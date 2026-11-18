import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ListPane from "@/pages/admin/components/ListPane";
import { useListPane } from "@/pages/admin/lib/listPane";
import { courseWeeksLabel, HOURS_PER_WEEK, loadUnitHours, rto, shownHours, type CourseDetail, type RtoCourse, type UnitHours } from "@/pages/admin/lib/rto";
import TrainingGovCourseImport, { SavedTrainingGovDetails } from "./TrainingGovCourseImport";
import { CourseFacts } from "@/pages/admin/components/rto/CourseSteps";
import { supabase } from "@/pages/admin/lib/supabase";
import { invokeTga } from "@/pages/admin/lib/tga";
import CricosCourseSection from "@/pages/admin/components/rto/CricosCourseSection";
import TrainingGovBulkSync from "@/pages/admin/components/rto/TrainingGovBulkSync";
import LmsUnitsPage from "./LmsUnitsPage";
import UnitHoursEditor from "./UnitHoursEditor";
import StartDateBreaksEditor from "./StartDateBreaksEditor";
import MasterTimetableTab from "./MasterTimetableTab";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import AddUnitsFromTga from "./AddUnitsFromTga";
import { useNavigate, useSearchParams } from "react-router-dom";
import { loadCricos, lookupCricos, saveCricos } from "@/pages/admin/lib/cricos";

type Tab = "overview" | "units" | "master";
const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const icon = (name: string) => <i className={name + " text-xl text-primary-600"} aria-hidden="true" />;

interface SyncResult {
  code: string; filled: string[]; unitsUpdated: number; hoursFilled: number; unitsMatched: number; unitCount: number;
  failedSources: string[];
  coreAdded?: number; electivesAdded?: number; detailsSynced?: number; detailsFailed?: number; elementsAdded?: number; columnsMissing?: boolean;
  cricos: { registered: boolean; providerCode: string; courseCode: string | null } | null;
}
function describeSync(r: SyncResult) {
  const lines = [`Synced ${r.code} with Training.gov.au.`];
  lines.push(r.filled.length ? "Filled: " + r.filled.join(", ") + "." : "No empty course fields needed filling.");
  lines.push(`Units: ${r.unitsMatched} of ${r.unitCount} found in the release, ${r.unitsUpdated} refreshed (prerequisites, usage, groups)` +
    (r.hoursFilled ? `, ${r.hoursFilled} given nominal hours.` : "; units that already had nominal hours were left as they are."));
  const added = (r.coreAdded ?? 0) + (r.electivesAdded ?? 0);
  if (added) lines.push(`Added ${added} missing core unit${added === 1 ? "" : "s"}. Choose electives with Units › Add Unit.`);
  if (r.detailsSynced || r.elementsAdded) lines.push(`Unit content: details refreshed for ${r.detailsSynced ?? 0} active units; elements, criteria and evidence added for ${r.elementsAdded ?? 0}.`);
  if (r.detailsFailed) lines.push(`${r.detailsFailed} units could not be read from training.gov.au; run Sync again later.`);
  if (r.columnsMissing) lines.push("Unit release and application details need the database update (migration 20261115140000).");
  // CRICOS is reported on its own line (see fillCricos), never as a failed source.
  const failed = r.failedSources.filter(source => !source.startsWith("CRICOS"));
  if (failed.length) lines.push("Not reachable: " + failed.join("; "));
  return lines;
}

/** After a sync: fill the CRICOS register entry when the qualification is registered and the course has none yet. */
async function fillCricos(courseId: string, r: SyncResult): Promise<string> {
  if (!r.cricos) return "CRICOS: not checked (set the CRICOS provider code in Settings, or the register did not respond).";
  if (!r.cricos.registered || !r.cricos.courseCode) {
    return `CRICOS: ${r.code} is not registered on CRICOS for provider ${r.cricos.providerCode}, so there is no CRICOS code to fill.`;
  }
  const code = r.cricos.courseCode;
  try {
    const current = await loadCricos(courseId);
    if (current.fetchedAt || current.fields.cricos_course_code) {
      return `CRICOS: registered as ${code}. The course already has CRICOS details; use Edit › Fetch from CRICOS to compare and update them.`;
    }
    const lookup = await lookupCricos(code);
    await saveCricos(courseId, { fields: lookup.fields, locations: lookup.locations, snapshot: lookup.snapshot, fetchedAt: lookup.fetched_at, edited: [] });
    const weeks = lookup.fields.cricos_duration_weeks;
    const detail = await rto<CourseDetail>("course_get", { courseId });
    if (!detail.course.duration?.trim() && typeof weeks === "number") await rto("course_save", { courseId, duration: `${weeks} weeks` });
    return `CRICOS: filled from ${code} (fees, duration, institution, locations).` + (lookup.warnings.length ? " " + lookup.warnings.join(" ") : "");
  } catch (e) {
    return `CRICOS: registered as ${code}, but it could not be filled automatically (${e instanceof Error ? e.message : "error"}). Use Edit › Fetch from CRICOS.`;
  }
}

/** LMS course information workspace. Reads authoritative course records only; children manage their own records. */
export default function LmsCoursesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [addingCourse, setAddingCourse] = useState<null | "tga">(null);
  const [selectedId, setSelectedId] = useState("");
  const pane = useListPane("courses");
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [unitHours, setUnitHours] = useState<Record<string, UnitHours>>({});
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
  const [bulkSync, setBulkSync] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  // New course wizard: 1 course (Add course / Sync), 2 units in the Add units popup (packaging rules met), 3 the units' SLIT
  // hours, 4 the master timetable (start date and term breaks: every unit's dates are calculated), 5 its first intake, then on
  // the intake: 6 a batch. Students are added only through the enrolment wizard.
  const [wizard, setWizard] = useState<{ courseId: string; step: "units" | "hours" | "master" | "intake"; hidden?: boolean } | null>(null);
  const navigate = useNavigate();

  // Only the latest load picks the course: an older one finishing later must not switch back (it hid the wizard after Sync).
  const loadSeq = useRef(0);
  const load = useCallback(async (courseId?: string) => {
    const mine = ++loadSeq.current;
    setLoading(true);
    try {
      const [cs, me] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        rto<{rtoManager:boolean}>("me"),
      ]);
      if (mine !== loadSeq.current) return;
      setCourses(cs); setCanEdit(me.rtoManager); setError("");
      setSelectedId(previous => {
        const preferred = courseId ?? previous;
        return cs.some(c => c.id === preferred) ? preferred : (cs[0]?.id ?? "");
      });
    } catch (e) { if (mine === loadSeq.current) setError(e instanceof Error ? e.message : "Could not load courses."); }
    finally { if (mine === loadSeq.current) setLoading(false); }
  }, []);
  const [params, setParams] = useSearchParams();
  useEffect(() => { void load(params.get("course") ?? undefined); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  // A link such as the dashboard's "Open master timetable" names the course and the tab.
  useEffect(() => {
    const wanted = params.get("tab");
    if (!params.get("course") || !courses.length) return;
    if (wanted === "master" || wanted === "units") setTab(wanted);
    setParams({}, { replace: true });
  }, [courses, params, setParams]);
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
  // SLIT hours per unit (accepted, or the nominal hours until accepted) give the course duration.
  useEffect(() => {
    setUnitHours({});
    if (!selectedId) return;
    let current = true;
    loadUnitHours(selectedId)
      .then(list => { if (current) setUnitHours(Object.fromEntries(list.map(h => [h.unitId, h]))); })
      .catch(() => { /* without saved hours the nominal hours are used */ });
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
    if (!window.confirm(`Delete ${course.code} – ${course.name} and its units? Draft applications that chose it lose the course and must choose again. This cannot be undone.`)) return;
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
    const { data, error: syncError } = await invokeTga<SyncResult>({ action: "sync", courseId: selectedId });
    setSyncing(false);
    if (syncError || !data) {
      const detail = syncError && "context" in syncError && syncError.context instanceof Response ? await syncError.context.json().catch(() => null) : null;
      setDetailError(typeof detail?.error === "string" ? detail.error : "Could not sync with Training.gov.au.");
      return;
    }
    setSyncNote([...describeSync(data), await fillCricos(selectedId, data)]);
    setReloadKey(k => k + 1);
    void load(selectedId);
  }, [canEdit, load, selectedId, syncing]);
  const campuses = useMemo(() => Array.from(new Set(courses.map(c => c.campus).filter((x): x is string => !!x))).sort(), [courses]);
  const visible = useMemo(() => courses.filter(c =>
    (!activeOnly || c.isActive) && (!campus || c.campus === campus) &&
    (c.label + " " + c.code).toLowerCase().includes(query.trim().toLowerCase())
  ), [courses, query, campus, activeOnly]);
  const selected = courses.find(c => c.id === selectedId);
  // Inactive units (electives not delivered) do not count toward the course.
  const units = (detail?.units ?? []).filter(unit => unit.isActive);
  const slit = units.map(u => shownHours(u.id ? unitHours[u.id] : undefined, u.nominalHours));
  const slitHours = slit.reduce((sum, h) => sum + (h?.slitHours ?? 0), 0);
  const slitPending = slit.some(h => h && !h.confirmed);
  const slitDuration = detail && slitHours > 0 ? courseWeeksLabel(slitHours) : "";

  const pick = (id: string) => { setSelectedId(id); setTab("overview"); setSavedAt(""); setEditing(false); setSyncNote([]); setMenuOpen(false); };
  /** next: "units" opens Add units (then the first intake), "intake" opens New intake (units already chosen), "none" just shows it. */
  const reloadAfterAdd = (courseId: string, next: "units" | "intake" | "none" = "none") => {
    setAddingCourse(null); setQuery(""); setCampus(""); setActiveOnly(false); setSavedAt(""); setEditing(false); setSyncNote([]);
    setTab(next === "none" ? "overview" : "units"); setWizard(next === "none" ? null : { courseId, step: next });
    setReloadKey(k => k + 1); void load(courseId);
  };
  const facts: [string, string][] = selected ? [
    ["Duration", detailLoading ? "…" : slitDuration || "—"], ["Delivery", selected.mode || "—"], ["Campus", selected.campus || "—"],
    ["Units", detail ? String(units.length) : "…"],
    ["SLIT hours", detailLoading ? "…" : detail ? slitHours.toLocaleString() + (slitPending ? " (to review)" : "") : "—"],
  ] : [];
  const tabs = [{ id: "overview", label: "Overview" }, { id: "units", label: "Units" }, { id: "master", label: "Master timetable" }] as const;
  const menuItem = "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-background-100 disabled:opacity-50";

  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Courses</h1>
        <p className="text-sm text-foreground-500">Qualifications, their CRICOS registration and units.</p>
      </div>
      {canEdit ? <div className="flex items-center gap-2">
        <button type="button" onClick={() => setBulkSync(true)} title="Import one qualification from SLIT's Training.gov.au scope of registration and run the new course wizard on it"
          className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100">Sync from Training.gov.au</button>
        <button type="button" onClick={() => setAddingCourse("tga")} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">Add course</button>
      </div> : null}
    </header>

    <TrainingGovBulkSync open={bulkSync && canEdit} courses={courses} onClose={() => setBulkSync(false)}
      onDone={() => { setReloadKey(k => k + 1); void load(selectedId || undefined); }}
      onAddUnits={courseId => { setBulkSync(false); reloadAfterAdd(courseId, "units"); }} />
    {wizard?.step === "units" && !wizard.hidden && canEdit && detail?.course.id === wizard.courseId
      ? <AddUnitsFromTga course={detail.course} units={detail.units} stepLabel="Step 2 of 6 · Units"
        // The course reloads when the popup closes: reloading earlier would close it before its result and next step show.
        // Closing keeps the wizard: the bar on the Units tab opens the popup again.
        onClose={() => { setWizard(w => (w ? { ...w, hidden: true } : w)); setReloadKey(k => k + 1); }} onDone={() => undefined}
        nextStep={{ label: "Next: unit hours", onClick: () => { setWizard({ courseId: wizard.courseId, step: "hours" }); setReloadKey(k => k + 1); } }} /> : null}
    {wizard?.step === "hours" && canEdit && selected?.id === wizard.courseId
      ? <UnitHoursEditor course={selected} stepLabel="Step 3 of 6 · Hours" onClose={() => { setWizard(null); setReloadKey(k => k + 1); }} onSaved={() => undefined}
        nextStep={{ label: "Next: start date and term breaks", onClick: () => { setWizard({ courseId: wizard.courseId, step: "master" }); setTab("master"); setReloadKey(k => k + 1); } }} /> : null}
    {wizard?.step === "master" && canEdit && selected?.id === wizard.courseId
      ? <StartDateBreaksEditor course={selected} stepLabel="Step 4 of 6" onClose={() => { setWizard(null); setReloadKey(k => k + 1); }}
        nextStep={detail?.intakes.length ? undefined : { label: "Next: create first intake", onClick: () => { setWizard({ courseId: wizard.courseId, step: "intake" }); setReloadKey(k => k + 1); } }} /> : null}
    {wizard?.step === "intake" && canEdit ? <NewIntakeDrawer open courses={courses.map(c => ({ id: c.id, label: c.label }))} courseId={wizard.courseId}
      allowBatch={false} requireUnitSchedule title="Step 5 of 6 · First intake"
      onClose={() => setWizard(null)}
      onCreated={d => { setWizard(null); navigate(`/admin/lms/intakes?wizard=1#${d.intake.id}`); }} /> : null}
    {addingCourse === "tga" && canEdit && <TrainingGovCourseImport onClose={() => setAddingCourse(null)} onSaved={reloadAfterAdd} />}
    {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error} <button className="ml-3 underline" onClick={() => void load()}>Retry</button></div> : null}

    <div className={"grid items-start gap-5 " + pane.grid}>
      <ListPane pane={pane} label="Courses" current={selected?.code}>
      <section className={card + " p-3"}>
        <label className="relative block"><span className="sr-only">Search courses</span>
          <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search code or name" className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" />
        </label>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <button type="button" aria-pressed={activeOnly} onClick={() => setActiveOnly(v => !v)}
            className={"rounded-full border px-2.5 py-1 font-semibold " + (activeOnly ? "border-primary-500 bg-primary-50 text-primary-700" : "border-background-300 text-foreground-600")}>Active only</button>
          {campuses.length ? <select aria-label="Campus" className="rounded-full border border-background-300 bg-transparent px-2 py-1 text-foreground-600" value={campus} onChange={e => setCampus(e.target.value)}>
            <option value="">All campuses</option>{campuses.map(x => <option key={x} value={x}>{x}</option>)}
          </select> : null}
          <span className="ml-auto text-foreground-500">{visible.length} course{visible.length === 1 ? "" : "s"}</span>
        </div>
        <div className="mt-3 max-h-[70vh] space-y-1 overflow-auto">
          {loading ? <p className="p-3 text-sm text-foreground-500">Loading…</p> : visible.length === 0 ? <p className="p-3 text-sm text-foreground-500">No matching courses.</p> : visible.map(c =>
            <button key={c.id} type="button" aria-pressed={selectedId === c.id} onClick={() => pick(c.id)}
              className={"flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors " + (selectedId === c.id ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100")}>
              <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (c.isActive ? "bg-green-500" : "bg-background-300")} title={c.isActive ? "Active" : "Inactive"} />
              <span className="min-w-0"><span className="block text-sm font-semibold text-foreground-950">{c.code}</span>
                <span className="block truncate text-xs text-foreground-600">{c.name}</span></span>
            </button>)}
        </div>
      </section>
      </ListPane>

      <section className={card + " min-w-0 p-5"}>
        {!selected ? <p className="py-20 text-center text-foreground-500">{loading ? "Loading…" : "Select a course."}</p> : <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{selected.code}</p>
              <h2 className="font-heading text-xl font-bold text-foreground-950">{selected.name}</h2>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs font-semibold">
                <span className={"rounded-full px-2 py-0.5 " + (selected.isActive ? "bg-green-100 text-green-800" : "bg-background-200 text-foreground-600")}>{selected.isActive ? "Active" : "Inactive"}</span>
                {selected.status === "Draft" ? <span className="rounded-full bg-background-200 px-2 py-0.5 text-foreground-600" title="Not published on the website">Website draft</span> : null}
                <span className="rounded-full bg-background-200 px-2 py-0.5 text-foreground-600">{selected.cricos ? "CRICOS " + selected.cricos : "No CRICOS code"}</span>
              </div>
            </div>
            {canEdit ? <div className="relative flex items-center gap-2">
              {editing ? <span className="text-xs text-foreground-500" role="status">{saving ? "Saving…" : savedAt ? "Saved " + savedAt : "Changes save automatically"}</span> : null}
              <button type="button" onClick={() => { setEditing(v => !v); setMenuOpen(false); }} disabled={!detail}
                className={"rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 " + (editing ? "bg-primary-600 text-white hover:bg-primary-700" : "border border-background-300 text-foreground-800 hover:bg-background-100")}>
                {editing ? "Done" : "Edit"}</button>
              <button type="button" aria-label="More actions" aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)}
                className="rounded-lg border border-background-300 px-2.5 py-2 text-foreground-700 hover:bg-background-100"><i className="ri-more-2-fill" aria-hidden="true" /></button>
              {menuOpen ? <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setMenuOpen(false)} /> : null}
              {menuOpen ? <div className="absolute right-0 top-11 z-20 w-64 overflow-hidden rounded-lg border border-background-200 bg-background-50 py-1 shadow-lg">
                <button type="button" className={menuItem} disabled={syncing || saving} onClick={() => { setMenuOpen(false); void sync(); }}>
                  <i className="ri-refresh-line" aria-hidden="true" />Sync with Training.gov.au and CRICOS</button>
                <button type="button" className={menuItem} disabled={saving || !detail} onClick={() => { setMenuOpen(false); void save("course_save", { isActive: !selected.isActive }); }}>
                  <i className={selected.isActive ? "ri-pause-circle-line" : "ri-play-circle-line"} aria-hidden="true" />Mark as {selected.isActive ? "inactive" : "active"}</button>
                <button type="button" className={menuItem + " text-red-700"} disabled={saving} onClick={() => { setMenuOpen(false); void remove(); }}>
                  <i className="ri-delete-bin-line" aria-hidden="true" />Delete course</button>
              </div> : null}
            </div> : null}
          </div>

          <dl className="mt-4 grid grid-cols-2 rounded-lg border border-background-200 sm:grid-cols-5 sm:divide-x sm:divide-background-200">
            {facts.map(([label, value]) => <div key={label} className="px-3 py-2">
              <dt className="text-xs text-foreground-500">{label}</dt><dd className="truncate text-sm font-semibold text-foreground-950">{value}</dd>
            </div>)}
          </dl>

          {syncing ? <p role="status" className="mt-3 text-sm text-foreground-600">Syncing with Training.gov.au and CRICOS…</p> : null}
          {syncNote.length ? <div role="status" className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            <ul className="space-y-0.5">{syncNote.map(line => <li key={line}>{line}</li>)}</ul>
            <button type="button" aria-label="Dismiss" onClick={() => setSyncNote([])}><i className="ri-close-line" aria-hidden="true" /></button></div> : null}
          {detailError ? <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{detailError}</div> : null}

          {editing && canEdit && detail ? <div className="mt-5 space-y-5">
            <CourseFacts key={selectedId + ":" + reloadKey} course={detail.course} readOnly={false} busy={saving} autosave onSave={data => void save("course_save", data)} />
            <CricosCourseSection key={selectedId + ":edit"} courseId={selectedId} onSaved={() => { setReloadKey(k => k + 1); void load(selectedId); }} />
          </div> : <>
            <div role="tablist" aria-label="Course sections" className="mt-5 flex gap-5 border-b border-background-200">
              {tabs.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
                className={"-mb-px border-b-2 px-1 py-2 text-sm font-semibold " + (tab === t.id ? "border-primary-600 text-primary-700" : "border-transparent text-foreground-500 hover:text-foreground-800")}>{t.label}</button>)}
            </div>
            <div role="tabpanel" className="pt-4">
              {tab === "overview" ? <div className="space-y-6"><dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                {([["Course name", selected.name + (selected.variantLabel ? ` (${selected.variantLabel})` : "")], ["Course code", selected.code], ["CRICOS code", selected.cricos],
                  ["Category", selected.category], ["Training package", selected.trainingPackage],
                  ["Duration", slitDuration ? `${slitDuration} (${slitHours.toLocaleString()} SLIT hrs ÷ ${HOURS_PER_WEEK} a week)` : ""],
                  ["CRICOS registered duration", selected.duration], ["Delivery mode", selected.mode],
                  ["Campus", selected.campus ?? ""], ["Open intakes", selected.openIntakes ? String(selected.openIntakes) : ""], ["training.gov.au", selected.tgaUrl ?? ""]] as [string, string][])
                  .filter(([, value]) => value && value.trim()).map(([label, value]) => <div key={label}>
                    <dt className="text-xs text-foreground-500">{label}</dt>
                    <dd className="break-words font-medium text-foreground-950">{label === "training.gov.au" ? <a className="text-primary-700 underline" href={value} target="_blank" rel="noreferrer">{value}</a> : value}</dd>
                  </div>)}
              </dl>
              {detail ? <section className="border-t border-background-200 pt-5">
                <h3 className="mb-3 font-heading text-sm font-bold uppercase tracking-wide text-foreground-500">CRICOS</h3>
                <CricosCourseSection key={selectedId + ":view:" + reloadKey} courseId={selectedId} readOnly />
              </section> : null}
              {detail ? <section className="border-t border-background-200 pt-5">
                <h3 className="mb-3 font-heading text-sm font-bold uppercase tracking-wide text-foreground-500">Training.gov.au</h3>
                <SavedTrainingGovDetails key={selectedId + ":" + reloadKey} courseId={selectedId} units={detail.units} />
              </section> : null}
              </div> : null}
              {tab === "units" && wizard?.step === "units" && wizard.courseId === selectedId ? <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-primary-300 bg-primary-50 p-3 text-sm text-primary-900">
                <span className="flex-1"><b>Step 2 of 6 · Units.</b> {detail?.course.id === selectedId ? "Pick the electives for this course." : "Loading the course…"}</span>
                <button type="button" disabled={detail?.course.id !== selectedId} onClick={() => setWizard(w => (w ? { ...w, hidden: false } : w))}
                  className="rounded-lg bg-primary-600 px-3 py-1.5 font-semibold text-white hover:bg-primary-700 disabled:opacity-50">Open Add units</button>
                <button type="button" onClick={() => setWizard({ courseId: selectedId, step: "hours" })} className="rounded-lg border border-primary-300 px-3 py-1.5 font-semibold text-primary-800 hover:bg-primary-100">Skip to unit hours</button>
                <button type="button" onClick={() => setWizard(null)} className="rounded-lg border border-primary-300 px-3 py-1.5 font-semibold text-primary-800 hover:bg-primary-100">Later</button>
              </div> : null}
              {tab === "units" && selectedId ? <LmsUnitsPage key={selectedId + ":" + reloadKey} embeddedCourseId={selectedId} /> : null}
              {tab === "master" && selected ? <MasterTimetableTab key={selectedId + ":" + reloadKey} courseId={selectedId} courseCode={selected.code} /> : null}
            </div>
          </>}
        </>}
      </section>
    </div>
  </div>;
}
