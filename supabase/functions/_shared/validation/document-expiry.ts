export type ExpiryDocument = "passport" | "visa" | "english";
export type ExpiryStatus = "expired" | "expiring_soon" | "valid" | "unknown";

export interface DocumentExpiry {
  status: ExpiryStatus;
  /** The expiry (or computed valid-until) date as YYYY-MM-DD; null when unknown. */
  date: string | null;
  /** True when the expiry date is today. */
  expiresToday: boolean;
}

/** Form / extraction field that holds each document's expiry. English falls back to the test date. */
export const EXPIRY_FIELDS: Record<ExpiryDocument, string> = { passport: "passport_expiry", visa: "visa_stay_until", english: "english_date" };

const NOUN: Record<ExpiryDocument, string> = { passport: "passport", visa: "visa", english: "English test result" };
const SOON_MONTHS = 6;
const ENGLISH_VALID_YEARS = 2;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAY_MS = 86_400_000;
const dayNumber = (year: number, month: number, day: number) => Date.UTC(year, month, day) / DAY_MS;
const iso = (days: number) => new Date(days * DAY_MS).toISOString().slice(0, 10);

/** Parses YYYY-MM-DD or DD/MM/YYYY into a real calendar date, or null. */
function parseDate(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const [year, month, day] = match ? [+match[1], +match[2], +match[3]] : dayFirst ? [+dayFirst[3], +dayFirst[2], +dayFirst[1]] : [NaN, NaN, NaN];
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1) return null;
  const real = new Date(Date.UTC(year, month - 1, day));
  return real.getUTCMonth() === month - 1 && real.getUTCDate() === day ? { year, month: month - 1, day } : null;
}

/**
 * Is a document expired? Dates only, compared with today's date in the user's local timezone.
 * An expiry of today is still valid. English results are valid for two years from the test date;
 * a printed valid-until (`english_valid_until` / `english_expiry`) wins when present.
 */
export function getDocumentExpiryStatus(type: ExpiryDocument, values: Record<string, unknown>, today: Date = new Date()): DocumentExpiry {
  let expiry: number | null = null;
  if (type === "english") {
    const printed = parseDate(values.english_valid_until) ?? parseDate(values.english_expiry);
    const taken = parseDate(values.english_date);
    if (printed) expiry = dayNumber(printed.year, printed.month, printed.day);
    else if (taken) expiry = dayNumber(taken.year + ENGLISH_VALID_YEARS, taken.month, taken.day);
  } else {
    const parsed = parseDate(values[EXPIRY_FIELDS[type]]);
    if (parsed) expiry = dayNumber(parsed.year, parsed.month, parsed.day);
  }
  if (expiry === null) return { status: "unknown", date: null, expiresToday: false };

  const now = dayNumber(today.getFullYear(), today.getMonth(), today.getDate());
  const date = iso(expiry);
  if (expiry < now) return { status: "expired", date, expiresToday: false };
  if (type !== "english" && expiry <= dayNumber(today.getFullYear(), today.getMonth() + SOON_MONTHS, today.getDate())) return { status: "expiring_soon", date, expiresToday: expiry === now };
  return { status: "valid", date, expiresToday: expiry === now };
}

/** 12 Mar 2025 */
export function formatExpiryDate(date: string): string {
  const parsed = parseDate(date);
  return parsed ? `${parsed.day} ${MONTHS[parsed.month]} ${parsed.year}` : date;
}

/** The sentence shown under a wizard file chip; empty when there is nothing to warn about. */
export function expiryMessage(type: ExpiryDocument, expiry: DocumentExpiry): string {
  if (!expiry.date) return "";
  const when = formatExpiryDate(expiry.date);
  if (expiry.status === "expired") return `This ${NOUN[type]} expired on ${when}. Please upload a valid one.`;
  if (expiry.status === "expiring_soon" && expiry.expiresToday) return `This ${NOUN[type]} expires today.`;
  if (expiry.status === "expiring_soon") return `This ${NOUN[type]} expires on ${when} (within ${SOON_MONTHS} months).`;
  return "";
}

/** Short badge text for the form and review screen. */
export function expiryLabel(expiry: DocumentExpiry): string {
  return expiry.status === "expired" ? "Expired" : expiry.expiresToday ? "Expires today" : "Expiring soon";
}

/** Tooltip text: the date, and "Expires today" on the day itself. */
export function expiryTooltip(expiry: DocumentExpiry): string {
  if (!expiry.date) return "";
  return expiry.status === "expiring_soon" && expiry.expiresToday ? `Expires today (${formatExpiryDate(expiry.date)})` : `${expiry.status === "expired" ? "Expired" : "Expires"} ${formatExpiryDate(expiry.date)}`;
}

/** Text colour for a status; red for expired, amber for expiring soon. */
export function expiryTone(status: ExpiryStatus): string {
  return status === "expired" ? "text-red-700" : "text-amber-700";
}
