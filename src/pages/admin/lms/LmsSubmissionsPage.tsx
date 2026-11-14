import { useCallback, useEffect, useMemo, useState } from "react";
import { rto, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";
import { asmAdmin, downloadCsv, type AssignmentRow, type AssignmentStudent } from "@/pages/admin/lib/assessments";
import AttemptDrawer from "@/pages/admin/assessments/panels/AttemptDrawer";

/** LMS-only submission register. No shadow student or assessment data. */
export default function LmsSubmissionsPage() {
  const [courses,setCourses] = useState<RtoCourse[]>([]);
  const [intakes,setIntakes] = useState<RtoIntake[]>([]);
  const [assignments,setAssignments] = useState<AssignmentRow[]>([]);
  const [courseId,setCourseId] = useState("");
  const [intakeId,setIntakeId] = useState("");
  const [batchId,setBatchId] = useState("");
  const [assignmentId,setAssignmentId] = useState("");
  const [students,setStudents] = useState<AssignmentStudent[]>([]);
  const [search,setSearch] = useState(["","","",""]);
  const [status,setStatus] = useState("all");
  const [attemptFilter,setAttemptFilter] = useState("all");
  const [page,setPage] = useState(1);
  const [attemptId,setAttemptId] = useState<string|null>(null);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [c,i,a] = await Promise.all([rto<RtoCourse[]>("course_list"),rto<RtoIntake[]>("intake_list"),asmAdmin<AssignmentRow[]>("assignment_list",{})]);
      setCourses(c);setIntakes(i);setAssignments(a);setCourseId(old=>c.some(x=>x.id===old)?old:c[0]?.id??"");setError("");
    } catch(e) {setError(e instanceof Error?e.message:"Unable to load submissions");}
  },[]);
  useEffect(()=>{void load();},[load]);
  const matchingIntakes=useMemo(()=>intakes.filter(x=>x.courseId===courseId),[intakes,courseId]);
  useEffect(()=>setIntakeId(old=>matchingIntakes.some(x=>x.id===old)?old:matchingIntakes[0]?.id??""),[matchingIntakes]);
  const batches=matchingIntakes.find(x=>x.id===intakeId)?.batchList??[];
  useEffect(()=>setBatchId(old=>batches.some(x=>x.id===old)?old:batches[0]?.id??""),[intakeId,intakes]);
  const batchAssignments=useMemo(()=>assignments.filter(x=>x.batchId===batchId),[assignments,batchId]);
  useEffect(()=>setAssignmentId(old=>batchAssignments.some(x=>x.id===old)?old:batchAssignments[0]?.id??""),[batchAssignments]);
  const fetchStudents=useCallback(async()=>{
    if(!assignmentId){setStudents([]);return;}
    setLoading(true);setStudents([]);
    try {setStudents(await asmAdmin<AssignmentStudent[]>("assignment_students",{id:assignmentId}));setError("");}
    catch(e){setError(e instanceof Error?e.message:"Unable to load students");}
    finally{setLoading(false);}
  },[assignmentId]);
  useEffect(()=>{void fetchStudents();},[fetchStudents]);
  const selected=batchAssignments.find(x=>x.id===assignmentId);
  const rows=students.map(s=>{
    const latest=[...s.attempts].sort((a,b)=>b.attemptNo-a.attemptNo)[0];
    const state=latest?.state??(s.dueAt&&new Date(s.dueAt)<new Date()?"overdue":"pending");
    return {student:s,latest,state};
  });
  const submitted=rows.filter(r=>["submitted","marking","final","returned"].includes(r.state)).length;
  const overdue=rows.filter(r=>r.state==="overdue").length;
  const filtered=rows.filter(r=>(r.student.name.toLowerCase().includes(search[3].toLowerCase())||r.student.studentId.toLowerCase().includes(search[3].toLowerCase()))&&(status==="all"||r.state===status)&&(attemptFilter==="all"||String(r.latest?.attemptNo??0)===attemptFilter));
  const pages=Math.max(1,Math.ceil(filtered.length/8));
  const visible=filtered.slice((Math.min(page,pages)-1)*8,Math.min(page,pages)*8);
  useEffect(()=>setPage(1),[assignmentId,status,attemptFilter,search]);
  const box="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4";
  const field="w-full rounded-lg border border-background-300 bg-background-50 p-2 text-sm";
  const item=(active:boolean)=>`w-full rounded-lg border px-3 py-3 text-left text-sm ${active?"border-primary-400 bg-primary-50 font-semibold":"border-background-200 hover:bg-background-100"}`;
  const choice=(values:{id:string;label:string}[],value:string,onChange:(id:string)=>void,index:number)=> <div className="space-y-2">{values.filter(v=>v.label.toLowerCase().includes(search[index].toLowerCase())).map(v=><button type="button" key={v.id} className={item(value===v.id)} onClick={()=>onChange(v.id)}>{v.label}</button>)}</div>;
  return <div className="mx-auto max-w-[1700px] space-y-4 pb-10">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p><h1 className="font-heading text-3xl font-bold">Submissions</h1><p className="text-sm text-foreground-600">View and manage student assessment submissions.</p></div><div className="flex gap-2"><button type="button" className="rounded-lg border border-primary-500 px-3 py-2 text-sm text-primary-600" onClick={()=>downloadCsv("lms-submissions.csv",filtered.map(r=>({studentId:r.student.studentId,student:r.student.name,assessment:selected?.assessmentTitle??"",status:r.state,attempt:r.latest?.attemptNo??"",submittedAt:r.latest?.submittedAt??""})))}>Export CSV</button><button type="button" className="rounded-lg border border-background-300 px-3 py-2 text-sm" onClick={()=>void fetchStudents()}>Refresh</button></div></header>
    {error?<p role="alert" className="rounded-lg border border-red-200 p-3 text-sm text-red-700">{error}</p>:null}
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(170px,1fr)_minmax(170px,0.9fr)_minmax(170px,0.9fr)_minmax(480px,3fr)]">
      <section className={box}><h2 className="mb-3 font-semibold">1. Course</h2><input className={field+" mb-3"} aria-label="Search course" placeholder="Search course…" value={search[0]} onChange={e=>setSearch(v=>[e.target.value,v[1],v[2],v[3]])}/>{choice(courses.map(c=>({id:c.id,label:c.label})),courseId,setCourseId,0)}</section>
      <section className={box}><h2 className="mb-3 font-semibold">2. Intake</h2><input className={field+" mb-3"} aria-label="Search intake" placeholder="Search intake…" value={search[1]} onChange={e=>setSearch(v=>[v[0],e.target.value,v[2],v[3]])}/>{choice(matchingIntakes.map(i=>({id:i.id,label:i.name})),intakeId,setIntakeId,1)}</section>
      <section className={box}><h2 className="mb-3 font-semibold">3. Batch</h2><input className={field+" mb-3"} aria-label="Search batch" placeholder="Search batch…" value={search[2]} onChange={e=>setSearch(v=>[v[0],v[1],e.target.value,v[3]])}/>{choice(batches.map(b=>({id:b.id,label:b.name})),batchId,setBatchId,2)}</section>
      <section className={box}><h2 className="mb-3 font-semibold">4. Submissions</h2>
        {!batchId?<p className="text-sm text-foreground-500">Select a batch to view submissions.</p>:<>
          <label className="mb-3 block text-xs font-semibold">Unit / Assessment<select className={field+" mt-1"} value={assignmentId} onChange={e=>setAssignmentId(e.target.value)}><option value="">Select an assigned assessment</option>{batchAssignments.map(a=><option key={a.id} value={a.id}>{a.unitCode??"Course"} — {a.assessmentTitle}</option>)}</select></label>
          {selected?<p className="mb-3 rounded-lg bg-primary-50 p-3 text-sm">{selected.batchName} · {selected.assessmentTitle} · Due {new Date(selected.dueAt).toLocaleDateString()}</p>:null}
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{[[rows.length,"Students"],[submitted,"Submitted"],[rows.length-submitted-overdue,"Pending"],[overdue,"Overdue"]].map(([n,label])=><div key={label} className="rounded-lg border border-background-200 p-3"><p className="text-xl font-bold">{n}</p><p className="text-xs text-foreground-500">{label}</p></div>)}</div>
          <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]"><input className={field} aria-label="Search student" placeholder="Search student name or ID…" value={search[3]} onChange={e=>setSearch(v=>[v[0],v[1],v[2],e.target.value])}/><select aria-label="Status" className={field} value={status} onChange={e=>setStatus(e.target.value)}>{["all","pending","draft","submitted","marking","returned","final","overdue"].map(x=><option key={x} value={x}>{x==="all"?"All statuses":x}</option>)}</select><select aria-label="Attempt" className={field} value={attemptFilter} onChange={e=>setAttemptFilter(e.target.value)}><option value="all">All attempts</option><option value="1">Attempt 1</option><option value="2">Attempt 2</option><option value="3">Attempt 3</option></select><button type="button" className="rounded-lg border border-primary-500 px-3 py-2 text-sm text-primary-600" onClick={()=>{setStatus("all");setAttemptFilter("all");setSearch(v=>[v[0],v[1],v[2],""]);}}>Clear filters</button></div>
          <div className="overflow-x-auto rounded-lg border border-background-200"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-background-100"><tr><th className="p-3">Student ID</th><th className="p-3">Student name</th><th className="p-3">Submission</th><th className="p-3">Status</th><th className="p-3">Attempt</th><th className="p-3">Submitted on</th><th className="p-3">Action</th></tr></thead><tbody className="divide-y divide-background-100">{visible.map(r=><tr key={r.student.studentId}><td className="p-3">{r.student.studentId.slice(0,8)}</td><td className="p-3 font-semibold">{r.student.name}</td><td className="p-3">{r.latest?.receiptNo??"—"}</td><td className="p-3 capitalize">{r.state.replaceAll("_"," ")}</td><td className="p-3">{r.latest?.attemptNo??"—"}</td><td className="p-3">{r.latest?.submittedAt?new Date(r.latest.submittedAt).toLocaleString():"—"}</td><td className="p-3">{r.latest?<button type="button" className="font-semibold text-primary-600 underline" onClick={()=>setAttemptId(r.latest!.id)}>View</button>:<span className="text-foreground-500">—</span>}</td></tr>)}</tbody></table>{loading?<p className="p-4 text-sm">Loading submissions…</p>:!visible.length?<p className="p-4 text-sm text-foreground-500">No submissions match this selection.</p>:null}</div>
          <div className="mt-3 flex items-center justify-between text-sm"><span>Showing {filtered.length?Math.min(page,pages)*8-7:0}–{Math.min(page,pages)*8>filtered.length?filtered.length:Math.min(page,pages)*8} of {filtered.length}</span><div className="flex gap-2"><button type="button" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Previous</button><span>{Math.min(page,pages)} / {pages}</span><button type="button" disabled={page>=pages} onClick={()=>setPage(p=>p+1)}>Next</button></div></div>
        </>}
      </section>
    </div>
    {attemptId?<AttemptDrawer attemptId={attemptId} onClose={()=>setAttemptId(null)} onChanged={()=>void fetchStudents()}/>:null}
  </div>;
}
