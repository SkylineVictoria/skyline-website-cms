import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import BatchTimingDrawer from "@/pages/admin/components/rto/BatchTimingDrawer";
import { rto, rtoFlow, type RtoCourse, type RtoIntake, type IntakeDetail, type BatchPageData, type StaffOption } from "@/pages/admin/lib/rto";

const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const sectionHeading = "text-xs font-semibold uppercase tracking-wide text-foreground-500";
const inputClass = "rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
const listRow = (selected: boolean) => "flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors " + (selected ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100");
const dot = (tone: "green" | "amber" | "grey", title: string) =>
  <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (tone === "green" ? "bg-green-500" : tone === "amber" ? "bg-amber-500" : "bg-background-300")} title={title} />;
const emptyRow = "px-3 py-2 text-xs text-foreground-500";

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
  const [trainers, setTrainers] = useState<StaffOption[]>([]);
  const [unitTrainers, setUnitTrainers] = useState<Record<string,string>>({});
  const [canEdit, setCanEdit] = useState(false);
  const [editor, setEditor] = useState<"edit" | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [courseQuery, setCourseQuery] = useState("");
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
  useEffect(() => {
    setUnitTrainers({});
    if (!batchId) return;
    let active = true;
    supabase.rpc("rto_batch_unit_trainers_get", { p_batch_id: batchId }).then(({ data, error }) => {
      if (active) { if (error) setError(error.message); else setUnitTrainers((data ?? {}) as Record<string,string>); }
    });
    return () => { active = false; };
  }, [batchId]);
  const setUnitTrainer = async (unitId: string, trainerId: string) => {
    if (!batchId) return;
    setSaving(unitId); setError("");
    try {
      const { error } = await supabase.rpc("rto_batch_unit_trainer", {
        p_batch_id: batchId, p_intake_unit_id: unitId, p_staff_id: trainerId || null,
      });
      if (error) throw error;
      setUnitTrainers(prev => ({ ...prev, [unitId]: trainerId }));
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save trainer"); }
    finally { setSaving(""); }
  };
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
  useEffect(() => {
    let active = true;
    rto<StaffOption[]>("staff_list").then(rows => { if (active) setTrainers(rows); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load trainers"); });
    return () => { active = false; };
  }, []);
  const assignTrainer = async (trainerId: string) => {
    if (!batchId || !batchDetail || !trainerId) return;
    const ids = batchDetail.batch.trainers.map(t => t.id);
    if (ids.includes(trainerId)) return;
    setSaving("trainer"); setError("");
    try {
      await rtoFlow("batch_trainers_set", { batchId, trainerIds: [...ids, trainerId] });
      setBatchDetail(await rtoFlow<BatchPageData>("batch_get", { batchId }));
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to assign trainer"); }
    finally { setSaving(""); }
  };
  const removeTrainer = async (trainerId: string) => {
    if (!batchId || !batchDetail) return;
    setSaving("trainer"); setError("");
    try {
      await rtoFlow("batch_trainers_set", { batchId, trainerIds: batchDetail.batch.trainers.filter(t => t.id !== trainerId).map(t => t.id) });
      setBatchDetail(await rtoFlow<BatchPageData>("batch_get", { batchId }));
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to remove trainer"); }
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
  const visibleCourses = courses.filter(c => (c.label + " " + c.code).toLowerCase().includes(courseQuery.trim().toLowerCase()));
  const shown = batchDetail && batchDetail.batch.id === batchId ? batchDetail.batch : null;
  const facts: [string, string][] = shown ? [
    ["Intake", selectedIntake?.name ?? "—"],
    ["Units", String(shown.schedule?.length ?? 0)],
    ["Trainers", String(shown.trainers.length)],
    ["Capacity", shown.capacity === null ? "—" : String(shown.capacity)],
  ] : [];
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header>
      <h1 className="font-heading text-2xl font-bold text-foreground-950">Batches</h1>
      <p className="text-sm text-foreground-500">Unit dates and trainers for each batch.</p>
    </header>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}<button className="ml-3 underline" onClick={() => void refresh()}>Retry</button></div>}
    <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]" role="region" aria-label="Batch management columns" tabIndex={0}>
      <div className={card + " space-y-4 p-3"}>
        <section aria-label="Courses">
          <label className="relative block"><span className="sr-only">Search courses</span>
            <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
            <input value={courseQuery} onChange={e => setCourseQuery(e.target.value)} placeholder="Search code or name" className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" />
          </label>
          <div className="mt-2 max-h-[40vh] space-y-1 overflow-auto">
            {loading && !courses.length ? <p className={emptyRow}>Loading…</p> : null}
            {visibleCourses.map(c => <button type="button" key={c.id} className={listRow(courseId === c.id)} aria-pressed={courseId === c.id} onClick={() => {setCourseId(c.id);setEditor(null);}}>
              {dot(c.isActive ? "green" : "grey", c.isActive ? "Active" : "Inactive")}
              <span className="min-w-0"><span className="block text-sm font-semibold text-foreground-950">{c.code}</span>
                <span className="block truncate text-xs text-foreground-600">{c.name}</span></span>
            </button>)}
            {!loading && !visibleCourses.length && <p className={emptyRow}>No courses found.</p>}
          </div>
        </section>
        <section aria-label="Intakes" className="border-t border-background-200 pt-3">
          <h2 className={sectionHeading + " px-1"}>Intakes</h2>
          <div className="mt-2 space-y-1">{courseIntakes.map(i => <button type="button" key={i.id} className={listRow(intakeId === i.id)} aria-pressed={intakeId === i.id} onClick={() => {setIntakeId(i.id);setEditor(null);}}>
            {dot(i.status === "open" ? "green" : i.status === "full" ? "amber" : "grey", i.status)}
            <span className="min-w-0 truncate text-sm font-semibold text-foreground-950">{i.name}</span>
          </button>)}</div>
          {!loading && !courseIntakes.length && <p className={emptyRow}>No intakes for this course.</p>}
        </section>
        <section aria-label="Batches" className="border-t border-background-200 pt-3">
          <div className="flex items-center justify-between gap-2 px-1"><h2 className={sectionHeading}>Batches</h2>
            {canEdit && intakeId && <button type="button" className="text-xs font-semibold text-primary-700 hover:underline" onClick={() => {setAdding(true);setEditor(null);}}>+ Add</button>}</div>
          {adding && <div className="mt-2 space-y-2 rounded-lg bg-background-100 p-2">
            <label className="block text-xs text-foreground-500">New batch name<input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. G1" className={inputClass + " mt-1 w-full"} /></label>
            <div className="flex items-center gap-2"><button type="button" disabled={!!saving || !newName.trim()} onClick={() => void createBatch()} className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{saving === "new" ? "Creating…" : "Create batch"}</button><button type="button" onClick={() => setAdding(false)} className="text-xs text-foreground-600 hover:underline">Cancel</button></div>
          </div>}
          <div className="mt-2 space-y-1">{batches.map(b => <button type="button" key={b.id} className={listRow(batchId === b.id)} aria-pressed={batchId === b.id} onClick={() => {setBatchId(b.id);setEditor(null);setAdding(false);}}>
            {dot(b.isActive ? "green" : "grey", b.isActive ? "Active" : "Inactive")}
            <span className="min-w-0 truncate text-sm font-semibold text-foreground-950">{b.name}</span>
          </button>)}</div>
          {!loading && !batches.length && <p className={emptyRow}>No batches for this intake.</p>}
        </section>
      </div>
      <section className={card + " min-w-0 p-5"} aria-label="Batch unit allocations">
        {!batchId ? <p className="py-10 text-center text-sm text-foreground-500">{loading ? "Loading…" : "Select a batch."}</p> : !shown ? <p className="py-10 text-center text-sm text-foreground-500">Loading units…</p> : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={sectionHeading}>Batch</p>
                <h2 className="font-heading text-xl font-bold text-foreground-950">{shown.name}</h2>
              </div>
              {canEdit && <button type="button" className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100" onClick={() => setEditor("edit")}>Edit batch timing</button>}
            </div>
            <dl className="mt-4 grid grid-cols-2 rounded-lg border border-background-200 sm:grid-cols-4 sm:divide-x sm:divide-background-200">
              {facts.map(([label, value]) => <div key={label} className="px-3 py-2">
                <dt className="text-xs text-foreground-500">{label}</dt><dd className="truncate text-sm font-semibold text-foreground-950">{value}</dd>
              </div>)}
            </dl>

            <h3 className={sectionHeading + " mt-6"}>Trainers</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {shown.trainers.map(t => <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full bg-background-200 px-2.5 py-0.5 text-xs font-semibold text-foreground-700">{t.name}{canEdit && <button type="button" disabled={!!saving} aria-label={`Remove ${t.name}`} className="text-foreground-500 hover:text-red-700 disabled:opacity-50" onClick={() => void removeTrainer(t.id)}><i className="ri-close-line" aria-hidden="true" /></button>}</span>)}
              {!shown.trainers.length && <span className="text-sm text-foreground-500">No trainers yet.</span>}
              <select aria-label="Assign batch trainer" className={inputClass + " w-full sm:ml-auto sm:w-56"} value="" disabled={!canEdit || !!saving} onChange={e => void assignTrainer(e.target.value)}>
                <option value="">Add trainer…</option>
                {trainers.filter(t => !shown.trainers.some(x => x.id === t.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>

            <h3 className={sectionHeading + " mt-6"}>Units</h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">
                  <th className="px-3 py-2">Unit</th><th className="px-3 py-2">Start</th><th className="px-3 py-2">End</th><th className="px-3 py-2">Trainer</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {(shown.schedule ?? []).map(u => <UnitAllocationRow key={u.intakeUnitId} unit={u}
                    disabled={!canEdit || !!saving} saving={saving === u.intakeUnitId}
                    trainers={shown.trainers} trainerId={unitTrainers[u.intakeUnitId] ?? ""}
                    onTrainerChange={id => void setUnitTrainer(u.intakeUnitId,id)}
                    onSave={(start,end) => void saveDates(u.intakeUnitId,start,end)} />)}
                </tbody>
              </table>
              {!(shown.schedule ?? []).length && <p className="py-10 text-center text-sm text-foreground-500">No units in this intake.</p>}
            </div>
            <p className="mt-2 text-xs text-foreground-500">Pick a unit trainer from the trainers added above.</p>
          </>
        )}
      </section>
    </div>
    {editor && detail && canEdit && <BatchTimingDrawer key={`${intakeId}:${editor}:${editor === "edit" ? batchId : "new"}`}
      intake={detail.intake} batches={detail.batches}
      batch={editor === "edit" ? detail.batches.find(b => b.id === batchId) ?? null : null}
      onClose={() => setEditor(null)}
      onSaved={out => { setEditor(null); setDetail(out); setCourseId(out.intake.courseId); setIntakeId(out.intake.id); setBatchId(out.batchId); void refresh(); }} />}
  </div>;
}

function UnitAllocationRow({ unit, disabled, saving, trainers, trainerId, onTrainerChange, onSave }: {
  unit: { intakeUnitId: string; code: string; name: string; startDate: string; endDate: string };
  disabled: boolean; saving: boolean; trainers: {id:string;name:string}[]; trainerId: string; onTrainerChange: (id:string) => void; onSave: (start: string, end: string) => void;
}) {
  const [start, setStart] = useState(unit.startDate);
  const [end, setEnd] = useState(unit.endDate);
  useEffect(() => { setStart(unit.startDate); setEnd(unit.endDate); }, [unit.startDate, unit.endDate]);
  const changed = start !== unit.startDate || end !== unit.endDate;
  const field = "rounded-lg border border-background-300 bg-background-50 px-2 py-1.5 text-sm disabled:opacity-60";
  return <tr className="border-b border-background-100 align-middle hover:bg-background-100">
    <td className="max-w-[260px] px-3 py-2"><span className="block font-semibold text-foreground-950">{unit.code}</span><span className="block truncate text-xs text-foreground-600" title={unit.name}>{unit.name}</span></td>
    <td className="px-3 py-2"><label><span className="sr-only">Start date</span><input type="date" value={start} disabled={disabled} onChange={e => setStart(e.target.value)} className={field} /></label></td>
    <td className="px-3 py-2"><label><span className="sr-only">End date</span><input type="date" value={end} disabled={disabled} onChange={e => setEnd(e.target.value)} className={field} /></label></td>
    <td className="px-3 py-2">
      <select aria-label={`Trainer for ${unit.code}`} value={trainerId} disabled={disabled} onChange={e => onTrainerChange(e.target.value)} className={field + " min-w-[150px]"}>
        <option value="">Select trainer…</option>
        {trainers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </td>
    <td className="px-3 py-2 text-right">{changed && <button type="button" disabled={disabled || !start || !end || start > end} onClick={() => onSave(start,end)} className="whitespace-nowrap rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{saving ? "Saving…" : "Save dates"}</button>}</td>
  </tr>;
}
