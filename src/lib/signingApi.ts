import { supabase } from "@/pages/admin/lib/supabase";
import { docxXmlToText } from "../../supabase/functions/_shared/signing";

export type SignFieldType = "signature" | "initials" | "date" | "name" | "text" | "checkbox";
export interface SigningRole { key: string; label: string; order: number; required: boolean }
/** A field placed on a template: `role` is a signer role, or "sender" for text the sender prints (a variable on a PDF template). */
export interface TemplateField { type: SignFieldType; role: string; page: number; x: number; y: number; w: number; h: number; required?: boolean; label?: string; value?: string }
/** One template table (20261113170000): documents to sign (text or PDF) and the HRMS letters and emails (rich `body_html`, `subject`, one default per category). */
export interface SigningTemplate {
  id: string; name: string; title: string; body: string | null; body_html?: string | null; subject?: string | null;
  /** TPL-02: header and footer repeated on every page; [Variable] tokens active (templates saved in the sectioned editor). */
  header_html?: string | null; footer_html?: string | null; bracket_variables?: boolean;
  kind: "text" | "pdf" | "email"; audience: "any" | "student" | "employee" | "agent"; category: string; status: "active" | "archived";
  version: number; roles: SigningRole[]; fields: TemplateField[]; signing_mode: "sequential" | "parallel"; expiry_days: number; reminder_days: number; source_pages: number | null; updated_at: string; created_at?: string;
  /** Stripe: requests made from the template ask the signer for this payment (hr.sign_templates payment_* columns). */
  payment_enabled?: boolean; payment_amount_cents?: number | null; payment_currency?: string | null; payment_description?: string | null; payment_timing?: PaymentTiming | null;
}
export type PaymentTiming = "before_sign" | "after_sign";
/** The Stripe payment on a request as signing_admin `list` and `detail` return it (null when the request has none). */
export interface SigningPayment {
  id: string; amount_cents: number; currency: string; description: string; timing: PaymentTiming; status: string; paid_at: string | null; amount_paid_cents: number | null;
  amount_refunded_cents?: number | null; failure_reason: string | null; livemode: boolean | null; checkout_open: boolean; payer_email?: string | null; updated_at?: string;
}
/**
 * OFFER-PAY-GATE: the offer letter's own state as the payments function reports it (public.offer_signing_state). `offer` false for a
 * document that is not an offer letter. `paymentRequired`: a deposit is printed on the letter, a live Stripe payment exists and Stripe has
 * not verified it yet; the server accepts the offer only once it has (acceptedAt, acceptedVia 'signing_and_payment').
 */
export interface OfferSigningState {
  offer: boolean; institution?: { name: string | null; logo: string | null } | null;
  letterId?: string; signedAt?: string | null; acceptedAt?: string | null; acceptedVia?: string | null; depositPaidAt?: string | null;
  paymentAmountCents?: number | null; paymentCurrency?: string; paymentRequired?: boolean; hasPayment?: boolean; mismatch?: boolean; applicationStatus?: string;
  /** "CoE", or "VoE" when the chosen intake's study load is voe (the wording after the deposit is paid). */
  coeLabel?: string;
}
/** What the `payments` function tells a link holder (status / checkout / confirm) and an administrator (refresh). */
export interface PaymentView {
  required: boolean; stripeReady?: boolean; mustPayBeforeSigning?: boolean; canPay?: boolean; alreadyPaid?: boolean; offer?: OfferSigningState | null;
  payment: { id: string; description: string; amountCents: number; currency: string; timing: PaymentTiming; status: string; paidAt: string | null; amountPaidCents: number | null; failureReason: string | null; testMode: boolean; receiptUrl?: string | null } | null;
}
/** The amount, currency, description and timing an administrator sets on a template or a request (amount in dollars). */
export interface PaymentInput { amount: number; currency: string; description: string; timing: PaymentTiming }
export const PAYMENT_TIMING: Record<PaymentTiming, string> = { before_sign: "Before signing", after_sign: "After signing" };
export const PAYMENT_STATUS: Record<string, { label: string; tone: "primary" | "secondary" | "success" | "muted" | "warn" }> = {
  pending: { label: "Pending", tone: "warn" }, open: { label: "Checkout open", tone: "secondary" }, processing: { label: "Processing", tone: "secondary" },
  paid: { label: "Paid", tone: "success" }, failed: { label: "Failed", tone: "primary" }, refunded: { label: "Refunded", tone: "muted" }, canceled: { label: "Cancelled", tone: "muted" },
};
export const paymentStatus = (status: string) => PAYMENT_STATUS[status] ?? { label: status.replaceAll("_", " "), tone: "muted" as const };
/** 12345 cents in "aud" as "$123.45" (the browser's locale rules for that currency). */
export function formatMoney(cents: number, currency: string): string {
  const code = (currency || "AUD").toUpperCase();
  try { return new Intl.NumberFormat("en-AU", { style: "currency", currency: code }).format(cents / 100); }
  catch { return `${code} ${(cents / 100).toFixed(2)}`; }
}
/** The payment as typed into the shared form (amount in dollars as text). */
export interface PaymentDraft { amount: string; currency: string; description: string; timing: PaymentTiming }
export const paymentDraft = (input: PaymentInput | null | undefined, description = ""): PaymentDraft => input
  ? { amount: input.amount.toFixed(2), currency: input.currency.toUpperCase(), description: input.description, timing: input.timing }
  : { amount: "", currency: "AUD", description, timing: "before_sign" };
/** A request's payment as the admin edits it (null when the request has none). */
export const paymentOfRecord = (payment: SigningPayment | null | undefined): PaymentInput | null => payment
  ? { amount: payment.amount_cents / 100, currency: payment.currency.toUpperCase(), description: payment.description, timing: payment.timing } : null;
/** The same checks hr.sign_payment_input makes, before the round trip. */
export function validatePayment(draft: PaymentDraft): PaymentInput {
  const amount = Number(draft.amount);
  if (!draft.amount.trim() || !Number.isFinite(amount) || amount < 0.5 || amount > 999999.99) throw new Error("Enter a payment amount between 0.50 and 999,999.99.");
  const currency = draft.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Use a 3-letter currency code for the payment, such as AUD.");
  const description = draft.description.trim();
  if (description.length > 250) throw new Error("Keep the payment description to 250 characters.");
  return { amount: Math.round(amount * 100) / 100, currency, description, timing: draft.timing };
}
export const samePayment = (a: PaymentInput | null, b: PaymentInput | null) => (!a && !b) || (!!a && !!b
  && Math.round(a.amount * 100) === Math.round(b.amount * 100) && a.currency.toUpperCase() === b.currency.toUpperCase() && a.description.trim() === b.description.trim() && a.timing === b.timing);
export const describePayment = (p: PaymentInput) => `${formatMoney(Math.round(p.amount * 100), p.currency)} · ${PAYMENT_TIMING[p.timing].toLowerCase()}${p.description.trim() ? ` · ${p.description.trim()}` : ""}`;
/** Requests still open for a payment change (payment_set refuses the others); a paid, refunded or closed one is read-only. */
export const paymentEditable = (requestStatus: string, payment: SigningPayment | null | undefined) =>
  ["draft", "sent", "viewed", "partial"].includes(requestStatus) && !["paid", "refunded", "processing"].includes(payment?.status ?? "");
/** The payment a template asks for, as the compose dialog edits it (null when the template has none). */
export function templatePayment(template: Pick<SigningTemplate, "payment_enabled" | "payment_amount_cents" | "payment_currency" | "payment_description" | "payment_timing"> | null | undefined): PaymentInput | null {
  if (!template?.payment_enabled || template.payment_amount_cents == null) return null;
  return { amount: template.payment_amount_cents / 100, currency: (template.payment_currency ?? "aud").toUpperCase(), description: template.payment_description ?? "", timing: template.payment_timing ?? "before_sign" };
}
export interface SigningRecipient {
  id: string; role_key: string; role_label: string; name: string; email: string; signing_order: number; required: boolean; state: "pending" | "sent" | "viewed" | "signed" | "declined" | "skipped";
  sent_at: string | null; viewed_at: string | null; signed_at: string | null; declined_at: string | null; decline_reason: string | null; signer_name: string | null; signature_kind: string | null;
  ip: string | null; user_agent: string | null; delivery_error: string | null; reminder_count: number;
}
export interface SigningRequest {
  id: string; reference: string; title: string; state: string; status: string; category: string; signing_mode: "sequential" | "parallel"; subject_type: "student" | "employee" | "agent" | null; subject_id: string | null;
  created_at: string; sent_at: string | null; expires_at: string | null; signed_at: string | null; completed_at: string | null; closed_reason: string | null; message: string | null;
  expiry_days: number; reminder_days: number; original_hash: string; signed_hash: string | null; certificate_hash: string | null; recipients: SigningRecipient[];
  payment?: SigningPayment | null;
}
export interface RequestField { id?: string; recipient_id: string; type: SignFieldType; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string; value?: string | null }
export interface SigningEvent { id: number; event: string; at: string; recipient_id: string | null; recipient_name: string | null; detail: Record<string, unknown>; hash: string }
export interface SigningDetail extends SigningRequest {
  fields: RequestField[]; events: SigningEvent[]; chain_ok: boolean;
  notifications: Array<{ id: number; kind: string; audience: string; state: string; recipient_id: string | null; created_at: string; sent_at: string | null; error: string | null }>;
}
/* The released first-stage shapes (20261110154917 + 20261113100000), used by the fallback pages while the hosted backend is that version. */
export interface LegacySigningTemplate { id: string; name: string; title: string; body: string }
export interface LegacySigningRequest { id: string; title: string; recipient_name: string; recipient_email: string; state: string; created_at: string; expires_at: string | null; signed_at: string | null; delivery_error: string | null; profile_id?: string | null; edited?: boolean }
export interface LegacySigningContext { templates: LegacySigningTemplate[]; requests: LegacySigningRequest[] }
export interface LegacySigningView { id: string; title: string; recipientName: string; state: string; signedAt: string | null; consent: string; documentHash: string; url: string }
/** document-signing `preview`: the PDF as it will be sent (base64), the filled text, the template's own render and the variables the template uses. */
export interface SigningPreview { pdfBase64: string; title: string; text: string; templateText: string; edited: boolean; isHtml?: boolean; recipientName: string; recipientEmail: string; variables: string[]; templateName: string }
export interface SigningContext { templates: SigningTemplate[]; requests: SigningRequest[] }
export interface SigningSubject { name: string; email: string; values: Record<string, string> }
/** What a link holder gets: their own fields only, and who else is signing. */
export interface SigningView {
  id: string; reference: string; title: string; state: string; message: string | null; expiresAt: string | null; signedAt: string | null; consent: string; documentHash: string; url: string; certificateUrl: string | null;
  /** Offer letters: the emailed 6-digit code confirms the signer before signing (codeTo: the masked address it goes to). */
  requireCode?: boolean; codeTo?: string | null; offer?: { studentName: string; applicationReference: string; prepaidMore: "YES" | "NO" | null } | null;
  recipient: { id: string; name: string; email: string; role: string; state: string; signed_at: string | null };
  /** Agent onboarding (2026-11-17): the application form (the first `formPages` pages) and the agreement, sent as one document. */
  onboarding?: { id: string; formPages: number; agencyName: string; agencyId: string } | null;
  // "choice": YES / NO (offer letters: the pre-paid fee), made by the offer flow only, never placed in the editor.
  // `key`: the variable behind the field (agent onboarding); a tick box "<question>:<answer>" answers a question with its siblings.
  fields: Array<{ id: string; type: SignFieldType | "choice"; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string; value: string | null; key?: string | null }>;
  signers: Array<{ name: string; role: string; state: string; order: number; required: boolean; me: boolean }>;
}
export interface MySigningDocument { recipient_id: string; reference: string; title: string; status: string; my_state: string; role: string; sent_at: string | null; signed_at: string | null; expires_at: string | null; completed_at: string | null }

/** The eight statuses of the dashboard, from the stored state (`signed` is a completed request, `partial` one that some have signed). */
export const SIGNING_STATUS: Record<string, { label: string; tone: "primary" | "secondary" | "success" | "muted" | "warn" }> = {
  draft: { label: "Draft", tone: "muted" }, sent: { label: "Pending", tone: "warn" }, viewed: { label: "Viewed", tone: "secondary" }, partial: { label: "Partially signed", tone: "secondary" },
  signed: { label: "Completed", tone: "success" }, declined: { label: "Declined", tone: "primary" }, expired: { label: "Expired", tone: "muted" }, void: { label: "Voided", tone: "muted" },
};
/**
 * Fields the server fills when the signer signs (the offer's answer and the payment): the signer sees them greyed and sends no value.
 * Matched on the field label, case-insensitive and trimmed.
 */
export const AUTO_FIELDS: ReadonlyArray<{ label: string; type: "checkbox" | "text" }> = [
  { label: "Offer accepted", type: "checkbox" }, { label: "Payment made", type: "checkbox" }, { label: "Payment not made", type: "checkbox" },
  { label: "Payment date", type: "text" }, { label: "Amount paid", type: "text" },
];
export const isAutoField = (label: string | null | undefined) => { const key = String(label ?? "").trim().toLowerCase(); return AUTO_FIELDS.some((f) => f.label.toLowerCase() === key); };
export const RECIPIENT_STATE: Record<string, string> = { pending: "Waiting for their turn", sent: "Invited", viewed: "Opened", signed: "Signed", declined: "Declined", skipped: "Not needed" };
export const signingStatus = (status: string) => SIGNING_STATUS[status] ?? { label: status.replaceAll("_", " "), tone: "muted" as const };
export const signedCount = (request: SigningRequest) => `${request.recipients.filter((r) => r.state === "signed").length} of ${request.recipients.filter((r) => r.required).length || request.recipients.length} signed`;

export async function signingAdmin<T>(action: string, id: string | null = null, data: Record<string, unknown> = {}): Promise<T> {
  const result = await supabase.rpc("signing_admin", { p_action: action, p_id: id, p_data: data });
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}
export async function signingMine<T>(action: "list" | "token", id: string | null = null): Promise<T> {
  const result = await supabase.rpc("signing_mine", { p_action: action, p_id: id });
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}
export async function signingAction<T>(body: Record<string, unknown>, file?: File): Promise<T> {
  return invokeFunction<T>("document-signing", body, "The signing request could not be completed.", file);
}
/** The `payments` function (Stripe Checkout on a signing request): a link holder sends the signing token, an administrator their session. Errors come back as { error }. */
export function paymentsAction<T>(body: Record<string, unknown>): Promise<T> {
  return invokeFunction<T>("payments", body, "The payment request could not be completed.");
}
/** Sets (or, with null, removes) the payment on a request that is not sent out yet or not paid yet. */
export const paymentSet = (requestId: string, payment: PaymentInput | null) =>
  signingAdmin<{ payment: SigningPayment | null }>("payment_set", requestId, { payment: payment ? { ...payment, currency: payment.currency.trim().toLowerCase() } : null });
async function invokeFunction<T>(name: string, body: Record<string, unknown>, fallback: string, file?: File): Promise<T> {
  const form = file ? new FormData() : null;
  if (form && file) { form.set("data", JSON.stringify(body)); form.set("file", file); }
  const { data, error } = await supabase.functions.invoke(name, { body: form ?? body });
  if (error) {
    let message = fallback, code = "";
    try {
      const response = await error.context?.json();
      if (typeof response?.error === "string") message = response.error;
      if (typeof response?.code === "string") code = response.code;
    } catch { /* safe fallback */ }
    if (error.context?.status === 546) code ||= "WORKER_LIMIT";
    throw Object.assign(new Error(message), { code });
  }
  return data as T;
}
/** The platform stopped the worker (its CPU or memory limit), not a refusal: the same call may simply be made again. */
export const isWorkerLimit = (error: unknown) => (error as { code?: string } | null)?.code === "WORKER_LIMIT";
/**
 * Signs through the function, again up to twice when the platform stopped the worker. The database keeps one signature per person,
 * so a retry after a stop that came after the commit answers "already signed": that is reported as signed.
 */
export async function signWithRetry<T>(body: Record<string, unknown>, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T | { signed: true; retried: true }> {
  for (let attempt = 0; ; attempt++) {
    try { return await signingAction<T>(body); }
    catch (error) {
      if (attempt > 0 && /already signed/i.test((error as Error).message)) return { signed: true, retried: true };
      if (!isWorkerLimit(error) || attempt >= 2) throw error;
      await wait(800 * (attempt + 1));
    }
  }
}
/* ------------------------------------------------------------------ agent onboarding documents (2026-11-17) */
/** The two blanks shipped with the site, uploaded once to the Sign module as PDF templates (document-signing `agent_onboarding_install`). */
export const AGENT_ONBOARDING_BLANKS: ReadonlyArray<{ which: "form" | "agreement" | "referee"; name: string; path: string }> = [
  { which: "form", name: "Agent Application Form", path: "/templates/agent_application_form_template_blank.pdf" },
  { which: "referee", name: "Agent Referee Check Form", path: "/templates/agent_referee_check_form_template_blank.pdf" },
  { which: "agreement", name: "Agent Agreement", path: "/templates/agent_agreement_template_blank.pdf" },
];
export const ONBOARDING_TEMPLATES_MISSING = /Install the agent onboarding templates first(?: \((form|referee|agreement)\))?/i;
/** Installs the blanks the function asked for (the one named in its error), or all three. */
export async function installAgentOnboardingTemplates(only?: "form" | "referee" | "agreement" | null): Promise<Array<{ id: string; systemKey: string; fields: number; pages: number }>> {
  const out = [];
  for (const blank of AGENT_ONBOARDING_BLANKS.filter((b) => !only || b.which === only)) {
    const response = await fetch(blank.path);
    if (!response.ok) throw new Error(`The ${blank.name} blank is missing from the site (${blank.path}).`);
    const file = new File([await response.blob()], blank.path.split("/").pop() ?? "blank.pdf", { type: "application/pdf" });
    out.push(await signingAction<{ id: string; systemKey: string; fields: number; pages: number }>({ action: "agent_onboarding_install", which: blank.which }, file));
  }
  return out;
}
export interface AgentOnboardingSendResult { id: string; reference: string; onboardingId: string; stage?: string; sent: boolean; state?: string; warning?: string; override?: boolean; agent?: { name: string; email: string }; printed?: number; fields?: number }
/** Runs an onboarding action; installs the three blanks first when the Sign module does not have them yet, then tries once more. */
async function onboardingAction<T>(body: Record<string, unknown>, file?: File): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await signingAction<T>(body, file); }
    catch (error) {
      const missing = ONBOARDING_TEMPLATES_MISSING.exec((error as Error).message);
      if (!missing || attempt >= 3) throw error;
      await installAgentOnboardingTemplates((missing[1] as "form" | "referee" | "agreement" | undefined) ?? null);
    }
  }
}
/** Stage 1: the application form to the business's agent. */
export const sendAgentApplication = (input: { agencyId: string; agentId?: string | null; message?: string }) => onboardingAction<AgentOnboardingSendResult>({ action: "agent_onboarding_send_application", ...input });
export interface AgentAgreementSendInput {
  agencyId: string; onboardingId: string; agentId?: string | null; commencementDate: string; territory: string; commissionPercent: string; adminName: string; adminPosition: string;
  adminWitnessName?: string; message?: string; overrideReason?: string;
  adminSignature: { kind: "saved" } | { kind: "drawn"; png: string; save?: boolean } | { kind: "typed"; name: string };
}
/** Stage 3: the agreement to the agent (at References received, or earlier with a typed reason). */
export const sendAgentAgreement = (input: AgentAgreementSendInput) => onboardingAction<AgentOnboardingSendResult>({ action: "agent_onboarding_send_agreement", ...input });
/** Reject the references: the onboarding is declined (reason kept for staff), its open requests voided, the agent emailed a polite decline. */
export const rejectOnboarding = (input: { onboardingId: string; reason: string }) => onboardingAction<{ id: string; stage: string; emailed: boolean; agent: { name: string; email: string } }>({ action: "agent_onboarding_reject", ...input });
/**
 * Agent-level onboarding (migration 20261118004521): Add agent records the agent as Onboarding (no login, no invitation) and emails them
 * the application form, prefilled with the business's details. CMS administrators pass the business; a business admin agent in the portal
 * adds to their own business. `agentId` starts the onboarding again for a Declined agent or one whose form was never signed.
 */
export interface AgentAddResult { onboardingId: string; agentId: string; reference: string; sent: boolean; agent: { id: string; name: string; email: string; role: "agent" | "agency_admin" }; agency: { id: string; name: string } }
export const addAgentForOnboarding = (input: { businessId?: string | null; agentId?: string | null; name: string; email: string; phone?: string; role?: "agent" | "agency_admin"; message?: string }) =>
  onboardingAction<AgentAddResult>({ action: "agent_onboarding_add_agent", ...input });
/** Activate: both references are back; the agent becomes Active and is sent the congratulations set-password email (once). */
export const activateOnboardedAgent = (onboardingId: string) =>
  onboardingAction<{ onboardingId: string; invited: boolean; loginExists: boolean; agent: { id: string; name: string; email: string } }>({ action: "agent_onboarding_agent_activate", onboardingId });
/** The agent's own agreement: the active Individual agent agreement template, sent to the agent once both references are back. */
export const sendAgentOwnAgreement = (input: { onboardingId: string; message?: string }) =>
  onboardingAction<{ id: string; reference: string; stage: string; sent: boolean; warning?: string; template: { id: string; name: string; version: number }; agent: { name: string; email: string } }>({ action: "agent_onboarding_agent_agreement_send", ...input });
/** A signed agreement received outside the Sign module, recorded by an administrator with a reason (kept in the history). */
export const uploadAgentOwnAgreement = (onboardingId: string, file: File, reason: string) =>
  onboardingAction<{ onboardingId: string; stage: string; voided: string | null }>({ action: "agent_onboarding_agent_agreement_upload", onboardingId, reason }, file);
/** Stage 2 by hand: the referee checks still outstanding (after a failed automatic send). */
export const sendRefereeChecks = (onboardingId: string) => onboardingAction<{ sent: number; skipped: number }>({ action: "agent_onboarding_send_referees", onboardingId });
/** A referee's email address (and name) changes: the old request is voided, a new referee check goes out. */
export const changeReferee = (input: { refereeId: string; email: string; name?: string }) => onboardingAction<{ email: string; sent: number }>({ action: "agent_onboarding_referee_change", ...input });
/** A signed referee check received by email, uploaded by staff. */
export const uploadRefereeForm = (refereeId: string, file: File) => onboardingAction<{ stage: string; notified: boolean }>({ action: "agent_onboarding_referee_upload", refereeId }, file);
/** A tick box that answers a question together with its siblings ("litigation_involved:YES"): the question and this box's answer. */
export function fieldGroup(key: string | null | undefined): { key: string; answer: string } | null {
  const text = String(key ?? ""); const colon = text.indexOf(":");
  return colon > 0 ? { key: text.slice(0, colon), answer: text.slice(colon + 1) } : null;
}

/** A saved header or footer (TPL-02); picking one copies its HTML into the template. */
export interface TemplatePart { id: string; kind: "header" | "footer"; name: string; html: string; updated_at: string }
export const listTemplateParts = () => signingAdmin<TemplatePart[]>("part_list");
export const saveTemplatePart = (part: { id?: string | null; kind: "header" | "footer"; name: string; html: string }) => signingAdmin<TemplatePart>("part_save", part.id ?? null, { kind: part.kind, name: part.name, html: part.html });
export const deleteTemplatePart = (id: string) => signingAdmin<{ id: string }>("part_delete", id);

export const pdfBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
/** The text of a .docx file, for a text template (formatting is not kept). */
export async function docxText(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose a Word document of 5 MB or smaller.");
  const { unzipSync, strFromU8 } = await import("fflate");
  let xml: Uint8Array | undefined;
  try { xml = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => entry.name === "word/document.xml" && entry.originalSize <= 8 * 1024 * 1024 })["word/document.xml"]; }
  catch { throw new Error("This file is not a Word .docx document."); }
  if (!xml) throw new Error("This file is not a Word .docx document.");
  return docxXmlToText(strFromU8(xml));
}

/**
 * True when the database answers the second-stage signing actions (20261113140000). Until that migration is released on hosted, the
 * admin and signing pages show the released first-stage screens, so a frontend release before the database release breaks nothing.
 */
export async function signingUpgraded(): Promise<boolean> {
  const result = await supabase.rpc("signing_admin", { p_action: "subject_search", p_id: null, p_data: { type: "none" } });
  if (!result.error) return true;
  // The released function looks the id up before it rejects an action it does not know.
  if (/Unknown signing action|Signing request not found/i.test(result.error.message)) return false;
  throw new Error(result.error.message);
}
