import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";
import NewAssessmentDialog from "@/pages/admin/assessments/NewAssessmentDialog";

const STATUS: Record<string, string> = { published: "Published", draft: "Draft", retired: "Retired" };

/** LMS > Courses > Units > a unit > Assessments: this unit's assessments, New assessment (the shared Add assessment wizard, this unit pre-selected) and the editor one click away. */
export default function UnitAssessmentsPanel({ courseId, unitId, canEdit }: { courseId: string; unitId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<AssessmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setError("");
    try {
      const list = await asmAdmin<AssessmentRow[]>("assessment_list", { courseId, includeArchived: false });
      setRows(list.filter(a => a.unitId === unitId));
    } catch (e) { setError(e instanceof Error ? e.message : "Assessments could not be loaded."); }
    finally { setLoading(false); }
  }, [courseId, unitId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4" data-testid="unit-assessments">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-600">Assessments for this unit. Build the questions in the editor, publish, then assign them to intakes from the assessment's Assignments tab.</p>
        {canEdit && !adding ? <button type="button" onClick={() => { setAdding(true); setCreated(null); }} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">+ New assessment</button> : null}
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {created ? <p role="status" className="rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">
        Assessment saved. <Link className="font-semibold underline" to={`/admin/assessments/${created}`}>Open it</Link> to edit, publish or assign it.</p> : null}
      {adding ? <NewAssessmentDialog courseId={courseId} unitId={unitId} onClose={() => setAdding(false)} onSaved={(id, { workbook }) => { setAdding(false); if (workbook) { navigate(`/admin/assessments/${id}?tab=pdf`); return; } setCreated(id); void load(); }} /> : null}
      {loading ? <p className="text-sm text-foreground-500" role="status">Loading assessments…</p>
        : rows.length === 0 ? <p className="rounded-xl border border-dashed border-background-300 p-6 text-center text-sm text-foreground-500">No assessments for this unit yet.{canEdit ? " Use + New assessment." : ""}</p>
        : <ul className="divide-y divide-background-100 rounded-xl border border-background-200 bg-background-50">{rows.map(a => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate font-semibold text-foreground-950">{a.code ? `${a.code} · ` : ""}{a.title}</p>
              <p className="text-xs text-foreground-500">{a.currentVersionStatus ? `${STATUS[a.currentVersionStatus] ?? a.currentVersionStatus} v${a.currentVersionNo}` : "Draft"}{a.hasDraft && a.currentVersionStatus === "published" ? " · draft changes" : ""} · {a.assignments} intake assignment{a.assignments === 1 ? "" : "s"}</p>
            </div>
            <Link to={`/admin/assessments/${a.id}`} className="shrink-0 rounded-lg border border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-800 hover:bg-background-100">Open editor</Link>
          </li>))}</ul>}
    </div>
  );
}
