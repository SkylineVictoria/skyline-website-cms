// ABR ABN Lookup JSON service (owner brief 2026-11-19, ABN prefill). The Australian Business Register's web service
// https://abr.business.gov.au/json/AbnDetails.aspx?abn=...&guid=... answers with JSONP; the GUID is the registered party's key, kept as the
// Edge Function secret EF_ABR_GUID (ABR_GUID is read too) and never sent to the browser. Without a GUID nothing here is called: the lookup
// reports `not_configured` and Add business keeps its earlier behaviour. Runtime-neutral (the function, the offline tests and the CMS types).
import { lookupAgencyAbn, normalizeAbn, validateAbn, type AgencyAbnDetails } from "./abn.ts";

/** What staff confirm on Add business and the F04 prefill uses: the register's values, editable before the business is saved. */
export interface AbrDetails {
  abn: string;
  acn: string;
  /** "Active", "Cancelled", ... as the register writes it. */
  abnStatus: string;
  active: boolean;
  /** ISO date the current status took effect (registration date of an active ABN). */
  statusFrom: string;
  entityName: string;
  entityType: string;
  /** Registered business names, the register's order (trading names). */
  businessNames: string[];
  gstRegistered: boolean;
  /** ISO date GST registration took effect, when registered. */
  gstFrom: string;
  state: string;
  postcode: string;
  sourceUrl: string;
}
export type AbrOutcome =
  | { ok: true; details: AbrDetails; raw: Record<string, unknown>; fetchedAt: string }
  | { ok: false; reason: "not_configured" | "invalid" | "not_found" | "unavailable"; message: string };

const MESSAGES = {
  not_configured: "ABN Lookup is not set up yet.",
  not_found: "The government register has no business with this ABN. Check the number.",
  unavailable: "ABN Lookup is not answering right now. You can still add the business: type its details, and the application form goes without the ABN prefill.",
} as const;

const str = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const isoDate = (value: unknown) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(value)); return m ? m[1] : ""; };

/** The JSON inside the register's JSONP answer ("callback({...})"), or the plain JSON when no wrapper is sent. */
export function unwrapAbrJsonp(body: string): Record<string, unknown> {
  const text = String(body ?? "").trim();
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("ABN Lookup returned an answer that could not be read.");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ABN Lookup returned an answer that could not be read.");
  return parsed as Record<string, unknown>;
}

/** The register's answer for one ABN, as AbrDetails; a message from the register ("No records found", a bad GUID) is a failure. */
export function parseAbrDetails(raw: Record<string, unknown>, abn: string): AbrOutcome {
  const message = str(raw.Message);
  const found = normalizeAbn(str(raw.Abn));
  if (!found || found !== abn) {
    // A GUID the register does not recognise is a set-up problem, not a missing business.
    if (/guid/i.test(message)) return { ok: false, reason: "unavailable", message: `ABN Lookup refused the request (${message.slice(0, 120)}). Check the EF_ABR_GUID secret.` };
    return { ok: false, reason: "not_found", message: MESSAGES.not_found };
  }
  const status = str(raw.AbnStatus);
  const names = Array.isArray(raw.BusinessName) ? raw.BusinessName.map(str).filter(Boolean) : [];
  const details: AbrDetails = {
    abn, acn: str(raw.Acn).replace(/\D/g, ""), abnStatus: status, active: /^active$/i.test(status), statusFrom: isoDate(raw.AbnStatusEffectiveFrom),
    entityName: str(raw.EntityName), entityType: str(raw.EntityTypeName), businessNames: [...new Set(names)],
    gstRegistered: isoDate(raw.Gst) !== "", gstFrom: isoDate(raw.Gst), state: str(raw.AddressState).toUpperCase(), postcode: str(raw.AddressPostcode).replace(/\D/g, "").slice(0, 4),
    sourceUrl: `https://abr.business.gov.au/ABN/View?abn=${abn}`,
  };
  if (!details.entityName) return { ok: false, reason: "not_found", message: MESSAGES.not_found };
  return { ok: true, details, raw, fetchedAt: new Date().toISOString() };
}

/**
 * Looks one ABN up. The checksum is checked first (no call for a mistyped number); no GUID: not_configured; a timeout, a network error
 * or a non-200 answer: unavailable. Never throws.
 */
export async function lookupAbr(value: string, guid: string | null | undefined, request: typeof fetch = fetch, timeoutMs = 8000): Promise<AbrOutcome> {
  const abn = normalizeAbn(value).replace(/\D/g, "");
  const problem = validateAbn(abn);
  if (problem) return { ok: false, reason: "invalid", message: problem };
  const key = String(guid ?? "").trim();
  if (!key) return { ok: false, reason: "not_configured", message: MESSAGES.not_configured };
  try {
    const url = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${abn}&callback=c&guid=${encodeURIComponent(key)}`;
    const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, reason: "unavailable", message: MESSAGES.unavailable };
    return parseAbrDetails(unwrapAbrJsonp(await response.text()), abn);
  } catch {
    return { ok: false, reason: "unavailable", message: MESSAGES.unavailable };
  }
}

/** The values staff confirmed on Add business (the register's, possibly edited), as kept on the business (agencies.abr_confirmed). */
export interface AbrConfirmed {
  legalEntity: string;
  tradingName: string;
  gstRegistered: boolean | null;
  state: string;
  postcode: string;
  /** A cancelled ABN added anyway: the staff member's reason. */
  cancelledOverride?: string;
}
export const F04_TITLES = ["Mr", "Mrs", "Ms", "Miss", "Dr", "Other"] as const;

/**
 * The F04 prefill from the register (owner brief): Legal Entity = EntityName; Trading Name and Agent/Agency Name = the chosen business
 * name (fallback EntityName); ABN/ACN; GST Registered; State; postcode in the "Province / postcode" box (Suburb is left for the contact);
 * Country = Australia; Year founded = year of the ABN's status date. From Add business:
 * the contact's given and family name, email and phone. Everything else is left for the contact. Staff edits win over the register.
 */
export function abrApplicationValues(input: {
  details: AbrDetails | null; confirmed: AbrConfirmed | null;
  contact: { givenName: string; familyName: string; email: string; phone: string };
}): Record<string, string> {
  const d = input.details, c = input.confirmed;
  const legal = str(c?.legalEntity) || d?.entityName || "";
  const trading = str(c?.tradingName) || d?.businessNames[0] || legal;
  const gst = c && c.gstRegistered !== null && c.gstRegistered !== undefined ? c.gstRegistered : d ? d.gstRegistered : null;
  // F04 wizard (2026-11-19): the ABN box holds the ABN only; the ACN is its own answer (printed with the MARN in the registration box).
  const abn = d?.abn ?? "";
  const values: Record<string, string> = {
    agent_legal_entity: legal, agent_trading_name: trading, agent_agency_name: trading, agent_abn: abn, agent_acn: d?.acn && d.acn.length === 9 ? printAcn(d.acn) : "",
    agent_gst_registered: gst === null ? "" : gst ? "YES" : "NO",
    office_state: str(c?.state) || d?.state || "", office_province: str(c?.postcode) || d?.postcode || "", office_country: "Australia",
    agent_year_founded: (d?.statusFrom ?? "").slice(0, 4),
    contact_given_name: str(input.contact.givenName), contact_family_name: str(input.contact.familyName),
    contact_email: str(input.contact.email).toLowerCase(), contact_phone: str(input.contact.phone),
  };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
}

/** The keys of the F04 the prefill may fill (anything else from our records is left blank for the contact). */
export const ABR_PREFILL_KEYS = ["agent_legal_entity", "agent_trading_name", "agent_agency_name", "agent_abn", "agent_acn", "agent_gst_registered", "office_state", "office_province", "office_country",
  "agent_year_founded", "contact_given_name", "contact_family_name", "contact_email", "contact_phone"] as const;

/** "603 584 676": an ACN in its printed groups (other text unchanged). */
export const printAcn = (acn: string) => { const d = String(acn ?? "").replace(/\D/g, ""); return d.length === 9 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : String(acn ?? "").trim(); };

/** The public ABN Lookup page's details (the fallback lookup, no GUID) in the JSON service's shape, so the F04 prefill has one rule. */
export function pageToAbrDetails(page: AgencyAbnDetails): AbrDetails {
  const status = str(page.abnStatus).replace(/\s+from\b.*$/i, "");
  return {
    abn: page.abn, acn: str(page.acn).replace(/\D/g, ""), abnStatus: status, active: /^active$/i.test(status), statusFrom: page.statusFrom ?? "", entityName: str(page.legalName),
    entityType: str(page.entityType), businessNames: [...new Set((page.businessNames ?? []).map(str).filter(Boolean))], gstRegistered: /^registered/i.test(page.gstStatus ?? ""),
    gstFrom: page.gstFrom ?? "", state: str(page.state).toUpperCase(), postcode: str(page.postcode), sourceUrl: page.sourceUrl,
  };
}

/**
 * What the register says about the business, shown read-only in the F04 wizard's Company summary and kept on the business profile
 * (agencies.profile.abr_facts). No box on the PDF.
 */
export interface AbrFacts { abn: string; acn: string; abnStatus: string; statusFrom: string; entityName: string; entityType: string; gstRegistered: boolean; gstFrom: string; sourceUrl: string; fetchedAt: string }
export function abrFacts(d: AbrDetails, fetchedAt: string): AbrFacts {
  return { abn: d.abn, acn: d.acn, abnStatus: d.abnStatus, statusFrom: d.statusFrom, entityName: d.entityName, entityType: d.entityType, gstRegistered: d.gstRegistered, gstFrom: d.gstFrom, sourceUrl: d.sourceUrl, fetchedAt };
}
/** "07 Jan 2015" for an ISO date. */
export function abrDateWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1] ?? ""} ${m[1]}` : "";
}
/** The facts as the Company summary words them: "Active from 07 Jan 2015", "Australian Private Company", "GST registered from 07 Jan 2015". */
export function abrFactLines(f: Partial<AbrFacts> | null | undefined): Array<{ label: string; value: string }> {
  if (!f) return [];
  const lines: Array<{ label: string; value: string }> = [];
  if (f.abnStatus) lines.push({ label: "ABN status", value: `${f.abnStatus}${f.statusFrom ? ` from ${abrDateWords(f.statusFrom)}` : ""}` });
  if (f.entityType) lines.push({ label: "Entity type", value: f.entityType });
  lines.push({ label: "GST", value: f.gstRegistered ? `GST registered${f.gstFrom ? ` from ${abrDateWords(f.gstFrom)}` : ""}` : "Not registered for GST" });
  return lines;
}

/** Looks the ABN up for the F04: the JSON service when the GUID is set, otherwise the public page. Never throws (null when neither answers). */
export async function lookupAbrAny(abn: string, guid: string | null | undefined, request: typeof fetch = fetch): Promise<{ details: AbrDetails; fetchedAt: string } | null> {
  if (String(guid ?? "").trim()) {
    const outcome = await lookupAbr(abn, guid, request);
    if (outcome.ok) return { details: outcome.details, fetchedAt: outcome.fetchedAt };
  }
  try { return { details: pageToAbrDetails(await lookupAgencyAbn(abn, request)), fetchedAt: new Date().toISOString() }; } catch { return null; }
}

/** Signing-time checks of a signed F04 (owner brief): the title is one of the list; the two referees have different emails. */
export function checkApplicationAnswers(answers: Record<string, string>): { error: string | null; warnings: string[] } {
  const title = str(answers.contact_title);
  if (title && !(F04_TITLES as readonly string[]).includes(title)) return { error: `Choose the contact's title from the list (${F04_TITLES.join(", ")}).`, warnings: [] };
  const e1 = str(answers.ref1_email).toLowerCase(), e2 = str(answers.ref2_email).toLowerCase();
  if (e1 && e2 && e1 === e2) return { error: "The two references need different email addresses: each referee gets their own form.", warnings: [] };
  const n1 = str(answers.ref1_contact_name).toLowerCase(), n2 = str(answers.ref2_contact_name).toLowerCase();
  return { error: null, warnings: n1 && n2 && n1 === n2 ? ["Both references have the same contact name. Check that they are two different people."] : [] };
}
