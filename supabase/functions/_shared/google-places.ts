// Google Places (New) lookup for a business's public details (owner 2026-11-24: "fill all info whatever you can find online for this
// business so no manual work"). Server side only: the key is the Google Maps connection in Integrations > Connections (Vault; the secret
// EF_GOOGLE_MAPS_KEY is only the fallback) and never reaches the browser.
// One Text Search call (https://places.googleapis.com/v1/places:searchText) with a field mask of exactly the fields used; the best match
// is the place whose name is closest to the register's names, in the same state (and, as a bonus, the same postcode). No key, an error,
// a timeout or no good match: nothing is filled and everything works as before. Runtime-neutral (the function and the offline tests).

export const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
/** Only the fields we read (billing follows the field mask). */
export const PLACES_FIELD_MASK = ["places.id", "places.displayName", "places.formattedAddress", "places.addressComponents", "places.websiteUri",
  "places.nationalPhoneNumber", "places.internationalPhoneNumber", "places.googleMapsUri", "places.businessStatus"].join(",");
export const PLACES_TIMEOUT_MS = 6000;
/** The lowest match accepted when the Business Rule agents.google_maps_match_percent cannot be read. */
export const DEFAULT_MATCH_PERCENT = 60;

/** One address component as Places (New) returns it. */
export interface PlaceAddressComponent { longText?: string; shortText?: string; types?: string[] }
/** One place of a Text Search answer (the fields of PLACES_FIELD_MASK). */
export interface RawPlace {
  id?: string; displayName?: { text?: string }; formattedAddress?: string; addressComponents?: PlaceAddressComponent[]; websiteUri?: string;
  nationalPhoneNumber?: string; internationalPhoneNumber?: string; googleMapsUri?: string; businessStatus?: string;
}
/** What we keep and fill from a place. */
export interface PlaceDetails {
  placeId: string; name: string; formattedAddress: string;
  street: string; suburb: string; state: string; postcode: string; country: string;
  website: string; phone: string; phoneInternational: string; mapsUri: string; businessStatus: string;
  /** 0..100: how well the place matched the business (name, state, postcode). */
  matchPercent: number;
}
export interface PlaceSearchInput {
  /** The names the business is known by: trading name first, then the legal name and other registered names. */
  names: string[];
  state?: string | null;
  postcode?: string | null;
}
export type PlacesOutcome =
  | { ok: true; place: PlaceDetails; query: string; fetchedAt: string }
  | { ok: false; reason: "not_configured" | "not_found" | "unavailable"; message: string; query?: string };

const MESSAGES = {
  not_configured: "Google Maps lookup is not set up yet.",
  not_found: "No matching business was found on Google Maps. Type the address by hand.",
  unavailable: "Google Maps is not answering right now. Type the address by hand.",
} as const;
const STATES = new Set(["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"]);
const STATE_NAMES: Record<string, string> = { "australian capital territory": "ACT", "new south wales": "NSW", "northern territory": "NT", queensland: "QLD",
  "south australia": "SA", tasmania: "TAS", victoria: "VIC", "western australia": "WA" };

// deno-lint-ignore no-control-regex
const str = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : ""); // eslint-disable-line no-control-regex

/** An Australian state as its abbreviation ("Victoria" / "VIC" -> "VIC"); anything else "". */
export function stateCode(value: string | null | undefined): string {
  const t = str(value);
  if (STATES.has(t.toUpperCase())) return t.toUpperCase();
  return STATE_NAMES[t.toLowerCase()] ?? "";
}

/** The query sent to Text Search: the name, the state and "Australia" (the postcode narrows nothing useful for a name search). */
export function placesQuery(name: string, state?: string | null): string {
  return [str(name), stateCode(state), "Australia"].filter(Boolean).join(" ");
}

/**
 * The address components as the F04 office row needs them: street (unit / street number / street: "5/123 Smith Street"), suburb (locality),
 * state (abbreviation), postcode, country.
 */
export function parseAddressComponents(components: PlaceAddressComponent[] | null | undefined): { street: string; suburb: string; state: string; postcode: string; country: string } {
  const list = Array.isArray(components) ? components : [];
  const find = (type: string) => list.find((c) => Array.isArray(c?.types) && c.types.includes(type));
  const long = (type: string) => str(find(type)?.longText);
  const short = (type: string) => str(find(type)?.shortText) || long(type);
  const unit = long("subpremise"), number = long("street_number"), route = long("route");
  let street = [number, route].filter(Boolean).join(" ");
  if (unit && number) street = `${unit}/${street}`;
  else if (unit) street = [unit, street].filter(Boolean).join(" ");
  if (!street) street = long("premise");
  const suburb = long("locality") || long("postal_town") || long("sublocality_level_1") || long("sublocality");
  return { street, suburb, state: stateCode(short("administrative_area_level_1")) || short("administrative_area_level_1"), postcode: long("postal_code").replace(/\D/g, "").slice(0, 4) || long("postal_code"), country: long("country") };
}

const STOP_WORDS = new Set(["pty", "ltd", "limited", "proprietary", "the", "inc", "incorporated", "co", "company", "corp", "corporation", "australia", "australian", "aus", "au", "trust", "trustee", "for", "as", "of", "atf"]);
/** The words of a business name that tell it apart ("ABC Education Pty Ltd" -> ["abc", "education"]). */
export function nameTokens(name: string | null | undefined): string[] {
  return str(name).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP_WORDS.has(w) && w !== "and");
}
/**
 * How alike two business names are, 0..1: the Dice coefficient of their distinguishing words; a name of at least two words wholly inside
 * the other ("Global Education" in "Global Education Consultants") counts as 0.85 at least.
 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const x = [...new Set(nameTokens(a))], y = [...new Set(nameTokens(b))];
  if (!x.length || !y.length) return 0;
  const common = x.filter((w) => y.includes(w)).length;
  const dice = (2 * common) / (x.length + y.length);
  const shorter = x.length <= y.length ? x : y;
  const contained = shorter.length >= 2 && common === shorter.length;
  return Math.max(dice, contained ? 0.85 : 0);
}

/** A raw place as PlaceDetails (score 0; pickBestPlace sets it). */
export function toPlaceDetails(raw: RawPlace): PlaceDetails {
  const address = parseAddressComponents(raw.addressComponents);
  return {
    placeId: str(raw.id), name: str(raw.displayName?.text), formattedAddress: str(raw.formattedAddress), ...address,
    website: /^https?:\/\//i.test(str(raw.websiteUri)) ? str(raw.websiteUri).slice(0, 300) : "",
    phone: str(raw.nationalPhoneNumber).slice(0, 40), phoneInternational: str(raw.internationalPhoneNumber).slice(0, 40),
    mapsUri: /^https:\/\/(maps\.google\.com|www\.google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(str(raw.googleMapsUri)) ? str(raw.googleMapsUri).slice(0, 500) : "",
    businessStatus: str(raw.businessStatus), matchPercent: 0,
  };
}

/**
 * The best place for the business: closed-for-good places and places in another state are left out; the score is the best name likeness
 * with any of the business's names, plus 0.15 when the postcode is the same (at most 1). Below minPercent: no match (null).
 */
export function pickBestPlace(places: RawPlace[] | null | undefined, input: PlaceSearchInput, minPercent = DEFAULT_MATCH_PERCENT): PlaceDetails | null {
  const state = stateCode(input.state), postcode = str(input.postcode).replace(/\D/g, "");
  const names = input.names.map(str).filter(Boolean);
  let best: PlaceDetails | null = null;
  for (const raw of Array.isArray(places) ? places : []) {
    const place = toPlaceDetails(raw ?? {});
    if (!place.name || /CLOSED_PERMANENTLY/i.test(place.businessStatus)) continue;
    if (state && place.state && stateCode(place.state) !== state) continue;
    const likeness = Math.max(0, ...names.map((n) => nameSimilarity(n, place.name)));
    if (likeness === 0) continue;
    const score = Math.min(1, likeness + (postcode && place.postcode === postcode ? 0.15 : 0));
    const percent = Math.round(score * 100);
    if (percent < minPercent) continue;
    if (!best || percent > best.matchPercent) best = { ...place, matchPercent: percent };
  }
  return best;
}

/**
 * Searches Google Maps for the business. Never throws. No key: not_configured (no call). Tries the first name, then the next different one
 * when the first finds no match (at most two calls). A timeout, a network error or a non-200 answer: unavailable.
 */
export async function searchPlace(input: PlaceSearchInput, key: string | null | undefined, request: typeof fetch = fetch,
  options: { minPercent?: number; timeoutMs?: number } = {}): Promise<PlacesOutcome> {
  const apiKey = String(key ?? "").trim();
  if (!apiKey) return { ok: false, reason: "not_configured", message: MESSAGES.not_configured };
  const names = [...new Set(input.names.map(str).filter(Boolean))];
  if (!names.length) return { ok: false, reason: "not_found", message: MESSAGES.not_found };
  const tries = names.filter((n, i) => i === 0 || nameTokens(n).join(" ") !== nameTokens(names[0]).join(" ")).slice(0, 2);
  let answered = false, lastQuery = "";
  for (const name of tries) {
    const query = placesQuery(name, input.state);
    lastQuery = query;
    try {
      const response = await request(PLACES_SEARCH_URL, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? PLACES_TIMEOUT_MS),
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": PLACES_FIELD_MASK },
        body: JSON.stringify({ textQuery: query, regionCode: "AU", languageCode: "en", pageSize: 5 }),
      });
      if (!response.ok) continue;
      answered = true;
      const body = await response.json() as { places?: RawPlace[] };
      const place = pickBestPlace(body?.places, { ...input, names }, options.minPercent ?? DEFAULT_MATCH_PERCENT);
      if (place) return { ok: true, place, query, fetchedAt: new Date().toISOString() };
    } catch {
      /* the next name, or unavailable */
    }
  }
  return answered ? { ok: false, reason: "not_found", message: MESSAGES.not_found, query: lastQuery } : { ok: false, reason: "unavailable", message: MESSAGES.unavailable, query: lastQuery };
}

/** "Check connection" (Integrations > Connections > Google Maps): one tiny Text Search, field mask places.id only. */
export const PLACES_CHECK_QUERY = "Melbourne VIC Australia";
export type PlacesCheck = { ok: true } | { ok: false; reason: "not_configured" | "rejected" | "unavailable"; status?: number; code?: string; message: string };
/**
 * Makes ONE Text Search with the key and reports Google's answer: ok, or Google's own error text (API not enabled, key restricted,
 * billing not enabled, key not valid). Never throws; the key is never part of the answer.
 */
export async function checkPlacesKey(key: string | null | undefined, request: typeof fetch = fetch, timeoutMs = PLACES_TIMEOUT_MS): Promise<PlacesCheck> {
  const apiKey = String(key ?? "").trim();
  if (!apiKey) return { ok: false, reason: "not_configured", message: "No Google Maps key is saved." };
  let response: Response;
  try {
    response = await request(PLACES_SEARCH_URL, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.id" },
      body: JSON.stringify({ textQuery: PLACES_CHECK_QUERY, regionCode: "AU", languageCode: "en", pageSize: 1 }),
    });
  } catch {
    return { ok: false, reason: "unavailable", message: "Google Maps did not answer. Try again in a minute." };
  }
  if (response.ok) { await response.body?.cancel().catch(() => undefined); return { ok: true }; }
  let message = "", code = "";
  try {
    const body = await response.json() as { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } };
    message = str(body?.error?.message);
    code = str(body?.error?.details?.find((d) => d?.reason)?.reason) || str(body?.error?.status);
  } catch { /* no JSON body */ }
  // Google's text never holds the key; strip it anyway in case an answer ever echoes it.
  message = message.split(apiKey).join("…").slice(0, 400);
  return { ok: false, reason: "rejected", status: response.status, code: code.slice(0, 60) || undefined,
    message: message || `Google Maps refused the key (HTTP ${response.status}).` };
}

/** Where answers are kept by ABN (public.google_place_lookups, agents.abn_cache_days): a found place or "not found". Either call may fail. */
export interface PlacesCache {
  get(abn: string): Promise<{ found: boolean; place: PlaceDetails | null; fetchedAt?: string } | null>;
  put(abn: string, query: string, place: PlaceDetails | null): Promise<void>;
}
/** The cached answer for the ABN when there is one; otherwise the search, kept (found or not found; an unavailable answer is not kept). */
export async function searchPlaceCached(abn: string, input: PlaceSearchInput, key: string | null | undefined, cache: PlacesCache | null, request: typeof fetch = fetch,
  options: { minPercent?: number; timeoutMs?: number } = {}): Promise<PlacesOutcome & { cached: boolean }> {
  if (!String(key ?? "").trim()) return { ok: false, reason: "not_configured", message: MESSAGES.not_configured, cached: false };
  const digits = String(abn ?? "").replace(/\D/g, "");
  if (cache && /^\d{11}$/.test(digits)) {
    try {
      const hit = await cache.get(digits);
      if (hit && hit.found && hit.place?.name) return { ok: true, place: hit.place, query: "", fetchedAt: String(hit.fetchedAt ?? new Date().toISOString()), cached: true };
      if (hit && hit.found === false) return { ok: false, reason: "not_found", message: MESSAGES.not_found, cached: true };
    } catch { /* search instead */ }
  }
  const outcome = await searchPlace(input, key, request, options);
  if (cache && /^\d{11}$/.test(digits) && (outcome.ok || ("reason" in outcome && outcome.reason === "not_found"))) {
    try { await cache.put(digits, outcome.query ?? "", outcome.ok ? outcome.place : null); } catch { /* not kept this time */ }
  }
  return { ...outcome, cached: false };
}

/**
 * The F04 values a place gives (office row, website): office_street_address, office_suburb (with the postcode, as the form prints it),
 * office_state, office_country, agent_website. Empty values are left out.
 */
export function placeF04Values(place: Pick<PlaceDetails, "street" | "suburb" | "state" | "postcode" | "country" | "website"> | null | undefined): Record<string, string> {
  if (!place) return {};
  const suburb = str(place.suburb), postcode = str(place.postcode);
  const values: Record<string, string> = {
    office_street_address: str(place.street), office_suburb: suburb ? (postcode && !suburb.endsWith(` ${postcode}`) ? `${suburb} ${postcode}` : suburb) : "",
    office_state: stateCode(place.state) || str(place.state), office_country: str(place.country), agent_website: str(place.website),
  };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
}
/** The keys a place may fill on the F04 (only blank ones; never an answer already given). */
export const PLACE_F04_KEYS = ["office_street_address", "office_suburb", "office_state", "office_country", "agent_website"] as const;
/** The office address as one line ("5/123 Smith Street, Parramatta NSW 2150"). */
export function placeAddressLine(place: Pick<PlaceDetails, "street" | "suburb" | "state" | "postcode"> | null | undefined): string {
  if (!place) return "";
  const tail = [str(place.suburb), stateCode(place.state) || str(place.state), str(place.postcode)].filter(Boolean).join(" ");
  return [str(place.street), tail].filter(Boolean).join(", ");
}
