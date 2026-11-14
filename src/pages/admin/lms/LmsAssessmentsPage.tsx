import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";


/** LMS assessment-only workspace. Reuses authoritative assessment records and creation dialog. */
export default function LmsAssessmentsPage() {
  const [courses,setCourses] = useState<RtoCourse[]>([]);
  const [units,setUnits] = useState<RtoUnit[]>([]);
  const [unitsLoading,setUnitsLoading] = useState(false);
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
  const [dialogError,setDialogError] = useState("");
  const [notice,setNotice] = useState("");
  const [source,setSource] = useState<"blank"|"upload"|"template">("blank");
  const [fromId,setFromId] = useState("");
  const [uploadText,setUploadText] = useState("");
  const [uploadName,setUploadName] = useState("");
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
  const unitOptions=units.map(u=>({id:u.id??"",label:`${u.code} — ${u.name}${u.isActive===false?" (Inactive)":""}`}));
  useEffect(()=>{setUnitId(old=>unitOptions.some(u=>u.id===old&&!!u.id)?old:unitOptions.find(u=>!!u.id)?.id??"");},[units]);
  const closeCreate=()=>{setCreating(false);setTitle("");setCode("");setDescription("");setSource("blank");setFromId("");setUploadText("");setUploadName("");setDialogError("");};
  const readUpload=async(file:File|undefined)=>{
    setUploadText("");setUploadName("");setDialogError("");
    if(!file)return;
    if(!file.name.toLowerCase().endsWith(".json")){setDialogError("Choose a JSON export from the Assessments editor. PDF, Word and other formats are unsupported.");return;}
    try{
      const text=await file.text();
      const parsed=JSON.parse(text) as {title?:string;code?:string;description?:string;definition?:{tasks?:unknown}};
      if(!Array.isArray(parsed?.definition?.tasks))throw new Error("no definition");
      setUploadText(text);setUploadName(file.name);
      setTitle(t=>t||parsed.title||"");setCode(c=>c||parsed.code||"");setDescription(d=>d||parsed.description||"");
    }catch{setDialogError("That file is not an assessment JSON export. It must contain an assessment definition.");}
  };
  const create=async()=>{
    if(!courseId||!unitId||saving)return;
    if(source==="upload"&&!uploadText)return;
    if(source==="template"&&!fromId)return;
    const name=title.trim()||(source==="template"?templates.find(t=>t.id===fromId)?.title??"":"");
    if(!name)return;
    setSaving(true);setDialogError("");setNotice("");
    try{
      const result=await asmAdmin<{id?:string;ok?:boolean;errors?:{message:string}[]}>("assessment_create",{
        courseId,unitId,title:name,code:code.trim()||null,description,
        fromAssessmentId:source==="template"?fromId:undefined,
        import:source==="upload"?JSON.parse(uploadText):undefined,
      });
      if(result.ok===false)throw new Error(result.errors?.map(e=>e.message).join(" ")||"Unable to create assessment");
      if(!result.id)throw new Error("Assessment creation did not return an ID");
      let message=`"${name}" created as a draft.`;
      if(source!=="blank"){
        const pub=await asmAdmin<{ok:boolean;errors?:{message:string}[]}>("version_publish",{assessmentId:result.id});
        message=pub.ok?`"${name}" created and published. Assign it under Batch Allocation › Assessments.`:`"${name}" created as a draft but not published: ${pub.errors?.map(e=>e.message).join(" ")??""} Open it to fix and publish.`;
      }
      closeCreate();setNotice(message);
      await load();
    }catch(e){setDialogError(e instanceof Error?e.message:"Unable to create assessment");}
    finally{setSaving(false);}
  };
  const templates=useMemo(()=>assessments.filter(a=>a.currentVersionNo!==null&&!a.archivedAt).sort((a,b)=>Number(b.isTemplate)-Number(a.isTemplate)||Number(b.unitId===unitId)-Number(a.unitId===unitId)||a.title.localeCompare(b.title)),[assessments,unitId]);
  const shown=assessments.filter(a=>a.courseId===courseId&&(!unitId||a.unitId===unitId));
  const box="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4";
  const field="w-full rounded-lg border border-background-300 bg-background-50 p-2 text-sm";
  const item=(active:boolean)=>`w-full rounded-lg border px-3 py-3 text-left text-sm ${active?"border-primary-400 bg-primary-50 font-semibold":"border-background-200 hover:bg-background-100"}`;
  return <div className="mx-auto max-w-[1600px] space-y-4 pb-10">
    <header><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p><h1 className="font-heading text-3xl font-bold">Assessments</h1><p className="text-sm text-foreground-600">Choose a course and unit to manage its assessments.</p></header>
    {notice&&<p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}<button type="button" className="ml-3 underline" onClick={()=>setNotice("")}>Dismiss</button></p>}
    {error&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}<button className="ml-3 underline" onClick={()=>void load()}>Retry</button></p>}

    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(240px,1fr)_minmax(420px,2.5fr)]">
      <section className={box}><h2 className="mb-3 font-semibold">1. Course</h2><input aria-label="Search courses" placeholder="Search course…" className={field+" mb-3"} value={search[0]} onChange={e=>setSearch(v=>[e.target.value,v[1]])}/><div className="space-y-2">{courses.filter(c=>c.label.toLowerCase().includes(search[0].toLowerCase())).map(c=><button key={c.id} className={item(courseId===c.id)} onClick={()=>setCourseId(c.id)}>{c.label}</button>)}</div></section>
      <section className={box}><h2 className="mb-3 font-semibold">2. Units</h2><input aria-label="Search units" placeholder="Search unit…" className={field+" mb-3"} value={search[1]} onChange={e=>setSearch(v=>[v[0],e.target.value])}/><div className="space-y-2">{unitOptions.filter(u=>u.label.toLowerCase().includes(search[1].toLowerCase())).map(u=><button type="button" key={u.id} className={item(unitId===u.id)} disabled={!u.id} onClick={()=>setUnitId(u.id)}>{u.label}</button>)}</div>{unitsLoading?<p className="text-sm text-foreground-500">Loading course units…</p>:!unitOptions.length?<p className="text-sm text-foreground-500">No units are assigned to this course.</p>:null}</section>
      <section className={box}><h2 className="mb-3 font-semibold">3. Assessments</h2>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Assessment library</h3><button className="rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white" disabled={!unitId} onClick={()=>setCreating(true)}>+ Add assessment</button></div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[[shown.length,"Assessments"],[shown.filter(a=>a.currentVersionStatus==="published").length,"Published"],[shown.filter(a=>a.currentVersionStatus!=="published").length,"Draft / Other"]].map(([n,label])=><div key={label} className="rounded-lg border border-background-200 p-3"><p className="text-xl font-bold">{n}</p><p className="text-xs text-foreground-500">{label}</p></div>)}</div>
            <div className="overflow-x-auto rounded-lg border border-background-200"><table className="w-full min-w-[460px] text-left text-sm"><thead className="bg-background-100"><tr><th className="p-3">Assessment name</th><th className="p-3">Unit</th><th className="p-3">Status</th><th className="p-3">Action</th></tr></thead><tbody className="divide-y divide-background-100">{shown.map(a=><tr key={a.id}><td className="p-3 font-semibold">{a.title}</td><td className="p-3">{a.unitCode||"Course"}</td><td className="p-3 capitalize">{a.currentVersionStatus||"Draft"}</td><td className="p-3"><Link className="font-semibold text-primary-600 underline" to={`/admin/assessments/${a.id}`}>Open</Link></td></tr>)}</tbody></table></div>
            {!shown.length&&<p className="text-sm text-foreground-500">No assessments for this unit.</p>}
          </div>
      </section>
    </div>
    {creating&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation"><div role="dialog" aria-modal="true" aria-label="Add assessment" className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl bg-background-50 p-6 shadow-xl">
      <h2 className="text-xl font-bold">Add assessment</h2>
      <p className="text-sm text-foreground-600">Course: {courses.find(c=>c.id===courseId)?.label}<br/>Unit: {unitOptions.find(u=>u.id===unitId)?.label}</p>
      <div role="group" aria-label="Start from" className="grid grid-cols-3 gap-1 rounded-lg border border-background-200 p-1">{([["blank","Blank","ri-file-add-line"],["upload","Upload file","ri-upload-2-line"],["template","Use template","ri-file-copy-line"]] as const).map(([v,label,icon])=><button type="button" key={v} aria-pressed={source===v} onClick={()=>{setSource(v);setDialogError("");}} className={"rounded-md px-2 py-2 text-sm "+(source===v?"bg-primary-500 font-semibold text-white":"hover:bg-background-100")}><i className={icon+" mr-1"} aria-hidden="true"/>{label}</button>)}</div>
      {source==="upload"&&<div className="rounded-lg border border-dashed border-background-300 p-3"><label className="block text-sm font-semibold">Assessment file (.json)<input className={field+" mt-1"} type="file" accept=".json,application/json" onChange={e=>{void readUpload(e.currentTarget.files?.[0]);e.currentTarget.value="";}}/></label><p className="mt-2 text-xs text-foreground-600">Use a JSON export from the Assessments editor. Title, code and description are filled from the file.</p>{uploadName&&<p className="mt-2 break-all text-sm" role="status">Selected file · {uploadName}</p>}</div>}
      {source==="template"&&<label className="block text-sm font-semibold">Copy from template or assessment<select className={field+" mt-1"} value={fromId} onChange={e=>{const id=e.target.value;setFromId(id);const t=templates.find(x=>x.id===id);if(t)setTitle(old=>old||t.title);}}><option value="">Select template…</option>{templates.map(t=><option key={t.id} value={t.id}>{t.isTemplate?"[Template] ":""}{t.unitCode?t.unitCode+" — ":""}{t.title} ({t.courseName})</option>)}</select>{!templates.length&&<span className="mt-1 block text-xs font-normal text-foreground-600">No templates or assessments to copy yet.</span>}</label>}
      <label className="block text-sm font-semibold">Assessment title<input className={field+" mt-1"} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Assessment title" autoFocus /></label>
      <label className="block text-sm font-semibold">Code (optional)<input className={field+" mt-1"} value={code} onChange={e=>setCode(e.target.value)} /></label>
      <label className="block text-sm font-semibold">Description<textarea className={field+" mt-1"} value={description} onChange={e=>setDescription(e.target.value)} rows={3}/></label>
      <p className="text-xs text-foreground-600">{source==="blank"?"A blank assessment is created as a draft; add tasks and publish it before assigning.":"The assessment is created under this unit and published, ready to assign to batches."}</p>
      {dialogError&&<p role="alert" className="break-words rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">{dialogError}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="rounded-lg border px-4 py-2" onClick={closeCreate}>Cancel</button><button type="button" className="rounded-lg bg-primary-500 px-4 py-2 font-semibold text-white disabled:opacity-50" disabled={saving||(source==="blank"&&!title.trim())||(source==="upload"&&(!uploadText||!title.trim()))||(source==="template"&&!fromId)} onClick={()=>void create()}>{saving?"Saving…":source==="blank"?"Create assessment":"Create & publish"}</button></div>
    </div></div>}
  </div>;
}
