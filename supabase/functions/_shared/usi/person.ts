// From the application's answers (student details merged with the application's own values) to the USI fields (2026-11-23).
// Pure: no imports, no runtime APIs. The answers come from the database (usi_access), never from the caller, so the form cannot be used
// to check a USI against made-up details.

export type Values = Record<string, unknown>;
const s = (v: unknown) => String(v ?? "").trim();

/** USI names: letters, hyphen, apostrophe, space and full stop only; accents are dropped (the Registry refuses them). */
export function usiNamePart(raw: unknown, max = 40): string {
  return s(raw).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‘’`]/g, "'").replace(/[^A-Za-z' .-]/g, " ")
    .replace(/\s+/g, " ").replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "").slice(0, max).trim();
}

export interface UsiPersonNames { firstName?: string; middleName?: string; familyName?: string; singleName?: string }
/** First / middle / family name, or a single name when the student has only one name. */
export function usiNames(v: Values): UsiPersonNames {
  const first = usiNamePart(v.first_name), middle = usiNamePart(v.middle_name, 80), family = usiNamePart(v.last_name);
  if (first && family) return { firstName: first, middleName: middle || undefined, familyName: family };
  const single = family || first;
  return single ? { singleName: single } : {};
}

export function usiGender(v: Values): "M" | "F" | "X" {
  const g = s(v.gender).toLowerCase();
  return g === "male" || g === "m" ? "M" : g === "female" || g === "f" ? "F" : "X";
}

/** YYYY-MM-DD, or "" when the stored date is not a real date. */
export function usiDate(raw: unknown): string {
  const t = s(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const [y, mo, d] = iso ? [iso[1], iso[2], iso[3]] : au ? [au[3], au[2].padStart(2, "0"), au[1].padStart(2, "0")] : ["", "", ""];
  if (!y) return "";
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.getUTCMonth() === Number(mo) - 1 && date.getUTCDate() === Number(d) ? `${y}-${mo}-${d}` : "";
}

/** Town or city of birth: the first part of "Town, State" (passport scans store place of birth that way). */
export const usiTownOfBirth = (v: Values) => s(v.place_of_birth).split(",")[0].replace(/[^A-Za-z' .-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);

/** Australian mobile as 04xxxxxxxx (the only form Locate accepts); null for any other number. */
export function usiAustralianMobile(raw: unknown): string | null {
  const d = s(raw).replace(/\D/g, "");
  const national = d.startsWith("61") && d.length === 11 ? "0" + d.slice(2) : d;
  return /^04\d{8}$/.test(national) ? national : null;
}
/** Mobile for CreateUSI: 10 to 12 characters, "+" allowed first. */
export function usiCreateMobile(raw: unknown): string | null {
  const au = usiAustralianMobile(raw);
  if (au) return au;
  const d = s(raw).replace(/\D/g, "");
  if (d.length >= 10 && d.length <= 11) return "+" + d;
  return d.length === 12 ? d : null;
}

export const usiEmail = (v: Values) => { const e = s(v.email).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : ""; };

const STATE_NAMES: Record<string, string> = {
  "new south wales": "NSW", victoria: "VIC", queensland: "QLD", "south australia": "SA", "western australia": "WA", tasmania: "TAS",
  "northern territory": "NT", "australian capital territory": "ACT",
};
export function usiState(raw: unknown): string {
  const t = s(raw).toUpperCase().replace(/\./g, "");
  if (["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"].includes(t)) return t;
  return STATE_NAMES[s(raw).toLowerCase()] ?? "";
}

/** True when the student's address is in Australia (the form's "Australian Address" choice or an Australian country). */
export const livesInAustralia = (v: Values) => /australia/i.test(s(v.address_type)) || (!s(v.address_type) && /^australia$/i.test(s(v.au_country)));

export interface UsiAddressParts { address1: string; address2?: string; suburb: string; state: string; postcode: string }
export function usiNationalAddress(v: Values): UsiAddressParts | null {
  const address1 = s(v.au_street).slice(0, 50), suburb = s(v.au_suburb).slice(0, 50), state = usiState(v.au_state), postcode = s(v.au_zip);
  if (!address1 || !suburb || !state || !/^\d{4}$/.test(postcode)) return null;
  return { address1, address2: s(v.au_line2).slice(0, 50) || undefined, suburb, state, postcode };
}
export function usiInternationalAddress(v: Values): string {
  return [v.ov_street, v.ov_line2, v.ov_suburb, v.ov_state, v.ov_zip, v.ov_country].map(s).filter(Boolean).join(", ").slice(0, 250);
}

/** Country name -> USI country code (from GetCountries), case and punctuation ignored, with a few common spellings. */
const ALIASES: Record<string, string> = {
  usa: "united states of america", "united states": "united states of america", uk: "united kingdom", "great britain": "united kingdom",
  "south korea": "korea, republic of (south)", "korea": "korea, republic of (south)", vietnam: "vietnam", "viet nam": "vietnam",
  "hong kong": "hong kong (sar of china)", "china": "china (excludes sars and taiwan)", "taiwan": "taiwan", "iran": "iran",
};
const norm = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, " ").trim();
export function usiCountryCode(name: unknown, countries: { code: string; name: string; current?: boolean }[]): string {
  const want = norm(s(name));
  if (!want) return "";
  const target = norm(ALIASES[want] ?? want);
  const list = countries.filter((c) => c.current !== false);
  return (list.find((c) => norm(c.name) === target) ?? list.find((c) => norm(c.name).startsWith(target + " ")) ?? list.find((c) => norm(c.name) === want))?.code ?? "";
}

/** What Verify needs from the answers; problems in plain words when something is missing. */
export function usiVerifyInput(v: Values): { names: UsiPersonNames; dateOfBirth: string; problems: string[] } {
  const names = usiNames(v), dateOfBirth = usiDate(v.dob), problems: string[] = [];
  if (!names.familyName && !names.singleName) problems.push("the student's name");
  if (!dateOfBirth) problems.push("the date of birth");
  return { names, dateOfBirth, problems };
}
