import { useCallback, useEffect, useMemo, useState } from "react";
import ListPane from "@/pages/admin/components/ListPane";
import { useListPane } from "@/pages/admin/lib/listPane";
import { Link } from "react-router-dom";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";


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
        message=pub.ok?`"${name}" created and published. Open it to assign it to intakes.`:`"${name}" created as a draft but not published: ${pub.errors?.map(e=>e.message).join(" ")??""} Open it to fix and publish.`;
      }
      closeCreate();setNotice(message);
      await load();
    }catch(e){setDialogError(e instanceof Error?e.message:"Unable to create assessment");}
    finally{setSaving(false);}
  };
  const templates=useMemo(()=>assessments.filter(a=>a.currentVersionNo!==null&&!a.archivedAt).sort((a,b)=>Number(b.isTemplate)-Number(a.isTemplate)||Number(b.unitId===unitId)-Number(a.unitId===unitId)||a.title.localeCompare(b.title)),[assessments,unitId]);
  const shown=assessments.filter(a=>a.courseId===courseId&&(!unitId||a.unitId===unitId));
  const card="rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  const field="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
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
    {creating&&<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation"><div role="dialog" aria-modal="true" aria-label="Add assessment" className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl border border-background-200 bg-background-50 p-5 shadow-xl">
      <h2 className="font-heading text-xl font-bold text-foreground-950">Add assessment</h2>
      <p className="text-sm text-foreground-500">{courses.find(c=>c.id===courseId)?.label}<br/>{unitOptions.find(u=>u.id===unitId)?.label}</p>
      <div role="group" aria-label="Start from" className="grid grid-cols-3 gap-1 rounded-lg border border-background-200 p-1">{([["blank","Blank","ri-file-add-line"],["upload","Upload file","ri-upload-2-line"],["template","Use template","ri-file-copy-line"]] as const).map(([v,label,icon])=><button type="button" key={v} aria-pressed={source===v} onClick={()=>{setSource(v);setDialogError("");}} className={"rounded-md px-2 py-1.5 text-sm font-semibold "+(source===v?"bg-primary-600 text-white":"text-foreground-700 hover:bg-background-100")}><i className={icon+" mr-1"} aria-hidden="true"/>{label}</button>)}</div>
      {source==="upload"&&<div><label className="block text-sm font-semibold">Assessment file (.json)<input className={field+" mt-1"} type="file" accept=".json,application/json" onChange={e=>{void readUpload(e.currentTarget.files?.[0]);e.currentTarget.value="";}}/></label><p className="mt-1 text-xs text-foreground-500">A JSON export from the Assessments editor.</p>{uploadName&&<p className="mt-2 break-all text-sm" role="status">Selected file · {uploadName}</p>}</div>}
      {source==="template"&&<label className="block text-sm font-semibold">Copy from template or assessment<select className={field+" mt-1"} value={fromId} onChange={e=>{const id=e.target.value;setFromId(id);const t=templates.find(x=>x.id===id);if(t)setTitle(old=>old||t.title);}}><option value="">Select template…</option>{templates.map(t=><option key={t.id} value={t.id}>{t.isTemplate?"[Template] ":""}{t.unitCode?t.unitCode+" — ":""}{t.title} ({t.courseName})</option>)}</select>{!templates.length&&<span className="mt-1 block text-xs font-normal text-foreground-600">No templates or assessments to copy yet.</span>}</label>}
      <label className="block text-sm font-semibold">Assessment title<input className={field+" mt-1"} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Assessment title" autoFocus /></label>
      <label className="block text-sm font-semibold">Code (optional)<input className={field+" mt-1"} value={code} onChange={e=>setCode(e.target.value)} /></label>
      <label className="block text-sm font-semibold">Description<textarea className={field+" mt-1"} value={description} onChange={e=>setDescription(e.target.value)} rows={3}/></label>
      <p className="text-xs text-foreground-500">{source==="blank"?"A blank assessment is created as a draft; add tasks and publish it before assigning.":"The assessment is created under this unit and published, ready to assign to intakes."}</p>
      {dialogError&&<p role="alert" className="break-words rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{dialogError}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100" onClick={closeCreate}>Cancel</button><button type="button" className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50" disabled={saving||(source==="blank"&&!title.trim())||(source==="upload"&&(!uploadText||!title.trim()))||(source==="template"&&!fromId)} onClick={()=>void create()}>{saving?"Saving…":source==="blank"?"Create assessment":"Create & publish"}</button></div>
    </div></div>}
  </div>;
}
