import { COUNTRY_OPTIONS } from "./countryOptions";

export interface DocumentExtraction {
  extracted: Record<string, string>;
  confirmed: Record<string, string>;
  status: "queued" | "processing" | "unreviewed" | "confirmed" | "rejected" | "no_fields" | "failed" | "cancelled";
  source: { engine: string; extractedAt?: string; queuedAt?: string; parser: string; diagnostics?: Record<string, unknown> };
}

const COUNTRY_ALIASES: Record<string, string> = {
  au: "Australia", aus: "Australia", australia: "Australia", australian: "Australia",
  in: "India", ind: "India", india: "India", "republic of india": "India", indian: "India",
  us: "United States", usa: "United States", "united states": "United States", "united states of america": "United States", american: "United States",
  gb: "United Kingdom", gbr: "United Kingdom", uk: "United Kingdom", "united kingdom": "United Kingdom", british: "United Kingdom",
  cn: "China", chn: "China", china: "China", chinese: "China",
  vn: "Viet Nam", vnm: "Viet Nam", vietnam: "Viet Nam", vietnamese: "Viet Nam",
  ph: "Philippines", phl: "Philippines", philippines: "Philippines", filipino: "Philippines",
  kr: "Korea, Republic of", kor: "Korea, Republic of", "south korea": "Korea, Republic of", korean: "Korea, Republic of",
};

const AU_STATE_ALIASES: Record<string, string> = {
  nsw: "NSW", "new south wales": "NSW", vic: "VIC", victoria: "VIC", qld: "QLD", queensland: "QLD",
  sa: "SA", "south australia": "SA", wa: "WA", "western australia": "WA", tas: "TAS", tasmania: "TAS",
  nt: "NT", "northern territory": "NT", act: "ACT", "australian capital territory": "ACT",
};

const DATE_FIELDS = new Set(["dob", "passport_expiry", "passport_issue_date", "licence_expiry", "visa_grant_date", "visa_stay_until", "english_date"]);
const COUNTRY_FIELDS = new Set(["nationality", "citizenship", "issuing_country", "passport_issuing_country", "birth_country", "au_country", "ov_country"]);

function englishTestType(value: string): string | null {
  const normalized = key(value);
  if (normalized.includes("ielts") && normalized.includes("general")) return "IELTS General Training";
  if (normalized.includes("ielts")) return "IELTS Academic";
  if (normalized.includes("pte") || normalized.includes("pearson")) return "PTE Academic";
  if (normalized.includes("toefl")) return "TOEFL iBT";
  if (normalized.includes("cambridge")) return "Cambridge English";
  return null;
}

function key(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[._-]/g, " ").replace(/\s+/g, " ");
}

function canonicalCountry(value: string): string | null {
  const normalized = key(value);
  const candidate = COUNTRY_ALIASES[normalized] ?? value.trim();
  return COUNTRY_OPTIONS.find((country) => key(country) === key(candidate)) ?? null;
}

function formattedDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const dayFirst = trimmed.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}`;
  const yearFirst = trimmed.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (yearFirst) return `${yearFirst[1]}-${yearFirst[2].padStart(2, "0")}-${yearFirst[3].padStart(2, "0")}`;
  // Keep an unrecognised value visible for agent correction rather than
  // silently clearing it because a native date input rejects the string.
  return trimmed;
}

/** Formats persisted OpenAI candidates for the existing wizard controls. */
export function formatExtractionCandidates(fields: Record<string, string> | undefined): Record<string, string> {
  const formatted: Record<string, string> = {};
  let englishComponents = "";
  for (const [rawField, raw] of Object.entries(fields ?? {})) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    // The API has a document-specific field name; the shared application uses
    // `issuing_country`. Preserve the source/evidence in metadata separately.
    const field = rawField === "passport_issuing_country" ? "issuing_country" : rawField;
    if (field === "english_type") {
      const type = englishTestType(value);
      if (type) formatted[field] = type;
      else formatted[field] = value;
    } else if (field === "english_components") {
      // The application has one score field. Preserve the source's scoring
      // notation verbatim in that field instead of inventing score conversions.
      englishComponents = value;
    } else if (field === "gender") {
      const gender = key(value);
      if (gender === "m" || gender === "male") formatted[field] = "Male";
      else if (gender === "f" || gender === "female") formatted[field] = "Female";
      else if (gender === "prefer not to say") formatted[field] = "Prefer not to say";
      // Unknown gender remains unselected; it must not masquerade as a valid option.
    } else if (COUNTRY_FIELDS.has(field)) {
      const country = canonicalCountry(value);
      if (country) formatted[field] = country;
    } else if (field === "au_state") {
      const state = AU_STATE_ALIASES[key(value)];
      if (state) formatted[field] = state;
    } else if (field === "address_type") {
      const addressType = key(value);
      if (addressType === "australian address") formatted[field] = "Australian Address";
      else if (addressType === "overseas address") formatted[field] = "Overseas Address";
    } else if (DATE_FIELDS.has(field)) {
      formatted[field] = formattedDate(value);
    } else {
      formatted[field] = value;
    }
  }
  // The radio follows the extracted address when the provider did not set it.
  if (!formatted.address_type) {
    if (formatted.ov_street || formatted.ov_suburb || formatted.ov_state || formatted.ov_zip || formatted.ov_country) formatted.address_type = "Overseas Address";
    else if (formatted.au_street || formatted.au_suburb || formatted.au_state || formatted.au_zip) formatted.address_type = "Australian Address";
  }
  if (englishComponents) {
    formatted.english_score = formatted.english_score ? `${formatted.english_score} (Overall) · ${englishComponents}` : englishComponents;
  }
  return formatted;
}

/** Creates a display-safe copy; stored metadata remains the raw audit record. */
export function formatDocumentExtraction(extraction: DocumentExtraction | undefined): DocumentExtraction | undefined {
  if (!extraction) return undefined;
  return { ...extraction, extracted: formatExtractionCandidates(extraction.extracted), confirmed: formatExtractionCandidates(extraction.confirmed) };
}

/** Legacy metadata has field names only; never misrepresent those as values. */
export function hasLegacyExtractionOnly(metadata: Record<string, unknown> | undefined): boolean {
  return !metadata?.extraction && Array.isArray(metadata?.extractedFields) && metadata.extractedFields.length > 0;
}

/** A saved private object can be read again without creating another row/object. */
export function needsOcrRetry(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata?.kind) return false;
  if (!metadata.extraction) return true;
  const extraction = metadata.extraction as Partial<DocumentExtraction>;
  return extraction.status === "failed" || (!extraction.extracted || Object.keys(extraction.extracted).length === 0) && extraction.status !== "processing";
}

/** Upgrades one document after an explicit reprocess; never invents legacy values. */
export function reprocessedExtractionMetadata(metadata: Record<string, unknown>, extracted: Record<string, string>, extractedAt: string, diagnostics?: Record<string, unknown>): Record<string, unknown> {
  const previous = metadata.extraction as Partial<DocumentExtraction> | undefined;
  const confirmed = previous?.confirmed ?? {};
  const hasConfirmed = Object.keys(confirmed).length > 0;
  return {
    ...metadata,
    diagnostics: diagnostics ?? metadata.diagnostics,
    extractedFields: Object.keys(extracted),
    extraction: {
      extracted,
      confirmed,
      // A failed retry is never allowed to downgrade already-confirmed values.
      status: Object.keys(extracted).length ? "unreviewed" : hasConfirmed ? "confirmed" : "no_fields",
      source: { engine: "tesseract.js", parser: "parseDocument", extractedAt, diagnostics },
    } satisfies DocumentExtraction,
  };
}
import { countries } from "../../../data/applicationForms";

