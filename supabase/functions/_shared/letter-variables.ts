// Offer letter (LOO) variables: {{group.key}} tokens with an optional |upper, |lower, |title or |raw modifier. Runtime-neutral (browser,
// Deno, Node tests). The registry itself (key -> label -> source -> format, required, aliases) lives in public.letter_variables and is
// served by letter_variable_registry(); this module scans templates against it, finds the old placeholders ($[field], {field:inline},
// [Page Number]) with a suggested variable for each, converts them, and turns a resolved value into what the PDF prints.
import { decodeEntities } from "./hr-template.ts";

export type LetterGroup = "Student" | "Course" | "Fees" | "Agent / Agency" | "Application" | "Institute" | "Page";
export interface LetterVariable {
  key: string;
  group: LetterGroup;
  label: string;
  description: string;
  sourceKind: "application" | "record" | "computed" | "course" | "intake" | "fee" | "agent" | "agency" | "institute" | "entered" | "render";
  source: string;
  format: "text" | "name" | "date" | "money" | "list" | "multiline" | "image";
  inputType: "text" | "date" | "money" | "textarea" | "email" | "tel";
  required: boolean;
  editableSource: boolean;
  aliases: string[];
  sample: string;
}
/** One application's value of a variable (application_letter_values). */
export interface LetterValue { value: string; raw: string; source: string; missing: boolean }
export const LETTER_GROUPS: readonly LetterGroup[] = ["Student", "Course", "Fees", "Agent / Agency", "Application", "Institute", "Page"];
export const LETTER_MODIFIERS = ["upper", "lower", "title", "raw"] as const;
export type LetterModifier = (typeof LETTER_MODIFIERS)[number];

/** {{ key }} or {{ key|modifier }}: up to 80 characters between the braces. */
export const CURLY_TOKEN = /\{\{\s*([^{}]{1,80}?)\s*\}\}/g;
const textOf = (html: string) => decodeEntities(String(html ?? "").replace(/<[^>]*>/g, ""));
export const parseCurly = (inner: string): { key: string; modifier: string | null } => {
  const [key, modifier] = inner.split("|").map((p) => p.trim().toLowerCase());
  return { key, modifier: modifier ?? null };
};

/* ------------------------------------------------------------------ blocks: packaged offers */
/**
 * {{#each courses}} ... {{/each}} repeats per course; {{#if multiple_courses}} ... {{/if}} prints only for more than one course;
 * {{#each other_fees}} ... {{/each}} repeats per row of Settings › Other fees and charges ({{charges.label}}, {{charges.amount}});
 * {{#if gst}} ... {{/if}} prints only when a fee line of the offer is taxable. Blocks are not nested.
 */
export const EACH_COURSES = "#each courses";
export const IF_MULTIPLE = "#if multiple_courses";
export const EACH_CHARGES = "#each other_fees";
export const IF_GST = "#if gst";
const BLOCK_MARKER = /^\s*(#each courses|#each other_fees|\/each|#if multiple_courses|#if gst|\/if)\s*$/i;
export const isBlockMarker = (inner: string) => BLOCK_MARKER.test(inner);
/** A course variable of the n-th course after the first is written key#n (course.name#1 is the second course's name). */
export const baseKey = (key: string) => key.split("#")[0];
export const courseIndexOf = (key: string) => { const n = Number(key.split("#")[1]); return Number.isInteger(n) && n > 0 ? n : 0; };
/** Variables of one row of Settings › Other fees and charges (repeated by {{#each other_fees}}). */
export const isChargeKey = (key: string) => /^charges\./.test(key);
/** Variables that belong to one course (repeated by {{#each courses}}). */
export const isCourseKey = (key: string) => /^(course|fees)\./.test(key) && key !== "fees.combined_total";
const courseLabel = (variable: LetterVariable, key: string) => (courseIndexOf(key) ? `${variable.label} (course ${courseIndexOf(key) + 1})` : variable.label);

/** The keys a template uses, in order of first use (modifiers and block markers left out). */
export function letterKeys(html: string): string[] {
  const seen: string[] = [];
  for (const m of textOf(html).matchAll(CURLY_TOKEN)) {
    if (isBlockMarker(m[1])) continue;
    const { key } = parseCurly(m[1]);
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

/** Where a marker sits: its table row or paragraph when it is alone there (removed with it), else the marker itself. */
function markerSpan(html: string, at: number, length: number): { start: number; end: number } {
  const own = (open: string, close: string) => {
    const start = html.lastIndexOf(open, at);
    if (start < 0 || html.lastIndexOf(close, at) > start) return null;
    const end = html.indexOf(close, at + length);
    if (end < 0) return null;
    const inner = textOf(html.slice(start, end + close.length)).replace(/\s/g, "");
    return inner === textOf(html.slice(at, at + length)).replace(/\s/g, "") ? { start, end: end + close.length } : null;
  };
  return own("<tr", "</tr>") ?? own("<p", "</p>") ?? own("<div", "</div>") ?? { start: at, end: at + length };
}
function nextMarker(html: string, from: number, name: RegExp): { at: number; length: number } | null {
  name.lastIndex = from;
  const m = name.exec(html);
  return m ? { at: m.index, length: m[0].length } : null;
}
/**
 * The template as printed for an application with `courseCount` courses: each {{#each courses}} block once per course (its course and
 * fee variables of the n-th course written key#n), {{#if multiple_courses}} blocks kept only for more than one course. With one course
 * (or none) the letter reads exactly as without the blocks.
 */
export function expandLetterBlocks(html: string, courseCount: number, extras: { charges?: number; gst?: boolean } = {}): string {
  const count = Math.max(1, Math.floor(courseCount) || 1);
  let out = String(html ?? "");
  const openEach = /\{\{\s*#each courses\s*\}\}/gi, closeEach = /\{\{\s*\/each\s*\}\}/gi;
  for (let guard = 0; guard < 50; guard++) {
    const open = nextMarker(out, 0, openEach);
    if (!open) break;
    const close = nextMarker(out, open.at + open.length, closeEach);
    if (!close) { out = out.slice(0, open.at) + out.slice(open.at + open.length); continue; }
    const a = markerSpan(out, open.at, open.length), b = markerSpan(out, close.at, close.length);
    const inner = out.slice(a.end, b.start);
    const copies = Array.from({ length: count }, (_, n) => (n === 0 ? inner : inner.replace(/\{\{\s*([a-z]+\.[a-z_]+)(\s*\|[^{}]*)?\s*\}\}/g,
      (whole, key: string, mod: string | undefined) => (isCourseKey(key) ? `{{${key}#${n}${mod ?? ""}}}` : whole))));
    out = out.slice(0, a.start) + copies.join("") + out.slice(b.end);
  }
  // {{#each other_fees}}: once per row (none: the block goes); the n-th copy's charges.* variables are written key#n.
  const rows = Math.max(0, Math.floor(extras.charges ?? 1));
  const openCharges = /\{\{\s*#each other_fees\s*\}\}/gi;
  for (let guard = 0; guard < 50; guard++) {
    const open = nextMarker(out, 0, openCharges);
    if (!open) break;
    const close = nextMarker(out, open.at + open.length, closeEach);
    if (!close) { out = out.slice(0, open.at) + out.slice(open.at + open.length); continue; }
    const a = markerSpan(out, open.at, open.length), b = markerSpan(out, close.at, close.length);
    const inner = out.slice(a.end, b.start);
    const copies = Array.from({ length: rows }, (_, n) => (n === 0 ? inner : inner.replace(/\{\{\s*([a-z]+\.[a-z_]+)(\s*\|[^{}]*)?\s*\}\}/g,
      (whole, key: string, mod: string | undefined) => (isChargeKey(key) ? `{{${key}#${n}${mod ?? ""}}}` : whole))));
    out = out.slice(0, a.start) + copies.join("") + out.slice(b.end);
  }
  // {{#if gst}}: kept only when a fee line is taxable.
  const openGst = /\{\{\s*#if gst\s*\}\}/gi, closeAnyIf = /\{\{\s*\/if\s*\}\}/gi;
  for (let guard = 0; guard < 200; guard++) {
    const open = nextMarker(out, 0, openGst);
    if (!open) break;
    const close = nextMarker(out, open.at + open.length, closeAnyIf);
    if (!close) { out = out.slice(0, open.at) + out.slice(open.at + open.length); continue; }
    const a = markerSpan(out, open.at, open.length), b = markerSpan(out, close.at, close.length);
    out = out.slice(0, a.start) + (extras.gst ? out.slice(a.end, b.start) : "") + out.slice(b.end);
  }
  const openIf = /\{\{\s*#if multiple_courses\s*\}\}/gi, closeIf = /\{\{\s*\/if\s*\}\}/gi;
  for (let guard = 0; guard < 50; guard++) {
    const open = nextMarker(out, 0, openIf);
    if (!open) break;
    const close = nextMarker(out, open.at + open.length, closeIf);
    if (!close) { out = out.slice(0, open.at) + out.slice(open.at + open.length); continue; }
    const a = markerSpan(out, open.at, open.length), b = markerSpan(out, close.at, close.length);
    out = out.slice(0, a.start) + (count > 1 ? out.slice(a.end, b.start) : "") + out.slice(b.end);
  }
  return out;
}
/** The values with the 2nd, 3rd... row of Settings › Other fees and charges added as charges.label#1, charges.amount#1... */
export function withChargeValues(values: Record<string, LetterValue>, charges: ReadonlyArray<Record<string, LetterValue>> = []): Record<string, LetterValue> {
  const out: Record<string, LetterValue> = { ...values };
  charges.forEach((row, n) => { if (n > 0) for (const [key, value] of Object.entries(row)) out[`${key}#${n}`] = value; });
  return out;
}
/** The application's values with the 2nd, 3rd... course's course and fee variables added as key#1, key#2... */
export function withCourseValues(values: Record<string, LetterValue>, courses: ReadonlyArray<Record<string, LetterValue>> = []): Record<string, LetterValue> {
  const out: Record<string, LetterValue> = { ...values };
  courses.forEach((course, n) => { if (n > 0) for (const [key, value] of Object.entries(course)) out[`${key}#${n}`] = value; });
  return out;
}

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** The registry variable an old placeholder name stands for (by key, label or alias), if one does. */
export function suggestVariable(name: string, registry: readonly LetterVariable[]): LetterVariable | undefined {
  const n = norm(name);
  if (!n) return undefined;
  return registry.find((v) => norm(v.key) === n || norm(v.key.split(".")[1]) === n || norm(v.label) === n || v.aliases.some((a) => norm(a) === n))
    ?? registry.find((v) => norm(`${v.group}${v.label}`) === n);
}

export interface UnmappedToken {
  /** As written in the template: {{foo.bar}}, $[dogField], {example2:inline}, [Page Number]. */
  token: string;
  kind: "unknown" | "modifier" | "legacy";
  /** The variable it probably means (one-click conversion), when there is one. */
  suggestion?: LetterVariable;
}
/**
 * The tokens that do not map to the registry: an unknown {{key}} or |modifier, the old $[field] and {field:inline} placeholders, and an
 * old [Variable] whose name is a registry alias. Other text in square brackets stays text. The same rules as letter_template_unmapped().
 */
export function unmappedTokens(html: string, registry: readonly LetterVariable[]): UnmappedToken[] {
  const text = textOf(html);
  const keys = new Set(registry.map((v) => v.key));
  const out = new Map<string, UnmappedToken>();
  for (const m of text.matchAll(CURLY_TOKEN)) {
    if (isBlockMarker(m[1])) continue;
    const { key, modifier } = parseCurly(m[1]);
    const token = `{{${m[1].trim()}}}`;
    if (!keys.has(key)) out.set(token, { token, kind: "unknown", suggestion: suggestVariable(key.replace(/^[a-z]+\./, ""), registry) ?? suggestVariable(key, registry) });
    else if (modifier !== null && !(LETTER_MODIFIERS as readonly string[]).includes(modifier) && !PICTURE_HEIGHT.test(modifier)) out.set(token, { token, kind: "modifier", suggestion: registry.find((v) => v.key === key) });
  }
  for (const m of text.matchAll(/\$\[([^[\]]{1,80})\]/g)) out.set(`$[${m[1]}]`, { token: `$[${m[1]}]`, kind: "legacy", suggestion: suggestVariable(m[1], registry) });
  for (const m of text.matchAll(/\{([A-Za-z][A-Za-z0-9_ ]{0,60}):inline\}/g)) out.set(`{${m[1]}:inline}`, { token: `{${m[1]}:inline}`, kind: "legacy", suggestion: suggestVariable(m[1], registry) });
  for (const m of text.matchAll(/(?:^|[^$])\[([^[\]\n]{1,80})\]/g)) {
    const n = norm(m[1]);
    const hit = registry.find((v) => v.aliases.some((a) => norm(a) === n));
    if (hit) out.set(`[${m[1]}]`, { token: `[${m[1]}]`, kind: "legacy", suggestion: hit });
  }
  return [...out.values()];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replaces every occurrence of an old token with {{key}} (also when Word split it across tags, e.g. "$[dog<b>Field</b>]"). */
export function replaceToken(html: string, token: string, key: string): string {
  const pattern = [...token].map((ch) => escapeRegExp(ch)).join("(?:<[^>]*>)*");
  const guard = token.startsWith("[") ? "(?<!\\$)" : "";
  return html.replace(new RegExp(guard + pattern, "g"), `{{${key}}}`);
}

/** The text a value prints with a modifier. Names are Title Case already (|raw prints what the source holds). */
export function applyModifier(value: LetterValue | undefined, modifier: string | null): string {
  if (!value) return "";
  const text = modifier === "raw" ? value.raw : value.value;
  if (modifier === "upper") return text.toUpperCase();
  if (modifier === "lower") return text.toLowerCase();
  if (modifier === "title") return text.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
  return text;
}

/** Offer conditions as printed: one per line, numbered when there are several; "Nil" when there are none. */
export function conditionsText(conditions: string): string {
  const lines = String(conditions ?? "").split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  if (!lines.length || (lines.length === 1 && /^nil$/i.test(lines[0]))) return "Nil";
  return lines.length === 1 ? lines[0] : lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
}

export const INITIALS_LINE = "Student initials: ____________";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/**
 * A value typed in the drawer as the letter prints it, with the same rules as the database (application_letter_values): a date
 * (YYYY-MM-DD from the date input) in the institute's format, an amount as AUD$1,234.00, a name in Title Case.
 */
export function formatTyped(variable: Pick<LetterVariable, "format">, input: string, dateFormat = "DD/MM/YYYY"): string {
  const text = String(input ?? "").trim();
  if (!text) return "";
  if (variable.format === "date") {
    const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return text;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (dateFormat === "D Month YYYY") return `${d} ${MONTHS[mo - 1]} ${y}`;
    if (dateFormat === "DD Mon YYYY") return `${String(d).padStart(2, "0")} ${MONTHS[mo - 1].slice(0, 3)} ${y}`;
    return `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`;
  }
  if (variable.format === "money") {
    const n = Number(text.replace(/^(AUD)?\$?\s*/i, "").replace(/,/g, ""));
    return Number.isFinite(n) && n >= 0 ? `AUD$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : text;
  }
  if (variable.format === "name") return text.toLowerCase().replace(/\s+/g, " ").replace(/(^|[\s'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
  return text;
}

export type ManualMode = "letter" | "source" | "blank";
/** A detail staff filled by hand for one letter. */
export interface ManualFill { key: string; value: string; mode: ManualMode }

/** A picture variable's height modifier: |h42 ... |h200 (points). */
export const PICTURE_HEIGHT = /^h(\d{2,3})$/;
export const DEFAULT_PICTURE_HEIGHT = 42;

export type CurlyResolution =
  | { kind: "image"; src: string; height: number }
  | { kind: "value"; text: string }
  | { kind: "missing"; key: string; label: string }
  | { kind: "page" | "total" };

/**
 * How the PDF builder resolves {{key|modifier}} for one letter: page numbers per page; the initials line; offer conditions; a value from
 * the application unless staff overrode it for this letter; a blank when an optional detail was left blank on purpose; otherwise
 * missing (printed as [Label] on a yellow mark, and Send stays disabled).
 */
export function letterResolver(registry: readonly LetterVariable[], values: Record<string, LetterValue>, manual: readonly ManualFill[], conditions: string, sample = false) {
  const byKey = new Map(registry.map((v) => [v.key, v]));
  const fills = new Map(manual.map((m) => [m.key, m]));
  return (key: string, modifier: string | null): CurlyResolution => {
    const spec = byKey.get(baseKey(key));
    if (!spec) return { kind: "missing", key, label: key };
    if (key === "page.number") return { kind: "page" };
    if (key === "page.total") return { kind: "total" };
    if (key === "student.initial_line") return { kind: "value", text: INITIALS_LINE };
    if (spec.format === "image") {
      const src = values[key] && !values[key].missing ? values[key].value : "";
      const h = PICTURE_HEIGHT.exec(modifier ?? "");
      if (src) return { kind: "image", src, height: Math.min(200, Math.max(10, h ? Number(h[1]) : DEFAULT_PICTURE_HEIGHT)) };
      if (fills.get(key)?.mode === "blank" || sample) return { kind: "value", text: "" };
      return { kind: "missing", key, label: spec.label };
    }
    if (key === "offer.conditions") return { kind: "value", text: applyModifier({ value: conditionsText(conditions), raw: conditions, source: "", missing: false }, modifier) };
    const fill = fills.get(key);
    if (fill && fill.mode !== "blank" && fill.value.trim()) return { kind: "value", text: applyModifier({ value: fill.value.trim(), raw: fill.value.trim(), source: "", missing: false }, modifier) };
    const value = values[key];
    if (value && !value.missing) return { kind: "value", text: applyModifier(value, modifier) };
    if (fill?.mode === "blank" && !spec.required) return { kind: "value", text: "" };
    if (sample) return { kind: "value", text: applyModifier({ value: spec.sample, raw: spec.sample, source: "", missing: false }, modifier) };
    return { kind: "missing", key, label: courseLabel(spec, key) };
  };
}

/** One missing detail: the full key (course variables of the 2nd, 3rd... course end in #1, #2...), its variable, the label shown. */
export interface MissingDetail { key: string; variable: LetterVariable; value: LetterValue | undefined; label: string }
/** The details a template (blocks already expanded) needs that the application does not have (render / entered variables never are). */
export function missingDetails(html: string, registry: readonly LetterVariable[], values: Record<string, LetterValue>): MissingDetail[] {
  const byKey = new Map(registry.map((v) => [v.key, v]));
  return letterKeys(html).flatMap((key) => {
    const variable = byKey.get(baseKey(key));
    if (!variable || variable.sourceKind === "render" || variable.sourceKind === "entered") return [];
    const value = values[key];
    return !value || value.missing ? [{ key, variable, value, label: courseLabel(variable, key) }] : [];
  });
}

/** What still blocks Send: required details without a value, and optional ones neither filled nor ticked to leave blank. */
export function blockingDetails(missing: readonly MissingDetail[], manual: readonly ManualFill[]): MissingDetail[] {
  const fills = new Map(manual.map((m) => [m.key, m]));
  return missing.filter(({ key, variable }) => {
    const fill = fills.get(key);
    if (fill && fill.mode !== "blank" && fill.value.trim()) return false;
    if (fill?.mode === "blank" && !variable.required) return false;
    return true;
  });
}
