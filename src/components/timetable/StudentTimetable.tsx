import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

type Session = { id: string; date: string; start: string; end: string; type: string; status: string; batchName: string; courseName: string; courseCode: string;
  unitCode: string | null; unitName: string | null; room: string | null; campus: string | null; trainers: string };
type PlanUnit = { unitId: string; code: string; name: string; startDate: string | null; endDate: string | null };
type PlanCourse = { enrolmentId: string; courseCode: string; courseName: string; intakeStart: string | null; intakeEnd: string | null; units: PlanUnit[] };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monday = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const short = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const KIND: Record<string, string> = { theory: "bg-primary-100 text-primary-800", practical: "bg-amber-100 text-amber-800", assessment: "bg-indigo-100 text-indigo-800" };
const clock = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`; };

/**
 * Student portal › My timetable (owner, 2026-11-23: "the weekly and daily timetable the admin sees, no clutter"). Two read-only
 * views of the student's own intake: Weekly calendar (each week of the course with the unit taught in it, as the admin's CoE /
 * VoE weekly calendar) and Daily timetable (the week of classes that repeats: day, kind, time, room, trainer, as the admin's daily
 * timetable), with the next class named. Classes come from my_class_schedule (the student's own units), units from student_my_learning.
 */
export default function StudentTimetable() {
  const [view, setView] = useState<"weekly" | "daily">("weekly");
  const [plan, setPlan] = useState<PlanCourse[] | null>(null);
  const [classes, setClasses] = useState<Session[] | null>(null);
  const [error, setError] = useState("");
  const today = iso(new Date());

  useEffect(() => {
    let live = true;
    void supabase.rpc("student_my_learning").then(({ data, error: failed }) => {
      if (!live) return;
      if (failed) { setError(failed.message); setPlan([]); return; }
      setPlan(((data as { courses?: PlanCourse[] } | null)?.courses) ?? []);
    });
    const from = new Date();
    void supabase.rpc("my_class_schedule", { p_from: iso(from), p_to: iso(addDays(from, 120)) }).then(({ data, error: failed }) => {
      if (!live) return;
      if (failed) { setError(failed.message); setClasses([]); return; }
      setClasses((((data as { sessions?: Session[] } | null)?.sessions) ?? []).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)));
    });
    return () => { live = false; };
  }, []);

  // Weekly calendar: every week from the intake's start to its end, with the units taught in it.
  const weeks = useMemo(() => (plan ?? []).map((course) => {
    const dated = course.units.filter((u) => u.startDate && u.endDate);
    const first = course.intakeStart ?? dated.map((u) => u.startDate as string).sort()[0];
    const last = course.intakeEnd ?? dated.map((u) => u.endDate as string).sort().slice(-1)[0];
    if (!first || !last) return { course, rows: [] as { n: number; from: Date; to: Date; units: PlanUnit[] }[] };
    const rows: { n: number; from: Date; to: Date; units: PlanUnit[] }[] = [];
    for (let from = monday(parse(first)), n = 1; iso(from) <= last && n <= 260; from = addDays(from, 7), n++) {
      const to = addDays(from, 6);
      rows.push({ n, from, to, units: dated.filter((u) => (u.startDate as string) <= iso(to) && (u.endDate as string) >= iso(from)) });
    }
    return { course, rows };
  }), [plan]);

  // Daily timetable: the classes of a typical week (each weekday's distinct class times), from the coming weeks.
  const pattern = useMemo(() => {
    const out: Record<number, Session[]> = {};
    for (const s of classes ?? []) {
      if (s.status === "cancelled") continue;
      const day = (parse(s.date).getDay() + 6) % 7;
      const list = (out[day] ??= []);
      if (!list.some((x) => x.start === s.start && x.end === s.end && x.type === s.type && x.room === s.room)) list.push(s);
    }
    Object.values(out).forEach((list) => list.sort((a, b) => a.start.localeCompare(b.start)));
    return out;
  }, [classes]);
  const next = (classes ?? []).find((s) => s.status !== "cancelled" && s.date >= today);
  const tab = (on: boolean) => `rounded-md px-3 py-1.5 text-sm font-semibold ${on ? "bg-primary-600 text-white" : "text-foreground-700 hover:bg-background-100"}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border border-background-200 bg-white p-1" role="tablist" aria-label="Timetable">
          <button type="button" role="tab" aria-selected={view === "weekly"} className={tab(view === "weekly")} onClick={() => setView("weekly")}>Weekly calendar</button>
          <button type="button" role="tab" aria-selected={view === "daily"} className={tab(view === "daily")} onClick={() => setView("daily")}>Daily timetable</button>
        </div>
        {next ? <p className="text-sm text-foreground-700"><i className="ri-time-line mr-1 text-primary-600" aria-hidden="true" />Next class: <b>{parse(next.date).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" })}</b>, {clock(next.start)}{next.unitCode ? ` · ${next.unitCode}` : ""}{next.room ? ` · Room ${next.room}` : ""}</p> : null}
      </div>
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      {view === "weekly" ? (plan === null ? <p className="text-sm text-foreground-500">Loading your calendar…</p>
        : !weeks.length ? <p className="rounded-lg border border-background-200 bg-white p-4 text-sm text-foreground-600">Your weekly calendar shows here once you are placed in an intake.</p>
        : weeks.map(({ course, rows }) => (
          <section key={course.enrolmentId} className="overflow-hidden rounded-lg border border-background-200 bg-white" aria-label={`${course.courseCode} weekly calendar`}>
            <p className="border-b border-background-200 px-4 py-3 text-sm font-semibold text-foreground-900">{course.courseCode} {course.courseName}</p>
            <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600"><tr><th className="px-4 py-2">Week</th><th className="px-4 py-2">Dates</th><th className="px-4 py-2">Unit</th></tr></thead>
              <tbody>{rows.map((w) => {
                const now = iso(w.from) <= today && today <= iso(w.to);
                return <tr key={w.n} className={`border-t border-background-100 ${now ? "bg-primary-50" : iso(w.to) < today ? "text-foreground-400" : ""}`}>
                  <td className="px-4 py-2 font-semibold tabular-nums">{w.n}{now ? <span className="ml-2 rounded-full bg-primary-600 px-2 py-0.5 text-xs text-white">This week</span> : null}</td>
                  <td className="px-4 py-2 tabular-nums">{short(w.from)} – {short(w.to)}</td>
                  <td className="px-4 py-2">{w.units.length ? w.units.map((u) => <span key={u.unitId} className="block"><b>{u.code}</b> {u.name}</span>) : <span className="text-foreground-500">Break</span>}</td>
                </tr>;
              })}</tbody>
            </table></div>
          </section>
        ))) : null}

      {view === "daily" ? (classes === null ? <p className="text-sm text-foreground-500">Loading your timetable…</p>
        : !Object.keys(pattern).length ? <p className="rounded-lg border border-background-200 bg-white p-4 text-sm text-foreground-600">No classes in the next four months. Your daily timetable shows here once you are placed in a class.</p>
        : <div className="overflow-x-auto rounded-lg border border-background-200 bg-white"><table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600"><tr>
            <th className="px-4 py-2">Day</th><th className="px-4 py-2">Kind</th><th className="px-4 py-2">Time</th><th className="px-4 py-2">Room</th><th className="px-4 py-2">Trainer</th></tr></thead>
          <tbody>{DAYS.map((day, i) => {
            const list = pattern[i] ?? [];
            if (!list.length) return i < 5 ? <tr key={day} className="border-t border-background-100 text-foreground-400"><td className="px-4 py-2 font-semibold">{day}</td><td className="px-4 py-2" colSpan={4}>No class</td></tr> : null;
            return list.map((s, k) => <tr key={`${day}-${k}`} className={`border-t ${k ? "border-background-50" : "border-background-100"}`}>
              <td className="px-4 py-2 font-semibold">{k ? "" : day}</td>
              <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${KIND[s.type] ?? "bg-background-200 text-foreground-700"}`}>{s.type}</span></td>
              <td className="px-4 py-2 tabular-nums">{clock(s.start)} – {clock(s.end)}</td>
              <td className="px-4 py-2">{s.room ? `${s.room}${s.campus ? `, ${s.campus}` : ""}` : "Not set"}</td>
              <td className="px-4 py-2">{s.trainers || "Not set"}</td>
            </tr>);
          })}</tbody>
        </table></div>) : null}
    </div>
  );
}
