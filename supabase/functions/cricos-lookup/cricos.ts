// CRICOS register (data.gov.au CKAN datastore, monthly snapshot) → typed course fields.
// Pure functions only: no network, no database. Column names match public.cms_courses (migration 20261115130000).
// Extension point: training.gov.au data (units, packaging rules, superseded status) belongs in tga-course-import.

export const SITE_PROVIDER_CODE = "04114B";
export const RESOURCES = {
  courses: "48cacf69-2082-415e-9595-f17d0c3a4af0",
  courseLocations: "4cd2de02-8ba3-4eb2-bac2-fe272cae3f5f",
  institutions: "7f6941f3-5327-4db7-b556-5f16d77f63c1",
  locations: "45d29535-1360-4486-8242-3850e61b5524",
} as const;
export const CODE_PATTERN = /^[0-9]{6}[A-Z]$/;

export type Row = Record<string, unknown>;
export type FieldType = "text" | "money" | "integer" | "boolean" | "code";
export type FieldValue = string | number | boolean | null;
export interface RawCricos { courses: Row[]; courseLocations: Row[]; institutions: Row[]; locations: Row[] }
export interface CricosLocation {
  location_name: string; location_type: string | null; address_line_1: string | null; address_line_2: string | null;
  address_line_3: string | null; address_line_4: string | null; city: string | null; state: string | null; postcode: string | null;
}

/** Column ← register field. "code" stores the part before " - " of a Field of Education value. */
export const FIELDS: { column: string; table: "course" | "institution"; source: string; type: FieldType }[] = [
  { column: "cricos_course_code", table: "course", source: "CRICOS Course Code", type: "text" },
  { column: "cricos_course_name", table: "course", source: "Course Name", type: "text" },
  { column: "cricos_vet_national_code", table: "course", source: "VET National Code", type: "text" },
  { column: "cricos_provider_code", table: "course", source: "CRICOS Provider Code", type: "text" },
  { column: "cricos_course_level", table: "course", source: "Course Level", type: "text" },
  { column: "cricos_language", table: "course", source: "Course Language", type: "text" },
  { column: "cricos_duration_weeks", table: "course", source: "Duration (Weeks)", type: "integer" },
  { column: "cricos_dual_qualification", table: "course", source: "Dual Qualification", type: "boolean" },
  { column: "cricos_foundation_studies", table: "course", source: "Foundation Studies", type: "boolean" },
  { column: "cricos_expired", table: "course", source: "Expired", type: "boolean" },
  ...[1, 2].flatMap(n => (["Broad", "Narrow", "Detailed"] as const).flatMap(level => {
    const source = `Field of Education ${n} ${level} Field`;
    const column = `cricos_foe${n}_${level.toLowerCase()}`;
    return [
      { column, table: "course" as const, source, type: "text" as const },
      { column: `${column}_code`, table: "course" as const, source, type: "code" as const },
    ];
  })),
  { column: "cricos_has_work_component", table: "course", source: "Work Component", type: "boolean" },
  { column: "cricos_work_component_hours_week", table: "course", source: "Work Component Hours/Week", type: "integer" },
  { column: "cricos_work_component_weeks", table: "course", source: "Work Component Weeks", type: "integer" },
  { column: "cricos_work_component_total_hours", table: "course", source: "Work Component Total Hours", type: "integer" },
  { column: "cricos_tuition_fee", table: "course", source: "Tuition Fee", type: "money" },
  { column: "cricos_non_tuition_fee", table: "course", source: "Non Tuition Fee", type: "money" },
  { column: "cricos_total_cost", table: "course", source: "Estimated Total Course Cost", type: "money" },
  { column: "institution_name", table: "institution", source: "Institution Name", type: "text" },
  { column: "institution_trading_name", table: "institution", source: "Trading Name", type: "text" },
  { column: "institution_type", table: "institution", source: "Institution Type", type: "text" },
  { column: "institution_capacity", table: "institution", source: "Institution Capacity", type: "integer" },
  { column: "institution_website", table: "institution", source: "Website", type: "text" },
  ...[1, 2, 3, 4].map(n => ({ column: `institution_postal_address_line_${n}`, table: "institution" as const, source: `Postal Address Line ${n}`, type: "text" as const })),
  { column: "institution_postal_city", table: "institution", source: "Postal Address City", type: "text" },
  { column: "institution_postal_state", table: "institution", source: "Postal Address State", type: "text" },
  { column: "institution_postal_postcode", table: "institution", source: "Postal Address Postcode", type: "text" },
];

/** Empty → null; trimmed text. Numbers from the API are kept as their text. */
export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text ? text : null;
}
/** "$15,000.00" → 15000. Unparseable → null. */
export function toMoney(value: unknown): number | null {
  const text = toText(value);
  if (text === null) return null;
  const amount = Number(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}
/** 66, "66", "360" → integer. Decimals round; anything else → null. */
export function toInteger(value: unknown): number | null {
  const text = toText(value);
  if (text === null) return null;
  const number = Number(text.replace(/,/g, ""));
  return Number.isFinite(number) ? Math.round(number) : null;
}
/** "Yes" → true, "No" → false, anything else → null. */
export function toBoolean(value: unknown): boolean | null {
  const text = toText(value)?.toLowerCase();
  return text === "yes" || text === "y" || text === "true" ? true : text === "no" || text === "n" || text === "false" ? false : null;
}
/** "030503 - Vehicle Mechanics" → "030503". No " - " separator → null. */
export function foeCode(value: unknown): string | null {
  const match = /^([0-9A-Za-z]+)\s+-\s+\S/.exec(toText(value) ?? "");
  return match ? match[1] : null;
}
export function convert(type: FieldType, value: unknown): FieldValue {
  switch (type) {
    case "money": return toMoney(value);
    case "integer": return toInteger(value);
    case "boolean": return toBoolean(value);
    case "code": return foeCode(value);
    default: return toText(value);
  }
}

const key = (value: unknown) => (toText(value) ?? "").toLowerCase();
/** Course Locations joined to the provider's Locations on Location Name (city breaks ties); unmatched keep name/city/state. */
export function joinLocations(courseLocations: Row[], locations: Row[]): CricosLocation[] {
  return courseLocations.filter(row => toText(row["Location Name"])).map(row => {
    const named = locations.filter(place => key(place["Location Name"]) === key(row["Location Name"]));
    const match = named.find(place => key(place.City) === key(row["Location City"])) ?? named[0];
    return {
      location_name: toText(row["Location Name"]) as string,
      location_type: match ? toText(match["Location Type"]) : null,
      address_line_1: match ? toText(match["Address Line 1"]) : null,
      address_line_2: match ? toText(match["Address Line 2"]) : null,
      address_line_3: match ? toText(match["Address Line 3"]) : null,
      address_line_4: match ? toText(match["Address Line 4"]) : null,
      city: (match ? toText(match.City) : null) ?? toText(row["Location City"]),
      state: (match ? toText(match.State) : null) ?? toText(row["Location State"]),
      postcode: match ? toText(match.Postcode) : null,
    };
  });
}

/** Drops CKAN's internal _id from every row. */
export const clean = (rows: Row[]) => rows.map(({ _id: _ignored, ...row }) => row);

export function mapCricos(raw: RawCricos) {
  const course = raw.courses.find(row => toBoolean(row.Expired) !== true) ?? raw.courses[0] ?? {};
  const institution = raw.institutions[0] ?? {};
  const fields: Record<string, FieldValue> = {};
  for (const field of FIELDS) {
    const row = field.table === "course" ? course : institution;
    fields[field.column] = convert(field.type, row[field.source]);
  }
  // The Courses table also names the institution; use it when the Institutions table has no row.
  fields.institution_name ??= toText(course["Institution Name"]);
  if (typeof fields.cricos_course_code === "string") fields.cricos_course_code = fields.cricos_course_code.toUpperCase();
  const warnings: string[] = [];
  const provider = fields.cricos_provider_code;
  if (provider && String(provider).toUpperCase() !== SITE_PROVIDER_CODE) {
    warnings.push(`This course belongs to CRICOS provider ${provider}${fields.institution_name ? ` (${fields.institution_name})` : ""}, not ${SITE_PROVIDER_CODE} (Skyline).`);
  }
  if (fields.cricos_expired === true) warnings.push("The CRICOS register marks this course as expired.");
  if (!fields.cricos_vet_national_code) warnings.push("The course has no VET National Code on the CRICOS register.");
  return { fields, locations: joinLocations(raw.courseLocations, raw.locations), warnings };
}
