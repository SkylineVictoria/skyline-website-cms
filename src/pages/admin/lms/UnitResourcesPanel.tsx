import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";
import { accessLabels, bulkAdmin, categories, categoryLabel, downloadResource, listResources, type BulkPolicy, type Category, type Resource } from "@/pages/admin/lib/bulkResources";

const button = "rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-50";

export default function UnitResourcesPanel({ courseId, unitId, canManage, onBulk }: {
  courseId: string; unitId: string; canManage: boolean; onBulk: () => void;
}) {
  const [selected, setSelected] = useState<Category>("learning");
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [assessments, setAssessments] = useState<AssessmentRow[]>([]);
  const [policy, setPolicy] = useState<BulkPolicy | null>(null);
  const [publishing, setPublishing] = useState<Resource | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const handleError = (e: unknown) => setError(e instanceof Error ? e.message : "The resource could not be updated.");
  const load = useCallback(async () => {
    setResources(await listResources(unitId));
  }, [unitId]);
  useEffect(() => { void load().catch(handleError); }, [load]);
  useEffect(() => {
    if (!canManage) return;
    void bulkAdmin<BulkPolicy>("policy").then(setPolicy).catch(() => setPolicy(null));
    void asmAdmin<AssessmentRow[]>("assessment_list", { courseId, includeArchived: false })
      .then(rows => setAssessments(rows.filter(row => row.unitId === unitId))).catch(handleError);
  }, [canManage, courseId, unitId]);

  const act = async (action: string, data: Record<string, unknown>) => {
    setBusy(true); setError("");
    try { await bulkAdmin(action, data); await load(); setPublishing(null); }
    catch (e) { handleError(e); }
    finally { setBusy(false); }
  };
  const createAssessment = async (resource: Resource) => {
    setBusy(true); setError("");
    let created: string | undefined;
    try {
      const result = await asmAdmin<{ id?: string }>("assessment_create", { courseId, unitId, title: resource.title });
      if (!result.id) throw new Error("No assessment was created.");
      created = result.id;
      await bulkAdmin("link", { id: resource.id, assessmentId: created });
      const list = await asmAdmin<AssessmentRow[]>("assessment_list", { courseId, includeArchived: false });
      setAssessments(list.filter(row => row.unitId === unitId));
      await load();
    } catch (e) { handleError(created ? new Error(`Draft assessment ${created} was created. Link it through the assessment picker.`) : e); }
    finally { setBusy(false); }
  };

  const shown = resources?.filter(r => r.category === selected);
  return <section className="space-y-3" aria-label="Unit resources">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-heading font-bold text-foreground-950">Unit resources</h3>
      {canManage && <button type="button" className="rounded-lg bg-primary-700 px-3 py-2 text-sm font-semibold text-white" onClick={onBulk}>AI Bulk Upload</button>}
    </header>
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Resource categories">
      {categories.map(category => <button type="button" role="tab" aria-selected={category === selected} key={category} onClick={() => setSelected(category)}
        className={button + (category === selected ? " border-primary-500 bg-primary-50 text-primary-800" : "")}>
        {categoryLabel(category, policy)}{resources ? ` (${resources.filter(r => r.category === category).length})` : ""}
      </button>)}
    </div>
    {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>}
    {!shown ? <p role="status" className="text-sm">Loading resources…</p> : shown.length === 0 ?
      <p className="rounded-lg border border-dashed border-background-300 p-4 text-sm text-foreground-600">No resources in this category.</p> :
      <ul className="divide-y divide-background-200 rounded-lg border border-background-200">
        {shown.map(resource => {
          const status = resource.published_at ? "Published" : resources?.some(r => r.previous_id === resource.id && r.published_at) ? "Superseded" : "Unpublished";
          return <li key={resource.id} className="space-y-2 p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><p className="font-semibold text-foreground-950">{resource.title}</p>
                <p className="break-all text-xs text-foreground-600">{resource.name}</p>
                <p className="text-xs text-foreground-600">{status} · {accessLabels[resource.audience]}{resource.previous_id ? " · Updated version" : ""}</p></div>
              <button className={button} type="button" onClick={() => void downloadResource(resource.path, resource.name).catch(handleError)}>Open file</button>
            </div>
            {canManage && <div className="flex flex-wrap items-center gap-2">
              {resource.published_at
                ? <button type="button" className={button} disabled={busy} onClick={() => void act("unpublish", { id: resource.id })}>Unpublish</button>
                : <button type="button" className={button} disabled={busy || status === "Superseded" || !policy?.allow_publication} onClick={() => { setPublishing(resource); setChecked(false); }}>Publish</button>}
              {resource.category === "assessment" && <>
                <select className={button + " max-w-56"} aria-label={`Link assessment for ${resource.title}`} disabled={busy} value={resource.assessment_id ?? ""}
                  onChange={e => void act("link", { id: resource.id, assessmentId: e.target.value })}>
                  <option value="">Assessment resource only</option>
                  {assessments.map(a => <option value={a.id} key={a.id}>{a.title}</option>)}
                </select>
                {resource.assessment_id
                  ? <Link className="text-primary-800 underline" to={`/admin/assessments/${resource.assessment_id}`}>Open assessment</Link>
                  : <button type="button" className={button} disabled={busy} onClick={() => void createAssessment(resource)}>Create assessment draft</button>}
              </>}
            </div>}
            {publishing?.id === resource.id && <div className="space-y-3 rounded-lg bg-primary-50 p-3">
              <p>Publish {resource.title} for {accessLabels[resource.audience].toLowerCase()}?</p>
              {resource.audience === "student_staff" && <label className="flex items-center gap-2"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />
                I checked this document for assessor-only answers and marking guidance.</label>}
              <div className="flex gap-2">
                <button className={button + " bg-white"} type="button" disabled={busy || (resource.audience === "student_staff" && !checked)}
                  onClick={() => void act("publish", { id: resource.id, contentChecked: checked })}>Confirm publication</button>
                <button className={button} type="button" disabled={busy} onClick={() => setPublishing(null)}>Cancel</button>
              </div>
            </div>}
          </li>;
        })}
      </ul>}
  </section>;
}
