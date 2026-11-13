import { useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { conditionMet } from "@/lib/assessment/conditions";
import { isAnswerable, isAssessorOnly, MARKING_LABEL } from "@/lib/assessment/registry";
import type { Attempt, Definition, EvidenceFile, Outcome, Question, QuestionKey, Responses, UnitMapping } from "@/lib/assessment/types";
import { OUTCOME_LABEL } from "@/lib/assessment/api";
import { typeUi } from "./registry";

export interface MarkInput { questionId: string; criterionId?: string | null; outcome: Outcome | null; score?: number | null; rubricLevelId?: string | null; feedback?: string }
export interface TaskMarkInput { taskId: string; outcome: Outcome | null; feedback: string }
export interface MarkingPayload { results: MarkInput[]; taskResults: TaskMarkInput[]; assessorResponses: Responses; overallFeedback: string }
export interface ElementRef { questionId: string; criterionId: string | null; elementKind: string; elementCode: string; elementText: string }

export interface MarkingViewProps {
  definition: Definition;
  attempt: Attempt;
  keys: QuestionKey[];
  mappings?: ElementRef[];
  readOnly?: boolean;
  busy?: boolean;
  openEvidence?: (file: EvidenceFile) => void;
  onSave: (payload: MarkingPayload) => Promise<void>;
  onReturn: (outcome: Outcome, payload: MarkingPayload, dueAt: string | null) => Promise<void>;
  onUploadAssessorEvidence?: (q: Question, files: FileList) => Promise<void>;
  maxAttempts?: number;
  reassessmentDays?: number;
}

const rkey = (qid: string, cid?: string | null) => `${qid}|${cid ?? ""}`;
const tone = (o: Outcome | null | undefined) => (o === "S" ? "success" : o === "NYS" ? "warn" : "muted");

function OutcomePick({ value, onChange, disabled, name }: { value: Outcome | null; onChange: (o: Outcome | null) => void; disabled?: boolean; name: string }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-background-300 text-xs font-medium">
      {(["S", "NYS"] as Outcome[]).map((o) => (
        <button key={o} type="button" disabled={disabled} aria-pressed={value === o} name={name} onClick={() => onChange(value === o ? null : o)}
          className={`px-3 py-1.5 ${value === o ? (o === "S" ? "bg-primary-500 text-background-50" : "bg-foreground-900 text-background-50") : "bg-background-50 text-foreground-700 hover:bg-background-100"} disabled:opacity-60`}>
          {o === "S" ? "Satisfactory" : "Not yet satisfactory"}
        </button>
      ))}
    </div>
  );
}

export default function MarkingView({ definition, attempt, keys, mappings = [], readOnly, busy, openEvidence, onSave, onReturn, onUploadAssessorEvidence, maxAttempts = 3, reassessmentDays = 5 }: MarkingViewProps) {
  const keyBy = useMemo(() => new Map(keys.map((k) => [k.questionId, k])), [keys]);
  const [results, setResults] = useState<Map<string, MarkInput>>(() => new Map(attempt.results.map((r) => [rkey(r.questionId, r.criterionId), { questionId: r.questionId, criterionId: r.criterionId, outcome: r.outcome, score: r.score, rubricLevelId: r.rubricLevelId, feedback: r.feedback }])));
  const [tasks, setTasks] = useState<Map<string, TaskMarkInput>>(() => new Map(attempt.taskResults.map((t) => [t.taskId, { taskId: t.taskId, outcome: t.outcome, feedback: t.feedback }])));
  const [assessorResponses, setAssessorResponses] = useState<Responses>(attempt.assessorResponses ?? {});
  const [overall, setOverall] = useState(attempt.overallFeedback ?? "");
  const [decision, setDecision] = useState<Outcome | null>(null);
  const [dueLocal, setDueLocal] = useState("");
  const suggested = useMemo(() => new Map(attempt.results.map((r) => [rkey(r.questionId, r.criterionId), r.suggestedOutcome])), [attempt.results]);
  const rollup = useMemo(() => new Map(attempt.taskResults.map((t) => [t.taskId, t.rollupSuggested])), [attempt.taskResults]);
  const locked = readOnly || attempt.state === "returned" || attempt.state === "final" || attempt.state === "void";

  const get = (qid: string, cid?: string | null): MarkInput => results.get(rkey(qid, cid)) ?? { questionId: qid, criterionId: cid ?? null, outcome: null, feedback: "" };
  const set = (qid: string, cid: string | null | undefined, patch: Partial<MarkInput>) => setResults((m) => { const n = new Map(m); n.set(rkey(qid, cid), { ...get(qid, cid), ...patch }); return n; });
  const payload = (): MarkingPayload => ({ results: [...results.values()], taskResults: [...tasks.values()], assessorResponses, overallFeedback: overall });

  const renderView = (q: Question, scope: Responses, prefix: string): ReactNode => {
    const ui = typeUi(q.type);
    const value = isAssessorOnly(q) ? assessorResponses[q.id] : scope[q.id];
    return ui.View({ q, value, evidence: attempt.evidence, openEvidence, renderChildren: (children, r, p) => children.map((c) => renderQuestion(c, r, p, null)) });
  };

  const renderQuestion = (q: Question, scope: Responses, prefix: string, number: string | null): ReactNode => {
    if (!conditionMet(q.showIf, scope)) return null;
    if (!isAnswerable(q)) return <div key={prefix + q.id} className="rounded-md bg-background-100 p-3 text-sm text-foreground-700">{typeUi(q.type).View({ q, value: null })}</div>;
    const key = keyBy.get(q.id);
    const mode = q.markingMode ?? "criteria";
    const assessor = isAssessorOnly(q);
    const r = get(q.id);
    const sug = suggested.get(rkey(q.id, null));
    const refs = mappings.filter((m) => m.questionId === q.id);
    return (
      <div key={prefix + q.id} className="rounded-card border border-background-200 bg-background-50 p-4" data-question={q.id}>
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <p className="text-sm font-medium text-foreground-950">{number ? <span className="mr-1.5 text-foreground-500">{number}</span> : null}{q.label}</p>
          <Badge tone="muted">{MARKING_LABEL[mode]}</Badge>
        </div>
        <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-500">{assessor ? "Assessor record" : "Student answer"}</p>
            {assessor && !locked ? typeUi(q.type).Input({ q, value: assessorResponses[q.id], onChange: (v) => setAssessorResponses((a) => ({ ...a, [q.id]: v })), evidence: attempt.evidence, openEvidence, onUpload: onUploadAssessorEvidence }) : renderView(q, scope, prefix)}
          </div>
          <div className="space-y-3">
            {key?.modelAnswer || key?.assessorGuidance || key?.answerKey !== undefined ? (
              <div className="rounded-md border border-accent-100 bg-accent-50 p-3 text-sm">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-accent-900">Assessor only</p>
                {key.modelAnswer ? <p className="whitespace-pre-wrap text-foreground-900"><span className="font-medium">Model answer: </span>{key.modelAnswer}</p> : null}
                {key.assessorGuidance ? <p className="mt-1 whitespace-pre-wrap text-foreground-800"><span className="font-medium">Guidance: </span>{key.assessorGuidance}</p> : null}
                {key.answerKey !== undefined && key.answerKey !== null ? <p className="mt-1 text-foreground-800"><span className="font-medium">Key: </span><code className="text-xs">{JSON.stringify(key.answerKey)}</code></p> : null}
              </div>
            ) : null}
            {refs.length ? <p className="text-xs text-foreground-600"><i className="ri-links-line mr-1" aria-hidden="true" />{refs.map((m) => `${m.elementCode || m.elementKind}`).join(", ")}</p> : null}
            {mode === "auto" ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-foreground-700">Auto-check suggests</span><Badge tone={tone(sug)}>{sug ? OUTCOME_LABEL[sug] : "nothing (no key)"}</Badge>
                {!locked && sug && !r.outcome ? <Button size="sm" variant="outline" onClick={() => set(q.id, null, { outcome: sug })}>Confirm</Button> : null}
              </div>
            ) : null}
            {mode === "criteria" && q.criteria?.length ? (
              <ul className="space-y-2">{q.criteria.map((c) => { const cr = get(q.id, c.id); return (
                <li key={c.id} className="rounded-md border border-background-200 p-2 text-sm">
                  <p className="text-foreground-900">{c.text}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2"><OutcomePick name={`${q.id}-${c.id}`} value={cr.outcome} disabled={locked} onChange={(o) => set(q.id, c.id, { outcome: o })} /><TextInput className="min-w-[10rem] flex-1" placeholder="Feedback on this criterion" disabled={locked} value={cr.feedback ?? ""} onChange={(e) => set(q.id, c.id, { feedback: e.target.value })} /></div>
                </li>); })}</ul>
            ) : null}
            {mode === "rubric" && q.rubric?.levels?.length ? (
              <Select disabled={locked} value={r.rubricLevelId ?? ""} onChange={(e) => { const lv = q.rubric?.levels.find((l) => l.id === e.target.value); set(q.id, null, { rubricLevelId: lv?.id ?? null, score: lv?.score ?? null, outcome: lv ? (lv.score >= Math.max(...(q.rubric?.levels.map((l) => l.score) ?? [0])) ? "S" : r.outcome) : r.outcome }); }}>
                <option value="">Rubric level…</option>{q.rubric.levels.map((l) => <option key={l.id} value={l.id}>{l.label} ({l.score})</option>)}
              </Select>
            ) : null}
            {mode !== "none" ? (
              <div className="flex flex-wrap items-center gap-2">
                <OutcomePick name={q.id} value={r.outcome} disabled={locked} onChange={(o) => set(q.id, null, { outcome: o })} />
                {mode === "rubric" ? <TextInput type="number" className="w-24" placeholder="Score" disabled={locked} value={r.score ?? ""} onChange={(e) => set(q.id, null, { score: e.target.value === "" ? null : Number(e.target.value) })} /> : null}
              </div>
            ) : null}
            {mode !== "none" ? <TextArea rows={2} placeholder="Feedback for the student on this question" disabled={locked} value={r.feedback ?? ""} onChange={(e) => set(q.id, null, { feedback: e.target.value })} /> : null}
          </div>
        </div>
        {q.children?.length ? <div className="mt-3 space-y-3 border-l-2 border-background-200 pl-4">{renderChildrenOf(q, scope, prefix)}</div> : null}
      </div>
    );
  };
  const renderChildrenOf = (q: Question, scope: Responses, prefix: string): ReactNode => {
    const v = scope[q.id];
    if (q.type === "repeating_group") return (Array.isArray(v) ? (v as Responses[]) : []).map((entry, i) => <div key={i} className="space-y-3"><p className="text-xs font-medium uppercase tracking-wide text-foreground-500">Entry {i + 1}</p>{(q.children ?? []).map((c) => renderQuestion(c, entry, `${prefix}${q.id}[${i}].`, null))}</div>);
    const obj = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Responses;
    return (q.children ?? []).map((c) => renderQuestion(c, obj, `${prefix}${q.id}.`, null));
  };

  const markable = definition.tasks.map((t) => ({ task: t, questions: t.sections.flatMap((s) => s.questions).filter((q) => isAnswerable(q) && (q.markingMode ?? "criteria") !== "none") })).filter((x) => x.questions.length);
  const allTasksDecided = markable.every((x) => tasks.get(x.task.id)?.outcome);
  const canReopen = attempt.attemptNo < maxAttempts;

  return (
    <div className="space-y-8">
      {definition.tasks.map((task, ti) => {
        let n = 0; const tr = tasks.get(task.id) ?? { taskId: task.id, outcome: null, feedback: "" }; const hasMarkable = markable.some((x) => x.task.id === task.id);
        return (
          <div key={task.id} className="space-y-4">
            <h2 className="font-heading text-lg font-bold text-foreground-950">Task {ti + 1}: {task.title}</h2>
            {task.sections.map((s) => (conditionMet(s.showIf, attempt.responses) ? <section key={s.id} className="space-y-3">{s.title ? <h3 className="font-heading text-base font-semibold text-foreground-900">{s.title}</h3> : null}{s.questions.map((q) => renderQuestion(q, attempt.responses, "", isAnswerable(q) ? `${ti + 1}.${++n}` : null))}</section> : null))}
            {hasMarkable ? (
              <div className="rounded-card border border-background-300 bg-background-100 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium text-foreground-900">Task {ti + 1} outcome</span>
                  <span className="text-xs text-foreground-600">Rollup suggests <Badge tone={tone(rollup.get(task.id))}>{rollup.get(task.id) ? OUTCOME_LABEL[rollup.get(task.id) as Outcome] : "not yet (save marks first)"}</Badge></span>
                  <OutcomePick name={`task-${task.id}`} value={tr.outcome} disabled={locked} onChange={(o) => setTasks((m) => new Map(m).set(task.id, { ...tr, outcome: o }))} />
                </div>
                <TextArea rows={2} className="mt-2" placeholder="Feedback on this task" disabled={locked} value={tr.feedback} onChange={(e) => setTasks((m) => new Map(m).set(task.id, { ...tr, feedback: e.target.value }))} />
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="rounded-card border border-background-200 bg-background-50 p-4">
        <h3 className="font-heading text-base font-semibold text-foreground-950">Overall feedback and decision</h3>
        <TextArea rows={3} className="mt-2" placeholder="Overall feedback for the student" disabled={locked} value={overall} onChange={(e) => setOverall(e.target.value)} />
        {!locked ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" icon="ri-save-line" disabled={busy} onClick={() => void onSave(payload())}>Save marks</Button>
            <span className="text-xs text-foreground-500">Saving does not decide; the decision below returns the attempt to the student.</span>
          </div>
        ) : null}
        {!locked ? (
          <div className="mt-4 rounded-md border border-background-300 p-3">
            <p className="text-sm font-medium text-foreground-900">Decision (attempt {attempt.attemptNo} of {maxAttempts})</p>
            {!allTasksDecided ? <p className="mt-1 text-xs text-primary-700">Record an outcome for every task first.</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-2"><OutcomePick name="decision" value={decision} onChange={setDecision} disabled={!allTasksDecided} /></div>
            {decision === "NYS" ? (
              <div className="mt-2 text-sm text-foreground-700">
                {canReopen ? <label className="block"><span className="mb-1 block text-xs text-foreground-600">Reassessment due (default: {reassessmentDays} days from now)</span><TextInput type="datetime-local" className="max-w-xs" value={dueLocal} onChange={(e) => setDueLocal(e.target.value)} /></label>
                  : <p className="text-primary-700">This is the last attempt: the result becomes final as Not Yet Satisfactory.</p>}
              </div>
            ) : null}
            <Button className="mt-3" icon="ri-send-plane-line" disabled={busy || !decision || !allTasksDecided} onClick={() => decision && void onReturn(decision, payload(), dueLocal || null)}>
              {decision === "S" ? "Return as Satisfactory" : decision === "NYS" ? (canReopen ? "Return for reassessment" : "Finalise as Not Yet Satisfactory") : "Choose a decision"}
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-foreground-700">Decided: <Badge tone={tone(attempt.outcome)}>{attempt.outcome ? OUTCOME_LABEL[attempt.outcome] : attempt.state}</Badge></p>
        )}
      </div>
    </div>
  );
}
