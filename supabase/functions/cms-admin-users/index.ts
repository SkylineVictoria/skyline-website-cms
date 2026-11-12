// =====================================================================
// cms-admin-users — Skyline Website CMS staff provisioning
//
// ALL user creation / invitation / deletion for the CMS goes through this
// function. It uses the official Supabase Auth Admin API
// (auth.admin.inviteUserByEmail / createUser / deleteUser / generateLink)
// with the service-role key. The auth schema is NEVER written directly.
//
// Caller must be a signed-in, Active Admin (checked against cms_users).
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cleanEmail, cleanName } from "../_shared/user-input.ts";
import { backendConfiguration } from "../_shared/config.ts";
import { emailConflictBody } from "../_shared/identity-email.ts";

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

// The Admin API has no get-user-by-email, so page through the user list.
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

// One email = one CMS user (identity_email_guard). The profile row is written BEFORE any Auth user exists, so a login the
// trigger would refuse is never created: a new row starts Inactive with no login, then gets the login and goes Active.
// An existing row with this email (a re-invite) is reused as before.
async function reserveProfile(admin: any, payload: { email: string; name: string; role: string }) {
  const { data: existing } = await admin
    .from("cms_users")
    .select("id")
    .ilike("email", payload.email)
    .maybeSingle();
  if (existing && existing.id) return { id: existing.id as string, created: false, error: null };
  const id = crypto.randomUUID();
  const { error } = await admin.from("cms_users").insert({
    id, name: payload.name, email: payload.email, role: payload.role === "Admin" ? "Admin" : "Editor", status: "Inactive", auth_user_id: null,
  });
  return { id, created: !error, error };
}

async function activateProfile(
  admin: any,
  id: string,
  payload: { email: string; name: string; role: string; authUserId: string },
) {
  const { error } = await admin.from("cms_users").update({
    name: payload.name,
    email: payload.email,
    role: payload.role === "Admin" ? "Admin" : "Editor",
    status: "Active",
    auth_user_id: payload.authUserId,
  }).eq("id", id);
  return { error };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY, ANON_KEY);
  if (configuration) return json(configuration, 503);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json({ error: "Missing authorization token." }, 401);

    // 1) Verify the caller's JWT with a normal (anon) client.
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: callerData, error: callerErr } = await anon.auth.getUser(token);
    if (callerErr || !callerData.user) return json({ error: "Not authenticated." }, 401);

    // 2) Privileged client (service role) for auth-admin + profile writes.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const caller = callerData.user;
    if (req.headers.has("x-tenant-domain")) return json({ error: "Use tenant membership administration for a scoped request." }, 403);
    let profile: { role?: string; must_change_password?: boolean; status?: string } | null = null;
    const { data: byId } = await admin
      .from("cms_users")
      .select("role, status, must_change_password")
      .eq("auth_user_id", caller.id)
      .maybeSingle();
    profile = byId ?? null;

    if (!profile || profile.status !== "Active" || profile.role !== "Admin" || profile.must_change_password) {
      return json({ error: "Administrator access required." }, 403);
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await req.json()) as Record<string, unknown>;
    } catch (_err) {
      parsed = {};
    }
    const action = String(parsed.action ?? "");

    switch (action) {
      case "invite": {
        const emailCheck = cleanEmail(parsed.email);
        if (!emailCheck.ok) return json({ error: emailCheck.error }, 400);
        const nameCheck = cleanName(parsed.name);
        if (!nameCheck.ok) return json({ error: nameCheck.error }, 400);
        const email = emailCheck.value;
        const name = nameCheck.value;
        // Unknown roles are rejected rather than silently becoming Editor.
        const role = String(parsed.role ?? "");
        if (role !== "Admin" && role !== "Editor") return json({ error: "Role must be Admin or Editor." }, 400);
        const redirectTo = typeof parsed.redirectTo === "string" ? parsed.redirectTo : undefined;

        let authUserId = "";
        let inviteLink: string | null = null;
        let emailSent = false;

        // 1) The CMS profile first: the identity trigger decides before any login or email exists.
        const reserved = await reserveProfile(admin, { email, name, role });
        if (reserved.error) {
          const conflict = emailConflictBody(reserved.error);
          if (conflict) return json(conflict, 409);
          return json({ error: "Could not create the user profile." }, 500);
        }
        // Undo a row this request created when a later step fails (a re-invited existing row is left alone).
        const fail = async (body: Record<string, unknown>, status: number) => {
          if (reserved.created) await admin.from("cms_users").delete().eq("id", reserved.id).is("auth_user_id", null);
          return json(body, status);
        };

        // 2) The Auth identity.
        const existing = await findAuthUserByEmail(admin, email);
        if (existing.error) return await fail({ error: existing.error }, 400);
        if (existing.user) {
          // Existing identities sign in normally. Never disclose a recovery
          // credential simply because another module wants to link the account.
          authUserId = existing.user.id;
        } else {
          const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, { data: { name }, redirectTo });
          if (!inviteErr && invited?.user) { authUserId = invited.user.id; emailSent = true; }
          else {
            const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name } });
            const found = await findAuthUserByEmail(admin, email);
            if (!found.user) return await fail({ error: createErr?.message || inviteErr?.message || "Could not create user." }, 400);
            authUserId = found.user.id;
            // A concurrent registration is an existing identity, not permission
            // to reset its password. Only our successfully created account gets a link.
            if (!createErr) {
              const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email, options: redirectTo ? { redirectTo } : undefined });
              if (linkErr) return await fail({ error: linkErr.message }, 400);
              inviteLink = link?.properties?.action_link || null;
            }
          }
        }

        // 3) Link the login and activate the profile.
        const profileRes = await activateProfile(admin, reserved.id, { email, name, role, authUserId });
        if (profileRes.error) {
          const conflict = emailConflictBody(profileRes.error);
          return await fail(conflict ?? { error: "Could not save the user profile." }, conflict ? 409 : 500);
        }

        return json({ ok: true, authUserId, emailSent, inviteLink });
      }

      case "reset": {
        const email = String(parsed.email ?? "").trim().toLowerCase();
        const redirectTo = typeof parsed.redirectTo === "string" ? parsed.redirectTo : undefined;
        if (!email) return json({ error: "Email is required." }, 400);
        const { data: mapped } = await admin.from("cms_users").select("auth_user_id").ilike("email", email).eq("status", "Active").maybeSingle();
        if (!mapped?.auth_user_id) return json({ error: "Mapped active profile not found." }, 404);
        const { data: shared } = await admin.from("portal_profiles").select("id").eq("auth_user_id", mapped.auth_user_id).limit(1).maybeSingle();
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

      case "delete": {
        // Removing one module's access must never delete a shared Auth identity.
        const authUserId = String(parsed.authUserId ?? "").trim();
        const email = String(parsed.email ?? "").trim().toLowerCase();
        if (!authUserId && !email) return json({ error: "Target profile is required." }, 400);
        let targetQuery = admin.from("cms_users").select("id, auth_user_id");
        targetQuery = authUserId ? targetQuery.eq("auth_user_id", authUserId) : targetQuery.ilike("email", email);
        const { data: target, error: targetError } = await targetQuery.maybeSingle();
        if (targetError || !target) return json({ error: "Mapped profile not found." }, 404);
        if (target.auth_user_id === caller.id) return json({ error: "Use another administrator to revoke your access." }, 403);
        const { error } = await admin.from("cms_users").update({ status: "Inactive" }).eq("id", target.id);
        if (error) return json({ error: error.message }, 400);
        
        return json({ ok: true, identityPreserved: true });
      }

      case "list": {
        const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        if (error) return json({ error: error.message }, 400);
        return json({
          ok: true,
          users: data.users.map((u: { id: string; email?: string | null; email_confirmed_at?: string | null }) => ({
            id: u.id,
            email: u.email,
            confirmed: !!u.email_confirmed_at,
          })),
        });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
