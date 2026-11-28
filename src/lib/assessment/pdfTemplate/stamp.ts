/**
 * ASM-PDF-TEMPLATE phase 3: the original workbook PDF with every value printed in its place (pdf-lib, browser and Node).
 *  - text in its box at the largest size from 10 to 8 pt that holds it; an answer box that goes on at the top of the next page takes
 *    the rest; what still does not fit goes on a "continued" page inserted right after the page it overflows (never cut);
 *  - ticks drawn in their circle / square; signatures drawn into their line; nothing of the original page is changed.
 *  - ASM-ANY-LAYOUT (2026-11-27): on a workbook of another layout (generic detector) a box that cannot hold its answer even at 8 pt (a
 *    small Word box that "expands as you type") prints "See answer page N", and the full answer goes on answer pages added after the
 *    last page of its task, each answer starting with its question number and text. The SLIT design keeps its continued pages.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { questionName, type PdfTemplate, type TemplateField } from "./model";
import { fitChain, questionInputs, wrap, LINE_HEIGHT, FIT_PADDING } from "./student";
import type { StampValue } from "./output";

const INK = { student: rgb(0.05, 0.1, 0.3), trainer: rgb(0.55, 0.08, 0.08), record: rgb(0.1, 0.1, 0.1) };
const MARGIN = 50;

interface Block { page: number; title: string; lines: string[]; size: number; by: "student" | "trainer" | "record" }
/** An answer printed in full on the answer pages at the end of its task (generic layouts). */
interface AnswerBlock { after: number; title: string; question: string; text: string; by: "student" | "trainer" | "record"; box: TemplateField; pageNo?: number }
const ANSWER_SIZE = 10;
export interface StampResult { bytes: Uint8Array; continued: { afterPage: number; pages: number }[] }

export async function stampPdf(original: Uint8Array, t: PdfTemplate, values: Map<string, StampValue>, opts: {
  footer?: string; continuedAtEnd?: boolean;
  /** LETTERHEAD-DESIGNER: a one-page PDF whose top `height` points are the letterhead strip, drawn on every page added here (the
   *  continued and answer pages); the trainer's own pages are never changed. */
  letterhead?: { pdf: Uint8Array; height: number } | null;
} = {}): Promise<StampResult> {
  const lift = opts.letterhead ? Math.min(90, Math.max(0, opts.letterhead.height)) : 0;
  const added: PDFPage[] = [];
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = safeText(font);
  const measure = (s: string, size: number) => font.widthOfTextAtSize(safe(s), size);
  const pages = doc.getPages();
  const blocks: Block[] = [];
  const done = new Set<string>();
  const byId = new Map(t.fields.map((f) => [f.id, f] as const));

  const drawLines = (page: PDFPage, f: TemplateField, lines: string[], size: number, by: "student" | "trainer" | "record") => {
    const { width: W, height: H } = page.getSize();
    const x = f.x * W + FIT_PADDING; let top = f.y * H + FIT_PADDING;
    for (const line of lines) {
      top += size * LINE_HEIGHT;
      page.drawText(safe(line), { x, y: H - top + size * 0.25, size, font, color: INK[by] });
    }
    void W;
  };
  const answerPages = (t.detected?.by ?? "").startsWith("asm-pdf-generic");
  const answers: AnswerBlock[] = [];
  const taskEnd = (page: number) => {
    const p = t.pages[page - 1];
    const task = p?.task != null ? t.tasks.find((x) => x.number === String(p.task)) : null;
    return task ? Math.max(task.lastPage, page) : page;
  };
  const putText = (chain: TemplateField[], value: string, by: "student" | "trainer" | "record", title: string, question = "") => {
    const boxes = chain.map((b) => { const p = pages[b.page - 1]; const { width: W, height: H } = p.getSize(); return { page: b.page, wPt: b.w * W, hPt: b.h * H }; });
    const fit = fitChain(value, boxes, measure);
    if (answerPages && fit.overflow.length) { answers.push({ after: taskEnd(chain[chain.length - 1].page), title, question, text: value, by, box: chain[0] }); return; }
    fit.boxes.forEach((b, i) => drawLines(pages[chain[i].page - 1], chain[i], b.lines, fit.size, by));
    if (fit.overflow.length) blocks.push({ page: chain[chain.length - 1].page, title, lines: fit.overflow, size: fit.size, by });
  };

  // question answers first: their text flows through the boxes that carry on onto the next page
  for (const q of t.questions) {
    for (const inp of questionInputs(t, q.key)) {
      if (inp.kind !== "text") continue;
      const v = values.get(inp.field.id);
      for (const b of inp.boxes) done.add(b.id);
      if (v?.kind === "text") putText(inp.boxes, v.text, v.by, `${questionName(q)}${inp.field.label && inp.field.label !== "Answer" && inp.field.label !== questionName(q) ? ` · ${inp.field.label}` : ""}`, q.label);
    }
  }
  for (const [id, v] of values) {
    if (done.has(id)) continue;
    const f = byId.get(id); if (!f) continue;
    const page = pages[f.page - 1]; if (!page) continue;
    const { width: W, height: H } = page.getSize();
    const box = { x: f.x * W, y: H - (f.y + f.h) * H, w: f.w * W, h: f.h * H };
    if (v.kind === "tick") drawTick(page, box, INK[v.by]);
    else if (v.kind === "png") {
      try {
        const data = base64(v.png);
        // a damaged picture can stall the PNG decoder: only a whole PNG (signature, IHDR, IEND) is drawn, else the signer's name
        if (!isWholePng(data)) throw new Error("not a PNG");
        const img = await doc.embedPng(data);
        const scale = Math.min(box.w / img.width, (box.h * 1.6) / img.height);
        const w = img.width * scale, h = img.height * scale;
        page.drawImage(img, { x: box.x + 2, y: box.y + Math.max(0, (box.h - h) / 2), width: w, height: h });
      } catch { drawLines(page, f, [v.name], 9, v.by); }
    } else {
      const q = f.questionKey ? t.questions.find((x) => x.key === f.questionKey) : null;
      putText([f], v.text, v.by, `${q ? `${questionName(q)} · ` : ""}${f.table?.rowLabel ? `${f.table.rowLabel} · ` : ""}${f.table?.column ?? f.label}`);
    }
  }

  // answer pages (generic layouts): laid out first so each box can say on which page its answer is, then added after each task
  if (answers.length) {
    const groups = [...new Set(answers.map((a) => a.after))].sort((a, b) => a - b);
    const plan: { after: number; pages: { a: AnswerBlock; kind: "title" | "question" | "line"; text: string }[][] }[] = [];
    let shift = 0;
    for (const g of groups) {
      const { width: W, height: H } = pages[g - 1].getSize();
      const out: { a: AnswerBlock; kind: "title" | "question" | "line"; text: string }[][] = [[]];
      let y = H - MARGIN - 18 - lift;
      const room = (h: number) => { if (y - h < MARGIN) { out.push([]); y = H - MARGIN - 18 - lift; } };
      for (const a of answers.filter((x) => x.after === g)) {
        room(11 * LINE_HEIGHT * 3);
        a.pageNo = g + shift + out.length;
        out[out.length - 1].push({ a, kind: "title", text: a.title }); y -= 11 * LINE_HEIGHT + 2;
        for (const line of a.question ? wrap(a.question, W - 2 * MARGIN, 9, measure) : []) { room(9 * LINE_HEIGHT); out[out.length - 1].push({ a, kind: "question", text: line }); y -= 9 * LINE_HEIGHT; }
        y -= 4;
        for (const para of a.text.split(String.fromCharCode(10))) for (const line of wrap(para || " ", W - 2 * MARGIN, ANSWER_SIZE, measure)) { room(ANSWER_SIZE * LINE_HEIGHT); out[out.length - 1].push({ a, kind: "line", text: line }); y -= ANSWER_SIZE * LINE_HEIGHT; }
        y -= 10;
      }
      plan.push({ after: g, pages: out });
      shift += out.length;
    }
    for (const a of answers) drawLines(pages[a.box.page - 1], a.box, [`See answer page ${a.pageNo}`], 9, a.by);
    for (const g of [...plan].reverse()) {
      const { width: W, height: H } = pages[g.after - 1].getSize();
      g.pages.forEach((items, i) => {
        const page = doc.insertPage(g.after + i, [W, H]); added.push(page);
        page.drawText(safe(`Answers (continued from page ${g.after})`), { x: MARGIN, y: H - MARGIN + 8 - lift, size: 11, font: bold, color: rgb(0.2, 0.2, 0.2) });
        let y = H - MARGIN - 18 - lift;
        for (const it of items) {
          if (it.kind === "title") { page.drawText(safe(it.text), { x: MARGIN, y, size: 11, font: bold, color: INK[it.a.by] }); y -= 11 * LINE_HEIGHT + 2; }
          else if (it.kind === "question") { page.drawText(safe(it.text), { x: MARGIN, y, size: 9, font: bold, color: rgb(0.25, 0.25, 0.25) }); y -= 9 * LINE_HEIGHT; }
          else { page.drawText(safe(it.text), { x: MARGIN, y, size: ANSWER_SIZE, font, color: INK[it.a.by] }); y -= ANSWER_SIZE * LINE_HEIGHT; }
          if (it.kind === "question" && items[items.indexOf(it) + 1]?.kind === "line") y -= 4;
        }
      });
    }
  }

  // continued pages, right after the page each answer overflows (inserted from the last page back, so the numbers hold)
  const continued: StampResult["continued"] = [];
  // continuedAtEnd (the marking view): after the last page instead, so every original page keeps its number under the trainer's fields
  const atEnd = !!opts.continuedAtEnd;
  const pagesWith = [...new Set(blocks.map((b) => b.page))].sort((a, b) => (atEnd ? a - b : b - a));
  for (const p of pagesWith) {
    const { width: W, height: H } = pages[p - 1].getSize();
    let index = atEnd ? doc.getPageCount() : p; // after page p (0-based index p), or at the end
    let page = doc.insertPage(index, [W, H]); added.push(page); let count = 1;
    let y = H - MARGIN - lift;
    const heading = (pg: PDFPage) => { pg.drawText(safe(`Continued from page ${p}`), { x: MARGIN, y: H - MARGIN + 8 - lift, size: 11, font: bold, color: rgb(0.2, 0.2, 0.2) }); };
    heading(page); y -= 18;
    for (const b of blocks.filter((x) => x.page === p)) {
      const lines = wrap(b.lines.join(" "), W - 2 * MARGIN, b.size, measure);
      const need = () => { if (y < MARGIN + b.size * LINE_HEIGHT) { index += 1; page = doc.insertPage(index, [W, H]); added.push(page); count += 1; heading(page); y = H - MARGIN - 18 - lift; } };
      need();
      page.drawText(safe(`${b.title} (continued)`), { x: MARGIN, y, size: 9, font: bold, color: INK[b.by] }); y -= 9 * LINE_HEIGHT + 2;
      for (const line of lines) { need(); page.drawText(safe(line), { x: MARGIN, y, size: b.size, font, color: INK[b.by] }); y -= b.size * LINE_HEIGHT; }
      y -= 8;
    }
    continued.push({ afterPage: p, pages: count });
  }
  if (opts.letterhead && added.length) {
    try {
      const src = await PDFDocument.load(opts.letterhead.pdf);
      const sp = src.getPage(0); const { width: LW, height: LH } = sp.getSize();
      const strip = await doc.embedPage(sp, { left: 0, bottom: LH - lift, right: LW, top: LH });
      for (const pg of added) { const { width: W, height: H } = pg.getSize(); const k = W / LW; pg.drawPage(strip, { x: 0, y: H - lift * k, xScale: k, yScale: k }); }
    } catch { /* a letterhead that cannot be read is left out; the pages are complete without it */ }
  }
  if (opts.footer) for (const pg of doc.getPages()) pg.drawText(safe(opts.footer), { x: MARGIN, y: 12, size: 6, font, color: rgb(0.45, 0.45, 0.45) });
  return { bytes: await doc.save(), continued: atEnd ? continued : continued.reverse() };
}

function drawTick(page: PDFPage, b: { x: number; y: number; w: number; h: number }, color: ReturnType<typeof rgb>) {
  const s = Math.min(b.w, b.h);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const p1 = { x: cx - s * 0.32, y: cy }, p2 = { x: cx - s * 0.08, y: cy - s * 0.28 }, p3 = { x: cx + s * 0.38, y: cy + s * 0.34 };
  page.drawLine({ start: p1, end: p2, thickness: Math.max(1, s * 0.12), color });
  page.drawLine({ start: p2, end: p3, thickness: Math.max(1, s * 0.12), color });
}

function isWholePng(b: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 60 || !sig.every((x, i) => b[i] === x)) return false;
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(12) !== "IHDR") return false;
  // walk the chunks to IEND; every chunk must fit in the file
  let o = 8;
  while (o + 12 <= b.length) {
    const len = ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
    const name = tag(o + 4);
    if (o + 12 + len > b.length) return false;
    if (name === "IEND") return true;
    o += 12 + len;
  }
  return false;
}

function base64(s: string): Uint8Array {
  const bin = atob(s.replace(/^data:image\/png;base64,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The standard font prints Windows-1252 only: other characters become their nearest plain form, else "?". */
function safeText(font: PDFFont) {
  const ok = new Map<string, boolean>();
  const plain: Record<string, string> = { "‘": "'", "’": "'", "“": "\"", "”": "\"", "–": "-", "—": "-", "…": "...", " ": " ", "\t": " " };
  return (s: string) => Array.from(s.replace(/\r/g, ""), (c) => {
    if (c === "\n") return " ";
    let good = ok.get(c);
    if (good === undefined) { try { font.encodeText(c); good = true; } catch { good = false; } ok.set(c, good); }
    return good ? c : plain[c] ?? "?";
  }).join("");
}
