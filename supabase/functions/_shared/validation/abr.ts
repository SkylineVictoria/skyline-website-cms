// ABR ABN Lookup JSON service (owner brief 2026-11-19, ABN prefill). The Australian Business Register's web service
// https://abr.business.gov.au/json/AbnDetails.aspx?abn=...&guid=... answers with JSONP; the GUID is the registered party's key, kept as the
// Edge Function secret EF_ABR_GUID (ABR_GUID is read too) and never sent to the browser. Without a GUID nothing here is called: the lookup
// reports `not_configured` and Add business keeps its earlier behaviour. Runtime-neutral (the function, the offline tests and the CMS types).
import { lookupAgencyAbn, normalizeAbn, validateAbn, type AgencyAbnDetails } from "./abn.ts";
import { DEFAULT_DIAL, parseStoredPhone, validatePhone } from "./identifiers.ts";

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
 * name (fallback EntityName); ABN/ACN; GST Registered; State; postcode in the Suburb box (never Province; the suburb is the contact's);
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
  // Round 3: no postcode alone in the Suburb box (the suburb itself is the contact's; f04Prefill joins the postcode to a named suburb).
  const values: Record<string, string> = {
    agent_legal_entity: legal, agent_trading_name: trading, agent_agency_name: trading, agent_abn: abn, agent_acn: d ? printAcn(resolveAcn({ abn: d.abn, acn: d.acn, entityType: d.entityType }).acn) : "",
    agent_gst_registered: gst === null ? "" : gst ? "YES" : "NO",
    // No postcode box on the F04: the postcode is printed in the Suburb box (never Province); the suburb itself is the contact's.
    office_state: str(c?.state) || d?.state || "", office_country: "Australia",
    agent_year_founded: d ? abrYearFounded(d.statusFrom, d.abnStatus) : "",
    contact_given_name: str(input.contact.givenName), contact_family_name: str(input.contact.familyName),
    contact_email: str(input.contact.email).toLowerCase(), contact_phone: str(input.contact.phone),
  };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
}

/** The keys of the F04 the prefill may fill (anything else from our records is left blank for the contact). */
export const ABR_PREFILL_KEYS = ["agent_legal_entity", "agent_trading_name", "agent_agency_name", "agent_abn", "agent_acn", "agent_gst_registered", "office_state", "office_country",
  "agent_year_founded", "contact_given_name", "contact_family_name", "contact_email", "contact_phone"] as const;

/**
 * Year founded from the ABN (round 3, 2026-11-19): the year of the date an active ABN took effect ("Active from 07 Jan 2015" -> "2015").
 * A cancelled ABN's date is its cancellation, so it gives no year. An unknown status with a date counts as active (facts kept before the status was).
 */
export function abrYearFounded(statusFrom: string | null | undefined, status?: string | null): string {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(statusFrom ?? "").trim());
  if (!m) return "";
  return str(status) && !/^active$/i.test(str(status)) ? "" : m[1];
}
/** 1999 / 2000: the ABN scheme started then, so the business may be older than its ABN. */
export const yearMayPredateAbn = (year: string | null | undefined) => /^(1999|2000)$/.test(String(year ?? "").trim());
export const YEAR_BEFORE_ABN_HINT = "Business may be older than its ABN; edit if needed.";

/** "603 584 676" / "603-584-676" -> "603584676": the ACN as stored and checked (other characters left for the check to refuse). */
export const acnDigits = (acn: string | null | undefined) => String(acn ?? "").replace(/[\s-]/g, "");
/** ASIC's ACN check digit: weights 8..1 on the first eight digits; the ninth is (10 - sum mod 10) mod 10. */
export function acnValid(acn: string | null | undefined): boolean {
  const d = String(acn ?? "").replace(/\D/g, "");
  if (d.length !== 9) return false;
  const sum = [...d.slice(0, 8)].reduce((t, c, i) => t + Number(c) * (8 - i), 0);
  return (10 - (sum % 10)) % 10 === Number(d[8]);
}
/**
 * A company's ACN from its ABN (follow-up 2026-11-18): an ABN issued to a company is two check digits then the ACN, so when the register
 * gives no ACN the last nine digits are used, only for an entity type that is a company and only when they pass the ACN check digit.
 */
export function acnFromAbn(abn: string | null | undefined, entityType: string | null | undefined): string {
  const digits = String(abn ?? "").replace(/\D/g, "");
  if (digits.length !== 11 || !isCompanyEntity(entityType)) return "";
  const acn = digits.slice(2);
  return acnValid(acn) ? acn : "";
}
/**
 * A company in the register's words (Australian Private / Public Company and other "... Company" types), never a trust, partnership,
 * sole trader or individual. The same rule as public.acn_company_entity (migration 20261120113517).
 */
export function isCompanyEntity(entityType: string | null | undefined): boolean {
  const type = String(entityType ?? "");
  return /company/i.test(type) && !/(trust|partnership|sole\s*trader|individual)/i.test(type);
}
/**
 * The business's ACN (2026-11-20, owner): the ASIC number ABN Lookup gives ("register"); else, for a company only, the last nine digits of
 * its ABN when they pass the ACN check ("derived"); else none, so sole traders, partnerships and trusts stay blank (and editable), never
 * derived. The same rule as public.acn_resolve.
 */
export function resolveAcn(input: { abn?: string | null; acn?: string | null; entityType?: string | null }): { acn: string; source: "register" | "derived" | null } {
  const register = String(input.acn ?? "").replace(/\D/g, "");
  if (acnValid(register)) return { acn: register, source: "register" };
  const derived = acnFromAbn(input.abn, input.entityType);
  return derived ? { acn: derived, source: "derived" } : { acn: "", source: null };
}
/** The agreement's "(ABN ...)" blank: "49 004 028 077, ACN 004 028 077" when the business has an ACN, else the ABN alone. */
export function abnWithAcn(abn: string | null | undefined, acn: string | null | undefined): string {
  const a = String(abn ?? "").replace(/\D/g, ""), c = String(acn ?? "").replace(/\D/g, "");
  const abnText = a.length === 11 ? `${a.slice(0, 2)} ${a.slice(2, 5)} ${a.slice(5, 8)} ${a.slice(8)}` : String(abn ?? "").trim();
  return acnValid(c) ? `${abnText}, ACN ${printAcn(c)}` : abnText;
}
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
/** The facts kept on the business profile as register details (no business names, no postcode): the F04 prefill when no fresh lookup is at hand. */
export function factsToDetails(f: Partial<AbrFacts> | null | undefined): AbrDetails | null {
  if (!f || !str(f.abn)) return null;
  const status = str(f.abnStatus);
  return { abn: str(f.abn), acn: str(f.acn).replace(/\D/g, ""), abnStatus: status, active: /^active$/i.test(status), statusFrom: str(f.statusFrom), entityName: str(f.entityName),
    entityType: str(f.entityType), businessNames: [], gstRegistered: f.gstRegistered === true, gstFrom: str(f.gstFrom), state: "", postcode: "", sourceUrl: str(f.sourceUrl) };
}
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

/** Where the register's answers are cached by ABN (public.abr_businesses, 30 days). Either call may fail: the lookup goes on without it. */
export interface AbrCache { get(abn: string): Promise<(AbrDetails & { fetchedAt?: string }) | null>; put(details: AbrDetails): Promise<void> }
/**
 * The F04's lookup (2026-11-19): the cached answer when there is one; otherwise the register (JSON service with the GUID, else the public
 * page), and the answer is cached so later sends and opens do not ask again. Never throws.
 */
export async function lookupAbrCached(abn: string, guid: string | null | undefined, cache: AbrCache | null, request: typeof fetch = fetch): Promise<{ details: AbrDetails; fetchedAt: string; cached: boolean } | null> {
  const digits = normalizeAbn(abn).replace(/\D/g, "");
  if (validateAbn(digits)) return null;
  if (cache) {
    try {
      const hit = await cache.get(digits);
      if (hit?.entityName) {
        const { fetchedAt, ...details } = hit;
        return { details: { ...details, businessNames: Array.isArray(details.businessNames) ? details.businessNames : [] }, fetchedAt: String(fetchedAt ?? new Date().toISOString()), cached: true };
      }
    } catch { /* the register instead */ }
  }
  const found = await lookupAbrAny(digits, guid, request);
  if (!found) return null;
  if (cache) { try { await cache.put(found.details); } catch { /* not cached this time */ } }
  return { ...found, cached: false };
}

/**
 * A phone as E.164 ("+61412345678"): an international number with a known code, or an Australian number written nationally (0412 345 678,
 * 03 9123 4567). Anything else, or a number of the wrong length: null.
 */
export function phoneE164(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parsed = parseStoredPhone(text) ?? (/^0\d{9}$/.test(text.replace(/[\s().-]/g, "")) ? { dial: DEFAULT_DIAL, national: text.replace(/[\s().-]/g, "").slice(1) } : null);
  if (!parsed || validatePhone(parsed.dial, parsed.national)) return null;
  return `+${parsed.dial}${parsed.national}`;
}
const personName = (value: unknown) => str(value).toLowerCase().replace(/[^a-zÀ-ɏ ]/g, "").replace(/\s+/g, " ").trim();

/**
 * Signing-time checks of a signed F04 (owner brief, 2026-11-19): the title is one of the list; each referee's phone is a full number with
 * its country code; the two referees have different emails and phones; neither referee is the applicant (their contact email, phone or
 * name). The same name on both referees is only a warning.
 */
export function checkApplicationAnswers(answers: Record<string, string>): { error: string | null; warnings: string[] } {
  const title = str(answers.contact_title);
  if (title && !(F04_TITLES as readonly string[]).includes(title)) return { error: `Choose the contact's title from the list (${F04_TITLES.join(", ")}).`, warnings: [] };
  const e1 = str(answers.ref1_email).toLowerCase(), e2 = str(answers.ref2_email).toLowerCase();
  if (e1 && e2 && e1 === e2) return { error: "The two references need different email addresses: each referee gets their own form.", warnings: [] };
  const phones: Array<string | null> = [];
  for (const n of [1, 2]) {
    const raw = str(answers[`ref${n}_phone`]);
    const e164 = phoneE164(raw);
    if (raw && !e164) return { error: `Enter reference ${n}'s phone with its country code, for example +61 412 345 678.`, warnings: [] };
    phones.push(e164);
  }
  if (phones[0] && phones[0] === phones[1]) return { error: "The two references need different phone numbers.", warnings: [] };
  const myEmail = str(answers.contact_email).toLowerCase(), myPhone = phoneE164(answers.contact_phone);
  const myNames = [personName(`${str(answers.contact_given_name)} ${str(answers.contact_family_name)}`), personName(answers.declarant_name)].filter(Boolean);
  for (const n of [1, 2]) {
    const email = n === 1 ? e1 : e2, phone = phones[n - 1], name = personName(answers[`ref${n}_contact_name`]);
    const same = (email && myEmail && email === myEmail) ? "email address" : (phone && myPhone && phone === myPhone) ? "phone number" : (name && myNames.includes(name)) ? "name" : "";
    if (same) return { error: `Reference ${n} has your own ${same}. A referee must be someone other than you.`, warnings: [] };
  }
  const n1 = personName(answers.ref1_contact_name), n2 = personName(answers.ref2_contact_name);
  return { error: null, warnings: n1 && n2 && n1 === n2 ? ["Both references have the same contact name. Check that they are two different people."] : [] };
}
