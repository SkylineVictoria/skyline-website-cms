import { useCallback, useEffect, useMemo, useState } from "react";
import { rto, type RtoCourse, type CourseDetail, type RtoIntake, type RtoUnit } from "@/pages/admin/lib/rto";
import { asmAdmin, type AssessmentRow, type AssignmentRow, type AssignmentStudent } from "@/pages/admin/lib/assessments";
import { fromLocalInput, toLocalInput } from "@/lib/assessment/api";
import { AssignmentDrawer } from "@/pages/admin/assessments/panels/AssignmentsPanel";
import AttemptDrawer from "@/pages/admin/assessments/panels/AttemptDrawer";

/** Assessment definitions belong to course units; allocations reference existing batches. */
export default function LmsAssessmentAllocationPage() {
  const [courses,setCourses]=useState<RtoCourse[]>([]);
  const [intakes,setIntakes]=useState<RtoIntake[]>([]);
  const [assessments,setAssessments]=useState<AssessmentRow[]>([]);
  const [assignments,setAssignments]=useState<AssignmentRow[]>([]);
  const [units,setUnits]=useState<RtoUnit[]>([]);
  const [courseId,setCourseId]=useState("");
  const [intakeId,setIntakeId]=useState("");
  const [batchId,setBatchId]=useState("");
  const [unitId,setUnitId]=useState("");
  const [assessmentId,setAssessmentId]=useState("");
  const [search,setSearch]=useState("");
  const [studentSearch,setStudentSearch]=useState("");
  const [students,setStudents]=useState<AssignmentStudent[]>([]);
  const [availableFrom,setAvailableFrom]=useState(toLocalInput(new Date().toISOString()));
  const [dueAt,setDueAt]=useState(toLocalInput(new Date(Date.now()+14*86400000).toISOString()));
  const [lateUntil,setLateUntil]=useState("");
  const [notes,setNotes]=useState("");
  const [saving,setSaving]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [editing,setEditing]=useState<AssignmentRow|null>(null);
  const [attempt,setAttempt]=useState<string|null>(null);
  const load=useCallback(async()=>{
    try{
      const [c,i,a,x]=await Promise.all([rto<RtoCourse[]>("course_list"),rto<RtoIntake[]>("intake_list"),asmAdmin<AssessmentRow[]>("assessment_list",{includeArchived:false}),asmAdmin<AssignmentRow[]>("assignment_list",{})]);
      setCourses(c);setIntakes(i);setAssessments(a);setAssignments(x);setCourseId(old=>c.some(v=>v.id===old)?old:c[0]?.id??"");setError("");
    }catch(e){setError(e instanceof Error?e.message:"Unable to load allocation records");}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{let active=true;if(!courseId){setUnits([]);return;}rto<CourseDetail>("course_get",{courseId}).then(d=>{if(active)setUnits(d.units??[]);}).catch(e=>{if(active)setError(e instanceof Error?e.message:"Unable to load units");});return()=>{active=false;};},[courseId]);
  const matchingIntakes=useMemo(()=>intakes.filter(i=>i.courseId===courseId),[intakes,courseId]);
  useEffect(()=>setIntakeId(old=>matchingIntakes.some(i=>i.id===old)?old:matchingIntakes[0]?.id??""),[matchingIntakes]);
  const batches=matchingIntakes.find(i=>i.id===intakeId)?.batchList??[];
  useEffect(()=>setBatchId(old=>batches.some(b=>b.id===old)?old:batches[0]?.id??""),[intakeId,intakes]);
  const unitOptions=units.filter(u=>!!u.id);
  useEffect(()=>setUnitId(old=>unitOptions.some(u=>u.id===old)?old:unitOptions[0]?.id??""),[units]);
  const available=assessments.filter(a=>a.courseId===courseId&&a.unitId===unitId);
  useEffect(()=>setAssessmentId(old=>available.some(a=>a.id===old)?old:available[0]?.id??""),[unitId,assessments]);
  const chosen=available.find(a=>a.id===assessmentId);
  const existing=assignments.find(a=>a.assessmentId===assessmentId&&a.batchId===batchId&&a.status!=="cancelled");
  useEffect(()=>{let active=true;setStudents([]);if(!existing)return;setLoading(true);asmAdmin<AssignmentStudent[]>("assignment_students",{id:existing.id}).then(v=>{if(active)setStudents(v);}).catch(e=>{if(active)setError(e instanceof Error?e.message:"Unable to load assigned students");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[existing?.id]);
  const shownStudents=students.filter(s=>s.name.toLowerCase().includes(studentSearch.toLowerCase())||s.email.toLowerCase().includes(studentSearch.toLowerCase()));
  const allocate=async()=>{
    if(!chosen||!batchId||!dueAt||saving)return;
    setSaving(true);setError("");
    try{
      const out=await asmAdmin<{created:number;errors?:{message:string}[]}>("assignment_create",{assessmentId:chosen.id,batchIds:[batchId],availableFrom:fromLocalInput(availableFrom),dueAt:fromLocalInput(dueAt),lateUntil:fromLocalInput(lateUntil),notes});
      if(out.errors?.length)throw new Error(out.errors.map(e=>e.message).join(" "));
      if(!out.created)throw new Error("No allocation was created. Ensure this assessment has a published version.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Unable to allocate assessment");}
    finally{setSaving(false);}
  };
  const field="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  const panel="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4";
  return <div className="mx-auto max-w-[1750px] space-y-4 pb-10">
    <header><p className="text-xs uppercase tracking-wide text-foreground-500">LMS</p><h1 className="font-heading text-3xl font-bold">Assessment Allocation</h1><p className="text-sm text-foreground-600">Choose a course, intake and batch, then allocate a published unit assessment to its students.</p></header>
    {error?<div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}<button type="button" className="ml-3 underline" onClick={()=>void load()}>Retry</button></div>:null}
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(210px,1fr)_minmax(250px,1.15fr)_minmax(460px,2.3fr)]">
      <section className={panel}><h2 className="mb-4 text-lg font-bold">1. Select Context</h2><div className="space-y-4"><label className="block text-sm font-semibold">Course<select className={field+" mt-1"} value={courseId} onChange={e=>setCourseId(e.target.value)}>{courses.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label><label className="block text-sm font-semibold">Intake<select className={field+" mt-1"} value={intakeId} onChange={e=>setIntakeId(e.target.value)}>{matchingIntakes.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label><label className="block text-sm font-semibold">Batch<select className={field+" mt-1"} value={batchId} onChange={e=>setBatchId(e.target.value)}>{batches.map(b=><option key={b.id} value={b.id}>{b.name} ({b.enrolled} students)</option>)}</select></label></div></section>
      <section className={panel}><h2 className="mb-4 text-lg font-bold">2. Select Unit & Assessment</h2><input className={field+" mb-3"} placeholder="Search unit or assessment…" aria-label="Search units and assessments" value={search} onChange={e=>setSearch(e.target.value)}/><div className="max-h-[650px] space-y-2 overflow-y-auto">{unitOptions.filter(u=>(u.code+" "+u.name+" "+assessments.filter(a=>a.unitId===u.id).map(a=>a.title).join(" ")).toLowerCase().includes(search.toLowerCase())).map(u=><div key={u.id} className="rounded-lg border border-background-200 p-2"><button type="button" onClick={()=>setUnitId(u.id!)} className={"w-full rounded-lg px-2 py-2 text-left text-sm font-semibold "+(unitId===u.id?"bg-primary-50 text-primary-700":"hover:bg-background-100")}>{u.code} — {u.name}<span className="ml-2 text-xs font-normal">{assessments.filter(a=>a.unitId===u.id&&a.courseId===courseId).length} assessments</span></button>{unitId===u.id?<div className="mt-2 space-y-1 pl-2">{available.map(a=><button type="button" key={a.id} onClick={()=>setAssessmentId(a.id)} className={"block w-full rounded-md border p-2 text-left text-sm "+(assessmentId===a.id?"border-primary-400 bg-primary-50":"border-background-200")}>{assessmentId===a.id?"◉ ":"○ "}{a.title}<span className="block pl-4 text-xs text-foreground-500">{a.currentVersionStatus??"Draft"}</span></button>)}{!available.length?<p className="p-2 text-xs text-foreground-500">No assessments for this unit.</p>:null}</div>:null}</div>)}{!unitOptions.length?<p className="text-sm text-foreground-500">No units found for this course.</p>:null}</div></section>
      <section className={panel}><h2 className="mb-4 text-lg font-bold">3. Allocate Assessment</h2>{!chosen?<p className="text-sm text-foreground-500">Select an assessment from a unit.</p>:<div className="space-y-4"><div className="rounded-lg bg-primary-50 p-3"><p className="font-semibold">{chosen.title}</p><p className="text-xs text-foreground-600">{unitOptions.find(u=>u.id===unitId)?.code} · {courses.find(c=>c.id===courseId)?.label}</p></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[[existing?.eligibleCount??0,"Students"],[existing?.submitted??0,"Submitted"],[existing?.toMark??0,"To mark"],[existing?.final??0,"Final"]].map(([n,label])=><div key={label} className="rounded-lg border border-background-200 p-3"><p className="text-xl font-bold">{n}</p><p className="text-xs text-foreground-500">{label}</p></div>)}</div>{existing?<><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">Allocated to {existing.batchName}</span><button type="button" className="rounded-lg border border-primary-400 px-3 py-2 text-sm text-primary-600" onClick={()=>setEditing(existing)}>Edit allocation & students</button></div><input className={field} placeholder="Search student…" aria-label="Search students" value={studentSearch} onChange={e=>setStudentSearch(e.target.value)}/><div className="overflow-x-auto rounded-lg border border-background-200"><table className="w-full text-left text-sm"><thead className="bg-background-100"><tr><th className="p-2">Student</th><th className="p-2">Status</th><th className="p-2">Attempt</th><th className="p-2">Due date</th></tr></thead><tbody>{shownStudents.map(s=><tr key={s.studentId} className="border-t border-background-100"><td className="p-2">{s.name}</td><td className="p-2">{s.excluded?"Excluded":s.attempts.length?"Allocated":"Eligible"}</td><td className="p-2">{s.attempts.at(-1)?.attemptNo??"—"}</td><td className="p-2">{s.dueAt?new Date(s.dueAt).toLocaleDateString():"—"}</td></tr>)}</tbody></table>{loading?<p className="p-3 text-sm">Loading students…</p>:null}</div><button type="button" className="rounded-lg bg-primary-500 px-4 py-2 font-semibold text-white" onClick={()=>setEditing(existing)}>Manage allocation</button></>:<><p className="text-sm text-foreground-600">Not yet allocated to this batch. Allocation includes eligible students enrolled in the batch; individual exceptions can be managed afterwards.</p><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Available from<input className={field+" mt-1"} type="datetime-local" value={availableFrom} onChange={e=>setAvailableFrom(e.target.value)}/></label><label className="text-sm font-semibold">Due date<input className={field+" mt-1"} type="datetime-local" value={dueAt} onChange={e=>setDueAt(e.target.value)}/></label><label className="text-sm font-semibold">Late until (optional)<input className={field+" mt-1"} type="datetime-local" value={lateUntil} onChange={e=>setLateUntil(e.target.value)}/></label></div><label className="block text-sm font-semibold">Student instructions<textarea className={field+" mt-1"} rows={3} value={notes} onChange={e=>setNotes(e.target.value)}/></label>{chosen.currentVersionStatus!=="published"?<p className="text-sm text-amber-700">Publish this assessment before allocation.</p>:null}<div className="flex justify-end gap-2"><button type="button" className="rounded-lg border px-4 py-2" onClick={()=>setNotes("")}>Clear notes</button><button type="button" className="rounded-lg bg-primary-500 px-4 py-2 font-semibold text-white disabled:opacity-50" disabled={saving||!batchId||!dueAt||chosen.currentVersionStatus!=="published"} onClick={()=>void allocate()}>{saving?"Allocating…":"Save Allocation"}</button></div></>}</div>}</section>
    </div>
    {editing?<AssignmentDrawer assignment={editing} onClose={()=>setEditing(null)} onChanged={()=>{void load();setEditing(null);}} onOpenAttempt={id=>setAttempt(id)}/>:null}
    {attempt?<AttemptDrawer attemptId={attempt} onClose={()=>setAttempt(null)} onChanged={()=>void load()}/>:null}
  </div>;
}
