import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { rto, rtoFlow, type RtoIntake, type IntakeDetail, type BatchPageData, type RtoCourse } from "@/pages/admin/lib/rto";

type Item = { id: string; name: string; intake: RtoIntake };
export default function LmsAcademicPage({ area }: { area: "batches" | "unit-delivery" | "timetable" | "attendance" }) {
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [batch, setBatch] = useState<BatchPageData | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [i, c] = await Promise.all([rto<RtoIntake[]>("intake_list"), rto<RtoCourse[]>("course_list")]);
      setIntakes(i); setCourses(c); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load academic records."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setDetail(null);
    if (!intakeId) return;
    let live = true;
    rto<IntakeDetail>("intake_get", { intakeId }).then(d => { if (live) setDetail(d); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [intakeId]);
  useEffect(() => {
    setBatch(null);
    if (!batchId) return;
    let live = true;
    rtoFlow<BatchPageData>("batch_get", { batchId }).then(d => { if (live) setBatch(d); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [batchId]);
  const matching = useMemo(() => intakes.filter(i => !courseId || i.courseId === courseId), [intakes, courseId]);
  const items = useMemo<Item[]>(() => intakes.flatMap(i => (i.batchList ?? []).map(b => ({ id: b.id, name: b.name, intake: i }))).filter(b => {
    const text = (b.name + " " + b.intake.courseName + " " + b.intake.name).toLowerCase();
    return (!courseId || b.intake.courseId === courseId) && (!intakeId || b.intake.id === intakeId) && text.includes(query.toLowerCase());
  }), [intakes, courseId, intakeId, query]);
  const titles = { batches: "Batches", "unit-delivery": "Unit Delivery", timetable: "Timetable", attendance: "Attendance" };
  return <div className="mx-auto max-w-6xl space-y-5 pb-10">
    <div><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p><h1 className="font-heading text-3xl font-bold text-foreground-950">{titles[area]}</h1>
      <p className="mt-1 text-sm text-foreground-600">Select an existing course, intake and batch. Parent details are filled automatically.</p></div>
    {error ? <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-red-800">{error}<button className="ml-3 underline" onClick={() => void load()}>Retry</button></div> : null}
    <div className="grid gap-3 rounded-xl border border-background-200 bg-background-50 p-4 sm:grid-cols-3">
      <label className="space-y-1 text-sm font-medium">Course<select className="w-full rounded-md border border-background-300 bg-background-50 p-2" value={courseId} onChange={e => { setCourseId(e.target.value); setIntakeId(""); setBatchId(""); }}>
        <option value="">All courses</option>{courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <label className="space-y-1 text-sm font-medium">Intake<select className="w-full rounded-md border border-background-300 bg-background-50 p-2" value={intakeId} onChange={e => { const i = intakes.find(x => x.id === e.target.value); setIntakeId(e.target.value); if (i) setCourseId(i.courseId); setBatchId(""); }}>
        <option value="">All intakes</option>{matching.map(i => <option key={i.id} value={i.id}>{i.courseCode} · {i.name}</option>)}</select></label>
      <label className="space-y-1 text-sm font-medium">Batch<select className="w-full rounded-md border border-background-300 bg-background-50 p-2" value={batchId} onChange={e => { const b = items.find(x => x.id === e.target.value); setBatchId(e.target.value); if (b) { setIntakeId(b.intake.id); setCourseId(b.intake.courseId); } }}>
        <option value="">All batches</option>{items.map(b => <option key={b.id} value={b.id}>{b.intake.courseCode} · {b.name}</option>)}</select></label>
    </div>
    {area === "batches" ? <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><input aria-label="Search batches" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search batches" className="rounded-md border border-background-300 bg-background-50 px-3 py-2" />
        <Link to="/admin/lms/intakes" className="rounded-md bg-primary-500 px-4 py-2 font-semibold text-background-50">Add Batch via Intake</Link></div>
      {loading ? <p>Loading batches…</p> : items.length ? <div className="divide-y divide-background-200 rounded-xl border border-background-200 bg-background-50">
        {items.map(b => <Link key={b.id} to={`/admin/batches/${b.id}`} className="flex items-center justify-between gap-3 p-4 hover:bg-background-100"><div><p className="font-semibold">{b.name}</p><p className="text-xs text-foreground-500">{b.intake.courseName} · {b.intake.name}</p></div><i className="ri-arrow-right-s-line" /></Link>)}</div> : <p className="text-sm text-foreground-500">No matching batches.</p>}
    </div> : null}
    {area === "unit-delivery" ? <div className="rounded-xl border border-background-200 bg-background-50 p-4">
      <h2 className="mb-3 font-semibold">Unit delivery schedule</h2>
      {!detail ? <p className="text-sm text-foreground-500">Choose an intake to see its units and delivery dates.</p> :
      <div className="divide-y divide-background-200">{detail.schedule.map(u => <div key={u.id} className="flex flex-wrap justify-between gap-2 py-3"><div><strong>{u.code}</strong><span className="ml-2 text-foreground-600">{u.name}</span></div><span className="text-xs text-foreground-500">{u.startDate} – {u.endDate}</span></div>)}</div>}
      {batchId ? <Link className="mt-4 inline-block font-semibold text-primary-600 underline" to={`/admin/batches/${batchId}`}>Edit batch unit delivery dates</Link> : null}
    </div> : null}
    {area === "timetable" ? <div className="rounded-xl border border-background-200 bg-background-50 p-4"><h2 className="mb-3 font-semibold">Weekly class timing</h2>
      {!batch ? <p className="text-sm text-foreground-500">Choose a batch to view its class times.</p> : <>
      {(batch.batch.sessions ?? []).length ? <div className="divide-y divide-background-200">{batch.batch.sessions!.map((s, i) => <div key={s.id ?? i} className="flex justify-between gap-3 py-3 text-sm"><span>{["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][s.weekday-1]} · {s.type}</span><span>{s.startTime}–{s.endTime} · {s.room ?? "Room not assigned"}</span></div>)}</div> : <p className="text-sm text-foreground-500">No class timing configured.</p>}
      <Link className="mt-4 inline-block font-semibold text-primary-600 underline" to={`/admin/batches/${batchId}`}>Edit class timing</Link></>}
    </div> : null}
    {area === "attendance" ? <div className="rounded-xl border border-background-200 bg-background-50 p-4"><h2 className="mb-3 font-semibold">Class attendance</h2>
      {!batch ? <p className="text-sm text-foreground-500">Choose a batch to see its enrolled students.</p> : <>
        <p className="text-sm text-foreground-600">{batch.batch.students.length} students enrolled in {batch.batch.name}.</p>
        <p className="mt-2 text-sm text-amber-800">Attendance marking is unavailable until dated class sessions and an attendance register are configured. No attendance has been recorded.</p>
        <div className="mt-3 divide-y divide-background-200">{batch.batch.students.map(s => <p key={s.enrolmentId} className="py-2 text-sm">{s.name}</p>)}</div>
      </>}
    </div> : null}
  </div>;
}
