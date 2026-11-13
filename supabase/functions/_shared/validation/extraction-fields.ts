/**
 * Maps the non-country fields of a document extraction to the exact option or format the application form holds (country fields are
 * handled by countries.ts). A value that cannot be matched is taken out of the fields, because a radio or a date input cannot hold it,
 * and is returned with a note so the agent sees it instead of an empty field.
 */

import { normaliseCountry } from "./countries.ts";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const DATE_FIELDS = ["dob", "passport_expiry", "visa_grant_date", "visa_stay_until", "english_date", "oshc_cover_start", "oshc_expiry"] as const;
const FIELD_NAMES: Record<string, string> = {
  gender: "Gender", dob: "Date of birth", passport_expiry: "Passport expiry", visa_grant_date: "Visa grant date", visa_stay_until: "Visa stay until",
  english_date: "English test date", oshc_cover_start: "OSHC start date", oshc_expiry: "OSHC expiry", au_state: "State", holds_visa: "Holds an Australian visa", address_type: "Address type",
};

const AU_STATES: Record<string, string> = {
  nsw: "NSW", "new south wales": "NSW", vic: "VIC", victoria: "VIC", qld: "QLD", queensland: "QLD", sa: "SA", "south australia": "SA",
  wa: "WA", "western australia": "WA", tas: "TAS", tasmania: "TAS", nt: "NT", "northern territory": "NT", act: "ACT", "australian capital territory": "ACT",
};

const key = (value: string): string => value.trim().toLowerCase().replace(/[._-]/g, " ").replace(/\s+/g, " ");

export function normaliseGender(raw: string): string | null {
  const text = key(raw);
  if (["m", "male", "man"].includes(text)) return "Male";
  if (["f", "female", "woman"].includes(text)) return "Female";
  if (text === "prefer not to say") return "Prefer not to say";
  return null;
}

export function normaliseAuState(raw: string): string | null {
  return AU_STATES[key(raw)] ?? null;
}

export function normaliseYesNo(raw: string): string | null {
  const text = key(raw);
  if (["yes", "y", "true"].includes(text)) return "Yes";
  if (["no", "n", "false"].includes(text)) return "No";
  return null;
}

function iso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** yyyy-mm-dd for a calendar date written as ISO, day-first numeric (Australian order) or with a month name; null when it is not a real date. */
export function normaliseIsoDate(raw: string): string | null {
  const text = raw.trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? text.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (match) return iso(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (match) return iso(Number(match[3]), Number(match[2]), Number(match[1]));
  match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[ \-/]([A-Za-z]{3,9})\.?,?[ \-/](\d{4})$/);
  if (match) {
    const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
    return month >= 0 ? iso(Number(match[3]), month + 1, Number(match[1])) : null;
  }
  return null;
}

export function normaliseFormFields(fields: Record<string, string>): { fields: Record<string, string>; unmatched: Record<string, string>; notes: string[] } {
  const out = { ...fields };
  const unmatched: Record<string, string> = {};
  const notes: string[] = [];
  const apply = (name: string, map: (raw: string) => string | null) => {
    const raw = out[name];
    if (raw === undefined) return;
    const value = map(raw);
    if (value) out[name] = value;
    else {
      delete out[name];
      unmatched[name] = raw;
      notes.push(`${FIELD_NAMES[name] ?? name} "${raw}" was read from the document but does not match the form. Enter it manually.`);
    }
  };
  apply("gender", normaliseGender);
  for (const name of DATE_FIELDS) apply(name, normaliseIsoDate);
  apply("au_state", normaliseAuState);
  apply("holds_visa", normaliseYesNo);
  apply("address_type", (raw) => (key(raw) === "australian address" ? "Australian Address" : key(raw) === "overseas address" ? "Overseas Address" : null));
  return { fields: out, unmatched, notes };
}

/** Well-known birth places and the country they are in (names resolve through the country normaliser). Small on purpose: an unknown place suggests nothing. */
const PLACES: Record<string, string> = {
  mumbai: "India", bombay: "India", delhi: "India", "new delhi": "India", bangalore: "India", bengaluru: "India", chennai: "India", madras: "India", kolkata: "India", calcutta: "India",
  hyderabad: "India", pune: "India", ahmedabad: "India", jaipur: "India", chandigarh: "India", amritsar: "India", ludhiana: "India", jalandhar: "India", lucknow: "India", surat: "India",
  kathmandu: "Nepal", pokhara: "Nepal", lalitpur: "Nepal", biratnagar: "Nepal", bharatpur: "Nepal",
  manila: "Philippines", "quezon city": "Philippines", cebu: "Philippines", "cebu city": "Philippines", davao: "Philippines", "davao city": "Philippines",
  colombo: "Sri Lanka", kandy: "Sri Lanka", dhaka: "Bangladesh", chittagong: "Bangladesh", karachi: "Pakistan", lahore: "Pakistan", islamabad: "Pakistan", rawalpindi: "Pakistan",
  london: "United Kingdom", manchester: "United Kingdom", birmingham: "United Kingdom", glasgow: "United Kingdom", edinburgh: "United Kingdom", liverpool: "United Kingdom",
  "new york": "United States", "los angeles": "United States", chicago: "United States", houston: "United States", "san francisco": "United States", boston: "United States",
  toronto: "Canada", vancouver: "Canada", montreal: "Canada", auckland: "New Zealand", wellington: "New Zealand", christchurch: "New Zealand",
  sydney: "Australia", melbourne: "Australia", brisbane: "Australia", perth: "Australia", adelaide: "Australia", canberra: "Australia",
  hanoi: "Vietnam", "ho chi minh city": "Vietnam", saigon: "Vietnam", bangkok: "Thailand", jakarta: "Indonesia", surabaya: "Indonesia", "kuala lumpur": "Malaysia", singapore: "Singapore",
  beijing: "China", shanghai: "China", guangzhou: "China", shenzhen: "China", "hong kong": "Hong Kong", seoul: "South Korea", tokyo: "Japan", osaka: "Japan",
  nairobi: "Kenya", lagos: "Nigeria", accra: "Ghana", johannesburg: "South Africa", "cape town": "South Africa", cairo: "Egypt", tehran: "Iran", kabul: "Afghanistan", thimphu: "Bhutan",
  paris: "France", berlin: "Germany", madrid: "Spain", rome: "Italy", dubai: "United Arab Emirates", "abu dhabi": "United Arab Emirates", riyadh: "Saudi Arabia", istanbul: "Turkey",
};

/**
 * Place names that exist in more than one country (London, Ontario; Birmingham, Alabama; Hyderabad, Pakistan). Such a place is only ever a suggestion the agent
 * applies or rejects, never written automatically.
 */
const AMBIGUOUS_PLACES = new Set(["london", "birmingham", "manchester", "perth", "hyderabad", "paris", "melbourne", "sydney", "boston", "rome", "cairo", "madrid"]);

const placeKey = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The form's country option for a printed place of birth: "MUMBAI, INDIA" (a country named in the text) or a place on the built-in list. Null for anything
 * else. The server never guesses a country of birth; this only feeds a Suggested value in the Review.
 */
export function birthCountryForPlace(place: string): string | null {
  const parts = place.split(/[,/]/).map((part) => part.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const named = normaliseCountry(parts[i]);
    if (named) return named;
  }
  const country = parts.length ? PLACES[placeKey(parts[0])] : undefined;
  return country ? normaliseCountry(country) : null;
}

/**
 * The country that may be written into an empty country of birth without asking: a country named in the printed place, or an unambiguous city from the list.
 * Null for an unknown place and for an ambiguous city (which birthCountryForPlace still offers as a suggestion).
 */
export function birthCountryAuto(place: string): string | null {
  const parts = place.split(/[,/]/).map((part) => part.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const named = normaliseCountry(parts[i]);
    if (named) return named;
  }
  if (!parts.length || AMBIGUOUS_PLACES.has(placeKey(parts[0]))) return null;
  return birthCountryForPlace(place);
}
