import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";
import { accessLabels, bulkAdmin, categories, categoryLabel, categoryTitle, downloadResource, listResources, splitCategoryTitle, type BulkPolicy, type Category, type Resource } from "@/pages/admin/lib/bulkResources";
import { supabase } from "@/pages/admin/lib/supabase";

/** A document saved straight to the unit (Add from documents, no AI reader): a unit_contents file whose title carries its category. */
type UnitDoc = { id: string; title: string; file_name: string | null; storage_path: string | null; visible_to_students: boolean };

const button = "rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-50";

export default function UnitResourcesPanel({ courseId, unitId, canManage, canEdit = false, onBulk }: {
  courseId: string; unitId: string; canManage: boolean;
  /** RTO Managers edit and delete the documents saved straight to the unit. */
  canEdit?: boolean; onBulk: () => void;
}) {
  const [docs, setDocs] = useState<UnitDoc[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string; category: Category; visible: boolean } | null>(null);
  const loadDocs = useCallback(async () => {
    const { data, error } = await supabase.from("unit_contents").select("id,title,file_name,storage_path,visible_to_students")
      .eq("unit_id", unitId).eq("kind", "file").order("sort");
    if (error) throw new Error(error.message);
    setDocs((data ?? []) as UnitDoc[]);
  }, [unitId]);
  useEffect(() => { void loadDocs().catch(e => setError(e instanceof Error ? e.message : "The documents could not be loaded.")); }, [loadDocs]);
  const openDoc = async (doc: UnitDoc) => {
    if (!doc.storage_path) return;
    const { data, error } = await supabase.storage.from("unit-content").createSignedUrl(doc.storage_path, 300);
    if (error || !data?.signedUrl) { setError("The file could not be opened."); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };
  const saveDoc = async () => {
    if (!editing || !editing.title.trim()) return;
    setBusy(true); setError("");
    try {
      const { error } = await supabase.from("unit_contents").update({ title: categoryTitle(editing.category, editing.title, policy), visible_to_students: editing.visible }).eq("id", editing.id);
      if (error) throw new Error(error.message);
      setEditing(null); await loadDocs();
    } catch (e) { setError(e instanceof Error ? e.message : "The document could not be saved."); }
    finally { setBusy(false); }
  };
  const deleteDoc = async (doc: UnitDoc) => {
    if (!window.confirm(`Delete "${splitCategoryTitle(doc.title, policy).title}"? The file is removed from this unit.`)) return;
    setBusy(true); setError("");
    try {
      const { error } = await supabase.from("unit_contents").delete().eq("id", doc.id);
      if (error) throw new Error(error.message);
      if (doc.storage_path) await supabase.storage.from("unit-content").remove([doc.storage_path]);
      await loadDocs();
    } catch (e) { setError(e instanceof Error ? e.message : "The document could not be deleted."); }
    finally { setBusy(false); }
  };
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
  const docsIn = (category: Category) => (docs ?? []).filter(d => splitCategoryTitle(d.title, policy).category === category);
  const shownDocs = docsIn(selected);
  return <section className="space-y-3" aria-label="Unit resources">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-heading font-bold text-slate-950 dark:text-slate-50">Unit resources</h3>
      {canManage && <button type="button" className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white" onClick={onBulk}>AI Bulk Upload</button>}
    </header>
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Resource categories">
      {categories.map(category => <button type="button" role="tab" aria-selected={category === selected} key={category} onClick={() => setSelected(category)}
        className={button + (category === selected ? " border-violet-500 bg-violet-50 dark:bg-violet-950/40 text-violet-800 dark:text-violet-300" : "")}>
        {categoryLabel(category, policy)}{resources ? ` (${resources.filter(r => r.category === category).length + docsIn(category).length})` : ""}
      </button>)}
    </div>
    {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>}
    {shownDocs.length ? <ul className="divide-y divide-background-200 rounded-lg border border-background-200" aria-label="Documents on this unit">
      {shownDocs.map(doc => {
        const parts = splitCategoryTitle(doc.title, policy);
        const edit = editing?.id === doc.id ? editing : null;
        return <li key={doc.id} className="space-y-2 p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><p className="font-semibold text-slate-950 dark:text-slate-50">{parts.title}</p>
              <p className="break-all text-xs text-foreground-600">{doc.file_name}</p>
              <p className="text-xs text-foreground-600">{doc.visible_to_students ? "Students and staff" : "Staff only"} · on the unit</p></div>
            <div className="flex flex-wrap gap-2">
              <button className={button} type="button" onClick={() => void openDoc(doc)}>Open file</button>
              {canEdit && !edit ? <button className={button} type="button" disabled={busy} onClick={() => setEditing({ id: doc.id, title: parts.title, category: parts.category, visible: doc.visible_to_students })}>Edit</button> : null}
              {canEdit ? <button className={button + " text-red-700"} type="button" disabled={busy} onClick={() => void deleteDoc(doc)}>Delete</button> : null}
            </div>
          </div>
          {edit ? <div className="grid gap-2 rounded-lg bg-background-100 p-3 sm:grid-cols-[1fr_auto]">
            <label className="flex flex-col gap-1 text-xs font-semibold text-foreground-600">Title
              <input className="rounded-lg border border-background-300 px-2.5 py-1.5 text-sm font-normal text-foreground-900" value={edit.title} maxLength={180}
                onChange={e => setEditing({ ...edit, title: e.target.value })} /></label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-foreground-600">Category
              <select className="rounded-lg border border-background-300 px-2.5 py-1.5 text-sm font-normal text-foreground-900" value={edit.category}
                onChange={e => { const category = e.target.value as Category; setEditing({ ...edit, category, visible: category === "learning" || category === "self_assessment" ? edit.visible : false }); }}>
                {categories.map(c => <option key={c} value={c}>{categoryLabel(c, policy)}</option>)}
              </select></label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={edit.visible} disabled={edit.category === "assessment" || edit.category === "assessor"}
              onChange={e => setEditing({ ...edit, visible: e.target.checked })} />Students can see it{edit.category === "assessment" || edit.category === "assessor" ? " (never for assessments and assessor resources)" : ""}</label>
            <div className="flex gap-2 sm:col-span-2">
              <button className={button + " bg-white"} type="button" disabled={busy || !edit.title.trim()} onClick={() => void saveDoc()}>Save</button>
              <button className={button} type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div> : null}
        </li>;
      })}
    </ul> : null}
    {!shown ? <p role="status" className="text-sm">Loading resources…</p> : shown.length === 0 ? shownDocs.length ? null :
      <p className="rounded-lg border border-dashed border-background-300 p-4 text-sm text-foreground-600">No resources in this category.</p> :
      <ul className="divide-y divide-background-200 rounded-lg border border-background-200">
        {shown.map(resource => {
          const status = resource.published_at ? "Published" : resources?.some(r => r.previous_id === resource.id && r.published_at) ? "Superseded" : "Unpublished";
          return <li key={resource.id} className="space-y-2 p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><p className="font-semibold text-slate-950 dark:text-slate-50">{resource.title}</p>
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
                  ? <Link className="text-violet-800 dark:text-violet-300 underline" to={`/admin/assessments/${resource.assessment_id}`}>Open assessment</Link>
                  : <button type="button" className={button} disabled={busy} onClick={() => void createAssessment(resource)}>Create assessment draft</button>}
              </>}
            </div>}
            {publishing?.id === resource.id && <div className="space-y-3 rounded-lg bg-violet-50 dark:bg-violet-950/40 p-3">
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
