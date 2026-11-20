// Documents & Signatures: everything the function does, behind injected ports (database RPCs, the private bucket, email), so the same code
// runs in the Edge Function (index.ts) and in the offline tests and the lab. Authorization is in the database: the caller's own RPC
// (public.signing_admin, CMS Admin only) for administrator actions, the service RPC (public.signing_service) for link holders, whose only
// credential is the token of an emailed link. No file is ever reachable by a public URL: links are signed for a few minutes after the
// stored bytes were re-hashed against the recorded sha256.
import { MAX_OFFER_BYTES } from "../_shared/offer-rules.ts";
import type { Letterhead } from "../_shared/letterhead.ts";
import { checkRecipients, fillHtmlVariables, fillSigningTemplate, renderSigningCodeEmail, renderSigningEmail, sampleFill, signingHtml, signingNameValid, signingToday, signingVariables, templateVariables, SIGNING_CONSENT,
  type SigningMailJob } from "../_shared/signing.ts";
import { toBase64 } from "../_shared/notification/attachment.ts";
import { PLACEHOLDERS, placeholderLabels, renderTemplate, sanitizeTemplateHtml, templatePlaceholders, templateText, templateValues, type TemplatePerson } from "../_shared/hr-template.ts";

import { isTokenFieldLabel } from "../_shared/template-variables.ts";
import { abrApplicationValues, abrFacts, acnDigits, checkApplicationAnswers, factsToDetails, lookupAbrCached, phoneE164, type AbrCache, type AbrConfirmed, type AbrDetails, type AbrFacts } from "../_shared/validation/abr.ts";
import type { AddressSearchResult } from "../_shared/validation/address.ts";
import { AGREEMENT_FROM_DECLARATION, answerKey, collectAnswers, composeRegistrationNumber, composeSuburb, correctionDraftProblem, correctionEditable, F04_ATTACHMENT_MAX, WITNESS_NAME_KEY, F04_ATTACHMENTS, F04_DECLARATIONS, F04_OPEN_PREFILL_KEYS, F04_RECORD_KEYS, groupOf,
  normalizeOfficeAddress, splitSuburb } from "../_shared/agent-onboarding.ts";
import { afterCompletion, ONBOARDING_ACTIONS, onboardingSignRules, stepTimer, takePdfWorkMs, type OnboardingContext } from "./onboarding.ts";

const HRMS_PLACEHOLDER = new Set(PLACEHOLDERS.map((p) => p.key));
/** A document template in the sectioned model (TPL-02): a header or footer, or [Variable] tokens. Everything else renders as before. */
// deno-lint-ignore no-explicit-any
export const isSectioned = (t: Record<string, any>) => t.kind === "text" && (t.bracket_variables === true || !!String(t.header_html ?? "").trim() || !!String(t.footer_html ?? "").trim());
/** A field made from the template's own tokens ([Student Initial], an unknown [token]), with where the renderer placed it. */
export interface GeneratedField { label: string; type: "text" | "initials"; page: number; x: number; y: number; w: number; h: number }
import type { EmailProvider } from "../_shared/notification/delivery.ts";
import { outcomeState, type HrMailConfig } from "../_shared/hr-mail.ts";

export class SigningError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export interface RpcError { message: string; code?: string }
export interface SigningPorts {
  /** public.signing_service with the service role. */
  // deno-lint-ignore no-explicit-any
  service(action: string, args?: { hash?: string | null; id?: string | null; data?: unknown }): Promise<any>;
  /** public.signing_admin as the caller (their JWT): the database refuses anyone who is not a CMS Admin. */
  // deno-lint-ignore no-explicit-any
  admin(action: string, id?: string | null, data?: unknown): Promise<any>;
  /** Any other RPC with the service role (the onboarding follow-up after a signature: public.agency_onboarding_* service functions). */
  // deno-lint-ignore no-explicit-any
  serviceRpc?(name: string, args: Record<string, unknown>): Promise<any>;
  /** Any other RPC as the caller (the staff record's letter variables, hr_admin_template_values: Admin only in the database). */
  // deno-lint-ignore no-explicit-any
  callerRpc?(name: string, args: Record<string, unknown>): Promise<any>;
  /** The template-assets bucket (pictures linked from a template's header, body or footer): read only, by the path after /template-assets/. */
  assets?: { download(path: string): Promise<Uint8Array | null> };
  storage: {
    download(path: string): Promise<Uint8Array | null>;
    upload(path: string, bytes: Uint8Array): Promise<boolean>;
    remove(paths: string[]): Promise<void>;
    signedUrl(path: string, seconds: number, downloadName?: string): Promise<string | null>;
  };
  letterhead(): Promise<Letterhead | null>;
  mail: { provider: EmailProvider | null; config: HrMailConfig };
  /** ABN Lookup (ABR JSON service): the registered party's GUID (secret EF_ABR_GUID; empty = not set up). Tests inject fetch. */
  abr?: { guid: string; fetch?: typeof fetch };
  /** Australian address suggestions (the address-search function's Geoscape lookup, same key, server side): the F04 wizard's address boxes. */
  address?(query: string): Promise<AddressSearchResult>;
  /** True when the request carries the service-role key itself (the scheduled job). */
  isServiceCaller: boolean;
  uuid(): string;
  /** Runs after the response where the runtime allows it (EdgeRuntime.waitUntil); awaited otherwise. */
  later(work: Promise<unknown>): void | Promise<void>;
}
export interface SigningCall { body: Record<string, unknown>; upload: { name: string; bytes: Uint8Array } | null; ip: string | null; userAgent: string | null }

export const sha256Hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))].map((b) => b.toString(16).padStart(2, "0")).join("");
const TOKEN = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_INVALID = "This signing link is invalid or expired.";
/** A link whose request was deleted (2026-11-20): neutral; no "request a new link". */
export const LINK_GONE = "This link is no longer available.";
const TOO_MANY = "Too many requests. Please wait a few minutes and try again.";
/** What a link holder (no account) may do: open, sign, decline, the emailed code (offer letters) and "Request a new link". */
const LINK_ACTIONS = ["open", "download", "sign", "decline", "code_send", "code_verify", "link_request", "draft_save", "address_search", "attachment_upload", "attachment_remove"];
/** The F04 wizard's draft ("Save and continue later"): at most this many characters of JSON. */
const DRAFT_MAX = 60000;
const isApplication = (record: { onboarding?: unknown }) => (record.onboarding as { kind?: string } | null)?.kind === "application";

/** The register's answers cached by ABN in public.abr_businesses (service RPCs); null without the service port. */
export function abrCache(ports: Pick<SigningPorts, "serviceRpc">): AbrCache | null {
  if (!ports.serviceRpc) return null;
  return {
    get: async (abn) => (await ports.serviceRpc!("abr_business_cache_get", { p_abn: abn })) ?? null,
    put: async (details) => { await ports.serviceRpc!("abr_business_cache_put", { p_details: details }); },
  };
}

/** The Agent Application Form's template: sent by itself (Add business, corrections), never from "Send a document to sign". */
export const F04_SYSTEM_KEY = "agent_application_form";
/** The agent onboarding blanks (F04, P06, F05): sent by the business onboarding flow only, never from New signing request. */
export const ONBOARDING_SYSTEM_KEYS: ReadonlySet<string> = new Set(["agent_application_form", "agent_agreement", "agent_referee_check_form"]);
export const ONBOARDING_NOT_HERE = "This is an agent onboarding document (application form, agreement or referee check): the business onboarding sends it. Choose another document.";
export const F04_NOT_HERE ="The Agent Application Form is sent automatically when a business is added (and back to its agency admin for corrections). Choose another document.";
/** An open correction of an F04 request (agency_onboarding_correction_of): the flagged answers and the reviewed ACN / MARN. */
export interface F04Correction { round: number; message?: string | null; flags: Record<string, string>; acn?: string; marn?: string;
  /** The reviewed answers the correction was sent with (agency_onboarding.answers, 2026-11-21): a Yes / No question as YES / NO. */
  answers?: Record<string, unknown> | null }
/**
 * A correction is signed: every field staff did not flag keeps the value it was sent with (the declaration's name and role are given again).
 * A Yes / No tick box keeps the reviewed answer (2026-11-21): the request's tick boxes are stored without a value, so the box reads the
 * reviewed answers (YES / NO) instead; before this every unflagged Yes / No question was signed unticked.
 */
export function lockUnflagged(fields: ReadonlyArray<{ id: string; type: string; key?: string | null; value?: string | null }>, values: Record<string, unknown>, flags: Record<string, string>,
  reviewed: Record<string, unknown> = {}): void {
  for (const f of fields) {
    if (!f.key || (f.type !== "text" && f.type !== "checkbox")) continue;
    const key = answerKey(f.key);
    if (key === "agent_registration_number" || correctionEditable(key, flags)) continue;
    if (f.type === "checkbox") {
      const group = groupOf(f.key);
      const held = group ? String(reviewed[group.key] ?? "").trim().toUpperCase() : "";
      values[f.id] = held && group ? (held === group.answer ? "true" : "false") : (f.value === "true" ? "true" : "false");
    } else values[f.id] = String(f.value ?? "");
  }
}
/** The reviewed answers a correction page shows (text values only, as the agency signed them). */
const signedAnswers = (answers: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(Object.entries(answers ?? {}).filter(([k, v]) => typeof v === "string" && /^[a-z][a-z0-9_]{0,60}$/.test(k)).map(([k, v]) => [k, String(v).slice(0, 2000)]));

const textOf = (value: unknown) => (typeof value === "string" ? value.trim() : "");
/**
 * The F04 prefill (2026-11-19), one rule for the send and the open: the register's values (staff-confirmed ones win) for the company, the
 * business record (sign-up, earlier answers on the profile) for the contact, website and office; the postcode in the Suburb box, phones as
 * E.164. Keys without a value are left out.
 */
export function f04Prefill(input: { details: AbrDetails | null; confirmed: (AbrConfirmed & { givenName?: string; familyName?: string }) | null; record: Record<string, unknown>;
  /** Round 3: the facts kept on the business profile stand in for the register when no lookup is at hand (year founded, ACN, names). */
  facts?: Partial<AbrFacts> | null }): Record<string, string> {
  const record = input.record ?? {};
  const details = input.details ?? factsToDetails(input.facts);
  const abr = abrApplicationValues({ details, confirmed: input.confirmed, contact: {
    givenName: textOf(input.confirmed?.givenName) || textOf(record.contact_given_name), familyName: textOf(input.confirmed?.familyName) || textOf(record.contact_family_name),
    email: textOf(record.contact_email), phone: textOf(record.contact_phone) } });
  const out: Record<string, string> = { ...abr };
  for (const key of F04_RECORD_KEYS) { const v = textOf(record[key]); if (v) out[key] = v; }
  // The register's postcode joins a suburb the record names; a postcode alone never fills the Suburb box (round 3).
  const postcode = String(input.confirmed?.postcode ?? "").trim() || details?.postcode || "";
  if (out.office_suburb) { const kept = splitSuburb(out.office_suburb); out.office_suburb = kept.suburb ? composeSuburb(kept.suburb, kept.postcode || postcode) : ""; }
  const phone = phoneE164(out.contact_phone); if (phone) out.contact_phone = phone;
  // Round 3: the declarant is the agency contact (name and position) unless the record names someone else.
  if (!out.declarant_name) out.declarant_name = [out.contact_given_name, out.contact_family_name].map((v) => String(v ?? "").trim()).filter(Boolean).join(" ");
  if (!out.declarant_role && out.contact_position) out.declarant_role = out.contact_position;
  const normalized = normalizeOfficeAddress(out);
  return Object.fromEntries(Object.entries(normalized).filter(([, v]) => String(v ?? "").trim() !== ""));
}

type LinkField = { id: string; type: string; key?: string | null; value?: string | null };
/** The F04 fields still blank among the keys filled on open (a Yes / No pair with no box ticked counts as blank). */
export function f04BlankKeys(fields: readonly LinkField[]): string[] {
  return F04_OPEN_PREFILL_KEYS.filter((key) => {
    const mine = fields.filter((f) => f.key && answerKey(f.key) === key);
    if (!mine.length) return false;
    if (mine.some((f) => groupOf(f.key))) return !mine.some((f) => f.value === "true");
    return mine.every((f) => !String(f.value ?? "").trim());
  });
}
/** The fields with the filled values written into the blank ones only (what the page shows after the fill). */
export function withFilled<T extends LinkField>(fields: readonly T[], filled: Record<string, string>): T[] {
  return fields.map((f) => {
    if (!f.key) return f;
    const group = groupOf(f.key);
    if (group) { const answer = String(filled[group.key] ?? "").toUpperCase(); return answer && answer === group.answer && f.value !== "true" ? { ...f, value: "true" } : f; }
    const value = filled[answerKey(f.key)];
    return value && f.type === "text" && !String(f.value ?? "").trim() ? { ...f, value } : f;
  });
}
/** What an uploaded attachment is, from its first bytes: a PDF, a PNG or a JPEG; anything else is refused. */
export function attachmentType(bytes: Uint8Array): string | null {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/** What the F04 wizard sends besides the fields: the ACN, the MARN and the declaration tick boxes. */
export interface ApplicationSubmission { acn: string; marn: string; declarations: Record<string, boolean> }
/**
 * F04 wizard (2026-11-19): the server's checks of a signed Agent Application Form, besides the title and the referees (checkApplicationAnswers):
 * every declaration statement ticked; the MARN digits only; the ACN nine digits; litigation details when litigation is Yes; the sub-agent
 * names when sub-agents is Yes. Returns the cleaned values.
 */
export function checkApplicationSubmission(input: unknown, answers: Record<string, string>): ApplicationSubmission {
  const app = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (!app) throw new SigningError("Open the application form from your email link again and complete every step before you sign.");
  const ticks = app.declarations && typeof app.declarations === "object" ? app.declarations as Record<string, unknown> : {};
  const unticked = F04_DECLARATIONS.filter((d) => ticks[d.key] !== true);
  if (unticked.length) throw new SigningError(`Tick every declaration statement before you sign (${unticked.length} not ticked).`);
  const marn = String(app.marn ?? "").replace(/\s/g, "");
  if (marn && !/^\d{1,10}$/.test(marn)) throw new SigningError("The MARN is a number: digits only.");
  // Round 3: "004 028 077" / "004-028-077" are the same ACN: digits before the check and in storage.
  const acn = acnDigits(String(app.acn ?? ""));
  if (acn &&!/^\d{9}$/.test(acn)) throw new SigningError("The ACN has 9 digits.");
  const tick = (key: string) => String(answers[key] ?? "").toUpperCase();
  if (tick("litigation_involved") === "YES" && !String(answers.litigation_details ?? "").trim()) throw new SigningError("Give the details of the litigation or dispute.");
  if (tick("works_with_sub_agents") === "YES" && !String(answers.sub_agent_names ?? "").trim()) throw new SigningError("Give the name of the sub-agent agency.");
  return { acn, marn, declarations: Object.fromEntries(F04_DECLARATIONS.map((d) => [d.key, true])) };
}
/** s***@example.com: enough for the signer to recognise the address, nothing more. */
export const maskEmail = (email: string) => { const [user, domain] = String(email).split("@"); return domain ? `${user.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}` : ""; };
// The PDF engine (pdf-lib + fontkit) loads on the first request that makes, checks or signs a PDF, not at boot.
const letterPdfModule = () => import("../_shared/offer-letter-pdf.ts");
const offerPdfModule = () => import("../_shared/offer-pdf.ts");
const signingPdfModule = () => import("../_shared/signing-pdf.ts");
const documentPdfModule = () => import("../_shared/document-pdf.ts");
const onboardingPdfModule = () => import("../_shared/agent-onboarding-pdf.ts");
/** The error the CMS acts on: it uploads the two blanks shipped with the site (agent_onboarding_install) and sends again. */
export const ONBOARDING_TEMPLATES_MISSING = "Install the agent onboarding templates first.";
/** Today in Melbourne as YYYY-MM-DD (the date printed next to the institution's signature). */
export const isoToday = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const ASSET_PATH = /\/template-assets\/([^?#]+)/;
/** The bytes of each template-assets picture by its public URL (one that cannot be read is left out, and the PDF prints without it). */
export async function templateAssetImages(ports: Pick<SigningPorts, "assets">, urls: readonly string[]): Promise<Record<string, Uint8Array>> {
  const images: Record<string, Uint8Array> = {};
  if (!ports.assets || !urls.length) return images;
  await Promise.all(urls.map(async (url) => {
    const path = ASSET_PATH.exec(url)?.[1];
    if (!path) return;
    try {
      const bytes = await ports.assets!.download(decodeURIComponent(path));
      if (bytes?.length) images[url] = bytes;
    } catch { /* left out */ }
  }));
  return images;
}
const safeName = (title: string) => (title.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 80) || "document");

export async function handleSigning(call: SigningCall, ports: SigningPorts): Promise<unknown> {
  const body = { ...call.body };
  // The released single-recipient form (20261110154917, 20261113100000): recipientName / recipientEmail and a staff member's profileId.
  if (typeof body.profileId === "string" && UUID.test(body.profileId) && !body.subjectType) { body.subjectType = "employee"; body.subjectId = body.profileId; }
  if (!Array.isArray(body.recipients) && (body.recipientName || body.recipientEmail)) body.recipients = [{ name: body.recipientName, email: body.recipientEmail }];
  const action = String(body.action ?? "");
  const staged: string[] = [];
  const store = async (path: string, bytes: Uint8Array) => {
    if (!(await ports.storage.upload(path, bytes))) throw new SigningError("The document could not be saved.");
    staged.push(path);
  };
  const fileBytes = async (path: string, expected: string) => {
    const bytes = await ports.storage.download(path);
    if (!bytes) throw new SigningError("The document could not be opened.");
    if (await sha256Hex(bytes) !== expected) throw new SigningError("The document integrity check failed. It was not opened.");
    return bytes;
  };
  const fileUrl = async (path: string, expected: string, name?: string) => {
    await fileBytes(path, expected);
    const url = await ports.storage.signedUrl(path, 300, name);
    if (!url) throw new SigningError("The document link could not be created.");
    return url;
  };
  try {
    // ------------------------------------------------------------------ link holders (no account)
    if (LINK_ACTIONS.includes(action)) {
      // Rate limits (their own transactions, so a refused call still counts): per address and per link.
      const token = String(body.token ?? "");
      const limited = async (key: string, limit: number, seconds: number) => {
        try { return (await ports.service("rate", { data: { key, limit, seconds } })) === false; } catch { return false; }
      };
      if (call.ip && await limited(`ip:${call.ip.replace(/[^A-Za-z0-9.:_-]/g, "").slice(0, 60) || "unknown"}`, 120, 600)) throw new SigningError(TOO_MANY, 429);
      if (TOKEN.test(token) && await limited(`link:${(await sha256Hex(new TextEncoder().encode(token))).slice(0, 40)}`, 60, 600)) throw new SigningError(TOO_MANY, 429);
      if (action === "link_request") {
        // "Request a new link": the same answer whether or not the link was ours; admissions are told when it was.
        if (TOKEN.test(token)) {
          await ports.service("link_request", { hash: await sha256Hex(new TextEncoder().encode(token)), data: { ip: call.ip } }).catch(() => undefined);
          await ports.later(drainSigningMail(ports));
        }
        return { requested: true };
      }
      if (!TOKEN.test(token)) throw new SigningError(LINK_INVALID, 403);
      const hash = await sha256Hex(new TextEncoder().encode(token));
      const linkCall = async (name: string, data: unknown = {}) => {
        try { return await ports.service(name, { hash, data }); }
        catch (error) {
          const e = error as RpcError; if (e.code === "SG409") throw error;
          // The link's request no longer exists (its business was deleted at Application sent): a neutral answer, nothing else said.
          if (/no longer available/i.test(e.message)) throw new SigningError(LINK_GONE, 410);
          throw new SigningError(/invalid or expired/.test(e.message) ? LINK_INVALID : e.message, /invalid or expired/.test(e.message) || e.code === "42501" ? 403 : e.code === "SG429" ? 429 : 400);
        }
      };
      const record = await linkCall("open", { ip: call.ip });
      if (action === "download") {
        // The signing page's Download button (2026-11-20): a new short-lived link on every click, so the page never holds a stale one.
        // The same document "open" shows (the signed PDF once signed); never the completion certificate.
        const signed = record.state === "signed";
        const path = signed ? record.signed_path : record.current_path ?? record.original_path;
        const expected = signed ? record.signed_hash : record.current_hash ?? record.original_hash;
        return { url: await fileUrl(path, expected, `${safeName(record.title)}${signed ? "-signed" : ""}.pdf`) };
      }
      if (action === "draft_save") {
        // F04 wizard "Save and continue later": the contact's answers so far, kept on the server for this link's request and signer.
        if (!isApplication(record) || !ports.serviceRpc) throw new SigningError("Only the application form can be saved as a draft.");
        if (record.state === "signed" || record.recipient?.state === "signed") throw new SigningError("This form is already signed.");
        const draft = body.draft && typeof body.draft === "object" && !Array.isArray(body.draft) ? body.draft : null;
        if (!draft || JSON.stringify(draft).length > DRAFT_MAX) throw new SigningError("The draft could not be saved: it is too large.");
        // A correction (2026-11-21): the page saves only the flagged answers; anything else is refused by name.
        const open = await ports.serviceRpc("agency_onboarding_correction_of", { p_request: record.id }).catch(() => null) as F04Correction | null;
        if (open) { const refused = correctionDraftProblem(draft as Record<string, unknown>, open.flags ?? {}); if (refused) throw new SigningError(refused); }
        const saved = await ports.serviceRpc("agency_onboarding_draft_save", { p_request: record.id, p_recipient: record.recipient.id, p_draft: draft });
        return { saved: true, savedAt: saved };
      }
      const waitingApplication = () => {
        if (!isApplication(record) || !ports.serviceRpc) throw new SigningError("Only the application form can do this.");
        if (record.state === "signed" || record.recipient?.state === "signed") throw new SigningError("This form is already signed.");
      };
      if (action === "address_search") {
        // The wizard's address boxes: the address-search function's lookup (same Geoscape key, server side) for a link holder, who has no login.
        waitingApplication();
        if (await limited(`addr:${hash.slice(0, 40)}`, 40, 60)) throw new SigningError("Too many address searches. Please wait a moment.", 429);
        const q = String(body.q ?? "").trim().slice(0, 200);
        if (q.length < 4) return { ok: true, suggestions: [] };
        const found = ports.address ? await ports.address(q).catch(() => ({ kind: "unavailable" as const })) : { kind: "unavailable" as const };
        return found.kind === "ok" ? { ok: true, suggestions: found.suggestions } : { ok: false, unavailable: true };
      }
      if (action === "attachment_upload" || action === "attachment_remove") {
        // The organisation chart / business profile, uploaded on the wizard's Agency step: kept with the application, opened by staff.
        waitingApplication();
        const kind = String(body.kind ?? "");
        if (!(kind in F04_ATTACHMENTS)) throw new SigningError("Say which file this is.");
        const open = await ports.serviceRpc!("agency_onboarding_correction_of", { p_request: record.id }).catch(() => null) as F04Correction | null;
        if (open && !correctionEditable(`attach_${kind}`, open.flags ?? {})) throw new SigningError("Only the answers SLIT asked you to correct can be changed: this file was not flagged.");
        if (action === "attachment_remove") {
          await ports.serviceRpc!("agency_onboarding_attachment_remove", { p_request: record.id, p_recipient: record.recipient.id, p_kind: kind });
          return { removed: true, kind };
        }
        if (await limited(`attach:${hash.slice(0, 40)}`, 20, 600)) throw new SigningError(TOO_MANY, 429);
        if (!call.upload?.bytes.length) throw new SigningError("Choose a file.");
        if (call.upload.bytes.length > F04_ATTACHMENT_MAX) throw new SigningError("The file must be smaller than 5 MB.");
        const contentType = attachmentType(call.upload.bytes);
        if (!contentType) throw new SigningError("Upload a PDF, PNG or JPEG file.");
        const name = call.upload.name.replace(/[\u0000-\u001f\u007f/\\]/g, " ").trim().slice(0, 160) || `${kind}.${contentType.split("/")[1]}`; // eslint-disable-line no-control-regex
        return await ports.serviceRpc!("agency_onboarding_attachment_save", { p_request: record.id, p_recipient: record.recipient.id, p_kind: kind,
          p_data: { name, contentType, base64: toBase64(call.upload.bytes) } });
      }
      if (action === "code_send") {
        const { provider, config } = ports.mail;
        if (!provider || !config.from) throw new SigningError("The code cannot be emailed right now. Please try again later or contact admissions.", 503);
        const sent = await linkCall("code_send", { ip: call.ip });
        const message = renderSigningCodeEmail({ name: sent.name, code: sent.code, title: sent.title, minutes: sent.expires_in_minutes });
        const outcome = outcomeState(await provider.send({ deliveryId: `sign-code-${record.recipient.id}-${Date.now()}`, from: config.from, to: sent.to, subject: message.subject, textBody: message.text, htmlBody: message.html }));
        if (outcome.state !== "sent") throw new SigningError("The code could not be emailed. Please try again in a minute.", 502);
        return { sent: true, to: maskEmail(sent.to), minutes: sent.expires_in_minutes };
      }
      if (action === "code_verify") {
        const result = await linkCall("code_verify", { code: String(body.code ?? "").replace(/\D/g, "").slice(0, 6), ip: call.ip });
        return { ok: result.ok === true, session: result.session ?? null, reason: result.reason ?? null, remaining: result.remaining ?? null };
      }
      if (action === "decline") {
        const after = await linkCall("decline", { reason: String(body.reason ?? "").slice(0, 500) });
        await ports.later(drainSigningMail(ports));
        return { declined: true, state: after.state };
      }
      if (action === "sign") {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (body.agreed !== true || !signingNameValid(name)) throw new SigningError("Enter your full name and tick the agreement.");
        const kind = ["typed", "drawn", "uploaded"].includes(String(body.signatureKind)) ? String(body.signatureKind) : "typed";
        const values = body.values && typeof body.values === "object" ? body.values as Record<string, unknown> : {};
        // A token that appears more than once is one answer: the signing page shows one input for it, so every copy carries the same text.
        const answers = new Map<string, string>();
        for (const f of (record.fields ?? []) as Array<{ id: string; type: string; label: string }>) {
          if (f.type !== "text" || !isTokenFieldLabel(f.label)) continue;
          const answer = String(values[f.id] ?? "").trim();
          if (answers.has(f.label) && answers.get(f.label) !== answer) throw new SigningError(`Give one answer for ${f.label}: it appears more than once in the document.`);
          answers.set(f.label, answer);
        }
        // Agent Application Form (2026-11-19): the title comes from the list; the two referees need different email addresses. F04 wizard: the
        // declarations, the MARN and the ACN (checkApplicationSubmission); the registration box prints "ACN … / MARN …" from them.
        let submission: ApplicationSubmission | null = null;
        const combinedPlan = record.onboarding as { combined?: boolean; witness?: { preset?: boolean; box?: { page: number; x: number; y: number; w: number; h: number } | null } | null } | null;
        let witness: { name: string; png: unknown } | null = null;
        if (isApplication(record)) {
          const fields = (record.fields ?? []) as Array<{ id: string; type: string; key?: string | null; value?: string | null }>;
          const valueOf = (key: string) => { const f = fields.find((x) => x.key === key); return f ? { f, v: String(values[f.id] ?? f.value ?? "").trim() } : null; };
          // 2026-11-19: a postcode is never kept in the Province box (it goes in the Suburb box); phones are kept as E.164.
          // Round 3: the Suburb box never holds a postcode alone (normalizeOfficeAddress).
          const province = valueOf("office_province"), suburb = valueOf("office_suburb");
          const office = normalizeOfficeAddress({ office_province: province?.v ?? "", office_suburb: suburb?.v ?? "" });
          if (province && office.office_province !== province.v) values[province.f.id] = office.office_province;
          if (suburb && office.office_suburb !== suburb.v) values[suburb.f.id] = office.office_suburb;
          for (const key of ["contact_phone", "ref1_phone", "ref2_phone"]) {
            const phone = valueOf(key); const e164 = phone ? phoneE164(phone.v) : null;
            if (phone && e164) values[phone.f.id] = e164;
          }
          // A correction request: every field staff did not flag keeps the reviewed value it was sent with (the page shows it read-only).
          const correction = ports.serviceRpc ? await ports.serviceRpc("agency_onboarding_correction_of", { p_request: record.id }).catch(() => null) as F04Correction | null : null;
          if (correction) lockUnflagged(fields, values, correction.flags ?? {}, correction.answers ?? {});
          const byKey: Record<string, string> = {};
          for (const f of fields) if (f.type === "text" && f.key) byKey[f.key] = String(values[f.id] ?? f.value ?? "").trim();
          const signRules = await onboardingSignRules(ports);
          const checked = checkApplicationAnswers(byKey, { refereeEmailsDistinct: signRules.refereeEmailsDistinct });
          if (checked.error) throw new SigningError(checked.error);
          submission = checkApplicationSubmission(body.application, collectAnswers(fields.map((f) => ({ key: f.key, type: f.type, value: String(values[f.id] ?? f.value ?? "") }))));
          // A correction (2026-11-18): only the fields staff flagged can change; the ACN and the MARN stay as reviewed unless flagged.
          if (correction) {
            const flagged = new Set(Object.keys(correction.flags ?? {}));
            if (!flagged.has("acn")) submission.acn = acnDigits(correction.acn ?? "");
            if (!flagged.has("marn")) submission.marn = String(correction.marn ?? "").trim();
          }
          const registration = fields.find((f) => f.key === "agent_registration_number");
          if (registration) values[registration.id] = composeRegistrationNumber(submission.acn, submission.marn);
          // F04 + P06 signed once (2026-11-20): the agreement's signatory is the declarant; the witness is typed (name) and DRAWN (signature)
          // on this page unless staff gave the witness before sending (then it is printed already).
          if (combinedPlan?.combined) {
            for (const [key, from] of Object.entries(AGREEMENT_FROM_DECLARATION)) { const f = fields.find((x) => x.key === key); const source = valueOf(from); if (f && source) values[f.id] = source.v; }
            if (!combinedPlan.witness?.preset) {
              const w = (body.application as { witness?: { name?: unknown; png?: unknown } } | undefined)?.witness ?? {};
              const witnessName = String(w.name ?? "").replace(/\s+/g, " ").trim().slice(0, 150);
              const drawn = typeof w.png === "string" && !!w.png.trim();
              // Business Rules (agents.agency_witness_on_agreement): an optional witness may be left out entirely; one given needs both.
              const optional = !(await onboardingSignRules(ports)).agencyWitnessRequired;
              if (!(optional && !witnessName && !drawn)) {
                if (witnessName.length < 2) throw new SigningError("Enter your witness's full name.");
                if (!drawn) throw new SigningError("Ask your witness to draw their signature in the witness box (it cannot be typed).");
                witness = { name: witnessName, png: w.png };
                const nameField = fields.find((x) => x.key === WITNESS_NAME_KEY);
                if (nameField) values[nameField.id] = witnessName;
              }
            }
          }
        }
        const signTimer = combinedPlan?.combined ? stepTimer("onboarding_sign_once") : null;
        const [pdf, letter] = await Promise.all([signingPdfModule(), letterPdfModule()]);
        signTimer?.lap("pdf_modules");
        let image: string | null = null, signatureHash: string;
        if (kind === "typed") signatureHash = await sha256Hex(new TextEncoder().encode(name));
        else { const bytes = pdf.signatureImageBytes(body.signatureImage); image = toBase64(bytes); signatureHash = await sha256Hex(bytes); }
        let witnessPng: string | null = null;
        if (witness) {
          try { witnessPng = toBase64(pdf.signatureImageBytes(witness.png)); }
          catch { throw new SigningError("Ask your witness to draw their signature again in the witness box."); }
        }
        const typed = [name, ...Object.values(values).filter((v): v is string => typeof v === "string" && v !== "true" && v !== "false")];
        if (await letter.unsupportedText(typed)) throw new SigningError("Please use Latin letters for your name and answers on this PDF. You can draw your signature in any script.");
        signTimer?.lap("check_text");
        const data = { signer_name: name, signature_kind: kind, signature_image: image, signature_hash: signatureHash, consent: SIGNING_CONSENT, values,
          document_hash: body.documentHash, ip: call.ip, user_agent: call.userAgent, code_session: typeof body.codeSession === "string" ? body.codeSession.slice(0, 64) : null };
        for (let attempt = 0; ; attempt++) {
          // What the document looks like once this person has signed; nothing is written yet.
          const plan = await linkCall("sign_plan", data);
          // The certificate's letterhead (Website Settings + the logo over HTTPS) is fetched while the document is stamped and stored.
          const letterheadSoon = plan.complete ? ports.letterhead().catch(() => null) : null;
          signTimer?.lap("io_plan");
          const original = await fileBytes(plan.original_path, plan.original_hash);
          signTimer?.lap("io_download");
          // The witness's drawn signature is printed in the agreement's witness box (never a typed field).
          const box = (plan.onboarding as typeof combinedPlan)?.witness?.box ?? combinedPlan?.witness?.box ?? null;
          const stampFields = witnessPng && box ? [...plan.fields, { recipient_id: null, type: "signature", page: Number(box.page), x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h),
            value: `data:image/png;base64,${witnessPng}`, done: true, label: "Witness signature" }] : plan.fields;
          // The combined application form + agreement (15 pages): the signature appended as an incremental update (CPU budget, 2026-11-20).
          const stamp = { reference: plan.reference, title: plan.title, fields: stampFields, recipients: plan.recipients, incremental: combinedPlan?.combined === true };
          const signed = await pdf.stampDocument(original, stamp);
          const signedHash = await sha256Hex(signed);
          signTimer?.lap("stamp");
          const mine: string[] = [];
          const currentPath = `${plan.id}/signed-${ports.uuid()}.pdf`;
          await store(currentPath, signed); mine.push(currentPath);
          signTimer?.lap("io_store");
          let certificatePath: string | null = null, certificateHash: string | null = null, certificateBytes: Uint8Array | null = null;
          if (plan.complete) {
            const letterhead = await letterheadSoon;
            signTimer?.lap("io_letterhead");
            const certificate = await pdf.buildCertificate({ ...stamp, id: plan.id, createdAt: plan.created_at, sentAt: plan.sent_at, completedAt: plan.signed_at, signingMode: plan.signing_mode,
              originalHash: plan.original_hash, signedHash, consent: SIGNING_CONSENT, chainOk: plan.chain_ok,
              events: [...plan.events, { event: "signed", at: plan.signed_at, recipient_id: plan.recipient_id }, { event: "completed", at: plan.signed_at }] }, letterhead);
            certificatePath = `${plan.id}/certificate-${ports.uuid()}.pdf`; certificateHash = await sha256Hex(certificate); certificateBytes = certificate;
            signTimer?.lap("certificate");
            await store(certificatePath, certificate); mine.push(certificatePath);
            signTimer?.lap("io_store_certificate");
          }
          // An offer letter: the signed copy and the certificate are also kept on the application (Documents), in the same transaction.
          // Agent onboarding: the one signed document is split back into the application form and the agreement, kept on the agency.
          const onboarding = plan.onboarding && typeof plan.onboarding === "object" ? plan.onboarding as { id: string; kind?: string; formPages: number; combined?: boolean } : null;
          let documents: Record<string, string> = {};
          if ((plan.offer || onboarding) && plan.complete && certificateBytes) {
            documents = { signed_base64: toBase64(signed), certificate_base64: toBase64(certificateBytes) };
            // The first merged version and the combined application (2026-11-20) are split into the application form and the agreement.
            // Only the first merged version is split here; the combined application is split by its own follow-up call (CPU budget).
            if (onboarding && (onboarding.kind ?? "merged") === "merged") {
              const [form, agreement] = await (await onboardingPdfModule()).splitPdf(signed, Number(onboarding.formPages));
              documents = { ...documents, form_base64: toBase64(form), agreement_base64: toBase64(agreement) };
            }
          }
          signTimer?.lap("encode");
          try {
            const after = await ports.service("sign", { hash, data: { ...data, revision: plan.revision, signed_at: plan.signed_at, current_path: currentPath, current_hash: signedHash,
              certificate_path: certificatePath, certificate_hash: certificateHash, ...documents } });
            signTimer?.lap("io_commit");
            staged.length = 0; // Committed: these files are the record now and are never removed on a later error.
            // F04 wizard: the ACN, the MARN and the ticked declarations join the signed answers and the business profile (the draft is removed).
            if (submission && ports.serviceRpc) {
              await ports.serviceRpc("agency_onboarding_application_extra", { p_request: record.id, p_data: { agent_acn: submission.acn, agent_marn: submission.marn,
                declarations: submission.declarations, declared_at: plan.signed_at } }).catch(() => undefined);
              // The ACN the business typed is kept on the business when we had none (2026-11-20; a valid ACN only, never over the register's).
              if (submission.acn) await ports.serviceRpc("agency_acn_from_application", { p_request: record.id, p_acn: submission.acn }).catch(() => undefined);
            }
            // The witness the agency admin added on this page is kept on the onboarding (staff see it; a correction prints it again).
            if (witness && witnessPng && ports.serviceRpc) {
              await ports.serviceRpc("agency_onboarding_witness_record", { p_request: record.id, p_name: witness.name, p_png: witnessPng }).catch(() => undefined);
            }
            await ports.later(drainSigningMail(ports));
            // An onboarding document completed: the referee checks go out after the application form; staff hear when the second referee is back.
            // CPU budget (2026-11-20): an application form's follow-up (the split of the combined document, the referee checks, the staff
            // emails) runs in its own call, queued by the database (pg_net); only when that cannot be queued does it run here.
            if (onboarding && after.state === "signed") {
              const inline = () => afterCompletion({ ports, store, fileBytes, commit: () => { staged.length = 0; } }, onboarding).catch(() => undefined);
              if (onboarding.kind === "application" && ports.serviceRpc) {
                const queue = ports.serviceRpc;
                await ports.later(queue("agency_onboarding_followup_queue", { p_onboarding: onboarding.id, p_step: onboarding.combined ? "split" : "after_application" })
                  .then(() => undefined, () => onboarding.combined ? undefined : inline()));
              } else await ports.later(inline());
            }
            signTimer?.lap("io_after"); signTimer?.done({ fields: stampFields.length, bytes: signed.length });
            return { signed: true, complete: after.state === "signed", state: after.state };
          } catch (error) {
            const e = error as RpcError;
            // Someone else signed between the plan and the commit: this copy is out of date, render again from the new state.
            if (e.code === "SG409" && attempt < 3) { await ports.storage.remove(mine); staged.length = 0; continue; }
            throw e.code === "SG409" ? new SigningError("Several people are signing at once. Please select Sign again.") : new SigningError(e.message, e.code === "42501" ? 403 : 400);
          }
        }
      }
      const done = record.state === "signed";
      // F04 wizard: the saved draft and the register's facts for the Company summary (looked up once and kept when the send did not keep them).
      // Prefill that cannot come up empty (2026-11-19): the blank fields among F04_OPEN_PREFILL_KEYS are filled from the register (cached by
      // ABN) and the business record, server side, and returned filled; a value already there is never overwritten. The ACN has no box of
      // its own: it is returned as application.prefill.agent_acn.
      let application: { draft: unknown; facts: unknown; savedAt: string | null; prefill: Record<string, string>; filled: string[]; attachments: Record<string, unknown>;
        correction?: { round: number; message: string | null; flags: Record<string, string>; answers: Record<string, string> } | null } | null = null;
      let fields = (record.fields ?? []) as LinkField[];
      if (isApplication(record) && !done && ports.serviceRpc) {
        try {
          const wizard = await ports.serviceRpc("agency_onboarding_wizard_get", { p_request: record.id }) as { draft: unknown; saved_at: string | null; facts: unknown; abn: string | null;
            record?: Record<string, unknown> | null; abr?: { details: AbrDetails | null; confirmed: (AbrConfirmed & { givenName?: string; familyName?: string }) | null } | null; attachments?: Record<string, unknown> | null;
            correction?: F04Correction | null } | null;
          let facts = wizard?.facts ?? null;
          // A correction request (2026-11-18) is prefilled with the reviewed answers: nothing is filled on open.
          const correction = wizard?.correction ?? null;
          const blanks = correction ? [] : f04BlankKeys(fields);
          let details: AbrDetails | null = wizard?.abr?.details ?? null;
          if (!details && wizard?.abn && (blanks.length || !facts || !(facts as { acn?: string }).acn)) {
            const found = await lookupAbrCached(wizard.abn, ports.abr?.guid, abrCache(ports), ports.abr?.fetch ?? fetch);
            if (found) {
              details = found.details;
              if (!facts) {
                facts = abrFacts(found.details, found.fetchedAt);
                await ports.serviceRpc("agency_onboarding_facts_save", { p_request: record.id, p_facts: facts }).catch(() => undefined);
              }
            }
          }
          const computed = f04Prefill({ details, confirmed: wizard?.abr?.confirmed ?? null, record: wizard?.record ?? {}, facts: facts as Partial<AbrFacts> | null });
          const fill = Object.fromEntries(blanks.filter((k) => computed[k]).map((k) => [k, computed[k]]));
          if (Object.keys(fill).length) {
            await ports.serviceRpc("agency_onboarding_prefill_blanks", { p_request: record.id, p_values: fill }).catch(() => undefined);
            fields = withFilled(fields, fill);
          }
          // Round 3: the page fills its own blanks from these too: the values a request sent by an older version has no box for (legal name,
          // the contact's name, the declarant) show on the cards and prefill the declaration; the ACN has no box at all.
          const acn = computed.agent_acn ?? ((facts as { acn?: string } | null)?.acn ?? "");
          const prefill: Record<string, string> = Object.fromEntries(F04_OPEN_PREFILL_KEYS.filter((k) => computed[k]).map((k) => [k, computed[k]]));
          if (acn) prefill.agent_acn = acn;
          // Follow-up (2026-11-18): the request's stored values (field_values) get the ACN when they have none, and lose a postcode kept as
          // the Province; nothing else in them changes (agency_onboarding_record_fill, unsigned F04s only).
          if (!correction) await ports.serviceRpc("agency_onboarding_record_fill", { p_request: record.id, p_values: acn ? { agent_acn: acnDigits(acn) } : {} }).catch(() => undefined);
          if (correction) { prefill.agent_acn = correction.acn ? acnDigits(correction.acn) : ""; prefill.agent_marn = correction.marn ?? ""; }
          application = { draft: wizard?.draft ?? null, facts, savedAt: wizard?.saved_at ?? null, prefill, filled: Object.keys(fill), attachments: wizard?.attachments ?? {},
            correction: correction ? { round: correction.round, message: correction.message ?? null, flags: correction.flags ?? {}, answers: signedAnswers(correction.answers) } : null };
        } catch { application = { draft: null, facts: null, savedAt: null, prefill: {}, filled: [], attachments: {} }; }
      }
      const path = done ? record.signed_path : record.current_path ?? record.original_path;
      const expected = done ? record.signed_hash : record.current_hash ?? record.original_hash;
      return { id: record.id, reference: record.reference, title: record.title, state: record.state, message: record.message, expiresAt: record.expires_at, signedAt: record.signed_at,
        recipient: record.recipient, fields, signers: record.signers, consent: SIGNING_CONSENT, documentHash: record.original_hash,
        requireCode: record.require_code === true, offer: record.offer ?? null, onboarding: record.onboarding ?? null, application, codeTo: record.require_code === true ? maskEmail(record.recipient?.email ?? "") : null,
        // Only the signed document: the completion certificate (audit record: IP, browser, history) never goes to a link holder (owner 2026-11-20).
        url: await fileUrl(path, expected, `${safeName(record.title)}${done ? "-signed" : ""}.pdf`) };
    }

    // ------------------------------------------------------------------ an offer letter's payment-confirmed copy (service role only, queued by the database)
    // 2026-11-21: once the deposit is recorded, the signed letter with "Payment made: Yes" ticked and the paid date printed in its ADMIN USE
    // ONLY table, appended as an incremental update: the signed letter's bytes stay the copy's first bytes (the database refuses anything
    // else), so the signature, the signing date and every word are those of the signed letter. Made once; a repeated call stores nothing.
    if (action === "offer_payment_copy") {
      if (!ports.isServiceCaller || !ports.serviceRpc) throw new SigningError("Not available.", 403);
      const letterId = String(body.letterId ?? "");
      if (!UUID.test(letterId)) throw new SigningError("Choose an offer letter.");
      const source = await ports.serviceRpc("offer_letter_payment_copy_source", { p_letter: letterId }) as {
        ready: boolean; reason?: string; reference: string; title: string; signedSha256: string | null; signedBase64: string;
        fields: Array<{ type: string; page: number; x: number; y: number; w: number; h: number; label: string; value: string }> };
      if (!source?.ready) return { made: false, reason: source?.reason ?? "not_ready" };
      const signed = Uint8Array.from(atob(source.signedBase64), (c) => c.charCodeAt(0));
      if (source.signedSha256 && await sha256Hex(signed) !== source.signedSha256) throw new SigningError("The signed letter does not match its recorded hash.");
      const fields = source.fields.map((f) => ({ recipient_id: null, type: f.type, page: Number(f.page), x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h), value: f.value, done: true, label: f.label }));
      const copy = fields.length ? await (await signingPdfModule()).stampDocument(signed, { reference: source.reference, title: source.title, fields, recipients: [], incremental: true }) : signed;
      const stored = await ports.serviceRpc("offer_letter_payment_copy_store", { p_letter: letterId, p_content: toBase64(copy), p_sha256: await sha256Hex(copy) }) as { stored: boolean; already?: boolean };
      return { made: stored?.stored === true, already: stored?.already === true, bytes: copy.length, marks: fields.length };
    }

    // ------------------------------------------------------------------ an application form's follow-up (service role only, queued by the database)
    // 2026-11-20, CPU budget: the work after the agency admin's one signature, in calls of its own. "split": the combined signed document
    // becomes the application form and the agreement, then "after_application" is queued; "after_application": the referee checks, the
    // agency admin's and the staff emails (afterCompletion).
    if (action === "onboarding_followup") {
      if (!ports.isServiceCaller || !ports.serviceRpc) throw new SigningError("Not available.", 403);
      const onboardingId = String(body.onboardingId ?? "");
      if (!UUID.test(onboardingId)) throw new SigningError("Choose an onboarding.");
      const step = String(body.step ?? "");
      const serviceRpc = ports.serviceRpc;
      if (step === "split") {
        const timer = stepTimer("onboarding_split");
        const source = await serviceRpc("agency_onboarding_split_source", { p_onboarding: onboardingId }) as { pending: boolean; requestId: string; state: string; path: string | null; hash: string | null; formPages: number };
        if (!source?.pending || source.state !== "signed" || !source.path || !source.hash) return { step, split: false };
        const signed = await fileBytes(source.path, source.hash); timer.lap("io_download");
        const [form, agreement] = await (await onboardingPdfModule()).splitPdf(signed, Number(source.formPages)); timer.lap("split");
        const stored = await serviceRpc("agency_onboarding_split_store", { p_onboarding: onboardingId, p_request: source.requestId, p_form: toBase64(form), p_agreement: toBase64(agreement) }) as { stored: boolean };
        timer.lap("io_store");
        await serviceRpc("agency_onboarding_followup_queue", { p_onboarding: onboardingId, p_step: "after_application" });
        timer.done({ formBytes: form.length, agreementBytes: agreement.length });
        return { step, split: stored?.stored === true };
      }
      if (step === "after_application") {
        const timer = stepTimer("onboarding_after_application");
        takePdfWorkMs();
        await afterCompletion({ ports, store, fileBytes, commit: () => { staged.length = 0; } }, { id: onboardingId, kind: "application" });
        const pdfMs = takePdfWorkMs();
        timer.lap("io_referee_requests_and_emails");
        timer.done({ refereeFormsPdfMs: pdfMs }); // the referee forms built inside: their PDF time (CPU) is part of the io_ lap
        return { step, done: true };
      }
      throw new SigningError("Unknown follow-up step.");
    }

    // ------------------------------------------------------------------ the schedule (service role) or an administrator: reminders, expiry, queued mail
    if (action === "tick") {
      if (!ports.isServiceCaller) await ports.admin("subject_search", null, { type: "none" });
      const tick = await ports.service("tick");
      return { ...tick, mail: await drainSigningMail(ports) };
    }

    // ------------------------------------------------------------------ administrators. Authorization comes before any file is made or stored.
    const admin = async (operation: string, id: unknown = null, data: unknown = {}) => {
      if (id !== null && !UUID.test(String(id))) throw new SigningError("Not found.", 404);
      try { return await ports.admin(operation, id as string | null, data); }
      catch (error) { const e = error as RpcError; throw new SigningError(e.message, e.code === "42501" ? 403 : 400); }
    };
    /** A template's document for a set of values: a letter from its text, or its PDF. `sample` shows [name] for what is still missing. */
    // deno-lint-ignore no-explicit-any
    const templateDocument = async (template: Record<string, any>, values: Record<string, unknown>, sample: boolean, editedText: unknown = null, editedHtml: unknown = null) => {
      const fill = (source: string) => sample ? sampleFill(source, values) : fillSigningTemplate(source, values);
      const title = fill(String(template.title ?? ""));
      const senderFields = (Array.isArray(template.fields) ? template.fields : []).map((f: Record<string, unknown>) => f.role === "sender" ? { ...f, value: String(f.value ?? "").trim() ? fill(String(f.value)).trim() : "" } : f);
      const none: GeneratedField[] = [];
      if (template.kind === "pdf") return { title, rendered: null as string | null, templateText: null as string | null, edited: false, isHtml: false, bytes: await fileBytes(template.source_path, template.source_hash), fields: senderFields, generated: none };
      const letterPdf = await letterPdfModule();
      if (isSectioned(template)) {
        // TPL-02: header, body and footer; {{placeholders}} filled first (escaped), then the [Variable] tokens by the registry while the PDF
        // is laid out. The administrator may edit the body of THIS copy; the header, the footer and the template are untouched.
        const strings = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "string")) as Record<string, string>;
        const fillHtml = (html: unknown) => typeof html === "string" && html.trim() ? fillHtmlVariables(html, strings, { sample }) : "";
        const ownBody = fillHtml(typeof template.body_html === "string" && template.body_html.trim() ? template.body_html : signingHtml(String(template.body ?? "")));
        let bodyHtml = ownBody;
        if (typeof editedHtml === "string" && editedHtml.trim()) {
          if (editedHtml.length > 400000) throw new SigningError("Keep the edited document under 400,000 characters.");
          const left = signingVariables(editedHtml);
          if (left.length) throw new SigningError(`The edited text still has ${left.map((k) => `{{${k}}}`).join(", ")} in it. Fill it in or remove it.`);
          bodyHtml = editedHtml;
        }
        const doc = await documentPdfModule();
        const headerHtml = fillHtml(template.header_html), footerHtml = fillHtml(template.footer_html);
        // Pictures uploaded from the editor live in template-assets and are linked by URL: their bytes are read here so the PDF can embed them.
        const images = await templateAssetImages(ports, doc.linkedImages(headerHtml, bodyHtml, footerHtml));
        const made = await doc.buildDocumentPdf({ title, header: headerHtml, body: bodyHtml, footer: footerHtml, values: strings, brackets: template.bracket_variables === true, sample, images });
        if (!sample && made.missing.length) {
          const names = made.missing.map((n) => `[${n}]`).join(", ");
          throw new SigningError(`The document cannot be made yet: ${names} ${made.missing.length === 1 ? "has" : "have"} no value. Add ${made.missing.length === 1 ? "it" : "them"} on the record, type ${made.missing.length === 1 ? "it" : "them"} here, or change the template.`);
        }
        if (!sample && made.unsupported) throw new SigningError(`Some characters cannot be printed in the PDF: "${made.unsupported.slice(0, 40)}". Replace them, or upload a ready-made PDF.`);
        return { title, rendered: bodyHtml, templateText: ownBody, edited: bodyHtml !== ownBody, isHtml: true, bytes: made.bytes, fields: senderFields, generated: made.fields as GeneratedField[] };
      }
      const bodyHtml = typeof template.body_html === "string" && template.body_html.trim() ? String(template.body_html) : null;
      if (bodyHtml) {
        // A rich template (the HRMS letters, one table since 20261113170000): the signing variables ({{employee.name}}, {{salary}}) are filled
        // first, escaped; the HRMS placeholders ({{first_name}}, {{job_title}}…) by their own renderer (formatting, optional lines, nothing
        // left unfilled). The administrator may edit the HTML of THIS copy; the template is untouched.
        const strings = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "string")) as Record<string, string>;
        const prefilled = fillHtmlVariables(bodyHtml, strings, { sample, leave: (key) => HRMS_PLACEHOLDER.has(key) });
        const made = renderTemplate(sanitizeTemplateHtml(prefilled), strings);
        if (!sample && (made.missing.length || made.unknown.length)) {
          const gaps = [...made.missing, ...made.unknown];
          throw new SigningError(`The document cannot be made yet: ${placeholderLabels(gaps)} ${gaps.length === 1 ? "has" : "have"} no value. Add ${gaps.length === 1 ? "it" : "them"} on the record, type ${gaps.length === 1 ? "it" : "them"} here, or change the template.`);
        }
        let html = made.html;
        if (typeof editedHtml === "string" && editedHtml.trim()) {
          if (editedHtml.length > 200000) throw new SigningError("Keep the edited document under 200,000 characters.");
          html = sanitizeTemplateHtml(editedHtml);
          const left = templatePlaceholders(html);
          if (left.length) throw new SigningError(`The edited text still has ${left.map((k) => `{{${k}}}`).join(", ")} in it. Fill it in or remove it.`);
          if (!templateText(html).trim()) throw new SigningError("The edited document is empty.");
        }
        const bad = await letterPdf.unsupportedText([title, templateText(html)]);
        if (bad !== null) throw new SigningError(`Some characters ${bad === title ? "in the title" : "in the text"} cannot be printed in the PDF: "${bad.slice(0, 80)}". Replace them, or upload a ready-made PDF.`);
        return { title, rendered: html, templateText: made.html, edited: html !== made.html, isHtml: true, bytes: (await letterPdf.buildLetterPdf({ title, html, letterhead: await ports.letterhead(), kind: "Document" })).bytes, fields: senderFields, generated: none };
      }
      // The administrator may edit the filled text of THIS copy (text templates; the template is untouched): no {{variable}} may remain.
      let text: string | null = null;
      if (typeof editedText === "string" && editedText.trim()) {
        if (editedText.length > 40000) throw new SigningError("Keep the document text under 40,000 characters.");
        const left = signingVariables(editedText);
        if (left.length) throw new SigningError(`The edited text still has ${left.map((k) => `{{${k}}}`).join(", ")} in it. Fill it in or remove it.`);
        text = editedText.replace(/\r\n/g, "\n");
      }
      const plain = fill(String(template.body ?? "")), rendered = text ?? plain;
      const bad = await letterPdf.unsupportedText([title, rendered]);
      if (bad !== null) throw new SigningError(`Some characters ${bad === title ? "in the title" : "in the text"} cannot be printed in the PDF: "${bad.slice(0, 80)}". Replace them, or upload a ready-made PDF.`);
      return { title, rendered, templateText: plain, edited: rendered !== plain, isHtml: false, bytes: (await letterPdf.buildLetterPdf({ title, html: signingHtml(rendered), letterhead: await ports.letterhead(), kind: "Document" })).bytes, fields: senderFields, generated: none };
    };
    /** The record's values: the signing names (student.*, employee.*, agent.*) and, for an employee, the letter names of HRMS Templates ({{job_title}}…). */
    const subjectValues = async (type: unknown, id: unknown) => {
      if (!type) return null;
      const subject = (await admin("subject_values", id, { type })) as { name: string; email: string; values: Record<string, string> };
      if (type === "employee" && ports.callerRpc) {
        try {
          const letter = templateValues(((await ports.callerRpc("hr_admin_template_values", { p_id: id })) ?? {}) as TemplatePerson);
          subject.values = { ...Object.fromEntries(Object.entries(letter).filter(([, v]) => String(v ?? "").trim())), ...subject.values };
        } catch { /* the signing names still fill */ }
      }
      return subject;
    };
    const inspect = async (bytes: Uint8Array) => {
      const inspected = await (await offerPdfModule()).inspectOfferPdf(bytes);
      if (!inspected.ok) throw new SigningError(inspected.error.replaceAll("offer letter", "document"));
      return inspected.pages;
    };

    /** A request from a saved template (or an uploaded PDF) for a record: the "create" action, also used by the agent's own agreement. */
    // deno-lint-ignore no-explicit-any
    const createRequest = async (body: Record<string, any>, upload: SigningCall["upload"]) => {
      const context = await admin("list");
      const recipients = checkRecipients(body.recipients);
      const subject = await subjectValues(body.subjectType, body.subjectId);
      let title = String(body.title ?? "").trim(), rendered: string | null = null, templateId: string | null = null, category = String(body.category ?? "other");
      let values: Record<string, unknown> = {}; let bytes: Uint8Array; let fields: Array<Record<string, unknown>> = [];
      let edited = false, templateText: string | null = null;
      const options: Record<string, unknown> = { signing_mode: body.signingMode === "parallel" ? "parallel" : "sequential" };
      if (upload) {
        bytes = upload.bytes;
        await inspect(bytes);
      } else {
        const template = context.templates.find((t: { id: string; status: string }) => t.id === body.templateId && t.status === "active");
        if (!template) throw new SigningError("Choose a saved template or upload a PDF.");
        // 2026-11-18: the Agent Application Form goes by itself when a business is added (and back to its agency admin for corrections).
        if ((template as { system_key?: string | null }).system_key === F04_SYSTEM_KEY) throw new SigningError(F04_NOT_HERE);
        // 2026-11-21: the agreement (P06) and the referee check (F05) too: the onboarding sends them itself (its own create path).
        if (ONBOARDING_SYSTEM_KEYS.has(String((template as { system_key?: string | null }).system_key ?? ""))) throw new SigningError(ONBOARDING_NOT_HERE);
        // The record's own values first, then what the administrator typed (a correction wins), and the two first-stage names.
        values = { current_date: signingToday(), ...(subject?.values ?? {}), ...(typeof body.values === "object" && body.values ? body.values : {}), full_name: recipients[0].name, email: recipients[0].email };
        const made = await templateDocument(template, values, false, body.text, body.html);
        title = made.title; rendered = made.rendered; bytes = made.bytes; templateId = template.id; category = template.category;
        edited = made.edited; templateText = made.templateText;
        // What the sender prints on a PDF template (its variables) becomes part of the document itself, before anyone sees or signs it.
        const printed = made.fields.filter((f: Record<string, unknown>) => f.role === "sender" && f.value).map((f: Record<string, unknown>) => ({ ...f, recipient_id: null, done: true })) as unknown as import("../_shared/signing-pdf.ts").StampField[];
        if (printed.length) bytes = await (await signingPdfModule()).stampDocument(bytes, { reference: "", title, fields: printed, recipients: [] });
        fields = made.fields.filter((f: Record<string, unknown>) => recipients.some((r) => r.role === f.role));
        // TPL-02: [Student Initial] on every page and every [token] the signer answers belong to the first signer (the student, the employee).
        if (made.generated.length) {
          const first = [...recipients].sort((a, b) => a.order - b.order)[0];
          fields = [...fields, ...made.generated.map((f) => ({ type: f.type, role: first.role, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: true, label: f.label }))];
        }
        options.signing_mode = body.signingMode ? options.signing_mode : template.signing_mode;
        options.expiry_days = body.expiryDays ?? template.expiry_days; options.reminder_days = body.reminderDays ?? template.reminder_days;
      }
      if (!title || title.length > 200 || /[\r\n]/.test(title)) throw new SigningError("Enter a document title up to 200 characters on one line.");
      const id = ports.uuid();
      await store(`${id}/original.pdf`, bytes);
      const record = await admin("create", id, { title, template_id: templateId, rendered_text: rendered, field_values: values, original_hash: await sha256Hex(bytes), recipients, fields,
        subject_type: body.subjectType ?? null, subject_id: body.subjectId ?? null, category, message: body.message ?? null, edited, template_text: edited ? templateText : null,
        expiry_days: body.expiryDays ?? undefined, reminder_days: body.reminderDays ?? undefined, ...options });
      staged.length = 0;
      return record;
    };

    if (Object.hasOwn(ONBOARDING_ACTIONS, action)) {
      // Agent onboarding (2026-11-17): install a blank, send the application form / the referee checks / the agreement, change or upload a referee's form.
      if (!ports.callerRpc) throw new SigningError("Not available.");
      const callerRpc = ports.callerRpc;
      const ctx: OnboardingContext = { ports, body, upload: call.upload, admin, store, fileBytes, commit: () => { staged.length = 0; }, createRequest: (input) => createRequest(input, null),
        rpc: async (name, args) => { try { return await callerRpc(name, args); } catch (error) { const e = error as RpcError; throw new SigningError(e.message, e.code === "42501" ? 403 : 400); } } };
      return await ONBOARDING_ACTIONS[action](ctx);
    }
    if (action === "template_upload") {
      await admin("subject_search", null, { type: "none" });
      if (!call.upload) throw new SigningError("Choose a PDF to upload.");
      const pages = await inspect(call.upload.bytes);
      const id = UUID.test(String(body.id ?? "")) ? String(body.id) : ports.uuid();
      const path = `templates/${id}/source-${ports.uuid()}.pdf`;
      await store(path, call.upload.bytes);
      const saved = await admin("template_save", id, { ...(body.template as Record<string, unknown> ?? {}), kind: "pdf", source_path: path, source_hash: await sha256Hex(call.upload.bytes), source_pages: pages });
      staged.length = 0;
      return saved;
    }
    if (action === "template_duplicate") {
      const context = await admin("list");
      const template = context.templates.find((t: { id: string }) => t.id === body.id);
      if (!template) throw new SigningError("Template not found.", 404);
      const newId = ports.uuid(); let path: string | null = null;
      if (template.kind === "pdf") { path = `templates/${newId}/source-${ports.uuid()}.pdf`; await store(path, await fileBytes(template.source_path, template.source_hash)); }
      const saved = await admin("template_duplicate", template.id, { new_id: newId, source_path: path });
      staged.length = 0;
      return saved;
    }
    if (action === "template_preview") {
      // A saved template, or the one being edited (text only): the populated document, never stored.
      let template = body.template as Record<string, unknown> | undefined;
      if (body.id) { const context = await admin("list"); template = context.templates.find((t: { id: string }) => t.id === body.id); }
      else await admin("subject_search", null, { type: "none" });
      if (!template) throw new SigningError("Template not found.", 404);
      if (!body.id && template.kind === "pdf") throw new SigningError("Save the PDF template before previewing it.");
      const subject = await subjectValues(body.subjectType, body.subjectId);
      const values = { current_date: signingToday(), ...(subject?.values ?? {}), ...(body.values && typeof body.values === "object" ? body.values : {}) };
      const made = await templateDocument(template, values, true);
      const sender = made.fields.filter((f: Record<string, unknown>) => f.role === "sender").map((f: Record<string, unknown>) => ({ ...f, recipient_id: null, done: true })) as unknown as import("../_shared/signing-pdf.ts").StampField[];
      const bytes = sender.length ? await (await signingPdfModule()).stampDocument(made.bytes, { reference: "PREVIEW", title: made.title, fields: sender, recipients: [] }) : made.bytes;
      return { title: made.title, pdfBase64: toBase64(bytes), variables: templateVariables(template as never), values, signerFields: made.generated };
    }
    if (action === "template_url") {
      const context = await admin("list");
      const template = context.templates.find((t: { id: string }) => t.id === body.id);
      if (!template || template.kind !== "pdf") throw new SigningError("Template not found.", 404);
      return { url: await fileUrl(template.source_path, template.source_hash) };
    }
    if (action === "preview") {
      // The released compose flow (20261113100000): the PDF exactly as it will be sent, the filled text and the template's own render.
      const context = await admin("list");
      const recipients = checkRecipients(body.recipients);
      const template = context.templates.find((t: { id: string; status: string }) => t.id === body.templateId && t.status === "active");
      if (!template) throw new SigningError("Choose a saved template or upload a PDF.");
      const subject = await subjectValues(body.subjectType, body.subjectId);
      const values = { current_date: signingToday(), ...(subject?.values ?? {}), ...(typeof body.values === "object" && body.values ? body.values : {}), full_name: recipients[0].name, email: recipients[0].email };
      const made = await templateDocument(template, values, false, body.text, body.html);
      return { pdfBase64: toBase64(made.bytes), title: made.title, text: made.rendered, templateText: made.templateText, edited: made.edited, isHtml: made.isHtml,
        recipientName: recipients[0].name, recipientEmail: recipients[0].email, variables: templateVariables(template), templateName: template.name };
    }
    if (action === "create") return await createRequest(body, call.upload);
    if (action === "admin_url") {
      const record = await admin("detail", body.id);
      const which = String(body.which ?? "document");
      // The audit record (completion certificate): staff only, opened from the signing request page (View audit record); never emailed.
      if (which === "certificate") {
        if (!record.certificate_path) throw new SigningError("The audit record is made when everyone has signed.");
        return { url: await fileUrl(record.certificate_path, record.certificate_hash, `${safeName(record.title)}-certificate.pdf`) };
      }
      if (which === "original") return { url: await fileUrl(record.original_path, record.original_hash, `${safeName(record.title)}.pdf`) };
      const path = record.signed_path ?? record.current_path ?? record.original_path;
      return { url: await fileUrl(path, record.signed_hash ?? record.current_hash ?? record.original_hash, `${safeName(record.title)}${record.signed_path ? "-signed" : ""}.pdf`) };
    }
    if (action === "verify") {
      // Tamper check: the history chain in the database, and every stored file against the hash recorded when it was made.
      const record = await admin("detail", body.id);
      const files = [["Original document", record.original_path, record.original_hash], ["Signed document", record.signed_path ?? record.current_path, record.signed_hash ?? record.current_hash],
        ["Completion certificate", record.certificate_path, record.certificate_hash]].filter((f) => f[1]);
      const checked = [];
      for (const [name, path, expected] of files) {
        const bytes = await ports.storage.download(path);
        checked.push({ name, ok: !!bytes && await sha256Hex(bytes) === expected, sha256: expected });
      }
      return { chainOk: record.chain_ok === true, files: checked, ok: record.chain_ok === true && checked.every((f) => f.ok) };
    }
    if (action === "send" || action === "resend") {
      await admin("detail", body.id);
      if (!ports.mail.provider || !ports.mail.config.siteUrl || !ports.mail.config.from) throw new SigningError("Signing email is not configured, so nothing was sent. The request was kept as it is.");
      const record = await admin(action, body.id, action === "resend" ? { recipient_id: body.recipientId } : {});
      const mail = await drainSigningMail(ports);
      return { ...record, mail };
    }
    if (action === "void") {
      const record = await admin("void", body.id, { reason: body.reason ?? "" });
      await ports.later(drainSigningMail(ports));
      return record;
    }
    throw new SigningError("Unknown signing action");
  } catch (error) {
    for (const path of staged) {
      // A lost RPC response can mean the transaction committed. Never delete a referenced PDF.
      try { if (await ports.service("path_referenced", { data: { path } }) === false) await ports.storage.remove([path]); } catch { /* left for a later clean-up */ }
    }
    if (error instanceof SigningError) throw error;
    throw new SigningError((error as RpcError)?.message || "The signing request could not be completed.", (error as RpcError)?.code === "42501" ? 403 : 400);
  }
}

/**
 * Sends queued signing mail. Each job is claimed with a lease and has a unique key in the database, so two runs never send the same email;
 * a job for a request that has closed is cancelled by the claim itself. Sending off: nothing is claimed and the jobs wait.
 */
export async function drainSigningMail(ports: SigningPorts, limit = 20): Promise<{ sent: number; failed: number; requeued: number }> {
  const totals = { sent: 0, failed: 0, requeued: 0 };
  const { provider, config } = ports.mail;
  if (!provider || !config.from || !config.siteUrl) return totals;
  // deno-lint-ignore no-explicit-any
  let jobs: Array<SigningMailJob & Record<string, any>>;
  try { jobs = await ports.service("notify_claim", { data: { limit } }); } catch { return totals; }
  for (const job of jobs ?? []) {
    const result = async (state: string, messageId?: string, error?: string) => {
      try { await ports.service("notify_result", { data: { id: job.id, state, message_id: messageId ?? null, error: error ?? null } }); } catch { /* the lease expires and the job is retried */ }
      if (state === "sent") totals.sent++; else if (state === "queued") totals.requeued++; else totals.failed++;
    };
    try {
      const to = job.audience === "admin" ? (job.sender_email || config.adminTo.join(", ")) : job.to;
      // OFFER-DEPOSIT: notify_claim adds `deposit` (amount and a fresh token) to the signer's completion email when the deposit is pending.
      const raw = (job as Record<string, unknown>).deposit as { label?: unknown; token?: unknown } | null | undefined;
      const deposit = raw && typeof raw.label === "string" && /^[a-f0-9]{64}$/.test(String(raw.token ?? ""))
        ? { label: raw.label, link: `${config.siteUrl}/sign#t=${raw.token}` } : null;
      const message = renderSigningEmail({ ...job, deposit }, job.token ? `${config.siteUrl}/sign#t=${job.token}` : null);
      if (!to || !message) { await result("failed", undefined, !to ? "no recipient address" : "no template"); continue; }
      let attachments: Array<{ name: string; contentType: string; contentBase64: string }> | undefined;
      if (job.kind === "completed") {
        // This email exists to deliver the signed PDF: a missing or changed file is not sent (failed, visible to the administrator). The signed
        // document only: the completion certificate (audit record) is never emailed to anyone, staff included (owner 2026-11-20).
        const files: Array<[string, string, string]> = [[job.signed_path, job.signed_hash, `${safeName(job.title)}-signed.pdf`]];
        attachments = [];
        for (const [path, expected, name] of files) {
          const bytes = path ? await ports.storage.download(path) : null;
          if (!bytes || await sha256Hex(bytes) !== expected) { attachments = undefined; break; }
          attachments.push({ name, contentType: "application/pdf", contentBase64: toBase64(bytes) });
        }
        if (!attachments || attachments.reduce((n, a) => n + a.contentBase64.length, 0) > 9_000_000) { await result("failed", undefined, "the signed PDF could not be attached"); continue; }
      }
      const outcome = outcomeState(await provider.send({ deliveryId: `sign-${job.id}`, from: config.from, to, subject: message.subject, textBody: message.text, ...(attachments ? { attachments } : {}) }));
      await result(outcome.state, outcome.messageId, outcome.error);
    } catch (error) {
      await result("queued", undefined, String((error as Error)?.message ?? error).slice(0, 200));
    }
  }
  return totals;
}

/** Bounded read of the request body, even when Content-Length is omitted. JSON, or multipart with "data" (JSON) and "file". */
export async function readSigningRequest(req: Request): Promise<{ body: Record<string, unknown>; upload: SigningCall["upload"] }> {
  const reader = req.body?.getReader();
  if (!reader) throw new SigningError("Request body required");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > MAX_OFFER_BYTES + 512 * 1024) { await reader.cancel(); throw new SigningError("Document is too large", 413); }
    chunks.push(part.value);
  }
  const raw = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  const parsed = new Response(raw, { headers: { "Content-Type": req.headers.get("content-type") ?? "application/json" } });
  try {
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await parsed.formData();
      const file = form.get("file");
      return { body: JSON.parse(String(form.get("data") ?? "{}")), upload: file instanceof File ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null };
    }
    const body = await parsed.json();
    if (!body || typeof body !== "object") throw new Error("not an object");
    return { body, upload: null };
  } catch { throw new SigningError("The request could not be read."); }
}
