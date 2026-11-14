import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { rto, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";

/** Allocation workspace: parent selection uses existing authoritative RTO records. */
export default function LmsBatchAllocationPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list")])
      .then(([c,i]) => { if (active) { setCourses(c); setIntakes(i); setCourseId(c[0]?.id ?? ""); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load academic records"); });
    return () => { active = false; };
  }, []);
  const availableIntakes = useMemo(() => intakes.filter(i => i.courseId === courseId), [intakes,courseId]);
  useEffect(() => { setIntakeId(availableIntakes[0]?.id ?? ""); }, [courseId,intakes]);
  const selectedIntake = availableIntakes.find(i => i.id === intakeId);
  const batches = selectedIntake?.batchList ?? [];
  useEffect(() => { setBatchId(batches[0]?.id ?? ""); }, [intakeId,intakes]);
  const inputClass = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  return <div className="mx-auto max-w-6xl space-y-5 pb-10">
    <div><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Learning Management</p>
      <h1 className="font-heading text-3xl font-bold">Batch Allocation</h1>
      <p className="mt-1 text-sm text-foreground-600">Select a course, intake and batch. Students remain owned by CRM and trainers by HRMS.</p></div>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">{error}</p>}
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
    <div className="grid gap-4 md:grid-cols-2">
      <section className="rounded-xl border border-background-200 bg-background-50 p-5">
        <h2 className="font-heading text-lg font-semibold">Students</h2>
        <p className="mt-2 text-sm text-foreground-600">Student assignment must reference existing CRM enrollments. No duplicate student records will be created.</p>
      </section>
      <section className="rounded-xl border border-background-200 bg-background-50 p-5">
        <h2 className="font-heading text-lg font-semibold">Trainers</h2>
        <p className="mt-2 text-sm text-foreground-600">Trainer assignment must reference existing HRMS employees. No duplicate trainer records will be created.</p>
      </section>
    </div>
    <p className="text-sm text-foreground-600">Assignment editing is not enabled until the existing student and trainer allocation APIs are verified. <Link to="/admin/lms/batches" className="font-semibold text-primary-600 underline">Manage batches</Link>.</p>
  </div>;
}
