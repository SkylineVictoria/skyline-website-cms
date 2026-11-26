/**
 * ASM-PDF-TEMPLATE: what a PDF page draws and writes, as the detector reads it: filled / stroked rectangles, thin lines (table borders),
 * curved shapes (the Yes / No circles, rounded tick squares) and text with its position. PDF points, origin TOP-left (y down).
 * Uses pdf.js's operator list (pdf.js 6: one constructPath per painted path, with its paint op and path data). Browser and Node.
 */
export interface Box { x: number; y: number; w: number; h: number }
export interface DrawnRect extends Box { fill: string | null; stroke: string | null }
export interface DrawnLine extends Box { dir: "h" | "v" }
export interface DrawnCurve extends Box { fill: string | null; stroke: string | null }
export interface PageText extends Box { s: string }
export interface PageModel { page: number; W: number; H: number; rects: DrawnRect[]; lines: DrawnLine[]; curves: DrawnCurve[]; texts: PageText[] }

/** The subset of pdf.js the model needs (pdfjs-dist legacy build, browser or Node). */
export interface PdfJsLike { OPS: Record<string, number> }
interface PdfPageLike {
  getViewport(o: { scale: number }): { width: number; height: number };
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  getTextContent(): Promise<{ items: unknown[] }>;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: number[]): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m: M, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const colour = (c: unknown): string => {
  if (typeof c === "string") return c.toLowerCase();
  if (Array.isArray(c) || ArrayBuffer.isView(c)) return "#" + Array.from(c as ArrayLike<number>).slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  return String(c);
};

export async function pageModel(pdfjs: PdfJsLike, page: PdfPageLike, number: number): Promise<PageModel> {
  const OPS = pdfjs.OPS;
  const FILL = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width; const H = vp.height;
  const list = await page.getOperatorList();
  let ctm: M = [1, 0, 0, 1, 0, 0]; let fill = "#000000"; let stroke = "#000000";
  const stack: { ctm: M; fill: string; stroke: string }[] = [];
  const rects: DrawnRect[] = []; const lines: DrawnLine[] = []; const curves: DrawnCurve[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i]; const a = list.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push({ ctm, fill, stroke });
    else if (fn === OPS.restore) { const s = stack.pop(); if (s) ({ ctm, fill, stroke } = s); }
    else if (fn === OPS.transform) ctm = mul(ctm, a as number[]);
    else if (fn === OPS.setFillRGBColor || fn === OPS.setFillColor) fill = colour(a?.[0] ?? a);
    else if (fn === OPS.setStrokeRGBColor || fn === OPS.setStrokeColor) stroke = colour(a?.[0] ?? a);
    else if (fn === OPS.setFillGray) fill = colour([Number(a[0]) * 255, Number(a[0]) * 255, Number(a[0]) * 255]);
    else if (fn === OPS.setStrokeGray) stroke = colour([Number(a[0]) * 255, Number(a[0]) * 255, Number(a[0]) * 255]);
    else if (fn === OPS.constructPath) {
      const paint = a[0] as number; const data = (a[1] as ArrayLike<number>[] | undefined)?.[0];
      if (!data) continue;
      const isFill = FILL.has(paint); const isStroke = STROKE.has(paint);
      if (!isFill && !isStroke) continue;
      const subs: { pts: number[][]; curve: boolean }[] = [];
      let pts: number[][] = []; let curve = false;
      const flush = () => { if (pts.length) subs.push({ pts, curve }); pts = []; curve = false; };
      for (let k = 0; k < data.length;) {
        const op = data[k++];
        if (op === 0) { flush(); pts.push(apply(ctm, data[k++], data[k++])); }
        else if (op === 1) pts.push(apply(ctm, data[k++], data[k++]));
        else if (op === 2) { curve = true; k += 4; pts.push(apply(ctm, data[k++], data[k++])); }
        else if (op === 3) { curve = true; k += 2; pts.push(apply(ctm, data[k++], data[k++])); }
        // 4 = closePath
      }
      flush();
      for (const s of subs) {
        const xs = s.pts.map((p) => p[0]); const ys = s.pts.map((p) => H - p[1]);
        const b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        if (s.curve) { curves.push({ ...b, fill: isFill ? fill : null, stroke: isStroke ? stroke : null }); continue; }
        // a border is a hairline or a thin filled rectangle
        if (b.w < 2 || b.h < 2) { if (b.w >= 2 || b.h >= 2) lines.push({ ...b, dir: b.w >= b.h ? "h" : "v" }); continue; }
        rects.push({ ...b, fill: isFill ? fill : null, stroke: isStroke ? stroke : null });
      }
    }
  }
  const tc = await page.getTextContent();
  const texts: PageText[] = [];
  for (const raw of tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
    // pdf.js returns control characters (NUL) for some bullet glyphs; jsonb refuses them
    const s = Array.from(raw.str ?? "", (c) => (c.charCodeAt(0) < 32 ? " " : c)).join("").trim();
    if (!s || !raw.transform) continue;
    const h = Math.abs(raw.transform[3]) || raw.height || 10;
    // y = the top of the text (baseline minus its size)
    texts.push({ s, x: raw.transform[4], y: H - raw.transform[5] - h * 0.8, w: raw.width ?? s.length * h * 0.5, h });
  }
  return { page: number, W, H, rects, lines, curves, texts };
}
