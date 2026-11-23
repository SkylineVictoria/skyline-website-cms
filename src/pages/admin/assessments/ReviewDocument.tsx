/**
 * ASM-REVIEW (owner, 2026-11-23): the wizard's Review step, "Edit" view. The draft looks like the workbook it came from and like
 * "Export as workbook PDF" (the shared layout in workbookLayout.ts): the institution header, the cover (title, unit, the Student
 * Name / ID lines, the qualification and unit table, the task list), the assessment information, then each task with its
 * instructions and questions in the workbook's question bars, and the footer (Version / Unit Code / Page).
 *
 * Every block is edited where it stands: click it. Text blocks (instructions, the information pages) get a small rich-text
 * toolbar and never show HTML; a question's wording, a table's columns and rows and a choice's options are typed in place. The
 * advanced settings (type, "Show this when", attached links, marking, model answers) sit under a closed "More options".
 */
import { useEffect, useRef, type ReactNode } from "react";
import RichBlockEditor from "@/components/assessment/RichBlockEditor";
import { sanitize, typeUi } from "@/components/assessment/registry";
import QuestionEditor from "./builder/QuestionEditor";
import { earlierQuestionIds } from "@/lib/assessment/definition";
import { GROUP_LABEL, newId, QUESTION_TYPES, questionType, type TypeGroup } from "@/lib/assessment/registry";
import type { Definition, Question, QuestionKey, Section, Task } from "@/lib/assessment/types";
import { CONTENT_TYPES, DETAIL_LABELS, footerParts, helpRepeatsLabel, qualificationRows, sectionShowsTitle, TASK_TABLE_HEAD, taskHeading, taskRows, workbookNumbering, type QuestionNumber, type WorkbookUnitInfo } from "@/lib/assessment/workbookLayout";
import type { WorkbookLetterhead } from "@/lib/assessment/workbookExport";

export interface ReviewActions {
  patchQuestion: (id: string, patch: Partial<Question>) => void;
  changeType: (q: Question, type: string) => void;
  remove: (id: string) => void;
  move: (taskId: string, sectionId: string, parentId: string | null, from: number, to: number) => void;
  add: (taskId: string, sectionId: string, type: string) => void;
  addTask: () => void;
  patchTask: (taskId: string, patch: Partial<Task>) => void;
  patchSection: (taskId: string, sectionId: string, patch: Partial<Section>) => void;
  setInstructions: (html: string) => void;
  keyOf: (id: string) => QuestionKey | undefined;
  patchKey: (id: string, patch: Partial<QuestionKey>) => void;
}

const cfg = <T,>(q: Question, k: string, d: T): T => ((q.config?.[k] as T | undefined) ?? d);
const ICON_BTN = "flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-600 hover:bg-background-200 hover:text-foreground-900 disabled:cursor-not-allowed disabled:opacity-40";
const LINK_BTN = "inline-flex cursor-pointer items-center gap-1 text-xs font-semibold text-primary-700 hover:underline";
/** A box drawn like the workbook's tick box. */
const Tick = () => <span className="inline-block h-3 w-3 border border-foreground-700 align-[-1px]" aria-hidden="true" />;

/** Text typed in place: looks like the page's own text, grows with its content, never shows markup. */
function InlineText({ value, onChange, label, className = "", placeholder, autoFocus, multiline = true }: {
  value: string; onChange: (v: string) => void; label: string; className?: string; placeholder?: string; autoFocus?: boolean; multiline?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = "0px"; el.style.height = `${el.scrollHeight}px`; } }, [value]);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  return (
    <textarea ref={ref} rows={1} value={value} aria-label={label} placeholder={placeholder}
      onChange={(e) => onChange(multiline ? e.target.value : e.target.value.replace(/\n/g, " "))}
      onKeyDown={(e) => { if (!multiline && e.key === "Enter") e.preventDefault(); }}
      className={`block w-full resize-none overflow-hidden rounded border border-dashed border-background-300 bg-background-50 px-1.5 py-1 focus:border-primary-400 focus:outline-none ${className}`} />
  );
}

/** One sheet of the workbook: header, body, footer. */
function Sheet({ head, footer, children, testId }: { head: WorkbookLetterhead | null; footer: [string, string, string]; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="mx-auto w-full max-w-[52rem] rounded-sm border border-background-200 bg-white text-[13px] leading-relaxed text-neutral-900 shadow-md">
      <header className="flex items-start justify-between gap-4 border-b border-neutral-300 px-6 pb-3 pt-5 sm:px-10">
        <div className="min-h-[2.75rem] min-w-0">{head?.logoUrl ? <img src={head.logoUrl} alt={head.name} className="max-h-14 max-w-[11rem] object-contain" /> : null}</div>
        <div className="min-w-0 text-right">
          <p className="text-sm font-bold text-neutral-900">{head?.name ?? "Skyline Institute of Technology"}</p>
          {(head?.lines ?? []).map((l) => <p key={l} className="text-[11px] leading-snug text-neutral-500">{l}</p>)}
        </div>
      </header>
      <div className="space-y-4 px-6 py-6 sm:px-10">{children}</div>
      <footer className="grid grid-cols-3 gap-2 border-t border-neutral-300 px-6 py-2.5 text-[11px] text-neutral-500 sm:px-10">
        <span>{footer[0]}</span><span className="text-center">{footer[1]}</span><span className="text-right">{footer[2]}</span>
      </footer>
    </section>
  );
}

/** The workbook's two-column table (label column shaded). */
function LabelTable({ rows, testId }: { rows: [string, ReactNode][]; testId?: string }) {
  return (
    <table className="w-full border-collapse text-[12px]" data-testid={testId}>
      <tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row" className="w-[30%] border border-neutral-400 bg-neutral-100 px-2 py-1.5 text-left font-semibold">{label}</th><td className="border border-neutral-400 px-2 py-1.5">{value}</td></tr>)}</tbody>
    </table>
  );
}

/** The question bar: "Q3   2.1.3          Satisfactory ☐ Yes ☐ No". */
function QuestionBar({ n }: { n: QuestionNumber }) {
  return (
    <div className="flex items-center justify-between gap-3 border border-neutral-400 bg-[#dbe3ef] px-2 py-1 text-[12px] font-bold">
      <span>{n.seq !== null ? <span className="mr-4">Q{n.seq}</span> : null}{n.number}</span>
      {n.markable ? <span className="flex items-center gap-2 whitespace-nowrap">Satisfactory <span className="flex items-center gap-1 font-normal"><Tick />Yes</span><span className="flex items-center gap-1 font-normal"><Tick />No</span></span> : null}
    </div>
  );
}

/** What the student fills in, drawn like the workbook (the trainer-only forms as the student page shows them). */
function AnswerArea({ q }: { q: Question }) {
  if (q.type === "long_answer") return <div className="h-24 border border-neutral-400" aria-hidden="true" />;
  if (q.type === "short_answer" || q.type === "number" || q.type === "date" || q.type === "url") return <div className="h-8 border border-neutral-400" aria-hidden="true" />;
  if (q.type === "table_grid") {
    const columns = cfg<{ id: string; label: string }[]>(q, "columns", []); const rows = cfg<{ id: string; label: string }[]>(q, "rows", []);
    const labelled = rows.some((r) => r.label && !/^\d+$/.test(r.label));
    return (
      <table className="w-full border-collapse text-[12px]">
        <thead><tr>{labelled ? <th className="border border-neutral-400 bg-neutral-100" /> : null}{columns.map((c) => <th key={c.id} className="border border-neutral-400 bg-neutral-100 px-2 py-1 text-left font-semibold">{c.label}</th>)}</tr></thead>
        <tbody>{(rows.length ? rows : [{ id: "_", label: "" }]).map((r) => <tr key={r.id}>{labelled ? <th className="border border-neutral-400 bg-neutral-100 px-2 py-1 text-left font-semibold">{r.label}</th> : null}{columns.map((c) => <td key={c.id} className="h-7 border border-neutral-400" />)}</tr>)}</tbody>
      </table>
    );
  }
  if (q.type === "single_choice" || q.type === "multi_choice") return <ul className="space-y-1">{cfg<{ id: string; label: string }[]>(q, "options", []).map((o) => <li key={o.id} className="flex items-center gap-2"><Tick />{o.label}</li>)}</ul>;
  if (q.type === "true_false") return <p className="flex items-center gap-4"><span className="flex items-center gap-1.5"><Tick />{cfg(q, "trueLabel", "True")}</span><span className="flex items-center gap-1.5"><Tick />{cfg(q, "falseLabel", "False")}</span></p>;
  const ui = typeUi(q.type);
  return <div className="pointer-events-none select-none opacity-90" aria-hidden="true">{ui.Input({ q, value: undefined, onChange: () => undefined, disabled: true, evidence: [], renderChildren: () => null })}</div>;
}

/** A table question's columns and rows typed in place. */
function TableInPlace({ q, onChange }: { q: Question; onChange: (patch: Partial<Question>) => void }) {
  const columns = cfg<{ id: string; label: string; kind?: string }[]>(q, "columns", []); const rows = cfg<{ id: string; label: string }[]>(q, "rows", []);
  const set = (patch: Record<string, unknown>) => onChange({ config: { ...q.config, ...patch } });
  const cell = "border border-neutral-400 p-0.5";
  const input = "w-full min-w-[5rem] rounded border border-dashed border-background-300 bg-background-50 px-1.5 py-1 text-[12px] focus:border-primary-400 focus:outline-none";
  return (
    <div className="space-y-1.5" data-testid="table-in-place">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead><tr><th className={`${cell} w-28 bg-neutral-100 text-left text-[11px] font-normal text-neutral-500`}>Row names</th>{columns.map((c, i) => (
            <th key={c.id} className={`${cell} bg-neutral-100`}><div className="flex items-center gap-0.5"><input className={`${input} font-semibold`} aria-label={`Column ${i + 1} heading`} value={c.label} onChange={(e) => set({ columns: columns.map((x) => (x.id === c.id ? { ...x, label: e.target.value } : x)) })} />
              <button type="button" className="cursor-pointer px-1 text-neutral-500 hover:text-red-700" aria-label={`Remove column ${i + 1}`} title="Remove column" onClick={() => set({ columns: columns.filter((x) => x.id !== c.id) })}>×</button></div></th>
          ))}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.id}><th className={`${cell} bg-neutral-100`}><div className="flex items-center gap-0.5"><input className={input} aria-label={`Row ${i + 1} name`} placeholder={String(i + 1)} value={r.label} onChange={(e) => set({ rows: rows.map((x) => (x.id === r.id ? { ...x, label: e.target.value } : x)) })} />
              <button type="button" className="cursor-pointer px-1 text-neutral-500 hover:text-red-700" aria-label={`Remove row ${i + 1}`} title="Remove row" onClick={() => set({ rows: rows.filter((x) => x.id !== r.id) })}>×</button></div></th>
              {columns.map((c) => <td key={c.id} className={`${cell} h-7`} />)}</tr>
          ))}</tbody>
        </table>
      </div>
      <div className="flex gap-3">
        <button type="button" className={LINK_BTN} onClick={() => set({ columns: [...columns, { id: newId("c"), label: "", kind: "text" }] })}><i className="ri-add-line" aria-hidden="true" />Column</button>
        <button type="button" className={LINK_BTN} onClick={() => set({ rows: [...rows, { id: newId("r"), label: "" }] })}><i className="ri-add-line" aria-hidden="true" />Row</button>
      </div>
    </div>
  );
}

/** A choice question's options typed in place. */
function OptionsInPlace({ q, onChange }: { q: Question; onChange: (patch: Partial<Question>) => void }) {
  const options = cfg<{ id: string; label: string }[]>(q, "options", []);
  const set = (next: { id: string; label: string }[]) => onChange({ config: { ...q.config, options: next } });
  return (
    <div className="space-y-1">
      {options.map((o, i) => (
        <div key={o.id} className="flex items-center gap-2"><Tick />
          <input className="h-8 min-w-0 flex-1 rounded border border-dashed border-background-300 bg-background-50 px-1.5 text-[13px] focus:border-primary-400 focus:outline-none" aria-label={`Option ${i + 1}`} value={o.label} onChange={(e) => set(options.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)))} />
          <button type="button" className={ICON_BTN} aria-label={`Remove option ${i + 1}`} onClick={() => set(options.filter((x) => x.id !== o.id))}><i className="ri-close-line" aria-hidden="true" /></button>
        </div>
      ))}
      <button type="button" className={LINK_BTN} onClick={() => set([...options, { id: newId("o"), label: "" }])}><i className="ri-add-line" aria-hidden="true" />Option</button>
    </div>
  );
}

const TypeOptions = () => <>{(Object.keys(GROUP_LABEL) as TypeGroup[]).map((g) => <optgroup key={g} label={GROUP_LABEL[g]}>{QUESTION_TYPES.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>)}</>;

export default function ReviewDocument({ definition, title, onTitle, unit, qualification, version, letterhead, selected, onSelect, actions }: {
  definition: Definition;
  title: string;
  onTitle: (t: string) => void;
  unit: WorkbookUnitInfo | null;
  qualification: WorkbookUnitInfo | null;
  version: string | null;
  letterhead: WorkbookLetterhead | null;
  /** The block being edited (a question id, or "info" for the information pages). */
  selected: string | null;
  onSelect: (id: string | null) => void;
  actions: ReviewActions;
}) {
  const numbers = workbookNumbering(definition);
  const hasInfo = Boolean(definition.instructions);
  const total = 1 + (hasInfo ? 1 : 0) + definition.tasks.length;
  const footer = (page: number) => footerParts(version, unit, page, total);

  /** Grey page label, amber "check this", and the block's own buttons when it is open. */
  const meta = (q: Question) => (
    <span className="flex shrink-0 items-center gap-1.5">
      {q.importMeta?.confidence === "low" ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900" data-testid="check-this">Check this</span> : null}
      {q.importMeta?.page ? <span className="text-[11px] text-neutral-400" title={`Imported from page ${q.importMeta.page} of the workbook`}>p. {q.importMeta.page}</span> : null}
    </span>
  );

  const blockFrame = (q: Question, open: boolean, children: ReactNode, tools: ReactNode) => (
    <div key={q.id} id={`wq-${q.id}`} data-block={q.id} data-type={q.type} data-testid="review-block"
      className={`group relative scroll-mt-16 rounded-md p-1.5 transition-colors ${open ? "bg-primary-50/60 ring-2 ring-primary-300" : "cursor-pointer hover:bg-neutral-50 hover:ring-1 hover:ring-neutral-300"}`}
      onClick={open ? (e) => e.stopPropagation() : (e) => { e.stopPropagation(); onSelect(q.id); }}
      onKeyDown={open ? undefined : (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onSelect(q.id); }}
      role={open ? undefined : "button"} tabIndex={open ? undefined : 0} aria-label={open ? undefined : `Edit ${q.label || questionType(q.type)?.label || "block"}`}>
      {children}
      {open ? tools : null}
    </div>
  );

  const tools = (task: Task, section: Section, q: Question, list: Question[], index: number, parentId: string | null) => (
    <div className="mt-2 space-y-2 border-t border-primary-200 pt-2">
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={ICON_BTN} title="Move up" aria-label="Move up" disabled={index === 0} onClick={() => actions.move(task.id, section.id, parentId, index, index - 1)}><i className="ri-arrow-up-line" aria-hidden="true" /></button>
        <button type="button" className={ICON_BTN} title="Move down" aria-label="Move down" disabled={index === list.length - 1} onClick={() => actions.move(task.id, section.id, parentId, index, index + 1)}><i className="ri-arrow-down-line" aria-hidden="true" /></button>
        <button type="button" className={`${ICON_BTN} hover:text-red-700`} title="Delete" aria-label={`Delete ${q.label || "block"}`} onClick={() => actions.remove(q.id)}><i className="ri-delete-bin-line" aria-hidden="true" /></button>
        <span className="flex-1" />
        <button type="button" className="cursor-pointer rounded-md bg-primary-500 px-3 py-1.5 text-xs font-semibold text-background-50 hover:bg-primary-600" onClick={() => onSelect(null)}>Done</button>
      </div>
      <details className="rounded-md border border-background-200 bg-background-50 text-sm" data-testid="more-options">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-foreground-700">More options <span className="font-normal text-foreground-500">· {CONTENT_TYPES.has(q.type) ? "attached links, show this when" : "question type, show this when, marking, model answer"}</span></summary>
        <div className="space-y-3 border-t border-background-200 p-3">
          {!CONTENT_TYPES.has(q.type) ? (
            <label className="flex items-center gap-2 text-xs text-foreground-600">Question type
              <select className="h-8 rounded-md border border-background-300 bg-background-50 px-2 text-xs" value={q.type} onChange={(e) => actions.changeType(q, e.target.value)}><TypeOptions /></select>
            </label>
          ) : null}
          <QuestionEditor compact q={q} onChange={(patch) => actions.patchQuestion(q.id, patch)} candidates={earlierQuestionIds(definition, q.id)} keyRow={actions.keyOf(q.id)} onKeyChange={(patch) => actions.patchKey(q.id, patch)} />
        </div>
      </details>
    </div>
  );

  const questionBlock = (task: Task, section: Section, q: Question, list: Question[], index: number, parentId: string | null): ReactNode => {
    const open = selected === q.id;
    if (CONTENT_TYPES.has(q.type)) {
      const html = cfg(q, "html", "");
      return blockFrame(q, open, <>
        <div className="mb-1 flex justify-end">{meta(q)}</div>
        {open ? <RichBlockEditor label="Instructions" value={html} autoFocus onChange={(v) => actions.patchQuestion(q.id, { config: { ...q.config, html: v } })} />
          : html ? (/^\s*</.test(html) ? <div className="asm-content" dangerouslySetInnerHTML={{ __html: sanitize(html) }} /> : <p className="whitespace-pre-wrap">{html}</p>)
            : <p className="italic text-neutral-400">Empty text block: click to type.</p>}
      </>, tools(task, section, q, list, index, parentId));
    }
    const n = numbers.get(q.id);
    const child = parentId !== null;
    return blockFrame(q, open, <>
      {n && !child ? <QuestionBar n={n} /> : null}
      <div className="mt-1.5 flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          {q.type === "declaration" ? null : open
            ? <InlineText label="Question" value={q.label} autoFocus onChange={(v) => actions.patchQuestion(q.id, { label: v })} className="font-semibold" placeholder="Type the question" />
            : <p className={`whitespace-pre-wrap font-semibold ${q.label ? "" : "italic text-neutral-400"}`}>{q.label || "Untitled question: click to type"}</p>}
          {open && q.type !== "declaration"
            ? <InlineText label="Note for the student" value={q.helpText ?? ""} onChange={(v) => actions.patchQuestion(q.id, { helpText: v || undefined })} className="text-[12px] text-neutral-600" placeholder="Add a note for the student (optional)" />
            : q.helpText && q.type !== "declaration" && !helpRepeatsLabel(q) ? <p className="whitespace-pre-wrap text-[12px] text-neutral-600">{q.helpText}</p> : null}
        </div>
        {meta(q)}
      </div>
      <div className="mt-1.5">
        {open && q.type === "table_grid" ? <TableInPlace q={q} onChange={(p) => actions.patchQuestion(q.id, p)} />
          : open && (q.type === "single_choice" || q.type === "multi_choice") ? <OptionsInPlace q={q} onChange={(p) => actions.patchQuestion(q.id, p)} />
          : q.children?.length ? null : <AnswerArea q={q} />}
      </div>
      {q.children?.length ? <div className="mt-2 space-y-2 border-l-2 border-neutral-200 pl-3">{q.children.map((c, ci) => questionBlock(task, section, c, q.children ?? [], ci, q.id))}</div> : null}
    </>, tools(task, section, q, list, index, parentId));
  };

  return (
    <div className="space-y-6 rounded-lg bg-background-200/60 p-3 sm:p-5" data-testid="review-document">
      {/* cover */}
      <Sheet head={letterhead} footer={footer(1)} testId="review-cover">
        <div className="pt-4">
          <InlineText label="Assessment title" multiline={false} value={title} onChange={onTitle} className="text-2xl font-bold leading-tight" placeholder="Assessment title" />
          {unit ? <p className="mt-1 text-base text-neutral-500">{unit.code} {unit.name}</p> : null}
          <p className="text-sm text-neutral-500">Student Assessment Pack</p>
        </div>
        <h3 className="pt-2 text-sm font-bold">1. Student and trainer details</h3>
        <LabelTable rows={DETAIL_LABELS.map((l) => [l, <span key={l} className="block h-4" />])} testId="review-details" />
        <h3 className="pt-2 text-sm font-bold">2. Qualification and unit of competency</h3>
        <LabelTable rows={qualificationRows(qualification, unit)} testId="review-qualification" />
        <h3 className="pt-2 text-sm font-bold">3. Assessment Tasks</h3>
        <table className="w-full border-collapse text-[12px]">
          <thead><tr>{TASK_TABLE_HEAD.map((h) => <th key={h} className="border border-neutral-400 bg-neutral-100 px-2 py-1.5 text-left font-semibold">{h}</th>)}</tr></thead>
          <tbody>{taskRows(definition).map(([a, b]) => <tr key={a}><td className="w-[30%] border border-neutral-400 px-2 py-1.5">{a}</td><td className="border border-neutral-400 px-2 py-1.5">{b}</td></tr>)}</tbody>
        </table>
      </Sheet>

      {/* the information pages (submission, plagiarism, appeals …) */}
      {hasInfo ? (
        <Sheet head={letterhead} footer={footer(2)} testId="review-info">
          <h3 className="text-lg font-bold">Assessment information</h3>
          <div data-block="info" className={`rounded-md p-1.5 ${selected === "info" ? "bg-primary-50/60 ring-2 ring-primary-300" : "cursor-pointer hover:bg-neutral-50 hover:ring-1 hover:ring-neutral-300"}`}
            onClick={selected === "info" ? undefined : () => onSelect("info")} role={selected === "info" ? undefined : "button"} tabIndex={selected === "info" ? undefined : 0}
            onKeyDown={selected === "info" ? undefined : (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onSelect("info"); }} aria-label={selected === "info" ? undefined : "Edit the assessment information"}>
            {selected === "info" ? <>
              <RichBlockEditor label="Assessment information" value={definition.instructions ?? ""} autoFocus onChange={actions.setInstructions} />
              <div className="mt-2 flex justify-end"><button type="button" className="cursor-pointer rounded-md bg-primary-500 px-3 py-1.5 text-xs font-semibold text-background-50 hover:bg-primary-600" onClick={() => onSelect(null)}>Done</button></div>
            </> : <div className="asm-content" dangerouslySetInnerHTML={{ __html: sanitize(definition.instructions ?? "") }} />}
          </div>
        </Sheet>
      ) : null}

      {definition.tasks.map((task, ti) => (
        <Sheet key={task.id} head={letterhead} footer={footer(ti + (hasInfo ? 3 : 2))} testId="review-task">
          <div className="flex items-baseline gap-1 text-lg font-bold">
            <span className="whitespace-nowrap">{taskHeading({ ...task, title: "" }, ti).replace(/ - $/, "")} -</span>
            <InlineText label={`Task ${ti + 1} title`} multiline={false} value={task.title} onChange={(v) => actions.patchTask(task.id, { title: v })} className="font-bold" />
          </div>
          {task.instructions ? <InlineText label={`Task ${ti + 1} instructions`} value={task.instructions} onChange={(v) => actions.patchTask(task.id, { instructions: v })} className="text-[12px] text-neutral-600" /> : null}
          {task.sections.map((s) => (
            <div key={s.id} className="space-y-2">
              {sectionShowsTitle(s.title) ? <InlineText label="Section heading" multiline={false} value={s.title} onChange={(v) => actions.patchSection(task.id, s.id, { title: v })} className="text-sm font-bold" /> : null}
              {s.questions.map((q, qi) => questionBlock(task, s, q, s.questions, qi, null))}
              <label className="inline-flex items-center gap-1.5 text-xs text-foreground-600">
                <i className="ri-add-line text-primary-700" aria-hidden="true" />
                <select aria-label={`Add to ${s.title || `task ${ti + 1}`}`} className="h-8 cursor-pointer rounded-md border border-dashed border-primary-300 bg-background-50 px-2 text-xs font-semibold text-primary-700" value=""
                  onChange={(e) => { if (e.target.value) actions.add(task.id, s.id, e.target.value); }}>
                  <option value="">Add a question or text…</option><TypeOptions />
                </select>
              </label>
            </div>
          ))}
          <div className="border-t border-neutral-300 pt-3">
            <p className="font-bold">{taskHeading(task, ti)} - Results Sheet</p>
            <p className="text-[12px] text-neutral-500">Filled in by the assessor: outcome, date, assessor and feedback for each attempt (in the PDF view).</p>
          </div>
        </Sheet>
      ))}
      <div className="flex justify-center"><button type="button" onClick={actions.addTask} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-primary-300 bg-background-50 px-4 py-2 text-sm font-semibold text-primary-700 hover:bg-primary-50"><i className="ri-add-line" aria-hidden="true" />Add task</button></div>
    </div>
  );
}
