/**
 * ASM-AI-IMPORT: the structured output the model must return (JSON schema, strict) and the shapes built from it.
 * Two calls per document: the outline (what the document is, its codes, its tasks and their pages), then one call per task
 * (or per part of a long task): tasks -> sections -> items. Pure data, shared by the worker, the browser and the tests.
 */
import type { Classification, ItemType, ResponseKind } from "./classify.ts";
export type { Classification, ItemType, ResponseKind };

/** A difference the checks resolved by a rule: which rule, the text it ignored, and a sentence for the admin / audit log. */
export interface AutoResolved { rule: "response_label" | "numbering" | "heading_number"; text: string; note: string; page: number | null }

export const ITEM_KINDS = ["instruction", "question", "multipart", "table", "evidence", "drawing", "declaration"] as const;
export type ItemKind = typeof ITEM_KINDS[number];
export const TASK_KINDS = ["written", "project", "practical", "observation", "other"] as const;

export interface AiOutline {
  document_kind: "workbook" | "answer_guide" | "other";
  title: string | null;
  qualification_code: string | null;
  qualification_name: string | null;
  unit_code: string | null;
  unit_name: string | null;
  version: string | null;
  tasks: { number: string | null; title: string; kind: typeof TASK_KINDS[number]; first_page: number; last_page: number }[];
}

export interface AiPart { label: string; text: string; answer: string | null }
export interface AiItem {
  kind: ItemKind;
  number: string | null;
  /** Copied word for word from the page (no number, no cell separators). */
  text: string;
  parts: AiPart[];
  table: { columns: string[]; rows: string[][] } | null;
  pages: number[];
  confidence: number;
  reason: string | null;
  /** Answer guides only: the model answer, and the benchmark / what to look for. */
  answer: string | null;
  look_for: string | null;
}
export interface AiSection { title: string; items: AiItem[] }
export interface AiTaskPart { title: string; number: string | null; instructions: string | null; sections: AiSection[] }

const str = { type: "string" } as const;
const strOrNull = { type: ["string", "null"] } as const;

export const OUTLINE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["document_kind", "title", "qualification_code", "qualification_name", "unit_code", "unit_name", "version", "tasks"],
  properties: {
    document_kind: { type: "string", enum: ["workbook", "answer_guide", "other"] },
    title: strOrNull, qualification_code: strOrNull, qualification_name: strOrNull, unit_code: strOrNull, unit_name: strOrNull, version: strOrNull,
    tasks: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["number", "title", "kind", "first_page", "last_page"],
      properties: { number: strOrNull, title: str, kind: { type: "string", enum: [...TASK_KINDS] }, first_page: { type: "integer" }, last_page: { type: "integer" } },
    } },
  },
} as const;

const PART = {
  type: "object", additionalProperties: false, required: ["label", "text", "answer"],
  properties: { label: str, text: str, answer: strOrNull },
} as const;

export const TASK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "number", "instructions", "sections"],
  properties: {
    title: str, number: strOrNull, instructions: strOrNull,
    sections: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["title", "items"],
      properties: {
        title: str,
        items: { type: "array", items: {
          type: "object", additionalProperties: false,
          required: ["kind", "number", "text", "parts", "table", "pages", "confidence", "reason", "answer", "look_for"],
          properties: {
            kind: { type: "string", enum: [...ITEM_KINDS] },
            number: strOrNull, text: str,
            parts: { type: "array", items: PART },
            table: { anyOf: [{ type: "null" }, {
              type: "object", additionalProperties: false, required: ["columns", "rows"],
              properties: { columns: { type: "array", items: str }, rows: { type: "array", items: { type: "array", items: str } } },
            }] },
            pages: { type: "array", items: { type: "integer" } },
            confidence: { type: "number" },
            reason: strOrNull, answer: strOrNull, look_for: strOrNull,
          },
        } },
      },
    } },
  },
} as const;

/* ------------------------------------------------------------- after the checks (what the browser receives) */

export interface CheckedPart {
  label: string; part: string; text: string; answer: string | null; verbatim: VerbatimStatus; pdfText: string | null;
  /** close / missing: what differs, in words the admin can act on. */
  diff?: string | null;
  /** A short category label to answer against (table_row) or a sub-question of its own. */
  itemType?: "question" | "table_row";
}
export type VerbatimStatus = "exact" | "close" | "missing" | "empty" | "scanned";
export interface CheckedItem {
  kind: ItemKind;
  /** The number as printed, and normalised ("Q1.2" -> "1.2"). */
  number: string | null;
  canonical: string | null;
  text: string;
  parts: CheckedPart[];
  table: { columns: string[]; rows: string[][] } | null;
  pages: number[];
  confidence: number;
  answer: string | null;
  lookFor: string | null;
  verbatim: VerbatimStatus;
  /** The closest PDF wording when the text is not the PDF's word for word. */
  pdfText: string | null;
  /** close / missing: what differs (words added / left out), in words the admin can act on. */
  diff?: string | null;
  /** The model's own reason for a low confidence (kept to explain a flag). */
  reason?: string | null;
  /** Every page of the item is a scan (no text layer). */
  scanned?: boolean;
  /** A picture the AI reader did not place, added by the checks where it is printed. */
  added?: boolean;
  /** What the item is (classify.ts): question | section_heading | instruction | response_label. Older imports: undefined = question. */
  itemType?: ItemType;
  /** How the type was decided (rules / the AI's second check), with its confidence and reason. */
  classification?: Classification | null;
  /** Differences the checks resolved by a rule (not on the list; shown under "Auto-resolved" with Reopen; written to the audit log). */
  autoResolved?: AutoResolved[];
  /** A flag that must be resolved before publishing (two questions with the same number). */
  blocking?: boolean;
  /** response_label of an answer area: upload or calculation box (attached to the question it serves). */
  responseKind?: ResponseKind;
  /** The answer areas attached to this question (its response types): "Submission of Supporting Evidence…" = upload. */
  responseAreas?: { kind: ResponseKind; text: string; page: number | null }[];
  /** Reasons this item is on the "Check this" list (empty = looks good); worked out when the document is put together. */
  flags: string[];
}
export interface CheckedSection { title: string; items: CheckedItem[] }
export interface CheckedTask { number: string | null; title: string; kind: string; instructions: string | null; firstPage: number; lastPage: number; sections: CheckedSection[] }

export interface ImportSummary {
  tasks: number; questions: number; evidence: number; drawings: number; tables: number; flagged: number; answers: number; scannedPages: number;
  /** Section headings (not questions) and differences resolved by a rule (reader 3). */
  headings?: number; autoResolved?: number;
}
export interface CheckedDocument {
  kind: "workbook" | "guide";
  documentKind: AiOutline["document_kind"];
  title: string | null;
  qualification: { code: string; name: string } | null;
  unit: { code: string; name: string } | null;
  version: string | null;
  tasks: CheckedTask[];
  summary: ImportSummary;
  provider: string;
  model: string;
}
