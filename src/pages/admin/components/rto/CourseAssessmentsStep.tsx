import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card } from "@/pages/admin/components/ui";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";
import type { RtoUnit } from "@/pages/admin/lib/rto";

/** Course wizard › Assessments: the assessments of this course grouped by unit, with their version state. */
export default function CourseAssessmentsStep({ courseId, units }: { courseId: string; units: RtoUnit[] }) {
  const [rows, setRows] = useState<AssessmentRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void asmAdmin<AssessmentRow[]>("assessment_list", { courseId }).then(setRows).catch((e) => setError(e instanceof Error ? e.message : "Not loaded.")); }, [courseId]);
  const active = units.filter((u) => u.isActive);
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-700">One or more assessments per unit; each is built in the assessment builder, mapped to the unit's elements and published before it is assigned to a batch.</p>
        <Link to="/admin/assessments"><Button size="sm" icon="ri-external-link-line">Open Assessments</Button></Link>
      </div>
      {error ? <p className="text-sm text-primary-700">{error.includes("Only an Admin") ? "Assessments are managed by Admins and RTO Managers." : error}</p> : null}
      {rows === null && !error ? <p className="text-sm text-foreground-600">Loading…</p> : null}
      {rows ? (
        <ul className="divide-y divide-background-100">
          {active.map((u) => { const mine = rows.filter((r) => r.unitId === u.id && !r.archivedAt); return (
            <li key={u.id ?? u.code} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="min-w-0 flex-1"><span className="font-medium text-foreground-900">{u.code}</span> <span className="text-foreground-700">{u.name}</span></span>
              {mine.length === 0 ? <Badge tone="warn">No assessment</Badge> : mine.map((r) => <Link key={r.id} to={`/admin/assessments/${r.id}`} className="rounded-md border border-background-300 px-2 py-0.5 text-xs text-foreground-800 hover:bg-background-100">{r.title} · {r.currentVersionNo ? `v${r.currentVersionNo}` : "unpublished"}</Link>)}
            </li>); })}
          {rows.filter((r) => !r.unitId && !r.archivedAt).length ? <li className="py-2 text-sm text-foreground-700">Not linked to a unit: {rows.filter((r) => !r.unitId && !r.archivedAt).map((r) => <Link key={r.id} to={`/admin/assessments/${r.id}`} className="ml-1 underline">{r.title}</Link>)}</li> : null}
        </ul>
      ) : null}
    </Card>
  );
}
