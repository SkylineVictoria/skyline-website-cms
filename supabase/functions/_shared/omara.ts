// OMARA migration agent discovery (owner 2026-11-24: "OMARA Business & Migration Agent Discovery" in Master Data › Businesses).
// Finds a business's registered migration agents on the public OMARA Register of Migration Agents (portal.mara.gov.au).
//
// OMARA has no API. Method (and nothing else):
//   1. a commercial web search API (Brave Search or Tavily, key in Integrations › Connections) returns indexed public agent detail pages
//      (https://portal.mara.gov.au/search-the-register-of-migration-agents/register-of-migration-agent-details/?ContactID=<guid>);
//   2. ONE plain HTTP GET per detail page, sequential, with a pause between requests (Business Rule omara.request_gap_ms) and small caps
//      per business (omara.max_search_queries, omara.max_agent_pages); only for the business being onboarded.
// The register's internal Power Pages search service (entity-grid-data.json with its anti-forgery token) is never called, and nothing
// tries to get past a CAPTCHA or a sign-in. A page we have not read is reported as "found in search, not verified"; only a page read and
// parsed now is "verified" (with its time). Disciplinary information is set only when a disciplinary decision page for the MARN was
// found and fetched and names the MARN; otherwise null. These agents are NOT SLIT education agents.
// Runtime-neutral (the Edge Function and the offline tests): fetch and the clock are injected.

export const OMARA_HOST = "portal.mara.gov.au";
export const DETAIL_PATH = "/search-the-register-of-migration-agents/register-of-migration-agent-details/";
export const USER_AGENT = "Mozilla/5.0 (compatible; SLIT-CMS)";
export const SEARCH_TIMEOUT_MS = 8000;
export const PAGE_TIMEOUT_MS = 10000;
export const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
export const TAVILY_URL = "https://api.tavily.com/search";
/** Fallbacks when a Business Rule cannot be read. */
export const DEFAULTS = { maxQueries: 6, maxPages: 20, gapMs: 1000, threshold: 60, reverifyDays: 30, costUsd: 0.005, allowed: [OMARA_HOST] };

export type Provider = "brave" | "tavily";
export interface SearchHit { url: string; title: string; snippet: string }
export interface OmaraAgent {
  marn: string; fullName: string; status: string; registrationCommencedAt: string | null;
  businessName: string; addressLine: string; suburb: string; state: string; postcode: string; country: string;
  phone: string; email: string; website: string; contactId: string; sourceUrl: string;
  registerUpdatedAt: string | null; verifiedAt: string;
  /** "Other business associated with this agent": the public page withholds it ("You don't have permissions to view these records"). */
  otherBusinesses: "unavailable" | "none" | string[];
  disciplinary: { verified: true; url: string; title: string; verifiedAt: string }[] | null;
  rawFields: Record<string, string>;
}
export interface BusinessFacts { names: string[]; website?: string | null; postcode?: string | null; state?: string | null; suburb?: string | null;
  /** Suburbs / cities of the head office and branches (2026-11-24): one more search per place, to find agents at every office. */
  places?: string[] | null }
export interface Match { confidence: number; evidence: string[] }
export type DiscoveredAgent =
  | (OmaraAgent & Match & { verification: "verified" | "stored"; likely: boolean })
  | { verification: "search_only"; contactId: string; sourceUrl: string; title: string; snippet: string; reason: string; confidence: 0; evidence: string[]; likely: false };

// deno-lint-ignore no-control-regex
const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : ""); // eslint-disable-line no-control-regex
const STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"];
const STATE_NAMES: Record<string, string> = { "australian capital territory": "ACT", "new south wales": "NSW", "northern territory": "NT", queensland: "QLD",
  "south australia": "SA", tasmania: "TAS", victoria: "VIC", "western australia": "WA" };
const ENTITIES: Record<string, string> = { amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'" };

/** HTML entities as text (&amp; &nbsp; &#39; &#x27; …). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name: string) => {
    const lower = name.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower];
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return all;
  });
}
const text = (html: string) => clean(decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ")));
/** Keeps line breaks (the business address is three lines). */
const lines = (html: string) => decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ")).split(/\n/).map(clean).filter(Boolean);

/** Hosts we may read: the rule's list, but only government .gov.au hosts (a rule edit cannot point this at any other site). */
export function allowedHosts(list: readonly string[] | null | undefined): string[] {
  const hosts = (list ?? []).map((h) => clean(h).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter((h) => /^[a-z0-9.-]+\.gov\.au$/.test(h));
  return hosts.length ? [...new Set(hosts)] : [OMARA_HOST];
}

/** The ContactID of an OMARA agent detail link on an allowed host (https only, the detail path, a GUID), else null. */
export function parseDetailUrl(raw: string, allowed: readonly string[] = [OMARA_HOST]): { contactId: string; url: string } | null {
  let u: URL;
  try { u = new URL(clean(raw)); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  if (!allowed.includes(u.hostname.toLowerCase())) return null;
  if (u.pathname.toLowerCase().replace(/\/?$/, "/") !== DETAIL_PATH) return null;
  let id = "";
  for (const [k, v] of u.searchParams) if (k.toLowerCase() === "contactid") id = v.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
  return { contactId: id, url: detailUrl(id, u.hostname.toLowerCase()) };
}
export const detailUrl = (contactId: string, host = OMARA_HOST) => `https://${host}${DETAIL_PATH}?ContactID=${contactId}`;
/** A disciplinary decision page on an allowed host. */
export function isDisciplinaryUrl(raw: string, allowed: readonly string[] = [OMARA_HOST]): boolean {
  try { const u = new URL(raw); return u.protocol === "https:" && allowed.includes(u.hostname.toLowerCase()) && /disciplin/i.test(u.pathname); } catch { return false; }
}

/** "2025-03-14 01:00 PM" (the register's UTC value, which its page converts to local time with JavaScript) -> ISO, else null. */
export function registerTime(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?$/i.exec(clean(value));
  if (!m) return null;
  let h = Number(m[4] ?? 0);
  const ap = (m[6] ?? "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, Number(m[5] ?? 0)));
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) ? null : d.toISOString();
}

/** Splits the register's address ("Level 1/ 7-9 Elizabeth Street" / "Melbourne VIC 3000" / "Australia"). */
export function splitAddress(parts: string[]): { addressLine: string; suburb: string; state: string; postcode: string; country: string } {
  const rest = [...parts];
  let country = "";
  if (rest.length > 1 && !/\d/.test(rest[rest.length - 1]) && !new RegExp(`\\b(${STATES.join("|")})\\b`).test(rest[rest.length - 1])) country = rest.pop() ?? "";
  let suburb = "", state = "", postcode = "";
  const last = rest[rest.length - 1] ?? "";
  // "Melbourne VIC 3000", or a state written out ("… Findon SOUTH AUSTRALIA 5023") on the street line itself.
  const names = [...STATES, ...Object.keys(STATE_NAMES)].map((n) => n.replace(/ /g, "\\s+")).join("|");
  const m = new RegExp(`^(.*?)[,\\s]+(${names})[,\\s]+(\\d{4})$`, "i").exec(last);
  if (m) {
    state = STATES.includes(m[2].toUpperCase()) ? m[2].toUpperCase() : STATE_NAMES[m[2].toLowerCase().replace(/\s+/g, " ")] ?? "";
    postcode = m[3];
    rest.pop();
    let before = clean(m[1]);
    // The suburb on the street line: the part after the last comma.
    if (!rest.length && before.includes(",")) { const i = before.lastIndexOf(","); rest.push(clean(before.slice(0, i))); before = clean(before.slice(i + 1)); }
    suburb = before;
  }
  return { addressLine: rest.join(", "), suburb, state, postcode, country };
}

/**
 * One OMARA agent detail page (the HTML of a plain GET) -> the record, or null when it is not a detail page with a name and a 7-digit MARN.
 * Reads the labelled values (Migration agent registration number, Current status, …) and the Contact details table.
 */
export function parseOmaraDetail(html: string, sourceUrl: string, fetchedAt: string): OmaraAgent | null {
  if (typeof html !== "string" || !/Registered migration agent details/i.test(html)) return null;
  const body = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const raw: Record<string, string> = {};
  const fullName = text(/<label[^>]*class="[^"]*resgister-fullname[^"]*"[^>]*>([\s\S]*?)<\/label>/i.exec(body)?.[1] ?? "");
  // Label / value pairs: <label class="resgister-label">X</label><label class="resgister-value">Y</label>
  for (const m of body.matchAll(/<label[^>]*class="[^"]*resgister-label[^"]*"[^>]*>([\s\S]*?)<\/label>\s*<label[^>]*class="[^"]*resgister-value[^"]*"[^>]*>([\s\S]*?)<\/label>/gi)) {
    raw[text(m[1]).replace(/:$/, "").trim()] = text(m[2]);
  }
  // Contact details: two-cell rows.
  const table = /Contact details[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i.exec(body)?.[1] ?? "";
  let addressLines: string[] = [];
  for (const row of table.matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)) {
    const label = text(row[1]);
    if (!label) continue;
    if (/^business address$/i.test(label)) { addressLines = lines(row[2]); raw[label] = addressLines.join(" / "); } else raw[label] = text(row[2]);
  }
  const updated = text(/<label[^>]*id="lastUpdated"[^>]*>([\s\S]*?)<\/label>/i.exec(body)?.[1] ?? "");
  if (updated) raw["Register last updated"] = updated;
  const marn = (raw["Migration agent registration number"] ?? "").replace(/\D/g, "");
  if (!fullName || !/^\d{7}$/.test(marn)) return null;
  const commenced = Object.entries(raw).find(([k]) => /most recent registration commenced/i.test(k))?.[1] ?? "";
  const address = splitAddress(addressLines);
  const otherBlock = /Other business associated with this agent([\s\S]*?)(?:<\/form>|$)/i.exec(body)?.[1] ?? "";
  const otherText = text(otherBlock);
  const otherBusinesses: OmaraAgent["otherBusinesses"] = /don.t have permissions to view/i.test(otherText) ? "unavailable"
    : /no records to display/i.test(otherText) ? "none" : "unavailable";
  const email = (raw["Email address"] ?? "").toLowerCase();
  let parsed: { contactId: string; url: string } | null = null;
  try { parsed = parseDetailUrl(sourceUrl, [new URL(sourceUrl).hostname.toLowerCase()]); } catch { parsed = null; }
  return {
    marn, fullName, status: raw["Current status"] ?? "", registrationCommencedAt: registerTime(commenced),
    businessName: raw["Business name"] ?? "", ...address, phone: (raw["Phone"] ?? "").replace(/[^0-9+() -]/g, "").trim(),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "", website: raw["Website"] ?? "",
    contactId: parsed?.contactId ?? "", sourceUrl: parsed?.url ?? sourceUrl,
    registerUpdatedAt: registerTime(updated), verifiedAt: fetchedAt, otherBusinesses, disciplinary: null, rawFields: raw,
  };
}

// ---- names, queries and matching ---------------------------------------------------------------------------------------------------

const LEGAL = /\b(pty|proprietary|ltd|limited|inc|incorporated|llc|plc|co|company|corporation|corp|holdings|group|trust|trustee|for|the|australia|australian|aust|au)\b/g;
const STOP = new Set(["and", "of", "the", "pty", "ltd", "limited", "group", "australia", "australian", "services", "service", "consultants", "consultant", "consultancy",
  "consulting", "migration", "education", "visa", "visas", "immigration", "international", "global", "solutions", "agency", "agents", "agent", "co", "company", "trust",
  "holdings", "inc", "corporation", "corp", "for", "trustee", "trading", "as", "t", "a"]);

/** Lower case, & as "and", brackets (branch names) and punctuation removed. */
export function normaliseName(name: string): string {
  return clean(name).toLowerCase().replace(/&/g, " and ").replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
const tokens = (name: string) => normaliseName(name).split(" ").filter(Boolean);
/** Distinctive words (not legal or trade words): "Aussizz Migration and Education Consultants Pty Ltd" -> ["aussizz"]. */
export const coreTokens = (name: string) => tokens(name).filter((t) => !STOP.has(t) && t.length >= 3);

/** The names to search for: as given, and without the legal ending (Pty Ltd, Group, …), shortest last; at most 6. */
export function nameVariants(names: string[]): string[] {
  const out: string[] = [];
  const add = (n: string) => { const v = clean(n).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim(); if (v.length >= 3 && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v); };
  for (const n of names) add(n);
  for (const n of names) add(clean(n).replace(/[.,]/g, " ").toLowerCase().replace(LEGAL, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase()));
  return out.slice(0, 6);
}

/** "https://www.Aussizz.com/x" -> "aussizz.com" (no www., lower case), else "". */
export function domainOf(value: string | null | undefined): string {
  const v = clean(value).toLowerCase();
  if (!v) return "";
  const at = v.lastIndexOf("@");
  const host = at >= 0 ? v.slice(at + 1) : (() => { try { return new URL(/^https?:\/\//.test(v) ? v : `https://${v}`).hostname; } catch { return ""; } })();
  return host.replace(/^www\./, "").replace(/\.$/, "");
}
/** The name part of a domain: "aussizzgroup.com.au" -> "aussizzgroup". */
const domainLabel = (domain: string) => domain.replace(/\.(com|net|org|edu|gov|biz|info|co|asn|id)?\.?(au|nz|in|uk)?$/, "").replace(/\.(com|net|org|biz|info|co)$/, "").split(".").pop() ?? "";

/** The web searches for a business, most specific first, capped at max. */
export function buildQueries(facts: BusinessFacts, max: number): string[] {
  const names = nameVariants(facts.names);
  const q: string[] = [];
  const add = (s: string) => { if (!q.includes(s)) q.push(s); };
  const domain = domainOf(facts.website);
  if (names[0]) add(`site:${OMARA_HOST} "${names[0]}" "Registered migration agent details"`);
  if (domain) add(`site:${OMARA_HOST} "${domain}"`);
  for (const n of names) {
    add(`site:${OMARA_HOST} "${n}" "Migration agent registration number"`);
    add(`site:${OMARA_HOST} "${n}" "Registered migration agent details"`);
  }
  // Wider (owner 2026-11-24: "I can't find the main people"): the brand word alone, the email domain, and the brand at each office.
  const brand = [...new Set(names.flatMap((n) => coreTokens(n)))].find((t) => t.length >= 4) ?? "";
  const brandText = brand ? brand.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
  if (brandText) add(`site:${OMARA_HOST} "${brandText}"`);
  if (domain) add(`site:${OMARA_HOST} "@${domain}"`);
  const label = domainLabel(domain);
  if (label && label.length >= 4 && label !== brand) add(`site:${OMARA_HOST} "${label}"`);
  for (const place of [...new Set((facts.places ?? []).map((p) => clean(p)).filter((p) => p.length >= 3))].slice(0, 8)) {
    if (brandText) add(`site:${OMARA_HOST} "${brandText}" "${place}"`);
  }
  return q.slice(0, Math.max(1, Math.min(20, Math.floor(max))));
}

/** How well a parsed agent matches the business (0-100) and why: business name, website / email domain, postcode / state. */
export function scoreMatch(agent: Pick<OmaraAgent, "businessName" | "website" | "email" | "postcode" | "state" | "suburb">, facts: BusinessFacts): Match {
  const evidence: string[] = [];
  let score = 0;
  // Business name: the share of the business's distinctive words in the agent's business name (best of all its names).
  const agentName = normaliseName(agent.businessName);
  const agentWords = new Set(tokens(agent.businessName));
  let bestName = 0, bestLabel = "";
  for (const n of facts.names) {
    const core = coreTokens(n);
    const all = tokens(n).filter((t) => !["pty", "ltd", "limited", "the"].includes(t));
    if (!all.length) continue;
    const exact = normaliseName(n).replace(/\b(pty|ltd|limited)\b/g, "").replace(/\s+/g, " ").trim();
    let s = 0;
    if (exact && agentName.includes(exact)) s = 50;
    else {
      const coreHit = core.length ? core.filter((t) => agentWords.has(t)).length / core.length : 0;
      const allHit = all.filter((t) => agentWords.has(t)).length / all.length;
      // Only the trade words in common ("Migration", "Education") is not a match.
      s = core.length && coreHit === 0 ? 0 : Math.round(coreHit * 30 + allHit * 15);
    }
    if (s > bestName || (s === bestName && s > 0 && clean(n).length > clean(bestLabel).length)) { bestName = s; bestLabel = n; }
  }
  if (bestName >= 50) evidence.push(`Business name contains "${clean(bestLabel)}"`);
  else if (bestName > 0) evidence.push(`Business name partly matches "${clean(bestLabel)}"`);
  score += bestName;
  // Website and email domains.
  const site = domainOf(facts.website);
  const brand = facts.names.flatMap(coreTokens).filter((t) => t.length >= 4);
  const related = (d: string) => !!d && (brand.some((b) => domainLabel(d).includes(b)) || (!!site && domainLabel(d) === domainLabel(site)));
  const agentSite = domainOf(agent.website), agentMail = domainOf(agent.email);
  if (site && agentSite === site) { score += 30; evidence.push(`Same website (${site})`); }
  else if (related(agentSite)) { score += 15; evidence.push(`Website ${agentSite} matches the business name`); }
  if (site && agentMail === site) { score += 15; evidence.push(`Email on the business's domain (${site})`); }
  else if (related(agentMail)) { score += 8; evidence.push(`Email domain ${agentMail} matches the business name`); }
  // Location.
  const pc = clean(facts.postcode), st = clean(facts.state).toUpperCase();
  if (pc && agent.postcode === pc) { score += 10; evidence.push(`Same postcode (${pc})`); }
  else if (st && agent.state === st) { score += 5; evidence.push(`Same state (${st})`); }
  if (!evidence.length) evidence.push("Nothing on the record matches the business");
  return { confidence: Math.max(0, Math.min(100, score)), evidence };
}

// ---- search providers --------------------------------------------------------------------------------------------------------------

export class OmaraError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 502) { super(message); this.code = code; this.status = status; }
}
type Fetch = typeof fetch;

/** One web search: the hits on allowed hosts only. Never throws for "no results"; throws OmaraError for a refused key, quota or timeout. */
export async function webSearch(provider: Provider, key: string, query: string, fetchFn: Fetch, allowed: readonly string[] = [OMARA_HOST], timeoutMs = SEARCH_TIMEOUT_MS): Promise<SearchHit[]> {
  let res: Response;
  try {
    res = provider === "brave"
      ? await fetchFn(`${BRAVE_URL}?q=${encodeURIComponent(query)}&count=20`, { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(timeoutMs) })
      : await fetchFn(TAVILY_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ api_key: key, query, include_domains: [...allowed], max_results: 20, search_depth: "basic" }) });
  } catch (e) {
    throw new OmaraError(`${provider === "brave" ? "Brave Search" : "Tavily"} did not answer in time.`, e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network");
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail = clean((body?.error as { detail?: string } | undefined)?.detail ?? (body?.detail as { error?: string } | undefined)?.error ?? body?.message ?? body?.error ?? "");
    throw new OmaraError(`${provider === "brave" ? "Brave Search" : "Tavily"} refused the search (HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}).`,
      res.status === 401 || res.status === 403 ? "key_refused" : res.status === 429 || res.status === 432 ? "quota" : `http_${res.status}`);
  }
  const rows = provider === "brave" ? ((body?.web as { results?: unknown[] } | undefined)?.results ?? []) : ((body?.results as unknown[] | undefined) ?? []);
  const hits: SearchHit[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as Record<string, unknown>;
    const url = clean(o.url);
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
    if (!allowed.includes(host)) continue;
    hits.push({ url, title: text(String(o.title ?? "")), snippet: text(String(o.description ?? o.content ?? "")).slice(0, 500) });
  }
  return hits;
}

/** One plain GET of a public page; the HTML or an OmaraError. */
export async function fetchPage(url: string, fetchFn: Fetch, timeoutMs = PAGE_TIMEOUT_MS): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", redirect: "error", headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new OmaraError("The OMARA register did not answer in time.", e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network");
  }
  if (res.status === 404) { await res.body?.cancel().catch(() => {}); throw new OmaraError("This OMARA page no longer exists.", "not_found", 404); }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new OmaraError(`The OMARA register answered HTTP ${res.status}.`, `http_${res.status}`); }
  const html = await res.text();
  return html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
}

// ---- discovery ---------------------------------------------------------------------------------------------------------------------

export interface DiscoverOptions {
  provider: Provider | null; key: string | null; fetch: Fetch; sleep: (ms: number) => Promise<void>; now: () => Date;
  maxQueries: number; maxPages: number; gapMs: number; threshold: number; allowed: string[];
  /** Records read recently enough (omara.reverify_days) by ContactID: not fetched again. */
  stored?: (contactIds: string[]) => Promise<Map<string, OmaraAgent>>;
}
export interface DiscoverResult {
  configured: boolean; agents: DiscoveredAgent[]; queries: string[]; results: number; pagesFetched: number; searches: number; errors: string[];
}

/** Reads the given detail links (already allowed and deduped) one at a time with the pause, matches them, dedupes by MARN. */
export async function readDetails(links: { contactId: string; url: string; title?: string; snippet?: string }[], facts: BusinessFacts, opts: DiscoverOptions,
  disciplinaryHits: SearchHit[] = []): Promise<{ agents: DiscoveredAgent[]; pagesFetched: number; errors: string[] }> {
  const agents: DiscoveredAgent[] = [];
  const errors: string[] = [];
  let pagesFetched = 0, requests = 0;
  const stored = opts.stored ? await opts.stored(links.map((l) => l.contactId)).catch(() => new Map<string, OmaraAgent>()) : new Map<string, OmaraAgent>();
  const pause = async () => { if (requests++ > 0) await opts.sleep(opts.gapMs); };
  const seen = new Set<string>();
  for (const link of links) {
    const known = stored.get(link.contactId);
    let agent: OmaraAgent | null = known ?? null;
    let verification: "verified" | "stored" = known ? "stored" : "verified";
    if (!agent) {
      if (pagesFetched >= opts.maxPages) {
        agents.push({ verification: "search_only", contactId: link.contactId, sourceUrl: link.url, title: link.title ?? "", snippet: link.snippet ?? "",
          reason: `Not read: the limit of ${opts.maxPages} pages per business was reached.`, confidence: 0, evidence: [], likely: false });
        continue;
      }
      await pause();
      pagesFetched++;
      try {
        const at = opts.now().toISOString();
        agent = parseOmaraDetail(await fetchPage(link.url, opts.fetch), link.url, at);
        verification = "verified";
        if (!agent) throw new OmaraError("The page is not an agent record any more.", "not_agent");
      } catch (e) {
        const reason = e instanceof Error ? e.message : "The page could not be read.";
        errors.push(`${link.url}: ${reason}`);
        agents.push({ verification: "search_only", contactId: link.contactId, sourceUrl: link.url, title: link.title ?? "", snippet: link.snippet ?? "", reason, confidence: 0, evidence: [], likely: false });
        continue;
      }
    }
    if (seen.has(agent.marn)) continue;
    seen.add(agent.marn);
    // Disciplinary: only a decision page found for this MARN and confirmed by reading it.
    const hit = disciplinaryHits.find((h) => h.title.includes(agent!.marn) || h.snippet.includes(agent!.marn));
    if (hit && verification === "verified" && pagesFetched < opts.maxPages) {
      await pause();
      pagesFetched++;
      try {
        const page = text(await fetchPage(hit.url, opts.fetch));
        if (page.includes(agent.marn)) agent = { ...agent, disciplinary: [{ verified: true, url: hit.url, title: hit.title, verifiedAt: opts.now().toISOString() }] };
      } catch { /* not verified: stays null */ }
    }
    const m = scoreMatch(agent, facts);
    agents.push({ ...agent, ...m, verification, likely: m.confidence >= opts.threshold });
  }
  return { agents, pagesFetched, errors };
}

/** Search -> allowed detail links (deduped by ContactID, capped) -> one GET each -> parse -> dedupe by MARN -> match. Never throws. */
export async function discover(facts: BusinessFacts, opts: DiscoverOptions): Promise<DiscoverResult> {
  const queries = buildQueries(facts, opts.maxQueries);
  if (!opts.provider || !opts.key) return { configured: false, agents: [], queries: [], results: 0, pagesFetched: 0, searches: 0, errors: [] };
  const links = new Map<string, { contactId: string; url: string; title: string; snippet: string }>();
  const disciplinary: SearchHit[] = [];
  const errors: string[] = [];
  let results = 0, searches = 0;
  for (const q of queries) {
    if (searches > 0) await opts.sleep(opts.gapMs);
    searches++;
    try {
      const hits = await webSearch(opts.provider, opts.key, q, opts.fetch, opts.allowed);
      results += hits.length;
      for (const h of hits) {
        const d = parseDetailUrl(h.url, opts.allowed);
        if (d && !links.has(d.contactId)) links.set(d.contactId, { ...d, title: h.title, snippet: h.snippet });
        else if (!d && isDisciplinaryUrl(h.url, opts.allowed)) disciplinary.push(h);
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "The search failed.");
      // A refused key or used-up quota will not get better with the next query.
      if (e instanceof OmaraError && (e.code === "key_refused" || e.code === "quota")) break;
    }
  }
  const read = await readDetails([...links.values()], facts, opts, disciplinary);
  read.agents.sort((a, b) => b.confidence - a.confidence);
  return { configured: true, agents: read.agents, queries: queries.slice(0, searches), results, pagesFetched: read.pagesFetched, searches, errors: [...errors, ...read.errors] };
}

/** The record as public.omara_agent_upsert reads it. */
export function upsertPayload(a: OmaraAgent): Record<string, unknown> {
  return { marn: a.marn, fullName: a.fullName, status: a.status, registrationCommencedAt: a.registrationCommencedAt, businessName: a.businessName,
    addressLine: a.addressLine, suburb: a.suburb, state: a.state, postcode: a.postcode, country: a.country, phone: a.phone, email: a.email,
    website: a.website, contactId: a.contactId, sourceUrl: a.sourceUrl, registerUpdatedAt: a.registerUpdatedAt, verifiedAt: a.verifiedAt,
    disciplinary: a.disciplinary, rawFields: { ...a.rawFields, otherBusinesses: Array.isArray(a.otherBusinesses) ? a.otherBusinesses.join("; ") : a.otherBusinesses } };
}
/** A stored omara_agents row as a record (for the reverify window). */
export function fromRow(r: Record<string, unknown>): OmaraAgent {
  const s = (k: string) => (typeof r[k] === "string" ? r[k] as string : "");
  const raw = (r.raw_fields && typeof r.raw_fields === "object" ? r.raw_fields : {}) as Record<string, string>;
  return { marn: s("marn"), fullName: s("full_name"), status: s("status"), registrationCommencedAt: s("registration_commenced_at") || null, businessName: s("business_name"),
    addressLine: s("address_line"), suburb: s("suburb"), state: s("state"), postcode: s("postcode"), country: s("country"), phone: s("phone"), email: s("email"),
    website: s("website"), contactId: s("contact_id"), sourceUrl: s("source_url"), registerUpdatedAt: s("register_updated_at") || null, verifiedAt: s("verified_at"),
    otherBusinesses: raw.otherBusinesses === "none" ? "none" : "unavailable",
    disciplinary: Array.isArray(r.disciplinary) ? r.disciplinary as OmaraAgent["disciplinary"] : null, rawFields: raw };
}
