import { useEffect, useState } from "react";

/** ASM-PDF-TEMPLATE: the workbook PDF opened with pdf.js (page sizes in points), and the text measure the fit preview uses. */
type PdfPage = { getViewport(o: { scale: number }): { width: number; height: number }; render(o: Record<string, unknown>): { promise: Promise<void>; cancel(): void } };
export type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage>; destroy?: () => Promise<void> };
/** ops: pdf.js's operator codes (the question reader walks a page's drawing operators). */
export interface PdfHandle { doc: PdfDoc; sizes: { w: number; h: number }[]; ops?: Record<string, number> }

export function usePdf(bytes: Uint8Array | null): { pdf: PdfHandle | null; error: string } {
  const [pdf, setPdf] = useState<PdfHandle | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false; let task: { promise: Promise<unknown>; destroy(): Promise<void> } | null = null;
    void (async () => {
      try {
        const [lib, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
        lib.GlobalWorkerOptions.workerSrc = worker.default;
        // font names are kept (fontExtraProperties) so a question's bold / italic words are read as printed
        task = lib.getDocument({ data: bytes.slice(), fontExtraProperties: true }) as unknown as typeof task;
        const doc = await task!.promise as PdfDoc;
        const sizes: { w: number; h: number }[] = [];
        for (let n = 1; n <= doc.numPages; n++) { const v = (await doc.getPage(n)).getViewport({ scale: 1 }); sizes.push({ w: v.width, h: v.height }); }
        if (!cancelled) setPdf({ doc, sizes, ops: lib.OPS as unknown as Record<string, number> });
      } catch { if (!cancelled) setError("The workbook could not be shown here."); }
    })();
    return () => { cancelled = true; void task?.destroy().catch(() => undefined); };
  }, [bytes]);
  return { pdf, error };
}

let measureCtx: CanvasRenderingContext2D | null = null;
export function measureText(s: string, size: number): number {
  if (typeof document === "undefined") return s.length * size * 0.5;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return s.length * size * 0.5;
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(s).width;
}
