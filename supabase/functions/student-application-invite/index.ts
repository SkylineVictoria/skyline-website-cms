import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appToken, graphFor, type Graph, type Ports } from "../_shared/office365-provision.ts";
import { loadRules } from "../_shared/business-rules.ts";
import { tokenRoles } from "../_shared/microsoft365.ts";
import { isServiceCaller } from "../_shared/service-role.ts";
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

function providerMessage(code: string, status: number): string {
  // rule-policy: technical invitation-graph-errors Map provider error codes and HTTP responses to user-facing messages.
  if (code === "ErrorMailboxNotEnabledForRESTAPI") return "The configured sender has no active Exchange Online mailbox.";
  if (code === "ErrorSendAsDenied" || status === 403) return "Office 365 denied permission to send from the configured mailbox.";
  // rule-policy: technical invitation-graph-errors Translate a missing mailbox provider response.
  if (status === 404) return "Office 365 could not find the configured sender mailbox.";
  return "Office 365 did not accept the invitation. Try again or ask SLIT to check the email integration.";
}

async function providerCode(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null);
  const code = payload?.error?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : "unknown";
}

async function lookupMailbox(graph: Graph, address: string) {
  const exact = await graph("GET", `/users/${encodeURIComponent(address)}?$select=id,mail,userPrincipalName`);
  if (exact.ok) {
    const result = await exact.json();
    // rule-policy: technical invitation-graph-directory Validate the directory object identifier before using it.
    return { id: typeof result.id === "string" && uuid.test(result.id) ? result.id : null, lookup: exact.status, matched: "principal" };
  }
  const lookup = exact.status;
  await exact.body?.cancel();
  // rule-policy: technical invitation-graph-directory Try the address lookup only when the principal lookup returns not found.
  if (lookup !== 404) return { id: null, lookup, matched: null };

  const escaped = address.replaceAll("'", "''");
  const params = new URLSearchParams({
    "$select": "id,mail,proxyAddresses",
    "$filter": `mail eq '${escaped}' or proxyAddresses/any(p:p eq 'smtp:${escaped}')`,
    "$count": "true",
  });
  const aliases = await graph("GET", `/users?${params}`, undefined, { ConsistencyLevel: "eventual" });
  if (!aliases.ok) {
    const status = aliases.status;
    await aliases.body?.cancel();
    // rule-policy: technical invitation-graph-directory Return lookup status without exposing directory records.
    return { id: null, lookup, matched: null, aliasLookup: status };
  }
  const result = await aliases.json();
  const matches = Array.isArray(result.value)
    ? result.value.filter((user: { id?: string; mail?: string; proxyAddresses?: string[] }) =>
      user.id && uuid.test(user.id) && (user.mail?.toLowerCase() === address.toLowerCase() ||
        user.proxyAddresses?.some((alias) => alias.toLowerCase() === `smtp:${address.toLowerCase()}`)))
    : [];
  // rule-policy: security invitation-graph-directory Require one unambiguous mailbox for the configured sender address.
  return { id: matches.length === 1 && result["@odata.nextLink"] === undefined ? matches[0].id : null,
    lookup, matched: matches.length === 1 && result["@odata.nextLink"] === undefined ? "address" : null, aliasLookup: aliases.status };
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
  const body = await request.json().catch(() => null);
  const admin = createClient(url, service, config);
  const ports: Ports = { env, fetch, rpc: (name, args) => admin.rpc(name, args) };
  // rule-policy: security invitation-mailbox-diagnostics Limit provider diagnostics to the service account and the configured sender.
  if (body?.action === "diagnose") {
    if (!isServiceCaller(authorization, service, url)) return json({ error: "Service access required." }, 403);
    try {
      const rules = await loadRules(admin, ["admissions.application_invite_sender"]);
      const sender = rules["admissions.application_invite_sender"];
      if (typeof sender !== "string" || !sender) return json({ senderConfigured: false });
      const credential = await appToken(ports);
      const mailbox = await lookupMailbox(graphFor(ports, credential), sender);
      // rule-policy: security invitation-mailbox-diagnostics Disclose only permission and mailbox lookup outcomes.
      return json({ senderConfigured: true, mailSend: tokenRoles(credential).includes("Mail.Send"),
        mailboxFound: Boolean(mailbox.id), lookup: mailbox.lookup, aliasLookup: mailbox.aliasLookup, matched: mailbox.matched });
    } catch {
      return json({ error: "Office 365 mailbox lookup failed." }, 502);
    }
  }
  const retry = body?.action === "retry";
  // rule-policy: security invitation-service-retry Restrict recovery to the service caller and a stored failed invitation ID.
  if (retry && !isServiceCaller(authorization, service, url)) return json({ error: "Service access required." }, 403);
  if (retry && (typeof body.failedInvitationId !== "string" || !uuid.test(body.failedInvitationId))) {
    return json({ error: "Choose a failed invitation." }, 400);
  }
  const caller = createClient(url, anon, { ...config, global: { headers: { Authorization: authorization,
    ...(request.headers.get("x-tenant-domain") ? { "x-tenant-domain": request.headers.get("x-tenant-domain")! } : {}),
  } } });
  if (!retry) {
    const { data: user, error: authError } = await caller.auth.getUser(authorization.slice(7));
    if (authError || !user.user) return json({ error: "Sign in before sending invitations." }, 401);
    if (!body || typeof body.applicationId !== "string" || !uuid.test(body.applicationId) ||
      (body.correctedEmail !== undefined && (typeof body.correctedEmail !== "string" || body.correctedEmail.length > 254))) {
      return json({ error: "Choose a valid student application." }, 400);
    }
  }

  const token = base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const { data: invitation, error: beginError } = retry
    ? await admin.rpc("portal_wizard_retry_failed_invite", { p_failed_invitation: body.failedInvitationId, p_hash: hash })
    : await caller.rpc("portal_wizard_invite_begin", {
      p_application: body.applicationId, p_hash: hash, p_corrected_email: body.correctedEmail ?? null,
    });
  if (beginError || !invitation) {
    const known = beginError && ["22023", "42501", "23505"].includes(beginError.code);
    return json({ error: known ? beginError.message : "The invitation could not be prepared." }, beginError?.code === "42501" ? 403 : 400);
  }

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
    const send = (mailbox: string) => graph("POST", `/users/${encodeURIComponent(mailbox)}/sendMail`,
      base64(new TextEncoder().encode(mime)), { "Content-Type": "text/plain" }, "raw");
    let response = await send(invitation.sender);
    let code = response.ok ? "" : await providerCode(response);
    // rule-policy: technical invitation-graph-address Resolve a configured alias only after Graph explicitly returns a missing sender.
    if (response.status === 404 && code !== "ErrorMailboxNotEnabledForRESTAPI") {
      const mailbox = await lookupMailbox(graph, invitation.sender);
      if (mailbox.id && mailbox.matched === "address") {
        response = await send(mailbox.id);
        code = response.ok ? "" : await providerCode(response);
      }
    }
    // rule-policy: technical invitation-graph-acceptance Microsoft Graph confirms queue acceptance with HTTP 202.
    accepted = response.status === 202;
    if (!accepted) {
      message = providerMessage(code, response.status);
      console.warn("student_invitation_mail_rejected", response.status, code);
    }
  } catch { /* Record the failure through the database. */ }

  const { data: recorded, error: trackingError } = await admin.rpc("portal_wizard_invite_delivered", {
    p_invitation: invitation.id, p_accepted: accepted,
  });
  if (trackingError || recorded !== true) return json({ error: "The invitation status could not be confirmed. Check its status before resending." }, 503);
  if (!accepted) return json({ error: message }, 502);
  return json({ ok: true });
});
