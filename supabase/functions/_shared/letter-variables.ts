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
  format: "text" | "name" | "date" | "money" | "list" | "multiline";
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

/** The keys a template uses, in order of first use (modifiers removed). */
export function letterKeys(html: string): string[] {
  const seen: string[] = [];
  for (const m of textOf(html).matchAll(CURLY_TOKEN)) { const { key } = parseCurly(m[1]); if (!seen.includes(key)) seen.push(key); }
  return seen;
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
    const { key, modifier } = parseCurly(m[1]);
    const token = `{{${m[1].trim()}}}`;
    if (!keys.has(key)) out.set(token, { token, kind: "unknown", suggestion: suggestVariable(key.replace(/^[a-z]+\./, ""), registry) ?? suggestVariable(key, registry) });
    else if (modifier !== null && !(LETTER_MODIFIERS as readonly string[]).includes(modifier)) out.set(token, { token, kind: "modifier", suggestion: registry.find((v) => v.key === key) });
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

export type CurlyResolution =
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
    const spec = byKey.get(key);
    if (!spec) return { kind: "missing", key, label: key };
    if (key === "page.number") return { kind: "page" };
    if (key === "page.total") return { kind: "total" };
    if (key === "student.initial_line") return { kind: "value", text: INITIALS_LINE };
    if (key === "offer.conditions") return { kind: "value", text: applyModifier({ value: conditionsText(conditions), raw: conditions, source: "", missing: false }, modifier) };
    const fill = fills.get(key);
    if (fill && fill.mode !== "blank" && fill.value.trim()) return { kind: "value", text: applyModifier({ value: fill.value.trim(), raw: fill.value.trim(), source: "", missing: false }, modifier) };
    const value = values[key];
    if (value && !value.missing) return { kind: "value", text: applyModifier(value, modifier) };
    if (fill?.mode === "blank" && !spec.required) return { kind: "value", text: "" };
    if (sample) return { kind: "value", text: applyModifier({ value: spec.sample, raw: spec.sample, source: "", missing: false }, modifier) };
    return { kind: "missing", key, label: spec.label };
  };
}

export interface MissingDetail { variable: LetterVariable; value: LetterValue | undefined }
/** The details a template needs that the application does not have (render / entered variables never are). */
export function missingDetails(html: string, registry: readonly LetterVariable[], values: Record<string, LetterValue>): MissingDetail[] {
  const byKey = new Map(registry.map((v) => [v.key, v]));
  return letterKeys(html).flatMap((key) => {
    const variable = byKey.get(key);
    if (!variable || variable.sourceKind === "render" || variable.sourceKind === "entered") return [];
    const value = values[key];
    return !value || value.missing ? [{ variable, value }] : [];
  });
}

/** What still blocks Send: required details without a value, and optional ones neither filled nor ticked to leave blank. */
export function blockingDetails(missing: readonly MissingDetail[], manual: readonly ManualFill[]): MissingDetail[] {
  const fills = new Map(manual.map((m) => [m.key, m]));
  return missing.filter(({ variable }) => {
    const fill = fills.get(variable.key);
    if (fill && fill.mode !== "blank" && fill.value.trim()) return false;
    if (fill?.mode === "blank" && !variable.required) return false;
    return true;
  });
}
