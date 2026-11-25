/**
 * ASM-REVIEW (owner, 2026-11-23): the workbook layout shared by "Export as workbook PDF" (workbookPdf.ts, pdf-lib) and the wizard's
 * Review step (ReviewDocument.tsx, HTML), so the page view, the student view and the export print the same thing: the cover rows,
 * the qualification table, the task list, the question numbering and bars ("Q3 | 2.1.3 | Satisfactory Yes / No"), the footer.
 * Runtime-neutral: no DOM (the registry test builds the PDF in Node).
 */
import type { Definition, Question, Task } from "./types";

/** Instruction / content blocks: read by the student, never numbered or marked. */
export const CONTENT_TYPES = new Set(["instruction", "content"]);

export interface WorkbookUnitInfo { code: string; name: string }

/** Cover section 1, as the workbook prints it (the values are blank in the review and the blank workbook). */
export const DETAIL_LABELS = ["Student Full Name", "Student ID", "Student Email", "Trainer Full Name"] as const;

export function qualificationRows(qual: WorkbookUnitInfo | null | undefined, unit: WorkbookUnitInfo | null | undefined): [string, string][] {
  return [["Qualification Code", qual?.code ?? ""], ["Qualification Name", qual?.name ?? ""], ["Unit Code", unit?.code ?? ""], ["Unit Name", unit?.name ?? ""]];
}

export const TASK_TABLE_HEAD = ["Evidence number", "Assessment method / Type of evidence"] as const;
export const taskRows = (definition: Definition): [string, string][] => definition.tasks.map((t, i) => [`Assessment Task - ${i + 1}`, t.title]);
export const taskHeading = (task: Task, index: number) => `Assessment Task - ${index + 1} - ${task.title}`;
/** Section headings the workbook does not print ("Instructions" sections hold the task's briefs). */
export const sectionShowsTitle = (title: string) => Boolean(title) && !/^instructions$/i.test(title);

export function footerParts(version: string | null | undefined, unit: WorkbookUnitInfo | null | undefined, page: number, total: number): [string, string, string] {
  return [`Version Number: ${version || "1.0"}`, unit ? `Unit Code: ${unit.code}` : "", `Page ${page} of ${total}`];
}

/** Marked with one Satisfactory Yes / No (the import marks per question; content and "none" are not marked). */
export const isMarkable = (q: Question) => !CONTENT_TYPES.has(q.type) && (q.markingMode ?? "criteria") !== "none";

export interface QuestionNumber {
  /** Q1, Q2 … across the whole assessment, for marked questions only. */
  seq: number | null;
  /** "1.3", "2.1.2" (a sub-task section numbers as the workbook does), or the name of a declaration / adjustment record. */
  number: string;
  markable: boolean;
}

/** The question bar of every top-level question, in reading order (content blocks are not numbered). */
export function workbookNumbering(definition: Definition): Map<string, QuestionNumber> {
  const map = new Map<string, QuestionNumber>();
  let seq = 0;
  definition.tasks.forEach((task, ti) => {
    // ASM-BUILDER-COMPACT: in an AI-read task an unprinted question takes the next number of the task that is not printed anywhere in
    // it (never "1.1" beside a printed Q1.1, never "2.1" again in every section); a parser-read task keeps per-section numbering
    const printed = new Set(task.sections.flatMap((s) => s.questions).filter((q) => q.importMeta?.via === "ai" && q.importMeta.number).map((q) => String(q.importMeta?.number)));
    const aiTask = task.sections.some((s) => s.questions.some((q) => q.importMeta?.via === "ai"));
    let taskN = 0;
    // the same printed number on several boxes / tables of one question (Q2.1.4 with two tables): 2.1.4, 2.1.4b, 2.1.4c
    const repeats = new Map<string, number>();
    const unique = (n: string) => { const c = repeats.get(n) ?? 0; repeats.set(n, c + 1); return c ? `${n}${String.fromCharCode(97 + c)}` : n; };
    for (const s of task.sections) {
      let n = 0;
      const prefix = s.title.match(/^(\d+\.\d+)\b/)?.[1] ?? String(ti + 1);
      const next = () => {
        if (!aiTask) return `${prefix}.${++n}`;
        let c: string;
        do { c = `${ti + 1}.${++taskN}`; } while (printed.has(c));
        return c;
      };
      for (const q of s.questions) {
        if (CONTENT_TYPES.has(q.type)) continue;
        const markable = isMarkable(q);
        // ASM-AI-IMPORT: a question read by the AI keeps the number printed in the workbook
        const hasPrinted = q.importMeta?.via === "ai" && q.importMeta.number && !["declaration", "adjustment_record"].includes(q.type);
        const computed = q.type === "declaration" ? "Student declaration" : q.type === "adjustment_record" ? "Trainer / assessor record" : hasPrinted ? "" : next();
        const number = q.importMeta?.via === "ai" && q.importMeta.number && !["declaration", "adjustment_record"].includes(q.type) ? unique(String(q.importMeta.number)) : computed;
        map.set(q.id, { seq: markable ? ++seq : null, number, markable });
      }
    }
  });
  return map;
}

/** Help text that only repeats the question (an imported long question keeps it whole) is not printed twice. */
export function helpRepeatsLabel(q: Question): boolean {
  if (!q.helpText) return false;
  return q.helpText.replace(/\s+/g, " ").trim().startsWith(q.label.replace(/\s+/g, " ").trim().slice(0, 60));
}

/* ------------------------------------------------------------------ ASM-COVER: the workbook's first page */

/** A4 in points; the cover is laid out in these units, y measured from the top. */
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;

export interface CoverShape { kind: "rect"; x: number; y: number; w: number; h: number; fill: string }
export interface CoverLayout {
  shapes: CoverShape[];
  /** The wave under the band: an SVG path in page points (y down), filled. */
  wave: { path: string; fill: string };
  lines: { x1: number; y1: number; x2: number; y2: number; stroke: string; width: number }[];
  /** The header picture top-left, on a white panel (the picture keeps its proportions inside the box). */
  logo: { x: number; y: number; w: number; h: number; pad: number };
  band: { text: string; y: number; size: number; color: string; spacing: number };
  title: { text: string; y: number; size: number; color: string };
  table: { x: number; y: number; w: number; labelW: number; rowH: number; rows: [string, string][]; label: string; value: string; border: string };
}

/**
 * The master workbook's cover ("STUDENT WORKBOOK"): dark slate page, the logo top-left, a grey band with the words, the wave, the unit
 * code and name in white, and the Student Name / Student ID table at the bottom (filled in on a student's export).
 */
export function coverLayout(input: { unit: WorkbookUnitInfo | null; title: string; student?: { name: string; ref: string } | null }): CoverLayout {
  const W = PAGE_W; const H = PAGE_H;
  return {
    shapes: [
      { kind: "rect", x: 0, y: 0, w: W, h: 323, fill: "#5b6979" },
      { kind: "rect", x: 0, y: 323, w: W, h: 54, fill: "#a1a7b0" },
      { kind: "rect", x: 0, y: 377, w: W, h: H - 377, fill: "#4a5767" },
    ],
    wave: { path: `M 0 475 C 110 470 190 545 300 557 C 420 570 520 505 ${W} 475 L ${W} ${H} L 0 ${H} Z`, fill: "#b1b8c0" },
    lines: [
      { x1: 0, y1: 323, x2: W, y2: 323, stroke: "#ffffff", width: 1.5 },
      { x1: 0, y1: 377, x2: W, y2: 377, stroke: "#ffffff", width: 1.5 },
      { x1: 0, y1: 595, x2: W, y2: 595, stroke: "#8f979f", width: 0.6 },
    ],
    logo: { x: 34, y: 30, w: 200, h: 58, pad: 6 },
    band: { text: "STUDENT WORKBOOK", y: 357, size: 17, color: "#1f3a5f", spacing: 3 },
    title: { text: input.unit ? `${input.unit.code} ${input.unit.name}`.trim() : input.title, y: 652, size: 15, color: "#ffffff" },
    table: { x: 43, y: 730, w: W - 86, labelW: 135, rowH: 26, rows: [["Student Name:", input.student?.name ?? ""], ["Student ID:", input.student?.ref ?? ""]], label: "#e2e5e9", value: "#f8fafc", border: "#1f2937" },
  };
}

/** Under the title on the details page: the unit line only when the title does not already say it (no "unit name" twice). */
export function titleSubline(title: string, unit: WorkbookUnitInfo | null): string | null {
  if (!unit) return null;
  const t = title.toLowerCase();
  return t.includes(unit.code.toLowerCase()) || (unit.name && t.includes(unit.name.toLowerCase())) ? null : `${unit.code} ${unit.name}`.trim();
}

/* ------------------------------------------------------------------ item 1: the information (compliance) pages */

/** The heading of the information pages (submission, plagiarism, appeals …) in the page view, the student page and the PDF. */
export const INFO_HEADING = "Assessment information";

/* ------------------------------------------------------------------ item 3: the details filled in by the system */

export interface WorkbookPerson { name: string; ref: string; email?: string | null }
export interface WorkbookDetails {
  student: WorkbookPerson | null;
  trainers: string[];
  qualification: WorkbookUnitInfo | null;
  unit: WorkbookUnitInfo | null;
}

/**
 * Who and what the workbook is for: the student and trainers from the attempt history, the qualification and unit from the history,
 * else the workbook the definition came from, else the assignment's unit. One rule for the student page, the PDF and the review.
 */
export function workbookDetails(input: {
  history?: { student: WorkbookPerson | null; trainers: string[]; assessment: { unit?: WorkbookUnitInfo | null; qualification?: WorkbookUnitInfo | null } | null } | null;
  definition?: Definition | null;
  unit?: { code: string | null; name: string | null } | null;
}): WorkbookDetails {
  const h = input.history ?? null;
  const fallbackUnit = input.unit?.code ? { code: input.unit.code, name: input.unit.name ?? "" } : null;
  return {
    student: h?.student ?? null,
    trainers: h?.trainers ?? [],
    qualification: h?.assessment?.qualification ?? input.definition?.source?.qualification ?? null,
    unit: h?.assessment?.unit ?? input.definition?.source?.unit ?? fallbackUnit,
  };
}

/** Cover section 1 with its values ("" where the system has none). */
export function detailRows(d: WorkbookDetails): [string, string][] {
  const values = [d.student?.name ?? "", d.student?.ref ?? "", d.student?.email ?? "", d.trainers.join(", ")];
  return DETAIL_LABELS.map((label, i) => [label, values[i]]);
}

/* ------------------------------------------------------------------ item 7: Appendix A – Reasonable Adjustments */

export const APPENDIX_TITLE = "Appendix A – Reasonable Adjustments";

/** What the trainer / assessor records (asm assessor responses of an adjustment_record question). */
export interface AdjustmentRecord { applied?: boolean; tasks?: string; categories?: string[]; strategies?: string[]; explanation?: string; assessorName?: string; date?: string; declared?: boolean }

/** A table cell: text, or tick boxes with labels. */
export type LayoutCell = string | { ticks: [string, boolean][] };

export interface AdjustmentLayout {
  intro: string;
  /** Applied Yes / No, task name and number, category, explanation. */
  facts: [string, LayoutCell][];
  /** The strategy matrix: every strategy of the record with its "applied" tick. */
  strategies: [string, boolean][];
  /** Name, declaration, date. */
  sign: [string, LayoutCell][];
  declaration: string;
}

export const asAdjustment = (v: unknown): AdjustmentRecord => (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as AdjustmentRecord;

/** The adjustment record as the workbook's Appendix A prints it (the same rows in the page view, on screen and in the PDF). */
export function adjustmentLayout(q: Question, value: unknown, date: (isoDay: string) => string = (d) => d): AdjustmentLayout {
  const v = asAdjustment(value);
  const used = new Set(v.strategies ?? []);
  const config = q.config ?? {};
  const list = (k: string) => (Array.isArray(config[k]) ? (config[k] as string[]) : []);
  return {
    intro: typeof config.intro === "string" ? config.intro : "",
    facts: [
      ["Reasonable adjustments applied", { ticks: [["Yes", v.applied === true], ["No", v.applied === false]] }],
      ["Task name and number", v.tasks ?? ""],
      ["Category", (v.categories ?? []).join(", ")],
      ["Explanation", v.explanation ?? ""],
    ],
    strategies: list("strategies").map((s) => [s, used.has(s)]),
    sign: [
      ["Trainer/Assessor Name", v.assessorName ?? ""],
      ["Trainer/Assessor Declaration", { ticks: [[v.declared ? "Declared" : "Not declared", Boolean(v.declared)]] }],
      ["Date", v.date ? date(v.date) : ""],
    ],
    declaration: typeof config.declaration === "string" ? config.declaration : "",
  };
}

/* ------------------------------------------------------------------ HTML content as printable blocks */

export type HtmlBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "item"; text: string; marker: string }
  | { kind: "table"; rows: string[][]; head: boolean }
  | { kind: "image"; src: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•" };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const inline = (s: string) => decode(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();

/**
 * The imported / edited HTML of an instruction block or the information pages as blocks the PDF can print: headings, paragraphs,
 * list items, tables and pictures (data: URLs). Plain text (no tags) is one paragraph per line.
 */
export function htmlToBlocks(html: string): HtmlBlock[] {
  if (!/^\s*</.test(html)) return html.split(/\n{1,}/).map((t) => t.trim()).filter(Boolean).map((text) => ({ kind: "para" as const, text }));
  const out: HtmlBlock[] = [];
  const src = html.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  // top-level pieces: tables and pictures are kept whole, the rest is split on block tags
  const re = /<table\b[\s\S]*?<\/table>|<img\b[^>]*>/gi;
  let at = 0;
  const flow = (chunk: string) => {
    let ordered = 0;
    const marked = chunk
      .replace(/<ol\b[^>]*>/gi, "\u0001OL\u0001").replace(/<\/ol>/gi, "\u0001/OL\u0001")
      .replace(/<ul\b[^>]*>/gi, "\u0001UL\u0001").replace(/<\/ul>/gi, "\u0001/UL\u0001")
      .replace(/<li\b[^>]*>/gi, "\u0001LI\u0001").replace(/<h[1-6]\b[^>]*>/gi, "\u0001H\u0001")
      .replace(/<\/(p|div|li|h[1-6]|figure|figcaption|blockquote)>|<(p|div|blockquote|figure)\b[^>]*>/gi, "\u0001BR\u0001");
    let inOl = false; let heading = false; let item = false;
    for (const part of marked.split("\u0001")) {
      if (part === "OL") { inOl = true; ordered = 0; continue; }
      if (part === "/OL" || part === "UL" || part === "/UL") { inOl = false; continue; }
      if (part === "LI") { item = true; continue; }
      if (part === "H") { heading = true; continue; }
      if (part === "BR") { item = false; heading = false; continue; }
      const text = inline(part);
      if (!text) continue;
      if (heading) out.push({ kind: "heading", text });
      else if (item) out.push({ kind: "item", text, marker: inOl ? `${++ordered}.` : "•" });
      else for (const line of text.split("\n")) if (line.trim()) out.push({ kind: "para", text: line.trim() });
      item = false; heading = false;
    }
  };
  for (const m of src.matchAll(re)) {
    flow(src.slice(at, m.index));
    at = (m.index ?? 0) + m[0].length;
    if (/^<img/i.test(m[0])) {
      const s = m[0].match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i);
      const url = s?.[2] ?? s?.[3] ?? "";
      if (url) out.push({ kind: "image", src: url });
      continue;
    }
    const rows: string[][] = [];
    let head = false;
    for (const tr of m[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)];
      if (!rows.length && cells.length && cells.every((c) => c[1].toLowerCase() === "th")) head = true;
      rows.push(cells.map((c) => inline(c[2])));
    }
    if (rows.length) out.push({ kind: "table", rows, head });
  }
  flow(src.slice(at));
  return out;
}
