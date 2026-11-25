/**
 * ASM-BUILDER (2026-11-25): the compact question rows of the Add assessment wizard (Check step) and of the assessment page's
 * Builder, one implementation for both (mockups docs/mockups/assessment-flow-mockups.pdf page 2):
 *   NeedsALook          only the flagged items, one line each (number, reason, tag); a row opens inline; done rows struck through.
 *   QuestionLine        one compact line: number, text, type icon, page, tags, "Edited" with Show original, hover actions.
 *   QuestionTextEditor  the inline editor: the question as text (instruction blocks in the rich-text editor, never HTML), the PDF's
 *                       wording when it differs, what the trainer should look for, then the caller's buttons and "More options".
 *   PdfPreviewDialog    "Preview PDF".
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import PdfPages from "@/components/signing/PdfPages";
import RichBlockEditor from "./RichBlockEditor";
import { questionType } from "@/lib/assessment/registry";
import type { CheckRow } from "@/lib/assessment/checkList";
import type { Question, QuestionKey } from "@/lib/assessment/types";

export const FIELD = "w-full rounded-lg border border-background-300 bg-white px-3 py-2 text-sm text-foreground-900 focus:border-primary-400 focus:outline-none";
export const BTN_PRIMARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_SECONDARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-background-300 bg-white px-3 py-2 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
/** Hover-only on a mouse, always shown on touch screens. */
export const HOVER_ACTIONS = "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";

const TAG_TONE: Record<string, string> = { "Answer missing": "bg-amber-100 text-amber-900", "Answer check": "bg-sky-100 text-sky-900", "Import check": "bg-indigo-100 text-indigo-900" };

export function NeedsALook({ rows, done, open, onToggle, renderEditor, title = "Needs a look" }: {
  rows: CheckRow[];
  done: Record<string, string>;
  open: string | null;
  onToggle: (rowId: string | null) => void;
  renderEditor: (row: CheckRow) => ReactNode;
  title?: string;
}) {
  const left = rows.filter((r) => !done[r.id]).length;
  return (
    <section className="space-y-3" data-testid="needs-a-look">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground-900">{title} <span className="font-normal text-foreground-500">· {left} of {rows.length} left</span></p>
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-background-200 sm:w-40" aria-hidden="true"><div className="h-full rounded-full bg-green-600 transition-all" style={{ width: `${rows.length ? Math.round(100 * (rows.length - left) / rows.length) : 100}%` }} /></div>
      </div>
      <ul className="divide-y divide-background-200 overflow-hidden rounded-xl border border-background-200 bg-white" data-testid="check-list">
        {rows.map((r) => {
          const how = done[r.id];
          const isOpen = open === r.id;
          return (
            <li key={r.id} className={isOpen ? "bg-primary-50/30" : ""}>
              <button type="button" onClick={() => onToggle(isOpen ? null : r.id)} aria-expanded={isOpen} className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left sm:px-4">
                {how ? <i className="ri-check-line text-green-700" aria-hidden="true" /> : <span className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${isOpen ? "border-primary-600 bg-primary-600" : "border-background-400"}`} aria-hidden="true" />}
                <span className="w-12 shrink-0 text-sm font-semibold text-foreground-900">{r.number || "–"}</span>
                <span className={`min-w-0 flex-1 truncate text-sm ${how ? "text-foreground-500 line-through" : "text-foreground-800"}`}>{r.reason}{!isOpen ? <span className="ml-2 hidden text-foreground-500 sm:inline">{r.label.length > 60 ? `${r.label.slice(0, 59)}…` : r.label}</span> : null}</span>
                {how ? <span className="shrink-0 text-xs text-foreground-500">{how}</span> : <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold ${TAG_TONE[r.tag] ?? "bg-background-100"}`}>{r.tag}</span>}
              </button>
              {isOpen ? renderEditor(r) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function QuestionLine({ q, number, open, onClick, depth = 0, actions, tags = [], answered }: {
  q: Question;
  number: string;
  open: boolean;
  onClick: () => void;
  depth?: number;
  actions?: ReactNode;
  tags?: string[];
  /** Has a model answer (assessor only). */
  answered?: boolean;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const type = questionType(q.type);
  const content = q.type === "instruction" || q.type === "content";
  const text = content ? (q.config?.html ? String(q.config.html).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : "") || (String(q.config?.html ?? "").includes("<img") ? "Picture" : "Instruction") : q.label || type?.label || q.type;
  const edited = Boolean(q.importMeta?.editedAt);
  const original = q.importMeta?.original ?? "";
  return (
    <div className="group" data-question-line={q.id}>
      <div className={`flex items-center gap-2 px-3 py-2 sm:px-4 ${depth ? "pl-8 sm:pl-10" : ""} ${open ? "bg-primary-50/30" : "hover:bg-background-50"}`}>
        <button type="button" onClick={onClick} aria-expanded={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
          <span className="w-14 shrink-0 text-sm font-semibold text-foreground-900">{number}</span>
          <i className={`${type?.icon ?? "ri-question-line"} shrink-0 text-foreground-400`} title={type?.label ?? q.type} aria-label={type?.label ?? q.type} />
          <span className={`min-w-0 flex-1 truncate text-sm ${content ? "text-foreground-600" : "text-foreground-800"}`}>{showOriginal && original ? original.replace(/<[^>]*>/g, " ") : text}</span>
          {q.importMeta?.page ? <span className="shrink-0 text-2xs text-foreground-500" title="Page in the imported workbook">p.{q.importMeta.page}</span> : null}
          {tags.map((t) => <span key={t} className="hidden shrink-0 rounded bg-background-100 px-1.5 py-0.5 text-2xs font-medium text-foreground-600 sm:inline">{t}</span>)}
          {answered ? <i className="ri-key-2-line shrink-0 text-foreground-400" title="Has a model answer" aria-label="Has a model answer" /> : null}
          {edited ? <span className="shrink-0 rounded-full bg-primary-100 px-2 py-0.5 text-2xs font-semibold text-primary-800">Edited</span> : null}
        </button>
        {actions ? <div className={HOVER_ACTIONS}>{actions}</div> : null}
      </div>
      {edited ? (
        <p className={`px-4 pb-1 text-xs text-foreground-500 ${depth ? "pl-10" : ""}`}>Edited{q.importMeta?.editedByName ? ` by ${q.importMeta.editedByName}` : ""}{q.importMeta?.editedAt ? ` · ${new Date(q.importMeta.editedAt).toLocaleString()}` : ""} · <button type="button" className="cursor-pointer font-semibold text-primary-700 hover:underline" onClick={() => setShowOriginal((v) => !v)}>{showOriginal ? "Show edited" : "Show original"}</button></p>
      ) : null}
    </div>
  );
}

/** The inline editor under a row: text, the PDF's wording, what the trainer should look for; then the caller's buttons and options. */
export function QuestionTextEditor({ q, keyRow, onLabel, onHtml, onAnswer, highlightAnswer, actions, children, readOnly }: {
  q: Question;
  keyRow?: QuestionKey;
  onLabel: (text: string) => void;
  onHtml?: (html: string) => void;
  onAnswer?: (text: string) => void;
  highlightAnswer?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
  readOnly?: boolean;
}) {
  const content = q.type === "instruction" || q.type === "content";
  const answerable = !content && q.type !== "declaration" && !(q.children?.length);
  return (
    <div className="space-y-3 border-t border-primary-100 bg-primary-50/40 px-3 pb-3 pt-2 sm:px-4" data-testid="row-editor">
      {content ? (
        readOnly || !onHtml ? <div className="asm-content rounded-lg border border-background-200 bg-white px-3 py-2 text-sm" dangerouslySetInnerHTML={{ __html: String(q.config?.html ?? "") }} />
          : <RichBlockEditor value={String(q.config?.html ?? "")} onChange={onHtml} label="Instruction" />
      ) : (
        <label className="block">
          <span className="text-2xs font-bold uppercase tracking-wide text-foreground-600">Question</span>
          <textarea className={`${FIELD} mt-1`} rows={3} value={q.label} readOnly={readOnly} onChange={(e) => onLabel(e.target.value)} aria-label="Question text" />
        </label>
      )}
      {q.importMeta?.pdfText && q.importMeta.pdfText !== q.label && !content ? (
        <div className="rounded-lg border border-background-200 bg-white px-3 py-2 text-sm">
          <p className="text-2xs font-bold uppercase tracking-wide text-foreground-500">The PDF says</p>
          <p className="mt-0.5 text-foreground-800">{q.importMeta.pdfText}</p>
          {!readOnly ? <button type="button" className="mt-1 cursor-pointer text-xs font-semibold text-primary-700 hover:underline" onClick={() => onLabel(q.importMeta?.pdfText ?? q.label)}>Use the PDF wording</button> : null}
        </div>
      ) : null}
      {answerable && onAnswer ? (
        <label className="block">
          <span className="text-2xs font-bold uppercase tracking-wide text-foreground-600">What the trainer should look for</span>
          <textarea className={`${FIELD} mt-1 ${highlightAnswer ? "border-primary-400" : ""}`} rows={3} placeholder="Type or paste the model answer…" value={keyRow?.modelAnswer ?? ""} readOnly={readOnly} onChange={(e) => onAnswer(e.target.value)} aria-label="Model answer" />
          {keyRow?.assessorGuidance ? <span className="mt-1 block text-xs text-foreground-600">Benchmark: {keyRow.assessorGuidance}</span> : null}
        </label>
      ) : null}
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      {children}
    </div>
  );
}

export function PdfPreviewDialog({ preview, title = "Preview PDF", onClose, fileName }: { preview: { bytes: Uint8Array | null; error: string }; title?: string; onClose: () => void; fileName?: string }) {
  const url = useMemo(() => (fileName && preview.bytes ? URL.createObjectURL(new Blob([preview.bytes as unknown as ArrayBuffer], { type: "application/pdf" })) : null), [fileName, preview.bytes]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return (
    <div className="fixed inset-0 z-[90] flex items-stretch justify-center bg-foreground-950/60 sm:p-6" role="dialog" aria-modal="true" aria-label="Preview PDF">
      <div className="flex w-full max-w-4xl flex-col bg-background-100 sm:rounded-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-background-200 bg-white px-4 py-3 sm:rounded-t-2xl">
          <p className="min-w-0 truncate font-heading text-sm font-semibold text-foreground-950">{title}</p>
          <div className="flex shrink-0 items-center gap-2">
            {url && fileName ? <a className={BTN_SECONDARY} href={url} download={fileName} data-testid="download-pdf"><i className="ri-download-2-line" aria-hidden="true" />Download</a> : null}
            <button type="button" className="cursor-pointer rounded-md p-1 text-foreground-500 hover:bg-background-100" onClick={onClose} aria-label="Close the preview"><i className="ri-close-line text-xl" aria-hidden="true" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 sm:p-5">
          {preview.error ? <p role="alert" className="text-sm text-red-700">{preview.error}</p> : !preview.bytes ? <p role="status" className="p-6 text-center text-sm text-foreground-600"><i className="ri-loader-4-line mr-1.5 animate-spin" aria-hidden="true" />Making the workbook PDF…</p> : <PdfPages source={preview.bytes} maxWidth={820} />}
        </div>
      </div>
    </div>
  );
}
