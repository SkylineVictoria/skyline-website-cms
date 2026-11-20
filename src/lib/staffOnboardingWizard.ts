// The staff onboarding wizard's logic, pure and browser-free so it is tested offline (scripts/test-staff-registration.ts):
// the steps, what is still missing (the same list the database checks on Submit), and the "from your passport" notes.
import {
  EMPTY_STAFF_DETAILS, STAFF_FIELDS, STAFF_STEP_FIELDS, SUPER_CHOICE_LABEL, TAX_RESIDENCY_LABEL, staffProblems, superFundNeeded, type StaffDetails, type StaffField,
} from "../../supabase/functions/_shared/validation/staff-onboarding";
import { expiryState, requiredStaffCategories, staffDocNeedsExpiry, todayIso, type StaffDocCategory } from "@/lib/staffStatus";

export type StaffWizardStepId = "documents" | "prefill" | "personal" | "bank" | "tax" | "review";
export interface StaffWizardStep { id: StaffWizardStepId; short: string; icon: string; title: string; subtitle: string }

/** The steps across the top. Tax and super keeps the declaration answers and the super choice only; the tax file number goes through Xero. */
export const STAFF_WIZARD: readonly StaffWizardStep[] = [
  { id: "documents", short: "Documents", icon: "ri-upload-cloud-2-line", title: "Upload your documents", subtitle: "Start here. We read your documents and fill in your details for you." },
  { id: "prefill", short: "Check details", icon: "ri-magic-line", title: "We filled this in for you", subtitle: "Read from your documents. Check each one and correct anything that is wrong." },
  { id: "personal", short: "Personal details", icon: "ri-user-line", title: "Personal details", subtitle: "Only what your documents could not tell us." },
  { id: "bank", short: "Bank details", icon: "ri-bank-line", title: "Bank details", subtitle: "The account your pay goes into." },
  { id: "tax", short: "Tax and super", icon: "ri-government-line", title: "Tax and super", subtitle: "A few answers for payroll. Your tax file number is not collected here." },
  { id: "review", short: "Review and submit", icon: "ri-checkbox-circle-line", title: "Review and submit", subtitle: "Check everything, then send it to us." },
];

export interface WizardDocumentLike {
  id: string; category: string; expiryDate: string | null;
  extractionStatus: "pending" | "processing" | "done" | "no_fields" | "failed" | "unavailable"; extracted: Record<string, string>;
}

/** The document types the reader understands; the others (academic results, health insurance) are never read. */
export const READABLE_CATEGORIES: readonly string[] = ["Passport", "Visa", "English", "Driving Licence"];
export const isBeingRead = (d: WizardDocumentLike): boolean =>
  (d.extractionStatus === "pending" && READABLE_CATEGORIES.includes(d.category)) || d.extractionStatus === "processing";

/** The profile the server sends, as the wizard's fields. */
export function detailsOf(profile: Record<string, unknown>): StaffDetails {
  const text = (key: string) => (typeof profile[key] === "string" ? (profile[key] as string) : "");
  return {
    ...EMPTY_STAFF_DETAILS,
    is_australian_citizen: typeof profile.is_australian_citizen === "boolean" ? profile.is_australian_citizen : null,
    first_name: text("first_name"), middle_name: text("middle_name"), last_name: text("last_name"), date_of_birth: text("date_of_birth"),
    phone: text("phone_e164"), address_street: text("address_street"), address_line2: text("address_line2"), address_suburb: text("address_suburb"),
    address_country: text("address_country"), address_state: text("address_state"), address_postcode: text("address_postcode"),
    emergency_name: text("emergency_name"), emergency_phone: text("emergency_phone_e164"), emergency_relationship: text("emergency_relationship"),
    nationality: text("nationality"), passport_number: text("passport_number"), visa_subclass: text("visa_subclass"), visa_conditions: text("visa_conditions"),
    tax_residency: text("tax_residency"), tax_free_threshold: text("tax_free_threshold"), study_loan: text("study_loan"), super_choice: text("super_choice"),
    super_fund_name: text("super_fund_name"), super_fund_abn: text("super_fund_abn"), super_usi: text("super_usi"), super_member_number: text("super_member_number"),
  };
}

/* ------------------------------------------------------------------ tax and super, as shown back */

const YES_NO_TEXT: Record<string, string> = { yes: "Yes", no: "No" };
/** "51 824 753 556": an ABN as the ABR prints it. */
export const formatAbn = (abn: string): string => abn.replace(/\s/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4");
export type TaxSuperAnswers = Pick<StaffDetails, "tax_residency" | "tax_free_threshold" | "study_loan" | "super_choice" | "super_fund_name" | "super_fund_abn" | "super_usi" | "super_member_number">;
/** The Tax and super answers as label / value pairs (the review card and the Admin's card). The last line says where the tax file number goes. */
export function taxSuperRows(d: TaxSuperAnswers): Array<[string, string]> {
  const label = (map: Record<string, string>, value: string) => map[value] ?? "";
  const rows: Array<[string, string]> = [["Residency for tax", label(TAX_RESIDENCY_LABEL, d.tax_residency)]];
  if (d.tax_residency === "resident") rows.push(["Tax-free threshold", label(YES_NO_TEXT, d.tax_free_threshold)]);
  rows.push(["Study or training loan", label(YES_NO_TEXT, d.study_loan)], ["Super", label(SUPER_CHOICE_LABEL, d.super_choice)]);
  if (superFundNeeded(d.super_choice)) {
    rows.push(["Fund", d.super_fund_name], ["Fund ABN", formatAbn(d.super_fund_abn)]);
    if (d.super_choice === "own") rows.push(["USI", d.super_usi], ["Member number", d.super_member_number]);
  }
  rows.push(["Tax file number", "Given through Xero, not collected here"]);
  return rows;
}

/* ------------------------------------------------------------------ what is still missing (mirrors hr_svc_onboarding_submit) */

export interface WizardProblem { step: StaffWizardStepId; text: string; field?: StaffField; category?: string }

const STEP_OF_FIELD = new Map<StaffField, StaffWizardStepId>(
  (Object.entries(STAFF_STEP_FIELDS) as Array<[StaffWizardStepId, readonly StaffField[]]>).flatMap(([step, fields]) => fields.map((field) => [field, step] as [StaffField, StaffWizardStepId])),
);
const isAddress = (field: StaffField) => field.startsWith("address_");

/**
 * The fields a step shows and checks. The address is typed on Personal details, unless an Australian driving licence gave it:
 * then it sits with the other pre-filled details on Check details (`addressOnPrefill`).
 */
export function stepFields(step: StaffWizardStepId, addressOnPrefill: boolean): StaffField[] {
  if (step === "prefill") return [...STAFF_STEP_FIELDS.prefill, ...(addressOnPrefill ? STAFF_STEP_FIELDS.personal.filter(isAddress) : [])];
  if (step === "personal") return STAFF_STEP_FIELDS.personal.filter((field) => !(addressOnPrefill && isAddress(field)));
  if (step === "tax") return [...STAFF_STEP_FIELDS.tax];
  return step === "documents" ? [...STAFF_STEP_FIELDS.documents] : [];
}

/** True when a read Australian driving licence carries a street address. */
export const licenceGaveAddress = (documents: readonly WizardDocumentLike[]): boolean =>
  documents.some((d) => d.category === "Driving Licence" && d.extractionStatus === "done" && String(d.extracted?.au_street ?? "").trim() !== "");
/** hr.staff_doc_label(): the document type as a sentence names it. */
const expiryLabel = (category: string) => (category === "English" ? "English test result" : category === "Academic" ? "academic results" : category.toLowerCase());
const MISSING_DOCUMENT = (category: StaffDocCategory) => (category === "Passport" ? "A passport is required before you can submit." : `Upload your ${expiryLabel(category)}.`);

/** Missing required documents (step "documents") and missing or passed expiry dates (step "prefill"), in the database's order. */
export function documentProblems(citizen: boolean | null, documents: readonly WizardDocumentLike[], today = todayIso()): WizardProblem[] {
  const out: WizardProblem[] = [];
  for (const category of requiredStaffCategories(citizen)) {
    const mine = documents.filter((d) => d.category === category);
    if (!mine.length) out.push({ step: "documents", text: MISSING_DOCUMENT(category), category });
    else if (mine.some((d) => (!d.expiryDate && staffDocNeedsExpiry(category)) || expiryState(d.expiryDate, today) === "expired")) {
      out.push({ step: "prefill", text: `Enter a current expiry date for your ${expiryLabel(category)}.`, category });
    }
  }
  return out;
}

/** Everything Submit needs, in the order the database checks it: the details, the documents, the bank details. */
export function wizardProblems(details: StaffDetails, documents: readonly WizardDocumentLike[], hasBank: boolean, now: Date = new Date()): WizardProblem[] {
  const addressOnPrefill = licenceGaveAddress(documents);
  const out: WizardProblem[] = staffProblems(details, STAFF_FIELDS, true, now)
    .map((p) => ({ step: addressOnPrefill && isAddress(p.field) ? "prefill" as const : STEP_OF_FIELD.get(p.field) ?? "personal", text: p.message, field: p.field }));
  out.push(...documentProblems(details.is_australian_citizen, documents, todayIso(now)));
  if (!hasBank) out.push({ step: "bank", text: "Enter your bank details." });
  return out;
}

/** True once nothing is outstanding on that step (the pill is then filled and ticked). Review is complete when everything is. */
export function stepComplete(step: StaffWizardStepId, problems: readonly WizardProblem[]): boolean {
  return step === "review" ? problems.length === 0 : !problems.some((p) => p.step === step);
}

/* ------------------------------------------------------------------ "from your passport" */

export type PrefillSource = "Passport" | "Visa" | "Driving Licence";
const SOURCE_NAME: Record<PrefillSource, string> = { Passport: "passport", Visa: "visa", "Driving Licence": "driving licence" };

/** Where each field can come from: the document type and the reader's field(s), first one with a value wins. */
export const PREFILL_SOURCE: Partial<Record<StaffField | "expiry:Passport" | "expiry:Visa", { category: PrefillSource; keys: readonly string[]; date?: boolean }>> = {
  first_name: { category: "Passport", keys: ["first_name"] }, middle_name: { category: "Passport", keys: ["middle_name"] }, last_name: { category: "Passport", keys: ["last_name"] },
  date_of_birth: { category: "Passport", keys: ["dob"], date: true }, nationality: { category: "Passport", keys: ["nationality", "citizenship"] },
  passport_number: { category: "Passport", keys: ["passport_number"] }, "expiry:Passport": { category: "Passport", keys: ["passport_expiry"], date: true },
  visa_subclass: { category: "Visa", keys: ["visa_subclass"] }, "expiry:Visa": { category: "Visa", keys: ["visa_stay_until"], date: true },
  address_street: { category: "Driving Licence", keys: ["au_street"] }, address_line2: { category: "Driving Licence", keys: ["au_line2"] },
  address_suburb: { category: "Driving Licence", keys: ["au_suburb"] }, address_state: { category: "Driving Licence", keys: ["au_state"] },
  address_postcode: { category: "Driving Licence", keys: ["au_zip"] },
};
export type PrefillField = keyof typeof PREFILL_SOURCE & string;

export interface PrefillNote {
  /** reading: the document is still being read. match: the value is the document's. differs: it is not (use `suggestion`).
   *  unread: the document was read but this was not found, and nothing is typed. expired: the document's own date has passed. */
  kind: "reading" | "match" | "differs" | "unread" | "expired";
  text: string;
  /** The document's value, offered as "Use this". */
  suggestion?: string;
}

const squash = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
/** A reader's date as YYYY-MM-DD (it answers ISO dates; D/M/YYYY is understood too). "" when it is not a date. */
export function readerDate(value: string): string {
  const text = String(value ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  return dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : "";
}
const showDate = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };

/**
 * The small note under a pre-filled field: "From your passport", a mismatch to check, something that could not be read, or
 * nothing (the field has no document behind it, or the person typed it and the document does not say otherwise).
 */
export function prefillNote(field: PrefillField, value: string, documents: readonly WizardDocumentLike[], today = todayIso()): PrefillNote | null {
  const source = PREFILL_SOURCE[field];
  if (!source) return null;
  const doc = documents.find((d) => d.category === source.category);
  if (!doc) return null;
  const name = SOURCE_NAME[source.category];
  if (isBeingRead(doc)) return { kind: "reading", text: `Reading your ${name}…` };
  const raw = source.keys.map((key) => String(doc.extracted?.[key] ?? "").trim()).find(Boolean) ?? "";
  const read = source.date ? readerDate(raw) : raw;
  const current = value.trim();
  if (!read) return current ? null : { kind: "unread", text: `We could not read this from your ${name}. Please type it.` };
  if (field.startsWith("expiry:") && read < today) {
    return { kind: "expired", text: `Your ${name} shows ${showDate(read)}, which has passed. Upload a current ${name}, or correct the date if we read it wrongly.` };
  }
  const same = source.date ? read === current : field === "passport_number" ? read.replace(/\s/g, "").toUpperCase() === current.replace(/\s/g, "").toUpperCase() : squash(read) === squash(current);
  if (same) return { kind: "match", text: `From your ${name}` };
  const shown = source.date ? showDate(read) : read;
  return current
    ? { kind: "differs", text: `This does not match your ${name}, which shows "${shown}". Check which is right.`, suggestion: read }
    : { kind: "differs", text: `Your ${name} shows "${shown}".`, suggestion: read };
}
