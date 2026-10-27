// Runtime-neutral document extraction contract (no Deno or Node globals beyond
// web-standard ones) so the same source runs in Edge, Node tests and any future host.
// A provider only turns document bytes into candidate fields. It never writes
// application values; the leased worker persists the result through fenced SQL.

export const EXTRACTION_PARSER = "document-extraction-v1";
export const EXTRACTION_CATEGORIES = ["Passport", "Driving Licence", "Visa", "English Test", "Academic"] as const;
export type ExtractionCategory = typeof EXTRACTION_CATEGORIES[number];

// Application field identifiers, not a generic document schema: aligned with the
// wizard so candidates can be merged into genuinely empty fields and then reviewed.
export const EXTRACTION_FIELD_NAMES = ["first_name","middle_name","last_name","dob","gender","nationality","citizenship","issuing_country","birth_country","passport_number","passport_expiry","address_type","au_street","au_line2","au_suburb","au_state","au_zip","au_country","ov_street","ov_line2","ov_suburb","ov_state","ov_zip","ov_country","holds_visa","visa_subclass","visa_grant_date","visa_stay_until","visa_grant_number","english_type","english_score","english_components","english_date","english_reference","academic_institution","academic_qualification","academic_program","academic_year","academic_result"] as const;

export type ProviderErrorCode = "network" | "rate_limit" | "provider" | "timeout" | "schema" | "validation" | "cancelled";

export interface ExtractionRequest {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  category: ExtractionCategory;
  /** Immutable content hash when known; used for dedupe by adapters that support it. */
  contentHash?: string;
  jobId: string;
  attempt: number;
  signal: AbortSignal;
  /** Asynchronous providers only: a previously accepted operation to poll instead of submitting the document again. */
  resumeOperationId?: string;
  /** Asynchronous providers only: called once with a newly accepted operation id, before polling, so a retry can reuse it. Best effort. */
  onOperationAccepted?: (operationId: string) => Promise<void>;
}

export interface ExtractionEvidence { field: string; page: number | null; source: string }

export interface ExtractionSuccess {
  ok: true;
  detectedType: string;
  categoryMismatch: boolean;
  fields: Record<string, string | null>;
  evidence: ExtractionEvidence[];
  /** Per-field 0..1, only when the provider supplied it. Never manufactured. */
  confidence?: Record<string, number>;
  warnings: string[];
  /** Provider response/operation identifier, persisted as the job response id. */
  operationId: string | null;
  usage: Record<string, unknown>;
}

/** Messages are fixed, non-sensitive strings: never document text, headers or credentials. */
export interface ExtractionFailure { ok: false; code: ProviderErrorCode; message: string; retryable: boolean }
export type ExtractionOutcome = ExtractionSuccess | ExtractionFailure;

export interface DocumentExtractionProvider {
  /** Stable engine identifier persisted in extraction provenance. */
  readonly id: string;
  /** Model/configuration version persisted in extraction provenance. */
  readonly model: string;
  extract(request: ExtractionRequest): Promise<ExtractionOutcome>;
}

export interface ExtractionEnvelope {
  extracted: Record<string, string>;
  confirmed: Record<string, string>;
  status: "unreviewed" | "no_fields";
  source: {
    engine: string; parser: string; model: string; extractedAt: string; documentType: string; categoryMismatch: boolean;
    rawFields: Record<string, string>; evidence: ExtractionEvidence[];
    confidence?: Record<string, number>; warnings?: string[];
  };
}

export const failure = (code: ProviderErrorCode, message: string, retryable: boolean): ExtractionFailure => ({ ok: false, code, message, retryable });

/** Allowed upload: PDF/PNG/JPEG whose declared MIME, extension and magic bytes agree. */
export function isSupportedDocument(bytes: Uint8Array, mime: string, name: string): boolean {
  const pdf = bytes.length > 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  const png = bytes.length > 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const jpg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const allowedName = /\.(pdf|png|jpe?g)$/i.test(name);
  return allowedName && ((mime === "application/pdf" && pdf) || (mime === "image/png" && png) || ((mime === "image/jpeg" || mime === "image/jpg") && jpg));
}

/** Normalise only to fields/options the existing application can represent. */
export function normaliseCandidates(fields: Record<string, string>): Record<string, string> {
  const result = { ...fields };
  const testType = result.english_type?.toLowerCase() ?? "";
  if (testType.includes("ielts") && testType.includes("general")) result.english_type = "IELTS General Training";
  else if (testType.includes("ielts")) result.english_type = "IELTS Academic";
  else if (testType.includes("pte") || testType.includes("pearson")) result.english_type = "PTE Academic";
  else if (testType.includes("toefl")) result.english_type = "TOEFL iBT";
  else if (testType.includes("cambridge")) result.english_type = "Cambridge English";
  if (result.english_components) {
    result.english_score = result.english_score ? `${result.english_score} (Overall) · ${result.english_components}` : result.english_components;
    delete result.english_components;
  }
  return result;
}

const known = new Set<string>(EXTRACTION_FIELD_NAMES);

const AU_STATE_CODES = new Set(["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"]);
const US_STATE_CODES = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WV","WI","WY"]);
const AU_ADDRESS_KEYS = ["au_street", "au_line2", "au_suburb", "au_state", "au_zip"] as const;
const OV_ADDRESS_KEYS = ["ov_street", "ov_line2", "ov_suburb", "ov_state", "ov_zip"] as const;
const isAustraliaName = (v: string) => ["AUS", "AU", "AUSTRALIA"].includes(v.trim().toUpperCase());

/**
 * Keeps a non-Australian address instead of dropping it: structured au_* values
 * with a non-Australian state are moved to the ov_* fields, address_type follows
 * the data, and a missing country is inferred only for a US state code with a
 * 5 or 5+4 digit ZIP. If the country is still unknown it stays empty and a
 * warning is returned. Australian handling is unchanged.
 */
export function normaliseAddress(fields: Record<string, string>): { fields: Record<string, string>; warnings: string[] } {
  const result = { ...fields };
  const warnings: string[] = [];
  const auState = (result.au_state ?? "").toUpperCase().replace(/\./g, "");
  if (AU_ADDRESS_KEYS.some((k) => result[k]) && !OV_ADDRESS_KEYS.some((k) => result[k]) && auState && !AU_STATE_CODES.has(auState) && !/^\d{4}$/.test(result.au_zip ?? "")) {
    AU_ADDRESS_KEYS.forEach((key, i) => { if (result[key]) result[OV_ADDRESS_KEYS[i]] = result[key]; delete result[key]; });
    if (result.au_country && !isAustraliaName(result.au_country)) result.ov_country = result.au_country;
    delete result.au_country;
  }
  if (!OV_ADDRESS_KEYS.some((k) => result[k]) && !result.ov_country) return { fields: result, warnings };
  if (!AU_ADDRESS_KEYS.some((k) => result[k])) result.address_type = "Overseas Address";
  if (result.address_type === "Overseas Address" && !result.ov_country) {
    const state = (result.ov_state ?? "").toUpperCase().replace(/\./g, "");
    if (US_STATE_CODES.has(state) && /^\d{5}(-\d{4})?$/.test(result.ov_zip ?? "")) result.ov_country = "United States";
    else warnings.push("The address country could not be determined; street, city, state and postal code were filled, enter the country manually.");
  }
  return { fields: result, warnings };
}

/** Confidence is kept only when every value is a finite number in 0..1; otherwise it is dropped. */
export function validConfidence(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || !entries.every(([key, v]) => known.has(key) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}

/**
 * Builds the persisted extraction envelope. A wrong category is retained as an
 * auditable outcome but can never populate an application (e.g. a foreign visa
 * must not be mistaken for an Australian grant notice). Optional provenance
 * keys are added only when the provider supplied them, keeping the legacy shape.
 */
export function buildExtractionEnvelope(provider: Pick<DocumentExtractionProvider, "id" | "model">, result: ExtractionSuccess, extractedAt: string): ExtractionEnvelope {
  const rawFields = Object.fromEntries(Object.entries(result.fields)
    .filter(([key, value]) => known.has(key) && typeof value === "string" && value.trim())
    .map(([key, value]) => [key, String(value).trim()]));
  const address = result.categoryMismatch ? { fields: rawFields, warnings: [] as string[] } : normaliseAddress(rawFields);
  const extracted = result.categoryMismatch ? {} : normaliseCandidates(address.fields);
  const warnings = [...result.warnings, ...address.warnings];
  const confidence = validConfidence(result.confidence);
  return {
    extracted, confirmed: {}, status: Object.keys(extracted).length ? "unreviewed" : "no_fields",
    source: {
      engine: provider.id, parser: EXTRACTION_PARSER, model: provider.model, extractedAt, documentType: result.detectedType,
      categoryMismatch: result.categoryMismatch, rawFields, evidence: result.evidence,
      ...(confidence ? { confidence } : {}), ...(warnings.length ? { warnings } : {}),
    },
  };
}
