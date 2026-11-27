import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import UnsavedGuard from "@/components/assessment/UnsavedGuard";
import { saveLabel, saveTone, useAutosave } from "@/lib/assessment/autosave";
import { supabase } from "@/pages/admin/lib/supabase";
import PdfPages from "@/components/signing/PdfPages";
import SignatureField, { SignatureImage, type SignatureValue } from "@/components/assessment/SignatureField";
import { asmSign, asmTrainer, keepSignature, mySignature } from "@/lib/assessment/api";
import { buildStampedPdf, downloadWorkbook, ensureAcknowledgedCopy, loadPdfAttempt, storeFinalPdf } from "@/lib/assessment/pdfTemplate/api";
import { questionName, type PdfTemplate, type TemplateField, type TemplateQuestion } from "@/lib/assessment/pdfTemplate/model";
import QuestionView from "@/components/assessment/pdf/QuestionView";
import AnswerReadOnly from "@/components/assessment/pdf/AnswerReadOnly";
import { usePdf, type PdfHandle } from "@/components/assessment/pdf/pdfDoc";
import { answered, markingMissing, stampValues, type BundleAttempt, type PdfBundle, type StampValue } from "@/lib/assessment/pdfTemplate/output";
import { reviewName } from "@/lib/assessment/pdfTemplate/student";

/**
 * ASM-PDF-TEMPLATE phase 3 (owner 2026-11-26): the trainer marks on the workbook itself. The original PDF with the student's
 * submitted answers in place (drawn from the locked snapshot), and a side panel of the questions: Satisfactory Yes / No and an
 * optional comment per question (a click on a question goes to its page). Task results follow the marks; the results sheet, the
 * marking checklist's Performance rows, the written evidence list and the summary sheet fill themselves; Evidence Outcome rows,
 * Appendix A and office use are clicked on the page. Overall Competent / Not Yet Competent with feedback; the assessor signs off;
 * Release result, or Return for resubmission (the student's next attempt starts from their answers). A final result stores the
 * stamped PDF with the snapshot hash.
 * ASM-QUESTION-TEXT (owner 2026-11-27): the Questions view (the default) marks one question at a time, shown as in the student's
 * wizard (its text read from the PDF, pictures, See on page), the student's answer under it, Satisfactory Yes / No as large toggles,
 * a comment, Next unmarked. The Workbook pages view is the workbook with the answers in place (checklists, Appendix A, office use).
 */
type Mark = { outcome: "S" | "NYS" | null; feedback: string };
const BTN = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = `${BTN} bg-primary-600 text-white hover:bg-primary-700`;
const SECONDARY = `${BTN} border border-background-300 bg-white text-foreground-800 hover:border-primary-300`;
const INPUT = "w-full rounded-md border border-background-300 bg-white px-2 py-1.5 text-sm focus:border-primary-400 focus:outline-none";

export default function PdfMarking({ attemptId, initial }: { attemptId: string; initial: PdfBundle }) {
  const [bundle, setBundle] = useState<PdfBundle>(initial);
  const cur = bundle.attempts.find((a) => a.attemptNo === bundle.attemptNo) as BundleAttempt;
  const t = bundle.template;
  const [marks, setMarks] = useState<Record<string, Mark>>(() => Object.fromEntries(cur.results.filter((r) => !r.criterionId).map((r) => [r.questionId, { outcome: r.outcome, feedback: r.feedback ?? "" }])));
  const [taskFeedback, setTaskFeedback] = useState<Record<string, string>>(() => Object.fromEntries(cur.taskResults.map((r) => [r.taskId, r.feedback ?? ""])));
  const [assessor, setAssessor] = useState<{ pdf: Record<string, string>; pdfChoice: Record<string, string> }>(() => ({ pdf: { ...(cur.assessorResponses?.pdf ?? {}) }, pdfChoice: { ...(cur.assessorResponses?.pdfChoice ?? {}) } }));
  const [overall, setOverall] = useState<"S" | "NYS" | null>(cur.outcome ?? null);
  const [overallFeedback, setOverallFeedback] = useState(cur.overallFeedback ?? "");
  const [base, setBase] = useState<Uint8Array | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = useState<"questions" | "pages">("questions");
  const [current, setCurrent] = useState<string>(() => (t.questions.find((q) => !cur.results.some((r) => r.questionId === q.key && !r.criterionId && r.outcome)) ?? t.questions[0])?.key ?? "");
  // the original workbook: the question display reads each question's words from it
  const [orig, setOrig] = useState<Uint8Array | null>(null);
  useEffect(() => { let off = false; void downloadWorkbook(t.pdf.path).then((b) => { if (!off) setOrig(b); }).catch(() => undefined); return () => { off = true; }; }, [t.pdf.path]);
  const { pdf: origPdf, error: origError } = usePdf(orig);
  const rowVersion = useRef(cur.rowVersion ?? 1);
  const open = cur.state === "submitted" || cur.state === "marking";
  const editable = open && bundle.canAssess;

  // the student's answers in place, from the snapshot (drawn once; the trainer's marks are shown over it as they change)
  // redrawn only when the attempt or its snapshot changes (never on a save or a sign-off: the page would reload)
  const baseKey = `${cur.id}:${cur.snapshot?.hash ?? ""}`;
  useEffect(() => { void buildStampedPdf(bundle, { trainer: false, continuedAtEnd: true }).then(setBase).catch((e) => setError(e instanceof Error ? e.message : "The workbook could not be drawn.")); }, [baseKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // the attempt as the trainer has it now (unsaved marks included): what the sheets show
  const live = useMemo<PdfBundle>(() => ({ ...bundle, attempts: bundle.attempts.map((a) => a.attemptNo !== bundle.attemptNo ? a : {
    ...a, results: Object.entries(marks).map(([questionId, m]) => ({ questionId, outcome: m.outcome, feedback: m.feedback })),
    taskResults: t.tasks.map((tk) => ({ taskId: tk.number, outcome: taskOutcome(tk.number), feedback: taskFeedback[tk.number] ?? "", signedAt: a.taskResults.find((r) => r.taskId === tk.number)?.signedAt ?? new Date().toISOString() })),
    assessorResponses: { ...(a.assessorResponses ?? {}), ...assessor }, outcome: overall, overallFeedback,
  }) }), [bundle, marks, taskFeedback, assessor, overall, overallFeedback]); // eslint-disable-line react-hooks/exhaustive-deps
  const values = useMemo(() => stampValues(live, { trainer: true }), [live]);
  function taskOutcome(task: string): "S" | "NYS" | null {
    const qs = t.questions.filter((q) => String(q.task) === task);
    if (!qs.length || qs.some((q) => !marks[q.key]?.outcome)) return null;
    return qs.some((q) => marks[q.key]?.outcome === "NYS") ? "NYS" : "S";
  }

  // the marks save as the trainer goes (owner 2026-11-26): a failed save says so and is retried, offline / signed out shown, saved
  // again when back online or signed in again; leaving the page with marks not saved asks first
  const send = useCallback(async ({ m, tf, as, of }: { m: Record<string, Mark>; tf: Record<string, string>; as: typeof assessor; of: string }) => {
    const out = await asmTrainer<{ rowVersion: number }>("mark_save", { id: attemptId, rowVersion: rowVersion.current,
      results: Object.entries(m).filter(([, x]) => x.outcome).map(([questionId, x]) => ({ questionId, outcome: x.outcome, feedback: x.feedback })),
      taskResults: t.tasks.map((tk) => ({ taskId: tk.number, feedback: tf[tk.number] ?? "" })), assessorResponses: as, overallFeedback: of });
    rowVersion.current = out.rowVersion;
  }, [attemptId, t.tasks]);
  const autosave = useAutosave(send, { debounceMs: 700, resumeOn: (resume) => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") resume(); });
    return () => sub.subscription.unsubscribe();
  } });
  const queue = (m = marks, tf = taskFeedback, as = assessor, of = overallFeedback) => { if (editable) autosave.queue({ m, tf, as, of }); };
  const mark = (key: string, patch: Partial<Mark>) => { const next = { ...marks, [key]: { outcome: null, feedback: "", ...marks[key], ...patch } }; setMarks(next); queue(next); };

  const reload = async () => { const b = await loadPdfAttempt(attemptId); if (b) setBundle(b); };
  // the student acknowledged but their browser did not store the acknowledged copy: the assessor's opening finishes it
  useEffect(() => {
    if (!bundle.canAssess) return;
    let off = false;
    void ensureAcknowledgedCopy(bundle).then((stored) => { if (stored && !off) void reload(); }).catch(() => undefined);
    return () => { off = true; };
  }, [bundle]); // eslint-disable-line react-hooks/exhaustive-deps
  const goPage = (page: number) => document.querySelector(`[data-pdf-page="${page}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  // what the release needs (the same rules as the database's asm_template_marking_missing): every question marked, every checklist row the trainer ticks
  const missing = useMemo(() => markingMissing(t, Object.entries(marks).map(([questionId, m]) => ({ questionId, outcome: m.outcome })), assessor.pdfChoice), [t, marks, assessor.pdfChoice]);
  const earlier = bundle.attempts.filter((a) => a.attemptNo < cur.attemptNo);
  const signoff = cur.signoff;

  const decide = async () => {
    if (!overall) return;
    setError("");
    autosave.queue({ m: marks, tf: taskFeedback, as: assessor, of: overallFeedback });
    if (!(await autosave.flush())) { setError("The marks are not saved yet (" + saveLabel(autosave.current(), "").replace("…", "") + "). Release once they are saved."); return; }
    setBusy("Saving the decision…");
    try {
      const out = await asmTrainer<{ ok: boolean; errors?: { message: string }[]; nextAttemptId?: string | null }>("mark_return", { id: attemptId, rowVersion: rowVersion.current, outcome: overall, overallFeedback });
      if (!out.ok) { setError((out.errors ?? []).map((e) => e.message).join(" ") || "Not saved."); return; }
      const b = await loadPdfAttempt(attemptId);
      if (b) {
        setBundle(b);
        const after = b.attempts.find((a) => a.attemptNo === b.attemptNo);
        if (after?.state === "final" && !after.output) {
          setBusy("Storing the final PDF…");
          await storeFinalPdf(attemptId, await buildStampedPdf(b, { trainer: true }));
          await reload();
        }
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Not saved."); } finally { setBusy(""); }
  };
  const openStamped = async () => {
    const w = window.open("", "_blank");
    try { const bytes = await buildStampedPdf(live, { trainer: true }); const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/pdf" })); if (w) w.location.href = url; }
    catch (e) { w?.close(); setError(e instanceof Error ? e.message : "The PDF could not be made."); }
  };

  const tasks = t.tasks;
  return <div className="flex min-h-screen flex-col bg-background-100 lg:h-screen lg:overflow-hidden" data-testid="pdf-marking">
    <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-background-200 bg-white px-4 py-3">
      <div className="min-w-0"><Link to="/staff/assessments" className="text-xs text-foreground-500 underline">Assessments</Link>
        <p className="truncate font-heading text-lg font-bold text-foreground-950">{cur.snapshot?.record.studentName ?? "Student"} · attempt {cur.attemptNo}</p>
        <p className="truncate text-xs text-foreground-500">{cur.snapshot?.record.unitCode} {cur.snapshot?.record.unitName} · snapshot {cur.snapshot?.hash.slice(0, 12)}…</p>
        {earlier.length ? <p className="text-xs text-foreground-600" data-testid="earlier-attempts">Earlier attempts (their own answers, marks and checklists): {earlier.map((a) => <Link key={a.id} to={`/staff/assessments/attempts/${a.id}`} className="mr-2 font-semibold text-primary-700 underline">Attempt {a.attemptNo}</Link>)}</p> : null}</div>
      <UnsavedGuard when={editable && autosave.pending} message="Your latest marks are not saved yet. Stay to let them save." />
      <div className="flex items-center gap-3"><span className={`text-sm font-semibold ${saveTone(autosave.status)}`} role="status" data-testid="marking-saved">{autosave.status.state === "idle" ? "" : saveLabel(autosave.status, "")}</span>
        <div className="inline-flex rounded-lg border border-background-300 bg-background-50 p-0.5" role="tablist" aria-label="View" data-testid="marking-view">
          {(["questions", "pages"] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} data-testid={`marking-view-${v}`}
            className={`min-h-[40px] rounded-md px-3 text-sm font-semibold ${view === v ? "bg-white text-foreground-950 shadow-sm" : "text-foreground-600 hover:text-foreground-900"}`}>{v === "questions" ? "Questions" : "Workbook pages"}</button>)}
        </div>
        <button type="button" className={SECONDARY} onClick={() => void openStamped()} data-testid="open-stamped">Open stamped PDF</button></div>
    </header>
    {error ? <p role="alert" className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
    <div className="grid flex-1 gap-4 p-4 lg:h-[calc(100vh-5.5rem)] lg:grid-cols-[minmax(0,1fr)_380px] lg:overflow-hidden">
      {view === "questions" ? <main className="min-w-0 lg:overflow-y-auto" data-testid="marking-questions">
        {origPdf && t.questions.find((q) => q.key === current) ? <QuestionMarker pdf={origPdf} t={t} q={t.questions.find((q) => q.key === current)!} answers={cur.snapshot?.answers ?? {}}
          mark={marks[current]} editable={editable} onMark={(p) => mark(current, p)} marks={marks} onGo={setCurrent} />
          : <p role="status" className="rounded-xl bg-white p-6 text-base text-foreground-600">{origError || "Opening the workbook…"}</p>}
      </main> : null}
      <main className={`min-w-0 rounded-xl bg-background-200 p-3 lg:overflow-y-auto ${view === "questions" ? "hidden" : ""}`} data-testid="marking-pdf">
        {base ? <PdfPages source={base} maxWidth={860} lazy overlay={(page) => <PageOverlay page={page} fields={t.fields.filter((f) => f.page === page && f.role === "trainer")} values={values} editable={editable}
          derived={(f) => derived(f, t.pages[f.page - 1]?.kind)} onToggle={(f) => {
            if ((f.kind === "yes_no" || f.kind === "rating") && f.group) { const as = { ...assessor, pdfChoice: { ...assessor.pdfChoice, [f.group]: f.option ?? "" } }; setAssessor(as); queue(marks, taskFeedback, as); }
            else if (f.kind === "checkbox") { const as = { ...assessor, pdf: { ...assessor.pdf, [f.id]: assessor.pdf[f.id] === "true" ? "" : "true" } }; setAssessor(as); queue(marks, taskFeedback, as); }
            else setEditing(f.id);
          }} editing={editing} onText={(f, v) => { const as = { ...assessor, pdf: { ...assessor.pdf, [f.id]: v } }; setAssessor(as); queue(marks, taskFeedback, as); }} onDone={() => setEditing(null)} assessor={assessor} />} />
          : <p role="status" className="p-6 text-sm text-foreground-600">Drawing the workbook with the student's answers…</p>}
      </main>
      <aside className="space-y-4 lg:overflow-y-auto lg:pr-1" data-testid="marking-panel">
        {tasks.map((tk) => {
          const qs = t.questions.filter((q) => String(q.task) === tk.number);
          const out = taskOutcome(tk.number);
          return <section key={tk.number} className="rounded-xl border border-background-200 bg-white p-3" data-testid="marking-task">
            <div className="flex items-start justify-between gap-2"><h2 className="text-sm font-semibold text-foreground-950">Task {tk.number} · {tk.title}</h2>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${out === "S" ? "bg-green-100 text-green-800" : out === "NYS" ? "bg-amber-100 text-amber-900" : "bg-background-100 text-foreground-500"}`} data-testid="task-auto">{out === "S" ? "Satisfactory" : out === "NYS" ? "Not satisfactory" : "Not marked yet"}</span></div>
            <ul className="mt-2 divide-y divide-background-100">
              {qs.map((q) => { const m = marks[q.key]; const did = answered(t, cur.snapshot, q.key); return <li key={q.key} className={`py-2 ${view === "questions" && current === q.key ? "-mx-1.5 rounded-lg bg-primary-50 px-1.5" : ""}`} data-testid="marking-question" data-key={q.key}>
                <div className="flex items-center gap-2">
                  <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium text-primary-700 underline-offset-2 hover:underline" onClick={() => (view === "questions" ? setCurrent(q.key) : goPage(q.header.page))} title={q.label} aria-current={view === "questions" && current === q.key ? "true" : undefined}>
                    {reviewName(t, q)} <span className="font-normal text-foreground-500">· p{q.header.page}{did ? "" : " · not answered"}</span></button>
                  {(["S", "NYS"] as const).map((o) => <button key={o} type="button" disabled={!editable} onClick={() => mark(q.key, { outcome: o })} aria-pressed={m?.outcome === o} data-testid={`mark-${o}`}
                    className={`rounded-md border px-2 py-1 text-xs font-semibold ${m?.outcome === o ? (o === "S" ? "border-green-600 bg-green-600 text-white" : "border-amber-600 bg-amber-500 text-white") : "border-background-300 bg-white text-foreground-700"}`}>{o === "S" ? "Yes" : "No"}</button>)}
                </div>
                {editable || m?.feedback ? <input className={`${INPUT} mt-1 text-xs`} placeholder="Comment (optional)" value={m?.feedback ?? ""} disabled={!editable} onChange={(e) => mark(q.key, { feedback: e.target.value })} aria-label={`Comment on ${questionName(q)}`} /> : null}
              </li>; })}
            </ul>
            <label className="mt-2 block text-xs font-medium text-foreground-600">Task {tk.number} feedback (results sheet)
              <textarea className={`${INPUT} mt-1`} rows={2} value={taskFeedback[tk.number] ?? ""} disabled={!editable} onChange={(e) => { const tf = { ...taskFeedback, [tk.number]: e.target.value }; setTaskFeedback(tf); queue(marks, tf); }} data-testid="task-feedback" /></label>
          </section>;
        })}
        <section className="space-y-3 rounded-xl border border-background-200 bg-white p-3" data-testid="marking-overall">
          <h2 className="text-sm font-semibold text-foreground-950">Overall result · attempt {cur.attemptNo}</h2>
          <div className="flex gap-2">{(["S", "NYS"] as const).map((o) => <button key={o} type="button" disabled={!editable} onClick={() => setOverall(o)} aria-pressed={overall === o} data-testid={`overall-${o}`}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold ${overall === o ? (o === "S" ? "border-green-600 bg-green-600 text-white" : "border-amber-600 bg-amber-500 text-white") : "border-background-300 bg-white"}`}>{o === "S" ? "Competent" : "Not Yet Competent"}</button>)}</div>
          <textarea className={INPUT} rows={3} placeholder="Feedback to the student" value={overallFeedback} disabled={!editable} onChange={(e) => { setOverallFeedback(e.target.value); queue(marks, taskFeedback, assessor, e.target.value); }} data-testid="overall-feedback" />
          <SignOff attemptId={attemptId} signed={signoff} onSigned={reload} disabled={!bundle.canAssess || cur.state === "draft"} />
          {open ? <>
            {missing.length ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" data-testid="marking-missing">
              <p className="font-semibold">Before the result can be released ({missing.length}):</p>
              <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4">{missing.map((m) => <li key={m}>{m}</li>)}</ul></div> : null}
            {!signoff ? <p className="text-xs text-amber-800">Sign off as the assessor first.</p> : null}
            <button type="button" className={`${PRIMARY} w-full`} disabled={!editable || !overall || missing.length > 0 || !signoff || !!busy} onClick={() => void decide()} data-testid="decide">
              {busy || (overall === "NYS" ? "Return for resubmission" : "Release result")}</button>
            <p className="text-2xs text-foreground-500">{overall === "NYS" ? "The student gets the next attempt with their answers filled in; the next column of the results and summary sheets is used." : "The result is released to the student, who signs to acknowledge it on the summary sheet."}</p>
          </> : <p className="rounded-lg bg-background-100 px-3 py-2 text-sm text-foreground-700" data-testid="decided">{cur.state === "returned" ? "Returned for resubmission." : "Result released."}{(cur.outputs ?? []).map((o) => <span key={o.kind} className="block" data-testid={`stored-${o.kind}`}>{o.kind === "acknowledged" ? "Acknowledged copy (official record)" : "Sign-off copy"} · SHA-256 <span className="font-mono text-2xs">{o.pdfSha256.slice(0, 16)}…</span> · snapshot <span className="font-mono text-2xs">{o.snapshotHash.slice(0, 16)}…</span></span>)}</p>}
        </section>
        {cur.state === "final" && bundle.canAssess && bundle.unitId && bundle.studentId ? <UnitOutcome studentId={bundle.studentId} unitId={bundle.unitId} attemptId={cur.id} suggested={cur.outcome === "S" ? "C" : "NYC"} /> : null}
      </aside>
    </div>
  </div>;
}

/** One question to mark: as the student saw it, their answer, Satisfactory Yes / No, a comment, and the way to the next one. */
function QuestionMarker({ pdf, t, q, answers, mark, marks, editable, onMark, onGo }: { pdf: PdfHandle; t: PdfTemplate; q: TemplateQuestion; answers: { pdf?: Record<string, string>; pdfChoice?: Record<string, string> };
  mark: Mark | undefined; marks: Record<string, Mark>; editable: boolean; onMark: (p: Partial<Mark>) => void; onGo: (key: string) => void }) {
  const i = t.questions.findIndex((x) => x.key === q.key);
  const n = t.questions.length;
  const unmarked = (from: number) => { for (let k = 1; k <= n; k++) { const x = t.questions[(from + k) % n]; if (!marks[x.key]?.outcome) return x.key; } return null; };
  const nextUnmarked = unmarked(i);
  const go = (key: string) => { onGo(key); document.querySelector("[data-testid=marking-questions]")?.scrollTo({ top: 0 }); window.scrollTo({ top: 0 }); };
  const task = t.tasks.find((x) => Number(x.number) === q.task);
  const left = t.questions.filter((x) => !marks[x.key]?.outcome).length;
  const TOGGLE = "flex min-h-[56px] flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 px-4 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2";
  return <div className="mx-auto max-w-3xl space-y-5 rounded-2xl border border-background-200 bg-white p-4 sm:p-6" data-testid="question-marker" data-key={q.key}>
    <QuestionView pdf={pdf} template={t} question={q} level={2}
      eyebrow={<p className="mb-1 text-sm font-medium text-foreground-600">{task ? `Task ${task.number} · ${task.title} · ` : ""}question {i + 1} of {n}</p>} />
    <section className="space-y-2 border-t border-background-200 pt-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground-600">Student's answer</h3>
      <AnswerReadOnly template={t} questionKey={q.key} answers={answers} />
    </section>
    <section className="space-y-3 border-t border-background-200 pt-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground-600" id={`sat-${q.key}`}>Satisfactory response?</h3>
      <div className="flex gap-3" role="group" aria-labelledby={`sat-${q.key}`}>
        <button type="button" disabled={!editable} aria-pressed={mark?.outcome === "S"} onClick={() => onMark({ outcome: "S" })} data-testid="q-mark-S"
          className={`${TOGGLE} ${mark?.outcome === "S" ? "border-green-600 bg-green-600 text-white" : "border-background-300 bg-white text-foreground-800 hover:border-green-500"}`}><i className="ri-check-line text-xl" aria-hidden="true" />Yes</button>
        <button type="button" disabled={!editable} aria-pressed={mark?.outcome === "NYS"} onClick={() => onMark({ outcome: "NYS" })} data-testid="q-mark-NYS"
          className={`${TOGGLE} ${mark?.outcome === "NYS" ? "border-amber-600 bg-amber-500 text-white" : "border-background-300 bg-white text-foreground-800 hover:border-amber-500"}`}><i className="ri-close-line text-xl" aria-hidden="true" />No, not yet</button>
      </div>
      <label className="block text-sm font-semibold text-foreground-800" htmlFor={`c-${q.key}`}>Comment to the student {mark?.outcome === "NYS" ? "(what to change)" : "(optional)"}</label>
      <textarea id={`c-${q.key}`} rows={3} className="w-full rounded-lg border border-background-300 bg-white px-3 py-2.5 text-base leading-7 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:bg-background-50"
        value={mark?.feedback ?? ""} disabled={!editable} onChange={(e) => onMark({ feedback: e.target.value })} data-testid="q-comment" />
    </section>
    <div className="flex flex-wrap items-center gap-2 border-t border-background-200 pt-4">
      <button type="button" className={`${SECONDARY} min-h-[44px]`} disabled={i === 0} onClick={() => go(t.questions[i - 1].key)} data-testid="q-prev">← Previous</button>
      <button type="button" className={`${SECONDARY} min-h-[44px]`} disabled={i === n - 1} onClick={() => go(t.questions[i + 1].key)} data-testid="q-next">Next →</button>
      <span className="ml-auto text-sm text-foreground-600" data-testid="q-left">{left ? `${left} not marked` : "All questions marked"}</span>
      <button type="button" className={`${PRIMARY} min-h-[44px]`} disabled={!nextUnmarked || nextUnmarked === q.key} onClick={() => nextUnmarked && go(nextUnmarked)} data-testid="q-next-unmarked">Next unmarked →</button>
    </div>
  </div>;
}

/** Marks that fill themselves (from the question marks and the task results): shown, never clicked. */
function derived(f: TemplateField, pageKind: string | undefined) {
  return (f.kind === "yes_no" && !!f.group?.startsWith("q.")) || (f.checklist === "performance" && !!f.questionKey) || pageKind === "results_sheet" || pageKind === "summary" || f.kind === "signature";
}

function PageOverlay({ page, fields, values, editable, derived: isDerived, onToggle, editing, onText, onDone, assessor }: {
  page: number; fields: TemplateField[]; values: Map<string, StampValue>; editable: boolean; derived: (f: TemplateField) => boolean;
  onToggle: (f: TemplateField) => void; editing: string | null; onText: (f: TemplateField, v: string) => void; onDone: () => void; assessor: { pdf: Record<string, string> };
}) {
  return <div className="absolute inset-0" data-testid={`marking-page-${page}`}>
    {fields.map((f) => {
      const v = values.get(f.id);
      const auto = isDerived(f);
      const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
      const choice = f.kind === "yes_no" || f.kind === "rating" || f.kind === "checkbox";
      if (f.kind === "signature") return v?.kind === "png" ? <img key={f.id} src={`data:image/png;base64,${v.png}`} alt="" className="absolute object-contain object-left" style={style} /> : null;
      if (choice) return <button key={f.id} type="button" disabled={!editable || auto} onClick={() => onToggle(f)} title={f.label} data-testid="trainer-field" data-field={f.id} data-checklist={f.checklist ?? undefined} data-option={f.option ?? undefined} aria-pressed={!!v}
        className={`absolute flex items-center justify-center rounded-sm text-[11px] font-bold leading-none ${auto ? "cursor-default" : "cursor-pointer outline outline-1 outline-red-300 hover:bg-red-100/60"} ${v ? "text-red-800" : ""}`} style={style}>{v ? "✓" : ""}</button>;
      if (editing === f.id) return <textarea key={f.id} autoFocus className="absolute z-10 rounded border border-red-400 bg-white p-1 text-[11px] shadow-lg" style={{ ...style, minHeight: 60 }}
        value={assessor.pdf[f.id] ?? ""} onChange={(e) => onText(f, e.target.value)} onBlur={onDone} aria-label={f.label} />;
      return <button key={f.id} type="button" disabled={!editable || auto} onClick={() => onToggle(f)} title={f.label}
        className={`absolute overflow-hidden whitespace-pre-wrap rounded-sm px-0.5 text-left text-[9px] leading-tight text-red-800 ${auto ? "cursor-default" : "cursor-text outline outline-1 outline-red-300 hover:bg-red-50/70"}`} style={style}>{v?.kind === "text" ? v.text : ""}</button>;
    })}
  </div>;
}

/** After the final result: the assessor records the unit outcome (never automatic: it covers every assessment of the unit), signed. */
function UnitOutcome({ studentId, unitId, attemptId, suggested }: { studentId: string; unitId: string; attemptId: string; suggested: "C" | "NYC" }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<"C" | "NYC">(suggested);
  const [notes, setNotes] = useState("");
  const [tick, setTick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const record = async () => {
    setBusy(true); setMsg("");
    try { await asmTrainer("unit_outcome_record", { studentId, unitId, outcome, signOff: tick, notes, attemptIds: [attemptId] }); setOpen(false); setTick(false); setNotes(""); setMsg(`Unit outcome recorded: ${outcome === "C" ? "Competent" : "Not Yet Competent"}.`); }
    catch (e) { setMsg(e instanceof Error ? e.message : "Not recorded."); } finally { setBusy(false); }
  };
  return <section className="space-y-2 rounded-xl border border-background-200 bg-white p-3 text-sm" data-testid="unit-outcome">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-foreground-800">Record the unit outcome for this student (never automatic: it covers every assessment of the unit).</p>
      <button type="button" className={SECONDARY} onClick={() => setOpen((o) => !o)} data-testid="unit-outcome-open">Record unit outcome</button></div>
    {open ? <div className="space-y-2">
      <div className="flex gap-2">{(["C", "NYC"] as const).map((o) => <button key={o} type="button" aria-pressed={outcome === o} className={`min-h-[44px] cursor-pointer rounded-lg border px-3 font-semibold ${outcome === o ? "border-primary-600 bg-primary-50 text-primary-800" : "border-background-300"}`} onClick={() => setOutcome(o)}>{o === "C" ? "Competent" : "Not Yet Competent"}</button>)}</div>
      <textarea rows={2} className="w-full rounded-lg border border-background-300 px-3 py-2" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={tick} onChange={(e) => setTick(e.target.checked)} />I declare that I have conducted a fair, valid, reliable and flexible assessment and that this outcome is based on the evidence recorded.</label>
      <button type="button" className={SECONDARY} disabled={busy || !tick} onClick={() => void record()} data-testid="unit-outcome-record">Record and sign</button>
    </div> : null}
    {msg ? <p role="status" className="text-foreground-700" data-testid="unit-outcome-msg">{msg}</p> : null}
  </section>;
}

function SignOff({ attemptId, signed, onSigned, disabled }: { attemptId: string; signed: BundleAttempt["signoff"]; onSigned: () => Promise<void>; disabled: boolean }) {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [value, setValue] = useState<SignatureValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { void mySignature().then((s) => setSaved(s.signaturePng)); }, []);
  if (signed) return <div className="rounded-lg border border-green-200 bg-green-50 p-2" data-testid="signoff-done"><p className="text-xs font-semibold text-green-800">Signed off by {signed.signerName} on {new Date(signed.signedAt).toLocaleDateString("en-AU")}</p>
    <SignatureImage png={signed.signaturePng} name={signed.signerName} className="h-10" /></div>;
  const sign = async (v: SignatureValue | null) => {
    setBusy(true); setErr("");
    try { await asmSign(attemptId, "assessor_signoff", v ? v.method : "saved", v?.png ?? null, "I declare that I have conducted a fair, valid, reliable, and flexible assessment with this student, and I have provided appropriate feedback."); if (v) await keepSignature({ ...v, keep: true }); await onSigned(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Not signed."); } finally { setBusy(false); }
  };
  return <div className="space-y-2" data-testid="signoff">
    <p className="text-xs font-medium text-foreground-600">Assessor sign-off (printed on the declarations, the summary sheet and Appendix A)</p>
    {saved ? <div className="flex items-center gap-2"><SignatureImage png={saved} className="h-10 rounded border border-background-200 bg-white" /><button type="button" className={SECONDARY} disabled={disabled || busy} onClick={() => void sign(null)} data-testid="signoff-sign">Sign</button></div>
      : saved === null ? <><SignatureField value={value} onChange={(v) => setValue(v)} label="Your signature" allowSave={false} /><button type="button" className={SECONDARY} disabled={disabled || !value || busy} onClick={() => void sign(value)} data-testid="signoff-sign">Sign</button></> : null}
    {err ? <p role="alert" className="text-xs text-red-700">{err}</p> : null}
  </div>;
}
