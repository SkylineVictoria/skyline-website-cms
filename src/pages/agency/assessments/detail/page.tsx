/**
 * The student's assessment (ASM-PDF-TEMPLATE phase 4, 2026-11-26): every assessment is its workbook PDF.
 *   Draft attempt     the wizard over the workbook (PdfWizard): instruction pages, one step per question cropped from the PDF, the
 *                     declarations signed one by one, review and submit; autosave with retry (src/lib/assessment/autosave.ts).
 *   Submitted / later the result on the workbook (PdfResults): marks, comments, acknowledgement, the stamped workbook and the
 *                     stored official PDF; earlier attempts open from the list (?results=<attempt>).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { loginUrl } from "@/lib/loginRouting";
import { supabase } from "@/pages/admin/lib/supabase";
import UnsavedGuard from "@/components/assessment/UnsavedGuard";
import { draftKey, localDraftStore, saveLabel as saveLabelOf, saveTone, useAutosave, type DraftStore } from "@/lib/assessment/autosave";
import { PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { downloadWorkbook, loadPdfAttempt, loadStudentTemplate, pdfSign, pdfSignatures, type PdfSignature } from "@/lib/assessment/pdfTemplate/api";
import type { PdfBundle } from "@/lib/assessment/pdfTemplate/output";
import type { PdfTemplate } from "@/lib/assessment/pdfTemplate/model";
import PdfResults from "./PdfResults";
import PdfWizard from "./PdfWizard";
import { asmStudent, attemptHistory, fmtDate, keepSignature, type AttemptHistory } from "@/lib/assessment/api";
import type { Attempt, Responses, ValidationError } from "@/lib/assessment/types";

interface Opened {
  assignment: { id: string; title: string; description: string; dueAt: string; lateUntil: string | null; status: string; unitCode: string | null; unitName: string | null };
  version: { id: string; versionNo: number };
  settings: { maxAttempts: number };
  attempt: Attempt; history: Attempt[];
}

export default function StudentAssessmentPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const shownParam = params.get("results");
  const location = useLocation();
  const [data, setData] = useState<Opened | null>(null);
  const [responses, setResponses] = useState<Responses>({});
  const [history, setHistory] = useState<AttemptHistory | null>(null);
  const rowVersionRef = useRef(1);
  const submitRequestId = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [pdfTpl, setPdfTpl] = useState<{ template: PdfTemplate; bytes: Uint8Array | null } | null>(null);
  const [pdfErrors, setPdfErrors] = useState<string[]>([]);
  const [pdfSigs, setPdfSigs] = useState<PdfSignature[]>([]);
  const [pdfChecked, setPdfChecked] = useState(false);
  const [prevPdf, setPrevPdf] = useState<PdfBundle | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 20_000); return () => window.clearInterval(t); }, []);

  // autosave (owner 2026-11-26): retried until it goes through, kept in this browser until the server has it (per signed-in student
  // and attempt), offline / signed-out states shown, saved again when back online or signed in again
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

  const load = useCallback(async () => {
    try {
      const d = await asmStudent<Opened>("assessment_open", { assignmentId: id });
      setData(d); rowVersionRef.current = d.attempt.rowVersion; attemptIdRef.current = d.attempt.id; setError("");
      // answers this student typed here and not yet on the server come back and are saved; the key carries the signed-in person,
      // so another student on this browser never sees them
      userIdRef.current = (await supabase.auth.getSession()).data.session?.user.id ?? "";
      const local = localDraftStore<Responses>(draftKey(userIdRef.current, d.attempt.id));
      const kept = userIdRef.current && d.attempt.state === "draft" && d.assignment.status === "open" ? local.read() : null;
      if (kept && JSON.stringify(kept.v) !== JSON.stringify(d.attempt.responses ?? {})) { setResponses(kept.v); queueSave(kept.v); }
      else { if (kept) local.clear(); setResponses(d.attempt.responses ?? {}); } // a kept copy equal to the server's is saved: deleted
      void attemptHistory(d.attempt.id).then(setHistory).catch(() => setHistory(null));
      const tpl = await loadStudentTemplate(d.attempt.id);
      if (tpl) {
        void pdfSignatures(d.attempt.id).then(setPdfSigs);
        setPdfTpl((cur) => cur?.template.pdf.path === tpl.pdf.path ? { ...cur, template: tpl } : { template: tpl, bytes: null });
        void downloadWorkbook(tpl.pdf.path).then((bytes) => setPdfTpl((cur) => cur && cur.template.pdf.path === tpl.pdf.path ? { ...cur, bytes } : cur)).catch(() => setError("The workbook PDF could not be opened."));
      } else setPdfTpl(null);
      setPdfChecked(true);
    } catch (e) { setError(e instanceof Error ? e.message : "The assessment did not load."); }
  }, [id, queueSave]);
  useEffect(() => { void load(); }, [load]);

  const attempt = data?.attempt;
  const editable = attempt?.state === "draft" && data?.assignment.status === "open";
  const prevReturned = useMemo(() => (data?.history ?? []).filter((h) => h.state === "returned").sort((x, y) => x.attemptNo - y.attemptNo).pop()?.id ?? null, [data?.history]);
  useEffect(() => {
    if (!pdfTpl || !prevReturned) { setPrevPdf(null); return; }
    let off = false;
    void loadPdfAttempt(prevReturned).then((b) => { if (!off) setPrevPdf(b); }).catch(() => { if (!off) setPrevPdf(null); });
    return () => { off = true; };
  }, [pdfTpl, prevReturned]);

  const change = (r: Responses) => { setResponses(r); queueSave(r); };
  /** Submit waits for the save; when it does not go through, the student is told why and nothing is submitted. */
  const unsavedReason = (): string => {
    const st = autosave.current().state;
    if (st === "offline") return "You are offline. Your latest answers are kept on this device and will save when you reconnect; submit after that.";
    if (st === "expired") return "Your sign-in has expired. Sign in again to save your latest answers, then submit.";
    return "Your latest answers are not saved yet (retrying). Submit once they show as saved.";
  };

  if (error && !data) return <div className="p-4"><PortalError message={error} onRetry={() => void load()} /><Link className="mt-3 inline-block text-sm underline" to="/agency/assessments">Back to my assessments</Link></div>;
  if (!data || !attempt || !pdfChecked) return <PortalLoading label="Loading the assessment…" />;

  const unitCode = data.assignment.unitCode ?? "";
  const unitName = data.assignment.unitName ?? data.assignment.title;
  const due = attempt.dueAt ?? data.assignment.dueAt;
  const savedLabel = saveLabelOf(autosave.status, "Your work saves as you go");
  const signInAgain = autosave.status.state === "expired"
    ? <button type="button" className="min-h-[36px] rounded-lg bg-primary-600 px-3 text-xs font-semibold text-white" onClick={() => setLeaving(true)} data-testid="sign-in-again">Sign in again</button> : null;
  const guard = <UnsavedGuard when={Boolean(editable) && autosave.pending && !leaving}
    message="They are kept on this device and will be saved when you come back to this assessment. Stay to let them save now." />;
  const topBar = (
    <div className="sticky top-0 z-30 -mx-4 mb-5 flex items-center justify-between gap-3 border-b border-background-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <p className="min-w-0 truncate text-sm text-foreground-600"><span className="font-semibold text-foreground-900">{unitCode}</span>{unitCode ? " · " : ""}{unitName}</p>
      <p className="shrink-0 text-sm text-foreground-600">Due {fmtDate(due)}</p>
    </div>
  );

  if (!pdfTpl) return <div className="mx-auto max-w-3xl px-0 sm:px-2" data-testid="no-workbook">
    {topBar}
    <PortalError message="This assessment has no workbook PDF yet. Ask your trainer." />
    <Link className="mt-3 inline-block text-sm font-semibold text-primary-700 hover:underline" to="/agency/assessments">← All assessments</Link>
  </div>;

  /* ---------------- a submitted attempt (or an earlier one, ?results=): the result on the workbook ---------------- */
  if (!editable || shownParam) {
    const all = [...data.history, attempt];
    const shown = (shownParam ? all.find((a) => a.id === shownParam) : null) ?? attempt;
    if (shown.state !== "draft") return <div className="px-0 sm:px-2" data-testid="student-results">
      {topBar}
      {error ? <div className="mb-3"><PortalError message={error} /></div> : null}
      <PdfResults attemptId={shown.id} unit={`${unitCode} ${unitName}`.trim()} receipt={shown.id === attempt.id ? receipt ?? shown.receiptNo ?? null : shown.receiptNo ?? null}
        otherAttempts={all.filter((x) => x.id !== shown.id && x.state !== "draft" && x.state !== "void").map((x) => ({ id: x.id, attemptNo: x.attemptNo, state: x.state }))}
        nextOpen={attempt.state === "draft" && attempt.id !== shown.id} />
    </div>;
    if (!editable) return <div className="mx-auto max-w-3xl px-0 sm:px-2">{topBar}<PortalError message="This assessment is closed." /></div>;
  }

  /* ---------------- the draft attempt: the wizard over the workbook ---------------- */
  const studentName = history?.student?.name ?? "";
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
      record={{ studentName, studentRef: history?.student?.ref ?? "", studentEmail: history?.student?.email ?? "", trainer: (history?.trainers ?? []).join(", "),
        unitCode, unitName, qualificationCode: history?.assessment?.qualification?.code ?? "", qualificationName: history?.assessment?.qualification?.name ?? "" }} />
  </div>;
}

/** The marks of the returned attempt, shown inside the next attempt's wizard. */
function previousOf(b: PdfBundle) {
  const a = b.attempts.find((x) => x.attemptNo === b.attemptNo);
  return a ? { attemptNo: a.attemptNo, overallFeedback: a.overallFeedback ?? "", marks: Object.fromEntries(a.results.filter((r) => !r.criterionId).map((r) => [r.questionId, { outcome: r.outcome, feedback: r.feedback ?? "" }])) } : null;
}
