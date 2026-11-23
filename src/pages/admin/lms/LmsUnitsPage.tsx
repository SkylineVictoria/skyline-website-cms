import { useCallback, useEffect, useMemo, useState } from "react";
import BulkResourceWorkspace from "./BulkResourceWorkspace";
import UnitResourcesPanel from "./UnitResourcesPanel";
import UnitContentPanel from "./UnitContentPanel";
import UnitAssessmentsPanel from "./UnitAssessmentsPanel";
import { HOURS_PER_WEEK, loadUnitHours, rto, saveUnitHours, shownHours, suggestHours, weeksForHours, type CourseDetail, type HoursSplit, type RtoCourse, type RtoUnit, type UnitHours } from "@/pages/admin/lib/rto";
import AddUnitsFromTga from "./AddUnitsFromTga";
import UnitHoursEditor from "./UnitHoursEditor";
import { supabase } from "@/pages/admin/lib/supabase";
import { UnitDetail } from "./UnitTgaList";
import UnitPrerequisitesPicker from "./UnitPrerequisitesPicker";
import { bulkAdmin, categories, categoryLabel, listResources, splitCategoryTitle, type ImportFile, type ImportJob, type Resource } from "@/pages/admin/lib/bulkResources";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";

type Entry = { course: RtoCourse; unit: RtoUnit; index: number };
/** A unit's documents for the list (owner, 2026-11-23: "see all docs inside units on the main page"): its Learning content,
 *  its Resources (AI bulk upload) and its Assessments. */
type UnitDocs = { learning: { id: string; title: string; kind: string }[]; resources: Resource[]; assessments: AssessmentRow[];
  /** AI Bulk Upload files for this unit not approved yet: they become Resources only after review (or failed / still reading). */
  pending: { name: string; state: ImportFile["state"] }[] };
/** The AI Bulk Upload files still in the queue (the latest 20 uploads), for the Documents column. */
async function pendingBulkFiles(): Promise<ImportFile[]> {
  const jobs = await bulkAdmin<ImportJob[]>("list");
  const lists = await Promise.all(jobs.slice(0, 20).map(job => bulkAdmin<ImportFile[]>("detail", { job: job.id }).catch(() => [] as ImportFile[])));
  return lists.flat().filter(file => !["imported", "excluded"].includes(file.state));
}
/** Filled from Training.gov.au or calculated: shown greyed out, not typed in. */
const readOnlyClass = "w-full cursor-not-allowed rounded-lg border border-background-200 bg-background-100 px-3 py-2 text-sm text-foreground-600";
/** Hours SLIT enters by hand: white, outlined, bold, so they stand out from the greyed fields. */
const hoursInputClass = "w-full rounded-lg border-2 border-primary-300 bg-background-50 px-3 py-2 text-base font-semibold text-foreground-950 focus:border-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:border-background-200 disabled:bg-background-100";
const HOUR_PARTS = [["theoryHours", "Theory hrs", "40%"], ["practicalHours", "Practical hrs", "40%"], ["assessmentHours", "Assessment hrs", "20%"]] as const;
/** Units of each course. On the Courses page (embeddedCourseId) it shows only that course's units, without the course list. */
export default function LmsUnitsPage({ embeddedCourseId }: { embeddedCourseId?: string } = {}) {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [details, setDetails] = useState<CourseDetail[]>([]);
  const [query, setQuery] = useState("");
  const [courseQuery, setCourseQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState(1);
  const [drawerTab, setDrawerTab] = useState<"content" | "details" | "learning" | "assessments" | "resources">("details");
  const [hours, setHours] = useState<Record<string, UnitHours>>({});
  const [hoursError, setHoursError] = useState("");
  const [hoursDraft, setHoursDraft] = useState<HoursSplit | null>(null);
  const [hoursBusy, setHoursBusy] = useState(false);
  const [editingHours, setEditingHours] = useState(false);
  const [courseId, setCourseId] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [draft, setDraft] = useState<RtoUnit | null>(null);
  const [bulk, setBulk] = useState<{ hint?: string } | null>(null);
  const [canManageResources, setCanManageResources] = useState(false);
  useEffect(() => {
    void supabase.rpc("asm_is_admin").then(({ data }) => setCanManageResources(data === true));
  }, []);
  const [canEdit, setCanEdit] = useState(false);
  const [docs, setDocs] = useState<Record<string, UnitDocs>>({});
  const [showDocs, setShowDocs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, me] = await Promise.all([rto<RtoCourse[]>("course_list"), rto<{rtoManager:boolean}>("me")]);
      setCourses(list); setCanEdit(me.rtoManager);
      setCourseId(prev => embeddedCourseId ?? (list.some(c => c.id === prev) ? prev : (list[0]?.id ?? "")));
      const wanted = embeddedCourseId ? list.filter(c => c.id === embeddedCourseId) : list;
      const results = await Promise.allSettled(wanted.map(c => rto<CourseDetail>("course_get", {courseId:c.id})));
      const loaded = results.filter((r):r is PromiseFulfilledResult<CourseDetail> => r.status === "fulfilled").map(r => r.value);
      setDetails(loaded);
      const failed = results.length - loaded.length;
      setError(failed ? `Unable to load units from ${failed} course(s). Showing available records only.` : "");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load units."); }
    finally { setLoading(false); }
  }, [embeddedCourseId]);
  useEffect(() => { void load(); }, [load]);
  const refreshHours = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const list = await loadUnitHours(id);
      setHours(old => { const next = { ...old }; for (const h of list) next[h.unitId] = h; return next; });
      setHoursError("");
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setHoursError(/rto_unit_hours_list|function/i.test(message)
        ? "SLIT hours need the database update (migration 20261116100000). Suggested hours are shown but cannot be saved yet."
        : message || "Unable to load SLIT hours.");
    }
  }, []);
  useEffect(() => { void refreshHours(courseId); }, [courseId, refreshHours]);
  // The units each unit needs first, read from its Training.gov.au prerequisites (empty until the UNIT-PREREQUISITES update).
  const [needs, setNeeds] = useState<Record<string, { id: string; code: string }[]>>({});
  useEffect(() => {
    setNeeds({});
    if (!courseId) return;
    let live = true;
    supabase.rpc("rto_course_prereqs", { p_course: courseId }).then(({ data }) => { if (live && data) setNeeds(data as Record<string, { id: string; code: string }[]>); });
    return () => { live = false; };
  }, [courseId, details]);
  // Only the selected (active) units count: a unit is a prerequisite here when an active unit of this course needs it.
  const activeNeeded = useMemo(() => {
    const activeIds = new Set((details.find(d => d.course.id === courseId)?.units ?? []).filter(u => u.isActive && u.id).map(u => u.id as string));
    return new Set(Object.entries(needs).filter(([unitId]) => activeIds.has(unitId)).flatMap(([, list]) => list.map(n => n.id)));
  }, [needs, details, courseId]);
  const rows = useMemo(() => details.flatMap(d => d.units.map((unit, index) => ({course:d.course,unit,index}))), [details]);
  const filtered = rows.filter(r => (!courseId || r.course.id === courseId) &&
    (type === "all" || (type === "prereq" ? activeNeeded.has(r.unit.id ?? "") : type === "needs" ? Boolean(r.unit.id && needs[r.unit.id]?.length) : r.unit.unitType === type)) && (status === "all" || (r.unit.isActive ? "active" : "inactive") === status) &&
    (r.unit.code + " " + r.unit.name + " " + r.course.name).toLowerCase().includes(query.trim().toLowerCase()));
  const PAGE = 25;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const currentPage = Math.min(page, pageCount);
  const paged = filtered.slice((currentPage - 1) * PAGE, currentPage * PAGE);
  useEffect(() => { setPage(1); }, [query, courseId, type, status]);
  const selectedCourse = courses.find(c => c.id === courseId);
  const docsUnitIds = useMemo(() => (details.find(d => d.course.id === courseId)?.units ?? []).map(u => u.id).filter((id): id is string => !!id), [details, courseId]);
  const docsKey = docsUnitIds.join(",");
  useEffect(() => {
    if (!courseId || !docsUnitIds.length) { setDocs({}); return; }
    let live = true;
    const empty = (): UnitDocs => ({ learning: [], resources: [], assessments: [], pending: [] });
    void Promise.all([
      supabase.from("unit_contents").select("id,unit_id,kind,title,sort").in("unit_id", docsUnitIds).order("sort").then(({ data }) => (data ?? []) as { id: string; unit_id: string; kind: string; title: string }[], () => []),
      listResources(null).catch(() => [] as Resource[]),
      asmAdmin<AssessmentRow[]>("assessment_list", { courseId, includeArchived: false }).catch(() => [] as AssessmentRow[]),
      canManageResources ? pendingBulkFiles().catch(() => [] as ImportFile[]) : Promise.resolve([] as ImportFile[]),
    ]).then(([learning, resources, assessments, pending]) => {
      if (!live) return;
      const out: Record<string, UnitDocs> = Object.fromEntries(docsUnitIds.map(id => [id, empty()]));
      for (const row of learning) out[row.unit_id]?.learning.push({ id: row.id, title: row.title, kind: row.kind });
      for (const row of resources) out[row.unit_id]?.resources.push(row);
      for (const row of assessments) if (row.unitId) out[row.unitId]?.assessments.push(row);
      // A queued file belongs to the unit the AI named (its code on this course), else to its only matching unit.
      const byCode = new Map((details.find(d => d.course.id === courseId)?.units ?? []).filter(u => u.id).map(u => [u.code.trim().toUpperCase(), u.id as string]));
      for (const file of pending) {
        // A file the AI has not read yet has no unit code: the unit code in its file or folder name is used instead.
        const fromPath = `${file.source_path ?? ""}/${file.name}`.toUpperCase().match(/(?<![A-Z0-9])[A-Z]{5,8}\d{3,4}[A-Z]?(?![A-Z0-9])/g)?.find(code => byCode.has(code));
        const unitId = (file.result?.unitCode && byCode.get(file.result.unitCode.trim().toUpperCase())) || (file.matches?.length === 1 ? file.matches[0].id : "")
          || (fromPath ? byCode.get(fromPath) ?? "" : "");
        if (unitId) out[unitId]?.pending.push({ name: file.result?.title || file.name, state: file.state });
      }
      setDocs(out);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloaded when the course or its units change
  }, [courseId, docsKey, drawerTab, selected, canManageResources, bulk]);
  /** Open a unit on one of its document tabs. */
  const openOn = (entry: Entry, tab: "learning" | "resources" | "assessments") => { open(entry); setDrawerTab(tab); };
  const shownCourses = courses.filter(c => (c.code+" "+c.name).toLowerCase().includes(courseQuery.toLowerCase()));
  const uniqueCount = new Set(rows.map(r => r.unit.code.trim().toLowerCase())).size;
  const hoursOf = (u: RtoUnit) => shownHours(u.id ? hours[u.id] : undefined, u.nominalHours);
  const open = (entry:Entry) => {
    const shown = hoursOf(entry.unit);
    setSelected(entry); setAdding(false); setDraft({...entry.unit}); setNotice("");
    setHoursDraft(shown ? { slitHours: shown.slitHours, theoryHours: shown.theoryHours, practicalHours: shown.practicalHours, assessmentHours: shown.assessmentHours } : null);
    setDrawerTab("details");
  };
  const hoursSum = hoursDraft ? hoursDraft.theoryHours + hoursDraft.practicalHours + hoursDraft.assessmentHours : 0;
  const hoursValid = !!hoursDraft && [hoursDraft.slitHours, hoursDraft.theoryHours, hoursDraft.practicalHours, hoursDraft.assessmentHours]
    .every(n => Number.isInteger(n) && n >= 0) && hoursSum === hoursDraft.slitHours;
  /** Accepts the suggested 40/40/20 split for every active unit of the course that has nominal hours and is not reviewed yet. */
  const acceptAllSuggested = async (pending: RtoUnit[]) => {
    if (!canEdit || hoursBusy || !pending.length) return;
    setHoursBusy(true); setHoursError("");
    try {
      const weeks = new Map<string, number>();
      for (const u of pending) {
        const saved = await saveUnitHours(u.id as string, suggestHours(u.nominalHours as number));
        setHours(old => ({ ...old, [saved.unitId]: saved }));
        weeks.set(saved.unitId, weeksForHours(saved.slitHours ?? 0));
      }
      // Durations follow the accepted SLIT hours (20 hours a week).
      const courseDetail = details.find(d => d.course.id === courseId);
      if (courseDetail) {
        await rto("units_save", { courseId, units: courseDetail.units.map(u => u.id && weeks.has(u.id) ? { ...u, defaultWeeks: weeks.get(u.id) } : u) });
        await reloadCourse(courseId);
      }
    } catch (e) { setHoursError(e instanceof Error ? e.message : "Unable to accept the suggested hours."); }
    finally { setHoursBusy(false); }
  };
  // Units come from the course's Training.gov.au release (core and chosen electives), never typed in by hand.
  const add = () => { if (!selectedCourse || !canEdit) return; setSelected(null); setDraft(null); setPicking(true); setNotice(""); };
  const reloadCourse = async (id: string) => {
    const updated = await rto<CourseDetail>("course_get", { courseId: id });
    setDetails(old => old.some(d => d.course.id === id) ? old.map(d => d.course.id === id ? updated : d) : [...old, updated]);
  };
  const chooseCourse = (id:string) => { setCourseId(id); setSelected(null); setDraft(null); setAdding(false); setAdding(false); setPage(1); };
  const save = async () => {
    if ((!selected && !adding) || !draft || !canEdit || busy || !courseId) return;
    if (!draft.code.trim() || !draft.name.trim()) { setNotice("Code and name are required."); return; }
    if (hoursDraft && !hoursValid) { setNotice("Theory, practical and assessment hours must be whole numbers that add up to the SLIT hours."); return; }
    const unit = { ...draft, defaultWeeks: hoursDraft ? weeksForHours(hoursDraft.slitHours) : draft.defaultWeeks };
    const courseDetail = details.find(d => d.course.id === courseId);
    if (!courseDetail) return;
    setBusy(true); setNotice("");
    try {
      const units = adding ? [...courseDetail.units, unit] : courseDetail.units.map((u, index) => index === selected?.index ? unit : u);
      await rto("units_save", {courseId, units});
      if (hoursDraft && draft.id) {
        const saved = await saveUnitHours(draft.id, hoursDraft);
        setHours(old => ({ ...old, [saved.unitId]: saved }));
      }
      const updated = await rto<CourseDetail>("course_get", {courseId});
      setDetails(old => old.map(d => d.course.id === updated.course.id ? updated : d));
      setSelected(null); setDraft(null);
    } catch(e) { setNotice(e instanceof Error ? e.message : "Unable to save unit."); }
    finally { setBusy(false); }
  };
  if (bulk) return <BulkResourceWorkspace courses={courses}
    units={rows.flatMap(({ course, unit }) => unit.id ? [{ id: unit.id, code: unit.code, name: unit.name, course_id: course.id }] : [])}
    unitHint={bulk.hint} onClose={() => setBulk(null)} />;
  return <div className={embeddedCourseId ? "space-y-4" : "mx-auto max-w-[1500px] space-y-5 pb-12"}>
    {editingHours && selectedCourse ? <UnitHoursEditor course={selectedCourse} onClose={() => setEditingHours(false)}
      onSaved={() => { void refreshHours(selectedCourse.id); void reloadCourse(selectedCourse.id); }} /> : null}
    {picking && selectedCourse ? <AddUnitsFromTga course={selectedCourse} units={details.find(d => d.course.id === selectedCourse.id)?.units ?? []}
      onClose={() => setPicking(false)} onDone={() => void reloadCourse(selectedCourse.id)} /> : null}
    {!embeddedCourseId && <header className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="font-heading text-2xl font-bold text-foreground-950">Units</h1>
        <p className="text-sm text-foreground-500">Units of each course, with their Training.gov.au content.</p></div>
      {canManageResources && <button type="button" className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white" onClick={() => setBulk({})}>AI Bulk Upload</button>}
    </header>}
    {error ? <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{error} <button className="ml-2 underline" onClick={() => void load()}>Retry</button></p> : null}
    <div className={embeddedCourseId ? "" : "grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]"}>
    {!embeddedCourseId && <aside className="rounded-2xl border border-background-200 bg-background-50 p-3 shadow-sm">
      <label className="relative block"><span className="sr-only">Search courses</span>
        <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
        <input aria-label="Search courses" className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" placeholder="Search code or name" value={courseQuery} onChange={e=>setCourseQuery(e.target.value)} />
      </label>
      <p className="mt-2 text-right text-xs text-foreground-500">{shownCourses.length} course{shownCourses.length === 1 ? "" : "s"}</p>
      <div className="mt-2 max-h-[70vh] space-y-1 overflow-auto">{shownCourses.map(course => {
        const list = details.find(d => d.course.id === course.id)?.units;
        const activeCount = list ? list.filter(u => u.isActive).length : null;
        return <button type="button" key={course.id} aria-pressed={courseId===course.id} onClick={()=>chooseCourse(course.id)}
          className={"flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors " + (courseId===course.id ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100")}>
          <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-foreground-950">{course.code}</span>
            <span className="block truncate text-xs text-foreground-600">{course.name}</span></span>
          <span className="shrink-0 text-xs text-foreground-500">{activeCount ?? "…"}</span>
        </button>;
      })}</div>
    </aside>}
    <section className="min-w-0 rounded-2xl border border-background-200 bg-background-50 p-5 shadow-sm">
      {!selectedCourse ? <p className="py-20 text-center text-sm text-foreground-500">{loading ? "Loading…" : "Select a course."}</p> : <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{selectedCourse.code}</p>
          <h2 className="font-heading text-xl font-bold text-foreground-950">{selectedCourse.name}</h2></div>
        {canEdit ? <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setEditingHours(true)} title="Edit the SLIT hours of every selected unit in one table"
            className="rounded-lg border border-primary-300 bg-primary-50 px-3 py-2 text-sm font-semibold text-primary-800 hover:bg-primary-100">
            <i className="ri-time-line mr-1" aria-hidden="true" />Edit all hours</button>
          <button type="button" onClick={add} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">Add or change units</button></div> : null}
      </div>
      {(() => {
        const units = details.find(d => d.course.id === selectedCourse.id)?.units ?? [];
        const active = units.filter(u => u.isActive);
        const facts: [string, string][] = [["Active units", String(active.length)], ["Core", String(active.filter(u => u.unitType === "core").length)],
          ["Electives", String(active.filter(u => u.unitType === "elective").length)], ["Nominal hours", active.reduce((sum, u) => sum + (u.nominalHours ?? 0), 0).toLocaleString()],
          ["SLIT hours", active.reduce((sum, u) => sum + (hoursOf(u)?.slitHours ?? 0), 0).toLocaleString() +
            (active.some(u => hoursOf(u) && !hoursOf(u)?.confirmed) ? " (to review)" : "")]];
        return <dl className="mt-4 grid grid-cols-2 rounded-lg border border-background-200 sm:grid-cols-5 sm:divide-x sm:divide-background-200">
          {facts.map(([label, value]) => <div key={label} className="px-3 py-2"><dt className="text-xs text-foreground-500">{label}</dt><dd className="text-sm font-semibold text-foreground-950">{loading ? "…" : value}</dd></div>)}
        </dl>;
      })()}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <label className="relative min-w-56 flex-1"><span className="sr-only">Search units</span>
          <i className="ri-search-line absolute left-3 top-2.5 text-sm text-foreground-400" aria-hidden="true" />
          <input aria-label="Search units" className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" placeholder="Search units" value={query} onChange={e=>setQuery(e.target.value)} />
        </label>
        {([["all","All"],["core","Core"],["elective","Electives"],["prereq","Prerequisite units"],["needs","Needs prerequisites"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={type===value} onClick={()=>setType(value)}
          className={"rounded-full border px-2.5 py-1 font-semibold " + (type===value ? "border-primary-500 bg-primary-50 text-primary-700" : "border-background-300 text-foreground-600")}>{label}</button>)}
        <select aria-label="Unit status" className="rounded-full border border-background-300 bg-transparent px-2 py-1 text-foreground-600" value={status} onChange={e=>setStatus(e.target.value)}>
          <option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
        <label className="flex items-center gap-1.5 text-foreground-600"><input type="checkbox" checked={showDocs} onChange={e=>setShowDocs(e.target.checked)} />Show document names</label>
      </div>
      {hoursError ? <p role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{hoursError}</p> : null}
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[1150px] text-left text-sm">
        <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">{["Code","Unit","Documents","Type","Prerequisites","Nominal hrs","SLIT hrs","Theory hrs","Practical hrs","Assessment hrs","Status"].map(x=><th key={x} className="px-3 py-2">{x}</th>)}</tr></thead>
        <tbody>{paged.map(r=><tr key={r.course.id + ":" + r.index} onClick={()=>open(r)} onKeyDown={e=>{if(e.key==="Enter")open(r);}} tabIndex={0} role="button" aria-label={`Open ${r.unit.code} for ${r.course.code}`}
          className={"cursor-pointer border-b border-background-100 hover:bg-background-100 focus:bg-primary-50 " + (r.unit.isActive ? "" : "text-foreground-400")}>
          <td className="px-3 py-2 font-semibold">{r.unit.code}</td><td className="px-3 py-2">{r.unit.name}
            </td>
          <td className="px-3 py-2 text-xs">{(() => {
            const d = r.unit.id ? docs[r.unit.id] : undefined;
            if (!d) return <span className="text-foreground-400">—</span>;
            // Files on the unit are counted under their category (with the AI Bulk Upload resources of that category); notes and
            // links stay "Learning content".
            const files = d.learning.filter(x => x.kind === "file").map(x => splitCategoryTitle(x.title));
            const other = d.learning.filter(x => x.kind !== "file");
            const parts: (readonly ["learning" | "resources" | "assessments", string, number, string[]])[] = [
              ...categories.map(c => {
                const names = [...files.filter(x => x.category === c).map(x => x.title), ...d.resources.filter(x => x.category === c).map(x => x.title || x.name)];
                return ["resources", categoryLabel(c), names.length, names] as const;
              }),
              ["learning", "Learning content", other.length, other.map(x => x.title)] as const,
              ["assessments", "Assessments set", d.assessments.length, d.assessments.map(x => x.title)] as const,
            ];
            const waiting = d.pending.length ? <div>
              <button type="button" onClick={e => { e.stopPropagation(); setBulk({ hint: r.unit.id }); }}
                title={d.pending.map(x => `${x.name} (${x.state === "review" ? "waiting for your review" : x.state === "failed" ? "failed: open AI Bulk Upload to retry" : "being read"})`).join("\n")}
                className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-semibold text-amber-900 hover:bg-amber-100">Not approved yet {d.pending.length}</button>
              {showDocs ? <ul className="mt-1 space-y-0.5 pl-2 text-foreground-600">{d.pending.map((x, i) => <li key={i} className="break-words">{x.name} · {x.state === "review" ? "review" : x.state}</li>)}</ul> : null}
            </div> : null;
            if (!parts.some(([, , n]) => n)) return waiting ?? <span className="text-foreground-400">None</span>;
            return <div className="flex max-w-xs flex-col gap-1">{waiting}{parts.filter(([, , n]) => n).map(([tab, label, n, names]) => <div key={label}>
              <button type="button" onClick={e => { e.stopPropagation(); openOn(r, tab); }} title={names.join("\n")}
                className="rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 font-semibold text-primary-800 hover:bg-primary-100">{label} {n}</button>
              {showDocs ? <ul className="mt-1 space-y-0.5 pl-2 text-foreground-600">{names.map((name, i) => <li key={i} className="break-words">{name}</li>)}</ul> : null}
            </div>)}</div>;
          })()}</td>
          <td className="px-3 py-2"><span className="capitalize">{r.unit.unitType}</span>{r.unit.isActive && activeNeeded.has(r.unit.id ?? "") ? <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800" title="Another unit needs this one first, so it is taught earlier">Prerequisite</span> : null}</td>
          <td className="px-3 py-2 text-xs">{r.unit.id && needs[r.unit.id]?.length ? <span className="block max-w-xs space-y-0.5">{needs[r.unit.id].map(n => <span key={n.id} className="block"><b className="text-amber-800">{n.code}</b> <span className="text-foreground-600">{r.course && details.find(d => d.course.id === r.course.id)?.units.find(u => u.id === n.id)?.name}</span></span>)}</span> : <span className="text-foreground-400">—</span>}</td><td className="px-3 py-2">{r.unit.nominalHours ?? "—"}</td>
          {(() => { const h = hoursOf(r.unit); const cell = "px-3 py-2 " + (h && !h.confirmed ? "italic text-foreground-400" : "");
            return <>
              <td className={cell}>{h ? h.slitHours : "—"}{h && !h.confirmed ? <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold not-italic text-amber-800">Review</span> : null}</td>
              {HOUR_PARTS.map(([key]) => <td key={key} className={cell}>{h ? h[key] : "—"}</td>)}
            </>; })()}
          <td className="px-3 py-2"><span className={"rounded-full px-2 py-0.5 text-xs font-semibold " + (r.unit.isActive ? "bg-green-100 text-green-800" : "bg-background-200 text-foreground-600")}>{r.unit.isActive ? "Active" : "Inactive"}</span></td>
        </tr>)}</tbody></table>
        {loading ? <p className="py-10 text-center text-sm text-foreground-500">Loading units…</p> : !filtered.length ? <p className="py-10 text-center text-sm text-foreground-500">{rows.some(r => r.course.id === courseId) ? "No matching units." : "No units yet. Use Add units to pick them from Training.gov.au."}</p> : null}
      </div>
      {pageCount > 1 ? <div className="mt-3 flex items-center justify-between text-xs text-foreground-500">
        <span>{((currentPage-1)*PAGE+1) + "–" + Math.min(currentPage*PAGE,filtered.length) + " of " + filtered.length}</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={currentPage===1} onClick={()=>setPage(p=>p-1)} className="rounded-lg border border-background-300 px-2.5 py-1 disabled:opacity-40" aria-label="Previous page">‹</button>
          <span>{currentPage} / {pageCount}</span>
          <button type="button" disabled={currentPage===pageCount} onClick={()=>setPage(p=>p+1)} className="rounded-lg border border-background-300 px-2.5 py-1 disabled:opacity-40" aria-label="Next page">›</button>
        </div>
      </div> : null}
      </>}
    </section>
    </div>
    {(selected || adding) && draft ? <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={()=>{setSelected(null);setAdding(false);setDraft(null);}}>
      <section role="dialog" aria-modal="true" aria-label="Unit details" className="flex h-full w-full max-w-2xl flex-col bg-background-50 shadow-xl" onClick={e=>e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-background-200 px-6 py-4">
          <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{draft.code} · {selectedCourse?.code} · {draft.unitType === "core" ? "Core" : "Elective"}{draft.isActive ? "" : " · inactive"}</p>
            <h2 className="font-heading text-lg font-bold text-foreground-950">{draft.name || "New unit"}</h2></div>
          <button type="button" onClick={()=>{setSelected(null);setDraft(null);}} aria-label="Close" className="rounded-lg p-1 text-foreground-500 hover:bg-background-100"><i className="ri-close-line text-xl" aria-hidden="true" /></button>
        </div>
        <div role="tablist" className="flex flex-wrap gap-x-5 border-b border-background-200 px-6">
          {([["details","Details"],["learning","Learning content"],["resources","Resources"],["assessments","Assessments"],["content","Training.gov.au"]] as const).filter(([id]) => id === "details" || draft.id).map(([id, label]) =>
            <button key={id} type="button" role="tab" aria-selected={drawerTab===id} onClick={()=>setDrawerTab(id)}
              className={"-mb-px border-b-2 px-1 py-2 text-sm font-semibold " + (drawerTab===id ? "border-primary-600 text-primary-700" : "border-transparent text-foreground-500 hover:text-foreground-800")}>{label}</button>)}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          {drawerTab==="content" && draft.id ? <UnitDetail key={draft.id} unitId={draft.id} /> : null}
          {drawerTab==="learning" && draft.id ? <UnitContentPanel key={draft.id} unitId={draft.id} canEdit={canEdit} /> : null}
          {drawerTab==="resources" && draft.id && selectedCourse ? <UnitResourcesPanel key={draft.id} courseId={selectedCourse.id} unitId={draft.id} canEdit={canEdit}
            canManage={canManageResources} onBulk={() => setBulk({ hint: draft.id })} /> : null}
          {drawerTab==="assessments" && draft.id && selectedCourse ? <UnitAssessmentsPanel key={draft.id} courseId={selectedCourse.id} unitId={draft.id} canEdit={canEdit} /> : null}
          {drawerTab==="details" ? <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
            <label className="block text-xs font-medium text-foreground-500">Unit code<input readOnly tabIndex={-1} className={readOnlyClass + " mt-1"} value={draft.code} /></label>
            <label className="block text-xs font-medium text-foreground-500">Unit name<input readOnly tabIndex={-1} className={readOnlyClass + " mt-1"} value={draft.name} /></label>
            <label className="flex items-center gap-2 text-sm font-medium text-foreground-800 sm:col-span-2"><input type="checkbox" disabled={!canEdit} checked={draft.isActive} onChange={e=>setDraft(d=>d?{...d,isActive:e.target.checked}:d)}/>Active in this course</label>
          </div>
          {draft.id && selectedCourse ? <UnitPrerequisitesPicker key={draft.id} unitId={draft.id} canEdit={canEdit} needs={needs}
            courseUnits={details.find(d => d.course.id === selectedCourse.id)?.units ?? []} onSaved={setNeeds} /> : null}
          {draft.id ? <div className="space-y-3 border-t border-background-200 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-heading text-sm font-bold uppercase tracking-wide text-foreground-500">Hours</h3>
              {(() => { const shown = hoursOf(draft); return shown && !shown.confirmed
                ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Suggested · review and accept</span>
                : shown?.confirmed ? <span className="text-xs text-foreground-500">Accepted {new Date(hours[draft.id]?.confirmedAt ?? "").toLocaleDateString()}</span> : null; })()}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-sm font-medium text-foreground-800">SLIT hours
                <input disabled={!canEdit} type="number" min="0" step="1" className={hoursInputClass + " mt-1"} value={hoursDraft?.slitHours ?? ""}
                  onChange={e => { const v = e.target.value; setHoursDraft(v === "" ? null : suggestHours(Number(v))); }} /></label>
              <div className="block text-xs font-medium text-foreground-500">Nominal hours (Training.gov.au)
                <div className="mt-1 flex gap-2"><input readOnly tabIndex={-1} className={readOnlyClass} value={draft.nominalHours ?? "—"} />
                  {canEdit && draft.nominalHours !== null ? <button type="button" title="Set SLIT hours to the nominal hours and split them 40 / 40 / 20"
                    onClick={() => setHoursDraft(suggestHours(draft.nominalHours as number))}
                    className="shrink-0 rounded-lg border border-background-300 px-2 text-xs font-semibold text-foreground-800 hover:bg-background-100">Use</button> : null}</div></div>
              <label className="block text-xs font-medium text-foreground-500">Duration ({HOURS_PER_WEEK} hrs a week)
                <input readOnly tabIndex={-1} className={readOnlyClass + " mt-1"}
                  value={hoursDraft ? `${weeksForHours(hoursDraft.slitHours)} week${weeksForHours(hoursDraft.slitHours) === 1 ? "" : "s"}` : `${draft.defaultWeeks} weeks`} /></label>
              {HOUR_PARTS.map(([key, label, pct]) => <label key={key} className="block text-sm font-medium text-foreground-800">{label} <span className="text-xs font-normal text-foreground-500">({pct})</span>
                <input disabled={!canEdit || !hoursDraft} type="number" min="0" step="1" className={hoursInputClass + " mt-1"} value={hoursDraft?.[key] ?? ""}
                  onChange={e => { const v = e.target.value === "" ? 0 : Number(e.target.value); setHoursDraft(h => h ? { ...h, [key]: v } : h); }} /></label>)}
            </div>
            {hoursDraft ? <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className={hoursSum === hoursDraft.slitHours ? "text-foreground-600" : "font-semibold text-red-700"}>
                Theory + practical + assessment = {hoursSum} of {hoursDraft.slitHours} SLIT hours{hoursSum === hoursDraft.slitHours ? "" : ` (${hoursDraft.slitHours - hoursSum > 0 ? hoursDraft.slitHours - hoursSum + " left" : hoursSum - hoursDraft.slitHours + " over"})`}</span>
              {canEdit ? <button type="button" className="underline" onClick={() => setHoursDraft(h => h ? suggestHours(h.slitHours) : h)}>Reset to 40 / 40 / 20</button> : null}
            </div> : <p className="text-sm text-foreground-600">Enter the SLIT hours for this unit.</p>}
          </div> : null}
          <div className="border-t border-background-200 pt-5">
            <h3 className="font-heading text-sm font-bold uppercase tracking-wide text-foreground-500">Courses with this unit</h3>
            <ul className="mt-2 divide-y divide-background-100 text-sm">{details.filter(d=>d.units.some(u=>u.code.toLowerCase()===draft.code.toLowerCase())).map(d=>
              <li key={d.course.id} className="py-2"><span className="font-semibold">{d.course.code}</span> <span className="text-foreground-600">{d.course.name}</span></li>)}</ul>
          </div>
          </div> : null}
          {notice ? <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p> : null}
        </div>
        {canEdit && drawerTab==="details" ? <div className="flex justify-end gap-2 border-t border-background-200 px-6 py-3">
          <button className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold" onClick={()=>{setSelected(null);setAdding(false);setDraft(null);}}>Cancel</button>
          <button disabled={busy || (!!hoursDraft && !hoursValid)} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50" onClick={()=>void save()}>
            {busy ? "Saving…" : adding ? "Add unit" : hoursDraft && draft.id && !hours[draft.id]?.confirmedAt ? "Accept hours and save" : "Save unit"}</button>
        </div> : null}
      </section></div> : null}
  </div>;
}
