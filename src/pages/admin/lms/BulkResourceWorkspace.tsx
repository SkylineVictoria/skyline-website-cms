import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { accessLabels, bulkAdmin, bulkBucket, categories, categoryLabel, downloadResource,
  type Audience, type BulkPolicy, type Category, type CourseOption, type ImportFile, type ImportJob,
  type UnitOption } from "@/pages/admin/lib/bulkResources";

type Decision = { unit: string; category: Category; audience: Audience; reviewed?: boolean; previousId?: string; skipExisting?: boolean };
type Filter = "all" | "ready" | "low" | "unmatched" | "duplicates" | "restricted" | "failed";
const control = "rounded-lg border border-background-300 bg-background-50 px-2.5 py-1.5 text-sm";
const button = "rounded-lg border border-background-300 bg-background-50 px-3 py-1.5 text-sm font-semibold disabled:opacity-50";
const mobileCell = "p-2 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-2 max-sm:before:text-xs max-sm:before:font-semibold max-sm:before:text-foreground-600 max-sm:before:content-[attr(data-column)]";
const primary = "rounded-lg bg-primary-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50";
const stateLabel: Record<ImportFile["state"], string> = {
  uploading: "Awaiting upload", queued: "Queued", processing: "Analysing", extracted: "Extracted",
  review: "Review", failed: "Failed", excluded: "Excluded", imported: "Approved",
};
const filters: [Filter, string][] = [["all", "All files"], ["ready", "Ready"], ["low", "Low confidence"],
  ["unmatched", "Unmatched"], ["duplicates", "Duplicates & versions"], ["restricted", "Restricted"], ["failed", "Failed"]];
const errorMessage = (e: unknown) => e instanceof Error ? e.message : "The request could not be completed.";
const relativePath = (file: File) => file.webkitRelativePath || file.name;
const restricted = (file: ImportFile) => !!file.result && (file.result.confidentiality !== "student_safe" || file.result.category === "assessor");
const low = (file: ImportFile, policy: BulkPolicy | null) => !!file.result && (!policy || file.result.confidence < policy.confidence);
const matched = (file: ImportFile, courses: CourseOption[]) => {
  const matches = file.matches ?? [];
  const courseCode = file.result?.courseCode?.toUpperCase();
  if (!courseCode) return matches;
  return matches.filter(u => courses.find(c => c.id === u.course_id)?.code.toUpperCase() === courseCode);
};

function suggested(file: ImportFile, courses: CourseOption[], policy: BulkPolicy | null): Decision {
  const matches = matched(file, courses);
  const unit = matches.length === 1 ? matches[0].id : "";
  return { unit, category: file.result?.category ?? "learning",
    audience: restricted(file) ? "assessor" : policy?.default_audience ?? "staff",
    skipExisting: policy?.duplicates === "skip_identical" && file.related?.some(r => r.identical && r.unit_id === unit) };
}

export default function BulkResourceWorkspace({ courses: initialCourses, units: initialUnits, unitHint, onClose }: {
  courses: CourseOption[]; units: UnitOption[]; unitHint?: string; onClose: () => void;
}) {
  const [catalogue, setCatalogue] = useState<{ courses: CourseOption[]; units: UnitOption[] } | null>(null);
  const courses = catalogue?.courses ?? initialCourses;
  const units = catalogue?.units ?? initialUnits;
  const [policy, setPolicy] = useState<BulkPolicy | null>(null);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [job, setJob] = useState("");
  const [course, setCourse] = useState(() => units.find(u => u.id === unitHint)?.course_id ?? "");
  const [hint, setHint] = useState(unitHint ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<ImportFile[]>([]);
  const [override, setOverride] = useState<Record<string, Decision>>({});
  const [selection, setSelection] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [displayCourse, setDisplayCourse] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ url: string; name: string; format: string } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const loadJobs = useCallback(async () => setJobs(await bulkAdmin<ImportJob[]>("list")), []);
  const refresh = useCallback(async () => {
    if (!job) return;
    setRows(await bulkAdmin<ImportFile[]>("detail", { job }));
  }, [job]);

  useEffect(() => {
    void bulkAdmin<{ courses: CourseOption[]; units: UnitOption[] }>("catalogue").then(setCatalogue).catch(e => setError(errorMessage(e)));
    void bulkAdmin<BulkPolicy>("policy").then(setPolicy).catch(e => setError(errorMessage(e)));
    void loadJobs().catch(e => setError(errorMessage(e)));
  }, [loadJobs]);
  useEffect(() => {
    let active = true;
    const tick = async () => {
      if (!job) return;
      try {
        const result = await bulkAdmin<ImportFile[]>("detail", { job });
        if (active) setRows(result);
      } catch (e) {
        if (active) setError(errorMessage(e));
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 4500);
    return () => { active = false; window.clearInterval(timer); };
  }, [job]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const addFiles = (incoming: FileList | File[]) => setFiles(old => {
    const existing = new Set(old.map(file => relativePath(file) + ":" + file.size + ":" + file.lastModified));
    return [...old, ...Array.from(incoming).filter(file => !existing.has(relativePath(file) + ":" + file.size + ":" + file.lastModified))];
  });
  const showJob = (id: string) => {
    setRows([]); setJob(id); setSelection([]); setOverride({}); setDisplayCourse({}); setRowErrors({}); setFilter("all");
  };
  const hasPendingUpload = rows.some(r => r.state === "uploading");
  const upload = async (resume: boolean) => {
    if (!policy || !files.length) return;
    setBusy(true); setError(""); setUploadErrors([]);
    try {
      let id = job;
      let assignments: { row: ImportFile; file: File }[];
      if (resume) {
        assignments = rows.filter(r => r.state === "uploading").flatMap(row => {
          const file = files.find(f => relativePath(f) === row.source_path && f.size === row.bytes);
          return file ? [{ row, file }] : [];
        });
        if (!assignments.length) throw new Error("Choose the original files or folder to continue this import.");
      } else {
        const valid = files.filter(file => {
          const ext = file.name.split(".").at(-1)?.toLowerCase() ?? "";
          return policy.formats.includes(ext) && file.size > 0 && file.size <= policy.max_mib * 1048576;
        });
        setUploadErrors(files.filter(file => !valid.includes(file)).map(file => `${file.name} · File type or size is outside the upload policy.`));
        if (!valid.length) throw new Error("Choose at least one file that meets the upload policy.");
        const result = await bulkAdmin<{ id: string; files: ImportFile[] }>("begin", {
          unit: hint, files: valid.map(f => ({ name: f.name, path: relativePath(f), bytes: f.size })),
        });
        id = result.id;
        showJob(id);
        setRows(result.files);
        assignments = result.files.map((row, index) => ({ row, file: valid[index] }));
        await loadJobs();
      }
      setProgress({ completed: 0, total: assignments.length });
      const queue = [...assignments];
      const send = async () => {
        while (queue.length) {
          const next = queue.shift();
          if (!next) break;
          const { row, file } = next;
          try {
            if (resume) {
              const existing = await bulkAdmin("uploaded", { job: id, id: row.id }).catch(() => null);
              if (existing) continue;
            }
            const result = await supabase.storage.from(bulkBucket).upload(row.object_path, file, {
              upsert: false, contentType: "application/octet-stream",
            });
            if (result.error) throw result.error;
            await bulkAdmin("uploaded", { job: id, id: row.id });
          } catch (e) {
            setUploadErrors(old => [...old, `${row.name} · ${errorMessage(e)}`]);
          } finally {
            setProgress(old => old && { ...old, completed: old.completed + 1 });
          }
        }
      };
      await Promise.all(Array.from({ length: 3 }, send));
      setRows(await bulkAdmin<ImportFile[]>("detail", { job: id }));
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  const decision = (file: ImportFile) => {
    if (override[file.id]) return override[file.id];
    const value = suggested(file, courses, policy);
    const jobHint = jobs.find(item => item.id === job)?.unit_hint;
    if (!value.unit && !file.result?.unitCode && jobHint) return { ...value, unit: jobHint };
    return value;
  };
  const related = (file: ImportFile, value: Decision) => file.related?.filter(r => r.unit_id === value.unit) ?? [];
  const canApprove = (file: ImportFile) => {
    if (file.state !== "review" || !policy) return false;
    const value = decision(file);
    return !!value.unit && (!(policy.confirm_each || restricted(file) || low(file, policy) || matched(file, courses).length !== 1)
      || value.reviewed === true) && (!related(file, value).some(r => r.identical) || !!value.skipExisting);
  };
  const update = (file: ImportFile, patch: Partial<Decision>) => {
    setOverride(old => ({ ...old, [file.id]: { ...decision(file), ...patch } }));
    setRowErrors(old => ({ ...old, [file.id]: "" }));
  };
  const action = async (name: string, file: ImportFile) => {
    setBusy(true); setError("");
    try { await bulkAdmin(name, { job, id: file.id }); await refresh(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    setBusy(true); setError("");
    const items = rows.filter(file => selection.includes(file.id) && canApprove(file))
      .map(file => ({ id: file.id, ...decision(file) }));
    try {
      const results = await bulkAdmin<{ id: string; ok: boolean; error?: string }[]>("approve", { job, items });
      setRowErrors(Object.fromEntries(results.filter(r => !r.ok).map(r => [r.id, r.error ?? "Approval failed."])));
      setSelection(results.filter(r => !r.ok).map(r => r.id));
      await refresh();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  const visible = rows.filter(file => {
    if (filter === "all") return true;
    if (filter === "failed") return file.state === "failed";
    if (file.state !== "review") return false;
    if (filter === "ready") return canApprove(file);
    if (filter === "low") return low(file, policy);
    if (filter === "unmatched") return matched(file, courses).length !== 1;
    if (filter === "duplicates") return !!file.related?.length;
    return restricted(file);
  });
  const ready = visible.filter(canApprove);
  const selectedReady = rows.filter(file => selection.includes(file.id) && canApprove(file)).length;
  const metadata = rows.filter(file => file.extension !== "zip");
  const analysed = metadata.filter(file => ["review", "imported", "excluded", "failed"].includes(file.state)).length;
  const archives = rows.filter(file => file.extension === "zip");
  const priced = rows.flatMap(file => file.usage?.estimated_usd != null ? [file.usage.estimated_usd] : []);
  const open = async (file: ImportFile) => {
    const formats: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg",
      jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" };
    const format = formats[file.extension];
    try {
      if (!format) { await downloadResource(file.object_path, file.name); return; }
      const result = await supabase.storage.from(bulkBucket).download(file.object_path);
      if (result.error || !result.data) throw new Error("The file could not be opened.");
      const url = URL.createObjectURL(result.data.slice(0, result.data.size, format));
      setPreview({ url, name: file.name, format });
    } catch (e) { setError(errorMessage(e)); }
  };

  return <section aria-label="AI Bulk Upload" className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><button type="button" className="text-sm font-semibold text-primary-800" onClick={onClose}>← Units</button>
        <h1 className="mt-2 font-heading text-2xl font-bold text-foreground-950">AI Bulk Upload</h1></div>
      <select className={control} aria-label="Open a recent import" value={job} onChange={e => showJob(e.target.value)} disabled={busy}>
        <option value="">New import</option>
        {jobs.map(j => <option value={j.id} key={j.id}>{new Date(j.created_at).toLocaleString()} · {j.id.slice(0, 8)}</option>)}
      </select>
    </header>
    {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>}
    <div className="grid min-w-0 items-start gap-3 lg:grid-cols-[10rem_11rem_minmax(0,1fr)]">
      <label className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-3 text-sm font-semibold">Course
        <select className={control + " mt-2 w-full"} value={course} disabled={busy} onChange={e => { setCourse(e.target.value); setHint(""); }}>
          <option value="">All courses</option>
          {courses.map(c => <option value={c.id} key={c.id}>{c.code} · {c.name}</option>)}
        </select>
      </label>
      <label className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-3 text-sm font-semibold">Unit hint
        <select className={control + " mt-2 w-full"} value={hint} disabled={busy} onChange={e => setHint(e.target.value)}>
          <option value="">Match all units</option>
          {units.filter(u => !course || u.course_id === course).map(u => <option value={u.id} key={u.id}>{u.code} · {u.name}</option>)}
        </select>
      </label>
      <div className="min-w-0 space-y-4">
        <section className="space-y-3 rounded-xl border border-background-200 bg-background-50 p-4">
          <div className="rounded-xl border-2 border-dashed border-primary-300 bg-primary-50/50 p-4"
            onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) addFiles(e.dataTransfer.files); }}>
            <h2 className="font-semibold text-foreground-950">Drop files here or choose a folder</h2>
            {policy && <p className="mt-1 break-words text-xs text-foreground-600">{policy.formats.map(f => f.toUpperCase()).join(", ")} · Up to {policy.max_mib} MiB per file</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className={button + " cursor-pointer"}>Choose files
                <input className="sr-only" type="file" multiple disabled={busy} onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
              </label>
              <input className="hidden" type="file" multiple ref={node => {
                folderInput.current = node;
                node?.setAttribute("webkitdirectory", "");
              }} onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
              <button className={button} type="button" disabled={busy} onClick={() => folderInput.current?.click()}>Choose folder</button>
              {files.length > 0 && <button className="text-sm underline" disabled={busy} type="button" onClick={() => setFiles([])}>Clear {files.length} selected</button>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={primary} type="button" disabled={busy || !policy || !files.length} onClick={() => void upload(false)}>
              Upload & analyse {files.length ? `(${files.length})` : ""}
            </button>
            {hasPendingUpload && <button className={button} type="button" disabled={busy || !files.length} onClick={() => void upload(true)}>Resume this import</button>}
          </div>
          {progress && <div className="text-sm" role="status">Upload attempts {progress.completed} of {progress.total}
            <progress className="ml-2 align-middle accent-primary-700" value={progress.completed} max={progress.total} />
          </div>}
          {uploadErrors.length > 0 && <ul className="max-h-40 overflow-auto text-sm text-red-800" aria-label="Upload errors">
            {uploadErrors.map((message, index) => <li key={index}>{message}</li>)}
          </ul>}
        </section>
        {job && <section className="space-y-3 rounded-xl border border-background-200 bg-background-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="font-semibold text-foreground-950">Classification review</h2>
              <p className="text-sm text-foreground-600">Archives extracted {archives.filter(f => f.state === "extracted").length}/{archives.length} · Documents processed {analysed}/{metadata.length}</p>
              <p className="text-xs text-foreground-600">Queued documents continue processing after you close this page.</p>
              {priced.length > 0 && <p className="text-xs text-foreground-600">Estimated AI cost USD {priced.reduce((a, b) => a + b, 0).toFixed(4)} for {priced.length} files</p>}</div>
            <button type="button" className={primary} disabled={busy || !selectedReady} onClick={() => void approve()}>Approve {selectedReady} selected</button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select className={control} aria-label="Filter documents" value={filter} onChange={e => setFilter(e.target.value as Filter)}>
              {filters.map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
            <button className={button} disabled={!ready.length || busy} type="button" onClick={() => setSelection(old => [...new Set([...old, ...ready.map(f => f.id)])])}>Select ready ({ready.length})</button>
            {!!selection.length && <button className={button} type="button" onClick={() => setSelection([])}>Clear selection</button>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm max-sm:block sm:min-w-[780px]">
              <thead className="max-sm:sr-only"><tr className="border-b border-background-300 text-xs text-foreground-700">
                {["Select", "Document", "Course", "Unit", "AI category", "Confidence", "Access", "Status"].map(label => <th key={label} scope="col" className="px-2 py-2">{label}</th>)}
              </tr></thead>
              <tbody className="max-sm:block max-sm:space-y-2">{visible.map(file => {
                const value = decision(file);
                const unit = units.find(u => u.id === value.unit);
                const selectedCourse = courses.find(c => c.id === unit?.course_id);
                const targetCourse = displayCourse[file.id] ?? selectedCourse?.id ?? "";
                const isReview = file.state === "review";
                const restrictedAccess = restricted(file) || value.category === "assessor";
                const duplicates = related(file, value);
                const identical = duplicates.some(r => r.identical);
                const unitOptions = units.filter(u => !targetCourse || u.course_id === targetCourse);
                return <tr key={file.id} className="border-b border-background-200 align-top max-sm:block max-sm:rounded-lg max-sm:border">
                  {/* // rule-policy: technical lms-review-layout Displays the current selection state for the document. */}
                  <td className={mobileCell} data-column="Select"><input type="checkbox" disabled={!canApprove(file) || busy} checked={selection.includes(file.id)}
                    aria-label={`Select ${file.name}`} onChange={e => setSelection(old => e.target.checked ? [...old, file.id] : old.filter(id => id !== file.id))} /></td>
                  <td className="min-w-44 p-2 max-sm:block">
                    <p className="break-words font-semibold">{file.result?.title || file.name}</p>
                    <p className="break-all text-xs text-foreground-600">{file.source_path}</p>
                    {file.result && <details className="mt-1 text-xs"><summary className="cursor-pointer text-primary-800">Evidence</summary>
                      <p>{file.result.documentType} · {file.result.intendedAudience}</p><p>{file.result.explanation}</p><p>{file.result.evidence}</p>
                      {file.result.assessmentPurpose && <p>{file.result.assessmentPurpose}</p>}</details>}
                    {isReview && <button type="button" className="mt-1 text-xs font-semibold text-primary-800 underline" onClick={() => void open(file)}>Preview file</button>}
                  </td>
                  <td className={mobileCell} data-column="Course">{isReview ? <select className={control + " w-28"} aria-label={`Course for ${file.name}`} value={targetCourse}
                    onChange={e => {
                      const courseId = e.target.value;
                      setDisplayCourse(old => ({ ...old, [file.id]: courseId }));
                      const options = units.filter(u => u.course_id === courseId);
                      const direct = options.find(u => u.code.toUpperCase() === file.result?.unitCode?.toUpperCase());
                      update(file, { unit: direct?.id ?? "", previousId: "", skipExisting: false, reviewed: false });
                    }}><option value="">{file.result?.courseCode ?? "Choose course"}</option>
                    {courses.map(c => <option value={c.id} key={c.id}>{c.code}</option>)}</select> : "—"}</td>
                  <td className={mobileCell} data-column="Unit">{isReview ? <select className={control + " w-36"} aria-label={`Unit for ${file.name}`} value={value.unit}
                    onChange={e => update(file, { unit: e.target.value, previousId: "", skipExisting: false, reviewed: false })}>
                    <option value="">{file.result?.unitCode ?? "Choose unit"}</option>
                    {unitOptions.map(u => <option value={u.id} key={u.id}>{u.code} · {u.name}</option>)}</select> : "—"}</td>
                  <td className={mobileCell} data-column="Category">{isReview ? <select className={control + " w-32"} aria-label={`Category for ${file.name}`} value={value.category}
                    onChange={e => update(file, { category: e.target.value as Category, reviewed: false })}>
                    {categories.map(c => <option value={c} key={c}>{categoryLabel(c, policy)}</option>)}</select> : file.result ? categoryLabel(file.result.category, policy) : "—"}</td>
                  {/* // rule-policy: business lms.bulk_confidence Shows the confidence comparison from the published review setting. */}
                  <td data-column="Confidence" className={mobileCell + (low(file, policy) ? "font-semibold text-amber-800" : "")}>{file.result ? `${Math.round(file.result.confidence)}%` : "—"}</td>
                  <td className={mobileCell} data-column="Access">{isReview ? <select className={control} aria-label={`Access for ${file.name}`} value={restrictedAccess ? "assessor" : value.audience}
                    disabled={restrictedAccess} onChange={e => update(file, { audience: e.target.value as Audience, reviewed: false })}>
                    {Object.entries(accessLabels).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select> : "—"}</td>
                  <td className="min-w-40 space-y-1 p-2 max-sm:block">
                    <p className={restrictedAccess ? "font-semibold text-amber-800" : "font-semibold"}>
                      {restrictedAccess && isReview ? "Restricted" : isReview && canApprove(file) ? "Ready" : file.state === "processing" && file.extension === "zip" ? "Extracting" : stateLabel[file.state]}
                    </p>
                    {restrictedAccess && isReview && <p className="text-xs text-amber-900">Assessor access enforced</p>}
                    {file.failure && <p className="text-xs text-red-800">{file.failure}</p>}
                    {rowErrors[file.id] && <p className="text-xs text-red-800">{rowErrors[file.id]}</p>}
                    {isReview && identical && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!value.skipExisting}
                      onChange={e => update(file, { skipExisting: e.target.checked })} />Skip existing</label>}
                    {isReview && !identical && duplicates.length > 0 && <select className={control + " max-w-40"} aria-label={`Version for ${file.name}`} value={value.previousId ?? ""}
                      onChange={e => update(file, { previousId: e.target.value })}>
                      <option value="">Separate resource</option>
                      {duplicates.map(r => <option key={r.id} value={r.id}>New version of {r.title}</option>)}
                    </select>}
                    {isReview && (policy?.confirm_each || restricted(file) || low(file, policy) || matched(file, courses).length !== 1) &&
                      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!value.reviewed} onChange={e => update(file, { reviewed: e.target.checked })} />Reviewed</label>}
                    {["review", "failed", "uploading"].includes(file.state) && <button className="mr-2 text-xs underline" type="button" disabled={busy} onClick={() => void action("exclude", file)}>Exclude</button>}
                    {file.state === "failed" && <button type="button" className="text-xs font-semibold underline" disabled={busy} onClick={() => void action("retry", file)}>Retry</button>}
                  </td>
                </tr>;
              })}</tbody>
            </table>
            {!visible.length && <p className="py-6 text-center text-sm text-foreground-600">No documents in this view.</p>}
          </div>
        </section>}
      </div>
    </div>
    {preview && <dialog open aria-label={preview.name} onCancel={() => setPreview(null)}
      className="fixed inset-0 z-50 m-auto max-h-[92vh] w-[94vw] max-w-5xl overflow-auto rounded-xl border border-background-300 bg-background-50 p-4 shadow-2xl">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="break-all font-semibold">{preview.name}</h2>
        <button type="button" className={button} onClick={() => setPreview(null)}>Close</button>
      </header>
      {preview.format === "application/pdf"
        ? <iframe className="h-[70vh] w-full" sandbox="" title={preview.name} src={preview.url} />
        : preview.format.startsWith("image/")
          ? <img className="mx-auto max-h-[70vh] object-contain" src={preview.url} alt={preview.name} />
          : <video className="mx-auto max-h-[70vh]" controls src={preview.url} />}
      <a className="mt-3 inline-block text-sm text-primary-800 underline" href={preview.url} download={preview.name}>Download original</a>
    </dialog>}
  </section>;
}
