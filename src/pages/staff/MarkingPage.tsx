/**
 * ASM-AI-IMPORT stage 4 (owner, 2026-11-25; mockups docs/mockups/assessment-flow-mockups.pdf pages 5-6):
 * /staff/assessments/attempts/:id
 *   Marking desk  one question at a time: the question and the student's answer, the model answer / what to look for folded under it;
 *                 large Satisfactory / Not satisfactory buttons, an optional comment, keys S / N / -> (next) / <- , a grid of the
 *                 questions coloured by state. Marks save as they are made (asm_trainer mark_save). No "mark all".
 *   Sign off      after every question is marked: one results sheet per task filled in from the marking (S / NS, attempt, date,
 *                 assessor) with the trainer's feedback, the assessment summary (all tasks S -> Competent, otherwise Not Yet
 *                 Competent), the reasonable adjustment record, the assessor declaration with the saved signature, "Sign & release
 *                 results" (asm_sign assessor_signoff, then mark_return).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { ruleNumber } from "@/lib/businessRules";
import PdfPages from "@/components/signing/PdfPages";
import SignatureField, { SignatureImage } from "@/components/assessment/SignatureField";
import { TypeInput, TypeView } from "@/components/assessment/TypeParts";
import { useAttemptHistory } from "@/components/assessment/useAttemptHistory";
import { downloadWorkbookPdf, workbookPdfBytes } from "@/lib/assessment/workbookExport";
import { workbookNumbering } from "@/lib/assessment/workbookLayout";
import { isAnswerable, isAssessorOnly } from "@/lib/assessment/registry";
import { taskOutcomeFromMarks, unitOutcome } from "@/lib/assessment/studentFlow";
import {
  asmSign, asmSignatures, asmTrainer, evidenceUrl, fmtDate, fmtDateTime, keepSignature, OUTCOME_LABEL, STATE_LABEL, uploadEvidence,
  type AttemptSignature, type SignatureValue,
} from "@/lib/assessment/api";
import type { Attempt, Definition, EvidenceFile, Outcome, Question, QuestionKey, Responses, Task } from "@/lib/assessment/types";

type Loaded = Attempt & { canAssess?: boolean; definition: Definition; assessmentTitle: string; unitId: string | null; studentName: string; settings: Record<string, unknown>; keys: QuestionKey[] };
interface Mark { outcome: Outcome | null; feedback: string }
interface Item { task: Task; taskIndex: number; q: Question; number: string }

const CARD = "rounded-2xl border border-background-200 bg-white p-4 sm:p-5";
const PRIMARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-background-300 bg-white px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const NOT_MARKED = new Set(["declaration", "adjustment_record"]);

export default function MarkingPage() {
  const { id = "" } = useParams();
  const [signedOut, setSignedOut] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [marks, setMarks] = useState<Map<string, Mark>>(new Map());
  const [taskFeedback, setTaskFeedback] = useState<Record<string, string>>({});
  const [assessorResponses, setAssessorResponses] = useState<Responses>({});
  const [index, setIndex] = useState(0);
  const [view, setView] = useState<"desk" | "signoff">("desk");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signatures, setSignatures] = useState<AttemptSignature[]>([]);
  const [declared, setDeclared] = useState(false);
  const [sig, setSig] = useState<SignatureValue | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [preview, setPreview] = useState<{ bytes: Uint8Array | null; error: string } | null>(null);
  const [message, setMessage] = useState("");
  const [unitForm, setUnitForm] = useState<{ open: boolean; outcome: "C" | "NYC"; tick: boolean; notes: string }>({ open: false, outcome: "C", tick: false, notes: "" });
  const recordUnit = async () => {
    if (!data?.unitId) return;
    setBusy(true);
    try { await asmTrainer("unit_outcome_record", { studentId: data.studentId, unitId: data.unitId, outcome: unitForm.outcome, signOff: unitForm.tick, notes: unitForm.notes, attemptIds: [data.id] }); setUnitForm((u) => ({ ...u, open: false })); setNote(`Unit outcome recorded: ${OUTCOME_LABEL[unitForm.outcome]}.`); }
    catch (e) { setError(e instanceof Error ? e.message : "Not recorded."); } finally { setBusy(false); }
  };
  const rowVersion = useRef(0);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await asmTrainer<Loaded>("attempt_get", { id });
      setData(d); rowVersion.current = d.rowVersion; setError("");
      setMarks(new Map(d.results.filter((r) => !r.criterionId).map((r) => [r.questionId, { outcome: r.outcome, feedback: r.feedback ?? "" }])));
      setTaskFeedback(Object.fromEntries(d.taskResults.map((t) => [t.taskId, t.feedback ?? ""])));
      setAssessorResponses(d.assessorResponses ?? {});
      setSignatures(await asmSignatures(d.id));
    } catch (e) { setError(e instanceof Error ? e.message : "The attempt did not load."); }
  }, [id]);
  useEffect(() => { void supabase.auth.getUser().then(({ data: u }) => { if (!u.user) setSignedOut(true); else void load(); }); }, [load]);
  const history = useAttemptHistory(data?.id, data ? [data] : [], data?.studentName, `${data?.state}${data?.rowVersion}`);

  const definition = data?.definition;
  const numbers = useMemo(() => (definition ? workbookNumbering(definition) : new Map()), [definition]);
  const items: Item[] = useMemo(() => {
    if (!definition) return [];
    const out: Item[] = [];
    definition.tasks.forEach((task, ti) => {
      let n = 0;
      for (const q of task.sections.flatMap((s) => s.questions)) {
        if (!isAnswerable(q) || NOT_MARKED.has(q.type) || (q.markingMode ?? "criteria") === "none") continue;
        n += 1;
        out.push({ task, taskIndex: ti, q, number: q.importMeta?.number ?? numbers.get(q.id)?.number ?? `${ti + 1}.${n}` });
      }
    });
    return out;
  }, [definition, numbers]);
  const keyOf = (qid: string) => data?.keys.find((k) => k.questionId === qid);
  const markOf = (qid: string): Mark => marks.get(qid) ?? { outcome: null, feedback: "" };
  const marked = items.filter((it) => markOf(it.q.id).outcome).length;
  const left = items.length - marked;
  const locked = !data || !["submitted", "marking"].includes(data.state) || data.canAssess === false;
  const taskOutcome = (t: Task) => taskOutcomeFromMarks(items.filter((it) => it.task.id === t.id).map((it) => it.q.id), Object.fromEntries([...marks].map(([k, v]) => [k, v.outcome])));
  const outcomes = definition ? Object.fromEntries(definition.tasks.filter((t) => items.some((it) => it.task.id === t.id)).map((t) => [t.id, taskOutcome(t)])) : {};
  const unit = definition ? unitOutcome(definition.tasks.filter((t) => items.some((it) => it.task.id === t.id)), outcomes) : null;

  const payload = useCallback((m: Map<string, Mark>, fb: Record<string, string>, ar: Responses) => {
    const markMap = Object.fromEntries([...m].map(([k, v]) => [k, v.outcome]));
    return {
      results: [...m].map(([questionId, v]) => ({ questionId, criterionId: null, outcome: v.outcome, feedback: v.feedback })),
      taskResults: (definition?.tasks ?? []).filter((t) => items.some((it) => it.task.id === t.id)).map((t) => ({ taskId: t.id, outcome: taskOutcomeFromMarks(items.filter((it) => it.task.id === t.id).map((it) => it.q.id), markMap), feedback: fb[t.id] ?? "" })),
      assessorResponses: ar,
      overallFeedback: (definition?.tasks ?? []).map((t, i) => (fb[t.id] ? `Task ${i + 1}: ${fb[t.id]}` : "")).filter(Boolean).join("\n"),
    };
  }, [definition, items]);
  /** Saves run one after another (each needs the row version the previous one returned). */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const save = useCallback((m: Map<string, Mark>, fb: Record<string, string>, ar: Responses): Promise<Loaded | null> => {
    if (locked) return Promise.resolve(null);
    const run = chain.current.catch(() => undefined).then(async () => {
      setSaving(true);
      try { const d = await asmTrainer<Loaded>("mark_save", { id, rowVersion: rowVersion.current, ...payload(m, fb, ar) }); rowVersion.current = d.rowVersion; setError(""); return d; }
      catch (e) { setError(e instanceof Error ? e.message : "Not saved."); return null; } finally { setSaving(false); }
    });
    chain.current = run;
    return run;
  }, [id, locked, payload]);
  const queue = (m: Map<string, Mark>, fb = taskFeedback, ar = assessorResponses) => { if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void save(m, fb, ar), 700); };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const setMark = (qid: string, patch: Partial<Mark>) => setMarks((prev) => { const n = new Map(prev); n.set(qid, { ...(prev.get(qid) ?? { outcome: null, feedback: "" }), ...patch }); queue(n); return n; });
  const decide = (o: Outcome) => {
    const it = items[index]; if (!it || locked) return;
    setMark(it.q.id, { outcome: o });
    // the next question still to mark (or the next one)
    const after = items.findIndex((x, i) => i > index && !markOf(x.q.id).outcome);
    if (after >= 0) setIndex(after); else if (index + 1 < items.length) setIndex(index + 1);
  };
  useEffect(() => {
    if (view !== "desk") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
      if (e.key === "s" || e.key === "S") { e.preventDefault(); decide("S"); }
      else if (e.key === "n" || e.key === "N") { e.preventDefault(); decide("NYS"); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setIndex((i) => Math.min(items.length - 1, i + 1)); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const openEvidence = async (f: EvidenceFile) => { const w = window.open("", "_blank"); try { const u = await evidenceUrl(f.path); if (w) { w.opener = null; w.location.href = u; } } catch (e) { w?.close(); setError(e instanceof Error ? e.message : "The file could not be opened."); } };
  const uploadAssessor = async (q: Question, files: FileList) => { for (const file of Array.from(files)) { try { const { path, sha256 } = await uploadEvidence(id, q.id, file, true); await asmTrainer("evidence_register", { attemptId: id, questionId: q.id, path, fileName: file.name, mime: file.type, bytes: file.size, sha256 }); } catch (e) { setError(e instanceof Error ? e.message : "Not uploaded."); } } await load(); };

  const signoff = signatures.find((s) => s.attemptId === data?.id && s.kind === "assessor_signoff") ?? null;
  const maxAttempts = Number(data?.settings.max_attempts ?? ruleNumber("assessment.attempts_default", 3));
  const adjustment = definition?.tasks.flatMap((t) => t.sections.flatMap((s) => s.questions)).find((q) => q.type === "adjustment_record") ?? null;
  const adjustmentValue = adjustment ? assessorResponses[adjustment.id] as Record<string, unknown> | undefined : undefined;
  const adjustmentSummary = !adjustment ? null : !adjustmentValue || !Object.keys(adjustmentValue).length ? "not recorded yet" : JSON.stringify(adjustmentValue).match(/"(applied|adjusted|made)"\s*:\s*true/) ? "recorded" : "none";

  const release = async () => {
    if (!data || !sig || !declared || unit === null) return;
    setBusy(true); setError("");
    try {
      if (timer.current) window.clearTimeout(timer.current);
      const saved = await save(marks, taskFeedback, assessorResponses);
      if (!saved) return;
      await asmSign(data.id, "assessor_signoff", sig.method, sig.png, "I have assessed this student's work against the unit requirements, recorded the results above, and given feedback to the student.");
      const p = payload(marks, taskFeedback, assessorResponses);
      const out = await asmTrainer<{ ok: boolean; errors?: { message: string }[]; nextAttemptId?: string | null }>("mark_return", { id: data.id, rowVersion: rowVersion.current, outcome: unit === "C" ? "S" : "NYS", overallFeedback: p.overallFeedback });
      if (!out.ok) { setError(out.errors?.map((e) => e.message).join(" ") ?? "The results were not released."); if (adjustment) setAdjustOpen(true); await load(); return; }
      await keepSignature(sig);
      setNote(unit === "C" ? "Results released: Competent." : out.nextAttemptId ? "Results released: Not Yet Competent. A reassessment attempt is open for the student." : "Results released: Not Yet Competent (final).");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "The results were not released."); }
    finally { setBusy(false); }
  };
  const openPreview = async () => {
    if (!data || !history) return;
    setPreview({ bytes: null, error: "" });
    try {
      const attempt = { ...data, results: [...marks].map(([questionId, v]) => ({ questionId, criterionId: null, suggestedOutcome: null, outcome: v.outcome, score: null, rubricLevelId: null, feedback: v.feedback, markedAt: null })) };
      setPreview({ bytes: await workbookPdfBytes({ definition: data.definition, attempt, history: { ...history, student: history.student ?? { id: data.studentId, ref: data.studentId.slice(0, 8).toUpperCase(), name: data.studentName } }, title: data.assessmentTitle, maxAttempts, signatures }), error: "" });
    } catch (e) { setPreview({ bytes: null, error: e instanceof Error ? e.message : "The PDF was not made." }); }
  };
  const exportPdf = async () => {
    if (!data || !history) return;
    try { await downloadWorkbookPdf({ definition: data.definition, attempt: data, history: { ...history, student: history.student ?? { id: data.studentId, ref: data.studentId.slice(0, 8).toUpperCase(), name: data.studentName } }, title: data.assessmentTitle, maxAttempts, signatures }); }
    catch (e) { setError(e instanceof Error ? `The PDF was not made: ${e.message}` : "The PDF was not made."); }
  };

  if (signedOut) return <Navigate to="/login?next=%2Fstaff%2Fassessments" replace />;
  if (!data || !definition) return <div className="min-h-screen bg-background-100 p-6 text-sm text-foreground-600">{error ? <p role="alert" className="text-red-700">{error}</p> : "Loading…"}</div>;

  const unitCode = history?.assessment?.unit?.code ?? definition.source?.unit?.code ?? "";
  const unitName = history?.assessment?.unit?.name ?? definition.source?.unit?.name ?? data.assessmentTitle;
  const header = (
    <header className="sticky top-0 z-30 border-b border-background-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0"><p className="font-heading text-base font-bold text-foreground-950">{data.studentName} · Attempt {data.attemptNo}</p><p className="truncate text-sm text-foreground-600">{unitCode}{unitCode ? " · " : ""}{unitName}</p></div>
        {view === "signoff" && !left ? <p className="text-sm font-semibold text-green-700">✓ All {items.length} questions marked</p> : (
          <div className="flex items-center gap-3" data-testid="marked-count"><span className="text-sm text-foreground-600">{marked} of {items.length} marked{saving ? " · saving…" : ""}</span>
            <span className="h-1.5 w-28 overflow-hidden rounded-full bg-background-200 sm:w-56"><span className="block h-full rounded-full bg-green-600 transition-all" style={{ width: `${items.length ? Math.round(100 * marked / items.length) : 0}%` }} /></span></div>
        )}
      </div>
    </header>
  );
  const banner = (error || note || data.canAssess === false) ? (
    <div className="mx-auto max-w-6xl space-y-2 px-4 pt-4 sm:px-6">
      {data.canAssess === false ? <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">You can read this submission but not mark it: marking needs the Trainer role on your staff record, a named-assessor place on the assignment, or an administrator.</p> : null}
      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {note ? <p role="status" className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">{note}</p> : null}
    </div>
  ) : null;

  /* ---------------- sign off (and the read-only record once released) ---------------- */
  if (view === "signoff" || data.state === "returned" || data.state === "final") {
    const released = data.state === "returned" || data.state === "final";
    const today = fmtDate(new Date().toISOString());
    return (
      <div className="min-h-screen bg-background-100 pb-16">
        {header}{banner}
        <main className="mx-auto max-w-4xl space-y-4 px-4 pt-6 sm:px-6" data-testid="sign-off">
          <h1 className="font-heading text-2xl font-bold text-foreground-950 sm:text-3xl">{released ? "Results" : "Sign off and release results"}</h1>
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Results sheets · filled in from your marking</p>
          <div className="grid gap-3 md:grid-cols-2">
            {definition.tasks.filter((t) => items.some((it) => it.task.id === t.id)).map((t) => {
              const ti = definition.tasks.indexOf(t); const qs = items.filter((it) => it.task.id === t.id); const s = qs.filter((it) => markOf(it.q.id).outcome === "S").length; const o = outcomes[t.id];
              return (
                <section key={t.id} className={CARD} data-testid="results-sheet-task">
                  <div className="flex items-start justify-between gap-2"><h2 className="font-heading text-base font-semibold text-foreground-950">Task {ti + 1} · {t.title.replace(/^Task\s*\d+\s*[:·-]?\s*/i, "").split(/[(:]/)[0].trim() || t.title}</h2>
                    {o ? <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${o === "S" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}`}>{o === "S" ? "Satisfactory" : "Not satisfactory"}</span> : null}</div>
                  <p className="mt-1 text-sm text-foreground-600">{s} of {qs.length} questions S · {ordinal(data.attemptNo)} attempt · {released ? fmtDate(data.returnedAt) : today}{signoff ? ` · ${signoff.signerName}` : ""}</p>
                  <label className="mt-3 block text-xs font-semibold text-foreground-600">Feedback to student
                    <textarea rows={3} className="mt-1 w-full rounded-lg border border-background-300 bg-white px-3 py-2 text-sm text-foreground-900 focus:border-primary-400 focus:outline-none" disabled={released || locked} value={taskFeedback[t.id] ?? ""}
                      onChange={(e) => { const fb = { ...taskFeedback, [t.id]: e.target.value }; setTaskFeedback(fb); queue(marks, fb); }} aria-label={`Feedback to student, task ${ti + 1}`} />
                  </label>
                </section>
              );
            })}
          </div>
          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-foreground-500">Assessment summary</p>
          <section className={`${CARD} flex flex-wrap items-center justify-between gap-3`} data-testid="assessment-summary">
            <div><p className="text-sm text-foreground-600">Unit outcome</p>
              <p className={`font-heading text-2xl font-bold ${unit === "C" ? "text-green-700" : "text-amber-800"}`}>{unit === "C" ? "Competent (C)" : unit === "NYC" ? "Not Yet Competent (NYC)" : "Not decided"}</p>
              <p className="text-sm text-foreground-600">{unit === "C" ? (Object.keys(outcomes).length === 2 ? "Both tasks satisfactory" : "Every task satisfactory") : `${Object.values(outcomes).filter((o) => o === "NYS").length} task(s) not satisfactory`}{adjustmentSummary ? ` · reasonable adjustment: ${adjustmentSummary}` : ""}</p></div>
            {adjustment && !released ? <button type="button" className="cursor-pointer text-sm font-semibold text-primary-700 underline underline-offset-2" onClick={() => setAdjustOpen((o) => !o)}>{adjustOpen ? "Hide the reasonable adjustment record" : "Record a reasonable adjustment"}</button> : null}
          </section>
          {adjustment && adjustOpen && !released ? (
            <section className={CARD} data-adjustment>
              <TypeInput q={adjustment} value={assessorResponses[adjustment.id]} onChange={(v) => { const ar = { ...assessorResponses, [adjustment.id]: v }; setAssessorResponses(ar); queue(marks, taskFeedback, ar); }} />
            </section>
          ) : null}
          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-foreground-500">Assessor declaration</p>
          <section className={CARD} data-testid="assessor-declaration">
            {signoff ? (
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div><p className="text-xs text-foreground-500">Signed</p><SignatureImage png={signoff.signaturePng} name={signoff.signerName} /></div>
                <div className="grid grid-cols-2 gap-6 text-sm"><div><p className="text-xs text-foreground-500">Assessor</p><p className="font-semibold">{signoff.signerName}</p></div><div><p className="text-xs text-foreground-500">Date</p><p className="font-semibold">{fmtDate(signoff.signedAt)}</p></div></div>
              </div>
            ) : (
              <div className="space-y-4">
                <label className="flex cursor-pointer items-start gap-3 text-sm text-foreground-800"><input type="checkbox" className="mt-0.5 h-5 w-5 accent-primary-600" checked={declared} onChange={(e) => setDeclared(e.target.checked)} disabled={locked} data-testid="assessor-declare" />
                  I have assessed this student’s work against the unit requirements, recorded the results above, and given feedback to the student.</label>
                <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <SignatureField value={sig} onChange={setSig} label="Your signature" />
                  <div className="grid grid-cols-2 gap-6 text-sm"><div><p className="text-xs text-foreground-500">Assessor</p><p className="font-semibold">{history?.trainers?.[0] ?? "You"}</p></div><div><p className="text-xs text-foreground-500">Date</p><p className="font-semibold">{today}</p></div></div>
                </div>
              </div>
            )}
          </section>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
            {!released ? <button type="button" className="cursor-pointer px-2 py-2 text-sm font-semibold text-foreground-600 hover:text-foreground-900" onClick={() => setView("desk")}>← Back to marking</button> : <Link className="px-2 py-2 text-sm font-semibold text-foreground-600 hover:text-foreground-900" to="/staff/assessments">← Assessments</Link>}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <button type="button" className={SECONDARY} onClick={() => void openPreview()} disabled={!history} data-testid="signoff-preview">Preview PDF</button>
              {released ? <button type="button" className={SECONDARY} onClick={() => void exportPdf()} disabled={!history}>Export as workbook PDF</button>
                : <button type="button" className={PRIMARY} disabled={busy || locked || !declared || !sig || unit === null} onClick={() => void release()} data-testid="sign-release">{busy ? "Releasing…" : "Sign & release results"}</button>}
            </div>
          </div>
          {!released ? <p className="text-sm text-foreground-600">The student signs to acknowledge the feedback when they open their results. The PDF then carries both signatures.</p> : null}
          {released && data.unitId ? (
            <section className={CARD} data-testid="unit-outcome">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-foreground-800">Record the unit outcome for this student (a unit outcome is never automatic: it covers every assessment of the unit).</p>
                <button type="button" className={SECONDARY} onClick={() => setUnitForm((u) => ({ ...u, open: !u.open, outcome: unit === "NYC" ? "NYC" : "C" }))}>Record unit outcome</button></div>
              {unitForm.open ? (
                <div className="mt-3 space-y-3 text-sm">
                  <div className="flex gap-2">{(["C", "NYC"] as const).map((o) => <button key={o} type="button" aria-pressed={unitForm.outcome === o} className={`cursor-pointer rounded-lg border px-3 py-1.5 font-semibold ${unitForm.outcome === o ? "border-primary-600 bg-primary-50 text-primary-800" : "border-background-300"}`} onClick={() => setUnitForm((u) => ({ ...u, outcome: o }))}>{OUTCOME_LABEL[o]}</button>)}</div>
                  <textarea rows={2} className="w-full rounded-lg border border-background-300 px-3 py-2" placeholder="Notes (optional)" value={unitForm.notes} onChange={(e) => setUnitForm((u) => ({ ...u, notes: e.target.value }))} />
                  <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={unitForm.tick} onChange={(e) => setUnitForm((u) => ({ ...u, tick: e.target.checked }))} />I declare that I have conducted a fair, valid, reliable and flexible assessment and that this outcome is based on the evidence recorded.</label>
                  <button type="button" className={PRIMARY} disabled={busy || !unitForm.tick} onClick={() => void recordUnit()}>Record and sign</button>
                </div>
              ) : null}
            </section>
          ) : null}
          <section className={CARD}>
            <h3 className="font-heading text-sm font-semibold text-foreground-950">Messages with the student</h3>
            {data.feedback.length ? <ul className="mt-2 space-y-1 text-sm">{data.feedback.map((f) => <li key={f.id} className="rounded-md bg-background-100 px-3 py-1.5"><span className="text-xs text-foreground-500">{f.role} · {fmtDateTime(f.createdAt)}</span><br />{f.body}</li>)}</ul> : <p className="mt-1 text-sm text-foreground-600">No messages yet.</p>}
            <div className="mt-2 flex gap-2"><input className="flex-1 rounded-lg border border-background-300 px-3 py-2 text-sm" placeholder="Write to the student" value={message} onChange={(e) => setMessage(e.target.value)} />
              <button type="button" className={SECONDARY} onClick={() => void asmTrainer("feedback_post", { attemptId: data.id, body: message }).then(() => { setMessage(""); return load(); }).catch((e) => setError(e instanceof Error ? e.message : "Not sent."))}>Send</button></div>
          </section>
        </main>
        {preview ? <PreviewModal preview={preview} onClose={() => setPreview(null)} /> : null}
      </div>
    );
  }

  /* ---------------- marking desk ---------------- */
  const it = items[Math.min(index, Math.max(0, items.length - 1))];
  const key = it ? keyOf(it.q.id) : undefined;
  const m = it ? markOf(it.q.id) : { outcome: null, feedback: "" };
  const renderView = (q: Question, scope: Responses): ReactNode => <TypeView key={q.id} q={q} value={isAssessorOnly(q) ? assessorResponses[q.id] : scope[q.id]} evidence={data.evidence} openEvidence={(f) => void openEvidence(f)} renderChildren={(children, r) => children.map((c) => (
    <div key={c.id} className="mt-2"><p className="text-xs font-semibold text-foreground-600">{c.label}</p>{renderView(c, r)}</div>
  ))} />;
  return (
    <div className="min-h-screen bg-background-100 pb-16">
      {header}{banner}
      {!it ? <p className="mx-auto max-w-6xl px-6 pt-6 text-sm text-foreground-600">There is nothing to mark in this assessment.</p> : (
        <main className="mx-auto grid max-w-6xl gap-5 px-4 pt-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px]" data-testid="marking-desk">
          <section className={`${CARD} self-start`} data-question={it.q.id}>
            <p className="text-sm font-semibold text-primary-700">Task {it.taskIndex + 1} · Question {it.number}</p>
            <h1 className="mt-2 text-base font-semibold text-foreground-950 sm:text-lg">{it.q.label}</h1>
            <div className="mt-4 rounded-xl bg-background-100 p-4" data-testid="student-answer">
              <p className="text-2xs font-bold uppercase tracking-wide text-foreground-500">{isAssessorOnly(it.q) ? "Your record" : "Student’s answer"}</p>
              <div className="mt-1 text-sm text-foreground-900">
                {isAssessorOnly(it.q) && !locked
                  ? <TypeInput key={it.q.id} q={it.q} value={assessorResponses[it.q.id]} onChange={(v) => { const ar = { ...assessorResponses, [it.q.id]: v }; setAssessorResponses(ar); queue(marks, taskFeedback, ar); }} evidence={data.evidence} openEvidence={(f) => void openEvidence(f)} onUpload={uploadAssessor} />
                  : renderView(it.q, data.responses)}
              </div>
            </div>
            <details className="mt-3 rounded-xl border border-background-200 px-4 py-3" data-testid="model-answer">
              <summary className="cursor-pointer text-sm font-semibold text-foreground-900">{key?.assessorGuidance && !key?.modelAnswer ? "What to look for" : "Model answer"}</summary>
              <div className="mt-2 space-y-2 text-sm text-foreground-800">
                {key?.modelAnswer ? <p className="whitespace-pre-wrap">{key.modelAnswer}</p> : null}
                {key?.assessorGuidance ? <p className="whitespace-pre-wrap"><span className="font-semibold">What to look for: </span>{key.assessorGuidance}</p> : null}
                {!key?.modelAnswer && !key?.assessorGuidance ? <p className="text-foreground-500">No model answer for this question.</p> : null}
              </div>
            </details>
          </section>
          <div className="space-y-4">
            <section className={CARD}>
              <p className="text-sm font-semibold text-foreground-900">Is this response satisfactory?</p>
              <button type="button" disabled={locked} onClick={() => decide("S")} aria-pressed={m.outcome === "S"} data-testid="mark-s"
                className={`mt-3 flex w-full cursor-pointer items-center justify-between rounded-xl px-4 py-3.5 text-base font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${m.outcome === "S" ? "bg-green-700 text-white ring-2 ring-green-300" : "bg-green-600 text-white hover:bg-green-700"}`}>Satisfactory<span className="text-sm font-semibold opacity-80">S</span></button>
              <button type="button" disabled={locked} onClick={() => decide("NYS")} aria-pressed={m.outcome === "NYS"} data-testid="mark-n"
                className={`mt-3 flex w-full cursor-pointer items-center justify-between rounded-xl border-2 px-4 py-3.5 text-base font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${m.outcome === "NYS" ? "border-amber-600 bg-amber-50 text-amber-900" : "border-amber-300 bg-white text-amber-800 hover:bg-amber-50"}`}>Not satisfactory<span className="text-sm font-semibold opacity-80">N</span></button>
              <label className="mt-4 block text-sm font-semibold text-foreground-800">Comment (optional)
                <textarea rows={3} className="mt-1 w-full rounded-lg border border-background-300 px-3 py-2 text-sm font-normal focus:border-primary-400 focus:outline-none" placeholder="Feedback for the student…" disabled={locked} value={m.feedback} onChange={(e) => setMark(it.q.id, { feedback: e.target.value })} /></label>
              <p className="mt-2 text-xs text-foreground-500">S / N to mark · → next question · ← back</p>
            </section>
            {definition.tasks.map((t, ti) => { const qs = items.map((x, i) => ({ x, i })).filter(({ x }) => x.task.id === t.id); if (!qs.length) return null; return (
              <section key={t.id} className={CARD} data-testid="question-grid">
                <p className="text-sm font-semibold text-foreground-900">Task {ti + 1}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {qs.map(({ x, i }) => { const o = markOf(x.q.id).outcome; const on = i === index; return (
                    <button key={x.q.id} type="button" onClick={() => setIndex(i)} aria-label={`Question ${x.number}${o ? `, ${o === "S" ? "satisfactory" : "not satisfactory"}` : ", not marked"}`} aria-current={on ? "true" : undefined}
                      className={`min-w-[3rem] cursor-pointer rounded-lg px-2 py-1.5 text-xs font-semibold ${o === "S" ? "bg-green-100 text-green-800" : o === "NYS" ? "bg-amber-100 text-amber-900" : "bg-background-100 text-foreground-600"} ${on ? "ring-2 ring-primary-600" : ""}`}>{x.number}</button>
                  ); })}
                </div>
                {ti === 0 ? <p className="mt-2 text-xs text-foreground-500">Green = S · orange = NS · grey = not marked</p> : null}
              </section>
            ); })}
            <button type="button" className={`${PRIMARY} w-full`} disabled={left > 0} onClick={() => { if (timer.current) { window.clearTimeout(timer.current); void save(marks, taskFeedback, assessorResponses); } setView("signoff"); window.scrollTo({ top: 0 }); }} data-testid="finish-sign-off">{left ? `Finish & sign off (${left} left)` : "Finish & sign off →"}</button>
          </div>
        </main>
      )}
    </div>
  );
}

function PreviewModal({ preview, onClose }: { preview: { bytes: Uint8Array | null; error: string }; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[90] flex items-stretch justify-center bg-foreground-950/60 sm:p-6" role="dialog" aria-modal="true" aria-label="Preview PDF">
      <div className="flex w-full max-w-4xl flex-col bg-background-100 sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-background-200 bg-white px-4 py-3 sm:rounded-t-2xl"><p className="font-heading text-sm font-semibold">Preview PDF</p>
          <button type="button" className="cursor-pointer rounded-md p-1 text-foreground-500 hover:bg-background-100" onClick={onClose} aria-label="Close the preview"><i className="ri-close-line text-xl" aria-hidden="true" /></button></div>
        <div className="flex-1 overflow-y-auto p-3 sm:p-5">{preview.error ? <p role="alert" className="text-sm text-red-700">{preview.error}</p> : !preview.bytes ? <p role="status" className="p-6 text-center text-sm">Making the PDF…</p> : <PdfPages source={preview.bytes} maxWidth={820} />}</div>
      </div>
    </div>
  );
}

