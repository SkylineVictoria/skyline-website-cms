// The identity documents CreateUSI accepts (USI Web Services v5, DVS document types; element names and order from the 3PT WSDL,
// 2026-11-23). Shared by the staff Create USI form (src/) and usi-service, so both check the same rules. No imports and no runtime
// APIs: the same file works in the browser, Deno and Node.
// A document is required for every Create in every environment (owner, 2026-11-23): Skyline never uses the DVS override.
// Document numbers are used only to build the request: never stored, logged or returned (only the type is kept).

export type UsiDocumentType =
  | "visa" | "passport" | "drivers_licence" | "immicard" | "medicare" | "birth_certificate" | "citizenship" | "descent" | "centrelink";

export interface UsiDocumentField {
  /** The XML element (in the order the schema requires). */
  key: string;
  label: string;
  kind: "text" | "date" | "month" | "select";
  options?: string[];
  /** Required always, or only for some values of the other fields. */
  required: boolean | ((values: Record<string, string>) => boolean);
  /** The format a value must have, and the message when it does not. */
  pattern?: RegExp;
  message?: string;
  help?: string;
  upper?: boolean;
}

export interface UsiDocumentDefinition { type: UsiDocumentType; label: string; xsiType: string; fields: UsiDocumentField[]; help?: string }

const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const USI_DOCUMENTS: UsiDocumentDefinition[] = [
  {
    type: "visa", label: "Passport from another country (with an Australian visa)", xsiType: "VisaDocumentType",
    help: "The passport the student's Australian visa was granted to. The names and date of birth must match the passport.",
    fields: [{ key: "PassportNumber", label: "Passport number", kind: "text", required: true, upper: true, pattern: /^[A-Za-z0-9-]{1,14}$/, message: "Use letters, numbers and hyphens only (up to 14)." }],
  },
  {
    type: "passport", label: "Australian passport", xsiType: "PassportDocumentType",
    help: "Current, or expired less than three years ago.",
    fields: [{ key: "DocumentNumber", label: "Document number", kind: "text", required: true, upper: true, pattern: /^[A-Z]{1,2}\d{7}$/, message: "One or two letters then 7 digits, e.g. PA1234567." }],
  },
  {
    type: "drivers_licence", label: "Australian driver licence", xsiType: "DriversLicenceDocumentType",
    help: "Current licence only.",
    fields: [
      { key: "LicenceNumber", label: "Licence number", kind: "text", required: true, upper: true, pattern: /^[A-Za-z0-9]{1,10}$/, message: "Letters and numbers only (up to 10)." },
      { key: "State", label: "State or territory", kind: "select", options: STATES, required: true },
      { key: "CardNumber", label: "Card number", kind: "text", required: true, upper: true, pattern: /^[A-Za-z0-9]{1,10}$/, message: "Letters and numbers only (up to 10).", help: "Printed on the card (required in every state)." },
    ],
  },
  {
    type: "immicard", label: "ImmiCard", xsiType: "ImmiCardDocumentType",
    fields: [{ key: "ImmiCardNumber", label: "ImmiCard number", kind: "text", required: true, upper: true, pattern: /^[A-Z]{3}\d{6}$/, message: "Three letters then 6 digits, e.g. ABC123456." }],
  },
  {
    type: "medicare", label: "Medicare card", xsiType: "MedicareDocumentType",
    help: "The names must be the student's names exactly as printed on the card.",
    fields: [
      { key: "MedicareCardNumber", label: "Card number", kind: "text", required: true, pattern: /^\d{10}$/, message: "10 digits." },
      { key: "IndividualRefNumber", label: "Individual reference number", kind: "text", required: true, pattern: /^[1-9]$/, message: "One digit, 1 to 9." },
      { key: "ExpiryDate", label: "Expiry date", kind: "text", required: true, pattern: /^\d{4}-\d{2}(-\d{2})?$/, message: "YYYY-MM for a green card, YYYY-MM-DD for blue or yellow.", help: "YYYY-MM (green) or YYYY-MM-DD (blue, yellow)." },
      { key: "CardColour", label: "Card colour", kind: "select", options: ["Green", "Blue", "Yellow"], required: true },
      { key: "NameLine1", label: "Name line 1", kind: "text", required: true, pattern: /^.{1,27}$/, message: "Up to 27 characters." },
      { key: "NameLine2", label: "Name line 2", kind: "text", required: false, pattern: /^.{0,25}$/, message: "Up to 25 characters." },
      { key: "NameLine3", label: "Name line 3", kind: "text", required: false, pattern: /^.{0,23}$/, message: "Up to 23 characters." },
      { key: "NameLine4", label: "Name line 4", kind: "text", required: false, pattern: /^.{0,21}$/, message: "Up to 21 characters." },
    ],
  },
  {
    type: "birth_certificate", label: "Australian birth certificate", xsiType: "BirthCertificateDocumentType",
    fields: [
      { key: "RegistrationNumber", label: "Registration number", kind: "text", required: true, upper: true, pattern: /^[A-Za-z0-9/]{1,10}$/, message: "Letters, numbers and / only (up to 10)." },
      { key: "RegistrationState", label: "State or territory", kind: "select", options: STATES, required: true },
      { key: "RegistrationDate", label: "Registration date", kind: "date", required: (v) => ["QLD", "TAS"].includes(v.RegistrationState), pattern: DATE, message: "Use a date." },
      { key: "DatePrinted", label: "Date printed", kind: "date", required: (v) => ["SA", "ACT"].includes(v.RegistrationState), pattern: DATE, message: "Use a date." },
      { key: "CertificateNumber", label: "Certificate number", kind: "text", required: false, pattern: /^\d{1,11}$/, message: "Up to 11 digits.", help: "SA (printed from 1 Nov 1999) and ACT (from 1 May 2002)." },
    ],
  },
  {
    type: "citizenship", label: "Australian citizenship certificate", xsiType: "CitizenshipCertificateDocumentType",
    fields: [
      { key: "StockNumber", label: "Stock number", kind: "text", required: true, upper: true, pattern: /^[A-Za-z0-9]{4,11}$/, message: "4 to 11 letters and numbers." },
      { key: "AcquisitionDate", label: "Acquisition date", kind: "date", required: true, pattern: DATE, message: "Use a date." },
    ],
  },
  {
    type: "descent", label: "Certificate of registration by descent", xsiType: "CertificateOfRegistrationByDescentDocumentType",
    fields: [{ key: "AcquisitionDate", label: "Acquisition date", kind: "date", required: true, pattern: DATE, message: "Use a date." }],
  },
  {
    type: "centrelink", label: "Centrelink concession card", xsiType: "CentrelinkCardType",
    help: "Pensioner Concession, Health Care or Commonwealth Seniors Health Card; only the first person named on the card.",
    fields: [
      { key: "CRN", label: "Customer reference number (CRN)", kind: "text", required: true, upper: true, pattern: /^\d{9}[A-Z]$/, message: "9 digits then one letter." },
      { key: "Name", label: "Name as on the card", kind: "text", required: true, pattern: /^[A-Za-z' -]{1,32}$/, message: "Letters, spaces, hyphens and apostrophes (up to 32)." },
      { key: "ExpiryDate", label: "Expiry date", kind: "date", required: true, pattern: DATE, message: "Use a date." },
      { key: "Type", label: "Card type", kind: "select", options: ["PCC", "HCC", "SHC"], required: true },
    ],
  },
];

export const usiDocument = (type: string) => USI_DOCUMENTS.find((d) => d.type === type) ?? null;

const isRequired = (f: UsiDocumentField, v: Record<string, string>) => typeof f.required === "function" ? f.required(v) : f.required;

/** The values as they will be sent: trimmed, upper-cased where the schema expects it, unknown keys dropped. */
export function cleanUsiDocument(type: string, raw: Record<string, unknown>): Record<string, string> {
  const def = usiDocument(type);
  const out: Record<string, string> = {};
  for (const f of def?.fields ?? []) {
    const value = String(raw?.[f.key] ?? "").trim().replace(/\s+/g, f.kind === "text" && !f.key.startsWith("Name") ? "" : " ");
    if (value) out[f.key] = f.upper ? value.toUpperCase() : value;
  }
  return out;
}

/** Field problems keyed by field; { _type } when no document (or an unknown one) was chosen. Empty = ready. */
export function usiDocumentProblems(type: string, raw: Record<string, unknown>): Record<string, string> {
  const def = usiDocument(type);
  if (!def) return { _type: "Choose the identity document." };
  const v = cleanUsiDocument(type, raw);
  const problems: Record<string, string> = {};
  for (const f of def.fields) {
    const value = v[f.key] ?? "";
    if (!value) { if (isRequired(f, v)) problems[f.key] = `Enter the ${f.label.toLowerCase()}.`; continue; }
    if (f.options && !f.options.includes(value)) problems[f.key] = `Choose the ${f.label.toLowerCase()}.`;
    else if (f.pattern && !f.pattern.test(value)) problems[f.key] = f.message ?? "This value is not in the right format.";
  }
  return problems;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The <DVSDocument> element for CreateUSI (xsi bound on CreateUSI); "" when the document is not valid. */
export function usiDocumentXml(type: string, raw: Record<string, unknown>): string {
  const def = usiDocument(type);
  if (!def || Object.keys(usiDocumentProblems(type, raw)).length) return "";
  const v = cleanUsiDocument(type, raw);
  // Only the fields this document needs: a birth certificate field another state does not use can make DVS fail (spec 4.3.11.2).
  const inner = def.fields.filter((f) => v[f.key] && (f.required === true || typeof f.required !== "function" || isRequired(f, v)))
    .map((f) => `<${f.key}>${esc(v[f.key])}</${f.key}>`).join("");
  return `<DVSDocument xsi:type="${def.xsiType}">${inner}</DVSDocument>`;
}
