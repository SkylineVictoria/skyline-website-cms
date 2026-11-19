import { supabase } from "@/pages/admin/lib/supabase";
import { STAGE_LABEL, type OnboardingStage } from "../../../../supabase/functions/_shared/agent-onboarding";

/*
 * Agent onboarding documents (2026-11-17), in stages: the Agent Application Form (F04) to the business's agent; when signed, an Agent
 * Referee Check Form (F05) to each of the two referees it names; at "References received" (or earlier with a typed reason) the Agent
 * Agreement (P06). The database keeps one row per onboarding (public.agency_onboarding: stage, each document's request, the signed PDFs,
 * the answers), one row per referee (their request, their signed or uploaded F05) and a history. Rows of the first version (one merged
 * request) have stage "legacy" and keep showing as they did.
 */

export type { OnboardingStage };
export { STAGE_LABEL };
export interface OnboardingAgent { id: string; name: string; email: string; role: "agency_admin" | "agent"; status?: string }
export interface OnboardingPrepared {
  agency: { id: string; name: string; abn: string | null; email: string | null; phone: string | null; address: string | null; country: string | null; status: string; agreementStatus: AgreementStatus; commencementDate: string | null; expiryDate: string | null; profile: Record<string, string> };
  agents: OnboardingAgent[];
  agent: OnboardingAgent | null;
  admin: { name: string; position: string; signaturePng: string | null };
  values: Record<string, string>;
}
export type AgreementStatus = "none" | "sent" | "signed";
export interface RequestSummary { id: string; reference: string; state: string; expiresAt: string | null; sentAt: string | null; viewedAt: string | null; signedAt: string | null; recipientId: string | null; recipientState: string | null; lastNotifiedAt: string | null; reminderCount: number | null }
export interface OnboardingReferee {
  id: string; position: 1 | 2; name: string; organisation: string; positionTitle: string; email: string; phone: string; status: "pending" | "sent" | "received" | "cancelled"; domainWarning: boolean;
  receivedAt: string | null; receivedVia: "signed" | "upload" | null; fileName: string | null; files: { form: boolean; certificate: boolean }; answers: Record<string, string>; request: RequestSummary | null;
}
export interface OnboardingEvent { id: number; at: string; actor: string; event: string; detail: Record<string, unknown> }
export interface OnboardingRow {
  /** business: the business's onboarding (agreement); agent: one agent's own onboarding (no agreement; activated by staff). */
  kind?: "business" | "agent";
  id: string; status: "sent" | "signed" | "closed"; stage: OnboardingStage; createdAt: string; signedAt: string | null; signerName: string | null; closedReason: string | null;
  applicationSignedAt: string | null; referencesReceivedAt: string | null; message: string | null;
  commencementDate: string | null; expiryDate: string | null; territory: string; commissionPercent: number | null; adminName: string; adminPosition: string;
  override: { reason: string; at: string; by: string | null } | null;
  /** Staff approval of the references (2026-11-17), the decline (its reason is for staff only) and the activation after the signed agreement. */
  approval?: { at: string; by: string | null } | null;
  decline?: { at: string; reason: string; by: string | null } | null;
  activation?: { at: string; invitationId: string | null; invitationStatus: "pending" | "accepted" | "revoked" | null } | null;
  /** An agent's own agreement recorded by an administrator (a signed copy received outside the Sign module): when, by whom, why. */
  agreementUpload?: { at: string; reason: string; fileName: string | null; by: string | null } | null;
  /** The SLIT signatory of an agent's agreement (second signer); mine = the person looking at the page. */
  countersign?: { recipientId: string; name: string; email: string; state: string; signedAt: string | null; mine: boolean } | null;
  agent: { id: string; name: string; email: string; role?: "agent" | "agency_admin"; status?: string }; answers: Record<string, string>;
  /** The merged request of a legacy onboarding. */
  request: RequestSummary | null;
  application: RequestSummary | null; agreement: RequestSummary | null; referees: OnboardingReferee[]; events: OnboardingEvent[];
  files: { form: boolean; agreement: boolean; certificate: boolean; application_certificate: boolean };
  /** 2026-11-18: the business status in words, the correction rounds and the PDF revisions after the first signature. */
  label?: string | null; corrections?: OnboardingCorrection[]; revisions?: OnboardingRevision[];
  /** 2026-11-20: the application request carries the agreement (signed once); the witness; the one signature on both; the agreement issued at approval. */
  combined?: boolean; witness?: { name: string; by: "admin" | "agent" | null } | null; signatureEvent?: SignatureEvent | null; agreementIssuedAt?: string | null; presendSavedAt?: string | null;
}
/** One signature covered the application form and the agreement (2026-11-20): when, by whom, from where. */
export interface SignatureEvent { at: string; request: string; signer: string | null; signatureKind?: string | null; ip?: string | null; userAgent?: string | null; documents?: string[] }
export interface FieldChange { field: string; old: string; new: string }
export interface OnboardingCorrection { id: string; round: number; message: string | null; flags: Record<string, string>; status: "open" | "resubmitted" | "closed"; changes: FieldChange[]; by: string | null;
  requestedAt: string; resubmittedAt: string | null; closedReason: string | null; request: RequestSummary | null }
export interface OnboardingRevision { id: string; revision: number; kind: "staff_edit" | "resubmitted"; note: string | null; changes: FieldChange[]; by: string | null; at: string }
/** What staff review in the F04 wizard (admin-review mode): the form's fields, the current answers, the referees' replies, an open correction. */
export interface ApplicationReview {
  onboardingId: string; stage: OnboardingStage; label: string | null; agency: { id: string; name: string; abn: string | null; status: string }; contact: { id: string; name: string; email: string; role: string };
  requestId: string; signerName: string | null; signedAt: string | null;
  fields: Array<{ id: string; key: string; type: string; label: string; required: boolean; page: number }>; answers: Record<string, string>; facts: Record<string, unknown> | null;
  attachments: Record<string, { name: string; size: number; at: string }>;
  referees: Array<{ id: string; position: number; name: string; organisation: string; positionTitle: string; email: string; phone: string; status: string; receivedAt: string | null; receivedVia: string | null; answers: Record<string, string>; request?: RequestSummary | null }>;
  correction: { round: number; message: string | null; flags: Record<string, string>; requestedAt: string; by: string | null } | null;
  combined?: boolean; terms?: { commencementDate: string | null; expiryDate: string | null; territory: string; commissionPercent: number | null } | null;
  witness?: { name: string; by: string | null } | null; signatureEvent?: SignatureEvent | null;
}
export const getApplicationReview = (onboardingId: string) => call<ApplicationReview>("agency_onboarding_review_get", { p_onboarding: onboardingId }, "The application could not be opened for review.");
export async function openRevisionFile(revisionId: string): Promise<void> {
  const file = await call<{ name: string; base64: string }>("agency_onboarding_revision_file", { p_revision: revisionId }, "The revision could not be opened.");
  const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url; link.download = file.name; link.rel = "noopener";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
/** form / agreement / certificate / application_certificate, or "referee:<id>" / "referee_certificate:<id>" (administrators only). */
export type OnboardingFileKind = string;
export const ONBOARDING_FILE_LABEL: Record<string, string> = { form: "Application form (signed)", agreement: "Agent agreement (signed)", certificate: "Completion certificate", application_certificate: "Application form certificate" };
export const EVENT_LABEL: Record<string, string> = {
  application_sent: "Application form sent", application_signed: "Application form signed", referee_check_sent: "Referee check sent", referee_received: "Reference received (signed online)",
  referee_uploaded: "Reference received (uploaded)", referee_email_changed: "Referee email changed", referee_check_closed: "Referee check closed", references_received: "References received",
  agent_notified_referees: "Agent told their referees were contacted", staff_notified_references: "Staff emailed: references received", override: "Agreement sent before both references (override)",
  agreement_sent: "Agreement sent", agreement_signed: "Agreement signed", cancelled: "Cancelled", expired: "Expired",
  references_approved: "References approved", declined: "Declined", activated: "Business activated, set-password email sent",
  agent_added: "Agent added", agent_activated: "Agent activated", agreement_uploaded: "Signed agreement recorded (uploaded)", countersigner_changed: "SLIT signatory changed",
  application_prefilled: "Application form prefilled (ABN Lookup and Add business)", prefill_reviewed: "Prefilled values checked against the signed form",
  application_declarations: "Declarations ticked, ACN / MARN recorded", application_prefilled_on_open: "Blank application fields filled when the form was opened (ABN Lookup and business record)",
  staff_edit: "Application edited by SLIT staff", revision_added: "New PDF revision", correction_requested: "Sent back for correction", correction_closed: "Correction request closed unsigned",
  resubmitted: "Corrected and signed again", referee_corrected: "Referee details corrected: new referee check", approved: "Approved: business active",
  draft_created: "Application prepared (draft, not sent)", draft_saved: "Draft saved by SLIT staff", signed_once: "Signed once: application form and agreement", witness_recorded: "Witness added by the agency admin",
  agreement_issued: "Agreement countersigned and issued",
};
/** Stages that are still in progress (one at a time per business). */
export const ACTIVE_STAGES: OnboardingStage[] = ["draft", "application_sent", "application_signed", "references_pending", "references_received", "references_approved", "agreement_sent", "correction_requested", "resubmitted"];
/** Staff approve the references (then the Send agreement dialog opens) or decline the onboarding with a reason kept for staff. */
export const approveReferences = (onboardingId: string) => call<{ id: string; stage: OnboardingStage; approvedAt: string }>("agency_onboarding_approve_references", { p_onboarding: onboardingId }, "The references could not be approved.");

async function call<T>(fn: string, params: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.rpc(fn, params);
  if (error) throw new Error(error.message || fallback);
  return data as T;
}
export const prepareOnboarding = (agencyId: string, agentId?: string | null) => call<OnboardingPrepared>("agency_onboarding_prepare", { p_agency: agencyId, p_agent: agentId ?? null }, "We could not prepare the onboarding documents.");
export const listOnboarding = (agencyId: string) => call<OnboardingRow[]>("agency_onboarding_list", { p_agency: agencyId }, "We could not load the onboarding documents.");
export const onboardingFile = (id: string, kind: OnboardingFileKind) => call<{ name: string; base64: string }>("agency_onboarding_file", { p_id: id, p_kind: kind }, "The document could not be opened.");
export const saveMySignature = (png: string | null) => call<{ saved: boolean }>("cms_user_signature_save", { p_png: png }, "The signature could not be saved.");

/** The organisation chart / business profile uploaded with the F04 wizard (2026-11-19), administrators only. */
export interface ApplicationAttachment { kind: string; name: string; contentType: string; size: number; at: string }
export const APPLICATION_ATTACHMENT_LABEL: Record<string, string> = { org_chart: "Organisational chart", business_profile: "Business profile" };
export const listApplicationAttachments = (onboardingId: string) => call<ApplicationAttachment[]>("agency_onboarding_attachments_list", { p_onboarding: onboardingId }, "The uploaded files could not be listed.");
export async function openApplicationAttachment(onboardingId: string, kind: string): Promise<void> {
  const file = await call<{ name: string; contentType: string; base64: string }>("agency_onboarding_attachment_file", { p_onboarding: onboardingId, p_kind: kind }, "The file could not be opened.");
  const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
  const link = document.createElement("a");
  link.href = url; link.download = file.name; link.rel = "noopener";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Opens a signed PDF kept in the database in a new tab (a blob of this page; nothing is stored in the browser). */
export async function openOnboardingFile(id: string, kind: OnboardingFileKind): Promise<void> {
  const file = await onboardingFile(id, kind);
  const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url; link.download = file.name; link.rel = "noopener";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** The form's own labels for the answers shown on the business page (the CMS reads them from the agency's profile). */
export const PROFILE_LABELS: Array<[string, string]> = [
  ["agent_legal_entity", "Legal entity"], ["agent_trading_name", "Trading name"], ["agent_acn", "ACN"], ["agent_marn", "MARA number (MARN)"],
  ["agent_registration_number", "Business/MARA/Registration number"], ["agent_gst_registered", "GST registered"],
  ["contact_title", "Contact title"], ["contact_given_name", "Contact given name"], ["contact_family_name", "Contact family name"], ["contact_position", "Contact position"],
  ["contact_email", "Contact email"], ["contact_phone", "Contact phone"], ["agent_website", "Website"], ["agent_fax", "Fax"],
  ["office_street_address", "Office street address"], ["office_suburb", "Suburb / city"], ["office_state", "State"], ["office_province", "Province / postcode"], ["office_country", "Country"],
  ["agent_year_founded", "Year founded"], ["agent_years_as_education_agent", "Years as an education agent"], ["org_chart_attached", "Organisation chart attached"],
  ["business_profile_attached", "Business profile attached"], ["litigation_involved", "Involved in litigation"], ["litigation_details", "Litigation details"],
  ["students_recruited_per_year", "Students recruited per year"], ["popular_courses", "Most popular courses"], ["slit_promotion_plan", "How they will promote SLIT"],
  ["slit_recruitment_target", "Recruitment target for SLIT"], ["staff_count", "Number of staff"], ["services_provided", "Services provided"], ["eatc_completed", "EATC completed"],
  ["eatc_details", "EATC details"], ["associations", "Associations / memberships"], ["number_of_offices", "Number of offices"], ["other_countries_recruited", "Other countries recruited from"],
  ["australian_institutions_represented", "Australian institutions represented"], ["works_with_sub_agents", "Works with sub-agents"], ["sub_agent_names", "Sub-agent names"],
  ["ref1_contact_name", "Reference 1: contact"], ["ref1_organisation", "Reference 1: organisation"], ["ref1_position", "Reference 1: position"], ["ref1_email", "Reference 1: email"],
  ["ref1_phone", "Reference 1: phone"], ["ref1_address", "Reference 1: address"], ["ref2_contact_name", "Reference 2: contact"], ["ref2_organisation", "Reference 2: organisation"],
  ["ref2_position", "Reference 2: position"], ["ref2_email", "Reference 2: email"], ["ref2_phone", "Reference 2: phone"], ["ref2_address", "Reference 2: address"],
  ["agent_signatory_name", "Agreement signatory"], ["agent_signatory_position", "Signatory position"], ["agent_witness_name", "Agent's witness"], ["declarant_name", "Declarant"], ["declarant_role", "Declarant role"],
];
/** The F05 answers as the referee left them. */
export const REFEREE_LABELS: Array<[string, string]> = [
  ["referee_organisation", "Organisation"], ["referee_address", "Address"], ["referee_contact_person_1", "Contact person"], ["referee_contact_person_2", "Second contact"], ["referee_phone", "Phone"], ["referee_fax", "Fax"],
];
export const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const formatAuDate = (iso: string | null | undefined) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? "")); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso ?? ""; };
/** The stage in plain words, with the referee count while waiting for them. */
export function stageWords(stage: OnboardingStage, received: number, total: number, kind: "business" | "agent" = "business"): string {
  if (stage === "references_pending" || (kind === "agent" && stage === "application_signed")) return `Waiting for referees (${received} of ${total || 2} received)`;
  if (kind === "agent" && stage === "references_received") return "Both references received: send the agreement";
  if (kind === "agent" && stage === "agreement_sent") return "Agreement sent";
  if (kind === "agent" && stage === "agreement_signed") return "Ready: agreement fully signed";
  if (kind === "agent" && stage === "declined") return "Rejected";
  // Onboarding per business: the signed agreement activates nothing; an administrator presses Activate.
  if (kind === "business" && stage === "agreement_signed") return "Ready to activate";
  return STAGE_LABEL[stage] ?? stage;
}
