// Agent onboarding documents (2026-11-17): the Agent Application Form (F04, 2 pages) and the Agent Agreement (P06, 13 pages) are two
// blank, fillable PDFs. Every AcroForm field name is a variable key. Both become PDF templates of the Sign module (hr.sign_templates,
// kind "pdf", audience "agent"): the sender's fields print the agency's data when the request is made, the agent's fields are filled
// on the signing page, exactly as the student offer letter. This registry says, per key, who fills it and where the value comes from.
// Runtime-neutral: the Edge Function (install, send, completion), the offline tests and the browser (labels, groups) share it.

export type OnboardingDoc = "form" | "agreement" | "referee";
/** Who fills the field: the sender (printed when the request is made), the agent or the referee (a field on the signing page). */
export type OnboardingRole = "sender" | "agent" | "referee";
/**
 * auto: the value comes from our records (printed; when we hold no value the agent types it on the signing page).
 * admin: entered on the send dialog. agent: the agent fills it. signing: the Sign engine fills it when the agent signs (date, signature).
 */
export type OnboardingSource = "auto" | "admin" | "agent" | "signing";
export interface OnboardingField {
  doc: OnboardingDoc;
  label: string;
  type: "text" | "checkbox" | "signature" | "date";
  role: OnboardingRole;
  source: OnboardingSource;
  required?: boolean;
  /** A tick box that answers a question with others (one of them is ticked): the question key and this box's answer. */
  group?: { key: string; answer: string };
  /** The AcroForm radio option whose widget this box is (a radio group has one widget per option). */
  option?: string;
  /** Printed when the sender holds a value; otherwise a field the agent fills in (optional unless `required`). */
  autoOrAgent?: boolean;
  /** An ABN, a date, a percentage: how the typed value is shown. */
  format?: "abn" | "date" | "percent";
}

export interface OnboardingDocument { key: "agent_application_form" | "agent_agreement" | "agent_referee_check_form"; name: string; title: string; sha256: string; pages: number; category: string; file: string }
/** The two blanks, with the checksum of the files in public/templates: a different file is refused by the installer. */
export const AGENT_ONBOARDING_DOCS: Record<OnboardingDoc, OnboardingDocument> = {
  form: { key: "agent_application_form", name: "Agent Application Form", title: "Agent Application Form (F04)", sha256: "53cf0ab79594d0f0f8d47db112a39d443ff959f9797d48cbd796c7f4ae1368f4", pages: 2, category: "other", file: "agent_application_form_template_blank.pdf" },
  agreement: { key: "agent_agreement", name: "Agent Agreement", title: "Education Agent Agreement (P06)", sha256: "2b4cfab02a24e874a1ffc1c4c8165da632377bf9358d1e00b357eb0c482e210a", pages: 13, category: "agency_agreement", file: "agent_agreement_template_blank.pdf" },
  referee: { key: "agent_referee_check_form", name: "Agent Referee Check Form", title: "Agent Referee Check Form (F05)", sha256: "fe609be45c91a7b0f44e4a7d881ed5d088a66322df8a56313e61af6212a0ce20", pages: 1, category: "other", file: "agent_referee_check_form_template_blank.pdf" },
};
/** The agreement runs for two years from its commencement (Item 5). */
export const AGREEMENT_TERM_YEARS = 2;
export const ONBOARDING_SIGNER_ROLE = { key: "agent", label: "Agent", order: 1, required: true };
export const REFEREE_SIGNER_ROLE = { key: "referee", label: "Referee", order: 1, required: true };
/** The one signer of each document: the agent (application form, agreement) or the referee (referee check). */
export const signerRole = (doc: OnboardingDoc) => doc === "referee" ? REFEREE_SIGNER_ROLE : ONBOARDING_SIGNER_ROLE;
/** The onboarding runs in stages (2026-11-17): the form, then a referee check per reference, then the agreement. */
export const ONBOARDING_STAGES = ["application_sent", "application_signed", "references_pending", "references_received", "references_approved", "agreement_sent", "agreement_signed"] as const;
export type OnboardingStage = typeof ONBOARDING_STAGES[number] | "legacy" | "cancelled" | "expired" | "declined" | "activated";
export const STAGE_LABEL: Record<OnboardingStage, string> = {
  legacy: "Sent as one document", application_sent: "Application form sent", application_signed: "Application form signed", references_pending: "Waiting for referees",
  references_received: "References received: review", references_approved: "References approved", agreement_sent: "Agreement sent", agreement_signed: "Agreement signed",
  cancelled: "Cancelled", expired: "Expired", declined: "Declined", activated: "Agent activated",
};

const auto = (doc: OnboardingDoc, label: string, extra: Partial<OnboardingField> = {}): OnboardingField => ({ doc, label, type: "text", role: "sender", source: "auto", ...extra });
const autoOrAgent = (doc: OnboardingDoc, label: string, extra: Partial<OnboardingField> = {}): OnboardingField => ({ doc, label, type: "text", role: "sender", source: "auto", autoOrAgent: true, ...extra });
const admin = (doc: OnboardingDoc, label: string, extra: Partial<OnboardingField> = {}): OnboardingField => ({ doc, label, type: "text", role: "sender", source: "admin", ...extra });
const agent = (doc: OnboardingDoc, label: string, extra: Partial<OnboardingField> = {}): OnboardingField => ({ doc, label, type: "text", role: "agent", source: "agent", ...extra });
const ref = (n: 1 | 2): Record<string, OnboardingField> => ({
  [`ref${n}_contact_name`]: agent("form", `Reference ${n}: contact name`, { required: true }),
  [`ref${n}_organisation`]: agent("form", `Reference ${n}: organisation`, { required: true }),
  [`ref${n}_position`]: agent("form", `Reference ${n}: position`),
  [`ref${n}_email`]: agent("form", `Reference ${n}: email`, { required: true }),
  [`ref${n}_phone`]: agent("form", `Reference ${n}: phone`, { required: true }),
  [`ref${n}_address`]: agent("form", `Reference ${n}: address`),
});

/** Every AcroForm field of the two blanks, by its field name. A radio group appears once per option (key "<group>:<answer>"). */
export const AGENT_ONBOARDING_FIELDS: Record<string, OnboardingField> = {
  // ------------------------------------------------------------- Agent Agreement (P06)
  agent_organisation_name: auto("agreement", "Agent organisation name"),
  agent_abn: auto("agreement", "ABN", { format: "abn" }),
  agreement_commencement_date: admin("agreement", "Commencement date", { format: "date" }),
  agent_territory: admin("agreement", "Territory"),
  agent_commission_percent: admin("agreement", "Commission", { format: "percent" }),
  admin_name: auto("agreement", "SLIT signatory name"),
  admin_position: admin("agreement", "SLIT signatory position"),
  admin_signature: admin("agreement", "SLIT signature", { type: "signature" }),
  admin_signed_date: auto("agreement", "SLIT signed date", { format: "date" }),
  admin_witness_name: admin("agreement", "SLIT witness name"),
  admin_witness_signature: admin("agreement", "SLIT witness signature"),
  agent_signatory_name: agent("agreement", "Agent signatory name", { required: true }),
  agent_signatory_position: agent("agreement", "Agent signatory position", { required: true }),
  agent_signature: agent("agreement", "Agent signature", { type: "signature", source: "signing", required: true }),
  agent_signed_date: agent("agreement", "Agent signed date", { type: "date", source: "signing" }),
  agent_witness_name: agent("agreement", "Agent witness name"),
  agent_witness_signature: agent("agreement", "Agent witness: type full name"),
  // ------------------------------------------------------------- Agent Application Form (F04), page 1: the agency
  agent_agency_name: autoOrAgent("form", "Agency name", { required: true }),
  agent_legal_entity: autoOrAgent("form", "Legal entity"),
  agent_trading_name: autoOrAgent("form", "Trading name"),
  agent_registration_number: autoOrAgent("form", "Registration number (ACN)"),
  "agent_gst_registered:YES": { doc: "form", label: "GST registered: Yes", type: "checkbox", role: "sender", source: "auto", autoOrAgent: true, group: { key: "agent_gst_registered", answer: "YES" } },
  "agent_gst_registered:NO": { doc: "form", label: "GST registered: No", type: "checkbox", role: "sender", source: "auto", autoOrAgent: true, group: { key: "agent_gst_registered", answer: "NO" } },
  agent_abn_form: autoOrAgent("form", "ABN", { format: "abn", required: true }),
  contact_title: autoOrAgent("form", "Contact title (Mr, Ms, Dr)"),
  contact_given_name: autoOrAgent("form", "Contact given name", { required: true }),
  contact_family_name: autoOrAgent("form", "Contact family name", { required: true }),
  contact_position: autoOrAgent("form", "Contact position", { required: true }),
  contact_email: autoOrAgent("form", "Contact email", { required: true }),
  contact_phone: autoOrAgent("form", "Contact phone", { required: true }),
  agent_website: autoOrAgent("form", "Website"),
  agent_fax: autoOrAgent("form", "Fax"),
  office_street_address: autoOrAgent("form", "Office street address", { required: true }),
  office_suburb: autoOrAgent("form", "Suburb / city"),
  office_state: autoOrAgent("form", "State"),
  office_province: autoOrAgent("form", "Province / postcode"),
  office_country: autoOrAgent("form", "Country", { required: true }),
  // ------------------------------------------------------------- Application form: the agent's answers
  agent_year_founded: agent("form", "Year founded"),
  agent_years_as_education_agent: agent("form", "Years as an education agent"),
  "org_chart_attached:YES": { doc: "form", label: "Organisation chart attached: Yes", type: "checkbox", role: "agent", source: "agent", group: { key: "org_chart_attached", answer: "YES" }, option: "Choice1" },
  "org_chart_attached:NO": { doc: "form", label: "Organisation chart attached: No", type: "checkbox", role: "agent", source: "agent", group: { key: "org_chart_attached", answer: "NO" }, option: "Choice2" },
  "business_profile_attached:YES": { doc: "form", label: "Business profile attached: Yes", type: "checkbox", role: "agent", source: "agent", group: { key: "business_profile_attached", answer: "YES" }, option: "Choice3" },
  "business_profile_attached:NO": { doc: "form", label: "Business profile attached: No", type: "checkbox", role: "agent", source: "agent", group: { key: "business_profile_attached", answer: "NO" }, option: "Choice4" },
  "litigation_involved:YES": { doc: "form", label: "Involved in litigation: Yes", type: "checkbox", role: "agent", source: "agent", required: true, group: { key: "litigation_involved", answer: "YES" }, option: "YES" },
  "litigation_involved:NO": { doc: "form", label: "Involved in litigation: No", type: "checkbox", role: "agent", source: "agent", required: true, group: { key: "litigation_involved", answer: "NO" }, option: "NO" },
  litigation_details: agent("form", "Litigation details"),
  students_recruited_per_year: agent("form", "Students recruited per year"),
  popular_courses: agent("form", "Most popular courses"),
  slit_promotion_plan: agent("form", "How you will promote SLIT"),
  slit_recruitment_target: agent("form", "Recruitment target for SLIT"),
  staff_count: agent("form", "Number of staff"),
  services_provided: agent("form", "Services provided"),
  "eatc_completed:YES": { doc: "form", label: "EATC completed: Yes", type: "checkbox", role: "agent", source: "agent", required: true, group: { key: "eatc_completed", answer: "YES" } },
  "eatc_completed:NO": { doc: "form", label: "EATC completed: No", type: "checkbox", role: "agent", source: "agent", required: true, group: { key: "eatc_completed", answer: "NO" } },
  eatc_details: agent("form", "EATC details"),
  associations: agent("form", "Associations / memberships"),
  number_of_offices: agent("form", "Number of offices"),
  other_countries_recruited: agent("form", "Other countries you recruit from"),
  australian_institutions_represented: agent("form", "Australian institutions represented"),
  "works_with_sub_agents:YES": { doc: "form", label: "Works with sub-agents: Yes", type: "checkbox", role: "agent", source: "agent", group: { key: "works_with_sub_agents", answer: "YES" }, option: "Choice1" },
  "works_with_sub_agents:NO": { doc: "form", label: "Works with sub-agents: No", type: "checkbox", role: "agent", source: "agent", group: { key: "works_with_sub_agents", answer: "NO" }, option: "Choice2" },
  sub_agent_names: agent("form", "Sub-agent names"),
  ...ref(1),
  ...ref(2),
  declarant_name: autoOrAgent("form", "Declarant name", { required: true }),
  declarant_role: autoOrAgent("form", "Declarant role", { required: true }),
  agent_signed_date_form: agent("form", "Agent signed date", { type: "date", source: "signing" }),
  agent_signature_form: agent("form", "Agent signature", { type: "signature", source: "signing", required: true }),
  // ------------------------------------------------------------- Agent Referee Check Form (F05): one per reference named on the F04
  agent_agency_name_referee: auto("referee", "Agency name"),
  agent_office_address: auto("referee", "Agency office address"),
  referee_organisation: referee("Referee organisation", { required: true }),
  referee_address: referee("Referee address"),
  referee_contact_person_1: referee("Contact person", { required: true }),
  referee_contact_person_2: referee("Second contact person (optional)"),
  referee_phone: referee("Referee phone", { required: true }),
  referee_fax: referee("Referee fax (optional)"),
  referee_email: auto("referee", "Referee email"),
  referee_signature: referee("Referee signature", { type: "signature", source: "signing", required: true }),
};
function referee(label: string, extra: Partial<OnboardingField> = {}): OnboardingField { return { doc: "referee", label, type: "text", role: "referee", source: "agent", ...extra }; }

/**
 * The AcroForm field name behind a registry key. Two names exist in both PDFs (agent_abn, agent_signed_date, agent_signature): the
 * form's copies carry a "_form" suffix in the registry so each has its own entry; the value is the same.
 */
export function acroFieldName(key: string): { name: string; option: string | null } {
  const field = AGENT_ONBOARDING_FIELDS[key];
  const base = key.replace(/_(form|referee)$/, "");
  const colon = base.indexOf(":");
  if (colon > 0) {
    const group = base.slice(0, colon), answer = base.slice(colon + 1);
    // A pair of plain check boxes (GST, EATC) is named <group>_yes / <group>_no; a radio group is one field with options.
    return field?.option ? { name: group, option: field.option } : { name: `${group}_${answer.toLowerCase()}`, option: null };
  }
  return { name: base, option: null };
}
/** The registry key of an AcroForm field (and, for a radio group, its option) in one of the two blanks. */
export function registryKey(doc: OnboardingDoc, name: string, option: string | null): string | null {
  for (const [key, field] of Object.entries(AGENT_ONBOARDING_FIELDS)) {
    if (field.doc !== doc) continue;
    const acro = acroFieldName(key);
    if (acro.name === name && (acro.option ?? null) === (option ?? null)) return key;
  }
  return null;
}
/** The value key of a signing field: the group's question for a tick box ("litigation_involved"), the key itself otherwise. */
export const answerKey = (key: string) => key.replace(/_(form|referee)$/, "").replace(/:.*$/, "");
/** A tick box that belongs to a question answered by one of several boxes: "litigation_involved:YES" -> { key, answer }. */
export function groupOf(key: string | null | undefined): { key: string; answer: string } | null {
  const text = String(key ?? "");
  const colon = text.indexOf(":");
  if (colon <= 0) return null;
  return { key: text.slice(0, colon), answer: text.slice(colon + 1) };
}
export const ONBOARDING_KEY = /^[a-z][a-z0-9_]{0,60}(:[A-Z0-9]{1,10})?$/;

/** The questions the agent must answer with Yes or No before signing (the form says so), and the signature. */
export const REQUIRED_GROUPS = ["litigation_involved", "eatc_completed"];

export interface PlacedField { key: string; type: OnboardingField["type"]; role: OnboardingRole; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string; value: string }
/** A widget rectangle in PDF points, from the page's bottom-left, with the page size. */
export interface WidgetBox { name: string; option: string | null; page: number; x: number; y: number; width: number; height: number; pageWidth: number; pageHeight: number }

/**
 * The signing template's fields for one blank: every widget becomes a placed field (fractions of the page from its top-left corner, as
 * hr.sign_fields keeps them), typed and labelled by the registry. A widget the registry does not know is an error (a different PDF).
 */
export function placeTemplateFields(doc: OnboardingDoc, widgets: WidgetBox[]): PlacedField[] {
  const out: PlacedField[] = [];
  const seen = new Set<string>();
  for (const w of widgets) {
    const key = registryKey(doc, w.name, w.option);
    if (!key) throw new Error(`The ${AGENT_ONBOARDING_DOCS[doc].name} PDF has a field the registry does not know: ${w.name}${w.option ? ` (${w.option})` : ""}.`);
    const field = AGENT_ONBOARDING_FIELDS[key];
    seen.add(key);
    const height = Math.abs(w.height), y = w.height < 0 ? w.y - height : w.y;
    const box = { x: round(w.x / w.pageWidth), y: round(1 - (y + height) / w.pageHeight), w: round(Math.max(w.width, 4) / w.pageWidth), h: round(Math.max(height, 4) / w.pageHeight) };
    if (box.x < 0 || box.y < 0 || box.x + box.w > 1.0001 || box.y + box.h > 1.0001) throw new Error(`The field ${w.name} is outside its page.`);
    out.push({ key, type: field.type, role: field.role, page: w.page, ...box, required: field.required === true, label: field.label, value: field.role === "sender" ? `{{${answerKey(key)}}}` : "" });
  }
  const missing = Object.entries(AGENT_ONBOARDING_FIELDS).filter(([key, f]) => f.doc === doc && !seen.has(key)).map(([key]) => key);
  if (missing.length) throw new Error(`The ${AGENT_ONBOARDING_DOCS[doc].name} PDF lacks ${missing.length} expected field${missing.length === 1 ? "" : "s"}: ${missing.slice(0, 6).join(", ")}.`);
  return out;
}
const round = (n: number) => Math.round(n * 10000) / 10000;

export const isPdfDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
/** "17/11/2026" for an ISO date, as Australian forms print it. */
export function printDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
/** "12 345 678 901": an ABN in its printed groups. */
export const printAbn = (abn: string) => { const d = abn.replace(/\D/g, ""); return d.length === 11 ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : abn; };
export const printPercent = (value: string) => { const n = Number(String(value).replace(/[^0-9.]/g, "")); return Number.isFinite(n) && String(value).trim() ? `${n}%` : ""; };
/** Commencement plus the term, the day before the anniversary (two years from 17/11/2026 ends 16/11/2028). */
export function expiryDate(commencement: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(commencement);
  if (!m) return "";
  const end = new Date(Date.UTC(Number(m[1]) + AGREEMENT_TERM_YEARS, Number(m[2]) - 1, Number(m[3])));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

/** What the sender's typed values and the records give, printed as the form shows them. */
export function printedValue(key: string, raw: unknown): string {
  const field = AGENT_ONBOARDING_FIELDS[key];
  const value = typeof raw === "string" ? raw.trim() : raw === true ? "true" : raw === false ? "false" : raw == null ? "" : String(raw);
  if (!value || !field) return value;
  if (field.format === "date" && isPdfDate(value)) return printDate(value);
  if (field.format === "abn") return printAbn(value);
  if (field.format === "percent") return printPercent(value);
  return value;
}

/** The signing fields of a sent request, resolved: what is printed by the sender, what the agent fills. */
export interface ResolvedFields { printed: PlacedField[]; recipient: PlacedField[] }
/**
 * Splits a template's placed fields for one send: a sender field with a value is printed; an auto-or-agent field without a value
 * becomes the agent's field (prefilled with nothing); an admin field without a value is left blank (optional ones: witness).
 */
export function resolveFields(fields: PlacedField[], values: Record<string, string>): ResolvedFields {
  const printed: PlacedField[] = [], recipient: PlacedField[] = [];
  for (const f of fields) {
    const spec = AGENT_ONBOARDING_FIELDS[f.key];
    const key = answerKey(f.key);
    if (f.role !== "sender") {
      const prefill = spec?.type === "text" ? printedValue(f.key, values[key] ?? "") : "";
      recipient.push({ ...f, value: prefill.slice(0, 500) });
      continue;
    }
    const group = groupOf(f.key);
    const answered = group ? (values[group.key] ?? "").trim() : "";
    const value = group ? (answered.toUpperCase() === group.answer ? "true" : "") : printedValue(f.key, values[key] ?? "");
    if (value) printed.push({ ...f, value });
    // The other box of an answered question stays empty; a question with no answer at all is the agent's to tick.
    else if (spec?.autoOrAgent && !answered) recipient.push({ ...f, role: signerRole(spec.doc).key as OnboardingRole, required: spec.required === true, value: "" });
  }
  return { printed, recipient };
}

/** The answers the agent gave (and the printed values), keyed by the form's variable names, from the request's fields. */
export function collectAnswers(fields: Array<{ key?: string | null; type: string; value?: string | null }>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const f of fields) {
    if (!f.key) continue;
    const group = groupOf(f.key);
    if (group) { if (f.value === "true") answers[group.key] = group.answer; continue; }
    if (f.type === "signature" || f.type === "initials") continue;
    const value = String(f.value ?? "").trim();
    if (value) answers[answerKey(f.key)] = value;
  }
  return answers;
}
