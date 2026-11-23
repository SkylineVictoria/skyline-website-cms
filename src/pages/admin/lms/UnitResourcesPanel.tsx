import { Fragment, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";
import { accessLabels, bulkAdmin, categories, categoryLabel, categoryTitle, downloadResource, listResources, splitCategoryTitle, type BulkPolicy, type Category, type Resource } from "@/pages/admin/lib/bulkResources";

import { supabase } from "@/pages/admin/lib/supabase";

/** A document saved straight to the unit (Add from documents, no AI reader): a unit_contents file whose title carries its category. */
type UnitDoc = { id: string; title: string; file_name: string | null; size_bytes: number | null; storage_path: string | null; visible_to_students: boolean };

const categoryStyles: Record<Category, { icon: string; tone: string }> = {
  learning: { icon: "ri-book-open-line", tone: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300" },
  assessment: { icon: "ri-clipboard-line", tone: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300" },
  self_assessment: { icon: "ri-list-check-3", tone: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" },
  assessor: { icon: "ri-shield-check-line", tone: "border-orange-200 bg-orange-50 text-orange-900 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300" },
};

function formatBytes(bytes: number) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

const button = "rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-50";

export default function UnitResourcesPanel({ courseId, unitId, canManage, canEdit = false, onBulk, onAddContent }: {
  courseId: string; unitId: string; canManage: boolean; canEdit?: boolean; onBulk: (files?: File[]) => void; onAddContent?: () => void;
}) {
  const [docs, setDocs] = useState<UnitDoc[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string; category: Category; visible: boolean } | null>(null);
  const loadDocs = useCallback(async () => {
    const { data, error } = await supabase.from("unit_contents").select("id,title,file_name,size_bytes,storage_path,visible_to_students")
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
  const docsIn = (category: Category) => (docs ?? []).filter(doc => splitCategoryTitle(doc.title, policy).category === category);
  const shownDocs = docsIn(selected);
  const countIn = (category: Category) => (resources?.filter(resource => resource.category === category).length ?? 0) + docsIn(category).length;
  return <section className="space-y-3" aria-label="Unit resources">
    {canManage && <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-violet-400 bg-violet-50/70 p-4 dark:bg-violet-950/30"
      onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const files = Array.from(event.dataTransfer.files); if (files.length) onBulk(files); }}>
      <div className="flex items-center gap-3">
        <i className="ri-upload-cloud-2-line text-3xl text-violet-700 dark:text-violet-300" aria-hidden="true" />
        <div><h3 className="font-heading font-bold">Upload unit resources</h3>
          <p className="text-sm text-foreground-600">Drop a ZIP package or individual files here.</p>
          {policy && <p className="mt-1 text-xs text-foreground-600">{policy.formats.map(format => format.toUpperCase()).join(", ")} · Up to {policy.max_mib} MiB per file</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white" onClick={() => onBulk()}>Upload ZIP package</button>
        <label className={button + " cursor-pointer border-violet-400 bg-background-50 text-violet-800 focus-within:ring-2 focus-within:ring-violet-500 dark:text-violet-300"}>
          + Add files<input className="sr-only" type="file" multiple onChange={event => { const files = Array.from(event.currentTarget.files ?? []); if (files.length) onBulk(files); }} />
        </label>
      </div>
    </section>}
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4" aria-label="Resource categories">
      {categories.map(category => {
        const { icon, tone } = categoryStyles[category];
        const count = resources || docs ? countIn(category) : undefined;
        return <button type="button" aria-pressed={category === selected} key={category} onClick={() => setSelected(category)}
          className={`flex min-h-24 flex-col items-start gap-1 rounded-xl border p-3 text-left ${tone} ${category === selected ? "ring-2 ring-inset ring-current" : "hover:shadow-sm"}`}>
          <span className="flex w-full items-center justify-between"><i className={icon + " text-xl"} aria-hidden="true" />
            {category === "assessor" && <i className="ri-lock-line" aria-label="Restricted access" />}</span>
          <span className="text-sm font-bold">{categoryLabel(category, policy)}</span>
          <span className="text-xs">{count !== undefined ? `${count} ${count === 1 ? "file" : "files"}` : "Loading…"}</span>
        </button>;
      })}
    </div>
    <header className="flex flex-wrap items-center justify-between gap-2 border-t border-background-200 pt-3">
      <h3 className="font-heading font-bold text-slate-950 dark:text-slate-50"><i className={categoryStyles[selected].icon + " mr-2 text-violet-700 dark:text-violet-300"} aria-hidden="true" />
        {categoryLabel(selected, policy)}{(shown || docs) && ` (${countIn(selected)})`}</h3>
      {onAddContent && selected === "learning" && <button type="button" className={button} onClick={onAddContent}>+ Add learning content</button>}
    </header>
    {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>}
    {!shown && !docs ? <p role="status" className="text-sm">Loading resources…</p> : !shown?.length && !shownDocs.length ?
      <p className="rounded-lg border border-dashed border-background-300 p-4 text-sm text-foreground-600">No resources in this category.</p> :
      <div className="overflow-x-auto rounded-lg border border-background-200">
      <table className="w-full min-w-[34rem] text-left text-sm">
      <thead className="bg-background-100 text-xs text-foreground-700"><tr>
        {["File name", "Type", "Size", "Access", "Status", "Actions"].map(label => <th scope="col" className="px-2.5 py-2" key={label}>{label}</th>)}
      </tr></thead><tbody className="divide-y divide-background-200">
        {shownDocs.map(doc => {
          const parts = splitCategoryTitle(doc.title, policy);
          const edit = editing?.id === doc.id ? editing : null;
          return <Fragment key={doc.id}>
            <tr className="align-top">
              <td className="min-w-32 break-words px-2.5 py-2.5"><p className="font-semibold">{parts.title}</p><p className="text-xs text-foreground-600">{doc.file_name}</p></td>
              <td className="px-2.5 py-2.5 text-xs font-semibold">{doc.file_name?.includes(".") ? doc.file_name.split(".").at(-1)?.toUpperCase() : "File"}</td>
              <td className="whitespace-nowrap px-2.5 py-2.5 text-xs">{doc.size_bytes ? formatBytes(doc.size_bytes) : "—"}</td>
              <td className="px-2.5 py-2.5 text-xs">{doc.visible_to_students ? "Student & Staff" : "Staff only"}</td>
              <td className="px-2.5 py-2.5 text-xs font-semibold">On unit</td>
              <td className="px-2.5 py-2.5"><div className="flex flex-wrap gap-1">
                <button className={button} type="button" onClick={() => void openDoc(doc)}>Open</button>
                {canEdit && !edit && <button className={button} type="button" disabled={busy} onClick={() => setEditing({ id: doc.id, title: parts.title, category: parts.category, visible: doc.visible_to_students })}>Edit</button>}
                {canEdit && <button className={button + " text-red-700"} type="button" disabled={busy} onClick={() => void deleteDoc(doc)}>Delete</button>}
              </div></td>
            </tr>
            {edit && <tr><td colSpan={6} className="p-2">
          <div className="grid gap-2 rounded-lg bg-background-100 p-3 sm:grid-cols-[1fr_auto]">
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
          </div>
            </td></tr>}
          </Fragment>;
        })}
        {shown?.map(resource => {
          const status = resource.published_at ? "Published" : resources?.some(r => r.previous_id === resource.id && r.published_at) ? "Superseded" : "Unpublished";
          return <tr key={resource.id} className="align-top">
            <td className="min-w-32 break-words px-2.5 py-2.5"><p className="font-semibold">{resource.title}</p>
              <p className="text-xs text-foreground-600">{resource.name}{resource.previous_id ? " · Updated version" : ""}</p></td>
            <td className="px-2.5 py-2.5 text-xs font-semibold text-violet-800 dark:text-violet-300">{resource.name.includes(".") ? resource.name.split(".").at(-1)?.toUpperCase() : "File"}</td>
            <td className="whitespace-nowrap px-2.5 py-2.5 text-xs">{formatBytes(resource.bytes)}</td>
            <td className="px-2.5 py-2.5 text-xs">{accessLabels[resource.audience]}</td>
            <td className="px-2.5 py-2.5 text-xs font-semibold">{status}</td>
            <td className="space-y-2 px-2.5 py-2.5">
              <button className={button} type="button" onClick={() => void downloadResource(resource.path, resource.name).catch(handleError)}>Download</button>
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
            </td>
          </tr>;
        })}
      </tbody></table></div>}
  </section>;
}
