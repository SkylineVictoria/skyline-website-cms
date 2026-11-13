import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/pages/admin/components/ui";
import { fmtDateTime } from "@/lib/assessment/api";
import { asmAdmin, type AssignmentRow } from "@/pages/admin/lib/assessments";
import { AssignmentDrawer } from "./AssignmentsPanel";
import AttemptDrawer from "./AttemptDrawer";

/** Batch page, section 5: the assessments assigned to this batch and their progress. */
export default function BatchAssessmentsPanel({ batchId }: { batchId: string }) {
  const [rows, setRows] = useState<AssignmentRow[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<AssignmentRow | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);
  const load = () => asmAdmin<AssignmentRow[]>("assignment_list", { batchId }).then(setRows).catch((e) => setError(e instanceof Error ? e.message : "Not loaded."));
  useEffect(() => { void load(); }, [batchId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="text-sm text-primary-700">{error}</p>;
  if (rows === null) return <p className="text-sm text-foreground-600">Loading…</p>;
  if (rows.length === 0) return <p className="rounded-md bg-background-100 px-3 py-4 text-center text-sm text-foreground-600">No assessment is assigned to this batch yet. Assign one from <Link className="underline" to="/admin/assessments">Master Data › Assessments</Link>.</p>;
  return (
    <>
      <ul className="divide-y divide-background-100">{rows.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(a)}><span className="block truncate font-medium text-foreground-900">{a.assessmentTitle}{a.unitCode ? <span className="ml-2 text-xs text-foreground-500">{a.unitCode}</span> : null}</span><span className="block text-xs text-foreground-600">v{a.versionNo} · due {fmtDateTime(a.dueAt)} · {a.eligibleCount} student{a.eligibleCount === 1 ? "" : "s"}</span></button>
          <Badge tone={a.status === "open" ? "success" : "muted"}>{a.status}</Badge>
          <Link to={`/admin/assessments/${a.assessmentId}?tab=assignments`} className="text-xs text-foreground-600 hover:text-primary-700">Open</Link>
        </li>))}</ul>
      {open ? <AssignmentDrawer assignment={open} onClose={() => setOpen(null)} onChanged={() => void load()} onOpenAttempt={setAttempt} /> : null}
      {attempt ? <AttemptDrawer attemptId={attempt} onClose={() => setAttempt(null)} onChanged={() => void load()} /> : null}
    </>
  );
}
