import { portalSections } from "@/pages/agency/lib/portalSections";

/** WIZARD-FULL (owner, 2026-11-23): shared answers and field lists of the wizard screens that finish the application. */
const FIELDS = new Map(portalSections.flatMap((section) => section.fields).map((field) => [field.name, field]));
export const optionsOf = (name: string): string[] => FIELDS.get(name)?.options ?? [];
export const DECLARATION_TERMS = optionsOf("declaration");
export const CHECKLIST_OPTIONS = optionsOf("checklist");
export const OSHC_SELF_CONFIRM = optionsOf("oshc_self_confirm")[0] ?? "";

/** The fields each new screen saves (used to send the agent back to the right screen when the server finds something missing). */
export const FINISH_SCREEN_FIELDS: Record<string, string[]> = {
  personal: ["title", "first_name", "middle_name", "last_name", "dob", "gender", "email", "confirm_email", "citizenship", "nationality", "birth_country", "place_of_birth", "passport_number", "passport_expiry"],
  address: ["address_type", "au_street", "au_line2", "au_suburb", "au_state", "au_zip", "au_country"],
  identifier: ["atsi", "employment", "secondary_enrolled", "school_level", "prior_ed", "disability"],
  study: ["study_reason", "rpl", "oshc_require", "oshc_start_date", "oshc_self_confirm", "oshc_provider", "oshc_policy_number", "oshc_expiry", "hear_about"],
  declare: ["mobile", "declaration_name", "digital_signature", "declaration_date", "checklist"],
};

/**
 * AVETMISS-UI (2026-11-25): extra answers of the "About the student" screen, kept as strings in the application values and copied
 * to the student's AVETMISS tables when the user may write them (english_proficiency_code: one code; disability_types: codes
 * separated by commas; prior_education: JSON rows { code, recognition, name }). Not in FINISH_SCREEN_FIELDS (not form options).
 */
export const AVETMISS_EXTRA_FIELDS = ["english_proficiency_code", "disability_types", "prior_education"] as const;

export interface FinishSummary {
  name: string;
  course: string;
  intake: string;
  documents: string[];
}


/** AVETMISS-CHECK: the wizard screen holding each field avetmiss_check_answers can flag. */
export const AVETMISS_FIELD_SCREEN: Record<string, string> = {
  gender: "personal", dob: "personal", birth_country: "personal",
  au_zip: "address", au_state: "address",
  language_home: "language", language_other: "language",
  atsi: "identifier", school_level: "identifier", year_completed: "identifier", employment: "identifier", disability: "identifier",
  prior_ed: "identifier", secondary_enrolled: "identifier",
  study_reason: "study",
};
/** AVETMISS-PAGE-CHECK: the wizard field that answers each item of missingInAnswers / missingForSubmit (to show the error under it). */
export function avetmissMissingField(item: string): string {
  const t = item.toLowerCase();
  const pairs: [RegExp, string][] = [[/^name$/, "first_name"], [/date of birth/, "dob"], [/^gender/, "gender"], [/country of birth/, "birth_country"],
    [/english/, "english_proficiency_code"], [/language/, "language_home"], [/aboriginal/, "atsi"], [/year/, "year_completed"],
    [/highest school level/, "school_level"], [/secondary school/, "secondary_enrolled"], [/employment/, "employment"],
    [/disability type/, "disability_types"], [/disability/, "disability"], [/prior qualifications/, "prior_education"], [/prior education/, "prior_ed"],
    [/street/, "au_street"], [/suburb/, "au_suburb"], [/postcode/, "au_zip"], [/state/, "au_state"]];
  return pairs.find(([re]) => re.test(t))?.[1] ?? "";
}
/** The screen that fixes each item of missingForSubmit (public.avetmiss_student_missing). */
export function avetmissMissingScreen(item: string): string {
  const t = item.toLowerCase();
  if (/name|date of birth|gender|country of birth/.test(t)) return "personal";
  if (/language|english/.test(t)) return t.includes("english") ? "identifier" : "language";
  if (/street|suburb|postcode|state/.test(t)) return "address";
  if (/aboriginal|school|employment|disability|prior/.test(t)) return "identifier";
  return "";
}

/**
 * The AVETMISS "year school level completed": 4 digits between 1920 and this year, or blank (owner 2026-11-27). The academic
 * document can give a range ("2005–2009") or a date, which the database refuses; its last year is used, else the year already
 * entered when that one is valid, else blank.
 */
export function avetmissYear(current: unknown, academic?: unknown): string {
  const now = new Date().getFullYear();
  const valid = (y: string) => /^\d{4}$/.test(y) && Number(y) >= 1920 && Number(y) <= now;
  const fromAcademic = (String(academic ?? "").match(/\d{4}/g) ?? []).filter(valid).pop();
  if (fromAcademic) return fromAcademic;
  const entered = String(current ?? "").trim();
  if (valid(entered)) return entered;
  return (entered.match(/\d{4}/g) ?? []).filter(valid).pop() ?? "";
}
