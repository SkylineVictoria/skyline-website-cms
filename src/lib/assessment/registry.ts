/**
 * The question-type registry (runtime-neutral part). Adding a type = adding an entry here and a React entry in
 * `src/components/assessment/registry.tsx`; no migration, because the database validates every answer against the
 * `responseSchema` the registry writes into the definition (DECISIONS.md D-07).
 */
import type { MarkingMode, Question, ResponseSchema } from "./types";

export type TypeGroup = "content" | "text" | "choice" | "structured" | "evidence" | "assessor";
/** How the auto-check key for the type is shaped (for the keys editor and `asm_autocheck_one`). */
export type KeyKind = "none" | "choice" | "choices" | "boolean" | "pairs" | "order" | "blanks" | "number" | "text";

export interface Option { id: string; label: string }
export interface GridColumn { id: string; label: string; kind?: "text" | "number" | "checkbox" }
export interface GridRow { id: string; label: string }
export interface ChecklistItem { id: string; text: string }

export interface QuestionType {
  id: string;
  label: string;
  icon: string;
  group: TypeGroup;
  hint: string;
  /** Never answered by anyone (instructions, media). */
  content?: boolean;
  /** Completed by the assessor, never the student. */
  assessorOnly?: boolean;
  hasChildren?: boolean;
  markingModes: MarkingMode[];
  defaultMarkingMode: MarkingMode;
  keyKind: KeyKind;
  defaultConfig: Record<string, unknown>;
  /** The response schema written into the definition for the given config (the database validates with it). */
  responseSchema: (config: Record<string, unknown>) => ResponseSchema | undefined;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const optionIds = (config: Record<string, unknown>): string[] => ((config.options as Option[] | undefined) ?? []).map((o) => o.id);

export const QUESTION_TYPES: QuestionType[] = [
  {
    id: "instruction", label: "Instruction / content", icon: "ri-information-line", group: "content", content: true,
    hint: "Text, images, links and attached documents the student reads; nothing to answer.",
    markingModes: ["none"], defaultMarkingMode: "none", keyKind: "none",
    defaultConfig: { html: "", attachments: [] }, responseSchema: () => undefined,
  },
  {
    id: "short_answer", label: "Short answer", icon: "ri-text", group: "text", hint: "One or two lines of text, with optional word limits.",
    markingModes: ["criteria", "rubric", "none"], defaultMarkingMode: "criteria", keyKind: "text",
    defaultConfig: { minWords: null, maxWords: 100, placeholder: "" },
    responseSchema: (c) => ({ type: "string", minWords: num(c.minWords), maxWords: num(c.maxWords) }),
  },
  {
    id: "long_answer", label: "Long answer (rich text)", icon: "ri-file-text-line", group: "text", hint: "A longer written response with formatting, with optional word limits.",
    markingModes: ["criteria", "rubric", "none"], defaultMarkingMode: "criteria", keyKind: "text",
    defaultConfig: { minWords: null, maxWords: null, richText: true },
    responseSchema: (c) => ({ type: "string", minWords: num(c.minWords), maxWords: num(c.maxWords) }),
  },
  {
    id: "single_choice", label: "Single choice", icon: "ri-radio-button-line", group: "choice", hint: "Pick one option; an optional \"Other\" with free text.",
    markingModes: ["auto", "criteria", "none"], defaultMarkingMode: "auto", keyKind: "choice",
    defaultConfig: { options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], allowOther: false, layout: "list" },
    responseSchema: (c) => (c.allowOther ? { type: "string", minLength: 1 } : { type: "string", enum: optionIds(c) }),
  },
  {
    id: "multi_choice", label: "Multiple choice", icon: "ri-checkbox-multiple-line", group: "choice", hint: "Pick one or more options, with optional minimum and maximum.",
    markingModes: ["auto", "criteria", "none"], defaultMarkingMode: "auto", keyKind: "choices",
    defaultConfig: { options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }, { id: "c", label: "Option C" }], allowOther: false, minSelected: 1, maxSelected: null },
    responseSchema: (c) => ({ type: "array", items: c.allowOther ? { type: "string" } : { type: "string", enum: optionIds(c) }, minItems: num(c.minSelected), maxItems: num(c.maxSelected), uniqueItems: true }),
  },
  {
    id: "true_false", label: "True / false", icon: "ri-toggle-line", group: "choice", hint: "A statement the student marks true or false.",
    markingModes: ["auto", "criteria", "none"], defaultMarkingMode: "auto", keyKind: "boolean",
    defaultConfig: { trueLabel: "True", falseLabel: "False" }, responseSchema: () => ({ type: "boolean" }),
  },
  {
    id: "matching", label: "Matching", icon: "ri-links-line", group: "structured", hint: "Match each item on the left with one on the right.",
    markingModes: ["auto", "criteria", "none"], defaultMarkingMode: "auto", keyKind: "pairs",
    defaultConfig: { left: [{ id: "l1", label: "Item 1" }, { id: "l2", label: "Item 2" }], right: [{ id: "r1", label: "Match 1" }, { id: "r2", label: "Match 2" }] },
    responseSchema: (c) => ({ type: "object", requiredKeys: ((c.left as Option[] | undefined) ?? []).map((o) => o.id) }),
  },
  {
    id: "ordering", label: "Ordering / ranking", icon: "ri-sort-asc", group: "structured", hint: "Put the items in the right order.",
    markingModes: ["auto", "criteria", "none"], defaultMarkingMode: "auto", keyKind: "order",
    defaultConfig: { items: [{ id: "i1", label: "Step 1" }, { id: "i2", label: "Step 2" }, { id: "i3", label: "Step 3" }] },
    responseSchema: (c) => { const n = ((c.items as Option[] | undefined) ?? []).length; return { type: "array", minItems: n, maxItems: n, uniqueItems: true }; },
  },
  {
    id: "fill_blanks", label: "Fill in the blanks", icon: "ri-input-method-line", group: "structured", hint: "Text with [blank] markers; one answer per blank (alternatives allowed in the key).",
    markingModes: ["auto", "criteria", "none"], defaultMarkingMode: "auto", keyKind: "blanks",
    defaultConfig: { text: "Tighten the bolt with a [blank] and check it with a [blank]." },
    responseSchema: (c) => { const n = (String(c.text ?? "").match(/\[blank\]/g) ?? []).length; return { type: "array", minItems: n, maxItems: n }; },
  },
  {
    id: "table_grid", label: "Table / grid", icon: "ri-table-line", group: "structured", hint: "Configurable rows and columns the student fills in.",
    markingModes: ["criteria", "rubric", "none"], defaultMarkingMode: "criteria", keyKind: "text",
    defaultConfig: { columns: [{ id: "c1", label: "Item", kind: "text" }, { id: "c2", label: "Detail", kind: "text" }], rows: [{ id: "r1", label: "1" }, { id: "r2", label: "2" }], allowAddRows: false },
    responseSchema: () => ({ type: "object" }),
  },
  {
    id: "likert", label: "Likert / rating scale", icon: "ri-star-line", group: "choice", hint: "A rating on a labelled scale.",
    markingModes: ["none", "criteria"], defaultMarkingMode: "none", keyKind: "number",
    defaultConfig: { min: 1, max: 5, labels: ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"] },
    responseSchema: (c) => ({ type: "integer", minimum: num(c.min) ?? 1, maximum: num(c.max) ?? 5 }),
  },
  {
    id: "number", label: "Number", icon: "ri-hashtag", group: "text", hint: "A number, with optional range and unit.",
    markingModes: ["auto", "criteria", "none"], defaultMarkingMode: "auto", keyKind: "number",
    defaultConfig: { min: null, max: null, unit: "", integer: false },
    responseSchema: (c) => ({ type: c.integer ? "integer" : "number", minimum: num(c.min), maximum: num(c.max) }),
  },
  {
    id: "date", label: "Date", icon: "ri-calendar-line", group: "text", hint: "A calendar date.",
    markingModes: ["criteria", "auto", "none"], defaultMarkingMode: "criteria", keyKind: "text",
    defaultConfig: {}, responseSchema: () => ({ type: "string", format: "date" }),
  },
  {
    id: "file_upload", label: "File / evidence upload", icon: "ri-upload-cloud-2-line", group: "evidence", hint: "One or more files, with allowed types, size and count.",
    markingModes: ["criteria", "rubric", "none"], defaultMarkingMode: "criteria", keyKind: "none",
    defaultConfig: { minFiles: 1, maxFiles: 5, maxMb: 25, accept: ["application/pdf", "image/jpeg", "image/png", "video/mp4"] },
    responseSchema: (c) => ({ type: "array", minFiles: num(c.minFiles), maxFiles: num(c.maxFiles) }),
  },
  {
    id: "url", label: "URL / link", icon: "ri-link", group: "text", hint: "A web address (a video, a shared document).",
    markingModes: ["criteria", "none"], defaultMarkingMode: "criteria", keyKind: "none",
    defaultConfig: {}, responseSchema: () => ({ type: "string", format: "url" }),
  },
  {
    id: "case_study", label: "Case study / scenario", icon: "ri-book-open-line", group: "structured", hasChildren: true, hint: "A scenario with nested sub-questions.",
    markingModes: ["criteria", "rubric", "none"], defaultMarkingMode: "criteria", keyKind: "none",
    defaultConfig: { scenario: "" }, responseSchema: () => ({ type: "object" }),
  },
  {
    id: "repeating_group", label: "Repeating group", icon: "ri-add-box-line", group: "structured", hasChildren: true, hint: "\"Add another entry\": the same set of fields any number of times.",
    markingModes: ["criteria", "rubric", "none"], defaultMarkingMode: "criteria", keyKind: "none",
    defaultConfig: { minEntries: 1, maxEntries: 10, entryLabel: "Entry" },
    responseSchema: (c) => ({ type: "array", minItems: num(c.minEntries), maxItems: num(c.maxEntries) }),
  },
  {
    id: "observation_checklist", label: "Observation checklist", icon: "ri-eye-line", group: "assessor", assessorOnly: true, hint: "Completed by the assessor while observing; each item is observed or not.",
    markingModes: ["observation"], defaultMarkingMode: "observation", keyKind: "none",
    defaultConfig: { items: [{ id: "o1", text: "Follows safe work practices" }, { id: "o2", text: "Uses the correct equipment" }], allowNotes: true },
    responseSchema: (c) => ({ type: "object", requiredKeys: ((c.items as ChecklistItem[] | undefined) ?? []).map((i) => i.id) }),
  },
  {
    id: "third_party_report", label: "Third-party report", icon: "ri-user-voice-line", group: "assessor", assessorOnly: true, hint: "A supervisor's or employer's report recorded by the assessor.",
    markingModes: ["observation", "none"], defaultMarkingMode: "observation", keyKind: "none",
    defaultConfig: { fields: [{ id: "name", label: "Reporter name" }, { id: "role", label: "Reporter role" }, { id: "report", label: "Report" }] },
    responseSchema: (c) => ({ type: "object", requiredKeys: ((c.fields as Option[] | undefined) ?? []).map((f) => f.id) }),
  },
  {
    id: "declaration", label: "Declaration / signature", icon: "ri-quill-pen-line", group: "content", hint: "The student's declaration (institution wording) with a typed signature, recorded with a hash at submission.",
    markingModes: ["none"], defaultMarkingMode: "none", keyKind: "none",
    defaultConfig: { text: "" }, responseSchema: () => ({ type: "object", requiredKeys: ["agreed", "signature"] }),
  },
];

export const TYPE_BY_ID: Record<string, QuestionType> = Object.fromEntries(QUESTION_TYPES.map((t) => [t.id, t]));
export const questionType = (id: string): QuestionType | undefined => TYPE_BY_ID[id];
export const GROUP_LABEL: Record<TypeGroup, string> = { content: "Content", text: "Text & numbers", choice: "Choices", structured: "Structured", evidence: "Evidence", assessor: "Assessor records" };
export const MARKING_LABEL: Record<MarkingMode, string> = { none: "No marking", auto: "Auto-check (suggests)", criteria: "Criteria (manual)", rubric: "Rubric", observation: "Observation" };

let counter = 0;
/** A short, unique, stable id for a new task / section / question / option. */
export function newId(prefix = "q"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** A new question of a type with its defaults; the response schema is recomputed by `withSchema` whenever the config changes. */
export function newQuestion(typeId: string): Question {
  const t = TYPE_BY_ID[typeId] ?? TYPE_BY_ID.short_answer;
  const q: Question = {
    id: newId("q"), type: t.id, label: t.content ? "" : "New question", required: !t.content && t.id !== "likert",
    markingMode: t.defaultMarkingMode, config: structuredClone(t.defaultConfig),
  };
  if (t.assessorOnly) q.assessorOnly = true;
  if (t.hasChildren) q.children = [];
  if (t.defaultMarkingMode === "criteria" && !t.hasChildren) q.criteria = [{ id: newId("c"), text: "Meets the requirement" }];
  return withSchema(q);
}

/** Writes the response schema the database will validate with (always derived from the type and config, never hand-edited). */
export function withSchema(q: Question): Question {
  const t = TYPE_BY_ID[q.type];
  const schema = t?.responseSchema(q.config ?? {});
  const out: Question = { ...q };
  if (schema) {
    const clean = Object.fromEntries(Object.entries(schema).filter(([, v]) => v !== undefined && v !== null));
    out.responseSchema = clean as Question["responseSchema"];
  } else delete out.responseSchema;
  return out;
}

export const isAnswerable = (q: Question) => !(TYPE_BY_ID[q.type]?.content ?? (q.type === "instruction" || q.type === "content"));
export const isAssessorOnly = (q: Question) => q.assessorOnly ?? Boolean(TYPE_BY_ID[q.type]?.assessorOnly);
