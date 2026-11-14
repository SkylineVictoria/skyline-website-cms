import { useCallback, useEffect, useMemo, useState } from "react";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";

type Entry = { course: RtoCourse; unit: RtoUnit; index: number };
const inputClass = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
export default function LmsUnitsPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [details, setDetails] = useState<CourseDetail[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [drawerTab, setDrawerTab] = useState<"details" | "courses">("details");
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
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pageCount);
  const paged = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  useEffect(() => { setPage(1); }, [query, courseId, type, status]);
  const uniqueCount = new Set(rows.map(r => r.unit.code.trim().toLowerCase())).size;
  const open = (entry:Entry) => { setSelected(entry); setDraft({...entry.unit}); setDrawerTab("details"); setNotice(""); };
  const save = async () => {
    if (!selected || !draft || !canEdit || busy) return;
    if (!draft.code.trim() || !draft.name.trim() || !Number.isFinite(draft.defaultWeeks) || draft.defaultWeeks < 0.5) { setNotice("Code, name and a valid duration (at least 0.5 weeks) are required."); return; }
    const courseDetail = details.find(d => d.course.id === selected.course.id);
    if (!courseDetail) return;
    setBusy(true); setNotice("");
    try {
      const units = courseDetail.units.map((u, index) => index === selected.index ? draft : u);
      await rto("units_save", {courseId:selected.course.id, units});
      const updated = await rto<CourseDetail>("course_get", {courseId:selected.course.id});
      setDetails(old => old.map(d => d.course.id === updated.course.id ? updated : d));
      setSelected(null); setDraft(null);
    } catch(e) { setNotice(e instanceof Error ? e.message : "Unable to save unit."); }
    finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header><p className="text-sm text-foreground-500">LMS / Units</p><div className="mt-2 flex items-center gap-3"><span className="rounded-xl bg-primary-50 p-3 text-2xl text-primary-600"><i className="ri-stack-line" aria-hidden="true" /></span><h1 className="font-heading text-3xl font-bold">Units</h1></div>
      <p className="mt-1 text-sm text-foreground-600">Browse units across courses. Edit the selected course's unit assignment without creating duplicate master records.</p></header>
    {error ? <p role="alert" className="rounded-lg border border-amber-300 p-3 text-sm text-amber-800">{error} <button className="ml-2 underline" onClick={() => void load()}>Retry</button></p> : null}
    <section className="rounded-2xl border border-background-200 bg-background-50 p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <input aria-label="Search units" className={inputClass + " min-w-56 flex-1"} placeholder="Search units (code or name)" value={query} onChange={e=>setQuery(e.target.value)} />
        <select aria-label="Course" className={inputClass + " w-auto max-w-64"} value={courseId} onChange={e=>setCourseId(e.target.value)}><option value="">All courses</option>{courses.map(c=><option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select>
        <select aria-label="Unit type" className={inputClass + " w-auto"} value={type} onChange={e=>setType(e.target.value)}><option value="all">All types</option><option value="core">Core</option><option value="elective">Elective</option></select>
        <select aria-label="Unit status" className={inputClass + " w-auto"} value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
      </div>
      <p className="my-4 text-sm text-foreground-600">{loading ? "Loading units…" : `${uniqueCount} unique unit codes · ${rows.length} course-unit assignments · ${filtered.length} matching`}</p>
      <div className="overflow-x-auto rounded-xl border border-background-200"><table className="w-full min-w-[740px] text-left text-sm">
        <thead className="bg-background-100"><tr>{["Unit code","Unit name","Course","Type","Nominal hours","Status"].map(x=><th key={x} className="px-4 py-3 font-semibold">{x}</th>)}</tr></thead>
        <tbody className="divide-y divide-background-200">{paged.map(r=><tr key={r.course.id + ":" + r.index} onClick={()=>open(r)} onKeyDown={e=>{if(e.key==="Enter")open(r);}} tabIndex={0} role="button" aria-label={`Edit ${r.unit.code} for ${r.course.code}`} className="cursor-pointer hover:bg-primary-50 focus:bg-primary-50">
          <td className="px-4 py-3 font-semibold">{r.unit.code}</td><td className="px-4 py-3">{r.unit.name}</td><td className="px-4 py-3">{r.course.code}</td><td className="px-4 py-3 capitalize">{r.unit.unitType}</td><td className="px-4 py-3">{r.unit.nominalHours ?? "—"}</td><td className="px-4 py-3">{r.unit.isActive ? "Active" : "Inactive"}</td>
        </tr>)}</tbody></table>{!loading && !filtered.length ? <p className="p-6 text-center text-sm text-foreground-500">No matching units.</p> : null}</div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-foreground-600">
        <span>{"Showing " + (filtered.length ? ((currentPage-1)*10+1) + "–" + Math.min(currentPage*10,filtered.length) : 0) + " of " + filtered.length}</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={currentPage===1} onClick={()=>setPage(p=>p-1)} className="rounded-lg border border-background-300 px-3 py-2 disabled:opacity-40" aria-label="Previous page">‹</button>
          <span>Page {currentPage} of {pageCount}</span>
          <button type="button" disabled={currentPage===pageCount} onClick={()=>setPage(p=>p+1)} className="rounded-lg border border-background-300 px-3 py-2 disabled:opacity-40" aria-label="Next page">›</button>
        </div>
      </div>
    </section>
    {selected && draft ? <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={()=>setSelected(null)}>
      <section role="dialog" aria-modal="true" aria-label="Unit details" className="h-full w-full max-w-lg overflow-auto bg-background-50 p-6 shadow-xl" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between"><div><h2 className="font-heading text-xl font-bold">{draft.code}</h2><p className="text-sm text-foreground-600">{draft.name}</p></div><button type="button" onClick={()=>setSelected(null)} aria-label="Close">✕</button></div>
        <p className="mb-6 mt-2 text-sm text-foreground-600">Course: {selected.course.code} — {selected.course.name}</p>
        <div className="mb-5 flex gap-6 border-b border-background-200"><button type="button" className={"border-b-2 py-3 text-sm font-semibold " + (drawerTab==="details"?"border-primary-600 text-primary-600":"border-transparent")} onClick={()=>setDrawerTab("details")}>Details</button><button type="button" className={"border-b-2 py-3 text-sm font-semibold " + (drawerTab==="courses"?"border-primary-600 text-primary-600":"border-transparent")} onClick={()=>setDrawerTab("courses")}>Courses</button></div>
        {drawerTab==="courses" ? <div className="rounded-xl border border-background-200 p-4"><p className="mb-3 text-sm text-foreground-600">Courses containing this unit code (read-only)</p>{details.filter(d=>d.units.some(u=>u.code.toLowerCase()===draft.code.toLowerCase())).map(d=><p key={d.course.id} className="border-b border-background-200 py-2 text-sm"><span className="font-semibold">{d.course.code}</span> — {d.course.name}</p>)}</div> : <div className="space-y-4">{([{key:"code",label:"Unit code"},{key:"name",label:"Unit name"}] as const).map(f=><label key={f.key} className="block text-sm font-semibold">{f.label}<input disabled={!canEdit} className={inputClass + " mt-1"} value={draft[f.key]} onChange={e=>setDraft(d=>d?{...d,[f.key]:e.target.value}:d)}/></label>)}
          <label className="block text-sm font-semibold">Type<select disabled={!canEdit} className={inputClass + " mt-1"} value={draft.unitType} onChange={e=>setDraft(d=>d?{...d,unitType:e.target.value as RtoUnit["unitType"]}:d)}><option value="core">Core</option><option value="elective">Elective</option></select></label>
          <label className="block text-sm font-semibold">Nominal hours<input disabled={!canEdit} type="number" min="0" className={inputClass + " mt-1"} value={draft.nominalHours ?? ""} onChange={e=>setDraft(d=>d?{...d,nominalHours:e.target.value===""?null:Number(e.target.value)}:d)}/></label>
          <label className="block text-sm font-semibold">Duration (weeks)<input disabled={!canEdit} type="number" min="0.5" step="0.5" className={inputClass + " mt-1"} value={draft.defaultWeeks} onChange={e=>setDraft(d=>d?{...d,defaultWeeks:Number(e.target.value)}:d)}/></label>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" disabled={!canEdit} checked={draft.isActive} onChange={e=>setDraft(d=>d?{...d,isActive:e.target.checked}:d)}/>Active in this course</label>
        </div>}
        {notice ? <p role="alert" className="mt-4 text-sm text-red-700">{notice}</p> : null}
        <div className="mt-8 flex justify-end gap-3"><button className="rounded-lg border px-4 py-2" onClick={()=>setSelected(null)}>Cancel</button>{canEdit && drawerTab==="details" ? <button disabled={busy} className="rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white disabled:opacity-50" onClick={()=>void save()}>{busy?"Saving…":"Save unit"}</button>:null}</div>
      </section></div> : null}
  </div>;
}
