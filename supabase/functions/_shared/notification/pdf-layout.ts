// Runtime-neutral (Deno and browser) page layout on top of pdf-lib: measured table rows that never split across pages, headings kept with their
// first row, long strings broken inside cells, link annotations, embedded images and a "Page X of Y" footer. Nothing here touches the network.
// This is the ONE styling every Skyline PDF uses: the submitted application (email attachment and the portal download), the offer letter
// (HRMS > Templates) and the signature page added to a signed offer. Recovered from the live notification-delivery function (2 Nov 2026) and
// extended for letters: flowing paragraphs with alignment, list markers, quotes, underline / strike, a header with free meta lines, and
// opening an existing PDF to add pages to it.
import { PDFDocument, PDFFont, PDFPage, PDFString, rgb, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { NOTO_SANS_BOLD, NOTO_SANS_REGULAR } from "./pdf-fonts.ts";

export const MAX_PDF_PAGES = 40;
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 45.35; // 16 mm
const FOOTER_H = 30;
const PAD = 5;
const SIZE = 9.5;
const LEAD = SIZE * 1.42;
const LABEL_SHARE = 0.32;
const BORDER = 0.75;

export type Rgb = readonly [number, number, number];
export type Tone = "normal" | "muted" | "link" | "warn" | "danger";
export interface Span { text: string; tone?: Tone; url?: string; underline?: boolean; strike?: boolean }
export interface ImageData { bytes: Uint8Array; type: "png" | "jpg" }
export interface Para {
  spans: Span[]; check?: boolean; bold?: boolean; size?: number; image?: ImageData;
  /** Letters: alignment, a hanging indent with a list marker ("•", "3."), a quote bar, and a heading kept with what follows. */
  align?: "left" | "center" | "right"; indent?: number; marker?: string; quote?: boolean; keepWithNext?: boolean;
}
export interface Row { label: string; paras: Para[] }
export interface Palette { primary: Rgb; tint: Rgb }

const GREY: Rgb = [0.4, 0.44, 0.5];
const WARN: Rgb = [0.71, 0.33, 0.04];
const DANGER: Rgb = [0.72, 0.11, 0.11];
const INK: Rgb = [0.09, 0.1, 0.12];
const BORDER_COLOUR: Rgb = [0.78, 0.8, 0.84];
const col = (c: Rgb) => rgb(c[0], c[1], c[2]);

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
let fontBytes: [Uint8Array, Uint8Array] | null = null;
const IMAGE_MAX_H = 40;
const IMAGE_MAX_W = 150;

interface Piece { text: string; tone: Tone; url?: string; width: number; bold: boolean; underline?: boolean; strike?: boolean }
interface Line { pieces: Piece[]; height: number; image?: { data: ImageData; w: number; h: number } }

export class PdfWriter {
  readonly pages: PDFPage[] = [];
  truncated = false;
  /** Where every heading and table row landed (page index, top and bottom y); lets tests prove nothing was split or orphaned. */
  readonly placed: { kind: "heading" | "row"; page: number; top: number; bottom: number }[] = [];
  y = 0;
  private known = new Set<number>();
  private boldKnown = new Set<number>();
  private images = new Map<Uint8Array, PDFImage>();
  /** Pages the document already had before this writer added any (an offer being signed). */
  private readonly existing: number;

  readonly pdf: PDFDocument;
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly palette: Palette;

  private constructor(pdf: PDFDocument, regular: PDFFont, bold: PDFFont, palette: Palette, existing: number) {
    this.pdf = pdf; this.regular = regular; this.bold = bold; this.palette = palette; this.existing = existing;
    this.known = new Set(regular.getCharacterSet());
    this.boldKnown = new Set(bold.getCharacterSet());
  }

  private static async fonts(pdf: PDFDocument): Promise<[PDFFont, PDFFont]> {
    pdf.registerFontkit(fontkit);
    // The base64 is decoded once per isolate: each PDF of a signature (signed copy, certificate) reuses the bytes (CPU budget).
    fontBytes ??= [fromBase64(NOTO_SANS_REGULAR), fromBase64(NOTO_SANS_BOLD)];
    return [await pdf.embedFont(fontBytes[0], { subset: true }), await pdf.embedFont(fontBytes[1], { subset: true })];
  }

  static async create(title: string, palette: Palette): Promise<PdfWriter> {
    const pdf = await PDFDocument.create();
    pdf.setTitle(title);
    pdf.setProducer("Skyline ERP");
    pdf.setCreator("Skyline ERP");
    const [regular, bold] = await PdfWriter.fonts(pdf);
    const writer = new PdfWriter(pdf, regular, bold, palette, 0);
    writer.newPage();
    return writer;
  }

  /** Opens an existing PDF to add pages after its own (every original page is kept unchanged). The first added page starts the cursor. */
  static async open(bytes: Uint8Array, palette: Palette): Promise<PdfWriter> {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const [regular, bold] = await PdfWriter.fonts(pdf);
    const writer = new PdfWriter(pdf, regular, bold, palette, pdf.getPageCount());
    writer.newPage();
    return writer;
  }

  /** Characters the embedded font does not cover lose their accents when the base letter is known, otherwise become "?"; never dropped silently. */
  clean(text: string, bold = false): string {
    const known = bold ? this.boldKnown : this.known;
    let out = "";
    for (const ch of String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")) {
      const cp = ch.codePointAt(0)!;
      if (ch === "\n" || ch === "\t" || known.has(cp)) { out += ch; continue; }
      const folded = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      out += folded && [...folded].every((c) => known.has(c.codePointAt(0)!)) ? folded : "?";
    }
    return out;
  }

  get page(): PDFPage { return this.pages[this.pages.length - 1]; }
  get bottom(): number { return MARGIN + FOOTER_H; }
  get contentWidth(): number { return PAGE_W - 2 * MARGIN; }
  get room(): number { return this.y - this.bottom; }
  /** Pages in the whole document, including any it had before. */
  get pageCount(): number { return this.existing + this.pages.length; }

  newPage(): boolean {
    if (this.pages.length >= MAX_PDF_PAGES) { this.truncated = true; return false; }
    this.pages.push(this.pdf.addPage([PAGE_W, PAGE_H]));
    this.y = PAGE_H - MARGIN;
    return true;
  }

  private font(bold: boolean) { return bold ? this.bold : this.regular; }
  private widthOf(text: string, bold: boolean, size: number) { return this.font(bold).widthOfTextAtSize(text, size); }

  /** Splits one character run so no piece is wider than max. */
  private breakLong(word: string, bold: boolean, size: number, max: number): string[] {
    const parts: string[] = [];
    let current = "";
    for (const ch of word) {
      if (current && this.widthOf(current + ch, bold, size) > max) { parts.push(current); current = ""; }
      current += ch;
    }
    if (current) parts.push(current);
    return parts;
  }

  private indentOf(para: Para): number { return (para.check ? 13 : 0) + (para.indent ?? 0) + (para.quote ? 12 : 0); }

  /** Word wrap across styled spans; explicit newlines start a new line; over-long words are broken inside the cell. */
  layout(para: Para, width: number): Line[] {
    const size = para.size ?? SIZE;
    const lead = size * 1.42;
    const bold = !!para.bold;
    if (para.image) {
      const dims = this.imageSize(para.image);
      return [{ pieces: [], height: dims.h + 4, image: { data: para.image, ...dims } }];
    }
    const max = Math.max(20, width - this.indentOf(para));
    const lines: Line[] = [];
    let pieces: Piece[] = [];
    let used = 0;
    const flush = () => { lines.push({ pieces, height: lead }); pieces = []; used = 0; };
    for (const span of para.spans) {
      const tone = span.tone ?? (span.url ? "link" : "normal");
      const text = this.clean(span.text, bold);
      const rows = text.split("\n");
      rows.forEach((rowText, rowIndex) => {
        if (rowIndex > 0) flush();
        for (const token of rowText.split(/(?<= )/)) {
          if (!token) continue;
          const spaceW = this.widthOf(" ", bold, size);
          const trimmed = token.replace(/ +$/, "");
          const pieceList = this.widthOf(trimmed, bold, size) > max ? this.breakLong(trimmed, bold, size, max) : [trimmed];
          pieceList.forEach((word, i) => {
            const w = this.widthOf(word, bold, size);
            if (used > 0 && used + w > max) flush();
            const trailing = i === pieceList.length - 1 && token.endsWith(" ") ? " " : "";
            pieces.push({ text: word + trailing, tone, url: span.url, width: w + (trailing ? spaceW : 0), bold, underline: span.underline, strike: span.strike });
            used += w + (trailing ? spaceW : 0);
            if (i < pieceList.length - 1) flush();
          });
        }
      });
    }
    if (pieces.length || !lines.length) flush();
    return lines;
  }

  private imageSize(data: ImageData): { w: number; h: number } {
    const image = this.embedImage(data);
    const scale = Math.min(IMAGE_MAX_H / image.height, IMAGE_MAX_W / image.width, 1);
    return { w: image.width * scale, h: image.height * scale };
  }

  private embedImage(data: ImageData): PDFImage {
    const cached = this.images.get(data.bytes);
    if (cached) return cached;
    // pdf-lib embeds synchronously only after parsing; the parsed images are prepared by prepareImage() before layout.
    throw new Error("image not prepared");
  }

  /** Embeds an image once (PNG or JPEG) so layout can measure it. */
  async prepareImage(data: ImageData): Promise<void> {
    if (this.images.has(data.bytes)) return;
    this.images.set(data.bytes, data.type === "png" ? await this.pdf.embedPng(data.bytes) : await this.pdf.embedJpg(data.bytes));
  }

  private paraHeight(lines: Line[]): number { return lines.reduce((sum, l) => sum + l.height, 0); }

  /** Draws laid-out lines at (x, top). `width` is the room the paragraph was laid out in (needed for centre / right alignment). */
  private drawLines(lines: Line[], x: number, top: number, para: Para, width?: number): void {
    const size = para.size ?? SIZE;
    let y = top;
    const indent = this.indentOf(para);
    const textX = x + indent;
    if (para.quote && lines.length) {
      const h = this.paraHeight(lines);
      this.page.drawLine({ start: { x: x + 3, y: top - 1 }, end: { x: x + 3, y: top - h + 3 }, thickness: 1.5, color: col(BORDER_COLOUR) });
    }
    lines.forEach((line, index) => {
      if (line.image) {
        const image = this.embedImage(line.image.data);
        this.page.drawImage(image, { x, y: y - line.image.h, width: line.image.w, height: line.image.h });
        y -= line.height;
        return;
      }
      const base = y - size;
      if (para.check && index === 0) this.drawCheck(x + 1, base + size * 0.3, size);
      if (para.marker && index === 0) {
        const marker = this.clean(para.marker);
        this.page.drawText(marker, { x: textX - 5 - this.widthOf(marker, false, size), y: base, size, font: this.regular, color: col(INK) });
      }
      const lineW = line.pieces.reduce((s, p, i) => s + (i === line.pieces.length - 1 ? this.widthOf(p.text.trimEnd(), p.bold, size) : p.width), 0);
      const free = width === undefined ? 0 : Math.max(0, width - indent - lineW);
      let cursor = textX + (para.align === "center" ? free / 2 : para.align === "right" ? free : 0);
      const link: { run: { url?: string; from: number; to: number } | null } = { run: null };
      const endRun = () => {
        const run = link.run;
        if (!run) return;
        this.page.drawLine({ start: { x: run.from, y: base - 1.2 }, end: { x: run.to, y: base - 1.2 }, thickness: 0.5, color: col(this.palette.primary) });
        if (run.url) this.linkAnnotation(run.from, base - 2, run.to - run.from, size + 3, run.url);
        link.run = null;
      };
      for (const piece of line.pieces) {
        const colour: Rgb = piece.tone === "muted" ? GREY : piece.tone === "link" ? this.palette.primary : piece.tone === "warn" ? WARN : piece.tone === "danger" ? DANGER : INK;
        if (piece.text.trim()) this.page.drawText(piece.text, { x: cursor, y: base, size, font: this.font(piece.bold), color: col(colour) });
        const visibleEnd = cursor + this.widthOf(piece.text.trimEnd(), piece.bold, size);
        if (piece.tone === "link" && piece.text.trim()) {
          if (link.run && link.run.url !== piece.url) endRun();
          link.run = link.run ? { ...link.run, to: visibleEnd } : { url: piece.url, from: cursor, to: visibleEnd };
        } else if (piece.text.trim()) endRun();
        if (piece.underline && piece.text.trim() && piece.tone !== "link") this.page.drawLine({ start: { x: cursor, y: base - 1.4 }, end: { x: visibleEnd, y: base - 1.4 }, thickness: 0.6, color: col(colour) });
        if (piece.strike && piece.text.trim()) this.page.drawLine({ start: { x: cursor, y: base + size * 0.3 }, end: { x: visibleEnd, y: base + size * 0.3 }, thickness: 0.6, color: col(colour) });
        cursor += piece.width;
      }
      endRun();
      y -= line.height;
    });
  }

  private drawCheck(x: number, y: number, size: number): void {
    const colour = col(this.palette.primary);
    this.page.drawLine({ start: { x, y: y + size * 0.25 }, end: { x: x + size * 0.28, y }, thickness: 1.2, color: colour });
    this.page.drawLine({ start: { x: x + size * 0.28, y }, end: { x: x + size * 0.72, y: y + size * 0.62 }, thickness: 1.2, color: colour });
  }

  private linkAnnotation(x: number, y: number, w: number, h: number, url: string): void {
    const ref = this.pdf.context.register(this.pdf.context.obj({
      Type: "Annot", Subtype: "Link", Rect: [x, y, x + w, y + h], Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    }));
    this.page.node.addAnnot(ref);
  }

  /** A rule under a heading or around the header block. */
  rule(thickness = 1.2, colour: Rgb = this.palette.primary): void {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness, color: col(colour) });
  }

  /** A thin grey rule with space around it (a letter's <hr>). */
  divider(): void {
    if (this.room < 14 && !this.newPage()) return;
    this.y -= 4;
    this.rule(0.7, BORDER_COLOUR);
    this.y -= 10;
  }

  /** Free text block (one or more paragraphs) at the cursor; it moves to a new page as a whole if it does not fit. */
  block(paras: Para[], gap = 4): void {
    const laid = paras.map((p) => ({ p, lines: this.layout(p, this.contentWidth) }));
    const total = laid.reduce((sum, l) => sum + this.paraHeight(l.lines) + gap, 0);
    if (total > this.room && !this.newPage()) return;
    for (const { p, lines } of laid) { this.drawLines(lines, MARGIN, this.y, p, this.contentWidth); this.y -= this.paraHeight(lines) + gap; }
  }

  /**
   * Letter text: paragraphs flow down the pages one after another. A paragraph moves to the next page when it does not fit, unless it is
   * taller than a page (then its lines are split); a heading (keepWithNext) is placed only with at least two lines of what follows.
   */
  flow(paras: Para[], gap = 6): void {
    const laid = paras.map((p) => ({ p, lines: this.layout(p, this.contentWidth) }));
    const pageRoom = PAGE_H - MARGIN - this.bottom;
    for (let i = 0; i < laid.length && !this.truncated; i++) {
      const { p, lines } = laid[i];
      const height = this.paraHeight(lines);
      const next = laid[i + 1];
      const keep = p.keepWithNext && next ? Math.min(this.paraHeight(next.lines), 2 * (next.p.size ?? SIZE) * 1.42) + gap : 0;
      if (height + keep > this.room && height + keep <= pageRoom && !this.newPage()) return;
      if (height <= this.room) {
        this.drawLines(lines, MARGIN, this.y, p, this.contentWidth);
        this.y -= height + gap;
        continue;
      }
      // Taller than what is left anywhere: line by line, the marker and quote bar with the first chunk only.
      let index = 0;
      let first = true;
      while (index < lines.length) {
        if (this.room < lines[index].height && !this.newPage()) return;
        const chunk: Line[] = [];
        let h = 0;
        while (index < lines.length && h + lines[index].height <= this.room) { h += lines[index].height; chunk.push(lines[index]); index++; }
        if (!chunk.length) { if (!this.newPage()) return; continue; }
        this.drawLines(chunk, MARGIN, this.y, first ? p : { ...p, marker: undefined, quote: undefined }, this.contentWidth);
        this.y -= h;
        first = false;
      }
      this.y -= gap;
    }
  }

  /**
   * One section: coloured heading with an underline, then a bordered two-column table. A row is placed on a page only when all of it fits;
   * the heading is placed only together with its first row. A row taller than a whole page is the single exception and is split between lines.
   */
  section(title: string, rows: Row[]): void {
    if (!rows.length || this.truncated) return;
    const labelW = this.contentWidth * LABEL_SHARE;
    const valueW = this.contentWidth - labelW;
    const prepared = rows.map((row) => {
      const labelPara: Para = { spans: [{ text: row.label }], bold: true };
      const label = this.layout(labelPara, labelW - 2 * PAD);
      const paras = row.paras.length ? row.paras : [{ spans: [{ text: "Not provided", tone: "muted" as Tone }] }];
      const value = paras.map((p) => ({ p, lines: this.layout(p, valueW - 2 * PAD) }));
      const valueH = value.reduce((s, v) => s + this.paraHeight(v.lines) + 2, -2);
      const height = Math.max(this.paraHeight(label), valueH) + 2 * PAD;
      return { labelPara, label, value, height };
    });
    const headingH = 12 * 1.4 + 9;
    const page = PAGE_H - 2 * MARGIN - FOOTER_H;
    let first = true;
    const heading = (suffix: string) => {
      this.page.drawText(this.clean(title + suffix, true), { x: MARGIN, y: this.y - 12, size: 12, font: this.bold, color: col(this.palette.primary) });
      this.placed.push({ kind: "heading", page: this.pages.length - 1, top: this.y, bottom: this.y - headingH });
      this.y -= 12 * 1.4;
      this.rule(1.2);
      this.y -= 7;
    };
    for (const row of prepared) {
      const needed = row.height <= page ? row.height : Math.min(row.height, LEAD + 2 * PAD);
      if (first) {
        if (headingH + needed > this.room && !this.newPage()) return;
        heading("");
        first = false;
      } else if (needed > this.room) {
        if (!this.newPage()) return;
        heading(" (continued)");
      }
      if (row.height <= page) this.drawRow(row, labelW, valueW, row.height);
      else this.drawOversizeRow(row, labelW, valueW);
    }
    this.y -= 12;
  }

  private drawRow(row: { labelPara: Para; label: Line[]; value: { p: Para; lines: Line[] }[] }, labelW: number, valueW: number, height: number): void {
    const top = this.y;
    this.placed.push({ kind: "row", page: this.pages.length - 1, top, bottom: top - height });
    this.page.drawRectangle({ x: MARGIN, y: top - height, width: labelW, height, color: col(this.palette.tint), borderColor: col(BORDER_COLOUR), borderWidth: BORDER });
    this.page.drawRectangle({ x: MARGIN + labelW, y: top - height, width: valueW, height, color: rgb(1, 1, 1), borderColor: col(BORDER_COLOUR), borderWidth: BORDER });
    this.drawLines(row.label, MARGIN + PAD, top - PAD, row.labelPara);
    let y = top - PAD;
    for (const v of row.value) { this.drawLines(v.lines, MARGIN + labelW + PAD, y, v.p); y -= this.paraHeight(v.lines) + 2; }
    this.y = top - height;
  }

  /** Last resort for a single cell taller than a page: flows line by line, still bordered per page chunk. */
  private drawOversizeRow(row: { labelPara: Para; label: Line[]; value: { p: Para; lines: Line[] }[] }, labelW: number, valueW: number): void {
    const flat = row.value.flatMap((v) => v.lines.map((line) => ({ line, p: v.p })));
    let index = 0;
    let labelDone = false;
    while (index < flat.length) {
      if (this.room < LEAD + 2 * PAD && !this.newPage()) return;
      const chunk: typeof flat = [];
      let h = 2 * PAD;
      while (index < flat.length && h + flat[index].line.height <= this.room) { h += flat[index].line.height; chunk.push(flat[index]); index++; }
      if (!chunk.length) { if (!this.newPage()) return; continue; }
      const top = this.y;
      this.page.drawRectangle({ x: MARGIN, y: top - h, width: labelW, height: h, color: col(this.palette.tint), borderColor: col(BORDER_COLOUR), borderWidth: BORDER });
      this.page.drawRectangle({ x: MARGIN + labelW, y: top - h, width: valueW, height: h, color: rgb(1, 1, 1), borderColor: col(BORDER_COLOUR), borderWidth: BORDER });
      if (!labelDone) { this.drawLines(row.label, MARGIN + PAD, top - PAD, row.labelPara); labelDone = true; }
      let y = top - PAD;
      for (const c of chunk) { this.drawLines([c.line], MARGIN + labelW + PAD, y, c.p); y -= c.line.height; }
      this.y = top - h;
    }
  }

  /**
   * Header: logo (or the institution name as text) on the left; on the right the institution in bold and then either the application lines
   * (reference, submitted, version) or the `meta` lines given; a rule; then the document title in the primary colour.
   */
  header(opts: { institution: string; logo: ImageData | null; title: string; reference?: string; submitted?: string; version?: number; meta?: string[] }): void {
    const top = this.y;
    let leftH = 0;
    if (opts.logo) {
      const { w, h } = this.imageSize(opts.logo);
      const scale = Math.min(48 / h, 1);
      this.page.drawImage(this.embedImage(opts.logo), { x: MARGIN, y: top - h * scale, width: w * scale, height: h * scale });
      leftH = h * scale;
    } else {
      const lines = this.layout({ spans: [{ text: opts.institution }], bold: true, size: 16 }, this.contentWidth * 0.5);
      this.drawLines(lines, MARGIN, top, { spans: [], bold: true, size: 16 });
      leftH = this.paraHeight(lines);
    }
    const right: { text: string; bold?: boolean }[] = [{ text: opts.institution, bold: true }];
    if (opts.meta) right.push(...opts.meta.map((text) => ({ text })));
    else right.push({ text: `Reference: ${opts.reference ?? ""}` }, { text: `Submitted: ${opts.submitted ?? ""}` }, { text: `Version ${opts.version ?? 0}` });
    let ry = top;
    for (const item of right) {
      const text = this.clean(item.text, !!item.bold);
      const font = this.font(!!item.bold);
      const lines = this.layout({ spans: [{ text }], bold: item.bold }, this.contentWidth * 0.5);
      for (const line of lines) {
        const w = line.pieces.reduce((s, p) => s + p.width, 0);
        let cursor = PAGE_W - MARGIN - w;
        for (const p of line.pieces) { this.page.drawText(p.text, { x: cursor, y: ry - SIZE, size: SIZE, font, color: col(INK) }); cursor += p.width; }
        ry -= LEAD;
      }
    }
    this.y = top - Math.max(leftH, top - ry) - 10;
    this.rule(0.5, BORDER_COLOUR);
    this.y -= 16;
    this.page.drawText(this.clean(opts.title, true), { x: MARGIN, y: this.y - 18, size: 18, font: this.bold, color: col(this.palette.primary) });
    this.y -= 18 * 1.5 + 8;
  }

  /** Shown at the bottom of the last page when the 40-page cap cut the document short. */
  truncationNote(): void {
    this.page.drawText("Truncated: open the application in the portal for the full record.", { x: MARGIN, y: MARGIN + 24, size: 8.5, font: this.regular, color: col(DANGER) });
  }

  /** Footer on every page this writer added, drawn last so the total is known (pages the document already had count towards it). */
  footers(institution: string, reference: string): void {
    const total = this.pageCount;
    this.pages.forEach((page, i) => {
      page.drawLine({ start: { x: MARGIN, y: MARGIN + 18 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 18 }, thickness: 0.5, color: col(BORDER_COLOUR) });
      const left = this.clean(`${institution}  |  ${reference}`);
      const right = `Page ${this.existing + i + 1} of ${total}`;
      page.drawText(left, { x: MARGIN, y: MARGIN + 6, size: 8, font: this.regular, color: col(GREY) });
      page.drawText(right, { x: PAGE_W - MARGIN - this.regular.widthOfTextAtSize(right, 8), y: MARGIN + 6, size: 8, font: this.regular, color: col(GREY) });
    });
  }

  async save(): Promise<Uint8Array> { return await this.pdf.save({ useObjectStreams: true }); }
}
