import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PdfCrop, PdfPageMarked } from "./PdfView";
import type { PdfHandle } from "./pdfDoc";
import { useQuestionContent } from "./questionContent";
import { FOCUS, SOFT_CARD, useStickySlot } from "./ui";
import { questionName, type PdfTemplate, type Rect, type TemplateQuestion } from "@/lib/assessment/pdfTemplate/model";
import { questionTextRect, scannedCrop, type QuestionContent, type Run } from "@/lib/assessment/pdfTemplate/questionText";

/**
 * ASM-QUESTION-TEXT (owner 2026-11-27): one question as the student and the trainer see it: the printed label as the only heading,
 * the question's own words read from the PDF's text layer (bold, line breaks, lists, parts kept), the pictures printed in the question
 * area as crops (tap to zoom). A scanned page (no text layer) shows the whole question as a padded crop.
 * ASM-QUESTION-POLISH (owner 2026-11-27): the question stays in view while the answers scroll: on a wide screen the card sticks under
 * the top bar (at most about 32% of the screen, "Show all" when longer); on a phone a compact bar (label and first line, tap to open)
 * shows under the top bar once the card has scrolled away. "Open full page" shows the original page, question marked.
 * ASM-QUESTION-TEXT-ONLY (owner 2026-11-27): no Workbook / Text switch: the question is always its text (a scan still falls back to
 * the padded crop); "Open full page" is the only way to the workbook page; pictures stay sharp crops (tap to zoom).
 */
function Runs({ runs }: { runs: Run[] }) {
  return <>{runs.map((r, i) => r.bold && r.italic ? <strong key={i}><em>{r.text}</em></strong> : r.bold ? <strong key={i} className="font-semibold">{r.text}</strong> : r.italic ? <em key={i}>{r.text}</em> : <span key={i}>{r.text}</span>)}</>;
}
const Lines = ({ lines }: { lines: Run[][] }) => <>{lines.map((l, i) => <span key={i}>{i ? <br /> : null}<Runs runs={l} /></span>)}</>;

/** The question's words, as read from the page. */
export function QuestionText({ content }: { content: QuestionContent }) {
  return <div className="max-w-[70ch] space-y-3 text-base leading-7 text-foreground-900 sm:text-[17px] sm:leading-8" data-testid="question-text">
    {content.blocks.map((b, i) => b.kind === "p"
      ? <p key={i}><Lines lines={b.lines} /></p>
      : <div key={i} className="flex gap-2.5" data-kind={b.kind}><span className={`shrink-0 ${b.kind === "part" ? "font-semibold" : ""} min-w-[1.25rem] text-foreground-600`}>{b.marker}</span><div className="min-w-0"><Lines lines={b.lines} /></div></div>)}
  </div>;
}

const WIDE = "(min-width: 768px)";
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(WIDE); if (!mq) return;
    const on = () => setWide(mq.matches); on();
    mq.addEventListener?.("change", on); return () => mq.removeEventListener?.("change", on);
  }, []);
  return wide;
}

/** The question itself (its words; the padded crop for a scan), with its pictures. */
function QuestionBody({ pdf, template, q, content, name }: { pdf: PdfHandle; template: PdfTemplate; q: TemplateQuestion; content: QuestionContent | null; name: string }) {
  const scanned = useMemo(() => scannedCrop(template, q, pdf.sizes[questionTextRect(q).page - 1] ?? { w: 595, h: 842 }), [template, q, pdf.sizes]);
  if (!content) return <div className="max-w-[70ch] space-y-2.5 py-1" aria-busy="true" role="status" aria-label="Reading the question">
    <div className="h-4 w-11/12 animate-pulse rounded-full bg-background-200" /><div className="h-4 w-9/12 animate-pulse rounded-full bg-background-200" /><div className="h-4 w-6/12 animate-pulse rounded-full bg-background-200" /></div>;
  const printed = !content.blocks.length;
  return <div className="space-y-4" data-mode={printed ? "scanned" : "text"}>
    {printed ? <PdfCrop pdf={pdf} rect={scanned} full hiRes frame={false} label={`${name} as printed on page ${scanned.page}`} />
      : <QuestionText content={content} />}
    {content.figures.length ? <div className="space-y-3" data-testid="question-figures">
      {content.figures.map((f, i) => <PdfCrop key={i} pdf={pdf} rect={f} testId="question-figure" hiRes label={`${content.figures.length > 1 ? `Picture ${i + 1} of ` : "Picture in "}${name}, page ${f.page}`} />)}
    </div> : null}
  </div>;
}

// rule-policy: technical question-heading-level The question heading is an h1 on its own step and an h2 inside the marking screen.
export default function QuestionView({ pdf, template, question: q, eyebrow, status, children, level = 1 }: {
  pdf: PdfHandle; template: PdfTemplate; question: TemplateQuestion;
  /** above the heading: task and question n of m */
  eyebrow?: ReactNode;
  /** beside the eyebrow: answered / marked */
  status?: ReactNode;
  /** under the heading: notes (the previous attempt's mark) */
  children?: ReactNode; level?: 1 | 2;
}) {
  const content = useQuestionContent(pdf, template, q);
  const [seePage, setSeePage] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const wide = useWide();
  const slot = useStickySlot();
  const name = questionName(q);
  const H = level === 1 ? "h1" : "h2";
  const cardRef = useRef<HTMLElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setExpanded(false); }, [q.key]);

  // longer than the space it may take while sticking: faded at the bottom, "Show all"
  useLayoutEffect(() => {
    const box = boxRef.current; const inner = innerRef.current;
    if (!box || !inner) return;
    const measure = () => setOverflows(wide && !expanded && inner.scrollHeight > box.clientHeight + 2);
    measure();
    const o = new ResizeObserver(measure); o.observe(inner); o.observe(box);
    return () => o.disconnect();
  }, [wide, expanded, content, q.key]);

  // on a phone: the compact bar once the card has scrolled up under the top bar
  const [compact, setCompact] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  useEffect(() => {
    if (wide || !slot.el) { setCompact(false); return; }
    let frame = 0;
    const check = () => { frame = 0; const c = cardRef.current; if (!c || !slot.el) return; const show = c.getBoundingClientRect().bottom < slot.el.getBoundingClientRect().top + 4; setCompact(show); if (!show) setCompactOpen(false); };
    const on = () => { if (!frame) frame = requestAnimationFrame(check); };
    check();
    window.addEventListener("scroll", on, { capture: true, passive: true }); window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on, { capture: true }); window.removeEventListener("resize", on); if (frame) cancelAnimationFrame(frame); };
  }, [wide, slot.el, q.key]);

  const firstLine = (content?.plain || q.label || "").split("\n").find((l) => l.trim()) ?? "";
  const sticky = wide && !expanded;
  // sticking: the strip above the card is the page's own colour, so nothing shows between the top bar and the card
  return <div className={sticky ? "z-20 -mt-3 bg-background-100 pt-3 md:sticky" : ""} style={sticky ? { top: slot.top } : undefined} data-testid="question-sticky">
  <section ref={cardRef} data-testid="question-view" data-question-key={q.key} data-sticky={sticky || undefined}
    className={`${SOFT_CARD} p-4 sm:p-6`}>
    {eyebrow || status ? <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">{eyebrow}{status}</div> : null}
    <H className={`min-w-0 font-heading font-bold tracking-tight text-foreground-950 ${level === 1 ? "text-2xl sm:text-[1.75rem]" : "text-xl sm:text-2xl"}`} data-testid="question-heading">{name}</H>
    {children ? <div className="mt-3">{children}</div> : null}
    <div ref={boxRef} className={`relative mt-4 ${sticky ? "md:max-h-[32vh] md:overflow-hidden" : ""}`} data-testid="question-body">
      <div ref={innerRef}><QuestionBody pdf={pdf} template={template} q={q} content={content} name={name} /></div>
      {overflows ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-white via-white/80 to-transparent" aria-hidden="true" /> : null}
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      {overflows || (wide && expanded) ? <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} data-testid="question-show-all"
        className={`inline-flex min-h-[36px] cursor-pointer items-center gap-1 rounded-lg px-2 text-sm font-semibold text-primary-700 hover:bg-primary-50 ${FOCUS}`}>
        <i className={expanded ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line"} aria-hidden="true" />{expanded ? "Show less" : "Show all"}</button> : <span />}
      <button type="button" onClick={() => setSeePage(true)} data-testid="see-on-page"
        className={`inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm text-foreground-600 hover:bg-background-100 hover:text-foreground-900 ${FOCUS}`}>
        <i className="ri-file-search-line text-base" aria-hidden="true" />Open full page <span className="text-foreground-400">· p{q.header.page}</span></button>
    </div>
    {compact && slot.el ? createPortal(<div className={`border-b border-background-200 shadow-[0_6px_16px_-8px_rgba(16,24,40,0.18)] bg-white md:hidden`} data-testid="question-compact">
      <button type="button" onClick={() => setCompactOpen((o) => !o)} aria-expanded={compactOpen} className={`flex min-h-[48px] w-full cursor-pointer items-center gap-2.5 px-4 text-left ${FOCUS}`}>
        <span className="shrink-0 rounded-md bg-primary-50 px-1.5 py-0.5 text-xs font-bold text-primary-800 ring-1 ring-inset ring-primary-200">{name}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground-800">{firstLine}</span>
        <i className={`ri-arrow-down-s-line shrink-0 text-xl text-foreground-500 transition-transform duration-200 ${compactOpen ? "rotate-180" : ""}`} aria-hidden="true" />
        <span className="sr-only">{compactOpen ? "Hide the question" : "Show the whole question"}</span>
      </button>
      {compactOpen ? <div className="max-h-[60vh] overflow-y-auto overscroll-contain px-4 pb-4 motion-safe:animate-step-in" data-testid="question-compact-body">
        <QuestionBody pdf={pdf} template={template} q={q} content={content} name={name} />
      </div> : null}
    </div>, slot.el) : null}
    {seePage ? <SeeOnPage pdf={pdf} q={q} name={name} onClose={() => setSeePage(false)} /> : null}
  </section>
  </div>;
}

/** The original page(s) of the question, the question's text highlighted and its answer areas lightly marked. */
function SeeOnPage({ pdf, q, name, onClose }: { pdf: PdfHandle; q: TemplateQuestion; name: string; onClose: () => void }) {
  const pages = useMemo(() => [...new Set([q.header.page, ...q.areas.map((a) => a.page)])].sort((a, b) => a - b), [q]);
  const [i, setI] = useState(0);
  const marks: { rect: Rect; strong: boolean }[] = [{ rect: q.header, strong: true }, ...q.areas.map((a) => ({ rect: a, strong: false }))];
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  const page = pages[i];
  return createPortal(<div className="fixed inset-0 z-[90] flex flex-col bg-foreground-950/80 motion-safe:animate-fade-in" role="dialog" aria-modal="true" aria-label={`${name} on page ${page}`} data-testid="see-on-page-dialog" onClick={onClose}>
    <div className="flex items-center justify-between gap-2 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
      <p className="min-w-0 truncate text-sm font-semibold">{name} · page {page} of the workbook</p>
      <div className="flex items-center gap-1">
        {pages.length > 1 ? <>
          <button type="button" className="min-h-[44px] rounded-md px-3 text-sm hover:bg-white/10 disabled:opacity-40" disabled={i === 0} onClick={() => setI(i - 1)}>← Page {pages[Math.max(0, i - 1)]}</button>
          <button type="button" className="min-h-[44px] rounded-md px-3 text-sm hover:bg-white/10 disabled:opacity-40" disabled={i === pages.length - 1} onClick={() => setI(i + 1)}>Page {pages[Math.min(pages.length - 1, i + 1)]} →</button>
        </> : null}
        <button type="button" className="min-h-[44px] min-w-[44px] rounded-md hover:bg-white/10" onClick={onClose} aria-label="Close"><i className="ri-close-line text-2xl" aria-hidden="true" /></button>
      </div>
    </div>
    <div className="flex-1 overflow-auto px-2 pb-6 sm:px-6" onClick={(e) => e.stopPropagation()}>
      <PdfPageMarked key={page} pdf={pdf} page={page} marks={marks} />
    </div>
  </div>, document.body);
}
