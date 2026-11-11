// Document templates as PDF (TPL-02): Header, Body and Footer, the header and footer repeated on every page, the body flowing across
// pages. Runtime-neutral (Deno Edge Function and the Node tests run the same code); pdf-lib, the engine every Skyline PDF already uses.
// Text is set in Arimo (metric-compatible with Arial, so it matches the editor and SLIT's earlier letters), with Noto Sans for the few
// characters Arimo lacks; anything neither can print is reported (`unsupported`) so the caller refuses instead of altering it.
//
// Layout: A4; header band from the top margin, footer band up to the bottom margin, body between them. Paragraphs flow line by line;
// a heading stays with what follows it; a table row is never split across pages unless it is taller than a whole page (then it continues
// on the next page, borders closed on both). Tokens: [Page Number] / [Total Pages] are filled per page; registry variables from `values`;
// [Student Initial] and every unknown [token] become fields: a blank in the PDF whose box (page, x, y, w, h as fractions of the page from
// its top-left corner, the convention of hr.sign_fields) is returned so the signer's initials and answers are stamped there later.
import { PDFDocument, PDFFont, PDFPage, PDFString, rgb, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { ARIMO_BOLD, ARIMO_BOLD_ITALIC, ARIMO_ITALIC, ARIMO_REGULAR } from "./pdf-fonts-arimo.ts";
import { NOTO_SANS_BOLD, NOTO_SANS_REGULAR } from "./notification/pdf-fonts.ts";
import { BRACKET_TOKEN, colourOf, lengthOf, parseHtml, pointsOf, safeHref, safeImageSrc, sanitizeRichHtml, type ElementNode, type Node } from "./rich-html.ts";
import { resolveToken, tokenFieldLabel } from "./template-variables.ts";

export const DOC_PAGE_W = 595.28;
export const DOC_PAGE_H = 841.89;
export const DOC_MARGIN_X = 42.52; // 15 mm
export const DOC_BAND = 28.35; // 10 mm: where the header starts and the footer ends
const BODY_MARGIN = 42.52; // top / bottom of the body when there is no header / footer
const BAND_GAP = 10;
export const MAX_DOCUMENT_PAGES = 80;
const BASE = 10;
const LEADING = 1.2;
const CELL_PAD = 4;
const BLACK = "#000000";

/* ------------------------------------------------------------------ model */
interface Style { bold: boolean; italic: boolean; underline: boolean; strike: boolean; size: number; color: string; background: string | null; href: string | null; script: "sub" | "sup" | null }
type Inline =
  | { t: "text"; text: string; style: Style }
  | { t: "image"; src: string; w: number | null; h: number | null; style: Style }
  | { t: "br"; style: Style }
  | { t: "var"; which: "page" | "total"; style: Style }
  | { t: "field"; field: "text" | "initials"; label: string; style: Style };
type Align = "left" | "center" | "right" | "justify";
interface Para { kind: "para"; inlines: Inline[]; align: Align; indent: number; marker: string | null; quote: boolean; before: number; after: number; keep: boolean; size: number }
interface Cell { blocks: Block[]; colspan: number; width: { pct: number } | { pt: number } | null; background: string | null; valign: "top" | "middle" | "bottom" }
interface Table { kind: "table"; border: boolean; width: { pct: number } | { pt: number } | null; rows: Cell[][] }
type Block = Para | Table | { kind: "hr" };

const plain: Style = { bold: false, italic: false, underline: false, strike: false, size: BASE, color: BLACK, background: null, href: null, script: null };
const css = (node: ElementNode) => Object.fromEntries(String(node.attrs.style ?? "").split(";").map((p) => { const i = p.indexOf(":"); return i < 0 ? ["", ""] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()]; }));
const HEADING: Record<string, { size: number; before: number; after: number }> = { h1: { size: 18, before: 10, after: 6 }, h2: { size: 15, before: 9, after: 5 }, h3: { size: 13, before: 7, after: 4 },
  h4: { size: 11.5, before: 6, after: 3 }, h5: { size: 10.5, before: 5, after: 3 }, h6: { size: 10, before: 5, after: 3 } };

function styled(base: Style, node: ElementNode): Style {
  const s = { ...base };
  const c = css(node);
  switch (node.tag) {
    case "strong": case "th": s.bold = true; break;
    case "em": s.italic = true; break;
    case "u": s.underline = true; break;
    case "s": s.strike = true; break;
    case "sub": s.script = "sub"; break;
    case "sup": s.script = "sup"; break;
    case "a": { const href = safeHref(node.attrs.href); if (href) { s.href = href; s.underline = true; s.color = "#1155cc"; } break; }
  }
  if (c["font-weight"] === "bold") s.bold = true;
  if (c["font-style"] === "italic") s.italic = true;
  if (c["text-decoration"] === "underline") s.underline = true;
  if (c["text-decoration"] === "line-through") s.strike = true;
  const size = pointsOf(c["font-size"]);
  if (size) s.size = size;
  const colour = colourOf(c.color);
  if (colour) s.color = colour;
  const bg = colourOf(c["background-color"]);
  if (bg && node.tag !== "td" && node.tag !== "th" && node.tag !== "table") s.background = bg;
  return s;
}
const alignOf = (node: ElementNode, inherited: Align): Align => { const a = css(node)["text-align"]; return a === "center" || a === "right" || a === "justify" || a === "left" ? a : inherited; };

class Builder {
  readonly blocks: Block[] = [];
  private current: Para | null = null;
  constructor(private readonly inCell: boolean) {}
  private para(ctx: Ctx, extra: Partial<Para> = {}): Para {
    if (!this.current) {
      this.current = { kind: "para", inlines: [], align: ctx.align, indent: ctx.indent, marker: null, quote: ctx.quote, before: 0, after: this.inCell ? 2 : 6, keep: false, size: ctx.style.size, ...extra };
      this.blocks.push(this.current);
    }
    return this.current;
  }
  flush() { this.current = null; }
  inline(item: Inline, ctx: Ctx) { this.para(ctx).inlines.push(item); }
  block(node: ElementNode, ctx: Ctx, extra: Partial<Para>) { this.flush(); this.para(ctx, extra); this.children(node, ctx); this.flush(); }
  children(node: ElementNode, ctx: Ctx) { for (const child of node.children) this.walk(child, ctx); }
  walk(node: Node, ctx: Ctx): void {
    if (typeof node === "string") { const text = node.replace(/[\t\r\n ]+/g, " "); if (text) this.inline({ t: "text", text, style: ctx.style }, ctx); return; }
    const tag = node.tag;
    const style = styled(ctx.style, node);
    const here: Ctx = { ...ctx, style, align: alignOf(node, ctx.align) };
    switch (tag) {
      case "br": this.inline({ t: "br", style }, ctx); return;
      case "img": {
        const src = safeImageSrc(node.attrs.src);
        if (!src) return;
        const c = css(node), w = lengthOf(c.width), h = lengthOf(c.height);
        this.inline({ t: "image", src, w: w && "pt" in w ? w.pt : null, h: h && "pt" in h ? h.pt : null, style }, ctx);
        return;
      }
      case "hr": this.flush(); this.blocks.push({ kind: "hr" }); return;
      case "p": case "div": {
        const blockish = node.children.some((c) => typeof c !== "string" && /^(p|div|table|ul|ol|h[1-6]|blockquote|hr)$/.test(c.tag));
        if (blockish) { this.flush(); this.children(node, here); this.flush(); return; }
        this.block(node, here, { align: here.align, size: style.size });
        return;
      }
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const h = HEADING[tag];
        const hs: Style = { ...style, bold: true, size: pointsOf(css(node)["font-size"]) ?? h.size };
        this.block(node, { ...here, style: hs }, { before: this.inCell ? 0 : h.before, after: h.after, keep: true, size: hs.size, align: here.align });
        return;
      }
      case "blockquote": this.flush(); this.children(node, { ...here, indent: ctx.indent + 14, quote: true }); this.flush(); return;
      case "ul": case "ol": {
        this.flush();
        const startAt = this.blocks.length;
        const list = { ordered: tag === "ol", n: 0 };
        for (const child of node.children) {
          if (typeof child === "string") { if (child.trim()) this.block({ tag: "li", attrs: {}, children: [child] }, { ...here, indent: ctx.indent + 18 }, { marker: list.ordered ? `${++list.n}.` : "•", after: 2 }); continue; }
          if (child.tag === "li") {
            const marker = list.ordered ? `${++list.n}.` : "•";
            const liCtx: Ctx = { ...here, style: styled(here.style, child), align: alignOf(child, here.align), indent: ctx.indent + 18 };
            // The item's own text is the marked paragraph; nested lists and blocks follow it, further in.
            this.flush();
            this.para(liCtx, { marker, after: 2, size: liCtx.style.size });
            for (const grandchild of child.children) {
              if (typeof grandchild !== "string" && /^(ul|ol|table|p|div|blockquote|h[1-6])$/.test(grandchild.tag)) { this.flush(); this.walk(grandchild, liCtx); this.flush(); }
              else this.walk(grandchild, liCtx);
            }
            this.flush();
          } else this.walk(child, { ...here, indent: ctx.indent + 18 });
        }
        // The text after a list keeps a paragraph's distance from it.
        const last = this.blocks[this.blocks.length - 1];
        if (this.blocks.length > startAt && last?.kind === "para") last.after = Math.max(last.after, this.inCell ? 2 : 6);
        return;
      }
      case "li": this.block(node, { ...here, indent: ctx.indent + 18 }, { marker: "•", after: 2 }); return;
      case "table": this.flush(); this.blocks.push(tableOf(node, here)); return;
      case "thead": case "tbody": case "tfoot": case "tr": case "td": case "th": case "colgroup": case "col":
        this.children(node, here); return; // only reached for malformed tables outside <table>
      default: this.children(node, here);
    }
  }
}
interface Ctx { style: Style; align: Align; indent: number; quote: boolean }

function tableOf(node: ElementNode, ctx: Ctx): Table {
  const c = css(node);
  const rows: Cell[][] = [];
  const collect = (n: ElementNode) => {
    for (const child of n.children) {
      if (typeof child === "string") continue;
      if (child.tag === "tr") {
        const row: Cell[] = [];
        for (const cell of child.children) {
          if (typeof cell === "string" || (cell.tag !== "td" && cell.tag !== "th")) continue;
          const cc = css(cell);
          const builder = new Builder(true);
          const cellStyle = styled(ctx.style, cell);
          builder.children(cell, { style: cellStyle, align: alignOf(cell, cell.tag === "th" ? "left" : "left"), indent: 0, quote: false });
          builder.flush();
          const span = Number(cell.attrs.colspan);
          row.push({ blocks: builder.blocks, colspan: Number.isInteger(span) && span > 1 ? Math.min(span, 20) : 1, width: lengthOf(cc.width), background: colourOf(cc["background-color"]),
            valign: cc["vertical-align"] === "middle" ? "middle" : cc["vertical-align"] === "bottom" ? "bottom" : "top" });
        }
        if (row.length) rows.push(row);
      } else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") collect(child);
    }
  };
  collect(node);
  return { kind: "table", border: !/^none/.test(String(c.border ?? "")), width: lengthOf(c.width), rows };
}

/** Sanitised HTML as blocks, with the tokens resolved (or kept as text when `brackets` is off). */
function blocksOf(html: string, tokens: TokenContext | null): Block[] {
  const builder = new Builder(false);
  builder.children(parseHtml(sanitizeRichHtml(html)), { style: plain, align: "left", indent: 0, quote: false });
  builder.flush();
  if (tokens) resolveBlocks(builder.blocks, tokens);
  return builder.blocks;
}

/* ------------------------------------------------------------------ tokens */
interface TokenContext { values: Record<string, string>; sample: boolean; missing: Set<string> }
function resolveBlocks(blocks: Block[], ctx: TokenContext): void {
  for (const block of blocks) {
    if (block.kind === "para") block.inlines = resolveInlines(block.inlines, ctx);
    else if (block.kind === "table") for (const row of block.rows) for (const cell of row) resolveBlocks(cell.blocks, ctx);
  }
}
/** Finds tokens across neighbouring text runs (a token formatted half bold is still one token) and replaces them. */
function resolveInlines(inlines: Inline[], ctx: TokenContext): Inline[] {
  const out: Inline[] = [];
  let group: Array<{ ch: string; style: Style }> = [];
  const flush = () => {
    if (!group.length) return;
    const text = group.map((g) => g.ch).join("");
    let at = 0;
    const emit = (from: number, to: number) => {
      let i = from;
      while (i < to) { const style = group[i].style; let j = i; while (j < to && group[j].style === style) j++; out.push({ t: "text", text: group.slice(i, j).map((g) => g.ch).join(""), style }); i = j; }
    };
    for (const m of text.matchAll(BRACKET_TOKEN)) {
      const start = m.index ?? 0, end = start + m[0].length;
      const style = group[start].style;
      const r = resolveToken(m[1], ctx.values, ctx.sample);
      if (r.kind === "literal") continue;
      emit(at, start);
      if (r.kind === "value") out.push({ t: "text", text: r.text, style });
      else if (r.kind === "missing") { ctx.missing.add(r.name); out.push({ t: "text", text: `[${r.name}]`, style }); }
      else if (r.kind === "page" || r.kind === "total") out.push({ t: "var", which: r.kind, style });
      else if (r.kind === "field") out.push({ t: "field", field: r.field, label: r.label, style });
      at = end;
    }
    emit(at, group.length);
    group = [];
  };
  for (const inline of inlines) {
    if (inline.t === "text") { for (const ch of inline.text) group.push({ ch, style: inline.style }); }
    else { flush(); out.push(inline); }
  }
  flush();
  return out;
}

/* ------------------------------------------------------------------ fonts */
interface Fonts { faces: Record<"r" | "b" | "i" | "bi", PDFFont>; fallback: { r: PDFFont; b: PDFFont }; sets: Map<PDFFont, Set<number>> }
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
async function embedFonts(pdf: PDFDocument): Promise<Fonts> {
  pdf.registerFontkit(fontkit);
  const embed = (b64: string) => pdf.embedFont(fromBase64(b64), { subset: true });
  const [r, b, i, bi, nr, nb] = await Promise.all([embed(ARIMO_REGULAR), embed(ARIMO_BOLD), embed(ARIMO_ITALIC), embed(ARIMO_BOLD_ITALIC), embed(NOTO_SANS_REGULAR), embed(NOTO_SANS_BOLD)]);
  const sets = new Map<PDFFont, Set<number>>();
  for (const f of [r, b, i, bi, nr, nb]) sets.set(f, new Set(f.getCharacterSet()));
  return { faces: { r, b, i, bi }, fallback: { r: nr, b: nb }, sets };
}
interface Seg { text: string; font: PDFFont; width: number }

/* ------------------------------------------------------------------ layout */
interface Piece {
  kind: "text" | "image" | "var" | "field";
  segs: Seg[]; width: number; size: number; style: Style; breakAfter: boolean; ascent: number; descent: number;
  image?: { img: PDFImage; w: number; h: number }; varWhich?: "page" | "total"; field?: { field: "text" | "initials"; label: string };
}
interface Line { pieces: Piece[]; width: number; height: number; ascent: number; spaces: number }
export interface PlacedField { label: string; type: "text" | "initials"; page: number; x: number; y: number; w: number; h: number }
interface DrawCtx { page: PDFPage; pageIndex: number; total: number; fields: PlacedField[]; sample: boolean }
interface Item {
  height: number; gap?: boolean; keep?: boolean; row?: boolean;
  draw(ctx: DrawCtx, x: number, top: number): void;
  split?(room: number): [Item, Item] | null;
}

class Layout {
  readonly unsupported = new Set<string>();
  readonly placed: Array<{ kind: "row"; page: number; top: number; bottom: number }> = [];
  constructor(private readonly fonts: Fonts, private readonly images: Map<string, PDFImage>) {}

  private face(style: Style): PDFFont { const f = this.fonts.faces; return style.bold ? (style.italic ? f.bi : f.b) : style.italic ? f.i : f.r; }
  /** A text in segments of one font each: Arimo where it has the glyph, Noto Sans where only it has it, "?" (reported) otherwise. */
  segments(text: string, style: Style, size: number): Seg[] {
    const face = this.face(style);
    const fallback = style.bold ? this.fonts.fallback.b : this.fonts.fallback.r;
    const segs: Seg[] = [];
    for (const raw of text) {
      const cp = raw.codePointAt(0)!;
      let ch = raw, font = face;
      if (raw === " ") ch = " ";
      else if (!this.fonts.sets.get(face)!.has(cp)) {
        if (this.fonts.sets.get(fallback)!.has(cp)) font = fallback;
        else { const folded = raw.normalize("NFKD").replace(/[̀-ͯ]/g, ""); if (folded && [...folded].every((c) => this.fonts.sets.get(face)!.has(c.codePointAt(0)!))) ch = folded; else { this.unsupported.add(raw); ch = "?"; } }
      }
      const last = segs[segs.length - 1];
      if (last && last.font === font) last.text += ch; else segs.push({ text: ch, font, width: 0 });
    }
    for (const s of segs) s.width = s.font.widthOfTextAtSize(s.text, size);
    return segs;
  }
  private sizeOf(style: Style) { return style.script ? style.size * 0.7 : style.size; }

  /** One paragraph's pieces: words (a break is allowed after a space), pictures, page numbers and fields. */
  private pieces(inlines: Inline[], vars: { page: number; total: number } | null, maxWidth: number): Array<Piece | "br"> {
    const out: Array<Piece | "br"> = [];
    for (const inline of inlines) {
      if (inline.t === "br") { out.push("br"); continue; }
      const size = this.sizeOf(inline.style);
      const metrics = { ascent: size * 0.905, descent: size * 0.212 };
      if (inline.t === "text") {
        for (const word of inline.text.split(/(?<= )/)) {
          if (!word) continue;
          const segs = this.segments(word, inline.style, size);
          out.push({ kind: "text", segs, width: segs.reduce((n, s) => n + s.width, 0), size, style: inline.style, breakAfter: word.endsWith(" "), ...metrics });
        }
      } else if (inline.t === "image") {
        const img = this.images.get(inline.src);
        if (!img) continue;
        let w = inline.w ?? img.width * 0.75, h = inline.h ?? (inline.w ? img.height * (inline.w / img.width) : img.height * 0.75);
        if (inline.w && !inline.h) h = img.height * (w / img.width);
        if (inline.h && !inline.w) w = img.width * (h / img.height);
        const scale = Math.min(1, maxWidth / w, 400 / h);
        w *= scale; h *= scale;
        out.push({ kind: "image", segs: [], width: w, size, style: inline.style, breakAfter: true, ascent: h, descent: 0, image: { img, w, h } });
      } else if (inline.t === "var") {
        const text = vars ? String(inline.which === "page" ? vars.page : vars.total) : "999";
        const segs = this.segments(text, inline.style, size);
        out.push({ kind: "var", segs, width: segs.reduce((n, s) => n + s.width, 0), size, style: inline.style, breakAfter: false, varWhich: inline.which, ...metrics });
      } else {
        const labelWidth = this.face(inline.style).widthOfTextAtSize(inline.label, size);
        const width = inline.field === "initials" ? Math.max(36, size * 3.6) : Math.min(maxWidth, Math.max(90, labelWidth * 1.3 + 12));
        out.push({ kind: "field", segs: [], width, size, style: inline.style, breakAfter: true, field: { field: inline.field, label: inline.label }, ...metrics });
      }
    }
    return out;
  }

  /** Word wrap into lines of at most `width`. */
  lines(para: Para, width: number, vars: { page: number; total: number } | null): Line[] {
    const max = Math.max(20, width - para.indent);
    const pieces = this.pieces(para.inlines, vars, max);
    const lines: Line[] = [];
    let current: Piece[] = [];
    const push = () => {
      // Trailing spaces do not count for alignment.
      const visible = current.length ? current.reduce((n, p, i) => n + (i === current.length - 1 && p.kind === "text" ? this.trimmedWidth(p) : p.width), 0) : 0;
      const size = current.length ? Math.max(...current.map((p) => p.size)) : para.size;
      const ascent = current.length ? Math.max(...current.map((p) => p.ascent), size * 0.905) : para.size * 0.905;
      const descent = current.length ? Math.max(...current.map((p) => p.descent), size * 0.212) : para.size * 0.212;
      const height = Math.max(size * LEADING, ascent + descent + size * (LEADING - 1.117));
      lines.push({ pieces: current, width: visible, height, ascent: ascent + (height - ascent - descent) / 2, spaces: current.slice(0, -1).filter((p) => p.breakAfter && p.kind === "text").length });
      current = [];
    };
    let used = 0;
    // A run of pieces with no break between them (a word split by formatting) moves to the next line as a whole.
    let i = 0;
    while (i < pieces.length) {
      if (pieces[i] === "br") { push(); used = 0; i++; continue; }
      const run: Piece[] = [];
      while (i < pieces.length && pieces[i] !== "br") { const p = pieces[i] as Piece; run.push(p); i++; if (p.breakAfter) break; }
      const runW = run.reduce((n, p, k) => n + (k === run.length - 1 && p.kind === "text" ? this.trimmedWidth(p) : p.width), 0);
      if (used > 0 && used + runW > max) { push(); used = 0; }
      if (runW > max) {
        // Wider than the line by itself: each word too wide is broken by characters.
        for (const p of run) {
          for (const part of p.kind === "text" && p.width > max ? this.breakWord(p, max) : [p]) {
            if (used > 0 && used + part.width > max) { push(); used = 0; }
            current.push(part); used += part.width;
          }
        }
      } else for (const p of run) { current.push(p); used += p.width; }
    }
    if (current.length || !lines.length) push();
    return lines;
  }
  private trimmedWidth(p: Piece): number {
    const last = p.segs[p.segs.length - 1];
    if (!last || !last.text.endsWith(" ")) return p.width;
    return p.width - (last.width - last.font.widthOfTextAtSize(last.text.trimEnd(), p.size));
  }
  private breakWord(p: Piece, max: number): Piece[] {
    const parts: Piece[] = [];
    let text = "";
    const text0 = p.segs.map((s) => s.text).join("");
    for (const ch of text0) {
      const next = text + ch;
      if (text && this.segments(next, p.style, p.size).reduce((n, s) => n + s.width, 0) > max) { const segs = this.segments(text, p.style, p.size); parts.push({ ...p, segs, width: segs.reduce((n, s) => n + s.width, 0), breakAfter: true }); text = ""; }
      text += ch;
    }
    const segs = this.segments(text, p.style, p.size);
    parts.push({ ...p, segs, width: segs.reduce((n, s) => n + s.width, 0) });
    return parts;
  }

  /** Blocks as items for a column `width` wide. */
  items(blocks: Block[], width: number, vars: { page: number; total: number } | null): Item[] {
    const items: Item[] = [];
    blocks.forEach((block, index) => {
      if (block.kind === "hr") { items.push({ height: 10, draw: (ctx, x, top) => ctx.page.drawLine({ start: { x, y: top - 5 }, end: { x: x + width, y: top - 5 }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) }) }); return; }
      if (block.kind === "table") { items.push(...this.table(block, width, vars)); return; }
      if (block.before && index > 0) items.push({ height: block.before, gap: true, draw: () => {} });
      const lines = this.lines(block, width, vars);
      lines.forEach((line, n) => items.push({ height: line.height, keep: block.keep && n === lines.length - 1, draw: (ctx, x, top) => this.drawLine(ctx, line, block, x, top, width, n === 0, n === lines.length - 1) }));
      if (block.after && index < blocks.length - 1) items.push({ height: block.after, gap: true, draw: () => {} });
    });
    return items;
  }

  private drawLine(ctx: DrawCtx, line: Line, para: Para, x0: number, top: number, width: number, first: boolean, last: boolean): void {
    const room = width - para.indent;
    const free = Math.max(0, room - line.width);
    const justify = para.align === "justify" && !last && line.spaces > 0;
    let x = x0 + para.indent + (para.align === "center" ? free / 2 : para.align === "right" ? free : 0);
    const baseline = top - line.ascent;
    const page = ctx.page;
    if (para.quote) page.drawLine({ start: { x: x0 + para.indent - 8, y: top }, end: { x: x0 + para.indent - 8, y: top - line.height }, thickness: 1.5, color: rgb(0.8, 0.8, 0.8) });
    if (first && para.marker) {
      const segs = this.segments(para.marker, line.pieces[0]?.style ?? plain, para.size);
      let mx = x0 + para.indent - 5 - segs.reduce((n, s) => n + s.width, 0);
      for (const s of segs) { page.drawText(s.text, { x: mx, y: baseline, size: para.size, font: s.font, color: rgb(0, 0, 0) }); mx += s.width; }
    }
    line.pieces.forEach((p, index) => {
      const colour = hexRgb(p.style.color);
      const shift = p.style.script === "sup" ? p.style.size * 0.33 : p.style.script === "sub" ? -p.style.size * 0.15 : 0;
      const textW = index === line.pieces.length - 1 && p.kind === "text" ? this.trimmedWidth(p) : p.width;
      if (p.style.background && p.kind !== "image") page.drawRectangle({ x, y: baseline - p.size * 0.23, width: textW, height: p.size * 1.15, color: hexRgb(p.style.background) });
      if (p.kind === "image" && p.image) page.drawImage(p.image.img, { x, y: baseline, width: p.image.w, height: p.image.h });
      else if (p.kind === "field" && p.field) {
        const box = { x, y: baseline - p.size * 0.3, w: p.width, h: p.size * 1.35 };
        page.drawLine({ start: { x, y: baseline - 1.5 }, end: { x: x + p.width, y: baseline - 1.5 }, thickness: 0.6, color: rgb(0.25, 0.25, 0.25) });
        if (ctx.sample) {
          const label = p.field.field === "initials" ? "Initials" : p.field.label;
          const segs = this.segments(label, { ...p.style, italic: true }, Math.min(p.size, 8));
          let lx = x + 2;
          for (const s of segs) { page.drawText(s.text, { x: lx, y: baseline + 0.5, size: Math.min(p.size, 8), font: s.font, color: rgb(0.45, 0.45, 0.5) }); lx += s.width; }
        }
        ctx.fields.push({ label: p.field.field === "initials" ? p.field.label : tokenFieldLabel(p.field.label), type: p.field.field, page: ctx.pageIndex + 1,
          x: box.x / DOC_PAGE_W, y: (DOC_PAGE_H - (box.y + box.h)) / DOC_PAGE_H, w: Math.min(box.w, DOC_PAGE_W - box.x) / DOC_PAGE_W, h: box.h / DOC_PAGE_H });
      } else {
        let segs = p.segs;
        if (p.kind === "var" && p.varWhich) segs = this.segments(String(p.varWhich === "page" ? ctx.pageIndex + 1 : ctx.total), p.style, p.size);
        let sx = x;
        for (const s of segs) {
          if (s.text.trim()) page.drawText(s.text, { x: sx, y: baseline + shift, size: p.size, font: s.font, color: colour });
          sx += s.width;
        }
        if (p.style.underline && textW > 0) page.drawLine({ start: { x, y: baseline - p.size * 0.12 }, end: { x: x + textW, y: baseline - p.size * 0.12 }, thickness: Math.max(0.5, p.size * 0.05), color: colour });
        if (p.style.strike && textW > 0) page.drawLine({ start: { x, y: baseline + p.size * 0.28 }, end: { x: x + textW, y: baseline + p.size * 0.28 }, thickness: Math.max(0.5, p.size * 0.05), color: colour });
        if (p.style.href && textW > 0) linkAnnotation(ctx, x, baseline - p.size * 0.25, textW, p.size * 1.15, p.style.href);
      }
      x += p.width + (justify && p.breakAfter && index < line.pieces.length - 1 && p.kind === "text" ? free / line.spaces : 0);
    });
  }

  /** A table as one item per row; each row draws its own cells, shading and borders, so a page break never leaves a row open. */
  private table(table: Table, available: number, vars: { page: number; total: number } | null): Item[] {
    const width = table.width ? ("pct" in table.width ? available * table.width.pct / 100 : Math.min(available, table.width.pt)) : available;
    const columns = Math.max(1, ...table.rows.map((row) => row.reduce((n, c) => n + c.colspan, 0)));
    const set: Array<number | null> = Array(columns).fill(null);
    for (const row of table.rows) {
      let col = 0;
      for (const cell of row) {
        if (cell.colspan === 1 && cell.width && set[col] === null) set[col] = "pct" in cell.width ? width * cell.width.pct / 100 : cell.width.pt;
        col += cell.colspan;
      }
    }
    const fixed = set.reduce<number>((n, w) => n + (w ?? 0), 0);
    const open = set.filter((w) => w === null).length;
    let widths = set.map((w) => w ?? (open ? Math.max(20, (width - fixed) / open) : 0));
    const sum = widths.reduce((n, w) => n + w, 0);
    if (sum > width || (open === 0 && sum < width)) widths = widths.map((w) => w * width / sum);
    const items: Item[] = [];
    for (const row of table.rows) {
      let col = 0;
      const cells = row.map((cell) => {
        const w = widths.slice(col, col + cell.colspan).reduce((n, x) => n + x, 0);
        const x = widths.slice(0, col).reduce((n, v) => n + v, 0);
        col += cell.colspan;
        return { cell, x, w, items: this.items(cell.blocks, Math.max(10, w - 2 * CELL_PAD), vars) };
      });
      items.push(this.rowItem(cells, width, table.border));
    }
    return items;
  }
  private rowItem(cells: Array<{ cell: Cell; x: number; w: number; items: Item[] }>, width: number, border: boolean): Item {
    const contentHeight = (list: Item[]) => list.reduce((n, it) => n + it.height, 0);
    const height = Math.max(...cells.map((c) => contentHeight(c.items)), 0) + 2 * CELL_PAD;
    const layout = this;
    return {
      height, row: true,
      draw(ctx, x0, top) {
        layout.placed.push({ kind: "row", page: ctx.pageIndex + 1, top, bottom: top - height });
        for (const c of cells) {
          if (c.cell.background) ctx.page.drawRectangle({ x: x0 + c.x, y: top - height, width: c.w, height, color: hexRgb(c.cell.background) });
          const inner = contentHeight(c.items);
          const offset = c.cell.valign === "middle" ? (height - 2 * CELL_PAD - inner) / 2 : c.cell.valign === "bottom" ? height - 2 * CELL_PAD - inner : 0;
          let y = top - CELL_PAD - offset;
          for (const it of c.items) { it.draw(ctx, x0 + c.x + CELL_PAD, y); y -= it.height; }
        }
        if (border) {
          const line = (a: [number, number], b: [number, number]) => ctx.page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: 0.5, color: rgb(0, 0, 0) });
          line([x0, top], [x0 + width, top]);
          line([x0, top - height], [x0 + width, top - height]);
          line([x0, top], [x0, top - height]);
          for (const c of cells) line([x0 + c.x + c.w, top], [x0 + c.x + c.w, top - height]);
        }
      },
      split(room) {
        // Only for a row taller than a page: as much of every cell as fits here, the rest on the next page.
        const budget = room - 2 * CELL_PAD;
        if (budget <= 0) return null;
        const firsts: typeof cells = [], rests: typeof cells = [];
        let any = false;
        for (const c of cells) {
          let used = 0, k = 0;
          while (k < c.items.length && used + c.items[k].height <= budget) { used += c.items[k].height; k++; }
          if (k > 0) any = true;
          firsts.push({ ...c, items: c.items.slice(0, k) });
          rests.push({ ...c, items: c.items.slice(k) });
        }
        if (!any) return null;
        return [layout.rowItem(firsts, width, border), layout.rowItem(rests, width, border)];
      },
    };
  }
}

function hexRgb(hex: string) { const n = parseInt(hex.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); }
function linkAnnotation(ctx: DrawCtx, x: number, y: number, w: number, h: number, url: string) {
  const pdf = ctx.page.doc;
  const ref = pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Link", Rect: [x, y, x + w, y + h], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of(url) } }));
  ctx.page.node.addAnnot(ref);
}

/* ------------------------------------------------------------------ the document */
export interface DocumentInput {
  title: string;
  header?: string | null;
  body: string;
  footer?: string | null;
  /** Record values by key (student.full_name, course.intake, current_date, full_name...). */
  values: Record<string, string>;
  /** [Variable] tokens are placeholders (templates saved in the sectioned editor); off: square brackets are text. */
  brackets: boolean;
  /** Preview: a missing value shows as [Name], a signer field shows its label. */
  sample?: boolean;
}
export interface DocumentResult {
  bytes: Uint8Array; pages: number; fields: PlacedField[]; missing: string[]; unsupported: string | null;
  /** Where each table row landed, for the tests (a row is never split unless taller than a page). */
  placed: Array<{ kind: "row"; page: number; top: number; bottom: number }>;
}

const imageSources = (html: string) => [...String(html ?? "").matchAll(/<img\b[^>]*\ssrc="(data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*)"/g)].map((m) => m[1]);

export async function buildDocumentPdf(input: DocumentInput): Promise<DocumentResult> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(input.title.slice(0, 200));
  pdf.setProducer("Skyline ERP");
  pdf.setCreator("Skyline ERP");
  const fonts = await embedFonts(pdf);
  const images = new Map<string, PDFImage>();
  const header = sanitizeRichHtml(input.header ?? ""), body = sanitizeRichHtml(input.body ?? ""), footer = sanitizeRichHtml(input.footer ?? "");
  for (const src of [...imageSources(header), ...imageSources(body), ...imageSources(footer)]) {
    if (images.has(src)) continue;
    const bytes = fromBase64(src.slice(src.indexOf(",") + 1));
    try { images.set(src, src.startsWith("data:image/png") ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes)); } catch { /* an unreadable picture is left out */ }
  }
  const tokens: TokenContext | null = input.brackets ? { values: input.values, sample: !!input.sample, missing: new Set() } : null;
  const headerBlocks = header ? blocksOf(header, tokens) : [];
  const bodyBlocks = blocksOf(body, tokens);
  const footerBlocks = footer ? blocksOf(footer, tokens) : [];
  if (!bodyBlocks.some((b) => b.kind !== "para" || b.inlines.length)) throw new Error("The document is empty.");
  const layout = new Layout(fonts, images);
  const width = DOC_PAGE_W - 2 * DOC_MARGIN_X;
  const heightOf = (items: Item[]) => items.reduce((n, it) => n + it.height, 0);
  // Header and footer measured with three-digit page numbers; drawn per page with the real ones.
  const headerH = headerBlocks.length ? heightOf(layout.items(headerBlocks, width, null)) : 0;
  const footerH = footerBlocks.length ? heightOf(layout.items(footerBlocks, width, null)) : 0;
  const bodyTop = headerH ? DOC_PAGE_H - DOC_BAND - headerH - BAND_GAP : DOC_PAGE_H - BODY_MARGIN;
  const bodyBottom = footerH ? DOC_BAND + footerH + BAND_GAP : BODY_MARGIN;
  const pageRoom = bodyTop - bodyBottom;
  if (pageRoom < 200) throw new Error("The header and footer leave too little room for the text. Make them shorter.");

  // Paginate the body.
  const pages: Array<Array<{ item: Item; top: number }>> = [[]];
  let y = bodyTop;
  const queue = layout.items(bodyBlocks, width, null);
  const newPage = () => { pages.push([]); y = bodyTop; if (pages.length > MAX_DOCUMENT_PAGES) throw new Error(`The document is longer than ${MAX_DOCUMENT_PAGES} pages.`); };
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const atTop = y === bodyTop;
    if (item.gap && atTop) continue;
    const room = y - bodyBottom;
    if (item.keep && !atTop) {
      let k = i + 1; while (k < queue.length && queue[k].gap) k++;
      const next = queue[k];
      if (next && item.height + (next.height <= pageRoom ? next.height : 0) > room) { newPage(); i--; continue; }
    }
    if (item.height <= room) { pages[pages.length - 1].push({ item, top: y }); y -= item.height; continue; }
    if (item.height <= pageRoom && !atTop) { newPage(); i--; continue; }
    // Taller than what is left on an empty page: a row is split; a single line (a huge picture) is placed anyway.
    const parts = item.split?.(room) ?? null;
    if (parts) { pages[pages.length - 1].push({ item: parts[0], top: y }); queue.splice(i + 1, 0, parts[1]); newPage(); continue; }
    if (!atTop) { newPage(); i--; continue; }
    pages[pages.length - 1].push({ item, top: y }); y -= item.height;
  }
  while (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();

  const total = pages.length;
  const fields: PlacedField[] = [];
  pages.forEach((placed, index) => {
    const page = pdf.addPage([DOC_PAGE_W, DOC_PAGE_H]);
    const ctx: DrawCtx = { page, pageIndex: index, total, fields, sample: !!input.sample };
    if (headerBlocks.length) { let hy = DOC_PAGE_H - DOC_BAND; for (const it of layout.items(headerBlocks, width, { page: index + 1, total })) { it.draw(ctx, DOC_MARGIN_X, hy); hy -= it.height; } }
    for (const { item, top } of placed) item.draw(ctx, DOC_MARGIN_X, top);
    if (footerBlocks.length) {
      const items = layout.items(footerBlocks, width, { page: index + 1, total });
      let fy = DOC_BAND + heightOf(items);
      for (const it of items) { it.draw(ctx, DOC_MARGIN_X, fy); fy -= it.height; }
    }
  });
  const unsupported = layout.unsupported.size ? [...layout.unsupported].join("") : null;
  return { bytes: await pdf.save({ useObjectStreams: true }), pages: total, fields, missing: [...(tokens?.missing ?? [])], unsupported, placed: layout.placed };
}
