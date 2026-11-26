/**
 * The student's assessment (ASM-IMPORT-SIMPLE, owner 2026-11-26): an assessment is a template, done as a wizard.
 *   Before you start  details filled in (student, student ID, trainer, qualification, unit), what you'll do, the full instructions one
 *                     tap away, Start.
 *   One step a section  each task's sections in reading order: instructions to read, questions with one answer box each (a form
 *                     question's box starts with its printed fields and headings), uploads; numbers exactly as printed; autosave.
 *   Declaration       the fixed last step: unanswered questions listed, "this is my own work" ticked with the student's name and
 *                     today's date, then submit (the declaration is saved with the submission: asm_attempts.declaration).
 *   Results           per question Satisfactory / Not satisfactory with the assessor's comment, per task (worked out from its
 *                     questions), the overall outcome; the student signs to acknowledge the feedback (asm_sign student_acknowledgement).
 * The workbook layout appears only in "Export as workbook PDF".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { loginUrl } from "@/lib/loginRouting";
import { supabase } from "@/pages/admin/lib/supabase";
import UnsavedGuard from "@/components/assessment/UnsavedGuard";
import { draftKey, localDraftStore, saveLabel as saveLabelOf, saveTone, useAutosave, type DraftStore } from "@/lib/assessment/autosave";
import { PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { AssessmentInfo } from "@/components/assessment/AssessmentRenderer";
import { sanitize } from "@/components/assessment/registry";
import { TypeInput } from "@/components/assessment/TypeParts";
import SignatureField, { SignatureImage } from "@/components/assessment/SignatureField";
import { useAttemptHistory } from "@/components/assessment/useAttemptHistory";
import { historyFromAttempts } from "@/lib/assessment/resultsSheet";
import { downloadWorkbookPdf } from "@/lib/assessment/workbookExport";
/** The number printed in the workbook (kept on the item by the import), or null. */
const printedNumber = (q: Question): string | null => q.importMeta?.number ?? null;
import { isAnswered, studentQuestions, studentSteps, taskProgress, ACKNOWLEDGEMENT_TEXT, DECLARATION_TEXT } from "@/lib/assessment/studentFlow";
import { downloadWorkbook, loadPdfAttempt, loadStudentTemplate, pdfSign, pdfSignatures, type PdfSignature } from "@/lib/assessment/pdfTemplate/api";
import type { PdfBundle } from "@/lib/assessment/pdfTemplate/output";
import PdfResults from "./PdfResults";
import type { PdfTemplate } from "@/lib/assessment/pdfTemplate/model";
import PdfWizard from "./PdfWizard";
import { attachmentSettings, isAnswerable } from "@/lib/assessment/registry";
import {
  asmSign, asmSignatures, asmStudent, evidenceUrl, fmtDate, fmtDateTime, keepSignature, removeEvidenceObject, uploadEvidence,
  type AttemptSignature, type SignatureValue,
} from "@/lib/assessment/api";
import type { Attempt, Definition, EvidenceFile, Question, Responses, ValidationError } from "@/lib/assessment/types";

interface Opened {
  assignment: { id: string; title: string; description: string; dueAt: string; lateUntil: string | null; status: string; unitCode: string | null; unitName: string | null };
  version: { id: string; versionNo: number; definition: Definition };
  settings: { declarationText: string; instructions: string; maxAttempts: number; lateSubmission: string; evidenceMaxMb: number; evidenceAllowedTypes: string[] };
  attempt: Attempt; history: Attempt[];
}
type View = { kind: "start" } | { kind: "step"; index: number } | { kind: "declare" };

const CARD = "rounded-2xl border border-background-200 bg-white p-4 sm:p-5";
const PRIMARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-background-300 bg-white px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 focus:border-primary-400 focus:bg-white focus:outline-none";
const taskLabel = (t: { number?: string | null; title: string }, i: number) => `${t.number || `Task ${i + 1}`} · ${t.title}`;

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
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [view, setView] = useState<View>({ kind: "start" });
  const [signatures, setSignatures] = useState<AttemptSignature[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [declName, setDeclName] = useState("");
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ackSig, setAckSig] = useState<SignatureValue | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  // ASM-PDF-TEMPLATE phase 2: an assessment answered on its workbook PDF (its template and the file)
  const [pdfTpl, setPdfTpl] = useState<{ template: PdfTemplate; bytes: Uint8Array | null } | null>(null);
  const [pdfErrors, setPdfErrors] = useState<string[]>([]);
  const [pdfSigs, setPdfSigs] = useState<PdfSignature[]>([]);
  const [pdfChecked, setPdfChecked] = useState(false);
  const [prevPdf, setPrevPdf] = useState<PdfBundle | null>(null);
  const [, tick] = useState(0);
  const location = useLocation();
  // autosave (owner 2026-11-26): retried until it goes through, kept in this browser until the server has it, offline / signed-out
  // states shown, saved again when back online or signed in again
  const attemptIdRef = useRef("");
  const userIdRef = useRef("");
  const draftStore = useMemo<DraftStore<Responses>>(() => ({
    save: (v) => { if (attemptIdRef.current && userIdRef.current) localDraftStore<Responses>(draftKey(userIdRef.current, attemptIdRef.current)).save(v); },
    clear: () => { if (attemptIdRef.current && userIdRef.current) localDraftStore<Responses>(draftKey(userIdRef.current, attemptIdRef.current)).clear(); },
  }), []);
  const autosave = useAutosave<Responses>(async (r) => {
    const out = await asmStudent<{ ok: boolean; rowVersion: number; savedAt: string }>("draft_save", { attemptId: attemptIdRef.current, responses: r, rowVersion: rowVersionRef.current });
    rowVersionRef.current = out.rowVersion;
  }, { store: draftStore, resumeOn: (resume) => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") resume(); });
    return () => sub.subscription.unsubscribe();
  } });
  const queueSave = autosave.queue;
  const [leaving, setLeaving] = useState(false);
  // Sign in again: the answers are in this browser; the login page brings the student back here, where they are saved
  useEffect(() => { if (leaving) window.location.assign(loginUrl(location.pathname + location.search, true)); }, [leaving, location.pathname, location.search]);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 20_000); return () => window.clearInterval(t); }, []);

  const loadSignatures = useCallback(async (attemptId: string) => setSignatures(await asmSignatures(attemptId)), []);
  const load = useCallback(async () => {
    try {
      const d = await asmStudent<Opened>("assessment_open", { assignmentId: id });
      setData(d); rowVersionRef.current = d.attempt.rowVersion; attemptIdRef.current = d.attempt.id; setError("");
      // answers this student typed here and not yet on the server (offline, signed out, closed before the save) come back and are
      // saved; the key carries the signed-in person, so another student on this browser never sees them
      userIdRef.current = (await supabase.auth.getSession()).data.session?.user.id ?? "";
      const local = localDraftStore<Responses>(draftKey(userIdRef.current, d.attempt.id));
      const kept = userIdRef.current && d.attempt.state === "draft" && d.assignment.status === "open" ? local.read() : null;
      if (kept && JSON.stringify(kept.v) !== JSON.stringify(d.attempt.responses ?? {})) { setResponses(kept.v); queueSave(kept.v); }
      else { if (kept) local.clear(); setResponses(d.attempt.responses ?? {}); } // a kept copy equal to the server's is saved: deleted
      void loadSignatures(d.attempt.id);
      const tpl = await loadStudentTemplate(d.attempt.id);
      if (tpl) {
        void pdfSignatures(d.attempt.id).then(setPdfSigs);
        setPdfTpl((cur) => cur?.template.pdf.path === tpl.pdf.path ? { ...cur, template: tpl } : { template: tpl, bytes: null });
        void downloadWorkbook(tpl.pdf.path).then((bytes) => setPdfTpl((cur) => cur && cur.template.pdf.path === tpl.pdf.path ? { ...cur, bytes } : cur)).catch(() => setError("The workbook PDF could not be opened."));
      } else setPdfTpl(null);
      setPdfChecked(true);
    } catch (e) { setError(e instanceof Error ? e.message : "The assessment did not load."); }
  }, [id, loadSignatures, queueSave]);
  useEffect(() => { void load(); }, [load]);

  const attempt = data?.attempt; const definition = data?.version.definition;
  const editable = attempt?.state === "draft" && data?.assignment.status === "open";
  const ackOf = (attemptId: string) => signatures.find((s) => s.attemptId === attemptId && s.kind === "student_acknowledgement") ?? null;
  // a returning student who has started this attempt goes straight to the work
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !attempt) return;
    opened.current = true;
    if (Object.keys(attempt.responses ?? {}).length || attempt.evidence.length) setView({ kind: "step", index: 0 });
  }, [attempt]);

  const decided = useMemo(() => (data ? [...data.history, data.attempt] : []).filter((a) => a.state === "returned" || a.state === "final").sort((a, b) => a.attemptNo - b.attemptNo), [data]);
  const history = useAttemptHistory(attempt?.id, decided, null, decided.map((a) => a.id + a.state).join() + (attempt?.state ?? ""));
  const steps = useMemo(() => (definition ? studentSteps(definition) : []), [definition]);
  const prevReturned = useMemo(() => (data?.history ?? []).filter((h) => h.state === "returned").sort((x, y) => x.attemptNo - y.attemptNo).pop()?.id ?? null, [data?.history]);
  useEffect(() => {
    if (!pdfTpl || !prevReturned) { setPrevPdf(null); return; }
    let off = false;
    void loadPdfAttempt(prevReturned).then((b) => { if (!off) setPrevPdf(b); }).catch(() => { if (!off) setPrevPdf(null); });
    return () => { off = true; };
  }, [pdfTpl, prevReturned]);
  // the student's name for the declaration (editable, filled in from their record)
  useEffect(() => { if (!declName && history?.student?.name) setDeclName(history.student.name); }, [history?.student?.name, declName]);

  const change = (r: Responses) => { setResponses(r); queueSave(r); };
  /** Submit waits for the save; when it does not go through, the student is told why and nothing is submitted. */
  const unsavedReason = (): string => {
    const st = autosave.current().state;
    if (st === "offline") return "You are offline. Your latest answers are kept on this device and will save when you reconnect; submit after that.";
    if (st === "expired") return "Your sign-in has expired. Sign in again to save your latest answers, then submit.";
    return "Your latest answers are not saved yet (retrying). Submit once they show as saved.";
  };

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

  const submit = async () => {
    if (!attempt || !definition || !agreed || declName.trim().length < 2) return;
    if (!(await autosave.flush())) { setError(unsavedReason()); return; }
    setBusy(true);
    try {
      const out = await asmStudent<{ ok: boolean; errors?: ValidationError[]; receiptNo?: string }>("submit", { attemptId: attempt.id, responses, rowVersion: rowVersionRef.current, declaration: { signature: declName.trim(), agreed: true }, requestId: (submitRequestId.current ??= crypto.randomUUID()) });
      if (!out.ok) { setErrors(out.errors ?? []); return; }
      submitRequestId.current = null; setReceipt(out.receiptNo ?? ""); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Not submitted."); }
    finally { setBusy(false); }
  };
  const acknowledge = async (attemptId: string) => {
    if (!ackSig) return;
    setBusy(true); setError("");
    try { await asmSign(attemptId, "student_acknowledgement", ackSig.method, ackSig.png, ACKNOWLEDGEMENT_TEXT); await keepSignature(ackSig); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not signed."); } finally { setBusy(false); }
  };
  const exportPdf = async (a: Attempt) => {
    if (!data) return; setExporting(true);
    try { await downloadWorkbookPdf({ definition: data.version.definition, attempt: a, history: history ?? historyFromAttempts(decided), title: data.assignment.title, maxAttempts: data.settings.maxAttempts, signatures }); }
    catch (e) { setError(e instanceof Error ? `The PDF was not made: ${e.message}` : "The PDF was not made."); } finally { setExporting(false); }
  };

  if (error && !data) return <div className="p-4"><PortalError message={error} onRetry={() => void load()} /><Link className="mt-3 inline-block text-sm underline" to="/agency/assessments">Back to my assessments</Link></div>;
  if (!data || !attempt || !definition || !pdfChecked) return <PortalLoading label="Loading the assessment…" />;

  const tasks = definition.tasks;
  const unitCode = data.assignment.unitCode ?? definition.source?.unit?.code ?? "";
  const unitName = data.assignment.unitName ?? definition.source?.unit?.name ?? data.assignment.title;
  const due = attempt.dueAt ?? data.assignment.dueAt;
  const savedLabel = saveLabelOf(autosave.status, "Your work saves as you go");
  const signInAgain = autosave.status.state === "expired"
    ? <button type="button" className="min-h-[36px] rounded-lg bg-primary-600 px-3 text-xs font-semibold text-white" onClick={() => setLeaving(true)} data-testid="sign-in-again">Sign in again</button> : null;
  const guard = <UnsavedGuard when={Boolean(editable) && autosave.pending && !leaving}
    message="They are kept on this device and will be saved when you come back to this assessment. Stay to let them save now." />;
  const go = (v: View) => { setView(v); window.scrollTo({ top: 0 }); };

  const topBar = (
    <div className="sticky top-0 z-30 -mx-4 mb-5 flex items-center justify-between gap-3 border-b border-background-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <p className="min-w-0 truncate text-sm text-foreground-600"><span className="font-semibold text-foreground-900">{unitCode}</span>{unitCode ? " · " : ""}{unitName}</p>
      {guard}
      {editable && view.kind !== "start" ? <div className="flex shrink-0 items-center gap-2"><p className={`text-sm font-semibold ${saveTone(autosave.status)}`} role="status" data-testid="autosave">{savedLabel}</p>{signInAgain}</div>
        : <p className="shrink-0 text-sm text-foreground-600">Due {fmtDate(due)}</p>}
    </div>
  );

  /* ---------------- results / submitted ---------------- */
  /* ---------------- ASM-PDF-TEMPLATE: a submitted attempt on the workbook PDF (replaces the results view below) ---------------- */
  if (pdfTpl && (!editable || shownParam)) {
    const all = [...data.history, attempt];
    const shown = (shownParam ? all.find((a) => a.id === shownParam) : null) ?? attempt;
    if (shown.state !== "draft") return <div className="px-0 sm:px-2" data-testid="student-results">
      {topBar}
      {error ? <div className="mb-3"><PortalError message={error} /></div> : null}
      <PdfResults attemptId={shown.id} unit={`${unitCode} ${unitName}`.trim()} receipt={shown.id === attempt.id ? receipt ?? shown.receiptNo ?? null : shown.receiptNo ?? null}
        otherAttempts={all.filter((x) => x.id !== shown.id && x.state !== "draft" && x.state !== "void").map((x) => ({ id: x.id, attemptNo: x.attemptNo, state: x.state }))}
        nextOpen={attempt.state === "draft" && attempt.id !== shown.id} />
    </div>;
  }

  if (!editable || shownParam) {
    const shown = (shownParam ? [...data.history, attempt].find((a) => a.id === shownParam) : null) ?? attempt;
    const showResults = shown.state === "returned" || shown.state === "final";
    const outcomeOf = (taskId: string) => shown.taskResults.find((t) => t.taskId === taskId);
    const markOf = (qid: string) => (shown.results ?? []).find((r) => r.questionId === qid && !r.criterionId);
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
            <div className={`${CARD} mt-5`}>
              <p className="text-sm text-foreground-600">Attempt {shown.attemptNo} outcome</p>
              <p className={`font-heading text-2xl font-bold ${shown.outcome === "S" ? "text-green-700" : "text-amber-800"}`} data-testid="overall-outcome">{shown.outcome === "S" ? "Competent (C)" : shown.outcome ? "Not Yet Competent (NYC)" : "–"}</p>
              {shown.overallFeedback ? <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-800">{shown.overallFeedback}</p> : null}
              {assessorSign ? <p className="mt-2 text-xs text-foreground-500">Signed off by {assessorSign.signerName} on {fmtDate(assessorSign.signedAt)}</p> : null}
            </div>
            {tasks.map((t, i) => { const r = outcomeOf(t.id); const ok = r?.outcome === "S"; const qs = studentQuestions(t); return (
              <section key={t.id} className={`${CARD} mt-3`} data-testid="task-result">
                <div className="flex items-start justify-between gap-2"><h2 className="font-heading text-base font-semibold text-foreground-950">{taskLabel(t, i)}</h2>
                  {r?.outcome ? <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${ok ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}`}>{ok ? "Satisfactory" : "Not satisfactory"}</span> : null}</div>
                {r?.feedback ? <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-800">{r.feedback}</p> : null}
                <ul className="mt-2 divide-y divide-background-100">
                  {qs.map((q) => { const m = markOf(q.id); return (
                    <li key={q.id} className="flex items-start gap-3 py-2 text-sm">
                      <span className="w-16 shrink-0 font-semibold text-foreground-900">{printedNumber(q) ?? ""}</span>
                      <span className="min-w-0 flex-1"><span className="line-clamp-2 text-foreground-700">{q.label}</span>{m?.feedback ? <span className="mt-0.5 block whitespace-pre-wrap text-foreground-900"><i className="ri-chat-1-line mr-1 text-foreground-500" aria-hidden="true" />{m.feedback}</span> : null}</span>
                      {m?.outcome ? <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${m.outcome === "S" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"}`}>{m.outcome === "S" ? "Yes" : "No"}</span> : null}
                    </li>
                  ); })}
                </ul>
              </section>
            ); })}
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
  /* ---------------- ASM-PDF-TEMPLATE: answered on the workbook PDF ---------------- */
  if (pdfTpl) {
    const studentName = history?.student?.name ?? declName;
    const submitPdf = async () => {
      setPdfErrors([]);
      if (!(await autosave.flush())) { setPdfErrors([unsavedReason()]); return; }
      setBusy(true);
      try {
        const out = await asmStudent<{ ok: boolean; errors?: ValidationError[]; receiptNo?: string }>("submit", { attemptId: attempt.id, responses, rowVersion: rowVersionRef.current,
          declaration: { signature: (studentName || "Student").trim(), agreed: true }, requestId: (submitRequestId.current ??= crypto.randomUUID()) });
        if (!out.ok) { setPdfErrors((out.errors ?? []).map((e) => e.message)); return; }
        submitRequestId.current = null; setReceipt(out.receiptNo ?? ""); await load();
      } catch (e) { setError(e instanceof Error ? e.message : "Not submitted."); }
      finally { setBusy(false); }
    };
    return <div className="px-0 sm:px-2">
      {guard}
      {error ? <div className="mb-3"><PortalError message={error} /></div> : null}
      <PdfWizard previous={prevPdf ? previousOf(prevPdf) : null} template={pdfTpl.template} pdfBytes={pdfTpl.bytes} responses={responses} onChange={change}
        saveClass={saveTone(autosave.status)} saveAction={signInAgain} savedLabel={autosave.status.state === "idle" ? "" : savedLabel}
        dueLabel={`Due ${fmtDate(due)}`} signatures={pdfSigs} busy={busy} serverErrors={pdfErrors} onSubmit={submitPdf}
        onSign={async (slot, v, statement) => { await pdfSign(attempt.id, slot, v ? (v.method === "saved" ? "saved" : v.method) : "saved", v?.png ?? null, statement); if (v) await keepSignature({ ...v, keep: true }); setPdfSigs(await pdfSignatures(attempt.id)); }}
        record={{ studentName: studentName ?? "", studentRef: history?.student?.ref ?? "", studentEmail: history?.student?.email ?? "", trainer: (history?.trainers ?? []).join(", "),
          unitCode, unitName, qualificationCode: history?.assessment?.qualification?.code ?? "", qualificationName: history?.assessment?.qualification?.name ?? "" }} />
    </div>;
  }

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
            {tasks.map((t, i) => { const qs = studentQuestions(t); const files = qs.some((q) => q.type === "file_upload"); return (
              <li key={t.id} className="flex items-start gap-3 text-sm"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-50 font-semibold text-primary-700">{i + 1}</span>
                <span className="pt-1 text-foreground-800"><strong className="text-foreground-950">{taskLabel(t, i)}</strong> · {qs.length} item{qs.length === 1 ? "" : "s"} to answer{files ? ", including uploads" : ""}</span></li>
            ); })}
            <li className="flex items-start gap-3 text-sm"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-50 font-semibold text-primary-700"><i className="ri-quill-pen-line" aria-hidden="true" /></span><span className="pt-1 text-foreground-800">Declare the work is your own, then submit</span></li>
          </ol>
          {rules ? <button type="button" className="mt-3 cursor-pointer text-sm font-semibold text-primary-700 underline underline-offset-2" onClick={() => setRulesOpen(true)}>Read the full instructions and rules ›</button> : null}
        </section>
        <button type="button" className={`${PRIMARY} mt-4 w-full`} disabled={!steps.length} onClick={() => go({ kind: "step", index: 0 })} data-testid="start-task">Start →</button>
        {rulesOpen ? <Drawer title="Instructions and rules" onClose={() => setRulesOpen(false)}><div className="rounded-xl bg-white p-4"><AssessmentInfo text={rules} /></div></Drawer> : null}
      </div>
    );
  }

  /* ---------------- the step rail ---------------- */
  const rail = (
    <nav className={`${CARD} space-y-1 p-3`} aria-label="Steps">
      {tasks.map((t, ti) => { const p = taskProgress(t, responses, attempt.evidence); const mine = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.taskIndex === ti); return (
        <div key={t.id}>
          <p className="px-3 pt-2 text-sm font-semibold text-foreground-900">{taskLabel(t, ti)}</p>
          <p className="px-3 text-xs text-foreground-500">{p.answered} of {p.total} answered</p>
          {mine.map(({ s, i }) => { const on = view.kind === "step" && view.index === i; return (
            <button key={s.section.id} type="button" onClick={() => go({ kind: "step", index: i })} aria-current={on ? "page" : undefined} data-testid="step-rail-item"
              className={`block w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm ${on ? "bg-primary-50 font-semibold text-primary-800" : "text-foreground-700 hover:bg-background-100"}`}>{s.section.title || (mine.length > 1 ? `Part ${i - mine[0].i + 1}` : "Questions")}</button>
          ); })}
        </div>
      ); })}
      <button type="button" className={`w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm ${view.kind === "declare" ? "bg-primary-50 font-semibold text-primary-800" : "text-foreground-600 hover:bg-background-100"}`} onClick={() => go({ kind: "declare" })} data-testid="step-declare">Declaration &amp; submit</button>
    </nav>
  );

  /* ---------------- declaration & submit (the fixed last step) ---------------- */
  if (view.kind === "declare") {
    const errorIds = new Set(errors.map((e) => e.questionId.split(".")[0]));
    const unanswered = tasks.flatMap((t) => studentQuestions(t).filter((q) => !isAnswered(q, responses, attempt.evidence)).map((q) => ({ q, t })));
    const stepOf = (qid: string) => steps.findIndex((s) => s.section.questions.some((q) => q.id === qid));
    const today = fmtDate(new Date().toISOString());
    return (
      <div className="pb-12">
        {topBar}
        <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
          <div className="hidden lg:block">{rail}</div>
          <div className="min-w-0 space-y-4" data-testid="declare-submit">
            <h1 className="font-heading text-2xl font-bold text-foreground-950">Declaration &amp; submit</h1>
            {error ? <PortalError message={error} /> : null}
            {errors.length ? <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">{errors.length} answer{errors.length === 1 ? " is" : "s are"} still needed before you can submit.</p> : null}
            <section className={CARD}>
              {unanswered.length ? (
                <>
                  <p className="text-sm font-semibold text-amber-900">{unanswered.length} item{unanswered.length === 1 ? " is" : "s are"} not answered yet</p>
                  <ul className="mt-2 divide-y divide-background-100">
                    {unanswered.map(({ q }) => (
                      <li key={q.id}><button type="button" className="flex w-full cursor-pointer items-center gap-3 py-2 text-left" onClick={() => { go({ kind: "step", index: Math.max(0, stepOf(q.id)) }); window.setTimeout(() => document.getElementById(`q-${q.id}`)?.scrollIntoView({ block: "center" }), 50); }}>
                        <i className={`ri-checkbox-blank-circle-line ${errorIds.has(q.id) ? "text-amber-600" : "text-foreground-400"}`} aria-hidden="true" />
                        <span className="w-16 shrink-0 text-sm font-semibold text-foreground-900">{printedNumber(q) ?? ""}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground-900">{q.label}</span>
                      </button></li>
                    ))}
                  </ul>
                </>
              ) : <p className="text-sm text-green-800"><i className="ri-checkbox-circle-fill mr-1 text-green-600" aria-hidden="true" />Every item is answered.</p>}
            </section>
            <section className={`${CARD} space-y-4`} data-testid="declaration">
              <label className="flex cursor-pointer items-start gap-3 text-sm text-foreground-800"><input type="checkbox" className="mt-0.5 h-5 w-5 accent-primary-600" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="declare" />
                <span className="whitespace-pre-wrap">{data.settings.declarationText || DECLARATION_TEXT}</span></label>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <label className="block text-xs font-semibold text-foreground-600">Your full name
                  <input className={`${FIELD} mt-1`} value={declName} onChange={(e) => setDeclName(e.target.value)} autoComplete="name" data-testid="declare-name" />
                </label>
                <div><p className="text-xs font-semibold text-foreground-600">Date</p><p className="mt-1 py-2 text-sm font-semibold text-foreground-900" data-testid="declare-date">{today}</p></div>
              </div>
              <p className="text-sm text-foreground-600">When you submit, your answers are locked and you get a receipt number. Your declaration, name and the date are saved with the submission.</p>
              <button type="button" className={PRIMARY} disabled={busy || !agreed || declName.trim().length < 2} onClick={() => void submit()} data-testid="submit">{busy ? "Submitting…" : "Submit assessment"}</button>
            </section>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- one step a section ---------------- */
  const si = Math.min(view.index, Math.max(0, steps.length - 1)); const step = steps[si];
  if (!step) return <div className="pb-12">{topBar}<p className={CARD}>This assessment has nothing to show yet.</p></div>;
  const task = step.task;
  const errorFor = (qid: string) => errors.find((e) => e.questionId === qid || e.questionId.startsWith(`${qid}.`))?.message;
  const last = si + 1 >= steps.length;
  return (
    <div className="pb-12">
      {topBar}
      <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
        <div className="hidden lg:block">{rail}</div>
        <div className="min-w-0 space-y-4" data-testid="task-page">
          <div className="lg:hidden"><details className={`${CARD} p-3`}><summary className="cursor-pointer text-sm font-semibold text-foreground-900">Step {si + 1} of {steps.length + 1} · {taskLabel(task, step.taskIndex)}</summary><div className="mt-2">{rail}</div></details></div>
          <div>
            <h1 className="font-heading text-xl font-bold text-foreground-950 sm:text-2xl">{taskLabel(task, step.taskIndex)}</h1>
            {step.section.title ? <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-foreground-500" data-testid="step-section">{step.section.title}</p> : null}
          </div>
          {error ? <PortalError message={error} /> : null}
          {step.section.questions.map((q) => {
            if (!isAnswerable(q)) {
              const html = String(q.config?.html ?? "");
              return html.replace(/<[^>]*>/g, "").trim() ? <section key={q.id} className="asm-content rounded-2xl bg-background-50 px-4 py-3 text-sm text-foreground-800 [&_p]:mb-1.5" data-instruction={q.id} dangerouslySetInnerHTML={{ __html: sanitize(html) }} /> : null;
            }
            const err = errorFor(q.id);
            return (
              <section key={q.id} id={`q-${q.id}`} data-question={q.id} className={`${CARD} ${err ? "border-amber-400" : ""}`}>
                <p className="whitespace-pre-wrap text-base text-foreground-950">{printedNumber(q) ? <span className="mr-1.5 font-semibold text-primary-600">{printedNumber(q)}</span> : null}{q.label}</p>
                {q.helpText ? <p className="mt-0.5 text-xs text-foreground-600">{q.helpText}</p> : null}
                <div className="mt-3"><TypeInput q={q} value={responses[q.id]} onChange={(v) => change({ ...responses, [q.id]: v })} evidence={attempt.evidence} onUpload={onUpload} onRemoveEvidence={onRemoveEvidence} openEvidence={(f) => void openEvidence(f)} /></div>
                {err ? <p role="alert" className="mt-2 text-xs font-medium text-amber-800">{err}</p> : null}
              </section>
            );
          })}
          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" className="cursor-pointer text-sm font-semibold text-foreground-600 hover:text-foreground-900" onClick={() => go(si === 0 ? { kind: "start" } : { kind: "step", index: si - 1 })}>← Back</button>
            <button type="button" className={PRIMARY} onClick={() => go(last ? { kind: "declare" } : { kind: "step", index: si + 1 })} data-testid="next">{last ? "Declaration & submit →" : "Next →"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The marks of the returned attempt, shown inside the next attempt's wizard. */
function previousOf(b: PdfBundle) {
  const a = b.attempts.find((x) => x.attemptNo === b.attemptNo);
  return a ? { attemptNo: a.attemptNo, overallFeedback: a.overallFeedback ?? "", marks: Object.fromEntries(a.results.filter((r) => !r.criterionId).map((r) => [r.questionId, { outcome: r.outcome, feedback: r.feedback ?? "" }])) } : null;
}
