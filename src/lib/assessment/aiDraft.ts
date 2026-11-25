/**
 * ASM-AI-IMPORT: the draft definition and the assessor keys built from the AI's checked document or the standard reader's result
 * (pure logic, shared by the Add assessment screen and the Node tests). Text is used exactly as checked; nothing is reworded here.
 * Answers only ever become QuestionKeys (asm_question_keys), never part of the definition.
 */
import { attachmentCapable, newId, newQuestion, withSchema, isAnswerable } from "./registry";
import { flattenQuestions } from "./definition";
import { workbookNumbering } from "./workbookLayout";
import type { ImportResult, WbImage } from "./workbookImport";
import type { Definition, ImportMeta, Question, QuestionKey, Section, Task } from "./types";
import type { CheckedDocument, CheckedItem, ImportSummary } from "../../../supabase/functions/_shared/asm-import/schema.ts";
import { normalizeNumber } from "../../../supabase/functions/_shared/asm-import/numbering.ts";
import { isResponseLabel } from "../../../supabase/functions/_shared/asm-import/classify.ts";
import { sameHeading } from "../../../supabase/functions/_shared/asm-import/pipeline.ts";
import { checkDocuments, matchGuide, type DocumentCheck, type GuideAnswer, type MatchOutcome, type MatchQuestion } from "../../../supabase/functions/_shared/asm-import/match.ts";

/** Text to read (an instruction item, not a section heading or a drawing): it goes to the task's instructions. */
const isReading = (it: CheckedItem) => it.kind === "instruction" && it.itemType !== "section_heading";

export type { CheckedDocument, DocumentCheck, MatchOutcome, GuideAnswer };
export type ImportKind = "workbook" | "guide";

export interface ImportStatus {
  id: string;
  kind: ImportKind;
  state: "uploading" | "queued" | "running" | "done" | "failed";
  fileName: string;
  pages: number;
  progress: { label: string; done: number; total: number };
  summary: Partial<ImportSummary> & { unit?: string | null; version?: string | null };
  error: string | null;
  usage: { input_tokens?: number; output_tokens?: number; calls?: number; cost_usd?: number | null };
  provider: string | null;
  model: string | null;
  cached: boolean;
  /** The reader version that read it (part of the cache key; older results are read again). */
  readerVersion?: number;
  result: CheckedDocument | null;
}

/* ------------------------------------------------------------------ the draft from the AI's checked document */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function meta(it: Pick<CheckedItem, "flags" | "text"> & Partial<Pick<CheckedItem, "pages" | "canonical" | "pdfText" | "itemType" | "classification" | "autoResolved" | "blocking" | "responseAreas">>, number?: string | null): ImportMeta {
  return {
    page: it.pages?.[0] ?? null, confidence: it.flags.length ? "low" : "high", ...(it.flags.length ? { note: it.flags.join(" · "), flags: it.flags } : {}),
    number: number ?? it.canonical ?? null, via: "ai", original: it.text, ...(it.pdfText ? { pdfText: it.pdfText } : {}),
    ...(it.itemType ? { itemType: it.itemType } : {}), ...(it.classification ? { classification: it.classification } : {}),
    ...(it.autoResolved?.length ? { autoResolved: it.autoResolved } : {}), ...(it.blocking ? { blocking: true } : {}),
    ...(it.responseAreas?.length ? { responseAreas: it.responseAreas } : {}),
  };
}

/**
 * ASM-BUILDER-COMPACT: the answer areas printed for a question ("Submission of Supporting Evidence…" = upload, "Mathematics
 * Calculation Box…" = calc) are its response types: the question takes attachments; the areas never become questions.
 */
function withResponseAreas(q: Question, it: CheckedItem): Question {
  if (!it.responseAreas?.length) return q;
  return withSchema({ ...q, config: { ...(q.config ?? {}), ...(attachmentCapable(q.type) ? { allowAttachment: true } : {}) } });
}

function questionFromItem(it: CheckedItem, pictures: WbImage[], used: Set<WbImage>): Question {
  return withResponseAreas(baseQuestionFromItem(it, pictures, used), it);
}

function baseQuestionFromItem(it: CheckedItem, pictures: WbImage[], used: Set<WbImage>): Question {
  // a section heading ("1. Introduction" of a report template) is a section label, never a question: no answer, no model answer
  if (it.itemType === "section_heading") {
    const q = newQuestion("instruction");
    q.config = { html: `<h4>${esc([it.number, it.text].filter(Boolean).join(" "))}</h4>`, attachments: [] };
    q.importMeta = meta(it, it.number ?? null);
    return withSchema(q);
  }
  if (it.kind === "instruction" || it.kind === "drawing") {
    const q = newQuestion("instruction");
    const imgs = it.kind === "drawing" ? pictures.filter((p) => !used.has(p) && it.pages.includes(p.page)).slice(0, 3) : [];
    imgs.forEach((p) => used.add(p));
    const body = it.kind === "drawing"
      ? `${imgs.map((p) => `<figure><img src="${p.src}" alt="${esc(it.text || "Drawing")}" /></figure>`).join("")}${it.text ? `<p><em>${esc(it.text)}</em></p>` : ""}`
      : it.text.split(/\n+/).map((l) => `<p>${esc(l)}</p>`).join("");
    q.config = { html: body, attachments: [] };
    // a drawing the reader found where the workbook's pictures could not be drawn in this browser: say so, and where
    const noPicture = it.kind === "drawing" && !imgs.length ? [`No picture found on page ${it.pages.join(", ")}: add the drawing from the PDF`] : [];
    q.importMeta = meta({ ...it, flags: [...it.flags, ...noPicture] }, null);
    return withSchema(q);
  }
  if (it.kind === "declaration") {
    const q = newQuestion("declaration");
    q.label = "Student declaration"; q.config = { text: it.text };
    q.importMeta = meta(it, null);
    return withSchema(q);
  }
  if (it.kind === "evidence") {
    const q = newQuestion("file_upload");
    q.label = it.text;
    q.importMeta = meta(it);
    return withSchema(q);
  }
  if (it.kind === "table" && it.table && it.table.columns.length) {
    const q = newQuestion("table_grid");
    q.label = it.text || "Complete the table";
    // a category table ("a. Australian and other relevant Standards | Short answer"): the first column names the rows, the others
    // are the answer cells (empty or a box label such as "Short answer")
    const labelled = it.table.columns.length >= 2 && !(it.table.columns[0] ?? "").trim() && it.table.rows.length > 0 && it.table.rows.every((r) => (r[0] ?? "").trim() && r.slice(1).every((c) => !c.trim() || isResponseLabel(c)));
    const answerCols = labelled ? it.table.columns.slice(1) : it.table.columns;
    const columns = answerCols.map((label, i) => ({ id: `c${i + 1}`, label: label || (labelled && answerCols.length === 1 ? "Answer" : `Column ${i + 1}`), kind: "text" }));
    const rows = (it.table.rows.length ? it.table.rows : [[""], [""]]).map((r, i) => ({ id: `r${i + 1}`, label: (r[0] ?? "").trim() || String(i + 1) }));
    q.config = { ...(q.config ?? {}), columns, rows, allowAddRows: false };
    q.importMeta = meta(it);
    return withSchema(q);
  }
  if (it.kind === "multipart" && it.parts.length) {
    const q = newQuestion("case_study");
    q.label = it.text; q.config = { scenario: "" };
    q.children = it.parts.map((p) => {
      const c = newQuestion("short_answer");
      c.label = p.text || p.label;
      const flags = p.verbatim === "close" || p.verbatim === "missing" ? [p.diff || (p.verbatim === "close" ? "Wording differs from the PDF" : "Text not found in the PDF")]
        : p.verbatim === "scanned" ? ["Read from a scanned page: check the text against the page"] : [];
      c.importMeta = { page: it.pages[0] ?? null, confidence: flags.length ? "low" : "high", ...(flags.length ? { flags, note: flags.join(" · ") } : {}), number: it.canonical ? `${normalizeNumber(it.canonical)?.base ?? it.canonical}${p.part}` : p.part, via: "ai", original: c.label, ...(p.pdfText ? { pdfText: p.pdfText } : {}) };
      return withSchema(c);
    });
    q.importMeta = meta(it);
    return withSchema(q);
  }
  const q = newQuestion("long_answer");
  q.label = it.text;
  q.importMeta = meta(it);
  return withSchema(q);
}

/** The draft definition built from the AI's checked document (text exactly as checked; nothing reworded here). */
export function definitionFromAi(doc: CheckedDocument, pictures: WbImage[] = []): Definition {
  const used = new Set<WbImage>();
  const tasks: Task[] = doc.tasks.map((t) => {
    // ASM-BUILDER-COMPACT: text to read ("Provide your response to each question in the box below", the role-play brief…) belongs to
    // its task as instructions (behind the task's ⓘ), not as rows among the questions; the part it came from is kept as a heading
    const instructions: string[] = t.instructions ? [t.instructions] : [];
    const sections: Section[] = [];
    for (const s of t.sections) {
      const reading = s.items.filter(isReading);
      if (reading.length) {
        if (!sameHeading(s.title, t.title)) instructions.push(`<h4>${esc(s.title)}</h4>`);
        instructions.push(...reading.map((it) => it.text.split(/\n+/).map((l) => `<p>${esc(l)}</p>`).join("")));
      }
      const rest = s.items.filter((it) => !isReading(it));
      if (rest.length) sections.push({ id: newId("s"), title: s.title, questions: rest.map((it) => questionFromItem(it, pictures, used)) });
    }
    return {
      id: newId("t"),
      title: t.number && !t.title.includes(t.number) ? `Task ${t.number}: ${t.title}` : t.title,
      instructions: instructions.join(""),
      sections,
    };
  });
  return {
    instructions: "",
    tasks,
    source: { qualification: doc.qualification, unit: doc.unit, version: doc.version, fileName: null },
  };
}

/* ------------------------------------------------------------------ the answer guide */

export function guideAnswersFromAi(doc: CheckedDocument): GuideAnswer[] {
  return doc.tasks.flatMap((t) => t.sections.flatMap((s) => s.items))
    .filter((i) => i.kind !== "instruction" && i.kind !== "drawing" && i.kind !== "declaration")
    .map((i) => ({ number: i.number, questionText: i.text || null, answer: i.answer, lookFor: i.lookFor, parts: i.parts.map((p) => ({ label: p.part || p.label, answer: p.answer, text: p.text })) }));
}

/** The standard reader's fallback for an answer guide: an assessor version's keys, by the printed numbering. */
export function guideAnswersFromParser(r: ImportResult): GuideAnswer[] {
  const numbers = workbookNumbering(r.definition);
  const keyOf = new Map(r.keys.map((k) => [k.questionId, k]));
  const out: GuideAnswer[] = [];
  for (const f of flattenQuestions(r.definition)) {
    const k = keyOf.get(f.question.id);
    if (!k || (!k.modelAnswer && !k.assessorGuidance)) continue;
    const top = f.parent ? numbers.get(f.parent.id)?.number : numbers.get(f.question.id)?.number;
    const part = f.parent ? String.fromCharCode(97 + Math.max(0, (f.parent.children ?? []).indexOf(f.question))) : "";
    out.push({ number: top ? `${top}${part}` : null, questionText: f.question.label || null, answer: k.modelAnswer ?? null, lookFor: k.assessorGuidance ?? null, parts: [] });
  }
  return out;
}

/** The questions of a draft as the matcher needs them: the printed number (AI) or the workbook numbering (standard reader). */
export function matchQuestions(def: Definition): MatchQuestion[] {
  const numbers = workbookNumbering(def);
  const out: MatchQuestion[] = [];
  for (const t of def.tasks) for (const s of t.sections) for (const q of s.questions) {
    if (!isAnswerable(q) || q.type === "declaration" || q.type === "adjustment_record") continue;
    const number = q.importMeta?.number ?? numbers.get(q.id)?.number ?? null;
    out.push({
      id: q.id, number, text: q.label,
      parts: (q.children ?? []).filter(isAnswerable).map((c, i) => ({ id: c.id, label: (c.importMeta?.number ? normalizeNumber(c.importMeta.number)?.part : null) ?? String.fromCharCode(97 + i), text: c.label })),
    });
  }
  return out;
}

export interface GuideApplied {
  keys: QuestionKey[];
  outcome: MatchOutcome;
  check: DocumentCheck;
  /** question id -> why the admin should look at its answer */
  review: Map<string, string>;
}

/** Applies a guide to a draft: refused (no keys) when the units differ. */
export function applyGuide(def: Definition, guide: { unitCode: string | null; version: string | null; answers: GuideAnswer[] }): GuideApplied {
  const check = checkDocuments({ unitCode: def.source?.unit?.code ?? null, version: def.source?.version ?? null }, guide);
  const questions = matchQuestions(def);
  if (check.block) return { keys: [], outcome: { keys: [], matched: 0, total: questions.length, missing: questions.map((q) => q.id), unused: guide.answers }, check, review: new Map() };
  const outcome = matchGuide(questions, guide.answers);
  const review = new Map<string, string>();
  for (const k of outcome.keys) if (k.review) review.set(k.questionId, k.review);
  return { keys: outcome.keys.map((k) => ({ questionId: k.questionId, modelAnswer: k.modelAnswer, assessorGuidance: k.assessorGuidance })), outcome, check, review };
}

/** Which reader's result to use: the AI's when it finished, else the standard reader (and why). */
export function chooseImportPath(ai: { status: ImportStatus | null; timedOut: boolean; skipped?: boolean } | null): { path: "ai" | "parser"; reason: string | null } {
  if (ai?.skipped) return { path: "parser", reason: "Read without AI (as you asked)." };
  if (!ai || !ai.status) return { path: "parser", reason: "The AI reader could not start." };
  if (ai.status.state === "done" && ai.status.result) return { path: "ai", reason: null };
  if (ai.timedOut) return { path: "parser", reason: "The AI reader took too long." };
  if (ai.status.state === "failed") return { path: "parser", reason: ai.status.error || "The AI reader failed." };
  return { path: "parser", reason: "The AI reader did not finish." };
}

/** Questions whose imported text or answer the admin changed (the version is bumped on publish). */
export function editedCount(def: Definition, keys: (QuestionKey & { originalModelAnswer?: string | null })[]): number {
  const q = flattenQuestions(def).filter((f) => f.question.importMeta?.editedAt).length;
  const k = keys.filter((x) => x.originalModelAnswer !== undefined && (x.originalModelAnswer ?? "") !== (x.modelAnswer ?? "")).length;
  return q + k;
}

/** Parser-only content the AI path keeps: the general instructions and compliance pages, and the items only the standard reader knows. */
const PARSER_ONLY = new Set(["adjustment_record", "observation_checklist", "declaration"]);

/**
 * The AI reads the tasks; the standard reader also reads the pages around them (plagiarism / appeals instructions, the reasonable
 * adjustment record, the student declaration, assessor observation checklists). Those are taken from the standard reader's draft:
 * each goes into the AI task whose pages hold it (else the last task), flagged so the admin checks where it landed.
 */
export function mergeParserExtras(ai: Definition, parser: Definition, taskPages: { firstPage: number; lastPage: number }[]): Definition {
  const out: Definition = structuredClone(ai);
  if (!out.instructions && parser.instructions) out.instructions = parser.instructions;
  const have = new Set(flattenQuestions(out).map((f) => f.question.type));
  for (const f of flattenQuestions(parser)) {
    const q = f.question;
    if (f.parent || !PARSER_ONLY.has(q.type)) continue;
    if (q.type !== "observation_checklist" && have.has(q.type)) continue; // one declaration / one adjustment record
    const page = q.importMeta?.page ?? null;
    // the task whose pages hold it, else the task it follows (a declaration or record printed after a task's pages belongs to it)
    let ti = page == null ? -1 : taskPages.findIndex((t) => page >= t.firstPage && page <= t.lastPage);
    if (ti < 0 && page != null) ti = taskPages.reduce((found, t, i) => (t.firstPage <= page ? i : found), page < (taskPages[0]?.firstPage ?? 0) ? 0 : -1);
    const task = out.tasks[ti >= 0 ? ti : out.tasks.length - 1];
    if (!task) continue;
    if (!task.sections.length) task.sections.push({ id: newId("s"), title: task.title, questions: [] });
    const flags = ti >= 0 ? [] : ["Added from the standard reader without a page: check which task it belongs to"];
    const copy: Question = { ...structuredClone(q), importMeta: { ...(q.importMeta ?? { confidence: "high" }), via: "parser", ...(flags.length ? { flags, confidence: "low" as const, note: flags[0] } : {}) } };
    task.sections[task.sections.length - 1].questions.push(copy);
  }
  return out;
}
