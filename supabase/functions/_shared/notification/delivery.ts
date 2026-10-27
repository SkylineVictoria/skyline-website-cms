// Runtime-neutral notification delivery: provider contract, Postmark adapter, webhook verification and the
// dispatch loop. No Deno or Node globals beyond web standards, so the same source runs in Edge, Node tests and
// any future host. Messages and errors are fixed strings: never addresses, bodies, tokens or provider text.

import { MAX_ATTACHMENT_BYTES, attachmentFileName, buildSubmissionPdf, toBase64 } from "./submission-pdf.ts";

export const POSTMARK_API = "https://api.postmarkapp.com";
export const MAX_DELIVERY_ATTEMPTS = 3;

export interface EmailAttachment { name: string; contentType: string; contentBase64: string }

export interface EmailMessage {
  deliveryId: string;
  from: { name: string; email: string };
  replyTo?: string;
  to: string;
  subject: string;
  textBody: string;
  attachments?: EmailAttachment[];
}

/** accepted: the provider took the message. retry/failed: definitively NOT accepted. unknown: it may have been accepted. */
export type SendOutcome =
  | { kind: "accepted"; messageId: string }
  | { kind: "retry"; code: string }
  | { kind: "failed"; code: string }
  | { kind: "unknown"; code: string };

export interface EmailProvider { readonly id: string; send(message: EmailMessage): Promise<SendOutcome> }

const MESSAGE_ID = /^[A-Za-z0-9-]{8,64}$/;
/** RFC 5322 display From: "Organization Name" <address>. Control characters and angle brackets are dropped; quotes and backslashes are escaped. */
export function formatFrom(name: string, email: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from the display name
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 100).replace(/[\\"]/g, "\\$&");
  return `"${clean}" <${email}>`;
}

export function createPostmarkProvider(options: { serverToken: string; fetch?: typeof fetch; timeoutMs?: number }): EmailProvider {
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    id: "postmark",
    async send(message) {
      let response: Response;
      try {
        response = await call(`${POSTMARK_API}/email`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": options.serverToken },
          body: JSON.stringify({
            From: formatFrom(message.from.name, message.from.email), ...(message.replyTo ? { ReplyTo: message.replyTo } : {}), To: message.to, Subject: message.subject, TextBody: message.textBody,
            ...(message.attachments?.length ? { Attachments: message.attachments.map((a) => ({ Name: a.name, Content: a.contentBase64, ContentType: a.contentType })) } : {}),
            MessageStream: "outbound", Metadata: { deliveryId: message.deliveryId }, TrackOpens: false, TrackLinks: "None",
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // The request may or may not have reached Postmark; it has no idempotency key, so this is never resent automatically.
        return { kind: "unknown", code: (error as Error)?.name === "TimeoutError" ? "timeout" : "network" };
      }
      if (response.status === 429) return { kind: "retry", code: "rate_limit" };
      if (response.status >= 500) return { kind: "retry", code: "provider" };
      if (response.status === 401) return { kind: "failed", code: "unauthorized" };
      let body: Record<string, unknown> | null = null;
      try { const parsed = await response.json(); body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { body = null; }
      if (response.status === 200) {
        if (body && body.ErrorCode === 0 && typeof body.MessageID === "string" && MESSAGE_ID.test(body.MessageID)) return { kind: "accepted", messageId: body.MessageID };
        return { kind: "unknown", code: "schema" };
      }
      const errorCode = typeof body?.ErrorCode === "number" ? body.ErrorCode : 0;
      if (errorCode === 406) return { kind: "failed", code: "inactive_recipient" };
      if (errorCode === 300) return { kind: "failed", code: "invalid_recipient" };
      // 400/401: the From signature is unknown or not confirmed in Postmark. Definitive for this sender, so never retried.
      if (errorCode === 400 || errorCode === 401) return { kind: "failed", code: "sender_rejected" };
      return { kind: "failed", code: "rejected" };
    },
  };
}

/** Deterministic provider for tests and local development; never reachable from selectEmailProvider. */
export function createMockEmailProvider(script: SendOutcome[] | ((message: EmailMessage, call: number) => SendOutcome)): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  let n = 0;
  return { id: "mock", sent, async send(message) { sent.push(message); n += 1; return typeof script === "function" ? script(message, n) : script[Math.min(n - 1, script.length - 1)]; } };
}

export type EmailProviderSelection = { provider: EmailProvider; unavailable: null } | { provider: null; unavailable: { code: "configuration_unavailable"; variables: string[] } };

/** Sending is on only when EF_NOTIFICATION_EMAIL_ENABLED is exactly "true" and the server token is set. Names only in errors. */
export function selectEmailProvider(config: Record<string, string | undefined>, options: { fetch?: typeof fetch } = {}): EmailProviderSelection {
  const variables: string[] = [];
  if ((config.EF_NOTIFICATION_EMAIL_ENABLED ?? "").trim() !== "true") variables.push("EF_NOTIFICATION_EMAIL_ENABLED");
  if (!(config.EF_POSTMARK_SERVER_TOKEN ?? "").trim()) variables.push("EF_POSTMARK_SERVER_TOKEN");
  if (variables.length) return { provider: null, unavailable: { code: "configuration_unavailable", variables } };
  return { provider: createPostmarkProvider({ serverToken: config.EF_POSTMARK_SERVER_TOKEN!.trim(), fetch: options.fetch }), unavailable: null };
}

// ---- worker authentication ----------------------------------------------------------------------
/** The worker accepts only the project's service-role key (platform authentication, no dedicated secret). 401 = no bearer token, 403 = any other token. */
export async function authorizeWorker(authorization: string | null, serviceKey: string): Promise<200 | 401 | 403> {
  const token = /^Bearer (.+)$/.exec((authorization ?? "").trim())?.[1] ?? "";
  if (!token) return 401;
  if (!serviceKey || !(await safeEqual(token, serviceKey))) return 403;
  return 200;
}

// ---- webhook verification (currently unused: the /webhook route is disabled until it can be authenticated) --------------------------------------------------------------------
// Postmark documents no HMAC signature for webhooks. Its supported controls are HTTP Basic credentials in the webhook URL
// (and an optional network allow-list), so callbacks are accepted only with the configured Basic credentials.

async function digest(value: string): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }

/** Constant-time equality of two secrets (compares SHA-256 digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function verifyBasicAuth(header: string | null, user: string, password: string): Promise<boolean> {
  if (!user || !password) return false;
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec((header ?? "").trim());
  if (!match) return false;
  let supplied: string;
  try { supplied = new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0))); } catch { return false; }
  return await safeEqual(supplied, `${user}:${password}`);
}

export type WebhookEvent = { recordType: "Delivery" | "Bounce" | "SpamComplaint"; messageId: string; eventKey: string; detail: { type?: string; description?: string } };

/** null = malformed (reject); "ignored" = a valid event type we do not track (acknowledge). */
export function parseWebhook(body: unknown): WebhookEvent | "ignored" | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const type = record.RecordType;
  if (typeof type !== "string") return null;
  if (type !== "Delivery" && type !== "Bounce" && type !== "SpamComplaint") return "ignored";
  if (typeof record.MessageID !== "string" || !MESSAGE_ID.test(record.MessageID)) return null;
  const id = typeof record.ID === "number" || typeof record.ID === "string" ? String(record.ID).replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) : "";
  return {
    recordType: type, messageId: record.MessageID, eventKey: `${type}:${record.MessageID}:${id}`,
    detail: type === "Bounce"
      ? { type: typeof record.Type === "string" ? record.Type.slice(0, 60) : undefined, description: typeof record.Description === "string" ? record.Description.slice(0, 300) : undefined }
      : {},
  };
}

// ---- dispatch loop ------------------------------------------------------------------------------

export interface ClaimedDelivery { id: string; leaseToken: string; recipientEmail: string; subject: string; body: string; sender: { name: string; email: string; replyTo?: string } | null; attempt: number; event?: string }
/** What the database releases for one claimed application_submitted delivery. The snapshot is held in memory for this send only. */
/** The issued CoE / VoE PDF for a claimed coe_voe_issued delivery (lease-checked in the database); held in memory for this send only. */
export interface CoeDocumentInfo { kind: "coe" | "voe"; sizeBytes: number; contentBase64: string; reference: string }
/** Thrown when the issued document could not be fetched: the delivery is retried later rather than sent without the document it promises. */
export class AttachmentUnavailableError extends Error {}
export interface SubmissionInfo { mode: "attach" | "link"; link: string; reference: string; version: number; institution: string; submittedAt: string | null; snapshot: unknown }
export interface DeliveryPort {
  claim(): Promise<ClaimedDelivery | null>;
  /** Optional: submission details for application_submitted deliveries (lease-checked in the database). */
  submission?(delivery: ClaimedDelivery): Promise<SubmissionInfo | null>;
  /** Optional: the issued CoE / VoE document for coe_voe_issued deliveries. Throws when it cannot be read; null when none was issued (a plain status change). */
  coeDocument?(delivery: ClaimedDelivery): Promise<CoeDocumentInfo | null>;
  record(delivery: ClaimedDelivery, outcome: "accepted" | "failed" | "unknown", messageId: string | null, errorCode: string | null, retry: boolean, delaySeconds: number): Promise<boolean>;
}
export interface DispatchSummary { accepted: number; retried: number; failed: number; unknown: number; stale: number }

/**
 * application_submitted carries the submitted form: as a PDF attachment, or as a link to the application (sign-in required) when the institution
 * chose "link", the PDF is over the size cap, or it could not be built. Nothing here can block or fail the email, and the PDF / snapshot are never
 * stored, returned or logged; the stored delivery row keeps only the reference-level subject and body.
 */
export async function composeBody(port: DeliveryPort, delivery: ClaimedDelivery): Promise<{ textBody: string; attachments?: EmailAttachment[] }> {
  if (delivery.event === "coe_voe_issued" && port.coeDocument) {
    let doc: CoeDocumentInfo | null;
    try { doc = await port.coeDocument(delivery); } catch { throw new AttachmentUnavailableError("coe document"); }
    if (!doc) return { textBody: delivery.body };
    if (!(doc.sizeBytes > 0 && doc.sizeBytes <= 3 * 1024 * 1024) || typeof doc.contentBase64 !== "string" || !doc.contentBase64) throw new AttachmentUnavailableError("coe document size");
    const label = doc.kind === "voe" ? "VoE" : "CoE";
    return { textBody: `${delivery.body}\n\nThe ${label} is attached as a PDF.`, attachments: [{ name: `${label}-${attachmentFileName(doc.reference).replace(/^application-/, "").replace(/\.pdf$/, "")}.pdf`, contentType: "application/pdf", contentBase64: doc.contentBase64 }] };
  }
  if (delivery.event !== "application_submitted" || !port.submission) return { textBody: delivery.body };
  let info: SubmissionInfo | null = null;
  try { info = await port.submission(delivery); } catch { return { textBody: delivery.body }; }
  if (!info) return { textBody: delivery.body };
  const withLink = () => ({ textBody: info!.link ? `${delivery.body}\n\nOpen the application (sign-in required): ${info!.link}` : delivery.body });
  if (info.mode !== "attach" || info.snapshot === null || info.snapshot === undefined) return withLink();
  try {
    const pdf = buildSubmissionPdf({ reference: info.reference, institution: info.institution, version: info.version, submittedAt: info.submittedAt, snapshot: info.snapshot });
    if (pdf.length > MAX_ATTACHMENT_BYTES) return withLink();
    return { textBody: `${delivery.body}\n\nThe submitted application is attached as a PDF.`, attachments: [{ name: attachmentFileName(info.reference), contentType: "application/pdf", contentBase64: toBase64(pdf) }] };
  } catch {
    return withLink();
  }
}

export async function dispatchBatch(port: DeliveryPort, provider: EmailProvider, limit: number): Promise<DispatchSummary> {
  const summary: DispatchSummary = { accepted: 0, retried: 0, failed: 0, unknown: 0, stale: 0 };
  for (let i = 0; i < limit; i++) {
    const delivery = await port.claim();
    if (!delivery) break;
    // The sender is resolved by the database per delivery scope; there is no platform fallback.
    const sender = delivery.sender;
    const delay = Math.min(900, 30 * 2 ** delivery.attempt);
    let stored: boolean;
    if (!sender) {
      stored = await port.record(delivery, "failed", null, "sender_unconfigured", false, 0); if (stored) summary.failed++;
    } else {
      let composed: { textBody: string; attachments?: EmailAttachment[] } | null = null;
      try { composed = await composeBody(port, delivery); } catch { composed = null; }
      const outcome: SendOutcome = composed
        ? await provider.send({ deliveryId: delivery.id, from: { name: sender.name, email: sender.email }, replyTo: sender.replyTo, to: delivery.recipientEmail, subject: delivery.subject, textBody: composed.textBody, attachments: composed.attachments })
        : { kind: "retry", code: "attachment_unavailable" };
      if (outcome.kind === "accepted") { stored = await port.record(delivery, "accepted", outcome.messageId, null, false, 0); if (stored) summary.accepted++; }
      else if (outcome.kind === "retry") { stored = await port.record(delivery, "failed", null, outcome.code, true, delay); if (stored) { if (delivery.attempt < MAX_DELIVERY_ATTEMPTS) summary.retried++; else summary.failed++; } }
      else if (outcome.kind === "failed") { stored = await port.record(delivery, "failed", null, outcome.code, false, 0); if (stored) summary.failed++; }
      else { stored = await port.record(delivery, "unknown", null, outcome.code, false, 0); if (stored) summary.unknown++; }
    }
    if (!stored) summary.stale++;
  }
  return summary;
}
