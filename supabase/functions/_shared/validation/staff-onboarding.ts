// The staff onboarding wizard's checks, built from the shared person rules (person.ts). The page (/staff/onboard), the
// staff-onboarding Edge Function and the offline tests all call staffProblems(); the database repeats it as hr.v_staff_problem
// (migration 20261112090000) and scripts/lab/staff-lab.mjs `wizard` compares the two on one list of inputs.
import {
  addressProblems, dateOfBirthProblem, emergencyContactProblems, mobileProblem, nameProblem, normalizePassportNumber, parseDateOfBirth,
  passportNumberProblem, phoneProblem, shortTextProblem, isAustralia, type Address,
} from "./person.ts";
import { normalizeAbn, validateAbn } from "./abn.ts";

/**
 * The wizard's fields, in the order problems are reported. Keys are the names the save action takes.
 * Tax and super (2026-11-10, owner's option A): only the super choice and the non-secret declaration answers are kept here;
 * the tax file number is never asked for or stored (the person gives it through Xero, the payroll system).
 */
export const STAFF_FIELDS = [
  "is_australian_citizen", "first_name", "middle_name", "last_name", "date_of_birth", "phone",
  "address_street", "address_line2", "address_suburb", "address_country", "address_state", "address_postcode",
  "emergency_name", "emergency_phone", "emergency_relationship", "nationality", "passport_number", "visa_subclass", "visa_conditions",
  "tax_residency", "tax_free_threshold", "study_loan", "super_choice", "super_fund_name", "super_fund_abn", "super_usi", "super_member_number",
] as const;
/** Residency for tax purposes (the ATO's three answers); yes / no answers; how super is paid. The database repeats these lists. */
export const TAX_RESIDENCY = ["resident", "foreign", "whm"] as const;
export const YES_NO = ["yes", "no"] as const;
export const SUPER_CHOICE = ["default", "own", "smsf"] as const;
export const TAX_RESIDENCY_LABEL: Record<(typeof TAX_RESIDENCY)[number], string> = { resident: "Australian resident for tax purposes", foreign: "Foreign resident", whm: "Working holiday maker" };
export const SUPER_CHOICE_LABEL: Record<(typeof SUPER_CHOICE)[number], string> = { default: "Skyline's default super fund", own: "My own super fund", smsf: "Self-managed super fund (SMSF)" };
/** A fund of the person's own needs its details; the member number only for an APRA fund (an SMSF has none). */
export const superFundNeeded = (choice: string) => choice === "own" || choice === "smsf";
export type StaffField = (typeof STAFF_FIELDS)[number];
export type StaffTextField = Exclude<StaffField, "is_australian_citizen">;
export type StaffDetails = Record<StaffTextField, string> & { is_australian_citizen: boolean | null };
export interface StaffProblem { field: StaffField; message: string }

export const EMPTY_STAFF_DETAILS: StaffDetails = {
  is_australian_citizen: null, first_name: "", middle_name: "", last_name: "", date_of_birth: "", phone: "",
  address_street: "", address_line2: "", address_suburb: "", address_country: "", address_state: "", address_postcode: "",
  emergency_name: "", emergency_phone: "", emergency_relationship: "", nationality: "", passport_number: "", visa_subclass: "", visa_conditions: "",
  tax_residency: "", tax_free_threshold: "", study_loan: "", super_choice: "", super_fund_name: "", super_fund_abn: "", super_usi: "", super_member_number: "",
};

const ADDRESS_KEY: Record<string, keyof Address> = {
  address_street: "street", address_line2: "line2", address_suburb: "suburb", address_country: "country", address_state: "state", address_postcode: "postcode",
};
const text = (details: StaffDetails, field: StaffTextField) => String(details[field] ?? "").trim();

/**
 * What is wrong with ONE field, or "". `final` false is a draft (blank is fine, what is typed must be valid); true is the check
 * before Submit (everything needed must be there). The address and the visa fields look at the country and the citizenship answer.
 */
export function staffFieldProblem(field: StaffField, details: StaffDetails, final: boolean, today: Date = new Date()): string {
  if (field === "is_australian_citizen") return final && typeof details.is_australian_citizen !== "boolean" ? "Tell us whether you are an Australian citizen." : "";
  const value = text(details, field);
  const blankOk = !final && !value;
  switch (field) {
    case "first_name": case "last_name": return blankOk ? "" : nameProblem(value, field.replace("_", " "));
    case "middle_name": return value ? nameProblem(value, "middle name") : "";
    case "date_of_birth": return blankOk ? "" : dateOfBirthProblem(value, today);
    case "phone": return mobileProblem(value);
    case "address_street": case "address_line2": case "address_suburb": case "address_country": case "address_state": case "address_postcode": {
      const key = ADDRESS_KEY[field];
      const problem = addressProblems({
        street: details.address_street, line2: details.address_line2, suburb: details.address_suburb, state: details.address_state,
        postcode: details.address_postcode, country: details.address_country,
      })[key] ?? "";
      return blankOk ? "" : problem;
    }
    case "emergency_name": case "emergency_phone": case "emergency_relationship": {
      if (blankOk) return "";
      const problems = emergencyContactProblems({ name: details.emergency_name, phone: details.emergency_phone, relationship: details.emergency_relationship }, "you");
      return (field === "emergency_name" ? problems.name : field === "emergency_phone" ? problems.phone : problems.relationship) ?? "";
    }
    case "nationality": return !value ? (final ? "Enter your nationality." : "") : shortTextProblem(value, "The nationality", 100);
    case "passport_number": return !value ? (final ? "Enter your passport number." : "") : passportNumberProblem(value);
    case "visa_subclass":
      return !value ? (final && details.is_australian_citizen === false ? "Enter your visa type or subclass." : "") : shortTextProblem(value, "The visa type or subclass", 100);
    case "visa_conditions": return shortTextProblem(value, "The visa work conditions", 500);
    // Tax and super: the answers of the ATO declarations, never the tax file number.
    case "tax_residency": return !value ? (final ? "Tell us your residency status for tax purposes." : "") : (TAX_RESIDENCY as readonly string[]).includes(value) ? "" : "Choose your residency status for tax purposes.";
    case "tax_free_threshold":
      if (!value) return final && text(details, "tax_residency") === "resident" ? "Tell us whether you claim the tax-free threshold." : "";
      return (YES_NO as readonly string[]).includes(value) ? "" : "Answer yes or no for the tax-free threshold.";
    case "study_loan": return !value ? (final ? "Tell us whether you have a study or training support loan." : "") : (YES_NO as readonly string[]).includes(value) ? "" : "Answer yes or no for the study or training support loan.";
    case "super_choice": return !value ? (final ? "Choose how your super is paid." : "") : (SUPER_CHOICE as readonly string[]).includes(value) ? "" : "Choose how your super is paid.";
    case "super_fund_name": return !value ? (final && superFundNeeded(text(details, "super_choice")) ? "Enter the name of your super fund." : "") : shortTextProblem(value, "The super fund name", 100);
    case "super_fund_abn": return !value ? (final && superFundNeeded(text(details, "super_choice")) ? "Enter the fund's ABN." : "") : validateAbn(value);
    case "super_usi": return !value ? "" : /^[A-Za-z0-9]{1,20}$/.test(value) ? "" : "The USI must be up to 20 letters and numbers.";
    case "super_member_number": return !value ? (final && text(details, "super_choice") === "own" ? "Enter your member number." : "") : /^[A-Za-z0-9 -]{1,30}$/.test(value) ? "" : "The member number must be up to 30 letters, numbers, spaces or hyphens.";
  }
}

/** Every problem among `fields`, in wizard order. The first one is what the server answers with. */
export function staffProblems(details: StaffDetails, fields: readonly StaffField[], final: boolean, today: Date = new Date()): StaffProblem[] {
  const out: StaffProblem[] = [];
  for (const field of STAFF_FIELDS) {
    if (!fields.includes(field)) continue;
    const message = staffFieldProblem(field, details, final, today);
    if (message) out.push({ field, message });
  }
  return out;
}

/** A field's value as it is stored: trimmed; the date of birth as YYYY-MM-DD; an Australian state and the passport number in capitals. */
export function normalizeStaffField(field: StaffTextField, details: StaffDetails, today: Date = new Date()): string {
  const value = text(details, field);
  if (field === "date_of_birth") return value ? parseDateOfBirth(value, today) ?? value : "";
  if (field === "address_state") return isAustralia(details.address_country) ? value.toUpperCase() : value;
  if (field === "passport_number") return normalizePassportNumber(value);
  if (field === "super_fund_abn") return normalizeAbn(value);
  if (field === "super_usi") return value.toUpperCase();
  return value;
}

/** The staff wizard's steps and the fields each one owns (Continue checks these as final). */
export const STAFF_STEP_FIELDS = {
  documents: ["is_australian_citizen"],
  prefill: ["first_name", "middle_name", "last_name", "date_of_birth", "nationality", "passport_number", "visa_subclass", "visa_conditions"],
  personal: ["phone", "address_street", "address_line2", "address_suburb", "address_country", "address_state", "address_postcode", "emergency_name", "emergency_phone", "emergency_relationship"],
  tax: ["tax_residency", "tax_free_threshold", "study_loan", "super_choice", "super_fund_name", "super_fund_abn", "super_usi", "super_member_number"],
} as const satisfies Record<string, readonly StaffField[]>;

export { phoneProblem };
