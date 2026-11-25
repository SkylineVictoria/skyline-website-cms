/**
 * ASM-BUILDER (2026-11-25): the assessment page's Builder in the wizard's design (mockups docs/mockups/assessment-flow-mockups.pdf
 * pages 1-2), built from the same components as the Add assessment wizard's Check step (components/assessment/CheckList.tsx):
 *   - "Needs a look" at the top while anything imported is still flagged (Save & next, done rows struck through), hidden otherwise;
 *   - tasks and sections as white cards of compact one-line rows (number, text, type icon, page, tags); a row edits in place;
 *   - instruction blocks and the instructions before task 1 / of each task in the rich-text editor (never HTML);
 *   - question type, marking, conditions, model answer under "More options"; reorder / duplicate / delete on hover;
 *   - one "+ Add" menu per section (Add question, From bank, Add section).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal, TextInput } from "@/pages/admin/components/ui";
import SearchableSelect from "@/components/ui/SearchableSelect";
import { Empty } from "@/pages/admin/components/rto/overlay";
import AssessmentRenderer from "@/components/assessment/AssessmentRenderer";
import RichBlockEditor from "@/components/assessment/RichBlockEditor";
import { AutoResolvedList, BTN_PRIMARY, BTN_SECONDARY, FIELD, HOVER_ACTIONS, NeedsALook, QuestionLine, QuestionTextEditor } from "@/components/assessment/CheckList";
import { asHtml, autoResolvedRows, checkRows, isOptional, markReviewed, numberOf, partsSummary, reopenAutoResolved, rowChips, rowQuestionId, stableRows, withHtmlEdit, withLabelEdit, type CheckRow } from "@/lib/assessment/checkList";
import { cloneQuestion, cloneSection, cloneTask, earlierQuestionIds, flattenQuestions, moveItem, newSection, newTask, removeQuestion, updateQuestion } from "@/lib/assessment/definition";
import { GROUP_LABEL, isAnswerable, newQuestion, QUESTION_TYPES, questionType, setQuestionDefaults, withSchema, type TypeGroup } from "@/lib/assessment/registry";
import { workbookNumbering } from "@/lib/assessment/workbookLayout";
import { onRules, ruleNumber, ruleObject } from "@/lib/businessRules";
import type { Definition, Question, QuestionKey, Section, Task } from "@/lib/assessment/types";
import { asmAdmin, type BankRow } from "@/pages/admin/lib/assessments";
import ConditionEditor from "./ConditionEditor";
import QuestionEditor from "./QuestionEditor";
import { UpDown } from "./Sortable";

/** Evidence types named in Business Rules (assessment.evidence_question_defaults) as the file types they allow. */
const EVIDENCE_TYPE: Record<string, string> = {
  PDF: "application/pdf", JPEG: "image/jpeg", JPG: "image/jpeg", PNG: "image/png", WEBP: "image/webp", MP4: "video/mp4",
  MP3: "audio/mpeg", M4A: "audio/mp4", DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  TXT: "text/plain", ZIP: "application/zip",
};
// New questions start from the Business Rules values (today's values until they load).
onRules(() => {
  setQuestionDefaults("short_answer", { maxWords: ruleNumber("assessment.short_response_default_word_cap", 100) });
  const group = ruleObject("assessment.repeat_group_entry_limits", { minEntries: 1, maxEntries: 10 });
  setQuestionDefaults("repeating_group", { minEntries: Number(group.minEntries) || 1, maxEntries: Number(group.maxEntries) || 10 });
  const ev = ruleObject<{ minFiles: unknown; maxFiles: unknown; maxMiB: unknown; accepted: unknown }>("assessment.evidence_question_defaults",
    { minFiles: 1, maxFiles: 5, maxMiB: 25, accepted: ["PDF", "JPEG", "PNG", "MP4"] });
  const accept = (Array.isArray(ev.accepted) ? ev.accepted : []).map((x) => EVIDENCE_TYPE[String(x).trim().toUpperCase()]).filter((x): x is string => Boolean(x));
  setQuestionDefaults("file_upload", {
    minFiles: Number(ev.minFiles) || 1, maxFiles: Number(ev.maxFiles) || 5, maxMb: Number(ev.maxMiB) || 25,
    accept: accept.length ? [...new Set(accept)] : ["application/pdf", "image/jpeg", "image/png", "video/mp4"],
  });
});

export interface BuilderProps {
  definition: Definition;
  keys: QuestionKey[];
  onChange: (definition: Definition, keys: QuestionKey[]) => void;
  readOnly?: boolean;
  declarationText?: string;
  /** Who is editing (kept with an edited question: "Edited by … · Show original"). */
  editor?: { id: string | null; name: string | null };
  /** ASM-BUILDER-COMPACT: inside the Add assessment wizard (Check step): the rows only, without Needs a look / Auto-resolved / the toolbar. */
  embedded?: boolean;
}

type Target = { taskId: string; sectionId: string; parentId?: string };
const ICON_BTN = "cursor-pointer rounded p-1 text-foreground-500 hover:bg-background-100 hover:text-foreground-800";

function IconButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return <button type="button" className={ICON_BTN} aria-label={label} title={label} onClick={onClick}><i className={icon} aria-hidden="true" /></button>;
}

/** The chips of a row (ASM-BUILDER-COMPACT): how it is answered (table, upload, calc), assessor-only, conditional. Never "required". */
function tagsOf(q: Question): string[] {
  const out = rowChips(q);
  if (questionType(q.type)?.assessorOnly && !out.includes("assessor")) out.push("assessor");
  return out;
}

/** A small menu opened by a button ("+ Add"), closed by a pick, Escape or a click elsewhere. */
function Menu({ label, icon = "ri-add-line", items, testId }: { label: string; icon?: string; items: { label: string; icon: string; onClick: () => void }[]; testId?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  return (
    <div className="relative" ref={box}>
      <button type="button" className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-primary-700 hover:bg-primary-50" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid={testId}>
        <i className={icon} aria-hidden="true" />{label}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-lg border border-background-200 bg-white py-1 shadow-lg">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-foreground-800 hover:bg-background-50" onClick={() => { setOpen(false); it.onClick(); }}>
              <i className={`${it.icon} text-foreground-500`} aria-hidden="true" />{it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A heading line (instructions, a task, a section) that opens its editor in place. */
function HeadLine({ open, onClick, children, actions, className = "" }: { open: boolean; onClick: () => void; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`group flex items-center gap-2 ${className}`}>
      <button type="button" onClick={onClick} aria-expanded={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
        <i className={`ri-arrow-${open ? "down" : "right"}-s-line shrink-0 text-foreground-400`} aria-hidden="true" />
        {children}
      </button>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export default function Builder({ definition, keys, onChange, readOnly, declarationText, editor, embedded }: BuilderProps) {
  const who = editor ?? { id: null, name: null };
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState(false);
  const [previewResponses, setPreviewResponses] = useState<Record<string, unknown>>({});
  const [palette, setPalette] = useState<Target | null>(null);
  const [bankPick, setBankPick] = useState<Target | null>(null);
  /** Questions whose sub-parts / table rows are shown; tasks whose instructions (ⓘ) are shown. Both collapsed by default. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [info, setInfo] = useState<Record<string, boolean>>({});
  const keyBy = useMemo(() => new Map(keys.map((k) => [k.questionId, k])), [keys]);
  const flat = useMemo(() => flattenQuestions(definition), [definition]);
  const numbers = useMemo(() => workbookNumbering(definition), [definition]);
  const flatBy = useMemo(() => new Map(flat.map((f) => [f.question.id, f])), [flat]);

  // "Needs a look": imported items still flagged; finished rows stay listed, struck through
  const listed = useRef<CheckRow[]>([]);
  const rows = useMemo(() => (listed.current = stableRows(listed.current, checkRows(definition, numbers, null))), [definition, numbers]);
  const autoRows = useMemo(() => autoResolvedRows(definition, numbers), [definition, numbers]);

  const setDef = (d: Definition) => onChange(d, keys);
  const editQ = (id: string, fn: (q: Question) => Question) => setDef(updateQuestion(definition, id, fn));
  const patchKey = (id: string, patch: Partial<QuestionKey>) => onChange(definition, keys.some((k) => k.questionId === id) ? keys.map((k) => (k.questionId === id ? { ...k, ...patch } : k)) : [...keys, { questionId: id, ...patch }]);
  const patchTask = (taskId: string, patch: Partial<Task>) => setDef({ ...definition, tasks: definition.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) });
  const sectionsOf = (taskId: string) => definition.tasks.find((t) => t.id === taskId)?.sections ?? [];
  const patchSection = (taskId: string, sectionId: string, patch: Partial<Section>) => patchTask(taskId, { sections: sectionsOf(taskId).map((s) => (s.id === sectionId ? { ...s, ...patch } : s)) });

  const addQuestion = (at: Target, q: Question, keyRow?: Partial<QuestionKey> | null) => {
    const d = at.parentId
      ? updateQuestion(definition, at.parentId, (p) => ({ ...p, children: [...(p.children ?? []), q] }))
      : { ...definition, tasks: definition.tasks.map((t) => (t.id !== at.taskId ? t : { ...t, sections: t.sections.map((s) => (s.id !== at.sectionId ? s : { ...s, questions: [...s.questions, q] })) })) };
    onChange(d, keyRow && Object.keys(keyRow).length ? [...keys, { ...keyRow, questionId: q.id } as QuestionKey] : keys);
    setOpen(q.id); setPalette(null); setBankPick(null);
  };
  const deleteQuestion = (q: Question) => {
    if (!window.confirm(`Delete ${q.label ? `"${q.label.slice(0, 60)}"` : "this item"}?`)) return;
    const gone = new Set([q.id, ...(q.children ?? []).map((c) => c.id)]);
    onChange(removeQuestion(definition, q.id), keys.filter((k) => !gone.has(k.questionId)));
    if (open === q.id) setOpen(null);
  };
  const moveIn = (at: Target, from: number, to: number) => (at.parentId
    ? setDef(updateQuestion(definition, at.parentId, (p) => ({ ...p, children: moveItem(p.children ?? [], from, to) })))
    : patchSection(at.taskId, at.sectionId, { questions: moveItem(sectionsOf(at.taskId).find((s) => s.id === at.sectionId)?.questions ?? [], from, to) }));
  const duplicateIn = (at: Target, q: Question) => {
    const copy = cloneQuestion(q);
    const insert = (list: Question[]) => { const i = list.findIndex((x) => x.id === q.id); return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)]; };
    setDef(at.parentId ? updateQuestion(definition, at.parentId, (p) => ({ ...p, children: insert(p.children ?? []) }))
      : { ...definition, tasks: definition.tasks.map((t) => (t.id !== at.taskId ? t : { ...t, sections: t.sections.map((s) => (s.id !== at.sectionId ? s : { ...s, questions: insert(s.questions) })) })) });
  };
  const addSectionAfter = (taskId: string, afterId?: string) => {
    const list = sectionsOf(taskId);
    const s = newSection(`Section ${list.length + 1}`);
    const i = afterId ? list.findIndex((x) => x.id === afterId) + 1 : list.length;
    patchTask(taskId, { sections: [...list.slice(0, i), s, ...list.slice(i)] });
    setOpen(`section:${s.id}`);
  };
  const changeType = (q: Question, type: string) => {
    const fresh = newQuestion(type);
    editQ(q.id, () => ({ ...fresh, id: q.id, label: q.label, helpText: q.helpText, required: q.required, showIf: q.showIf, importMeta: q.importMeta, ...(questionType(type)?.hasChildren ? { children: q.children ?? [] } : {}) }));
  };
  const saveToBank = async (q: Question) => {
    const title = window.prompt("Save to the question bank as:", q.label || q.type); if (title === null) return;
    const unitId = (definition as { unitId?: string }).unitId;
    await asmAdmin("bank_save", { title, definition: q, keys: keyBy.get(q.id) ?? {}, unitId, tags: [q.type] });
    window.alert("Saved to the question bank.");
  };

  /** "More options": the question type, then its settings, marking, conditions and model answer (one editor, as the wizard's). */
  const moreOptions = (q: Question) => {
    const isOpen = Boolean(more[q.id]);
    const hasKids = Boolean(q.children?.length);
    return (
      <div className="rounded-lg border border-background-200 bg-white">
        <button type="button" className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left text-sm font-semibold text-foreground-800" aria-expanded={isOpen} onClick={() => setMore((m) => ({ ...m, [q.id]: !isOpen }))}>
          <i className={`ri-arrow-${isOpen ? "down" : "right"}-s-line text-foreground-400`} aria-hidden="true" />More options
          <span className="ml-1 truncate text-xs font-normal text-foreground-500">type, marking, conditions, model answer</span>
        </button>
        {isOpen ? (
          <div className="space-y-4 border-t border-background-200 p-3">
            <label className="block max-w-sm">
              <span className="text-2xs font-bold uppercase tracking-wide text-foreground-600">Question type</span>
              <SearchableSelect className={`${FIELD} mt-1`} value={q.type} onChange={(e) => changeType(q, e.target.value)} aria-label="Question type" searchPlaceholder="Search question types…">
                {(Object.keys(GROUP_LABEL) as TypeGroup[]).map((g) => (
                  <optgroup key={g} label={GROUP_LABEL[g]}>
                    {QUESTION_TYPES.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id} data-icon={t.icon} disabled={hasKids && !t.hasChildren && t.id !== q.type}>{t.label}</option>)}
                  </optgroup>
                ))}
              </SearchableSelect>
            </label>
            <QuestionEditor compact q={q} onChange={(patch) => editQ(q.id, (x) => ({ ...x, ...patch }))} candidates={earlierQuestionIds(definition, q.id)} keyRow={keyBy.get(q.id)} onKeyChange={(patch) => patchKey(q.id, patch)} />
            {questionType(q.type)?.content ? null : <button type="button" className={BTN_SECONDARY} onClick={() => void saveToBank(q)}><i className="ri-archive-line" aria-hidden="true" />Save to question bank</button>}
          </div>
        ) : null}
      </div>
    );
  };

  const finishRow = (row: CheckRow, how: string) => {
    if (row.tag === "Import check") editQ(rowQuestionId(row.id), markReviewed);
    setDone((m) => ({ ...m, [row.id]: how }));
    const next = rows.find((r) => r.id !== row.id && !done[r.id]);
    setOpen(next ? `look:${next.id}` : null);
  };

  const rowEditor = (q: Question, actions: ReactNode, withMore: boolean) => (
    <QuestionTextEditor q={q} keyRow={keyBy.get(q.id)} readOnly={readOnly} onLabel={(t) => editQ(q.id, (x) => withLabelEdit(x, t, who))} onHtml={(h) => editQ(q.id, (x) => withHtmlEdit(x, h, who))} actions={actions}>
      {withMore && !readOnly ? moreOptions(q) : null}
    </QuestionTextEditor>
  );

  const questionRows = (at: Target, list: Question[], depth: number): ReactNode => list.map((q, i) => {
    const f = flatBy.get(q.id);
    const isOpen = open === q.id;
    const kids = questionType(q.type)?.hasChildren;
    // sub-parts and table rows are collapsed ("6 parts ▸") until the admin opens them
    const summary = partsSummary(q);
    const partsOpen = Boolean(expanded[q.id]);
    const tableRows = q.type === "table_grid" && Array.isArray(q.config?.rows) ? (q.config?.rows as { id: string; label: string }[]) : [];
    return (
      <li key={q.id}>
        <QuestionLine q={q} number={f ? numberOf(f, numbers) : ""} open={isOpen} depth={depth} tags={tagsOf(q)} optional={isOptional(q)} answered={Boolean(keyBy.get(q.id)?.modelAnswer)} onClick={() => setOpen(isOpen ? null : q.id)}
          parts={summary ? { label: summary, open: partsOpen, onToggle: () => setExpanded((m) => ({ ...m, [q.id]: !partsOpen })) } : null}
          actions={readOnly ? undefined : <>
            <UpDown index={i} length={list.length} onMove={(a, b) => moveIn(at, a, b)} />
            <IconButton icon="ri-file-copy-line" label="Duplicate" onClick={() => duplicateIn(at, q)} />
            <IconButton icon="ri-delete-bin-line" label="Delete" onClick={() => deleteQuestion(q)} />
          </>} />
        {isOpen ? rowEditor(q, <>
          <button type="button" className={BTN_SECONDARY} onClick={() => setOpen(null)}>Done</button>
          {kids && !readOnly ? <button type="button" className={BTN_SECONDARY} onClick={() => { setExpanded((m) => ({ ...m, [q.id]: true })); setPalette({ ...at, parentId: q.id }); }}><i className="ri-add-line" aria-hidden="true" />Add sub-question</button> : null}
        </>, true) : null}
        {partsOpen && q.children?.length ? <ul className="divide-y divide-background-100" data-testid="row-children">{questionRows({ ...at, parentId: q.id }, q.children, depth + 1)}</ul> : null}
        {partsOpen && tableRows.length ? (
          <ul className="pb-1.5 pl-[5.5rem] pr-4 text-xs text-foreground-700" data-testid="row-table-rows">
            {tableRows.map((r) => <li key={r.id} className="truncate py-0.5"><i className="ri-subtract-line mr-1 text-foreground-400" aria-hidden="true" />{r.label}</li>)}
          </ul>
        ) : null}
      </li>
    );
  });

  const instructionsOpen = open === "instructions";
  return (
    <div className="space-y-4" data-testid="builder">
      {embedded ? null : rows.length ? (
        <NeedsALook rows={rows} done={done} open={open?.startsWith("look:") ? open.slice(5) : null} onToggle={(id) => setOpen(id ? `look:${id}` : null)}
          renderEditor={(r) => {
            const q = flatBy.get(rowQuestionId(r.id))?.question;
            if (!q) return null;
            return rowEditor(q, readOnly ? <button type="button" className={BTN_SECONDARY} onClick={() => setOpen(null)}>Close</button> : <>
              <button type="button" className={BTN_PRIMARY} onClick={() => finishRow(r, q.importMeta?.editedAt ? "Edited" : "Looks good")}>Save &amp; next</button>
              <button type="button" className={BTN_SECONDARY} onClick={() => finishRow(r, "Looks good")}>Looks good</button>
            </>, false);
          }} />
      ) : null}
      {embedded ? null : <AutoResolvedList rows={autoRows} readOnly={readOnly} onReopen={(id) => { editQ(id, reopenAutoResolved); setOpen(`look:${id}`); }} />}

      <div className={`flex flex-wrap items-center justify-between gap-2 ${embedded ? "hidden" : ""}`}>
        <p className="text-sm text-foreground-600">{definition.tasks.length} task{definition.tasks.length === 1 ? "" : "s"} · {flat.filter((f) => !questionType(f.question.type)?.content).length} questions</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN_SECONDARY} onClick={() => setPreview(true)}><i className="ri-eye-line" aria-hidden="true" />Preview as the student sees it</button>
          {!readOnly ? <button type="button" className={BTN_PRIMARY} onClick={() => { const t = newTask(`Task ${definition.tasks.length + 1}`); setDef({ ...definition, tasks: [...definition.tasks, t] }); setOpen(`task:${t.id}`); }}><i className="ri-add-line" aria-hidden="true" />Add task</button> : null}
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-background-200 bg-white">
        <HeadLine open={instructionsOpen} onClick={() => setOpen(instructionsOpen ? null : "instructions")} className="px-3 py-2.5 sm:px-4">
          <span className="text-sm font-semibold text-foreground-900">Instructions shown before task 1</span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground-500">{definition.instructions ? definition.instructions.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) : "None"}</span>
        </HeadLine>
        {instructionsOpen ? (
          <div className="border-t border-primary-100 bg-primary-50/40 px-3 pb-3 pt-2 sm:px-4">
            {readOnly ? <div className="asm-content rounded-lg border border-background-200 bg-white px-3 py-2 text-sm" dangerouslySetInnerHTML={{ __html: asHtml(definition.instructions ?? "") }} />
              : <RichBlockEditor value={asHtml(definition.instructions ?? "")} onChange={(html) => setDef({ ...definition, instructions: html })} label="Instructions shown before task 1" placeholder="What the student reads before task 1…" />}
          </div>
        ) : null}
      </section>

      {definition.tasks.length === 0 ? <Empty icon="ri-file-list-3-line" title="No tasks yet" text="An assessment is tasks, each with sections of questions. Add the first task." /> : null}

      {definition.tasks.map((t, ti) => {
        const taskOpen = open === `task:${t.id}`;
        const count = t.sections.flatMap((s) => s.questions).filter((q) => isAnswerable(q) && q.importMeta?.itemType !== "section_heading").length;
        const hasInfo = Boolean(t.instructions && t.instructions.replace(/<[^>]*>/g, "").trim());
        const infoOpen = Boolean(info[t.id]);
        const lastSection = t.sections[t.sections.length - 1];
        return (
          <section key={t.id} className="overflow-hidden rounded-xl border border-background-200 bg-white" data-testid="builder-task">
            <HeadLine open={taskOpen} onClick={() => setOpen(taskOpen ? null : `task:${t.id}`)} className="border-b border-background-200 bg-background-50 px-3 py-2 sm:px-4"
              actions={<>
                {hasInfo ? <button type="button" className={`${ICON_BTN} ${infoOpen ? "text-primary-700" : ""}`} aria-expanded={infoOpen} aria-label={infoOpen ? "Hide the task instructions" : "Show the task instructions"} title="Task instructions" onClick={() => setInfo((m) => ({ ...m, [t.id]: !infoOpen }))} data-testid="task-info"><i className="ri-information-line" aria-hidden="true" /></button> : null}
                {readOnly ? null : <>
                  <div className={HOVER_ACTIONS}>
                    <UpDown index={ti} length={definition.tasks.length} onMove={(a, b) => setDef({ ...definition, tasks: moveItem(definition.tasks, a, b) })} />
                    <IconButton icon="ri-file-copy-line" label="Duplicate task" onClick={() => setDef({ ...definition, tasks: [...definition.tasks.slice(0, ti + 1), cloneTask(t), ...definition.tasks.slice(ti + 1)] })} />
                    <IconButton icon="ri-delete-bin-line" label="Delete task" onClick={() => window.confirm(`Delete task ${ti + 1} "${t.title}" and its questions?`) && setDef({ ...definition, tasks: definition.tasks.filter((x) => x.id !== t.id) })} />
                  </div>
                  <Menu label="Add" testId="task-add" items={[
                    ...(lastSection ? [{ label: "Add question", icon: "ri-question-line", onClick: () => setPalette({ taskId: t.id, sectionId: lastSection.id }) },
                      { label: "From bank", icon: "ri-archive-line", onClick: () => setBankPick({ taskId: t.id, sectionId: lastSection.id }) }] : []),
                    { label: "Add section", icon: "ri-layout-row-line", onClick: () => addSectionAfter(t.id, lastSection?.id) },
                  ]} />
                </>}
              </>}>
              <span className="font-heading text-sm font-bold text-foreground-950">Task {ti + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground-800">{t.title || "Untitled"}</span>
              <span className="shrink-0 text-xs text-foreground-500" data-testid="task-count">{count} question{count === 1 ? "" : "s"}</span>
            </HeadLine>
            {infoOpen && hasInfo ? <div className="asm-content border-b border-background-200 bg-white px-4 py-2 text-sm text-foreground-700" data-testid="task-info-text" dangerouslySetInnerHTML={{ __html: asHtml(t.instructions ?? "") }} /> : null}
            {taskOpen ? (
              <div className="space-y-3 border-b border-primary-100 bg-primary-50/40 px-3 pb-3 pt-2 sm:px-4">
                <label className="block"><span className="text-2xs font-bold uppercase tracking-wide text-foreground-600">Task title</span>
                  <input className={`${FIELD} mt-1`} value={t.title} readOnly={readOnly} onChange={(e) => patchTask(t.id, { title: e.target.value })} aria-label="Task title" /></label>
                {readOnly ? (t.instructions ? <div className="asm-content rounded-lg border border-background-200 bg-white px-3 py-2 text-sm" dangerouslySetInnerHTML={{ __html: asHtml(t.instructions) }} /> : null)
                  : <RichBlockEditor value={asHtml(t.instructions ?? "")} onChange={(html) => patchTask(t.id, { instructions: html })} label="Task instructions" placeholder="Conditions, resubmission rules, location, what to submit…" />}
                <button type="button" className={BTN_SECONDARY} onClick={() => setOpen(null)}>Done</button>
              </div>
            ) : null}
            {t.sections.length === 0 && !readOnly ? <div className="px-4 py-3"><button type="button" className="cursor-pointer text-sm font-semibold text-primary-700 hover:underline" onClick={() => addSectionAfter(t.id)}>+ Add a section</button></div> : null}
            {t.sections.map((s, si) => {
              const at: Target = { taskId: t.id, sectionId: s.id };
              const secOpen = open === `section:${s.id}`;
              return (
                <div key={s.id} className={si ? "border-t border-background-200" : ""} data-testid="builder-section">
                  <HeadLine open={secOpen} onClick={() => setOpen(secOpen ? null : `section:${s.id}`)} className="px-3 pb-0.5 pt-2 sm:px-4"
                    actions={readOnly ? undefined : <div className={HOVER_ACTIONS}>
                      <UpDown index={si} length={t.sections.length} onMove={(a, b) => patchTask(t.id, { sections: moveItem(t.sections, a, b) })} />
                      <IconButton icon="ri-file-copy-line" label="Duplicate section" onClick={() => patchTask(t.id, { sections: [...t.sections.slice(0, si + 1), cloneSection(s), ...t.sections.slice(si + 1)] })} />
                      <IconButton icon="ri-delete-bin-line" label="Delete section" onClick={() => window.confirm(`Delete section "${s.title}" and its questions?`) && patchTask(t.id, { sections: t.sections.filter((x) => x.id !== s.id) })} />
                      <Menu label="Add" testId="section-add" items={[
                        { label: "Add question", icon: "ri-question-line", onClick: () => setPalette(at) },
                        { label: "From bank", icon: "ri-archive-line", onClick: () => setBankPick(at) },
                        { label: "Add section", icon: "ri-layout-row-line", onClick: () => addSectionAfter(t.id, s.id) },
                      ]} />
                    </div>}>
                    <span className="truncate text-2xs font-bold uppercase tracking-wide text-foreground-600">{s.title || "Untitled section"}</span>
                    {s.showIf ? <i className="ri-git-branch-line text-foreground-400" title="Shown only when its condition is met" aria-label="Conditional" /> : null}
                  </HeadLine>
                  {secOpen ? (
                    <div className="mx-3 mb-2 space-y-3 rounded-lg border border-primary-100 bg-primary-50/40 p-3 sm:mx-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="block"><span className="text-2xs font-bold uppercase tracking-wide text-foreground-600">Section title</span>
                          <input className={`${FIELD} mt-1`} value={s.title} readOnly={readOnly} onChange={(e) => patchSection(t.id, s.id, { title: e.target.value })} aria-label="Section title" /></label>
                        <label className="block"><span className="text-2xs font-bold uppercase tracking-wide text-foreground-600">Description</span>
                          <input className={`${FIELD} mt-1`} value={s.description ?? ""} readOnly={readOnly} onChange={(e) => patchSection(t.id, s.id, { description: e.target.value })} aria-label="Section description" /></label>
                      </div>
                      {!readOnly ? <ConditionEditor value={s.showIf} onChange={(c) => patchSection(t.id, s.id, { showIf: c })} candidates={earlierQuestionIds(definition, s.questions[0]?.id ?? "")} /> : null}
                      <button type="button" className={BTN_SECONDARY} onClick={() => setOpen(null)}>Done</button>
                    </div>
                  ) : null}
                  {s.questions.length ? <ul className="divide-y divide-background-100" data-testid="builder-rows">{questionRows(at, s.questions, 0)}</ul>
                    : <p className="px-4 pb-3 text-sm text-foreground-500">No questions yet.{!readOnly ? <> <button type="button" className="cursor-pointer font-semibold text-primary-700 hover:underline" onClick={() => setPalette(at)}>Add a question</button></> : null}</p>}
                </div>
              );
            })}
          </section>
        );
      })}

      <Modal open={Boolean(palette)} title={palette?.parentId ? "Add a sub-question" : "Add a question"} onClose={() => setPalette(null)} width="max-w-3xl">
        <div className="space-y-4">{(Object.keys(GROUP_LABEL) as TypeGroup[]).map((g) => (
          <div key={g}><p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-foreground-500">{GROUP_LABEL[g]}</p>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">{QUESTION_TYPES.filter((t) => t.group === g && t.id !== "content").map((t) => (
              <button key={t.id} type="button" data-testid={`palette-${t.id}`} className="flex cursor-pointer items-start gap-2 rounded-lg border border-background-200 bg-white p-2 text-left hover:border-primary-300 hover:bg-primary-50/40" onClick={() => palette && addQuestion(palette, newQuestion(t.id))}>
                <i className={`${t.icon} mt-0.5 text-lg text-foreground-600`} aria-hidden="true" /><span><span className="block text-sm font-medium text-foreground-900">{t.label}</span><span className="block text-xs text-foreground-500">{t.hint}</span></span>
              </button>))}</div></div>))}</div>
      </Modal>
      {bankPick ? <BankPicker onClose={() => setBankPick(null)} onPick={(q, k) => addQuestion(bankPick, cloneQuestion(withSchema(q)), k)} /> : null}
      <Modal open={preview} title="Preview as the student sees it" onClose={() => setPreview(false)} width="max-w-4xl">
        <AssessmentRenderer definition={definition} responses={previewResponses} onChange={setPreviewResponses} mode="preview" declarationText={declarationText} />
      </Modal>
    </div>
  );
}

function BankPicker({ onClose, onPick }: { onClose: () => void; onPick: (q: Question, keys: Partial<QuestionKey> | null) => void }) {
  const [rows, setRows] = useState<BankRow[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const load = async (query: string) => { try { setRows(await asmAdmin<BankRow[]>("bank_list", { q: query || undefined })); } catch (e) { setError(e instanceof Error ? e.message : "The bank did not load."); setRows([]); } };
  useEffect(() => { void load(""); }, []);
  const insert = async (r: BankRow) => { const full = await asmAdmin<{ definition: Question; keys: Partial<QuestionKey> }>("bank_get", { id: r.id }); onPick(full.definition, full.keys); };
  return (
    <Modal open title="Insert from the question bank" onClose={onClose} width="max-w-2xl">
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void load(q); }}><TextInput placeholder="Search by title or tag" value={q} onChange={(e) => setQ(e.target.value)} /><button type="submit" className={BTN_SECONDARY}>Search</button></form>
      {error ? <p role="alert" className="mb-2 text-sm text-red-700">{error}</p> : null}
      {rows === null ? <p className="text-sm text-foreground-600">Loading…</p> : rows.length === 0 ? <p className="text-sm text-foreground-600">Nothing in the bank yet. Open a question's More options and choose "Save to question bank".</p> : (
        <ul className="divide-y divide-background-100 overflow-hidden rounded-xl border border-background-200 bg-white">{rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <i className={`${questionType(r.type)?.icon ?? "ri-question-line"} text-foreground-400`} aria-hidden="true" />
            <span className="min-w-0 flex-1"><span className="block truncate text-foreground-900">{r.title}</span><span className="text-xs text-foreground-500">{questionType(r.type)?.label ?? r.type} · v{r.versionNo}{r.tags.length ? ` · ${r.tags.join(", ")}` : ""}</span></span>
            <button type="button" className={BTN_SECONDARY} onClick={() => void insert(r)}>Insert a copy</button>
          </li>))}</ul>
      )}
    </Modal>
  );
}
