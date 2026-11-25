/**
 * ASM-IMPORT, browser side: reads an uploaded .docx (mammoth HTML) or .pdf (pdf.js text with positions) and maps it with
 * `buildFromLines`. Nothing is uploaded. A PDF without a text layer (a scan) is refused with a plain message: reading scans would
 * need the document reader (portal-document-extract / Azure), which is not wired to this screen.
 * ASM-WORKBOOK (2026-11-23): a PDF's pictures (drawings, site plans; not the repeated header logo) are rendered here, each to a JPEG
 * of at most 1200 px wide, and placed in the instructions where they sit in the workbook.
 */
import { buildFromLines, imageRegionsFromPdf, linesFromDocxHtml, linesFromPdf, type ImportResult, type PdfDocLike, type PdfOps, type WbImage } from "./workbookImport";

const MAX_PICTURE_PX = 1200;
const MAX_PICTURES = 30;

interface RenderablePage {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }) => { promise: Promise<void> };
}

/** Renders each region's page once and cuts the regions out as JPEG data URLs; a region that cannot be drawn is left out. */
export async function renderRegions(doc: { getPage: (n: number) => Promise<unknown> }, regions: Omit<WbImage, "src">[]): Promise<WbImage[]> {
  const out: WbImage[] = [];
  const byPage = new Map<number, Omit<WbImage, "src">[]>();
  for (const r of regions.slice(0, MAX_PICTURES)) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);
  for (const [pageNo, list] of byPage) {
    try {
      const page = (await doc.getPage(pageNo)) as RenderablePage;
      const widest = Math.max(...list.map((r) => r.width));
      const scale = Math.min(3, Math.max(1, MAX_PICTURE_PX / Math.max(1, widest)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const pageHeight = viewport.height / scale;
      for (const r of list) {
        const crop = document.createElement("canvas");
        crop.width = Math.max(1, Math.round(r.width * scale)); crop.height = Math.max(1, Math.round(r.height * scale));
        crop.getContext("2d")?.drawImage(canvas, r.x * scale, (pageHeight - r.top) * scale, crop.width, crop.height, 0, 0, crop.width, crop.height);
        out.push({ ...r, src: crop.toDataURL("image/jpeg", 0.82) });
      }
      canvas.width = 0; canvas.height = 0;
    } catch { /* a picture that cannot be drawn is skipped; the import still works */ }
  }
  return out;
}

export async function readWorkbook(file: File): Promise<ImportResult> {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith(".docx")) {
    const imported = await import("mammoth");
    const mammoth = (imported as unknown as { default?: typeof imported }).default ?? imported;
    const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes.slice().buffer as ArrayBuffer }, { ignoreEmptyParagraphs: false } as Parameters<typeof mammoth.convertToHtml>[1]);
    return buildFromLines(linesFromDocxHtml(value), { fileName: file.name });
  }
  if (name.endsWith(".pdf")) {
    const [pdf, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
    pdf.GlobalWorkerOptions.workerSrc = worker.default;
    const doc = await pdf.getDocument({ data: bytes.slice() }).promise;
    try {
      const { lines, pages, textChars, version } = await linesFromPdf(doc as unknown as PdfDocLike);
      if (textChars < pages * 40) throw new Error("This PDF has no readable text (it looks like a scan). Upload the Word file, or a PDF with selectable text.");
      let images: WbImage[] = [];
      try { images = await renderRegions(doc, await imageRegionsFromPdf(doc, pdf.OPS as unknown as PdfOps)); } catch { images = []; }
      return buildFromLines(lines, { fileName: file.name, images, version });
    } finally { void doc.cleanup(); }
  }
  throw new Error("Choose a Word (.docx) or PDF workbook.");
}
