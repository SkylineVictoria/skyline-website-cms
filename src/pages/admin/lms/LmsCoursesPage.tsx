import { useCallback, useEffect, useMemo, useState } from "react";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import IntakeSheet from "@/pages/admin/components/rto/IntakeSheet";
import { rto, type IntakeDetail, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";

/** LMS course workspace: academic delivery overview, not the Master Data course editor. */
export default function LmsCoursesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [createIntake, setCreateIntake] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [activeIntakeId, setActiveIntakeId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cs, is, role] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        rto<RtoIntake[]>("intake_list"),
        rto<{rtoManager:boolean}>("me"),
      ]);
      setCourses(cs); setIntakes(is); setCanEdit(role.rtoManager); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load courses."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const visible = useMemo(() => courses.filter(c => (c.label + " " + c.code).toLowerCase().includes(query.toLowerCase())), [courses, query]);
  const selected = courses.find(c => c.id === selectedId);
  const runs = intakes.filter(i => i.courseId === selectedId);
  return <div className="mx-auto max-w-6xl space-y-5 pb-10">
    <header><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Learning Management</p>
      <h1 className="mt-1 font-heading text-3xl font-bold">Course delivery</h1>
      <p className="mt-2 text-sm text-foreground-600">Choose an existing academic course, review its intakes and manage delivery. Course definitions remain in Master Data.</p>
    </header>
    {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button className="ml-3 underline" onClick={() => void load()}>Retry</button></div> : null}
    <div className="grid gap-5 lg:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]">
      <section className="rounded-xl border border-background-200 bg-background-50 p-4">
        <label className="block text-sm font-semibold" htmlFor="lms-course-search">Find a course</label>
        <input id="lms-course-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search code or course" className="mt-2 w-full rounded-lg border border-background-300 bg-background-50 p-2 text-sm" />
        <div className="mt-3 max-h-[560px] space-y-2 overflow-auto">
          {loading ? <p className="text-sm">Loading courses…</p> : visible.length === 0 ? <p className="text-sm text-foreground-500">No matching courses.</p> : visible.map(c => {
            const count = intakes.filter(i => i.courseId === c.id).length;
            return <button type="button" key={c.id} aria-pressed={selectedId === c.id} onClick={() => setSelectedId(c.id)} className={`w-full rounded-lg border p-3 text-left hover:border-primary-500 ${selectedId === c.id ? "border-primary-500 bg-background-100" : "border-background-200"}`}>
              <span className="block text-sm font-semibold">{c.label}</span>
              <span className="mt-1 block text-xs text-foreground-500">{count} intake{count === 1 ? "" : "s"} · {c.isActive ? "Active" : "Inactive"}</span>
            </button>;
          })}
        </div>
      </section>
      <section className="min-w-0 space-y-4">
        {!selected ? <div className="rounded-xl border border-dashed border-background-300 p-10 text-center text-foreground-600">Select a course to view its learning delivery.</div> : <>
          <div className="rounded-xl border border-background-200 bg-background-50 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div>
              <p className="text-xs font-semibold uppercase text-foreground-500">Academic course</p>
              <h2 className="mt-1 text-xl font-bold">{selected.label}</h2>
              <p className="mt-1 text-sm text-foreground-600">{selected.code} · {selected.isActive ? "Active" : "Inactive"}</p>
            </div>{canEdit ? <button type="button" onClick={() => setCreateIntake(true)} className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-background-50">+ Create intake</button> : null}</div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-background-100 p-3"><p className="text-xs text-foreground-500">Intakes</p><p className="text-2xl font-bold">{runs.length}</p></div>
              <div className="rounded-lg bg-background-100 p-3"><p className="text-xs text-foreground-500">Batches</p><p className="text-2xl font-bold">{runs.reduce((sum, i) => sum + (i.batchList?.length ?? 0), 0)}</p></div>
            </div>
          </div>
          <div className="rounded-xl border border-background-200 bg-background-50 p-5">
            <h3 className="font-semibold">Intakes and delivery</h3>
            {runs.length ? <div className="mt-3 divide-y divide-background-200">{runs.map(i => <div key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div><p className="font-medium">{i.name}</p><p className="text-xs text-foreground-500">{i.startDate} – {i.endDate} · {i.batchList?.length ?? 0} batches</p></div>
              <button type="button" onClick={() => setActiveIntakeId(i.id)} className="text-sm font-semibold text-primary-600">Manage batches</button>
            </div>)}</div> : <p className="mt-3 text-sm text-foreground-500">No intakes yet. Create an intake to start delivery.</p>}
          </div>
        </>}
      </section>
    </div>
    {activeIntakeId ? <IntakeSheet key={activeIntakeId} intakeId={activeIntakeId} canEdit={canEdit} canEnrol={canEdit} startTab="batches" onClose={() => setActiveIntakeId("")} onChanged={() => void load()} onDuplicate={() => { setActiveIntakeId(""); void load(); }} onDelete={() => { setActiveIntakeId(""); void load(); }} /> : null}
    <NewIntakeDrawer open={createIntake && canEdit} onClose={() => setCreateIntake(false)} courses={courses.map(c => ({id:c.id,label:c.label}))} courseId={selectedId || undefined}
      onCreated={(detail: IntakeDetail) => { setCreateIntake(false); setSelectedId(detail.intake.courseId); void load(); }} />
  </div>;
}
