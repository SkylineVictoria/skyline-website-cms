/*
 * Signed times on the signing pages (owner 2026-11-20): always SLIT's own time zone with its name, e.g. "19 Nov 2026, 4:42 pm AEDT",
 * whatever the signer's computer is set to. Dependency-free (used by the pages and the offline tests).
 */

/** SLIT is in Melbourne. */
export const SLIT_TIME_ZONE = "Australia/Melbourne";

/** "AEDT" / "AEST": the browser's short name, or the offset turned into the name when the browser only gives "GMT+11". */
function zoneName(raw: string): string {
  const offset = /^(?:GMT|UTC)\+(\d{1,2})(?::00)?$/.exec(raw.trim());
  if (offset) return offset[1] === "11" ? "AEDT" : offset[1] === "10" ? "AEST" : raw;
  return raw;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "19 Nov 2026, 4:42 pm AEDT" in Melbourne time; "" for a missing or unreadable date. */
export function formatSignedAt(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-AU", {
    timeZone: SLIT_TIME_ZONE, day: "numeric", month: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const month = MONTHS[Number(parts.month) - 1] ?? "";
  const period = String(parts.dayPeriod ?? "").toLowerCase().replace(/\./g, "").trim();
  return `${Number(parts.day)} ${month} ${parts.year}, ${parts.hour}:${parts.minute} ${period} ${zoneName(String(parts.timeZoneName ?? ""))}`.replace(/\s+/g, " ").trim();
}
