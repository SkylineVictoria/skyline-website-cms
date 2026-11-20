// True redaction of a line's tail in a PDF page (2026-11-21, P06 Item 4): the glyphs are removed from the page's content stream, so
// copy, search and text extraction no longer find them; pictures (the watermark), drawings and every other text stay as they were.
// Runtime-neutral (the Deno function and the Node tests); pdf-lib from the import map or node_modules.
import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, type PDFDocument, type PDFPage } from "pdf-lib";

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const latin1 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return s; };
const toBytes = (s: string) => { const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff; return out; };

interface FontInfo { twoByte: boolean; unicode: Map<number, string> }
/** A ToUnicode CMap: glyph code -> text (bfchar and bfrange). */
export function readToUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>();
  const text = (hex: string) => { let s = ""; for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16)); return s; };
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) out.set(parseInt(m[1], 16), text(m[2]));
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[3]) { const base = parseInt(m[3], 16); for (let c = lo; c <= hi && c - lo < 65536; c++) out.set(c, String.fromCharCode(base + c - lo)); }
      else [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((u, i) => { if (lo + i <= hi) out.set(lo + i, text(u[1])); });
    }
  }
  return out;
}
function fontsOf(pdf: PDFDocument, page: PDFPage): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>();
  const fonts = page.node.Resources()?.lookup(PDFName.of("Font"));
  if (!(fonts instanceof PDFDict)) return out;
  for (const [name, ref] of fonts.entries()) {
    const font = pdf.context.lookup(ref);
    if (!(font instanceof PDFDict)) continue;
    const twoByte = String(font.get(PDFName.of("Subtype"))) === "/Type0";
    const map = pdf.context.lookup(font.get(PDFName.of("ToUnicode")));
    const unicode = map instanceof PDFRawStream ? readToUnicode(latin1(decodePDFRawStream(map).decode())) : new Map<number, string>();
    out.set(name.asString().replace(/^\//, ""), { twoByte, unicode });
  }
  return out;
}

// ---------------------------------------------------------------- content stream tokens (the operands kept as their exact source text)
type Token = { kind: "num"; value: number; start: number; end: number } | { kind: "str"; bytes: string; start: number; end: number }
  | { kind: "name" | "op"; value: string; start: number; end: number } | { kind: "array"; items: Token[]; start: number; end: number } | { kind: "other"; start: number; end: number };
const WHITE = /[\0\t\n\f\r ]/, DELIM = /[()<>[\]{}/%]/;
function tokenize(src: string, onOp: (op: string, operands: Token[], start: number, end: number) => void): void {
  let i = 0;
  const stack: Token[] = [];
  const literal = (): Token => {
    const start = i; i++; let depth = 1, out = "";
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "\\") {
        const n = src[i + 1];
        const esc: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
        if (n in esc) { out += esc[n]; i += 2; continue; }
        if (/[0-7]/.test(n)) { const m = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4))![0]; out += String.fromCharCode(parseInt(m, 8) & 0xff); i += 1 + m.length; continue; }
        if (n === "\r") { i += src[i + 2] === "\n" ? 3 : 2; continue; }
        if (n === "\n") { i += 2; continue; }
        i += 1; continue;
      }
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (!depth) { i++; break; } }
      out += c; i++;
    }
    return { kind: "str", bytes: out, start, end: i };
  };
  const value = (): Token | null => {
    while (i < src.length) {
      const c = src[i];
      if (WHITE.test(c)) { i++; continue; }
      if (c === "%") { while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
      break;
    }
    if (i >= src.length) return null;
    const c = src[i], start = i;
    if (c === "(") return literal();
    if (c === "<" && src[i + 1] === "<") {
      // A dictionary (marked-content properties): kept as text, nested ones included.
      let depth = 0;
      while (i < src.length) {
        if (src[i] === "<" && src[i + 1] === "<") { depth++; i += 2; continue; }
        if (src[i] === ">" && src[i + 1] === ">") { depth--; i += 2; if (!depth) break; continue; }
        if (src[i] === "(") { literal(); continue; }
        i++;
      }
      return { kind: "other", start, end: i };
    }
    if (c === "<") { const close = src.indexOf(">", i); const hex = src.slice(i + 1, close).replace(/\s+/g, ""); i = close + 1;
      let bytes = ""; for (let k = 0; k < hex.length; k += 2) bytes += String.fromCharCode(parseInt((hex.slice(k, k + 2) + "0").slice(0, 2), 16)); return { kind: "str", bytes, start, end: i }; }
    if (c === "[") { i++; const items: Token[] = []; for (;;) { while (i < src.length && WHITE.test(src[i])) i++; if (src[i] === "]") { i++; break; } const t = value(); if (!t) break; items.push(t); } return { kind: "array", items, start, end: i }; }
    if (c === "/") { i++; while (i < src.length && !WHITE.test(src[i]) && !DELIM.test(src[i])) i++; return { kind: "name", value: src.slice(start + 1, i), start, end: i }; }
    while (i < src.length && !WHITE.test(src[i]) && !DELIM.test(src[i])) i++;
    if (i === start) { i++; return { kind: "other", start, end: i }; }
    const word = src.slice(start, i);
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ? { kind: "num", value: Number(word), start, end: i } : { kind: "op", value: word, start, end: i };
  };
  for (;;) {
    const t = value();
    if (!t) break;
    if (t.kind !== "op") { stack.push(t); continue; }
    if (t.value === "BI") {
      // An inline image: skipped whole (to EI), never looked into.
      const at = src.slice(i).search(/\sEI(?=[\s]|$)/);
      i = at < 0 ? src.length : i + at + 3;
      stack.length = 0; continue;
    }
    const operands = stack.splice(0);
    onOp(t.value, operands, operands.length ? operands[0].start : t.start, t.end);
  }
}

interface Shown { op: string; operands: Token[]; start: number; end: number; font: FontInfo; y: number; glyphs: Array<{ code: string; text: string; item: number }> }
const hex = (bytes: string) => Array.from(bytes, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();

/**
 * Removes from the page the text of one line from `from` to the end of that line: the line whose baseline is `baseline` pt (page space)
 * within `tolerance`. Only the shown glyphs go (their strings shortened or emptied); positioning operators, pictures and all other text
 * stay. The page gets ONE new content stream (the old ones joined, edited and compressed again). False when the text is not on the page.
 */
export function redactLineFrom(pdf: PDFDocument, page: PDFPage, options: { baseline: number; from: string; tolerance?: number }): boolean {
  const contents = page.node.Contents();
  const parts = contents instanceof PDFArray ? contents.asArray().map((r) => pdf.context.lookup(r)) : contents ? [contents] : [];
  if (!parts.length || !parts.every((p) => p instanceof PDFRawStream)) return false;
  const src = parts.map((p) => latin1(decodePDFRawStream(p as PDFRawStream).decode())).join("\n");
  const fonts = fontsOf(pdf, page);
  const tolerance = options.tolerance ?? 0.6;
  // Graphics and text state: enough to know each text operator's baseline (CTM, Tm, Tlm, leading, font).
  let ctm: Matrix = [1, 0, 0, 1, 0, 0]; const saved: Matrix[] = [];
  let tm: Matrix = [1, 0, 0, 1, 0, 0], tlm: Matrix = [1, 0, 0, 1, 0, 0], leading = 0, font: FontInfo | null = null;
  const shown: Shown[] = [];
  const num = (t: Token | undefined) => (t && t.kind === "num" ? t.value : 0);
  const nextLine = (tx: number, ty: number) => { tlm = multiply([1, 0, 0, 1, tx, ty], tlm); tm = [...tlm] as Matrix; };
  const glyphsOf = (bytes: string, item: number) => {
    const out: Shown["glyphs"] = [];
    const step = font?.twoByte ? 2 : 1;
    for (let k = 0; k + step <= bytes.length; k += step) {
      const code = step === 2 ? (bytes.charCodeAt(k) << 8) | bytes.charCodeAt(k + 1) : bytes.charCodeAt(k);
      out.push({ code: bytes.slice(k, k + step), text: font?.unicode.get(code) ?? (step === 1 ? String.fromCharCode(code) : "�"), item });
    }
    return out;
  };
  tokenize(src, (op, operands, start, end) => {
    switch (op) {
      case "q": saved.push([...ctm] as Matrix); break;
      case "Q": ctm = saved.pop() ?? [1, 0, 0, 1, 0, 0]; break;
      case "cm": if (operands.length >= 6) ctm = multiply(operands.slice(-6).map(num) as Matrix, ctm); break;
      case "BT": tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
      case "Tf": { const name = operands.find((t) => t.kind === "name"); font = name && name.kind === "name" ? fonts.get(name.value) ?? null : null; break; }
      case "TL": leading = num(operands[0]); break;
      case "Td": nextLine(num(operands[0]), num(operands[1])); break;
      case "TD": leading = -num(operands[1]); nextLine(num(operands[0]), num(operands[1])); break;
      case "Tm": if (operands.length >= 6) { tm = operands.slice(-6).map(num) as Matrix; tlm = [...tm] as Matrix; } break;
      case "T*": nextLine(0, -leading); break;
      case "'": case "\"": case "Tj": case "TJ": {
        if (op === "'" || op === "\"") nextLine(0, -leading);
        if (!font) break;
        const y = multiply(tm, ctm)[5];
        const strings = op === "TJ" ? (operands[0]?.kind === "array" ? operands[0].items : []) : operands.filter((t) => t.kind === "str");
        // item = the string's index among the operator's STRINGS (kerning numbers not counted), as the rebuild below counts them.
        let item = -1;
        const glyphs = strings.flatMap((t) => (t.kind === "str" ? glyphsOf(t.bytes, ++item) : []));
        shown.push({ op, operands, start, end, font, y, glyphs });
        break;
      }
    }
  });
  const line = shown.filter((s) => Math.abs(s.y - options.baseline) <= tolerance);
  const text = line.flatMap((s) => s.glyphs.map((g) => g.text)).join("");
  const at = text.indexOf(options.from);
  if (at < 0) return false;
  // Glyph index (in the line) where the removal starts: the text index mapped back through each glyph's text length.
  let seen = 0, cut = -1, index = 0;
  for (const s of line) for (const g of s.glyphs) { if (cut < 0 && seen >= at) cut = index; seen += g.text.length; index++; }
  if (cut < 0) return false;
  // Rebuild each touched operator with only the glyphs before the cut.
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let g0 = 0;
  for (const s of line) {
    const keep = Math.max(0, Math.min(s.glyphs.length, cut - g0));
    g0 += s.glyphs.length;
    if (keep === s.glyphs.length) continue;
    const kept = s.glyphs.slice(0, keep);
    const byItem = new Map<number, string>();
    for (const g of kept) byItem.set(g.item, (byItem.get(g.item) ?? "") + g.code);
    let body: string;
    if (s.op === "TJ") {
      const items = s.operands[0]?.kind === "array" ? s.operands[0].items : [];
      const lastItem = kept.length ? kept[kept.length - 1].item : -1;
      const out: string[] = [];
      let strIndex = -1;
      for (const t of items) {
        if (t.kind === "str") { strIndex++; if (strIndex > lastItem) break; out.push(`<${hex(byItem.get(strIndex) ?? "")}>`); }
        else if (t.kind === "num" && strIndex < lastItem) out.push(String(t.value));
      }
      body = `[${out.join(" ")}] TJ`;
    } else {
      const prefix = s.op === "\"" ? `${s.operands.filter((t) => t.kind === "num").map((t) => (t as { value: number }).value).join(" ")} ` : "";
      body = `${prefix}<${hex(byItem.get(0) ?? "")}> ${s.op}`;
    }
    edits.push({ start: s.start, end: s.end, text: body });
  }
  if (!edits.length) return false;
  let out = "", pos = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) { out += src.slice(pos, e.start) + e.text; pos = e.end; }
  out += src.slice(pos);
  const stream = pdf.context.flateStream(toBytes(out));
  const ref: PDFRef = pdf.context.register(stream as unknown as PDFStream);
  // The old streams are deleted from the document (a full save then holds no copy of the removed words), unless another page uses them.
  const raw = page.node.get(PDFName.of("Contents"));
  const oldRefs = raw instanceof PDFRef ? [raw, ...(contents instanceof PDFArray ? contents.asArray().filter((r): r is PDFRef => r instanceof PDFRef) : [])]
    : contents instanceof PDFArray ? contents.asArray().filter((r): r is PDFRef => r instanceof PDFRef) : [];
  page.node.set(PDFName.of("Contents"), ref);
  const usedElsewhere = new Set<string>();
  for (const other of pdf.getPages()) {
    if (other === page) continue;
    const c = other.node.get(PDFName.of("Contents"));
    const refs = c instanceof PDFRef ? [c, ...((pdf.context.lookup(c) instanceof PDFArray) ? (pdf.context.lookup(c) as PDFArray).asArray() : [])] : c instanceof PDFArray ? c.asArray() : [];
    for (const r of refs) if (r instanceof PDFRef) usedElsewhere.add(r.toString());
  }
  for (const r of oldRefs) if (!usedElsewhere.has(r.toString())) pdf.context.delete(r);
  return true;
}
