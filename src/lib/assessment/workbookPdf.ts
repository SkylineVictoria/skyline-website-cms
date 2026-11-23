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
}

const W = 595.28; const H = 841.89; const M = 42;
const HEADER_BOTTOM = H - 104; const FOOTER_TOP = 46;
const INK = rgb(0.1, 0.11, 0.13); const GREY = rgb(0.42, 0.45, 0.5); const LINE = rgb(0.62, 0.65, 0.7); const SHADE = rgb(0.93, 0.94, 0.96);
const BAR = rgb(0.86, 0.89, 0.94);
const SIZE = 9.5; const LEAD = 12.6; const PAD = 5;

type Cell = string | { ticks: [string, boolean][] };

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
    this.newPage();
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
    // header: logo left, institution right
    if (this.logo) {
      const scale = Math.min(150 / this.logo.width, 52 / this.logo.height, 1);
      page.drawImage(this.logo, { x: M, y: H - 30 - this.logo.height * scale, width: this.logo.width * scale, height: this.logo.height * scale });
    }
    let y = H - 34;
    const lines = [this.input.institution.name, ...this.input.institution.lines].filter(Boolean);
    lines.forEach((l, i) => {
      const t = this.clean(l); const size = i === 0 ? 10 : 8; const f = i === 0 ? this.bold : this.font;
      page.drawText(t, { x: W - M - f.widthOfTextAtSize(t, size), y, size, font: f, color: i === 0 ? INK : GREY });
      y -= i === 0 ? 12 : 10;
    });
    page.drawLine({ start: { x: M, y: HEADER_BOTTOM + 8 }, end: { x: W - M, y: HEADER_BOTTOM + 8 }, thickness: 0.8, color: LINE });
    this.y = HEADER_BOTTOM - 4;
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
    const stacked = (c: Cell, ci: number) => typeof c !== "string" && tickWidth(c) > widths[ci] - 2 * PAD;
    const draw = (cells: Cell[], head: boolean) => {
      const wrapped = cells.map((c, ci) => (typeof c === "string" ? this.wrap(c, widths[ci] - 2 * PAD, 8.5, head || (o.labelColumn === true && ci === 0)) : null));
      const h = Math.max(...wrapped.map((w, ci) => (w ? w.length : stacked(cells[ci], ci) ? (cells[ci] as { ticks: unknown[] }).ticks.length : 1))) * 11 + 2 * PAD;
      if (this.y - h < FOOTER_TOP + 8) { this.newPage(); if (header && !head) draw(header, true); }
      let cx = x0;
      cells.forEach((c, ci) => {
        this.page.drawRectangle({ x: cx, y: this.y - h, width: widths[ci], height: h, borderColor: LINE, borderWidth: 0.6, color: head || (o.labelColumn && ci === 0) ? SHADE : undefined });
        const lines = wrapped[ci];
        if (lines) lines.forEach((l, k) => this.page.drawText(l, { x: cx + PAD, y: this.y - PAD - 8.5 - k * 11 + 1.5, size: 8.5, font: head || (o.labelColumn && ci === 0) ? this.bold : this.font, color: INK }));
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
  const unit = definition.source?.unit ?? history.assessment?.unit ?? null;
  const qual = definition.source?.qualification ?? history.assessment?.qualification ?? null;
  const version = definition.source?.version ?? (history.assessment?.versionNo ? String(history.assessment.versionNo) : "1.0");

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${input.title}${history.student?.name ? ` – ${history.student.name}` : ""}`);
  pdf.setProducer("Skyline ERP"); pdf.setCreator("Skyline ERP");
  const L = new Layout(pdf, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold), input);
  await L.init();

  /* ---- cover */
  L.gap(16);
  L.text(input.title, { size: 20, bold: true, lead: 25 });
  if (unit) L.text(`${unit.code} ${unit.name}`, { size: 12, color: GREY, lead: 16 });
  L.text("Student Assessment Pack", { size: 11, color: GREY, lead: 16 });
  L.gap(14);
  L.heading("1. Student and trainer details", 11);
  L.table(null, [
    ["Student Full Name", history.student?.name ?? ""],
    ["Student ID", history.student?.ref ?? ""],
    ["Student Email", history.student?.email ?? ""],
    ["Trainer Full Name", history.trainers.join(", ")],
  ], [0.3, 0.7], { labelColumn: true });
  L.heading("2. Qualification and unit of competency", 11);
  L.table(null, [
    ["Qualification Code", qual?.code ?? ""], ["Qualification Name", qual?.name ?? ""],
    ["Unit Code", unit?.code ?? ""], ["Unit Name", unit?.name ?? ""],
  ], [0.3, 0.7], { labelColumn: true });
  L.heading("3. Assessment Tasks", 11);
  L.table(["Evidence number", "Assessment method / Type of evidence"], definition.tasks.map((t, i) => [`Assessment Task - ${i + 1}`, t.title]), [0.3, 0.7]);
  L.text(`Attempt ${attempt.attemptNo}${attempt.receiptNo ? ` · receipt ${attempt.receiptNo}` : ""}${attempt.submittedAt ? ` · submitted ${date(attempt.submittedAt)}` : ""}`, { size: 8.5, color: GREY });

  /* ---- tasks */
  const sheet = buildResultsSheet(definition, history, input.maxAttempts ?? 3);
  const evidenceOf = (qid: string) => attempt.evidence.filter((f) => f.questionId === qid && !f.byAssessor);
  let seq = 0;

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
      // Appendix A – Reasonable Adjustments, as the trainer / assessor recorded it
      const val = (v && typeof v === "object" ? v : {}) as { applied?: boolean; tasks?: string; categories?: string[]; strategies?: string[]; explanation?: string; assessorName?: string; date?: string; declared?: boolean };
      const intro = cfg(q, "intro", "");
      if (intro) L.text(intro, { size: 8, color: GREY });
      L.gap(2);
      const used = new Set(val.strategies ?? []);
      L.table(null, [
        ["Reasonable adjustments applied", { ticks: [["Yes", val.applied === true], ["No", val.applied === false]] }],
        ["Task name and number", val.tasks ?? ""],
        ["Category", (val.categories ?? []).join(", ")],
        ["Explanation", val.explanation ?? ""],
      ], [0.3, 0.7], { labelColumn: true });
      const strategies = cfg<string[]>(q, "strategies", []);
      if (strategies.length) L.table(["Reasonable adjustment strategy", "Applied"], strategies.map((s): Cell[] => [s, { ticks: [["", used.has(s)]] }]), [0.86, 0.14]);
      L.table(null, [
        ["Trainer/Assessor Name", val.assessorName ?? ""],
        ["Trainer/Assessor Declaration", { ticks: [[val.declared ? "Declared" : "Not declared", Boolean(val.declared)]] }],
        ["Date", val.date ? date(`${val.date}T00:00:00`) : ""],
      ], [0.3, 0.7], { labelColumn: true });
    } else if (q.type === "declaration") {
      const val = (v && typeof v === "object" ? v : {}) as { agreed?: boolean; signature?: string };
      const text = cfg(q, "text", "");
      if (text) L.text(text, { size: 8.5 });
      L.gap(3);
      const name = val.signature || str(attempt.declaration?.signature);
      L.table(null, [["Student Name", name], ["Student Signature", name ? `${name} (typed)` : ""], ["Date", date(attempt.submittedAt)], ["Agreed", { ticks: [["I agree to this declaration", Boolean(val.agreed ?? attempt.declaration?.agreed)]] }]], [0.3, 0.7], { labelColumn: true });
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

  definition.tasks.forEach((task, ti) => {
    L.newPage();
    L.heading(`Assessment Task - ${ti + 1} - ${task.title}`, 14);
    if (task.instructions) L.text(task.instructions, { size: 8.5, color: GREY });
    task.sections.forEach((s) => {
      const qs = s.questions.filter((q) => !ANSWERABLE_SKIP.has(q.type));
      if (!qs.length) return;
      if (s.title && !/^instructions$/i.test(s.title)) L.heading(s.title, 11);
      let n = 0;
      // a sub-task section ("2.1 Project Plan …") numbers its questions as the workbook does: 2.1.1, 2.1.2, …
      const prefix = s.title.match(/^(\d+\.\d+)\b/)?.[1] ?? String(ti + 1);
      qs.forEach((q) => {
        const markable = (q.markingMode ?? "criteria") !== "none";
        const number = q.type === "declaration" ? "Student declaration" : q.type === "adjustment_record" ? "Trainer / assessor record" : `${prefix}.${++n}`;
        L.questionBar(markable ? ++seq : null, number, questionOutcome(attempt.results, q), markable);
        if (q.type !== "declaration") L.text(q.label, { bold: true, size: 9.5 });
        // help text that only repeats the question (an imported long question keeps it whole) is not printed twice
        const repeats = q.helpText ? q.helpText.replace(/\s+/g, " ").trim().startsWith(q.label.replace(/\s+/g, " ").trim().slice(0, 60)) : false;
        if (q.helpText && q.type !== "declaration" && !repeats) L.text(q.helpText, { size: 8, color: GREY });
        L.gap(2);
        drawAnswer(q, attempt.responses);
        const fb = attempt.results.find((r) => r.questionId === q.id && !r.criterionId)?.feedback;
        if (fb) L.text(`Assessor feedback: ${fb}`, { size: 8.5, color: GREY });
        L.gap(4);
      });
    });
    // the task's results sheet
    const row = sheet.rows[ti];
    L.heading(`Assessment Task - ${ti + 1} - Results Sheet`, 12);
    L.table(["", ...row.cells.map((c) => ordinal(c.attemptNo))], resultRows(row.cells, date), [0.2, ...row.cells.map(() => 0.8 / row.cells.length)], { labelColumn: true });
  });

  /* ---- overall outcome and declarations */
  L.newPage();
  L.heading("Assessment outcome", 14);
  L.table(["", ...sheet.overall.map((c) => ordinal(c.attemptNo))], resultRows(sheet.overall, date), [0.2, ...sheet.overall.map(() => 0.8 / sheet.overall.length)], { labelColumn: true });
  const decided = [...history.attempts].reverse().find((a) => a.state === "returned" || a.state === "final");
  L.text("Student overall Feedback:", { bold: true });
  L.box(decided?.overallFeedback ?? "", 3);
  L.table(null, [
    ["Student Name", history.student?.name ?? ""],
    ["Student Declaration", attempt.declaration?.signature ? `Signed (typed) by ${str(attempt.declaration.signature)} on ${date(attempt.submittedAt)}` : ""],
    ["Trainer/Assessor", decided?.assessor ?? history.trainers.join(", ")],
    ["Date", date(decided?.finalisedAt ?? decided?.returnedAt)],
  ], [0.3, 0.7], { labelColumn: true });

  /* ---- footers, now that the page count is known */
  const total = L.pages.length;
  L.pages.forEach((page, i) => {
    page.drawLine({ start: { x: M, y: FOOTER_TOP }, end: { x: W - M, y: FOOTER_TOP }, thickness: 0.6, color: LINE });
    const left = L.clean(`Version Number: ${version}`); const mid = L.clean(unit ? `Unit Code: ${unit.code}` : ""); const right = `Page ${i + 1} of ${total}`;
    page.drawText(left, { x: M, y: FOOTER_TOP - 14, size: 8, font: L.font, color: GREY });
    if (mid) page.drawText(mid, { x: (W - L.width(mid, 8)) / 2, y: FOOTER_TOP - 14, size: 8, font: L.font, color: GREY });
    page.drawText(right, { x: W - M - L.width(right, 8), y: FOOTER_TOP - 14, size: 8, font: L.font, color: GREY });
  });
  return pdf.save();
}

const ordinal = (n: number) => (n === 1 ? "First attempt" : n === 2 ? "Second attempt" : n === 3 ? "Third attempt" : `Attempt ${n}`);
function resultRows(cells: SheetCell[], date: (iso: string | null) => string): Cell[][] {
  return [
    ["Outcome", ...cells.map((c): Cell => ({ ticks: [["Satisfactory", c.decided && c.result === "S"], ["Not Satisfactory", c.decided && c.result === "NS"]] }))],
    ["Date", ...cells.map((c) => (c.decided ? date(c.date) : ""))],
    ["Assessor", ...cells.map((c) => (c.decided ? c.assessor ?? "" : ""))],
    ["Feedback", ...cells.map((c) => (c.decided ? c.feedback : ""))],
  ];
}
