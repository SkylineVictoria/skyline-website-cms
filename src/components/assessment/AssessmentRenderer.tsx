import { useMemo, type ReactNode } from "react";
import { conditionMet } from "@/lib/assessment/conditions";
import { isAnswerable, isAssessorOnly, questionType } from "@/lib/assessment/registry";
import type { Definition, EvidenceFile, Question, Responses, Section, Task, ValidationError } from "@/lib/assessment/types";
import { typeUi } from "./registry";

export type RenderMode = "student" | "preview" | "review";

export interface RendererProps {
  definition: Definition;
  responses: Responses;
  onChange?: (responses: Responses) => void;
  mode: RenderMode;
  /** Review mode: what the assessor recorded (observation checklists, third-party reports). */
  assessorResponses?: Responses;
  evidence?: EvidenceFile[];
  onUpload?: (q: Question, files: FileList) => Promise<void>;
  onRemoveEvidence?: (file: EvidenceFile) => Promise<void>;
  openEvidence?: (file: EvidenceFile) => void;
  errors?: ValidationError[];
  declarationText?: string;
  /** Renders one task only (the student's step-by-step view). */
  taskId?: string;
  /** Extra content under a question (marking panels live here in the trainer view). */
  afterQuestion?: (q: Question, path: string) => ReactNode;
  disabled?: boolean;
}

/** Numbers questions 1.1, 1.2 … per task, in reading order; content blocks are unnumbered. */
function numbering(task: Task, taskIndex: number): Map<string, string> {
  const map = new Map<string, string>(); let n = 0;
  for (const s of task.sections) for (const q of s.questions) if (isAnswerable(q)) { n += 1; map.set(q.id, `${taskIndex + 1}.${n}`); }
  return map;
}

export default function AssessmentRenderer(props: RendererProps) {
  const { definition, responses, onChange, mode, assessorResponses = {}, evidence, onUpload, onRemoveEvidence, openEvidence, errors = [], declarationText, taskId, afterQuestion, disabled } = props;
  const errorByPath = useMemo(() => new Map(errors.map((e) => [e.questionId, e.message])), [errors]);
  const readOnly = mode === "review" || disabled;

  const renderQuestion = (q: Question, scope: Responses, setScope: (r: Responses) => void, path: string, number: string | null): ReactNode => {
    if (!conditionMet(q.showIf, scope)) return null;
    const type = questionType(q.type);
    const assessor = isAssessorOnly(q);
    const ui = typeUi(q.type);
    const value = assessor ? assessorResponses[q.id] : scope[q.id];
    const err = errorByPath.get(path + q.id);
    const content = type?.content || q.type === "instruction" || q.type === "content";
    const renderChildrenInput = (children: Question[], r: Responses, set: (nr: Responses) => void, prefix: string) => children.map((c) => renderQuestion(c, r, set, prefix, null));
    const renderChildrenView = (children: Question[], r: Responses, prefix: string) => children.map((c) => renderQuestion(c, r, () => undefined, prefix, null));
    let body: ReactNode;
    if (content) body = ui.Input({ q, value, onChange: () => undefined });
    else if (assessor && mode !== "review") body = (
      <p className="rounded-md bg-background-100 px-3 py-2 text-sm text-foreground-600"><i className="ri-eye-line mr-1.5 text-foreground-400" aria-hidden="true" />Completed by your assessor{type?.id === "observation_checklist" ? " during observation" : ""}.</p>
    );
    else if (readOnly) body = ui.View({ q, value, evidence, openEvidence, renderChildren: renderChildrenView });
    else body = ui.Input({ q, value, onChange: (v) => setScope({ ...scope, [q.id]: v }), disabled, evidence, onUpload, onRemoveEvidence, openEvidence, declarationText, renderChildren: renderChildrenInput });
    return (
      <div key={path + q.id} id={`q-${path}${q.id}`} className={`rounded-card border bg-background-50 p-4 ${err ? "border-primary-400" : "border-background-200"}`} data-question={q.id}>
        {!content ? (
          <div className="mb-2">
            <p className="text-sm font-medium text-foreground-950">{number ? <span className="mr-1.5 text-foreground-500">{number}</span> : null}{q.label}{q.required ? <span className="text-primary-600"> *</span> : null}{assessor ? <span className="ml-2 rounded bg-background-200 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-foreground-600">Assessor</span> : null}</p>
            {q.helpText ? <p className="mt-0.5 text-xs text-foreground-600">{q.helpText}</p> : null}
          </div>
        ) : null}
        {body}
        {err ? <p className="mt-2 text-xs font-medium text-primary-700" role="alert">{err}</p> : null}
        {afterQuestion?.(q, path)}
      </div>
    );
  };

  const renderSection = (task: Task, taskIndex: number, s: Section, numbers: Map<string, string>) => {
    if (!conditionMet(s.showIf, responses)) return null;
    return (
      <section key={s.id} className="space-y-3">
        {s.title ? <h3 className="font-heading text-base font-semibold text-foreground-900">{s.title}</h3> : null}
        {s.description ? <p className="text-sm text-foreground-600">{s.description}</p> : null}
        {s.questions.map((q) => renderQuestion(q, responses, (r) => onChange?.(r), "", numbers.get(q.id) ?? null))}
      </section>
    );
  };

  const tasks = taskId ? definition.tasks.filter((t) => t.id === taskId) : definition.tasks;
  return (
    <div className="space-y-8">
      {!taskId && definition.instructions ? <div className="rounded-card border border-background-200 bg-background-100 p-4 text-sm text-foreground-800 whitespace-pre-wrap">{definition.instructions}</div> : null}
      {tasks.map((task) => {
        const taskIndex = definition.tasks.findIndex((t) => t.id === task.id);
        const numbers = numbering(task, taskIndex);
        return (
          <div key={task.id} className="space-y-5">
            <div><h2 className="font-heading text-lg font-bold text-foreground-950">Task {taskIndex + 1}: {task.title}</h2>{task.instructions ? <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-700">{task.instructions}</p> : null}</div>
            {task.sections.map((s) => renderSection(task, taskIndex, s, numbers))}
          </div>
        );
      })}
    </div>
  );
}
