// HR (staff enrolment) email: configuration, plain-text templates, the outbox drain and inline link emails.
// Runtime-neutral and injectable (tested offline). It reuses the Postmark adapter and the on/off switches of the notification
// worker (_shared/notification/delivery.ts: EF_NOTIFICATION_EMAIL_ENABLED + EF_POSTMARK_SERVER_TOKEN) without changing them.
//
// Two kinds of mail:
//   * Outbox mail (hr.staff_emails, queued by the database in the same transaction as the change): application received,
//     already applied, new application (admin), documents uploaded (admin), rejected. drainHrEmails() claims, sends and
//     records each one. Never a token in these.
//   * Link mail (document invite, re-upload invite, offer): the token exists only in the request that made it. The
//     function sends it inline with sendLinkEmail() and logs the outcome WITHOUT the token. If the send fails the caller cancels
//     that link at once, so nobody holds a valid link they never received, and "send again" makes exactly one new link.
//
// Local lab only: EF_POSTMARK_API_URL redirects the Postmark calls to a mock server, and only when SUPABASE_URL is local.
import { POSTMARK_API, selectEmailProvider, type EmailProvider, type SendOutcome } from "./notification/delivery.ts";
import { isLocalSupabaseUrl } from "./captcha.ts";

export type HrEmailKind = "application_received" | "already_applied" | "admin_new_application" | "document_invite" | "reupload_invite"
  | "admin_documents_submitted" | "offer" | "signed_offer" | "admin_offer_signed" | "rejected";
/** Outbox kinds this module sends. The two signed-offer kinds carry the signed PDF (DrainPort.attachment). */
export const DRAINABLE_KINDS: readonly HrEmailKind[] = ["application_received", "already_applied", "admin_new_application", "admin_documents_submitted", "rejected", "signed_offer", "admin_offer_signed"];
export const ATTACHMENT_KINDS: readonly HrEmailKind[] = ["signed_offer", "admin_offer_signed"];
const EMAIL = /^[^@\s<>",]+@[^@\s<>",]+\.[^@\s<>",]+$/;

export interface HrMailConfig { from: { name: string; email: string } | null; adminTo: string[]; siteUrl: string | null; problems: string[] }

/** EF_HR_EMAIL_FROM ("Name <address>" or an address), EF_HR_ADMIN_NOTIFY_TO (comma-separated, up to 10), EF_HR_PUBLIC_SITE_URL. */
export function readHrMailConfig(env: Record<string, string | undefined>): HrMailConfig {
  const problems: string[] = [];
  let from: HrMailConfig["from"] = null;
  const rawFrom = (env.EF_HR_EMAIL_FROM ?? "").trim();
  const named = rawFrom.match(/^(.*)<([^<>]+)>$/);
  const address = (named ? named[2] : rawFrom).trim().toLowerCase();
  if (EMAIL.test(address)) from = { name: (named?.[1] ?? "").replace(/"/g, "").trim() || "Skyline", email: address };
  else problems.push("EF_HR_EMAIL_FROM");
  const adminTo = [...new Set((env.EF_HR_ADMIN_NOTIFY_TO ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!adminTo.length || adminTo.length > 10 || adminTo.some((a) => !EMAIL.test(a))) problems.push("EF_HR_ADMIN_NOTIFY_TO");
  let siteUrl: string | null = null;
  try {
    const url = new URL((env.EF_HR_PUBLIC_SITE_URL ?? "").trim());
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    if ((url.protocol === "https:" || local) && !url.username && !url.password && !url.search && !url.hash) siteUrl = url.toString().replace(/\/+$/, "");
  } catch { /* not set or invalid */ }
  if (!siteUrl) problems.push("EF_HR_PUBLIC_SITE_URL");
  return { from, adminTo: problems.includes("EF_HR_ADMIN_NOTIFY_TO") ? [] : adminTo, siteUrl, problems };
}

/** The Postmark provider, or null when sending is switched off. In a local lab EF_POSTMARK_API_URL points it at a mock. */
export function selectHrMailProvider(env: Record<string, string | undefined>, options: { fetch?: typeof fetch } = {}): EmailProvider | null {
  const base = (env.EF_POSTMARK_API_URL ?? "").trim().replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const redirected = base && isLocalSupabaseUrl(env.SUPABASE_URL ?? "")
    ? ((input: string | URL | Request, init?: RequestInit) => doFetch(String(input).replace(POSTMARK_API, base), init)) as typeof fetch
    : doFetch;
  return selectEmailProvider(env, { fetch: redirected }).provider;
}

export function linkUrl(siteUrl: string, purpose: "documents" | "reupload" | "offer", token: string): string {
  return `${siteUrl}/staff/${purpose === "offer" ? "offer" : "onboard"}#t=${encodeURIComponent(token)}`;
}

// eslint-disable-next-line no-control-regex -- a header value never carries control characters
const oneLine = (value: unknown, max = 120) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const SIGN_OFF = "\n\nSkyline Institute of Technology\nThis is an automated message.";

export interface RenderContext { siteUrl: string | null; profileId?: string; link?: string; expiresAt?: string; rejected?: Array<{ category: string; note: string }> }

/** Plain-text templates. Applicant mail without a link never contains a URL. */
export function renderHrEmail(kind: HrEmailKind, payload: Record<string, unknown>, ctx: RenderContext): { subject: string; text: string } | null {
  const name = oneLine(payload.name, 80) || "there";
  const adminLink = ctx.siteUrl && ctx.profileId ? `\n\nOpen the application: ${ctx.siteUrl}/admin/staff/employees/${ctx.profileId}` : "";
  const until = ctx.expiresAt ? new Date(ctx.expiresAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, "") : "";
  switch (kind) {
    case "application_received":
      return { subject: "We received your staff application",
        text: `Hello ${name},\n\nThank you for applying to work with us. We have received your application and resume, and an administrator will review it.\n\nIf we would like to continue, we will email you a private link to add your personal details and documents. You do not need to create an account.${SIGN_OFF}` };
    case "already_applied":
      return { subject: "We already have your staff application",
        text: `Hello,\n\nSomeone, probably you, tried to apply for a staff position again with this email address. We already have your application, so nothing was changed and you do not need to apply again.\n\nIf this was not you, you can ignore this email.${SIGN_OFF}` };
    case "admin_new_application":
      return { subject: oneLine(`New staff application: ${name}`), text: `A new staff application was received.\n\nName: ${name}\nEmail: ${oneLine(payload.email, 254)}${adminLink}` };
    case "admin_documents_submitted":
      return { subject: oneLine(`${name} has uploaded documents${payload.reupload ? " again" : ""}`),
        text: `${name} (${oneLine(payload.email, 254)}) has ${payload.reupload ? "uploaded the documents you asked for again" : "sent their personal details and documents"}. They are ready for review.${adminLink}` };
    case "rejected":
      return { subject: "Your staff application",
        text: `Hello ${name},\n\nThank you for your interest in working with us. After reviewing your application we will not be continuing with it at this time.\n\nWe wish you all the best.${SIGN_OFF}` };
    case "signed_offer":
      return { subject: "Your signed offer letter",
        text: `Hello ${name},\n\nThank you for signing your offer letter. A copy of the signed letter is attached for your records.\n\nWe will be in touch about your start and your staff account.${SIGN_OFF}` };
    case "admin_offer_signed":
      return { subject: oneLine(`${name} signed the offer`),
        text: `${name} (${oneLine(payload.email, 254)}) has signed the offer letter. The signed copy is attached.${adminLink}` };
    case "offer":
      if (!ctx.link) return null;
      return { subject: "Your offer letter from Skyline",
        text: `Hello ${name},\n\nWe are pleased to offer you a position. Please read your offer letter and, if you accept it, sign it on the page using this private link:\n\n${ctx.link}\n\nThe link works until ${until}. It is personal: please do not forward it. You do not need an account or a password.${SIGN_OFF}` };
    case "document_invite":
      if (!ctx.link) return null;
      return { subject: "Next step: your details and documents",
        text: `Hello ${name},\n\nThank you for applying. Please add your personal details and documents using this private link:\n\n${ctx.link}\n\nThe link works until ${until}. It is personal: please do not forward it. You do not need an account or a password.${SIGN_OFF}` };
    case "reupload_invite": {
      if (!ctx.link) return null;
      const items = (ctx.rejected ?? []).map((r) => `- ${oneLine(r.category, 40)}: ${oneLine(r.note, 300)}`).join("\n");
      return { subject: "Please upload a document again",
        text: `Hello ${name},\n\nWe need a new copy of ${(ctx.rejected ?? []).length === 1 ? "one document" : "some documents"}:\n\n${items}\n\nUpload them with this private link:\n\n${ctx.link}\n\nThe link works until ${until}. It is personal: please do not forward it.${SIGN_OFF}` };
    }
    default:
      return null;
  }
}

/** What a send outcome means for an outbox row. "unknown" may have been delivered, so it is never retried automatically. */
export function outcomeState(outcome: SendOutcome): { state: "sent" | "queued" | "failed"; messageId?: string; error?: string } {
  if (outcome.kind === "accepted") return { state: "sent", messageId: outcome.messageId };
  if (outcome.kind === "retry") return { state: "queued", error: `retry: ${outcome.code}` };
  if (outcome.kind === "failed") return { state: "failed", error: outcome.code };
  return { state: "failed", error: `unknown (${outcome.code}): it may have been delivered; check before sending again` };
}

export interface HrEmailRow { id: number; profileId: string; kind: HrEmailKind; audience: "applicant" | "admin"; to: string | null; payload: Record<string, unknown>; attempts: number }
export type HrAttachment = { name: string; contentType: string; contentBase64: string };
export interface DrainPort {
  claim(kinds: readonly string[], limit: number): Promise<HrEmailRow[]>;
  /** The signed offer PDF for a signed-offer email (payload.offerId), or null when it cannot be found. */
  attachment?(row: HrEmailRow): Promise<HrAttachment | null>;
  result(id: number, state: "sent" | "queued" | "failed", messageId?: string, error?: string): Promise<void>;
}

/** Sends queued outbox mail. Off (no provider): nothing is claimed and the rows stay queued. */
export async function drainHrEmails(port: DrainPort, provider: EmailProvider | null, config: HrMailConfig, limit = 20): Promise<{ sent: number; failed: number; requeued: number }> {
  const totals = { sent: 0, failed: 0, requeued: 0 };
  if (!provider) return totals;
  const rows = await port.claim(DRAINABLE_KINDS, limit);
  for (const row of rows) {
    const to = row.audience === "admin" ? config.adminTo.join(", ") : row.to ?? "";
    const missing = !config.from ? "EF_HR_EMAIL_FROM is not set" : !to ? (row.audience === "admin" ? "EF_HR_ADMIN_NOTIFY_TO is not set" : "no recipient") : null;
    const message = renderHrEmail(row.kind, row.payload ?? {}, { siteUrl: config.siteUrl, profileId: row.profileId });
    if (missing || !message) { await port.result(row.id, "failed", undefined, missing ?? "no template"); totals.failed++; continue; }
    let attachments: HrAttachment[] | undefined;
    if (ATTACHMENT_KINDS.includes(row.kind)) {
      // These emails exist to deliver the signed PDF: without it they are not sent (failed, visible to the admin, retryable).
      const file = port.attachment ? await port.attachment(row).catch(() => null) : null;
      if (!file) { await port.result(row.id, "failed", undefined, "the signed offer PDF could not be attached"); totals.failed++; continue; }
      attachments = [file];
    }
    const outcome = await provider.send({ deliveryId: `hr-${row.id}`, from: config.from!, to, subject: message.subject, textBody: message.text, ...(attachments ? { attachments } : {}) });
    const mapped = outcomeState(outcome);
    await port.result(row.id, mapped.state, mapped.messageId, mapped.error);
    if (mapped.state === "sent") totals.sent++; else if (mapped.state === "queued") totals.requeued++; else totals.failed++;
  }
  return totals;
}

/** A link email, sent inline. "skipped" = sending is switched off: the caller shows the link to the admin once instead. */
export async function sendLinkEmail(provider: EmailProvider | null, config: HrMailConfig, mail: { kind: "document_invite" | "reupload_invite" | "offer"; to: string; name: string; link: string; expiresAt: string; rejected?: Array<{ category: string; note: string }>; deliveryId: string }):
  Promise<{ state: "sent" | "failed" | "skipped"; messageId?: string; error?: string }> {
  if (!provider) return { state: "skipped", error: "email sending is switched off" };
  if (!config.from) return { state: "failed", error: "EF_HR_EMAIL_FROM is not set" };
  const message = renderHrEmail(mail.kind, { name: mail.name }, { siteUrl: config.siteUrl, link: mail.link, expiresAt: mail.expiresAt, rejected: mail.rejected });
  if (!message) return { state: "failed", error: "no template" };
  const mapped = outcomeState(await provider.send({ deliveryId: mail.deliveryId, from: config.from, to: mail.to, subject: message.subject, textBody: message.text }));
  // A link that may or may not have arrived is treated as failed: the caller cancels it and the admin sends a new one.
  return mapped.state === "sent" ? { state: "sent", messageId: mapped.messageId } : { state: "failed", error: mapped.error };
}
