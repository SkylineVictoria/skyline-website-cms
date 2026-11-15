import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import { rto, type RtoCourse, type RtoIntake, type IntakeDetail } from "@/pages/admin/lib/rto";

const field = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const statusBadge = (s: string) => "rounded-full px-2 py-0.5 text-xs font-semibold capitalize " + (
  s === "open" || s === "active" ? "bg-green-100 text-green-800" : s === "cancelled" ? "bg-red-100 text-red-700" : "bg-background-200 text-foreground-600");
export default function LmsIntakesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courseId, setCourseId] = useState("");
  const [courseSearch, setCourseSearch] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [role, setRole] = useState({rtoManager:false,admin:false});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [capacity, setCapacity] = useState("");
  const load = useCallback(async () => {
    try {
      const [cs, is, me] = await Promise.all([rto<RtoCourse[]>("course_list"),rto<RtoIntake[]>("intake_list"),rto<{rtoManager:boolean;admin:boolean}>("me")]);
      setCourses(cs);setIntakes(is);setRole(me);setError("");
      setCourseId(prev => cs.some(c=>c.id===prev)?prev:(cs[0]?.id??""));
    } catch(e) {setError(e instanceof Error?e.message:"Unable to load intakes.");}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    setDetail(null);setNotice("");
    if(!selectedId)return;
    let active=true;
    rto<IntakeDetail>("intake_get",{intakeId:selectedId}).then(d=>{if(active){setDetail(d);setCapacity(d.intake.capacity==null?"":String(d.intake.capacity));}})
      .catch(e=>{if(active)setNotice(e instanceof Error?e.message:"Unable to load intake.");});
    return ()=>{active=false;};
  },[selectedId]);
  const chooseCourse=(id:string)=>{setCourseId(id);setSelectedId("");setDetail(null);setNotice("");};
  const selectedCourse=courses.find(c=>c.id===courseId);
  const courseIntakes=intakes.filter(i=>i.courseId===courseId);
  const filtered=useMemo(()=>courseIntakes.filter(i=>(status==="all"||i.status===status)&&(i.name+" "+i.startDate).toLowerCase().includes(search.toLowerCase())),[courseIntakes,status,search]);
  const save=async(nextStatus?:RtoIntake["status"])=>{
    if(!detail||!role.rtoManager||busy)return;
    setBusy(true);setNotice("");
    try{
      const updated=await rto<IntakeDetail>("intake_save",{id:detail.intake.id,capacity,...(nextStatus?{status:nextStatus}:{})});
      setDetail(updated);setCapacity(updated.intake.capacity==null?"":String(updated.intake.capacity));
      setIntakes(prev=>prev.map(i=>i.id===updated.intake.id?updated.intake:i));
      setNotice("Intake saved.");
    }catch(e){setNotice(e instanceof Error?e.message:"Could not save intake.");}
    finally{setBusy(false);}
  };
  const visibleCourses=courses.filter(c=>(c.code+" "+c.name).toLowerCase().includes(courseSearch.toLowerCase()));
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Intakes</h1>
        <p className="text-sm text-foreground-500">Intakes for each course.</p>
      </div>
      {role.rtoManager&&selectedCourse?<button type="button" onClick={()=>setCreating(true)} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">Add intake</button>:null}
    </header>
    {error?<div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}<button onClick={()=>void load()} className="ml-3 underline">Retry</button></div>:null}
    <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className={card+" p-3"}>
        <label className="relative block"><span className="sr-only">Search courses</span>
          <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
          <input className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" aria-label="Search courses" placeholder="Search course" value={courseSearch} onChange={e=>setCourseSearch(e.target.value)}/>
        </label>
        <div className="mt-3 max-h-[70vh] space-y-1 overflow-auto">{visibleCourses.length===0?<p className="p-3 text-sm text-foreground-500">No matching courses.</p>:visibleCourses.map(c=>{
          const count=intakes.filter(i=>i.courseId===c.id).length;
          return <button type="button" key={c.id} aria-pressed={courseId===c.id} onClick={()=>chooseCourse(c.id)}
            className={"flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors "+(courseId===c.id?"bg-primary-50 ring-1 ring-primary-300":"hover:bg-background-100")}>
            <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full "+(c.isActive?"bg-green-500":"bg-background-300")} title={c.isActive?"Active":"Inactive"} />
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-foreground-950">{c.code}</span>
              <span className="block truncate text-xs text-foreground-600">{c.name}</span></span>
            <span className="shrink-0 text-xs text-foreground-500" title={count+" intakes"}>{count}</span>
          </button>;})}</div>
      </aside>
      <section className={card+" min-w-0 p-5"}>
        {!selectedCourse?<p className="py-10 text-center text-sm text-foreground-500">Select a course.</p>:<>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{selectedCourse.code}</p>
            <h2 className="font-heading text-xl font-bold text-foreground-950">{selectedCourse.name}</h2>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label className="relative min-w-48 flex-1"><span className="sr-only">Search intakes</span>
              <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
              <input className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" aria-label="Search intakes" placeholder="Search intakes" value={search} onChange={e=>setSearch(e.target.value)}/>
            </label>
            <select className="rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm" aria-label="Intake status" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option><option value="planned">Planned</option><option value="open">Open</option><option value="active">Active</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select>
            <span className="text-xs text-foreground-500">{filtered.length} intake{filtered.length===1?"":"s"}</span>
          </div>
          <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">{["Intake","Start date","End date","Campus","Places","Status"].map(x=><th key={x} className="px-3 py-2">{x}</th>)}</tr></thead>
            <tbody>{filtered.map(i=><tr key={i.id} tabIndex={0} role="button" aria-label={"Open "+i.name} onClick={()=>setSelectedId(i.id)} onKeyDown={e=>{if(e.key==="Enter")setSelectedId(i.id);}} className={"cursor-pointer border-b border-background-100 "+(selectedId===i.id?"bg-primary-50":"hover:bg-background-100")}>
              <td className="px-3 py-2 font-semibold text-foreground-950">{i.name}</td><td className="px-3 py-2">{i.startDate}</td><td className="px-3 py-2">{i.endDate||"—"}</td><td className="px-3 py-2">{i.campus||"—"}</td><td className="px-3 py-2">{i.capacity??"—"}</td><td className="px-3 py-2"><span className={statusBadge(i.status)}>{i.status}</span></td>
            </tr>)}</tbody></table>{!filtered.length?<p className="py-10 text-center text-sm text-foreground-500">No intakes for this selection.</p>:null}</div>
        </>}
      </section>
    </div>
    {selectedId?<div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={()=>setSelectedId("")}>
      <section role="dialog" aria-modal="true" aria-label="Edit intake" className="h-full w-full max-w-lg overflow-y-auto bg-background-50 p-5 shadow-xl" onClick={e=>e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Intake</p>
            <h2 className="font-heading text-xl font-bold text-foreground-950">{detail?.intake.name??"…"}</h2>
          </div>
          <button type="button" aria-label="Close" onClick={()=>setSelectedId("")} className="rounded-lg p-1.5 text-foreground-600 hover:bg-background-100"><i className="ri-close-line text-lg" aria-hidden="true" /></button>
        </div>
        {!detail?<p className="py-10 text-center text-sm text-foreground-500">{notice||"Loading intake…"}</p>:<div className="mt-4 space-y-4">
          <Link to="/admin/lms/courses" className="block truncate text-sm text-primary-700 underline">{detail.intake.courseCode} — {detail.intake.courseName}</Link>
          <dl className="grid grid-cols-2 rounded-lg border border-background-200 sm:grid-cols-4 sm:divide-x sm:divide-background-200">
            {([["Start",detail.intake.startDate],["End",detail.intake.endDate||"—"],["Enrolled",String(detail.intake.enrolled)],["Campus",detail.intake.campus||"—"]] as [string,string][]).map(([label,value])=><div key={label} className="px-3 py-2">
              <dt className="text-xs text-foreground-500">{label}</dt><dd className="truncate text-sm font-semibold text-foreground-950">{value}</dd>
            </div>)}
          </dl>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-foreground-700">Status<select disabled={!role.rtoManager||busy} className={field+" mt-1 capitalize"} value={detail.intake.status} onChange={e=>setDetail(d=>d?{...d,intake:{...d.intake,status:e.target.value as RtoIntake["status"]}}:d)}>{Array.from(new Set([detail.intake.status,"planned","open","active","completed","cancelled"])).map(s=><option key={s} value={s}>{s}</option>)}</select></label>
            <label className="block text-xs font-semibold text-foreground-700">Capacity<input disabled={!role.rtoManager||busy} type="number" min="0" className={field+" mt-1"} value={capacity} onChange={e=>setCapacity(e.target.value)}/></label>
          </div>
          {notice?<p role="status" className={"rounded-lg border px-3 py-2 text-sm "+(notice==="Intake saved."?"border-green-200 bg-green-50 text-green-800":"border-red-200 bg-red-50 text-red-700")}>{notice}</p>:null}
          <div className="flex justify-end gap-2"><button className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100" onClick={()=>setSelectedId("")}>Cancel</button>{role.rtoManager?<button disabled={busy} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50" onClick={()=>void save(detail.intake.status)}>{busy?"Saving…":"Save changes"}</button>:null}</div>
        </div>}
      </section></div>:null}
    <NewIntakeDrawer open={creating&&role.rtoManager} onClose={()=>setCreating(false)} courses={courses.map(c=>({id:c.id,label:c.label}))} courseId={courseId||undefined}
      onCreated={(created:IntakeDetail)=>{setCreating(false);setCourseId(created.intake.courseId);setSelectedId(created.intake.id);void load();}}/>
  </div>;
}
