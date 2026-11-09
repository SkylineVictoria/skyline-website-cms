/**
 * Time formatting for the HRMS. Every instant is shown in the HR timezone from hr.settings (Australia/Melbourne), never the
 * browser's zone, through Intl with the en-AU locale. Pure functions.
 */
export const DEFAULT_TZ = "Australia/Melbourne";
export const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // ISO day numbers 1..7
export const PUNCH_LABEL: Record<string, string> = { punch_in: "Punch in", break_start: "Start break", break_end: "End break", punch_out: "Punch out", void: "Void", none: "Not punched in" };
export const STATE_LABEL: Record<string, string> = { none: "Off the clock", punch_out: "Off the clock", punch_in: "Working", break_end: "Working", break_start: "On a break" };
export const FLAG_LABEL: Record<string, string> = { missing_punch_out: "Missing punch-out", unclosed_break: "Unclosed break", weekend: "Weekend", public_holiday: "Public holiday" };

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-AU", { timeZone, ...options }); }
    catch { f = new Intl.DateTimeFormat("en-AU", { timeZone: DEFAULT_TZ, ...options }); }
    cache.set(key, f);
  }
  return f;
}
const toDate = (instant: string | number | Date): Date => (instant instanceof Date ? instant : new Date(instant));

/** "AEDT" / "AEST" for an instant in the zone. */
export function tzAbbrev(instant: string | number | Date, timeZone = DEFAULT_TZ): string {
  const parts = formatter(timeZone, { timeZoneName: "short", hour: "numeric" }).formatToParts(toDate(instant));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}
/** "9:05 am" */
export const fmtTime = (instant: string | number | Date | null | undefined, timeZone = DEFAULT_TZ): string =>
  instant ? formatter(timeZone, { hour: "numeric", minute: "2-digit", hour12: true }).format(toDate(instant)) : "";
/** "Mon 16 Nov 2026, 9:05 am" */
export const fmtDateTime = (instant: string | number | Date | null | undefined, timeZone = DEFAULT_TZ): string =>
  instant ? formatter(timeZone, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(toDate(instant)) : "";
/** A calendar date (ISO yyyy-mm-dd, no zone) as "Mon 16 Nov 2026". */
export function fmtDate(iso: string | null | undefined, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" }): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", ...options }).format(new Date(Date.UTC(y, m - 1, d)));
}
export const fmtDateShort = (iso: string | null | undefined): string => fmtDate(iso, { day: "numeric", month: "short" });
export const fmtRange = (from: string, to: string): string => `${fmtDate(from, { day: "numeric", month: "short" })} – ${fmtDate(to, { day: "numeric", month: "short", year: "numeric" })}`;

/** The local calendar date (ISO) of an instant in the zone. */
export function isoDateIn(instant: string | number | Date, timeZone = DEFAULT_TZ): string {
  const parts = formatter(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(toDate(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export const isoToday = (timeZone = DEFAULT_TZ): string => isoDateIn(Date.now(), timeZone);
/** ISO date n days from a date. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
/** The offset (minutes east of UTC) of the zone at an instant, read back from Intl. */
export function tzOffsetMinutes(instant: Date, timeZone = DEFAULT_TZ): number {
  const parts = formatter(timeZone, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}
/** A wall-clock time in the zone ("2026-11-16T09:05") as an ISO instant (DST-safe: two passes over the offset). */
export function zonedToInstant(local: string, timeZone = DEFAULT_TZ): string {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error("Enter a date and time.");
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  let guess = new Date(wall - tzOffsetMinutes(new Date(wall), timeZone) * 60000);
  guess = new Date(wall - tzOffsetMinutes(guess, timeZone) * 60000);
  return guess.toISOString();
}
/** An instant as the zone's wall-clock "yyyy-mm-ddThh:mm" (for datetime-local inputs). */
export function instantToZoned(instant: string | Date, timeZone = DEFAULT_TZ): string {
  const parts = formatter(timeZone, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(toDate(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")}`;
}

export function minutesToHm(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(minutes ?? 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export const hoursLabel = (hours: number | string | null | undefined): string => `${Number(hours ?? 0).toFixed(2)} h`;
export const money = (n: number | string | null | undefined): string => (n === null || n === undefined || n === "" ? "" : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(n)));
/** "3h 12m" between an instant and now (or another instant). */
export function elapsedLabel(since: string | null | undefined, now: number = Date.now()): string {
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export const weekdayNames = (days: number[] | null | undefined): string => (days ?? []).map((d) => WEEKDAY_SHORT[d] ?? String(d)).join(", ");
export const PERIOD_STATUS_LABEL: Record<string, string> = { open: "Open", locked: "Locked", exported: "Exported" };
export const LEAVE_STATUS_LABEL: Record<string, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled" };
