import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PdfCrop, PdfPageMarked } from "./PdfView";
import type { PdfHandle } from "./pdfDoc";
import { useQuestionContent } from "./questionContent";
import { questionName, type PdfTemplate, type Rect, type TemplateQuestion } from "@/lib/assessment/pdfTemplate/model";
import { questionTextRect, scannedCrop, type QuestionContent, type Run } from "@/lib/assessment/pdfTemplate/questionText";

/**
 * ASM-QUESTION-TEXT (owner 2026-11-27): one question as the student and the trainer see it: the printed label as the only heading,
 * the question's own words read from the PDF's text layer (bold, line breaks, lists, parts kept), the pictures printed in the question
 * area as crops (tap to zoom), and "See on page" with the question highlighted on the original page. A scanned page (no text layer)
 * shows the whole question as a padded crop.
 */
function Runs({ runs }: { runs: Run[] }) {
  return <>{runs.map((r, i) => r.bold && r.italic ? <strong key={i}><em>{r.text}</em></strong> : r.bold ? <strong key={i} className="font-semibold">{r.text}</strong> : r.italic ? <em key={i}>{r.text}</em> : <span key={i}>{r.text}</span>)}</>;
}
const Lines = ({ lines }: { lines: Run[][] }) => <>{lines.map((l, i) => <span key={i}>{i ? <br /> : null}<Runs runs={l} /></span>)}</>;

/** The question's words, as read from the page. */
export function QuestionText({ content }: { content: QuestionContent }) {
  return <div className="max-w-[70ch] space-y-3 text-base leading-7 text-foreground-900" data-testid="question-text">
    {content.blocks.map((b, i) => b.kind === "p"
      ? <p key={i}><Lines lines={b.lines} /></p>
      : <div key={i} className="flex gap-2.5" data-kind={b.kind}><span className={`shrink-0 ${b.kind === "part" ? "font-semibold" : ""} min-w-[1.25rem] text-foreground-700`}>{b.marker}</span><div className="min-w-0"><Lines lines={b.lines} /></div></div>)}
  </div>;
}

export default function QuestionView({ pdf, template, question: q, eyebrow, children, level = 1 }: {
  pdf: PdfHandle; template: PdfTemplate; question: TemplateQuestion; eyebrow?: ReactNode; children?: ReactNode; level?: 1 | 2;
}) {
  const content = useQuestionContent(pdf, template, q);
  const [seePage, setSeePage] = useState(false);
  const name = questionName(q);
  const page = q.header.page;
  const H = level === 1 ? "h1" : "h2";
  const crop = useMemo(() => scannedCrop(template, q, pdf.sizes[questionTextRect(q).page - 1] ?? { w: 595, h: 842 }), [template, q, pdf.sizes]);
  return <section className="space-y-4" data-testid="question-view" data-question-key={q.key}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">{eyebrow}<H className={`font-heading font-bold text-foreground-950 ${level === 1 ? "text-2xl" : "text-xl"}`} data-testid="question-heading">{name}</H></div>
      <button type="button" onClick={() => setSeePage(true)} data-testid="see-on-page"
        className="inline-flex min-h-[44px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-primary-700 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
        <i className="ri-file-search-line text-base" aria-hidden="true" />See on page {page}</button>
    </div>
    {children}
    {!content ? <div className="max-w-[70ch] space-y-2" aria-busy="true" role="status" aria-label="Reading the question"><div className="h-4 w-11/12 animate-pulse rounded bg-background-200" /><div className="h-4 w-8/12 animate-pulse rounded bg-background-200" /></div>
      : content.blocks.length ? <QuestionText content={content} />
        : <PdfCrop pdf={pdf} rect={crop} label={`${name} as printed on page ${crop.page}`} />}
    {content?.figures.length ? <div className="space-y-3" data-testid="question-figures">
      {content.figures.map((f, i) => <PdfCrop key={i} pdf={pdf} rect={f} testId="question-figure" label={`${content.figures.length > 1 ? `Picture ${i + 1} of ` : "Picture in "}${name}, page ${f.page}`} />)}
    </div> : null}
    {seePage ? <SeeOnPage pdf={pdf} q={q} name={name} onClose={() => setSeePage(false)} /> : null}
  </section>;
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
  return <div className="fixed inset-0 z-[90] flex flex-col bg-foreground-950/80" role="dialog" aria-modal="true" aria-label={`${name} on page ${page}`} data-testid="see-on-page-dialog" onClick={onClose}>
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
  </div>;
}
