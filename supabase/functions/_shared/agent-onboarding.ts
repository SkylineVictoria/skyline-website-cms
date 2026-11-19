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
  /** Never prefilled from our records or ABN Lookup: the signer types it (Business/MARA/Registration number). */
  noPrefill?: boolean;
  /** An ABN, a date, a percentage: how the typed value is shown. */
  format?: "abn" | "date" | "percent";
}

export interface OnboardingDocument { key: "agent_application_form" | "agent_agreement" | "agent_referee_check_form"; name: string; title: string; sha256: string; pages: number; category: string; file: string }
/** The two blanks, with the checksum of the files in public/templates: a different file is refused by the installer. */
export const AGENT_ONBOARDING_DOCS: Record<OnboardingDoc, OnboardingDocument> = {
  form: { key: "agent_application_form", name: "Agent Application Form", title: "Agent Application Form (F04)", sha256: "c247efe3e877df9b8f4ff90d4abac9b8938d22a7cdf0112d0b0c621d9cf74a83", pages: 2, category: "other", file: "agent_application_form_template_blank.pdf" },
  agreement: { key: "agent_agreement", name: "Agent Agreement", title: "Education Agent Agreement (P06)", sha256: "5ca5213f8d2e95766f7eb8df51d5f408c203ce2270bd441b3e93c08561bc9f88", pages: 13, category: "agency_agreement", file: "agent_agreement_template_blank.pdf" },
  referee: { key: "agent_referee_check_form", name: "Agent Referee Check Form", title: "Agent Referee Check Form (F05)", sha256: "afd78833c524411c1c4544e3bd19025bd5f974c941a5b8658862ce71a64377a1", pages: 1, category: "other", file: "agent_referee_check_form_template_blank.pdf" },
};
/** The agreement runs for two years from its commencement (Item 5). */
export const AGREEMENT_TERM_YEARS = 2;
// The signer of the F04 and the P06 is the business's point of contact (2026-11-19); the role key stays "agent" (stored on requests and templates).
export const ONBOARDING_SIGNER_ROLE = { key: "agent", label: "Business contact", order: 1, required: true };
export const REFEREE_SIGNER_ROLE = { key: "referee", label: "Referee", order: 1, required: true };
/** The one signer of each document: the agent (application form, agreement) or the referee (referee check). */
export const signerRole = (doc: OnboardingDoc) => doc === "referee" ? REFEREE_SIGNER_ROLE : ONBOARDING_SIGNER_ROLE;
/** The onboarding runs in stages (2026-11-17): the form, then a referee check per reference, then the agreement. */
export const ONBOARDING_STAGES = ["application_sent", "application_signed", "references_pending", "references_received", "references_approved", "agreement_sent", "agreement_signed"] as const;
export type OnboardingStage = typeof ONBOARDING_STAGES[number] | "draft" | "legacy" | "cancelled" | "expired" | "declined" | "activated" | "correction_requested" | "resubmitted";
export const STAGE_LABEL: Record<OnboardingStage, string> = {
  draft: "Not sent yet (pre-fill)", legacy: "Sent as one document", application_sent: "Application form sent", application_signed: "Application form signed", references_pending: "Waiting for referees",
  references_received: "References received: review", references_approved: "References approved", agreement_sent: "Agreement sent", agreement_signed: "Agreement signed",
  cancelled: "Cancelled", expired: "Expired", declined: "Declined", activated: "Business activated",
  correction_requested: "Correction requested", resubmitted: "Resubmitted",
};
/** The business status in words (2026-11-18), as agency_onboarding_label gives it. */
export const BUSINESS_STATUS_FLOW = ["Application sent", "Awaiting referees", "Ready for review", "Correction requested", "Resubmitted", "Active"] as const;

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
  // Witness signatures are drawn, never typed (2026-11-20): a PNG printed as a picture.
  admin_witness_signature: admin("agreement", "SLIT witness signature (drawn)", { type: "signature" }),
  agent_signatory_name: agent("agreement", "Agent signatory name", { required: true }),
  agent_signatory_position: agent("agreement", "Agent signatory position", { required: true }),
  agent_signature: agent("agreement", "Agent signature", { type: "signature", source: "signing", required: true }),
  agent_signed_date: agent("agreement", "Agent signed date", { type: "date", source: "signing" }),
  agent_witness_name: agent("agreement", "Agent witness name"),
  // Never a field the signer types into: staff draw it before sending, or the agency admin's witness draws it on the signing page (stamped by document-signing).
  agent_witness_signature: agent("agreement", "Agent witness signature (drawn)"),
  // ------------------------------------------------------------- Agent Application Form (F04), page 1: the agency
  agent_agency_name: autoOrAgent("form", "Agency name", { required: true }),
  agent_legal_entity: autoOrAgent("form", "Legal entity"),
  agent_trading_name: autoOrAgent("form", "Trading name"),
  // The form's "Business/Mara/Registration Number" box: never prefilled as such; the F04 wizard (2026-11-19) asks for the ACN (prefilled from
  // ABN Lookup) and the MARN, and the sign step prints "ACN 603 584 676 / MARN 1234567" here (composeRegistrationNumber).
  agent_registration_number: agent("form", "Business/MARA/Registration number", { noPrefill: true }),
  "agent_gst_registered:YES": { doc: "form", label: "GST registered: Yes", type: "checkbox", role: "sender", source: "auto", autoOrAgent: true, group: { key: "agent_gst_registered", answer: "YES" } },
  "agent_gst_registered:NO": { doc: "form", label: "GST registered: No", type: "checkbox", role: "sender", source: "auto", autoOrAgent: true, group: { key: "agent_gst_registered", answer: "NO" } },
  agent_abn_form: autoOrAgent("form", "ABN", { format: "abn", required: true }),
  // One of F04_TITLES (_shared/validation/abr.ts): a list on the signing page, checked again by the sign step.
  contact_title: autoOrAgent("form", "Title (Mr, Mrs, Ms, Miss, Dr, Other)"),
  contact_given_name: autoOrAgent("form", "Contact given name", { required: true }),
  contact_family_name: autoOrAgent("form", "Contact family name", { required: true }),
  contact_position: autoOrAgent("form", "Contact position", { required: true }),
  contact_email: autoOrAgent("form", "Contact email", { required: true }),
  contact_phone: autoOrAgent("form", "Contact phone", { required: true }),
  agent_website: autoOrAgent("form", "Website"),
  agent_fax: autoOrAgent("form", "Fax"),
  office_street_address: autoOrAgent("form", "Office street address", { required: true }),
  office_suburb: autoOrAgent("form", "Suburb and postcode"),
  office_state: autoOrAgent("form", "State"),
  // No postcode box on the form: an Australian postcode is printed in the Suburb box (composeSuburb); Province is an overseas region only.
  office_province: autoOrAgent("form", "Province (outside Australia)"),
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
/** Business Rules agents.onboarding_required_answer_groups names these questions; one left out of the list may stay unanswered. */
export const REQUIRED_GROUP_LABELS: Readonly<Record<string, string>> = { litigation_involved: "Litigation involved", eatc_completed: "EATC completed" };
/** The question keys SLIT made optional, from the rule's list of labels (none when the list holds every label). */
export function optionalAnswerGroups(requiredLabels: readonly string[]): Set<string> {
  return new Set(REQUIRED_GROUPS.filter((key) => !requiredLabels.includes(REQUIRED_GROUP_LABELS[key])));
}
/** A signing field list with the tick boxes of optional questions no longer required. */
export function relaxAnswerGroups<T extends { key?: string | null; required: boolean }>(fields: T[], optional: ReadonlySet<string>): T[] {
  if (!optional.size) return fields;
  return fields.map((f) => { const g = groupOf(f.key); return g && optional.has(g.key) ? { ...f, required: false } : f; });
}
/** Business Rules agents.agent_application_yes_no_fallback: the first choice (No) is what the form always did. */
export const YES_NO_FALLBACKS = ["No", "Leave blank (the agent answers)"] as const;

/**
 * F04 wizard (2026-11-19): the declaration statements of the form's page 2, each its own required tick box on the wizard's last step and
 * checked again by the sign step (document-signing core.ts). Kept with the signed answers (agency_onboarding.answers.declarations).
 */
export const F04_DECLARATIONS: ReadonlyArray<{ key: string; text: string; link?: { href: string; label: string } }> = [
  { key: "dha_policies", text: "I will regularly monitor policies and changes to the policies as reported on the Department of Home Affairs (DHA) website." },
  { key: "education_policies", text: "I will regularly monitor policies and regulations, and changes to these policies and regulations, as reported on the www.education.gov.au website." },
  { key: "national_code", text: "I have read the National Code 2018 and agree to adhere to the relevant Standards." },
  { key: "conflicts_of_interest", text: "I declare that I take all reasonable steps to avoid conflicts of interest with my duties as an education agent of SLIT (for example: charging service fees to both overseas students and SLIT for the same service; a financial interest in SLIT; or an employee having a personal relationship with an employee of SLIT), and I will disclose any conflict of interest to SLIT." },
  { key: "code_of_ethics", text: "I declare that I have read the Australian International Education and Training Agent Code of Ethics.",
    link: { href: "https://internationaleducation.gov.au/News/Latest-News/Documents/Australian%20International%20Education%20and%20Training%20-%20Agent%20Code%20of%20Ethics.pdf", label: "Agent Code of Ethics (PDF)" } },
];
/** The opening statement of the declaration, printed above the tick boxes. */
export const F04_DECLARATION_INTRO = "I am interested in representing Skyline Institute Pty Ltd as an education agent and I agree to do so in an honest and professional manner. I agree to:";

/** "603584676" / "1234567" -> "ACN 603 584 676 / MARN 1234567", or whichever is present: what the F04's registration box prints. */
export function composeRegistrationNumber(acn: string | null | undefined, marn: string | null | undefined): string {
  const a = String(acn ?? "").replace(/\D/g, ""), m = String(marn ?? "").replace(/\s/g, "");
  const parts = [a ? `ACN ${a.length === 9 ? `${a.slice(0, 3)} ${a.slice(3, 6)} ${a.slice(6)}` : a}` : "", m ? `MARN ${m}` : ""].filter(Boolean);
  return parts.join(" / ");
}
/** The F04 wizard's position chips (contact position and the declarant's role); anything else is typed after "Other". */
export const F04_POSITIONS = ["CEO", "Director", "Manager", "Owner"] as const;

/** The OMARA public register search (staff check a MARN by hand; no automated lookup). */
export const OMARA_REGISTER_URL = "https://portal.mara.gov.au/search-the-register-of-migration-agents/";

/*
 * The office address (2026-11-19, prefill fix): the F04 row is Street / Suburb / State / Province / Country and has no postcode box. An
 * Australian postcode is printed in the Suburb box after the suburb ("Footscray 3011"); Province is only an overseas region and never holds
 * a postcode (requests sent before the fix put the ABR postcode there).
 */
const POSTCODE = /^\d{4}$/;
/** "Footscray" + "3011" -> "Footscray 3011"; either alone as it is. */
export function composeSuburb(suburb: string | null | undefined, postcode: string | null | undefined): string {
  const s = String(suburb ?? "").trim(), p = String(postcode ?? "").trim();
  if (!p) return s;
  return s.endsWith(` ${p}`) || s === p ? s : [s, p].filter(Boolean).join(" ");
}
/** "Footscray 3011" -> { suburb: "Footscray", postcode: "3011" }; "3011" -> postcode only; anything else is the suburb. */
export function splitSuburb(text: string | null | undefined): { suburb: string; postcode: string } {
  const t = String(text ?? "").trim();
  if (POSTCODE.test(t)) return { suburb: "", postcode: t };
  const m = /^(.*\S)\s+(\d{4})$/.exec(t);
  return m ? { suburb: m[1], postcode: m[2] } : { suburb: t, postcode: "" };
}
/** True when the Suburb box holds a postcode and no suburb name ("3000"). */
export const isPostcodeOnly = (text: string | null | undefined) => POSTCODE.test(String(text ?? "").trim());
/**
 * The office row as the form prints it (round 3, 2026-11-19): a postcode found in the Province box moves next to a named suburb; the Suburb
 * box never holds a postcode alone (no suburb name known: it stays blank and the address search fills suburb, state and postcode).
 */
export function normalizeOfficeAddress<T extends Record<string, string>>(values: T): T {
  const province = String(values.office_province ?? "").trim();
  let out = values;
  if (POSTCODE.test(province)) out = { ...out, office_province: "", office_suburb: composeSuburb(out.office_suburb, isPostcodeOnly(out.office_suburb) ? "" : province) };
  if ("office_suburb" in out && isPostcodeOnly(out.office_suburb)) out = { ...out, office_suburb: "" };
  return out;
}

/**
 * Filled on open (2026-11-19): when the signing page opens an F04 still waiting for its signature, the blank fields among these get the
 * register's / the business record's value (document-signing, agency_onboarding_prefill_blanks). A value already there is never overwritten.
 */
export const F04_OPEN_PREFILL_KEYS = ["agent_legal_entity", "agent_trading_name", "agent_agency_name", "agent_abn", "agent_gst_registered", "agent_year_founded",
  "contact_title", "contact_given_name", "contact_family_name", "contact_position", "contact_email", "contact_phone", "agent_website",
  "office_street_address", "office_suburb", "office_state", "office_country", "declarant_name", "declarant_role"] as const;
/** The business record's own values the F04 prefill uses besides the register (sign-up, earlier answers kept on the business profile). */
export const F04_RECORD_KEYS = ["contact_title", "contact_position", "agent_website", "office_street_address", "office_suburb", "office_state", "office_country",
  "contact_given_name", "contact_family_name", "contact_email", "contact_phone", "declarant_name", "declarant_role"] as const;

/** The wizard's uploads on the Agency step (the questions "organisational chart" / "business profile" answered Yes). */
export const F04_ATTACHMENTS = { org_chart: "Organisational chart", business_profile: "Business profile or strategic plan" } as const;
export type F04AttachmentKind = keyof typeof F04_ATTACHMENTS;
export const F04_ATTACHMENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const F04_ATTACHMENT_MAX = 5 * 1024 * 1024;

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
export function resolveFields(fields: PlacedField[], values: Record<string, string>, options: { editablePrefill?: boolean } = {}): ResolvedFields {
  const printed: PlacedField[] = [], recipient: PlacedField[] = [];
  for (const f of fields) {
    const spec = AGENT_ONBOARDING_FIELDS[f.key];
    const key = answerKey(f.key);
    // A field the registry gives to the signer is theirs even when an older installed template stored it as the sender's (registration number).
    if (f.role !== "sender" || (spec && spec.role !== "sender")) {
      // A Yes / No tick box comes ticked when we hold the question's answer (every question defaults to No, 2026-11-20: yesNoDefaults).
      const group = spec?.type === "checkbox" ? groupOf(f.key) : null;
      const prefill = group ? ((values[group.key] ?? "").trim().toUpperCase() === group.answer ? "true" : "")
        : spec?.type === "text" && !spec.noPrefill ? printedValue(f.key, values[key] ?? "") : "";
      recipient.push({ ...f, ...(spec ? { role: spec.role === "sender" ? f.role : spec.role, label: spec.label, required: spec.required === true } : {}), value: prefill.slice(0, 500) });
      continue;
    }
    const group = groupOf(f.key);
    const answered = group ? (values[group.key] ?? "").trim() : "";
    // ABN prefill (2026-11-19): every value we hold for an auto-or-agent field is the signer's field, already filled in, so the contact can
    // correct it before signing; a tick box of a question we hold an answer for comes ticked (the other box of the pair stays empty).
    if (options.editablePrefill && spec?.autoOrAgent) {
      const value = group ? (answered.toUpperCase() === group.answer ? "true" : "") : printedValue(f.key, values[key] ?? "").slice(0, 500);
      recipient.push({ ...f, role: signerRole(spec.doc).key as OnboardingRole, required: spec.required === true, value });
      continue;
    }
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

/*
 * Corrections (2026-11-18): staff flag answers of a signed F04 (key -> note) and send it back to the agency admin. A flag is an answer key
 * (agent_trading_name, ref1_email, a Yes / No question's key), "acn" / "marn", or "office_address" for the whole office address. Only flagged
 * answers can change in the correction; the declaration (name, role) is given again with the new signature.
 */
export function correctionFlagged(key: string, flags: Record<string, unknown> | null | undefined): boolean {
  if (!flags) return false;
  if (Object.prototype.hasOwnProperty.call(flags, key)) return true;
  return /^office_/.test(key) && Object.prototype.hasOwnProperty.call(flags, "office_address");
}
export const CORRECTION_ALWAYS_EDITABLE = ["declarant_name", "declarant_role"] as const;

/** The agent's witness on the agreement: a typed name and a DRAWN signature (never a field the signer types a signature into). */
export const WITNESS_NAME_KEY = "agent_witness_name", WITNESS_SIGNATURE_KEY = "agent_witness_signature";
/** The agreement fields the agency admin's one signature fills on the combined request (F04 + P06): their values come from the declaration. */
export const AGREEMENT_FROM_DECLARATION: Readonly<Record<string, "declarant_name" | "declarant_role">> = { agent_signatory_name: "declarant_name", agent_signatory_position: "declarant_role" };

/**
 * Every Yes / No question defaults to No (owner brief 2026-11-20), whatever the template: a question answered by a pair of tick boxes
 * ("<question>:YES" / "<question>:NO") with no answer held gets "NO". Works for any template field pair, not a fixed list.
 */
export function yesNoDefaults<T extends Record<string, string>>(fields: ReadonlyArray<{ key?: string | null }>, values: T): T {
  const options = new Map<string, Set<string>>();
  for (const f of fields) { const g = groupOf(f.key); if (g) options.set(g.key, (options.get(g.key) ?? new Set<string>()).add(g.answer.toUpperCase())); }
  for (const [question, answers] of options) {
    if (answers.has("YES") && answers.has("NO") && !String(values[question] ?? "").trim()) (values as Record<string, string>)[question] = "NO";
  }
  return values;
}
