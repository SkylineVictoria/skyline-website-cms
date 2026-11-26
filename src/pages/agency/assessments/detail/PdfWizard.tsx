import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import SignatureField, { SignatureImage, type SignatureValue } from "@/components/assessment/SignatureField";
import { FitPreview, PdfCrop, PdfPageImage } from "@/components/assessment/pdf/PdfView";
import { usePdf, type PdfHandle } from "@/components/assessment/pdf/pdfDoc";
import { questionName, type AutoKey, type PdfTemplate, type TemplateField } from "@/lib/assessment/pdfTemplate/model";
import { fieldValue, missingItems, questionInputs, studentFields, wizardSteps, type FitBox, type Missing, type PdfAnswers, type Table, type WizardStep } from "@/lib/assessment/pdfTemplate/student";
import { mySignature } from "@/lib/assessment/api";
import type { PdfSignature } from "@/lib/assessment/pdfTemplate/api";
import type { Responses } from "@/lib/assessment/types";

/**
 * ASM-PDF-TEMPLATE phase 2 (owner 2026-11-26): the student answers on the workbook itself. Per task: its instruction pages (as page
 * images), one step per question (the question cropped from the PDF, then its answer boxes / tables), the task's declaration; Appendix
 * B (optional); review & submit. Only the student's fields; the record's shown read-only where they help; never the trainer's fields
 * or the result acknowledgement. Every change is autosaved (draft_save); the preview shows how the answer fits its box on the page.
 */
/** The returned attempt this one follows: its marks and comments, shown next to the questions. */
export interface PreviousAttempt { attemptNo: number; overallFeedback: string; marks: Record<string, { outcome: "S" | "NYS" | null; feedback: string }> }
export interface PdfRecord { studentName: string; studentRef: string; studentEmail: string; trainer: string; unitCode: string; unitName: string; qualificationCode: string; qualificationName: string }

const CARD = "rounded-2xl border border-background-200 bg-white p-4 sm:p-5";
const PRIMARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-background-300 bg-white px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const INPUT = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 focus:border-primary-400 focus:bg-white focus:outline-none";
const RATINGS = ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];

export default function PdfWizard({ template, pdfBytes, responses, onChange, savedLabel, saving, record, signatures, onSign, onSubmit, busy, serverErrors, dueLabel, previous = null }: {
  template: PdfTemplate; pdfBytes: Uint8Array | null; responses: Responses; onChange: (r: Responses) => void; savedLabel: string; saving: boolean;
  record: PdfRecord; signatures: PdfSignature[];
  /** Signs one declaration: v null = with the saved signature (one tap). */
  onSign: (slot: string, v: SignatureValue | null, statement: string) => Promise<void>;
  previous?: PreviousAttempt | null;
  onSubmit: () => Promise<void>; busy: boolean; serverErrors: string[]; dueLabel: string;
}) {
  const { pdf, error } = usePdf(pdfBytes);
  const steps = useMemo(() => wizardSteps(template), [template]);
  const [params, setParams] = useSearchParams();
  const index = Math.max(0, steps.findIndex((s) => s.id === params.get("step")));
  const step = steps[index];
  const go = (i: number) => { const next = new URLSearchParams(params); next.set("step", steps[Math.max(0, Math.min(steps.length - 1, i))].id); setParams(next, { replace: false }); window.scrollTo({ top: 0 }); };
  const a = responses as PdfAnswers;
  const signed = useMemo(() => signatures.map((x) => x.slot), [signatures]);
  const missing = useMemo(() => missingItems(template, a, signed), [template, a, signed]);
  const answeredQ = useMemo(() => new Set(template.questions.filter((q) => !missing.some((m) => m.questionKey === q.key && m.code === "unanswered")).map((q) => q.key)), [template, missing]);

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
  const pct = Math.round(((index + 1) / steps.length) * 100);

  return <div className="mx-auto max-w-6xl pb-24" data-testid="pdf-wizard">
    <div className="sticky top-0 z-30 -mx-4 mb-4 border-b border-background-200 bg-white/95 px-4 pb-2 pt-3 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm text-foreground-600"><span className="font-semibold text-foreground-900">{record.unitCode}</span>{record.unitCode ? " · " : ""}{record.unitName}</p>
        <p className={`shrink-0 text-sm font-semibold ${saving ? "text-foreground-500" : "text-green-700"}`} role="status" data-testid="autosave">{savedLabel || dueLabel}</p>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-background-200" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1} aria-label="Progress" data-testid="wizard-progress">
          <div className="h-full rounded-full bg-primary-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 text-xs font-medium text-foreground-600" data-testid="wizard-step-count">Step {index + 1} of {steps.length}</span>
      </div>
    </div>
    <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
      <nav aria-label="Steps" className="hidden lg:block">
        <ol className="sticky top-24 max-h-[calc(100vh-8rem)] space-y-0.5 overflow-y-auto pr-1 text-sm" data-testid="wizard-steps">
          {steps.map((s, i) => {
            const done = s.kind === "question" ? answeredQ.has(s.key) : s.kind === "declaration" ? signed.includes(`decl:${s.task}`) : false;
            const heading = (s.kind === "read" && (i === 0 || steps[i - 1].kind === "details" || steps[i - 1].kind === "declaration")) ? `Task ${s.task}` : null;
            return <li key={s.id}>
              {heading ? <p className="mb-1 mt-3 px-3 text-2xs font-semibold uppercase tracking-wide text-foreground-500">{heading} · {s.kind === "read" ? template.tasks.find((t) => Number(t.number) === s.task)?.title : ""}</p> : null}
              <button type="button" onClick={() => go(i)} aria-current={i === index ? "step" : undefined}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left ${i === index ? "bg-primary-50 font-semibold text-primary-800" : "text-foreground-700 hover:bg-background-100"}`}>
                <i className={`${done ? "ri-checkbox-circle-fill text-green-600" : s.kind === "read" ? "ri-book-open-line text-foreground-400" : "ri-circle-line text-foreground-300"} text-base`} aria-hidden="true" />
                <span className="truncate">{s.kind === "question" ? s.title : s.kind === "read" ? s.title.split(" · ")[1] : s.title.replace(/^Task \d+ · /, "")}</span>
              </button>
            </li>;
          })}
        </ol>
      </nav>
      <main className="min-w-0 space-y-4">
        <label className="block lg:hidden"><span className="sr-only">Go to step</span>
          <select className={INPUT} value={step.id} onChange={(e) => go(steps.findIndex((s) => s.id === e.target.value))} data-testid="wizard-jump">
            {steps.map((s, i) => <option key={s.id} value={s.id}>{i + 1}. {s.kind === "question" ? `Task ${s.task} · ${s.title}` : s.title}</option>)}
          </select>
        </label>
        {error ? <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">{error}</p> : null}
        {!pdf && !error ? <p role="status" className={`${CARD} text-sm text-foreground-600`}>Opening your workbook…</p> : null}
        {pdf ? <StepView step={step} template={template} pdf={pdf} a={a} record={record} recordValue={recordValue} setValue={setValue} setChoice={setChoice}
          signatures={signatures} onSign={onSign} previous={previous}
          missing={missing} goMissing={(m) => go(stepOfMissing(m))} onSubmit={onSubmit} busy={busy} serverErrors={serverErrors} /> : null}
        <div className="flex items-center justify-between gap-3 pt-2">
          <button type="button" className={SECONDARY} disabled={index === 0} onClick={() => go(index - 1)} data-testid="wizard-back">← Back</button>
          {index < steps.length - 1 ? <button type="button" className={PRIMARY} onClick={() => go(index + 1)} data-testid="wizard-next">{steps[index + 1].kind === "review" ? "Review & submit →" : "Next →"}</button> : null}
        </div>
      </main>
    </div>
  </div>;
}

function StepView({ step, template, pdf, a, record, recordValue, setValue, setChoice, signatures, onSign, missing, goMissing, onSubmit, busy, serverErrors, previous }: {
  step: WizardStep; template: PdfTemplate; pdf: PdfHandle; a: PdfAnswers; record: PdfRecord; recordValue: (f: TemplateField) => string;
  setValue: (f: TemplateField, v: string) => void; setChoice: (g: string, o: string) => void;
  signatures: PdfSignature[]; onSign: (slot: string, v: SignatureValue | null, statement: string) => Promise<void>; previous: PreviousAttempt | null;
  missing: Missing[]; goMissing: (m: Missing) => void; onSubmit: () => Promise<void>; busy: boolean; serverErrors: string[];
}) {
  const taskTitle = (n: number | null) => { const t = template.tasks.find((x) => Number(x.number) === n); return t ? `Task ${t.number} · ${t.title}` : ""; };
  const boxesOf = (fs: TemplateField[]): FitBox[] => fs.map((f) => { const s = pdf.sizes[f.page - 1] ?? { w: 595, h: 842 }; return { page: f.page, wPt: f.w * s.w, hPt: f.h * s.h }; });

  if (step.kind === "details") {
    const rows: [string, string][] = [["Student name", record.studentName], ["Student ID", record.studentRef], ["Email", record.studentEmail], ["Unit", `${record.unitCode} ${record.unitName}`.trim()],
      ["Qualification", `${record.qualificationCode} ${record.qualificationName}`.trim()], ["Trainer / assessor", record.trainer]];
    return <section className={CARD} data-testid="step-details">
      <h1 className="font-heading text-2xl font-bold text-foreground-950">Your details</h1>
      {previous ? <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="resubmission">
        <p className="font-semibold">Attempt {previous.attemptNo + 1}: your answers from attempt {previous.attemptNo} are filled in.</p>
        <p className="mt-1">Change what your trainer marked as not yet satisfactory, sign the declarations again and submit.{previous.overallFeedback ? <> Trainer's feedback: <span className="italic">{previous.overallFeedback}</span></> : null}</p>
      </div> : null}
      <p className="mt-1 text-sm text-foreground-600">These come from your enrolment and are printed on your workbook for you. Ask your trainer if something is wrong.</p>
      <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2" data-testid="record-fields">
        {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt className="text-xs font-medium text-foreground-500">{k}</dt><dd className="mt-0.5 rounded-lg bg-background-100 px-3 py-2 text-sm text-foreground-900">{v}</dd></div>)}
      </dl>
      <ul className="mt-5 space-y-1 text-sm text-foreground-700">
        {template.tasks.map((t) => <li key={t.number}><span className="font-semibold">Task {t.number}</span> · {t.title} · {template.questions.filter((q) => q.task === Number(t.number)).length} questions</li>)}
      </ul>
    </section>;
  }

  if (step.kind === "read") return <section className="space-y-3" data-testid="step-read">
    <div className={CARD}><p className="text-xs font-semibold uppercase tracking-wide text-primary-700">{taskTitle(step.task)}</p>
      <h1 className="mt-1 font-heading text-xl font-bold text-foreground-950">Read {step.pages.length === 1 ? "this page" : `these ${step.pages.length} pages`} first</h1>
      <p className="mt-1 text-sm text-foreground-600">Pages {step.pages[0]}{step.pages.length > 1 ? `–${step.pages[step.pages.length - 1]}` : ""} of your workbook, as printed.</p></div>
    {step.pages.map((p) => <PdfPageImage key={p} pdf={pdf} page={p} />)}
  </section>;

  if (step.kind === "question") {
    const q = template.questions.find((x) => x.key === step.key)!;
    const inputs = questionInputs(template, q.key);
    const choiceGroups = new Set<string>();
    const tableCount = inputs.filter((x) => x.kind === "table").length;
    let tableNo = 0;
    return <section className="space-y-4" data-testid="step-question" data-question-key={q.key}>
      <div><p className="text-xs font-semibold uppercase tracking-wide text-primary-700">{taskTitle(step.task)}</p>
        <h1 className="mt-1 font-heading text-2xl font-bold text-foreground-950">{questionName(q)}</h1></div>
      {previous?.marks[q.key]?.outcome ? <p className={`rounded-xl px-3 py-2 text-sm ${previous.marks[q.key].outcome === "NYS" ? "border border-amber-300 bg-amber-50 text-amber-900" : "border border-green-200 bg-green-50 text-green-800"}`} data-testid="previous-mark">
        {previous.marks[q.key].outcome === "NYS" ? `Not yet satisfactory in attempt ${previous.attemptNo}` : `Satisfactory in attempt ${previous.attemptNo}`}{previous.marks[q.key].feedback ? `: ${previous.marks[q.key].feedback}` : "."}</p> : null}
      <PdfCrop pdf={pdf} rect={q.prompt ?? q.header} label={`${questionName(q)} as printed on page ${q.header.page}`} />
      <div className={`${CARD} space-y-5`}>
        {inputs.map((inp) => {
          if (inp.kind === "table") return <TableInput key={inp.table.id} heading={tableCount > 1 ? `Table ${++tableNo} of ${tableCount}` : null} table={inp.table} a={a} setValue={setValue} boxesOf={boxesOf} />;
          const f = inp.field;
          if (inp.kind === "text") {
            const v = fieldValue(a, f);
            const label = f.label !== "Answer" ? f.label : f.page !== q.header.page ? `Your answer (page ${f.page})` : "Your answer";
            const lines = Math.min(16, Math.max(3, Math.round(inp.boxes.reduce((s, b) => s + b.h * (pdf.sizes[b.page - 1]?.h ?? 842), 0) / 16)));
            return <div key={f.id} className="space-y-2" data-field={f.id}>
              <label className="block text-sm font-semibold text-foreground-900" htmlFor={`f-${f.id}`}>{label}{f.required ? <span className="ml-1 text-red-700" aria-hidden="true">*</span> : null}</label>
              <textarea id={`f-${f.id}`} className={INPUT} rows={lines} value={v} onChange={(e) => setValue(f, e.target.value)} aria-required={f.required || undefined} data-testid="answer-text" />
              <FitPreview text={v} boxes={boxesOf(inp.boxes)} />
            </div>;
          }
          if (f.role === "auto") return <ReadOnly key={f.id} label={f.label} value={recordValue(f)} />;
          if ((f.kind === "yes_no" || f.kind === "rating") && f.group) {
            if (choiceGroups.has(f.group)) return null;
            choiceGroups.add(f.group);
            const opts = inputs.filter((x): x is { kind: "field"; field: TemplateField } => x.kind === "field" && x.field.group === f.group).map((x) => x.field);
            return <fieldset key={f.group}><legend className="text-sm font-semibold text-foreground-900">{f.label}</legend>
              <div className="mt-1 flex flex-wrap gap-2">{opts.map((o) => <label key={o.id} className="flex items-center gap-1.5 text-sm"><input type="radio" name={f.group!} checked={a.pdfChoice?.[f.group!] === o.option} onChange={() => setChoice(f.group!, o.option ?? "")} />{o.option}</label>)}</div></fieldset>;
          }
          if (f.kind === "checkbox") return <label key={f.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fieldValue(a, f) === "true"} onChange={(e) => setValue(f, e.target.checked ? "true" : "")} />{f.label}</label>;
          return <div key={f.id} data-field={f.id}><label className="block text-sm font-semibold text-foreground-900" htmlFor={`f-${f.id}`}>{f.label}{f.required ? <span className="ml-1 text-red-700" aria-hidden="true">*</span> : null}</label>
            <input id={`f-${f.id}`} type={f.kind === "date" ? "date" : "text"} className={`${INPUT} mt-1`} value={fieldValue(a, f)} onChange={(e) => setValue(f, e.target.value)} data-testid="answer-line" /></div>;
        })}
        {!inputs.length ? <p className="text-sm text-foreground-600">Nothing to fill in here.</p> : null}
      </div>
    </section>;
  }

  if (step.kind === "declaration") {
    const decl = template.declarations?.find((d) => d.page === step.page);
    const slot = `decl:${step.task}`;
    const mine = signatures.find((x) => x.slot === slot) ?? null;
    return <section className="space-y-4" data-testid="step-declaration">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-primary-700">{taskTitle(step.task)}</p>
        <h1 className="mt-1 font-heading text-2xl font-bold text-foreground-950">Task {step.task} declaration</h1></div>
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
  return <section className={`${CARD} space-y-4`} data-testid="step-review">
    <h1 className="font-heading text-2xl font-bold text-foreground-950">Review &amp; submit</h1>
    <p className="text-sm text-foreground-700">{total - unanswered} of {total} questions answered.</p>
    {missing.length ? <div className="rounded-xl border border-amber-300 bg-amber-50 p-3" data-testid="review-missing">
      <p className="text-sm font-semibold text-amber-900">Before you can submit ({missing.length}):</p>
      <ul className="mt-2 space-y-1">{missing.map((m, i) => <li key={i}><button type="button" className="cursor-pointer text-left text-sm text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-950" onClick={() => goMissing(m)} data-testid="missing-item">{m.message}</button></li>)}</ul>
    </div> : <p className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" data-testid="review-ready">Everything needed is answered, agreed and signed.</p>}
    {pack ? <div className="space-y-3 border-t border-background-200 pt-4" data-testid="pack-declaration">
      <h2 className="font-heading text-lg font-semibold text-foreground-950">Student declaration</h2>
      <p className="text-sm text-foreground-600">The declaration for the whole workbook, as printed on page{packDecl?.rects && packDecl.rects.length > 1 ? "s" : ""} {(packDecl?.rects ?? []).map((r) => r.page).join(" and ") || pack.page}. Sign it when you submit.</p>
      {(packDecl?.rects ?? []).map((r) => <PdfCrop key={r.page} pdf={pdf} rect={r} label={`The student declaration on page ${r.page}`} />)}
      <DeclSign slot="pack" signed={signatures.find((x) => x.slot === "pack") ?? null} onSign={(v) => onSign("pack", v, packDecl?.text ?? "")} where={`page ${pack.page}`} />
    </div> : null}
    {serverErrors.length ? <ul role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{serverErrors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
    <p className="text-sm text-foreground-600">When you submit, your answers are locked and you get a receipt number. The learner evaluation is optional.</p>
    <button type="button" className={PRIMARY} disabled={busy || missing.length > 0} onClick={() => void onSubmit()} data-testid="submit">{busy ? "Submitting…" : "Submit for marking"}</button>
  </section>;
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
    const props = { value: v, onChange: (e: { target: { value: string } }) => setValue(f, e.target.value), className: `${INPUT} min-w-0`, "aria-label": `${rowLabel} · ${label}`, "data-testid": "table-cell" };
    return <>{tall ? <textarea rows={2} {...props} /> : <input type={f.kind === "date" ? "date" : "text"} {...props} />}<FitPreview text={v} boxes={boxesOf([f])} compact /></>;
  };
  return <div data-testid="answer-table" data-rows={table.rows.length}>
    {heading ? <p className="mb-2 text-sm font-semibold text-foreground-900" data-testid="table-heading">{heading}</p> : null}
    <div className="hidden overflow-x-auto md:block" data-testid="table-grid">
      <table className="w-full border-collapse text-sm">
        <thead><tr>{table.labelColumn ? <th className="w-48 border border-background-200 bg-[#595959] px-2 py-2 text-left font-semibold text-white" scope="col"><span className="sr-only">Row</span></th> : null}
          {table.columns.map((c, i) => <th key={i} scope="col" className="border border-background-200 bg-[#595959] px-2 py-2 text-left font-semibold text-white">{c.label}</th>)}</tr></thead>
        <tbody>{table.rows.map((r) => <tr key={r.id}>
          {table.labelColumn ? <th scope="row" className="border border-background-200 bg-background-50 px-2 py-2 text-left align-top font-medium text-foreground-900">{r.label}</th> : null}
          {r.cells.map((c, i) => <td key={i} className="border border-background-200 p-1 align-top">{cell(c, table.columns[i]?.label ?? "", r.label)}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="space-y-3 md:hidden" data-testid="table-cards">
      {table.rows.map((r) => <div key={r.id} className="rounded-xl border border-background-200 bg-background-50 p-3" data-testid="table-card">
        <p className="mb-2 font-semibold text-foreground-900">{r.label}</p>
        <div className="space-y-2">{r.cells.map((c, i) => c ? <label key={i} className="block text-xs font-medium text-foreground-600">{table.columns[i]?.label || `Column ${i + 1}`}
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
    <div className={CARD}><p className="text-xs font-semibold uppercase tracking-wide text-primary-700">Appendix B · optional</p>
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
