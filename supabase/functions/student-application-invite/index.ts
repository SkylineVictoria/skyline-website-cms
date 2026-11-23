import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appToken, graphFor, type Ports } from "../_shared/office365-provision.ts";
import { simpleEmailHtml } from "../_shared/email-html.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const encode = (value: string) => base64(new TextEncoder().encode(value));
const wrap = (value: string) => encode(value).match(/.{1,76}/g)?.join("\r\n") ?? "";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function httpsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid invitation URL");
  return url;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "Sign in before sending invitations." }, 401);

  const env = (name: string) => Deno.env.get(name);
  const url = env("SUPABASE_URL");
  const anon = env("SUPABASE_ANON_KEY") ?? env("SUPABASE_PUBLISHABLE_KEY");
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return json({ error: "The invitation service is unavailable." }, 503);
  const config = { auth: { persistSession: false, autoRefreshToken: false } };
  const caller = createClient(url, anon, { ...config, global: { headers: { Authorization: authorization,
    ...(request.headers.get("x-tenant-domain") ? { "x-tenant-domain": request.headers.get("x-tenant-domain")! } : {}),
  } } });
  const { data: user, error: authError } = await caller.auth.getUser(authorization.slice(7));
  if (authError || !user.user) return json({ error: "Sign in before sending invitations." }, 401);

  const body = await request.json().catch(() => null);
  if (!body || typeof body.applicationId !== "string" || !uuid.test(body.applicationId) ||
    (body.correctedEmail !== undefined && (typeof body.correctedEmail !== "string" || body.correctedEmail.length > 254))) {
    return json({ error: "Choose a valid student application." }, 400);
  }
  const token = base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { data: invitation, error: beginError } = await caller.rpc("portal_wizard_invite_begin", {
    p_application: body.applicationId, p_hash: hash, p_corrected_email: body.correctedEmail ?? null,
  });
  if (beginError || !invitation) {
    const known = beginError && ["22023", "42501", "23505"].includes(beginError.code);
    return json({ error: known ? beginError.message : "The invitation could not be prepared." }, beginError?.code === "42501" ? 403 : 400);
  }

  const admin = createClient(url, service, config);
  const ports: Ports = { env, fetch, rpc: (name, args) => admin.rpc(name, args) };
  let accepted = false;
  let message = "Office 365 could not accept the invitation. Try sending it again.";
  try {
    const template = invitation.template as Record<string, unknown>;
    const field = (key: string) => typeof template[key] === "string" ? (template[key] as string).trim() : "";
    const subject = field("subject");
    const brand = field("brand");
    const button = field("button");
    const contact = field("contact");
    let link: URL;
    let logo: URL;
    try {
      link = new URL("/agency/application-invite", httpsUrl(field("siteUrl")));
      logo = httpsUrl(field("logoUrl"));
      if (/\r|\n/.test(subject) || !subject || !brand || !button || !field("greeting") || !field("body") ||
        !field("note") || !field("signature") || !contact || !/^#[0-9a-f]{6}$/i.test(field("primary"))) throw new Error("Incomplete");
    } catch {
      message = "Complete the published invitation template and branding in Business Rules & Policies.";
      throw new Error("Invalid invitation template");
    }
    link.hash = new URLSearchParams({ t: token }).toString();
    const text = [field("greeting"), field("body"), `${button}: ${link}`, field("note"), field("signature"), contact].join("\r\n\r\n");
    const html = simpleEmailHtml({
      brand, heading: subject, paragraphs: [field("greeting"), field("body")],
      button: { label: button, url: link.href }, note: `${field("note")}\n\n${field("signature")}`,
      footer: contact, primary: field("primary"), logo: { url: logo.href, alt: brand },
    });
    const boundary = `slit-${crypto.randomUUID()}`;
    const mime = [
      `From: ${invitation.sender}`, `To: ${invitation.recipient}`, `Subject: =?UTF-8?B?${encode(subject)}?=`,
      "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
      `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap(text),
      `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap(html),
      `--${boundary}--`, "",
    ].join("\r\n");
    const graph = graphFor(ports, await appToken(ports));
    // Graph accepts an RFC 5322 message as base64 MIME and returns 202 when accepted for delivery.
    const response = await graph("POST", `/users/${encodeURIComponent(invitation.sender)}/sendMail`, base64(new TextEncoder().encode(mime)),
      { "Content-Type": "text/plain" }, "raw");
    accepted = response.status === 202;
    await response.body?.cancel();
  } catch { /* Record the failure through the database. */ }

  const { data: recorded, error: trackingError } = await admin.rpc("portal_wizard_invite_delivered", {
    p_invitation: invitation.id, p_accepted: accepted,
  });
  if (trackingError || recorded !== true) return json({ error: "The invitation status could not be confirmed. Check its status before resending." }, 503);
  if (!accepted) return json({ error: message }, 502);
  return json({ ok: true });
});
