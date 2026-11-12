// email-sender: sends every queued email (notification_deliveries) except application_submitted through Postmark, with the
// branded HTML body (html_body, made in the database) and the plain-text body. Offer letters and CoE / VoE documents are attached
// through the same lease-checked reads notification-delivery uses. application_submitted stays with notification-delivery,
// which builds the submitted-form PDF. Called every minute by public.support_mail_dispatch() (pg_cron + pg_net) with the
// project's service-role key; verify_jwt stays on. Claim via support_mail_claim(), record via notification_record_attempt().
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const enabled = (Deno.env.get("EF_NOTIFICATION_EMAIL_ENABLED") ?? "").trim() === "true";
const postmarkToken = (Deno.env.get("EF_POSTMARK_SERVER_TOKEN") ?? "").trim();
const POSTMARK_HOST = "https://api.postmarkapp.com";
const isLocal = (() => { try { return ["127.0.0.1", "localhost", "kong", "host.docker.internal"].includes(new URL(url).hostname); } catch { return false; } })();
// A local stack only: mail goes to the lab's mock Postmark (never on a hosted project).
const POSTMARK_API = `${isLocal && (Deno.env.get("EF_POSTMARK_API_URL") ?? "").trim() ? (Deno.env.get("EF_POSTMARK_API_URL") ?? "").trim().replace(/\/+$/, "") : POSTMARK_HOST}/email`;
const MESSAGE_ID = /^[A-Za-z0-9-]{8,64}$/;
const BATCH = 20;
// OFFER-SIGN: the app's address for the student's signing link (APP_URL/sign#t=<token>), the setting the Sign module uses.
const signingSite = (() => {
  try {
    const site = new URL((Deno.env.get("EF_HR_PUBLIC_SITE_URL") ?? "").trim());
    return (site.protocol === "https:" || isLocal) && !site.username && !site.password ? site.toString().replace(/\/+$/, "") : null;
  } catch { return null; }
})();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Only this project's service_role token may run the worker (the gateway has verified the signature: verify_jwt = true). */
function authorized(header: string | null): 200 | 401 | 403 {
  const token = /^Bearer (.+)$/.exec((header ?? "").trim())?.[1] ?? "";
  if (!token) return 401;
  const parts = token.split(".");
  if (parts.length !== 3) return 403;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as { role?: string; ref?: string };
    if (claims.role !== "service_role") return 403;
    const host = new URL(url).hostname;
    const ref = host.endsWith(".supabase.co") ? host.split(".")[0] : null;
    if (ref && claims.ref && claims.ref !== ref) return 403;
    return 200;
  } catch { return 403; }
}

function formatFrom(name: string, email: string): string {
  // deno-lint-ignore no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 100).replace(/[\\"]/g, "\\$&");
  return `"${clean}" <${email}>`;
}

type Attachment = { Name: string; Content: string; ContentType: string };
const MAX_ATTACHMENT = 3 * 1024 * 1024;

// deno-lint-ignore no-explicit-any
async function attachmentsFor(admin: any, d: Record<string, unknown>): Promise<{ attachments: Attachment[]; note: string } | "retry"> {
  if (d.event === "offer_letter_issued") {
    const { data, error } = await admin.rpc("notification_delivery_offer_letter", { p_id: d.id, p_lease: d.lease_token });
    if (error) return "retry";
    if (!data || typeof data !== "object") return { attachments: [], note: "" };
    const l = data as Record<string, unknown>;
    const size = Number(l.sizeBytes ?? 0), content = String(l.contentBase64 ?? "");
    if (!(size > 0 && size <= MAX_ATTACHMENT) || !content) return "retry";
    const name = String(l.fileName ?? "Offer letter.pdf");
    return { attachments: [{ Name: (/\.pdf$/i.test(name) ? name : `${name || "Offer letter"}.pdf`).replace(/[^\w .()-]/g, "_"), Content: content, ContentType: "application/pdf" }], note: "" };
  }
  if (d.event === "coe_voe_issued") {
    const { data, error } = await admin.rpc("notification_delivery_coe_document", { p_id: d.id, p_lease: d.lease_token });
    if (error) return "retry";
    if (!data || typeof data !== "object") return { attachments: [], note: "" };
    const c = data as Record<string, unknown>;
    const size = Number(c.sizeBytes ?? 0), content = String(c.contentBase64 ?? "");
    if (!(size > 0 && size <= MAX_ATTACHMENT) || !content) return "retry";
    const label = c.kind === "voe" ? "VoE" : "CoE";
    const ref = String(c.reference ?? "").replace(/[^\w.-]/g, "_") || "document";
    return { attachments: [{ Name: `${label}-${ref}.pdf`, Content: content, ContentType: "application/pdf" }], note: `The ${label} is attached as a PDF.` };
  }
  return { attachments: [], note: "" };
}

const sha256Hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * OFFER-SIGN: the student's own copy of an offer letter email (delivery.signing) gets their personal signing link. The database makes the
 * signing request for the letter the first time (this function stores the letter as its original in signing-documents), retires every
 * earlier link and returns the email's text and branded HTML with the "Review and sign your offer" button; the link is stored nowhere.
 * "retry" (the signing places are still being stored, a failure) sends the email later rather than without its link; null: send as it is.
 */
// deno-lint-ignore no-explicit-any
async function offerSigning(admin: any, d: Record<string, unknown>, letterBase64: string): Promise<{ text: string; html: string } | "retry" | null> {
  if (d.event !== "offer_letter_issued" || d.signing !== true) return null;
  if (!signingSite || !letterBase64) return "retry";
  const bytes = Uint8Array.from(atob(letterBase64), (c) => c.charCodeAt(0));
  let pages: number | null = null;
  try { const { PDFDocument } = await import("npm:pdf-lib@1.17.1"); pages = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount(); } catch { pages = null; }
  const call = async (stored: boolean) => {
    const { data, error } = await admin.rpc("notification_delivery_offer_signing", { p_id: d.id, p_lease: d.lease_token, p_pages: pages, p_original_stored: stored, p_site: signingSite });
    if (error) throw new Error("offer signing");
    return data as Record<string, unknown> | null;
  };
  try {
    let link = await call(false);
    if (!link || link.closed) return null; // the offer is no longer open: the letter goes without a link
    if (link.wait) return "retry";
    if (link.needs_original) {
      if (typeof link.path !== "string" || await sha256Hex(bytes) !== link.hash) return "retry";
      const { error } = await admin.storage.from("signing-documents").upload(link.path, bytes, { contentType: "application/pdf", upsert: true });
      if (error) return "retry";
      link = await call(true);
      if (!link || link.closed) return null;
    }
    return typeof link.text === "string" && typeof link.html === "string" && /#t=[a-f0-9]{64}/.test(link.text) ? { text: link.text, html: link.html } : "retry";
  } catch { return "retry"; }
}

type Outcome = { outcome: "accepted"; messageId: string } | { outcome: "failed" | "unknown"; code: string; retry: boolean };

async function send(d: Record<string, unknown>, extra: { attachments: Attachment[]; note: string }): Promise<Outcome> {
  const sender = d.sender as { name?: string; email?: string; replyTo?: string } | null;
  if (!sender?.email || !sender?.name) return { outcome: "failed", code: "no_sender", retry: false };
  let response: Response;
  try {
    response = await fetch(POSTMARK_API, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": postmarkToken },
      body: JSON.stringify({
        From: formatFrom(sender.name, sender.email), ...(sender.replyTo ? { ReplyTo: sender.replyTo } : {}),
        To: String(d.recipient_email), Subject: String(d.subject), TextBody: extra.note ? `${String(d.body)}\n\n${extra.note}` : String(d.body),
        ...(typeof d.html_body === "string" && d.html_body
          ? { HtmlBody: extra.note ? String(d.html_body).replace("</td></tr><tr><td style=\"padding:16px 24px;background:#f9fafb", `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#111827;">${extra.note}</p></td></tr><tr><td style="padding:16px 24px;background:#f9fafb`) : d.html_body }
          : {}),
        ...(extra.attachments.length ? { Attachments: extra.attachments } : {}),
        MessageStream: "outbound", Metadata: { deliveryId: String(d.id) }, TrackOpens: false, TrackLinks: "None",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // May or may not have reached Postmark: never resent automatically.
    return { outcome: "unknown", code: (error as Error)?.name === "TimeoutError" ? "timeout" : "network", retry: false };
  }
  if (response.status === 429) return { outcome: "failed", code: "rate_limit", retry: true };
  if (response.status >= 500) return { outcome: "failed", code: "provider", retry: true };
  if (response.status === 401) return { outcome: "failed", code: "unauthorized", retry: false };
  let body: Record<string, unknown> | null = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 200 && body?.ErrorCode === 0 && typeof body.MessageID === "string" && MESSAGE_ID.test(body.MessageID)) {
    return { outcome: "accepted", messageId: body.MessageID };
  }
  const code = typeof body?.ErrorCode === "number" ? body.ErrorCode : 0;
  if (code === 406) return { outcome: "failed", code: "inactive_recipient", retry: false };
  if (code === 300) return { outcome: "failed", code: "invalid_recipient", retry: false };
  if (code === 400 || code === 401) return { outcome: "failed", code: "sender_rejected", retry: false };
  return { outcome: "failed", code: "rejected", retry: false };
}

async function worker(): Promise<Response> {
  if (!enabled || !postmarkToken) return json({ error: "Email sending is not configured." }, 503);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  let sent = 0, failed = 0;
  for (let i = 0; i < BATCH; i++) {
    const { data, error } = await admin.rpc("support_mail_claim");
    if (error) return json({ ok: false, error: "claim failed", sent, failed }, 500);
    const d = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (!d) break;
    let extra = await attachmentsFor(admin, d);
    if (extra !== "retry") {
      const signed = await offerSigning(admin, d, extra.attachments[0]?.Content ?? "");
      if (signed === "retry") extra = "retry";
      else if (signed) { d.body = signed.text; d.html_body = signed.html; }
    }
    const result: Outcome = extra === "retry" ? { outcome: "failed", code: "attachment_unavailable", retry: true } : await send(d, extra);
    const { error: recordError } = await admin.rpc("notification_record_attempt", {
      p_id: d.id, p_lease: d.lease_token, p_outcome: result.outcome,
      p_message_id: result.outcome === "accepted" ? result.messageId : null,
      p_error: result.outcome === "accepted" ? null : result.code,
      p_retry: result.outcome === "failed" ? result.retry : false, p_delay: 60,
    });
    if (recordError) console.error(JSON.stringify({ event: "support_mail_record_failed" }));
    if (result.outcome === "accepted") sent++; else failed++;
  }
  return json({ ok: true, sent, failed });
}

Deno.serve(async (request) => {
  if (!url || !serviceKey) return json({ error: "Edge Function configuration is unavailable." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const status = authorized(request.headers.get("authorization"));
  if (status !== 200) return json({ error: status === 401 ? "Unauthorized." : "Forbidden." }, status);
  try { return await worker(); }
  catch { return json({ ok: false, error: "Worker stopped unexpectedly." }, 500); }
});
