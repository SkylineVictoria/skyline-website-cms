import { useCallback, useEffect, useMemo, useState } from "react";
import { generateClassSessions, loadClassSessions, updateClassSession, type ClassSession, type SessionClash } from "@/pages/admin/lib/rto";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(s + "T00:00:00Z");
/** Monday of the week that holds the date. */
const monday = (d: Date) => new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const fmtDay = (s: string) => parse(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const fmtTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const hours = (s: ClassSession) => {
  const [a, b] = [s.startTime, s.endTime].map(t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; });
  return (b - a) / 60;
};
const typeTone: Record<string, string> = {
  theory: "bg-sky-50 ring-sky-200", practical: "bg-amber-50 ring-amber-200", assessment: "bg-emerald-50 ring-emerald-200",
};

/**
 * Dated classes generated from the weekly class times, the unit order, SLIT hours, term breaks and public holidays.
 * "Batch calendar" lists one batch week by week; "Room grid" shows every batch's classes for one week by room, like the master timetable.
 */
export default function ClassSessionsPanel({ batchId, canManage }: { batchId: string; canManage: boolean }) {
  const [mode, setMode] = useState<"batch" | "rooms">("batch");
  const [weekStart, setWeekStart] = useState(() => monday(new Date(iso(new Date()) + "T00:00:00Z")));
  const [rows, setRows] = useState<ClassSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clashes, setClashes] = useState<SessionClash[]>([]);
  const weeks = mode === "batch" ? 12 : 1;
  const from = iso(weekStart), to = iso(addDays(weekStart, weeks * 7 - 1));

  const load = useCallback(async () => {
    if (mode === "batch" && !batchId) { setRows([]); return; }
    setLoading(true);
    try { setRows(await loadClassSessions(mode === "batch" ? batchId : null, from, to)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to load classes"); }
    finally { setLoading(false); }
  }, [mode, batchId, from, to]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setClashes([]); setNotice(""); }, [batchId]);

  const generate = async () => {
    if (!batchId || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const out = await generateClassSessions(batchId);
      setClashes(out.clashes);
      setNotice(`${out.created} classes scheduled from ${fmtDay(out.from)}${out.endDate ? `, last class ${fmtDay(out.endDate)}` : ""}.${out.kept ? ` ${out.kept} earlier or hand-changed classes kept.` : ""}`);
      setWeekStart(monday(parse(out.from)));
      if (mode !== "batch") setMode("batch"); else await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to generate classes"); }
    finally { setBusy(false); }
  };
  const toggle = async (s: ClassSession) => {
    try {
      const out = await updateClassSession(s.id, { status: s.status === "cancelled" ? "scheduled" : "cancelled" });
      setClashes(out.clashes); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to change the class"); }
  };

  const byWeek = useMemo(() => {
    const map = new Map<string, ClassSession[]>();
    for (const s of rows) { const k = iso(monday(parse(s.date))); map.set(k, [...(map.get(k) ?? []), s]); }
    return [...map.entries()];
  }, [rows]);
  const rooms = useMemo(() => [...new Set(rows.map(r => r.room ?? "No room"))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [rows]);
  const scheduledHours = rows.filter(r => r.status === "scheduled").reduce((t, r) => t + hours(r), 0);

  const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  const navButton = "rounded-lg border border-background-300 px-2.5 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100";
  return <section className={card + " min-w-0 p-5 print:border-0 print:shadow-none"}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="font-heading text-lg font-bold text-foreground-950">Dated classes</h2>
        <p className="text-xs text-foreground-500">Built from the weekly class times, unit order and SLIT hours. Term breaks and confirmed public holidays are skipped.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <div className="inline-flex rounded-lg border border-background-300 p-0.5">
          {([["batch", "Batch calendar"], ["rooms", "Room grid"]] as const).map(([v, label]) => <button key={v} type="button" aria-pressed={mode === v} onClick={() => setMode(v)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${mode === v ? "bg-primary-600 text-white" : "text-foreground-600 hover:bg-background-100"}`}>{label}</button>)}
        </div>
        <button type="button" onClick={() => window.print()} className={navButton}>Print</button>
        {canManage && batchId && <button type="button" disabled={busy} onClick={() => void generate()}
          title="Rebuilds this batch's classes from today. Earlier classes and classes you changed by hand are kept."
          className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Generating…" : "Generate classes"}</button>}
      </div>
    </div>

    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm print:hidden">
      <button type="button" className={navButton} onClick={() => setWeekStart(addDays(weekStart, -7 * weeks))} aria-label="Earlier">‹</button>
      <button type="button" className={navButton} onClick={() => setWeekStart(monday(new Date(iso(new Date()) + "T00:00:00Z")))}>This week</button>
      <button type="button" className={navButton} onClick={() => setWeekStart(addDays(weekStart, 7 * weeks))} aria-label="Later">›</button>
      <span className="text-foreground-600">{fmtDay(from)} – {fmtDay(to)}</span>
      {mode === "batch" && rows.length > 0 && <span className="text-xs text-foreground-500">· {rows.length} classes · {scheduledHours} hours</span>}
    </div>

    {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    {notice && <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
    {clashes.length > 0 && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <strong>{clashes.length} room {clashes.length === 1 ? "clash" : "clashes"}.</strong>{" "}
      {clashes.slice(0, 4).map(c => `${c.room} on ${fmtDay(c.date)} ${fmtTime(c.startTime)} is also booked by ${c.otherBatch}`).join("; ")}{clashes.length > 4 ? "; …" : "."}
    </div>}

    <div className="mt-4">
      {loading ? <p className="py-8 text-center text-sm text-foreground-500">Loading…</p>
      : mode === "batch" && !batchId ? <p className="py-8 text-center text-sm text-foreground-500">Select a batch.</p>
      : !rows.length ? <p className="py-8 text-center text-sm text-foreground-500">{mode === "batch" ? (canManage ? "No classes in these weeks. Set the weekly class times, then Generate classes." : "No classes in these weeks.") : "No classes booked this week."}</p>
      : mode === "batch" ? <div className="space-y-4">
        {byWeek.map(([wk, list]) => <div key={wk} className="break-inside-avoid">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-500">Week of {fmtDay(wk)}</h3>
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><tbody>
            {list.map(s => <tr key={s.id} className={`border-b border-background-100 ${s.status === "cancelled" ? "text-foreground-400 line-through" : ""}`}>
              <td className="w-32 px-2 py-1.5 font-medium">{fmtDay(s.date)}</td>
              <td className="w-44 px-2 py-1.5">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</td>
              <td className="w-28 px-2 py-1.5"><span className={`rounded-full px-2 py-0.5 text-xs capitalize ring-1 ${typeTone[s.type] ?? ""}`}>{s.type}</span></td>
              <td className="px-2 py-1.5"><strong>{s.unitCode ?? "—"}</strong> <span className="text-foreground-600">{s.unitName ?? ""}</span></td>
              <td className="w-32 px-2 py-1.5 text-foreground-600">{s.room ?? "No room"}</td>
              <td className="w-28 px-2 py-1.5 text-right print:hidden">{s.manual && <span className="mr-2 text-xs text-foreground-400">edited</span>}
                {canManage && <button type="button" onClick={() => void toggle(s)} className="text-xs font-semibold text-primary-700 no-underline hover:underline">{s.status === "cancelled" ? "Restore" : "Cancel"}</button>}</td>
            </tr>)}
          </tbody></table></div>
        </div>)}
      </div>
      : <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] table-fixed border-collapse text-left text-xs">
          <thead><tr>
            <th className="w-28 border border-background-200 bg-background-100 px-2 py-1.5">Room</th>
            {Array.from({ length: 7 }, (_, i) => iso(addDays(weekStart, i))).map(d => <th key={d} className="border border-background-200 bg-background-100 px-2 py-1.5">{fmtDay(d)}</th>)}
          </tr></thead>
          <tbody>{rooms.map(room => <tr key={room}>
            <th className="border border-background-200 px-2 py-1.5 align-top font-semibold">{room}</th>
            {Array.from({ length: 7 }, (_, i) => iso(addDays(weekStart, i))).map(d => {
              const cell = rows.filter(r => (r.room ?? "No room") === room && r.date === d && r.status === "scheduled");
              return <td key={d} className="border border-background-200 p-1 align-top"><div className="space-y-1">
                {cell.map(s => <div key={s.id} className={`rounded px-1.5 py-1 ring-1 ${typeTone[s.type] ?? ""} ${cell.some(o => o !== s && o.startTime < s.endTime && s.startTime < o.endTime) ? "ring-2 ring-red-500" : ""}`}>
                  <strong className="block">{s.courseCode} {s.batch}</strong>
                  <span className="block">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</span>
                  {s.trainers && <span className="block truncate text-foreground-600">{s.trainers}</span>}
                </div>)}
              </div></td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>}
    </div>
  </section>;
}
