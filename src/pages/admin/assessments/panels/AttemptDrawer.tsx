import { useEffect, useState } from "react";
import { Badge, Button, TextInput } from "@/pages/admin/components/ui";
import { Drawer } from "@/pages/admin/components/rto/shared";
import { useToast } from "@/pages/admin/components/toastContext";
import AssessmentRenderer from "@/components/assessment/AssessmentRenderer";
import { evidenceUrl, fmtDateTime, OUTCOME_LABEL, STATE_LABEL } from "@/lib/assessment/api";
import type { Attempt, Definition, EvidenceFile } from "@/lib/assessment/types";
import { asmAdmin } from "@/pages/admin/lib/assessments";

/** An administrator's read-only view of one attempt: responses, evidence, results, feedback, history, and the authorised overrides. */
export default function AttemptDrawer({ attemptId, onClose, onChanged }: { attemptId: string; onClose: () => void; onChanged?: () => void }) {
  const { push } = useToast();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const load = async () => {
    try {
      const a = await asmAdmin<Attempt>("attempt_get", { id: attemptId }); setAttempt(a);
      const v = await asmAdmin<{ definition: Definition }>("version_get", { versionId: a.versionId }); setDefinition(v.definition);
    } catch (e) { setError(e instanceof Error ? e.message : "The attempt did not load."); }
  };
  useEffect(() => { void load(); }, [attemptId]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = async (f: EvidenceFile) => { const w = window.open("", "_blank"); try { const u = await evidenceUrl(f.path); if (w) { w.opener = null; w.location.href = u; } } catch (e) { w?.close(); setError(e instanceof Error ? e.message : "The file could not be opened."); } };
  const act = async (action: string, data: Record<string, unknown>, done: string) => { try { await asmAdmin(action, { id: attemptId, ...data }); push(done); await load(); onChanged?.(); } catch (e) { setError(e instanceof Error ? e.message : "Not done."); } };
  return (
    <Drawer open title={attempt ? `Attempt ${attempt.attemptNo} · ${STATE_LABEL[attempt.state] ?? attempt.state}` : "Attempt"} onClose={onClose} width="max-w-4xl" footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      {error ? <p className="mb-3 text-sm text-primary-700" role="alert">{error}</p> : null}
      {attempt && definition ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs text-foreground-600">
            {attempt.receiptNo ? <Badge tone="muted">Receipt {attempt.receiptNo}</Badge> : null}
            {attempt.submittedAt ? <span>Submitted {fmtDateTime(attempt.submittedAt)}</span> : null}
            {attempt.outcome ? <Badge tone={attempt.outcome === "S" ? "success" : "warn"}>{OUTCOME_LABEL[attempt.outcome]}</Badge> : null}
            {attempt.responsesHash ? <span title={attempt.responsesHash}>sha-256 {attempt.responsesHash.slice(0, 12)}…</span> : null}
            {attempt.declaration?.signature ? <span>Signed "{String(attempt.declaration.signature)}"</span> : null}
          </div>
          {attempt.state !== "draft" && attempt.state !== "void" ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-background-200 p-2 text-sm">
              <span className="text-foreground-700">Authorised overrides:</span>
              <TextInput className="min-w-[12rem] flex-1" placeholder="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" variant="outline" disabled={!reason} onClick={() => void act("attempt_reopen", { reason }, "A further attempt was opened.")}>Reopen for the student</Button>
              <Button size="sm" variant="danger" disabled={!reason} onClick={() => window.confirm("Void this attempt? It stays in the history.") && void act("attempt_void", { reason }, "Attempt voided.")}>Void</Button>
            </div>
          ) : null}
          {attempt.overallFeedback ? <p className="rounded-md bg-background-100 p-3 text-sm text-foreground-800"><span className="font-medium">Overall feedback: </span>{attempt.overallFeedback}</p> : null}
          {attempt.taskResults.length ? <ul className="flex flex-wrap gap-2 text-xs">{attempt.taskResults.map((t) => <li key={t.taskId}><Badge tone={t.outcome === "S" ? "success" : t.outcome === "NYS" ? "warn" : "muted"}>{definition.tasks.find((x) => x.id === t.taskId)?.title ?? t.taskId}: {t.outcome ? OUTCOME_LABEL[t.outcome] : "not decided"}</Badge></li>)}</ul> : null}
          <AssessmentRenderer definition={definition} responses={attempt.responses} assessorResponses={attempt.assessorResponses} mode="review" evidence={attempt.evidence} openEvidence={(f) => void open(f)}
            afterQuestion={(q) => { const rs = attempt.results.filter((r) => r.questionId === q.id); return rs.length ? <ul className="mt-2 space-y-0.5 text-xs text-foreground-700">{rs.map((r) => <li key={`${r.questionId}|${r.criterionId ?? ""}`}>{r.criterionId ? `${q.criteria?.find((c) => c.id === r.criterionId)?.text ?? r.criterionId}: ` : ""}<Badge tone={r.outcome === "S" ? "success" : r.outcome === "NYS" ? "warn" : "muted"}>{r.outcome ? OUTCOME_LABEL[r.outcome] : r.suggestedOutcome ? `suggested ${OUTCOME_LABEL[r.suggestedOutcome]}` : "unmarked"}</Badge>{r.feedback ? ` ${r.feedback}` : ""}</li>)}</ul> : null; }} />
          {attempt.feedback.length ? <div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-500">Messages</p><ul className="space-y-1 text-sm">{attempt.feedback.map((f) => <li key={f.id} className="rounded-md bg-background-100 px-3 py-1.5"><span className="text-xs text-foreground-500">{f.role} · {fmtDateTime(f.createdAt)}</span><br />{f.body}</li>)}</ul></div> : null}
        </div>
      ) : !error ? <p className="text-sm text-foreground-600">Loading…</p> : null}
    </Drawer>
  );
}
