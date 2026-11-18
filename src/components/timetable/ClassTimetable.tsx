import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import TrainerAttendanceDialog from "@/components/timetable/TrainerAttendanceDialog";

type Session = { id: string; date: string; start: string; end: string; type: string; status: string; batchName: string; courseName: string; courseCode: string;
  unitCode: string | null; unitName: string | null; room: string | null; campus: string | null; trainers: string; prerequisite?: boolean };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monday = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayLabel = (d: Date) => d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" });
const TYPE_TONE: Record<string, string> = { theory: "bg-primary-100 text-primary-800", practical: "bg-amber-100 text-amber-800", assessment: "bg-indigo-100 text-indigo-800" };

/** A week of the signed-in student's or trainer's classes (my_class_schedule), Monday to Sunday, with previous / next week. */
export default function ClassTimetable({ who }: { who: "student" | "trainer" }) {
  const [start, setStart] = useState(() => monday(new Date()));
  const [rows, setRows] = useState<Session[] | null>(null);
  const [error, setError] = useState("");
  const [marking, setMarking] = useState<Session | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null); setError("");
    const range = { p_from: iso(start), p_to: iso(addDays(start, 6)) };
    // Regular classes plus the Prerequisite class (a late joiner's prerequisite units; my_prereq_classes, ignored if not available).
    Promise.all([supabase.rpc("my_class_schedule", range), supabase.rpc("my_prereq_classes", range)]).then(([main, pre]) => {
      if (!live) return;
      if (main.error) { setError(main.error.message); return; }
      const all = [...((main.data as { sessions?: Session[] } | null)?.sessions ?? []), ...(pre.error ? [] : ((pre.data as Session[] | null) ?? []))];
      setRows(all.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)));
    });
    return () => { live = false; };
  }, [start]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);
  const today = iso(new Date());
  const btn = "inline-flex items-center gap-1 rounded-md border border-background-300 bg-white px-3 py-1.5 text-sm font-medium text-foreground-800 hover:bg-background-100";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-heading text-lg font-semibold text-foreground-950">Week of {start.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}</p>
        <div className="flex gap-2">
          <button type="button" className={btn} onClick={() => setStart(addDays(start, -7))}><i className="ri-arrow-left-s-line" aria-hidden="true" />Previous</button>
          <button type="button" className={btn} onClick={() => setStart(monday(new Date()))}>This week</button>
          <button type="button" className={btn} onClick={() => setStart(addDays(start, 7))}>Next<i className="ri-arrow-right-s-line" aria-hidden="true" /></button>
        </div>
      </div>
      {error ? <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {rows === null && !error ? <p className="mt-4 text-sm text-foreground-500">Loading classes…</p> : null}
      {rows && !rows.length ? <p className="mt-4 rounded-lg border border-background-200 bg-white p-4 text-sm text-foreground-600">No classes this week.{who === "student" ? " Your classes show here once you are enrolled in a class." : " Classes of the batches and units you teach show here."}</p> : null}
      {rows && rows.length ? (
        <ol className="mt-4 space-y-3">
          {days.map((d) => {
            const list = rows.filter((r) => r.date === iso(d));
            if (!list.length) return null;
            return (
              <li key={iso(d)} className={`rounded-lg border bg-white p-3 ${iso(d) === today ? "border-primary-300 ring-1 ring-primary-200" : "border-background-200"}`}>
                <p className="mb-2 text-sm font-semibold text-foreground-900">{dayLabel(d)}{iso(d) === today ? <span className="ml-2 rounded-full bg-primary-600 px-2 py-0.5 text-xs text-white">Today</span> : null}</p>
                <ul className="space-y-2">
                  {list.map((s) => (
                    <li key={s.id} className={`flex flex-wrap items-start gap-3 rounded-md border border-background-100 p-2 ${s.status === "cancelled" ? "opacity-60" : ""}`}>
                      <span className="w-28 shrink-0 text-sm font-semibold tabular-nums text-foreground-900">{s.start} – {s.end}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-foreground-900">{s.unitCode ? `${s.unitCode} ${s.unitName ?? ""}` : s.courseName}</span>
                        <span className="block text-xs text-foreground-600">
                          {[s.courseCode || s.courseName, `Class ${s.batchName}`, s.room ? `Room ${s.room}${s.campus ? `, ${s.campus}` : ""}` : "Room not set", who === "student" && s.trainers ? `Trainer: ${s.trainers}` : ""].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      {s.status === "cancelled"
                        ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">Cancelled</span>
                        : <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${TYPE_TONE[s.type] ?? "bg-background-200 text-foreground-700"}`}>{s.type}</span>}
                      {who === "trainer" && s.status !== "cancelled" && s.unitCode && s.date <= today
                        ? <button type="button" onClick={() => setMarking(s)} className="rounded-md border border-primary-300 px-2 py-0.5 text-xs font-semibold text-primary-700 hover:bg-primary-50"><i className="ri-checkbox-circle-line" aria-hidden="true" /> Attendance</button>
                        : null}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      ) : null}
      {marking ? <TrainerAttendanceDialog sessionId={marking.id} title={`${marking.date} ${marking.start}–${marking.end} · ${marking.unitCode ?? ""} · Class ${marking.batchName}`} onClose={() => setMarking(null)} /> : null}
    </div>
  );
}
