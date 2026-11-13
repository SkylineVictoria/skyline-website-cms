import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { Empty } from "@/pages/admin/components/rto/overlay";
import AssessmentRenderer from "@/components/assessment/AssessmentRenderer";
import { cloneQuestion, cloneSection, cloneTask, earlierQuestionIds, moveItem, newSection, newTask, removeQuestion, updateQuestion } from "@/lib/assessment/definition";
import { GROUP_LABEL, isAnswerable, newQuestion, QUESTION_TYPES, questionType, withSchema, type TypeGroup } from "@/lib/assessment/registry";
import type { Definition, Question, QuestionKey, Section, Task } from "@/lib/assessment/types";
import { asmAdmin, type BankRow } from "@/pages/admin/lib/assessments";
import ConditionEditor from "./ConditionEditor";
import QuestionEditor from "./QuestionEditor";
import { DragHandle, UpDown } from "./Sortable";
import { useSortable } from "./useSortable";

export interface BuilderProps {
  definition: Definition;
  keys: QuestionKey[];
  onChange: (definition: Definition, keys: QuestionKey[]) => void;
  readOnly?: boolean;
  declarationText?: string;
}

type Selection = { kind: "task"; taskId: string } | { kind: "section"; taskId: string; sectionId: string } | { kind: "question"; questionId: string } | null;

/** The drag-and-drop builder: tasks > sections > questions (with children), the type palette, the question editor and a live preview. */
export default function Builder({ definition, keys, onChange, readOnly, declarationText }: BuilderProps) {
  const [sel, setSel] = useState<Selection>(null);
  const [preview, setPreview] = useState(false);
  const [previewResponses, setPreviewResponses] = useState<Record<string, unknown>>({});
  const [palette, setPalette] = useState<{ taskId: string; sectionId: string; parentId?: string } | null>(null);
  const [bankPick, setBankPick] = useState<{ taskId: string; sectionId: string } | null>(null);
  const keyBy = useMemo(() => new Map(keys.map((k) => [k.questionId, k])), [keys]);
  const setDef = (d: Definition) => onChange(d, keys);

  const addQuestion = (taskId: string, sectionId: string, q: Question, parentId?: string) => {
    const d = parentId
      ? updateQuestion(definition, parentId, (p) => ({ ...p, children: [...(p.children ?? []), q] }))
      : { ...definition, tasks: definition.tasks.map((t) => (t.id !== taskId ? t : { ...t, sections: t.sections.map((s) => (s.id !== sectionId ? s : { ...s, questions: [...s.questions, q] })) })) };
    setDef(d); setSel({ kind: "question", questionId: q.id }); setPalette(null);
  };
  const patchQuestion = (id: string, patch: Partial<Question>) => setDef(updateQuestion(definition, id, (q) => ({ ...q, ...patch })));
  const patchKey = (id: string, patch: Partial<QuestionKey>) => {
    const next = keys.some((k) => k.questionId === id) ? keys.map((k) => (k.questionId === id ? { ...k, ...patch } : k)) : [...keys, { questionId: id, ...patch }];
    onChange(definition, next);
  };
  const deleteQuestion = (id: string) => { setDef(removeQuestion(definition, id)); onChange(removeQuestion(definition, id), keys.filter((k) => k.questionId !== id)); if (sel?.kind === "question" && sel.questionId === id) setSel(null); };
  const duplicateQuestion = (taskId: string, sectionId: string, q: Question) => addQuestion(taskId, sectionId, cloneQuestion(q));
  const saveToBank = async (q: Question) => {
    const title = window.prompt("Save to the question bank as:", q.label || q.type); if (title === null) return;
    const unitId = (definition as { unitId?: string }).unitId;
    await asmAdmin("bank_save", { title, definition: q, keys: keyBy.get(q.id) ?? {}, unitId, tags: [q.type] });
    window.alert("Saved to the question bank.");
  };
  const patchTask = (taskId: string, patch: Partial<Task>) => setDef({ ...definition, tasks: definition.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) });
  const patchSection = (taskId: string, sectionId: string, patch: Partial<Section>) => patchTask(taskId, { sections: definition.tasks.find((t) => t.id === taskId)!.sections.map((s) => (s.id === sectionId ? { ...s, ...patch } : s)) });

  const selectedQuestion = sel?.kind === "question" ? (findQ(definition, sel.questionId) ?? null) : null;
  const selectedTask = sel?.kind === "task" ? definition.tasks.find((t) => t.id === sel.taskId) : sel?.kind === "section" ? definition.tasks.find((t) => t.id === sel.taskId) : null;
  const selectedSection = sel?.kind === "section" && selectedTask ? selectedTask.sections.find((s) => s.id === sel.sectionId) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><label className="block text-xs text-foreground-600">Instructions shown before task 1</label><TextArea rows={2} className="mt-1" disabled={readOnly} value={definition.instructions ?? ""} onChange={(e) => setDef({ ...definition, instructions: e.target.value })} /></div>
          <div className="flex gap-2"><Button size="sm" variant="outline" icon="ri-eye-line" onClick={() => setPreview(true)}>Preview</Button>{!readOnly ? <Button size="sm" icon="ri-add-line" onClick={() => { const t = newTask(`Task ${definition.tasks.length + 1}`); setDef({ ...definition, tasks: [...definition.tasks, t] }); setSel({ kind: "task", taskId: t.id }); }}>Add task</Button> : null}</div>
        </div>
        {definition.tasks.length === 0 ? <Empty icon="ri-file-list-3-line" title="No tasks yet" text="An assessment is tasks, each with sections of questions. Add the first task." /> : null}
        <TaskList definition={definition} sel={sel} setSel={setSel} readOnly={readOnly} onMoveTask={(f, t) => setDef({ ...definition, tasks: moveItem(definition.tasks, f, t) })}
          onMoveSection={(taskId, f, t) => patchTask(taskId, { sections: moveItem(definition.tasks.find((x) => x.id === taskId)!.sections, f, t) })}
          onMoveQuestion={(taskId, sectionId, f, t) => patchSection(taskId, sectionId, { questions: moveItem(definition.tasks.find((x) => x.id === taskId)!.sections.find((s) => s.id === sectionId)!.questions, f, t) })}
          onMoveChild={(parentId, f, t) => setDef(updateQuestion(definition, parentId, (p) => ({ ...p, children: moveItem(p.children ?? [], f, t) })))}
          onAddSection={(taskId) => { const s = newSection(`Section ${definition.tasks.find((t) => t.id === taskId)!.sections.length + 1}`); patchTask(taskId, { sections: [...definition.tasks.find((t) => t.id === taskId)!.sections, s] }); setSel({ kind: "section", taskId, sectionId: s.id }); }}
          onAddQuestion={(taskId, sectionId, parentId) => setPalette({ taskId, sectionId, parentId })} onPickFromBank={(taskId, sectionId) => setBankPick({ taskId, sectionId })}
          onDuplicateTask={(t) => setDef({ ...definition, tasks: [...definition.tasks, cloneTask(t)] })} onDeleteTask={(id) => { setDef({ ...definition, tasks: definition.tasks.filter((t) => t.id !== id) }); setSel(null); }}
          onDuplicateSection={(taskId, s) => patchTask(taskId, { sections: [...definition.tasks.find((t) => t.id === taskId)!.sections, cloneSection(s)] })}
          onDeleteSection={(taskId, id) => { patchTask(taskId, { sections: definition.tasks.find((t) => t.id === taskId)!.sections.filter((s) => s.id !== id) }); setSel(null); }}
          onDuplicateQuestion={duplicateQuestion} onDeleteQuestion={deleteQuestion} />
      </div>
      <div className="min-w-0 rounded-card border border-background-200 bg-background-50 p-4">
        {selectedQuestion ? (
          readOnly ? <AssessmentRenderer definition={{ tasks: [{ id: "x", title: "", sections: [{ id: "y", title: "", questions: [selectedQuestion] }] }] }} responses={{}} mode="review" />
          : <QuestionEditor q={selectedQuestion} onChange={(patch) => patchQuestion(selectedQuestion.id, patch)} candidates={earlierQuestionIds(definition, selectedQuestion.id)} keyRow={keyBy.get(selectedQuestion.id)} onKeyChange={(patch) => patchKey(selectedQuestion.id, patch)} onSaveToBank={() => void saveToBank(selectedQuestion)} />
        ) : selectedSection && selectedTask ? (
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-foreground-500">Section</p>
            <label className="block"><span className="mb-1 block text-xs text-foreground-600">Title</span><TextInput disabled={readOnly} value={selectedSection.title} onChange={(e) => patchSection(selectedTask.id, selectedSection.id, { title: e.target.value })} /></label>
            <label className="block"><span className="mb-1 block text-xs text-foreground-600">Description</span><TextArea rows={3} disabled={readOnly} value={selectedSection.description ?? ""} onChange={(e) => patchSection(selectedTask.id, selectedSection.id, { description: e.target.value })} /></label>
            <SectionCondition definition={definition} section={selectedSection} onChange={(c) => patchSection(selectedTask.id, selectedSection.id, { showIf: c })} />
          </div>
        ) : selectedTask ? (
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-foreground-500">Task</p>
            <label className="block"><span className="mb-1 block text-xs text-foreground-600">Title</span><TextInput disabled={readOnly} value={selectedTask.title} onChange={(e) => patchTask(selectedTask.id, { title: e.target.value })} /></label>
            <label className="block"><span className="mb-1 block text-xs text-foreground-600">Task instructions (conditions, resubmission rules, location, what to submit)</span><TextArea rows={8} disabled={readOnly} value={selectedTask.instructions ?? ""} onChange={(e) => patchTask(selectedTask.id, { instructions: e.target.value })} /></label>
          </div>
        ) : <Empty icon="ri-cursor-line" title="Select a task, section or question" text="Its settings appear here. Drag the handles to reorder anything." />}
      </div>

      <Modal open={Boolean(palette)} title="Add a question" onClose={() => setPalette(null)} width="max-w-3xl">
        <div className="space-y-4">{(Object.keys(GROUP_LABEL) as TypeGroup[]).map((g) => (
          <div key={g}><p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-foreground-500">{GROUP_LABEL[g]}</p>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">{QUESTION_TYPES.filter((t) => t.group === g && t.id !== "content").map((t) => (
              <button key={t.id} type="button" className="flex items-start gap-2 rounded-md border border-background-200 p-2 text-left hover:bg-background-100" onClick={() => palette && addQuestion(palette.taskId, palette.sectionId, newQuestion(t.id), palette.parentId)}>
                <i className={`${t.icon} mt-0.5 text-lg text-foreground-600`} aria-hidden="true" /><span><span className="block text-sm font-medium text-foreground-900">{t.label}</span><span className="block text-xs text-foreground-500">{t.hint}</span></span>
              </button>))}</div></div>))}</div>
      </Modal>
      {bankPick ? <BankPicker onClose={() => setBankPick(null)} onPick={(q, k) => { const c = cloneQuestion(withSchema(q)); addQuestion(bankPick.taskId, bankPick.sectionId, c); if (k && Object.keys(k).length) patchKey(c.id, { ...k, questionId: c.id } as QuestionKey); setBankPick(null); }} /> : null}
      <Modal open={preview} title="Preview as the student sees it" onClose={() => setPreview(false)} width="max-w-4xl">
        <AssessmentRenderer definition={definition} responses={previewResponses} onChange={setPreviewResponses} mode="preview" declarationText={declarationText} />
      </Modal>
    </div>
  );
}

function findQ(def: Definition, id: string): Question | undefined {
  const walk = (list: Question[]): Question | undefined => { for (const q of list) { if (q.id === id) return q; const c = q.children ? walk(q.children) : undefined; if (c) return c; } return undefined; };
  for (const t of def.tasks) for (const s of t.sections) { const q = walk(s.questions); if (q) return q; }
  return undefined;
}

function SectionCondition({ definition, section, onChange }: { definition: Definition; section: Section; onChange: (c: Section["showIf"]) => void }) {
  const candidates = earlierQuestionIds(definition, section.questions[0]?.id ?? "");
  return <ConditionEditor value={section.showIf} onChange={onChange} candidates={candidates} />;
}

interface TaskListProps {
  definition: Definition; sel: Selection; setSel: (s: Selection) => void; readOnly?: boolean;
  onMoveTask: (f: number, t: number) => void; onMoveSection: (taskId: string, f: number, t: number) => void; onMoveQuestion: (taskId: string, sectionId: string, f: number, t: number) => void; onMoveChild: (parentId: string, f: number, t: number) => void;
  onAddSection: (taskId: string) => void; onAddQuestion: (taskId: string, sectionId: string, parentId?: string) => void; onPickFromBank: (taskId: string, sectionId: string) => void;
  onDuplicateTask: (t: Task) => void; onDeleteTask: (id: string) => void; onDuplicateSection: (taskId: string, s: Section) => void; onDeleteSection: (taskId: string, id: string) => void;
  onDuplicateQuestion: (taskId: string, sectionId: string, q: Question) => void; onDeleteQuestion: (id: string) => void;
}
function TaskList(p: TaskListProps) {
  const tasks = useSortable("tasks", p.onMoveTask);
  return (
    <div className="space-y-3">
      {p.definition.tasks.map((t, ti) => (
        <div key={t.id} {...tasks.itemProps(ti)} className={`rounded-card border bg-background-50 ${p.sel?.kind === "task" && p.sel.taskId === t.id ? "border-primary-400" : "border-background-200"} ${tasks.itemProps(ti).className}`}>
          <div className="flex items-center gap-1 px-2 py-2">
            {!p.readOnly ? <DragHandle {...tasks.handleProps(ti)} /> : null}
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => p.setSel({ kind: "task", taskId: t.id })}><span className="block truncate text-sm font-semibold text-foreground-950">Task {ti + 1}: {t.title || "Untitled"}</span></button>
            {!p.readOnly ? <><UpDown index={ti} length={p.definition.tasks.length} onMove={p.onMoveTask} /><Button size="sm" variant="ghost" icon="ri-file-copy-line" aria-label="Duplicate task" onClick={() => p.onDuplicateTask(t)} /><Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Delete task" onClick={() => window.confirm(`Delete task "${t.title}" and its questions?`) && p.onDeleteTask(t.id)} /></> : null}
          </div>
          <SectionList task={t} {...p} />
        </div>
      ))}
    </div>
  );
}
function SectionList({ task, ...p }: TaskListProps & { task: Task }) {
  const sections = useSortable(`sections-${task.id}`, (f, t) => p.onMoveSection(task.id, f, t));
  return (
    <div className="space-y-2 px-2 pb-2">
      {task.sections.map((s, si) => (
        <div key={s.id} {...sections.itemProps(si)} className={`rounded-md border bg-background-100/60 ${p.sel?.kind === "section" && p.sel.sectionId === s.id ? "border-primary-400" : "border-background-200"} ${sections.itemProps(si).className}`}>
          <div className="flex items-center gap-1 px-2 py-1.5">
            {!p.readOnly ? <DragHandle {...sections.handleProps(si)} /> : null}
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => p.setSel({ kind: "section", taskId: task.id, sectionId: s.id })}><span className="block truncate text-sm font-medium text-foreground-800">{s.title || "Untitled section"}{s.showIf ? <i className="ri-git-branch-line ml-1 text-foreground-400" title="Conditional" aria-hidden="true" /> : null}</span></button>
            {!p.readOnly ? <><UpDown index={si} length={task.sections.length} onMove={(f, t) => p.onMoveSection(task.id, f, t)} /><Button size="sm" variant="ghost" icon="ri-file-copy-line" aria-label="Duplicate section" onClick={() => p.onDuplicateSection(task.id, s)} /><Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Delete section" onClick={() => window.confirm(`Delete section "${s.title}" and its questions?`) && p.onDeleteSection(task.id, s.id)} /></> : null}
          </div>
          <QuestionList task={task} section={s} questions={s.questions} parentId={undefined} depth={0} {...p} />
          {!p.readOnly ? <div className="flex gap-2 px-2 pb-2"><Button size="sm" variant="outline" icon="ri-add-line" onClick={() => p.onAddQuestion(task.id, s.id)}>Add question</Button><Button size="sm" variant="ghost" icon="ri-archive-line" onClick={() => p.onPickFromBank(task.id, s.id)}>From bank</Button></div> : null}
        </div>
      ))}
      {!p.readOnly ? <Button size="sm" variant="ghost" icon="ri-add-line" onClick={() => p.onAddSection(task.id)}>Add section</Button> : null}
    </div>
  );
}
function QuestionList({ task, section, questions, parentId, depth, ...p }: TaskListProps & { task: Task; section: Section; questions: Question[]; parentId: string | undefined; depth: number }) {
  const list = useSortable(`q-${parentId ?? section.id}`, (f, t) => (parentId ? p.onMoveChild(parentId, f, t) : p.onMoveQuestion(task.id, section.id, f, t)));
  let n = 0;
  return (
    <ul className={`space-y-1 ${depth ? "ml-4 border-l-2 border-background-200 pl-2" : "px-2"}`}>
      {questions.map((q, qi) => {
        const type = questionType(q.type); const answerable = isAnswerable(q); if (answerable && !depth) n += 1;
        const selected = p.sel?.kind === "question" && p.sel.questionId === q.id;
        return (
          <li key={q.id} {...list.itemProps(qi)} className={`rounded-md border bg-background-50 ${selected ? "border-primary-400" : "border-background-200"} ${list.itemProps(qi).className}`}>
            <div className="flex items-center gap-1 px-2 py-1.5">
              {!p.readOnly ? <DragHandle {...list.handleProps(qi)} /> : null}
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => p.setSel({ kind: "question", questionId: q.id })}>
                <i className={`${type?.icon ?? "ri-question-line"} shrink-0 text-foreground-500`} aria-hidden="true" />
                <span className="truncate text-sm text-foreground-900">{answerable && !depth ? <span className="mr-1 text-foreground-500">{n}.</span> : null}{q.label || type?.label || q.type}</span>
                {q.required ? <span className="text-primary-600">*</span> : null}
                {q.showIf ? <i className="ri-git-branch-line text-foreground-400" title="Conditional" aria-hidden="true" /> : null}
                {q.assessorOnly || type?.assessorOnly ? <Badge tone="muted">assessor</Badge> : null}
              </button>
              {!p.readOnly ? <><UpDown index={qi} length={questions.length} onMove={(f, t) => (parentId ? p.onMoveChild(parentId, f, t) : p.onMoveQuestion(task.id, section.id, f, t))} /><Button size="sm" variant="ghost" icon="ri-file-copy-line" aria-label="Duplicate question" onClick={() => p.onDuplicateQuestion(task.id, section.id, q)} /><Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Delete question" onClick={() => p.onDeleteQuestion(q.id)} /></> : null}
            </div>
            {type?.hasChildren ? (
              <div className="pb-2">
                <QuestionList task={task} section={section} questions={q.children ?? []} parentId={q.id} depth={depth + 1} {...p} />
                {!p.readOnly ? <div className="ml-6 mt-1"><Button size="sm" variant="ghost" icon="ri-add-line" onClick={() => p.onAddQuestion(task.id, section.id, q.id)}>Add sub-question</Button></div> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function BankPicker({ onClose, onPick }: { onClose: () => void; onPick: (q: Question, keys: Partial<QuestionKey> | null) => void }) {
  const [rows, setRows] = useState<BankRow[] | null>(null);
  const [q, setQ] = useState("");
  const load = async (query: string) => setRows(await asmAdmin<BankRow[]>("bank_list", { q: query || undefined }));
  useEffect(() => { void load(""); }, []);
  return (
    <Modal open title="Insert from the question bank" onClose={onClose} width="max-w-2xl">
      <div className="mb-3 flex gap-2"><TextInput placeholder="Search by title or tag" value={q} onChange={(e) => setQ(e.target.value)} /><Button variant="outline" onClick={() => void load(q)}>Search</Button></div>
      {rows === null ? <p className="text-sm text-foreground-600">Loading…</p> : rows.length === 0 ? <p className="text-sm text-foreground-600">Nothing in the bank yet. Select a question in the builder and choose "Save to question bank".</p> : (
        <ul className="divide-y divide-background-100">{rows.map((r) => <li key={r.id} className="flex items-center gap-2 py-2 text-sm"><span className="min-w-0 flex-1"><span className="block truncate text-foreground-900">{r.title}</span><span className="text-xs text-foreground-500">{questionType(r.type)?.label ?? r.type} · v{r.versionNo} · {r.tags.join(", ")}</span></span><Select className="w-auto" value="" onChange={async (e) => { if (e.target.value !== "insert") return; const full = await asmAdmin<{ definition: Question; keys: Partial<QuestionKey> }>("bank_get", { id: r.id }); onPick(full.definition, full.keys); }}><option value="">…</option><option value="insert">Insert a copy</option></Select></li>)}</ul>
      )}
    </Modal>
  );
}
