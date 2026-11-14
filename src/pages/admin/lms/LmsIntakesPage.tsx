import { useCallback, useEffect, useMemo, useState } from "react";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import IntakeSheet from "@/pages/admin/components/rto/IntakeSheet";
import { rto, type RtoCourse, type RtoIntake, type IntakeDetail } from "@/pages/admin/lib/rto";

/** Purpose-built LMS intake selection and delivery view; Master Data remains authoritative. */
export default function LmsIntakesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courseId, setCourseId] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [addBatch, setAddBatch] = useState(false);
  const [role, setRole] = useState({ rtoManager: false, admin: false });
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [cs, is, me] = await Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list"), rto<{rtoManager:boolean;admin:boolean}>("me")]);
      setCourses(cs); setIntakes(is); setRole(me); setError("");
    } catch(e) { setError(e instanceof Error ? e.message : "Unable to load intakes."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const shown = useMemo(() => intakes.filter(i => (!courseId || i.courseId === courseId) && (i.name + " " + i.courseName).toLowerCase().includes(query.toLowerCase())), [intakes, courseId, query]);
  const selected = intakes.find(i => i.id === selectedId);
  return <div className="mx-auto max-w-6xl space-y-5 pb-10">
    <header><p className="text-xs font-semibold uppercase text-foreground-500">Learning Management</p><h1 className="mt-1 font-heading text-3xl font-bold">Intake delivery</h1><p className="mt-2 text-sm text-foreground-600">Review course runs, select an intake and manage batches without leaving the workspace.</p></header>
    {error ? <p role="alert" className="rounded-lg border border-red-200 p-3 text-red-700">{error}<button className="ml-3 underline" onClick={() => void load()}>Retry</button></p> : null}
    <div className="flex flex-wrap items-center gap-3">
      <input aria-label="Search intakes" className="min-w-48 flex-1 rounded-lg border border-background-300 p-2" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search intakes" />
      <select aria-label="Filter course" className="rounded-lg border border-background-300 p-2" value={courseId} onChange={e => setCourseId(e.target.value)}><option value="">All courses</option>{courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      {role.rtoManager ? <button className="rounded-lg bg-primary-500 px-4 py-2 font-semibold text-background-50" onClick={() => setNewOpen(true)}>+ New intake</button> : null}
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{shown.map(i => <button type="button" key={i.id} onClick={() => { setSelectedId(i.id); setAddBatch(false); }} className="rounded-xl border border-background-200 bg-background-50 p-4 text-left hover:border-primary-500">
      <p className="text-xs font-semibold uppercase text-foreground-500">{i.courseCode}</p><h2 className="mt-1 font-semibold">{i.name}</h2><p className="mt-1 text-sm text-foreground-600">{i.courseName}</p>
      <p className="mt-3 text-xs text-foreground-500">{i.startDate} – {i.endDate}</p><p className="mt-2 text-sm font-medium">{i.batchList?.length ?? 0} batches · {i.status}</p>
    </button>)}</div>
    {!shown.length ? <p className="text-sm text-foreground-500">No matching intakes.</p> : null}
    <NewIntakeDrawer open={newOpen && role.rtoManager} onClose={() => setNewOpen(false)} courses={courses.map(c => ({id:c.id,label:c.label}))} courseId={courseId || undefined}
      onCreated={(detail: IntakeDetail, createBatch: boolean) => { setNewOpen(false); setCourseId(detail.intake.courseId); setSelectedId(detail.intake.id); setAddBatch(createBatch); void load(); }} />
    {selected ? <IntakeSheet key={selected.id} intakeId={selected.id} canEdit={role.rtoManager} canEnrol={role.rtoManager || role.admin} startTab="batches" startAddBatch={addBatch} onClose={() => { setSelectedId(""); setAddBatch(false); }} onChanged={() => void load()} onDuplicate={() => { setSelectedId(""); void load(); }} onDelete={() => { setSelectedId(""); void load(); }} /> : null}
  </div>;
}
