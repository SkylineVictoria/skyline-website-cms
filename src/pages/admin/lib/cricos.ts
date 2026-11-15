// CRICOS register details of a course (migration 20261115130000, Edge Function cricos-lookup).
// Field keys are cms_courses column names; the lookup returns them already typed.
import { supabase } from "@/pages/admin/lib/supabase";

export type CricosValue = string | number | boolean | null;
export type CricosFields = Record<string, CricosValue>;
export type FieldKind = "text" | "number" | "boolean";
export interface CricosField { key: string; label: string; kind: FieldKind; wide?: boolean }
export interface CricosLocation {
  location_name: string; location_type: string | null; address_line_1: string | null; address_line_2: string | null;
  address_line_3: string | null; address_line_4: string | null; city: string | null; state: string | null; postcode: string | null;
}
export interface CricosSnapshot { fetched_at: string; raw: unknown; fields: CricosFields; locations: CricosLocation[] }
export interface CricosLookup { fields: CricosFields; locations: CricosLocation[]; warnings: string[]; fetched_at: string; snapshot: CricosSnapshot }
export interface CricosRecord { fields: CricosFields; locations: CricosLocation[]; snapshot: CricosSnapshot | null; fetchedAt: string | null; edited: string[] }

export const CODE_PATTERN = /^[0-9]{6}[A-Z]$/;
export const LOCATIONS_KEY = "locations";

const foe = (n: 1 | 2): CricosField[] => (["broad", "narrow", "detailed"] as const).flatMap(level => [
  { key: `cricos_foe${n}_${level}`, label: `Field ${n}: ${level}`, kind: "text" as const, wide: true },
  { key: `cricos_foe${n}_${level}_code`, label: `Field ${n}: ${level} code`, kind: "text" as const },
]);

/** The form's sections, in display order. The CRICOS course code itself sits above them. */
export const CRICOS_SECTIONS: { title: string; fields: CricosField[] }[] = [
  { title: "Course", fields: [
    { key: "cricos_course_name", label: "Course name", kind: "text", wide: true },
    { key: "cricos_vet_national_code", label: "VET national code", kind: "text" },
    { key: "cricos_provider_code", label: "CRICOS provider code", kind: "text" },
    { key: "cricos_course_level", label: "Course level", kind: "text" },
    { key: "cricos_language", label: "Course language", kind: "text" },
    { key: "cricos_duration_weeks", label: "Duration (weeks)", kind: "number" },
    { key: "cricos_dual_qualification", label: "Dual qualification", kind: "boolean" },
    { key: "cricos_foundation_studies", label: "Foundation studies", kind: "boolean" },
    { key: "cricos_expired", label: "Expired", kind: "boolean" },
  ] },
  { title: "Field of Education", fields: [...foe(1), ...foe(2)] },
  { title: "Work Component", fields: [
    { key: "cricos_has_work_component", label: "Work component", kind: "boolean" },
    { key: "cricos_work_component_hours_week", label: "Hours per week", kind: "number" },
    { key: "cricos_work_component_weeks", label: "Weeks", kind: "number" },
    { key: "cricos_work_component_total_hours", label: "Total hours", kind: "number" },
  ] },
  { title: "Fees", fields: [
    { key: "cricos_tuition_fee", label: "Tuition fee (AUD)", kind: "number" },
    { key: "cricos_non_tuition_fee", label: "Non-tuition fee (AUD)", kind: "number" },
    { key: "cricos_total_cost", label: "Estimated total course cost (AUD)", kind: "number" },
  ] },
  { title: "Institution", fields: [
    { key: "institution_trading_name", label: "Trading name", kind: "text" },
    { key: "institution_name", label: "Institution name", kind: "text" },
    { key: "institution_type", label: "Institution type", kind: "text" },
    { key: "institution_capacity", label: "Capacity", kind: "number" },
    { key: "institution_website", label: "Website", kind: "text", wide: true },
    { key: "institution_postal_address_line_1", label: "Postal address line 1", kind: "text" },
    { key: "institution_postal_address_line_2", label: "Postal address line 2", kind: "text" },
    { key: "institution_postal_address_line_3", label: "Postal address line 3", kind: "text" },
    { key: "institution_postal_address_line_4", label: "Postal address line 4", kind: "text" },
    { key: "institution_postal_city", label: "City", kind: "text" },
    { key: "institution_postal_state", label: "State", kind: "text" },
    { key: "institution_postal_postcode", label: "Postcode", kind: "text" },
  ] },
];
export const CODE_FIELD: CricosField = { key: "cricos_course_code", label: "CRICOS course code", kind: "text" };
export const ALL_FIELDS: CricosField[] = [CODE_FIELD, ...CRICOS_SECTIONS.flatMap(section => section.fields)];
export const LOCATION_FIELDS: { key: keyof CricosLocation; label: string }[] = [
  { key: "location_name", label: "Location name" }, { key: "location_type", label: "Location type" },
  { key: "address_line_1", label: "Address line 1" }, { key: "address_line_2", label: "Address line 2" },
  { key: "address_line_3", label: "Address line 3" }, { key: "address_line_4", label: "Address line 4" },
  { key: "city", label: "City" }, { key: "state", label: "State" }, { key: "postcode", label: "Postcode" },
];
const fieldByKey = new Map(ALL_FIELDS.map(field => [field.key, field]));
export const labelOf = (key: string) => key === LOCATIONS_KEY ? "Locations" : fieldByKey.get(key)?.label ?? key;

export const emptyLocation = (): CricosLocation => ({ location_name: "", location_type: null, address_line_1: null, address_line_2: null,
  address_line_3: null, address_line_4: null, city: null, state: null, postcode: null });
export const emptyFields = (): CricosFields => Object.fromEntries(ALL_FIELDS.map(field => [field.key, null]));

/** Comparable form of a value: empty → null, numbers as numbers, text trimmed. */
export function norm(kind: FieldKind, value: unknown): CricosValue {
  if (value === null || value === undefined || value === "") return null;
  if (kind === "number") { const number = Number(value); return Number.isFinite(number) ? number : null; }
  if (kind === "boolean") return value === true || value === "true";
  const text = String(value).trim();
  return text ? text : null;
}
const normLocations = (rows: CricosLocation[]) => JSON.stringify(rows.map(row =>
  LOCATION_FIELDS.map(field => norm("text", row[field.key]))));
export const sameValue = (key: string, a: unknown, b: unknown) => key === LOCATIONS_KEY
  ? normLocations(a as CricosLocation[]) === normLocations(b as CricosLocation[])
  : norm(fieldByKey.get(key)?.kind ?? "text", a) === norm(fieldByKey.get(key)?.kind ?? "text", b);

/** Fields whose current value differs from the value last fetched from CRICOS. */
export function editedFields(fields: CricosFields, locations: CricosLocation[], snapshot: CricosSnapshot | null): string[] {
  if (!snapshot) return [];
  const edited = ALL_FIELDS.filter(field => !sameValue(field.key, fields[field.key], snapshot.fields[field.key])).map(field => field.key);
  if (!sameValue(LOCATIONS_KEY, locations, snapshot.locations ?? [])) edited.push(LOCATIONS_KEY);
  return edited;
}

export interface DiffRow { key: string; current: unknown; incoming: unknown; edited: boolean }
/** Fields where the course differs from a new CRICOS fetch; edited fields default to keeping the course value. */
export function diffWithLookup(fields: CricosFields, locations: CricosLocation[], edited: string[], lookup: CricosLookup): DiffRow[] {
  const rows: DiffRow[] = ALL_FIELDS.filter(field => !sameValue(field.key, fields[field.key], lookup.fields[field.key]))
    .map(field => ({ key: field.key, current: fields[field.key], incoming: lookup.fields[field.key], edited: edited.includes(field.key) }));
  if (!sameValue(LOCATIONS_KEY, locations, lookup.locations)) {
    rows.push({ key: LOCATIONS_KEY, current: locations, incoming: lookup.locations, edited: edited.includes(LOCATIONS_KEY) });
  }
  return rows;
}

export function display(key: string, value: unknown): string {
  if (key === LOCATIONS_KEY) {
    const rows = (value as CricosLocation[]) ?? [];
    return rows.length ? rows.map(row => [row.location_name, row.city, row.state].filter(Boolean).join(", ")).join("; ") : "None";
  }
  const kind = fieldByKey.get(key)?.kind;
  if (value === null || value === undefined || value === "") return "—";
  if (kind === "boolean") return value ? "Yes" : "No";
  if (kind === "number" && /fee|cost/.test(key)) return Number(value).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
  return String(value);
}

const COLUMNS = [...ALL_FIELDS.map(field => field.key), "cricos_snapshot", "cricos_fetched_at", "cricos_edited_fields"].join(",");

export async function loadCricos(courseId: string): Promise<CricosRecord> {
  const [{ data, error }, { data: rows, error: rowsError }] = await Promise.all([
    supabase.from("cms_courses").select(COLUMNS).eq("id", courseId).maybeSingle<Record<string, unknown>>(),
    supabase.from("course_locations").select(LOCATION_FIELDS.map(field => field.key).join(",")).eq("course_id", courseId).order("sort_order"),
  ]);
  if (error || rowsError) throw new Error("CRICOS details need a one-time database update (migration 20261115130000). Run it in the Supabase SQL editor, then reload.");
  if (!data) throw new Error("Course not found.");
  const fields = Object.fromEntries(ALL_FIELDS.map(field => [field.key, norm(field.kind, data[field.key])]));
  return {
    fields, locations: (rows ?? []) as unknown as CricosLocation[],
    snapshot: (data.cricos_snapshot as CricosSnapshot | null) ?? null, fetchedAt: (data.cricos_fetched_at as string | null) ?? null,
    edited: (data.cricos_edited_fields as string[] | null) ?? [],
  };
}

async function errorText(error: unknown, fallback: string) {
  const context = error && typeof error === "object" && "context" in error ? (error as { context: unknown }).context : null;
  const body = context instanceof Response ? await context.json().catch(() => null) : null;
  return typeof body?.error === "string" ? body.error : fallback;
}

export async function lookupCricos(code: string): Promise<CricosLookup> {
  const { data, error } = await supabase.functions.invoke<CricosLookup>("cricos-lookup", { body: { cricos_code: code } });
  if (error || !data) throw new Error(await errorText(error, "Could not contact the CRICOS lookup service."));
  return data;
}

export async function saveCricos(courseId: string | null, record: CricosRecord): Promise<string> {
  const fields = Object.fromEntries(ALL_FIELDS.map(field => [field.key, norm(field.kind, record.fields[field.key])]));
  const { data, error } = await supabase.rpc("rto_course_cricos_save", {
    p_course_id: courseId, p_fields: fields,
    p_locations: record.locations.map(row => Object.fromEntries(LOCATION_FIELDS.map(field => [field.key, norm("text", row[field.key])]))),
    p_snapshot: record.snapshot, p_fetched_at: record.fetchedAt, p_edited: editedFields(record.fields, record.locations, record.snapshot),
  });
  if (error) {
    if (error.code === "23505") throw new Error("Another course already uses this CRICOS course code (or course code).");
    if (error.code === "PGRST202") throw new Error("Saving CRICOS details needs the database update (migration 20261115130000).");
    throw new Error(error.message || "The CRICOS details could not be saved.");
  }
  return data as string;
}
