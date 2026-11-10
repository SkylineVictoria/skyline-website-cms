// The staff onboarding wizard's checks, built from the shared person rules (person.ts). The page (/staff/onboard), the
// staff-onboarding Edge Function and the offline tests all call staffProblems(); the database repeats it as hr.v_staff_problem
// (migration 20261112090000) and scripts/lab/staff-lab.mjs `wizard` compares the two on one list of inputs.
import {
  addressProblems, dateOfBirthProblem, emergencyContactProblems, mobileProblem, nameProblem, normalizePassportNumber, parseDateOfBirth,
  passportNumberProblem, phoneProblem, shortTextProblem, isAustralia, type Address,
} from "./person.ts";

/** The wizard's fields, in the order problems are reported. Keys are the names the save action takes. */
export const STAFF_FIELDS = [
  "is_australian_citizen", "first_name", "middle_name", "last_name", "date_of_birth", "phone",
  "address_street", "address_line2", "address_suburb", "address_country", "address_state", "address_postcode",
  "emergency_name", "emergency_phone", "emergency_relationship", "nationality", "passport_number", "visa_subclass", "visa_conditions",
] as const;
export type StaffField = (typeof STAFF_FIELDS)[number];
export type StaffTextField = Exclude<StaffField, "is_australian_citizen">;
export type StaffDetails = Record<StaffTextField, string> & { is_australian_citizen: boolean | null };
export interface StaffProblem { field: StaffField; message: string }

export const EMPTY_STAFF_DETAILS: StaffDetails = {
  is_australian_citizen: null, first_name: "", middle_name: "", last_name: "", date_of_birth: "", phone: "",
  address_street: "", address_line2: "", address_suburb: "", address_country: "", address_state: "", address_postcode: "",
  emergency_name: "", emergency_phone: "", emergency_relationship: "", nationality: "", passport_number: "", visa_subclass: "", visa_conditions: "",
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
  return value;
}

/** The staff wizard's steps and the fields each one owns (Continue checks these as final). */
export const STAFF_STEP_FIELDS = {
  documents: ["is_australian_citizen"],
  prefill: ["first_name", "middle_name", "last_name", "date_of_birth", "nationality", "passport_number", "visa_subclass", "visa_conditions"],
  personal: ["phone", "address_street", "address_line2", "address_suburb", "address_country", "address_state", "address_postcode", "emergency_name", "emergency_phone", "emergency_relationship"],
} as const satisfies Record<string, readonly StaffField[]>;

export { phoneProblem };
