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
      // Prefer a course with an intake so the timetable opens with usable selections.
      setCourseId(prev => c.some(x => x.id === prev) ? prev : c.find(x => i.some(t => t.courseId === x.id))?.id ?? c[0]?.id ?? "");
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load timetable"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const courseIntakes = useMemo(() => intakes.filter(i => i.courseId === courseId), [intakes, courseId]);
  useEffect(() => { setIntakeId(prev => courseIntakes.some(i => i.id === prev) ? prev : courseIntakes[0]?.id ?? ""); }, [courseIntakes]);
  const intake = courseIntakes.find(i => i.id === intakeId);
  // The intake list may omit batchList; intake_get provides the authoritative batches.
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
  const canManage = canEdit && !!data && !!detail && detail.intake.id === intakeId;
  const selectClass = () => { if (canManage) setEditor(true); };
  const selectClassButton = (label: string) => <button type="button" disabled={!canManage} onClick={selectClass} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-50">{label}</button>;
  const inputClass = "mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Timetable</h1>
        <p className="text-sm text-foreground-500">Weekly recurring class times for a batch.</p>
      </div>
      {canManage && <button type="button" onClick={selectClass} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">Edit class times</button>}
    </header>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}<button type="button" className="ml-3 underline" onClick={() => { void reload(); void refreshBatch(); }}>Retry</button></div>}
    <div className={card + " grid gap-3 p-3 md:grid-cols-3"}>
      <label className="block text-xs font-semibold text-foreground-500">Course
        <select className={inputClass} value={courseId} onChange={e => setCourseId(e.target.value)}><option value="">Select course</option>{courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      </label>
      <label className="block text-xs font-semibold text-foreground-500">Intake
        <select className={inputClass} value={intakeId} onChange={e => setIntakeId(e.target.value)}><option value="">Select intake</option>{courseIntakes.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
      </label>
      <label className="block text-xs font-semibold text-foreground-500">Batch
        <select className={inputClass} value={batchId} onChange={e => setBatchId(e.target.value)}><option value="">Select batch</option>{batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      </label>
    </div>
    <section className={card + " min-w-0 p-5"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-background-300 p-0.5">
          {(["week", "list"] as const).map(v => <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${view === v ? "bg-primary-600 text-white" : "text-foreground-600 hover:bg-background-100"}`}>{v === "week" ? "Week" : "List"}</button>)}
        </div>
        {data && <div className="flex flex-wrap items-center gap-3 text-xs text-foreground-500">
          <span>{sessions.length} weekly {sessions.length === 1 ? "slot" : "slots"} · {data.batch.trainers.length} trainer{data.batch.trainers.length === 1 ? "" : "s"}</span>
          <Link className="font-semibold text-primary-700 hover:underline" to="/admin/lms/batch-allocation">Batch allocation</Link>
        </div>}
      </div>
      <div className="mt-4">
        {loading ? <p className="py-10 text-center text-sm text-foreground-500">Loading…</p> : !batchId ? <p className="py-10 text-center text-sm text-foreground-500">Select a course, intake and batch.</p> : !data ? <p className="py-10 text-center text-sm text-foreground-500">Loading batch…</p> : !sessions.length ? <div className="py-10 text-center">
          <p className="text-sm text-foreground-500">No class times saved for this batch.</p>
          {canManage && <div className="mt-3">{selectClassButton("Set class timing")}</div>}
        </div> : view === "week" ? <div className="overflow-x-auto">
          <div className="grid min-w-[760px] grid-cols-7 divide-x divide-background-200 rounded-lg border border-background-200">
            {DAYS.map((day, i) => <section key={day} className="min-h-44 p-2">
              <h2 className="mb-2 text-center text-xs font-semibold uppercase tracking-wide text-foreground-500">{day.slice(0, 3)}</h2>
              <div className="space-y-1.5">{sessions.filter(s => s.weekday === i + 1).map((s, j) =>
                <button key={s.id ?? j} type="button" disabled={!canManage} onClick={selectClass}
                  className="w-full rounded-lg bg-primary-50 px-2 py-1.5 text-left text-xs text-foreground-900 ring-1 ring-primary-200 hover:ring-primary-400 disabled:cursor-default disabled:hover:ring-primary-200">
                  <strong className="block">{shortTime(s.startTime)} – {shortTime(s.endTime)}</strong>
                  <span className="block capitalize text-foreground-700">{s.type}</span>
                  <span className="block truncate text-foreground-500">{s.room || "No room"}</span>
                </button>)}</div>
            </section>)}
          </div>
        </div> : <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm"><thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">
            {["Day", "Time", "Session type", "Room", ""].map(x => <th key={x || "action"} className="px-3 py-2">{x}</th>)}
          </tr></thead><tbody>{sessions.map((s, i) => <tr key={s.id ?? i} className="border-b border-background-100 hover:bg-background-100">
            <td className="px-3 py-2">{dayName(s.weekday)}</td><td className="px-3 py-2">{shortTime(s.startTime)} – {shortTime(s.endTime)}</td>
            <td className="px-3 py-2 capitalize">{s.type}</td><td className="px-3 py-2">{s.room || "Not assigned"}</td>
            <td className="px-3 py-2 text-right">{canManage && <button type="button" onClick={selectClass} className="font-semibold text-primary-700 hover:underline">Edit</button>}</td>
          </tr>)}</tbody></table>
        </div>}
      </div>
    </section>
    {editor && detail && data && canManage && <BatchTimingDrawer key={batchId} intake={detail.intake} batches={detail.batches} batch={data.batch}
      onClose={() => setEditor(false)}
      onSaved={out => { setEditor(false); setDetail(out); void refreshBatch(); void reload(); }} />}
  </div>;
}
