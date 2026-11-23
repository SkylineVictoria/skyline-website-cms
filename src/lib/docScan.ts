/**
 * Turns raw OCR text from a passport, English test result or driver licence
 * into a map of { enrollFieldName: value }. The values are then written into the
 * live form so applicants never have to retype what a document already says.
 *
 * Everything here is best-effort: the applicant can always edit the result.
 */

import { countries } from "@/data/applicationForms";

export type ScanType = "passport" | "english" | "licence" | "academic" | "visa";

export const SCAN_CONFIG: Record<ScanType, { title: string; hint: string; icon: string }> = {
  passport: {
    title: "Passport — read automatically",
    hint: "Upload a clear photo or PDF of your passport and we read it straight away to fill your name, date of birth, passport number, expiry and nationality.",
    icon: "ri-id-card-line",
  },
  english: {
    title: "English test result — read automatically",
    hint: "Upload your IELTS / PTE / TOEFL result (photo or PDF) and we read your test type, score and date straight away.",
    icon: "ri-translate-2",
  },
  licence: {
    title: "Driver licence — read automatically (best-effort)",
    hint: "Upload your driver licence and we pre-fill your name, date of birth and address. Always check every field afterwards.",
    icon: "ri-profile-line",
  },
  academic: {
    title: "Academic marksheets — read automatically (best-effort)",
    hint: "Upload your transcripts, certificates or marksheets (photo or PDF). You can add several files and we read your institution, qualification and year straight away.",
    icon: "ri-file-paper-2-line",
  },
  visa: {
    title: "Visa grant notice — read automatically",
    hint: "Upload a visa grant letter or VEVO record. Only values explicitly printed on it are proposed for review.",
    icon: "ri-passport-line",
  },
};

/** ISO-3166 alpha-3 codes (as encoded in a passport MRZ) → country names used in the form. */
const ISO3_TO_COUNTRY: Record<string, string> = {
  AUS: "Australia",
  AFG: "Afghanistan",
  BGD: "Bangladesh",
  BTN: "Bhutan",
  BRA: "Brazil",
  KHM: "Cambodia",
  CAN: "Canada",
  CHN: "China",
  COL: "Colombia",
  FJI: "Fiji",
  FRA: "France",
  DEU: "Germany",
  HKG: "Hong Kong",
  IND: "India",
  IDN: "Indonesia",
  IRL: "Ireland",
  ITA: "Italy",
  JPN: "Japan",
  KEN: "Kenya",
  KOR: "Korea, Republic of",
  KWT: "Kuwait",
  MYS: "Malaysia",
  MDV: "Maldives",
  MUS: "Mauritius",
  MEX: "Mexico",
  MMR: "Myanmar",
  NPL: "Nepal",
  NLD: "Netherlands",
  NZL: "New Zealand",
  NGA: "Nigeria",
  OMN: "Oman",
  PAK: "Pakistan",
  PNG: "Papua New Guinea",
  PER: "Peru",
  PHL: "Philippines",
  POL: "Poland",
  PRT: "Portugal",
  QAT: "Qatar",
  RUS: "Russian Federation",
  SAU: "Saudi Arabia",
  SGP: "Singapore",
  ZAF: "South Africa",
  ESP: "Spain",
  LKA: "Sri Lanka",
  SWE: "Sweden",
  CHE: "Switzerland",
  TWN: "Taiwan",
  TZA: "Tanzania, the United Republic of",
  THA: "Thailand",
  TUR: "Turkey",
  UGA: "Uganda",
  UKR: "Ukraine",
  ARE: "United Arab Emirates",
  GBR: "United Kingdom",
  USA: "United States",
  VNM: "Viet Nam",
  ZWE: "Zimbabwe",
};

/** Repairs the characters OCR most often mixes up inside the numeric MRZ regions. */
function mrzDigits(raw: string): string {
  return raw
    .replace(/[OQDoq]/g, "0")
    .replace(/[IlL|!]/g, "1")
    .replace(/[Zz]/g, "2")
    .replace(/[Ss]/g, "5")
    .replace(/[Bb]/g, "8")
    .replace(/[Gg]/g, "6")
    .replace(/[^0-9]/g, "");
}

/** Keeps only A–Z, for the 3-letter nationality code. */
function mrzLetters(raw: string): string {
  return raw.replace(/[^A-Z]/g, "");
}

/** Converts a YYMMDD MRZ date segment into an ISO date string. */
function mrzDate(raw: string, force20xx: boolean): string {
  const digits = mrzDigits(raw);
  if (digits.length < 6) return "";
  const segment = digits.slice(0, 6);
  const yy = parseInt(segment.slice(0, 2), 10);
  const mm = segment.slice(2, 4);
  const dd = segment.slice(4, 6);
  const currentYY = new Date().getFullYear() % 100;
  const century = force20xx ? 2000 : yy > currentYY ? 1900 : 2000;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${century + yy}-${mm}-${dd}`;
}

/** Converts a DD/MM/YYYY (or YY) style date found in free text into ISO. */
function looseDate(raw: string): string {
  const parts = raw.split(/[\/\-.]/).map((part) => part.trim());
  if (parts.length !== 3) return "";
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  let year = parseInt(parts[2], 10);
  if (Number.isNaN(day) || Number.isNaN(month) || Number.isNaN(year)) return "";
  if (parts[2].length === 2) year += year > 60 ? 1900 : 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function splitGivenNames(given: string): { first: string; middle: string } {
  const tokens = given.split(/\s+/).filter(Boolean);
  const first = tokens[0] ?? "";
  const middle = tokens.slice(1).join(" ");
  return { first, middle };
}

/**
 * MRZ names are printed in block capitals ("MIHIR", "O'BRIEN"), which look wrong in
 * a form. This trims them to natural case: "MIHIR" → "Mihir", "O'BRIEN" → "O'Brien".
 */
function properName(value: string): string {
  return value
    .toLowerCase()
    .replace(
      /(^|[\s'-])([a-z])/g,
      (_match, boundary: string, letter: string) => `${boundary}${letter.toUpperCase()}`,
    );
}

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** Parses "03 Oct 1983", "03 OCT 1983" or "3-Oct-83" into an ISO date. */
function wordDate(raw: string): string {
  const match = /(\d{1,2})\s*[\/\-\s.]?\s*([A-Za-z]{3,})\s*[\/\-\s.]?\s*(\d{2,4})/.exec(raw);
  if (!match) return "";
  const day = parseInt(match[1], 10);
  const month = MONTHS[match[2].slice(0, 3).toLowerCase()];
  let year = parseInt(match[3], 10);
  if (!month || Number.isNaN(day) || Number.isNaN(year)) return "";
  if (match[3].length === 2) year += year > 60 ? 1900 : 2000;
  if (day < 1 || day > 31) return "";
  return `${String(year).padStart(4, "0")}-${month}-${String(day).padStart(2, "0")}`;
}

/** Any date shape (ISO, D/M/Y or "03 Oct 1983") → ISO, or "" when unparseable. */
function anyDate(raw: string): string {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const loose = /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/.exec(raw);
  if (loose) {
    const parsed = looseDate(loose[1]);
    if (parsed) return parsed;
  }
  return wordDate(raw);
}

/** Maps a printed country name / code to the exact option used in the form. */
const COUNTRY_ALIASES: Record<string, string> = {
  USA: "United States",
  US: "United States",
  "UNITED STATES OF AMERICA": "United States",
  "UNITED STATES": "United States",
  UK: "United Kingdom",
  "UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND": "United Kingdom",
  "GREAT BRITAIN": "United Kingdom",
  ENGLAND: "United Kingdom",
  "SOUTH KOREA": "Korea, Republic of",
  "REPUBLIC OF KOREA": "Korea, Republic of",
  KOREA: "Korea, Republic of",
  RUSSIA: "Russian Federation",
  VIETNAM: "Viet Nam",
  "VIET NAM": "Viet Nam",
  TANZANIA: "Tanzania, the United Republic of",
  UAE: "United Arab Emirates",
  "THE NETHERLANDS": "Netherlands",
  HOLLAND: "Netherlands",
};

function matchCountry(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z ,]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  if (cleaned.length < 3) return "";
  if (COUNTRY_ALIASES[cleaned]) return COUNTRY_ALIASES[cleaned];
  const exact = countries.find((country) => country.toUpperCase() === cleaned);
  if (exact) return exact;
  return (
    countries.find(
      (country) =>
        country.length >= 5 &&
        (cleaned.includes(country.toUpperCase()) || country.toUpperCase().includes(cleaned)),
    ) ?? ""
  );
}

/**
 * MRZ check digit (ICAO 9303): digits 0-9, A=10…Z=35, '<'=0, weighted 7-3-1.
 */
const MRZ_WEIGHTS = [7, 3, 1];

function mrzCharValue(char: string): number {
  if (char >= "0" && char <= "9") return char.charCodeAt(0) - 48;
  if (char >= "A" && char <= "Z") return char.charCodeAt(0) - 55;
  return 0;
}

function mrzCheckDigit(input: string): number {
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    sum += mrzCharValue(input[index]) * MRZ_WEIGHTS[index % 3];
  }
  return sum % 10;
}

/** Characters OCR routinely confuses inside the MRZ, used to auto-repair one slip. */
const MRZ_CONFUSIONS: Record<string, string[]> = {
  "0": ["O", "Q", "D", "8"],
  O: ["0", "Q"],
  Q: ["0", "O"],
  "1": ["I", "L", "7"],
  I: ["1", "L"],
  L: ["1", "I"],
  "7": ["1"],
  "2": ["Z"],
  Z: ["2"],
  "5": ["S"],
  S: ["5"],
  "8": ["B", "0"],
  B: ["8"],
  "6": ["G", "0"],
  G: ["6"],
  "4": ["A"],
  A: ["4"],
};

/**
 * Returns the field unchanged when its check digit already agrees, otherwise tries
 * single-character fixes so a real passport survives a one-character OCR slip.
 * Returns null when nothing lines up (the caller then treats the MRZ as unreliable).
 */
function repairMrzField(raw: string, check: string): string | null {
  if (!/^\d$/.test(check)) return null;
  const target = Number(check);
  if (mrzCheckDigit(raw) === target) return raw;
  for (let index = 0; index < raw.length; index += 1) {
    const alternatives = MRZ_CONFUSIONS[raw[index]] ?? [];
    for (const alternative of alternatives) {
      const candidate = `${raw.slice(0, index)}${alternative}${raw.slice(index + 1)}`;
      if (mrzCheckDigit(candidate) === target) return candidate;
    }
  }
  return null;
}

/** How many of a second row's three check digits agree — a real passport scores 3. */
function mrzLine2Score(line2: string): number {
  const line = line2.padEnd(44, "<").slice(0, 44);
  let score = 0;
  if (/^\d$/.test(line[9]) && mrzCheckDigit(line.slice(0, 9)) === Number(line[9])) score += 1;
  if (/^\d$/.test(line[19]) && mrzCheckDigit(line.slice(13, 19)) === Number(line[19])) score += 1;
  if (/^\d$/.test(line[27]) && mrzCheckDigit(line.slice(21, 27)) === Number(line[27])) score += 1;
  return score;
}

/** A plausible single name part — short enough not to be a run of merged page text. */
function isPlausibleName(token: string): boolean {
  return token.length >= 2 && token.length <= 24 && !/(.)\1{5,}/.test(token);
}

/**
 * Synthetic-fixture diagnostic only. Do not call this with a real passport or
 * send its output to telemetry: it intentionally exposes candidate MRZ rows.
 */
export function diagnoseSyntheticPassportMrz(text: string) {
  const candidates = text.toUpperCase().replace(/\r/g, "").split("\n")
    .filter((line) => /[A-Z0-9<]/.test(line));
  const normalized = candidates.map((line) => line.replace(/[^A-Z0-9<]/g, ""));
  const line1 = normalized.find((line) => /^P<[A-Z]{3}/.test(line) && line.length === 44) ?? "";
  const at = line1 ? normalized.indexOf(line1) : -1;
  const line2 = at >= 0 ? normalized[at + 1] ?? "" : "";
  const score = line2.length === 44 ? mrzLine2Score(line2) : 0;
  const name = line1.slice(5);
  const separator = name.indexOf("<<");
  return {
    candidateLines: candidates,
    normalizedLines: normalized,
    td3Lengths: [line1.length, line2.length],
    checksumScore: score,
    nameSeparatorPresent: separator >= 0,
    selectedFieldSources: score >= 2 && separator >= 0 ? { names: "mrz", identity: "mrz" } : { names: "rejected", identity: "rejected" },
  };
}

/** Safe production summary: contains counts/statuses only, never MRZ text. */
export function passportMrzSummary(text: string) {
  const diagnostic = diagnoseSyntheticPassportMrz(text);
  return { candidateCount: diagnostic.normalizedLines.length, checksumScore: diagnostic.checksumScore, nameSeparatorPresent: diagnostic.nameSeparatorPresent };
}

/** Reads the machine-readable zone (the <<< lines) — the most reliable source on a passport. */
function parsePassportMrz(text: string): Record<string, string> {
  const cleaned = text.toUpperCase().replace(/[«»‹›]/g, "<").replace(/\r/g, "");

  // Keep anything that could be an MRZ row. Tesseract frequently inserts spaces
  // between the widely-spaced MRZ characters, so we strip everything but the
  // characters an MRZ can legally contain before measuring the row.
  const rows = cleaned
    .split(/\n/)
    .map((line) => line.replace(/[^A-Z0-9<]/g, ""))
    .filter((line) => line.length >= 20);

  let line1 = "";
  let line2 = "";

  // 1) Two consecutive rows where the first is the name row: P<COUNTRY (or PCOUNTRY).
  for (let index = 0; index < rows.length; index += 1) {
    // TD3 is exactly two 44-character rows. A short P-like visual row must
    // never be padded into a trusted name source.
    if (/^P<[A-Z]{3}/.test(rows[index]) && (rows[index].length === 44 || rows[index].length >= 88)) {
      line1 = rows[index];
      line2 = rows[index + 1] ?? "";
      break;
    }
  }

  // 2) The name row was found but OCR glued it to the next row — take the first 88 chars.
  if (line1 && line1.length >= 88 && (!line2 || line2.length < 44)) {
    line2 = line1.slice(44, 88);
    line1 = line1.slice(0, 44);
  }

  // 3) No P< row at all: fall back to the two densest MRZ-looking rows.
  if (!line1) {
    const dense = rows.filter((row) => row.length === 44 && (/<{3,}/.test(row) || /\d{6}/.test(row)));
    if (dense.length >= 2) {
      line1 = dense[0];
      line2 = dense[1];
    }
  }

  if (!line1 || !line2 || line1.length !== 44 || line2.length !== 44 || !/^P<[A-Z]{3}/.test(line1)) return {};

  const first = line1;
  const second = line2;

  // Trust the MRZ only when its machine-readable check digits agree. A real passport
  // passes at least two of them; a garbled read (or a stray block of page text) does not.
  if (mrzLine2Score(second) < 2) return {};

  const out: Record<string, string> = {};

  // Names live in the first row, after the P<CCC prefix.
  const nameSection = first.slice(5);
  const separator = nameSection.indexOf("<<");
  // Padding creates `<<` at the row end; it is not a surname/given-name
  // separator. A real separator occurs before padding and has no lone `<` in
  // the surname segment.
  const hasNameSeparator = separator >= 0 && separator < 39 && !nameSection.slice(0, separator).includes("<");
  const surname = hasNameSeparator ? nameSection.slice(0, separator).replace(/<+$/g, "") : "";
  const given = hasNameSeparator ? nameSection.slice(separator + 2).replace(/<+$/g, "").replace(/</g, " ").replace(/\s+/g, " ").trim() : "";
  const validNamePart = (value: string) => /^[A-Z]{2,24}(?:<[A-Z]{2,24})*$/.test(value) && !/(.)\1{5,}/.test(value);

  // Guard against a garbled name row (e.g. a run of merged page text) poisoning the form.
  if (hasNameSeparator && validNamePart(surname)) {
    // ICAO MRZ is the official transliteration. Do not infer or re-case a name.
    out.last_name = surname;
  }
  if (hasNameSeparator && given && validNamePart(given.replace(/ /g, "<"))) {
    const tokens = given.split(" ").filter((token) => isPlausibleName(token));
    if (tokens.length > 0) {
      // Keep all given-name components intact; later components are not assumed
      // to be legal middle names without the Agent's explicit confirmation.
      out.first_name = tokens[0];
      out.passport_given_names = tokens.join(" ");
    }
  }

  const repairedDob = repairMrzField(second.slice(13, 19), second[19]);
  if (repairedDob) {
    const dob = mrzDate(repairedDob, false);
    if (dob) out.dob = dob;
  }

  const sex = second.charAt(20);
  if (sex === "M") {
    out.gender = "Male";
    out.title = "Mr";
  } else if (sex === "F") {
    out.gender = "Female";
    out.title = "Ms";
  }

  const passDigits = second.slice(0, 9).replace(/[^A-Z0-9]/g, "");
  const repairedPass = passDigits.length === 9 ? repairMrzField(passDigits, second[9]) : null;
  const number = (repairedPass ?? passDigits).replace(/[^A-Z0-9]/g, "");
  if (number.length >= 5) out.passport_number = number;

  const repairedExpiry = repairMrzField(second.slice(21, 27), second[27]);
  if (repairedExpiry) {
    const expiry = mrzDate(repairedExpiry, true);
    if (expiry) out.passport_expiry = expiry;
  }

  const nationality = mrzLetters(second.slice(10, 13));
  const country = ISO3_TO_COUNTRY[nationality];
  if (country) {
    out.nationality = country;
    out.citizenship = country;
  }
  const issuingCountry = ISO3_TO_COUNTRY[first.slice(2, 5)];
  if (issuingCountry) out.issuing_country = issuingCountry;

  return out;
}

/**
 * Label vocabulary printed across passports in several languages (accents stripped).
 * Used both to recognise a label line and to strip a bilingual label tail off a value
 * (e.g. "Surname / Nom" — the "Nom" half is a label, not the value).
 */
const LABEL_WORDS = new Set<string>([
  // Name / surname / given names
  "surname", "family", "last", "nom", "familienname", "nachname", "apellido", "cognome", "sobrenome", "achternaam",
  "given", "name", "names", "first", "prenom", "prenoms", "vorname", "vornamen", "nombre", "nombres", "voornaam",
  // Passport number
  "passport", "pass", "pasaporte", "passaporto", "paspoort", "no", "number", "nummer", "numero", "nr", "n",
  // Nationality
  "nationality", "nationalite", "staatsangehoerigkeit", "nacionalidad", "nazionalita", "nationaliteit",
  // Dates / birth
  "date", "birth", "naissance", "geburtsdatum", "nacimiento", "nascita", "geboortedatum",
  // Place of birth
  "place", "lieu", "ort", "lugar", "luogo", "geburtsort", "geboorteplaats",
  // Sex / gender
  "sex", "sexe", "geschlecht", "sexo", "sesso", "geslacht",
  // Expiry / validity
  "expiration", "expiry", "expire", "expiracion", "scadenza", "verloopdatum", "valid", "validity", "validite", "until",
  // Issue / authority
  "issue", "issuing", "delivrance", "ausstellung", "emision", "emissione", "afgifte", "authority", "autorite",
  "behoerde", "autoridad", "autorita", "gezag",
  // Small connector words that sit inside labels ("date OF birth", "lieu DE naissance")
  "of", "de", "du", "del", "della", "der", "des", "van", "di", "la", "le", "type", "code",
]);

/** Lower-cases and strips accents so label words match regardless of printed language. */
function normWord(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** True when a printed line is a field label rather than a value. */
function isLabelLine(line: string): boolean {
  const cleaned = normWord(line).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  const tokens = cleaned.split(" ");
  const labelCount = tokens.filter((token) => LABEL_WORDS.has(token)).length;
  return labelCount >= 1 && labelCount / tokens.length >= 0.6;
}

/** Reads the printed (visual) zone by label — a safety net when the MRZ is faint, skewed or unreadable. */
function parsePassportVisual(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  // Drop the machine-readable zone and any non-text noise so they can never be taken as a value.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    // Remove complete MRZ-shaped rows, including rows with OCR-damaged
    // delimiters. Otherwise the visual-label parser can mistake `...NOM...`
    // inside a machine row for a name label.
    .filter((line) => Boolean(line) && /[A-Za-z]/.test(line) && !/<<</.test(line) && !/^P<[A-Z]{3}[A-Z0-9<]{30,}$/.test(line.replace(/\s/g, "").toUpperCase()));

  const labelFlags = lines.map(isLabelLine);

  const findIndex = (pattern: RegExp, requireLabel: boolean): number => {
    for (let index = 0; index < lines.length; index += 1) {
      if (requireLabel && !labelFlags[index]) continue;
      if (pattern.test(lines[index])) return index;
    }
    return -1;
  };

  /** Extracts the value living on the same physical line, after the matched label. */
  const sameLineValue = (line: string, matchStart: number, matchLen: number): string => {
    let remainder = line.slice(matchStart + matchLen);
    // Bilingual label ("Surname / Nom : SMITH") — an inline value follows the last colon.
    if (/[:：]/.test(remainder)) {
      remainder = remainder.slice(remainder.lastIndexOf(":") + 1);
    } else if (remainder.includes("/")) {
      remainder = remainder.slice(remainder.lastIndexOf("/") + 1);
    }
    const tokens = remainder.replace(/^[\s:.,\-|/]+/, "").trim().split(" ").filter(Boolean);
    // Strip a leading label tail ("Nom SMITH" → "SMITH", "Nom" → "").
    while (tokens.length > 0 && LABEL_WORDS.has(normWord(tokens[0]))) tokens.shift();
    const cleaned = tokens.join(" ").replace(/^[\s:.,\-|/]+/, "").trim();
    if (!cleaned || isLabelLine(cleaned)) return "";
    return cleaned;
  };

  /**
   * Finds the value belonging to a labelled field. Handles both the common
   * "label then value" rows AND the ICAO data-page layout, where a block of stacked
   * labels is followed by a block of values: when our label is the k-th line in its
   * label block, its value is the k-th line after that block ends.
   */
  const valueFor = (pattern: RegExp): string => {
    let index = findIndex(pattern, true);
    if (index < 0) index = findIndex(pattern, false);
    if (index < 0) return "";

    const match = pattern.exec(lines[index]);
    if (match) {
      const inline = sameLineValue(lines[index], match.index, match[0].length);
      if (inline) return inline;
    }

    let start = index;
    while (start - 1 >= 0 && labelFlags[start - 1]) start -= 1;
    const rank = index - start;
    let end = index;
    while (end + 1 < lines.length && labelFlags[end + 1]) end += 1;

    const valueIndex = end + 1 + rank;
    if (valueIndex < lines.length && !labelFlags[valueIndex]) return lines[valueIndex];
    return "";
  };

  const cleanName = (raw: string): string[] =>
    raw
      .toUpperCase()
      .replace(/[^A-Z'\- ]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((token) => isPlausibleName(token));

  const surnameTokens = cleanName(
    valueFor(/surname|family\s*name|(?:^|[^a-z\u00e0-\u00ff])nom(?:[^a-z\u00e0-\u00ff]|$)|familienname|nachname|apellido|cognome|sobrenome|achternaam/i),
  );
  if (surnameTokens.length > 0) out.last_name = surnameTokens.join(" ");

  const givenTokens = cleanName(
    valueFor(/given\s*names?|\bpr[ée]noms?\b|first\s*name|nombres|vornamen?|voornaam/i),
  );
  if (givenTokens.length > 0) {
    out.first_name = givenTokens[0];
    if (givenTokens.length > 1) out.middle_name = givenTokens.slice(1).join(" ");
  }

  const numberSource = valueFor(/passport\s*(no|number|nr)|passeport|pasaporte|passaporto|paspoort/i);
  const numberTokens: string[] = numberSource.toUpperCase().replace(/\s+/g, "").match(/[A-Z0-9]{6,9}/g) ?? [];
  const passportNumber = numberTokens.find(
    (token) => (token.match(/\d/g)?.length ?? 0) >= 3 && !LABEL_WORDS.has(normWord(token)),
  );
  if (passportNumber) out.passport_number = passportNumber;

  const country = matchCountry(
    valueFor(/nationality|nationalit|staatsangeh|nacionalidad|nazionalit|nationaliteit/i),
  );
  if (country) {
    out.nationality = country;
    out.citizenship = country;
  }

  const dob = anyDate(
    valueFor(
      /date\s*of\s*birth|birth\s*date|date\s*de\s*naissance|geburtsdatum|fecha\s*de\s*nacimiento|data\s*di\s*nascita|geboortedatum/i,
    ),
  );
  if (dob) out.dob = dob;

  const expiry = anyDate(
    valueFor(
      /expiration|expiry|expire|expiraci[oó]n|scadenza|verloopdatum|date\s*of\s*expiry|valid\s*until|validity|validit[ée]|gueltig/i,
    ),
  );
  if (expiry) out.passport_expiry = expiry;

  const placeOfBirth = valueFor(/place\s*of\s*birth|lieu\s*de\s*naissance|geburtsort|lugar\s*de\s*nacimiento|luogo\s*di\s*nascita|geboorteplaats/i);
  const birthCountry = matchCountry(placeOfBirth);
  if (birthCountry) out.birth_country = birthCountry;
  // The town as printed ("AHMEDABAD, GUJARAT"), unless the line is only a country: the USI needs the town or city of birth.
  const place = placeOfBirth.replace(/\s+/g, " ").trim();
  if (place && (!birthCountry || place.includes(","))) out.place_of_birth = place.slice(0, 80);

  const sexRaw = valueFor(/\bsex\b|sexe|geschlecht|sexo|sesso|geslacht/i).toUpperCase();
  if (/^M\b/.test(sexRaw) || /\bMALE\b/.test(sexRaw)) {
    out.gender = "Male";
    out.title = "Mr";
  } else if (/^F\b/.test(sexRaw) || /\bFEMALE\b/.test(sexRaw)) {
    out.gender = "Female";
    out.title = "Ms";
  }

  // Last resort: a passport number is usually a 6–9 character token mixing letters and digits.
  if (!out.passport_number) {
    const token = /\b([A-Z]{1,2}\d{6,8}|\d{7,9})\b/.exec(text.toUpperCase());
    if (token) out.passport_number = token[1];
  }

  // Last resort: a lone printed date that no labelled field claimed is most likely the DOB.
  if (!out.dob && !out.passport_expiry) {
    const onlyDate = anyDate(text);
    if (onlyDate) out.dob = onlyDate;
  }

  return out;
}

function parsePassport(text: string): Record<string, string> {
  const out: Record<string, string> = { ...parsePassportMrz(text) };
  const visual = parsePassportVisual(text);
  for (const [key, value] of Object.entries(visual)) {
    if (!out[key]) out[key] = value;
  }
  return out;
}

function parseEnglish(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lower = text.toLowerCase();
  if (/ielts/.test(lower)) out.english_type = "IELTS";
  else if (/\bpte\b|pearson/.test(lower)) out.english_type = "PTE";
  else if (/toefl/.test(lower)) out.english_type = "TOEFL";

  const overall = /overall(?:\s+(?:band|score))?[^0-9]{0,15}(\d{1,3}(?:\.\d)?)/i.exec(text);
  const score = Number(overall?.[1]);
  // Validate document-specific score ranges; an OCR number outside the published
  // scale is withheld rather than proposed as a score.
  const valid = out.english_type === "IELTS" ? score >= 0 && score <= 9
    : out.english_type === "PTE" ? score >= 10 && score <= 90
      : out.english_type === "TOEFL" ? score >= 0 && score <= 120 : false;
  if (overall?.[1] && valid) out.english_score = overall[1];

  const date = /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/.exec(text);
  if (date?.[1]) {
    const iso = looseDate(date[1]);
    if (iso) out.english_date = iso;
  }

  // Individual component scores (Listening / Reading / Writing / Speaking). We only
  // ever report a component the document actually prints — never an invented value.
  const component = (labels: string[]): string => {
    for (const label of labels) {
      const match = new RegExp(`${label}[^0-9]{0,14}(\\d{1,2}(?:\\.\\d)?)`, "i").exec(text);
      if (match?.[1]) return match[1];
    }
    return "";
  };
  const components: string[] = [];
  const listening = component(["listening", "listen"]);
  const reading = component(["reading", "read"]);
  const writing = component(["writing", "write"]);
  const speaking = component(["speaking", "speak"]);
  if (listening) components.push(`L ${listening}`);
  if (reading) components.push(`R ${reading}`);
  if (writing) components.push(`W ${writing}`);
  if (speaking) components.push(`S ${speaking}`);
  if (components.length > 0) out.english_components = components.join(" \u00b7 ");

  // Candidate / test report reference number.
  const reference =
    /(?:candidate|test\s*report|trf|registration|reference|report)\s*(?:number|no\.?|form)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,20})/i.exec(
      text,
    );
  if (reference?.[1]) out.english_reference = reference[1].toUpperCase();

  return out;
}

function parseLicence(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const grabAfter = (labels: string[]): string => {
    for (const line of lines) {
      for (const label of labels) {
        const match = new RegExp(`${label}\\s*[:\\-]?\\s*(.+)$`, "i").exec(line);
        if (match?.[1]) {
          return match[1]
            .replace(/[^A-Za-z'\-\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }
      }
    }
    return "";
  };

  const surname = grabAfter(["surname", "last name", "family name"]);
  const given = grabAfter(["given names", "given name", "first name"]);
  if (surname) out.last_name = surname;
  if (given) {
    const { first, middle } = splitGivenNames(given);
    if (first) out.first_name = first;
    if (middle) out.middle_name = middle;
  }

  const date = /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/.exec(text);
  if (date?.[1]) {
    const iso = looseDate(date[1]);
    if (iso) out.dob = iso;
  }

  // Licence number / card number (best-effort) and expiry date.
  const licenceNumber =
    /(?:licen[cs]e|card)\s*(?:no\.?|number|n[o\u00b0])?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,15})/i.exec(text);
  if (licenceNumber?.[1]) out.licence_number = licenceNumber[1].toUpperCase();

  const expiryLine = lines.find((line) => /expir|valid\s*to|valid\s*until/i.test(line));
  if (expiryLine) {
    const expiry = anyDate(expiryLine);
    if (expiry) out.licence_expiry = expiry;
  }

  const stateLine = lines.find((line) => /state|territory/i.test(line));
  if (stateLine) {
    const state = /state\s*[:\-]?\s*([A-Za-z ]{3,20})/i.exec(stateLine)?.[1];
    if (state) out.licence_state = state.trim();
  }

  // --- Australian address block ---
  // Licences typically print the address across two lines after an "ADDRESS" label:
  //   ADDRESS
  //   12 MAIN STREET
  //   SYDNEY NSW 2000
  const addressIndex = lines.findIndex((line) => /^address\b/i.test(line));
  let street = "";
  let locality = "";
  if (addressIndex >= 0) {
    const block = lines.slice(addressIndex + 1, addressIndex + 4).filter((line) => !/^[A-Za-z .]+:$/.test(line));
    if (block[0]) street = block[0];
    // The locality line is the one that carries a state code and/or a 4-digit postcode.
    locality = block.find((line) => AU_STATE_RE.test(line) || /\b\d{4}\b/.test(line)) ?? block[1] ?? "";
  }

  // Fall back to scanning every line for a "… NSW 2000" style locality.
  if (!locality) locality = lines.find((line) => AU_STATE_RE.test(line) && /\b\d{4}\b/.test(line)) ?? "";

  if (street && street.length > 3) {
    out.address_type = "Australian Address";
    out.au_street = street.replace(/\s+/g, " ").trim();
  }

  if (locality) {
    const state = AU_STATE_RE.exec(locality.toUpperCase())?.[1];
    const postcode = /\b(\d{4})\b/.exec(locality)?.[1];
    const suburb = locality
      .replace(AU_STATE_RE, " ")
      .replace(/\b\d{4}\b/g, " ")
      .replace(/[^A-Za-z'\- ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (suburb.length > 1) out.au_suburb = smartTitle(suburb);
    if (state) {
      out.au_state = state;
      out.licence_state = out.licence_state || state;
    }
    if (postcode) out.au_zip = postcode;
    out.address_type = "Australian Address";
  }

  // Other proof-of-address documents often use labelled international blocks.
  // Keep the recognised script verbatim: no transliteration or country guessing.
  if (!out.address_type) {
    const foreignIndex = lines.findIndex((line) => /^(address|residential address|mailing address|住所|주소)\b/i.test(line));
    if (foreignIndex >= 0) {
      const block = lines.slice(foreignIndex + 1, foreignIndex + 4).filter((line) => line.length > 2 && !/^(dob|date|licen)/i.test(line));
      if (block.length > 0) {
        out.address_type = "Overseas Address";
        out.ov_street = block[0];
        if (block[1]) out.ov_line2 = block[1];
        const postal = block.join(" ").match(/\b([A-Z0-9][A-Z0-9 -]{2,9})\b$/i)?.[1];
        if (postal && /\d/.test(postal)) out.ov_zip = postal;
      }
    }
  }

  return out;
}

/**
 * Best-effort read of an academic transcript / marksheet / certificate. Marksheets
 * vary wildly, so we only pull the three things that are almost always printed:
 * the institution, the qualification name and the year. Everything is editable.
 */
function smartTitle(value: string): string {
  const small = new Set(["of", "in", "and", "the", "for", "to", "at"]);
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, position) => (position > 0 && small.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

function parseAcademic(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const joined = lines.join(" ");

  const institutionLine = lines.find((line) =>
    /(university|college|institute|institution|school|academy|polytechnic|board of|education board)/i.test(line),
  );
  if (institutionLine && institutionLine.length <= 90) {
    out.academic_institution = smartTitle(institutionLine.replace(/[^A-Za-z0-9 .,&'()-]/g, " ").replace(/\s+/g, " ").trim());
  }

  const qualification =
    /\b(advanced\s+diploma(?:\s+of\s+[A-Za-z ]+)?|bachelor(?:'?s)?(?:\s+of\s+[A-Za-z ]+)?|master(?:'?s)?(?:\s+of\s+[A-Za-z ]+)?|doctorate|ph\.?d|diploma(?:\s+of\s+[A-Za-z ]+)?|certificate\s+(?:i{1,3}|iv|v)(?:\s+in\s+[A-Za-z ]+)?|high\s+school(?:\s+certificate)?|senior\s+secondary)\b/i.exec(
      joined,
    );
  if (qualification?.[1]) {
    out.academic_qualification = smartTitle(qualification[1].replace(/\s+/g, " ").trim());
  }

  const years = joined.match(/\b(19|20)\d{2}\b/g);
  if (years && years.length > 0) {
    out.academic_year = years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : years[0];
  }

  // Programme / stream of study, when the document prints one.
  const program =
    /(?:programme|program|stream|branch|specialis[az]ation|specialization)\s*[:\-]?\s*([A-Za-z0-9 ,.&()'-]{3,60})/i.exec(joined);
  if (program?.[1]) {
    out.academic_program = smartTitle(program[1].replace(/\s+/g, " ").trim());
  }

  // Result / grade / GPA, when present. Reported only when the document states it.
  const result =
    /(?:cgpa|gpa|percentage|grade|result|final\s*marks?|marks?)\s*[:\-]?\s*([0-9]{1,3}(?:\.[0-9]{1,2})?\s*%?|[A-F][+-]?|[Dd]istinction|[Ff]irst\s*[Cc]lass)/.exec(
      joined,
    );
  if (result?.[1]) out.academic_result = result[1].trim();

  return out;
}

function parseVisa(text: string): Record<string, string> {
  const out: Record<string, string> = { holds_visa: "Yes" };
  const value = (label: string) => new RegExp(`${label}\\s*[:#-]?\\s*([^\\n]+)`, "i").exec(text)?.[1]?.trim() ?? "";
  const subclass = value("visa\\s*(?:subclass|class)").match(/\b\d{3}[A-Z]?\b/)?.[0] ?? "";
  if (subclass) out.visa_subclass = subclass;
  const grant = anyDate(value("(?:visa\\s*)?grant\\s*date"));
  if (grant) out.visa_grant_date = grant;
  const until = anyDate(value("(?:must not arrive after|stay until|visa expiry|expiry date|valid until)"));
  if (until) out.visa_stay_until = until;
  const number = value("(?:visa\\s*)?(?:grant|transaction|reference)\\s*(?:number|no\\.?)").match(/[A-Z0-9-]{6,}/i)?.[0];
  if (number) out.visa_grant_number = number.toUpperCase();
  const passport = value("passport\\s*(?:number|no\\.?)").match(/[A-Z0-9]{5,12}/i)?.[0];
  if (passport) out.passport_number = passport.toUpperCase();
  return Object.keys(out).length > 1 ? out : {};
}

export function parseDocument(type: ScanType, text: string): Record<string, string> {
  if (!text) return {};
  if (type === "passport") return parsePassport(text);
  if (type === "english") return parseEnglish(text);
  if (type === "academic") return parseAcademic(text);
  if (type === "visa") return parseVisa(text);
  return parseLicence(text);
}

function flash(element: Element) {
  const target = element.parentElement ?? element;
  target.classList.add("scan-filled");
  window.setTimeout(() => target.classList.remove("scan-filled"), 1700);
}

/** Leaves a persistent “auto-filled” marker on the field until the applicant edits it. */
function markFilled(element: Element) {
  const wrapper = element.closest("[data-scan-field]");
  if (!wrapper) return;
  wrapper.classList.add("scan-autofilled");
  const clear = () => wrapper.classList.remove("scan-autofilled");
  element.addEventListener("input", clear, { once: true });
  element.addEventListener("change", clear, { once: true });
}

function applyOne(form: HTMLFormElement, name: string, value: string): boolean {
  const nodes = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`);
  if (nodes.length === 0) return false;
  const first = nodes[0];

  if (first instanceof HTMLSelectElement) {
    const wanted = value.toLowerCase();
    const option = Array.from(first.options).find((item) => item.value.toLowerCase() === wanted);
    if (!option) return false;
    first.value = option.value;
    flash(first);
    markFilled(first);
    first.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (first instanceof HTMLInputElement && (first.type === "radio" || first.type === "checkbox")) {
    const wanted = value.toLowerCase();
    const match = Array.from(nodes).find(
      (node) => node instanceof HTMLInputElement && node.value.toLowerCase() === wanted,
    );
    if (!(match instanceof HTMLInputElement)) return false;
    match.checked = true;
    flash(match);
    markFilled(match);
    match.dispatchEvent(new Event("change", { bubbles: true }));
    match.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) {
    first.value = value;
    flash(first);
    markFilled(first);
    first.dispatchEvent(new Event("input", { bubbles: true }));
    first.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  return false;
}

/**
 * Writes scanned values into the live form. Conditional fields that are not in
 * the DOM yet (because a radio answer controls their visibility) are retried
 * once on the next tick, after React has re-rendered.
 */
export function applyFieldValues(
  form: HTMLFormElement | null,
  values: Record<string, string>,
  allowRetry = true,
): number {
  if (!form) return 0;
  let applied = 0;
  const missed: Record<string, string> = {};

  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    if (applyOne(form, name, value)) applied += 1;
    else missed[name] = value;
  }

  if (allowRetry && Object.keys(missed).length > 0) {
    window.setTimeout(() => applyFieldValues(form, missed, false), 90);
  }

  return applied;
}

/** Australian state / territory codes used when reading a licence locality line. */
const AU_STATE_RE = /\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/;
