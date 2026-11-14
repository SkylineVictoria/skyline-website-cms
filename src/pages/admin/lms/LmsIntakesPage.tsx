import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import { rto, type RtoCourse, type RtoIntake, type IntakeDetail } from "@/pages/admin/lib/rto";

const field = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
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
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header><p className="text-sm text-foreground-500">LMS / Intakes</p><h1 className="mt-2 font-heading text-3xl font-bold">Intakes</h1>
      <p className="mt-1 text-sm text-foreground-600">Select a course to view, add or edit its intakes. Batches are managed separately.</p></header>
    {error?<div role="alert" className="rounded-lg border border-red-200 p-3 text-red-700">{error}<button onClick={()=>void load()} className="ml-3 underline">Retry</button></div>:null}
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,2fr)]">
      <aside className="rounded-2xl border border-background-200 bg-background-50 p-4 shadow-sm">
        <h2 className="mb-3 font-heading text-lg font-bold">Courses</h2>
        <input className={field+" mb-3"} aria-label="Search courses" placeholder="Search course" value={courseSearch} onChange={e=>setCourseSearch(e.target.value)}/>
        <div className="max-h-[680px] space-y-2 overflow-auto">{courses.filter(c=>(c.code+" "+c.name).toLowerCase().includes(courseSearch.toLowerCase())).map(c=>
          <button type="button" key={c.id} aria-pressed={courseId===c.id} onClick={()=>chooseCourse(c.id)} className={"w-full rounded-lg border p-3 text-left hover:border-primary-500 "+(courseId===c.id?"border-primary-500 bg-primary-50":"border-background-200")}>
            <span className="block font-semibold">{c.code}</span><span className="block text-sm text-foreground-600">{c.name}</span><span className="mt-1 block text-xs text-primary-600">{intakes.filter(i=>i.courseId===c.id).length} intakes</span>
          </button>)}</div>
      </aside>
      <section className="min-w-0 rounded-2xl border border-background-200 bg-background-50 p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-heading text-lg font-bold">Intakes — {selectedCourse?.code??"Select course"}</h2><p className="text-sm text-foreground-600">{selectedCourse?.name}</p></div>
          {role.rtoManager&&selectedCourse?<button type="button" onClick={()=>setCreating(true)} className="rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white">+ Add Intake</button>:null}
        </div>
        <div className="mb-4 flex flex-wrap gap-3"><input className={field+" min-w-48 flex-1"} aria-label="Search intakes" placeholder="Search intakes" value={search} onChange={e=>setSearch(e.target.value)}/>
          <select className={field+" w-auto"} aria-label="Intake status" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option><option value="planned">Planned</option><option value="open">Open</option><option value="active">Active</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select>
        </div>
        <div className="overflow-x-auto rounded-xl border border-background-200"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-background-100"><tr>{["Intake","Start date","End date","Campus","Places","Status"].map(x=><th key={x} className="px-3 py-3">{x}</th>)}</tr></thead>
          <tbody className="divide-y divide-background-200">{filtered.map(i=><tr key={i.id} tabIndex={0} role="button" aria-label={"Open "+i.name} onClick={()=>setSelectedId(i.id)} onKeyDown={e=>{if(e.key==="Enter")setSelectedId(i.id);}} className={"cursor-pointer hover:bg-primary-50 "+(selectedId===i.id?"bg-primary-50":"")}>
            <td className="px-3 py-3 font-semibold">{i.name}</td><td className="px-3 py-3">{i.startDate}</td><td className="px-3 py-3">{i.endDate||"—"}</td><td className="px-3 py-3">{i.campus||"—"}</td><td className="px-3 py-3">{i.capacity??"—"}</td><td className="px-3 py-3 capitalize">{i.status}</td>
          </tr>)}</tbody></table>{!filtered.length?<p className="p-6 text-center text-sm text-foreground-500">No intakes for this selection.</p>:null}</div>
        <p className="mt-3 text-sm text-foreground-500">{filtered.length} intakes</p>
      </section>
    </div>
    {selectedId?<div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={()=>setSelectedId("")}>
      <section role="dialog" aria-modal="true" aria-label="Edit intake" className="h-full w-full max-w-lg overflow-y-auto bg-background-50 p-6 shadow-xl" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between"><h2 className="font-heading text-xl font-bold">Intake details</h2><button type="button" aria-label="Close" onClick={()=>setSelectedId("")}>✕</button></div>
        {!detail?<p className="mt-6 text-sm">Loading intake…</p>:<div className="mt-5 space-y-4">
          <div className="rounded-lg bg-primary-50 p-3"><p className="text-sm font-semibold">{detail.intake.name}</p><Link to="/admin/lms/courses" className="text-sm text-primary-600 underline">Parent course: {detail.intake.courseCode} — {detail.intake.courseName}</Link></div>
          <div className="grid grid-cols-2 gap-3"><div><p className="text-xs text-foreground-500">Start date</p><p className="font-semibold">{detail.intake.startDate}</p></div><div><p className="text-xs text-foreground-500">End date</p><p className="font-semibold">{detail.intake.endDate}</p></div></div>
          <label className="block text-sm font-semibold">Status<select disabled={!role.rtoManager||busy} className={field+" mt-1"} value={detail.intake.status} onChange={e=>setDetail(d=>d?{...d,intake:{...d.intake,status:e.target.value as RtoIntake["status"]}}:d)}>{Array.from(new Set([detail.intake.status,"planned","open","active","completed","cancelled"])).map(s=><option key={s} value={s}>{s}</option>)}</select></label>
          <label className="block text-sm font-semibold">Capacity<input disabled={!role.rtoManager||busy} type="number" min="0" className={field+" mt-1"} value={capacity} onChange={e=>setCapacity(e.target.value)}/></label>
          <div className="grid grid-cols-2 gap-3"><div className="rounded-lg bg-background-100 p-3"><p className="text-xs text-foreground-500">Enrolled</p><p className="text-xl font-bold">{detail.intake.enrolled}</p></div><div className="rounded-lg bg-background-100 p-3"><p className="text-xs text-foreground-500">Campus</p><p className="font-semibold">{detail.intake.campus||"—"}</p></div></div>
          {notice?<p role="status" className="text-sm text-primary-700">{notice}</p>:null}
          <div className="flex justify-end gap-3"><button className="rounded-lg border px-4 py-2" onClick={()=>setSelectedId("")}>Cancel</button>{role.rtoManager?<button disabled={busy} className="rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white" onClick={()=>void save(detail.intake.status)}>{busy?"Saving…":"Save Changes"}</button>:null}</div>
        </div>}
      </section></div>:null}
    <NewIntakeDrawer open={creating&&role.rtoManager} onClose={()=>setCreating(false)} courses={courses.map(c=>({id:c.id,label:c.label}))} courseId={courseId||undefined}
      onCreated={(created:IntakeDetail)=>{setCreating(false);setCourseId(created.intake.courseId);setSelectedId(created.intake.id);void load();}}/>
  </div>;
}
