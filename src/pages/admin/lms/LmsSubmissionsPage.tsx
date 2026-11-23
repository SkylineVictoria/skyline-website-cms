import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import ListPane from "@/pages/admin/components/ListPane";
import { useListPane } from "@/pages/admin/lib/listPane";
import { rto, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";
import { asmAdmin, downloadCsv, type AssignmentRow, type AssignmentStudent } from "@/pages/admin/lib/assessments";
import AttemptDrawer from "@/pages/admin/assessments/panels/AttemptDrawer";
import SearchableSelect from "@/components/ui/SearchableSelect";

/** LMS-only submission register. No shadow student or assessment data. */
export default function LmsSubmissionsPage() {
  const pane = useListPane("submissions");
  const [courses,setCourses] = useState<RtoCourse[]>([]);
  const [intakes,setIntakes] = useState<RtoIntake[]>([]);
  const [assignments,setAssignments] = useState<AssignmentRow[]>([]);
  const [courseId,setCourseId] = useState("");
  const [intakeId,setIntakeId] = useState("");
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
  const matchingIntakes=useMemo(()=>intakes.filter(x=>x.courseId===courseId&&(x.batchList?.length??0)>0),[intakes,courseId]);
  useEffect(()=>setIntakeId(old=>matchingIntakes.some(x=>x.id===old)?old:matchingIntakes[0]?.id??""),[matchingIntakes]);
  // The intake is the class group: assignments carry its id as batchId.
  const batchId=matchingIntakes.find(x=>x.id===intakeId)?.batchList?.[0]?.id??"";
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
  const card="rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  const field="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  const searchField="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm";
  const sectionTitle="text-xs font-semibold uppercase tracking-wide text-foreground-500";
  const secondaryBtn="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100";
  const pagerBtn="rounded-lg border border-background-300 px-2.5 py-1 text-xs font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50";
  const th="px-3 py-2";
  const row=(active:boolean)=>"flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors "+(active?"bg-primary-50 ring-1 ring-primary-300":"hover:bg-background-100");
  const stateBadge=(state:string)=>"rounded-full px-2 py-0.5 text-xs font-semibold capitalize "+(["final","returned","submitted"].includes(state)?"bg-green-100 text-green-800":state==="overdue"?"bg-red-100 text-red-700":state==="marking"?"bg-amber-100 text-amber-800":"bg-background-200 text-foreground-600");
  const choice=(values:{id:string;label:string;title?:string;sub?:string;dot?:boolean}[],value:string,onChange:(id:string)=>void,index:number)=> <div className="mt-3 max-h-[30vh] space-y-1 overflow-auto">{values.filter(v=>v.label.toLowerCase().includes(search[index].toLowerCase())).map(v=><button type="button" key={v.id} className={row(value===v.id)} onClick={()=>onChange(v.id)}>{v.dot!==undefined?<span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full "+(v.dot?"bg-green-500":"bg-background-300")} title={v.dot?"Active":"Inactive"}/>:null}<span className="min-w-0"><span className="block text-sm font-semibold text-foreground-950">{v.title??v.label}</span>{v.sub?<span className="block truncate text-xs text-foreground-600">{v.sub}</span>:null}</span></button>)}</div>;
  const listCard=(title:string,searchLabel:string,index:number,list:ReactNode)=><section className={card+" p-3"}><h2 className={sectionTitle+" mb-2 px-1"}>{title}</h2><label className="relative block"><i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true"/><input className={searchField} aria-label={searchLabel} placeholder={searchLabel+"…"} value={search[index]} onChange={e=>{const t=e.target.value;setSearch(v=>v.map((x,i)=>i===index?t:x));}}/></label>{list}</section>;
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="font-heading text-2xl font-bold text-foreground-950">Submissions</h1><p className="text-sm text-foreground-500">Student submissions by intake and assessment.</p></div><div className="flex flex-wrap gap-2"><button type="button" className={secondaryBtn} onClick={()=>downloadCsv("lms-submissions.csv",filtered.map(r=>({studentId:r.student.studentId,student:r.student.name,assessment:selected?.assessmentTitle??"",status:r.state,attempt:r.latest?.attemptNo??"",submittedAt:r.latest?.submittedAt??""})))}>Export CSV</button><button type="button" className={secondaryBtn} onClick={()=>void fetchStudents()}>Refresh</button></div></header>
    {error?<p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>:null}
    <div className={"grid items-start gap-5 " + pane.grid}>
      <ListPane pane={pane} label="Courses">
      <div className="min-w-0 space-y-5">
        {listCard("Course","Search course",0,choice(courses.map(c=>({id:c.id,label:c.label,title:c.code,sub:c.name+(c.variantLabel?` (${c.variantLabel})`:""),dot:c.isActive})),courseId,setCourseId,0))}
        {listCard("Intake","Search intake",1,choice(matchingIntakes.map(i=>({id:i.id,label:i.name})),intakeId,setIntakeId,1))}
      </div>
      </ListPane>
      <section className={card+" min-w-0 p-5"}>
        {!batchId?<p className="py-10 text-center text-sm text-foreground-500">Select an intake with classes set up to view submissions.</p>:<>
          <label className="block text-xs font-semibold text-foreground-500">Unit / Assessment<SearchableSelect className={field+" mt-1 font-normal text-foreground-950"} value={assignmentId} onChange={e=>setAssignmentId(e.target.value)}><option value="">Select an assigned assessment</option>{batchAssignments.map(a=><option key={a.id} value={a.id}>{a.unitCode??"Course"} — {a.assessmentTitle}</option>)}</SearchableSelect></label>
          {selected?<p className="mt-2 text-xs text-foreground-500">{selected.batchName} · Due {new Date(selected.dueAt).toLocaleDateString()}</p>:null}
          <dl className="mt-4 grid grid-cols-2 rounded-lg border border-background-200 sm:grid-cols-4 sm:divide-x sm:divide-background-200">{([["Students",rows.length],["Submitted",submitted],["Pending",rows.length-submitted-overdue],["Overdue",overdue]] as [string,number][]).map(([label,n])=><div key={label} className="px-3 py-2"><dt className="text-xs text-foreground-500">{label}</dt><dd className="text-sm font-semibold text-foreground-950">{n}</dd></div>)}</dl>
          <div className="mt-4 flex flex-wrap items-center gap-2"><label className="relative block min-w-0 flex-1 basis-56"><i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true"/><input className={searchField} aria-label="Search student" placeholder="Search student name or ID…" value={search[3]} onChange={e=>setSearch(v=>[v[0],v[1],v[2],e.target.value])}/></label><SearchableSelect aria-label="Status" className="rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm" value={status} onChange={e=>setStatus(e.target.value)}>{["all","pending","draft","submitted","marking","returned","final","overdue"].map(x=><option key={x} value={x}>{x==="all"?"All statuses":x}</option>)}</SearchableSelect><SearchableSelect aria-label="Attempt" className="rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm" value={attemptFilter} onChange={e=>setAttemptFilter(e.target.value)}><option value="all">All attempts</option><option value="1">Attempt 1</option><option value="2">Attempt 2</option><option value="3">Attempt 3</option></SearchableSelect><button type="button" className="px-2 py-2 text-sm font-semibold text-primary-700 hover:underline" onClick={()=>{setStatus("all");setAttemptFilter("all");setSearch(v=>[v[0],v[1],v[2],""]);}}>Clear filters</button></div>
          <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500"><th className={th}>Student ID</th><th className={th}>Student name</th><th className={th}>Submission</th><th className={th}>Status</th><th className={th}>Attempt</th><th className={th}>Submitted on</th><th className={th}>Action</th></tr></thead><tbody>{visible.map(r=><tr key={r.student.studentId} className="border-b border-background-100 hover:bg-background-100"><td className={th+" font-mono text-xs text-foreground-600"}>{r.student.studentId.slice(0,8)}</td><td className={th+" font-semibold text-foreground-950"}>{r.student.name}</td><td className={th}>{r.latest?.receiptNo??"—"}</td><td className={th}><span className={stateBadge(r.state)}>{r.state.replaceAll("_"," ")}</span></td><td className={th}>{r.latest?.attemptNo??"—"}</td><td className={th+" whitespace-nowrap"}>{r.latest?.submittedAt?new Date(r.latest.submittedAt).toLocaleString():"—"}</td><td className={th}>{r.latest?<button type="button" className="font-semibold text-primary-700 hover:underline" onClick={()=>setAttemptId(r.latest!.id)}>View</button>:<span className="text-foreground-500">—</span>}</td></tr>)}</tbody></table>{loading?<p className="py-10 text-center text-sm text-foreground-500">Loading…</p>:!visible.length?<p className="py-10 text-center text-sm text-foreground-500">No submissions match this selection.</p>:null}</div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-500"><span>Showing {filtered.length?Math.min(page,pages)*8-7:0}–{Math.min(page,pages)*8>filtered.length?filtered.length:Math.min(page,pages)*8} of {filtered.length}</span><div className="flex items-center gap-2"><button type="button" className={pagerBtn} disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Previous</button><span>{Math.min(page,pages)} / {pages}</span><button type="button" className={pagerBtn} disabled={page>=pages} onClick={()=>setPage(p=>p+1)}>Next</button></div></div>
        </>}
      </section>
    </div>
    {attemptId?<AttemptDrawer attemptId={attemptId} onClose={()=>setAttemptId(null)} onChanged={()=>void fetchStudents()}/>:null}
  </div>;
}
