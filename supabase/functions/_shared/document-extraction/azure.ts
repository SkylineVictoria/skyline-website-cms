// Azure AI Document Intelligence adapter behind DocumentExtractionProvider.
// Contract verified against Microsoft Learn on 2026-10-26 (REST api-version 2024-11-30):
//   POST {endpoint}/documentintelligence/documentModels/{model}:analyze?_overload=analyzeDocument&api-version=...
//     body {"base64Source": "..."}, header Ocp-Apim-Subscription-Key -> 202 + Operation-Location (+ Retry-After)
//   GET  {endpoint}/documentintelligence/documentModels/{model}/analyzeResults/{resultId}?api-version=...
//     status notStarted | running | succeeded | failed; throttling is HTTP 429; poll no faster than every 2 s.
// Runtime-neutral (web-standard APIs only). The adapter never writes application values,
// never follows a URL supplied by the service, and never puts credentials, the endpoint or
// document text into an error message. No live call is made unless a caller supplies real
// configuration and fetch; tests inject both.
import {
  EXTRACTION_FIELD_NAMES, failure, validConfidence,
  type DocumentExtractionProvider, type ExtractionCategory, type ExtractionEvidence, type ExtractionOutcome, type ExtractionRequest,
} from "./contract.ts";

export const AZURE_DEFAULT_API_VERSION = "2024-11-30";
export const AZURE_PROVIDER_ID = "azure-document-intelligence";

const HOST_SUFFIXES = [".cognitiveservices.azure.com", ".cognitive.microsoft.com"];
export const AZURE_MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._~-]{1,63}$/;
const API_VERSION = /^\d{4}-\d{2}-\d{2}(-preview)?$/;
const RESULT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const POLL_BACKOFF_MS = [2000, 5000, 13000, 34000];
const MIN_POLL_MS = 2000;
const MAX_POLL_MS = 34000;
const MAX_TRANSIENT_POLL_ERRORS = 3;
const PERMANENT_ANALYSIS_ERRORS = /^(InvalidRequest|InvalidContent|InvalidContentLength|InvalidContentDimensions|InvalidFormat|InvalidParameter|UnsupportedContent|CorruptedContent)/i;

/** Thrown only while building the provider; carries the offending variable name, never a value. */
export class AzureConfigurationError extends Error {
  constructor(readonly variable: string) { super(`Invalid Azure configuration: ${variable}`); }
}

export interface AzureProviderOptions {
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
  /** Category -> model id. Passport and Driving Licence use prebuilt-idDocument mapping; any other model is a custom model whose fields are named with application identifiers. */
  modelMap: Partial<Record<ExtractionCategory, string>>;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxPolls?: number;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const b64 = (bytes: Uint8Array) => { let out = ""; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(out); };

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
});

function normaliseEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AzureConfigurationError("EF_AZURE_DOCUMENT_ENDPOINT"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port || url.pathname !== "/" ||
      !HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) throw new AzureConfigurationError("EF_AZURE_DOCUMENT_ENDPOINT");
  return url.origin;
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw || !/^\d{1,5}$/.test(raw.trim())) return null;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Number(raw) * 1000));
}

// ---- result mapping ------------------------------------------------------------------

const SCALAR_KEYS = ["valueString", "valueDate", "valueTime", "valueNumber", "valueInteger", "valuePhoneNumber", "valueCountryRegion", "valueSelectionMark", "valueBoolean"];
function scalar(field: unknown): string | null {
  if (!isObject(field)) return null;
  for (const key of SCALAR_KEYS) { const v = field[key]; if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v).trim() || null; }
  if (field.type === "string" && typeof field.content === "string") return field.content.trim() || null;
  return null;
}
const pageOf = (field: unknown): number | null => {
  const region = isObject(field) && Array.isArray(field.boundingRegions) ? field.boundingRegions[0] : null;
  return isObject(region) && Number.isInteger(region.pageNumber) ? Number(region.pageNumber) : null;
};
const confidenceOf = (field: unknown): number | undefined => (isObject(field) && typeof field.confidence === "number" ? field.confidence : undefined);

type Mapped = { fields: Record<string, string | null>; evidence: ExtractionEvidence[]; confidence: Record<string, number>; warnings: string[] };
const emptyMapped = (): Mapped => ({ fields: {}, evidence: [], confidence: {}, warnings: [] });
function put(m: Mapped, key: string, value: string | null, azureName: string, field: unknown) {
  if (value === null) return;
  m.fields[key] = value;
  m.evidence.push({ field: key, page: pageOf(field), source: `Azure ${azureName}` });
  const c = confidenceOf(field);
  if (c !== undefined) m.confidence[key] = c;
}

const SEX: Record<string, string> = { F: "Female", M: "Male" };
const expectedDocType: Partial<Record<ExtractionCategory, RegExp>> = { Passport: /passport/, "Driving Licence": /driver(s)?licen[cs]e/ };

function mapIdDocument(doc: Json, category: ExtractionCategory): { mapped: Mapped; mismatch: boolean } {
  const m = emptyMapped();
  const docType = typeof doc.docType === "string" ? doc.docType.toLowerCase().replace(/[^a-z]/g, "") : "";
  const expected = expectedDocType[category];
  if (!expected || !expected.test(docType)) { m.warnings.push("The document type did not match the requested category."); return { mapped: m, mismatch: true }; }
  const f = isObject(doc.fields) ? doc.fields : {};
  put(m, "first_name", scalar(f.FirstName), "FirstName", f.FirstName);
  put(m, "last_name", scalar(f.LastName), "LastName", f.LastName);
  put(m, "dob", scalar(f.DateOfBirth), "DateOfBirth", f.DateOfBirth);
  const sex = scalar(f.Sex);
  if (sex && SEX[sex.toUpperCase()]) put(m, "gender", SEX[sex.toUpperCase()], "Sex", f.Sex);
  else if (sex) m.warnings.push("Sex value is not represented in the application and was not mapped.");
  if (category === "Passport") {
    put(m, "passport_number", scalar(f.DocumentNumber), "DocumentNumber", f.DocumentNumber);
    put(m, "passport_expiry", scalar(f.DateOfExpiration), "DateOfExpiration", f.DateOfExpiration);
    if (scalar(f.Nationality) || scalar(f.CountryRegion) || scalar(f.Country)) m.warnings.push("Country codes were not converted to application country names; enter them manually.");
  } else if (isObject(f.Address)) {
    const address = isObject(f.Address.valueAddress) ? f.Address.valueAddress : null;
    if (address) {
      const street = typeof address.streetAddress === "string" ? address.streetAddress : [address.houseNumber, address.road ?? address.streetName].filter((x) => typeof x === "string" && x).join(" ");
      if (String(address.countryRegion ?? "").toUpperCase() === "AUS") {
        m.fields.address_type = "Australian Address"; m.evidence.push({ field: "address_type", page: pageOf(f.Address), source: "Azure Address" });
        put(m, "au_street", street || null, "Address", f.Address);
        put(m, "au_suburb", typeof address.city === "string" ? address.city : null, "Address", f.Address);
        put(m, "au_state", typeof address.state === "string" ? address.state : null, "Address", f.Address);
        put(m, "au_zip", typeof address.postalCode === "string" ? address.postalCode : null, "Address", f.Address);
      } else m.warnings.push("Address is not an Australian address and was not mapped.");
    } else m.warnings.push("Address was not structured and was not mapped.");
  }
  return { mapped: m, mismatch: false };
}

const known = new Set<string>(EXTRACTION_FIELD_NAMES);
function mapCustomModel(doc: Json): Mapped {
  const m = emptyMapped();
  const f = isObject(doc.fields) ? doc.fields : {};
  for (const [name, field] of Object.entries(f)) if (known.has(name)) put(m, name, scalar(field), name, field);
  return m;
}

// ---- adapter ---------------------------------------------------------------------------

export function createAzureProvider(options: AzureProviderOptions): DocumentExtractionProvider {
  const origin = normaliseEndpoint(options.endpoint);
  if (!(options.apiKey ?? "").trim()) throw new AzureConfigurationError("EF_AZURE_DOCUMENT_API_KEY");
  const apiVersion = options.apiVersion ?? AZURE_DEFAULT_API_VERSION;
  if (!API_VERSION.test(apiVersion)) throw new AzureConfigurationError("EF_AZURE_DOCUMENT_API_VERSION");
  for (const modelId of Object.values(options.modelMap)) if (!AZURE_MODEL_ID.test(modelId ?? "")) throw new AzureConfigurationError("EF_AZURE_DOCUMENT_MODEL");
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 90_000;
  const maxPolls = options.maxPolls ?? 20;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  return {
    id: AZURE_PROVIDER_ID,
    model: `azure-di-${apiVersion}`,
    async extract(request: ExtractionRequest): Promise<ExtractionOutcome> {
      const cancelled = () => failure("cancelled", "Extraction was cancelled.", false);
      if (request.signal.aborted) return cancelled();
      const modelId = options.modelMap[request.category];
      if (!modelId) return failure("validation", "No Azure model is configured for this document category.", false);
      const call = options.fetch ?? fetch;
      const base = `${origin}/documentintelligence/documentModels/${modelId}`;
      const resultUrl = (id: string) => `${base}/analyzeResults/${id}?api-version=${apiVersion}`;
      const send = async (url: string, init: RequestInit): Promise<Response | ExtractionOutcome> => {
        try {
          return await call(url, { ...init, signal: AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs)]), headers: { "Ocp-Apim-Subscription-Key": options.apiKey, ...(init.headers as Record<string, string> | undefined) } });
        } catch (error) {
          if (request.signal.aborted) return cancelled();
          return (error as Error)?.name === "TimeoutError" ? failure("timeout", "The extraction provider timed out.", true) : failure("network", "The extraction provider could not be reached.", true);
        }
      };
      const httpFailure = (status: number): ExtractionOutcome => {
        if (status === 429) return failure("rate_limit", "The extraction provider returned 429.", true);
        if (status >= 500) return failure("provider", `The extraction provider returned ${status}.`, true);
        if ([400, 413, 415, 422].includes(status)) return failure("validation", "The provider rejected the document as unreadable.", false);
        return failure("provider", `The extraction provider returned ${status}.`, false);
      };
      const asOutcome = (value: Response | ExtractionOutcome): ExtractionOutcome | null => (value instanceof Response ? null : value);

      let resultId = request.resumeOperationId && RESULT_ID.test(request.resumeOperationId) ? request.resumeOperationId : null;
      let wait = MIN_POLL_MS;
      let resumed = resultId !== null;
      const deadline = now() + totalTimeoutMs;
      let polls = 0, transient = 0;

      for (;;) {
        if (!resultId) {
          const submitted = await send(`${base}:analyze?_overload=analyzeDocument&api-version=${apiVersion}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base64Source: b64(request.bytes) }) });
          const early = asOutcome(submitted); if (early) return early;
          const response = submitted as Response;
          if (response.status !== 202) return response.ok ? failure("schema", "The extraction provider returned an unexpected response.", true) : httpFailure(response.status);
          let location: URL;
          try { location = new URL(response.headers.get("Operation-Location") ?? ""); } catch { return failure("schema", "The extraction provider returned an incomplete response.", true); }
          const match = /^\/documentintelligence\/documentModels\/([^/]+)\/analyzeResults\/([A-Za-z0-9_-]{1,128})$/.exec(location.pathname);
          if (location.origin !== origin || !match || match[1] !== modelId) return failure("provider", "The extraction provider returned an unexpected operation location.", false);
          resultId = match[2];
          wait = retryAfterMs(response) ?? MIN_POLL_MS;
          try { await request.onOperationAccepted?.(resultId); } catch { /* a lost receipt only costs a repeat analysis on retry */ }
        }
        // Poll until a terminal state, bounded by poll count and total deadline.
        while (true) {
          if (polls >= maxPolls || now() + wait > deadline) return failure("timeout", "The extraction provider timed out.", true);
          await sleep(wait, request.signal);
          if (request.signal.aborted) return cancelled();
          polls += 1;
          const polled = await send(resultUrl(resultId), { method: "GET" });
          const early = asOutcome(polled); if (early) return early;
          const response = polled as Response;
          wait = retryAfterMs(response) ?? POLL_BACKOFF_MS[Math.min(polls, POLL_BACKOFF_MS.length - 1)];
          if (response.status === 404 && resumed) { resultId = null; resumed = false; break; }
          if (response.status === 429 || response.status >= 500) {
            if (++transient > MAX_TRANSIENT_POLL_ERRORS) return httpFailure(response.status);
            continue;
          }
          if (!response.ok) return httpFailure(response.status);
          transient = 0;
          let body: Json;
          try { const parsed = await response.json(); if (!isObject(parsed)) throw new Error("shape"); body = parsed; } catch { return failure("schema", "The extraction provider returned an incomplete structured response.", true); }
          if (body.status === "notStarted" || body.status === "running") continue;
          if (body.status === "failed") {
            const code = isObject(body.error) && typeof body.error.code === "string" ? body.error.code : "";
            return PERMANENT_ANALYSIS_ERRORS.test(code) ? failure("validation", "The provider rejected the document as unreadable.", false) : failure("provider", "The extraction provider could not analyse the document.", true);
          }
          if (body.status !== "succeeded" || !isObject(body.analyzeResult)) return failure("schema", "The extraction provider returned an incomplete structured response.", true);
          return toOutcome(body.analyzeResult, request, modelId, resultId, apiVersion);
        }
      }
    },
  };
}

function toOutcome(result: Json, request: ExtractionRequest, modelId: string, resultId: string, apiVersion: string): ExtractionOutcome {
  if (typeof result.modelId === "string" && result.modelId !== modelId) return failure("schema", "The extraction response did not match the requested model.", false);
  if (!Array.isArray(result.documents)) return failure("schema", "The extraction response did not match the required schema.", true);
  const usage = { provider: AZURE_PROVIDER_ID, model: modelId, apiVersion, pages: Array.isArray(result.pages) ? result.pages.length : null };
  const doc = result.documents.find(isObject);
  if (!doc) return { ok: true, detectedType: "unknown", categoryMismatch: false, fields: {}, evidence: [], warnings: ["No document was recognised."], operationId: resultId, usage };
  const isId = modelId.startsWith("prebuilt-idDocument");
  const { mapped, mismatch } = isId ? mapIdDocument(doc, request.category) : { mapped: mapCustomModel(doc), mismatch: false };
  const confidence = validConfidence(mapped.confidence);
  const warnings = [...mapped.warnings, ...(result.documents.filter(isObject).length > 1 ? ["Several documents were found; only the first was used."] : [])];
  return {
    ok: true, detectedType: typeof doc.docType === "string" ? doc.docType : request.category, categoryMismatch: mismatch,
    fields: mismatch ? {} : mapped.fields, evidence: mismatch ? [] : mapped.evidence, ...(confidence && !mismatch ? { confidence } : {}),
    warnings, operationId: resultId, usage,
  };
}
