import type { SigningView } from "@/lib/signingApi";
import { abrYearFounded, acnDigits, acnFromAbn, checkApplicationAnswers, phoneE164, type AbrFacts } from "../../../supabase/functions/_shared/validation/abr";
import { AGREEMENT_FROM_DECLARATION, composeRegistrationNumber, composeSuburb, correctionFlagged, F04_ATTACHMENTS, F04_DECLARATIONS, F04_POSITIONS, isPostcodeOnly, splitSuburb, WITNESS_NAME_KEY, yesNoDefaults,
  type F04AttachmentKind } from "../../../supabase/functions/_shared/agent-onboarding";

/*
 * The F04 wizard's rules, without React (owner briefs 2026-11-19 "fix prefill and make it short", and round 3 "less typing, nicer finish"):
 * what the page opens with, the values it signs with and the problems of each of the five steps (Business, Contact, Agency, References,
 * Review & sign). The server repeats every check (document-signing core.ts checkApplicationAnswers / checkApplicationSubmission) before
 * anything is signed.
 */

export type Answers = Record<string, string>;
type Field = SigningView["fields"][number];
/** What "Save and continue later" keeps on the server. office_postcode is the wizard's own key (printed in the Suburb box). acn: digits. */
export interface F04Draft { answers: Answers; acn: string; marn: string; declarations: Record<string, boolean>; step: number }

export const F04_STEPS = [
  { id: "business", short: "Business", icon: "ri-building-line", title: "Your business", text: "Check what the government register says about your business." },
  { id: "contact", short: "Contact", icon: "ri-contacts-line", title: "Contact and office", text: "Who we deal with, and where your office is." },
  { id: "agency", short: "Agency", icon: "ri-briefcase-line", title: "Your agency", text: "A few questions about how you recruit students." },
  { id: "references", short: "References", icon: "ri-team-line", title: "Two references", text: "Two people who know your agency's work." },
  { id: "review", short: "Review & sign", icon: "ri-quill-pen-line", title: "Review and sign", text: "Check your answers, tick the declaration and sign." },
] as const;
export const REVIEW_STEP = F04_STEPS.length - 1;

export const COMPANY_KEYS = ["agent_legal_entity", "agent_trading_name", "agent_agency_name", "agent_abn", "agent_year_founded"] as const;
export const COMPANY_LABEL: Record<string, string> = { agent_legal_entity: "Legal name", agent_trading_name: "Trading name", agent_agency_name: "Agency name", agent_abn: "ABN", agent_year_founded: "Year founded" };
export const QUESTIONS: Array<{ key: string; label: string; short: string; attach?: F04AttachmentKind; follow?: { key: string; label: string; required: boolean; long: boolean } }> = [
  { key: "org_chart_attached", label: "Do you have an organisational chart?", short: "Organisational chart", attach: "org_chart" },
  { key: "business_profile_attached", label: "Do you have a business profile or strategic plan?", short: "Business profile", attach: "business_profile" },
  { key: "litigation_involved", label: "Has the company or anyone in it been involved in litigation, arbitration, administrative action or another dispute (past, pending or threatened)?", short: "Litigation or dispute",
    follow: { key: "litigation_details", label: "Details of the litigation or dispute", required: true, long: true } },
  { key: "eatc_completed", label: "Have you or your staff completed the EATC training (PIER Online)?", short: "EATC training", follow: { key: "eatc_details", label: "Who completed it, and when", required: false, long: false } },
  { key: "works_with_sub_agents", label: "Do you work, or have you worked, with sub-agents?", short: "Sub-agents", follow: { key: "sub_agent_names", label: "Names of the sub-agent agencies", required: true, long: false } },
];
export const NUMBERS: Array<[string, string]> = [["agent_years_as_education_agent", "Years as an agent"], ["students_recruited_per_year", "Students a year"], ["number_of_offices", "Offices"],
  ["staff_count", "Staff"], ["slit_recruitment_target", "SLIT target a year"]];
export const SERVICES = ["Course counselling", "Applications and admissions", "Student visa applications", "Pre-departure briefing", "Accommodation", "Airport pickup", "Health cover (OSHC)", "English test preparation"];
export const COUNTRIES = ["Canada", "United Kingdom", "United States", "New Zealand", "Ireland"];
export const POSITIONS = F04_POSITIONS;
export const REF_PARTS: Array<[string, string, boolean]> = [["contact_name", "Contact name", true], ["organisation", "Organisation", true], ["position", "Position", false], ["email", "Email", true], ["phone", "Phone", true], ["address", "Address", false]];
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;
export const yesNo = (value: string | undefined) => (value ?? "").toUpperCase();
export const isAustralia = (country: string | undefined) => !String(country ?? "").trim() || /^(australia|au)$/i.test(String(country).trim());
export const TRADING_SAME_HINT = "Same as legal name; change if you trade differently";

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

/**
 * One choice of chips (round 3: the contact's position and the declarant's role): CEO / Director / Manager / Owner, or Other with the
 * typed text. The value stored is the chosen label or the typed text; "Other" alone means Other chosen and not named yet.
 */
export function readChoice(value: string | undefined, options: readonly string[]): { picked: string | null; other: string | null } {
  const v = String(value ?? "").trim();
  if (!v) return { picked: null, other: null };
  const known = options.find((o) => o.toLowerCase() === v.toLowerCase());
  if (known) return { picked: known, other: null };
  return { picked: null, other: v.toLowerCase() === "other" ? "" : v };
}
export function writeChoice(picked: string | null, other: string | null): string {
  if (picked) return picked;
  if (other === null) return "";
  return other.trim() ? other : "Other";
}
const choiceUnnamed = (value: string | undefined) => String(value ?? "").trim().toLowerCase() === "other";

/** "I agree to all of the above": every statement ticked, some, or none (the box shows indeterminate for some). */
export function declarationsState(declarations: Record<string, boolean>): "all" | "some" | "none" {
  const n = F04_DECLARATIONS.filter((d) => declarations[d.key] === true).length;
  return n === F04_DECLARATIONS.length ? "all" : n ? "some" : "none";
}
/** Ticks (or unticks) every statement at once. */
export const allDeclarations = (checked: boolean): Record<string, boolean> => Object.fromEntries(F04_DECLARATIONS.map((d) => [d.key, checked]));

/** The year founded from the register's facts when the form has none ("Active from 07 Jan 2015" -> 2015). */
export const yearFromFacts = (facts: Partial<AbrFacts> | null | undefined) => abrYearFounded(facts?.statusFrom, facts?.abnStatus);

/**
 * The answers the page opens with: the fields' values (filled on open by the server), the server's prefill for blanks (also the values an
 * older request has no box for), the register's facts, then the saved draft. A blank in the draft never empties a value the page has
 * (round 3: PURVA TECH's draft held an empty "Year founded" that hid the register's 2015).
 */
export function initialF04(fields: readonly Field[], facts: Partial<AbrFacts> | null, prefill: Record<string, string> | null, draft: Partial<F04Draft> | null, recipientName = "", defaultNo = false): F04Draft {
  const answers: Answers = {};
  for (const f of fields) {
    if (!f.key) continue;
    const group = groupOf(f.key);
    if (group) { if (f.value === "true") answers[group.key] = group.answer; continue; }
    if (f.type === "text" && f.value) answers[keyOf(f)] = f.value;
  }
  const has = (key: string) => fields.some((f) => keyOf(f) === key);
  const blank = (key: string) => !String(answers[key] ?? "").trim();
  for (const [key, value] of Object.entries(prefill ?? {})) if (key !== "agent_acn" && key !== "agent_marn" && String(value ?? "").trim() && blank(key)) answers[key] = String(value).trim();
  const fill = (key: string, value: string | undefined) => { if (value && has(key) && blank(key)) answers[key] = value; };
  if (facts) {
    fill("agent_legal_entity", facts.entityName); fill("agent_trading_name", answers.agent_legal_entity || facts.entityName); fill("agent_agency_name", facts.entityName);
    if (blank("agent_year_founded")) { const year = yearFromFacts(facts); if (year) answers.agent_year_founded = year; }
    if (has("agent_gst_registered") && blank("agent_gst_registered") && typeof facts.gstRegistered === "boolean") answers.agent_gst_registered = facts.gstRegistered ? "YES" : "NO";
  }
  if (blank("agent_trading_name") && !blank("agent_legal_entity")) answers.agent_trading_name = answers.agent_legal_entity;
  // The office: a postcode found in Province (requests sent before 2026-11-19) belongs with the suburb; a postcode alone is no suburb (round 3).
  if (/^\d{4}$/.test((answers.office_province ?? "").trim())) answers.office_province = "";
  const place = isPostcodeOnly(answers.office_suburb) ? { suburb: "", postcode: "" } : splitSuburb(answers.office_suburb);
  answers.office_suburb = place.suburb; answers.office_postcode = place.postcode;
  for (const key of ["contact_phone", "ref1_phone", "ref2_phone"]) { const e164 = phoneE164(answers[key]); if (e164) answers[key] = e164; }
  // The registration box is composed from the ACN and the MARN; a value typed there earlier is not shown again. Fax is no longer asked.
  delete answers.agent_registration_number;
  // No ACN from the register: a company's ACN is the last nine digits of its ABN (check digit verified).
  const acn = acnDigits(prefill?.agent_acn || facts?.acn || acnFromAbn(facts?.abn || answers.agent_abn, facts?.entityType));
  const base: F04Draft = { answers, acn: /^\d{9}$/.test(acn) ? acn : "", marn: String(prefill?.agent_marn ?? "").trim(), declarations: {}, step: 0 };
  const merged: F04Draft = !draft ? base : {
    answers: { ...answers, ...Object.fromEntries(Object.entries(draft.answers ?? {}).filter(([k, v]) => String(v ?? "").trim() || blank(k))) },
    acn: acnDigits(draft.acn) || base.acn, marn: draft.marn ?? "", declarations: { ...(draft.declarations ?? {}) },
    step: Math.min(Math.max(Number(draft.step) || 0, 0), F04_STEPS.length - 1) };
  const m = merged.answers;
  if (isPostcodeOnly(m.office_suburb)) m.office_suburb = "";
  // The declarant is the agency contact unless the contact names someone else (round 3); both stay editable.
  if (!String(m.declarant_name ?? "").trim()) m.declarant_name = [m.contact_given_name, m.contact_family_name].map((v) => String(v ?? "").trim()).filter(Boolean).join(" ") || recipientName.trim();
  if (!String(m.declarant_role ?? "").trim() && String(m.contact_position ?? "").trim()) m.declarant_role = m.contact_position.trim();
  // 2026-11-20: every Yes / No question starts at No (the agency admin and staff before sending; a review shows what was signed).
  if (defaultNo) yesNoDefaults(fields, m);
  return merged;
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
    const suburb = (a.office_suburb ?? "").trim();
    // The combined request (2026-11-20): the agreement's signatory is the declarant; the witness name is typed on the review step.
    const declared = AGREEMENT_FROM_DECLARATION[key];
    values[f.id] = declared ? (a[declared] ?? "").trim() : key === WITNESS_NAME_KEY ? (a[WITNESS_NAME_KEY] ?? "").trim()
      : key === "agent_registration_number" ? composeRegistrationNumber(state.acn, state.marn)
      : key === "office_suburb" ? (suburb && !isPostcodeOnly(suburb) ? composeSuburb(suburb, a.office_postcode) : "")
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
    if (state.acn.trim() && !/^\d{9}$/.test(acnDigits(state.acn))) p.acn = "The ACN has 9 digits.";
    if (state.marn.trim() && !/^\d{1,10}$/.test(state.marn.replace(/\s/g, ""))) p.marn = "The MARN is a number: digits only.";
    if (!blank("agent_year_founded") && !/^\d{4}$/.test(a.agent_year_founded.trim())) p.agent_year_founded = "Enter the year as four digits, for example 2015.";
  }
  if (step === 1) {
    for (const [key, label] of [["contact_given_name", "given name"], ["contact_family_name", "family name"], ["contact_position", "position"], ["contact_email", "email"]] as const) need(key, `Enter the contact's ${label}.`);
    if (!p.contact_position && choiceUnnamed(a.contact_position)) p.contact_position = "Type the position.";
    if (field("contact_phone") && blank("contact_phone")) p.contact_phone = "Enter the contact's phone with its country code.";
    else if (!blank("contact_phone") && !phoneE164(a.contact_phone)) p.contact_phone = "Enter a full phone number with its country code.";
    if (!blank("contact_email") && !EMAIL.test(a.contact_email.trim())) p.contact_email = "Enter a valid email address.";
    const title = checkApplicationAnswers({ contact_title: a.contact_title ?? "" });
    if (title.error) p.contact_title = title.error;
    need("office_street_address", "Enter the office street address."); need("office_country", "Enter the country.");
    if (isAustralia(a.office_country) && !blank("office_postcode") && !/^\d{4}$/.test(a.office_postcode.trim())) p.office_postcode = "An Australian postcode has 4 digits.";
    if (field("office_suburb") && blank("office_suburb") && !blank("office_postcode")) p.office_suburb = "Enter the suburb or city for this postcode.";
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
  }
  if (step === REVIEW_STEP) {
    for (const d of F04_DECLARATIONS) if (state.declarations[d.key] !== true) p[`declaration_${d.key}`] = "Tick this statement to continue.";
    need("declarant_name", "Enter your full name."); need("declarant_role", "Choose your role.");
    if ((a.declarant_name ?? "").trim().length < 2) p.declarant_name = "Enter your full name.";
    if (!blank("declarant_role") && choiceUnnamed(a.declarant_role)) p.declarant_role = "Type your role.";
  }
  return p;
}

/*
 * One wizard, three modes (2026-11-18): "agent" (the agency admin fills in and signs), "admin-review" (SLIT staff edit, flag and approve
 * in the CMS) and "correction" (the agency admin changes only the flagged answers and signs again).
 */
export type F04Mode = "agent" | "admin-review" | "correction" | "admin-prefill";
const STEP_OF_KEY: Array<[RegExp, number]> = [
  [/^(agent_legal_entity|agent_trading_name|agent_agency_name|agent_abn|agent_year_founded|agent_gst_registered|acn|marn)$/, 0],
  [/^(contact_|office_|agent_website$)/, 1],
  [/^ref[12]_/, 3],
];
/** The step a flagged answer is on (anything about the agency itself: step 3, Agency). */
export const stepOfKey = (key: string) => STEP_OF_KEY.find(([re]) => re.test(key))?.[1] ?? 2;
/** The steps shown: every step in agent and admin-review modes; in correction mode only the steps with a flagged answer, then Review & sign. */
export function visibleSteps(mode: F04Mode, flags: Record<string, string> | null | undefined): number[] {
  // The pre-send step (2026-11-20): staff never fill the references; they are the agency admin's.
  if (mode === "admin-prefill") return F04_STEPS.map((_, i) => i).filter((i) => i !== 3);
  if (mode !== "correction") return F04_STEPS.map((_, i) => i);
  const steps = new Set(Object.keys(flags ?? {}).map(stepOfKey));
  return [...F04_STEPS.map((_, i) => i).filter((i) => i !== REVIEW_STEP && steps.has(i)), REVIEW_STEP];
}
/** In correction mode an answer can change only when flagged (the declaration's name and role are given again). */
export const correctionEditable = (key: string, flags: Record<string, string> | null | undefined) =>
  key === "declarant_name" || key === "declarant_role" || correctionFlagged(key, flags);

/** The answers as the server keeps them (agency_onboarding.answers): text by key, a Yes / No question as YES / NO, the ACN and the MARN. */
export function answersOf(fields: readonly Field[], state: F04Draft): Record<string, string> {
  const values = f04Values(fields, state);
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (!f.key) continue;
    const group = groupOf(f.key);
    if (group) { if (values[f.id] === "true") out[group.key] = group.answer; else if (!(group.key in out)) out[group.key] = ""; continue; }
    if (f.type !== "text") continue;
    const key = keyOf(f);
    if (key === "agent_registration_number") continue;
    out[key] = (values[f.id] ?? "").trim();
  }
  out.agent_acn = acnDigits(state.acn);
  out.agent_marn = state.marn.replace(/\s/g, "");
  return out;
}
/** What staff changed since the review opened (key -> new value). */
export function reviewChanges(fields: readonly Field[], opened: F04Draft, now: F04Draft): Record<string, string> {
  const before = answersOf(fields, opened), after = answersOf(fields, now);
  return Object.fromEntries(Object.keys(after).filter((k) => (before[k] ?? "") !== (after[k] ?? "")).map((k) => [k, after[k]]));
}
/** The fields of a reviewed application as the wizard reads them: the form's fields with the current answers as their values. */
export function reviewFields(fields: ReadonlyArray<{ id: string; key: string; type: string; label: string; required: boolean; page: number }>, answers: Record<string, string>): Field[] {
  return fields.map((f) => {
    const group = groupOf(f.key);
    const value = group ? (String(answers[group.key] ?? "").toUpperCase() === group.answer ? "true" : "") : f.type === "text" ? String(answers[keyOf(f)] ?? "") : "";
    return { ...f, value, x: 0, y: 0, w: 0, h: 0 } as unknown as Field;
  });
}
