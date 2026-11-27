/**
 * ASM-ANY-LAYOUT (owner 2026-11-27): the AI's only job on a workbook is to say what each empty area is (a variable), for the areas the
 * rules could not settle. It never rewrites text and is never used while answering, marking or making the PDF.
 * Per page: the page image with each candidate drawn and numbered, plus the numbered list (shape, the text beside it). The answer is
 * one entry per candidate number: student answer / trainer field / record field / not a field, the question number as printed, and the
 * kind. Only numbers of real candidates are accepted (anything else is dropped and counted). Pure: used by asm-import and the tests.
 */
import type { StructuredRequest } from "./provider.ts";

export const FIELD_CLASSES = ["student_answer", "trainer_field", "record_field", "not_a_field"] as const;
export const FIELD_AI_KINDS = ["text", "table_cell", "yes_no", "tick", "signature", "date"] as const;
export const RECORD_VALUES = ["student_name", "student_id", "student_email", "trainer_name", "unit_code", "unit_name", "unit_code_name", "qualification_code", "qualification_name", "submission_date", "start_date", "end_date", "other"] as const;
export type FieldClass = typeof FIELD_CLASSES[number];
export type FieldAiKind = typeof FIELD_AI_KINDS[number];

/** A candidate as the model sees it (what the browser sends; no student data: the workbook is blank). */
export interface CandidateBrief { n: number; shape: string; left?: string; column?: string; above?: string; tickLabel?: string; placeholder?: string; table?: string | null }
export interface ClassifyPage { page: number; imageDataUrl: string; imageWidth: number; imageHeight: number; candidates: CandidateBrief[]; pageText?: string }
export interface Classified { n: number; class: FieldClass; question: string | null; kind: FieldAiKind; record: string | null }

const INSTRUCTIONS = [
  "You look at one page of a vocational training workbook (a blank student assessment pack) and say what each numbered empty area is.",
  "The image shows the page with every candidate area outlined and numbered. The list gives the same numbers with the text printed beside each area.",
  "For EVERY number in the list return exactly one entry, and use only those numbers:",
  "- class: student_answer (the student writes or ticks it), trainer_field (the assessor / trainer / supervisor fills it: marks, comments, outcome, assessor signature),",
  "  record_field (a fixed record value: student name, student ID, unit, qualification, dates of submission), or not_a_field (decoration, a spacer cell, a printed table, an area nobody fills).",
  "- question: the question number exactly as printed on the page for the question this area answers (\"1\", \"2.3\", \"Q4\", \"4 b\"), else null.",
  "- kind: text (free text), table_cell (one cell of a table to fill), yes_no (one option of a Yes/No or S/NS pair), tick (a tick box on its own), signature, or date.",
  "- record: for record_field, which value (student_name, student_id, ...; other when none fits), else null.",
  "Do not invent areas, do not copy or rewrite any text from the page.",
].join("\n");

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["fields"],
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["n", "class", "question", "kind", "record"],
        properties: {
          n: { type: "integer" },
          class: { type: "string", enum: [...FIELD_CLASSES] },
          question: { type: ["string", "null"] },
          kind: { type: "string", enum: [...FIELD_AI_KINDS] },
          record: { type: ["string", "null"], enum: [...RECORD_VALUES, null] },
        },
      },
    },
  },
};

const short = (s: string | undefined, n = 120) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function classifyRequest(page: ClassifyPage, detail: "low" | "high" = "high"): StructuredRequest {
  const list = page.candidates.map((c) => {
    const parts = [`#${c.n} ${c.shape}`];
    if (c.left) parts.push(`left: "${short(c.left)}"`);
    if (c.column) parts.push(`column: "${short(c.column, 60)}"`);
    if (c.tickLabel) parts.push(`after: "${short(c.tickLabel, 30)}"`);
    if (c.placeholder) parts.push(`placeholder: "${short(c.placeholder, 40)}"`);
    if (c.above) parts.push(`above: "${short(c.above)}"`);
    if (c.table) parts.push(`table ${c.table}`);
    return parts.join(" · ");
  }).join("\n");
  return {
    name: "workbook_fields",
    schema: SCHEMA,
    instructions: INSTRUCTIONS,
    input: [
      { kind: "text", text: `Page ${page.page}. Candidates:\n${list}${page.pageText ? `\n\nPage text (for question numbers only):\n${short(page.pageText, 3000)}` : ""}` },
      { kind: "image", dataUrl: page.imageDataUrl, detail },
    ],
    maxOutputTokens: Math.min(4000, 120 + page.candidates.length * 40),
    timeoutMs: 60_000,
  };
}

/** The model's answer, kept only where it names a real candidate (each once); everything else is refused and counted. */
export function validateClassification(data: unknown, candidates: number[]): { fields: Classified[]; refused: number } {
  const allowed = new Set(candidates);
  const seen = new Set<number>();
  const out: Classified[] = [];
  let refused = 0;
  const list = (data as { fields?: unknown[] } | null)?.fields;
  if (!Array.isArray(list)) return { fields: [], refused: 1 };
  for (const raw of list) {
    const f = raw as Partial<Classified>;
    const n = Number(f?.n);
    if (!Number.isInteger(n) || !allowed.has(n) || seen.has(n) || !(FIELD_CLASSES as readonly string[]).includes(String(f.class)) || !(FIELD_AI_KINDS as readonly string[]).includes(String(f.kind))) { refused++; continue; }
    seen.add(n);
    const question = typeof f.question === "string" && f.question.trim() ? f.question.trim().slice(0, 40) : null;
    const record = f.class === "record_field" && typeof f.record === "string" && (RECORD_VALUES as readonly string[]).includes(f.record) ? f.record : null;
    out.push({ n, class: f.class as FieldClass, question, kind: f.kind as FieldAiKind, record });
  }
  return { fields: out, refused };
}

/**
 * Tokens an image costs before it is sent (OpenAI patch-based models such as gpt-4.1-mini: 32 px patches, capped at 1536, times the
 * model's multiplier), plus the text; used to stop before a workbook would pass its budget.
 */
export function estimateInputTokens(page: ClassifyPage, multiplier = 1.62): number {
  let w = page.imageWidth; let h = page.imageHeight;
  let patches = Math.ceil(w / 32) * Math.ceil(h / 32);
  if (patches > 1536) { const s = Math.sqrt((1536 * 32 * 32) / (w * h)); w = Math.floor(w * s); h = Math.floor(h * s); patches = Math.ceil(w / 32) * Math.ceil(h / 32); }
  const text = classifyRequest(page).input.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") + INSTRUCTIONS;
  return Math.ceil(patches * multiplier) + Math.ceil(text.length / 3.5);
}

/** The lab / test answer: a deterministic guess from the printed text (never used live). */
export function mockClassification(request: StructuredRequest): unknown {
  const text = request.input.find((p) => p.kind === "text") as { text: string } | undefined;
  const rows = (text?.text ?? "").split("\n").filter((l) => l.startsWith("#"));
  return {
    fields: rows.map((l) => {
      const n = Number(/^#(\d+)/.exec(l)?.[1]);
      const tick = / tick/.test(l); const lower = l.toLowerCase();
      const trainer = /assessor|trainer|supervisor|office use/.test(lower);
      const empty = !/left: |column: |above: /.test(l);
      return { n, class: empty ? "not_a_field" : trainer ? "trainer_field" : "student_answer", question: null, kind: tick ? "tick" : / cell/.test(l) ? "table_cell" : "text", record: null };
    }),
  };
}
