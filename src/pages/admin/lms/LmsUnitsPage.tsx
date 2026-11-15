import { useCallback, useEffect, useMemo, useState } from "react";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";
import AddUnitsFromTga from "./AddUnitsFromTga";
import { UnitDetail } from "./UnitTgaList";

type Entry = { course: RtoCourse; unit: RtoUnit; index: number };
const inputClass = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
export default function LmsUnitsPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [details, setDetails] = useState<CourseDetail[]>([]);
  const [query, setQuery] = useState("");
  const [courseQuery, setCourseQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [page, setPage] = useState(1);
  const [drawerTab, setDrawerTab] = useState<"content" | "details" | "courses">("content");
  const [courseId, setCourseId] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<Entry | null>(null);
  const [draft, setDraft] = useState<RtoUnit | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, me] = await Promise.all([rto<RtoCourse[]>("course_list"), rto<{rtoManager:boolean}>("me")]);
      setCourses(list); setCanEdit(me.rtoManager);
      setCourseId(prev => list.some(c => c.id === prev) ? prev : (list[0]?.id ?? ""));
      const results = await Promise.allSettled(list.map(c => rto<CourseDetail>("course_get", {courseId:c.id})));
      const loaded = results.filter((r):r is PromiseFulfilledResult<CourseDetail> => r.status === "fulfilled").map(r => r.value);
      setDetails(loaded);
      const failed = results.length - loaded.length;
      setError(failed ? `Unable to load units from ${failed} course(s). Showing available records only.` : "");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load units."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const rows = useMemo(() => details.flatMap(d => d.units.map((unit, index) => ({course:d.course,unit,index}))), [details]);
  const filtered = rows.filter(r => (!courseId || r.course.id === courseId) &&
    (type === "all" || r.unit.unitType === type) && (status === "all" || (r.unit.isActive ? "active" : "inactive") === status) &&
    (r.unit.code + " " + r.unit.name + " " + r.course.name).toLowerCase().includes(query.trim().toLowerCase()));
  const PAGE = 25;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const currentPage = Math.min(page, pageCount);
  const paged = filtered.slice((currentPage - 1) * PAGE, currentPage * PAGE);
  useEffect(() => { setPage(1); }, [query, courseId, type, status]);
  const selectedCourse = courses.find(c => c.id === courseId);
  const shownCourses = courses.filter(c => (c.code+" "+c.name).toLowerCase().includes(courseQuery.toLowerCase()));
  const uniqueCount = new Set(rows.map(r => r.unit.code.trim().toLowerCase())).size;
  const open = (entry:Entry) => { setSelected(entry); setAdding(false); setDraft({...entry.unit}); setDrawerTab(entry.unit.id ? "content" : "details"); setNotice(""); };
  // Units come from the course's Training.gov.au release (core and chosen electives), never typed in by hand.
  const add = () => { if (!selectedCourse || !canEdit) return; setSelected(null); setDraft(null); setPicking(true); setNotice(""); };
  const reloadCourse = async (id: string) => {
    const updated = await rto<CourseDetail>("course_get", { courseId: id });
    setDetails(old => old.some(d => d.course.id === id) ? old.map(d => d.course.id === id ? updated : d) : [...old, updated]);
  };
  const chooseCourse = (id:string) => { setCourseId(id); setSelected(null); setDraft(null); setAdding(false); setAdding(false); setPage(1); };
  const save = async () => {
    if ((!selected && !adding) || !draft || !canEdit || busy || !courseId) return;
    if (!draft.code.trim() || !draft.name.trim() || !Number.isFinite(draft.defaultWeeks) || draft.defaultWeeks < 0.5) { setNotice("Code, name and a valid duration (at least 0.5 weeks) are required."); return; }
    const courseDetail = details.find(d => d.course.id === courseId);
    if (!courseDetail) return;
    setBusy(true); setNotice("");
    try {
      const units = adding ? [...courseDetail.units, draft] : courseDetail.units.map((u, index) => index === selected?.index ? draft : u);
      await rto("units_save", {courseId, units});
      const updated = await rto<CourseDetail>("course_get", {courseId});
      setDetails(old => old.map(d => d.course.id === updated.course.id ? updated : d));
      setSelected(null); setDraft(null);
    } catch(e) { setNotice(e instanceof Error ? e.message : "Unable to save unit."); }
    finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    {picking && selectedCourse ? <AddUnitsFromTga course={selectedCourse} units={details.find(d => d.course.id === selectedCourse.id)?.units ?? []}
      onClose={() => setPicking(false)} onDone={() => void reloadCourse(selectedCourse.id)} /> : null}
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="font-heading text-2xl font-bold text-foreground-950">Units</h1>
        <p className="text-sm text-foreground-500">Units of each course, with their Training.gov.au content.</p></div>
    </header>
    {error ? <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{error} <button className="ml-2 underline" onClick={() => void load()}>Retry</button></p> : null}
    <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
    <aside className="rounded-2xl border border-background-200 bg-background-50 p-3 shadow-sm">
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
    </aside>
    <section className="min-w-0 rounded-2xl border border-background-200 bg-background-50 p-5 shadow-sm">
      {!selectedCourse ? <p className="py-20 text-center text-sm text-foreground-500">{loading ? "Loading…" : "Select a course."}</p> : <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{selectedCourse.code}</p>
          <h2 className="font-heading text-xl font-bold text-foreground-950">{selectedCourse.name}</h2></div>
        {canEdit ? <button type="button" onClick={add} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">Add units</button> : null}
      </div>
      {(() => {
        const units = details.find(d => d.course.id === selectedCourse.id)?.units ?? [];
        const active = units.filter(u => u.isActive);
        const facts: [string, string][] = [["Active units", String(active.length)], ["Core", String(active.filter(u => u.unitType === "core").length)],
          ["Electives", String(active.filter(u => u.unitType === "elective").length)], ["Nominal hours", active.reduce((sum, u) => sum + (u.nominalHours ?? 0), 0).toLocaleString()]];
        return <dl className="mt-4 grid grid-cols-2 rounded-lg border border-background-200 sm:grid-cols-4 sm:divide-x sm:divide-background-200">
          {facts.map(([label, value]) => <div key={label} className="px-3 py-2"><dt className="text-xs text-foreground-500">{label}</dt><dd className="text-sm font-semibold text-foreground-950">{loading ? "…" : value}</dd></div>)}
        </dl>;
      })()}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <label className="relative min-w-56 flex-1"><span className="sr-only">Search units</span>
          <i className="ri-search-line absolute left-3 top-2.5 text-sm text-foreground-400" aria-hidden="true" />
          <input aria-label="Search units" className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" placeholder="Search units" value={query} onChange={e=>setQuery(e.target.value)} />
        </label>
        {([["all","All"],["core","Core"],["elective","Electives"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={type===value} onClick={()=>setType(value)}
          className={"rounded-full border px-2.5 py-1 font-semibold " + (type===value ? "border-primary-500 bg-primary-50 text-primary-700" : "border-background-300 text-foreground-600")}>{label}</button>)}
        <select aria-label="Unit status" className="rounded-full border border-background-300 bg-transparent px-2 py-1 text-foreground-600" value={status} onChange={e=>setStatus(e.target.value)}>
          <option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
      </div>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm">
        <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">{["Code","Unit","Type","Hours","Status"].map(x=><th key={x} className="px-3 py-2">{x}</th>)}</tr></thead>
        <tbody>{paged.map(r=><tr key={r.course.id + ":" + r.index} onClick={()=>open(r)} onKeyDown={e=>{if(e.key==="Enter")open(r);}} tabIndex={0} role="button" aria-label={`Open ${r.unit.code} for ${r.course.code}`}
          className={"cursor-pointer border-b border-background-100 hover:bg-background-100 focus:bg-primary-50 " + (r.unit.isActive ? "" : "text-foreground-400")}>
          <td className="px-3 py-2 font-semibold">{r.unit.code}</td><td className="px-3 py-2">{r.unit.name}</td>
          <td className="px-3 py-2 capitalize">{r.unit.unitType}</td><td className="px-3 py-2">{r.unit.nominalHours ?? "—"}</td>
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
        <div role="tablist" className="flex gap-5 border-b border-background-200 px-6">
          {([["content","Training.gov.au"],["details","Settings"],["courses","Courses"]] as const).filter(([id]) => id !== "content" || draft.id).map(([id, label]) =>
            <button key={id} type="button" role="tab" aria-selected={drawerTab===id} onClick={()=>setDrawerTab(id)}
              className={"-mb-px border-b-2 px-1 py-2 text-sm font-semibold " + (drawerTab===id ? "border-primary-600 text-primary-700" : "border-transparent text-foreground-500 hover:text-foreground-800")}>{label}</button>)}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          {drawerTab==="content" && draft.id ? <UnitDetail key={draft.id} unitId={draft.id} /> : null}
          {drawerTab==="courses" ? <ul className="divide-y divide-background-100 text-sm">{details.filter(d=>d.units.some(u=>u.code.toLowerCase()===draft.code.toLowerCase())).map(d=>
            <li key={d.course.id} className="py-2"><span className="font-semibold">{d.course.code}</span> <span className="text-foreground-600">{d.course.name}</span></li>)}</ul> : null}
          {drawerTab==="details" ? <div className="grid gap-4 sm:grid-cols-2">
            {([{key:"code",label:"Unit code"},{key:"name",label:"Unit name"}] as const).map(f=><label key={f.key} className={"block text-sm font-medium text-foreground-800" + (f.key === "name" ? " sm:col-span-2" : "")}>{f.label}
              <input disabled={!canEdit} className={inputClass + " mt-1"} value={draft[f.key]} onChange={e=>setDraft(d=>d?{...d,[f.key]:e.target.value}:d)}/></label>)}
            <label className="block text-sm font-medium text-foreground-800">Type<select disabled={!canEdit} className={inputClass + " mt-1"} value={draft.unitType} onChange={e=>setDraft(d=>d?{...d,unitType:e.target.value as RtoUnit["unitType"]}:d)}><option value="core">Core</option><option value="elective">Elective</option></select></label>
            <label className="block text-sm font-medium text-foreground-800">Nominal hours<input disabled={!canEdit} type="number" min="0" className={inputClass + " mt-1"} value={draft.nominalHours ?? ""} onChange={e=>setDraft(d=>d?{...d,nominalHours:e.target.value===""?null:Number(e.target.value)}:d)}/></label>
            <label className="block text-sm font-medium text-foreground-800">Duration (weeks)<input disabled={!canEdit} type="number" min="0.5" step="0.5" className={inputClass + " mt-1"} value={draft.defaultWeeks} onChange={e=>setDraft(d=>d?{...d,defaultWeeks:Number(e.target.value)}:d)}/></label>
            <label className="flex items-center gap-2 self-end pb-2 text-sm font-medium text-foreground-800"><input type="checkbox" disabled={!canEdit} checked={draft.isActive} onChange={e=>setDraft(d=>d?{...d,isActive:e.target.checked}:d)}/>Active in this course</label>
          </div> : null}
          {notice ? <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p> : null}
        </div>
        {canEdit && drawerTab==="details" ? <div className="flex justify-end gap-2 border-t border-background-200 px-6 py-3">
          <button className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold" onClick={()=>{setSelected(null);setAdding(false);setDraft(null);}}>Cancel</button>
          <button disabled={busy} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50" onClick={()=>void save()}>{busy?"Saving…" : adding ? "Add unit" : "Save unit"}</button>
        </div> : null}
      </section></div> : null}
  </div>;
}
