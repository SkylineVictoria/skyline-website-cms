/**
 * ASM-QUESTION-TEXT (owner 2026-11-27): a question is shown as text, read word for word from the workbook PDF's text layer (code only,
 * never AI), with its bold / italic runs, line breaks, lists and sub-parts (a, b, c). The printed label ("Q1", "Question 1", "2.1.8")
 * becomes the one heading and is left out of the text. Pictures printed in the question area (between the question and its first
 * answer box) are returned as page rects to show as crops. A page without a text layer (a scan) gives `scanned`: the wizard then shows
 * the crop of the question, padded, as before.
 *
 * Pure (Node tests and the browser): pageInk() reads one page with pdf.js; readQuestion() works on that.
 */
import { questionName, type PdfTemplate, type Rect, type TemplateQuestion } from "./model";
import { pageModel, type Box, type DrawnLine, type DrawnRect, type PdfJsLike } from "./pageModel";

/** A text item in PDF points, origin top-left; y = top of the glyphs, base = baseline. */
export interface InkText { s: string; x: number; y: number; w: number; h: number; base: number; bold: boolean; italic: boolean }
export interface PageInk { page: number; W: number; H: number; texts: InkText[]; images: Box[]; lines: DrawnLine[]; rects: DrawnRect[] }

interface PdfPageInkLike {
  getViewport(o: { scale: number }): { width: number; height: number };
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  getTextContent(): Promise<{ items: unknown[] }>;
  commonObjs?: { get(id: string): unknown };
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: number[]): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

/** One page as the question reader needs it: text with its font weight / style, raster images and ruled lines. */
export async function pageInk(pdfjs: PdfJsLike, page: PdfPageInkLike, number: number): Promise<PageInk> {
  const OPS = pdfjs.OPS;
  const model = await pageModel(pdfjs, page, number);
  const { W, H } = model;
  const list = await page.getOperatorList();
  const images: Box[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup].filter((x) => x != null));
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, list.argsArray[i] as number[]);
    else if (IMG.has(fn)) {
      // an image is drawn into the unit square of the current matrix
      const xs = [ctm[4], ctm[4] + ctm[0], ctm[4] + ctm[2], ctm[4] + ctm[0] + ctm[2]];
      const ys = [ctm[5], ctm[5] + ctm[1], ctm[5] + ctm[3], ctm[5] + ctm[1] + ctm[3]];
      const x = Math.min(...xs); const top = H - Math.max(...ys);
      images.push({ x, y: top, w: Math.max(...xs) - x, h: Math.max(...ys) - Math.min(...ys) });
    }
  }
  const tc = await page.getTextContent();
  const fonts = new Map<string, { bold: boolean; italic: boolean }>();
  const styleOf = (fontName: string | undefined) => {
    if (!fontName) return { bold: false, italic: false };
    let s = fonts.get(fontName);
    if (!s) {
      let name = "";
      try { const o = page.commonObjs?.get(fontName) as { name?: string; bold?: boolean; italic?: boolean } | undefined; name = `${o?.name ?? ""}`; s = { bold: !!o?.bold || /bold|black|heavy|semibold|demi/i.test(name), italic: !!o?.italic || /italic|oblique/i.test(name) }; }
      catch { s = { bold: false, italic: false }; }
      fonts.set(fontName, s);
    }
    return s;
  };
  const texts: InkText[] = [];
  for (const raw of tc.items as { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string }[]) {
    const s = raw.str ?? "";
    if (!s.trim() || !raw.transform) continue;
    const h = Math.abs(raw.transform[3]) || raw.height || 10;
    const base = H - raw.transform[5];
    texts.push({ s, x: raw.transform[4], y: base - h * 0.8, w: raw.width ?? s.length * h * 0.5, h, base, ...styleOf(raw.fontName) });
  }
  return { page: number, W, H, texts, images, lines: model.lines, rects: model.rects };
}

/* ------------------------------------------------------------------ the question's content */
export interface Run { text: string; bold?: boolean; italic?: boolean }
/** p: a paragraph; li: a list item (bullet or number, `marker` as printed); part: a lettered sub-part ("a.", "(b)", "ii)"). */
export interface TextBlock { kind: "p" | "li" | "part"; marker?: string; lines: Run[][] }
export interface QuestionContent { blocks: TextBlock[]; figures: Rect[]; scanned: boolean; plain: string }

/** Where the question's own words are printed (the header row without the trainer's Satisfactory column). */
export const questionTextRect = (q: TemplateQuestion): Rect => q.prompt ?? q.header;

/**
 * The area under the question text, down to its first answer box on that page: where a picture the student must look at is printed.
 * Text there is not read (it is the answer table's column headings or the answer boxes' labels, shown with the inputs).
 */
export function questionFigureArea(t: PdfTemplate, q: TemplateQuestion): Rect {
  const r = questionTextRect(q);
  const bottom = r.y + r.h;
  const below = t.fields.filter((f) => f.page === r.page && f.y >= bottom - 0.002 && f.x < r.x + r.w && f.x + f.w > r.x).map((f) => f.y);
  const areaTops = q.areas.filter((a) => a.page === r.page && a.y >= bottom - 0.002).map((a) => a.y);
  const end = Math.min(0.93, ...below, ...(below.length ? [] : areaTops));
  return { page: r.page, x: q.header.x, y: r.y, w: q.header.w, h: Math.max(r.h, end - r.y) };
}

const BULLETS = new Set(["•", "●", "▪", "■", "◦", "○", "‣", "⁃", "–", "-", "·", "o", "", "", "§", "Ø", "ü", "✓", "✔", "➢", "►", "▶"]);
const isBulletGlyph = (s: string) => {
  const t = s.trim();
  if (!t) return false;
  if (t.length === 1 && (BULLETS.has(t) || t.charCodeAt(0) < 32 || (t.charCodeAt(0) >= 0xf000 && t.charCodeAt(0) <= 0xf0ff))) return true;
  return false;
};
const PART_RE = /^(\(?(?:[a-z]|[ivx]{1,4})[.)])(?:\s+|$)/;
const NUM_RE = /^(\d{1,2}[.)])(?:\s+|$)/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const clean = (s: string) => Array.from(s, (c) => (c.charCodeAt(0) < 32 ? " " : c)).join("");

/** The labels the question is printed with (left out of its text): its name, running number, key, "Question n". */
export function questionLabels(q: TemplateQuestion): string[] {
  const n = q.seq.replace(/^Q/i, "");
  const set = new Set([questionName(q), q.seq, q.key, `Q${q.key}`, `Question ${n}`, `Q${n}`, `${n}.`, `Q ${n}`].map(norm).filter(Boolean));
  if (q.display) set.add(norm(q.display));
  return [...set];
}

interface Line { base: number; h: number; items: InkText[]; left: number; right: number }

/**
 * Reads a question's words from its page: the text items inside `rect` (by their centre), grouped into lines by baseline, the label
 * dropped, then paragraphs, list items and parts. Words are never changed; only spacing is normalised (a line wrapped by the page's
 * width is joined back, a short line or one ending with ":" keeps its break).
 */
export function readQuestion(ink: PageInk, rect: Rect, labels: string[], figureArea: Rect | null = null): QuestionContent {
  const R = { x: rect.x * ink.W, y: rect.y * ink.H, w: rect.w * ink.W, h: rect.h * ink.H };
  const inside = (t: InkText) => { const cx = t.x + Math.min(t.w, R.w) / 2; const cy = t.y + t.h / 2; return cx >= R.x - 1 && cx <= R.x + R.w + 1 && cy >= R.y - 1 && cy <= R.y + R.h + 1 && t.x >= R.x - 2; };
  let items = ink.texts.filter(inside).map((t) => ({ ...t, s: clean(t.s) })).filter((t) => t.s.trim());
  const figures = figuresIn(ink, figureArea ?? rect);
  if (!items.length) return { blocks: [], figures, scanned: !ink.texts.length, plain: "" };
  // an answer table that starts inside the rect (its ruled heading row): its column headings are shown with the table's inputs
  const firstBottom = Math.min(...items.map((t) => t.base));
  // (a rule drawn as one line, or cell by cell: the segments at one height covering half the rect's width)
  const segs = [...ink.lines.filter((l) => l.dir === "h").map((l) => ({ y: l.y, x: l.x, w: l.w })),
    ...ink.rects.filter((r) => r.h > 6).map((r) => ({ y: r.y, x: r.x, w: r.w }))]
    .filter((l) => l.x < R.x + R.w && l.x + l.w > R.x && l.y > firstBottom + 2 && l.y < R.y + R.h - 3)
    .sort((a, b) => a.y - b.y);
  let cut = Infinity;
  for (const s of segs) {
    const row = segs.filter((o) => Math.abs(o.y - s.y) <= 1.5);
    const covered = row.reduce((n, o) => n + Math.max(0, Math.min(o.x + o.w, R.x + R.w) - Math.max(o.x, R.x)), 0);
    if (covered >= 0.5 * R.w) { cut = s.y; break; }
  }
  // without rules: a later line of three or more short cells far apart (column headings)
  const byBase = new Map<number, InkText[]>();
  for (const t of items) { const k = [...byBase.keys()].find((b) => Math.abs(b - t.base) <= 2) ?? t.base; byBase.set(k, [...(byBase.get(k) ?? []), t]); }
  for (const [base, row] of [...byBase.entries()].sort((a, b) => a[0] - b[0])) {
    if (base <= firstBottom + 2 || row.length < 3) continue;
    const xs = [...row].sort((a, b) => a.x - b.x);
    const apart = xs.slice(1).every((t, i) => t.x - (xs[i].x + xs[i].w) > 2.5 * t.h);
    if (apart && xs.every((t) => t.s.trim().split(/\s+/).length <= 4)) { cut = Math.min(cut, Math.min(...row.map((t) => t.y)) - 1); break; }
  }
  if (cut < Infinity) items = items.filter((t) => t.y + 1 < cut);

  // lines by baseline
  const lines: Line[] = [];
  for (const it of [...items].sort((a, b) => a.base - b.base || a.x - b.x)) {
    const l = lines.find((x) => Math.abs(x.base - it.base) <= Math.max(2, 0.4 * Math.min(x.h, it.h)));
    if (l) { l.items.push(it); l.h = Math.max(l.h, it.h); } else lines.push({ base: it.base, h: it.h, items: [it], left: 0, right: 0 });
  }
  for (const l of lines) { l.items.sort((a, b) => a.x - b.x); l.left = l.items[0].x; l.right = Math.max(...l.items.map((i) => i.x + i.w)); }
  lines.sort((a, b) => a.base - b.base);

  // the printed label: the first items of the first lines (a number cell, then the name on the text column's first line)
  const labelSet = new Set(labels.map((x) => norm(x).toLowerCase()));
  for (let pass = 0; pass < 4 && lines.length; pass++) {
    const first = lines[0].items[0];
    const s = norm(first.s);
    if (labelSet.has(s.toLowerCase())) { lines[0].items.shift(); }
    else {
      const pre = [...labelSet].find((lab) => s.toLowerCase().startsWith(lab + " ") && lab.length >= 2);
      if (!pre) break;
      first.s = first.s.trimStart().slice(pre.length).trimStart();
      first.x += first.w * (pre.length / Math.max(1, s.length)); first.w *= 1 - pre.length / Math.max(1, s.length);
      if (!first.s.trim()) lines[0].items.shift();
      break;
    }
    if (!lines[0].items.length) lines.shift();
    else { lines[0].left = lines[0].items[0].x; }
  }
  // a label printed alone on a line of its own (the number cell beside the text column) on a later line
  for (const l of lines) if (l.items.length && l.items[0].x < R.x + 0.12 * R.w && labelSet.has(norm(l.items[0].s).toLowerCase()) && l.items.length > 1) l.items.shift();
  const kept = lines.filter((l) => l.items.length);
  for (const l of kept) { l.left = l.items[0].x; l.right = Math.max(...l.items.map((i) => i.x + i.w)); }
  if (!kept.length) return { blocks: [], figures, scanned: false, plain: "" };

  const textLeft = Math.min(...kept.map((l) => l.left));
  const maxRight = Math.max(...kept.map((l) => l.right));
  const blocks: TextBlock[] = [];
  let prev: Line | null = null;
  let markerX = 0;
  for (const l of kept) {
    const runs = lineRuns(l.items);
    const firstText = runs.map((r) => r.text).join("").trimStart();
    let kind: TextBlock["kind"] | null = null; let marker: string | undefined;
    if (isBulletGlyph(l.items[0].s)) { kind = "li"; marker = "•"; dropLead(runs, l.items[0].s); }
    else {
      const m = PART_RE.exec(firstText) ?? null; const n = m ? null : NUM_RE.exec(firstText);
      if (m && (m[1].length <= 3 || /^\(/.test(m[1]))) { kind = "part"; marker = m[1]; dropLead(runs, m[0]); }
      else if (n) { kind = "li"; marker = n[1]; dropLead(runs, n[0]); }
    }
    const cur = blocks[blocks.length - 1];
    const gap = prev ? l.base - prev.base : 0;
    const newPara = !prev || gap > 1.75 * Math.max(prev.h, l.h);
    if (kind) { blocks.push({ kind, marker, lines: [trimRuns(runs)] }); markerX = l.left; }
    else if (!cur || newPara) blocks.push({ kind: "p", lines: [trimRuns(runs)] });
    else if ((cur.kind === "li" || cur.kind === "part") && l.left <= markerX + 1 && l.left <= textLeft + 1 && gap > 1.4 * l.h) blocks.push({ kind: "p", lines: [trimRuns(runs)] });
    else {
      const prevText = cur.lines[cur.lines.length - 1].map((r) => r.text).join("").trimEnd();
      // a line that changes style throughout (a bold sub-heading after plain text) keeps its break
      const styleOf = (rs: Run[]) => rs.filter((r) => r.text.trim()).every((r) => r.bold) ? "b" : rs.filter((r) => r.text.trim()).every((r) => !r.bold) ? "n" : "m";
      const restyled = styleOf(runs) !== "m" && styleOf(cur.lines[cur.lines.length - 1]) !== "m" && styleOf(runs) !== styleOf(cur.lines[cur.lines.length - 1]);
      const resized = Math.abs(l.h - prev!.h) > 1;
      const hard = restyled || resized || /[:;]$/.test(prevText) || (prev!.right < maxRight - 0.18 * (maxRight - textLeft) && !/[,\-–]$/.test(prevText));
      if (hard) cur.lines.push(trimRuns(runs));
      else { const last = cur.lines[cur.lines.length - 1]; pushRuns(last, [{ text: " " }, ...runs]); cur.lines[cur.lines.length - 1] = trimRuns(last); }
    }
    prev = l;
  }
  const out = blocks.map((b) => ({ ...b, lines: b.lines.map(mergeRuns).filter((x) => x.length) })).filter((b) => b.lines.length);
  return { blocks: out, figures, scanned: false, plain: plainText(out) };
}

function lineRuns(items: InkText[]): Run[] {
  const runs: Run[] = [];
  let prev: InkText | null = null;
  for (const it of items) {
    let s = it.s;
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > 0.15 * Math.min(prev.h, it.h) && !/\s$/.test(prev.s) && !/^\s/.test(s)) s = " " + s;
    }
    pushRuns(runs, [{ text: s, bold: it.bold || undefined, italic: it.italic || undefined }]);
    prev = it;
  }
  return runs;
}
function pushRuns(into: Run[], add: Run[]) {
  for (const r of add) {
    const last = into[into.length - 1];
    // a space takes the style of the run before it
    if (last && (r.text.trim() === "" || (!!last.bold === !!r.bold && !!last.italic === !!r.italic))) last.text += r.text;
    else into.push({ ...r });
  }
}
const mergeRuns = (runs: Run[]): Run[] => { const out: Run[] = []; pushRuns(out, runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, " ") }))); return trimRuns(out); };
function trimRuns(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }));
  while (out.length && !out[0].text.trim()) out.shift();
  while (out.length && !out[out.length - 1].text.trim()) out.pop();
  if (out.length) { out[0].text = out[0].text.trimStart(); out[out.length - 1].text = out[out.length - 1].text.trimEnd(); }
  return out;
}
/** Removes `lead` (a marker) from the start of the line's runs. */
function dropLead(runs: Run[], lead: string) {
  let rest = lead.trimStart().length;
  while (rest > 0 && runs.length) {
    const r = runs[0]; const t = r.text.trimStart();
    if (t.length <= rest) { rest -= t.length; runs.shift(); continue; }
    r.text = t.slice(rest).trimStart(); rest = 0;
  }
  // a separate space item after the marker
  while (runs.length && !runs[0].text.trim()) runs.shift();
}
export const plainText = (blocks: TextBlock[]) => blocks.map((b) => (b.marker ? b.marker + " " : "") + b.lines.map((l) => l.map((r) => r.text).join("")).join("\n")).join("\n\n");

/** Pictures the student must look at: raster images in the area (not page logos), padded a little; as page fractions. */
export function figuresIn(ink: PageInk, area: Rect): Rect[] {
  const A = { x: area.x * ink.W, y: area.y * ink.H, w: area.w * ink.W, h: area.h * ink.H };
  const out: Rect[] = [];
  for (const im of ink.images) {
    if (im.w < 24 || im.h < 24) continue;
    const ix = Math.max(0, Math.min(im.x + im.w, A.x + A.w) - Math.max(im.x, A.x));
    const iy = Math.max(0, Math.min(im.y + im.h, A.y + A.h) - Math.max(im.y, A.y));
    if (ix * iy < 0.5 * im.w * im.h) continue;
    const pad = 4;
    const x = Math.max(0, im.x - pad); const y = Math.max(0, im.y - pad);
    const r: Rect = { page: ink.page, x: x / ink.W, y: y / ink.H, w: (Math.min(ink.W, im.x + im.w + pad) - x) / ink.W, h: (Math.min(ink.H, im.y + im.h + pad) - y) / ink.H };
    if (!out.some((o) => Math.abs(o.x - r.x) < 0.005 && Math.abs(o.y - r.y) < 0.005)) out.push(r);
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The question read from its page (the page's ink from pageInk). A part printed in the question that is also the label of one of its
 * answer boxes ("a. Australian and other relevant Standards") is left out here: it is shown once, above its answer box.
 */
export function questionContent(t: PdfTemplate, q: TemplateQuestion, ink: PageInk): QuestionContent {
  const c = readQuestion(ink, questionTextRect(q), questionLabels(q), questionFigureArea(t, q));
  const answerLabels = new Set(t.fields.filter((f) => f.questionKey === q.key && f.role === "student").map((f) => norm(f.label).toLowerCase()));
  const blocks = c.blocks.filter((b) => !(b.kind === "part" && answerLabels.has(norm(`${b.marker} ${b.lines.map((l) => l.map((r) => r.text).join("")).join(" ")}`).toLowerCase())));
  return blocks.length === c.blocks.length || !blocks.length ? c : { ...c, blocks, plain: plainText(blocks) };
}

/**
 * ASM-QUESTION-POLISH: the question as printed (the Workbook view): its header row without the trainer's Satisfactory column, so the
 * crop ends where that column began and leaves no blank block. Never clipped: every word whose middle is in the row widens the crop
 * to its full extent, plus a small margin. The pictures under the question are shown as their own crops below it (`figures`).
 */
export function workbookCrop(q: TemplateQuestion, ink: Pick<PageInk, "W" | "H" | "texts">): Rect {
  const r = questionTextRect(q);
  const { W, H } = ink;
  // the row's own edges (its ruled lines included, nothing of the next row); a word reaching past them widens it, with a margin
  const R = { x0: r.x * W, y0: r.y * H, x1: (r.x + r.w) * W, y1: (r.y + r.h) * H };
  let x0 = R.x0 - 1; let y0 = R.y0 - 1; let x1 = R.x1; let y1 = R.y1 + 1;
  const m = 2;
  for (const t of ink.texts) {
    const cx = t.x + t.w / 2; const cy = t.y + t.h / 2;
    if (cx < R.x0 || cx > R.x1 || cy < R.y0 || cy > R.y1) continue;
    x0 = Math.min(x0, t.x - m); x1 = Math.max(x1, t.x + t.w + m);
    y0 = Math.min(y0, t.y - m); y1 = Math.max(y1, t.base + t.h * 0.3 + m);
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  return { page: r.page, x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
}

/**
 * The crop shown for a scanned page (no text layer): the whole question, padded, never cut, and without the trainer's column (so no
 * blank block is left where it was): the text rect widened by a margin on every side and down to the first answer box.
 */
export function scannedCrop(t: PdfTemplate, q: TemplateQuestion, page: { w: number; h: number }): Rect {
  const r = questionTextRect(q);
  const area = questionFigureArea(t, q);
  const padX = 8 / page.w; const padY = 8 / page.h;
  const x = Math.max(0, r.x - padX); const y = Math.max(0, r.y - padY);
  const bottom = Math.min(1, Math.max(r.y + r.h, Math.min(area.y + area.h, r.y + r.h + 0.25)) + padY);
  return { page: r.page, x, y, w: Math.min(1, r.x + r.w + padX) - x, h: bottom - y };
}
