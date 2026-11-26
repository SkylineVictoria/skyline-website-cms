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
import { contactCodeEmail, newCode, newLinkToken, sendText, sha256Hex } from "../_shared/contact-links.ts";
import { readHrMailConfig, selectHrMailProvider } from "../_shared/hr-mail.ts";
import { HR_MAIL_ENV } from "../_shared/hr-mail-drain.ts";
import { normalizePhoneNumber } from "../_shared/notification/sms.ts";

const mailEnv: Record<string, string> = {};
for (const key of HR_MAIL_ENV) mailEnv[key] = Deno.env.get(key) ?? "";
const TEXT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * CONTACT-VERIFY (owner, 2026-11-26): a CMS user's invitation also goes by text when a mobile is given, with its own link
 * (/admin/text-invite#t=). That link proves the mobile; the person then confirms their email with a 6-digit code, and only then gets
 * a one-time set-password link (Auth recovery). The emailed invitation itself is unchanged (it proves the email). Link holders only:
 * the token is the credential (rate-limited by the code rules in the database).
 */
// deno-lint-ignore no-explicit-any
async function textInvite(admin: any, parsed: Record<string, unknown>) {
  const action = String(parsed.action);
  const token = String(parsed.token ?? "");
  if (!TEXT_TOKEN.test(token)) return json({ error: "This link is invalid or has expired." }, 403);
  const hash = await sha256Hex(token);
  const { data: opened } = await admin.rpc("link_opened", { p_hash: hash });
  if (opened?.scope !== "cms" || !opened?.subject || opened.via !== "sms") return json({ error: "This link is invalid or has expired." }, 403);
  const { data: person } = await admin.rpc("link_person", { p_scope: "cms", p_subject: opened.subject });
  if (!person?.email) return json({ error: "This link is invalid or has expired." }, 403);
  if (action === "text_open") return json({ ok: true, name: person.name ?? "", emailTo: opened.emailTo ?? null, emailPending: opened.emailPending === true });
  if (action === "text_code_send") {
    if (!opened.emailPending) return json({ ok: true, confirmed: true });
    const code = newCode();
    const { data: issued, error } = await admin.rpc("link_code_issue", { p_scope: "cms", p_subject: opened.subject, p_code: code });
    if (error) return json({ error: error.message }, 429);
    const provider = selectHrMailProvider(mailEnv); const config = readHrMailConfig(mailEnv);
    if (!provider || !config.from) return json({ error: "A code cannot be emailed right now." }, 503);
    const message = contactCodeEmail({ name: person.name, code, purpose: "create your password" });
    const outcome = await provider.send({ deliveryId: `cms-contact-${crypto.randomUUID()}`, from: config.from, to: issued.to, subject: message.subject, textBody: message.text, htmlBody: message.html });
    return outcome.kind === "accepted" ? json({ ok: true, emailTo: opened.emailTo }) : json({ error: "The code could not be emailed. Try again in a minute." }, 502);
  }
  // text_code_verify: the right code confirms the email and hands out the one-time set-password link (the text link is then used up).
  if (opened.emailPending) {
    const { data: checked, error } = await admin.rpc("link_code_verify", { p_scope: "cms", p_subject: opened.subject, p_code: String(parsed.code ?? "").replace(/\D/g, "").slice(0, 6) });
    if (error) return json({ error: "The code could not be checked." }, 400);
    if (checked?.ok !== true) return json({ ok: false, reason: checked?.reason ?? "wrong", error: checked?.error ?? "That code is not right." });
  }
  const { data: used } = await admin.rpc("link_alias_use", { p_hash: hash });
  if (used !== true) return json({ error: "This link was already used. Ask an administrator for a new invitation." }, 410);
  const site = (mailEnv.EF_HR_PUBLIC_SITE_URL || "").replace(/\/+$/, "");
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email: person.email, options: site ? { redirectTo: `${site}/reset-password` } : undefined });
  if (linkErr || !link?.properties?.action_link) return json({ error: "The password link could not be made. Ask an administrator to resend the invitation." }, 502);
  return json({ ok: true, link: link.properties.action_link });
}

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
    // CONTACT-VERIFY: the text invitation's own link (a link holder, not a signed-in admin).
    const peek = await req.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (["text_open", "text_code_send", "text_code_verify"].includes(String(peek.action ?? ""))) {
      return await textInvite(createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }), peek);
    }
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

        // CONTACT-VERIFY: a mobile was given: it is kept on the CMS user and the invitation also goes by text (its own link).
        let text: string | null = null;
        const mobile = typeof parsed.mobile === "string" && parsed.mobile.trim() ? normalizePhoneNumber(parsed.mobile) : null;
        if (typeof parsed.mobile === "string" && parsed.mobile.trim() && !mobile) text = "invalid_mobile";
        if (mobile) {
          await admin.from("cms_users").update({ mobile }).eq("id", reserved.id);
          const site = (mailEnv.EF_HR_PUBLIC_SITE_URL || (redirectTo ? new URL(redirectTo).origin : "")).replace(/\/+$/, "");
          const textToken = newLinkToken();
          const { data: added } = await admin.rpc("link_alias_add", { p_scope: "cms", p_subject: reserved.id, p_base_hash: null, p_alias_hash: await sha256Hex(textToken),
            p_email: email, p_mobile: mobile, p_expires: new Date(Date.now() + 7 * 86400_000).toISOString() });
          const sent = added === true && site ? await sendText(admin, { mobile, deliveryId: `cms-invite-${reserved.id}`,
            body: `Hi ${name.split(" ")[0]}, you have been invited to the Skyline Institute of Technology CMS. We also emailed you; you will confirm your email with a code.\n${site}/admin/text-invite#t=${textToken}` })
            : { state: "skipped" as const, code: "not_ready", to: "" };
          text = sent.state === "sent" ? "sent" : sent.code || sent.state;
        }
        return json({ ok: true, authUserId, emailSent, inviteLink, text });
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
