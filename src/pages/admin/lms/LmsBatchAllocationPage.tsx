import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
  const [tab, setTab] = useState<"students" | "trainers">("students");
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
  const buttonClass = "rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50";
  const removeStudent = (s: BatchStudent) => {
    if (!window.confirm(`Remove ${s.name} from this batch?`)) return;
    void save("enrolment_set", { enrolmentId: s.enrolmentId, status: "withdrawn" }, "Student removed");
  };
  return <div className="mx-auto max-w-7xl space-y-5 pb-10">
    <div><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Learning Management</p>
      <h1 className="font-heading text-3xl font-bold">Batch Allocation</h1>
      <p className="mt-1 text-sm text-foreground-600">Assign existing CRM students and HRMS trainers to a batch.</p></div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button className="ml-3 underline" onClick={() => { setError(""); void load(); }}>Retry</button></div>}
    <div className="grid gap-4 rounded-xl border border-background-200 bg-background-50 p-5 md:grid-cols-3">
      <label className="space-y-2 text-sm font-medium">Course
        <select className={inputClass} value={courseId} onChange={e => setCourseId(e.target.value)}>{courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      </label>
      <label className="space-y-2 text-sm font-medium">Intake
        <select className={inputClass} value={intakeId} onChange={e => setIntakeId(e.target.value)}>{availableIntakes.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
      </label>
      <label className="space-y-2 text-sm font-medium">Batch
        <select className={inputClass} value={batchId} onChange={e => setBatchId(e.target.value)}>{batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      </label>
    </div>
    {loading ? <p className="text-sm text-foreground-500">Loading academic records…</p> : !batchId ? <p className="text-sm text-foreground-500">Select a course and intake with an existing batch.</p> : !current ? <p className="text-sm text-foreground-500">Loading allocations…</p> : <>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-background-200 bg-background-50 p-4"><p className="text-xs text-foreground-500">Students allocated</p><p className="mt-1 text-2xl font-bold">{students.length}{current.capacity ? <span className="text-sm font-normal text-foreground-500"> / {current.capacity}</span> : null}</p></div>
        <div className="rounded-xl border border-background-200 bg-background-50 p-4"><p className="text-xs text-foreground-500">Trainers allocated</p><p className="mt-1 text-2xl font-bold">{current.trainers.length}</p></div>
      </div>
      <div className="rounded-xl border border-background-200 bg-background-50">
        <div className="flex gap-2 border-b border-background-200 p-3" role="tablist">
          {(["students", "trainers"] as const).map(t => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === t ? "bg-primary-500 text-white" : "text-foreground-600 hover:bg-background-100"}`}>{t === "students" ? "Students" : "Trainers"}</button>)}
        </div>
        <div className="space-y-3 p-4">
          {tab === "students" ? <>
            <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Assigned Students</h2>
              {canEnrol && current.isActive && <button className={buttonClass} disabled={busy || (current.capacity !== null && students.length >= current.capacity)} onClick={() => setPicker(true)}>+ Assign Students</button>}
            </div>
            {!students.length && <p className="text-sm text-foreground-500">No students allocated.</p>}
            <ul className="divide-y divide-background-100">{students.map(s => <li key={s.enrolmentId} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1"><Link to={`/admin/students/${s.id}`} className="font-medium text-primary-600 hover:underline">{s.name}</Link><p className="truncate text-xs text-foreground-500">{s.email} · {s.type}</p></div>
              {canEnrol && <><select aria-label={`Move ${s.name}`} className={inputClass + " max-w-44"} value="" disabled={busy} onChange={e => { if (e.target.value) void save("student_move", { enrolmentId: s.enrolmentId, toBatchId: e.target.value }, "Student transferred"); }}>
                <option value="">Move to…</option>{data.siblings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select><button type="button" disabled={busy} onClick={() => removeStudent(s)} className="text-sm font-medium text-red-600 disabled:opacity-50">Remove</button></>}
            </li>)}</ul>
          </> : <>
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Assigned Trainers</h2>
              {canEdit && <select aria-label="Assign trainer" className={inputClass + " max-w-64"} value="" disabled={busy} onChange={e => { const id = e.target.value; if (id) void save("batch_trainers_set", { batchId, trainerIds: [...current.trainers.map(t => t.id), id] }, "Trainer assigned"); }}>
                <option value="">+ Assign Trainer</option>{staff.filter(s => !current.trainers.some(t => t.id === s.id)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>}
            </div>
            {!current.trainers.length && <p className="text-sm text-foreground-500">No trainers allocated.</p>}
            <ul className="divide-y divide-background-100">{current.trainers.map(t => <li key={t.id} className="flex items-center justify-between gap-3 py-3">
              <span className="font-medium">{t.name}</span>{canEdit && <button type="button" disabled={busy} className="text-sm font-medium text-red-600 disabled:opacity-50" onClick={() => void save("batch_trainers_set", { batchId, trainerIds: current.trainers.filter(x => x.id !== t.id).map(x => x.id) }, "Trainer removed")}>Remove</button>}
            </li>)}</ul>
          </>}
        </div>
      </div>
      {picker && <StudentPicker courseId={data.intake.courseId} batchId={batchId} rtoManager={canEdit}
        batches={[{ id: batchId, name: current.name, capacity: current.capacity, enrolled: students.length, studentIds: students.map(s => s.id) }]}
        onClose={() => setPicker(false)} onAdded={() => { setPicker(false); void load(); push("Students assigned", "success"); }} />}
    </>}
  </div>;
}
