import type { SigningView } from "@/lib/signingApi";
import { checkApplicationAnswers, phoneE164, printAcn, type AbrFacts } from "../../../supabase/functions/_shared/validation/abr";
import { composeRegistrationNumber, composeSuburb, F04_ATTACHMENTS, F04_DECLARATIONS, splitSuburb, type F04AttachmentKind } from "../../../supabase/functions/_shared/agent-onboarding";

/*
 * The F04 wizard's rules, without React (owner brief 2026-11-19, "fix prefill and make it short"): what the page opens with, the values it
 * signs with and the problems of each of the four steps (Business, Contact, Agency, References & sign). The server repeats every check
 * (document-signing core.ts checkApplicationAnswers / checkApplicationSubmission) before anything is signed.
 */

export type Answers = Record<string, string>;
type Field = SigningView["fields"][number];
/** What "Save and continue later" keeps on the server. office_postcode is the wizard's own key (printed in the Suburb box). */
export interface F04Draft { answers: Answers; acn: string; marn: string; declarations: Record<string, boolean>; step: number }

export const F04_STEPS = [
  { id: "business", short: "Business", icon: "ri-building-line", title: "Your business", text: "Check what the government register says about your business." },
  { id: "contact", short: "Contact", icon: "ri-contacts-line", title: "Contact and office", text: "Who we deal with, and where your office is." },
  { id: "agency", short: "Agency", icon: "ri-briefcase-line", title: "Your agency", text: "A few questions about how you recruit students." },
  { id: "references", short: "References & sign", icon: "ri-quill-pen-line", title: "References and declaration", text: "Two referees, then read, tick and sign." },
] as const;

export const COMPANY_KEYS = ["agent_legal_entity", "agent_trading_name", "agent_agency_name", "agent_abn", "agent_year_founded"] as const;
export const COMPANY_LABEL: Record<string, string> = { agent_legal_entity: "Legal name", agent_trading_name: "Trading name", agent_agency_name: "Agency name", agent_abn: "ABN", agent_year_founded: "Year founded" };
export const QUESTIONS: Array<{ key: string; label: string; attach?: F04AttachmentKind; follow?: { key: string; label: string; required: boolean; long: boolean } }> = [
  { key: "org_chart_attached", label: "Do you have an organisational chart?", attach: "org_chart" },
  { key: "business_profile_attached", label: "Do you have a business profile or strategic plan?", attach: "business_profile" },
  { key: "litigation_involved", label: "Has the company or anyone in it been involved in litigation, arbitration, administrative action or another dispute (past, pending or threatened)?",
    follow: { key: "litigation_details", label: "Details of the litigation or dispute", required: true, long: true } },
  { key: "eatc_completed", label: "Have you or your staff completed the EATC training (PIER Online)?", follow: { key: "eatc_details", label: "Who completed it, and when", required: false, long: false } },
  { key: "works_with_sub_agents", label: "Do you work, or have you worked, with sub-agents?", follow: { key: "sub_agent_names", label: "Names of the sub-agent agencies", required: true, long: false } },
];
export const NUMBERS: Array<[string, string]> = [["agent_years_as_education_agent", "Years as an agent"], ["students_recruited_per_year", "Students a year"], ["number_of_offices", "Offices"],
  ["staff_count", "Staff"], ["slit_recruitment_target", "SLIT target a year"]];
export const SERVICES = ["Course counselling", "Applications and admissions", "Student visa applications", "Pre-departure briefing", "Accommodation", "Airport pickup", "Health cover (OSHC)", "English test preparation"];
export const COUNTRIES = ["Canada", "United Kingdom", "United States", "New Zealand", "Ireland"];
export const REF_PARTS: Array<[string, string, boolean]> = [["contact_name", "Contact name", true], ["organisation", "Organisation", true], ["position", "Position", false], ["email", "Email", true], ["phone", "Phone", true], ["address", "Address", false]];
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;
export const yesNo = (value: string | undefined) => (value ?? "").toUpperCase();
export const isAustralia = (country: string | undefined) => !String(country ?? "").trim() || /^(australia|au)$/i.test(String(country).trim());

/** The value key of a field (agent_abn_form -> agent_abn; a tick box -> its question). */
export const keyOf = (f: Pick<Field, "key">) => String(f.key ?? "").replace(/_(form|referee)$/, "").replace(/:.*$/, "");
const groupOf = (key: string | null | undefined) => { const t = String(key ?? ""); const c = t.indexOf(":"); return c > 0 ? { key: t.slice(0, c), answer: t.slice(c + 1) } : null; };

/** "Course counselling, Other: visa reviews" <-> chips: the known options in their order, anything else is the "Other" text. */
/** other: null when "Other" is not chosen, "" when chosen and not named yet. */
export function readChips(text: string | undefined, options: readonly string[]): { picked: string[]; other: string | null } {
  const tokens = String(text ?? "").split(/\s*[,;\n]\s*/).map((t) => t.trim()).filter(Boolean);
  const picked = options.filter((o) => tokens.some((t) => t.toLowerCase() === o.toLowerCase()));
  const rest = tokens.filter((t) => !options.some((o) => o.toLowerCase() === t.toLowerCase()));
  if (!rest.length) return { picked, other: null };
  return { picked, other: rest.filter((t) => t.toLowerCase() !== "other").join(", ") };
}
/** The chips as the form prints them; "Other" chosen but not named stays as the word Other (the step asks for it). */
export function writeChips(picked: readonly string[], other: string | null, options: readonly string[]): string {
  const known = options.filter((o) => picked.includes(o));
  return [...known, ...(other === null ? [] : [other.trim() || "Other"])].join(", ");
}

/** The answers the page opens with: the fields' values (filled on open by the server), the register's facts, then the saved draft. */
export function initialF04(fields: readonly Field[], facts: Partial<AbrFacts> | null, prefill: Record<string, string> | null, draft: Partial<F04Draft> | null): F04Draft {
  const answers: Answers = {};
  for (const f of fields) {
    if (!f.key) continue;
    const group = groupOf(f.key);
    if (group) { if (f.value === "true") answers[group.key] = group.answer; continue; }
    if (f.type === "text" && f.value) answers[keyOf(f)] = f.value;
  }
  const has = (key: string) => fields.some((f) => keyOf(f) === key);
  const fill = (key: string, value: string | undefined) => { if (value && has(key) && !answers[key]) answers[key] = value; };
  if (facts) {
    fill("agent_legal_entity", facts.entityName); fill("agent_trading_name", facts.entityName); fill("agent_agency_name", facts.entityName);
    fill("agent_year_founded", (facts.statusFrom ?? "").slice(0, 4));
    if (has("agent_gst_registered") && !answers.agent_gst_registered && typeof facts.gstRegistered === "boolean") answers.agent_gst_registered = facts.gstRegistered ? "YES" : "NO";
  }
  // The office: a postcode found in Province (requests sent before 2026-11-19) belongs to the Suburb box; the wizard keeps it apart.
  if (/^\d{4}$/.test((answers.office_province ?? "").trim())) { answers.office_suburb = composeSuburb(answers.office_suburb, answers.office_province.trim()); answers.office_province = ""; }
  const place = splitSuburb(answers.office_suburb);
  answers.office_suburb = place.suburb; answers.office_postcode = place.postcode;
  for (const key of ["contact_phone", "ref1_phone", "ref2_phone"]) { const e164 = phoneE164(answers[key]); if (e164) answers[key] = e164; }
  // The registration box is composed from the ACN and the MARN; a value typed there earlier is not shown again. Fax is no longer asked.
  delete answers.agent_registration_number;
  const acn = prefill?.agent_acn || (facts?.acn ? printAcn(facts.acn) : "");
  const base: F04Draft = { answers, acn: acn ? printAcn(acn) : "", marn: "", declarations: {}, step: 0 };
  if (!draft) return base;
  return { answers: { ...answers, ...(draft.answers ?? {}) }, acn: draft.acn || base.acn, marn: draft.marn ?? "", declarations: { ...(draft.declarations ?? {}) },
    step: Math.min(Math.max(Number(draft.step) || 0, 0), F04_STEPS.length - 1) };
}

/** The signing values (by field id): text by key (the Suburb box with its postcode, the registration box from ACN + MARN), a tick box "true" when chosen. */
export function f04Values(fields: readonly Field[], state: F04Draft): Record<string, string> {
  const values: Record<string, string> = {};
  const a = state.answers;
  for (const f of fields) {
    if (!f.key) continue;
    const group = groupOf(f.key);
    if (group) { values[f.id] = yesNo(a[group.key]) === group.answer ? "true" : "false"; continue; }
    if (f.type !== "text") continue;
    const key = keyOf(f);
    values[f.id] = key === "agent_registration_number" ? composeRegistrationNumber(state.acn, state.marn)
      : key === "office_suburb" ? composeSuburb(a.office_suburb, a.office_postcode)
      : key === "office_province" ? (/^\d{4}$/.test((a.office_province ?? "").trim()) ? "" : (a.office_province ?? "").trim())
      : (a[key] ?? "").trim();
  }
  return values;
}

/** The problems of one step (key -> message). Required fields come from the form's own fields; follow-ups only when their answer is Yes. */
export function f04Problems(step: number, fields: readonly Field[], state: F04Draft, attachments: Partial<Record<F04AttachmentKind, unknown>> = {}): Record<string, string> {
  const p: Record<string, string> = {};
  const a = state.answers;
  const field = (key: string) => fields.some((f) => keyOf(f) === key);
  const required = (key: string) => fields.some((f) => keyOf(f) === key && f.required);
  const blank = (key: string) => !(a[key] ?? "").trim();
  const need = (key: string, message: string) => { if (field(key) && required(key) && blank(key)) p[key] = message; };
  const digits = (key: string, label: string) => { if (!blank(key) && !/^\d{1,6}$/.test(a[key].trim())) p[key] = `${label}: a number.`; };
  if (step === 0) {
    for (const key of COMPANY_KEYS) need(key, `Enter the ${COMPANY_LABEL[key].toLowerCase()}.`);
    if (!blank("agent_abn") && a.agent_abn.replace(/\s/g, "").length !== 11) p.agent_abn = "The ABN has 11 digits.";
    if (state.acn.trim() && !/^\d{9}$/.test(state.acn.replace(/\s/g, ""))) p.acn = "The ACN has 9 digits.";
    if (state.marn.trim() && !/^\d{1,10}$/.test(state.marn.replace(/\s/g, ""))) p.marn = "The MARN is a number: digits only.";
    if (!blank("agent_year_founded") && !/^\d{4}$/.test(a.agent_year_founded.trim())) p.agent_year_founded = "Enter the year as four digits, for example 2015.";
  }
  if (step === 1) {
    for (const [key, label] of [["contact_given_name", "given name"], ["contact_family_name", "family name"], ["contact_position", "position"], ["contact_email", "email"]] as const) need(key, `Enter the contact's ${label}.`);
    if (field("contact_phone") && blank("contact_phone")) p.contact_phone = "Enter the contact's phone with its country code.";
    else if (!blank("contact_phone") && !phoneE164(a.contact_phone)) p.contact_phone = "Enter a full phone number with its country code.";
    if (!blank("contact_email") && !EMAIL.test(a.contact_email.trim())) p.contact_email = "Enter a valid email address.";
    const title = checkApplicationAnswers({ contact_title: a.contact_title ?? "" });
    if (title.error) p.contact_title = title.error;
    need("office_street_address", "Enter the office street address."); need("office_country", "Enter the country.");
    if (isAustralia(a.office_country) && !blank("office_postcode") && !/^\d{4}$/.test(a.office_postcode.trim())) p.office_postcode = "An Australian postcode has 4 digits.";
  }
  if (step === 2) {
    for (const q of QUESTIONS) {
      const asked = fields.some((f) => groupOf(f.key)?.key === q.key);
      if (!asked) continue;
      if (fields.some((f) => groupOf(f.key)?.key === q.key && f.required) && !["YES", "NO"].includes(yesNo(a[q.key]))) p[q.key] = "Choose Yes or No.";
      if (yesNo(a[q.key]) !== "YES") continue;
      if (q.follow?.required && field(q.follow.key) && blank(q.follow.key)) p[q.follow.key] = `Enter the ${q.follow.label.toLowerCase()}.`;
      if (q.attach && !attachments[q.attach]) p[`attach_${q.attach}`] = `Upload the ${F04_ATTACHMENTS[q.attach].toLowerCase()}, or answer No.`;
    }
    for (const [key, label] of NUMBERS) digits(key, label);
    if (/(^|,\s*)Other$/.test((a.services_provided ?? "").trim())) p.services_provided = "Name the other services.";
    if (/(^|,\s*)Other$/.test((a.other_countries_recruited ?? "").trim())) p.other_countries_recruited = "Name the other countries.";
  }
  if (step === 3) {
    for (const n of [1, 2]) {
      for (const [part, label, must] of REF_PARTS) if (must && field(`ref${n}_${part}`) && blank(`ref${n}_${part}`)) p[`ref${n}_${part}`] = `Enter reference ${n}'s ${label.toLowerCase()}.`;
      if (!blank(`ref${n}_email`) && !EMAIL.test(a[`ref${n}_email`].trim())) p[`ref${n}_email`] = "Enter a valid email address.";
      if (!blank(`ref${n}_phone`) && !phoneE164(a[`ref${n}_phone`])) p[`ref${n}_phone`] = "Enter a full phone number with its country code.";
    }
    if (!Object.keys(p).length) {
      const checked = checkApplicationAnswers({ ...a });
      if (checked.error) {
        const which = /reference 1/i.test(checked.error) ? "ref1" : "ref2";
        p[/phone/i.test(checked.error) ? `${which}_phone` : /name/i.test(checked.error) ? `${which}_contact_name` : `${which}_email`] = checked.error;
      }
    }
    for (const d of F04_DECLARATIONS) if (state.declarations[d.key] !== true) p[`declaration_${d.key}`] = "Tick this statement to continue.";
    need("declarant_name", "Enter your full name."); need("declarant_role", "Enter your role.");
    if ((a.declarant_name ?? "").trim().length < 2) p.declarant_name = "Enter your full name.";
  }
  return p;
}
