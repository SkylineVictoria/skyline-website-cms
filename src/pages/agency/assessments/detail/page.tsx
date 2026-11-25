/**
 * ASM-AI-IMPORT stage 3 (owner, 2026-11-25; mockups docs/mockups/assessment-flow-mockups.pdf pages 3-4): the student's assessment.
 *   Before you start  details filled in (student, student ID, trainer, qualification, unit), what you'll do, the full instructions one
 *                     tap away, the declaration tick and the student's signature (asm_sign student_declaration), Start.
 *   One task a page   task rail with "4 of 6 answered", autosave, questions as cards, parts as compact rows, evidence uploads inline,
 *                     briefs / tables / drawings in the Reference drawer (never inline above the questions).
 *   Review & submit   answered / unanswered per task, then submit (the declaration signed at the start goes with it).
 *   Results           per-task outcome and feedback; the student signs to acknowledge the feedback (asm_sign student_acknowledgement).
 * The workbook layout appears only in "Export as workbook PDF".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { AssessmentInfo } from "@/components/assessment/AssessmentRenderer";
import { sanitize } from "@/components/assessment/registry";
import { TypeInput } from "@/components/assessment/TypeParts";
import SignatureField, { SignatureImage } from "@/components/assessment/SignatureField";
import { useAttemptHistory } from "@/components/assessment/useAttemptHistory";
import { historyFromAttempts } from "@/lib/assessment/resultsSheet";
import { downloadWorkbookPdf } from "@/lib/assessment/workbookExport";
import { workbookNumbering } from "@/lib/assessment/workbookLayout";
import { isAnswered, referenceItems, studentQuestions, taskProgress } from "@/lib/assessment/studentFlow";
import { attachmentSettings, isAnswerable } from "@/lib/assessment/registry";
import {
  asmSign, asmSignatures, asmStudent, evidenceUrl, fmtDate, fmtDateTime, keepSignature, OUTCOME_LABEL, removeEvidenceObject, uploadEvidence,
  type AttemptSignature, type SignatureValue,
} from "@/lib/assessment/api";
import type { Attempt, Definition, EvidenceFile, Question, Responses, ValidationError } from "@/lib/assessment/types";

interface Opened {
  assignment: { id: string; title: string; description: string; dueAt: string; lateUntil: string | null; status: string; unitCode: string | null; unitName: string | null };
  version: { id: string; versionNo: number; definition: Definition };
  settings: { declarationText: string; instructions: string; maxAttempts: number; lateSubmission: string; evidenceMaxMb: number; evidenceAllowedTypes: string[] };
  attempt: Attempt; history: Attempt[];
}
type View = { kind: "start" } | { kind: "task"; index: number } | { kind: "review" };

const CARD = "rounded-2xl border border-background-200 bg-white p-4 sm:p-5";
const PRIMARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-background-300 bg-white px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 focus:border-primary-400 focus:bg-white focus:outline-none";

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-foreground-950/40" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="flex h-full w-full max-w-lg flex-col bg-background-100 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-background-200 bg-white px-4 py-3">
          <p className="font-heading text-sm font-semibold text-foreground-950">{title}</p>
          <button type="button" className="cursor-pointer rounded-md p-1 text-foreground-500 hover:bg-background-100" onClick={onClose} aria-label="Close"><i className="ri-close-line text-xl" aria-hidden="true" /></button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export default function StudentAssessmentPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const shownParam = params.get("results");
  const [data, setData] = useState<Opened | null>(null);
  const [responses, setResponses] = useState<Responses>({});
  const rowVersionRef = useRef(1);
  const submitRequestId = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [view, setView] = useState<View>({ kind: "start" });
  const [signatures, setSignatures] = useState<AttemptSignature[]>([]);
  const [declared, setDeclared] = useState(false);
  const [sig, setSig] = useState<SignatureValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [refOpen, setRefOpen] = useState<string | null>(null);
  const [refDrawer, setRefDrawer] = useState(false);
  const [allParts, setAllParts] = useState<Record<string, boolean>>({});
  const [ackSig, setAckSig] = useState<SignatureValue | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 20_000); return () => window.clearInterval(t); }, []);

  const loadSignatures = useCallback(async (attemptId: string) => setSignatures(await asmSignatures(attemptId)), []);
  const load = useCallback(async () => {
    try {
      const d = await asmStudent<Opened>("assessment_open", { assignmentId: id });
      setData(d); setResponses(d.attempt.responses ?? {}); rowVersionRef.current = d.attempt.rowVersion; setError("");
      void loadSignatures(d.attempt.id);
    } catch (e) { setError(e instanceof Error ? e.message : "The assessment did not load."); }
  }, [id, loadSignatures]);
  useEffect(() => { void load(); }, [load]);

  const attempt = data?.attempt; const definition = data?.version.definition;
  const editable = attempt?.state === "draft" && data?.assignment.status === "open";
  const declaration = signatures.find((s) => s.attemptId === attempt?.id && s.kind === "student_declaration") ?? null;
  const ackOf = (attemptId: string) => signatures.find((s) => s.attemptId === attemptId && s.kind === "student_acknowledgement") ?? null;
  // a returning student who signed this attempt goes straight to the work
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !attempt) return;
    // the declaration is signed for every attempt (a reassessment starts with the earlier answers copied in)
    if (declaration) { opened.current = true; setView({ kind: "task", index: 0 }); }
  }, [declaration, attempt]);

  const decided = useMemo(() => (data ? [...data.history, data.attempt] : []).filter((a) => a.state === "returned" || a.state === "final").sort((a, b) => a.attemptNo - b.attemptNo), [data]);
  const history = useAttemptHistory(attempt?.id, decided, null, decided.map((a) => a.id + a.state).join() + (attempt?.state ?? ""));
  const numbers = useMemo(() => (definition ? workbookNumbering(definition) : new Map()), [definition]);

  const save = useCallback(async (r: Responses) => {
    if (!attempt) return; setSaving(true);
    try { const out = await asmStudent<{ ok: boolean; rowVersion: number; savedAt: string }>("draft_save", { attemptId: attempt.id, responses: r, rowVersion: rowVersionRef.current }); rowVersionRef.current = out.rowVersion; setSavedAt(Date.now()); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved."); } finally { setSaving(false); }
  }, [attempt]);
  const change = (r: Responses) => { setResponses(r); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void save(r), 900); };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const onUpload = async (q: Question, files: FileList) => {
    if (!attempt || !data) return;
    const maxMb = Number((q.config?.maxMb as number | undefined) ?? (q.type !== "file_upload" ? attachmentSettings(q)?.maxMb : undefined) ?? data.settings.evidenceMaxMb);
    for (const file of Array.from(files)) {
      if (file.size > maxMb * 1024 * 1024) { setError(`${file.name} is larger than ${maxMb} MB.`); continue; }
      try { const { path, sha256 } = await uploadEvidence(attempt.id, q.id, file); await asmStudent("evidence_register", { attemptId: attempt.id, questionId: q.id, path, fileName: file.name, mime: file.type, bytes: file.size, sha256 }); }
      catch (e) { setError(e instanceof Error ? e.message : `${file.name} did not upload.`); }
    }
    await load();
  };
  const onRemoveEvidence = async (f: EvidenceFile) => { try { await asmStudent("evidence_remove", { id: f.id }); await removeEvidenceObject(f.path); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed."); } };
  const openEvidence = async (f: EvidenceFile) => { const w = window.open("", "_blank"); try { const u = await evidenceUrl(f.path); if (w) { w.opener = null; w.location.href = u; } } catch (e) { w?.close(); setError(e instanceof Error ? e.message : "The file could not be opened."); } };

  /** The declaration questions of the workbook are answered by the declaration signed at the start. */
  const withDeclaration = useCallback((r: Responses, name: string): Responses => {
    if (!definition) return r;
    const out = { ...r };
    for (const t of definition.tasks) for (const s of t.sections) for (const q of s.questions) if (q.type === "declaration" && !out[q.id]) out[q.id] = { agreed: true, signature: name };
    return out;
  }, [definition]);

  const start = async () => {
    if (!attempt || !data || !sig) return;
    setBusy(true); setError("");
    try {
      await asmSign(attempt.id, "student_declaration", sig.method, sig.png, data.settings.declarationText);
      await keepSignature(sig);
      await loadSignatures(attempt.id);
      setView({ kind: "task", index: 0 }); window.scrollTo({ top: 0 });
    } catch (e) { setError(e instanceof Error ? e.message : "The declaration was not signed."); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!attempt || !definition) return;
    const name = declaration?.signerName ?? history?.student?.name ?? "Student";
    const r = withDeclaration(responses, name);
    if (timer.current) window.clearTimeout(timer.current);
    setBusy(true);
    try {
      await save(r);
      const out = await asmStudent<{ ok: boolean; errors?: ValidationError[]; receiptNo?: string }>("submit", { attemptId: attempt.id, responses: r, rowVersion: rowVersionRef.current, declaration: { signature: name, agreed: true, signatureId: declaration?.id ?? null }, requestId: (submitRequestId.current ??= crypto.randomUUID()) });
      if (!out.ok) { setErrors(out.errors ?? []); return; }
      submitRequestId.current = null; setReceipt(out.receiptNo ?? ""); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Not submitted."); }
    finally { setBusy(false); }
  };
  const acknowledge = async (attemptId: string) => {
    if (!ackSig) return;
    setBusy(true); setError("");
    try { await asmSign(attemptId, "student_acknowledgement", ackSig.method, ackSig.png, "I have read the feedback on this assessment."); await keepSignature(ackSig); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not signed."); } finally { setBusy(false); }
  };
  const exportPdf = async (a: Attempt) => {
    if (!data) return; setExporting(true);
    try { await downloadWorkbookPdf({ definition: data.version.definition, attempt: a, history: history ?? historyFromAttempts(decided), title: data.assignment.title, maxAttempts: data.settings.maxAttempts, signatures }); }
    catch (e) { setError(e instanceof Error ? `The PDF was not made: ${e.message}` : "The PDF was not made."); } finally { setExporting(false); }
  };

  if (error && !data) return <div className="p-4"><PortalError message={error} onRetry={() => void load()} /><Link className="mt-3 inline-block text-sm underline" to="/agency/assessments">Back to my assessments</Link></div>;
  if (!data || !attempt || !definition) return <PortalLoading label="Loading the assessment…" />;

  const tasks = definition.tasks;
  const unitCode = data.assignment.unitCode ?? definition.source?.unit?.code ?? "";
  const unitName = data.assignment.unitName ?? definition.source?.unit?.name ?? data.assignment.title;
  const due = attempt.dueAt ?? data.assignment.dueAt;
  const savedLabel = saving ? "Saving…" : savedAt ? (Date.now() - savedAt < 60_000 ? "✓ Saved just now" : `✓ Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`) : "Your work saves as you go";
  const numberOf = (q: Question, ti: number, qi: number) => q.importMeta?.number ?? numbers.get(q.id)?.number ?? `${ti + 1}.${qi + 1}`;

  const topBar = (
    <div className="sticky top-0 z-30 -mx-4 mb-5 flex items-center justify-between gap-3 border-b border-background-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <p className="min-w-0 truncate text-sm text-foreground-600"><span className="font-semibold text-foreground-900">{unitCode}</span>{unitCode ? " · " : ""}{unitName}</p>
      {editable && view.kind !== "start" ? <p className={`shrink-0 text-sm font-semibold ${saving ? "text-foreground-500" : "text-green-700"}`} role="status" data-testid="autosave">{savedLabel}</p>
        : <p className="shrink-0 text-sm text-foreground-600">Due {fmtDate(due)}</p>}
    </div>
  );

  /* ---------------- results / submitted ---------------- */
  if (!editable || shownParam) {
    const shown = (shownParam ? [...data.history, attempt].find((a) => a.id === shownParam) : null) ?? attempt;
    const showResults = shown.state === "returned" || shown.state === "final";
    const outcomeOf = (taskId: string) => shown.taskResults.find((t) => t.taskId === taskId);
    const assessorSign = signatures.find((s) => s.attemptId === shown.id && s.kind === "assessor_signoff");
    return (
      <div className="mx-auto max-w-3xl px-0 pb-12 sm:px-2" data-testid="student-results">
        {topBar}
        <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">{unitCode} · {showResults ? "Your results" : shown.state === "draft" ? "Closed" : "Submitted"}</p>
        <h1 className="mt-1 font-heading text-2xl font-bold text-foreground-950 sm:text-3xl">{unitName}</h1>
        {error ? <div className="mt-3"><PortalError message={error} /></div> : null}
        {!showResults ? (
          <div className={`${CARD} mt-5`}>
            {shown.state === "draft" ? <p className="text-sm text-foreground-800">This assessment is closed.</p>
              : <p className="text-sm text-foreground-800"><i className="ri-time-line mr-1 text-primary-600" aria-hidden="true" />Submitted {fmtDateTime(shown.submittedAt)} · receipt <strong>{receipt || shown.receiptNo}</strong>. Your assessor is marking it; you will be told when the results are ready.</p>}
          </div>
        ) : (
          <>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {tasks.map((t, i) => { const r = outcomeOf(t.id); const ok = r?.outcome === "S"; return (
                <div key={t.id} className={CARD} data-testid="task-result">
                  <div className="flex items-start justify-between gap-2"><p className="font-heading text-base font-semibold text-foreground-950">Task {i + 1} · {t.title}</p>
                    {r?.outcome ? <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${ok ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}`}>{ok ? "Satisfactory" : "Not satisfactory"}</span> : null}</div>
                  <p className="mt-2 text-xs font-semibold text-foreground-600">Feedback</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground-800">{r?.feedback || "No feedback for this task."}</p>
                </div>
              ); })}
            </div>
            <div className={`${CARD} mt-3`}>
              <p className="text-sm text-foreground-600">Attempt {shown.attemptNo} outcome</p>
              <p className={`font-heading text-2xl font-bold ${shown.outcome === "S" ? "text-green-700" : "text-amber-800"}`}>{shown.outcome === "S" ? "Competent (C)" : shown.outcome ? "Not Yet Competent (NYC)" : "–"}</p>
              {shown.overallFeedback ? <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-800">{shown.overallFeedback}</p> : null}
              {assessorSign ? <p className="mt-2 text-xs text-foreground-500">Signed off by {assessorSign.signerName} on {fmtDate(assessorSign.signedAt)}</p> : null}
            </div>
            <div className={`${CARD} mt-3`} data-testid="acknowledge">
              {ackOf(shown.id) ? (
                <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-foreground-800"><i className="ri-checkbox-circle-line mr-1 text-green-600" aria-hidden="true" />You acknowledged the feedback on {fmtDate(ackOf(shown.id)?.signedAt)}.</p><SignatureImage png={ackOf(shown.id)?.signaturePng ?? null} name={ackOf(shown.id)?.signerName} /></div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-foreground-800">Sign to say you have read the results and the feedback.</p>
                  <SignatureField value={ackSig} onChange={setAckSig} />
                  <button type="button" className={PRIMARY} disabled={!ackSig || busy} onClick={() => void acknowledge(shown.id)}>Sign to acknowledge</button>
                </div>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {shown.state === "final" ? <button type="button" className={SECONDARY} disabled={exporting} onClick={() => void exportPdf(shown)}><i className="ri-file-pdf-2-line" aria-hidden="true" />{exporting ? "Making the PDF…" : "Export as workbook PDF"}</button> : null}
            </div>
            {shown.state === "final" && shown.outcome === "NYS" && !shown.reassessments.some((r) => r.state === "requested") ? (
              <div className={`${CARD} mt-3 flex flex-wrap items-center gap-2`}><input className={`${FIELD} min-w-[12rem] flex-1`} placeholder="Why you are asking for a reassessment" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button type="button" className={SECONDARY} onClick={() => void asmStudent("reassessment_request", { attemptId: shown.id, reason }).then(() => { setReason(""); return load(); }).catch((e) => setError(e instanceof Error ? e.message : "Not sent."))}>Request reassessment</button></div>
            ) : null}
          </>
        )}
        {shown.state !== "draft" ? (
          <div className={`${CARD} mt-3`}>
            <p className="text-sm font-semibold text-foreground-900">Message your assessor</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row"><textarea rows={2} className={`${FIELD} flex-1`} placeholder="A question or a note about this assessment" value={message} onChange={(e) => setMessage(e.target.value)} />
              <button type="button" className={SECONDARY} disabled={!message.trim()} onClick={() => void asmStudent("feedback_post", { attemptId: shown.id, body: message }).then(() => { setMessage(""); return load(); }).catch((e) => setError(e instanceof Error ? e.message : "Not sent."))}>Send</button></div>
          </div>
        ) : null}
        {editable ? <button type="button" className="mt-5 mr-4 cursor-pointer text-sm font-semibold text-primary-700 hover:underline" onClick={() => setParams({})}>← Back to attempt {attempt.attemptNo}</button> : null}
        <Link className="mt-5 inline-block text-sm font-semibold text-primary-700 hover:underline" to="/agency/assessments">← All assessments</Link>
      </div>
    );
  }

  /* ---------------- before you start ---------------- */
  if (view.kind === "start") {
    const rules = definition.instructions || data.settings.instructions;
    return (
      <div className="mx-auto max-w-3xl pb-12" data-testid="before-you-start">
        {topBar}
        <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">{unitCode} · Before you start</p>
        <h1 className="mt-1 font-heading text-2xl font-bold text-foreground-950 sm:text-3xl">{unitName}</h1>
        <p className="mt-1 text-sm text-foreground-600">{tasks.length} task{tasks.length === 1 ? "" : "s"} · due {fmtDate(due)} · your work saves as you go</p>
        {error ? <div className="mt-3"><PortalError message={error} /></div> : null}
        <section className={`${CARD} mt-5`} data-testid="assessment-details">
          <div className="flex items-center justify-between"><h2 className="font-heading text-base font-semibold text-foreground-950">Your details</h2><span className="text-xs font-semibold text-green-700">Filled in for you</span></div>
          <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {([["Student", history?.student?.name], ["Student ID", history?.student?.ref], ["Trainer", history?.trainers?.join(", ")], ["Qualification", history?.assessment?.qualification?.code ?? definition.source?.qualification?.code], ["Unit", `${unitCode} ${unitName}`.trim()]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-xs text-foreground-500">{k}</dt><dd className="font-semibold text-foreground-900">{v || "–"}</dd></div>
            ))}
          </dl>
        </section>
        <section className={`${CARD} mt-3`}>
          <h2 className="font-heading text-base font-semibold text-foreground-950">What you’ll do</h2>
          <ol className="mt-3 space-y-2.5">
            {tasks.map((t, i) => { const qs = studentQuestions(t); const files = qs.some((q) => q.type === "file_upload" || q.config?.allowAttachment === true); return (
              <li key={t.id} className="flex items-start gap-3 text-sm"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-50 font-semibold text-primary-700">{i + 1}</span>
                <span className="pt-1 text-foreground-800"><strong className="text-foreground-950">{t.title}</strong> · {qs.length} question{qs.length === 1 ? "" : "s"}{files ? ", upload your evidence" : ""}</span></li>
            ); })}
          </ol>
          {rules ? <button type="button" className="mt-3 cursor-pointer text-sm font-semibold text-primary-700 underline underline-offset-2" onClick={() => setRulesOpen(true)}>Read the full instructions and rules ›</button> : null}
        </section>
        <section className={`${CARD} mt-3 space-y-4`}>
          <label className="flex cursor-pointer items-start gap-3 text-sm text-foreground-800"><input type="checkbox" className="mt-0.5 h-5 w-5 accent-primary-600" checked={declared} onChange={(e) => setDeclared(e.target.checked)} data-testid="declare" />
            <span className="whitespace-pre-wrap">{data.settings.declarationText || "I declare this work is my own, I have read the plagiarism and collusion rules, and I agree my work may be checked by a plagiarism service."}</span></label>
          {declared ? <SignatureField value={sig} onChange={setSig} /> : null}
        </section>
        <button type="button" className={`${PRIMARY} mt-4 w-full`} disabled={!declared || !sig || busy} onClick={() => void start()} data-testid="start-task">{busy ? "Signing…" : `Start Task 1 →`}</button>
        {rulesOpen ? <Drawer title="Instructions and rules" onClose={() => setRulesOpen(false)}><div className="rounded-xl bg-white p-4"><AssessmentInfo text={rules} /></div></Drawer> : null}
      </div>
    );
  }

  /* ---------------- review & submit ---------------- */
  const rail = (
    <nav className={`${CARD} space-y-1 p-3`} aria-label="Tasks">
      <button type="button" className="flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-foreground-600 hover:bg-background-100" onClick={() => setView({ kind: "start" })} disabled={Boolean(declaration)}>Before you start {declaration ? <i className="ri-check-line text-green-600" aria-label="Done" /> : null}</button>
      {tasks.map((t, i) => { const p = taskProgress(t, responses, attempt.evidence); const on = view.kind === "task" && view.index === i; return (
        <button key={t.id} type="button" onClick={() => { setView({ kind: "task", index: i }); window.scrollTo({ top: 0 }); }} aria-current={on ? "page" : undefined} data-testid="task-rail-item"
          className={`block w-full cursor-pointer rounded-lg px-3 py-2 text-left ${on ? "bg-primary-50" : "hover:bg-background-100"}`}>
          <span className={`block text-sm font-semibold ${on ? "text-primary-800" : "text-foreground-900"}`}>Task {i + 1} · {t.title.replace(/^Task\s*\d+\s*[:·-]?\s*/i, "").split(/[(:]/)[0].trim() || t.title}</span>
          <span className="block text-xs text-foreground-500">{p.answered} of {p.total} answered</span>
          {on ? <span className="mt-1 block h-1 overflow-hidden rounded-full bg-primary-100"><span className="block h-full rounded-full bg-primary-600" style={{ width: `${p.total ? Math.round(100 * p.answered / p.total) : 0}%` }} /></span> : null}
        </button>
      ); })}
      <button type="button" className={`w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm ${view.kind === "review" ? "bg-primary-50 font-semibold text-primary-800" : "text-foreground-600 hover:bg-background-100"}`} onClick={() => { setView({ kind: "review" }); window.scrollTo({ top: 0 }); }}>Review &amp; submit</button>
    </nav>
  );

  if (view.kind === "review") {
    const errorIds = new Set(errors.map((e) => e.questionId.split(".")[0]));
    return (
      <div className="pb-12">
        {topBar}
        <div className="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
          <div className="hidden lg:block">{rail}</div>
          <div className="min-w-0 space-y-4" data-testid="review-submit">
            <h1 className="font-heading text-2xl font-bold text-foreground-950">Review &amp; submit</h1>
            {error ? <PortalError message={error} /> : null}
            {errors.length ? <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">{errors.length} answer{errors.length === 1 ? " is" : "s are"} still needed before you can submit.</p> : null}
            {tasks.map((t, ti) => { const qs = studentQuestions(t); const p = taskProgress(t, responses, attempt.evidence); return (
              <section key={t.id} className={CARD}>
                <div className="flex items-center justify-between gap-2"><h2 className="font-heading text-base font-semibold text-foreground-950">Task {ti + 1} · {t.title}</h2><span className={`text-xs font-semibold ${p.answered === p.total ? "text-green-700" : "text-amber-800"}`}>{p.answered} of {p.total} answered</span></div>
                <ul className="mt-2 divide-y divide-background-100">
                  {qs.map((q, qi) => { const ok = isAnswered(q, responses, attempt.evidence); return (
                    <li key={q.id}><button type="button" className="flex w-full cursor-pointer items-center gap-3 py-2 text-left" onClick={() => { setView({ kind: "task", index: ti }); window.setTimeout(() => document.getElementById(`q-${q.id}`)?.scrollIntoView({ block: "center" }), 50); }}>
                      {ok ? <i className="ri-checkbox-circle-fill text-green-600" aria-label="Answered" /> : <i className={`ri-checkbox-blank-circle-line ${errorIds.has(q.id) ? "text-amber-600" : "text-foreground-400"}`} aria-label="Not answered" />}
                      <span className="w-14 shrink-0 text-sm font-semibold text-foreground-900">{numberOf(q, ti, qi)}</span>
                      <span className={`min-w-0 flex-1 truncate text-sm ${ok ? "text-foreground-600" : "text-foreground-900"}`}>{q.label}</span>
                    </button></li>
                  ); })}
                </ul>
              </section>
            ); })}
            <section className={CARD}>
              <p className="text-sm text-foreground-800">When you submit, your answers are locked and you get a receipt number. Your declaration{declaration ? `, signed ${fmtDateTime(declaration.signedAt)},` : ""} goes with it.</p>
              <button type="button" className={`${PRIMARY} mt-3`} disabled={busy} onClick={() => void submit()} data-testid="submit">{busy ? "Submitting…" : "Submit assessment"}</button>
            </section>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- one task a page ---------------- */
  const ti = view.index; const task = tasks[ti];
  const questions = studentQuestions(task);
  const refs = referenceItems(task, ti + 1);
  const errorFor = (qid: string) => errors.find((e) => e.questionId === qid || e.questionId.startsWith(`${qid}.`))?.message;
  const renderParts = (q: Question) => {
    const parts = (q.children ?? []).filter((c) => isAnswerable(c));
    const scope = (responses[q.id] as Responses | undefined) ?? {};
    const shown = allParts[q.id] ? parts : parts.slice(0, 3);
    const setPart = (cid: string, v: unknown) => change({ ...responses, [q.id]: { ...scope, [cid]: v } });
    const letter = (c: Question, i: number) => (c.importMeta?.number?.match(/[a-z]+$/)?.[0]) ?? String.fromCharCode(97 + i);
    return (
      <div className="space-y-2">
        {shown.map((c, i) => (
          <div key={c.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-2 sm:grid-cols-[1.5rem_minmax(0,14rem)_minmax(0,1fr)] sm:items-center" data-part={c.id}>
            <span className="pt-2 text-sm font-semibold text-foreground-600 sm:pt-0">{letter(c, i)}</span>
            <span className="text-sm text-foreground-700 sm:text-foreground-600">{c.label}</span>
            <div className="col-span-2 sm:col-span-1">{["short_answer", "long_answer"].includes(c.type)
              ? <input className={FIELD} value={String(scope[c.id] ?? "").replace(/<[^>]*>/g, "")} onChange={(e) => setPart(c.id, e.target.value)} aria-label={`${letter(c, i)}. ${c.label}`} />
              : <TypeInput q={c} value={scope[c.id]} onChange={(v) => setPart(c.id, v)} evidence={attempt.evidence} onUpload={onUpload} onRemoveEvidence={onRemoveEvidence} openEvidence={(f) => void openEvidence(f)} />}</div>
          </div>
        ))}
        {parts.length > 3 && !allParts[q.id] ? <button type="button" className="cursor-pointer text-sm text-foreground-600 hover:text-primary-700" onClick={() => setAllParts((m) => ({ ...m, [q.id]: true }))}>+ {parts.length - 3} more parts ({letter(parts[3], 3)}–{letter(parts[parts.length - 1], parts.length - 1)})</button> : null}
      </div>
    );
  };
  const referencePanel = (
    <div className="space-y-3">
      {refs.map((r) => (
        <div key={r.id} className="overflow-hidden rounded-xl border border-background-200 bg-white" data-testid="reference-item">
          {r.hasPicture ? <div className="asm-content max-h-40 overflow-hidden bg-background-100 [&_img]:mx-auto [&_img]:max-h-40 [&_img]:object-contain [&_p]:hidden" dangerouslySetInnerHTML={{ __html: sanitize(r.html.replace(/<(p|figcaption|table)[\s\S]*?<\/\1>/gi, "")) }} /> : null}
          <button type="button" className="block w-full cursor-pointer px-3 py-2 text-left hover:bg-background-50" onClick={() => setRefOpen(r.id)}>
            <span className="block text-sm font-semibold text-foreground-900">{r.title}{r.page ? <span className="font-normal text-foreground-500"> · from page {r.page}</span> : null}</span>
            {!r.hasPicture ? <span className="mt-0.5 line-clamp-2 block text-xs text-foreground-600">{r.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
  const openRef = refs.find((r) => r.id === refOpen);
  return (
    <div className="pb-12">
      {topBar}
      <div className="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)_260px]">
        <div className="hidden lg:block">{rail}</div>
        <div className="min-w-0 space-y-4" data-testid="task-page">
          <div className="lg:hidden"><details className={`${CARD} p-3`}><summary className="cursor-pointer text-sm font-semibold text-foreground-900">Task {ti + 1} of {tasks.length} · {taskProgress(task, responses, attempt.evidence).answered} of {questions.length} answered</summary><div className="mt-2">{rail}</div></details></div>
          <div className="flex items-start justify-between gap-3">
            <h1 className="font-heading text-xl font-bold text-foreground-950 sm:text-2xl">Task {ti + 1} · {task.title.replace(/^Task\s*\d+\s*[:·-]?\s*/i, "")}</h1>
            {refs.length ? <button type="button" className={`${SECONDARY} shrink-0 lg:hidden`} onClick={() => setRefDrawer(true)}>Reference ({refs.length})</button> : null}
          </div>
          {error ? <PortalError message={error} /> : null}
          {questions.map((q, qi) => {
            const err = errorFor(q.id);
            return (
              <section key={q.id} id={`q-${q.id}`} data-question={q.id} className={`${CARD} ${err ? "border-amber-400" : ""}`}>
                <p className="text-base text-foreground-950"><span className="mr-1.5 font-semibold text-primary-600">{numberOf(q, ti, qi)}</span>{q.label}</p>
                {q.helpText ? <p className="mt-0.5 text-xs text-foreground-600">{q.helpText}</p> : null}
                <div className="mt-3">{q.children?.length ? renderParts(q) : <TypeInput q={q} value={responses[q.id]} onChange={(v) => change({ ...responses, [q.id]: v })} evidence={attempt.evidence} onUpload={onUpload} onRemoveEvidence={onRemoveEvidence} openEvidence={(f) => void openEvidence(f)} />}</div>
                {err ? <p role="alert" className="mt-2 text-xs font-medium text-amber-800">{err}</p> : null}
              </section>
            );
          })}
          {!questions.length ? <p className={CARD}>Nothing to answer in this task: read the reference material.</p> : null}
          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" className="cursor-pointer text-sm font-semibold text-foreground-600 hover:text-foreground-900" onClick={() => { setView(ti === 0 ? (declaration ? { kind: "task", index: 0 } : { kind: "start" }) : { kind: "task", index: ti - 1 }); window.scrollTo({ top: 0 }); }} disabled={ti === 0 && Boolean(declaration)}>{ti === 0 ? (declaration ? "" : "← Before you start") : `← Task ${ti}`}</button>
            <button type="button" className={PRIMARY} onClick={() => { setView(ti + 1 < tasks.length ? { kind: "task", index: ti + 1 } : { kind: "review" }); window.scrollTo({ top: 0 }); }} data-testid="next">{ti + 1 < tasks.length ? `Next: Task ${ti + 2} →` : "Review & submit →"}</button>
          </div>
        </div>
        {refs.length ? <aside className="hidden lg:block"><div className={`${CARD} sticky top-20 p-3`}><p className="mb-2 font-heading text-sm font-semibold text-foreground-950">Reference</p>{referencePanel}</div></aside> : <div className="hidden lg:block" />}
      </div>
      {refDrawer ? <Drawer title={`Reference (${refs.length})`} onClose={() => setRefDrawer(false)}>{referencePanel}</Drawer> : null}
      {openRef ? <Drawer title={openRef.title} onClose={() => setRefOpen(null)}><div className="asm-content rounded-xl bg-white p-4 text-sm [&_img]:max-w-full [&_table]:w-full" dangerouslySetInnerHTML={{ __html: sanitize(openRef.html) }} /></Drawer> : null}
    </div>
  );
}
