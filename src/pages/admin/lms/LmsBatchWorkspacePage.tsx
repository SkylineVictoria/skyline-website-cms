import { useCallback, useEffect, useMemo, useState } from "react";
import BatchTimingDrawer from "@/pages/admin/components/rto/BatchTimingDrawer";
import { rto, rtoFlow, type RtoCourse, type RtoIntake, type IntakeDetail, type BatchPageData } from "@/pages/admin/lib/rto";

/** Rebuilt four-column batch workspace. Existing RTO records remain authoritative. */
export default function LmsBatchWorkspacePage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [batchDetail, setBatchDetail] = useState<BatchPageData | null>(null);
  const [saving, setSaving] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [editor, setEditor] = useState<"edit" | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
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
  const batches = detail?.intake.id === intakeId ? detail.batches : selectedIntake?.batchList ?? [];
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
  useEffect(() => {
    setBatchDetail(null);
    if (!batchId) return;
    let active = true;
    rtoFlow<BatchPageData>("batch_get", { batchId }).then(d => { if (active) setBatchDetail(d); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load batch"); });
    return () => { active = false; };
  }, [batchId]);
  const createBatch = async () => {
    if (!intakeId || !newName.trim()) { setError("Enter a batch name."); return; }
    setSaving("new"); setError("");
    try {
      const out = await rtoFlow<IntakeDetail & { batchId: string }>("batch_setup", {
        batchId: null, intakeId, name: newName.trim(), sessions: [],
      });
      setDetail(out); setBatchId(out.batchId); setAdding(false); setNewName("");
      void refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to create batch"); }
    finally { setSaving(""); }
  };
  const saveDates = async (unitId: string, startDate: string, endDate: string) => {
    if (!batchId || !startDate || !endDate || startDate > endDate) { setError("End date must be on or after start date."); return; }
    setSaving(unitId); setError("");
    try {
      await rtoFlow("batch_override_set", { batchId, intakeUnitId: unitId, startDate, endDate });
      setBatchDetail(await rtoFlow<BatchPageData>("batch_get", { batchId }));
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save unit dates"); }
    finally { setSaving(""); }
  };
  const row = (selected:boolean) => `w-full rounded-lg border px-3 py-3 text-left text-sm transition hover:bg-background-100 ${selected ? "border-primary-500 bg-primary-50 font-semibold" : "border-background-200 bg-background-50"}`;
  return <div className="mx-auto max-w-7xl space-y-5 pb-10">
    <div><p className="text-xs uppercase tracking-wide text-foreground-500">Learning Management</p>
      <h1 className="font-heading text-3xl font-bold text-foreground-950">Batches · New Workspace</h1>
      <p className="mt-1 text-sm text-foreground-600">Select a course, intake and batch across the first three columns. Allocate unit dates in the fourth column.</p></div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button className="ml-3 underline" onClick={() => void refresh()}>Retry</button></div>}
    <div className="w-full pb-3" role="region" aria-label="Batch management columns" tabIndex={0}><div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(180px,1fr)_minmax(170px,0.85fr)_minmax(170px,0.8fr)_minmax(330px,2.2fr)]">
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
          {canEdit && intakeId && <button type="button" className="rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white" onClick={() => {setAdding(true);setEditor(null);}}>+ Add</button>}</div>
        {adding && <div className="mb-3 space-y-2 rounded-lg border border-primary-300 bg-primary-50 p-3">
          <label className="block text-xs font-semibold">New batch name<input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. G1" className="mt-1 w-full rounded-md border border-background-300 bg-white p-2 text-sm" /></label>
          <div className="flex gap-2"><button type="button" disabled={!!saving || !newName.trim()} onClick={() => void createBatch()} className="rounded-md bg-primary-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{saving === "new" ? "Creating…" : "Create batch"}</button><button type="button" onClick={() => setAdding(false)} className="text-xs underline">Cancel</button></div>
        </div>}
        <div className="space-y-2">{batches.map(b => <button type="button" key={b.id} className={row(batchId === b.id)} aria-pressed={batchId === b.id} onClick={() => {setBatchId(b.id);setEditor(null);setAdding(false);}}>
          <span className="flex items-center justify-between gap-2"><span>{b.name}</span>{canEdit && <span className="text-xs text-primary-600">Edit</span>}</span>
        </button>)}</div>
        {!loading && !batches.length && <p className="text-sm text-foreground-500">No batches for this intake.</p>}
      </section>
      <section className="min-w-0 rounded-xl border border-background-200 bg-background-50 p-4" aria-label="Batch unit allocations">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Unit Allocation</h2>
          {canEdit && batchId && <button type="button" className="text-xs font-semibold text-primary-600 hover:underline" onClick={() => setEditor("edit")}>Edit batch timing</button>}
        </div>
        {!batchId ? <p className="text-sm text-foreground-500">Select an existing batch, or add a new batch in column three.</p> : !batchDetail || batchDetail.batch.id !== batchId ? <p className="text-sm text-foreground-500">Loading units…</p> : (
          <>
            <p className="mb-3 text-sm text-foreground-600"><strong>{batchDetail.batch.name}</strong> · {batchDetail.batch.schedule?.length ?? 0} intake units</p>
            <div className="space-y-3">
              {(batchDetail.batch.schedule ?? []).map(u => <UnitAllocationRow key={u.intakeUnitId} unit={u}
                disabled={!canEdit || !!saving} saving={saving === u.intakeUnitId}
                onSave={(start,end) => void saveDates(u.intakeUnitId,start,end)} />)}
            </div>
            <div className="mt-4 rounded-lg bg-background-100 p-3 text-xs text-foreground-600">
              <strong>Assigned batch trainers:</strong> {batchDetail.batch.trainers.map(t => t.name).join(", ") || "None"}
              <p className="mt-1">Trainer assignment is currently batch-wide. Per-unit trainer assignments need a backend change before they can be saved reliably.</p>
            </div>
          </>
        )}
      </section>
    </div>
    </div>
    {loading && <p className="text-sm text-foreground-500">Loading…</p>}
    {editor && detail && canEdit && <BatchTimingDrawer key={`${intakeId}:${editor}:${editor === "edit" ? batchId : "new"}`}
      intake={detail.intake} batches={detail.batches}
      batch={editor === "edit" ? detail.batches.find(b => b.id === batchId) ?? null : null}
      onClose={() => setEditor(null)}
      onSaved={out => { setEditor(null); setDetail(out); setCourseId(out.intake.courseId); setIntakeId(out.intake.id); setBatchId(out.batchId); void refresh(); }} />}
  </div>;
}

function UnitAllocationRow({ unit, disabled, saving, onSave }: {
  unit: { intakeUnitId: string; code: string; name: string; startDate: string; endDate: string };
  disabled: boolean; saving: boolean; onSave: (start: string, end: string) => void;
}) {
  const [start, setStart] = useState(unit.startDate);
  const [end, setEnd] = useState(unit.endDate);
  useEffect(() => { setStart(unit.startDate); setEnd(unit.endDate); }, [unit.startDate, unit.endDate]);
  const changed = start !== unit.startDate || end !== unit.endDate;
  return <div className="rounded-lg border border-background-200 p-3">
    <p className="text-sm font-semibold text-foreground-900">{unit.code}</p>
    <p className="mb-2 text-xs text-foreground-600">{unit.name}</p>
    <div className="grid grid-cols-2 gap-2">
      <label className="text-xs text-foreground-600">Start date<input type="date" value={start} disabled={disabled} onChange={e => setStart(e.target.value)} className="mt-1 w-full rounded-md border border-background-200 bg-background-50 p-2 text-xs" /></label>
      <label className="text-xs text-foreground-600">End date<input type="date" value={end} disabled={disabled} onChange={e => setEnd(e.target.value)} className="mt-1 w-full rounded-md border border-background-200 bg-background-50 p-2 text-xs" /></label>
    </div>
    {changed && <button type="button" disabled={disabled || !start || !end || start > end} onClick={() => onSave(start,end)} className="mt-2 rounded-md bg-primary-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save dates"}</button>}
  </div>;
}
