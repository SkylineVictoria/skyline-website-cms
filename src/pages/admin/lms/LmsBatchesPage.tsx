import { useCallback, useEffect, useMemo, useState } from "react";
import BatchTimingDrawer from "@/pages/admin/components/rto/BatchTimingDrawer";
import { rto, type RtoCourse, type RtoIntake, type IntakeDetail } from "@/pages/admin/lib/rto";

/** Three-column parent/child batch workspace. All writes use the existing RTO drawer. */
export default function LmsBatchesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [editor, setEditor] = useState<"add" | "edit" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [c, i, me] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        rto<RtoIntake[]>("intake_list"),
        rto<{rtoManager:boolean}>("me"),
      ]);
      setCourses(c); setIntakes(i); setCanEdit(me.rtoManager);
      setCourseId(prev => c.some(x => x.id === prev) ? prev : c[0]?.id ?? "");
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load batches"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const courseIntakes = useMemo(() => intakes.filter(i => i.courseId === courseId), [intakes, courseId]);
  useEffect(() => {
    if (!courseIntakes.some(i => i.id === intakeId)) setIntakeId(courseIntakes[0]?.id ?? "");
  }, [courseIntakes, intakeId]);
  const selectedIntake = courseIntakes.find(i => i.id === intakeId);
  const batches = selectedIntake?.batchList ?? [];
  useEffect(() => {
    if (!batches.some(b => b.id === batchId)) setBatchId(batches[0]?.id ?? "");
  }, [batches, batchId]);
  useEffect(() => {
    setDetail(null);
    if (!intakeId) return;
    let active = true;
    rto<IntakeDetail>("intake_get", { intakeId }).then(d => { if (active) setDetail(d); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load intake"); });
    return () => { active = false; };
  }, [intakeId]);
  const row = (selected:boolean) => `w-full rounded-lg border px-3 py-3 text-left text-sm transition hover:bg-background-100 ${selected ? "border-primary-500 bg-primary-50 font-semibold" : "border-background-200 bg-background-50"}`;
  return <div className="mx-auto max-w-7xl space-y-5 pb-10">
    <div><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p>
      <h1 className="font-heading text-3xl font-bold text-foreground-950">Batch Management</h1>
      <p className="mt-1 text-sm text-foreground-600">Select a course, then an intake. Add or edit batches in the final column.</p></div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button className="ml-3 underline" onClick={() => void refresh()}>Retry</button></div>}
    <div className="grid gap-4 md:grid-cols-3">
      <section className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4" aria-label="Courses">
        <h2 className="mb-3 font-semibold">Courses</h2>
        <div className="space-y-2">{courses.map(c => <button type="button" key={c.id} className={row(courseId === c.id)} aria-pressed={courseId === c.id} onClick={() => {setCourseId(c.id);setEditor(null);}}>{c.label}</button>)}</div>
        {!loading && !courses.length && <p className="text-sm text-foreground-500">No courses found.</p>}
      </section>
      <section className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4" aria-label="Intakes">
        <h2 className="mb-3 font-semibold">Intakes</h2>
        <div className="space-y-2">{courseIntakes.map(i => <button type="button" key={i.id} className={row(intakeId === i.id)} aria-pressed={intakeId === i.id} onClick={() => {setIntakeId(i.id);setEditor(null);}}>{i.name}</button>)}</div>
        {!loading && !courseIntakes.length && <p className="text-sm text-foreground-500">No intakes for this course.</p>}
      </section>
      <section className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4" aria-label="Batches">
        <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">Batches</h2>
          {canEdit && intakeId && <button type="button" className="rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white" onClick={() => setEditor("add")}>+ Add</button>}</div>
        <div className="space-y-2">{batches.map(b => <button type="button" key={b.id} className={row(batchId === b.id)} aria-pressed={batchId === b.id} onClick={() => {setBatchId(b.id);if(canEdit)setEditor("edit");}}>
          <span className="flex items-center justify-between gap-2"><span>{b.name}</span>{canEdit && <span className="text-xs text-primary-600">Edit</span>}</span>
        </button>)}</div>
        {!loading && !batches.length && <p className="text-sm text-foreground-500">No batches for this intake.</p>}
      </section>
    </div>
    {loading && <p className="text-sm text-foreground-500">Loading…</p>}
    {editor && detail && canEdit && <BatchTimingDrawer key={`${intakeId}:${editor}:${editor === "edit" ? batchId : "new"}`}
      intake={detail.intake} batches={detail.batches}
      batch={editor === "edit" ? detail.batches.find(b => b.id === batchId) ?? null : null}
      onClose={() => setEditor(null)}
      onSaved={out => { setEditor(null); setDetail(out); setCourseId(out.intake.courseId); setIntakeId(out.intake.id); setBatchId(out.batchId); void refresh(); }} />}
  </div>;
}
