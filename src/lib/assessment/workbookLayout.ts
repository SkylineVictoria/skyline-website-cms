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
    for (const s of task.sections) {
      let n = 0;
      const prefix = s.title.match(/^(\d+\.\d+)\b/)?.[1] ?? String(ti + 1);
      for (const q of s.questions) {
        if (CONTENT_TYPES.has(q.type)) continue;
        const markable = isMarkable(q);
        const number = q.type === "declaration" ? "Student declaration" : q.type === "adjustment_record" ? "Trainer / assessor record" : `${prefix}.${++n}`;
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
