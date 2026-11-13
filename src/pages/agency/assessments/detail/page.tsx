import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Modal, TextArea, TextInput } from "@/pages/admin/components/ui";
import { PageHeading, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import AssessmentRenderer from "@/components/assessment/AssessmentRenderer";
import { asmStudent, evidenceUrl, fmtDateTime, OUTCOME_LABEL, removeEvidenceObject, STATE_LABEL, uploadEvidence } from "@/lib/assessment/api";
import { validateResponses } from "@/lib/assessment/validate";
import type { Attempt, Definition, EvidenceFile, Question, Responses, ValidationError } from "@/lib/assessment/types";

interface Opened {
  assignment: { id: string; title: string; description: string; dueAt: string; lateUntil: string | null; status: string; unitCode: string | null; unitName: string | null };
  version: { id: string; versionNo: number; definition: Definition };
  settings: { declarationText: string; instructions: string; maxAttempts: number; lateSubmission: string; evidenceMaxMb: number; evidenceAllowedTypes: string[] };
  attempt: Attempt; history: Attempt[];
}

/** One assessment for the student: the form (autosaved draft), evidence, declaration and submit with a receipt; results, feedback and reassessment. */
export default function StudentAssessmentPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<Opened | null>(null);
  const [responses, setResponses] = useState<Responses>({});
  const [rowVersion, setRowVersion] = useState(1);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [taskIndex, setTaskIndex] = useState(0);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [signature, setSignature] = useState(""); const [agreed, setAgreed] = useState(false);
  const [receipt, setReceipt] = useState<{ receiptNo: string; submittedAt: string } | null>(null);
  const [viewing, setViewing] = useState<Attempt | null>(null);
  const [reason, setReason] = useState("");
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try { const d = await asmStudent<Opened>("assessment_open", { assignmentId: id }); setData(d); setResponses(d.attempt.responses ?? {}); setRowVersion(d.attempt.rowVersion); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The assessment did not load."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const attempt = data?.attempt; const definition = data?.version.definition;
  const editable = attempt?.state === "draft" && data?.assignment.status === "open";
  const save = useCallback(async (r: Responses) => {
    if (!attempt) return; setSaving(true);
    try { const out = await asmStudent<{ ok: boolean; rowVersion: number; savedAt: string }>("draft_save", { attemptId: attempt.id, responses: r, rowVersion }); setRowVersion(out.rowVersion); setSavedAt(out.savedAt); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved."); } finally { setSaving(false); }
  }, [attempt, rowVersion]);
  const onChange = (r: Responses) => { setResponses(r); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void save(r), 1000); };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const onUpload = async (q: Question, files: FileList) => {
    if (!attempt || !data) return;
    const maxMb = Number((q.config?.maxMb as number | undefined) ?? data.settings.evidenceMaxMb);
    for (const file of Array.from(files)) {
      if (file.size > maxMb * 1024 * 1024) { setError(`${file.name} is larger than ${maxMb} MB.`); continue; }
      try { const { path, sha256 } = await uploadEvidence(attempt.id, q.id, file); await asmStudent("evidence_register", { attemptId: attempt.id, questionId: q.id, path, fileName: file.name, mime: file.type, bytes: file.size, sha256 }); }
      catch (e) { setError(e instanceof Error ? e.message : `${file.name} did not upload.`); }
    }
    await load();
  };
  const onRemoveEvidence = async (f: EvidenceFile) => { if (!attempt) return; try { await asmStudent("evidence_remove", { id: f.id }); await removeEvidenceObject(f.path); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed."); } };
  const openEvidence = async (f: EvidenceFile) => { const w = window.open("", "_blank"); try { const u = await evidenceUrl(f.path); if (w) { w.opener = null; w.location.href = u; } } catch (e) { w?.close(); setError(e instanceof Error ? e.message : "The file could not be opened."); } };

  const liveErrors = useMemo(() => (definition ? validateResponses(definition, responses, "student") : []), [definition, responses]);
  const submit = async () => {
    if (!attempt || !definition) return;
    if (timer.current) { window.clearTimeout(timer.current); await save(responses); }
    try {
      const out = await asmStudent<{ ok: boolean; errors?: ValidationError[]; receiptNo?: string; submittedAt?: string }>("submit", { attemptId: attempt.id, responses, rowVersion: rowVersion + 1, declaration: { signature, agreed } });
      if (!out.ok) { setErrors(out.errors ?? []); setSubmitOpen(false); const first = out.errors?.[0]; if (first?.questionId) document.getElementById(`q-${first.questionId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      setReceipt({ receiptNo: out.receiptNo ?? "", submittedAt: out.submittedAt ?? "" }); setSubmitOpen(false); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Not submitted."); }
  };
  const requestReassessment = async (a: Attempt) => { try { await asmStudent("reassessment_request", { attemptId: a.id, reason }); setReason(""); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Not sent."); } };
  const [message, setMessage] = useState("");
  const sendMessage = async () => { if (!attempt) return; try { await asmStudent("feedback_post", { attemptId: attempt.id, body: message }); setMessage(""); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Not sent."); } };

  if (error && !data) return <div><PageHeading eyebrow="Assessments" title="Assessment" /><PortalError message={error} onRetry={() => void load()} /><Link className="mt-3 inline-block text-sm underline" to="/agency/assessments">Back to my assessments</Link></div>;
  if (!data || !attempt || !definition) return <PortalLoading label="Loading the assessment…" />;
  const tasks = definition.tasks; const task = tasks[taskIndex] ?? tasks[0];
  const historyAll = [...data.history, attempt].filter((a) => a.state !== "draft").sort((a, b) => a.attemptNo - b.attemptNo);
  return (
    <div>
      <PageHeading eyebrow={`${data.assignment.unitCode ?? ""} ${data.assignment.unitName ?? ""}`.trim() || "Assessment"} title={data.assignment.title} description={data.assignment.description} />
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-foreground-700">
        <Badge tone={attempt.state === "draft" ? "accent" : attempt.state === "final" ? (attempt.outcome === "S" ? "success" : "warn") : "primary"}>Attempt {attempt.attemptNo}: {STATE_LABEL[attempt.state] ?? attempt.state}{attempt.outcome && attempt.state !== "draft" ? ` · ${OUTCOME_LABEL[attempt.outcome]}` : ""}</Badge>
        <span>Due {fmtDateTime(attempt.dueAt ?? data.assignment.dueAt)}</span>
        {editable ? <span className="text-xs text-foreground-500" role="status">{saving ? "Saving…" : savedAt ? `Saved ${fmtDateTime(savedAt)}` : "Changes save automatically"}</span> : null}
        <span className="flex-1" /><Link className="text-sm underline" to="/agency/assessments">All assessments</Link>
      </div>
      {error ? <div className="mt-3"><PortalError message={error} /></div> : null}
      {data.settings.instructions ? <div className="mt-4 rounded-card border border-background-200 bg-background-100 p-4 text-sm text-foreground-800 whitespace-pre-wrap">{data.settings.instructions}</div> : null}

      {editable ? (
        <div className="mt-5 space-y-5">
          {tasks.length > 1 ? <div className="flex flex-wrap gap-2">{tasks.map((t, i) => <button key={t.id} type="button" onClick={() => setTaskIndex(i)} className={`rounded-full border px-3.5 py-1.5 text-label font-medium ${i === taskIndex ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-700"}`}>Task {i + 1}{errors.some((e) => t.sections.some((s) => s.questions.some((q) => e.questionId.startsWith(q.id)))) ? " !" : ""}</button>)}</div> : null}
          <AssessmentRenderer definition={definition} responses={responses} onChange={onChange} mode="student" taskId={task?.id} evidence={attempt.evidence} onUpload={onUpload} onRemoveEvidence={onRemoveEvidence} openEvidence={(f) => void openEvidence(f)} errors={errors} declarationText={data.settings.declarationText} />
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-background-200 bg-background-50 p-4">
            <div className="flex gap-2">{taskIndex > 0 ? <Button variant="outline" icon="ri-arrow-left-line" onClick={() => setTaskIndex(taskIndex - 1)}>Previous task</Button> : null}{taskIndex < tasks.length - 1 ? <Button variant="outline" onClick={() => setTaskIndex(taskIndex + 1)}>Next task <i className="ri-arrow-right-line" aria-hidden="true" /></Button> : null}</div>
            <div className="flex items-center gap-3"><span className="text-xs text-foreground-600">{liveErrors.length ? `${liveErrors.length} question${liveErrors.length === 1 ? "" : "s"} still need${liveErrors.length === 1 ? "s" : ""} an answer` : "Everything required is answered"}</span><Button icon="ri-send-plane-line" onClick={() => setSubmitOpen(true)}>Submit assessment</Button></div>
          </div>
        </div>
      ) : (
        <div className="mt-5 rounded-card border border-background-200 bg-background-50 p-4 text-sm text-foreground-800">
          {attempt.state === "draft" ? <p>This assessment is closed.</p> : attempt.state === "submitted" || attempt.state === "marking" ? <p><i className="ri-time-line mr-1" aria-hidden="true" />Submitted {fmtDateTime(attempt.submittedAt)} · receipt <strong>{attempt.receiptNo}</strong>. Your assessor is marking it; you will be notified.</p> : <p>Attempt {attempt.attemptNo} is {STATE_LABEL[attempt.state]?.toLowerCase()}{attempt.outcome ? `: ${OUTCOME_LABEL[attempt.outcome]}` : ""}.</p>}
        </div>
      )}

      {historyAll.length ? (
        <div className="mt-6">
          <h2 className="font-heading text-base font-semibold text-foreground-950">Submissions, results and feedback</h2>
          <ul className="mt-2 space-y-2">{historyAll.map((a) => (
            <li key={a.id} className="rounded-card border border-background-200 bg-background-50 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-foreground-900">Attempt {a.attemptNo}</span><Badge tone={a.state === "final" ? (a.outcome === "S" ? "success" : "warn") : a.state === "returned" ? "warn" : "primary"}>{STATE_LABEL[a.state] ?? a.state}{a.outcome && (a.state === "returned" || a.state === "final") ? ` · ${OUTCOME_LABEL[a.outcome]}` : ""}</Badge><span className="text-xs text-foreground-600">submitted {fmtDateTime(a.submittedAt)} · receipt {a.receiptNo}</span><span className="flex-1" /><Button size="sm" variant="outline" onClick={() => setViewing(a)}>View</Button></div>
              {a.overallFeedback ? <p className="mt-2 whitespace-pre-wrap text-foreground-800"><span className="font-medium">Assessor feedback: </span>{a.overallFeedback}</p> : null}
              {a.taskResults.length ? <ul className="mt-1 flex flex-wrap gap-1.5">{a.taskResults.map((t) => <li key={t.taskId}><Badge tone={t.outcome === "S" ? "success" : t.outcome === "NYS" ? "warn" : "muted"}>{definition.tasks.find((x) => x.id === t.taskId)?.title ?? t.taskId}: {t.outcome ? OUTCOME_LABEL[t.outcome] : "–"}</Badge></li>)}</ul> : null}
              {a.state === "final" && a.outcome === "NYS" && !a.reassessments.some((r) => r.state === "requested") ? <div className="mt-2 flex flex-wrap items-center gap-2"><TextInput className="min-w-[12rem] flex-1" placeholder="Why you are asking for a reassessment" value={reason} onChange={(e) => setReason(e.target.value)} /><Button size="sm" variant="outline" onClick={() => void requestReassessment(a)}>Request reassessment</Button></div> : null}
              {a.reassessments.map((r) => <p key={r.id} className="mt-1 text-xs text-foreground-600">Reassessment {r.state}{r.newDueAt ? ` · due ${fmtDateTime(r.newDueAt)}` : ""}{r.reason ? ` · ${r.reason}` : ""}</p>)}
            </li>))}</ul>
        </div>
      ) : null}

      <Modal open={submitOpen} title="Submit with your declaration" onClose={() => setSubmitOpen(false)} footer={<><Button variant="outline" onClick={() => setSubmitOpen(false)}>Not yet</Button><Button disabled={!agreed || signature.trim().length < 2} onClick={() => void submit()}>Submit</Button></>}>
        <div className="space-y-3 text-sm">
          {liveErrors.length ? <p className="rounded-md bg-primary-50 px-3 py-2 text-primary-800">{liveErrors.length} required question{liveErrors.length === 1 ? " is" : "s are"} not answered yet. You can still try; the server lists what is missing.</p> : null}
          <p className="whitespace-pre-wrap rounded-md border border-background-200 bg-background-100 p-3 text-foreground-800">{data.settings.declarationText}</p>
          <label className="flex items-start gap-2 text-foreground-900"><input type="checkbox" className="mt-0.5" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I have read and agree to this declaration.</label>
          <label className="block"><span className="mb-1 block text-xs text-foreground-600">Type your full name as your signature</span><TextInput value={signature} onChange={(e) => setSignature(e.target.value)} /></label>
          <p className="text-xs text-foreground-500">Once submitted, your answers are locked and a receipt number is issued. The submission is recorded with a hash of your answers and of this declaration.</p>
        </div>
      </Modal>
      <Modal open={Boolean(receipt)} title="Submitted" onClose={() => setReceipt(null)} footer={<Button onClick={() => setReceipt(null)}>Done</Button>}>
        <p className="text-sm text-foreground-800">Your assessment was submitted on {fmtDateTime(receipt?.submittedAt)}.</p><p className="mt-2 text-lg font-semibold text-foreground-950">Receipt {receipt?.receiptNo}</p><p className="mt-2 text-xs text-foreground-500">A copy of this receipt is in your notifications. Your assessor will mark it and you will be told the result.</p>
      </Modal>
      {viewing ? <Modal open title={`Attempt ${viewing.attemptNo}`} onClose={() => setViewing(null)} width="max-w-4xl"><AssessmentRenderer definition={definition} responses={viewing.responses} assessorResponses={viewing.assessorResponses} mode="review" evidence={viewing.evidence} openEvidence={(f) => void openEvidence(f)} declarationText={data.settings.declarationText}
        afterQuestion={(q) => { const rs = viewing.results.filter((r) => r.questionId === q.id); const fb = viewing.feedback.filter((f) => f.questionId === q.id); return rs.length || fb.length ? <ul className="mt-2 space-y-0.5 text-xs text-foreground-700">{rs.map((r) => <li key={`${r.questionId}|${r.criterionId ?? ""}`}>{r.criterionId ? `${q.criteria?.find((c) => c.id === r.criterionId)?.text ?? ""}: ` : ""}{r.outcome ? <Badge tone={r.outcome === "S" ? "success" : "warn"}>{OUTCOME_LABEL[r.outcome]}</Badge> : null}{r.feedback ? ` ${r.feedback}` : ""}</li>)}{fb.map((f) => <li key={f.id}>{f.role}: {f.body}</li>)}</ul> : null; }} /></Modal> : null}
      {attempt.state !== "draft" ? (
        <div className="mt-6 rounded-card border border-background-200 bg-background-50 p-4">
          <h2 className="font-heading text-base font-semibold text-foreground-950">Message your assessor</h2>
          <div className="mt-2 flex gap-2"><TextArea rows={2} className="flex-1" placeholder="A question or a note about this assessment" value={message} onChange={(e) => setMessage(e.target.value)} /><Button variant="outline" disabled={!message.trim()} onClick={() => void sendMessage()}>Send</Button></div>
        </div>
      ) : null}
    </div>
  );
}
