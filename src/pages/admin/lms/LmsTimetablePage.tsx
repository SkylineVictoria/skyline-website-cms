import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import IntakeClassSetupDrawer from "@/pages/admin/components/rto/BatchTimingDrawer";
import BatchCourseCalendar from "@/pages/admin/lms/BatchCourseCalendar";
import { bestIntake, rto, rtoFlow, type BatchPageData, type IntakeDetail, type RtoCourse, type RtoIntake, type BatchSession } from "@/pages/admin/lib/rto";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayName = (n: number) => DAYS[n - 1] ?? "Unknown";
const shortTime = (t: string) => t.slice(0, 5);
const ordered = (rows: BatchSession[]) => [...rows].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));

/** A weekly recurring timetable, using the existing batch_get / batch_setup contract. */
export default function LmsTimetablePage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [data, setData] = useState<BatchPageData | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [editor, setEditor] = useState<null | { day?: number; templates?: boolean; manual?: boolean }>(null);
  const [savedNote, setSavedNote] = useState("");
  const [calendarKey, setCalendarKey] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [c, i, me] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        rto<RtoIntake[]>("intake_list"),
        rto<{ rtoManager: boolean }>("me"),
      ]);
      setCourses(c); setIntakes(i); setCanEdit(me.rtoManager);
      // Prefer a course with an intake so the timetable opens with usable selections.
      setCourseId(prev => c.some(x => x.id === prev) ? prev : c.find(x => i.some(t => t.courseId === x.id))?.id ?? c[0]?.id ?? "");
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load timetable"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const courseIntakes = useMemo(() => intakes.filter(i => i.courseId === courseId), [intakes, courseId]);
  useEffect(() => { setIntakeId(prev => courseIntakes.some(i => i.id === prev) ? prev : bestIntake(courseIntakes)); }, [courseIntakes]);
  const intake = courseIntakes.find(i => i.id === intakeId);
  // The intake list may omit batchList; intake_get provides the authoritative class group (one, same id as the intake).
  const batches = useMemo(() => {
    if (detail?.intake.id === intakeId) return detail.batches;
    return intake?.batchList ?? [];
  }, [detail, intake, intakeId]);
  useEffect(() => {
    if (!intakeId) { setBatchId(""); return; }
    // Wait for intake_get before selecting a default, so missing batchList cannot leave the selector empty.
    if (detail?.intake.id !== intakeId) return;
    setBatchId(prev => batches.some(b => b.id === prev) ? prev : batches[0]?.id ?? "");
  }, [batches, detail, intakeId]);
  useEffect(() => {
    setDetail(null);
    if (!intakeId) return;
    let live = true;
    rto<IntakeDetail>("intake_get", { intakeId }).then(d => { if (live) setDetail(d); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "Unable to load intake"); });
    return () => { live = false; };
  }, [intakeId]);
  const refreshBatch = useCallback(async () => {
    if (!batchId) { setData(null); return; }
    try {
      const result = await rtoFlow<BatchPageData>("batch_get", { batchId });
      setData(result); setError("");
    } catch (e) { setData(null); setError(e instanceof Error ? e.message : "Unable to load class timing"); }
  }, [batchId]);
  useEffect(() => { setData(null); void refreshBatch(); }, [refreshBatch]);

  const sessions = ordered(data?.batch.sessions ?? []);
  const trainerNames = (data?.batch.trainers ?? []).map(t => t.name).join(", ");
  const canManage = canEdit && !!data && !!detail && detail.intake.id === intakeId;
  const selectClass = () => { if (canManage) setEditor({}); };
  const selectClassButton = (label: string) => <button type="button" disabled={!canManage} onClick={selectClass}
    className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary-600 px-5 py-3 text-base font-semibold text-white shadow-sm hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-300 disabled:cursor-not-allowed disabled:opacity-50">
    <i className="ri-time-line text-lg" aria-hidden="true" />{label}</button>;
  const inputClass = "mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Timetable</h1>
        <p className="text-sm text-foreground-500">Set an intake's weekly class times, trainer and rooms. Term breaks and public holidays are skipped automatically.</p>
      </div>
    </header>
    {savedNote && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{savedNote}</p>}
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}<button type="button" className="ml-3 underline" onClick={() => { void reload(); void refreshBatch(); }}>Retry</button></div>}
    <div className={card + " grid gap-3 p-3 md:grid-cols-2"}>
      <label className="block text-xs font-semibold text-foreground-500">Course
        <select className={inputClass} value={courseId} onChange={e => setCourseId(e.target.value)}><option value="">Select course</option>{courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      </label>
      <label className="block text-xs font-semibold text-foreground-500">Intake
        <select className={inputClass} value={intakeId} onChange={e => setIntakeId(e.target.value)}><option value="">Select intake</option>{courseIntakes.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
      </label>
    </div>
    <section className={card + " min-w-0 p-5"}>
      {loading ? <p className="py-10 text-center text-sm text-foreground-500">Loading…</p>
      : !batchId ? <p className="py-10 text-center text-sm text-foreground-500">{intakeId ? <>This intake&apos;s classes are not set up yet. Students are placed once they are, or <a className="font-semibold text-primary-700 underline" href={`/admin/lms/intakes#${intakeId}`}>open the intake</a>.</> : "Choose a course and an intake."}</p>
      : !data ? <p className="py-10 text-center text-sm text-foreground-500">Loading class setup…</p>
      : !sessions.length ? <div className="py-8 text-center">
        <i className="ri-calendar-schedule-line text-4xl text-primary-500" aria-hidden="true" />
        <h2 className="mt-2 font-heading text-lg font-bold text-foreground-950">No class times for this intake yet</h2>
        <p className="mx-auto mt-1 max-w-xl text-sm text-foreground-600">Add the days, times, rooms and trainer, or start from a course template. The full course calendar then fills in below, from the intake start to the last class.</p>
        {canManage ? <div className="mt-4 flex flex-wrap justify-center gap-3">
          <button type="button" onClick={() => setEditor({ templates: true })}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-5 py-3 text-base font-semibold text-white shadow-sm hover:bg-primary-700">
            <i className="ri-file-copy-2-line text-lg" aria-hidden="true" />Use a course template</button>
          <button type="button" onClick={() => setEditor({ manual: true })}
            className="inline-flex items-center gap-2 rounded-lg border-2 border-primary-300 bg-background-50 px-5 py-3 text-base font-semibold text-primary-700 hover:border-primary-500 hover:bg-primary-50">
            <i className="ri-edit-2-line text-lg" aria-hidden="true" />Set the hours myself</button>
        </div> : <p className="mt-2 text-xs text-foreground-500">An RTO Manager sets the class timing.</p>}
      </div>
      : <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-lg font-bold text-foreground-950">Weekly class timing</h2>
          <p className="mt-0.5 text-sm text-foreground-600"><i className="ri-user-line mr-1" aria-hidden="true" />{trainerNames || "No trainer"}
            <Link className="ml-3 text-xs font-semibold text-primary-700 hover:underline" to={`/admin/lms/intakes#${intakeId}`}>Open the intake</Link></p>
          <ul className="mt-3 flex flex-wrap gap-2">{sessions.map((s, i) => <li key={s.id ?? i} className="rounded-lg bg-primary-50 px-3 py-1.5 text-sm text-foreground-900 ring-1 ring-primary-200">
            <strong>{dayName(s.weekday).slice(0, 3)}</strong> {shortTime(s.startTime)}–{shortTime(s.endTime)} · <span className="capitalize">{s.type}</span> · {s.room || "No room"}
          </li>)}</ul>
        </div>
        {canManage && selectClassButton("Edit class timing")}
      </div>}
    </section>
    {batchId && data && sessions.length > 0 && detail?.intake.id === intakeId && <BatchCourseCalendar key={`calendar-${batchId}`} batchId={batchId} courseId={detail.intake.courseId} intakeStart={detail.intake.startDate} intakeEnd={detail.intake.endDate}
      hasSlots={sessions.length > 0} canManage={canManage} reloadKey={calendarKey}
      onRemoved={async () => {
        await rtoFlow("batch_setup", { batchId, intakeId, sessions: [] });
        await refreshBatch(); void reload();
        setSavedNote("Course calendar and weekly class timing removed. Start again with a course template or by hand.");
      }} />}
    {editor && detail && data && canManage && <IntakeClassSetupDrawer key={`timing-${batchId}`} intake={detail.intake} batches={detail.batches} batch={data.batch}
      startDay={editor.day} showTemplates={editor.templates} startManual={editor.manual}
      onClose={() => setEditor(null)}
      onSaved={out => {
        setEditor(null); setDetail(out); void refreshBatch(); void reload();
        setSavedNote("Class timing saved."); setCalendarKey(k => k + 1);
      }} />}
  </div>;
}
