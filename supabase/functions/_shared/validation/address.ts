// Pure Australian address helpers shared by the portal (src/), the address-search Edge Function and tests. No I/O.

export const AU_STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;

export interface AddressSuggestion { line: string; line2: string; suburb: string; state: string; postcode: string; country: "Australia" }

const POSTCODE_RANGES: Record<string, Array<[number, number]>> = {
  NSW: [[1000, 1999], [2000, 2599], [2619, 2899], [2921, 2999]],
  ACT: [[200, 299], [2600, 2618], [2900, 2920]],
  VIC: [[3000, 3999], [8000, 8999]],
  QLD: [[4000, 4999], [9000, 9999]],
  SA: [[5000, 5999]],
  WA: [[6000, 6797], [6800, 6999]],
  TAS: [[7000, 7999]],
  NT: [[800, 999]],
};

const STATE_NAMES: Record<string, string> = {
  "australian capital territory": "ACT", "new south wales": "NSW", "northern territory": "NT", "queensland": "QLD",
  "south australia": "SA", "tasmania": "TAS", "victoria": "VIC", "western australia": "WA",
};

/** A state code for a code or a full name; "" when it is neither (the saved text is then left alone). */
export function stateCode(raw: string): string {
  const text = String(raw ?? "").trim();
  const upper = text.toUpperCase();
  return (AU_STATES as readonly string[]).includes(upper) ? upper : STATE_NAMES[text.toLowerCase()] ?? "";
}

/** "" when the postcode is blank or fine; otherwise the message. Four digits, and inside the state's postcode ranges. */
export function postcodeProblem(state: string, postcode: string): string {
  const pc = String(postcode ?? "").trim();
  if (!pc) return "";
  if (!/^\d{4}$/.test(pc)) return "Postcode must be 4 digits.";
  const code = stateCode(state);
  if (!code) return "";
  const value = Number(pc);
  return POSTCODE_RANGES[code].some(([from, to]) => value >= from && value <= to) ? "" : `Postcode ${pc} does not match ${code}.`;
}

/* ------------------------------------------------------------- Same as student */

type Values = Record<string, unknown>;
const text = (values: Values, name: string): string => String(values[name] ?? "").trim();

/** The emergency contact address fields a "Same as student's address" copy writes, from the student's Australian or overseas address. */
export function copyStudentAddress(student: Values): Record<string, string> {
  const overseas = text(student, "address_type") === "Overseas Address";
  const from = overseas ? "ov" : "au";
  return {
    ec_in_au: overseas ? "No" : "Yes",
    ec_street: text(student, `${from}_street`),
    ec_line2: text(student, `${from}_line2`),
    ec_suburb: text(student, `${from}_suburb`),
    ec_state: text(student, `${from}_state`),
    ec_zip: text(student, `${from}_zip`),
    ec_country: text(student, `${from}_country`) || (overseas ? "" : "Australia"),
  };
}

/** What picking a suggestion writes: the five address fields of the group, plus the country only while it is still empty. */
export function suggestionValues(prefix: "au" | "ec", pick: AddressSuggestion, currentCountry: string): Record<string, string> {
  const out: Record<string, string> = {
    [`${prefix}_street`]: pick.line, [`${prefix}_line2`]: pick.line2, [`${prefix}_suburb`]: pick.suburb, [`${prefix}_state`]: pick.state, [`${prefix}_zip`]: pick.postcode,
  };
  if (!currentCountry.trim()) out[`${prefix}_country`] = "Australia";
  return out;
}

/* ---------------------------------------------------------------- Geoscape */

const TAIL = /^(.*),\s*([^,]+?)\s+(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\s+(\d{4})$/i;

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[\s\-'])([a-z])/g, (_m, lead: string, letter: string) => lead + letter.toUpperCase())
    .replace(/\b(\d+)([a-z])\b/g, (_m, digits: string, letter: string) => digits + letter.toUpperCase());
}

/** "UNIT 3, 12 SMITH ST, MELBOURNE VIC 3000" -> line "12 Smith St", line2 "Unit 3", suburb, state, postcode; null when it cannot be read. */
export function parseGeoscapeAddress(address: string): AddressSuggestion | null {
  const match = TAIL.exec(String(address ?? "").trim());
  if (!match) return null;
  const parts = match[1].split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return { line: titleCase(parts[parts.length - 1]), line2: titleCase(parts.slice(0, -1).join(", ")), suburb: titleCase(match[2]), state: match[3].toUpperCase(), postcode: match[4], country: "Australia" };
}

/** Up to six readable suggestions from the provider's `{ results: [{ formatted }] }` body; anything unreadable is dropped. */
export function parseGeoscapeResponse(body: unknown): AddressSuggestion[] {
  const list = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: AddressSuggestion[] = [];
  for (const item of list) {
    const parsed = parseGeoscapeAddress(String((item as { formatted?: unknown })?.formatted ?? ""));
    if (!parsed) continue;
    const key = JSON.stringify(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
    if (out.length === 6) break;
  }
  return out;
}

export type AddressSearchResult =
  | { kind: "ok"; suggestions: AddressSuggestion[]; attribution: string }
  | { kind: "unavailable"; reason: string };

/** Geoscape Verify Autocomplete (Australia). The key is sent raw in Authorization; the consumer secret is not used. */
export const GEOSCAPE_URL = "https://api.geoscape.com.au/v1/verify/autocomplete/AU";
export const MIN_QUERY = 4;
export const MAX_QUERY = 200;

/** One provider call. Never logs or stores the query or the results. Every fault is "unavailable" with a short reason code (never provider text or the key). */
export async function searchAddresses(query: string, key: string, fetchImpl: typeof fetch = fetch): Promise<AddressSearchResult> {
  if (!key.trim()) return { kind: "unavailable", reason: "missing_key" };
  const q = String(query ?? "").trim().slice(0, MAX_QUERY);
  if (q.length < MIN_QUERY) return { kind: "ok", suggestions: [], attribution: "" };
  let response: Response;
  try {
    response = await fetchImpl(GEOSCAPE_URL, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: q, maxResults: 6 }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return { kind: "unavailable", reason: name === "TimeoutError" || name === "AbortError" ? "provider_timeout" : "provider_network" };
  }
  // 429 is quota or rate limiting; like every status it is only a reason code on the server.
  if (!response.ok) return { kind: "unavailable", reason: `provider_status_${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unavailable", reason: "parse_error" };
  }
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return { kind: "unavailable", reason: "parse_error" };
  const suggestions = parseGeoscapeResponse(body);
  // Results the provider returned but none readable is a shape we do not know; no results at all is simply no match.
  if (results.length > 0 && suggestions.length === 0) return { kind: "unavailable", reason: "parse_error" };
  const attribution = (body as { attribution?: unknown }).attribution;
  return { kind: "ok", suggestions, attribution: typeof attribution === "string" ? attribution.slice(0, 500) : "" };
}

/** A sliding-window limit per caller. In memory: it holds per function instance, the best an address lookup can have without a table. */
export function takeSlot(hits: Map<string, number[]>, caller: string, now: number, limit: number, windowMs: number): boolean {
  const recent = (hits.get(caller) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) {
    hits.set(caller, recent);
    return false;
  }
  recent.push(now);
  hits.set(caller, recent);
  return true;
}
