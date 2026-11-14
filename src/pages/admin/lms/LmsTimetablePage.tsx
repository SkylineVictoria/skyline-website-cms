import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import BatchTimingDrawer from "@/pages/admin/components/rto/BatchTimingDrawer";
import { rto, rtoFlow, type BatchPageData, type IntakeDetail, type RtoCourse, type RtoIntake, type BatchSession } from "@/pages/admin/lib/rto";

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
  const [editor, setEditor] = useState(false);
  const [view, setView] = useState<"week" | "list">("week");
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
      // Prefer a course with an intake so the timetable opens with usable selections.\n      setCourseId(prev => c.some(x => x.id === prev) ? prev : c.find(x => i.some(t => t.courseId === x.id))?.id ?? c[0]?.id ?? "");
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load timetable"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const courseIntakes = useMemo(() => intakes.filter(i => i.courseId === courseId), [intakes, courseId]);
  useEffect(() => { setIntakeId(prev => courseIntakes.some(i => i.id === prev) ? prev : courseIntakes[0]?.id ?? ""); }, [courseIntakes]);
  const intake = courseIntakes.find(i => i.id === intakeId);
  // The intake list may omit batchList; intake_get provides the authoritative batches.\n  const batches = useMemo(() => {\n    if (detail?.intake.id === intakeId) return detail.batches;\n    return intake?.batchList ?? [];\n  }, [detail, intake, intakeId]);\n  useEffect(() => {\n    if (!intakeId) { setBatchId(""); return; }\n    // Wait for intake_get before selecting a default, so missing batchList cannot leave the selector empty.\n    if (detail?.intake.id !== intakeId) return;\n    setBatchId(prev => batches.some(b => b.id === prev) ? prev : batches[0]?.id ?? "");\n  }, [batches, detail, intakeId]);
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
  const canManage = canEdit && !!data && !!detail && detail.intake.id === intakeId;
  const selectClass = () => { if (canManage) setEditor(true); };
  const selectClassButton = (label: string) => <button type="button" disabled={!canManage} onClick={selectClass} className="rounded-md border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-50">{label}</button>;
  const inputClass = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  return <div className="mx-auto max-w-7xl space-y-5 pb-10">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Learning Management</p>
        <h1 className="font-heading text-3xl font-bold text-foreground-950">Timetable</h1>
        <p className="mt-1 text-sm text-foreground-600">Weekly recurring class times from the selected batch.</p></div>
      {canManage && <button type="button" onClick={selectClass} className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white">+ Add / Edit Class</button>}
    </div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button type="button" className="ml-3 underline" onClick={() => { void reload(); void refreshBatch(); }}>Retry</button></div>}
    <div className="grid gap-3 rounded-xl border border-background-200 bg-background-50 p-4 md:grid-cols-3">
      <label className="space-y-1 text-sm font-medium">Course
        <select className={inputClass} value={courseId} onChange={e => setCourseId(e.target.value)}><option value="">Select course</option>{courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      </label>
      <label className="space-y-1 text-sm font-medium">Intake
        <select className={inputClass} value={intakeId} onChange={e => setIntakeId(e.target.value)}><option value="">Select intake</option>{courseIntakes.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
      </label>
      <label className="space-y-1 text-sm font-medium">Batch
        <select className={inputClass} value={batchId} onChange={e => setBatchId(e.target.value)}><option value="">Select batch</option>{batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      </label>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="inline-flex rounded-lg border border-background-300 bg-background-50 p-1">
        {(["week", "list"] as const).map(v => <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v}
          className={`rounded-md px-4 py-2 text-sm font-semibold ${view === v ? "bg-primary-500 text-white" : "text-foreground-700 hover:bg-background-100"}`}>{v === "week" ? "Weekly View" : "List View"}</button>)}
      </div>
      <p className="text-xs text-foreground-500">Recurring weekly pattern · not individual dated occurrences</p>
    </div>
    {loading ? <p className="text-sm text-foreground-500">Loading timetable…</p> : !batchId ? <p className="rounded-xl border border-background-200 p-6 text-sm text-foreground-500">Select a course, intake and batch to view class times.</p> : !data ? <p className="text-sm text-foreground-500">Loading batch schedule…</p> : <>
      {view === "week" ? <div className="overflow-x-auto rounded-xl border border-background-200 bg-background-50">
        <div className="grid min-w-[760px] grid-cols-7 divide-x divide-background-200">
          {DAYS.map((day, i) => <section key={day} className="min-h-52 p-2.5">
            <h2 className="mb-3 border-b border-background-200 pb-2 text-center text-xs font-bold text-foreground-700">{day}</h2>
            <div className="space-y-2">{sessions.filter(s => s.weekday === i + 1).map((s, j) =>
              <button key={s.id ?? j} type="button" disabled={!canManage} onClick={selectClass}
                className="w-full rounded-lg border-l-4 border-primary-500 bg-primary-50 p-2.5 text-left text-xs text-foreground-900 disabled:cursor-default">
                <strong className="block">{shortTime(s.startTime)} – {shortTime(s.endTime)}</strong>
                <span className="mt-1 block capitalize">{s.type}</span>
                <span className="mt-1 block text-foreground-600">{s.room || "Room not assigned"}</span>
              </button>)}</div>
          </section>)}
        </div>
      </div> : <div className="overflow-x-auto rounded-xl border border-background-200 bg-background-50">
        <table className="w-full min-w-[600px] text-left text-sm"><thead className="border-b border-background-200 bg-background-100"><tr>
          {["Day", "Time", "Session type", "Room", "Action"].map(x => <th key={x} className="px-4 py-3 font-semibold">{x}</th>)}
        </tr></thead><tbody className="divide-y divide-background-200">{sessions.map((s, i) => <tr key={s.id ?? i}>
          <td className="px-4 py-3">{dayName(s.weekday)}</td><td className="px-4 py-3">{shortTime(s.startTime)} – {shortTime(s.endTime)}</td>
          <td className="px-4 py-3 capitalize">{s.type}</td><td className="px-4 py-3">{s.room || "Not assigned"}</td>
          <td className="px-4 py-3">{canManage && <button type="button" onClick={selectClass} className="font-semibold text-primary-600 hover:underline">Edit</button>}</td>
        </tr>)}</tbody></table>
      </div>}
      {!sessions.length && <div className="rounded-lg border border-dashed border-background-300 p-5 text-center">
        <p className="text-sm text-foreground-500">No class times have been saved for this batch.</p>
        {canManage && <div className="mt-3">{selectClassButton("Set class timing")}</div>}
      </div>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-500">
        <span>{sessions.length} weekly class {sessions.length === 1 ? "slot" : "slots"} · {data.batch.trainers.length} assigned trainers</span>
        <Link className="font-semibold text-primary-600 hover:underline" to="/admin/lms/batch-allocation">View batch allocation</Link>
      </div>
    </>}
    {editor && detail && data && canManage && <BatchTimingDrawer key={batchId} intake={detail.intake} batches={detail.batches} batch={data.batch}
      onClose={() => setEditor(false)}
      onSaved={out => { setEditor(false); setDetail(out); void refreshBatch(); void reload(); }} />}
  </div>;
}
