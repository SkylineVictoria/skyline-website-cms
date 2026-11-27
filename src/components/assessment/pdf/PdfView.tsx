import { useEffect, useMemo, useRef, useState } from "react";
import { measureText, type PdfHandle } from "./pdfDoc";
import type { Rect } from "@/lib/assessment/pdfTemplate/model";
import { fitChain, LINE_HEIGHT, FIT_PADDING, type ChainFit, type FitBox } from "@/lib/assessment/pdfTemplate/student";

/**
 * ASM-PDF-TEMPLATE phase 2: the workbook PDF in the student's wizard: whole pages (instructions) and crops (a question's header row,
 * a declaration) drawn with pdf.js at the width of their column; a crop opens larger on a tap (phones). Pages draw only when near.
 */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => setW(Math.round(el.clientWidth));
    measure();
    const o = new ResizeObserver(measure); o.observe(el);
    return () => o.disconnect();
  }, []);
  return [ref, w];
}

/** Draws `rect` (fractions of the page; the whole page when absent) of a page into a canvas `width` CSS px wide, once it is near the view. */
function CropCanvas({ pdf, page, rect, width, label }: { pdf: PdfHandle; page: number; rect?: Rect | null; width: number; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const size = pdf.sizes[page - 1] ?? { w: 595, h: 842 };
  const r = rect ?? { page, x: 0, y: 0, w: 1, h: 1 };
  const height = Math.round(width * (r.h * size.h) / (r.w * size.w));
  useEffect(() => {
    const el = canvas.current; if (near || !el) return;
    const o = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { setNear(true); o.disconnect(); } }, { rootMargin: "800px 0px" });
    o.observe(el); return () => o.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near || width <= 0) return;
    let task: { promise: Promise<void>; cancel(): void } | null = null; let cancelled = false;
    void (async () => {
      const p = await pdf.doc.getPage(page);
      const el = canvas.current; if (cancelled || !el) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const scale = (width / (r.w * size.w)) * ratio;
      const vp = p.getViewport({ scale });
      el.width = Math.max(1, Math.floor(r.w * vp.width)); el.height = Math.max(1, Math.floor(r.h * vp.height));
      const ctx = el.getContext("2d"); if (!ctx) return;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, el.width, el.height);
      // draw the page shifted so that the rect's top-left is at the canvas origin
      task = p.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -r.x * vp.width, -r.y * vp.height] });
      await task.promise.catch(() => undefined);
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, page, r.x, r.y, r.w, r.h, width, near, size.w]);
  return <canvas ref={canvas} role="img" aria-label={label} style={{ width, height }} className="block max-w-full bg-white" />;
}

export function PdfPageImage({ pdf, page }: { pdf: PdfHandle; page: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  return <div ref={ref} className="overflow-hidden rounded-xl border border-background-200 bg-white shadow-sm" data-testid={`pdf-page-${page}`}>
    {w > 0 ? <CropCanvas pdf={pdf} page={page} width={w} label={`Page ${page} of the workbook`} /> : null}
  </div>;
}

/** A whole page with parts of it marked (the question, in "See on page"): a coloured frame and tint over each rect. */
export function PdfPageMarked({ pdf, page, marks, maxWidth = 900 }: { pdf: PdfHandle; page: number; marks: { rect: Rect; strong: boolean }[]; maxWidth?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const width = Math.min(w, maxWidth);
  const size = pdf.sizes[page - 1] ?? { w: 595, h: 842 };
  const markRef = useRef<HTMLDivElement>(null);
  // the question in view: only the dialog's own scroll area moves (never the page behind it)
  useEffect(() => {
    const el = markRef.current; const box = el?.closest(".overflow-auto");
    if (!el || !box || width <= 0) return;
    const a = el.getBoundingClientRect(); const c = box.getBoundingClientRect();
    box.scrollTop += a.top - c.top - c.height / 4;
  }, [width, page]);
  return <div ref={ref} className="w-full">
    {width > 0 ? <div className="relative mx-auto overflow-hidden rounded-lg bg-white shadow" style={{ width, height: Math.round(width * size.h / size.w) }} data-testid={`marked-page-${page}`}>
      <CropCanvas pdf={pdf} page={page} width={width} label={`Page ${page} of the workbook`} />
      {marks.filter((m) => m.rect.page === page).map((m, i) => <div key={i} ref={m.strong && i === 0 ? markRef : undefined} aria-hidden="true"
        className={`pointer-events-none absolute rounded-sm ${m.strong ? "bg-amber-300/25 ring-[3px] ring-amber-500" : "bg-sky-300/10 ring-2 ring-sky-400/70"}`}
        style={{ left: `${m.rect.x * 100}%`, top: `${m.rect.y * 100}%`, width: `${m.rect.w * 100}%`, height: `${m.rect.h * 100}%` }} />)}
    </div> : null}
  </div>;
}

/**
 * A part of a page (a declaration, a picture of a question, a scanned question); tap or click to see it larger. It fills the column
 * (a small picture is enlarged at most 2.5 times and centred), so no blank block is left beside it.
 */
export function PdfCrop({ pdf, rect, label, testId = "question-crop" }: { pdf: PdfHandle; rect: Rect; label: string; testId?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (!zoom) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setZoom(false); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [zoom]);
  const natural = rect.w * (pdf.sizes[rect.page - 1]?.w ?? 595);
  const width = Math.min(w, Math.round(natural * 2.5));
  return <>
    <div ref={ref} className="w-full">
      <button type="button" onClick={() => setZoom(true)} style={w > 0 ? { width } : undefined}
        className="group relative mx-auto block cursor-zoom-in overflow-hidden rounded-xl border border-background-200 bg-white text-left shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" aria-label={`${label}: open larger`} data-testid={testId}>
        {w > 0 ? <CropCanvas pdf={pdf} page={rect.page} rect={rect} width={width} label={label} /> : null}
        <span className="absolute bottom-1.5 right-1.5 rounded-md bg-white/90 px-1.5 py-0.5 text-xs font-medium text-foreground-700 shadow-sm"><i className="ri-zoom-in-line mr-0.5" aria-hidden="true" />Zoom</span>
      </button>
    </div>
    {zoom ? <div className="fixed inset-0 z-[80] flex flex-col bg-foreground-950/80" role="dialog" aria-modal="true" aria-label={label} onClick={() => setZoom(false)} data-testid="crop-zoom">
      <div className="flex items-center justify-between px-4 py-3 text-white"><p className="text-sm font-semibold">{label}</p>
        <button type="button" className="rounded-md p-1 hover:bg-white/10" onClick={() => setZoom(false)} aria-label="Close"><i className="ri-close-line text-2xl" aria-hidden="true" /></button></div>
      <div className="flex-1 overflow-auto p-3" onClick={(e) => e.stopPropagation()}>
        <CropCanvas pdf={pdf} page={rect.page} rect={rect} width={Math.max(900, Math.round(window.innerWidth * 1.6))} label={label} />
      </div>
    </div> : null}
  </>;
}

/* ------------------------------------------------------------------ fit preview */
/** One small grey line, only when the answer will not fit its box on the page (the rest goes on a continued page; nothing is cut). */
export function FitHint({ text, boxes }: { text: string; boxes: FitBox[] }) {
  const fit = useMemo(() => (text.trim() && boxes.length ? fitChain(text, boxes, measureText) : null), [text, boxes]);
  if (!fit?.overflowLines) return null;
  return <p className="text-xs text-foreground-500" data-testid="fit-continued">Longer than the box on page {boxes[boxes.length - 1].page}: about {fit.overflowLines} line{fit.overflowLines === 1 ? "" : "s"} will print on a continued page. Nothing is cut.</p>;
}

/** The answer drawn as it will print in its box(es), and whether some of it goes to a continued page (a warning, never a block). */
export function FitPreview({ text, boxes, compact = false }: { text: string; boxes: FitBox[]; compact?: boolean }) {
  const fit = useMemo(() => fitChain(text, boxes, measureText), [text, boxes]);
  if (!text.trim() || !boxes.length) return null;
  const lastPage = boxes[boxes.length - 1].page;
  const note = fit.overflowLines
    ? <p className="flex items-start gap-1.5 text-xs text-amber-800" data-testid="fit-continued"><i className="ri-information-line mt-0.5" aria-hidden="true" />About {fit.overflowLines} more line{fit.overflowLines === 1 ? "" : "s"} will go on a continued page after page {lastPage}. That is fine: nothing is cut.</p>
    : <p className="text-xs text-foreground-500" data-testid="fit-ok">Fits in the box on page {boxes.map((b) => b.page).filter((p, i, a) => a.indexOf(p) === i).join(" and ")}{fit.size < 10 ? ` (printed at ${fit.size} pt)` : ""}.</p>;
  if (compact) return fit.overflowLines ? note : null;
  return <div className="space-y-1.5" data-testid="fit-preview">
    <p className="text-2xs font-semibold uppercase tracking-wide text-foreground-500">How it will look on the page</p>
    {fit.boxes.map((b, i) => <PreviewBox key={i} box={b} size={fit.size} />)}
    {note}
  </div>;
}

function PreviewBox({ box, size }: { box: ChainFit["boxes"][number]; size: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const width = Math.min(w, 520);
  const scale = width / box.wPt;
  return <div ref={ref} className="w-full">
    {w > 0 ? <div className="relative overflow-hidden rounded border border-[#c7d2fe] bg-[#f5f7ff]" style={{ width, height: box.hPt * scale }}>
      <div className="absolute inset-0 whitespace-pre text-[#111827]" style={{ padding: FIT_PADDING * scale, fontFamily: "Helvetica, Arial, sans-serif", fontSize: size * scale, lineHeight: LINE_HEIGHT }}>
        {box.lines.join("\n")}
      </div>
      <span className="absolute right-1 top-1 rounded bg-white/80 px-1 text-[9px] text-foreground-500">p{box.page}</span>
    </div> : null}
  </div>;
}
