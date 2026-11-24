/**
 * ASM-IMPORT: builds a DRAFT assessment definition from an uploaded Word or PDF workbook (runtime-neutral, no React, no DOM).
 *
 * Two readers produce one stream of lines:
 *  - `linesFromPdf(doc)`: pdfjs text with positions (font size, x, y, the gap below each line); repeated headers / footers and
 *    "Page x of y" are removed by frequency across pages.
 *  - `linesFromDocxHtml(html)`: mammoth's HTML (real headings, paragraphs, lists and table rows).
 * `buildFromLines(lines)` maps the stream onto tasks > sections > questions:
 *  "Assessment Task N" -> task; "Task N.M ..." / "Occasion N" / the question number's prefix -> section; a question header
 *  ("Q3 | Q2.1.3 | Satisfactory") or a numbered question -> question; lettered items, "Short answer" boxes and form labels -> fields
 *  (several fields = a case study with children); fill-in tables -> table_grid; tick boxes / Yes-No columns -> choice / true_false;
 *  "attach / upload / photo / screenshot / provide evidence" -> allowAttachment (file_upload when there is no text box);
 *  role-play briefs and "observed by your assessor" lists -> observation_checklist; the student declaration -> declaration;
 *  instructions -> instruction blocks. Cover pages, the marking checklist, results sheets, the outcome table, appendices and the
 *  evaluation form are skipped. Model / benchmark answers and assessor guidance go into `keys` (asm_question_keys), never into the
 *  definition (DECISIONS.md D-05). Every question carries `importMeta` (source page, confidence, note) for the admin's review.
 */
import { ADJUSTMENT_CATEGORIES, ADJUSTMENT_DECLARATION, ADJUSTMENT_STRATEGIES, newId, withSchema } from "./registry";
import type { Definition, ImportMeta, Question, QuestionKey, Section, Task } from "./types";

export interface WbCell { x: number; text: string; /** PDF: the width of the cell text. */ w?: number }
export interface WbLine {
  page: number | null;
  /** Baseline from the bottom of the page (PDF) or a running index (Word). */
  y: number;
  x: number;
  size: number;
  cells: WbCell[];
  text: string;
  /** Distance to the next line on the same page (PDF) or blank space after the paragraph (Word, in points). */
  gapBelow: number;
  /** Word heading level (1-6). */
  heading?: number;
  bold?: boolean;
  listNumber?: number | null;
  table?: { id: number; row: number; header: boolean };
}

/**
 * A picture in the workbook (a drawing, a site plan), in PDF points from the bottom of its page (`top` > `bottom`). `src` is filled
 * in by the browser (the page region rendered to a JPEG data URL); the parser only needs the place to put it in the instructions.
 */
export interface WbImage { page: number; x: number; top: number; bottom: number; width: number; height: number; src: string }

export interface ImportResult {
  title: string;
  /** "Version Number: 1.0" from the workbook's footer. */
  version: string | null;
  unitCode: string | null;
  /** Read from the workbook's details table ("Qualification Code | RII50520", "Unit Name | …") or its cover. */
  qualification: { code: string; name: string } | null;
  unit: { code: string; name: string } | null;
  assessorVersion: boolean;
  definition: Definition;
  keys: QuestionKey[];
  stats: { tasks: number; sections: number; questions: number; topLevelQuestions: number; byType: Record<string, number>; lowConfidence: number; attachments: number; keys: number; tables: number; images: number; infoSections: number; adjustmentRecord: boolean };
  warnings: string[];
}

/* ------------------------------------------------------------------ PDF reader */

interface PdfTextItem { str: string; transform: number[]; width: number; height: number }
interface PdfPageLike { getViewport: (o: { scale: number }) => { width: number; height: number }; getTextContent: () => Promise<{ items: unknown[] }> }
export interface PdfDocLike { numPages: number; getPage: (n: number) => Promise<PdfPageLike> }

/** Lines of a pdfjs document (text layer); `textChars` tells whether the PDF has a text layer at all; `version` is the footer's. */
export async function linesFromPdf(doc: PdfDocLike): Promise<{ lines: WbLine[]; pages: number; textChars: number; version: string | null }> {
  const perPage: { lines: WbLine[]; height: number }[] = [];
  let textChars = 0;
  let version: string | null = null;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = (tc.items as PdfTextItem[]).filter((i) => typeof i.str === "string" && i.str.trim() !== "");
    textChars += items.reduce((n, i) => n + i.str.trim().length, 0);
    // group by baseline (±2.5 pt)
    const rows: { y: number; items: PdfTextItem[] }[] = [];
    for (const it of items.slice().sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
      const y = it.transform[5];
      const row = rows.find((r) => Math.abs(r.y - y) <= 2.5);
      if (row) row.items.push(it); else rows.push({ y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines: WbLine[] = rows.map((r) => {
      const its = r.items.sort((a, b) => a.transform[4] - b.transform[4]);
      const size = Math.round(Math.max(...its.map((i) => Math.abs(i.height) || Math.abs(i.transform[3]) || 10)));
      const cells: WbCell[] = [];
      let prevEnd = -Infinity;
      for (const it of its) {
        const x = it.transform[4];
        const gap = x - prevEnd;
        const last = cells[cells.length - 1];
        if (last && gap <= Math.max(8, size * 0.9)) last.text += (gap > size * 0.12 && !/\s$/.test(last.text) && !/^\s/.test(it.str) ? " " : "") + it.str;
        else cells.push({ x, text: it.str });
        prevEnd = x + (it.width || it.str.length * size * 0.5);
        cells[cells.length - 1].w = prevEnd - cells[cells.length - 1].x;
      }
      for (const c of cells) c.text = clean(c.text);
      const kept = cells.filter((c) => c.text !== "");
      return { page: p, y: Math.round(r.y), x: Math.round(kept[0]?.x ?? 0), size, cells: kept.map((c) => ({ x: Math.round(c.x), text: c.text, w: Math.round(c.w ?? 0) })), text: kept.map((c) => c.text).join(" "), gapBelow: 0 };
    }).filter((l) => l.text !== "");
    version ??= lines.map((l) => l.text.match(VERSION_RE)?.[1]).find(Boolean) ?? null;
    perPage.push({ lines, height: vp.height });
  }
  // repeated headers / footers: the same text (digits ignored) in the top or bottom band of many pages
  const band = (l: WbLine, h: number) => l.y > h - 110 || l.y < 60;
  const keyOf = (l: WbLine) => l.text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const count = new Map<string, number>();
  perPage.forEach((pg) => { const seen = new Set<string>(); pg.lines.filter((l) => band(l, pg.height)).forEach((l) => { const k = keyOf(l); if (!seen.has(k)) { seen.add(k); count.set(k, (count.get(k) ?? 0) + 1); } }); });
  const threshold = Math.max(3, Math.floor(perPage.length * 0.3));
  const out: WbLine[] = [];
  const keptPages = perPage.map((pg) => ({ height: pg.height, lines: pg.lines.filter((l) => !(band(l, pg.height) && (count.get(keyOf(l)) ?? 0) >= threshold) && !PAGE_X_OF_Y.test(l.text)) }));
  keptPages.forEach((pg, pi) => {
    const kept = pg.lines;
    kept.forEach((l, i) => {
      if (i + 1 < kept.length) { l.gapBelow = l.y - kept[i + 1].y; return; }
      // the last line of a page: its box runs to the bottom margin and on to the first line of the next page
      const next = keptPages[pi + 1];
      const top = next ? next.height * 0.83 - (next.lines[0]?.y ?? next.height * 0.83) : 0;
      l.gapBelow = Math.max(0, l.y - 50) + Math.max(0, top);
    });
    out.push(...kept);
  });
  return { lines: out, pages: perPage.length, textChars, version };
}

const RA_RE = /reasonable\s+adjust/i;
const INFO_SKIP_RE = /student\s+and\s+trainer\s+details|qualification\s+and\s+unit|^assessment\s+tasks$|instructions\s+to\s+complete\s+the\s+outcomes/i;
const EVIDENCE_COL_RE = /^evidence\s+(to\s+(submit|be\s+submitted)|required)$/i;
const VERSION_RE = /\bversion(?:\s+number)?\s*[:\-–]?\s*(\d+(?:\.\d+)*)\b/i;

/** The pdf.js operator codes the picture finder needs (`pdfjs.OPS`). */
export interface PdfOps { save: number; restore: number; transform: number; paintImageXObject: number; paintInlineImageXObject: number; paintImageMaskXObject?: number }
interface PdfPageOps { getViewport: (o: { scale: number }) => { width: number; height: number }; getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }> }

/**
 * The pictures of a PDF workbook (drawings, plans, photos), as page regions. A picture drawn at the same place on many pages (the
 * header logo and banner) and anything smaller than `minSize` points are left out. Nothing is decoded here: the browser renders
 * each region to an image (workbookFile.ts), the parser places it in the instructions by its position.
 */
export async function imageRegionsFromPdf(doc: { numPages: number; getPage: (n: number) => Promise<unknown> }, ops: PdfOps, minSize = 80): Promise<Omit<WbImage, "src">[]> {
  const mul = (a: number[], b: number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const found: Omit<WbImage, "src">[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = (await doc.getPage(p)) as PdfPageOps;
    if (typeof page.getOperatorList !== "function") continue;
    const list = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0]; const stack: number[][] = [];
    list.fnArray.forEach((fn, i) => {
      const args = list.argsArray[i] as number[];
      if (fn === ops.save) stack.push(ctm);
      else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
      else if (fn === ops.transform) ctm = mul(ctm, args);
      else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) {
        const width = Math.abs(ctm[0]) + Math.abs(ctm[2]); const height = Math.abs(ctm[1]) + Math.abs(ctm[3]);
        const x = Math.min(ctm[4], ctm[4] + ctm[0] + ctm[2]); const bottom = Math.min(ctm[5], ctm[5] + ctm[1] + ctm[3]);
        found.push({ page: p, x: Math.round(x), bottom: Math.round(bottom), top: Math.round(bottom + height), width: Math.round(width), height: Math.round(height) });
      }
    });
  }
  // repeated at the same place (logo, banner): on at least 3 pages and 30 % of them
  const keyOf = (r: Omit<WbImage, "src">) => `${Math.round(r.x / 4)}|${Math.round(r.bottom / 4)}|${Math.round(r.width / 4)}|${Math.round(r.height / 4)}`;
  const pagesOf = new Map<string, Set<number>>();
  for (const r of found) { const k = keyOf(r); if (!pagesOf.has(k)) pagesOf.set(k, new Set()); pagesOf.get(k)!.add(r.page); }
  const threshold = Math.max(3, Math.floor(doc.numPages * 0.3));
  return found.filter((r) => (pagesOf.get(keyOf(r))?.size ?? 0) < threshold && r.width >= minSize && r.height >= minSize);
}

/* ------------------------------------------------------------------ Word reader (mammoth HTML, no DOM needed) */

const decode = (s: string) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** Lines of mammoth's HTML (convertToHtml with ignoreEmptyParagraphs: false, so empty paragraphs show the answer space). */
export function linesFromDocxHtml(html: string): WbLine[] {
  const out: WbLine[] = [];
  let y = 0; let tableId = 0;
  const push = (l: Omit<WbLine, "y" | "gapBelow" | "page" | "x"> & { x?: number }) => { y += 1; out.push({ page: null, y, x: l.x ?? 0, gapBelow: 0, ...l }); };
  // tokens: block elements in document order (tables handled as a whole)
  const re = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  const listCounters: number[] = [];
  const olStarts = [...html.matchAll(/<(\/?)(ol|ul)\b[^>]*>/gi)].map((x) => ({ at: x.index ?? 0, close: x[1] === "/", ordered: x[2].toLowerCase() === "ol" }));
  const listAt = (at: number) => { // the innermost list kind at a position, and the item index in it
    const stack: { ordered: boolean; start: number }[] = [];
    for (const t of olStarts) { if (t.at > at) break; if (t.close) stack.pop(); else stack.push({ ordered: t.ordered, start: t.at }); }
    return stack[stack.length - 1] ?? null;
  };
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase(); const inner = m[2];
    if (tag === "table") {
      tableId += 1; let row = 0;
      for (const tr of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...tr[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c, i) => ({ x: i * 100, text: clean(decode(c[2].replace(/<\/p>\s*<p[^>]*>/gi, "\n"))), header: c[1].toLowerCase() === "th" }));
        const nonEmpty = cells.filter((c) => c.text !== "");
        push({ size: 11, cells: cells.map((c) => ({ x: c.x, text: c.text })), text: nonEmpty.map((c) => c.text).join(" "), table: { id: tableId, row, header: row === 0 || cells.every((c) => c.header) }, bold: false });
        row += 1;
      }
      continue;
    }
    const text = clean(decode(inner));
    const bold = /^\s*<strong>[\s\S]*<\/strong>\s*$/i.test(inner);
    if (tag.startsWith("h")) { push({ size: 20 - Number(tag[1]) * 2, heading: Number(tag[1]), cells: [{ x: 0, text }], text, bold: true }); continue; }
    if (tag === "li") {
      const list = listAt(m.index);
      const depthKey = list?.start ?? -1;
      listCounters[depthKey] = (listCounters[depthKey] ?? 0) + 1;
      push({ size: 11, cells: [{ x: 20, text }], text, x: 20, listNumber: list?.ordered ? listCounters[depthKey] : null, bold });
      continue;
    }
    if (text === "") { if (out.length) out[out.length - 1].gapBelow += 20; continue; } // a blank line of answer space
    push({ size: 11, cells: [{ x: 0, text }], text, bold });
  }
  for (const l of out) if (!l.gapBelow) l.gapBelow = 14;
  return out;
}

/* ------------------------------------------------------------------ patterns */

const PAGE_X_OF_Y = /\bpage\s*\d+\s*(of|\/)\s*\d+\b/i;
// pdf.js gives tick-box glyphs as NUL; Postgres refuses NUL in jsonb, so a leading one becomes a box and the rest are dropped
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/^\u0000+\s*/, "☐ ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/g, "").replace(/[  -​]/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const TASK_RE = /^(?:assessment\s+)?task\s*[-–—]?\s*(\d+)(?!\s*\.\s*\d)\s*[-–—:.]?\s*(.*)$/i;
const SUBTASK_RE = /^(?:assessment\s+)?task\s*(\d+)\.(\d+)\s*[-–—:.]?\s*(.*)$/i;
const OCCASION_RE = /\boccasion\s*(\d+)\b/i;
const SKIP_HEADING_RE = /^(assessment\s+marking\s+checklist|marking\s+(checklist|guide)|written\s+evidence\s+checklist|evidence\s+submission\s+checklist|assessment\s+task\s*[-–—]?\s*\d+\s*[-–—:]\s*results?\s+sheet|results?\s+sheet|assessment\s+outcome|unit\s+outcome|competency\s+outcome|record\s+of\s+(assessment\s+)?outcome|appendix\b.*|learner\s+evaluation(\s+form)?|student\s+evaluation(\s+form)?|evaluation\s+form|reasonable\s+adjustments?(\s+strateg.*)?|office\s+use\s+only.*|assessor\s+(declaration|feedback|use\s+only).*)$/i;
const APPENDIX_RE = /^(appendix\b|learner\s+evaluation|student\s+evaluation|evaluation\s+form|reasonable\s+adjust)/i;
const DECLARATION_RE = /^(student'?s?\s+)?declaration:?$/i;
const PLACEHOLDER_RE = /^(short|long)\s+answer\.?$|^click or tap here to enter text\.?$|^(type|enter|write)\s+(your\s+)?(answer|response)\s+here\.?$|^_{4,}$|^\.{6,}$/i;
const ITEM_RE = /^(\(?[a-z]\)|[a-z]\.|[a-z]\))\s+(.+)$/i;
const ROMAN_RE = /^\(?(i{1,3}|iv|v|vi{1,3}|ix|x)[.)]\s+(.+)$/i;
const FORM_LABEL_RE = /^(project(\s+(title|name))?|location|prepared\s+by|date|subject|approved\s+by|reviewed\s+by|validated\s+by|checked\s+by|student\s+name|name|signature|site|client|position|role|time|venue|company|organisation|organization|job\s+title|to|from|cc|re|attention)\s*:?$/i;
/** Pre-filled memo lines in the question text ("To: Senior Engineer"): an example, shown as help text, never part of the question. */
const MEMO_RE = /^(to|from|cc|re|subject|attention|date)\s*:\s*\S/i;
const MARK_WORD_RE = /^(response|satisfactory|yes|no|s|ns|nys|y|n|comments?|submitted)$/i;
const TICK_RE = /^[☐☑☒□■❏❑]\s*|^\[\s?[x✓]?\s?\]\s*/i;
const MODEL_RE = /^(model|benchmark|suggested|expected|sample|correct|ideal)\s+(answer|response|solution)s?\b\s*[:\-–]?\s*(.*)$/i;
const ANSWER_GUIDE_RE = /^answer\s*(key|guide)?\s*[:\-–]\s*(.*)$/i;
const GUIDANCE_RE = /^(assessor|marking|trainer)\s+(guidance|guide|notes?|instructions?)\b\s*[:\-–]?\s*(.*)$/i;
const ATTACH_RE = /\b(attach(ed|ment)?|upload(ed)?|photo(graph)?s?|screen\s?shots?|scan(ned)?\s+cop(y|ies)|provide\s+(supporting\s+)?evidence|evidence\s+of\s+(your|the)|submit\s+(a\s+)?(copy|photo|file))\b/i;
const QUESTION_VERB_RE = /^(describe|explain|identify|list|outline|provide|discuss|define|compare|calculate|complete|name|state|give|what|why|how|which|when|where|who|summari[sz]e|evaluate|analy[sz]e|prepare|develop|write|research|determine|select|justify|demonstrate|recommend|choose|match|tick|circle|draw|record|review|attach|upload|take|submit|photograph)\b/i;
const ROLEPLAY_RE = /\brole[-\s]?play\b/i;
const OBSERVE_LIST_RE = /(assessment\s+focus|observed\s+by\s+your\s+assessor|assessor\s+will\s+(observe|assess)|will\s+assess\s+your|observation\s+criteria|performance\s+criteria)/i;
const UNIT_RE = /\b([A-Z]{3,6}\d{3,4}[A-Z]?)\b/;
const ASSESSOR_DOC_RE = /\b(assessor\s+(pack|version|guide|copy|marking\s+guide|workbook)|marking\s+guide|benchmark\s+answers?|model\s+answers?|answer\s+(key|guide))\b/i;
const QA_HEADER_Q_RE = /^(question|questions|task|activity)s?$/i;
const QA_HEADER_MODEL_RE = /(model|benchmark|suggested|expected|sample)\s+(answer|response)|answer\s+guide|assessor\s+guid|marking\s+guide/i;
const QA_HEADER_STUDENT_RE = /^(student('?s)?\s+)?(answer|response)s?$|^your\s+(answer|response)$/i;

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const onlyMarkWords = (l: WbLine) => l.cells.length > 0 && l.cells.every((c) => MARK_WORD_RE.test(c.text));
const isHeadingLine = (l: WbLine, pdfBody: number) => (l.heading ? true : l.page !== null ? l.size >= pdfBody + 3 : Boolean(l.bold) && words(l.text) <= 14);

/* ------------------------------------------------------------------ the mapper */

interface Field {
  kind: "text" | "table" | "choice" | "tf" | "info";
  label: string;
  page: number | null;
  box: number;
  form?: boolean;
  date?: boolean;
  columns?: string[];
  rowLabels?: string[];
  options?: string[];
  single?: boolean;
  model?: string[];
  guidance?: string[];
  low?: string;
  /** The label was followed by a real answer box ("Short answer" etc.). */
  hasBox?: boolean;
  /** Sample text printed in the answer area ("Selected Option: AC10 Asphalt"): placeholder / help text, not the label. */
  example?: string;
}
interface QBlock { number: string | null; name: string | null; page: number | null; lines: WbLine[]; templateHeader: boolean }
interface SecState { key: string; title: string; section: Section; intro: WbLine[]; introPage: number | null; carried: boolean; carryNote?: string }
interface TaskState { n: number; task: Task; sections: SecState[]; instructionsKey: string; declaration: string | null; declarationPage: number | null; wantsUploads: boolean; uploadPage: number | null; uploadNote: string }

export function buildFromLines(lines: WbLine[], opts: { fileName?: string; images?: WbImage[]; version?: string | null } = {}): ImportResult {
  const warnings: string[] = [];
  // the workbook's pictures, in reading order; each instruction block takes the ones that sit among its lines
  const pics: PicPool = { list: (opts.images ?? []).filter((im) => im.src).slice().sort((a, b) => a.page - b.page || b.top - a.top), used: new Set() };
  const keys = new Map<string, QuestionKey>();
  const bodySize = mode(lines.filter((l) => l.page !== null).map((l) => l.size)) ?? 11;
  const firstPages = lines.filter((l) => (l.page ?? 0) <= 2 || (l.page === null && l.y < 40)).map((l) => l.text).join("\n");
  const allHeads = lines.filter((l) => l.heading || (l.page !== null && l.size >= bodySize + 3)).map((l) => l.text).join("\n");
  const assessorVersion = ASSESSOR_DOC_RE.test(firstPages) || ASSESSOR_DOC_RE.test(allHeads) || lines.some((l) => l.table?.header && l.cells.some((c) => QA_HEADER_MODEL_RE.test(c.text)));
  const templateMode = lines.some((l) => templateQHeader(l) !== null);

  // title and unit from the cover (largest lines of the first page / first heading)
  const cover = lines.filter((l) => l.page === 1 || (l.page === null && l.y < 15));
  const unitLine = cover.find((l) => UNIT_RE.test(l.text) && l.size >= bodySize + 2) ?? cover.find((l) => UNIT_RE.test(l.text)) ?? lines.find((l) => UNIT_RE.test(l.text));
  // the details table ("Qualification Code | RII50520"): a label cell and its value, in a table row or as "Label: value"
  const detail = (label: RegExp): string => {
    for (const l of lines) {
      const ci = l.cells.findIndex((c) => label.test(c.text.replace(/:$/, "").trim()));
      if (ci >= 0 && l.cells[ci + 1]?.text) return l.cells[ci + 1].text.trim();
      const m = l.text.match(new RegExp(`^${label.source.replace(/^\^|\$$/g, "")}\\s*[:\\-–]\\s*(.+)$`, "i"));
      if (m && l.cells.length === 1) return m[m.length - 1].trim();
    }
    return "";
  };
  const qualCodeRaw = detail(/^(qualification|course|program(me)?)\s+code$/i) || (lines.slice(0, 400).map((l) => l.text.match(/\b([A-Z]{3}\d{5})\b/)?.[1]).find(Boolean) ?? "");
  const qualName = detail(/^(qualification|course|program(me)?)\s+(name|title)$/i);
  const unitCodeRaw = detail(/^unit\s+(of\s+competency\s+)?code$/i);
  const unitName = detail(/^unit\s+(of\s+competency\s+)?(name|title)$/i);
  const unitCode = unitCodeRaw.match(UNIT_RE)?.[1] ?? unitLine?.text.match(UNIT_RE)?.[1] ?? null;
  const qualCode = qualCodeRaw.match(/\b([A-Z]{3}\d{5})\b/)?.[1] ?? null;
  const unitNameFromCover = unitLine && unitCode ? unitLine.text.replace(unitCode, "").replace(/^[\s\-–:]+/, "").trim() : "";
  const qualification = qualCode ? { code: qualCode, name: qualName } : null;
  const unitInfo = unitCode ? { code: unitCode, name: unitName || unitNameFromCover } : null;
  const title = (unitLine && unitLine.text.length <= 120 ? unitLine.text : cover.slice().sort((a, b) => b.size - a.size)[0]?.text) || (opts.fileName ?? "Imported assessment").replace(/\.[a-z]+$/i, "");

  const tasks: TaskState[] = [];
  let cur: TaskState | null = null;
  let sec: SecState | null = null;
  let mode_: "front" | "intro" | "question" | "skip" = "front";
  let skipKind: "outcome" | "appendix" = "outcome";
  let block: QBlock | null = null;
  let lastTaskHeading: WbLine | null = null;
  let declCapture: { lines: string[]; page: number | null } | null = null;
  let carry: { lines: WbLine[]; from: string } | null = null;
  const questionsOut: { sec: SecState; q: Question }[] = [];
  /** Lines before the first task (cover, details, the numbered information sections). */
  const front: WbLine[] = [];
  /** Appendix A – Reasonable Adjustments, captured while the appendix is skipped. */
  let ra: { lines: WbLine[]; page: number | null; done: boolean } | null = null;

  const getSection = (t: TaskState, key: string, title: string): SecState => {
    let s = t.sections.find((x) => x.key === key);
    if (!s) { s = { key, title, section: { id: newId("s"), title, questions: [] }, intro: [], introPage: null, carried: false }; t.sections.push(s); }
    return s;
  };
  const startTask = (n: number, rawTitle: string, line: WbLine) => {
    flushBlock();
    const titleClean = rawTitle.replace(/^assessment\s+task\s*\d+\s*[-–—:]\s*/i, "").trim() || `Task ${n}`;
    cur = tasks.find((t) => t.n === n) ?? null;
    if (!cur) {
      cur = { n, task: { id: newId("t"), title: titleClean, instructions: "", sections: [] }, sections: [], instructionsKey: "intro", declaration: null, declarationPage: null, wantsUploads: false, uploadPage: null, uploadNote: "" };
      tasks.push(cur);
    }
    sec = getSection(cur, "intro", "Instructions");
    mode_ = "intro"; lastTaskHeading = line;
  };
  const flushDecl = () => {
    if (declCapture && cur && !cur.declaration) {
      const text = declCapture.lines.join("\n").trim();
      if (text) { cur.declaration = text; cur.declarationPage = declCapture.page; }
    }
    declCapture = null;
  };
  const flushBlock = () => {
    if (!block || !cur || !sec) { block = null; return; }
    const b = block; block = null;
    const built = buildQuestion(b, cur, sec);
    if (!built) return;
    for (const q of built.questions) { sec.section.questions.push(q); questionsOut.push({ sec, q }); }
    if (built.trailing.length) carry = { lines: built.trailing, from: b.number ?? b.name ?? "the previous question" };
  };

  const buildQuestion = (b: QBlock, t: TaskState, s: SecState): { questions: Question[]; trailing: WbLine[] } | null => {
    const body = b.lines.filter((l) => !onlyMarkWords(l));
    const labelLines: WbLine[] = []; const fields: Field[] = []; const extra: WbLine[] = []; const samples: string[] = [];
    /** Lines since the last field that belong to no field: kept as help text, or (after the last field) handed on as a brief. */
    let loose: WbLine[] = [];
    let pending: WbLine[] = [];
    let keyTarget: { field: Field | null; kind: "model" | "guidance" } | null = null;
    const qModel: string[] = []; const qGuidance: string[] = [];
    let i = 0;
    const lastLine = (ls: WbLine[]) => ls[ls.length - 1];
    const addField = (f: Field) => { if (loose.length) { extra.push(...loose); loose = []; } fields.push(f); };
    const pendingToField = (box?: number) => {
      if (!pending.length) return;
      const label = pending.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
      const p = pending[0];
      const looksLabel = /:$/.test(label) || words(label) <= 10 || FORM_LABEL_RE.test(label);
      // "Selected Option: AC10 Asphalt": the label is the part before the colon, the rest is the template's sample answer
      const sample = !/:$/.test(label) ? label.match(/^([^:]{2,40}):\s+(\S.*)$/) : null;
      const fieldLabel = sample && words(sample[1]) <= 5 ? sample[1].trim() : label.replace(/:$/, "");
      const example = sample && words(sample[1]) <= 5 ? sample[2].trim() : undefined;
      if (box !== undefined || looksLabel) addField({ kind: "text", label: fieldLabel, page: p.page, box: box ?? lastLine(pending).gapBelow, form: FORM_LABEL_RE.test(fieldLabel), date: /\bdate\b/i.test(fieldLabel) && words(fieldLabel) <= 3, hasBox: box !== undefined, example });
      else loose.push(...pending);
      pending = [];
    };
    const listRow = (l: WbLine) => l.cells.length >= 2 && /^(\d{1,2}|[a-z]|[ivx]{1,4})[.)]$|^[•·•]$/i.test(l.cells[0].text);
    while (i < body.length) {
      const l0 = body[i];
      const l = listRow(l0) ? { ...l0, cells: [{ x: l0.x, text: l0.text }] } : l0;
      const text = l.text;
      // assessor-only content (model answers, guidance) -> keys
      const mm = text.match(MODEL_RE) ?? text.match(ANSWER_GUIDE_RE); const gm = text.match(GUIDANCE_RE);
      if (mm || gm) {
        pendingToField();
        const rest = (mm ? mm[mm.length - 1] : gm![3]) ?? "";
        keyTarget = { field: fields.length ? fields[fields.length - 1] : null, kind: mm ? "model" : "guidance" };
        const arr = keyTarget.field ? (keyTarget.kind === "model" ? (keyTarget.field.model ??= []) : (keyTarget.field.guidance ??= [])) : keyTarget.kind === "model" ? qModel : qGuidance;
        if (rest.trim()) arr.push(rest.trim());
        i += 1; continue;
      }
      const isStructural = PLACEHOLDER_RE.test(text) || ITEM_RE.test(text) || FORM_LABEL_RE.test(text) || l.cells.length >= 2 || TICK_RE.test(text);
      if (keyTarget && !isStructural) {
        const arr = keyTarget.field ? (keyTarget.kind === "model" ? keyTarget.field.model! : keyTarget.field.guidance!) : keyTarget.kind === "model" ? qModel : qGuidance;
        arr.push(text); i += 1; continue;
      }
      keyTarget = null;
      if (PLACEHOLDER_RE.test(text)) {
        if (pending.length) pendingToField(l.gapBelow + 12);
        else { const f = fields[fields.length - 1]; if (f && f.kind === "text" && !f.form && !loose.length) f.box = Math.max(f.box, l.gapBelow + 12); else addField({ kind: "text", label: "", page: l.page, box: l.gapBelow + 12 }); }
        i += 1; continue;
      }
      const item = text.match(ITEM_RE);
      const roman = text.match(ROMAN_RE);
      const prevItem = fields[fields.length - 1];
      if (roman && prevItem && prevItem.kind === "text" && /:$/.test(prevItem.label)) { prevItem.label += ` ${roman[0]}`; i += 1; continue; }
      if (item) { pendingToField(); addField({ kind: "text", label: text, page: l.page, box: l.gapBelow }); i += 1; continue; }
      if (TICK_RE.test(text)) {
        pendingToField();
        const opts: string[] = [];
        while (i < body.length && TICK_RE.test(body[i].text)) { opts.push(body[i].text.replace(TICK_RE, "").trim()); i += 1; }
        const ctx = (labelLines.map((x) => x.text).join(" ") + " " + (fields[fields.length - 1]?.label ?? "")).toLowerCase();
        addField({ kind: "choice", label: "", page: l.page, box: 0, options: opts.filter(Boolean), single: /(select|tick|choose|circle)\s+(one|the\s+correct|the\s+best)/.test(ctx) || opts.length === 2 });
        continue;
      }
      // a statement with Yes / No (or True / False) columns for the student
      const tf = l.cells.length >= 3 && /^(yes|true)$/i.test(l.cells[l.cells.length - 2].text) && /^(no|false)$/i.test(l.cells[l.cells.length - 1].text);
      if (tf && !/satisfactory/i.test(text)) { pendingToField(); addField({ kind: "tf", label: l.cells.slice(0, -2).map((c) => c.text).join(" "), page: l.page, box: 0 }); i += 1; continue; }
      // tables: a header of one or more lines close together (cells wrap onto extra lines), then its rows
      if (l.cells.length >= 2 && (labelLines.length || fields.length || pending.length)) {
        const group: WbLine[] = [l];
        const near = (a: WbLine, c: WbLine) => a.page === c.page && Math.abs(a.y - c.y) <= l.size * 1.5 && a.size === l.size;
        if (l.page !== null) {
          // header words wrapped above the first multi-cell line ("Comments /", "Suitability")
          for (const pool of [pending, loose, labelLines]) {
            while (pool.length && near(lastLine(pool), group[0]) && lastLine(pool).x > l.x + 40) group.unshift(pool.pop()!);
          }
        }
        let j = i + 1;
        while (j < body.length && (l.page === null ? body[j].table?.id === l.table?.id && body[j].table?.header : near(body[j], group[group.length - 1]) && !PLACEHOLDER_RE.test(body[j].text))) { group.push(body[j]); j += 1; }
        const cols = l.page === null ? l.cells.map((c) => ({ x: c.x, text: c.text })) : columnsOf(group);
        const secondX = cols[1]?.x ?? (cols[0]?.x ?? 0) + 60;
        // rows: text in the first column only = row labels; text further right = a reference table
        const bodyRows: WbLine[] = [];
        while (j < body.length) {
          const n = body[j];
          if (l.page === null) { if (n.table?.id !== l.table?.id) break; }
          else if (PLACEHOLDER_RE.test(n.text) || ITEM_RE.test(n.text) || n.size < l.size - 1 || n.page !== l.page || (FORM_LABEL_RE.test(n.text) && n.x >= secondX - 20) || (body[j + 1] && PLACEHOLDER_RE.test(body[j + 1].text))) break;
          bodyRows.push(n); j += 1;
        }
        const infoRows = bodyRows.filter((r) => r.cells.some((c, ci) => (l.page === null ? ci > 0 : c.x >= secondX - 20) && c.text !== ""));
        if (infoRows.length >= 1 && infoRows.length >= bodyRows.length / 2) {
          pendingToField();
          if (fields.length) loose.push(...group, ...bodyRows); else extra.push(...group, ...bodyRows);
          i = j; continue;
        }
        let tableLabel = pending.length ? pending.map((x) => x.text).join(" ").replace(/:$/, "") : "";
        pending = [];
        // "A. Stakeholder Feedback Summary" right above the table names it
        const prevF = fields[fields.length - 1];
        if (!tableLabel && prevF && prevF.kind === "text" && !prevF.form && !prevF.hasBox && !loose.length) { fields.pop(); tableLabel = prevF.label.replace(/:$/, ""); }
        // a numbered heading with its own box just above ("3. Evaluation of Surfacing Options") also names the table
        if (!tableLabel && prevF && prevF.kind === "text" && /^\d+\.\s+\S/.test(prevF.label) && !loose.length) tableLabel = prevF.label;
        // else the nearest heading / bold / stand-alone short line above it ("Site Condition Evaluation" under the question title)
        if (!tableLabel && !fields.length && labelLines.length >= 2) {
          const cap = lastLine(labelLines); const before = labelLines[labelLines.length - 2];
          const standalone = cap.heading || cap.bold || (cap.page !== null && (cap.page !== before.page || before.y - cap.y > cap.size * 1.6));
          if (standalone && words(cap.text) <= 8 && !/[.?]$/.test(cap.text)) { labelLines.pop(); tableLabel = cap.text.replace(/:$/, ""); }
        }
        // row labels wrapped over several lines are one label
        const rowLabels: string[] = [];
        bodyRows.forEach((r, ri) => {
          const t2 = r.cells[0]?.text ?? ""; if (!t2) return;
          const prev = bodyRows[ri - 1];
          if (prev && rowLabels.length && l.page !== null && prev.y - r.y <= l.size * 1.5) rowLabels[rowLabels.length - 1] = joinWrapped([rowLabels[rowLabels.length - 1], t2]);
          else rowLabels.push(t2);
        });
        const colTexts = cols.map((c) => c.text).filter(Boolean);
        // the same header repeated at the top of the next page continues the table above
        const prevT = fields[fields.length - 1];
        if (!tableLabel && prevT?.kind === "table" && !loose.length && (prevT.columns ?? []).join("|") === colTexts.join("|")) {
          if (prevT.rowLabels?.length || rowLabels.length) prevT.rowLabels = [...(prevT.rowLabels ?? []), ...rowLabels];
          i = j; continue;
        }
        addField({ kind: "table", label: tableLabel, page: l.page, box: 0, columns: colTexts, rowLabels, low: cols.length < 2 ? "The table's columns could not be read." : undefined });
        i = j; continue;
      }
      const nextIsBox = Boolean(body[i + 1] && PLACEHOLDER_RE.test(body[i + 1].text));
      // pre-filled memo lines under the question ("To: Senior Engineer"): examples, never the question or a field label
      if (!fields.length && !pending.length && !loose.length && labelLines.length && MEMO_RE.test(text)) { samples.push(text); i += 1; continue; }
      // a form label ("Project", "Prepared by", "Date")
      if (FORM_LABEL_RE.test(text) && (labelLines.length || fields.length) && !nextIsBox) { pendingToField(); addField({ kind: "text", label: text.replace(/:$/, ""), page: l.page, box: Math.min(l.gapBelow, 30), form: true, date: /\bdate\b/i.test(text) }); i += 1; continue; }
      // the question text itself (before any field); a line followed by an answer box is a field label instead
      if (!fields.length && !pending.length && !nextIsBox && !loose.length) {
        if (labelLines.length && MEMO_RE.test(text)) samples.push(text); else labelLines.push(l);
        i += 1; continue;
      }
      // after fields: a short label waits for its box; long text is kept aside (and so is everything after it until a box)
      if (loose.length && !nextIsBox) { pendingToField(); loose.push(l); i += 1; continue; }
      if (nextIsBox || words(text) <= 12 || /:$/.test(text)) { if (!nextIsBox || pending.length) pendingToField(); pending.push(l); i += 1; continue; }
      pendingToField();
      if (fields.length) loose.push(l); else extra.push(l);
      i += 1;
    }
    pendingToField();

    // text found after the last field that reads like a brief: hand it to whatever comes next
    const trailingText = loose.map((l) => l.text).join(" ");
    const keepTrailing = trailingText.length > 300 ? loose : [];
    if (!keepTrailing.length && loose.length) extra.push(...loose);

    const meta = (page: number | null, low?: string): ImportMeta => (low ? { page, confidence: "low", note: low } : { page, confidence: "high" });
    let fullLabel = labelLines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
    let help = "";
    if (b.name && !b.number) fullLabel = fullLabel || b.name;
    if (fullLabel.length > 300) {
      const sentences = fullLabel.split(/(?<=[.?!])\s+/);
      const ask = sentences.find((x) => QUESTION_VERB_RE.test(x.trim())) ?? sentences[sentences.length - 1];
      help = fullLabel; fullLabel = (b.name && !b.number ? `${b.name}: ` : "") + ask.trim();
    }
    const notes: string[] = [];
    if (!fullLabel) notes.push("No question text was found; type the question.");
    if (extra.length) notes.push(`Text between the answer boxes was kept in the help text: "${extra.map((x) => x.text).join(" ").slice(0, 80)}…". Check where it belongs.`);
    if (!b.templateHeader) notes.push("Recognised from its numbering only.");
    if (extra.length) help = [help, extra.map((x) => x.text).join(" ")].filter(Boolean).join("\n\n");

    // attachments only where the question's own words ask for them (never inferred from calculations or task instructions)
    const labelAll = labelLines.map((x) => x.text).join(" ");
    const wantsAttach = ATTACH_RE.test(labelAll) || fields.some((f) => ATTACH_RE.test(f.label));

    const toQuestion = (f: Field): Question => {
      let q: Question;
      if (f.kind === "table") {
        q = base("table_grid", f.label || fullLabel);
        const cols = (f.columns?.length ? f.columns : ["Item", "Detail"]).map((c, ci) => ({ id: `c${ci + 1}`, label: c, kind: "text" as const }));
        const rows = (f.rowLabels?.length ? f.rowLabels : ["1", "2", "3", "4", "5"]).map((r, ri) => ({ id: `r${ri + 1}`, label: r }));
        q.config = { ...q.config, columns: cols, rows, allowAddRows: !f.rowLabels?.length };
      } else if (f.kind === "choice") {
        q = base(f.single ? "single_choice" : "multi_choice", f.label || fullLabel);
        q.config = { ...q.config, options: (f.options ?? []).map((o, oi) => ({ id: String.fromCharCode(97 + oi), label: o })) };
        if (f.single) q.config.allowOther = false; else { q.config.minSelected = 1; q.config.maxSelected = null; }
      } else if (f.kind === "tf") {
        q = base("true_false", f.label);
        q.config = { ...q.config, trueLabel: "Yes", falseLabel: "No" };
      } else if (f.date) {
        q = base("date", f.label); q.required = false;
      } else {
        const long = f.box >= 45;
        q = base(long ? "long_answer" : "short_answer", f.label || fullLabel);
        if (!long) q.config = { ...q.config, maxWords: null };
        if (f.form) q.required = false;
        if (!f.form && f.box >= 30 && f.box < 60 && f.page !== null) f.low = f.low ?? "The answer box is medium-sized; check short or long answer.";
      }
      if (f.example) { if (q.type === "short_answer") q.config = { ...q.config, placeholder: f.example }; else q.helpText = `Example: ${f.example}`; }
      q.importMeta = meta(f.page ?? b.page, f.low);
      if (f.model?.length || f.guidance?.length) keys.set(q.id, { questionId: q.id, modelAnswer: f.model?.join("\n") || null, assessorGuidance: f.guidance?.join("\n") || null });
      return withSchema(q);
    };

    let main: Question;
    const real = fields.filter((f) => f.kind !== "info");
    if (!real.length) {
      // the space under the question (blank Word paragraphs after a model answer still count)
      const box = Math.max(labelLines.length ? lastLine(labelLines).gapBelow : 0, body.length ? lastLine(body).gapBelow : 0);
      const noTextBox = wantsAttach && /\b(upload|attach|photo|screen\s?shot)/i.test(fullLabel) && !/\b(describe|explain|write|list|answer)\b/i.test(fullLabel) && box < 45;
      if (noTextBox) { main = base("file_upload", fullLabel); main.config = { ...main.config, minFiles: 1 }; }
      else main = base(box >= 45 || b.templateHeader ? "long_answer" : "short_answer", fullLabel);
      if (!b.templateHeader && box >= 30 && box < 60) notes.push("Short or long answer was guessed from the space left for it.");
    } else if (real.length === 1 && real[0].kind !== "text" && !real[0].label) {
      main = toQuestion({ ...real[0], label: fullLabel });
    } else if (real.length === 1 && real[0].kind === "text" && !real[0].form && !real[0].label) {
      main = base(real[0].box >= 45 ? "long_answer" : "short_answer", fullLabel);
    } else {
      // the title: the first lines of the question text (until a gap or a "To: …" line), cut at the first sentence end
      const titleLines: WbLine[] = [];
      for (const tl of labelLines) { const prev = titleLines[titleLines.length - 1]; if (titleLines.length && (/^[A-Z][A-Za-z ]{0,20}:\s/.test(tl.text) || (prev.page === tl.page && prev.y - tl.y > tl.size * 1.6) || prev.page !== tl.page)) break; titleLines.push(tl); }
      const titleText = titleLines.map((x) => x.text).join(" ").replace(/\s+/g, " ").trim() || fullLabel;
      main = base("case_study", titleText.split(/(?<=[.:?])\s+/)[0].replace(/:$/, "") || fullLabel);
      const scenario = fullLabel.length > (main.label?.length ?? 0) + 2 ? fullLabel : "";
      main.config = { ...main.config, scenario };
      // the workbook marks the question (its "Satisfactory Yes / No" bar), not each box inside it
      main.children = real.map(toQuestion).map((c) => { c.markingMode = "none"; delete c.criteria; return c; });
      // a table with no caption of its own: the nearest heading above it is the question's title
      if (real.some((f) => f.kind === "table" && !f.label)) for (const c of main.children) if (c.type === "table_grid" && c.label === fullLabel) c.label = main.label;
    }
    if (qModel.length || qGuidance.length) keys.set(main.id, { questionId: main.id, modelAnswer: qModel.join("\n") || null, assessorGuidance: qGuidance.join("\n") || null });
    if (samples.length) help = [help, `Example in the workbook: ${samples.join(" · ")}`].filter(Boolean).join("\n\n");
    if (help) main.helpText = help;

    if (wantsAttach) attachTo(main);
    main.importMeta = meta(b.page, notes.join(" ") || undefined);
    return { questions: [withSchema(main)], trailing: keepTrailing };
  };

  /** Attachments: on the question itself, else on its main child (one asking for files, a table, then the longest text box). */
  const attachTo = (main: Question): boolean => {
    if (main.type === "file_upload") return false;
    const kids = (main.children ?? []).filter((c) => c.type !== "date" && !/^(project|prepared by|approved by|subject|location)/i.test(c.label));
    const target = main.type === "case_study"
      ? kids.find((c) => ATTACH_RE.test(c.label)) ?? kids.find((c) => c.type === "table_grid") ?? kids.filter((c) => c.type === "long_answer").pop() ?? kids[0]
      : main;
    if (!target || !["short_answer", "long_answer", "table_grid", "number", "date"].includes(target.type)) return false;
    if (target.config?.allowAttachment === true) return true;
    target.config = { ...target.config, allowAttachment: true };
    Object.assign(target, withSchema(target));
    return true;
  };

  const base = (type: string, label: string): Question => {
    const q: Question = { id: newId("q"), type, label: label.trim(), required: type !== "instruction", markingMode: type === "observation_checklist" ? "observation" : type === "declaration" || type === "instruction" ? "none" : "criteria", config: {} };
    // no default criterion: the trainer marks each question Satisfactory Yes / No, as the workbook does (criteria can be added in the builder)
    return q;
  };

  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    const text = l.text;
    const heading = isHeadingLine(l, bodySize);
    // a task heading wrapped onto the next line / page ("… (Includes a" + "role-play)")
    if (lastTaskHeading && heading && cur && !TASK_RE.test(text) && /\([^)]*$/.test(lastTaskHeading.text)) {
      if (/\([^)]*$/.test(cur.task.title)) cur.task.title = `${cur.task.title} ${text}`.trim();
      lastTaskHeading = null; continue;
    }
    if (heading && !SKIP_HEADING_RE.test(text) && TASK_RE.test(text) && !SUBTASK_RE.test(text) && !/results?\s+sheet/i.test(text)) {
      const m = text.match(TASK_RE)!; flushDecl(); startTask(Number(m[1]), m[2] ?? "", l);
      // the rest of a wrapped heading
      let nxt = lines[li + 1];
      let wrapped = false;
      while (l.page !== null && nxt && nxt.page === l.page && nxt.size === l.size && l.y - nxt.y > 0 && l.y - nxt.y <= l.size * 1.6 && !TASK_RE.test(nxt.text)) { wrapped = true; if (/\([^)]*$/.test(cur!.task.title) || cur!.task.title === `Task ${m[1]}`) cur!.task.title = `${cur!.task.title} ${nxt.text}`.replace(/^task\s*\d+\s+/i, "").trim(); li += 1; nxt = lines[li + 1]; }
      if (wrapped) lastTaskHeading = null;
      continue;
    }
    lastTaskHeading = null;
    if (!cur) { front.push(l); continue; } // cover and unit requirements before the first task (kept for the information pages)
    // skip regions: the phrases are specific, so any size counts; an appendix needs a real heading (a case study may say "Appendix")
    if (SKIP_HEADING_RE.test(text) && l.cells.length <= 2 && (APPENDIX_RE.test(text) ? heading : true) && !(l.page === null && words(text) > 8)) {
      flushBlock(); flushDecl();
      mode_ = "skip"; skipKind = APPENDIX_RE.test(text) ? "appendix" : skipKind === "appendix" ? "appendix" : "outcome";
      // Appendix A – Reasonable Adjustments (and its strategies matrix) is kept for the adjustment record; the next appendix ends it
      if (skipKind === "appendix") ra = RA_RE.test(text) ? (ra && !ra.done ? ra : { lines: [], page: l.page, done: false }) : ra ? { ...ra, done: true } : null;
      continue;
    }
    // a "Student declaration" heading inside a task (not on a results sheet)
    if (heading && /^(student'?s?\s+)?declaration:?$/i.test(text) && !cur.declaration) {
      flushBlock(); flushDecl();
      mode_ = "skip"; skipKind = "outcome"; declCapture = { lines: [], page: l.page };
      continue;
    }
    if (mode_ === "skip") {
      if (skipKind === "appendix" && ra && !ra.done) { ra.lines.push(l); continue; }
      if (skipKind === "outcome" && !cur.declaration) {
        // the student declaration on the results sheet: its text column, until the next field label
        const firstCell = l.cells[0]?.text ?? "";
        if (!declCapture && (DECLARATION_RE.test(text) || (/^(student\s+)?declaration$/i.test(firstCell) && l.cells.length > 1) || (/^student$/i.test(text) && lines.slice(li + 1, li + 4).some((n) => /^declaration$/i.test(n.cells[0]?.text ?? ""))) || /^student\s+declaration\b/i.test(text))) {
          declCapture = { lines: l.cells.length > 1 ? [l.cells.slice(1).map((c) => c.text).join(" ")] : [], page: l.page };
          continue;
        }
        if (declCapture) {
          const leftLabel = l.cells[0] && l.cells[0].x < 120 && l.page !== null;
          if (leftLabel && /^(declaration|student)$/i.test(l.cells[0].text)) { if (l.cells.length > 1) declCapture.lines.push(l.cells.slice(1).map((c) => c.text).join(" ")); continue; }
          if ((leftLabel && words(l.cells[0].text) <= 4 && l.cells.length === 1) || (l.page === null && FORM_LABEL_RE.test(text)) || /^office use only/i.test(text)) { flushDecl(); continue; }
          declCapture.lines.push(l.page === null ? text : l.cells.map((c) => c.text).join(" "));
          continue;
        }
      }
      continue;
    }
    const st = text.match(SUBTASK_RE);
    if (st && (heading || l.size >= bodySize || l.page === null) && Number(st[1]) === cur.n && mode_ !== "question") {
      flushBlock();
      sec = getSection(cur, `${st[1]}.${st[2]}`, `${st[1]}.${st[2]} ${st[3]}`.trim());
      if (!sec.introPage) sec.introPage = l.page;
      mode_ = "intro"; continue;
    }
    // Word: a "Question | Answer | Model answer" table, one question per row (the model column goes to the keys only)
    if (l.table?.header && l.cells.some((c) => QA_HEADER_Q_RE.test(c.text))) {
      flushBlock();
      const ci = (re: RegExp) => l.cells.findIndex((c) => re.test(c.text));
      const qCol = ci(QA_HEADER_Q_RE); const modelCol = ci(QA_HEADER_MODEL_RE); const guideCol = ci(/assessor\s+(guidance|notes?)|marking\s+notes?/i); const studentCol = ci(QA_HEADER_STUDENT_RE);
      sec = getSection(cur, "main", "Questions");
      let k = li + 1;
      while (lines[k]?.table?.id === l.table.id) {
        const row = lines[k]; const cell = (n: number) => (n >= 0 ? row.cells[n]?.text ?? "" : "");
        const label = cell(qCol);
        if (label) {
          const q = base("long_answer", label);
          const note = studentCol < 0 ? "The table has no answer column; a long answer box was used." : "";
          q.importMeta = note ? { page: null, confidence: "low", note } : { page: null, confidence: "high" };
          if (ATTACH_RE.test(label)) q.config = { ...q.config, allowAttachment: true };
          const model = cell(modelCol); const guide = cell(guideCol);
          if (model || guide) keys.set(q.id, { questionId: q.id, modelAnswer: model || null, assessorGuidance: guide || null });
          const built = withSchema(q);
          sec.section.questions.push(built); questionsOut.push({ sec, q: built });
        }
        k += 1;
      }
      li = k - 1; mode_ = "intro"; continue;
    }
    const qh = templateQHeader(l) ?? (templateMode ? null : genericQuestion(l, lines[li + 1], cur, mode_));
    if (qh) {
      flushBlock();
      const parts = qh.number?.split(".") ?? [];
      // "Q22 | References": no number, so it stays in the part being answered (2.2), else the task's questions
      const key = parts.length >= 3 ? parts.slice(0, -1).join(".") : !qh.number && sec && /^\d+\.\d+$/.test(sec.key) ? sec.key : "main";
      const target = key === "main" ? getSection(cur, "main", "Questions") : getSection(cur, key, `${key}`);
      const pendingCarry = carry as { lines: WbLine[]; from: string } | null; carry = null;
      if (pendingCarry) {
        if (target !== sec && target.section.questions.length === 0) { target.intro.unshift(...pendingCarry.lines); target.carried = true; target.carryNote = `This text was found after question ${pendingCarry.from}; it looks like the brief for this part.`; }
        else if (sec) { sec.section.questions.push(instructionFrom(pendingCarry.lines, `This text was found after question ${pendingCarry.from}; check where it belongs.`)); }
      }
      sec = target;
      block = { number: qh.number, name: qh.name, page: l.page, lines: qh.rest ? [{ ...l, cells: [{ x: l.x, text: qh.rest }], text: qh.rest }] : [], templateHeader: qh.template };
      mode_ = "question"; continue;
    }
    if (mode_ === "question" && block) { block.lines.push(l); continue; }
    if (mode_ === "intro" && sec) {
      if (!sec.introPage) sec.introPage = l.page;
      sec.intro.push(l);
      if (/\b(submission\s+of\s+supporting\s+evidence|mathematics\s+calculation\s+box|any\s+other\s+additional\s+work)\b/i.test(text)) { cur.wantsUploads = true; cur.uploadPage ??= l.page; cur.uploadNote = cur.uploadNote || text; }
    }
  }
  flushBlock(); flushDecl();
  if (carry && cur) { const c = carry as { lines: WbLine[]; from: string }; (sec ?? getSection(cur, "main", "Questions")).section.questions.push(instructionFrom(c.lines, `This text was found after question ${c.from}; check where it belongs.`)); }

  // assemble each task: instruction blocks, questions, observation checklists, supporting evidence, declaration
  for (const t of tasks) {
    for (const s of t.sections) {
      const intro = s.intro.filter((l) => !onlyMarkWords(l));
      const blocks = intro.length ? instructionBlocks(intro, s.carried ? s.carryNote : undefined) : [];
      const observation = observationFrom(intro, s.key !== "intro" && s.key !== "main" ? s.title : "");
      if (observation && s.key === "intro") {
        // a task-level "observed by your assessor" list goes at the end of the task's questions
        const last = [...t.sections].reverse().find((x) => x.key !== "intro" && x.section.questions.length);
        (last ?? s).section.questions.push(observation);
      } else if (observation) s.section.questions.push(observation);
      s.section.questions.unshift(...blocks);
      // a section named only by number: use "Occasion N" from its questions when they say so
      if (/^\d+\.\d+$/.test(s.title)) {
        const occ = s.section.questions.map((q) => q.label.match(OCCASION_RE)?.[0]).find(Boolean);
        s.section.title = `${s.title}${occ ? ` – ${occ.replace(/^o/, "O")}` : ""}`;
      } else s.section.title = s.title;
    }
    // sections in reading order: instructions, the task's own questions, then sub-tasks by number
    const order = (k: string) => (k === "intro" ? -1 : k === "main" ? 0 : Number(k.split(".")[1] ?? 0) + 1);
    t.sections.sort((a, b) => order(a.key) - order(b.key));
    const qSections = t.sections.filter((s) => s.section.questions.some((q) => q.type !== "instruction"));
    const lastQ = qSections[qSections.length - 1] ?? t.sections[t.sections.length - 1];
    if (t.wantsUploads && lastQ) {
      const up = base("file_upload", "Supporting evidence: graphs, calculations or any other additional work");
      up.required = false; up.helpText = "Upload any graphs, calculations or other work you could not include in your answers.";
      up.config = { minFiles: 0, maxFiles: 10, maxMb: 25, accept: [] };
      up.importMeta = { page: t.uploadPage, confidence: "high" };
      lastQ.section.questions.push(withSchema(up));
    }
    if (t.declaration) {
      const d = base("declaration", "Student declaration");
      d.config = { text: t.declaration };
      d.importMeta = { page: t.declarationPage, confidence: "high" };
      getSection(t, "zz_declaration", "Declaration").section.questions.push(withSchema(d));
    }
    // a project task whose instructions list "Evidence to submit": each evidence item (the sub-task questions) takes files too
    const evidenceTable = t.sections.some((s) => s.intro.some((l) => l.cells.length >= 3 && l.cells.some((c) => EVIDENCE_COL_RE.test(c.text))));
    if (evidenceTable) {
      for (const s of t.sections) {
        if (s.key === "intro" || s.key === "main" || s.key === "zz_declaration") continue;
        for (const q of s.section.questions) if (["case_study", "table_grid", "long_answer", "short_answer"].includes(q.type) && !/^references?\b/i.test(q.label)) attachTo(q);
      }
    }
    // ASM-WORKBOOK item 7: Appendix A becomes the trainer's reasonable adjustment record, at the end of the last task
    if (ra && t === tasks[tasks.length - 1]) getSection(t, "zz_appendix", "Appendix A – Reasonable Adjustments").section.questions.push(adjustmentRecord(ra.lines, ra.page));
    t.task.sections = t.sections.filter((s) => s.section.questions.length).map((s) => s.section);
    const firstIntro = t.sections.find((s) => s.key === "intro");
    t.task.instructions = firstIntro ? firstIntroSummary(firstIntro.intro) : "";
  }
  if (!tasks.length) warnings.push("No \"Assessment Task\" heading was found: check that the file is an assessment workbook.");
  if (assessorVersion) warnings.push("This looks like an assessor version: model answers and guidance were put in the assessor-only keys.");

  const unplaced = pics.list.filter((im) => !pics.used.has(im) && tasks.length && im.page >= Math.min(...lines.filter((l) => l.page !== null).map((l) => l.page as number)));
  if (unplaced.length) warnings.push(`${unplaced.length} picture${unplaced.length === 1 ? "" : "s"} (page${unplaced.length === 1 ? "" : "s"} ${unplaced.map((im) => im.page).join(", ")}) sit${unplaced.length === 1 ? "s" : ""} among questions, not instructions, and ${unplaced.length === 1 ? "was" : "were"} not imported: add ${unplaced.length === 1 ? "it" : "them"} in the builder if the students need ${unplaced.length === 1 ? "it" : "them"}.`);
  const version = opts.version ?? null;
  const info = infoSections(front);
  const definition: Definition = { instructions: info.html, tasks: tasks.map((t) => t.task), source: { qualification, unit: unitInfo, version, fileName: opts.fileName ?? null } };
  const flat: Question[] = [];
  const walk = (q: Question) => { flat.push(q); (q.children ?? []).forEach(walk); };
  definition.tasks.forEach((t) => t.sections.forEach((s) => s.questions.forEach(walk)));
  const byType: Record<string, number> = {};
  for (const q of flat) byType[q.type] = (byType[q.type] ?? 0) + 1;
  const keyList = [...keys.values()].filter((k) => flat.some((q) => q.id === k.questionId));
  return {
    title, version, unitCode, qualification, unit: unitInfo, assessorVersion, definition, keys: keyList, warnings,
    stats: {
      tasks: definition.tasks.length,
      sections: definition.tasks.reduce((n, t) => n + t.sections.length, 0),
      questions: flat.filter((q) => q.type !== "instruction").length,
      topLevelQuestions: definition.tasks.reduce((n, t) => n + t.sections.reduce((m, s) => m + s.questions.filter((q) => q.type !== "instruction").length, 0), 0),
      byType,
      lowConfidence: flat.filter((q) => q.importMeta?.confidence === "low").length,
      attachments: flat.filter((q) => q.config?.allowAttachment === true || q.type === "file_upload").length,
      keys: keyList.length,
      tables: flat.reduce((n, q) => n + (q.type === "instruction" ? (String(q.config?.html ?? "").match(/<table>/g) ?? []).length : 0), 0),
      images: pics.used.size,
      infoSections: info.count,
      adjustmentRecord: Boolean(ra),
    },
  };

  /* -------- helpers that need the closure (keys, base) -------- */
  /**
   * ASM-WORKBOOK item 1: the numbered sections before the first task (submission method, reasonable adjustment, feedback,
   * plagiarism, collusion, outcomes, reassessment, due dates, confidentiality, appeals, RPL, special needs, declaration) as the
   * read-only information the student sees before starting. The details forms (filled in by the system), the task list and the
   * assessors' own instructions are left out.
   */
  function infoSections(ls: WbLine[]): { html: string; count: number } {
    const isHead = (l: WbLine) => Boolean(l.heading || (l.page !== null && l.size >= bodySize + 3)) && /^\d{1,2}\.\s+\S/.test(l.text);
    const parts: { title: string; lines: WbLine[] }[] = [];
    for (const l of ls) {
      if (l.page !== null && l.page < 2) continue; // the cover
      if (isHead(l)) { parts.push({ title: l.text.replace(/^\d{1,2}\.\s+/, "").trim(), lines: [] }); continue; }
      if (parts.length && !/^(student\s+)?(signature|date)\s*:?$/i.test(l.text) && !/^\(please describe here\)$/i.test(l.text)) parts[parts.length - 1].lines.push(l);
    }
    const kept = parts.filter((p) => !INFO_SKIP_RE.test(p.title) && p.lines.length);
    const html = kept.map((p) => `<h4>${esc(p.title)}</h4>${/submission\s+method/i.test(p.title) ? "<p>This assessment is submitted online through the Learning Management System (LMS).</p>" : toHtml(p.lines)}`).join("");
    // a sentence the workbook prints twice in a row is shown once
    return { html: html.replace(/(<p>[^<]*<\/p>)(\1)+/g, "$1"), count: kept.length };
  }
  /** ASM-WORKBOOK item 7: the reasonable adjustment record from Appendix A (its explanation and the strategies of its matrix). */
  function adjustmentRecord(ls: WbLine[], page: number | null): Question {
    const q = base("adjustment_record", "Reasonable adjustments (Appendix A)");
    q.assessorOnly = true; q.required = false; q.markingMode = "none"; delete q.criteria;
    // the explanation: the plain paragraphs before the first matrix header
    const headerAt = ls.findIndex((l) => l.cells.some((c) => /^category$/i.test(c.text)));
    const intro = (headerAt >= 0 ? ls.slice(0, headerAt) : ls).filter((l) => l.size <= bodySize + 1 && l.cells.length === 1).map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
    // the strategies: the cells of the matrix's strategy column, wrapped lines joined
    const strategies: string[] = [];
    let stratX: number | null = null;
    for (const l of ls) {
      // the matrix header row ("Category | … | Reasonable Adjustment Strategy"), not a sentence that names the matrix
      const head = l.cells.some((c) => /^category$/i.test(c.text)) ? l.cells.find((c) => /adjustment\s+strateg/i.test(c.text)) : undefined;
      // the declarations after the matrix end it
      if (stratX !== null && (/^i\s+declare\b/i.test(l.text) || l.cells.some((c) => /^(trainer|student)\b/i.test(c.text) && c.x < stratX))) break;
      if (head) { const before = l.cells.filter((c) => c.x < head.x).pop(); stratX = before ? (before.x + head.x) / 2 : head.x - 40; continue; } // the header is centred over its column
      if (stratX === null || l.size > bodySize + 1) continue;
      for (const c of l.cells) {
        if (c.x < stratX) continue;
        const t = c.text.trim();
        const prev = strategies[strategies.length - 1];
        if (prev && (/^[a-z(]/.test(t) || /,$/.test(prev))) strategies[strategies.length - 1] = `${prev} ${t}`;
        else strategies.push(t);
      }
    }
    const unique = [...new Set(strategies.map((x) => x.replace(/\s+/g, " ").replace(/\.$/, "").trim()).filter((x) => x.length >= 4))].slice(0, 40);
    q.config = { intro, categories: ADJUSTMENT_CATEGORIES, strategies: unique.length >= 5 ? unique : ADJUSTMENT_STRATEGIES, declaration: ADJUSTMENT_DECLARATION };
    q.importMeta = unique.length >= 5 ? { page, confidence: "high" } : { page, confidence: "low", note: "The strategies matrix could not be read; the standard SLIT strategies were used." };
    return withSchema(q);
  }
  function instructionFrom(ls: WbLine[], note?: string): Question {
    const q = base("instruction", "");
    q.config = { html: toHtml(ls, pics), attachments: [] };
    q.importMeta = { page: ls[0]?.page ?? null, confidence: note ? "low" : "high", ...(note ? { note } : {}) };
    return withSchema(q);
  }
  function instructionBlocks(ls: WbLine[], note?: string): Question[] {
    // split at headings (larger text or Word headings), at most ~4000 characters a block
    const chunks: WbLine[][] = []; let curChunk: WbLine[] = []; let len = 0;
    const left = Math.min(...ls.map((l) => l.x));
    for (const l of ls) {
      const h = l.heading || (l.page !== null && l.size >= bodySize + 3);
      // a long block is cut only at a plain paragraph line at the left margin (never inside a table)
      if ((h && curChunk.length) || (len > 4000 && l.cells.length < 2 && l.x <= left + 5)) { chunks.push(curChunk); curChunk = []; len = 0; }
      curChunk.push(l); len += l.text.length;
    }
    if (curChunk.length) chunks.push(curChunk);
    return chunks.map((c, ci) => instructionFrom(c, ci === 0 ? note : undefined));
  }
  function observationFrom(ls: WbLine[], sectionTitle: string): Question | null {
    const text = ls.map((l) => l.text).join("\n");
    const hasRolePlay = ROLEPLAY_RE.test(text) && /\bbrief\b|\bscenario\b|\bstakeholder\b|\bmeeting\b/i.test(text);
    const startIdx = ls.findIndex((l) => OBSERVE_LIST_RE.test(l.text));
    if (!hasRolePlay && startIdx < 0) return null;
    const items: string[] = [];
    if (startIdx >= 0) {
      const start = ls[startIdx];
      for (let k = startIdx + 1; k < ls.length && items.length < 15; k++) {
        const l = ls[k];
        if (l.heading || (l.page !== null && l.x <= start.x + 2 && !/^[•·\-–]/.test(l.text) && items.length)) break;
        if (items.length >= 2 && l.text.length > 75) break; // a paragraph after the list
        if (l.page !== null && l.x <= start.x + 2 && !items.length && !/^[•·\-–]/.test(l.text)) break;
        const t2 = l.text.replace(/^[•·\-–•]\s*/, "").trim();
        if (l.page !== null && items.length && l.x > start.x + 20 && !/^[•·\-–]/.test(l.text) && /^[a-z]/.test(t2)) { items[items.length - 1] += ` ${t2}`; continue; }
        if (t2) items.push(t2);
      }
    }
    const roleplay = startIdx >= 0 ? hasRolePlay && (/assessment\s+focus/i.test(ls[startIdx].text) || ROLEPLAY_RE.test(ls[startIdx].text)) : hasRolePlay;
    if (!roleplay && !sectionTitle && items.length < 2) return null;
    const q = base("observation_checklist", roleplay ? `Role-play observation${sectionTitle ? `: ${sectionTitle}` : ""}` : "Practical performance observed by the assessor");
    q.assessorOnly = true;
    const list = items.length >= 2 ? items : ["Presents the technical information clearly", "Responds to questions and clarifies professionally", "Uses appropriate industry terminology", "Justifies decisions with the site data and selection criteria"];
    q.config = { items: list.map((t3, k) => ({ id: `o${k + 1}`, text: t3 })), allowNotes: true };
    delete q.criteria;
    q.importMeta = items.length >= 2 ? { page: ls[startIdx]?.page ?? ls[0]?.page ?? null, confidence: "high" } : { page: ls[0]?.page ?? null, confidence: "low", note: "A role-play was found but no list of what the assessor observes; the checklist items are placeholders." };
    return withSchema(q);
  }
}

/** The template's question header row: "Q3 | Q2.1.3 | Satisfactory" or "Q6 | References | Satisfactory". */
function templateQHeader(l: WbLine): { number: string | null; name: string | null; rest: string; template: boolean } | null {
  const cells = l.cells.map((c) => c.text);
  if (cells.length < 2 || !/^Q\s?\d+$/i.test(cells[0])) return null;
  const num = cells.find((c) => /^Q?\d+(\.\d+)+$/i.test(c));
  const hasMark = cells.some((c) => /^satisfactory$/i.test(c));
  if (!num && !hasMark) return null;
  const name = num ? null : cells[1] && !/^satisfactory$/i.test(cells[1]) ? cells[1] : null;
  return { number: num ? num.replace(/^Q/i, "") : null, name, rest: "", template: true };
}

/** A numbered question in a free-form document (only when the file has no template question headers). */
function genericQuestion(l: WbLine, next: WbLine | undefined, t: TaskState | null, mode_: string): { number: string | null; name: string | null; rest: string; template: boolean } | null {
  if (!t || l.table) return null;
  const m = l.text.match(/^(?:Q(?:uestion)?\s*)?(\d+(?:\.\d+){0,3})[.):]?\s+(.{3,})$/i);
  const listed = l.listNumber ? { num: String(l.listNumber), rest: l.text } : null;
  const got = m ? { num: m[1], rest: m[2] } : listed;
  if (!got) return null;
  const rest = got.rest.trim();
  const questionLike = /\?$/.test(rest) || QUESTION_VERB_RE.test(rest);
  const nextIsBox = next ? PLACEHOLDER_RE.test(next.text) || ITEM_RE.test(next.text) || (next.table && next.cells.every((c) => c.text === "")) : false;
  if (!questionLike && !nextIsBox) return null;
  if (mode_ === "intro" && !questionLike) return null;
  const number = got.num.includes(".") ? got.num : `${t.n}.${got.num}`;
  return { number, name: null, rest, template: false };
}

/** Column headings of a PDF table header: the line with most cells gives the columns; wrapped words join the nearest column. */
function columnsOf(group: WbLine[]): { x: number; text: string }[] {
  // header words are centred in their cells: group them by the centre of the text, top to bottom
  const cols: { c: number; x: number; parts: string[] }[] = [];
  for (const l of group) for (const cell of l.cells) {
    const centre = cell.x + (cell.w ?? cell.text.length * l.size * 0.5) / 2;
    const col = cols.find((k) => Math.abs(k.c - centre) <= 22);
    if (col) { col.parts.push(cell.text); col.x = Math.min(col.x, cell.x); } else cols.push({ c: centre, x: cell.x, parts: [cell.text] });
  }
  return cols.sort((a, b) => a.c - b.c).map((c) => ({ x: c.x, text: joinWrapped(c.parts) }));
}
/** Words a narrow cell wrapped mid-word ("Conseque" + "nce", "Disadvantage" + "s") are joined back. */
const joinWrapped = (parts: string[]) => parts.reduce((s, p) => (!s ? p : /^[a-z]{1,3}\)?$/.test(p) && /[a-z]$/i.test(s) ? s + p : `${s} ${p}`), "").replace(/(\w)- (\w)/g, "$1$2").replace(/\s+/g, " ").trim();

function mode(ns: number[]): number | null {
  const m = new Map<number, number>(); for (const n of ns) m.set(n, (m.get(n) ?? 0) + 1);
  let best: number | null = null; let c = 0; for (const [k, v] of m) if (v > c) { best = k; c = v; } return best;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

/** The workbook's pictures still to place, shared by every instruction block of one import (each picture is placed once). */
interface PicPool { list: WbImage[]; used: Set<WbImage> }
const figure = (im: WbImage) => `<figure><img src="${escAttr(im.src)}" alt="Picture on page ${im.page} of the workbook" width="${im.width}" height="${im.height}" /></figure>`;

/**
 * A table of three or more columns starting at line k ("Task | Instructions | Evidence to submit", "Team Member | Role |
 * Responsibilities"): PDF cells go to the column whose left edge they are past, a new row starts after a larger gap, the same header
 * at the top of the next page continues the table, and a line wider than its column (a paragraph) ends it. Word tables come as rows.
 */
function tableAt(ls: WbLine[], k: number): { html: string; end: number } | null {
  const h = ls[k];
  if (h.page === null) {
    if (!h.table || h.cells.length < 3) return null;
    const id = h.table.id; const rows: string[][] = []; let end = k;
    while (end < ls.length && ls[end].table?.id === id) { rows.push(ls[end].cells.map((c) => c.text)); end += 1; }
    return rows.length >= 2 ? { html: tableHtml(rows[0], rows.slice(1)), end } : null;
  }
  if (h.cells.length < 3 || h.cells.some((c) => words(c.text) > 6 || c.text.length > 50)) return null;
  const header = h.cells.map((c) => c.text);
  const cols = h.cells.map((c) => c.x);
  const colOf = (x: number) => { let i = 0; cols.forEach((cx, ci) => { if (x >= cx - 15) i = ci; }); return i; };
  const sameHeader = (l: WbLine) => l.cells.length === header.length && l.cells.every((c, ci) => c.text === header[ci]);
  const rows: string[][][] = [];
  let prev = h; let end = k + 1; let afterHeader = true;
  while (end < ls.length) {
    const l = ls[end];
    if (l.page === null || l.heading || Math.abs(l.size - h.size) > 1) break;
    if (sameHeader(l)) { prev = l; end += 1; afterHeader = true; continue; }
    if (l.page !== prev.page || prev.gapBelow > h.size * 5 || l.cells[0].x < cols[0] - 15) break;
    // a line running past the start of the next column is a paragraph, not a cell
    if (l.cells.some((c) => { const ci = colOf(c.x); return ci + 1 < cols.length && c.x + (c.w ?? c.text.length * l.size * 0.5) > cols[ci + 1] + 8; })) break;
    if (afterHeader || prev.gapBelow > h.size * 2) rows.push(header.map(() => []));
    afterHeader = false;
    const row = rows[rows.length - 1];
    for (const c of l.cells) row[colOf(c.x)].push(c.text);
    prev = l; end += 1;
  }
  const filled = rows.filter((r) => r.filter((parts) => parts.length).length >= 2);
  if (!filled.length) return null;
  return { html: tableHtml(header, rows.map((r) => r.map((parts) => joinWrapped(parts)))), end };
}
const tableHtml = (header: string[], rows: string[][]) =>
  `<table><thead><tr>${header.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${header.map((_, i) => `<td>${esc(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

/** Instruction lines -> simple HTML: headings, paragraphs (lines joined), bullet lists, two-column rows, tables and the pictures between them. */
function toHtml(ls: WbLine[], pics?: PicPool): string {
  const out: string[] = []; let para: string[] = []; let list: string[] = [];
  const body = mode(ls.filter((l) => l.page !== null).map((l) => l.size)) ?? 11;
  const flushP = () => { if (para.length) out.push(`<p>${esc(para.join(" "))}</p>`); para = []; };
  const flushL = () => { if (list.length) out.push(`<ul>${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`); list = []; };
  const firstPage = ls.find((l) => l.page !== null)?.page ?? null;
  const place = (im: WbImage) => { flushP(); flushL(); out.push(figure(im)); pics!.used.add(im); };
  // pictures above this line (on its page, or on an earlier page of this block) go before it
  const placeBefore = (l: WbLine) => {
    if (!pics || l.page === null || firstPage === null) return;
    for (const im of pics.list) if (!pics.used.has(im) && im.page >= firstPage && (im.page < l.page || (im.page === l.page && im.bottom >= l.y))) place(im);
  };
  let rowTextX: number | null = null; // the x of the text column of the last "label | text" row
  for (let k = 0; k < ls.length; k++) {
    const l = ls[k];
    const t = l.text;
    placeBefore(l);
    const tbl = tableAt(ls, k);
    if (tbl) { flushP(); flushL(); out.push(tbl.html); k = tbl.end - 1; rowTextX = null; continue; }
    // a "label | text" row continues on the next lines at the text column's x (the label column may add "(What?)")
    if (rowTextX !== null && l.page !== null && l.cells.length === 1 && (Math.abs(l.x - rowTextX) < 40 || /^\([^)]*\)?$/.test(t)) && out.length && out[out.length - 1].endsWith("</p>")) {
      out[out.length - 1] = out[out.length - 1].replace(/<\/p>$/, ` ${esc(t)}</p>`); continue;
    }
    rowTextX = l.cells.length >= 2 ? l.cells[1].x : null;
    const bullet = t.match(/^[•·•▪\-–]\s*(.+)$/) ?? (l.listNumber === null && l.x === 20 ? [t, t] : null);
    if (l.heading || (l.page !== null && l.size >= body + 3)) { flushP(); flushL(); out.push(`<h4>${esc(t)}</h4>`); continue; }
    if (bullet) { flushP(); list.push(bullet[1]); continue; }
    if (l.cells.length >= 2) { flushP(); flushL(); out.push(`<p><strong>${esc(l.cells[0].text)}</strong> ${esc(l.cells.slice(1).map((c) => c.text).join(" "))}</p>`); continue; }
    if (list.length && l.page !== null && l.x > (ls[k - 1]?.x ?? 0) - 2 && /^[a-z(]/.test(t)) { list[list.length - 1] += ` ${t}`; continue; }
    flushL();
    para.push(t);
    if (l.page === null || l.gapBelow > l.size * 1.75 || /[.:]$/.test(t) && words(t) <= 8) flushP();
  }
  // pictures under the last line of the block's last page
  const last = [...ls].reverse().find((l) => l.page !== null);
  if (pics && last) for (const im of pics.list) if (!pics.used.has(im) && im.page === last.page && im.top <= last.y + last.size) place(im);
  flushP(); flushL();
  return out.join("");
}

function firstIntroSummary(ls: WbLine[]): string {
  const desc = ls.findIndex((l) => /assessment\s+(task\s+)?description/i.test(l.cells[0]?.text ?? l.text));
  if (desc >= 0) {
    const parts: string[] = [];
    const first = ls[desc]; if (first.cells.length > 1) parts.push(first.cells.slice(1).map((c) => c.text).join(" "));
    for (let k = desc + 1; k < ls.length && parts.join(" ").length < 600; k++) {
      const l = ls[k];
      if (/^\(/.test(l.text)) continue; // "(What?)" beside the label
      if (l.page === null ? l.heading || l.table : l.x <= first.x + 5) break;
      parts.push(l.cells.map((c) => c.text).join(" "));
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

/** Plain-text dump of a definition, for tests and the import summary (every student-visible string). */
export function definitionText(def: Definition): string {
  const out: string[] = [];
  const walk = (q: Question) => { out.push(q.label ?? "", q.helpText ?? "", JSON.stringify(q.config ?? {})); (q.children ?? []).forEach(walk); };
  for (const t of def.tasks) { out.push(t.title, t.instructions ?? ""); for (const s of t.sections) { out.push(s.title, s.description ?? ""); s.questions.forEach(walk); } }
  return out.join("\n");
}
