import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import BatchTimingDrawer from "@/pages/admin/components/rto/BatchTimingDrawer";
import { rto, rtoFlow, type RtoIntake, type IntakeDetail, type BatchPageData, type RtoCourse } from "@/pages/admin/lib/rto";

type Item = { id: string; name: string; intake: RtoIntake };
export default function LmsAcademicPage({ area }: { area: "batches" | "unit-delivery" | "timetable" | "attendance" }) {

  const [newIntakeOpen, setNewIntakeOpen] = useState(false);
  const [batchEditorOpen, setBatchEditorOpen] = useState(false);
  const [newBatchAfterIntake, setNewBatchAfterIntake] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [unitEdit, setUnitEdit] = useState<{intakeUnitId:string;startDate:string;endDate:string}|null>(null);
  const [savingUnit, setSavingUnit] = useState(false);
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
      const [i, c, role] = await Promise.all([rto<RtoIntake[]>("intake_list"), rto<RtoCourse[]>("course_list"), rto<{rtoManager:boolean}>("me")]);
      setIntakes(i); setCourses(c); setCanEdit(role.rtoManager); setError("");
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
  const saveUnit = async () => {
    if (!unitEdit || !batchId) return;
    if (unitEdit.endDate < unitEdit.startDate) { setError("End date cannot precede start date."); return; }
    setSavingUnit(true);
    try {
      await rtoFlow<IntakeDetail>("batch_override_set", { batchId, intakeUnitId: unitEdit.intakeUnitId, startDate: unitEdit.startDate, endDate: unitEdit.endDate });
      const updated = await rtoFlow<BatchPageData>("batch_get", { batchId });
      setBatch(updated); setUnitEdit(null); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save unit dates."); }
    finally { setSavingUnit(false); }
  };
  const titles = { batches: "Batches", "unit-delivery": "Unit Delivery", timetable: "Timetable", attendance: "Attendance" };
  const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  const field = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  const primaryBtn = "rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50";
  const secondaryBtn = "rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100";
  const sectionTitle = "text-xs font-semibold uppercase tracking-wide text-foreground-500";
  const th = "px-3 py-2";
  const tr = "border-b border-background-100 hover:bg-background-100";
  const empty = "py-10 text-center text-sm text-foreground-500";
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">{titles[area]}</h1>
        <p className="text-sm text-foreground-500">Pick a course, intake and batch.</p>
      </div>
      {canEdit ? <div className="flex flex-wrap items-center gap-2">
        <Link to="/admin/lms/courses" className={secondaryBtn}>Manage Courses</Link>
        <button type="button" onClick={() => setNewIntakeOpen(true)} className={secondaryBtn}>+ New Intake</button>
        {(area === "batches" || area === "timetable") && intakeId ? <button type="button" onClick={() => setBatchEditorOpen(true)} className={primaryBtn}>{batchId ? "Edit selected batch timing" : "Add Batch"}</button> : null}
      </div> : null}
    </header>
    {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}<button className="ml-3 underline" onClick={() => void load()}>Retry</button></div> : null}
    <div className={card + " grid gap-3 p-3 sm:grid-cols-3"}>
      <label className="space-y-1 text-xs font-semibold text-foreground-500">Course<select className={field + " font-normal text-foreground-950"} value={courseId} onChange={e => { setCourseId(e.target.value); setIntakeId(""); setBatchId(""); }}>
        <option value="">All courses</option>{courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <label className="space-y-1 text-xs font-semibold text-foreground-500">Intake<select className={field + " font-normal text-foreground-950"} value={intakeId} onChange={e => { const i = intakes.find(x => x.id === e.target.value); setIntakeId(e.target.value); if (i) setCourseId(i.courseId); setBatchId(""); }}>
        <option value="">All intakes</option>{matching.map(i => <option key={i.id} value={i.id}>{i.courseCode} · {i.name}</option>)}</select></label>
      <label className="space-y-1 text-xs font-semibold text-foreground-500">Batch<select className={field + " font-normal text-foreground-950"} value={batchId} onChange={e => { const b = items.find(x => x.id === e.target.value); setBatchId(e.target.value); if (b) { setIntakeId(b.intake.id); setCourseId(b.intake.courseId); } }}>
        <option value="">All batches</option>{items.map(b => <option key={b.id} value={b.id}>{b.intake.courseCode} · {b.name}</option>)}</select></label>
    </div>
    {batchEditorOpen && detail && canEdit ? <BatchTimingDrawer key={`${detail.intake.id}:${batchId || "new"}`} intake={detail.intake} batches={detail.batches} batch={batchId ? detail.batches.find(b => b.id === batchId) ?? null : null} onClose={() => setBatchEditorOpen(false)} onSaved={out => { setBatchEditorOpen(false); setDetail(out); setIntakeId(out.intake.id); setCourseId(out.intake.courseId); setBatchId(out.batchId); void load(); }} /> : null}
    <NewIntakeDrawer open={newIntakeOpen && canEdit} onClose={() => setNewIntakeOpen(false)} courses={courses.map(c => ({ id: c.id, label: c.label }))} courseId={courseId || undefined} onCreated={(created, addBatch) => { setNewIntakeOpen(false); setCourseId(created.intake.courseId); setIntakeId(created.intake.id); setBatchId(""); setDetail(created); setNewBatchAfterIntake(addBatch); void load(); }} />
    {newBatchAfterIntake && detail && canEdit ? <BatchTimingDrawer key={detail.intake.id} intake={detail.intake} batches={detail.batches} onClose={() => setNewBatchAfterIntake(false)} onSaved={out => { setNewBatchAfterIntake(false); setDetail(out); setCourseId(out.intake.courseId); setIntakeId(out.intake.id); setBatchId(out.batchId); void load(); }} /> : null}
    {area === "batches" ? <section className={card + " p-3"}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative block w-full sm:w-80">
          <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
          <input aria-label="Search batches" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search batches" className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" />
        </label>
        {!intakeId ?<span className="text-xs text-foreground-500">Select an intake to add a batch</span> : null}
        <span className="ml-auto text-xs text-foreground-500">{items.length} batch{items.length === 1 ? "" : "es"}</span>
      </div>
      <div className="mt-3 space-y-1">
        {loading ? <p className={empty}>Loading…</p> : items.length ? items.map(b => <button type="button" key={b.id} onClick={() => { setCourseId(b.intake.courseId); setIntakeId(b.intake.id); setBatchId(b.id); }} aria-pressed={batchId === b.id}
          className={"flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors " + (batchId === b.id ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100")}>
          <span className="min-w-0"><span className="block text-sm font-semibold text-foreground-950">{b.name}</span>
            <span className="block truncate text-xs text-foreground-600">{b.intake.courseName} · {b.intake.name}</span></span>
        </button>) : <p className={empty}>No matching batches.</p>}
      </div>
    </section> : null}
    {area === "unit-delivery" ? <section className={card + " p-5"}>
      <h2 className={sectionTitle}>Unit delivery schedule</h2>
      {!batch && !detail ? <p className={empty}>Choose an intake or batch to see its units.</p> :
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500"><th className={th}>Code</th><th className={th}>Unit</th><th className={th}>Dates</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{(batch?.batch.schedule ?? detail?.schedule ?? []).map(u => <tr key={"intakeUnitId" in u ? u.intakeUnitId : u.id} className={tr}>
          <td className={th + " font-semibold text-foreground-950"}>{u.code}</td>
          <td className={th + " text-foreground-700"}>{u.name}</td>
          <td className={th + " whitespace-nowrap text-xs text-foreground-500"}>{u.startDate} – {u.endDate}</td>
          <td className={th + " text-right"}>{batchId && canEdit && "intakeUnitId" in u ? <button type="button" className="text-sm font-semibold text-primary-700 hover:underline" onClick={() => setUnitEdit({intakeUnitId:u.intakeUnitId,startDate:u.startDate,endDate:u.endDate})}>Edit</button> : null}</td>
        </tr>)}</tbody>
      </table></div>}
      {unitEdit ? <div className="mt-4 space-y-3 border-t border-background-200 pt-4"><h3 className={sectionTitle}>Edit batch unit dates</h3>
        <div className="flex flex-wrap gap-3"><label className="space-y-1 text-xs font-semibold text-foreground-500">Start date<input type="date" className={field + " font-normal text-foreground-950"} value={unitEdit.startDate} onChange={e => setUnitEdit(v => v ? {...v,startDate:e.target.value}:v)} /></label>
        <label className="space-y-1 text-xs font-semibold text-foreground-500">End date<input type="date" className={field + " font-normal text-foreground-950"} value={unitEdit.endDate} onChange={e => setUnitEdit(v => v ? {...v,endDate:e.target.value}:v)} /></label></div>
        <div className="flex flex-wrap gap-2">
          <button disabled={savingUnit} className={primaryBtn} onClick={() => void saveUnit()}>{savingUnit ? "Saving…" : "Save unit dates"}</button>
          <button className={secondaryBtn} onClick={() => setUnitEdit(null)}>Cancel</button>
        </div>
      </div> : null}
    </section> : null}
    {area === "timetable" ? <section className={card + " p-5"}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className={sectionTitle}>Weekly class timing</h2>
        {batch && canEdit ? <button type="button" className={secondaryBtn} onClick={() => setBatchEditorOpen(true)}>Edit class timing</button> : null}</div>
      {!batch ? <p className={empty}>Choose a batch to view its class times.</p> :
        (batch.batch.sessions ?? []).length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500"><th className={th}>Day</th><th className={th}>Type</th><th className={th}>Time</th><th className={th}>Room</th></tr></thead>
          <tbody>{batch.batch.sessions!.map((s, i) => <tr key={s.id ?? i} className={tr}>
            <td className={th + " font-semibold text-foreground-950"}>{["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][s.weekday-1]}</td>
            <td className={th}>{s.type}</td>
            <td className={th + " whitespace-nowrap"}>{s.startTime}–{s.endTime}</td>
            <td className={th + (s.room ? "" : " text-foreground-500")}>{s.room ?? "Room not assigned"}</td>
          </tr>)}</tbody>
        </table></div> : <p className={empty}>No class timing configured.</p>}
    </section> : null}
    {area === "attendance" ? <section className={card + " p-5"}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className={sectionTitle}>Class attendance</h2>
        {batch ? <span className="rounded-full bg-background-200 px-2 py-0.5 text-xs font-semibold text-foreground-600">{batch.batch.students.length} students in {batch.batch.name}</span> : null}</div>
      {!batch ? <p className={empty}>Choose a batch to see its enrolled students.</p> : <>
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">Attendance marking is unavailable until dated class sessions and an attendance register are configured. No attendance has been recorded.</div>
        <ul className="mt-3 divide-y divide-background-100">{batch.batch.students.map(s => <li key={s.enrolmentId} className="px-3 py-2 text-sm text-foreground-950">{s.name}</li>)}</ul>
      </>}
    </section> : null}
  </div>;
}
