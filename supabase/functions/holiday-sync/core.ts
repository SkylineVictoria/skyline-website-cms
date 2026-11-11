// =====================================================================
// holiday-sync core: reads the Victorian public holidays of a year from the official sources and turns them into the rows the
// database upserts (public.hr_holiday_sync_finish, migration 20261113150000). No Deno API here: scripts/test-holiday-import.ts
// runs it offline with fake fetchers.
//
// Sources, in order:
//   1. data.gov.au "Australian Public Holidays Dates Machine Readable Dataset" (CKAN): package_show lists one CSV resource per
//      year (checked 2026-11-11: the newest is 2025, so 2026 and 2027 fall back); datastore_search on that resource with
//      Jurisdiction = vic gives Date (YYYYMMDD, null while a date is not yet declared), Holiday Name, Information.
//   2. Nager.Date /api/v3/PublicHolidays/{year}/AU, rows that are national (counties null) or list AU-VIC. Its names differ
//      from Business Victoria's ("Holy Saturday", "Anzac Day", "Melbourne Cup", "St. Stephen's Day"), it marks an undeclared Grand
//      Final Friday "(Tentative Date)", and it lists only the Monday / Tuesday substitute when Christmas Day, Boxing Day or New
//      Year's Day falls on a weekend. Victoria keeps the actual day AND adds the weekday (Public Holidays Act 1993 (Vic)), so the
//      actual day is added back and the substitute is named "... (additional day)", exactly as 20261110120000 seeded them.
// Names are normalised to Business Victoria's wording from either source so a re-sync never renames a row twice.
// =====================================================================

export type HolidaySource = "data.gov.au" | "nager";
export interface SyncHoliday { date: string; name: string; note: string; tentative: boolean }
export type YearResult = { source: HolidaySource; holidays: SyncHoliday[]; fallbackReason?: string } | { error: string };
export interface SyncResult { ok: boolean; error?: string; years: Record<string, YearResult>; detail: { dataGov: string; nager: string; skipped: string[] } }

/** GETs a URL and returns its JSON body; throws on a non-2xx answer, a timeout or a body that is not JSON. */
export type FetchJson = (url: string) => Promise<unknown>;

export const DATA_GOV_API = "https://data.gov.au/data/api/3/action";
export const DATA_GOV_DATASET = "australian-holidays-machine-readable-dataset";
export const NAGER_API = "https://date.nager.at/api/v3";

const NAME_MAP: Record<string, string> = {
  "new year's day": "New Year's Day", "new years day": "New Year's Day",
  "australia day": "Australia Day",
  "labour day": "Labour Day", "labor day": "Labour Day",
  "good friday": "Good Friday",
  "holy saturday": "Saturday before Easter Sunday", "easter saturday": "Saturday before Easter Sunday", "easter eve": "Saturday before Easter Sunday",
  "saturday before easter sunday": "Saturday before Easter Sunday", "the saturday before easter sunday": "Saturday before Easter Sunday",
  "easter sunday": "Easter Sunday", "easter monday": "Easter Monday",
  "anzac day": "ANZAC Day",
  "king's birthday": "King's Birthday", "kings birthday": "King's Birthday", "queen's birthday": "King's Birthday", "sovereign's birthday": "King's Birthday",
  "friday before afl grand final": "Friday before the AFL Grand Final", "friday before the afl grand final": "Friday before the AFL Grand Final",
  "afl grand final friday": "Friday before the AFL Grand Final", "grand final friday": "Friday before the AFL Grand Final", "afl grand final eve": "Friday before the AFL Grand Final",
  "melbourne cup": "Melbourne Cup Day", "melbourne cup day": "Melbourne Cup Day",
  "christmas day": "Christmas Day",
  "boxing day": "Boxing Day", "st. stephen's day": "Boxing Day", "st stephen's day": "Boxing Day", "st. stephens day": "Boxing Day",
};
/** Holidays Victoria keeps on their actual date AND observes again on the next weekday when they fall on a weekend. */
const FIXED_DAYS: Record<string, string> = { "New Year's Day": "01-01", "Christmas Day": "12-25", "Boxing Day": "12-26" };

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const dateOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** The official Victorian name of a holiday, or the source's wording (title-cased as given) when it is not a known one. */
export function normaliseVicName(raw: string): { name: string; tentative: boolean } {
  let name = clean(raw);
  const tentative = /\(\s*tentative[^)]*\)|\btentative\b|\bto be confirmed\b|\btbc\b/i.test(name);
  name = clean(name.replace(/\(\s*tentative[^)]*\)/gi, "").replace(/\b(tentative|to be confirmed|tbc)\b/gi, "").replace(/\s*[-–:]\s*$/, ""));
  const additional = /\(?\b(additional|substitute|observed|in lieu)\b[^)]*\)?/i.test(name);
  const base = clean(name.replace(/\(?\b(additional|substitute|observed|in lieu)\b[^)]*\)?/gi, "").replace(/\bday\s+(holiday)\b/i, "day")).replace(/[.,;]+$/, "");
  const known = NAME_MAP[base.toLowerCase()];
  return { name: (known ?? base) + (additional && known && FIXED_DAYS[known] ? " (additional day)" : ""), tentative };
}

/** Applies the Victorian weekend rule and removes duplicates: one row per date + name, sorted by date. */
export function completeVictorianDays(rows: SyncHoliday[], year: number): SyncHoliday[] {
  const out = new Map<string, SyncHoliday>();
  const put = (h: SyncHoliday) => { const k = `${h.date}|${h.name.toLowerCase()}`; if (!out.has(k)) out.set(k, h); };
  for (const h of rows) {
    const fixed = FIXED_DAYS[h.name.replace(/ \(additional day\)$/, "")];
    if (fixed) {
      const nominal = `${year}-${fixed}`;
      const baseName = h.name.replace(/ \(additional day\)$/, "");
      if (h.date === nominal) put({ ...h, name: baseName });
      else {
        // The source gives the weekday observance: keep it as the additional day and make sure the actual day is listed too.
        put({ ...h, name: `${baseName} (additional day)`, note: h.note || `Additional public holiday for ${baseName} falling on a weekend` });
        put({ date: nominal, name: baseName, note: "", tentative: false });
      }
    } else put(h);
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
}

interface CkanResource { id?: string; name?: string; datastore_active?: boolean; format?: string }
interface CkanRecord { Date?: string | null; "Holiday Name"?: string | null; Information?: string | null; Jurisdiction?: string | null }

/** The dataset resource that holds a year: "... 2026", or a combined one whose "2021-2025" range covers it. */
export function pickDataGovResource(resources: CkanResource[], year: number): CkanResource | null {
  const active = resources.filter((r) => r && r.id && r.datastore_active !== false);
  const exact = active.find((r) => new RegExp(`\\b${year}\\b`).test(r.name ?? "") && !/\d{4}\s*[-–]\s*\d{4}/.test(r.name ?? ""));
  if (exact) return exact;
  const ranged = active.find((r) => { const m = /(\d{4})\s*[-–]\s*(\d{4})/.exec(r.name ?? ""); return m && Number(m[1]) <= year && year <= Number(m[2]); });
  return ranged ?? null;
}

export function parseDataGovRecords(records: CkanRecord[], year: number, state: string): { holidays: SyncHoliday[]; skipped: string[] } {
  const skipped: string[] = [];
  const rows: SyncHoliday[] = [];
  for (const rec of records) {
    if (clean(rec.Jurisdiction).toLowerCase() !== state.toLowerCase()) continue;
    const { name, tentative } = normaliseVicName(rec["Holiday Name"] ?? "");
    const raw = clean(rec.Date);
    if (!name) continue;
    if (!/^\d{8}$/.test(raw)) { skipped.push(`${year}: ${name} has no date yet in data.gov.au`); continue; }
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    if (!dateOk(date) || Number(raw.slice(0, 4)) !== year) { skipped.push(`${year}: ${name} has an unusable date ${raw}`); continue; }
    rows.push({ date, name, note: clean(rec.Information).slice(0, 500), tentative });
  }
  return { holidays: completeVictorianDays(rows, year), skipped };
}

export async function fetchDataGov(year: number, state: string, fetchJson: FetchJson, api = DATA_GOV_API): Promise<{ holidays: SyncHoliday[]; skipped: string[] }> {
  const pkg = await fetchJson(`${api}/package_show?id=${DATA_GOV_DATASET}`) as { success?: boolean; result?: { resources?: CkanResource[] } };
  if (!pkg?.success || !Array.isArray(pkg.result?.resources)) throw new Error("data.gov.au did not describe the holidays dataset");
  const resource = pickDataGovResource(pkg.result!.resources!, year);
  if (!resource) throw new Error(`data.gov.au has no ${year} holidays dataset yet`);
  const filters = encodeURIComponent(JSON.stringify({ Jurisdiction: state.toLowerCase() }));
  const data = await fetchJson(`${api}/datastore_search?resource_id=${encodeURIComponent(resource.id!)}&filters=${filters}&limit=500`) as { success?: boolean; result?: { records?: CkanRecord[] } };
  if (!data?.success || !Array.isArray(data.result?.records)) throw new Error(`data.gov.au returned no rows for ${year}`);
  const parsed = parseDataGovRecords(data.result!.records!, year, state);
  if (!parsed.holidays.length) throw new Error(`data.gov.au lists no ${state} holidays for ${year}`);
  return parsed;
}

interface NagerRow { date?: string; name?: string; localName?: string; counties?: string[] | null; types?: string[] | null; global?: boolean }

export function parseNagerRows(rows: NagerRow[], year: number, state: string): SyncHoliday[] {
  const county = `AU-${state.toUpperCase()}`;
  const out: SyncHoliday[] = [];
  for (const r of rows) {
    if (!r || !dateOk(clean(r.date)) || Number(clean(r.date).slice(0, 4)) !== year) continue;
    if (Array.isArray(r.counties) && r.counties.length && !r.counties.includes(county)) continue;
    if (Array.isArray(r.types) && r.types.length && !r.types.includes("Public")) continue;
    const { name, tentative } = normaliseVicName(r.name || r.localName || "");
    if (!name) continue;
    out.push({ date: clean(r.date), name, note: tentative ? "Tentative date (Nager.Date): it is confirmed automatically once Victoria declares the day." : "", tentative });
  }
  return completeVictorianDays(out, year);
}

export async function fetchNager(year: number, state: string, fetchJson: FetchJson, api = NAGER_API): Promise<SyncHoliday[]> {
  const rows = await fetchJson(`${api}/PublicHolidays/${year}/AU`);
  if (!Array.isArray(rows)) throw new Error(`Nager.Date returned no list for ${year}`);
  const holidays = parseNagerRows(rows as NagerRow[], year, state);
  if (!holidays.length) throw new Error(`Nager.Date lists no ${state} holidays for ${year}`);
  return holidays;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** One year: data.gov.au first, Nager.Date when it is unavailable or has no dataset for the year. */
export async function planYear(year: number, state: string, fetchJson: FetchJson, apis: { dataGov: string; nager: string }, skipped: string[]): Promise<YearResult> {
  let fallbackReason: string;
  try {
    const r = await fetchDataGov(year, state, fetchJson, apis.dataGov);
    skipped.push(...r.skipped);
    return { source: "data.gov.au", holidays: r.holidays };
  } catch (e) { fallbackReason = `data.gov.au: ${reason(e)}`; }
  try {
    return { source: "nager", holidays: await fetchNager(year, state, fetchJson, apis.nager), fallbackReason };
  } catch (e) { return { error: `${fallbackReason}; Nager.Date: ${reason(e)}` }; }
}

/** Every year in turn; ok when at least one year could be read (the database applies the readable years and records the rest). */
export async function runSync(years: number[], state: string, fetchJson: FetchJson, apis = { dataGov: DATA_GOV_API, nager: NAGER_API }): Promise<SyncResult> {
  const skipped: string[] = [];
  const out: Record<string, YearResult> = {};
  for (const y of years) out[String(y)] = await planYear(y, state, fetchJson, apis, skipped);
  const errors = Object.entries(out).filter(([, r]) => "error" in r).map(([y, r]) => `${y}: ${(r as { error: string }).error}`);
  const ok = errors.length < years.length;
  return { ok, ...(ok ? {} : { error: errors.join(" | ").slice(0, 2000) }), years: out, detail: { dataGov: apis.dataGov, nager: apis.nager, skipped } };
}
