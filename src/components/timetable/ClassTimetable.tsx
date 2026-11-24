import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import TrainerAttendanceDialog from "@/components/timetable/TrainerAttendanceDialog";
import TodayClasses from "@/components/timetable/TodayClasses";

type Session = { id: string; date: string; start: string; end: string; type: string; status: string; batchName: string; courseName: string; courseCode: string;
  unitCode: string | null; unitName: string | null; room: string | null; campus: string | null; trainers: string; prerequisite?: boolean };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monday = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const minutes = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
const dayLabel = (d: Date) => d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" });
const shortDate = (s: string) => parse(s).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
const TYPE_TONE: Record<string, string> = { theory: "bg-primary-100 text-primary-800", practical: "bg-amber-100 text-amber-800", assessment: "bg-indigo-100 text-indigo-800" };
/** Calendar blocks: the colour of each kind of class. */
const BLOCK_TONE: Record<string, string> = {
  theory: "border-primary-400 bg-primary-50 text-primary-900", practical: "border-amber-400 bg-amber-50 text-amber-900",
  assessment: "border-indigo-400 bg-indigo-50 text-indigo-900",
};
/** How far ahead the list and the next-class search look (my_class_schedule allows up to 120 days per call). */
const AHEAD_DAYS = 120;
/** Height of one hour in the calendar grids. */
const HOUR_PX = 56;

/** Classes in a range: the regular ones plus the Prerequisite class (a late joiner's prerequisite units; my_prereq_classes, ignored if not available). */
async function loadClasses(from: Date, to: Date): Promise<Session[]> {
  const range = { p_from: iso(from), p_to: iso(to) };
  const [main, pre] = await Promise.all([supabase.rpc("my_class_schedule", range), supabase.rpc("my_prereq_classes", range)]);
  if (main.error) throw new Error(main.error.message);
  const all = [...((main.data as { sessions?: Session[] } | null)?.sessions ?? []), ...(pre.error ? [] : ((pre.data as Session[] | null) ?? []))];
  return all.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

type PlanUnit = { unitId: string; code: string; name: string; startDate: string | null; endDate: string | null };
type PlanCourse = { enrolmentId: string; courseCode: string; courseName: string; intakeStart: string | null; intakeEnd: string | null; units: PlanUnit[] };
type View = "day" | "week" | "list";

/**
 * The signed-in student's or trainer's classes (my_class_schedule), owner 2026-11-23: weekly and daily calendar views and a list
 * view. Day and Week draw the classes as blocks on an hour grid (Week: Monday to Sunday side by side); List shows the next four
 * months by week. An empty day or week names the next class with a button to it. Students also see their study plan (every unit
 * with its dates, the current one marked; student_my_learning).
 */
export default function ClassTimetable({ who }: { who: "student" | "trainer" }) {
  const [view, setView] = useState<View>("week");
  const [cursor, setCursor] = useState(() => new Date());
  const start = useMemo(() => monday(cursor), [cursor]);
  const [rows, setRows] = useState<Session[] | null>(null);
  const [ahead, setAhead] = useState<Session[] | null>(null);
  const [plan, setPlan] = useState<PlanCourse[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Session | null>(null);
  const [marking, setMarking] = useState<Session | null>(null);
  const today = iso(new Date());
  const startKey = iso(start);

  useEffect(() => {
    let live = true;
    setRows(null); setError("");
    const from = parse(startKey);
    loadClasses(from, addDays(from, 6)).then((r) => { if (live) setRows(r); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [startKey]);
  useEffect(() => {
    let live = true;
    const from = new Date();
    loadClasses(from, addDays(from, AHEAD_DAYS)).then((r) => { if (live) setAhead(r); }, () => { if (live) setAhead([]); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (who !== "student") return;
    let live = true;
    void supabase.rpc("student_my_learning").then(({ data, error: failed }) => {
      if (!live) return;
      setPlan(failed ? [] : (((data as { courses?: PlanCourse[] } | null)?.courses) ?? []));
    });
    return () => { live = false; };
  }, [who]);

  const days = useMemo(() => (view === "day" ? [new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())] : Array.from({ length: 7 }, (_, i) => addDays(start, i))), [view, cursor, start]);
  const shown = useMemo(() => (rows ?? []).filter((s) => days.some((d) => iso(d) === s.date)), [rows, days]);
  const lastShown = iso(days[days.length - 1]);
  const nextClass = useMemo(() => (ahead ?? []).find((s) => s.status !== "cancelled" && s.date > lastShown), [ahead, lastShown]);
  const weeks = useMemo(() => {
    const out = new Map<string, Session[]>();
    for (const s of ahead ?? []) { const key = iso(monday(parse(s.date))); out.set(key, [...(out.get(key) ?? []), s]); }
    return [...out.entries()];
  }, [ahead]);
  // The hours the grid covers: 8 am to 6 pm, widened to fit every class shown.
  const [fromHour, toHour] = useMemo(() => {
    let lo = 8, hi = 18;
    for (const s of shown) { lo = Math.min(lo, Math.floor(minutes(s.start) / 60)); hi = Math.max(hi, Math.ceil(minutes(s.end) / 60)); }
    return [Math.max(0, lo), Math.min(24, hi)];
  }, [shown]);

  const step = (n: number) => setCursor((c) => addDays(c, view === "day" ? n : 7 * n));
  const btn = "inline-flex items-center gap-1 rounded-md border border-background-300 bg-white px-3 py-1.5 text-sm font-medium text-foreground-800 hover:bg-background-100";
  const tab = (on: boolean) => `rounded-md px-3 py-1.5 text-sm font-semibold ${on ? "bg-primary-600 text-white" : "text-foreground-700 hover:bg-background-100"}`;
  const title = view === "day" ? cursor.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : view === "week" ? `${start.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} – ${addDays(start, 6).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}`
    : "Next four months";
  const meta = (s: Session) => [s.courseCode || s.courseName, `Class ${s.batchName}`, s.room ? `Room ${s.room}${s.campus ? `, ${s.campus}` : ""}` : "Room not set", s.trainers ? `Trainer: ${s.trainers}` : ""].filter(Boolean);

  /** One class in the list. */
  const classRow = (s: Session, withDate = false) => (
    <li key={s.id} className={`flex flex-wrap items-start gap-3 rounded-md border border-background-100 p-2 ${s.status === "cancelled" ? "opacity-60" : ""}`}>
      <span className="w-28 shrink-0 text-sm font-semibold tabular-nums text-foreground-900">
        {withDate ? <span className="block text-xs font-medium text-foreground-500">{parse(s.date).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}</span> : null}
        {s.start} – {s.end}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground-900">{s.unitCode ? `${s.unitCode} ${s.unitName ?? ""}` : s.courseName}</span>
        <span className="block text-xs text-foreground-600">{meta(s).join(" · ")}</span>
      </span>
      {s.status === "cancelled"
        ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">Cancelled</span>
        : <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${TYPE_TONE[s.type] ?? "bg-background-200 text-foreground-700"}`}>{s.type}</span>}
      {who === "trainer" && s.status !== "cancelled" && s.unitCode && s.date <= today
        ? <button type="button" onClick={() => setMarking(s)} className="rounded-md border border-primary-300 px-2 py-0.5 text-xs font-semibold text-primary-700 hover:bg-primary-50"><i className="ri-checkbox-circle-line" aria-hidden="true" /> Attendance</button>
        : null}
    </li>
  );

  /** Day / Week: the classes as blocks on an hour grid, one column per day. */
  const grid = () => {
    const hours = Array.from({ length: toHour - fromHour }, (_, i) => fromHour + i);
    const height = hours.length * HOUR_PX;
    return (
      <div className="overflow-x-auto rounded-lg border border-background-200 bg-white">
        <div className={view === "week" ? "min-w-[760px]" : ""}>
          <div className="grid border-b border-background-200" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
            <div />
            {days.map((d) => <button key={iso(d)} type="button" onClick={() => { setCursor(d); setView("day"); }} title="Open this day"
              className={`px-2 py-2 text-center text-xs font-semibold ${iso(d) === today ? "text-primary-700" : "text-foreground-700"} hover:bg-background-100`}>
              {d.toLocaleDateString("en-AU", { weekday: "short" })}
              <span className={`mx-auto mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-sm ${iso(d) === today ? "bg-primary-600 text-white" : "text-foreground-900"}`}>{d.getDate()}</span>
            </button>)}
          </div>
          <div className="relative grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))`, height }}>
            <div className="relative">{hours.map((h, i) => <span key={h} className="absolute right-2 -translate-y-1/2 text-2xs text-foreground-500" style={{ top: i * HOUR_PX }}>{i ? hourLabel(h) : ""}</span>)}</div>
            {days.map((d) => {
              const list = shown.filter((s) => s.date === iso(d));
              return <div key={iso(d)} className={`relative border-l border-background-100 ${iso(d) === today ? "bg-primary-50/40" : ""}`}>
                {hours.map((h, i) => <div key={h} className="absolute inset-x-0 border-t border-background-100" style={{ top: i * HOUR_PX }} />)}
                {list.map((s) => {
                  const top = (minutes(s.start) - fromHour * 60) / 60 * HOUR_PX;
                  const tall = Math.max(22, (minutes(s.end) - minutes(s.start)) / 60 * HOUR_PX - 2);
                  return <button key={s.id} type="button" onClick={() => setOpen(s)}
                    className={`absolute inset-x-1 overflow-hidden rounded-md border-l-4 px-1.5 py-1 text-left text-xs shadow-sm hover:shadow ${BLOCK_TONE[s.type] ?? "border-background-400 bg-background-100 text-foreground-900"} ${s.status === "cancelled" ? "opacity-50 line-through" : ""}`}
                    style={{ top, height: tall }} title={`${s.start}–${s.end} ${s.unitCode ?? ""} ${s.unitName ?? ""}`}>
                    <span className="block font-semibold tabular-nums">{s.start} – {s.end}</span>
                    <span className="block truncate font-semibold">{s.unitCode ?? s.courseCode}</span>
                    {tall > 60 ? <span className="block truncate">{s.unitName}</span> : null}
                    {tall > 80 ? <span className="block truncate opacity-80">{s.room ? `Room ${s.room}` : ""}</span> : null}
                  </button>;
                })}
              </div>;
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {who === "trainer" ? <TodayClasses /> : null}

      {who === "student" && plan && plan.length ? <details className="rounded-lg border border-background-200 bg-white p-4" open aria-label="Study plan">
        <summary className="cursor-pointer font-heading text-base font-semibold text-foreground-950">Your study plan</summary>
        {plan.map((course) => (
          <div key={course.enrolmentId} className="mt-3">
            <p className="text-sm font-semibold text-foreground-900">{course.courseCode} {course.courseName}
              <span className="ml-2 text-xs font-normal text-foreground-600">{course.intakeStart ? `${shortDate(course.intakeStart)} – ${course.intakeEnd ? shortDate(course.intakeEnd) : "…"}` : ""}</span></p>
            <ol className="mt-2 divide-y divide-background-100 rounded-md border border-background-100">
              {course.units.map((u, i) => {
                const now = !!u.startDate && !!u.endDate && u.startDate <= today && today <= u.endDate;
                const done = !!u.endDate && u.endDate < today;
                return <li key={u.unitId} className={`flex flex-wrap items-center gap-3 px-3 py-2 text-sm ${now ? "bg-primary-50" : ""}`}>
                  <span className="w-6 shrink-0 text-xs text-foreground-500">{i + 1}</span>
                  <span className="min-w-0 flex-1"><b>{u.code}</b> <span className="text-foreground-700">{u.name}</span></span>
                  <span className="text-xs tabular-nums text-foreground-600">{u.startDate ? `${shortDate(u.startDate)} – ${u.endDate ? shortDate(u.endDate) : "…"}` : "Dates to be set"}</span>
                  {now ? <span className="rounded-full bg-primary-600 px-2 py-0.5 text-xs font-semibold text-white">Now</span>
                    : done ? <span className="rounded-full bg-background-200 px-2 py-0.5 text-xs font-semibold text-foreground-600">Finished</span> : null}
                </li>;
              })}
            </ol>
          </div>
        ))}
      </details> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border border-background-200 bg-white p-1" role="tablist" aria-label="Timetable view">
          {([["day", "Day"], ["week", "Week"], ["list", "List"]] as const).map(([id, label]) =>
            <button key={id} type="button" role="tab" aria-selected={view === id} className={tab(view === id)} onClick={() => setView(id)}>{label}</button>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-2 font-heading text-base font-semibold text-foreground-950">{title}</p>
          {view !== "list" ? <>
            <button type="button" className={btn} onClick={() => step(-1)} aria-label={view === "day" ? "Previous day" : "Previous week"}><i className="ri-arrow-left-s-line" aria-hidden="true" />Previous</button>
            <button type="button" className={btn} onClick={() => setCursor(new Date())}>Today</button>
            <button type="button" className={btn} onClick={() => step(1)} aria-label={view === "day" ? "Next day" : "Next week"}>Next<i className="ri-arrow-right-s-line" aria-hidden="true" /></button>
          </> : null}
        </div>
      </div>
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      {view !== "list" ? <>
        {rows === null && !error ? <p className="text-sm text-foreground-500">Loading classes…</p> : null}
        {rows && !shown.length ? <div className="rounded-lg border border-background-200 bg-white p-4 text-sm text-foreground-600">
          <p>No classes {view === "day" ? "on this day" : "this week"}.</p>
          {nextClass ? <p className="mt-2 flex flex-wrap items-center gap-2">Your next class is on <b>{dayLabel(parse(nextClass.date))}</b> at {nextClass.start}{nextClass.unitCode ? ` (${nextClass.unitCode})` : ""}.
            <button type="button" className={btn} onClick={() => setCursor(parse(nextClass.date))}>Go to it</button></p>
            : ahead && !ahead.length ? <p className="mt-1">{who === "student" ? "You have no classes in the next four months. Your classes show here once you are placed in a class." : "No classes of the intakes and units you teach in the next four months."}</p> : null}
        </div> : null}
        {rows && shown.length ? grid() : null}
        <p className="flex flex-wrap gap-3 text-xs text-foreground-600">
          {(["theory", "practical", "assessment"] as const).map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span className={`h-3 w-3 rounded-sm border-l-4 ${BLOCK_TONE[k]}`} aria-hidden="true" /><span className="capitalize">{k}</span></span>)}
          <span>Click a class for its details{view === "week" ? ", a day to open it" : ""}.</span>
        </p>
      </> : <>
        {ahead === null ? <p className="text-sm text-foreground-500">Loading classes…</p> : null}
        {ahead && !ahead.length ? <p className="rounded-lg border border-background-200 bg-white p-4 text-sm text-foreground-600">No classes in the next four months.</p> : null}
        {weeks.length ? <ol className="space-y-3">
          {weeks.map(([week, list]) => (
            <li key={week} className="rounded-lg border border-background-200 bg-white p-3">
              <p className="mb-2 text-sm font-semibold text-foreground-900">Week of {parse(week).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}
                <span className="ml-2 text-xs font-normal text-foreground-500">{list.length} class{list.length === 1 ? "" : "es"}</span></p>
              <ul className="space-y-2">{list.map((s) => classRow(s, true))}</ul>
            </li>
          ))}
        </ol> : null}
      </>}

      {open ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(null)}>
        <div role="dialog" aria-modal="true" aria-label="Class details" className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{dayLabel(parse(open.date))} · {open.start} – {open.end}</p>
          <h3 className="mt-1 font-heading text-lg font-bold text-foreground-950">{open.unitCode ? `${open.unitCode} ${open.unitName ?? ""}` : open.courseName}</h3>
          <dl className="mt-3 space-y-1.5 text-sm">
            {[["Course", `${open.courseCode} ${open.courseName}`], ["Class", open.batchName], ["Kind", open.type], ["Room", open.room ? `${open.room}${open.campus ? `, ${open.campus}` : ""}` : "Not set"], ["Trainer", open.trainers || "Not set"], ["Status", open.status === "cancelled" ? "Cancelled" : "Scheduled"]]
              .map(([k, v]) => <div key={k} className="flex gap-3"><dt className="w-20 shrink-0 text-foreground-500">{k}</dt><dd className="capitalize-first text-foreground-900">{v}</dd></div>)}
          </dl>
          <div className="mt-4 flex justify-end gap-2">
            {who === "trainer" && open.status !== "cancelled" && open.unitCode && open.date <= today
              ? <button type="button" className={btn} onClick={() => { setMarking(open); setOpen(null); }}>Attendance</button> : null}
            <button type="button" className={btn} onClick={() => setOpen(null)}>Close</button>
          </div>
        </div>
      </div> : null}
      {marking ? <TrainerAttendanceDialog sessionId={marking.id} title={`${marking.date} ${marking.start}–${marking.end} · ${marking.unitCode ?? ""} · Class ${marking.batchName}`} onClose={() => setMarking(null)} /> : null}
    </div>
  );
}
