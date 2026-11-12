import { useEffect, useState } from "react";

export type ReadingPhase = "uploading" | "queued" | "processing";

const STAGES = ["Uploading…", "Reading your document…", "Finding your details…", "Almost there…"] as const;
// Twice the thumbnail's 56px width, for sharp screens.
const THUMB_WIDTH = 112;
type PdfDocument = { getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: Record<string, unknown>): { promise: Promise<void> } }> };
const MESSAGES =["Good things take a few seconds ✨", "You won’t regret the wait", "Saving you from typing all this", "Double-checking every letter"] as const;

/**
 * What a document looks like while it is uploaded and read, used by the application form and by the document wizards: the
 * document (the picture, or page 1 of a PDF, when this browser has the file) with an orange line sweeping over it, the stages ticking off, a rotating
 * friendly line and a thin progress bar. The stages follow the real states (uploading, queued, being read); within a state they
 * move on with time, since the reader reports no finer progress. With reduced motion there is no sweep, only the text changes.
 */
export default function DocumentReadingState({ filename, file, phase, uploadProgress }: {
  filename: string;
  /** The picked file, when this browser still has it: an image is shown as the thumbnail. */
  file?: File | null;
  phase: ReadingPhase;
  /** 0 to 1 while uploading, when the uploader reports it. */
  uploadProgress?: number;
}) {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [thumb, setThumb] = useState("");
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!file) return undefined;
    if (file.type.startsWith("image/")) {
      const url = URL.createObjectURL(file);
      setThumb(url);
      return () => URL.revokeObjectURL(url);
    }
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return undefined;
    // A PDF: page 1, drawn small by pdf.js (already used by the signing viewer, loaded only here); the drawn page stays otherwise.
    let cancelled = false;
    let task: { promise: Promise<unknown>; destroy(): Promise<void> } | null = null;
    void (async () => {
      try {
        const [pdf, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
        pdf.GlobalWorkerOptions.workerSrc = worker.default;
        task = pdf.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }) as unknown as typeof task;
        const doc = await task!.promise as PdfDocument;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
        await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
        if (!cancelled) setThumb(canvas.toDataURL("image/png"));
      } catch { /* not drawable here: the drawn page stays */ }
    })();
    return () => { cancelled = true; void task?.destroy().catch(() => undefined); };
  }, [file]);

  const elapsed = now - since;
  const timed = elapsed < 4000 ? 1 : elapsed < 10000 ? 2 : 3;
  const stage = phase === "uploading" ? 0 : phase === "queued" ? Math.max(1, Math.min(timed, 2)) : Math.max(2, timed);
  const percent = phase === "uploading"
    ? Math.round(5 + 20 * (typeof uploadProgress === "number" ? uploadProgress : 1 - Math.exp(-elapsed / 3000)))
    : Math.min(95, Math.round(25 + 70 * (1 - Math.exp(-elapsed / 15000))));
  const message = MESSAGES[Math.floor(elapsed / 3000) % MESSAGES.length];

  return (
    <div className="fade-in overflow-hidden rounded-lg border border-background-200 bg-background-50 p-3" data-testid="document-reading">
      <div className="flex items-start gap-3">
        <div className="relative h-[72px] w-14 shrink-0 overflow-hidden rounded-md border border-background-200 bg-background-100">
          {thumb ? (
            <img src={thumb} alt="" className="h-full w-full object-cover object-top" />
          ) : (
            <div className="space-y-1.5 p-2" aria-hidden="true">
              <div className="h-1.5 w-7 rounded bg-background-300" />
              {[10, 8, 9, 6, 9, 7].map((width, index) => <div key={index} className="h-1 rounded bg-background-200" style={{ width: `${width * 4}px` }} />)}
            </div>
          )}
          <span className="doc-scan-line" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground-900" title={filename}>{filename}</p>
          <ol className="mt-1 space-y-0.5" aria-label="Progress">
            {STAGES.map((label, index) => (
              <li key={label} className={`flex items-center gap-1.5 text-xs transition-colors duration-200 ${index < stage ? "text-foreground-600" : index === stage ? "font-medium text-foreground-900" : "text-foreground-400"}`}>
                {index < stage ? (
                  <i className="ri-check-line text-sm leading-none text-emerald-700" aria-hidden="true" />
                ) : index === stage ? (
                  <i className="ri-loader-4-line animate-spin text-sm leading-none text-primary-600" aria-hidden="true" />
                ) : (
                  <span className="flex h-3.5 w-3.5 items-center justify-center" aria-hidden="true"><span className="h-1.5 w-1.5 rounded-full bg-background-300" /></span>
                )}
                {label}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p key={message} className="fade-in mt-2 truncate text-xs text-foreground-500">{message}</p>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-background-200" role="progressbar" aria-label={`Reading ${filename}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="h-full rounded-full bg-primary-500 transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
      </div>
      <span className="sr-only" role="status">{STAGES[stage]}</span>
    </div>
  );
}
