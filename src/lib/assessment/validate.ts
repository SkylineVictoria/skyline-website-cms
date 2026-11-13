import { conditionMet, isEmptyValue } from "./conditions";
import type { Definition, Question, ResponseSchema, Responses, ValidationError } from "./types";
import { FORBIDDEN_DEFINITION_KEYS } from "./types";

/** Mirrors `public.asm_schema_check`: returns the rule that failed, or null. The database is the authority; this gives live feedback. */
export function schemaCheck(schema: ResponseSchema | undefined, v: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  if (v === null || v === undefined) return null;
  const t = schema.type;
  if (t) {
    if (t === "integer") { if (typeof v !== "number" || !Number.isInteger(v)) return "type"; }
    else if (t === "string" && typeof v !== "string") return "type";
    else if (t === "number" && typeof v !== "number") return "type";
    else if (t === "boolean" && typeof v !== "boolean") return "type";
    else if (t === "array" && !Array.isArray(v)) return "type";
    else if (t === "object" && (typeof v !== "object" || Array.isArray(v))) return "type";
  }
  if (schema.enum && !Array.isArray(v) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) return "enum";
  if (typeof v === "string") {
    if (schema.minLength !== undefined && v.length < schema.minLength) return "minLength";
    if (schema.maxLength !== undefined && v.length > schema.maxLength) return "maxLength";
    if (schema.minWords !== undefined || schema.maxWords !== undefined) {
      const words = v.trim() === "" ? 0 : v.trim().split(/\s+/).length;
      if (schema.minWords !== undefined && words < schema.minWords) return "minWords";
      if (schema.maxWords !== undefined && words > schema.maxWords) return "maxWords";
    }
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return "format";
    if (schema.format === "time" && !/^\d{2}:\d{2}$/.test(v)) return "format";
    if (schema.format === "url" && !/^https?:\/\/\S+$/i.test(v)) return "format";
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "format";
  }
  if (typeof v === "number") {
    if (schema.minimum !== undefined && v < schema.minimum) return "minimum";
    if (schema.maximum !== undefined && v > schema.maximum) return "maximum";
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) return "minItems";
    if (schema.maxItems !== undefined && v.length > schema.maxItems) return "maxItems";
    if (schema.minFiles !== undefined && v.length < schema.minFiles) return "minFiles";
    if (schema.maxFiles !== undefined && v.length > schema.maxFiles) return "maxFiles";
    if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) return "uniqueItems";
    if (schema.items && v.some((e) => schemaCheck(schema.items, e) !== null)) return "items";
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of schema.requiredKeys ?? []) if (!(k in o) || o[k] === null || o[k] === "") return "requiredKeys";
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in o && schemaCheck(s, o[k]) !== null) return "properties";
  }
  return null;
}

export const RULE_MESSAGES: Record<string, string> = {
  required: "This question is required.", type: "The answer has the wrong shape.", enum: "Choose one of the listed options.",
  minLength: "The answer is too short.", maxLength: "The answer is too long.", minWords: "Write more words.", maxWords: "Too many words.",
  minimum: "The number is too small.", maximum: "The number is too large.", format: "The value is not in the expected format.",
  minItems: "Add more entries.", maxItems: "Too many entries.", uniqueItems: "Each entry must be different.", items: "An entry is not valid.",
  requiredKeys: "Complete every part.", properties: "A part of the answer is not valid.", minFiles: "Upload a file.", maxFiles: "Too many files.",
};
const message = (code: string) => RULE_MESSAGES[code] ?? `The answer does not meet the rule ${code}.`;

export type ValidationRole = "student" | "assessor";

function isAssessorOnly(q: Question): boolean {
  return q.assessorOnly ?? (q.type === "observation_checklist" || q.type === "third_party_report");
}

function validateQuestions(questions: Question[] | undefined, responses: Responses, role: ValidationRole, prefix: string): ValidationError[] {
  const errs: ValidationError[] = [];
  for (const q of questions ?? []) {
    if (q.type === "instruction" || q.type === "content") continue;
    if (!conditionMet(q.showIf, responses)) continue;
    const ao = isAssessorOnly(q);
    if (ao && role === "student") continue;
    if (!ao && role === "assessor") continue;
    const v = responses[q.id];
    if (q.type === "repeating_group") {
      if (q.required && isEmptyValue(v)) { errs.push({ questionId: prefix + q.id, code: "required", message: "Add at least one entry." }); continue; }
      if (v !== undefined && v !== null) {
        if (!Array.isArray(v)) { errs.push({ questionId: prefix + q.id, code: "type", message: "Entries must be a list." }); continue; }
        const code = schemaCheck(q.responseSchema, v);
        if (code) errs.push({ questionId: prefix + q.id, code, message: message(code) });
        v.forEach((item, i) => errs.push(...validateQuestions(q.children, (item && typeof item === "object" ? item : {}) as Responses, role, `${prefix}${q.id}[${i}].`)));
      }
      continue;
    }
    if (q.type === "case_study") {
      errs.push(...validateQuestions(q.children, (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Responses, role, `${prefix}${q.id}.`));
      continue;
    }
    if (q.required && isEmptyValue(v)) { errs.push({ questionId: prefix + q.id, code: "required", message: message("required") }); continue; }
    const code = schemaCheck(q.responseSchema, v);
    if (code) errs.push({ questionId: prefix + q.id, code, message: message(code) });
  }
  return errs;
}

/** Mirrors `public.asm_validate_responses`. */
export function validateResponses(definition: Definition, responses: Responses, role: ValidationRole = "student"): ValidationError[] {
  const errs: ValidationError[] = [];
  for (const t of definition.tasks ?? []) {
    for (const s of t.sections ?? []) {
      if (!conditionMet(s.showIf, responses)) continue;
      errs.push(...validateQuestions(s.questions, responses, role, ""));
    }
  }
  return errs;
}

/** The first forbidden (assessor-only) key found anywhere in a definition, or null. Mirrors `asm_jsonb_forbidden_key`. */
export function forbiddenKey(value: unknown): string | null {
  if (Array.isArray(value)) { for (const v of value) { const r = forbiddenKey(v); if (r) return r; } return null; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((FORBIDDEN_DEFINITION_KEYS as readonly string[]).includes(k)) return k;
      const r = forbiddenKey(v); if (r) return r;
    }
  }
  return null;
}

/** Structural problems of a definition (mirrors `asm_validate_definition`): ids, duplicate ids, types, marking modes. */
export function validateDefinition(def: Definition): { code: string; message: string; questionId?: string }[] {
  const errs: { code: string; message: string; questionId?: string }[] = [];
  if (!def || !Array.isArray(def.tasks)) return [{ code: "shape", message: "The definition must have a tasks array." }];
  const fk = forbiddenKey(def);
  if (fk) errs.push({ code: "assessor_data", message: `Assessor-only data (${fk}) must be kept in the keys, not in the definition.` });
  const ids = new Set<string>();
  const walk = (q: Question) => {
    if (!q.id || !/^[A-Za-z0-9_.-]{1,80}$/.test(q.id)) errs.push({ code: "question_id", message: "Every question needs an id of letters, digits, dot, dash or underscore." });
    else if (ids.has(q.id)) errs.push({ code: "duplicate_id", questionId: q.id, message: `Question id ${q.id} is used twice.` });
    else ids.add(q.id);
    if (!q.type || !/^[a-z][a-z0-9_]{1,40}$/.test(q.type)) errs.push({ code: "question_type", questionId: q.id, message: "Every question needs a type." });
    const mode = q.markingMode ?? (q.type === "instruction" || q.type === "content" ? "none" : "criteria");
    if (!["none", "auto", "criteria", "rubric", "observation"].includes(mode)) errs.push({ code: "marking_mode", questionId: q.id, message: `Unknown marking mode ${mode}.` });
    for (const c of q.children ?? []) walk(c);
  };
  for (const t of def.tasks) {
    if (!t.id?.trim()) errs.push({ code: "task_id", message: "Every task needs an id." });
    for (const s of t.sections ?? []) {
      if (!s.id?.trim()) errs.push({ code: "section_id", message: "Every section needs an id." });
      for (const q of s.questions ?? []) walk(q);
    }
  }
  return errs;
}
