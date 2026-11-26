import { useEffect, useState } from "react";
import { Badge, Button, TextInput } from "@/pages/admin/components/ui";
import { Drawer } from "@/pages/admin/components/rto/shared";
import { useToast } from "@/pages/admin/components/toastContext";
import PdfPages from "@/components/signing/PdfPages";
import { fmtDateTime, OUTCOME_LABEL, STATE_LABEL } from "@/lib/assessment/api";
import type { Attempt } from "@/lib/assessment/types";
import { asmAdmin } from "@/pages/admin/lib/assessments";
import { buildStampedPdf, downloadOutput, loadPdfAttempt } from "@/lib/assessment/pdfTemplate/api";
import type { PdfBundle } from "@/lib/assessment/pdfTemplate/output";

/**
 * An administrator's read-only view of one attempt: its state, results and feedback, the authorised overrides, and the attempt drawn on
 * its workbook PDF (answers from the submission snapshot, the trainer's marks once decided), with the stored PDFs to download.
 */
export default function AttemptDrawer({ attemptId, onClose, onChanged }: { attemptId: string; onClose: () => void; onChanged?: () => void }) {
  const { push } = useToast();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [bundle, setBundle] = useState<PdfBundle | null>(null);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState(""); const [overrideLimit, setOverrideLimit] = useState(false);
  const load = async () => {
    try {
      setAttempt(await asmAdmin<Attempt>("attempt_get", { id: attemptId }));
      setBundle(await loadPdfAttempt(attemptId));
    } catch (e) { setError(e instanceof Error ? e.message : "The attempt did not load."); }
  };
  useEffect(() => { setPdf(null); void load(); }, [attemptId]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (action: string, data: Record<string, unknown>, done: string) => { try { await asmAdmin(action, { id: attemptId, ...data }); push(done); await load(); onChanged?.(); } catch (e) { setError(e instanceof Error ? e.message : "Not done."); } };
  const cur = bundle?.attempts.find((a) => a.attemptNo === bundle.attemptNo) ?? null;
  const decided = attempt?.state === "returned" || attempt?.state === "final";
  const draw = async () => {
    if (!bundle) return;
    setDrawing(true);
    try { setPdf(await buildStampedPdf(bundle, { trainer: decided })); } catch (e) { setError(e instanceof Error ? e.message : "The workbook could not be drawn."); } finally { setDrawing(false); }
  };
  const download = async (path: string, name: string) => {
    try {
      const bytes = await downloadOutput(path);
      const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/pdf" }));
      const link = document.createElement("a"); link.href = url; link.download = name; link.click();
    } catch (e) { setError(e instanceof Error ? e.message : "The PDF could not be opened."); }
  };
  const taskTitle = (taskId: string) => bundle?.template.tasks.find((t) => t.number === taskId)?.title ?? `Task ${taskId}`;
  return (
    <Drawer open title={attempt ? `Attempt ${attempt.attemptNo} · ${STATE_LABEL[attempt.state] ?? attempt.state}` : "Attempt"} onClose={onClose} width="max-w-4xl" footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      {error ? <p className="mb-3 text-sm text-primary-700" role="alert">{error}</p> : null}
      {attempt ? (
        <div className="space-y-4" data-testid="attempt-drawer">
          <div className="flex flex-wrap gap-2 text-xs text-foreground-600">
            {attempt.receiptNo ? <Badge tone="muted">Receipt {attempt.receiptNo}</Badge> : null}
            {attempt.submittedAt ? <span>Submitted {fmtDateTime(attempt.submittedAt)}</span> : null}
            {attempt.outcome ? <Badge tone={attempt.outcome === "S" ? "success" : "warn"}>{OUTCOME_LABEL[attempt.outcome]}</Badge> : null}
            {cur?.snapshot ? <span title={cur.snapshot.hash}>snapshot sha-256 {cur.snapshot.hash.slice(0, 12)}…</span> : null}
          </div>
          {attempt.state !== "draft" && attempt.state !== "void" ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-background-200 p-2 text-sm">
              <span className="text-foreground-700">Authorised overrides:</span>
              <TextInput className="min-w-[12rem] flex-1" placeholder="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <label className="flex items-center gap-1 text-xs text-foreground-700"><input type="checkbox" checked={overrideLimit} onChange={(e) => setOverrideLimit(e.target.checked)} /> Allow beyond the attempt limit (audited)</label>
              <Button size="sm" variant="outline" disabled={!reason} onClick={() => void act("attempt_reopen", { reason, overrideLimit }, "A further attempt was opened.")}>Reopen for the student</Button>
              <Button size="sm" variant="danger" disabled={!reason} onClick={() => window.confirm("Void this attempt? It stays in the history.") && void act("attempt_void", { reason }, "Attempt voided.")}>Void</Button>
            </div>
          ) : null}
          {attempt.overallFeedback ? <p className="rounded-md bg-background-100 p-3 text-sm text-foreground-800"><span className="font-medium">Overall feedback: </span>{attempt.overallFeedback}</p> : null}
          {attempt.taskResults.length ? <ul className="flex flex-wrap gap-2 text-xs">{attempt.taskResults.map((t) => <li key={t.taskId}><Badge tone={t.outcome === "S" ? "success" : t.outcome === "NYS" ? "warn" : "muted"}>{taskTitle(t.taskId)}: {t.outcome ? OUTCOME_LABEL[t.outcome] : "not decided"}</Badge></li>)}</ul> : null}
          {bundle ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-foreground-900">The workbook</p>
                {(cur?.outputs ?? []).map((o) => <Button key={o.kind} size="sm" variant="outline" icon="ri-download-2-line" onClick={() => void download(o.path, `attempt-${attempt.attemptNo}-${o.kind}.pdf`)}>{o.kind === "acknowledged" ? "Official PDF (acknowledged)" : "Sign-off PDF"}</Button>)}
                {attempt.state !== "draft" && !pdf ? <Button size="sm" variant="outline" icon="ri-file-pdf-2-line" disabled={drawing} onClick={() => void draw()}>{drawing ? "Drawing…" : "Show the workbook"}</Button> : null}
              </div>
              {pdf ? <div className="rounded-xl bg-background-200 p-2" data-testid="attempt-workbook"><PdfPages source={pdf} maxWidth={760} lazy /></div> : null}
            </div>
          ) : <p className="text-sm text-foreground-600">This attempt has no workbook PDF.</p>}
          {attempt.feedback.length ? <div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-500">Messages</p><ul className="space-y-1 text-sm">{attempt.feedback.map((f) => <li key={f.id} className="rounded-md bg-background-100 px-3 py-1.5"><span className="text-xs text-foreground-500">{f.role} · {fmtDateTime(f.createdAt)}</span><br />{f.body}</li>)}</ul></div> : null}
        </div>
      ) : !error ? <p className="text-sm text-foreground-600">Loading…</p> : null}
    </Drawer>
  );
}
