import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import SignatureField, { SignatureImage, type SignatureValue } from "@/components/assessment/SignatureField";
import { FitHint, PdfCrop, PdfPageImage } from "@/components/assessment/pdf/PdfView";
import QuestionView from "@/components/assessment/pdf/QuestionView";
import { usePdf, type PdfHandle } from "@/components/assessment/pdf/pdfDoc";
import { CARD, EYEBROW, FOCUS, PRIMARY, SECONDARY, STEP_IN, StickySlot, useAppHeaderOffset, useHeight } from "@/components/assessment/pdf/ui";
import { questionName, type AutoKey, type PdfTemplate, type TemplateField } from "@/lib/assessment/pdfTemplate/model";
import { fieldValue, missingItems, questionInputs, studentFields, wizardSteps, type FitBox, type Missing, type PdfAnswers, type Table, type WizardStep } from "@/lib/assessment/pdfTemplate/student";
import { mySignature } from "@/lib/assessment/api";
import type { PdfSignature } from "@/lib/assessment/pdfTemplate/api";
import type { Responses } from "@/lib/assessment/types";

/**
 * ASM-PDF-TEMPLATE phase 2 (owner 2026-11-26), redesigned by ASM-QUESTION-TEXT (owner 2026-11-27): the student answers on the workbook
 * itself. Per task: its instruction pages (as page images), one step per question (the question as printed or as text, its pictures,
 * "Open full page"; then its answer boxes / tables), the task's declaration; Appendix B (optional); review & submit.
 * Only the student's fields; the record's shown read-only where they help; never the trainer's fields or the result
 * acknowledgement. Every change is autosaved (draft_save); a one-line hint says when an answer is longer than its box on the page.
 * The top bar shows the task, step X of Y and the progress; the side list (a drawer behind "Questions" on a phone) groups the steps
 * by task with their status. Preview as learner uses the same wizard.
 * ASM-QUESTION-POLISH (owner 2026-11-27): one scroll (the page; only the side list scrolls on its own, when taller than the screen);
 * the top bar sticks under the portal's own header; the question stays in view while the answers scroll (QuestionView); a progress
 * bar in task segments; steps fade in; a finished state ("All questions answered — review and submit") and an empty state.
 */
/** The returned attempt this one follows: its marks and comments, shown next to the questions. */
export interface PreviousAttempt { attemptNo: number; overallFeedback: string; marks: Record<string, { outcome: "S" | "NYS" | null; feedback: string }> }
export interface PdfRecord { studentName: string; studentRef: string; studentEmail: string; trainer: string; unitCode: string; unitName: string; qualificationCode: string; qualificationName: string }

const INPUT = "w-full rounded-xl border border-background-300 bg-white px-3.5 py-2.5 text-base leading-7 text-foreground-900 shadow-[inset_0_1px_2px_rgba(16,24,40,0.04)] transition-[border-color,box-shadow] placeholder:text-foreground-400 hover:border-background-400 focus:border-primary-500 focus:outline-none focus:ring-4 focus:ring-primary-100";
const RATINGS = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];

type StepStatus = "done" | "partly" | "todo" | "info";
type Group = { task: number | null; items: { s: WizardStep; i: number }[] };
/** The steps in runs: before the tasks, each task, after them. */
function groupSteps(steps: WizardStep[]): Group[] {
  const groups: Group[] = [];
  steps.forEach((s, i) => {
    const task = (s.kind === "read" || s.kind === "question" || s.kind === "declaration") ? s.task : null;
    const last = groups[groups.length - 1];
    if (last && last.task === task) last.items.push({ s, i }); else groups.push({ task, items: [{ s, i }] });
  });
  return groups;
}

export default function PdfWizard({ template, pdfBytes, responses, onChange, savedLabel, saveClass, saveAction = null, record, signatures, onSign, onSubmit, busy, serverErrors, dueLabel, previous = null }: {
  template: PdfTemplate; pdfBytes: Uint8Array | null; responses: Responses; onChange: (r: Responses) => void; savedLabel: string;
  /** The save indicator's colour (green saved, amber offline, red not saved) and, when signed out, its Sign in again button. */
  saveClass: string; saveAction?: ReactNode;
  record: PdfRecord; signatures: PdfSignature[];
  /** Signs one declaration: v null = with the saved signature (one tap). */
  onSign: (slot: string, v: SignatureValue | null, statement: string) => Promise<void>;
  previous?: PreviousAttempt | null;
  onSubmit: () => Promise<void>; busy: boolean; serverErrors: string[]; dueLabel: string;
}) {
  const { pdf, error } = usePdf(pdfBytes);
  const steps = useMemo(() => wizardSteps(template), [template]);
  const groups = useMemo(() => groupSteps(steps), [steps]);
  const [params, setParams] = useSearchParams();
  const index = Math.max(0, steps.findIndex((s) => s.id === params.get("step")));
  const step = steps[index];
  const [drawer, setDrawer] = useState(false);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const appTop = useAppHeaderOffset(root);
  const barH = useHeight(bar);
  const go = (i: number) => {
    const next = new URLSearchParams(params); next.set("step", steps[Math.max(0, Math.min(steps.length - 1, i))].id); setParams(next, { replace: false }); setDrawer(false);
    window.scrollTo({ top: 0 }); root?.closest(".overflow-y-auto")?.scrollTo({ top: 0 });
  };
  const a = responses as PdfAnswers;
  const signed = useMemo(() => signatures.map((x) => x.slot), [signatures]);
  const missing = useMemo(() => missingItems(template, a, signed), [template, a, signed]);
  const statusOf = (s: WizardStep): StepStatus => {
    if (s.kind === "question") {
      if (!studentFields(template).some((f) => f.questionKey === s.key && f.role === "student")) return "info";
      const mine = missing.filter((m) => m.questionKey === s.key);
      return !mine.length ? "done" : mine.some((m) => m.code === "unanswered") ? "todo" : "partly";
    }
    if (s.kind === "declaration") return signed.includes(`decl:${s.task}`) ? "done" : "todo";
    return "info";
  };

  const set = (patch: PdfAnswers) => onChange({ ...responses, ...patch } as Responses);
  const setValue = (f: TemplateField, v: string) => set({ pdf: { ...(a.pdf ?? {}), [f.id]: v } });
  const setChoice = (group: string, option: string) => set({ pdfChoice: { ...(a.pdfChoice ?? {}), [group]: option } });
  const recordValue = (f: TemplateField): string => {
    const k = f.dataKey as AutoKey | undefined;
    const today = new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
    const v: Partial<Record<AutoKey, string>> = { student_name: record.studentName, student_id: record.studentRef, student_email: record.studentEmail, trainer_name: record.trainer,
      unit_code: record.unitCode, unit_name: record.unitName, unit_code_name: `${record.unitCode} ${record.unitName}`.trim(), qualification_code: record.qualificationCode,
      qualification_name: record.qualificationName, submission_date: "Added when you submit", today, submission_method: f.option === "lms" ? "✓ Online via LMS" : "" };
    return (k && v[k]) || "";
  };
  const stepOfMissing = (m: Missing): number => {
    if (m.questionKey) return steps.findIndex((s) => s.kind === "question" && s.key === m.questionKey);
    if (m.code === "declaration") return steps.findIndex((s) => s.kind === "declaration" && s.task === m.task);
    if (m.code === "signature") return steps.findIndex((s) => s.kind === "review");
    return 0;
  };
  const taskOfStep = "task" in step && step.task != null ? template.tasks.find((t) => Number(t.number) === step.task) : undefined;
  const topTitle = taskOfStep ? `Task ${taskOfStep.number} · ${taskOfStep.title}` : `${record.unitCode}${record.unitCode ? " · " : ""}${record.unitName}`;
  const saveStatus = <p className={`text-sm font-medium ${saveClass}`} role="status" data-testid="autosave">{savedLabel || dueLabel}</p>;
  const list = <StepList groups={groups} steps={steps} template={template} index={index} statusOf={statusOf} go={go} />;
  const qTop = appTop + barH;

  useEffect(() => {
    if (!drawer) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setDrawer(false); } };
    window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true);
  }, [drawer]);

  return <StickySlot.Provider value={{ el: slotEl, top: qTop }}>
    <div ref={setRoot} className="mx-auto max-w-6xl pb-6" data-testid="pdf-wizard">
      <div ref={setBar} className="sticky z-30 -mx-4 mb-5 border-b border-background-200/80 bg-white/90 px-4 pb-3 pt-2.5 shadow-[0_4px_16px_-12px_rgba(16,24,40,0.25)] backdrop-blur-md sm:-mx-6 sm:px-6" style={{ top: appTop }}>
        <div className="flex min-h-[44px] items-center gap-2">
          <button type="button" onClick={() => setDrawer(true)} className={`inline-flex min-h-[44px] shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-white px-3 text-sm font-semibold text-foreground-800 ring-1 ring-foreground-950/10 lg:hidden ${FOCUS}`} aria-haspopup="dialog" aria-expanded={drawer} data-testid="questions-button">
            <i className="ri-list-check-2 text-base" aria-hidden="true" />Questions</button>
          <p className="min-w-0 flex-1 truncate font-heading text-sm font-semibold text-foreground-950 sm:text-base" data-testid="wizard-task">{topTitle}</p>
          {step.kind !== "question" ? <div className="hidden shrink-0 items-center gap-2 sm:flex">{saveStatus}{saveAction}</div> : null}
          <span className="shrink-0 rounded-full bg-background-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-foreground-700" data-testid="wizard-step-count">Step {index + 1} of {steps.length}</span>
        </div>
        <SegmentedProgress groups={groups} template={template} index={index} total={steps.length} statusOf={statusOf} />
        {/* the question's compact bar on a phone (QuestionView), just under this bar */}
        <div ref={setSlotEl} className="absolute inset-x-0 top-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[272px_minmax(0,1fr)]">
        <nav aria-label="Questions" className="hidden lg:block">
          <div className="sticky overflow-y-auto overscroll-contain pb-2 pr-1" style={{ top: qTop + 16, maxHeight: `calc(100vh - ${qTop + 32}px)` }} data-testid="wizard-side">{list}</div>
        </nav>
        {drawer ? <div className="fixed inset-0 z-[85] flex lg:hidden" role="dialog" aria-modal="true" aria-label="Questions" data-testid="questions-drawer">
          <div className="absolute inset-0 bg-foreground-950/50 motion-safe:animate-fade-in" onClick={() => setDrawer(false)} />
          <div className="relative flex h-full w-[86vw] max-w-sm flex-col bg-white shadow-2xl motion-safe:animate-step-in">
            <div className="flex items-center justify-between border-b border-background-200 px-4 py-2"><p className="font-heading text-lg font-semibold text-foreground-950">Questions</p>
              <button type="button" className={`min-h-[44px] min-w-[44px] rounded-md hover:bg-background-100 ${FOCUS}`} onClick={() => setDrawer(false)} aria-label="Close"><i className="ri-close-line text-2xl" aria-hidden="true" /></button></div>
            <div className="flex-1 overflow-y-auto px-2 py-2">{list}</div>
          </div>
        </div> : null}
        <main className="min-w-0 space-y-5">
          {error ? <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">{error}</p> : null}
          {!pdf && !error ? <div role="status" className={`${CARD} space-y-3`} aria-label="Opening your workbook"><p className="text-base text-foreground-600">Opening your workbook…</p>
            <div className="h-4 w-10/12 animate-pulse rounded-full bg-background-200" /><div className="h-4 w-7/12 animate-pulse rounded-full bg-background-200" /></div> : null}
          {pdf ? <div key={step.id} className={STEP_IN}>
            <StepView step={step} template={template} pdf={pdf} a={a} record={record} recordValue={recordValue} setValue={setValue} setChoice={setChoice}
              signatures={signatures} onSign={onSign} previous={previous} saveStatus={<div className="flex items-center gap-2">{saveStatus}{saveAction}</div>}
              missing={missing} goMissing={(m) => go(stepOfMissing(m))} onSubmit={onSubmit} busy={busy} serverErrors={serverErrors}
              status={statusOf(step)} position={positionOf(steps, template, step)} groups={groups} statusOf={statusOf} go={go} />
          </div> : null}
          <div className="sticky bottom-0 z-20 -mx-4 flex items-center justify-between gap-3 border-t border-background-200/80 bg-white/90 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0 lg:py-1 lg:backdrop-blur-none">
            <button type="button" className={SECONDARY} disabled={index === 0} onClick={() => go(index - 1)} data-testid="wizard-back"><i className="ri-arrow-left-line" aria-hidden="true" />Back</button>
            {index < steps.length - 1 ? <button type="button" className={PRIMARY} onClick={() => go(index + 1)} data-testid="wizard-next">{steps[index + 1].kind === "review" ? "Review & submit" : "Next"}<i className="ri-arrow-right-line" aria-hidden="true" /></button> : null}
          </div>
        </main>
      </div>
    </div>
  </StickySlot.Provider>;
}

/** "Question 2 of 3" within its task. */
function positionOf(steps: WizardStep[], template: PdfTemplate, step: WizardStep): string {
  if (step.kind !== "question") return "";
  const inTask = template.questions.filter((q) => q.task === step.task);
  const n = inTask.findIndex((q) => q.key === step.key);
  return n >= 0 ? `Question ${n + 1} of ${inTask.length}` : "";
}

/** The progress in segments: one per task (sized by its steps), filled as its questions are answered; the current one outlined. */
function SegmentedProgress({ groups, template, index, total, statusOf }: { groups: Group[]; template: PdfTemplate; index: number; total: number; statusOf: (s: WizardStep) => StepStatus }) {
  return <div className="mt-2" data-testid="wizard-progress-wrap">
    <div className="flex items-center gap-1" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={index + 1} aria-label="Progress" data-testid="wizard-progress">
      {groups.map((g, gi) => {
        const done = g.items.filter(({ s, i }) => { const st = statusOf(s); return st === "done" || (st === "info" && i <= index); }).length;
        const here = g.items.some(({ i }) => i === index);
        const t = g.task != null ? template.tasks.find((x) => Number(x.number) === g.task) : null;
        const label = t ? `Task ${t.number}` : gi === 0 ? "Start" : "Finish";
        return <div key={gi} className="min-w-[14px] basis-0" style={{ flexGrow: g.items.length }} title={`${label}: ${done} of ${g.items.length} done`} data-testid="progress-segment" data-current={here || undefined}>
          <div className={`h-2 overflow-hidden rounded-full ${here ? "bg-primary-100 ring-1 ring-primary-300" : "bg-background-200"}`}>
            <div className="h-full rounded-full bg-gradient-to-r from-primary-500 to-primary-600 transition-[width] duration-500 ease-out" style={{ width: `${(done / g.items.length) * 100}%` }} />
          </div>
          {t ? <p className={`mt-1 hidden truncate text-2xs sm:block ${here ? "font-semibold text-primary-800" : "text-foreground-500"}`}>{label}</p> : null}
        </div>;
      })}
    </div>
  </div>;
}

/** The steps, grouped by task (collapsible; the current task open), with their status: ✓ done, • something required missing, ○ not started. */
function StepList({ groups, steps, template, index, statusOf, go }: { groups: Group[]; steps: WizardStep[]; template: PdfTemplate; index: number; statusOf: (s: WizardStep) => StepStatus; go: (i: number) => void }) {
  const current = steps[index];
  const currentTask = "task" in current ? current.task : null;
  const [open, setOpen] = useState<Set<number>>(() => new Set(currentTask != null ? [currentTask] : []));
  useEffect(() => { if (currentTask != null) setOpen((o) => (o.has(currentTask) ? o : new Set([...o, currentTask]))); }, [currentTask]);
  const row = ({ s, i }: { s: WizardStep; i: number }) => {
    const st = statusOf(s);
    const q = s.kind === "question" ? template.questions.find((x) => x.key === s.key) : null;
    const icon = st === "done" ? "ri-checkbox-circle-fill text-green-600" : st === "partly" ? "ri-contrast-fill text-amber-500" : st === "todo" ? "ri-circle-line text-foreground-300"
      : s.kind === "read" ? "ri-book-open-line text-foreground-400" : s.kind === "review" ? "ri-send-plane-line text-foreground-400" : s.kind === "evaluation" ? "ri-chat-smile-2-line text-foreground-400" : "ri-user-line text-foreground-400";
    const name = s.kind === "question" ? s.title : s.kind === "read" ? s.title.split(" · ")[1] : s.title.replace(/^Task \d+ · /, "");
    const here = i === index;
    return <li key={s.id}>
      <button type="button" onClick={() => go(i)} aria-current={here ? "step" : undefined} data-status={st}
        className={`relative flex min-h-[40px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${FOCUS} ${here ? "bg-primary-50 font-semibold text-primary-900" : "text-foreground-800 hover:bg-background-100"}`}>
        {here ? <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary-600" aria-hidden="true" /> : null}
        <span className="flex w-4 shrink-0 justify-center"><i className={`${icon} text-base leading-none`} aria-hidden="true" /></span>
        <span className="shrink-0">{name}</span>
        {q?.label && q.label !== name ? <span className={`min-w-0 truncate ${here ? "font-normal text-primary-800/80" : "text-foreground-500"}`}>{q.label}</span> : null}
        <span className="sr-only">{st === "done" ? "(done)" : st === "partly" ? "(something required is missing)" : st === "todo" ? "(not started)" : ""}</span>
      </button>
    </li>;
  };
  return <div data-testid="wizard-steps" className="space-y-1">
    {groups.map((g, gi) => {
      if (g.task == null) return <ul key={gi} className="space-y-0.5">{g.items.map(row)}</ul>;
      const t = template.tasks.find((x) => Number(x.number) === g.task);
      const qs = g.items.filter((x) => x.s.kind === "question" && statusOf(x.s) !== "info");
      const done = qs.filter((x) => statusOf(x.s) === "done").length;
      const isOpen = open.has(g.task);
      const all = qs.length > 0 && done === qs.length;
      return <div key={gi} className="pt-1.5">
        <button type="button" onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(g.task!)) n.delete(g.task!); else n.add(g.task!); return n; })} aria-expanded={isOpen}
          className={`flex min-h-[40px] w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left ${FOCUS} hover:bg-background-100`} data-testid="task-group">
          <i className={`ri-arrow-right-s-line text-base text-foreground-500 transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-[0.06em] text-foreground-600">Task {t?.number ?? g.task}{t?.title ? ` · ${t.title}` : ""}</span>
          {qs.length ? <span className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${all ? "bg-green-100 text-green-800" : "bg-background-100 text-foreground-600"}`}>{all ? <i className="ri-check-line" aria-hidden="true" /> : null}{done}/{qs.length}</span> : null}
        </button>
        {isOpen ? <ul className="mt-0.5 space-y-0.5 pl-2">{g.items.map(row)}</ul> : null}
      </div>;
    })}
  </div>;
}

/** A text box that grows with what is typed (no inner scroll bar). */
function GrowArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const el = ref.current; if (!el) return; el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; }, [props.value]);
  return <textarea ref={ref} {...props} className={`${props.className ?? ""} resize-none overflow-hidden`} />;
}

/** A text answer: grows with what is typed, counts words, says in one grey line when it is longer than its box on the page. */
function AnswerText({ id, label, value, onChange, required, boxes, minRows }: { id: string; label: string; value: string; onChange: (v: string) => void; required?: boolean; boxes: FitBox[]; minRows: number }) {
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return <div className="space-y-1.5" data-field={id}>
    <label className="block text-base font-semibold text-foreground-900" htmlFor={`f-${id}`}>{label}{required ? <span className="ml-1 text-red-700" aria-hidden="true">*</span> : null}</label>
    <GrowArea id={`f-${id}`} className={INPUT} rows={minRows} value={value} onChange={(e) => onChange(e.target.value)} aria-required={required || undefined} data-testid="answer-text" />
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
      <FitHint text={value} boxes={boxes} />
      {minRows > 1 ? <span className="ml-auto shrink-0 text-xs text-foreground-500" data-testid="word-count">{words} word{words === 1 ? "" : "s"}</span> : null}
    </div>
  </div>;
}

function StepView({ step, template, pdf, a, record, recordValue, setValue, setChoice, signatures, onSign, missing, goMissing, onSubmit, busy, serverErrors, previous, saveStatus, status, position, groups, statusOf, go }: {
  step: WizardStep; template: PdfTemplate; pdf: PdfHandle; a: PdfAnswers; record: PdfRecord; recordValue: (f: TemplateField) => string;
  setValue: (f: TemplateField, v: string) => void; setChoice: (g: string, o: string) => void;
  signatures: PdfSignature[]; onSign: (slot: string, v: SignatureValue | null, statement: string) => Promise<void>; previous: PreviousAttempt | null;
  missing: Missing[]; goMissing: (m: Missing) => void; onSubmit: () => Promise<void>; busy: boolean; serverErrors: string[]; saveStatus: ReactNode;
  status: StepStatus; position: string; groups: Group[]; statusOf: (s: WizardStep) => StepStatus; go: (i: number) => void;
}) {
  const taskTitle = (n: number | null) => { const t = template.tasks.find((x) => Number(x.number) === n); return t ? `Task ${t.number} · ${t.title}` : ""; };
  const boxesOf = (fs: TemplateField[]): FitBox[] => fs.map((f) => { const s = pdf.sizes[f.page - 1] ?? { w: 595, h: 842 }; return { page: f.page, wPt: f.w * s.w, hPt: f.h * s.h }; });

  if (step.kind === "details") {
    const rows: [string, string][] = [["Student name", record.studentName], ["Student ID", record.studentRef], ["Email", record.studentEmail], ["Unit", `${record.unitCode} ${record.unitName}`.trim()],
      ["Qualification", `${record.qualificationCode} ${record.qualificationName}`.trim()], ["Trainer / assessor", record.trainer]];
    return <section className={CARD} data-testid="step-details">
      <p className={EYEBROW}>Getting started</p><h1 className="mt-1 font-heading text-2xl font-bold tracking-tight text-foreground-950">Your details</h1>
      {previous ? <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="resubmission">
        <p className="font-semibold">Attempt {previous.attemptNo + 1}: your answers from attempt {previous.attemptNo} are filled in.</p>
        <p className="mt-1">Change what your trainer marked as not yet satisfactory, sign the declarations again and submit.{previous.overallFeedback ? <> Trainer's feedback: <span className="italic">{previous.overallFeedback}</span></> : null}</p>
      </div> : null}
      <p className="mt-1 text-base text-foreground-600">These come from your enrolment and are printed on your workbook for you. Ask your trainer if something is wrong.</p>
      <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2" data-testid="record-fields">
        {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt className="text-xs font-medium text-foreground-500">{k}</dt><dd className="mt-0.5 rounded-lg bg-background-100 px-3 py-2 text-base text-foreground-900">{v}</dd></div>)}
      </dl>
      <ul className="mt-5 space-y-1 text-base text-foreground-700">
        {template.tasks.map((t) => <li key={t.number}><span className="font-semibold">Task {t.number}</span> · {t.title} · {template.questions.filter((q) => q.task === Number(t.number)).length} questions</li>)}
      </ul>
    </section>;
  }

  if (step.kind === "read") return <section className="space-y-3" data-testid="step-read">
    <div className={CARD}><p className={EYEBROW}>Before the questions</p><h1 className="mt-1 font-heading text-xl font-bold tracking-tight text-foreground-950">Read {step.pages.length === 1 ? "this page" : `these ${step.pages.length} pages`} first</h1>
      <p className="mt-1 text-base text-foreground-600">Pages {step.pages[0]}{step.pages.length > 1 ? `–${step.pages[step.pages.length - 1]}` : ""} of your workbook, as printed.</p></div>
    {step.pages.map((p) => <PdfPageImage key={p} pdf={pdf} page={p} />)}
  </section>;

  if (step.kind === "question") {
    const q = template.questions.find((x) => x.key === step.key)!;
    const inputs = questionInputs(template, q.key);
    const choiceGroups = new Set<string>();
    const tableCount = inputs.filter((x) => x.kind === "table").length;
    const texts = inputs.filter((x) => x.kind === "text").length;
    let tableNo = 0;
    const prev = previous?.marks[q.key];
    return <section className="space-y-5" data-testid="step-question" data-question-key={q.key}>
      <QuestionView pdf={pdf} template={template} question={q} who="student"
        eyebrow={<p className={EYEBROW}>{taskTitle(step.task).replace(/ · .*/, "")}{position ? ` · ${position}` : ""}</p>} status={<StatusChip status={status} />}>
        {prev?.outcome ? <p className={`rounded-xl px-3 py-2 text-base ${prev.outcome === "NYS" ? "border border-amber-300 bg-amber-50 text-amber-900" : "border border-green-200 bg-green-50 text-green-800"}`} data-testid="previous-mark">
          {prev.outcome === "NYS" ? `Not yet satisfactory in attempt ${previous!.attemptNo}` : `Satisfactory in attempt ${previous!.attemptNo}`}{prev.feedback ? `: ${prev.feedback}` : "."}</p> : null}
      </QuestionView>
      <div className={`${CARD} space-y-6`} data-testid="answer-card">
        {inputs.map((inp) => {
          if (inp.kind === "table") return <TableInput key={inp.table.id} heading={tableCount > 1 ? `Table ${++tableNo} of ${tableCount}` : null} table={inp.table} a={a} setValue={setValue} boxesOf={boxesOf} />;
          const f = inp.field;
          if (inp.kind === "text") {
            const v = fieldValue(a, f);
            // the box's own label, unless it only repeats "Answer" or the question's name (the heading says that once)
            const generic = f.label === "Answer" || f.label.trim() === questionName(q) || f.label.trim() === q.label.trim();
            const label = !generic ? f.label : f.page !== q.header.page && texts > 1 ? `Your answer (page ${f.page})` : "Your answer";
            const hPt = inp.boxes.reduce((s, b) => s + b.h * (pdf.sizes[b.page - 1]?.h ?? 842), 0);
            const lines = hPt < 34 && inp.boxes.length === 1 && f.label !== "Answer" && !generic ? 1 : Math.min(10, Math.max(4, Math.round(hPt / 28)));
            return <AnswerText key={f.id} id={f.id} label={label} value={v} onChange={(x) => setValue(f, x)} required={f.required} boxes={boxesOf(inp.boxes)} minRows={lines} />;
          }
          if (f.role === "auto") return <ReadOnly key={f.id} label={f.label} value={recordValue(f)} />;
          if ((f.kind === "yes_no" || f.kind === "rating") && f.group) {
            if (choiceGroups.has(f.group)) return null;
            choiceGroups.add(f.group);
            const opts = inputs.filter((x): x is { kind: "field"; field: TemplateField } => x.kind === "field" && x.field.group === f.group).map((x) => x.field);
            return <fieldset key={f.group}><legend className="text-base font-semibold text-foreground-900">{f.label}</legend>
              <div className="mt-2 flex flex-wrap gap-2">{opts.map((o) => { const on = a.pdfChoice?.[f.group!] === o.option; return <label key={o.id} className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-4 text-base ${on ? "border-primary-500 bg-primary-50 font-semibold text-primary-800" : "border-background-300 text-foreground-800 hover:bg-background-50"}`}>
                <input type="radio" className="h-4 w-4 accent-primary-600" name={f.group!} checked={on} onChange={() => setChoice(f.group!, o.option ?? "")} />{o.option}</label>; })}</div></fieldset>;
          }
          if (f.kind === "checkbox") return <label key={f.id} className="flex min-h-[44px] items-center gap-3 text-base"><input type="checkbox" className="h-5 w-5 accent-primary-600" checked={fieldValue(a, f) === "true"} onChange={(e) => setValue(f, e.target.checked ? "true" : "")} />{f.label}</label>;
          return <div key={f.id} data-field={f.id}><label className="block text-base font-semibold text-foreground-900" htmlFor={`f-${f.id}`}>{f.label}{f.required ? <span className="ml-1 text-red-700" aria-hidden="true">*</span> : null}</label>
            <input id={`f-${f.id}`} type={f.kind === "date" ? "date" : "text"} className={`${INPUT} mt-1.5`} value={fieldValue(a, f)} onChange={(e) => setValue(f, e.target.value)} data-testid="answer-line" /></div>;
        })}
        {!inputs.length ? <div className="flex items-start gap-3 rounded-xl bg-background-50 p-4" data-testid="nothing-to-answer">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-xl text-primary-600 ring-1 ring-foreground-950/[0.06]"><i className="ri-book-read-line" aria-hidden="true" /></span>
          <div><p className="font-semibold text-foreground-900">Nothing to write for this one</p><p className="text-sm text-foreground-600">Read the question, then continue with Next.</p></div></div> : null}
        <div className="flex justify-end border-t border-background-100 pt-3">{saveStatus}</div>
      </div>
    </section>;
  }

  if (step.kind === "declaration") {
    const decl = template.declarations?.find((d) => d.page === step.page);
    const slot = `decl:${step.task}`;
    const mine = signatures.find((x) => x.slot === slot) ?? null;
    return <section className="space-y-4" data-testid="step-declaration">
      <div className={CARD}><p className={EYEBROW}>{taskTitle(step.task)}</p>
        <h1 className="mt-1 font-heading text-2xl font-bold tracking-tight text-foreground-950">Task {step.task} declaration</h1>
        <p className="mt-1 text-base text-foreground-600">Read the declaration as printed, then sign it.</p></div>
      {decl ? <PdfCrop pdf={pdf} rect={decl.rect} label={`The Task ${step.task} declaration as printed on page ${step.page}`} /> : <PdfPageImage pdf={pdf} page={step.page} />}
      <div className={`${CARD} space-y-4`}>
        <div className="grid gap-3 sm:grid-cols-2"><ReadOnly label="Student name" value={record.studentName} /><ReadOnly label="Date" value={mine ? fmtDay(mine.signedAt) : "The day you sign"} /></div>
        <DeclSign slot={slot} signed={mine} onSign={(v) => onSign(slot, v, decl?.text ?? "")} where={`page ${step.page}`} />
      </div>
    </section>;
  }

  if (step.kind === "evaluation") return <Evaluation template={template} pdf={pdf} pages={step.pages} a={a} setValue={setValue} setChoice={setChoice} recordValue={recordValue} />;

  // review & submit
  const total = template.questions.filter((q) => studentFields(template).some((f) => f.questionKey === q.key && f.role === "student")).length;
  const unanswered = missing.filter((m) => m.code === "unanswered").length;
  const pack = studentFields(template).find((f) => f.kind === "signature" && f.slot === "pack");
  const packDecl = template.declarations?.find((d) => d.kind === "pack");
  const allAnswered = unanswered === 0 && !missing.some((m) => m.questionKey);
  const pct = total ? Math.round(((total - unanswered) / total) * 100) : 100;
  const taskRows = groups.filter((g) => g.task != null).map((g) => {
    const t = template.tasks.find((x) => Number(x.number) === g.task);
    const qs = g.items.filter((x) => x.s.kind === "question" && statusOf(x.s) !== "info");
    const decl = g.items.find((x) => x.s.kind === "declaration");
    return { g, t, done: qs.filter((x) => statusOf(x.s) === "done").length, count: qs.length, declSigned: decl ? statusOf(decl.s) === "done" : null, first: g.items.find((x) => x.s.kind === "question" && statusOf(x.s) !== "done")?.i ?? g.items[0].i };
  });
  return <section className="space-y-4" data-testid="step-review">
    {allAnswered ? <div className={`${CARD} relative overflow-hidden text-center`} data-testid={missing.length ? "review-answered" : "review-ready"}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-green-50 to-transparent" aria-hidden="true" />
      <span className="relative mx-auto grid h-16 w-16 place-items-center rounded-full bg-green-100 text-3xl text-green-700 ring-8 ring-green-50 motion-safe:animate-step-in"><i className="ri-check-double-line" aria-hidden="true" /></span>
      <h1 className="relative mt-4 font-heading text-2xl font-bold tracking-tight text-foreground-950">All questions answered — review and submit</h1>
      <p className="relative mx-auto mt-1.5 max-w-prose text-base text-foreground-600">{missing.length
        ? `Nicely done: all ${total} questions are answered. ${missing.length === 1 ? "One thing is" : `${missing.length} things are`} left before you can submit.`
        : `Nicely done: all ${total} questions are answered and everything is signed. Look back over any answer from the list, then submit.`}</p>
    </div> : <div className={CARD}>
      <p className={EYEBROW}>Almost there</p>
      <h1 className="mt-1 font-heading text-2xl font-bold tracking-tight text-foreground-950">Review &amp; submit</h1>
      <div className="mt-3 flex items-center gap-3"><div className="h-2 flex-1 overflow-hidden rounded-full bg-background-200"><div className="h-full rounded-full bg-gradient-to-r from-primary-500 to-primary-600" style={{ width: `${pct}%` }} /></div>
        <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground-700">{total - unanswered} of {total} questions answered</p></div>
    </div>}
    <div className={`${CARD} space-y-4`}>
      <ul className="divide-y divide-background-100" data-testid="review-tasks">{taskRows.map(({ g, t, done, count, declSigned, first }) => <li key={g.task}>
        <button type="button" onClick={() => go(first)} className={`flex min-h-[52px] w-full cursor-pointer items-center gap-3 rounded-lg px-1 py-2 text-left hover:bg-background-50 ${FOCUS}`}>
          <i className={`text-xl ${done === count && declSigned !== false ? "ri-checkbox-circle-fill text-green-600" : "ri-progress-4-line text-amber-500"}`} aria-hidden="true" />
          <span className="min-w-0 flex-1"><span className="block truncate font-semibold text-foreground-900">Task {t?.number ?? g.task}{t?.title ? ` · ${t.title}` : ""}</span>
            <span className="block text-sm text-foreground-600">{done} of {count} answered{declSigned === null ? "" : declSigned ? " · declaration signed" : " · declaration not signed yet"}</span></span>
          <i className="ri-arrow-right-s-line text-xl text-foreground-400" aria-hidden="true" />
        </button></li>)}</ul>
      {missing.length ? <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5" data-testid="review-missing">
        <p className="text-sm font-semibold text-amber-900">Before you can submit ({missing.length}):</p>
        <ul className="mt-2 space-y-1.5">{missing.map((m, i) => <li key={i} className="flex gap-2"><i className="ri-arrow-right-up-line mt-0.5 text-amber-600" aria-hidden="true" /><button type="button" className="cursor-pointer text-left text-sm text-amber-900 underline decoration-amber-300 underline-offset-2 hover:text-amber-950" onClick={() => goMissing(m)} data-testid="missing-item">{m.message}</button></li>)}</ul>
      </div> : null}
    {pack ? <div className="space-y-3 border-t border-background-200 pt-4" data-testid="pack-declaration">
      <h2 className="font-heading text-lg font-semibold text-foreground-950">Student declaration</h2>
      <p className="text-sm text-foreground-600">The declaration for the whole workbook, as printed on page{packDecl?.rects && packDecl.rects.length > 1 ? "s" : ""} {(packDecl?.rects ?? []).map((r) => r.page).join(" and ") || pack.page}. Sign it when you submit.</p>
      {(packDecl?.rects ?? []).map((r) => <PdfCrop key={r.page} pdf={pdf} rect={r} label={`The student declaration on page ${r.page}`} />)}
      <DeclSign slot="pack" signed={signatures.find((x) => x.slot === "pack") ?? null} onSign={(v) => onSign("pack", v, packDecl?.text ?? "")} where={`page ${pack.page}`} />
    </div> : null}
    {serverErrors.length ? <ul role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{serverErrors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
    <div className="flex flex-col-reverse items-stretch gap-3 border-t border-background-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-foreground-600">When you submit, your answers are locked and you get a receipt number. The learner evaluation is optional.</p>
      <button type="button" className={`${PRIMARY} shrink-0`} disabled={busy || missing.length > 0} onClick={() => void onSubmit()} data-testid="submit"><i className="ri-send-plane-fill" aria-hidden="true" />{busy ? "Submitting…" : "Submit for marking"}</button>
    </div>
    </div>
  </section>;
}

/** Answered / partly / not yet, beside the question's position. */
function StatusChip({ status }: { status: StepStatus }) {
  if (status === "info") return null;
  const [cls, icon, text] = status === "done" ? ["bg-green-50 text-green-800 ring-green-200", "ri-check-line", "Answered"]
    : status === "partly" ? ["bg-amber-50 text-amber-900 ring-amber-200", "ri-contrast-fill", "Partly answered"] : ["bg-background-100 text-foreground-600 ring-foreground-950/[0.06]", "ri-circle-line", "Not answered yet"];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`} data-testid="question-status" data-status={status}><i className={icon} aria-hidden="true" />{text}</span>;
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-medium text-foreground-500">{label}</p><p className="mt-0.5 rounded-lg bg-background-100 px-3 py-2 text-sm text-foreground-900" data-testid="record-value">{value || "—"}</p></div>;
}

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });

/**
 * One declaration's signature: signed (who, when); else one tap with the student's saved signature; the first time, drawn once
 * (kept as their saved signature for the next declarations).
 */
function DeclSign({ slot, signed, onSign, where }: { slot: string; signed: PdfSignature | null; onSign: (v: SignatureValue | null) => Promise<void>; where: string }) {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [value, setValue] = useState<SignatureValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { let off = false; void mySignature().then((s) => { if (!off) setSaved(s.signaturePng); }); return () => { off = true; }; }, [signed]);
  const sign = (v: SignatureValue | null) => { setBusy(true); setErr(""); void onSign(v).catch((e) => setErr(e instanceof Error ? e.message : "Not signed.")).finally(() => setBusy(false)); };
  if (signed) return <div className="rounded-xl border border-green-200 bg-green-50 p-3" data-testid="signed" data-slot={slot}>
    <p className="text-sm font-semibold text-green-800"><i className="ri-checkbox-circle-line mr-1" aria-hidden="true" />Signed by {signed.signerName} on {fmtDay(signed.signedAt)}</p>
    <SignatureImage png={signed.signaturePng} name={signed.signerName} className="mt-1" />
    <p className="mt-1 text-xs text-green-800">Printed on the signature line ({where}) with this date.</p>
  </div>;
  if (saved === undefined) return <p className="text-sm text-foreground-500">Loading your signature…</p>;
  return <div className="space-y-2" data-testid="sign-declaration" data-slot={slot}>
    <p className="text-sm text-foreground-700">By signing you agree with the declaration above.</p>
    {saved ? <div className="flex flex-wrap items-center gap-3"><SignatureImage png={saved} className="rounded-lg border border-background-200 bg-white px-2" />
      <button type="button" className={PRIMARY} disabled={busy} onClick={() => sign(null)} data-testid="sign-button">{busy ? "Signing…" : "Sign"}</button></div>
      : <><SignatureField value={value} onChange={(v) => setValue(v ? { ...v, keep: true } : null)} label="Your signature (kept for your next declarations)" allowSave={false} />
        <button type="button" className={PRIMARY} disabled={!value || busy} onClick={() => sign(value)} data-testid="sign-button">{busy ? "Signing…" : "Sign"}</button></>}
    {err ? <p role="alert" className="text-sm text-red-700">{err}</p> : null}
  </div>;
}

/** A table: a grid on wide screens; on a phone each row is a card with one labelled input per column (the row's printed name as its title). */
function TableInput({ table, heading, a, setValue, boxesOf }: { table: Table; heading: string | null; a: PdfAnswers; setValue: (f: TemplateField, v: string) => void; boxesOf: (fs: TemplateField[]) => FitBox[] }) {
  const cell = (f: TemplateField | null, label: string, rowLabel: string) => {
    if (!f) return null;
    const v = fieldValue(a, f);
    const tall = (boxesOf([f])[0]?.hPt ?? 0) > 26;
    const props = { value: v, onChange: (e: { target: { value: string } }) => setValue(f, e.target.value), className: `${INPUT} min-w-0 py-2 leading-6`, "aria-label": `${rowLabel} · ${label}`, "data-testid": "table-cell" };
    return <>{tall ? <GrowArea rows={2} {...props} /> : <input type={f.kind === "date" ? "date" : "text"} {...props} />}<FitHint text={v} boxes={boxesOf([f])} /></>;
  };
  return <div data-testid="answer-table" data-rows={table.rows.length}>
    {heading ? <p className="mb-2 text-base font-semibold text-foreground-900" data-testid="table-heading">{heading}</p> : null}
    <div className="hidden overflow-x-auto md:block" data-testid="table-grid">
      <table className="w-full border-collapse text-base">
        <thead><tr>{table.labelColumn ? <th className="w-48 border border-background-200 bg-background-100 px-3 py-2 text-left text-sm font-semibold text-foreground-800" scope="col"><span className="sr-only">Row</span></th> : null}
          {table.columns.map((c, i) => <th key={i} scope="col" className="border border-background-200 bg-background-100 px-3 py-2 text-left text-sm font-semibold text-foreground-800">{c.label}</th>)}</tr></thead>
        <tbody>{table.rows.map((r) => <tr key={r.id}>
          {table.labelColumn ? <th scope="row" className="border border-background-200 bg-background-50 px-3 py-2 text-left align-top text-sm font-medium text-foreground-900">{r.label}</th> : null}
          {r.cells.map((c, i) => <td key={i} className="border border-background-200 p-1 align-top">{cell(c, table.columns[i]?.label ?? "", r.label)}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="space-y-3 md:hidden" data-testid="table-cards">
      {table.rows.map((r) => <div key={r.id} className="rounded-xl border border-background-200 bg-background-50 p-3" data-testid="table-card">
        <p className="mb-2 font-semibold text-foreground-900">{r.label}</p>
        <div className="space-y-2">{r.cells.map((c, i) => c ? <label key={i} className="block text-sm font-medium text-foreground-700">{table.columns[i]?.label || `Column ${i + 1}`}
          <div className="mt-1">{cell(c, table.columns[i]?.label ?? "", r.label)}</div></label> : null)}</div>
      </div>)}
    </div>
  </div>;
}

/** Appendix B: the learner evaluation, optional: the student's details on the form, five-point ratings per statement, comments. */
function Evaluation({ template, pdf, pages, a, setValue, setChoice, recordValue }: { template: PdfTemplate; pdf: PdfHandle; pages: number[]; a: PdfAnswers;
  setValue: (f: TemplateField, v: string) => void; setChoice: (g: string, o: string) => void; recordValue: (f: TemplateField) => string }) {
  const fields = studentFields(template).filter((f) => pages.includes(f.page)).sort((x, y) => x.page - y.page || x.y - y.y || x.x - y.x);
  const groups: { group: string; label: string; options: TemplateField[] }[] = [];
  const items: ReactNode[] = [];
  for (const f of fields) {
    if (f.kind === "rating" && f.group) {
      let g = groups.find((x) => x.group === f.group);
      if (!g) { g = { group: f.group, label: f.label, options: [] }; groups.push(g); items.push(<RatingRow key={f.group} g={g} a={a} setChoice={setChoice} />); }
      g.options.push(f);
      continue;
    }
    if (f.role === "auto") { items.push(<ReadOnly key={f.id} label={f.label} value={recordValue(f)} />); continue; }
    const v = fieldValue(a, f);
    items.push(<label key={f.id} className="block text-sm font-semibold text-foreground-900">{f.label}
      {f.h > 0.05 ? <textarea rows={3} className={`${INPUT} mt-1 font-normal`} value={v} onChange={(e) => setValue(f, e.target.value)} />
        : <input className={`${INPUT} mt-1 font-normal`} value={v} onChange={(e) => setValue(f, e.target.value)} />}</label>);
  }
  return <section className="space-y-4" data-testid="step-evaluation">
    <div className={CARD}><p className={EYEBROW}>Appendix B · optional</p>
      <h1 className="mt-1 font-heading text-2xl font-bold text-foreground-950">Learner evaluation</h1>
      <p className="mt-1 text-sm text-foreground-600">Optional. Tell us how the training went; you can submit without it.</p></div>
    <PdfCrop pdf={pdf} rect={{ page: pages[0], x: 0, y: 0.15, w: 1, h: 0.25 }} label={`Appendix B as printed on page ${pages[0]}`} />
    <div className={`${CARD} space-y-4`}>{items}</div>
  </section>;
}

function RatingRow({ g, a, setChoice }: { g: { group: string; label: string; options: TemplateField[] }; a: PdfAnswers; setChoice: (g: string, o: string) => void }) {
  return <fieldset className="rounded-xl border border-background-200 p-3" data-testid="rating-row">
    <legend className="px-1 text-sm font-medium text-foreground-900">{g.label}</legend>
    <div className="mt-1 grid grid-cols-5 gap-1">
      {RATINGS.map((r, i) => { const opt = String(i + 1); const on = a.pdfChoice?.[g.group] === opt; return <label key={r} className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border px-1 py-2 text-center text-2xs sm:text-xs ${on ? "border-primary-500 bg-primary-50 font-semibold text-primary-800" : "border-background-200 text-foreground-600 hover:bg-background-100"}`}>
        <input type="radio" className="sr-only" name={g.group} checked={on} onChange={() => setChoice(g.group, opt)} />{r}</label>; })}
    </div>
  </fieldset>;
}
