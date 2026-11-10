// Pure helpers shared by the portal (src/), the submission PDF and tests: Unique Student Identifier (USI) and phone numbers.
// No imports and no runtime APIs, so the same file works in the browser, Deno and Node.

/* ---------------------------------------------------------------------- USI */

/** Characters a USI can contain: A-Z without I and O, and 2-9 (no 0 or 1). */
export type UsiStatus = "provided" | "pending" | "none";

/**
 * Where a student's USI stands: "provided" once a number is entered, "pending" when the agent chose to add it later (and none is entered yet),
 * otherwise "none". A pending USI never blocks a finish or a submission: the form still records "No" for "Do you already have a USI?".
 * (From the live notification-delivery function of 2026-11-02; the submission PDF prints "Pending" for it.)
 */
export function usiStatus(values: Record<string, unknown>, pending: boolean): UsiStatus {
  const has = String(values.has_usi ?? "").trim() === "Yes";
  const number = normalizeUsi(String(values.usi_number ?? ""));
  if (has && number) return "provided";
  return pending ? "pending" : "none";
}

export const USI_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const USI_LENGTH = 10;
export const USI_FORMAT_MESSAGE = "USI must be 10 characters using letters and numbers (no 0, 1, I or O).";

/** Uppercases, drops spaces and dashes, and caps the length. */
export function normalizeUsi(raw: string): string {
  return String(raw ?? "").toUpperCase().replace(/[\s-]/g, "").slice(0, USI_LENGTH);
}

/** True once the text contains a character a USI can never have. */
export function hasForbiddenUsiCharacter(raw: string): boolean {
  return [...normalizeUsi(raw)].some((char) => !USI_ALPHABET.includes(char));
}

/**
 * Format check only. The 10th character is a check character, but the official algorithm is issued by the USI Registry on request
 * and has not been verified here, so it is deliberately not checked. Blank is valid (optional for offshore students).
 */
export function validateUsi(raw: string): string {
  const text = String(raw ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (!text) return "";
  return text.length === USI_LENGTH && [...text].every((char) => USI_ALPHABET.includes(char)) ? "" : USI_FORMAT_MESSAGE;
}

/* ------------------------------------------------------------------- Phones */

export interface PhoneCountry { dial: string; label: string; flag: string }

export const PHONE_COUNTRIES: PhoneCountry[] = [
  { dial: "61", label: "Australia", flag: "\u{1F1E6}\u{1F1FA}" },
  { dial: "91", label: "India", flag: "\u{1F1EE}\u{1F1F3}" },
  { dial: "63", label: "Philippines", flag: "\u{1F1F5}\u{1F1ED}" },
  { dial: "977", label: "Nepal", flag: "\u{1F1F3}\u{1F1F5}" },
  { dial: "94", label: "Sri Lanka", flag: "\u{1F1F1}\u{1F1F0}" },
  { dial: "880", label: "Bangladesh", flag: "\u{1F1E7}\u{1F1E9}" },
  { dial: "92", label: "Pakistan", flag: "\u{1F1F5}\u{1F1F0}" },
  { dial: "44", label: "United Kingdom", flag: "\u{1F1EC}\u{1F1E7}" },
  { dial: "1", label: "United States / Canada", flag: "\u{1F1FA}\u{1F1F8}" },
];

export const DEFAULT_DIAL = "61";
export const AU_PHONE_MESSAGE = "Enter a 10-digit Australian number starting with 0, e.g. 041 234 5678.";
export const OTHER_PHONE_MESSAGE = "Enter a valid phone number for the selected country.";

const digitsOf = (text: string) => String(text ?? "").replace(/\D/g, "");

/** Splits "+61 412 345 678" into its known dial code and national digits; null when the code is unknown. */
export function splitInternational(raw: string): { dial: string; national: string } | null {
  const text = String(raw ?? "").trim();
  if (!text.startsWith("+")) return null;
  const digits = digitsOf(text);
  const country = [...PHONE_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length).find((item) => digits.startsWith(item.dial));
  return country ? { dial: country.dial, national: digits.slice(country.dial.length) } : null;
}

/** What the user typed for a given country, reduced to national digits (a leading trunk 0 is dropped) and E.164. */
export function normalizePhoneInput(dial: string, raw: string): { dial: string; national: string; e164: string } {
  const typed = String(raw ?? "").trim();
  const international = splitInternational(typed);
  const useDial = international?.dial ?? dial;
  let national = international ? international.national : digitsOf(typed);
  if (useDial !== "1" && national.startsWith("0")) national = national.slice(1);
  if (useDial === DEFAULT_DIAL && national.length === 11 && national.startsWith("61")) national = national.slice(2);
  return { dial: useDial, national, e164: national ? `+${useDial}${national}` : "" };
}

/** "" when valid or blank, otherwise the message to show. Australian numbers: any 9 digits after the trunk 0 (10 digits as written). */
export function validatePhone(dial: string, national: string): string {
  if (!national) return "";
  if (dial === DEFAULT_DIAL) return /^[1-9]\d{8}$/.test(national) ? "" : AU_PHONE_MESSAGE;
  return /^\d{6,12}$/.test(national) && dial.length + national.length <= 15 ? "" : OTHER_PHONE_MESSAGE;
}

/** Australian digits always carry the trunk 0 and group 3-3-4 (041 234 5678), also while typing; otherwise groups of three. */
export function formatNational(dial: string, national: string): string {
  if (dial === DEFAULT_DIAL) {
    if (!national) return "";
    const digits = `0${national}`;
    return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)].filter(Boolean).join(" ");
  }
  return national.replace(/(\d{3})(?=\d)/g, "$1 ");
}

/**
 * Reads a stored value. "+..." numbers with a known code and "04XXXXXXXX" legacy Australian mobiles are understood;
 * anything else returns null so the caller can leave it exactly as it was saved.
 */
export function parseStoredPhone(raw: string): { dial: string; national: string } | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const international = splitInternational(text);
  if (international) return international;
  const compact = text.replace(/[\s().-]/g, "");
  return /^04\d{8}$/.test(compact) ? { dial: DEFAULT_DIAL, national: compact.slice(1) } : null;
}

/** 041 234 5678 for Australia, +91 987 654 321 0 style otherwise. Unrecognised stored values are returned untouched. */
export function formatPhone(raw: string): string {
  const parsed = parseStoredPhone(raw);
  if (!parsed) return String(raw ?? "");
  // Australian numbers are shown nationally with their 0 (041 234 5678) so there is no +61 / 0 confusion.
  return parsed.dial === DEFAULT_DIAL ? formatNational(parsed.dial, parsed.national) : `+${parsed.dial} ${formatNational(parsed.dial, parsed.national)}`;
}

/** Validation of a stored value; legacy values that are not understood are not flagged. */
export function validateStoredPhone(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text.startsWith("+")) return "";
  const parsed = splitInternational(text);
  return parsed ? validatePhone(parsed.dial, parsed.national) : "";
}

/* --------------------------------------------------------------- Display */

/** Form fields that hold a phone number. */
export const PHONE_FIELDS = new Set(["mobile", "ec_phone", "agent_phone"]);

/** How a stored value is shown on the review screen and in the PDF. */
export function formatStoredValue(field: string, value: string): string {
  if (PHONE_FIELDS.has(field)) return formatPhone(value);
  if (field === "usi_number") return String(value ?? "").trim() ? normalizeUsi(value) : "";
  return value;
}
