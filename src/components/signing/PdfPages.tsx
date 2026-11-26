import { useEffect, useRef, useState, type ReactNode } from "react";

interface PageInfo { number: number; width: number; height: number }
type PdfDocument = { numPages: number; getPage(n: number): Promise<PdfPage> };
type PdfPage = { getViewport(o: { scale: number }): { width: number; height: number }; render(o: Record<string, unknown>): { promise: Promise<void>; cancel(): void } };

/**
 * A PDF drawn page by page at the width of its container (so it reads on a phone without zooming), with room for an overlay on every
 * page: the fields a signer fills, or the boxes an administrator places. `overlay` gets the page number and its drawn size in CSS pixels.
 */
export default function PdfPages({ source, overlay, onLoaded, maxWidth = 900, zoom = 1, lazy = false }: {
  source: string | Uint8Array; overlay?: (page: number, size: { width: number; height: number }) => ReactNode; onLoaded?: (pages: number) => void; maxWidth?: number;
  /** 1 fits the container; above 1 the pages grow past it and scroll sideways (the signing page's zoom buttons). */
  zoom?: number;
  /** Draw a page only once it comes near the view (a 100-page workbook would otherwise draw every page at once). */
  lazy?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState("");
  const loaded = useRef(onLoaded); loaded.current = onLoaded;

  useEffect(() => {
    let cancelled = false; let task: { promise: Promise<unknown>; destroy(): Promise<void> } | null = null;
    setDoc(null); setPages([]); setError("");
    void (async () => {
      try {
        // The legacy build: pdf.js 6 calls Map.prototype.getOrInsertComputed, which browsers only shipped recently; the legacy build
        // brings its polyfills, so the document still draws on an older phone or browser (it drew nothing there before).
        const [pdf, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
        pdf.GlobalWorkerOptions.workerSrc = worker.default;
        task = pdf.getDocument(typeof source === "string" ? { url: source } : { data: source.slice() }) as unknown as typeof task;
        const opened = await task!.promise as PdfDocument;
        const infos: PageInfo[] = [];
        for (let n = 1; n <= opened.numPages; n++) { const view = (await opened.getPage(n)).getViewport({ scale: 1 }); infos.push({ number: n, width: view.width, height: view.height }); }
        if (cancelled) return;
        setDoc(opened); setPages(infos); loaded.current?.(infos.length);
      } catch { if (!cancelled) setError("The document could not be shown here. Use the download link to open it."); }
    })();
    // The loading task owns the document and its worker: destroying it frees both (also when it is still loading).
    return () => { cancelled = true; void task?.destroy().catch(() => undefined); };
  }, [source]);

  useEffect(() => {
    const element = host.current; if (!element) return;
    const measure = () => setWidth(Math.round(Math.min(element.clientWidth, maxWidth) * Math.max(zoom, 0.25)));
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [maxWidth, zoom]);

  return <div ref={host} className={`w-full ${zoom > 1 ? "overflow-x-auto" : ""}`}>
    {error && <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
    {!error && !pages.length && <p role="status" className="p-6 text-center text-sm text-foreground-600">Loading the document…</p>}
    {doc && width > 0 && pages.map((page) => {
      const size = { width, height: width * page.height / page.width };
      return <div key={page.number} data-pdf-page={page.number} className="relative mx-auto mb-4 border border-background-300 bg-white shadow-sm" style={size}>
        <PageCanvas doc={doc} number={page.number} width={size.width} height={size.height} lazy={lazy} />
        {overlay && <div className="absolute inset-0">{overlay(page.number, size)}</div>}
        <span className="pointer-events-none absolute bottom-1 right-2 rounded bg-white/80 px-1 text-2xs text-foreground-500">Page {page.number} of {pages.length}</span>
      </div>;
    })}
  </div>;
}

function PageCanvas({ doc, number, width, height, lazy }: { doc: PdfDocument; number: number; width: number; height: number; lazy: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(!lazy || typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = canvas.current; if (near || !element) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); observer.disconnect(); } }, { rootMargin: "1200px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near) return;
    let task: { promise: Promise<void>; cancel(): void } | null = null; let cancelled = false;
    void (async () => {
      const page = await doc.getPage(number);
      const element = canvas.current; if (cancelled || !element) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width * ratio });
      element.width = Math.floor(viewport.width); element.height = Math.floor(viewport.height);
      task = page.render({ canvas: element, canvasContext: element.getContext("2d"), viewport });
      await task.promise.catch(() => undefined);
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [doc, number, width, near]);
  return <canvas ref={canvas} style={{ width, height }} className="block" />;
}
