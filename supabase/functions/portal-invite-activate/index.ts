// portal-invite-activate: the "Activate access" link (INV-LINK) for an invitation to an email that already has a login.
// POST { token } from /agency/accept-invite. The one-time token from the email is the credential (256 random bits, only its
// SHA-256 is stored), so the gateway's JWT check is off for this function (config.toml verify_jwt = false) and the token is
// checked by portal_invitation_link_confirm, which records that the link was opened. The function then answers with a
// Supabase password-setup (recovery) link for that same email, so the person creates their password and is signed in;
// the set-password page accepts the invitation (portal_resolve_access). Nothing is emailed here: holding the token already
// proves the person received the invitation email. Once the invitation is accepted the token gives no link any more.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { activationSite } from "../_shared/activation-mail.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const INVALID = "This invitation link is not valid or has expired.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "", service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !service) return json({ error: "The service is not configured." }, 503);
    const raw = await req.text();
    if (raw.length > 500) return json({ error: INVALID }, 400);
    let token = "";
    try { token = String((JSON.parse(raw) as { token?: unknown }).token ?? ""); } catch { return json({ error: INVALID }, 400); }
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return json({ error: INVALID }, 400);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.rpc("portal_invitation_link_confirm", { p_token: token });
    if (error || !data?.ok || typeof data.email !== "string") return json({ error: INVALID }, 400);
    if (data.alreadyAccepted) return json({ ok: true, alreadyActive: true });
    const site = activationSite(Deno.env.toObject(), req.headers.get("origin") ?? undefined);
    if (!site) return json({ ok: true, passwordLink: null });
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email: data.email, options: { redirectTo: `${site}/reset-password` } });
    const actionLink = link?.properties?.action_link;
    if (linkErr || typeof actionLink !== "string") return json({ ok: true, passwordLink: null });
    return json({ ok: true, passwordLink: actionLink });
  } catch {
    return json({ error: "Your access could not be activated right now. Try the link again in a moment." }, 500);
  }
});
