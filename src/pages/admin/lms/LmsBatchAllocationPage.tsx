import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { asmAdmin, type AssessmentRow, type AssignmentRow } from "@/pages/admin/lib/assessments";
import { fmtDate, fromLocalInput, toLocalInput } from "@/lib/assessment/api";
import StudentPicker from "@/pages/admin/components/rto/StudentPicker";
import { useToast } from "@/pages/admin/components/toastContext";
import { rto, rtoFlow, type BatchPageData, type BatchStudent, type RtoCourse, type RtoIntake, type CourseDetail, type StaffOption } from "@/pages/admin/lib/rto";

/** Dedicated allocation screen, backed by the existing CRM enrolment and HRMS trainer APIs. */
export default function LmsBatchAllocationPage() {
  const { push } = useToast();
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [data, setData] = useState<BatchPageData | null>(null);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [picker, setPicker] = useState(false);
  const [courseSearch, setCourseSearch] = useState("");
  const [intakeSearch, setIntakeSearch] = useState("");
  const [batchSearch, setBatchSearch] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [tab, setTab] = useState<"students" | "trainers" | "assessments">("students");
  const [assessmentOptions, setAssessmentOptions] = useState<AssessmentRow[]>([]);
  const [assessmentAssignments, setAssessmentAssignments] = useState<AssignmentRow[]>([]);
  const [assessmentId, setAssessmentId] = useState("");
  const [assessmentMode, setAssessmentMode] = useState<"existing" | "create">("create");
  const [createdDraft, setCreatedDraft] = useState<{ id: string; courseId: string } | null>(null);
  const [assessmentRefresh, setAssessmentRefresh] = useState(0);
  const [assessmentLoading, setAssessmentLoading] = useState(true);
  const [assessmentError, setAssessmentError] = useState("");
  const [newAssessmentTitle, setNewAssessmentTitle] = useState("");
  const [newAssessmentUnit, setNewAssessmentUnit] = useState("");
  const [courseUnits, setCourseUnits] = useState<CourseDetail["units"]>([]);
  const [assessmentFile, setAssessmentFile] = useState<File | null>(null);
  const [availableFrom, setAvailableFrom] = useState(toLocalInput(new Date().toISOString()));
  const [dueAt, setDueAt] = useState(toLocalInput(new Date(Date.now() + 14 * 86400000).toISOString()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list")])
      .then(([c, i]) => { if (active) { setCourses(c); setIntakes(i); setCourseId(c[0]?.id ?? ""); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load academic records"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const availableIntakes = useMemo(() => intakes.filter(i => i.courseId === courseId), [intakes, courseId]);
  useEffect(() => { setIntakeId(prev => availableIntakes.some(i => i.id === prev) ? prev : availableIntakes[0]?.id ?? ""); }, [availableIntakes]);
  const selectedIntake = availableIntakes.find(i => i.id === intakeId);
  const batches = useMemo(() => selectedIntake?.batchList ?? [], [selectedIntake]);
  useEffect(() => { setBatchId(prev => batches.some(b => b.id === prev) ? prev : batches[0]?.id ?? ""); }, [batches]);
  const load = useCallback(async () => {
    if (!batchId) { setData(null); return; }
    try { const result = await rtoFlow<BatchPageData>("batch_get", { batchId }); setData(result); setError(""); }
    catch (e) { setData(null); setError(e instanceof Error ? e.message : "Unable to load batch allocations"); }
  }, [batchId]);
  useEffect(() => { setData(null); void load(); }, [load]);
  useEffect(() => {
    if (tab !== "trainers" || !data?.rtoManager) return;
    let active = true;
    rto<StaffOption[]>("staff_list").then(s => { if (active) setStaff(s); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load trainers"); });
    return () => { active = false; };
  }, [tab, data?.rtoManager]);

  useEffect(() => {
    if (tab !== "assessments" || !courseId || !batchId) return;
    let active = true;
    setAssessmentLoading(true);
    Promise.all([
      asmAdmin<AssessmentRow[]>("assessment_list", { courseId, includeArchived: false }),
      asmAdmin<AssignmentRow[]>("assignment_list", { batchId }),
    ])
      .then(([a, x]) => { if (active) { setAssessmentOptions(a); setAssessmentAssignments(x); } })
      .catch(e => { if (active) setAssessmentError(e instanceof Error ? e.message : "Unable to load assessments"); })
      .finally(() => { if (active) setAssessmentLoading(false); });
    return () => { active = false; };
  }, [tab, courseId, batchId, assessmentRefresh]);
  useEffect(() => {
    let active = true;
    setCourseUnits([]);
    setNewAssessmentUnit("");
    setAssessmentId("");
    setAssessmentError("");
    if (courseId) rto<CourseDetail>("course_get", { courseId })
      .then(detail => { if (active) setCourseUnits(detail.units ?? []); })
      .catch(e => { if (active) setAssessmentError(e instanceof Error ? e.message : "Unable to load course units"); });
    return () => { active = false; };
  }, [courseId]);
  const publishedAssessments = assessmentOptions.filter(a => a.courseId === courseId && a.currentVersionStatus === "published" && !a.archivedAt);
  const refreshAssessments = () => {
    setAssessmentError("");
    setAssessmentRefresh(value => value + 1);
  };
  const createAssessment = async () => {
    const title = newAssessmentTitle.trim();
    if (!title || !courseUnits.some(unit => unit.id === newAssessmentUnit) || !assessmentFile || busy || !canEdit ||
        !current?.isActive || current.id !== batchId || data?.intake.courseId !== courseId) return;
    setAssessmentError("");
    setCreatedDraft(null);
    setBusy(true);
    try {
      const startsAt = fromLocalInput(availableFrom);
      const deadline = fromLocalInput(dueAt);
      if (!startsAt || !deadline || deadline <= startsAt) throw new Error("Due Date must be after Available From.");
      if (!assessmentFile.name.toLowerCase().endsWith(".json")) throw new Error("Choose a JSON assessment export. PDF, Word and other file types are unsupported.");
      let imported: unknown;
      try { imported = JSON.parse(await assessmentFile.text()); }
      catch { throw new Error("The selected file is not valid JSON."); }
      const template = imported as { definition?: { tasks?: unknown } } | null;
      if (!Array.isArray(template?.definition?.tasks)) {
        throw new Error("Choose a JSON export from the Assessments editor. The file must contain an assessment definition.");
      }
      const result = await asmAdmin<{ id?: string; ok?: boolean; errors?: { message: string }[] }>("assessment_create", {
        courseId, unitId: newAssessmentUnit, title, import: imported,
      });
      if (result.ok === false || !result.id) throw new Error(result.errors?.map(e => e.message).join(" ") || "Unable to create assessment");
      const id = result.id;
      setNewAssessmentTitle("");
      setAssessmentFile(null);
      const published = await asmAdmin<{ ok: boolean; errors?: { message: string }[] }>("version_publish", { assessmentId: id });
      if (!published.ok) {
        setCreatedDraft({ id, courseId });
        refreshAssessments();
        throw new Error("Uploaded as a draft but not published, so it was not assigned: " + (published.errors?.map(e => e.message).join(" ") ?? "") + " Open the draft to fix and publish it.");
      }
      const assigned = await asmAdmin<{ created: number; errors?: { message: string }[] }>("assignment_create", {
        assessmentId: id, batchIds: [batchId], availableFrom: startsAt, dueAt: deadline,
      });
      refreshAssessments();
      if (assigned.errors?.length || !assigned.created) throw new Error("Uploaded and published, but not assigned: " + (assigned.errors?.map(e => e.message).join(" ") || "check assessment eligibility.") + " Assign it under Select Existing Assessment.");
      push("Assessment uploaded and assigned to " + current.name, "success");
    } catch (e) { setAssessmentError(e instanceof Error ? e.message : "Unable to upload assessment"); }
    finally { setBusy(false); }
  };
  const assignAssessment = async () => {
    if (!publishedAssessments.some(a => a.id === assessmentId) || !current?.isActive || current.id !== batchId ||
        data?.intake.courseId !== courseId || !availableFrom || !dueAt || busy || !canEdit || assessmentLoading) return;
    setAssessmentError("");
    setBusy(true);
    try {
      const startsAt = fromLocalInput(availableFrom);
      const deadline = fromLocalInput(dueAt);
      if (!startsAt || !deadline || deadline <= startsAt) throw new Error("Due Date must be after Available From.");
      const result = await asmAdmin<{ created: number; errors?: { message: string }[] }>("assignment_create", {
        assessmentId, batchIds: [batchId], availableFrom: startsAt, dueAt: deadline,
      });
      if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join(" "));
      if (!result.created) throw new Error("No assignment created. Check assessment eligibility.");
      setAssessmentId("");
      refreshAssessments();
      push("Assessment assigned", "success");
    } catch (e) { setAssessmentError(e instanceof Error ? e.message : "Unable to assign assessment"); }
    finally { setBusy(false); }
  };
  const save = async (action: string, payload: Record<string, unknown>, success: string) => {
    setBusy(true);
    try { await rtoFlow(action, payload); await load(); push(success, "success"); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to save allocation"); }
    finally { setBusy(false); }
  };
  const current = data?.batch;
  const students = current?.students.filter(s => s.status === "active" || s.status === "deferred") ?? [];
  const canEnrol = !!data && (data.rtoManager || data.admin);
  const canEdit = !!data?.rtoManager;
  const inputClass = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  const selectionClass = (selected: boolean) => `w-full rounded-lg border px-3 py-3 text-left text-sm transition ${selected ? "border-primary-500 bg-primary-50 font-semibold" : "border-background-200 hover:bg-background-100"}`;
  const buttonClass = "rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50";
  const assessmentSourceClass = (selected: boolean) => `min-h-11 rounded-lg border px-3 py-2.5 text-left text-sm font-semibold transition ${selected ? "border-primary-600 bg-primary-600 text-white" : "border-background-300 bg-background-50 text-foreground-900 hover:bg-background-100"}`;
  const dateFields = <>
    <p className="text-xs text-foreground-600">Dates and times use Melbourne time.</p>
    <label className="block text-sm font-medium">Available From<input type="datetime-local" className={inputClass + " mt-1 min-w-0"} value={availableFrom} onChange={e => setAvailableFrom(e.target.value)} /></label>
    <label className="block text-sm font-medium">Due Date<input type="datetime-local" className={inputClass + " mt-1 min-w-0"} value={dueAt} onChange={e => setDueAt(e.target.value)} /></label>
  </>;
  const batchAssessments = assessmentAssignments.filter(a => a.batchId === batchId && a.status !== "cancelled");
  const removeStudent = (s: BatchStudent) => {
    if (!window.confirm(`Remove ${s.name} from this batch?`)) return;
    void save("enrolment_set", { enrolmentId: s.enrolmentId, status: "withdrawn" }, "Student removed");
  };
  return <div className="mx-auto max-w-7xl space-y-5 pb-10">
    <div><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p>
      <h1 className="font-heading text-3xl font-bold">Batch Allocation</h1>
      <p className="mt-1 text-sm text-foreground-600">Select a course, intake and batch across the first three columns. Assign students, trainers and assessments in the fourth column.</p></div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button className="ml-3 underline" onClick={() => { setError(""); void load(); }}>Retry</button></div>}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-[minmax(180px,1fr)_minmax(170px,0.85fr)_minmax(170px,0.8fr)_minmax(330px,2.2fr)]">
      <section aria-label="Course selection" className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4">
        <h2 className="mb-3 font-semibold">Courses</h2>
        <input aria-label="Search courses" placeholder="Search courses…" className={inputClass + " mb-3"} value={courseSearch} onChange={e => setCourseSearch(e.target.value)} />
        <div className="space-y-2">{courses.filter(c => c.label.toLowerCase().includes(courseSearch.toLowerCase())).map(c => <button key={c.id} type="button" aria-pressed={courseId === c.id} onClick={() => { setCourseId(c.id); setPicker(false); }} className={selectionClass(courseId === c.id)}>{c.label}</button>)}</div>
      </section>
      <section aria-label="Intake selection" className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4">
        <h2 className="mb-3 font-semibold">Intakes</h2>
        <input aria-label="Search intakes" placeholder="Search intakes…" className={inputClass + " mb-3"} value={intakeSearch} onChange={e => setIntakeSearch(e.target.value)} />
        <div className="space-y-2">{availableIntakes.filter(i => i.name.toLowerCase().includes(intakeSearch.toLowerCase())).map(i => <button key={i.id} type="button" aria-pressed={intakeId === i.id} onClick={() => { setIntakeId(i.id); setPicker(false); }} className={selectionClass(intakeId === i.id)}>{i.name}</button>)}</div>
        {!availableIntakes.length && <p className="text-sm text-foreground-500">No intakes for this course.</p>}
      </section>
      <section aria-label="Batch selection" className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4">
        <h2 className="mb-3 font-semibold">Batches</h2>
        <input aria-label="Search batches" placeholder="Search batches…" className={inputClass + " mb-3"} value={batchSearch} onChange={e => setBatchSearch(e.target.value)} />
        <div className="space-y-2">{batches.filter(b => b.name.toLowerCase().includes(batchSearch.toLowerCase())).map(b => <button key={b.id} type="button" aria-pressed={batchId === b.id} onClick={() => { setBatchId(b.id); setPicker(false); }} className={selectionClass(batchId === b.id)}>{b.name}</button>)}</div>
        {!batches.length && <p className="text-sm text-foreground-500">No batches for this intake.</p>}
        <Link className="mt-4 inline-block text-sm font-semibold text-primary-600 hover:underline" to="/admin/lms/batches">Manage batches</Link>
      </section>
      <section aria-label="Allocation workspace" className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4 md:col-span-3 xl:col-span-1">
        <h2 className="mb-3 font-semibold">Allocation</h2>
        {loading ? <p className="text-sm text-foreground-500">Loading academic records…</p> : !batchId ? <p className="text-sm text-foreground-500">Select a batch in the Batches column.</p> : !current || data?.batch.id !== batchId ? <p className="text-sm text-foreground-500">Loading allocations…</p> : <>
          <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Allocation type">
            {(["students", "trainers", "assessments"] as const).map(t => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`flex-1 rounded-lg px-2 py-2 text-sm font-semibold ${tab === t ? "bg-primary-500 text-white" : "bg-background-100 text-foreground-700"}`}>{t === "students" ? `Students (${students.length})` : t === "trainers" ? `Trainers (${current.trainers.length})` : "Assessments"}</button>)}
          </div>
          {tab === "students" ? <>
            <div className="mb-3 rounded-lg border border-background-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Available students</h3>
                {canEnrol && current.isActive && <button type="button" className={buttonClass} disabled={busy || (current.capacity !== null && students.length >= current.capacity)} onClick={() => setPicker(true)}>+ Add students</button>}
              </div>
              <p className="mt-2 text-xs text-foreground-500">Search and select eligible students from CRM using Add students.</p>
            </div>
            <div className="rounded-lg border border-background-200 p-3">
              <h3 className="mb-2 font-semibold">Batch students ({students.length})</h3>
              <input aria-label="Search assigned students" className={inputClass + " mb-2"} placeholder="Search assigned students…" value={studentSearch} onChange={e => setStudentSearch(e.target.value)} />
              <ul className="max-h-[480px] divide-y divide-background-100 overflow-y-auto">{students.filter(s => (s.name + " " + s.email).toLowerCase().includes(studentSearch.toLowerCase())).map(s => <li key={s.enrolmentId} className="flex flex-wrap items-center gap-2 py-3">
                <div className="min-w-0 flex-1"><Link to={`/admin/students/${s.id}`} className="font-medium text-primary-600 hover:underline">{s.name}</Link><p className="truncate text-xs text-foreground-500">{s.email}</p></div>
                {canEnrol && <><select aria-label={`Move ${s.name}`} className={inputClass + " max-w-36"} value="" disabled={busy} onChange={ev => { if (ev.target.value) void save("student_move", { enrolmentId: s.enrolmentId, toBatchId: ev.target.value }, "Student transferred"); }}><option value="">Move to…</option>{data.siblings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select><button type="button" disabled={busy} onClick={() => removeStudent(s)} className="text-sm font-medium text-red-600 disabled:opacity-50">Remove</button></>}
              </li>)}</ul>
              {!students.length && <p className="text-sm text-foreground-500">No students assigned yet.</p>}
            </div>
          </> : tab === "trainers" ? <>
            <div className="rounded-lg border border-background-200 p-3">
              <h3 className="mb-2 font-semibold">Available trainers</h3>
              {canEdit && <select aria-label="Assign trainer" className={inputClass} value="" disabled={busy} onChange={ev => { const id = ev.target.value; if (id) void save("batch_trainers_set", { batchId, trainerIds: [...current.trainers.map(t => t.id), id] }, "Trainer assigned"); }}><option value="">+ Select trainer to assign</option>{staff.filter(t => !current.trainers.some(a => a.id === t.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
            </div>
            <div className="mt-3 rounded-lg border border-background-200 p-3">
              <h3 className="mb-2 font-semibold">Batch trainers ({current.trainers.length})</h3>
              <ul className="divide-y divide-background-100">{current.trainers.map(t => <li key={t.id} className="flex items-center justify-between gap-2 py-3"><span className="font-medium">{t.name}</span>{canEdit && <button type="button" disabled={busy} className="text-sm font-medium text-red-600 disabled:opacity-50" onClick={() => void save("batch_trainers_set", { batchId, trainerIds: current.trainers.filter(x => x.id !== t.id).map(x => x.id) }, "Trainer removed")}>Remove</button>}</li>)}</ul>
              {!current.trainers.length && <p className="text-sm text-foreground-500">No trainers assigned yet.</p>}
            </div>
          </> : <div className="space-y-4">
            <div className="rounded-lg border border-background-200 p-3">
              <h3 className="mb-3 break-words font-semibold">Assign assessments to {current.name}</h3>
              <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,210px),1fr))] gap-2" role="group" aria-label="Assessment source">
                <button type="button" aria-pressed={assessmentMode === "create"} className={assessmentSourceClass(assessmentMode === "create")} onClick={() => setAssessmentMode("create")}>
                  <i className="ri-upload-2-line mr-2" aria-hidden="true" />Upload New Assessment
                </button>
                <button type="button" aria-pressed={assessmentMode === "existing"} className={assessmentSourceClass(assessmentMode === "existing")} onClick={() => { setAssessmentMode("existing"); refreshAssessments(); }}>
                  <i className="ri-list-check mr-2" aria-hidden="true" />Select Existing Assessment
                </button>
              </div>
              {assessmentError && <p role="alert" className="mb-3 break-words rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800">{assessmentError}</p>}
              {assessmentMode === "create" ? <div className="space-y-3">
                <fieldset disabled={busy || !canEdit} className="min-w-0 space-y-3">
                  <label className="block text-sm font-medium">Course unit<select className={inputClass + " mt-1"} value={newAssessmentUnit} onChange={e => setNewAssessmentUnit(e.target.value)}><option value="">Select unit</option>{courseUnits.filter(u => u.id).map(u => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}</select></label>
                  <label className="block text-sm font-medium">Assessment title<input className={inputClass + " mt-1"} value={newAssessmentTitle} onChange={e => setNewAssessmentTitle(e.target.value)} placeholder="e.g. A1 — Project" /></label>
                  <div className="rounded-lg border border-dashed border-background-300 p-3">
                    <label htmlFor="batch-assessment-template" className="block text-sm font-medium">Upload assessment template</label>
                    <input id="batch-assessment-template" type="file" accept=".json,application/json" aria-describedby="batch-assessment-template-help" className={inputClass + " mt-1"} onChange={e => { setAssessmentError(""); setAssessmentFile(e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ""; }} />
                    <p id="batch-assessment-template-help" className="mt-2 text-xs text-foreground-600">Use a JSON export from the Assessments editor. PDF, Word, PowerPoint and other formats are unsupported.</p>
                    {assessmentFile && <p className="mt-2 break-all text-sm" role="status">Selected file · {assessmentFile.name}</p>}
                  </div>
                  {dateFields}
                  <button type="button" className={buttonClass} disabled={!newAssessmentTitle.trim() || !newAssessmentUnit || !assessmentFile || !availableFrom || !dueAt || !current.isActive} onClick={() => void createAssessment()}>{busy ? "Uploading…" : "Upload & assign to " + current.name}</button>
                </fieldset>
                {createdDraft?.courseId === courseId ? (
                  <div className="rounded-lg border border-background-200 bg-background-100 p-3 text-sm">
                    <Link className="font-semibold text-primary-600 underline" to={`/admin/assessments/${createdDraft.id}`} target="_blank" rel="noopener">Open draft to review and publish</Link>
                    <p className="mt-1 text-foreground-600">The editor opens in a new tab. After publishing, choose Select Existing Assessment here to assign it.</p>
                  </div>
                ) : <p className="text-xs text-foreground-600">The file is created under the chosen unit, published, and assigned to this batch in one step.</p>}
              </div> : <>
                <label className="block text-sm font-medium">Published assessment
                  <select className={inputClass + " mt-1"} value={assessmentId} disabled={assessmentLoading || busy} onChange={e => setAssessmentId(e.target.value)}>
                    <option value="">{assessmentLoading ? "Loading assessments…" : "Select assessment"}</option>
                    {publishedAssessments.map(a => <option key={a.id} value={a.id}>{a.unitCode ? a.unitCode + " — " : ""}{a.title}</option>)}
                  </select>
                </label>
                {!assessmentLoading && !assessmentError && !publishedAssessments.length && <p className="mt-2 text-sm text-foreground-600">This course has no published assessments.</p>}
                <button type="button" className="mt-2 text-sm font-semibold text-primary-600 underline disabled:opacity-50" disabled={assessmentLoading || busy} onClick={refreshAssessments}>Refresh published assessments</button>
                <fieldset className="mt-3 min-w-0 space-y-2" disabled={busy}>
                  {dateFields}
                  <button type="button" className={buttonClass} disabled={!canEdit || assessmentLoading || !publishedAssessments.some(a => a.id === assessmentId) || !availableFrom || !dueAt || !current.isActive} onClick={() => void assignAssessment()}>{busy ? "Assigning…" : "Assign assessment"}</button>
                </fieldset>
              </>}
            </div>
            <div className="rounded-lg border border-background-200 p-3">
              <h3 className="mb-2 font-semibold">Assigned assessments</h3>
              {batchAssessments.map(a => <div key={a.id} className="border-b border-background-100 py-3 last:border-0"><p className="break-words font-medium">{a.assessmentTitle}</p><p className="text-xs text-foreground-500">{a.unitCode ?? "Assessment"} · Due {fmtDate(a.dueAt)} · {a.eligibleCount} students · {a.status}</p></div>)}
              {!batchAssessments.length && (assessmentLoading ? <p className="text-sm text-foreground-500">Loading assigned assessments…</p> : !assessmentError && <p className="text-sm text-foreground-500">No assessments assigned yet.</p>)}
            </div>
          </div>}
        </>}
      </section>
    </div>
      {picker && data && current && <StudentPicker courseId={data.intake.courseId} batchId={batchId} rtoManager={canEdit}
        batches={[{ id: batchId, name: current.name, capacity: current.capacity, enrolled: students.length, studentIds: students.map(s => s.id) }]}
        onClose={() => setPicker(false)} onAdded={() => { setPicker(false); void load(); push("Students assigned", "success"); }} />}
  </div>;
}
