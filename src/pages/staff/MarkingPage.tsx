import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Badge, Button, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import MarkingView, { type ElementRef, type MarkingPayload } from "@/components/assessment/MarkingView";
import { asmTrainer, evidenceUrl, fmtDateTime, fromLocalInput, OUTCOME_LABEL, STATE_LABEL, uploadEvidence } from "@/lib/assessment/api";
import type { Attempt, Definition, EvidenceFile, Outcome, Question, QuestionKey } from "@/lib/assessment/types";

type Loaded = Attempt & { definition: Definition; assessmentTitle: string; unitId: string | null; studentName: string; settings: Record<string, unknown>; keys: QuestionKey[]; mappings: ElementRef[] };

/** /staff/assessments/attempts/:id: the assessor marks one attempt (per question / criterion / rubric, observation checklist, task outcomes, decision) and can sign the unit off. */
export default function MarkingPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [signedOut, setSignedOut] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [signOff, setSignOff] = useState(false);
  const [signOutcome, setSignOutcome] = useState<"C" | "NYC">("C"); const [signNotes, setSignNotes] = useState(""); const [signTick, setSignTick] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => { try { setData(await asmTrainer<Loaded>("attempt_get", { id })); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "The attempt did not load."); } }, [id]);
  useEffect(() => { void supabase.auth.getUser().then(({ data: u }) => { if (!u.user) setSignedOut(true); else void load(); }); }, [load]);
  if (signedOut) return <Navigate to="/login?next=%2Fstaff%2Fassessments" replace />;

  const openEvidence = async (f: EvidenceFile) => { const w = window.open("", "_blank"); try { const u = await evidenceUrl(f.path); if (w) { w.opener = null; w.location.href = u; } } catch (e) { w?.close(); setError(e instanceof Error ? e.message : "The file could not be opened."); } };
  const save = async (p: MarkingPayload) => { setBusy(true); try { setData(await asmTrainer<Loaded>("mark_save", { id, rowVersion: data?.rowVersion, ...p })); setNote("Marks saved."); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Not saved."); } finally { setBusy(false); } };
  const ret = async (outcome: Outcome, p: MarkingPayload, dueLocal: string | null) => {
    setBusy(true);
    try {
      const saved = await asmTrainer<Loaded>("mark_save", { id, rowVersion: data?.rowVersion, ...p });
      const out = await asmTrainer<{ ok: boolean; errors?: { message: string }[]; nextAttemptId?: string | null }>("mark_return", { id, rowVersion: saved.rowVersion, outcome, overallFeedback: p.overallFeedback, dueAt: dueLocal ? fromLocalInput(dueLocal) : undefined });
      if (!out.ok) { setError(out.errors?.map((e) => e.message).join(" ") ?? "Not returned."); await load(); return; }
      setNote(outcome === "S" ? "Returned as Satisfactory." : out.nextAttemptId ? "Returned; a reassessment attempt is open for the student." : "Finalised as Not Yet Satisfactory."); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Not returned."); } finally { setBusy(false); }
  };
  const uploadAssessor = async (q: Question, files: FileList) => { for (const file of Array.from(files)) { try { const { path, sha256 } = await uploadEvidence(id, q.id, file, true); await asmTrainer("evidence_register", { attemptId: id, questionId: q.id, path, fileName: file.name, mime: file.type, bytes: file.size, sha256 }); } catch (e) { setError(e instanceof Error ? e.message : "Not uploaded."); } } await load(); };
  const recordOutcome = async () => { if (!data?.unitId) return; setBusy(true); try { await asmTrainer("unit_outcome_record", { studentId: data.studentId, unitId: data.unitId, outcome: signOutcome, signOff: signTick, notes: signNotes, attemptIds: [data.id] }); setSignOff(false); setNote(`Unit outcome recorded: ${OUTCOME_LABEL[signOutcome]}.`); } catch (e) { setError(e instanceof Error ? e.message : "Not recorded."); } finally { setBusy(false); } };
  const post = async () => { if (!message.trim()) return; try { await asmTrainer("feedback_post", { attemptId: id, body: message }); setMessage(""); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Not sent."); } };

  return (
    <div className="min-h-screen bg-background-100 px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h1 className="font-heading text-2xl font-bold text-foreground-950">{data ? `${data.studentName} · ${data.assessmentTitle}` : "Marking"}</h1>{data ? <p className="text-sm text-foreground-600">Attempt {data.attemptNo} · <Badge tone={data.state === "final" ? (data.outcome === "S" ? "success" : "warn") : "primary"}>{STATE_LABEL[data.state] ?? data.state}{data.outcome && data.state !== "draft" ? ` · ${OUTCOME_LABEL[data.outcome]}` : ""}</Badge> · submitted {fmtDateTime(data.submittedAt)} · receipt {data.receiptNo} · sha-256 {data.responsesHash?.slice(0, 12)}…</p> : null}</div>
          <div className="flex gap-2">{data?.unitId && (data.state === "final" || data.state === "returned") ? <Button variant="outline" icon="ri-award-line" onClick={() => setSignOff(true)}>Record unit outcome</Button> : null}<Link to="/staff/assessments" className="inline-flex items-center gap-1.5 rounded-md border border-background-300 px-4 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100"><i className="ri-arrow-left-line" aria-hidden="true" />Assessments</Link></div>
        </div>
        {error ? <p role="alert" className="mt-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
        {note ? <p role="status" className="mt-4 rounded-md border border-background-200 bg-background-50 px-3 py-2 text-sm text-foreground-800">{note}</p> : null}
        {!data && !error ? <p className="mt-4 text-sm text-foreground-600">Loading…</p> : null}
        {data ? (
          <div className="mt-6 space-y-6">
            <MarkingView definition={data.definition} attempt={data} keys={data.keys} mappings={data.mappings} busy={busy} openEvidence={(f) => void openEvidence(f)} onSave={save} onReturn={ret} onUploadAssessorEvidence={uploadAssessor}
              maxAttempts={Number(data.settings.max_attempts ?? 3)} reassessmentDays={Number(data.settings.reassessment_days ?? 5)} />
            <div className="rounded-card border border-background-200 bg-background-50 p-4">
              <h3 className="font-heading text-base font-semibold text-foreground-950">Messages with the student</h3>
              {data.feedback.length ? <ul className="mt-2 space-y-1 text-sm">{data.feedback.map((f) => <li key={f.id} className="rounded-md bg-background-100 px-3 py-1.5"><span className="text-xs text-foreground-500">{f.role} · {fmtDateTime(f.createdAt)}</span><br />{f.body}</li>)}</ul> : <p className="mt-1 text-sm text-foreground-600">No messages yet.</p>}
              <div className="mt-2 flex gap-2"><TextInput className="flex-1" placeholder="Write to the student" value={message} onChange={(e) => setMessage(e.target.value)} /><Button variant="outline" onClick={() => void post()}>Send</Button></div>
            </div>
          </div>
        ) : null}
        <Modal open={signOff} title="Record the unit outcome" onClose={() => setSignOff(false)} footer={<><Button variant="outline" onClick={() => setSignOff(false)}>Cancel</Button><Button disabled={busy || !signTick} onClick={() => void recordOutcome()}>Record and sign</Button></>}>
          <div className="space-y-3 text-sm">
            <p className="text-foreground-700">A unit outcome is never automatic. You are recording, as the assessor, that the evidence of this student's attempts meets (or does not yet meet) the unit's requirements.</p>
            <Select value={signOutcome} onChange={(e) => setSignOutcome(e.target.value as "C" | "NYC")}><option value="C">Competent</option><option value="NYC">Not Yet Competent</option></Select>
            <TextArea rows={3} placeholder="Notes (optional)" value={signNotes} onChange={(e) => setSignNotes(e.target.value)} />
            <label className="flex items-start gap-2 text-foreground-900"><input type="checkbox" className="mt-0.5" checked={signTick} onChange={(e) => setSignTick(e.target.checked)} />I declare that I have conducted a fair, valid, reliable and flexible assessment and that this outcome is based on the evidence recorded.</label>
          </div>
        </Modal>
        <div className="mt-6"><Button variant="ghost" onClick={() => navigate("/staff/assessments")}>Back</Button></div>
      </div>
    </div>
  );
}
