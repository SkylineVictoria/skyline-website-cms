import { Badge } from "@/pages/admin/components/ui";
import { fmtDateTime, OUTCOME_LABEL, STATE_LABEL } from "@/lib/assessment/api";

export interface ProgressUnit {
  unitId: string; unitCode: string; unitName: string; courseId: string; outcome: "C" | "NYC" | null; outcomeAt: string | null;
  assessments: { assessmentId: string; title: string; assignmentId: string; dueAt: string; latest: { id: string; attemptNo: number; state: string; outcome: string | null; submittedAt: string | null } | null }[];
}
export interface Progress { studentId: string; units: ProgressUnit[] }

/** A student's competency progress: every unit of their batches' courses, the assessments on it and the signed outcome. */
export default function ProgressList({ progress, onOpenAttempt, onOpenAssignment }: { progress: Progress; onOpenAttempt?: (attemptId: string) => void; onOpenAssignment?: (assignmentId: string) => void }) {
  if (!progress.units.length) return <p className="text-sm text-foreground-600">No units yet: the student is not enrolled in a batch.</p>;
  return (
    <ul className="divide-y divide-background-100 rounded-md border border-background-200">
      {progress.units.map((u) => (
        <li key={u.unitId} className="px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground-900">{u.unitCode} {u.unitName}</span>
            <Badge tone={u.outcome === "C" ? "success" : u.outcome === "NYC" ? "warn" : "muted"}>{u.outcome ? `${OUTCOME_LABEL[u.outcome]} · ${fmtDateTime(u.outcomeAt)}` : "No outcome yet"}</Badge>
          </div>
          {u.assessments.length ? (
            <ul className="mt-1 space-y-0.5">{u.assessments.map((a) => (
              <li key={a.assignmentId} className="flex flex-wrap items-center gap-2 text-xs text-foreground-700">
                <button type="button" className="min-w-0 flex-1 truncate text-left hover:text-primary-700" onClick={() => onOpenAssignment?.(a.assignmentId)}>{a.title}</button>
                <span>due {fmtDateTime(a.dueAt)}</span>
                {a.latest ? <button type="button" className="rounded border border-background-300 px-1.5 py-0.5 hover:bg-background-100" onClick={() => onOpenAttempt?.(a.latest!.id)}>Attempt {a.latest.attemptNo}: {STATE_LABEL[a.latest.state] ?? a.latest.state}{a.latest.outcome ? ` · ${OUTCOME_LABEL[a.latest.outcome] ?? a.latest.outcome}` : ""}</button> : <span className="text-foreground-500">not started</span>}
              </li>))}</ul>
          ) : <p className="mt-1 text-xs text-foreground-500">No assessment assigned for this unit.</p>}
        </li>
      ))}
    </ul>
  );
}
