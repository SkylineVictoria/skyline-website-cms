// =====================================================================
// portal-admin-users — Skyline Agency Portal account provisioning
//
// Invitations, resends, revokes, role/status changes and agency creation for
// the Agency Portal go through this function. Authorization is decided by the
// database (migration 86 portal_* functions) from the verified JWT subject:
// organization (SLIT) admins may act on any agency, agency admins only on the
// agency of their own membership, agents never. The agency is never trusted
// from the request for an agency admin. Auth identities are created or mailed
// only through the official Supabase Auth Admin API; no password is stored.
// Invitation mail is the Auth mailer (it carries the one-time setup link), not
// the notification-delivery outbox, so migration 84 activation rules do not apply.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cleanEmail, cleanName } from "../_shared/user-input.ts";
import { backendConfiguration } from "../_shared/config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Database errors raised by the portal_* functions carry user-facing messages and a class code.
function rpcFailure(error: { code?: string; message?: string }) {
  const message = error.message || "The request could not be completed.";
  switch (error.code) {
    case "42501": return json({ error: message }, 403);
    case "23505":
    case "23514": return json({ error: message }, 409);
    case "22023":
    case "23503": return json({ error: message }, 400);
    case "P0002": return json({ error: message }, 404);
    default: return json({ error: "The request could not be completed." }, 500);
  }
}

async function findAuthUserByEmail(admin: any, email: string) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return { user: null, error: error.message };
    const match = data.users.find(
      (u: { email?: string | null }) => (u.email ?? "").toLowerCase() === email.toLowerCase(),
    );
    if (match) return { user: match, error: null };
    if (data.users.length < 200) break;
  }
  return { user: null, error: null };
}

/**
 * Mail the one-time setup link for an invitation. Existing confirmed identities are never sent a credential
 * reset: they simply sign in and the pending invitation is accepted. `inviteLink` is only produced for the
 * fallback path and is only returned to organization administrators.
 */
async function deliverInvite(admin: any, anon: any, email: string, name: string, redirectTo?: string) {
  const existing = await findAuthUserByEmail(admin, email);
  if (existing.error) return { error: existing.error };
  if (existing.user) {
    if (existing.user.email_confirmed_at) return { emailSent: false, existingIdentity: true, inviteLink: null as string | null };
    const { error } = await anon.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined);
    return error ? { error: error.message } : { emailSent: true, existingIdentity: false, inviteLink: null as string | null };
  }
  const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, { data: { name }, redirectTo });
  if (!inviteErr) return { emailSent: true, existingIdentity: false, inviteLink: null as string | null };
  const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name } });
  if (createErr) return { error: createErr.message || inviteErr.message };
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email, options: redirectTo ? { redirectTo } : undefined });
  if (linkErr) return { error: linkErr.message };
  return { emailSent: false, existingIdentity: false, inviteLink: (link?.properties?.action_link as string | undefined) ?? null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY, ANON_KEY);
  if (configuration) return json(configuration, 503);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json({ error: "Missing authorization token." }, 401);

    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: callerData, error: callerErr } = await anon.auth.getUser(token);
    if (callerErr || !callerData.user) return json({ error: "Not authenticated." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const caller = callerData.user;
    if (req.headers.has("x-tenant-domain")) return json({ error: "Use tenant membership administration for a scoped request." }, 403);

    // The caller's authority is read from the database for the verified JWT subject only.
    const { data: ctx, error: ctxErr } = await admin.rpc("portal_actor_context", { p_actor: caller.id });
    if (ctxErr) return json({ error: "Unable to verify your access." }, 503);
    const isSlit = ctx?.slit === true;
    if (!isSlit && ctx?.role !== "agency_admin") return json({ error: "Organization or agency administrator access required." }, 403);

    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await req.json()) as Record<string, unknown>;
    } catch (_err) {
      parsed = {};
    }
    const action = String(parsed.action ?? "");
    const redirectTo = typeof parsed.redirectTo === "string" ? parsed.redirectTo : undefined;
    const optionalText = (key: string) => (parsed[key] === undefined || parsed[key] === null || parsed[key] === "" ? null : String(parsed[key]).trim());

    // Auth mail is sent after the database has recorded the invitation, so a mail failure leaves a pending,
    // resendable invitation rather than an orphan or a missing record.
    const respondDelivered = async (invitation: { invitationId: string; email: string; name: string; role?: string }, extra: Record<string, unknown> = {}) => {
      const delivery = await deliverInvite(admin, anon, invitation.email, invitation.name || invitation.email.split("@")[0], redirectTo);
      if (delivery.error) {
        return json({ ok: true, ...extra, invitationId: invitation.invitationId, emailSent: false, warning: "The invitation was saved but the email could not be sent. Use Resend to try again." });
      }
      return json({
        ok: true, ...extra, invitationId: invitation.invitationId, emailSent: delivery.emailSent === true,
        existingIdentity: delivery.existingIdentity === true,
        inviteLink: isSlit ? delivery.inviteLink : null,
      });
    };

    switch (action) {
      case "invite": {
        const emailCheck = cleanEmail(parsed.email);
        if (!emailCheck.ok) return json({ error: emailCheck.error }, 400);
        const nameCheck = cleanName(parsed.name);
        if (!nameCheck.ok) return json({ error: nameCheck.error }, 400);
        // For an agency admin the database ignores any agencyId other than their own membership's agency.
        const { data, error } = await admin.rpc("portal_invitation_create", {
          p_actor: caller.id,
          p_agency: optionalText("agencyId"),
          p_email: emailCheck.value,
          p_name: nameCheck.value,
          p_role: String(parsed.role ?? "agent"),
        });
        if (error) return rpcFailure(error);
        return respondDelivered(data);
      }

      case "create_agency": {
        const adminEmail = cleanEmail(parsed.adminEmail);
        if (!adminEmail.ok) return json({ error: adminEmail.error }, 400);
        const adminName = cleanName(parsed.adminName);
        if (!adminName.ok) return json({ error: adminName.error }, 400);
        const agency = (parsed.agency && typeof parsed.agency === "object" ? parsed.agency : {}) as Record<string, unknown>;
        const { data, error } = await admin.rpc("portal_agency_create_with_admin", {
          p_actor: caller.id,
          p_agency: agency,
          p_admin_email: adminEmail.value,
          p_admin_name: adminName.value,
        });
        if (error) return rpcFailure(error);
        return respondDelivered(data, { agencyId: data.agencyId, agencyName: data.agencyName });
      }

      case "resend": {
        const { data, error } = await admin.rpc("portal_invitation_resend", { p_actor: caller.id, p_invitation: String(parsed.invitationId ?? "") });
        if (error) return rpcFailure(error);
        return respondDelivered(data);
      }

      case "revoke": {
        const { data, error } = await admin.rpc("portal_invitation_revoke", { p_actor: caller.id, p_invitation: String(parsed.invitationId ?? "") });
        if (error) return rpcFailure(error);
        return json({ ok: true, ...data });
      }

      case "update":
      case "delete": {
        // "delete" keeps its historical meaning: revoke this module's access, never the shared Auth identity.
        const profileId = String(parsed.profileId ?? "").trim();
        if (!profileId) return json({ error: "Portal user not found." }, 404);
        const { data, error } = await admin.rpc("portal_member_update", {
          p_actor: caller.id,
          p_profile: profileId,
          p_role: action === "delete" ? null : optionalText("role"),
          p_status: action === "delete" ? "Inactive" : optionalText("status"),
          p_agency: action === "delete" ? null : optionalText("agencyId"),
        });
        if (error) return rpcFailure(error);
        return json({ ok: true, ...data, identityPreserved: true });
      }

      case "reset": {
        if (!isSlit) return json({ error: "Organization administrator access required." }, 403);
        const email = String(parsed.email ?? "").trim().toLowerCase();
        if (!email) return json({ error: "Email is required." }, 400);
        const { data: mapped } = await admin.from("portal_profiles").select("auth_user_id").ilike("email", email).eq("status", "Active").maybeSingle();
        if (!mapped?.auth_user_id) return json({ error: "Mapped active profile not found." }, 404);
        const { data: shared } = await admin.from("cms_users").select("id").eq("auth_user_id", mapped.auth_user_id).limit(1).maybeSingle();
        const { data: membership, error: membershipError } = await admin.from("tenant_memberships").select("tenant_id").eq("auth_user_id", mapped.auth_user_id).limit(1).maybeSingle();
        if (membershipError) return json({ error: "Unable to verify account scope." }, 503);
        if (shared || membership) return json({ error: "Shared accounts must use account self-service recovery." }, 403);
        const { data: targetAuth, error: targetError } = await admin.auth.admin.getUserById(mapped.auth_user_id);
        if (targetError || targetAuth?.user?.email?.toLowerCase() !== email) return json({ error: "Verified account mapping required." }, 403);
        const { data: link, error } = await admin.auth.admin.generateLink({
          type: "recovery",
          email,
          options: redirectTo ? { redirectTo } : undefined,
        });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, link: (link && link.properties && link.properties.action_link) || null });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
