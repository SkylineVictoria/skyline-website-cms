import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { rto, rtoFlow, type RtoCourse, type RtoIntake, type BatchPageData } from "@/pages/admin/lib/rto";

type Mark = "present" | "absent" | "late" | "excused";
type History = { date: string; unitId: string; state: string };
const statuses: Mark[] = ["present", "absent", "late", "excused"];
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
const itemClass = (active: boolean) => `w-full rounded-lg border px-3 py-3 text-left text-sm ${active ? "border-primary-400 bg-primary-50 font-semibold" : "border-background-200 hover:bg-background-100"}`;
export default function LmsAttendancePage() {
  const [courses,setCourses] = useState<RtoCourse[]>([]);
  const [intakes,setIntakes] = useState<RtoIntake[]>([]);
  const [courseId,setCourseId] = useState("");
  const [intakeId,setIntakeId] = useState("");
  const [batchId,setBatchId] = useState("");
  const [batch,setBatch] = useState<BatchPageData|null>(null);
  const [courseSearch,setCourseSearch] = useState("");
  const [intakeSearch,setIntakeSearch] = useState("");
  const [batchSearch,setBatchSearch] = useState("");
  const [studentSearch,setStudentSearch] = useState("");
  const [unitId,setUnitId] = useState("");
  const [date,setDate] = useState(today);
  const [marks,setMarks] = useState<Record<string,Mark>>({});
  const [state,setState] = useState("new");
  const [history,setHistory] = useState<History[]>([]);
  const [mode,setMode] = useState<"mark"|"history">("mark");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [message,setMessage] = useState("");
  useEffect(() => { let live=true; Promise.all([rto<RtoCourse[]>("course_list"),rto<RtoIntake[]>("intake_list")]).then(([c,i])=>{if(live){setCourses(c);setIntakes(i);setCourseId(c[0]?.id??"");}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;}; },[]);
  const filteredIntakes=useMemo(()=>intakes.filter(i=>i.courseId===courseId),[intakes,courseId]);
  useEffect(()=>{setIntakeId(old=>filteredIntakes.some(i=>i.id===old)?old:filteredIntakes[0]?.id??"");},[filteredIntakes]);
  const batches=filteredIntakes.find(i=>i.id===intakeId)?.batchList??[];
  useEffect(()=>{setBatchId(old=>batches.some(b=>b.id===old)?old:batches[0]?.id??"");},[intakeId,intakes]);
  useEffect(()=>{setBatch(null);if(!batchId)return;let live=true;rtoFlow<BatchPageData>("batch_get",{batchId}).then(d=>{if(live)setBatch(d);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[batchId]);
  const units=batch?.batch.schedule??[];
  useEffect(()=>{setUnitId(old=>units.some(u=>u.intakeUnitId===old)?old:units[0]?.intakeUnitId??"");},[batch]);
  const students=useMemo(()=>batch?.batch.students.filter(s=>s.status==="active"||s.status==="deferred")??[],[batch]);
  useEffect(()=>{setMarks({});setState("new");setMessage("");if(!batchId||!unitId||!date)return;let live=true;
    supabase.rpc("lms_attendance",{p_action:"get",p_batch_id:batchId,p_unit_id:unitId,p_class_date:date}).then(({data,error})=>{if(!live)return;if(error)setError(error.message);else{const row=data as {state:string;marks:Record<string,Mark>};setState(row.state);setMarks(row.marks??{});}});
    return()=>{live=false;};},[batchId,unitId,date]);
  useEffect(()=>{if(!batchId||mode!=="history")return;let live=true;
    supabase.rpc("lms_attendance",{p_action:"history",p_batch_id:batchId}).then(({data,error})=>{if(!live)return;if(error)setError(error.message);else setHistory((data??[]) as History[]);});
    return()=>{live=false;};},[batchId,mode,state]);
  const save=async(next:"draft"|"final")=>{if(!batchId||!unitId||!date)return;
    if(next==="final"&&students.some(s=>!marks[s.enrolmentId])){setError("Mark every student before finalising attendance.");return;}
    setBusy(true);setError("");setMessage("");
    try{const {error}=await supabase.rpc("lms_attendance",{p_action:"save",p_batch_id:batchId,p_unit_id:unitId,p_class_date:date,p_state:next,p_marks:students.filter(s=>marks[s.enrolmentId]).map(s=>({enrolmentId:s.enrolmentId,status:marks[s.enrolmentId]}))});if(error)throw error;setState(next);setMessage(next==="final"?"Attendance saved.":"Draft saved.");}
    catch(e){setError(e instanceof Error?e.message:"Unable to save attendance");}finally{setBusy(false);}
  };
  const panel="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4";
  const input="w-full rounded-lg border border-background-300 bg-background-50 p-2 text-sm";
  return <div className="mx-auto max-w-[1600px] space-y-4 pb-10">
    <header><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p><h1 className="font-heading text-3xl font-bold">Attendance</h1><p className="text-sm text-foreground-600">Record attendance for the selected batch, unit and class date.</p></header>
    {error&&<div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}<button className="ml-3 underline" onClick={()=>setError("")}>Dismiss</button></div>}
    {message&&<p role="status" className="text-sm text-green-700">{message}</p>}
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(180px,1fr)_minmax(170px,0.85fr)_minmax(170px,0.8fr)_minmax(330px,2.2fr)]">
      <section className={panel}><h2 className="mb-3 font-semibold">1. Course</h2><input aria-label="Search courses" placeholder="Search course…" className={input+" mb-3"} value={courseSearch} onChange={e=>setCourseSearch(e.target.value)}/><div className="space-y-2">{courses.filter(c=>c.label.toLowerCase().includes(courseSearch.toLowerCase())).map(c=><button key={c.id} type="button" className={itemClass(c.id===courseId)} onClick={()=>setCourseId(c.id)}>{c.label}</button>)}</div></section>
      <section className={panel}><h2 className="mb-3 font-semibold">2. Intake</h2><input aria-label="Search intakes" placeholder="Search intake…" className={input+" mb-3"} value={intakeSearch} onChange={e=>setIntakeSearch(e.target.value)}/><div className="space-y-2">{filteredIntakes.filter(i=>i.name.toLowerCase().includes(intakeSearch.toLowerCase())).map(i=><button key={i.id} type="button" className={itemClass(i.id===intakeId)} onClick={()=>setIntakeId(i.id)}>{i.name}</button>)}</div></section>
      <section className={panel}><h2 className="mb-3 font-semibold">3. Batch</h2><input aria-label="Search batches" placeholder="Search batch…" className={input+" mb-3"} value={batchSearch} onChange={e=>setBatchSearch(e.target.value)}/><div className="space-y-2">{batches.filter(b=>b.name.toLowerCase().includes(batchSearch.toLowerCase())).map(b=><button key={b.id} type="button" className={itemClass(b.id===batchId)} onClick={()=>setBatchId(b.id)}>{b.name}</button>)}</div></section>
      <section className={panel}><h2 className="mb-3 font-semibold">4. Attendance</h2>
        {!batchId?<p className="text-sm text-foreground-500">Select a batch.</p>:!batch||batch.batch.id!==batchId?<p className="text-sm text-foreground-500">Loading batch…</p>:<>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <label className="text-xs font-semibold">Class date<input type="date" className={input+" mt-1"} value={date} onChange={e=>setDate(e.target.value)}/></label>
            <label className="text-xs font-semibold">Unit<select className={input+" mt-1"} value={unitId} onChange={e=>setUnitId(e.target.value)}>{units.map(u=><option key={u.intakeUnitId} value={u.intakeUnitId}>{u.code} — {u.name}</option>)}</select></label>
            <div className="text-xs font-semibold">Trainer<div className={input+" mt-1 text-foreground-600"}>{batch.batch.trainers.map(t=>t.name).join(", ")||"Not assigned"}</div></div>
          </div>
          <div className="my-4 grid grid-cols-2 gap-2">{(["mark","history"] as const).map(t=><button type="button" key={t} className={`rounded-lg p-2 text-sm font-semibold ${mode===t?"bg-primary-500 text-white":"bg-background-100"}`} onClick={()=>setMode(t)}>{t==="mark"?"Mark Attendance":"Attendance History"}</button>)}</div>
          {mode==="history"?<div className="space-y-2">{history.map((h,i)=><button key={i} type="button" className="w-full rounded-lg border border-background-200 p-3 text-left text-sm" onClick={()=>{setDate(h.date);setUnitId(h.unitId);setMode("mark");}}>{h.date} · {units.find(u=>u.intakeUnitId===h.unitId)?.code??"Unit"} · {h.state}</button>)}{!history.length&&<p className="text-sm text-foreground-500">No attendance history yet.</p>}</div>:<>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Students ({students.length})</h3><button type="button" disabled={!batch.rtoManager} className="rounded-lg border border-background-300 px-3 py-2 text-xs disabled:opacity-50" onClick={()=>setMarks(Object.fromEntries(students.map(s=>[s.enrolmentId,"present" as Mark])))}>Mark all present</button></div>
            <input className={input+" mb-2"} aria-label="Search students" placeholder="Search students…" value={studentSearch} onChange={e=>setStudentSearch(e.target.value)}/>
            <div className="max-h-[490px] space-y-2 overflow-y-auto">{students.filter(s=>s.name.toLowerCase().includes(studentSearch.toLowerCase())).map(s=><div key={s.enrolmentId} className="rounded-lg border border-background-200 p-3"><p className="mb-2 text-sm font-semibold">{s.name}</p><div className="flex flex-wrap gap-2">{statuses.map(st=><label key={st} className="flex items-center gap-1 text-xs capitalize"><input type="radio" name={s.enrolmentId} value={st} checked={marks[s.enrolmentId]===st} disabled={!batch.rtoManager||busy} onChange={()=>setMarks(prev=>({...prev,[s.enrolmentId]:st}))}/>{st}</label>)}</div></div>)}</div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-foreground-500">{students.filter(s=>marks[s.enrolmentId]).length} / {students.length} marked · {state==="new"?"Unsaved":state}</span><div className="flex gap-2"><button type="button" disabled={busy||!batch.rtoManager||!unitId} className="rounded-lg border border-primary-500 px-3 py-2 text-sm font-semibold text-primary-600 disabled:opacity-50" onClick={()=>void save("draft")}>Save Draft</button><button type="button" disabled={busy||!batch.rtoManager||!unitId||!students.length} className="rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={()=>void save("final")}>{busy?"Saving…":"Save Attendance"}</button></div></div>
          </>}
        </>}
      </section>
    </div>
  </div>;
}
