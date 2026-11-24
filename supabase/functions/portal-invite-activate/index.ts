// portal-invite-activate: the set-password link (INV-LINK) of an invitation, and a new link when one has expired.
// POST { token } from /agency/accept-invite, pressed by the person on that page (never on opening it, so a mail scanner that
// follows the link does not use it up). The one-time token from the email is the credential (256 random bits, only its SHA-256
// is stored), so the gateway's JWT check is off for this function (config.toml verify_jwt = false) and the token is checked by
// portal_invitation_link_confirm, which records that the link was opened. The function makes sure the email has an Auth user
// and answers with the hashed recovery token for it: the page verifies it (verifyOtp) and the person sets their password and is
// signed in; the page then accepts the invitation (portal_resolve_access). Once the invitation is accepted the token gives nothing.
// POST { action: "resend", email } from the expired-link page: a new one-time token for a pending invitation into an operational
// business, at most one every two minutes and ten a day (portal_invitation_self_resend); the answer is the same whatever happened.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { activationSite, sendActivationEmail } from "../_shared/activation-mail.ts";
import { loadEmailBranding } from "../_shared/email-html.ts";
import { loadInstitutionTimeZone } from "../_shared/time-zone.ts";
import { findAuthUserByEmail } from "../_shared/invite-delivery.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const INVALID = "This invitation link is not valid or has expired.";
const EMAIL = /^[^@\s<>",]+@[^@\s<>",]+\.[^@\s<>",]+$/;
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256Hex = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "", service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !service) return json({ error: "The service is not configured." }, 503);
    const raw = await req.text();
    if (raw.length > 1000) return json({ error: INVALID }, 400);
    let body: { token?: unknown; action?: unknown; email?: unknown } = {};
    try { body = JSON.parse(raw) as typeof body; } catch { return json({ error: INVALID }, 400); }
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const env = Deno.env.toObject();
    const site = activationSite(env, req.headers.get("origin") ?? undefined);

    if (body.action === "resend") {
      // Always the same answer: whether the address has an invitation is not revealed.
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!EMAIL.test(email) || email.length > 254) return json({ ok: true });
      const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const { data } = await admin.rpc("portal_invitation_self_resend", { p_email: email, p_token_hash: await sha256Hex(token) });
      if (data?.sent === true && site) {
        await loadInstitutionTimeZone(admin); // the "works until" date in the institution time zone (general.time_zone)
        await loadEmailBranding(admin); // the branded email layout (logo, colour, footer)
        await sendActivationEmail(env, { to: email, name: String(data.name ?? ""), link: `${site}/agency/accept-invite#t=${token}`, role: String(data.role ?? ""), agencyName: data.agencyName ?? null, expiresAt: data.expiresAt ?? undefined });
      }
      return json({ ok: true });
    }

    const token = String(body.token ?? "");
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return json({ error: INVALID }, 400);
    const { data, error } = await admin.rpc("portal_invitation_link_confirm", { p_token: token });
    if (error || !data?.ok || typeof data.email !== "string") return json({ error: INVALID }, 400);
    if (data.alreadyAccepted) return json({ ok: true, alreadyActive: true });
    const email = data.email.toLowerCase();
    // The person may not have an Auth user yet (the invitation was made by the signed agreement): one is made now, confirmed, without any email from Supabase.
    const existing = await findAuthUserByEmail(admin, email);
    if (existing.error) return json({ error: "Your access could not be activated right now. Try the link again in a moment." }, 500);
    if (!existing.user) {
      const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name: String(data.name ?? "") } });
      if (createErr && !/already|exists/i.test(createErr.message ?? "")) return json({ error: "Your access could not be activated right now. Try the link again in a moment." }, 500);
    } else if (!existing.user.email_confirmed_at) {
      await admin.auth.admin.updateUserById(existing.user.id, { email_confirm: true }).catch(() => undefined);
    }
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email });
    const tokenHash = link?.properties?.hashed_token;
    if (linkErr || typeof tokenHash !== "string") return json({ error: "Your access could not be activated right now. Try the link again in a moment." }, 500);
    return json({ ok: true, tokenHash, type: "recovery", email: email.replace(/^(.).*(@.*)$/, "$1…$2") });
  } catch {
    return json({ error: "Your access could not be activated right now. Try the link again in a moment." }, 500);
  }
});
