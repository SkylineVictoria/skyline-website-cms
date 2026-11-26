import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appToken, graphFor, type Graph, type Ports } from "../_shared/office365-provision.ts";
import { loadRules } from "../_shared/business-rules.ts";
import { tokenRoles } from "../_shared/microsoft365.ts";
import { isServiceCaller } from "../_shared/service-role.ts";
import { simpleEmailHtml } from "../_shared/email-html.ts";
import { createClickSendProvider, normalizePhoneNumber } from "../_shared/notification/sms.ts";

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

type Brand = { field: (key: string) => string; brand: string; contact: string; primaryOk: boolean };
function brandOf(template: Record<string, unknown>): Brand {
  const field = (key: string) => typeof template?.[key] === "string" ? (template[key] as string).trim() : "";
  return { field, brand: field("brand"), contact: field("contact"), primaryOk: /^#[0-9a-f]{6}$/i.test(field("primary")) };
}

/** Sends one message through Microsoft Graph from the configured mailbox (an alias resolved once on a 404). */
async function sendMail(ports: Ports, sender: string, recipient: string, subject: string, text: string, html: string) {
  const boundary = `slit-${crypto.randomUUID()}`;
  const mime = [
    `From: ${sender}`, `To: ${recipient}`, `Subject: =?UTF-8?B?${encode(subject)}?=`,
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap(text),
    `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap(html),
    `--${boundary}--`, "",
  ].join("\r\n");
  const graph = graphFor(ports, await appToken(ports));
  // Graph accepts an RFC 5322 message as base64 MIME and returns 202 when accepted for delivery.
  const send = (mailbox: string) => graph("POST", `/users/${encodeURIComponent(mailbox)}/sendMail`,
    base64(new TextEncoder().encode(mime)), { "Content-Type": "text/plain" }, "raw");
  let response = await send(sender);
  let code = response.ok ? "" : await providerCode(response);
  // rule-policy: technical invitation-graph-address Resolve a configured alias only after Graph explicitly returns a missing sender.
  if (response.status === 404 && code !== "ErrorMailboxNotEnabledForRESTAPI") {
    const mailbox = await lookupMailbox(graph, sender);
    if (mailbox.id && mailbox.matched === "address") {
      response = await send(mailbox.id);
      code = response.ok ? "" : await providerCode(response);
    }
  }
  // rule-policy: technical invitation-graph-acceptance Microsoft Graph confirms queue acceptance with HTTP 202.
  const accepted = response.status === 202;
  if (!accepted) console.warn("student_invitation_mail_rejected", response.status, code);
  return { accepted, message: accepted ? "" : providerMessage(code, response.status) };
}

const newToken = () => base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const tokenShape = /^[A-Za-z0-9_-]{43}$/;
const clientIp = (request: Request) => (request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "")
  .split(",")[0].trim().slice(0, 64);

/**
 * APPLICATION-STUDENT-SIGNS: a student under 18 asks a parent / guardian to sign. guardian_send (the student signed in) emails the
 * link; guardian_open / guardian_code / guardian_verify / guardian_sign are called from the guardian's page (no account: the link
 * token, a one-time code by email). Every check is in the database; this only makes tokens and codes and sends the emails.
 */
// deno-lint-ignore no-explicit-any
async function guardian(action: string, body: any, request: Request, admin: any, caller: any, ports: Ports): Promise<Response> {
  const dbError = (error: { code?: string; message?: string } | null, fallback: string) => {
    const known = error && ["22023", "42501", "PT409"].includes(error.code ?? "");
    return json({ error: known ? error!.message : fallback }, error?.code === "42501" ? 403 : 400);
  };
  if (action === "guardian_send") {
    if (typeof body.applicationId !== "string" || !uuid.test(body.applicationId)) return json({ error: "Choose a valid application." }, 400);
    const token = newToken();
    const { data: req, error } = await caller.rpc("portal_guardian_request_begin", {
      p_application: body.applicationId, p_name: String(body.name ?? ""), p_relationship: String(body.relationship ?? ""),
      p_email: String(body.email ?? ""), p_mobile: String(body.mobile ?? ""), p_hash: await sha256Hex(token),
    });
    if (error || !req) return dbError(error, "The request could not be prepared.");
    let accepted = false;
    let guardianLink = "";
    let message = "The email to your parent or guardian could not be sent. Try again.";
    try {
      const brand = brandOf(req.template);
      const site = httpsUrl(brand.field("siteUrl"));
      const link = new URL("/guardian-sign", site);
      link.hash = new URLSearchParams({ t: token }).toString();
      guardianLink = link.href;
      const subject = `Please sign ${req.studentName}'s application to ${brand.brand}`;
      const paragraphs = [`Hello ${req.guardianName},`,
        `${req.studentName} is under 18 and has applied to study with ${brand.brand}. As their parent or guardian, please read the declarations and sign the application too. It is submitted only once you have signed.`,
        "To check it is you, we will email a one-time code to this address when you open the link."];
      const note = `The link is personal to you. If you were not expecting this email, you can ignore it.\n\n${brand.field("signature")}`;
      const text = [...paragraphs, `Open and sign: ${link}`, note, brand.contact].join("\r\n\r\n");
      const html = simpleEmailHtml({ brand: brand.brand, heading: subject, paragraphs, button: { label: "Open and sign", url: link.href }, note,
        footer: brand.contact, primary: brand.primaryOk ? brand.field("primary") : "#ea6619", logo: { url: httpsUrl(brand.field("logoUrl")).href, alt: brand.brand } });
      const sent = await sendMail(ports, req.sender, req.recipient, subject, text, html);
      accepted = sent.accepted;
      if (!accepted) message = sent.message;
    } catch { /* recorded below */ }
    const { data: recorded, error: trackError } = await admin.rpc("portal_guardian_request_delivered", { p_request: req.id, p_accepted: accepted });
    if (trackError || recorded !== true) return json({ error: "The email status could not be confirmed. Check before sending again." }, 503);
    if (!accepted) return json({ error: message }, 502);
    const sms = guardianLink ? await textLink(admin, "guardian", req.id, guardianLink,
      (name, studentName) => `SLIT: ${name ? `Hi ${name}, ` : ""}please sign ${studentName}'s application (they are under 18). Open it here:`) : "not_requested";
    return json({ ok: true, sms });
  }
  if (typeof body.token !== "string" || !tokenShape.test(body.token)) return json({ error: "This link is invalid, expired, or no longer available." }, 403);
  const hash = await sha256Hex(body.token);
  if (action === "guardian_open") {
    const { data, error } = await admin.rpc("portal_guardian_open", { p_hash: hash });
    return error ? dbError(error, "This link could not be opened.") : json(data);
  }
  if (action === "guardian_code") {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    const { data: req, error } = await admin.rpc("portal_guardian_code_issue", { p_hash: hash, p_code: code });
    if (error || !req) return dbError(error, "A code could not be sent.");
    try {
      const brand = brandOf(req.template);
      const subject = `Your ${brand.brand} code: ${code}`;
      const paragraphs = [`Hello ${req.guardianName},`, `Your code to sign ${req.studentName}'s application is ${code}. It works for 10 minutes.`];
      const html = simpleEmailHtml({ brand: brand.brand, heading: "Your one-time code", paragraphs, code, note: "If you did not ask for this code, you can ignore this email.",
        footer: brand.contact, primary: brand.primaryOk ? brand.field("primary") : "#ea6619", logo: { url: httpsUrl(brand.field("logoUrl")).href, alt: brand.brand } });
      const sent = await sendMail(ports, req.sender, req.recipient, subject, paragraphs.join("\r\n\r\n"), html);
      return sent.accepted ? json({ ok: true }) : json({ error: sent.message }, 502);
    } catch {
      return json({ error: "The code could not be sent. Try again in a minute." }, 502);
    }
  }
  if (action === "guardian_verify") {
    if (typeof body.code !== "string" || !/^[0-9]{6}$/.test(body.code)) return json({ ok: false, error: "Enter the 6-digit code." });
    const { data, error } = await admin.rpc("portal_guardian_code_verify", { p_hash: hash, p_code: body.code });
    return error ? dbError(error, "The code could not be checked.") : json(data);
  }
  if (action === "guardian_sign") {
    if (!body.declarations || typeof body.declarations !== "object") return json({ error: "Tick each declaration before signing." }, 400);
    const { data, error } = await admin.rpc("portal_guardian_sign", { p_hash: hash, p_declarations: body.declarations,
      p_ip: clientIp(request), p_user_agent: (request.headers.get("user-agent") ?? "").slice(0, 500) });
    return error ? dbError(error, "The signature could not be saved.") : json(data);
  }
  return json({ error: "Unknown action." }, 400);
}

/**
 * INVITE-SMS (owner, 2026-11-26): the same link by text message through the ClickSend connection (Integrations › Connections).
 * Never blocks the email: no connection or no mobile is recorded as skipped; the outcome goes on the application's timeline.
 */
// deno-lint-ignore no-explicit-any
async function textLink(admin: any, kind: "student" | "guardian", id: string, link: string, wording: (name: string, studentName: string) => string): Promise<string> {
  try {
    const [{ data: settings }, { data: target }] = await Promise.all([admin.rpc("invite_sms_settings"), admin.rpc("invite_sms_target", { p_kind: kind, p_id: id })]);
    if (!target?.applicationId) return "skipped";
    const record = (outcome: string, code: string, to = "") => admin.rpc("invite_sms_record", { p_application: target.applicationId, p_who: kind,
      p_outcome: outcome, p_code: code, p_last_digits: to.slice(-3) }).then(() => undefined, () => undefined);
    if (!settings?.username || !settings?.apiKey) { await record("skipped", "not_connected"); return "not_connected"; }
    const to = normalizePhoneNumber(String(target.mobile ?? ""));
    if (!to) { await record("skipped", "no_mobile"); return "no_mobile"; }
    const provider = createClickSendProvider({ username: settings.username, apiKey: settings.apiKey, senderId: settings.from ?? undefined });
    const outcome = await provider.send({ deliveryId: id, to, body: `${wording(String(target.name ?? "").trim(), String(target.studentName ?? ""))}\n${link}` });
    if (outcome.kind === "accepted") { await record("sent", "", to); return "sent"; }
    await record("failed", outcome.code, to);
    return "failed";
  } catch {
    return "failed";
  }
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
  // APPLICATION-INVITE-GUEST-START: the student's link page. invite_check says whether the invited email already has an account
  // (then: sign in) or not (then: invite_session opens the application from the link alone; the password is made when signing).
  if (body?.action === "invite_check" || body?.action === "invite_session") {
    if (typeof body.token !== "string" || !tokenShape.test(body.token)) return json({ valid: false });
    const { data: found, error: lookupError } = await admin.rpc("portal_wizard_invite_lookup", { p_hash: await sha256Hex(body.token) });
    if (lookupError) return json({ error: "The invitation could not be checked. Try again." }, 503);
    if (!found?.valid) return json({ valid: false });
    if (body.action === "invite_check") return json(found);
    // Never a link-only sign-in to an account that has a password or Google: that person signs in.
    if (found.account !== "new") return json({ error: "This email already has a SLIT account. Sign in to continue." }, 409);
    const created = await admin.auth.admin.createUser({ email: found.email, email_confirm: true });
    if (created.error && !/already|registered|exists/i.test(created.error.message)) {
      return json({ error: "Your application could not be opened. Try again." }, 502);
    }
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email: found.email });
    const tokenHash = link.data?.properties?.hashed_token;
    if (link.error || !tokenHash) return json({ error: "Your application could not be opened. Try again." }, 502);
    return json({ tokenHash, email: found.email });
  }
  if (typeof body?.action === "string" && body.action.startsWith("guardian_")) {
    const caller = createClient(url, anon, { ...config, global: { headers: { Authorization: authorization } } });
    return guardian(body.action, body, request, admin, caller, ports);
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

  const token = newToken();
  const hash = await sha256Hex(token);
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
  let sentLink = "";
  let message = "Office 365 could not accept the invitation. Try sending it again.";
  try {
    const template = invitation.template as Record<string, unknown>;
    const brand = brandOf(template);
    const field = brand.field;
    const subject = field("subject");
    const button = field("button");
    let link: URL;
    try {
      link = new URL("/agency/application-invite", httpsUrl(field("siteUrl")));
      if (/\r|\n/.test(subject) || !subject || !brand.brand || !button || !field("greeting") || !field("body") ||
        !field("note") || !field("signature") || !brand.contact || !brand.primaryOk) throw new Error("Incomplete");
      httpsUrl(field("logoUrl"));
    } catch {
      message = "Complete the published invitation template and branding in Business Rules & Policies.";
      throw new Error("Invalid invitation template");
    }
    link.hash = new URLSearchParams({ t: token }).toString();
    sentLink = link.href;
    const text = [field("greeting"), field("body"), `${button}: ${link}`, field("note"), field("signature"), brand.contact].join("\r\n\r\n");
    const html = simpleEmailHtml({
      brand: brand.brand, heading: subject, paragraphs: [field("greeting"), field("body")],
      button: { label: button, url: link.href }, note: `${field("note")}\n\n${field("signature")}`,
      footer: brand.contact, primary: field("primary"), logo: { url: httpsUrl(field("logoUrl")).href, alt: brand.brand },
    });
    const sent = await sendMail(ports, invitation.sender, invitation.recipient, subject, text, html);
    accepted = sent.accepted;
    if (!accepted) message = sent.message;
  } catch { /* Record the failure through the database. */ }

  const { data: recorded, error: trackingError } = await admin.rpc("portal_wizard_invite_delivered", {
    p_invitation: invitation.id, p_accepted: accepted,
  });
  if (trackingError || recorded !== true) return json({ error: "The invitation status could not be confirmed. Check its status before resending." }, 503);
  if (!accepted) return json({ error: message }, 502);
  // Also by text, unless the sender asked for email only (channels: ["email"]).
  const wantsText = !Array.isArray(body?.channels) || body.channels.includes("sms");
  const sms = wantsText && sentLink ? await textLink(admin, "student", invitation.id, sentLink,
    (name) => `SLIT: ${name ? `Hi ${name}, y` : "Y"}our application is ready to check and sign. Open it here:`) : "not_requested";
  return json({ ok: true, sms });
});
