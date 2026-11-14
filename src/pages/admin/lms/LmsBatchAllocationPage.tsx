import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { asmAdmin, type AssessmentRow, type AssignmentRow } from "@/pages/admin/lib/assessments";
import { fromLocalInput, toLocalInput } from "@/lib/assessment/api";
import StudentPicker from "@/pages/admin/components/rto/StudentPicker";
import { useToast } from "@/pages/admin/components/toastContext";
import { rto, rtoFlow, type BatchPageData, type BatchStudent, type RtoCourse, type RtoIntake, type StaffOption } from "@/pages/admin/lib/rto";

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
  const batches = selectedIntake?.batchList ?? [];
  useEffect(() => { setBatchId(prev => batches.some(b => b.id === prev) ? prev : batches[0]?.id ?? ""); }, [intakeId, intakes]);
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
    if (tab !== "assessments") return;
    let active = true;
    Promise.all([asmAdmin<AssessmentRow[]>("assessment_list", {includeArchived:false}), asmAdmin<AssignmentRow[]>("assignment_list", {})])
      .then(([a, x]) => { if (active) { setAssessmentOptions(a); setAssessmentAssignments(x); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load assessments"); });
    return () => { active = false; };
  }, [tab, batchId]);
  const assignAssessment = async () => {
    if (!assessmentId || !batchId || !dueAt || busy || !data?.rtoManager) return;
    setBusy(true);
    try {
      const result = await asmAdmin<{created:number;errors?:{message:string}[]}>("assignment_create", {assessmentId, batchIds:[batchId], availableFrom:fromLocalInput(availableFrom), dueAt:fromLocalInput(dueAt)});
      if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join("; "));
      if (!result.created) throw new Error("No assignment created. Check assessment eligibility.");
      setAssessmentAssignments(await asmAdmin<AssignmentRow[]>("assignment_list", {}));
      push("Assessment assigned", "success");
    } catch(e) { setError(e instanceof Error ? e.message : "Unable to assign assessment"); }
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
  const removeStudent = (s: BatchStudent) => {
    if (!window.confirm(`Remove ${s.name} from this batch?`)) return;
    void save("enrolment_set", { enrolmentId: s.enrolmentId, status: "withdrawn" }, "Student removed");
  };
  return <div className="mx-auto max-w-7xl space-y-5 pb-10">
    <div><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p>
      <h1 className="font-heading text-3xl font-bold">Batch Allocation</h1>
      <p className="mt-1 text-sm text-foreground-600">Select a course, intake and batch across the first three columns. Assign students, trainers and assessments in the fourth column.</p></div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button className="ml-3 underline" onClick={() => { setError(""); void load(); }}>Retry</button></div>}
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(180px,1fr)_minmax(170px,0.85fr)_minmax(170px,0.8fr)_minmax(330px,2.2fr)]">
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
      <section aria-label="Allocation workspace" className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4">
        <h2 className="mb-3 font-semibold">Allocation</h2>
        {loading ? <p className="text-sm text-foreground-500">Loading academic records…</p> : !batchId ? <p className="text-sm text-foreground-500">Select a batch in the Batches column.</p> : !current || data?.batch.id !== batchId ? <p className="text-sm text-foreground-500">Loading allocations…</p> : <>
          <div className="mb-3 flex gap-2" role="tablist" aria-label="Allocation type">
            {(["students", "trainers", "assessments"] as const).map(t => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${tab === t ? "bg-primary-500 text-white" : "bg-background-100 text-foreground-700"}`}>{t === "students" ? `Students (${students.length})` : t === "trainers" ? `Trainers (${current.trainers.length})` : "Assessments"}</button>)}
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
              <h3 className="mb-3 font-semibold">Assign assessment</h3>
              <label className="block text-sm font-medium">Published assessment
                <select className={inputClass + " mt-1"} value={assessmentId} onChange={e => setAssessmentId(e.target.value)}>
                  <option value="">Select assessment</option>
                  {assessmentOptions.filter(a => a.courseId === courseId && a.currentVersionStatus === "published" && !a.archivedAt).map(a => <option key={a.id} value={a.id}>{a.unitCode ? a.unitCode + " — " : ""}{a.title}</option>)}
                </select>
              </label>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-sm font-medium">Available from<input type="datetime-local" className={inputClass + " mt-1"} value={availableFrom} onChange={e => setAvailableFrom(e.target.value)} /></label>
                <label className="text-sm font-medium">Due date<input type="datetime-local" className={inputClass + " mt-1"} value={dueAt} onChange={e => setDueAt(e.target.value)} /></label>
              </div>
              <button type="button" className={buttonClass + " mt-3"} disabled={!canEdit || busy || !assessmentId || !dueAt || !current.isActive} onClick={() => void assignAssessment()}>{busy ? "Assigning…" : "Assign assessment"}</button>
            </div>
            <div className="rounded-lg border border-background-200 p-3">
              <h3 className="mb-2 font-semibold">Assigned assessments</h3>
              {assessmentAssignments.filter(a => a.batchId === batchId && a.status !== "cancelled").map(a => <div key={a.id} className="border-b border-background-100 py-3 last:border-0"><p className="font-medium">{a.assessmentTitle}</p><p className="text-xs text-foreground-500">{a.unitCode ?? "Assessment"} · Due {new Date(a.dueAt).toLocaleDateString()} · {a.eligibleCount} students · {a.status}</p></div>)}
              {!assessmentAssignments.some(a => a.batchId === batchId && a.status !== "cancelled") && <p className="text-sm text-foreground-500">No assessments assigned yet.</p>}
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
