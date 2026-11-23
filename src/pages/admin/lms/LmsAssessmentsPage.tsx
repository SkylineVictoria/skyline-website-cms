import { useCallback, useEffect, useMemo, useState } from "react";
import ListPane from "@/pages/admin/components/ListPane";
import { useListPane } from "@/pages/admin/lib/listPane";
import { Link, useNavigate } from "react-router-dom";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";
import AssessmentWizard from "@/pages/admin/assessments/AssessmentWizard";


/** LMS assessment-only workspace. Reuses authoritative assessment records and creation dialog. */
export default function LmsAssessmentsPage() {
  const pane = useListPane("assessments");
  const [courses,setCourses] = useState<RtoCourse[]>([]);
  const [units,setUnits] = useState<RtoUnit[]>([]);
  const [unitsLoading,setUnitsLoading] = useState(false);
  const [assessments,setAssessments] = useState<AssessmentRow[]>([]);
  const [courseId,setCourseId] = useState("");
  const [unitId,setUnitId] = useState("");
  const [search,setSearch] = useState(["",""]);
  const [creating,setCreating] = useState(false);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const navigate = useNavigate();
  const load=useCallback(async()=>{
    try {
      const [c,a] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        asmAdmin<AssessmentRow[]>("assessment_list",{includeArchived:false})
      ]);
      setCourses(c);setAssessments(a);setCourseId(old=>c.some(x=>x.id===old)?old:c[0]?.id??"");setError("");
    }catch(e){setError(e instanceof Error?e.message:"Unable to load assessment records");}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    if(!courseId){setUnits([]);setUnitId("");return;}
    let active=true;
    setUnitsLoading(true);setUnits([]);setSearch(v=>[v[0],""]);
    rto<CourseDetail>("course_get",{courseId}).then(detail=>{if(active){setUnits(detail.units??[]);setError("");}}).catch(e=>{if(active){setUnits([]);setError(e instanceof Error?e.message:"Unable to load course units");}}).finally(()=>{if(active)setUnitsLoading(false);});
    return ()=>{active=false;};
  },[courseId]);
  const unitOptions=useMemo(()=>units.map(u=>({id:u.id??"",label:`${u.code} — ${u.name}${u.isActive===false?" (Inactive)":""}`})),[units]);
  useEffect(()=>{setUnitId(old=>unitOptions.some(u=>u.id===old&&!!u.id)?old:unitOptions.find(u=>!!u.id)?.id??"");},[unitOptions]);
  const shown=assessments.filter(a=>a.courseId===courseId&&(!unitId||a.unitId===unitId));
  const card="rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  const searchField="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm";
  const sectionTitle="text-xs font-semibold uppercase tracking-wide text-foreground-500";
  const row=(active:boolean)=>"flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-50 "+(active?"bg-primary-50 ring-1 ring-primary-300":"hover:bg-background-100");
  const dot=(active:boolean)=><span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full "+(active?"bg-green-500":"bg-background-300")} title={active?"Active":"Inactive"}/>;
  const statusBadge=(s:string|null|undefined)=>"rounded-full px-2 py-0.5 text-xs font-semibold capitalize "+(s==="published"?"bg-green-100 text-green-800":!s||s==="draft"?"bg-background-200 text-foreground-600":"bg-amber-100 text-amber-800");
  const th="px-3 py-2";
  const selectedCourse=courses.find(c=>c.id===courseId);
  const selectedUnit=units[unitOptions.findIndex(u=>u.id===unitId)];
  const published=shown.filter(a=>a.currentVersionStatus==="published").length;
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="font-heading text-2xl font-bold text-foreground-950">Assessments</h1><p className="text-sm text-foreground-500">Assessments by course and unit.</p></div>
      <button type="button" className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50" disabled={!unitId} onClick={()=>setCreating(true)}>+ Add assessment</button>
    </header>
    {notice&&<p role="status" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{notice}<button type="button" className="ml-3 underline" onClick={()=>setNotice("")}>Dismiss</button></p>}
    {error&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}<button className="ml-3 underline" onClick={()=>void load()}>Retry</button></p>}

    <div className={"grid items-start gap-5 " + pane.grid}>
      <ListPane pane={pane} label="Courses and units">
      <div className="min-w-0 space-y-5">
        <section className={card+" p-3"}>
          <h2 className={sectionTitle+" mb-2 px-1"}>Course</h2>
          <label className="relative block"><i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true"/><input aria-label="Search courses" placeholder="Search course…" className={searchField} value={search[0]} onChange={e=>setSearch(v=>[e.target.value,v[1]])}/></label>
          <div className="mt-3 max-h-[40vh] space-y-1 overflow-auto">{courses.filter(c=>c.label.toLowerCase().includes(search[0].toLowerCase())).map(c=><button key={c.id} className={row(courseId===c.id)} onClick={()=>setCourseId(c.id)}>{dot(c.isActive)}<span className="min-w-0"><span className="block text-sm font-semibold text-foreground-950">{c.code}</span><span className="block truncate text-xs text-foreground-600">{c.name}{c.variantLabel?` (${c.variantLabel})`:""}</span></span></button>)}</div>
        </section>
        <section className={card+" p-3"}>
          <h2 className={sectionTitle+" mb-2 px-1"}>Unit</h2>
          <label className="relative block"><i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true"/><input aria-label="Search units" placeholder="Search unit…" className={searchField} value={search[1]} onChange={e=>setSearch(v=>[v[0],e.target.value])}/></label>
          <div className="mt-3 max-h-[40vh] space-y-1 overflow-auto">{unitOptions.map((u,i)=>({...u,unit:units[i]})).filter(u=>u.label.toLowerCase().includes(search[1].toLowerCase())).map(u=><button type="button" key={u.id} className={row(unitId===u.id)} disabled={!u.id} onClick={()=>setUnitId(u.id)}>{dot(u.unit?.isActive!==false)}<span className="min-w-0"><span className="block text-sm font-semibold text-foreground-950">{u.unit?.code}</span><span className="block truncate text-xs text-foreground-600">{u.unit?.name}</span></span></button>)}</div>
          {unitsLoading?<p className="py-6 text-center text-sm text-foreground-500">Loading…</p>:!unitOptions.length?<p className="py-6 text-center text-sm text-foreground-500">No units in this course.</p>:null}
        </section>
      </div>
      </ListPane>
      <section className={card+" min-w-0 p-5"}>
        <div className="min-w-0">
          <p className={sectionTitle}>{selectedCourse?.code??"Assessment library"}</p>
          <h2 className="font-heading text-xl font-bold text-foreground-950">{selectedUnit?`${selectedUnit.code} — ${selectedUnit.name}`:"Select a unit"}</h2>
        </div>
        <dl className="mt-4 grid grid-cols-3 rounded-lg border border-background-200 sm:divide-x sm:divide-background-200">
          {([["Assessments",shown.length],["Published",published],["Draft / Other",shown.length-published]] as [string,number][]).map(([label,n])=><div key={label} className="px-3 py-2"><dt className="text-xs text-foreground-500">{label}</dt><dd className="text-sm font-semibold text-foreground-950">{n}</dd></div>)}
        </dl>
        {shown.length?<div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500"><th className={th}>Assessment name</th><th className={th}>Unit</th><th className={th}>Status</th><th className={th}>Action</th></tr></thead><tbody>{shown.map(a=><tr key={a.id} className="border-b border-background-100 hover:bg-background-100"><td className={th+" font-semibold text-foreground-950"}>{a.title}</td><td className={th}>{a.unitCode||"Course"}</td><td className={th}><span className={statusBadge(a.currentVersionStatus)}>{a.currentVersionStatus||"Draft"}</span></td><td className={th}><Link className="font-semibold text-primary-700 hover:underline" to={`/admin/assessments/${a.id}`}>Open</Link></td></tr>)}</tbody></table></div>
        :<p className="py-10 text-center text-sm text-foreground-500">No assessments for this unit.</p>}
      </section>
    </div>
    {creating&&<AssessmentWizard courses={courses} pageCourseId={courseId} pageUnitId={unitId} pageUnits={units} onClose={()=>setCreating(false)} onSaved={(id)=>{setCreating(false);navigate(`/admin/assessments/${id}`);}}/>}
  </div>;
}
