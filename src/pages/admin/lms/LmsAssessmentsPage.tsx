import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { rto, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";
import { asmAdmin, type AssessmentRow, type AssignmentRow } from "@/pages/admin/lib/assessments";
import { CreateDialog, Submissions } from "@/pages/admin/assessments/AssessmentsPage";

/** Four-column LMS workspace: reuses the existing assessment engine, submissions and outcomes. */
export default function LmsAssessmentsPage() {
  const [courses,setCourses] = useState<RtoCourse[]>([]);
  const [intakes,setIntakes] = useState<RtoIntake[]>([]);
  const [assessments,setAssessments] = useState<AssessmentRow[]>([]);
  const [assignments,setAssignments] = useState<AssignmentRow[]>([]);
  const [courseId,setCourseId] = useState("");
  const [intakeId,setIntakeId] = useState("");
  const [batchId,setBatchId] = useState("");
  const [unitId,setUnitId] = useState("");
  const [assessmentId,setAssessmentId] = useState("");
  const [tab,setTab] = useState<"results"|"assessments"|"reassessments"|"submissions">("results");
  const [search,setSearch] = useState(["","",""]);
  const [creating,setCreating] = useState(false);
  const [error,setError] = useState("");
  const load=useCallback(async()=>{
    try {
      const [c,i,a,as] = await Promise.all([
        rto<RtoCourse[]>("course_list"),rto<RtoIntake[]>("intake_list"),
        asmAdmin<AssessmentRow[]>("assessment_list",{includeArchived:false}),
        asmAdmin<AssignmentRow[]>("assignment_list",{})
      ]);
      setCourses(c);setIntakes(i);setAssessments(a);setAssignments(as);setCourseId(old=>old||c[0]?.id||"");setError("");
    }catch(e){setError(e instanceof Error?e.message:"Unable to load assessment records");}
  },[]);
  useEffect(()=>{void load();},[load]);
  const matchingIntakes=useMemo(()=>intakes.filter(i=>i.courseId===courseId),[intakes,courseId]);
  useEffect(()=>{setIntakeId(old=>matchingIntakes.some(i=>i.id===old)?old:matchingIntakes[0]?.id??"");},[matchingIntakes]);
  const batches=matchingIntakes.find(i=>i.id===intakeId)?.batchList??[];
  useEffect(()=>{setBatchId(old=>batches.some(b=>b.id===old)?old:batches[0]?.id??"");},[intakeId,intakes]);
  const batchAssignments=assignments.filter(a=>a.batchId===batchId);
  const unitOptions=Array.from(new Map(assessments.filter(a=>a.courseId===courseId&&a.unitId).map(a=>[a.unitId!,{id:a.unitId!,label:a.unitCode||a.unitName||"Unit"}])).values());
  useEffect(()=>{setUnitId(old=>unitOptions.some(u=>u.id===old)?old:unitOptions[0]?.id??"");},[courseId,assessments]);
  const shown=assessments.filter(a=>a.courseId===courseId&&(!unitId||a.unitId===unitId));
  useEffect(()=>{setAssessmentId(old=>shown.some(a=>a.id===old)?old:shown[0]?.id??"");},[courseId,unitId,assessments]);
  const selected=assessments.find(a=>a.id===assessmentId);
  const selectedAssignments=batchAssignments.filter(a=>a.assessmentId===assessmentId);
  const box="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4";
  const field="w-full rounded-lg border border-background-300 bg-background-50 p-2 text-sm";
  const item=(active:boolean)=>`w-full rounded-lg border px-3 py-3 text-left text-sm ${active?"border-primary-400 bg-primary-50 font-semibold":"border-background-200 hover:bg-background-100"}`;
  return <div className="mx-auto max-w-[1600px] space-y-4 pb-10">
    <header><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p><h1 className="font-heading text-3xl font-bold">Assessments & Results</h1><p className="text-sm text-foreground-600">Choose course, intake and batch to manage existing assessments and student outcomes.</p></header>
    {error&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}<button className="ml-3 underline" onClick={()=>void load()}>Retry</button></p>}
    {tab === "submissions" ? <div className="mb-3 rounded-xl border border-background-200 p-3"><Submissions /></div> : <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(170px,1fr)_minmax(170px,0.9fr)_minmax(170px,0.9fr)_minmax(400px,2.5fr)]">
      <section className={box}><h2 className="mb-3 font-semibold">1. Course</h2><input aria-label="Search courses" placeholder="Search course…" className={field+" mb-3"} value={search[0]} onChange={e=>setSearch(v=>[e.target.value,v[1],v[2]])}/><div className="space-y-2">{courses.filter(c=>c.label.toLowerCase().includes(search[0].toLowerCase())).map(c=><button key={c.id} className={item(courseId===c.id)} onClick={()=>setCourseId(c.id)}>{c.label}</button>)}</div></section>
      <section className={box}><h2 className="mb-3 font-semibold">2. Intake</h2><input aria-label="Search intakes" placeholder="Search intake…" className={field+" mb-3"} value={search[1]} onChange={e=>setSearch(v=>[v[0],e.target.value,v[2]])}/><div className="space-y-2">{matchingIntakes.filter(i=>i.name.toLowerCase().includes(search[1].toLowerCase())).map(i=><button key={i.id} className={item(intakeId===i.id)} onClick={()=>setIntakeId(i.id)}>{i.name}</button>)}</div></section>
      <section className={box}><h2 className="mb-3 font-semibold">3. Batch</h2><input aria-label="Search batches" placeholder="Search batch…" className={field+" mb-3"} value={search[2]} onChange={e=>setSearch(v=>[v[0],v[1],e.target.value])}/><div className="space-y-2">{batches.filter(b=>b.name.toLowerCase().includes(search[2].toLowerCase())).map(b=><button key={b.id} className={item(batchId===b.id)} onClick={()=>setBatchId(b.id)}>{b.name}</button>)}</div></section>
      <section className={box}><h2 className="mb-3 font-semibold">4. Assessments & Results</h2>
        {!batchId?<p className="text-sm text-foreground-500">Select a batch.</p>:<>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold">Unit<select className={field+" mt-1"} value={unitId} onChange={e=>setUnitId(e.target.value)}><option value="">All units</option>{unitOptions.map(u=><option key={u.id} value={u.id}>{u.label}</option>)}</select></label>
            <label className="text-xs font-semibold">Assessment<select className={field+" mt-1"} value={assessmentId} onChange={e=>setAssessmentId(e.target.value)}><option value="">Select assessment</option>{shown.map(a=><option key={a.id} value={a.id}>{a.title}</option>)}</select></label>
          </div>
          <div className="my-4 grid grid-cols-4 gap-1">{(["results","assessments","submissions","reassessments"] as const).map(t=><button key={t} className={`rounded-lg px-2 py-2 text-xs font-semibold capitalize ${tab===t?"bg-primary-500 text-white":"bg-background-100"}`} onClick={()=>setTab(t)}>{t}</button>)}</div>
          {tab==="assessments"?<div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Assessment library</h3><button className="rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white" onClick={()=>setCreating(true)}>+ New assessment</button></div>
            {shown.map(a=><Link key={a.id} to={`/admin/assessments/${a.id}`} className="block rounded-lg border border-background-200 p-3 hover:bg-background-100"><p className="font-semibold">{a.title}</p><p className="text-xs text-foreground-500">{a.unitCode||"Course assessment"} · {a.currentVersionStatus||"Unpublished"}</p></Link>)}
            {!shown.length&&<p className="text-sm text-foreground-500">No assessments for this unit.</p>}
          </div>:tab==="results"?<div className="space-y-3">
            <h3 className="font-semibold">{selected?.title||"Select an assessment"}</h3>
            <p className="text-sm text-foreground-600">Results are recorded through the existing assessment submissions and competency marking workflow.</p>
            {selectedAssignments.map(a=><div key={a.id} className="rounded-lg border border-background-200 p-3"><p className="font-semibold">{a.assessmentTitle}</p><p className="text-xs text-foreground-500">{a.eligibleCount} eligible · {a.submitted??0} submitted · {a.final??0} final · {a.toMark??0} to mark</p><Link className="mt-2 inline-block text-sm font-semibold text-primary-600 underline" to="/admin/lms/assessments?tab=submissions">Open submissions and marking</Link></div>)}
            {!selectedAssignments.length&&<p className="text-sm text-foreground-500">No assessment assigned to this batch yet.</p>}
            <Link className="inline-block rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white" to="/admin/assessments?tab=outcomes">View competency outcomes</Link>
          </div>:<div className="space-y-3"><h3 className="font-semibold">Reassessments</h3><p className="text-sm text-foreground-600">Use existing assessment attempts and reassessment controls; no duplicate result records are created.</p><Link className="inline-block rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white" to="/admin/assessments?tab=submissions">Open reassessment workflow</Link></div>}
        </>}
      </section>
    </div>}
    {tab === "submissions" ? null : null}
    {creating&&<CreateDialog courses={courses} templates={assessments.filter(a=>a.isTemplate||!!a.currentVersionNo)} onClose={()=>setCreating(false)} onCreated={()=>{setCreating(false);void load();}}/>}
  </div>;
}
