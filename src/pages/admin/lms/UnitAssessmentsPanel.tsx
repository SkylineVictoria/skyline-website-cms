import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";

const STATUS: Record<string, string> = { published: "Published", draft: "Draft", retired: "Retired" };

/** LMS > Courses > Units > a unit > Assessments: this unit's assessments, a new one in one step, and the full editor one click away. */
export default function UnitAssessmentsPanel({ courseId, unitId, canEdit }: { courseId: string; unitId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<AssessmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const list = await asmAdmin<AssessmentRow[]>("assessment_list", { courseId, includeArchived: false });
      setRows(list.filter(a => a.unitId === unitId));
    } catch (e) { setError(e instanceof Error ? e.message : "Assessments could not be loaded."); }
    finally { setLoading(false); }
  }, [courseId, unitId]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!title.trim()) { setError("Give the assessment a title."); return; }
    setBusy(true); setError("");
    try {
      const out = await asmAdmin<{ id?: string; ok?: boolean; errors?: { message: string }[] }>("assessment_create", { courseId, unitId, title: title.trim(), code: code.trim() || null });
      if (out.ok === false || !out.id) throw new Error(out.errors?.map(e => e.message).join(" ") || "The assessment could not be created.");
      setCreated(out.id); setAdding(false); setTitle(""); setCode("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "The assessment could not be created."); }
    finally { setBusy(false); }
  };

  const input = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  return (
    <div className="space-y-4" data-testid="unit-assessments">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-600">Assessments for this unit. Build the questions in the editor, publish, then assign them to batches under Batches › Assessments.</p>
        {canEdit && !adding ? <button type="button" onClick={() => { setAdding(true); setCreated(null); }} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">+ New assessment</button> : null}
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {created ? <p role="status" className="rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">
        Assessment created as a draft. <Link className="font-semibold underline" to={`/admin/assessments/${created}`}>Open the editor</Link> to add questions and publish it.</p> : null}
      {adding ? (
        <div className="space-y-3 rounded-xl border border-background-200 bg-background-100/50 p-4">
          <label className="block text-xs font-medium text-foreground-500">Title<input className={input + " mt-1"} value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Assessment 1 – Knowledge questions" /></label>
          <label className="block text-xs font-medium text-foreground-500">Code (optional)<input className={input + " mt-1"} value={code} onChange={e => setCode(e.target.value)} maxLength={40} placeholder="e.g. AT1" /></label>
          <div className="flex gap-2">
            <button type="button" disabled={busy || !title.trim()} onClick={() => void create()} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Creating…" : "Create assessment"}</button>
            <button type="button" onClick={() => { setAdding(false); setTitle(""); setCode(""); }} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold">Cancel</button>
          </div>
        </div>
      ) : null}
      {loading ? <p className="text-sm text-foreground-500" role="status">Loading assessments…</p>
        : rows.length === 0 ? <p className="rounded-xl border border-dashed border-background-300 p-6 text-center text-sm text-foreground-500">No assessments for this unit yet.{canEdit ? " Use + New assessment." : ""}</p>
        : <ul className="divide-y divide-background-100 rounded-xl border border-background-200 bg-background-50">{rows.map(a => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate font-semibold text-foreground-950">{a.code ? `${a.code} · ` : ""}{a.title}</p>
              <p className="text-xs text-foreground-500">{a.currentVersionStatus ? `${STATUS[a.currentVersionStatus] ?? a.currentVersionStatus} v${a.currentVersionNo}` : "Draft"}{a.hasDraft && a.currentVersionStatus === "published" ? " · draft changes" : ""} · {a.assignments} batch assignment{a.assignments === 1 ? "" : "s"}</p>
            </div>
            <Link to={`/admin/assessments/${a.id}`} className="shrink-0 rounded-lg border border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-800 hover:bg-background-100">Open editor</Link>
          </li>))}</ul>}
    </div>
  );
}
