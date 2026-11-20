// Term breaks from the Victorian school calendar (owner, 2026-11-20). Source: Victorian Government "Important Dates" open data
// (Department of Government Services, CC BY 4.0) on discover.data.vic.gov.au, read straight from the browser (no key; CORS open).
// The dataset's SCHOOL_TERM rows give each term's first and last day (published to 2030); a break is the gap between two terms,
// Monday to Sunday as SLIT runs them. Years after the last published term are forecast from the last published year, moved by
// whole weeks so the weekdays stay the same, and marked predicted (staff check them when the state publishes the dates).

export const VIC_DATES_URL = "https://discover.data.vic.gov.au/api/3/action/datastore_search";
export const VIC_DATES_RESOURCE = "caaa47de-8626-46a6-aa28-3d948c15c5d9";
export const VIC_DATES_SOURCE = "Victorian Government Important Dates (data.vic.gov.au, CC BY 4.0)";

export interface Term { year: number; term: number; start: string; end: string }
export interface SchoolBreak { label: string; startDate: string; endDate: string; predicted: boolean }
interface Row { dateType?: string; name?: string; important_date?: string }

const iso = (date: Date) => date.toISOString().slice(0, 10);
const day = (value: string) => new Date(value + "T00:00:00Z");
const addDays = (value: string, days: number) => iso(new Date(day(value).getTime() + days * 86400000));
const weekday = (value: string) => day(value).getUTCDay(); // 0 Sunday … 6 Saturday

/** "7/10/2030" -> "2030-10-07". */
function parseDate(text: string | undefined): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((text ?? "").trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

/** School terms from the dataset rows ("Term 3 2030 - Start date", "Term 4  2019 -End date"). A term listed twice keeps its earliest start and latest end. */
export function parseVicTerms(rows: Row[]): Term[] {
  const found = new Map<string, { year: number; term: number; start?: string; end?: string }>();
  for (const row of rows) {
    if (row.dateType && row.dateType !== "SCHOOL_TERM") continue;
    const m = /term\s*([1-4])\D*?(\d{4})\D*?(start|end)/i.exec(row.name ?? "");
    const date = parseDate(row.important_date);
    if (!m || !date) continue;
    const key = `${m[2]}-${m[1]}`;
    const item = found.get(key) ?? { year: Number(m[2]), term: Number(m[1]) };
    if (m[3].toLowerCase() === "start") item.start = !item.start || date < item.start ? date : item.start;
    else item.end = !item.end || date > item.end ? date : item.end;
    found.set(key, item);
  }
  return [...found.values()].filter((t): t is Term => !!t.start && !!t.end && t.start <= t.end)
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Reads every school term of the dataset (one request). */
export async function fetchVicTerms(fetchImpl: typeof fetch = fetch): Promise<Term[]> {
  const url = `${VIC_DATES_URL}?resource_id=${VIC_DATES_RESOURCE}&limit=1000&filters=${encodeURIComponent(JSON.stringify({ dateType: "SCHOOL_TERM" }))}`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`The Victorian school calendar could not be read (HTTP ${response.status}).`);
  const body = await response.json() as { success?: boolean; result?: { records?: Row[] } };
  if (!body.success || !Array.isArray(body.result?.records)) throw new Error("The Victorian school calendar sent an unexpected answer.");
  const terms = parseVicTerms(body.result.records);
  if (!terms.length) throw new Error("The Victorian school calendar has no school terms.");
  return terms;
}

/** The terms up to `untilYear`: published ones, then forecasts from the last fully published year (whole weeks later). */
export function termsUntil(terms: Term[], untilYear: number): (Term & { predicted: boolean })[] {
  const out = terms.map(t => ({ ...t, predicted: false }));
  const full = [...new Set(terms.map(t => t.year))].filter(year => [1, 2, 3, 4].every(n => terms.some(t => t.year === year && t.term === n)));
  const base = Math.max(...full);
  if (!Number.isFinite(base)) return out;
  const pattern = terms.filter(t => t.year === base);
  for (let year = Math.max(...terms.map(t => t.year)) + 1; year <= untilYear; year++) {
    const shift = Math.round(((year - base) * 365.2425) / 7) * 7;
    for (const t of pattern) out.push({ year, term: t.term, start: addDays(t.start, shift), end: addDays(t.end, shift), predicted: true });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** The breaks between consecutive terms that touch [from, to], Monday after a term ends to Sunday before the next starts. */
export function schoolBreaks(terms: Term[], from: string, to: string): SchoolBreak[] {
  const all = termsUntil(terms, Number(to.slice(0, 4)) + 1);
  const out: SchoolBreak[] = [];
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i], b = all[i + 1];
    let start = addDays(a.end, 1);
    while (weekday(start) !== 1) start = addDays(start, 1);
    let end = addDays(b.start, -1);
    while (weekday(end) !== 0) end = addDays(end, -1);
    if (end < start || end < from || start > to) continue;
    const label = a.term === 4 ? `Summer break ${a.year}–${String(b.year).slice(2)}` : `Term ${a.term} break ${a.year}`;
    const predicted = a.predicted || b.predicted;
    out.push({ label: predicted ? `${label} (predicted: check)` : label, startDate: start, endDate: end, predicted });
  }
  return out;
}

/** The school breaks not overlapping a break already saved (those are kept as staff entered them). */
export function newBreaks(wanted: SchoolBreak[], existing: { startDate: string; endDate: string }[]): SchoolBreak[] {
  const taken = [...existing];
  return wanted.filter(item => {
    if (taken.some(other => other.startDate <= item.endDate && other.endDate >= item.startDate)) return false;
    taken.push(item);
    return true;
  });
}
