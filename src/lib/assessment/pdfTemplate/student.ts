/**
 * ASM-PDF-TEMPLATE phase 2: the student's wizard over the workbook PDF, as pure rules (shared by the page, the tests and, for the
 * missing-answer check, the database's asm_template_missing).
 *
 * Answers live in the attempt's responses: pdf {fieldId: text} (text, table cells, dates, ticks "true"), pdfChoice {group: option}
 * (the student's own choices: ratings, Yes / No), pdfDeclared {task: true} (each task's declaration agreed). The student signs once
 * (asm_sign student_declaration); that signature fills every student signature field of the submission.
 */
import { questionName, type PdfTemplate, type TemplateField, type TemplateQuestion, type TemplatePage } from "./model";

export interface PdfAnswers { pdf?: Record<string, string>; pdfChoice?: Record<string, string>; pdfDeclared?: Record<string, boolean> }

/** The fields the student sees: their own and the record's, never the trainer's or the acknowledgement row. */
export const studentFields = (t: PdfTemplate): TemplateField[] => t.fields.filter((f) => (f.role === "student" || f.role === "auto") && f.step !== "acknowledge");
const onEvaluation = (t: PdfTemplate, f: TemplateField) => t.pages[f.page - 1]?.kind === "appendix_b";

export type WizardStep =
  | { kind: "details"; id: string; title: string }
  | { kind: "read"; id: string; title: string; task: number | null; pages: number[] }
  | { kind: "question"; id: string; title: string; task: number | null; key: string }
  | { kind: "declaration"; id: string; title: string; task: number | null; page: number }
  | { kind: "evaluation"; id: string; title: string; pages: number[] }
  | { kind: "review"; id: string; title: string };

const SHOWN_TO_READ: ReadonlySet<TemplatePage["kind"]> = new Set(["info", "task_start"]);

/**
 * The steps, in the workbook's order: your details, then per task its instruction pages (as page images), one step per question,
 * the task's declaration; Appendix B (optional); review and submit. Trainer pages, continued pages (part of their question) and the
 * results / summary sheets never become steps.
 */
export function wizardSteps(t: PdfTemplate): WizardStep[] {
  const steps: WizardStep[] = [{ kind: "details", id: "details", title: "Your details" }];
  const byHeader = new Map<number, TemplateQuestion[]>();
  for (const q of t.questions) byHeader.set(q.header.page, [...(byHeader.get(q.header.page) ?? []), q].sort((a, b) => a.header.y - b.header.y));
  for (const task of t.tasks) {
    const n = Number(task.number);
    let read: number[] = [];
    const flush = () => { if (read.length) steps.push({ kind: "read", id: `read-${read[0]}`, title: `Task ${task.number} · ${steps.some((s) => s.kind === "read" && s.task === n) ? "Read" : "Instructions"}`, task: n, pages: read }); read = []; };
    for (let page = task.firstPage; page <= task.lastPage; page++) {
      const kind = t.pages[page - 1]?.kind;
      if (!kind) continue;
      if (SHOWN_TO_READ.has(kind)) { read.push(page); continue; }
      if (kind === "question") { flush(); for (const q of byHeader.get(page) ?? []) steps.push({ kind: "question", id: `q-${q.key}`, title: `${questionName(q)}`, task: n, key: q.key }); continue; }
      if (kind === "declaration") { flush(); steps.push({ kind: "declaration", id: `decl-${n}-${page}`, title: `Task ${task.number} · Declaration`, task: n, page }); }
    }
    flush();
  }
  const evaluation = t.pages.filter((p) => p.kind === "appendix_b").map((p) => p.page);
  if (evaluation.length) steps.push({ kind: "evaluation", id: "evaluation", title: "Learner evaluation (optional)", pages: evaluation });
  steps.push({ kind: "review", id: "review", title: "Review & submit" });
  return steps;
}

export const isFilled = (v: unknown) => typeof v === "string" ? v.trim() !== "" : v != null && v !== false;
export function fieldValue(a: PdfAnswers, f: TemplateField): string {
  if ((f.kind === "yes_no" || f.kind === "rating") && f.group) return a.pdfChoice?.[f.group] === f.option ? (f.option ?? "") : "";
  return a.pdf?.[f.id] ?? "";
}

export interface Missing { code: "unanswered" | "required" | "table" | "declaration" | "signature"; questionKey?: string | null; fieldId?: string; task?: number | null; slot?: string; message: string }

/**
 * What blocks the submission (the same rules and words as public.asm_template_missing):
 *  - every question answered; each text box and "Short answer" part filled (required fields);
 *  - a table with printed rows (Q3's tools): every cell; a table of blank rows: at least one complete row;
 *  - each task's declaration signed at the end of the task; the whole-pack declaration signed on the submit step;
 *  - Appendix B is optional.
 * signed: the signature slots the student has signed ("decl:1", "pack").
 */
export function missingItems(t: PdfTemplate, a: PdfAnswers, signed: readonly string[]): Missing[] {
  const out: Missing[] = [];
  const mine = studentFields(t).filter((f) => f.role === "student" && !onEvaluation(t, f));
  for (const q of t.questions) {
    const own = mine.filter((f) => f.questionKey === q.key && f.kind !== "signature");
    if (!own.length) continue;
    const name = reviewName(t, q);
    if (!own.some((f) => isFilled(fieldValue(a, f)))) { out.push({ code: "unanswered", questionKey: q.key, message: `${name} is not answered yet.` }); continue; }
    for (const f of own.filter((x) => x.kind !== "table_cell" && x.required && !isFilled(fieldValue(a, x)))) out.push({ code: "required", questionKey: q.key, fieldId: f.id, message: `${name}: "${f.label}" is empty.` });
    const groups = [...new Set(own.filter((x) => x.kind === "table_cell" && x.table?.group).map((x) => x.table!.group!))];
    groups.forEach((g, i) => {
      const cells = own.filter((x) => x.table?.group === g);
      const which = groups.length > 1 ? ` (table ${i + 1} of ${groups.length})` : "";
      if (cells[0].table?.fixed) {
        const empty = cells.filter((c) => !isFilled(fieldValue(a, c))).length;
        if (empty) out.push({ code: "table", questionKey: q.key, message: `${name}: ${empty} empty cell${empty === 1 ? "" : "s"} in the table${which}.` });
      } else {
        const rowKeys = [...new Set(cells.map((c) => c.table!.rowKey ?? c.id))];
        const complete = rowKeys.some((r) => cells.filter((c) => (c.table!.rowKey ?? c.id) === r).every((c) => isFilled(fieldValue(a, c))));
        if (!complete) out.push({ code: "table", questionKey: q.key, message: `${name}: fill in at least one complete row of the table${which}.` });
      }
    });
  }
  for (const f of mine.filter((x) => !x.questionKey && x.required && x.kind !== "signature" && !isFilled(fieldValue(a, x)))) out.push({ code: "required", fieldId: f.id, message: `"${f.label}" (page ${f.page}) is empty.` });
  for (const d of declarationTasks(t)) if (!signed.includes(`decl:${d}`)) out.push({ code: "declaration", task: d, slot: `decl:${d}`, message: `Sign the Task ${d} declaration.` });
  const pack = mine.find((f) => f.kind === "signature" && f.slot === "pack");
  if (pack && !signed.includes("pack")) out.push({ code: "signature", slot: "pack", message: `Sign the student declaration (page ${pack.page}).` });
  return out;
}
/** A question's name in the review list: as printed, with its task when another task prints the same number ("Task 1 · Q2"). */
export const reviewName = (t: PdfTemplate, q: TemplateQuestion) => t.questions.filter((x) => questionName(x) === questionName(q)).length > 1 && q.task != null ? `Task ${q.task} · ${questionName(q)}` : questionName(q);
export const declarationTasks = (t: PdfTemplate): number[] => [...new Set(t.pages.filter((p) => p.kind === "declaration" && p.task != null).map((p) => p.task as number))];

/* ------------------------------------------------------------------ tables */
export interface TableColumn { x: number; label: string }
export interface TableRow { id: string; label: string; cells: (TemplateField | null)[] }
export interface Table { id: string; columns: TableColumn[]; rows: TableRow[]; fixedRows: boolean; labelColumn: boolean }

/**
 * A question's table cells as tables: cells sharing the same columns on consecutive rows (also over a page break) are one table;
 * another set of columns, or a gap of more than a few rows, starts the next one. Rows printed with a label (Q3's tool names) are fixed.
 */
export function tablesOf(fields: TemplateField[]): Table[] {
  const cells = fields.filter((f) => f.kind === "table_cell").sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const rows: { page: number; y: number; h: number; cells: TemplateField[] }[] = [];
  for (const c of cells) {
    const r = rows.find((o) => o.page === c.page && Math.abs(o.y - c.y) < 0.004);
    if (r) r.cells.push(c); else rows.push({ page: c.page, y: c.y, h: c.h, cells: [c] });
  }
  const colsOf = (r: { cells: TemplateField[] }) => r.cells.map((c) => Math.round(c.x * 200)).sort((a, b) => a - b);
  const sameCols = (a: number[], b: number[]) => {
    // a row may miss a column (its label cell is printed text): same table when the shorter set sits inside the longer one
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    return s.every((x) => l.some((y) => Math.abs(x - y) <= 1));
  };
  const tables: { rows: typeof rows; cols: number[] }[] = [];
  for (const r of rows) {
    const cur = tables[tables.length - 1];
    const prev = cur?.rows[cur.rows.length - 1];
    const near = prev && (r.page === prev.page ? r.y - (prev.y + prev.h) < 0.06 : r.page === prev.page + 1 && r.y < 0.3);
    if (cur && near && sameCols(cur.cols, colsOf(r))) { cur.rows.push(r); for (const x of colsOf(r)) if (!cur.cols.some((y) => Math.abs(x - y) <= 1)) cur.cols.push(x); cur.cols.sort((a, b) => a - b); }
    else tables.push({ rows: [r], cols: colsOf(r) });
  }
  return tables.map((t, ti) => {
    const columns = t.cols.map((x) => {
      const c = t.rows.flatMap((r) => r.cells).find((f) => Math.abs(Math.round(f.x * 200) - x) <= 1 && f.table?.column);
      return { x, label: c?.table?.column ?? "" };
    });
    const fixedRows = t.rows.every((r) => r.cells.some((c) => c.table?.rowLabel));
    return {
      id: `t${ti + 1}-${t.rows[0].cells[0].id}`, columns, fixedRows, labelColumn: fixedRows,
      rows: t.rows.map((r, ri) => ({
        id: r.cells[0].id, label: r.cells.find((c) => c.table?.rowLabel)?.table?.rowLabel ?? `Row ${ri + 1}`,
        cells: t.cols.map((x) => r.cells.find((c) => Math.abs(Math.round(c.x * 200) - x) <= 1) ?? null),
      })),
    };
  });
}

/* ------------------------------------------------------------------ a question's inputs, in the order the page prints them */
export type QuestionInput =
  | { kind: "text"; field: TemplateField; boxes: TemplateField[] }
  | { kind: "table"; table: Table }
  | { kind: "field"; field: TemplateField };

/**
 * The inputs of a question: text answers (an answer box that goes on at the top of the next page is the same answer: one input,
 * the text flows from box to box), tables, single fields. Only the student's and the record's fields.
 */
export function questionInputs(t: PdfTemplate, key: string): QuestionInput[] {
  const q = t.questions.find((x) => x.key === key);
  const fields = studentFields(t).filter((f) => f.questionKey === key).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const tables = tablesOf(fields);
  const tableOf = new Map(tables.flatMap((tb) => tb.rows.flatMap((r) => r.cells.filter((c): c is TemplateField => !!c).map((c) => [c.id, tb] as const))));
  const out: QuestionInput[] = [];
  const emitted = new Set<string>();
  for (const f of fields) {
    const tb = tableOf.get(f.id);
    if (tb) { if (!emitted.has(tb.id)) { emitted.add(tb.id); out.push({ kind: "table", table: tb }); } continue; }
    if (f.kind === "text") {
      const prev = out[out.length - 1];
      const last = prev?.kind === "text" ? prev.boxes[prev.boxes.length - 1] : null;
      // the free space at the top of a continued page carries on the answer that ended the page before
      const carries = !f.required && f.label === "Answer" && f.page !== q?.header.page && f.y < 0.3 && last && last.page === f.page - 1 && last.y + last.h > 0.8;
      if (carries && prev?.kind === "text") { prev.boxes.push(f); continue; }
      out.push({ kind: "text", field: f, boxes: [f] });
      continue;
    }
    out.push({ kind: "field", field: f });
  }
  return out;
}

/* ------------------------------------------------------------------ text fit (8 pt minimum, then a continued page) */
export const FIT_SIZES = [10, 9.5, 9, 8.5, 8];
export const LINE_HEIGHT = 1.2;
export const FIT_PADDING = 2;
export interface Fit { size: number; lines: string[]; capacity: number; fits: boolean; overflowLines: number }

/** Wraps the answer in a box (points) at the largest size from 10 to 8 pt that fits; past 8 pt the rest goes to a continued page. */
export function fitText(text: string, wPt: number, hPt: number, measure: (s: string, size: number) => number): Fit {
  const width = Math.max(10, wPt - 2 * FIT_PADDING);
  let last: Fit | null = null;
  for (const size of FIT_SIZES) {
    const lines = wrap(text, width, size, measure);
    const capacity = Math.max(1, Math.floor((hPt - 2 * FIT_PADDING) / (size * LINE_HEIGHT)));
    last = { size, lines, capacity, fits: lines.length <= capacity, overflowLines: Math.max(0, lines.length - capacity) };
    if (last.fits) return last;
  }
  return last!;
}
export interface FitBox { page: number; wPt: number; hPt: number }
export interface ChainFit { size: number; boxes: (FitBox & { lines: string[]; capacity: number })[]; overflowLines: number; /** What goes to the continued page, wrapped at the last box width. */ overflow: string[] }
/**
 * An answer flowing through its boxes in order (a box that runs to the foot of the page goes on at the top of the next one), at the
 * largest size from 10 to 8 pt that holds it all; what is left at 8 pt goes to a continued page right after the last box's page.
 */
export function fitChain(text: string, boxes: FitBox[], measure: (s: string, size: number) => number): ChainFit {
  let best: ChainFit = { size: FIT_SIZES[0], boxes: [], overflowLines: 0, overflow: [] };
  for (const size of FIT_SIZES) {
    let rest = text;
    const out: ChainFit["boxes"] = [];
    for (const b of boxes) {
      const lines = rest.trim() ? wrap(rest, Math.max(10, b.wPt - 2 * FIT_PADDING), size, measure) : [];
      const capacity = Math.max(1, Math.floor((b.hPt - 2 * FIT_PADDING) / (size * LINE_HEIGHT)));
      out.push({ ...b, lines: lines.slice(0, capacity), capacity });
      rest = lines.slice(capacity).join("\n");
    }
    const overflow = rest.trim() ? wrap(rest, Math.max(10, (boxes[boxes.length - 1]?.wPt ?? 500) - 2 * FIT_PADDING), size, measure) : [];
    best = { size, boxes: out, overflowLines: overflow.length, overflow };
    if (!overflow.length) return best;
  }
  return best;
}

export function wrap(text: string, width: number, size: number, measure: (s: string, size: number) => number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next, size) <= width || !line) {
        // a single word wider than the box is broken by characters
        if (!line && measure(word, size) > width) { let part = ""; for (const ch of word) { if (measure(part + ch, size) > width && part) { out.push(part); part = ""; } part += ch; } line = part; continue; }
        line = next;
      } else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}
