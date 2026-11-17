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
  id: string; status: "sent" | "signed" | "closed"; stage: OnboardingStage; createdAt: string; signedAt: string | null; signerName: string | null; closedReason: string | null;
  applicationSignedAt: string | null; referencesReceivedAt: string | null; message: string | null;
  commencementDate: string | null; expiryDate: string | null; territory: string; commissionPercent: number | null; adminName: string; adminPosition: string;
  override: { reason: string; at: string; by: string | null } | null;
  agent: { id: string; name: string; email: string }; answers: Record<string, string>;
  /** The merged request of a legacy onboarding. */
  request: RequestSummary | null;
  application: RequestSummary | null; agreement: RequestSummary | null; referees: OnboardingReferee[]; events: OnboardingEvent[];
  files: { form: boolean; agreement: boolean; certificate: boolean; application_certificate: boolean };
}
/** form / agreement / certificate / application_certificate, or "referee:<id>" / "referee_certificate:<id>" (administrators only). */
export type OnboardingFileKind = string;
export const ONBOARDING_FILE_LABEL: Record<string, string> = { form: "Application form (signed)", agreement: "Agent agreement (signed)", certificate: "Completion certificate", application_certificate: "Application form certificate" };
export const EVENT_LABEL: Record<string, string> = {
  application_sent: "Application form sent", application_signed: "Application form signed", referee_check_sent: "Referee check sent", referee_received: "Reference received (signed online)",
  referee_uploaded: "Reference received (uploaded)", referee_email_changed: "Referee email changed", referee_check_closed: "Referee check closed", references_received: "References received",
  agent_notified_referees: "Agent told their referees were contacted", staff_notified_references: "Staff emailed: references received", override: "Agreement sent before both references (override)",
  agreement_sent: "Agreement sent", agreement_signed: "Agreement signed", cancelled: "Cancelled", expired: "Expired",
};
/** Stages that are still in progress (one at a time per business). */
export const ACTIVE_STAGES: OnboardingStage[] = ["application_sent", "application_signed", "references_pending", "references_received", "agreement_sent"];

async function call<T>(fn: string, params: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.rpc(fn, params);
  if (error) throw new Error(error.message || fallback);
  return data as T;
}
export const prepareOnboarding = (agencyId: string, agentId?: string | null) => call<OnboardingPrepared>("agency_onboarding_prepare", { p_agency: agencyId, p_agent: agentId ?? null }, "We could not prepare the onboarding documents.");
export const listOnboarding = (agencyId: string) => call<OnboardingRow[]>("agency_onboarding_list", { p_agency: agencyId }, "We could not load the onboarding documents.");
export const onboardingFile = (id: string, kind: OnboardingFileKind) => call<{ name: string; base64: string }>("agency_onboarding_file", { p_id: id, p_kind: kind }, "The document could not be opened.");
export const saveMySignature = (png: string | null) => call<{ saved: boolean }>("cms_user_signature_save", { p_png: png }, "The signature could not be saved.");

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
  ["agent_legal_entity", "Legal entity"], ["agent_trading_name", "Trading name"], ["agent_registration_number", "Registration number"], ["agent_gst_registered", "GST registered"],
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
export function stageWords(stage: OnboardingStage, received: number, total: number): string {
  if (stage === "references_pending") return `Waiting for referees (${received} of ${total || 2} received)`;
  return STAGE_LABEL[stage] ?? stage;
}
