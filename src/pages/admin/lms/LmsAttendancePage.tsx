import { useEffect, useMemo, useState } from "react";
import ListPane from "@/pages/admin/components/ListPane";
import { useListPane } from "@/pages/admin/lib/listPane";
import { supabase } from "@/pages/admin/lib/supabase";
import AttendanceSummary from "./AttendanceSummary";
import { bestIntake, rto, rtoFlow, type RtoCourse, type RtoIntake, type BatchPageData } from "@/pages/admin/lib/rto";

type Mark = "present" | "absent" | "late" | "excused";
type History = { date: string; unitId: string; state: string };
const statuses: Mark[] = ["present", "absent", "late", "excused"];
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
const itemClass = (active: boolean) => `block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${active ? "bg-primary-50 font-semibold text-foreground-950 ring-1 ring-primary-300" : "text-foreground-700 hover:bg-background-100"}`;
const heading = "text-xs font-semibold uppercase tracking-wide text-foreground-500";
const searchClass = "w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm";
const markClass: Record<Mark, string> = { present: "bg-green-100 text-green-800 ring-green-300", absent: "bg-red-100 text-red-700 ring-red-300", late: "bg-amber-100 text-amber-800 ring-amber-300", excused: "bg-background-200 text-foreground-700 ring-background-300" };
function Search({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label className="relative mt-2 block"><span className="sr-only">{label}</span>
    <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
    <input aria-label={label} placeholder="Search" className={searchClass} value={value} onChange={e => onChange(e.target.value)} />
  </label>;
}
export default function LmsAttendancePage() {
  const pane = useListPane("attendance");
  const [courses,setCourses] = useState<RtoCourse[]>([]);
  const [intakes,setIntakes] = useState<RtoIntake[]>([]);
  const [courseId,setCourseId] = useState("");
  const [intakeId,setIntakeId] = useState("");
  const [batch,setBatch] = useState<BatchPageData|null>(null);
  const [courseSearch,setCourseSearch] = useState("");
  const [intakeSearch,setIntakeSearch] = useState("");
  const [studentSearch,setStudentSearch] = useState("");
  const [unitId,setUnitId] = useState("");
  const [date,setDate] = useState(today);
  const [marks,setMarks] = useState<Record<string,Mark>>({});
  const [state,setState] = useState("new");
  const [history,setHistory] = useState<History[]>([]);
  const [mode,setMode] = useState<"mark"|"history"|"summary">("mark");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [message,setMessage] = useState("");
  useEffect(() => { let live=true; Promise.all([rto<RtoCourse[]>("course_list"),rto<RtoIntake[]>("intake_list")]).then(([c,i])=>{if(live){setCourses(c);setIntakes(i);setCourseId(c[0]?.id??"");}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;}; },[]);
  const filteredIntakes=useMemo(()=>intakes.filter(i=>i.courseId===courseId&&(i.batchList?.length??0)>0),[intakes,courseId]);
  useEffect(()=>{setIntakeId(old=>filteredIntakes.some(i=>i.id===old)?old:bestIntake(filteredIntakes));},[filteredIntakes]);
  // The intake is the class group: its id is what the attendance RPCs call batchId.
  const batchId=filteredIntakes.find(i=>i.id===intakeId)?.batchList?.[0]?.id??"";
  useEffect(()=>{setBatch(null);if(!batchId)return;let live=true;rtoFlow<BatchPageData>("batch_get",{batchId}).then(d=>{if(live)setBatch(d);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[batchId]);
  const units=batch?.batch.schedule??[];
  useEffect(()=>{setUnitId(old=>units.some(u=>u.intakeUnitId===old)?old:units[0]?.intakeUnitId??"");},[batch]);
  // A student who joined late or is carried over from an earlier intake is on the roll only for the units they take in this intake.
  const students=useMemo(()=>batch?.batch.students.filter(s=>(s.status==="active"||s.status==="deferred")&&(!s.path||!unitId||s.path.unitIds.includes(unitId)))??[],[batch,unitId]);
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
  const card="rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  const input="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  const list="mt-2 max-h-56 space-y-0.5 overflow-auto";
  const empty=<p className="px-3 py-2 text-xs text-foreground-500">None</p>;
  const visibleCourses=courses.filter(c=>c.label.toLowerCase().includes(courseSearch.toLowerCase()));
  const visibleIntakes=filteredIntakes.filter(i=>i.name.toLowerCase().includes(intakeSearch.toLowerCase()));
  const markedCount=students.filter(s=>marks[s.enrolmentId]).length;
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header>
      <h1 className="font-heading text-2xl font-bold text-foreground-950">Attendance</h1>
      <p className="text-sm text-foreground-500">Mark attendance by intake, unit and class date.</p>
    </header>
    {error&&<div role="alert" className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}<button className="underline" onClick={()=>setError("")}>Dismiss</button></div>}
    {message&&<p role="status" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{message}</p>}
    <div className={"grid items-start gap-5 " + pane.grid}>
      <ListPane pane={pane} label="Courses">
      <aside className={card+" space-y-4 p-3"}>
        <section><h2 className={heading+" px-1"}>Course</h2><Search label="Search courses" value={courseSearch} onChange={setCourseSearch}/>
          <div className={list}>{visibleCourses.length?visibleCourses.map(c=><button key={c.id} type="button" className={itemClass(c.id===courseId)} onClick={()=>setCourseId(c.id)} title={c.label}>{c.label}</button>):empty}</div></section>
        <section className="border-t border-background-200 pt-3"><h2 className={heading+" px-1"}>Intake</h2><Search label="Search intakes" value={intakeSearch} onChange={setIntakeSearch}/>
          <div className={list}>{visibleIntakes.length?visibleIntakes.map(i=><button key={i.id} type="button" className={itemClass(i.id===intakeId)} onClick={()=>setIntakeId(i.id)}>{i.name}</button>):empty}</div></section>
      </aside>
      </ListPane>
      <section className={card+" min-w-0 p-5"}>
        {!batchId?<p className="py-10 text-center text-sm text-foreground-500">No intake of this course has its classes set up yet. Set up an intake's room, trainer and class times first.</p>:!batch||batch.batch.id!==batchId?<p className="py-10 text-center text-sm text-foreground-500">Loading intake…</p>:<>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <label className="block text-xs font-semibold text-foreground-500">Class date<input type="date" className={input+" mt-1"} value={date} onChange={e=>setDate(e.target.value)}/></label>
            <label className="block text-xs font-semibold text-foreground-500">Unit<select className={input+" mt-1"} value={unitId} onChange={e=>setUnitId(e.target.value)}>{units.map(u=><option key={u.intakeUnitId} value={u.intakeUnitId}>{u.code} — {u.name}</option>)}</select></label>
            <div className="text-xs font-semibold text-foreground-500">Trainer<p className="mt-1 truncate py-2 text-sm font-semibold text-foreground-950">{batch.batch.trainers.map(t=>t.name).join(", ")||"Not assigned"}</p></div>
          </div>
          <div className="mt-5 flex gap-5 border-b border-background-200">{(["mark","history","summary"] as const).map(t=><button type="button" key={t} aria-pressed={mode===t} className={"-mb-px border-b-2 px-1 py-2 text-sm font-semibold "+(mode===t?"border-primary-600 text-primary-700":"border-transparent text-foreground-500 hover:text-foreground-800")} onClick={()=>setMode(t)}>{t==="mark"?"Mark attendance":t==="history"?"History":"Attendance rates"}</button>)}</div>
          {mode==="summary"?<div className="pt-3"><AttendanceSummary batchId={batchId}/></div>:mode==="history"?<div className="pt-3">{history.length?<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500"><th className="px-3 py-2">Date</th><th className="px-3 py-2">Unit</th><th className="px-3 py-2">State</th></tr></thead>
            <tbody>{history.map((h,i)=><tr key={i} className="border-b border-background-100 hover:bg-background-100">
              <td className="px-3 py-2"><button type="button" className="font-semibold text-primary-700 hover:underline" onClick={()=>{setDate(h.date);setUnitId(h.unitId);setMode("mark");}}>{h.date}</button></td>
              <td className="px-3 py-2">{units.find(u=>u.intakeUnitId===h.unitId)?.code??"Unit"}</td>
              <td className="px-3 py-2"><span className={"rounded-full px-2 py-0.5 text-xs font-semibold capitalize "+(h.state==="final"?"bg-green-100 text-green-800":"bg-background-200 text-foreground-600")}>{h.state}</span></td>
            </tr>)}</tbody></table></div>:<p className="py-10 text-center text-sm text-foreground-500">No attendance history yet.</p>}</div>:<div className="pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-48 flex-1"><span className="sr-only">Search students</span>
                <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
                <input className={searchClass} aria-label="Search students" placeholder="Search students" value={studentSearch} onChange={e=>setStudentSearch(e.target.value)}/>
              </label>
              <button type="button" disabled={!batch.rtoManager} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50" onClick={()=>setMarks(Object.fromEntries(students.map(s=>[s.enrolmentId,"present" as Mark])))}>Mark all present</button>
            </div>
            <div className="mt-3 max-h-[490px] overflow-y-auto">{!students.length?<p className="py-10 text-center text-sm text-foreground-500">No active students take this unit in this intake.</p>:students.filter(s=>s.name.toLowerCase().includes(studentSearch.toLowerCase())).map(s=><div key={s.enrolmentId} className="flex flex-wrap items-center justify-between gap-2 border-b border-background-100 px-3 py-2 hover:bg-background-100">
              <p className="min-w-0 truncate text-sm font-semibold text-foreground-950">{s.name}</p>
              <div className="flex flex-wrap gap-1">{statuses.map(st=><label key={st} className={"cursor-pointer rounded-full px-2.5 py-1 text-xs font-semibold capitalize has-[:disabled]:cursor-default has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-400 "+(marks[s.enrolmentId]===st?markClass[st]+" ring-1":"text-foreground-500 hover:bg-background-200")}><input type="radio" className="sr-only" name={s.enrolmentId} value={st} checked={marks[s.enrolmentId]===st} disabled={!batch.rtoManager||busy} onChange={()=>setMarks(prev=>({...prev,[s.enrolmentId]:st}))}/>{st}</label>)}</div>
            </div>)}</div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-foreground-500">{markedCount} / {students.length} marked · <span className="capitalize">{state==="new"?"Unsaved":state}</span></span><div className="flex gap-2"><button type="button" disabled={busy||!batch.rtoManager||!unitId} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50" onClick={()=>void save("draft")}>Save draft</button><button type="button" disabled={busy||!batch.rtoManager||!unitId||!students.length} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50" onClick={()=>void save("final")}>{busy?"Saving…":"Save attendance"}</button></div></div>
          </div>}
        </>}
      </section>
    </div>
  </div>;
}
