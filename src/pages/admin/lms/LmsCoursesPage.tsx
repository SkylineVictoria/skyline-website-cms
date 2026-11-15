import { useCallback, useEffect, useMemo, useState } from "react";
import { rto, type CourseDetail, type RtoCourse } from "@/pages/admin/lib/rto";
import TrainingGovCourseImport, { SavedTrainingGovDetails } from "./TrainingGovCourseImport";
import { CourseFacts } from "@/pages/admin/components/rto/CourseSteps";
import { supabase } from "@/pages/admin/lib/supabase";
import CricosCourseSection from "@/pages/admin/components/rto/CricosCourseSection";
import { Modal } from "@/pages/admin/components/ui";

type Tab = "overview";
const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const icon = (name: string) => <i className={name + " text-xl text-primary-600"} aria-hidden="true" />;

interface SyncResult {
  code: string; filled: string[]; unitsUpdated: number; hoursFilled: number; unitsMatched: number; unitCount: number;
  failedSources: string[];
}
function describeSync(r: SyncResult) {
  const lines = [`Synced ${r.code} with Training.gov.au.`];
  lines.push(r.filled.length ? "Filled: " + r.filled.join(", ") + "." : "No empty course fields needed filling.");
  lines.push(`Units: ${r.unitsMatched} of ${r.unitCount} found in the release, ${r.unitsUpdated} updated, ${r.hoursFilled} got nominal hours.`);
  if (r.failedSources.length) lines.push("Not reachable: " + r.failedSources.join("; "));
  return lines;
}

/** LMS course information workspace. Reads authoritative course records only; children manage their own records. */
export default function LmsCoursesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [addingCourse, setAddingCourse] = useState<null | "choose" | "tga" | "cricos">(null);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [query, setQuery] = useState("");
  const [campus, setCampus] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [editing, setEditing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async (courseId?: string) => {
    setLoading(true);
    try {
      const [cs, me] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        rto<{rtoManager:boolean}>("me"),
      ]);
      setCourses(cs); setCanEdit(me.rtoManager); setError("");
      setSelectedId(previous => {
        const preferred = courseId ?? previous;
        return cs.some(c => c.id === preferred) ? preferred : (cs[0]?.id ?? "");
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load courses."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setDetail(null); setDetailError("");
    if (!selectedId) return;
    let current = true;
    setDetailLoading(true);
    rto<CourseDetail>("course_get", { courseId: selectedId })
      .then(result => { if (current) setDetail(result); })
      .catch(e => { if (current) setDetailError(e instanceof Error ? e.message : "Could not load course units."); })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [selectedId, reloadKey]);

  const save = useCallback(async (action: "course_save" | "units_save", data: Record<string, unknown>) => {
    if (!canEdit || !selectedId || saving) return;
    setSaving(true); setDetailError("");
    try {
      const out = await rto<CourseDetail | RtoCourse>(action, { courseId: selectedId, ...data });
      if ("course" in out) {
        setDetail(out);
        setCourses(previous => previous.map(c => c.id === selectedId ? out.course : c));
      } else {
        setDetail(previous => previous ? { ...previous, course: out } : previous);
        setCourses(previous => previous.map(c => c.id === selectedId ? out : c));
      }
      setSavedAt(new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }));
    } catch (e) { setDetailError(e instanceof Error ? e.message : "Unable to save course."); }
    finally { setSaving(false); }
  }, [canEdit, selectedId, saving]);
  const remove = useCallback(async () => {
    const course = courses.find(c => c.id === selectedId);
    if (!canEdit || !course || saving) return;
    if (!window.confirm(`Delete ${course.code} – ${course.name} and its units? This cannot be undone.`)) return;
    setSaving(true); setDetailError("");
    const { error: deleteError } = await supabase.rpc("rto_course_delete", { p_course_id: course.id });
    setSaving(false);
    if (deleteError) { setDetailError(deleteError.message || "Unable to delete the course."); return; }
    setSavedAt(""); setSelectedId("");
    void load();
  }, [canEdit, courses, load, saving, selectedId]);
  const sync = useCallback(async () => {
    if (!canEdit || !selectedId || syncing) return;
    setSyncing(true); setDetailError(""); setSyncNote([]);
    const { data, error: syncError } = await supabase.functions.invoke<SyncResult>("tga-course-import", { body: { action: "sync", courseId: selectedId } });
    setSyncing(false);
    if (syncError || !data) {
      const detail = syncError && "context" in syncError && syncError.context instanceof Response ? await syncError.context.json().catch(() => null) : null;
      setDetailError(typeof detail?.error === "string" ? detail.error : "Could not sync with Training.gov.au.");
      return;
    }
    setSyncNote(describeSync(data));
    setReloadKey(k => k + 1);
    void load(selectedId);
  }, [canEdit, load, selectedId, syncing]);
  const campuses = useMemo(() => Array.from(new Set(courses.map(c => c.campus).filter((x): x is string => !!x))).sort(), [courses]);
  const visible = useMemo(() => courses.filter(c =>
    (!activeOnly || c.isActive) && (!campus || c.campus === campus) &&
    (c.label + " " + c.code).toLowerCase().includes(query.trim().toLowerCase())
  ), [courses, query, campus, activeOnly]);
  const selected = courses.find(c => c.id === selectedId);
  const units = detail?.units ?? [];
  const nominalHours = units.reduce((sum, u) => sum + (u.nominalHours ?? 0), 0);

  return <div className="mx-auto max-w-[1500px] space-y-6 pb-12">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm font-semibold text-foreground-500">LMS <span className="mx-2">/</span> Courses</p>
        <h1 className="mt-3 font-heading text-3xl font-bold text-foreground-950">Courses</h1>
        <p className="mt-1 text-sm text-foreground-600">View and edit course information and qualification details. Units are managed separately.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
      {canEdit ? <button type="button" onClick={() => setAddingCourse("choose")} className="rounded-xl bg-primary-600 px-4 py-2.5 font-semibold text-white">+ Add New</button> : null}
      <label className="flex items-center gap-2 rounded-xl border border-background-200 bg-background-50 px-3 py-2 text-sm">
        {icon("ri-map-pin-line")}<span className="sr-only">Campus</span>
        <select className="max-w-48 bg-transparent outline-none" value={campus} onChange={e => setCampus(e.target.value)}>
          <option value="">All Campuses</option>{campuses.map(x => <option key={x} value={x}>{x}</option>)}
        </select>
      </label></div>
    </header>
    <Modal open={addingCourse === "choose" && canEdit} title="Add a course" onClose={() => setAddingCourse(null)}>
      <div className="grid gap-3 sm:grid-cols-2">
        {([
          { id: "tga", title: "From Training.gov.au", text: "Search a qualification and import its units and packaging rules.", glyph: "ri-government-line" },
          { id: "cricos", title: "From a CRICOS course code", text: "Fetch the CRICOS register entry (fees, duration, institution, locations) and create a draft course.", glyph: "ri-global-line" },
        ] as const).map(option => <button key={option.id} type="button" onClick={() => setAddingCourse(option.id)}
          className="rounded-xl border border-background-200 p-4 text-left hover:border-primary-500 hover:bg-primary-50">
          {icon(option.glyph)}<span className="mt-2 block font-semibold text-foreground-950">{option.title}</span>
          <span className="mt-1 block text-sm text-foreground-600">{option.text}</span></button>)}
      </div>
    </Modal>
    <Modal open={addingCourse === "cricos" && canEdit} title="New course from CRICOS" width="max-w-5xl" onClose={() => setAddingCourse(null)}>
      <CricosCourseSection courseId={null} onSaved={courseId => {
        setAddingCourse(null); setQuery(""); setCampus(""); setActiveOnly(false); setSavedAt(""); void load(courseId);
      }} />
    </Modal>
    {addingCourse === "tga" && canEdit && <TrainingGovCourseImport onClose={() => setAddingCourse(null)}
      onSaved={courseId => {
        setAddingCourse(null);
        setQuery("");
        setCampus("");
        setActiveOnly(false);
        setSavedAt("");
        void load(courseId);
      }} />}
    {error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error} <button className="ml-3 underline" onClick={() => void load()}>Retry</button></div> : null}
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(280px,0.95fr)_minmax(0,2.25fr)]">
      <section className={card + " p-4"}>
        <div className="flex gap-2">
          <label className="relative min-w-0 flex-1"><span className="sr-only">Search courses</span>
            <i className="ri-search-line absolute left-3 top-3 text-foreground-500" aria-hidden="true" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search courses (code or name)" className="w-full rounded-lg border border-background-300 bg-background-50 py-2.5 pl-9 pr-2 text-sm" />
          </label>
          <button type="button" title={activeOnly ? "Show all courses" : "Show active courses"} aria-pressed={activeOnly} onClick={() => setActiveOnly(v => !v)}
            className={"rounded-lg border px-3 " + (activeOnly ? "border-primary-500 bg-primary-50" : "border-background-300")}>{icon("ri-filter-3-line")}</button>
        </div>
        <p className="my-4 text-sm font-semibold text-foreground-700">{visible.length} course{visible.length === 1 ? "" : "s"}</p>
        <div className="max-h-[690px] space-y-2 overflow-auto">
          {loading ? <p className="p-3 text-sm text-foreground-500">Loading courses…</p> : visible.length === 0 ? <p className="p-3 text-sm text-foreground-500">No matching courses.</p> : visible.map(c =>
            <button key={c.id} type="button" aria-pressed={selectedId === c.id} onClick={() => { setSelectedId(c.id); setTab("overview"); setSavedAt(""); setEditing(false); setSyncNote([]); }}
              className={"flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:border-primary-500 " + (selectedId === c.id ? "border-primary-400 bg-primary-50" : "border-background-200 bg-background-50")}>
              <span className="rounded-lg bg-background-100 p-2">{icon("ri-graduation-cap-line")}</span>
              <span className="min-w-0 flex-1"><span className="block font-semibold text-foreground-950">{c.code}</span>
                <span className="mt-1 block text-sm text-foreground-600">{c.name}</span></span>
              <span className={"rounded-full px-2 py-1 text-xs font-semibold " + (c.isActive ? "bg-green-100 text-green-800" : "bg-background-200 text-foreground-600")}>{c.isActive ? "Active" : "Inactive"}</span>
            </button>)}
        </div>
      </section>
      <section className={card + " min-w-0 p-5"}>
        {!selected ? <p className="py-20 text-center text-foreground-500">{loading ? "Loading…" : "Select a course to view its delivery."}</p> : <>
          <div className="flex flex-wrap items-start gap-4">
            <span className="rounded-xl bg-primary-50 p-4">{icon("ri-graduation-cap-line")}</span>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading text-xl font-bold text-foreground-950">{selected.code} – {selected.name}</h2>
              <span className={"rounded-full px-3 py-1 text-xs font-semibold " + (selected.isActive ? "bg-green-100 text-green-800" : "bg-background-200 text-foreground-600")}>{selected.isActive ? "Active" : "Inactive"}</span>
              {selected.status === "Draft" ? <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800" title="Not published on the website">Website draft</span> : null}
            </div><p className="mt-1 text-sm text-foreground-600">{selected.cricos ? "CRICOS: " + selected.cricos : "CRICOS not specified"}</p></div>
            {canEdit ? <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 rounded-xl border border-background-300 px-3 py-2 text-sm font-semibold">
                <span>Status</span>
                <select aria-label="Course status" value={selected.isActive ? "active" : "inactive"} disabled={saving || !detail}
                  onChange={e => void save("course_save", { isActive: e.target.value === "active" })} className="bg-transparent outline-none">
                  <option value="active">Active</option><option value="inactive">Inactive</option>
                </select>
              </label>
              <button type="button" onClick={() => void sync()} disabled={syncing || saving}
                title="Fetch Training.gov.au, CRICOS and nominal hours again and fill in missing details"
                className="flex items-center gap-1 rounded-xl border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50">
                <i className={"ri-refresh-line" + (syncing ? " animate-spin" : "")} aria-hidden="true" />{syncing ? "Syncing…" : "Sync"}</button>
              <button type="button" onClick={() => setEditing(v => !v)} disabled={!detail} aria-expanded={editing}
                className={"flex items-center gap-1 rounded-xl border px-3 py-2 text-sm font-semibold disabled:opacity-50 " + (editing ? "border-primary-500 bg-primary-50 text-primary-700" : "border-background-300 text-foreground-800 hover:bg-background-100")}>
                <i className={editing ? "ri-close-line" : "ri-edit-line"} aria-hidden="true" />{editing ? "Close edit" : "Edit"}</button>
              <button type="button" onClick={() => void remove()} disabled={saving}
                className="flex items-center gap-1 rounded-xl border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
                <i className="ri-delete-bin-line" aria-hidden="true" />Delete</button>
            </div> : null}
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Duration", value: selected.duration || "—", iconName: "ri-calendar-line" },
              { label: "Delivery Mode", value: selected.mode || "—", iconName: "ri-stack-line" },
              { label: "Campus", value: selected.campus || "Not specified", iconName: "ri-map-pin-line" },
              { label: "Nominal Hours", value: detailLoading ? "…" : detail ? nominalHours.toLocaleString() : "—", iconName: "ri-time-line" },
            ].map(item => <div key={item.label} className="flex items-center gap-3 rounded-xl border border-background-200 bg-background-50 p-3">
              <span className="rounded-lg bg-primary-50 p-2">{icon(item.iconName)}</span><div className="min-w-0">
                <p className="text-xs text-foreground-500">{item.label}</p><p className="font-semibold text-foreground-950">{item.value}</p>
              </div>
            </div>)}
          </div>
          <div className="mt-3 text-right text-xs text-foreground-500" role="status">{saving ? "Saving changes…" : savedAt ? "Saved " + savedAt : canEdit ? "Changes autosave" : "Read only"}</div>
          {editing && canEdit && detail ? <div className="mt-5 space-y-5">
            <CricosCourseSection key={selectedId + ":edit"} courseId={selectedId} onSaved={() => { setReloadKey(k => k + 1); void load(selectedId); }} />
            <CourseFacts key={selectedId + ":" + reloadKey} course={detail.course} readOnly={false} busy={saving} autosave onSave={data => void save("course_save", data)} />
          </div> : null}
          {syncNote.length ? <div role="status" className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            <ul className="space-y-1">{syncNote.map(line => <li key={line}>{line}</li>)}</ul>
            <button type="button" aria-label="Dismiss" onClick={() => setSyncNote([])}><i className="ri-close-line" aria-hidden="true" /></button></div> : null}
          {detailError ? <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{detailError}</div> : null}
          <div role="tablist" aria-label="Course sections" className="mt-7 flex flex-wrap gap-6 border-b border-background-200">
            {([{ id: "overview", label: "Overview", glyph: "ri-information-line" }] as const).map(t =>
              <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
                className={"flex items-center gap-2 border-b-2 px-1 py-3 text-sm font-semibold " + (tab === t.id ? "border-primary-600 text-primary-600" : "border-transparent text-foreground-600")}>
                <i className={t.glyph} aria-hidden="true" />{t.label}</button>)}
          </div>
          {tab === "overview" && detail && !editing ? <div className="mt-5"><CricosCourseSection key={selectedId + ":view:" + reloadKey} courseId={selectedId} readOnly /></div> : null}
          {tab === "overview" && detail && <SavedTrainingGovDetails key={selectedId + ":" + reloadKey} courseId={selectedId} units={detail.units} />}
          {tab === "overview" && !canEdit ? <div role="tabpanel" className="grid gap-4 pt-5 sm:grid-cols-2">
            {[["Course code", selected.code], ["Course name", selected.name], ["CRICOS", selected.cricos || "—"], ["Duration", selected.duration || "—"], ["Delivery mode", selected.mode || "—"], ["Campus", selected.campus || "—"], ["Training package", selected.trainingPackage || "—"], ["Category", selected.category || "—"]].map(([label, value]) =>
              <div key={label} className="rounded-xl bg-background-100 p-4"><p className="text-xs text-foreground-500">{label}</p><p className="mt-1 font-semibold">{value}</p></div>)}
          </div> : null}
        </>}
      </section>
    </div>
  </div>;
}
