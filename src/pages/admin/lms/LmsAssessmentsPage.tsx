import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";


/** LMS assessment-only workspace. Reuses authoritative assessment records and creation dialog. */
export default function LmsAssessmentsPage() {
  const [courses,setCourses] = useState<RtoCourse[]>([]);
  const [units,setUnits] = useState<RtoUnit[]>([]);
  const [assessments,setAssessments] = useState<AssessmentRow[]>([]);
  const [courseId,setCourseId] = useState("");
  const [unitId,setUnitId] = useState("");
  const [search,setSearch] = useState(["",""]);
  const [creating,setCreating] = useState(false);
  const [title,setTitle] = useState("");
  const [code,setCode] = useState("");
  const [description,setDescription] = useState("");
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState("");
  const load=useCallback(async()=>{
    try {
      const [c,a] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        asmAdmin<AssessmentRow[]>("assessment_list",{includeArchived:false})
      ]);
      setCourses(c);setAssessments(a);setCourseId(old=>old||c[0]?.id||"");setError("");
    }catch(e){setError(e instanceof Error?e.message:"Unable to load assessment records");}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    if(!courseId){setUnits([]);setUnitId("");return;}
    let active=true;
    rto<CourseDetail>("course_get",{courseId}).then(detail=>{if(active)setUnits(detail.units);}).catch(e=>{if(active){setUnits([]);setError(e instanceof Error?e.message:"Unable to load course units");}});
    return ()=>{active=false;};
  },[courseId]);
  const unitOptions=units.filter(u=>u.isActive&&u.id).map(u=>({id:u.id!,label:`${u.code} — ${u.name}`}));
  useEffect(()=>{setUnitId(old=>unitOptions.some(u=>u.id===old)?old:unitOptions[0]?.id??"");},[units]);
  const create=async()=>{
    if(!courseId||!unitId||!title.trim()||saving)return;
    setSaving(true);setError("");
    try{
      const result=await asmAdmin<{id?:string;ok?:boolean;errors?:{message:string}[]}>("assessment_create",{courseId,unitId,title:title.trim(),code:code.trim()||null,description});
      if(result.ok===false)throw new Error(result.errors?.map(e=>e.message).join(" ")||"Unable to create assessment");
      if(!result.id)throw new Error("Assessment creation did not return an ID");
      setCreating(false);setTitle("");setCode("");setDescription("");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Unable to create assessment");}
    finally{setSaving(false);}
  };
  const shown=assessments.filter(a=>a.courseId===courseId&&(!unitId||a.unitId===unitId));
  const box="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4";
  const field="w-full rounded-lg border border-background-300 bg-background-50 p-2 text-sm";
  const item=(active:boolean)=>`w-full rounded-lg border px-3 py-3 text-left text-sm ${active?"border-primary-400 bg-primary-50 font-semibold":"border-background-200 hover:bg-background-100"}`;
  return <div className="mx-auto max-w-[1600px] space-y-4 pb-10">
    <header><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p><h1 className="font-heading text-3xl font-bold">Assessments</h1><p className="text-sm text-foreground-600">Choose a course and unit to manage its assessments.</p></header>
    {error&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}<button className="ml-3 underline" onClick={()=>void load()}>Retry</button></p>}

    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(240px,1fr)_minmax(420px,2.5fr)]">
      <section className={box}><h2 className="mb-3 font-semibold">1. Course</h2><input aria-label="Search courses" placeholder="Search course…" className={field+" mb-3"} value={search[0]} onChange={e=>setSearch(v=>[e.target.value,v[1]])}/><div className="space-y-2">{courses.filter(c=>c.label.toLowerCase().includes(search[0].toLowerCase())).map(c=><button key={c.id} className={item(courseId===c.id)} onClick={()=>setCourseId(c.id)}>{c.label}</button>)}</div></section>
      <section className={box}><h2 className="mb-3 font-semibold">2. Units</h2><input aria-label="Search units" placeholder="Search unit…" className={field+" mb-3"} value={search[1]} onChange={e=>setSearch(v=>[v[0],e.target.value])}/><div className="space-y-2">{unitOptions.filter(u=>u.label.toLowerCase().includes(search[1].toLowerCase())).map(u=><button type="button" key={u.id} className={item(unitId===u.id)} onClick={()=>setUnitId(u.id)}>{u.label}</button>)}</div>{!unitOptions.length?<p className="text-sm text-foreground-500">No active units found for this course.</p>:null}</section>
      <section className={box}><h2 className="mb-3 font-semibold">3. Assessments</h2>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Assessment library</h3><button className="rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white" disabled={!unitId} onClick={()=>setCreating(true)}>+ Add assessment</button></div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[[shown.length,"Assessments"],[shown.filter(a=>a.currentVersionStatus==="published").length,"Published"],[shown.filter(a=>a.currentVersionStatus!=="published").length,"Draft / Other"]].map(([n,label])=><div key={label} className="rounded-lg border border-background-200 p-3"><p className="text-xl font-bold">{n}</p><p className="text-xs text-foreground-500">{label}</p></div>)}</div>
            <div className="overflow-x-auto rounded-lg border border-background-200"><table className="w-full min-w-[460px] text-left text-sm"><thead className="bg-background-100"><tr><th className="p-3">Assessment name</th><th className="p-3">Unit</th><th className="p-3">Status</th><th className="p-3">Action</th></tr></thead><tbody className="divide-y divide-background-100">{shown.map(a=><tr key={a.id}><td className="p-3 font-semibold">{a.title}</td><td className="p-3">{a.unitCode||"Course"}</td><td className="p-3 capitalize">{a.currentVersionStatus||"Draft"}</td><td className="p-3"><Link className="font-semibold text-primary-600 underline" to={`/admin/assessments/${a.id}`}>Open</Link></td></tr>)}</tbody></table></div>
            {!shown.length&&<p className="text-sm text-foreground-500">No assessments for this unit.</p>}
          </div>
      </section>
    </div>
    {creating&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation"><div role="dialog" aria-modal="true" aria-label="Add assessment" className="w-full max-w-lg space-y-4 rounded-xl bg-background-50 p-6 shadow-xl"><h2 className="text-xl font-bold">Add assessment</h2><p className="text-sm text-foreground-600">Course: {courses.find(c=>c.id===courseId)?.label}<br/>Unit: {unitOptions.find(u=>u.id===unitId)?.label}</p><label className="block text-sm font-semibold">Assessment title<input className={field+" mt-1"} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Assessment title" autoFocus /></label><label className="block text-sm font-semibold">Code (optional)<input className={field+" mt-1"} value={code} onChange={e=>setCode(e.target.value)} /></label><label className="block text-sm font-semibold">Description<textarea className={field+" mt-1"} value={description} onChange={e=>setDescription(e.target.value)} rows={3}/></label><div className="flex justify-end gap-2"><button type="button" className="rounded-lg border px-4 py-2" onClick={()=>setCreating(false)}>Cancel</button><button type="button" className="rounded-lg bg-primary-500 px-4 py-2 font-semibold text-white disabled:opacity-50" disabled={saving||!title.trim()} onClick={()=>void create()}>{saving?"Saving…":"Create assessment"}</button></div></div></div>}
  </div>;
}
