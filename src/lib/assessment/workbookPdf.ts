/**
 * ASM-WORKBOOK item 8: "Export as workbook PDF". A marked submission laid out like the SLIT student workbook (runtime-neutral:
 * pdf-lib only, no DOM, so the test builds it from the RIICWD525E import):
 *   - every page: the institution header (logo left; name, address, RTO / CRICOS, email, phone right) and the footer
 *     "Version Number: x · Unit Code: X · Page n of N";
 *   - cover: title, "1. Student and trainer details" (name, student ID, email, trainer), "2. Qualification and unit of competency",
 *     "3. Assessment Tasks";
 *   - each task: its sections and questions in the workbook's question bar ("Q3 | 2.1.3 | Satisfactory Yes [x] No [ ]"), the
 *     question text, the student's answer in a bordered answer box (tables as tables, choices ticked, files listed by name), the
 *     assessor's observation checklist, the student declaration, then "Assessment Task N – Results Sheet" (attempts 1-3:
 *     Satisfactory / Not Satisfactory ticked, date, assessor, feedback);
 *   - last: overall result, the student's overall feedback, the student's and assessor's names with dates.
 * Instruction pages (the briefs, drawings) are not repeated: they are the same for every student. Model answers and assessor
 * guidance are never printed (they are not in the definition).
 */
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { buildResultsSheet, type AttemptHistory, type SheetCell } from "./resultsSheet";
import type { Definition, EvidenceFile, Outcome, Question, Responses, ResultRow } from "./types";
import { adjustmentLayout, CONTENT_TYPES, coverLayout, titleSubline, type CoverLayout, detailRows, footerParts, INFO_HEADING, workbookDetails, helpRepeatsLabel, htmlToBlocks, qualificationRows, sectionShowsTitle, TASK_TABLE_HEAD, taskHeading, taskRows, workbookNumbering } from "./workbookLayout";

export interface WorkbookInstitution {
  name: string;
  /** Printed under the name, right-aligned (address, "RTO: 45989 CRICOS: 04114B", "Email: …", "Phone: …"). */
  lines: string[];
  logo?: { bytes: Uint8Array; type: "png" | "jpg" } | null;
}
export interface WorkbookAttempt {
  attemptNo: number;
  responses: Responses;
  assessorResponses: Responses;
  results: ResultRow[];
  evidence: EvidenceFile[];
  submittedAt: string | null;
  receiptNo?: string | null;
  declaration?: Record<string, unknown> | null;
}
export interface WorkbookPdfInput {
  definition: Definition;
  attempt: WorkbookAttempt;
  history: AttemptHistory;
  title: string;
  institution: WorkbookInstitution;
  maxAttempts?: number;
  /** Dates are printed in this zone (default Australia/Melbourne). */
  timeZone?: string;
  /**
   * The blank workbook (ASM-REVIEW: the wizard's "Workbook (PDF) view"): as a student receives it, so the information pages and the
   * instruction blocks (briefs, drawings, tables) are printed too, and no attempt line. A marked export leaves them out.
   */
  blank?: boolean;
  /**
   * ASM-AI-IMPORT stage 5: the signatures of this student's attempts (asm_signatures): the student's declaration, the assessor's
   * sign-off and the student's acknowledgement, stamped where the workbook expects them; later attempts fill further columns.
   */
  signatures?: PdfSignature[];
}

export interface PdfSignature { kind: "student_declaration" | "assessor_signoff" | "student_acknowledgement"; attemptNo?: number; signerName: string; signaturePng: string | null; signedAt: string }

const W = 595.28; const H = 841.89; const M = 42;
const HEADER_BOTTOM = H - 104; const FOOTER_TOP = 46;
const INK = rgb(0.1, 0.11, 0.13); const GREY = rgb(0.42, 0.45, 0.5); const LINE = rgb(0.62, 0.65, 0.7); const SHADE = rgb(0.93, 0.94, 0.96);
const BAR = rgb(0.86, 0.89, 0.94);
const SIZE = 9.5; const LEAD = 12.6; const PAD = 5;

type SigCell = { sig: PDFImage | null; text: string };
type Cell = string | { ticks: [string, boolean][] } | SigCell;
const isSig = (c: Cell): c is SigCell => typeof c !== "string" && "sig" in c;
const SIG_H = 30;

class Layout {
  pages: PDFPage[] = [];
  y = 0;
  private known: Set<number>;
  private logo: PDFImage | null = null;
  readonly pdf: PDFDocument; readonly font: PDFFont; readonly bold: PDFFont; readonly input: WorkbookPdfInput;
  constructor(pdf: PDFDocument, font: PDFFont, bold: PDFFont, input: WorkbookPdfInput) {
    this.pdf = pdf; this.font = font; this.bold = bold; this.input = input;
    this.known = new Set(font.getCharacterSet());
  }
  async init() {
    const logo = this.input.institution.logo;
    if (logo?.bytes.length) { try { this.logo = logo.type === "png" ? await this.pdf.embedPng(logo.bytes) : await this.pdf.embedJpg(logo.bytes); } catch { this.logo = null; } }
  }
  /** ASM-COVER: the master workbook's first page (shared coverLayout; no header, no footer, not numbered). */
  cover(c: CoverLayout) {
    const page = this.pdf.addPage([W, H]);
    this.pages.push(page);
    const col = (hex: string) => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
    for (const r of c.shapes) page.drawRectangle({ x: r.x, y: H - r.y - r.h, width: r.w, height: r.h, color: col(r.fill) });
    page.drawSvgPath(c.wave.path, { x: 0, y: H, color: col(c.wave.fill) });
    for (const l of c.lines) page.drawLine({ start: { x: l.x1, y: H - l.y1 }, end: { x: l.x2, y: H - l.y2 }, thickness: l.width, color: col(l.stroke) });
    if (this.logo) {
      const box = c.logo; const scale = Math.min((box.w - 2 * box.pad) / this.logo.width, (box.h - 2 * box.pad) / this.logo.height);
      const w = this.logo.width * scale; const h = this.logo.height * scale;
      page.drawRectangle({ x: box.x, y: H - box.y - (h + 2 * box.pad), width: w + 2 * box.pad, height: h + 2 * box.pad, color: rgb(1, 1, 1) });
      page.drawImage(this.logo, { x: box.x + box.pad, y: H - box.y - box.pad - h, width: w, height: h });
    }
    // the band's words, letter-spaced and centred
    const band = this.clean(c.band.text);
    const bandW = [...band].reduce((n, ch) => n + this.bold.widthOfTextAtSize(ch, c.band.size) + c.band.spacing, -c.band.spacing);
    let bx = (W - bandW) / 2;
    for (const ch of band) { page.drawText(ch, { x: bx, y: H - c.band.y - c.band.size * 0.35, size: c.band.size, font: this.bold, color: col(c.band.color) }); bx += this.bold.widthOfTextAtSize(ch, c.band.size) + c.band.spacing; }
    for (const [k, line] of this.wrap(c.title.text, W - 120, c.title.size, true).entries()) {
      page.drawText(line, { x: (W - this.width(line, c.title.size, true)) / 2, y: H - c.title.y - k * c.title.size * 1.3, size: c.title.size, font: this.bold, color: col(c.title.color) });
    }
    const t = c.table;
    t.rows.forEach(([label, value], i) => {
      const y = H - t.y - (i + 1) * t.rowH;
      page.drawRectangle({ x: t.x, y, width: t.labelW, height: t.rowH, color: col(t.label), borderColor: col(t.border), borderWidth: 0.8 });
      page.drawRectangle({ x: t.x + t.labelW, y, width: t.w - t.labelW, height: t.rowH, color: col(t.value), borderColor: col(t.border), borderWidth: 0.8 });
      page.drawText(this.clean(label), { x: t.x + 8, y: y + t.rowH / 2 - 3.5, size: 10, font: this.bold, color: INK });
      if (value) page.drawText(this.clean(value), { x: t.x + t.labelW + 8, y: y + t.rowH / 2 - 3.5, size: 10, font: this.font, color: INK });
      else page.drawLine({ start: { x: t.x + t.labelW + 8, y: y + 7 }, end: { x: t.x + t.w - 8, y: y + 7 }, thickness: 0.6, color: INK });
    });
  }
  get page() { return this.pages[this.pages.length - 1]; }
  /** Characters Helvetica (WinAnsi) cannot print lose their accents, else become "?"; never a broken document. */
  clean(s: string): string {
    let out = "";
    for (const ch of String(s ?? "").replace(/\r\n?/g, "\n")) {
      const cp = ch.codePointAt(0)!;
      if (ch === "\n") { out += ch; continue; }
      if (cp < 0x20 || cp === 0x7f) { out += " "; continue; } // tabs and other control characters
      if (this.known.has(cp)) { out += ch; continue; }
      if (ch === "☐" || ch === "☑" || ch === "☒") { out += "[ ]"; continue; }
      const folded = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      out += folded && [...folded].every((c) => this.known.has(c.codePointAt(0)!)) ? folded : "?";
    }
    return out;
  }
  width(s: string, size = SIZE, bold = false) { return (bold ? this.bold : this.font).widthOfTextAtSize(s, size); }
  /** Wraps text to a width; long words are broken. */
  wrap(text: string, width: number, size = SIZE, bold = false): string[] {
    const out: string[] = [];
    for (const para of this.clean(text).split("\n")) {
      let line = "";
      for (const word of para.split(/ +/)) {
        if (!word) continue;
        let w = word;
        while (this.width(w, size, bold) > width) {
          let k = w.length; while (k > 1 && this.width(w.slice(0, k), size, bold) > width) k -= 1;
          if (line) { out.push(line); line = ""; }
          out.push(w.slice(0, k)); w = w.slice(k);
        }
        const next = line ? `${line} ${w}` : w;
        if (this.width(next, size, bold) > width) { out.push(line); line = w; } else line = next;
      }
      out.push(line);
    }
    while (out.length > 1 && out[out.length - 1] === "") out.pop();
    return out;
  }
  newPage() {
    const page = this.pdf.addPage([W, H]);
    this.pages.push(page);
    // ASM-HEADER: the master workbook's header: the header picture on the left, the address block on the right (no name line)
    if (this.logo) {
      const scale = Math.min(240 / this.logo.width, 58 / this.logo.height);
      page.drawImage(this.logo, { x: M, y: H - 28 - this.logo.height * scale, width: this.logo.width * scale, height: this.logo.height * scale });
    }
    let y = H - 34;
    for (const l of this.input.institution.lines.filter(Boolean)) {
      const t = this.clean(l);
      page.drawText(t, { x: W - M - this.font.widthOfTextAtSize(t, 8.5), y, size: 8.5, font: this.font, color: GREY });
      y -= 11;
    }
    page.drawLine({ start: { x: M, y: HEADER_BOTTOM + 8 }, end: { x: W - M, y: HEADER_BOTTOM + 8 }, thickness: 0.8, color: LINE });
    this.y = HEADER_BOTTOM - 4;
  }
  /** A picture (JPEG / PNG data: URL) at most the content width and 300 pt high; anything else is skipped. */
  async image(src: string) {
    const m = src.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
    if (!m) return;
    try {
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      const img = m[1].toLowerCase() === "png" ? await this.pdf.embedPng(bytes) : await this.pdf.embedJpg(bytes);
      const scale = Math.min((W - 2 * M) / img.width, 300 / img.height, 1);
      const w = img.width * scale; const h = img.height * scale;
      this.ensure(h + 6);
      this.page.drawImage(img, { x: M, y: this.y - h, width: w, height: h });
      this.y -= h + 6;
    } catch { /* not a picture pdf-lib can read: left out */ }
  }
  /** An instruction block's HTML (or plain text) as headings, paragraphs, list items, tables and pictures. */
  async content(html: string) {
    for (const b of htmlToBlocks(html)) {
      if (b.kind === "heading") this.heading(b.text, 10.5);
      else if (b.kind === "para") { this.text(b.text, { size: 8.5 }); this.gap(2); }
      else if (b.kind === "item") {
        const lines = this.wrap(b.text, W - 2 * M - 16, 8.5);
        lines.forEach((line, k) => {
          this.ensure(11.2);
          if (k === 0) this.page.drawText(this.clean(b.marker), { x: M + 4, y: this.y - 8.5, size: 8.5, font: this.font, color: INK });
          this.page.drawText(line, { x: M + 16, y: this.y - 8.5, size: 8.5, font: this.font, color: INK });
          this.y -= 11.2;
        });
        this.gap(1);
      } else if (b.kind === "table") {
        const n = Math.max(1, ...b.rows.map((r) => r.length));
        const rows = b.rows.map((r) => [...r, ...Array<string>(n - r.length).fill("")]);
        this.table(b.head ? rows[0] : null, b.head ? rows.slice(1) : rows, rows[0].map(() => 1 / n));
      } else await this.image(b.src);
    }
  }
  ensure(h: number) { if (this.y - h < FOOTER_TOP + 8) this.newPage(); }
  gap(h = 6) { this.y -= h; }
  text(s: string, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number; lead?: number } = {}) {
    const size = o.size ?? SIZE; const lead = o.lead ?? size * 1.32; const x = o.x ?? M; const width = o.width ?? W - M - x;
    for (const line of this.wrap(s, width, size, o.bold)) {
      this.ensure(lead);
      this.page.drawText(line, { x, y: this.y - size, size, font: o.bold ? this.bold : this.font, color: o.color ?? INK });
      this.y -= lead;
    }
  }
  heading(s: string, size = 13) { this.ensure(size * 3); this.gap(4); this.text(s, { size, bold: true, lead: size * 1.35 }); this.gap(3); }
  tick(x: number, yTop: number, checked: boolean, page = this.page) {
    page.drawRectangle({ x, y: yTop - 8, width: 8, height: 8, borderColor: INK, borderWidth: 0.7 });
    if (checked) {
      page.drawLine({ start: { x: x + 1.5, y: yTop - 4.2 }, end: { x: x + 3.4, y: yTop - 6.6 }, thickness: 1.2, color: INK });
      page.drawLine({ start: { x: x + 3.4, y: yTop - 6.6 }, end: { x: x + 7, y: yTop - 1.2 }, thickness: 1.2, color: INK });
    }
  }
  /** Ticks with labels in one line; returns the width used. */
  ticks(items: [string, boolean][], x: number, yTop: number, page = this.page): number {
    let cx = x;
    for (const [label, on] of items) {
      this.tick(cx, yTop, on, page);
      const t = this.clean(label);
      page.drawText(t, { x: cx + 11, y: yTop - 7.5, size: 8.5, font: this.font, color: INK });
      cx += 11 + this.width(t, 8.5) + 10;
    }
    return cx - x;
  }
  /** A bordered answer box with the text inside; split over pages when it is long. */
  box(text: string, minLines = 2, x = M, width = W - 2 * M) {
    const lines = this.wrap(text || "", width - 2 * PAD);
    while (lines.length < minLines) lines.push("");
    let i = 0;
    while (i < lines.length) {
      this.ensure(LEAD + 2 * PAD);
      const fit = Math.max(1, Math.floor((this.y - FOOTER_TOP - 8 - 2 * PAD) / LEAD));
      const chunk = lines.slice(i, i + fit);
      const h = chunk.length * LEAD + 2 * PAD;
      this.page.drawRectangle({ x, y: this.y - h, width, height: h, borderColor: LINE, borderWidth: 0.8 });
      chunk.forEach((l, k) => { if (l) this.page.drawText(l, { x: x + PAD, y: this.y - PAD - SIZE - k * LEAD + 1.5, size: SIZE, font: this.font, color: INK }); });
      this.y -= h; i += chunk.length;
      if (i < lines.length) this.newPage();
    }
    this.gap(6);
  }
  /** A table: column widths as fractions; the header row is repeated on a new page. */
  table(header: string[] | null, rows: Cell[][], fractions: number[], o: { x?: number; width?: number; labelColumn?: boolean } = {}) {
    const x0 = o.x ?? M; const total = o.width ?? W - 2 * M;
    const widths = fractions.map((f) => f * total);
    const tickWidth = (c: { ticks: [string, boolean][] }) => c.ticks.reduce((n, [label]) => n + 21 + this.width(this.clean(label), 8.5), 0) - 10;
    // tick boxes that do not fit side by side in their cell are stacked
    const stacked = (c: Cell, ci: number) => typeof c !== "string" && !isSig(c) && tickWidth(c) > widths[ci] - 2 * PAD;
    const draw = (cells: Cell[], head: boolean) => {
      const wrapped = cells.map((c, ci) => (typeof c === "string" ? this.wrap(c, widths[ci] - 2 * PAD, 8.5, head || (o.labelColumn === true && ci === 0)) : isSig(c) ? this.wrap(c.text, widths[ci] - 2 * PAD, 7.5) : null));
      const lineCount = (ci: number) => { const c = cells[ci]; const w = wrapped[ci]; if (isSig(c)) return 0; return w ? w.length : stacked(c, ci) ? (c as { ticks: unknown[] }).ticks.length : 1; };
      const sigHeight = Math.max(0, ...cells.map((c, ci) => (isSig(c) ? (c.sig ? SIG_H + 2 : 0) + (wrapped[ci]?.length ?? 0) * 9.5 : 0)));
      const h = Math.max(Math.max(...cells.map((_, ci) => lineCount(ci))) * 11, sigHeight) + 2 * PAD;
      if (this.y - h < FOOTER_TOP + 8) { this.newPage(); if (header && !head) draw(header, true); }
      let cx = x0;
      cells.forEach((c, ci) => {
        this.page.drawRectangle({ x: cx, y: this.y - h, width: widths[ci], height: h, borderColor: LINE, borderWidth: 0.6, color: head || (o.labelColumn && ci === 0) ? SHADE : undefined });
        const lines = wrapped[ci];
        if (isSig(c)) {
          let top = this.y - PAD;
          if (c.sig) {
            const scale = Math.min((widths[ci] - 2 * PAD) / c.sig.width, SIG_H / c.sig.height);
            this.page.drawImage(c.sig, { x: cx + PAD, y: top - c.sig.height * scale, width: c.sig.width * scale, height: c.sig.height * scale });
            top -= SIG_H + 2;
          }
          (lines ?? []).forEach((l, k) => this.page.drawText(l, { x: cx + PAD, y: top - 7.5 - k * 9.5 + 1.5, size: 7.5, font: this.font, color: GREY }));
        } else if (lines) lines.forEach((l, k) => this.page.drawText(l, { x: cx + PAD, y: this.y - PAD - 8.5 - k * 11 + 1.5, size: 8.5, font: head || (o.labelColumn && ci === 0) ? this.bold : this.font, color: INK }));
        else if (typeof c !== "string") {
          if (stacked(c, ci)) c.ticks.forEach((t, k) => this.ticks([t], cx + PAD, this.y - PAD - k * 11));
          else this.ticks(c.ticks, cx + PAD, this.y - PAD);
        }
        cx += widths[ci];
      });
      this.y -= h;
    };
    if (header) { this.ensure(40); draw(header, true); }
    rows.forEach((r) => draw(r, false));
    this.gap(8);
  }
  /** The workbook's question bar: "Q3 | 2.1.3 | Satisfactory  Yes [x]  No [ ]". */
  questionBar(seq: number | null, number: string, outcome: Outcome | null, markable: boolean) {
    this.ensure(22 + LEAD * 2);
    const h = 18;
    this.page.drawRectangle({ x: M, y: this.y - h, width: W - 2 * M, height: h, color: BAR, borderColor: LINE, borderWidth: 0.6 });
    const left = this.clean(`${seq !== null ? `Q${seq}` : ""}${seq !== null && number ? "    " : ""}${number}`);
    this.page.drawText(left, { x: M + PAD, y: this.y - 12.5, size: 9.5, font: this.bold, color: INK });
    if (markable) {
      const label = "Satisfactory";
      const tickW = 11 + this.width("Yes", 8.5) + 10 + 11 + this.width("No", 8.5);
      const start = W - M - PAD - tickW;
      this.page.drawText(label, { x: start - this.width(label, 8.5, true) - 8, y: this.y - 12.5, size: 8.5, font: this.bold, color: INK });
      this.ticks([["Yes", outcome === "S"], ["No", outcome === "NYS"]], start, this.y - 5);
    }
    this.y -= h + 5;
  }
}

/* -------------------------------------------------------------------- answers as text */

const str = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
const cfg = <T,>(q: Question, k: string, d: T): T => ((q.config?.[k] as T | undefined) ?? d);
interface Opt { id: string; label: string }

/** A short, printable form of an answer (tables and children are drawn separately). */
function answerText(q: Question, v: unknown): string {
  switch (q.type) {
    case "single_choice": { const o = cfg<Opt[]>(q, "options", []).find((x) => x.id === v); return o ? o.label : str(v); }
    case "multi_choice": return (Array.isArray(v) ? v : []).map((id) => cfg<Opt[]>(q, "options", []).find((x) => x.id === id)?.label ?? str(id)).join(", ");
    case "true_false": return v === true ? cfg(q, "trueLabel", "True") : v === false ? cfg(q, "falseLabel", "False") : "";
    case "matching": { const v2 = (v && typeof v === "object" ? v : {}) as Record<string, string>; const right = cfg<Opt[]>(q, "right", []); return cfg<Opt[]>(q, "left", []).map((l) => `${l.label} -> ${right.find((r) => r.id === v2[l.id])?.label ?? "—"}`).join("\n"); }
    case "ordering": { const items = cfg<Opt[]>(q, "items", []); return (Array.isArray(v) ? v : []).map((id, i) => `${i + 1}. ${items.find((x) => x.id === id)?.label ?? str(id)}`).join("\n"); }
    case "fill_blanks": return (Array.isArray(v) ? v : []).map((x, i) => `(${i + 1}) ${str(x)}`).join("   ");
    case "number": { const u = cfg(q, "unit", ""); return v === null || v === undefined || v === "" ? "" : `${str(v)}${u ? ` ${u}` : ""}`; }
    default: return typeof v === "object" && v !== null ? "" : str(v);
  }
}

/** The S / NS tick of a question: its own result, else from its criteria (any NYS = NYS; all criteria S = S). */
export const questionOutcome = (results: ResultRow[], q: Question): Outcome | null => {
  const own = results.find((r) => r.questionId === q.id && !r.criterionId)?.outcome ?? null;
  if (own) return own;
  const crit = results.filter((r) => r.questionId === q.id && r.criterionId && r.outcome);
  if (!crit.length) return null;
  return crit.some((r) => r.outcome === "NYS") ? "NYS" : crit.length >= (q.criteria?.length ?? 1) ? "S" : null;
};

const ANSWERABLE_SKIP = new Set(["instruction", "content"]);

/** Builds the PDF; returns its bytes. */
export async function buildWorkbookPdf(input: WorkbookPdfInput): Promise<Uint8Array> {
  const { definition, attempt, history } = input;
  const tz = input.timeZone ?? "Australia/Melbourne";
  const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz }) : "");
  // item 3: the same details as the student's page (workbookDetails)
  const details = workbookDetails({ history, definition });
  const unit = details.unit;
  const qual = details.qualification;
  const version = definition.source?.version ?? (history.assessment?.versionNo ? String(history.assessment.versionNo) : "1.0");

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${input.title}${history.student?.name ? ` – ${history.student.name}` : ""}`);
  pdf.setProducer("Skyline ERP"); pdf.setCreator("Skyline ERP");
  const L = new Layout(pdf, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold), input);
  // ASM-AI-IMPORT stage 5: every signature picture embedded once
  const sigs = input.signatures ?? [];
  const sigImages = new Map<PdfSignature, PDFImage | null>();
  for (const sg of sigs) {
    let img: PDFImage | null = null;
    if (sg.signaturePng) { try { img = await pdf.embedPng(Uint8Array.from(atob(sg.signaturePng), (c) => c.charCodeAt(0))); } catch { img = null; } }
    sigImages.set(sg, img);
  }
  const sigOf = (kind: PdfSignature["kind"], attemptNo: number) => sigs.find((x) => x.kind === kind && (x.attemptNo ?? attempt.attemptNo) === attemptNo) ?? null;
  const sigCell = (sg: PdfSignature | null): Cell => (sg ? { sig: sigImages.get(sg) ?? null, text: `${sg.signerName} · ${date(sg.signedAt)}` } : "");
  await L.init();

  /* ---- ASM-COVER: the "STUDENT WORKBOOK" page, then the details page (page 1) */
  L.cover(coverLayout({ unit, title: input.title, student: details.student ? { name: details.student.name, ref: details.student.ref } : null }));
  L.newPage();
  L.gap(16);
  L.text(input.title, { size: 20, bold: true, lead: 25 });
  const subline = titleSubline(input.title, unit);
  if (subline) L.text(subline, { size: 12, color: GREY, lead: 16 });
  L.text("Student Assessment Pack", { size: 11, color: GREY, lead: 16 });
  L.gap(14);
  L.heading("1. Student and trainer details", 11);
  L.table(null, detailRows(details), [0.3, 0.7], { labelColumn: true });
  L.heading("2. Qualification and unit of competency", 11);
  L.table(null, qualificationRows(qual, unit), [0.3, 0.7], { labelColumn: true });
  L.heading("3. Assessment Tasks", 11);
  L.table([...TASK_TABLE_HEAD], taskRows(definition), [0.3, 0.7]);
  // item 1: the information (compliance) pages, in every export as in the workbook
  if (definition.instructions) { L.newPage(); L.heading(INFO_HEADING, 14); await L.content(definition.instructions); }
  if (!input.blank) L.text(`Attempt ${attempt.attemptNo}${attempt.receiptNo ? ` · receipt ${attempt.receiptNo}` : ""}${attempt.submittedAt ? ` · submitted ${date(attempt.submittedAt)}` : ""}`, { size: 8.5, color: GREY });

  /* ---- tasks */
  const sheet = buildResultsSheet(definition, history, input.maxAttempts ?? 3);
  const evidenceOf = (qid: string) => attempt.evidence.filter((f) => f.questionId === qid && !f.byAssessor);
  const numbers = workbookNumbering(definition);

  const drawAnswer = (q: Question, scope: Responses) => {
    const assessor = q.assessorOnly === true || q.type === "observation_checklist" || q.type === "third_party_report";
    const v = assessor ? attempt.assessorResponses[q.id] : scope[q.id];
    if (q.type === "table_grid") {
      const columns = cfg<{ id: string; label: string }[]>(q, "columns", []);
      const rows = cfg<{ id: string; label: string }[]>(q, "rows", []);
      const val = (v && typeof v === "object" ? v : {}) as Record<string, Record<string, unknown>>;
      const extra = Object.keys(val).filter((r) => !rows.some((x) => x.id === r)).map((id) => ({ id, label: "" }));
      const all = [...rows, ...extra];
      const labelled = all.some((r) => r.label && !/^\d+$/.test(r.label));
      const head = [...(labelled ? [""] : []), ...columns.map((c) => c.label)];
      const n = head.length || 1;
      const fr = labelled ? [0.26, ...columns.map(() => 0.74 / Math.max(1, columns.length))] : columns.map(() => 1 / Math.max(1, columns.length));
      L.table(head, (all.length ? all : [{ id: "_", label: "" }]).map((r) => [...(labelled ? [r.label] : []), ...columns.map((c) => { const x = val[r.id]?.[c.id]; return x === true ? "Yes" : x === false ? "No" : str(x); })]), fr.length === n ? fr : head.map(() => 1 / n), { labelColumn: labelled });
    } else if (q.type === "observation_checklist") {
      const items = cfg<{ id: string; text: string }[]>(q, "items", []);
      const val = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      L.table(["Observed by the assessor", "Satisfactory"], items.map((it) => [it.text, { ticks: [["Yes", val[it.id] === true], ["No", val[it.id] === false]] }]), [0.74, 0.26]);
      if (str(val.notes)) L.box(`Assessor notes: ${str(val.notes)}`, 1);
    } else if (q.type === "third_party_report") {
      const fields = cfg<{ id: string; label: string }[]>(q, "fields", []);
      const val = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      L.table(null, fields.map((f) => [f.label, str(val[f.id])]), [0.3, 0.7], { labelColumn: true });
    } else if (q.type === "adjustment_record") {
      // item 7: Appendix A – Reasonable Adjustments, as the trainer / assessor recorded it (adjustmentLayout, as on screen)
      const lay = adjustmentLayout(q, v, (d) => date(`${d}T00:00:00`));
      if (lay.intro) L.text(lay.intro, { size: 8, color: GREY });
      L.gap(2);
      L.table(null, lay.facts, [0.3, 0.7], { labelColumn: true });
      if (lay.strategies.length) L.table(["Reasonable adjustment strategy", "Applied"], lay.strategies.map(([text, on]): Cell[] => [text, { ticks: [["", on]] }]), [0.86, 0.14]);
      if (lay.declaration) L.text(lay.declaration, { size: 8, color: GREY });
      L.gap(2);
      L.table(null, lay.sign, [0.3, 0.7], { labelColumn: true });
    } else if (q.type === "declaration") {
      const val = (v && typeof v === "object" ? v : {}) as { agreed?: boolean; signature?: string };
      const text = cfg(q, "text", "");
      if (text) L.text(text, { size: 8.5 });
      L.gap(3);
      const name = val.signature || str(attempt.declaration?.signature);
      const signed = sigOf("student_declaration", attempt.attemptNo);
      L.table(null, [["Student Name", signed?.signerName ?? name], ["Student Signature", signed ? sigCell(signed) : name ? `${name} (typed)` : ""], ["Date", date(signed?.signedAt ?? attempt.submittedAt)], ["Agreed", { ticks: [["I agree to this declaration", Boolean(signed || (val.agreed ?? attempt.declaration?.agreed))]] }]], [0.3, 0.7], { labelColumn: true });
    } else if (q.type === "case_study" || q.type === "repeating_group") {
      const scenario = cfg(q, "scenario", "");
      if (scenario && scenario !== q.label) L.text(scenario, { size: 8.5, color: GREY });
      const entries: Responses[] = q.type === "repeating_group" ? (Array.isArray(v) ? (v as Responses[]) : []) : [(v && typeof v === "object" ? v : {}) as Responses];
      entries.forEach((entry, i) => {
        if (q.type === "repeating_group") L.text(`Entry ${i + 1}`, { size: 8.5, bold: true });
        for (const c of q.children ?? []) {
          if (ANSWERABLE_SKIP.has(c.type)) continue;
          L.text(c.label, { size: 9, bold: true, lead: 12 });
          if (c.helpText) L.text(c.helpText, { size: 8, color: GREY });
          drawAnswer(c, entry);
        }
      });
    } else if (q.type === "file_upload") {
      const files = evidenceOf(q.id);
      L.box(files.length ? `Files submitted: ${files.map((f) => f.fileName).join(", ")}` : "No file submitted.", 1);
    } else {
      L.box(answerText(q, v), q.type === "long_answer" ? 4 : 1);
    }
    if (q.type !== "file_upload" && q.config?.allowAttachment === true) {
      const files = evidenceOf(q.id);
      if (files.length) L.text(`Attached: ${files.map((f) => f.fileName).join(", ")}`, { size: 8, color: GREY });
    }
  };

  for (const [ti, task] of definition.tasks.entries()) {
    L.newPage();
    L.heading(taskHeading(task, ti), 14);
    if (task.instructions) { if (/^\s*</.test(task.instructions)) await L.content(task.instructions); else L.text(task.instructions, { size: 8.5, color: GREY }); }
    for (const s of task.sections) {
      // the blank workbook keeps the briefs; a marked export prints only what was answered
      const qs = s.questions.filter((q) => input.blank || !CONTENT_TYPES.has(q.type));
      if (!qs.length) continue;
      if (sectionShowsTitle(s.title)) L.heading(s.title, 11);
      for (const q of qs) {
        if (CONTENT_TYPES.has(q.type)) { await L.content(cfg(q, "html", "")); L.gap(4); continue; }
        // the question bar: "Q3 | 2.1.3 | Satisfactory Yes / No" (sub-task sections number as the workbook does: 2.1.1, 2.1.2, …)
        const { seq, number, markable } = numbers.get(q.id) ?? { seq: null, number: "", markable: false };
        L.questionBar(seq, number, questionOutcome(attempt.results, q), markable);
        if (q.type !== "declaration") L.text(q.label, { bold: true, size: 9.5 });
        if (q.helpText && q.type !== "declaration" && !helpRepeatsLabel(q)) L.text(q.helpText, { size: 8, color: GREY });
        L.gap(2);
        drawAnswer(q, attempt.responses);
        const fb = attempt.results.find((r) => r.questionId === q.id && !r.criterionId)?.feedback;
        if (fb) L.text(`Assessor feedback: ${fb}`, { size: 8.5, color: GREY });
        L.gap(4);
      }
    }
    // the task's results sheet
    const row = sheet.rows[ti];
    L.heading(`Assessment Task - ${ti + 1} - Results Sheet`, 12);
    L.table(["", ...row.cells.map((c) => ordinal(c.attemptNo))], resultRows(row.cells, date, sigs.length ? (no, kind) => sigCell(sigOf(kind, no)) : null), [0.2, ...row.cells.map(() => 0.8 / row.cells.length)], { labelColumn: true });
  }

  /* ---- overall outcome and declarations */
  L.newPage();
  L.heading("Assessment outcome", 14);
  L.table(["", ...sheet.overall.map((c) => ordinal(c.attemptNo))], resultRows(sheet.overall, date, sigs.length ? (no, kind) => sigCell(sigOf(kind, no)) : null), [0.2, ...sheet.overall.map(() => 0.8 / sheet.overall.length)], { labelColumn: true });
  const decided = [...history.attempts].reverse().find((a) => a.state === "returned" || a.state === "final");
  L.text("Student overall Feedback:", { bold: true });
  L.box(decided?.overallFeedback ?? "", 3);
  L.table(null, [
    ["Student Name", history.student?.name ?? ""],
    ["Student Declaration", sigOf("student_declaration", attempt.attemptNo) ? sigCell(sigOf("student_declaration", attempt.attemptNo)) : attempt.declaration?.signature ? `Signed (typed) by ${str(attempt.declaration.signature)} on ${date(attempt.submittedAt)}` : ""],
    ["Trainer/Assessor", sigOf("assessor_signoff", decided?.attemptNo ?? attempt.attemptNo)?.signerName ?? decided?.assessor ?? history.trainers.join(", ")],
    ...(sigs.length ? [["Assessor Signature", sigCell(sigOf("assessor_signoff", decided?.attemptNo ?? attempt.attemptNo))] as Cell[], ["Student Acknowledgement", sigCell(sigOf("student_acknowledgement", decided?.attemptNo ?? attempt.attemptNo))] as Cell[]] : []),
    ["Date", date(sigOf("assessor_signoff", decided?.attemptNo ?? attempt.attemptNo)?.signedAt ?? decided?.finalisedAt ?? decided?.returnedAt)],
  ], [0.3, 0.7], { labelColumn: true });

  /* ---- footers, now that the page count is known; the cover is not numbered (as the master workbook: "Page 1" follows it) */
  const total = L.pages.length - 1;
  L.pages.forEach((page, k) => {
    if (k === 0) return;
    const i = k - 1;
    page.drawLine({ start: { x: M, y: FOOTER_TOP }, end: { x: W - M, y: FOOTER_TOP }, thickness: 0.6, color: LINE });
    const [a, b, right] = footerParts(version, unit, i + 1, total); const left = L.clean(a); const mid = L.clean(b);
    page.drawText(left, { x: M, y: FOOTER_TOP - 14, size: 8, font: L.font, color: GREY });
    if (mid) page.drawText(mid, { x: (W - L.width(mid, 8)) / 2, y: FOOTER_TOP - 14, size: 8, font: L.font, color: GREY });
    page.drawText(right, { x: W - M - L.width(right, 8), y: FOOTER_TOP - 14, size: 8, font: L.font, color: GREY });
  });
  return pdf.save();
}

const ordinal = (n: number) => (n === 1 ? "First attempt" : n === 2 ? "Second attempt" : n === 3 ? "Third attempt" : `Attempt ${n}`);
function resultRows(cells: SheetCell[], date: (iso: string | null) => string, sign: ((attemptNo: number, kind: PdfSignature["kind"]) => Cell) | null = null): Cell[][] {
  return [
    ["Outcome", ...cells.map((c): Cell => ({ ticks: [["Satisfactory", c.decided && c.result === "S"], ["Not Satisfactory", c.decided && c.result === "NS"]] }))],
    ["Date", ...cells.map((c) => (c.decided ? date(c.date) : ""))],
    ["Assessor", ...cells.map((c) => (c.decided ? c.assessor ?? "" : ""))],
    ["Feedback", ...cells.map((c) => (c.decided ? c.feedback : ""))],
    ...(sign ? [
      ["Assessor signature", ...cells.map((c) => (c.decided ? sign(c.attemptNo, "assessor_signoff") : ""))],
      ["Student acknowledgement", ...cells.map((c) => (c.decided ? sign(c.attemptNo, "student_acknowledgement") : ""))],
    ] : []),
  ];
}
