// One set of rules for a person's details, used by the student "Enroll now" / application wizard AND the staff onboarding wizard
// (browser), by the staff-onboarding Edge Function (Deno) and by the offline tests (Node). No runtime APIs and no imports other
// than the phone rules next to it, so the same input passes or fails everywhere with the same message. The database repeats the
// rules it stores (hr.v_* in migration 20261112090000); scripts/lab/staff-lab.mjs `wizard` runs one list of inputs through both
// and compares the messages.
//
// Each *Problem function returns "" when the value is fine, otherwise the message to show under the field.
import { parseStoredPhone, validateStoredPhone } from "./identifiers.ts";

// eslint-disable-next-line no-control-regex -- control characters are never valid in names, addresses or numbers
export const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

/* ---------------------------------------------------------------------- email */

/**
 * A real-looking address: one @, a name of allowed characters that does not start or end with a dot and has no "..",
 * and a domain of dot-separated labels (letters, digits, inner hyphens) ending in a 2+ letter extension (.com, .com.au).
 */
export function validEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || CONTROL.test(email) || !EMAIL.test(email)) return false;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (email.indexOf("@") !== at || !local || local.length > 64) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || !/^[a-z]{2,}$/.test(labels[labels.length - 1])) return false;
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function emailProblem(value: string): string {
  if (!value.trim()) return "Enter your email address.";
  return validEmail(value) ? "" : "Enter a valid email address, like name@company.com.au.";
}

/* ---------------------------------------------------------------------- names */

export const NAME_MAX = 100;

/** `what` is the field as the message names it: "first name", "last name", "contact person's name". */
export function nameProblem(value: string, what: string): string {
  const name = value.trim();
  if (!name) return `Enter your ${what}.`;
  if (CONTROL.test(name) || name.length > NAME_MAX) return `The ${what} must be ${NAME_MAX} characters or fewer.`;
  return "";
}

/* --------------------------------------------------------------------- phones */

/** A phone as the shared country-code field stores it (E.164). `missing` is the message for a blank or unusable value. */
export function phoneProblem(e164: string, missing: string): string {
  const value = String(e164 ?? "").trim();
  if (!value || !value.startsWith("+") || !parseStoredPhone(value)?.national) return missing;
  return validateStoredPhone(value);
}

export const mobileProblem = (e164: string): string => phoneProblem(e164, "Enter your mobile number.");

/* -------------------------------------------------------------- date of birth */

export const DOB_YOUNGEST_YEARS = 10;
export const DOB_OLDEST_YEARS = 100;

/** The date-of-birth limits, as YYYY-MM-DD, for the date picker's min and max. */
export function dateOfBirthRange(today: Date = new Date()): { min: string; max: string } {
  const iso = (years: number) => new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
  return { min: iso(DOB_OLDEST_YEARS), max: iso(DOB_YOUNGEST_YEARS) };
}

/** DD/MM/YYYY (or YYYY-MM-DD) to an ISO date; null when it is not a real date or not 10 to 100 years ago. */
export function parseDateOfBirth(raw: string, today: Date = new Date()): string | null {
  const text = raw.trim();
  let year: number, month: number, day: number;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dmy) { day = Number(dmy[1]); month = Number(dmy[2]); year = Number(dmy[3]); }
  else if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
  else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const youngest = new Date(Date.UTC(today.getUTCFullYear() - DOB_YOUNGEST_YEARS, today.getUTCMonth(), today.getUTCDate()));
  const oldest = new Date(Date.UTC(today.getUTCFullYear() - DOB_OLDEST_YEARS, today.getUTCMonth(), today.getUTCDate()));
  if (date > youngest || date < oldest) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function dateOfBirthProblem(raw: string, today: Date = new Date()): string {
  const text = raw.trim();
  if (!text) return "Enter your date of birth.";
  if (parseDateOfBirth(text, today)) return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const [year, month, day] = iso ? [+iso[1], +iso[2], +iso[3]] : dmy ? [+dmy[3], +dmy[2], +dmy[1]] : [0, 0, 0];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? "You must be between 10 and 100 years old." : "Enter a real date of birth.";
}

/* ---------------------------------------------------------- emergency contact */

export interface EmergencyContact { name: string; phone: string; relationship: string }
export type EmergencyContactProblems = Partial<Record<keyof EmergencyContact, string>>;
export const EMERGENCY_NAME_MAX = 120;
export const EMERGENCY_RELATIONSHIP_MAX = 60;

/** `who` is the person the contact is for, as the message names them: "the student" (application wizard) or "you" (staff). */
export function emergencyContactProblems(contact: EmergencyContact, who = "the student"): EmergencyContactProblems {
  const out: EmergencyContactProblems = {};
  const name = String(contact.name ?? "").trim(), relationship = String(contact.relationship ?? "").trim();
  if (!name) out.name = "Enter the emergency contact's name.";
  else if (CONTROL.test(name) || name.length > EMERGENCY_NAME_MAX) out.name = `The emergency contact's name must be ${EMERGENCY_NAME_MAX} characters or fewer.`;
  const phone = phoneProblem(contact.phone, "Enter the emergency contact's phone number.");
  if (phone) out.phone = phone;
  if (!relationship) out.relationship = `Enter how they are related to ${who}.`;
  else if (CONTROL.test(relationship) || relationship.length > EMERGENCY_RELATIONSHIP_MAX) out.relationship = `The relationship must be ${EMERGENCY_RELATIONSHIP_MAX} characters or fewer.`;
  return out;
}

/* -------------------------------------------------------------------- address */

export interface Address { street: string; line2: string; suburb: string; state: string; postcode: string; country: string }
export type AddressProblems = Partial<Record<keyof Address, string>>;
export const ADDRESS_LINE_MAX = 200;
export const AU_STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;
export const isAustralia = (country: string): boolean => /^(australia|au|aus)$/i.test(String(country ?? "").trim());

/** Street, suburb and country always; for an Australian address also a state (ACT, NSW, …) and a 4-digit postcode. */
export function addressProblems(address: Address): AddressProblems {
  const out: AddressProblems = {};
  const text = (key: keyof Address) => String(address[key] ?? "").trim();
  const tooLong = (key: keyof Address) => CONTROL.test(text(key)) || text(key).length > ADDRESS_LINE_MAX;
  if (!text("street")) out.street = "Enter the street address.";
  else if (tooLong("street")) out.street = `The street address must be ${ADDRESS_LINE_MAX} characters or fewer.`;
  if (tooLong("line2")) out.line2 = `Address line 2 must be ${ADDRESS_LINE_MAX} characters or fewer.`;
  if (!text("suburb")) out.suburb = "Enter the suburb or city.";
  else if (tooLong("suburb")) out.suburb = `The suburb or city must be ${ADDRESS_LINE_MAX} characters or fewer.`;
  if (!text("country")) out.country = "Enter the country.";
  else if (tooLong("country")) out.country = `The country must be ${ADDRESS_LINE_MAX} characters or fewer.`;
  if (isAustralia(text("country"))) {
    if (!(AU_STATES as readonly string[]).includes(text("state").toUpperCase())) out.state = "Choose the state or territory.";
    if (!/^\d{4}$/.test(text("postcode"))) out.postcode = "Enter the 4-digit postcode.";
  } else {
    if (tooLong("state")) out.state = `The state must be ${ADDRESS_LINE_MAX} characters or fewer.`;
    if (CONTROL.test(text("postcode")) || text("postcode").length > 20) out.postcode = "The postcode must be 20 characters or fewer.";
  }
  return out;
}

/* ---------------------------------------------------------- document uploads */

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_ACCEPT = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";
export const DOCUMENT_SIZE_MESSAGE = "Each document must be a PDF, JPG, or PNG no larger than 10 MB.";
export const DOCUMENT_TYPE_MESSAGE = "Only PDF, JPG, and PNG documents are supported.";
export const DOCUMENT_CONTENT_MESSAGE = "The selected file does not match its declared document type.";

export type DocumentKindOfFile = "pdf" | "png" | "jpg";
const KIND_OF_TYPE: Record<string, DocumentKindOfFile> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg" };
export const DOCUMENT_MIME: Record<DocumentKindOfFile, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg" };

/** What the first bytes of a file are: a PDF, a PNG, a JPEG, or none of them. */
export function sniffDocumentKind(header: Uint8Array): DocumentKindOfFile | null {
  if (header.length >= 5 && header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46 && header[4] === 0x2d) return "pdf";
  if (header.length >= 4 && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) return "png";
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "jpg";
  return null;
}

/**
 * Size, then name and declared type, then content. `header` is the file's first bytes (8 are enough); without it only the
 * first two checks run (a picker can refuse early, the upload checks all three).
 */
export function documentFileProblem(file: { name: string; size: number; type: string }, header?: Uint8Array): string {
  if (!(file.size > 0) || file.size > DOCUMENT_MAX_BYTES) return DOCUMENT_SIZE_MESSAGE;
  const declared = KIND_OF_TYPE[String(file.type ?? "").toLowerCase()];
  if (!/\.(pdf|png|jpe?g)$/i.test(file.name) || !declared) return DOCUMENT_TYPE_MESSAGE;
  if (header && sniffDocumentKind(header) !== declared) return DOCUMENT_CONTENT_MESSAGE;
  return "";
}

/* ------------------------------------------------- staff only: identity papers */

export const PASSPORT_NUMBER_MESSAGE = "Enter the passport number: 6 to 12 letters and numbers.";
/** Blank is fine here (the wizard decides what is required); otherwise 6 to 12 letters and digits. */
export function passportNumberProblem(raw: string): string {
  const value = String(raw ?? "").replace(/\s/g, "").toUpperCase();
  return !value || /^[A-Z0-9]{6,12}$/.test(value) ? "" : PASSPORT_NUMBER_MESSAGE;
}
export const normalizePassportNumber = (raw: string): string => String(raw ?? "").replace(/\s/g, "").toUpperCase();

/** Free text with a limit: nationality (100), visa type or subclass (100), visa work conditions (500). */
export function shortTextProblem(raw: string, label: string, max: number): string {
  const value = String(raw ?? "").trim();
  return CONTROL.test(value.replace(/[\r\n\t]/g, " ")) || value.length > max ? `${label} must be ${max} characters or fewer.` : "";
}

/* ------------------------------------------------- staff only: bank details */

export interface BankDetails { accountName: string; bsb: string; accountNumber: string }
export type BankProblems = Partial<Record<keyof BankDetails, string>>;
export const BANK_ACCOUNT_NAME_MAX = 100;
export const BSB_MESSAGE = "The BSB must be 6 digits, for example 062-000.";
export const ACCOUNT_NUMBER_MESSAGE = "The account number must be 4 to 10 digits.";
export const bankDigits = (value: string): string => String(value ?? "").replace(/[\s-]/g, "");

/** True when nothing was typed. */
export const bankIsBlank = (b: BankDetails): boolean => !String(b.accountName ?? "").trim() && !bankDigits(b.bsb) && !bankDigits(b.accountNumber);

/** Every field is needed: account name (1 to 100 characters), BSB (6 digits), account number (4 to 10 digits). */
export function bankProblems(b: BankDetails): BankProblems {
  const out: BankProblems = {};
  const name = String(b.accountName ?? "").trim();
  if (!name) out.accountName = "Enter the account name.";
  else if (CONTROL.test(name) || name.length > BANK_ACCOUNT_NAME_MAX) out.accountName = `The account name must be ${BANK_ACCOUNT_NAME_MAX} characters or fewer.`;
  if (!/^\d{6}$/.test(bankDigits(b.bsb))) out.bsb = BSB_MESSAGE;
  if (!/^\d{4,10}$/.test(bankDigits(b.accountNumber))) out.accountNumber = ACCOUNT_NUMBER_MESSAGE;
  return out;
}

/** 062000 > 062-000 (as printed on Australian bank statements). Anything else is returned as typed. */
export const formatBsb = (value: string): string => { const d = bankDigits(value); return /^\d{6}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3)}` : value; };
/** 062000 > 06••••: what an administrator sees until they press Reveal. */
export const maskBsb = (value: string): string => { const d = bankDigits(value); return d.length >= 2 ? `${d.slice(0, 2)}••••` : "••••••"; };
/** The last four digits, or only two of a number shorter than eight (hr.bank_view does the same). */
export const maskAccountNumber = (value: string): string => { const d = bankDigits(value); return `•••• ${d.slice(d.length >= 8 ? -4 : -2)}`; };

/**
 * The bank a BSB belongs to, from its first two or three digits (the institution code). This is a short built-in list of the
 * larger Australian banks, not a branch directory: no lookup service is called, and an unknown code returns "".
 */
const BSB_BANKS: ReadonlyArray<readonly [string, string]> = [
  ["939", "AMP Bank"], ["923", "ING"], ["944", "ME Bank"], ["484", "Suncorp Bank"], ["633", "Bendigo Bank"], ["637", "Greater Bank"],
  ["638", "Heritage Bank"], ["640", "Hume Bank"], ["641", "IMB Bank"], ["802", "Cuscal"], ["814", "Great Southern Bank"], ["969", "Tyro"],
  ["01", "ANZ"], ["03", "Westpac"], ["73", "Westpac"], ["06", "Commonwealth Bank"], ["76", "Commonwealth Bank"], ["08", "NAB"], ["78", "NAB"],
  ["10", "BankSA"], ["11", "St.George Bank"], ["33", "St.George Bank"], ["12", "Bank of Queensland"], ["18", "Macquarie Bank"],
  ["19", "Bank of Melbourne"], ["30", "Bankwest"], ["34", "HSBC"],
];
export function bsbBank(value: string): string {
  const d = bankDigits(value);
  if (!/^\d{6}$/.test(d)) return "";
  return BSB_BANKS.find(([prefix]) => d.startsWith(prefix))?.[1] ?? "";
}
