// Every class as a month, week or day calendar, with filters (course › intake, trainer, room, student) and a class's details.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Modal, Select } from "@/pages/admin/components/ui";
import { addDays, mondayOf, shortDate, timeRange, todayIso } from "@/pages/admin/lib/rto";
import { courseColour, loadCalendar, loadClassStudents, overlaps, trainerNames, type CalClass, type CalFilter, type CalPeople, type ClassStudent } from "./calendarData";

type View = "month" | "week" | "day";
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const longDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const monthTitle = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });

/** The classes in a clash: the same trainer or the same room in two classes at once. */
function clashes(list: CalClass[]) {
  const out = new Map<string, string>();
  for (const a of list) for (const b of list) {
    if (!overlaps(a, b)) continue;
    const t = a.trainers.find((x) => b.trainers.some((y) => y.id === x.id));
    if (t) out.set(a.id, `${t.name} also teaches ${b.courseCode} ${b.batch} at ${timeRange(b.start, b.end)}`);
    else if (a.roomId && a.roomId === b.roomId) out.set(a.id, `${a.room} is also used by ${b.courseCode} ${b.batch} at ${timeRange(b.start, b.end)}`);
  }
  return out;
}

export default function ClassCalendar({ people, fixed = {}, showFilters = true, initialView = "week" }: {
  people: CalPeople | null; fixed?: CalFilter; showFilters?: boolean; initialView?: View;
}) {
  const [view, setView] = useState<View>(initialView);
  const [anchor, setAnchor] = useState(todayIso());
  const [filter, setFilter] = useState<CalFilter>({});
  const [classes, setClasses] = useState<CalClass[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<CalClass | null>(null);
  const fixedKey = JSON.stringify(fixed);

  const range = useMemo(() => {
    if (view === "day") return { from: anchor, to: anchor };
    if (view === "week") { const m = mondayOf(anchor); return { from: m, to: addDays(m, 6) }; }
    const first = `${anchor.slice(0, 7)}-01`; const m = mondayOf(first); return { from: m, to: addDays(m, 41) };
  }, [view, anchor]);
  useEffect(() => {
    let live = true;
    setClasses(null); setError("");
    loadCalendar(range.from, range.to, { ...filter, ...(JSON.parse(fixedKey) as CalFilter) })
      .then((r) => { if (live) setClasses(r); })
      .catch((e) => { if (live) { setError(e instanceof Error ? e.message : "The classes did not load."); setClasses([]); } });
    return () => { live = false; };
  }, [range.from, range.to, filter, fixedKey]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalClass[]>();
    for (const c of classes ?? []) m.set(c.date, [...(m.get(c.date) ?? []), c]);
    return m;
  }, [classes]);
  const clash = useMemo(() => clashes(classes ?? []), [classes]);
  const step = (n: number) => setAnchor((a) => view === "day" ? addDays(a, n) : view === "week" ? addDays(a, 7 * n)
    : (() => { const d = new Date(`${a.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); })());
  const title = view === "day" ? longDay(anchor) : view === "week" ? `${shortDate(range.from)} – ${shortDate(range.to)}` : monthTitle(anchor);
  const set = (k: keyof CalFilter, v: string) => setFilter((f) => {
    const next = { ...f, [k]: v || undefined };
    if (k === "courseId") { next.intakeId = undefined; next.batchId = undefined; }
    // The intake is the class group: the database filters on either key, so send the intake id as both.
    if (k === "intakeId") next.batchId = v || undefined;
    return next;
  });

  const card = (c: CalClass, compact = false) => (
    <button key={c.id} type="button" onClick={() => setOpen(c)} title={clash.get(c.id) ?? `${c.courseCode} ${c.batch} · ${c.unitCode ?? ""} ${c.unitName ?? ""}`}
      className={`block w-full rounded-md border px-2 py-1 text-left text-xs ${courseColour(c.courseId)} ${c.prerequisite ? "border-dashed" : ""} ${clash.has(c.id) ? "ring-2 ring-red-500" : ""}`}>
      <span className="font-semibold">{timeRange(c.start, c.end)}</span> · {c.courseCode} {c.batch}
      {compact ? (c.unitCode ? <span className="block truncate opacity-80">{c.unitCode}</span> : null) : <>
        <span className="block truncate">{c.unitCode} {c.unitName}</span>
        <span className="block truncate opacity-80">{c.room ?? "No room"} · {trainerNames(c)} · {c.students} student{c.students === 1 ? "" : "s"}</span>
        {clash.has(c.id) ? <span className="block font-semibold text-red-700">Clash: {clash.get(c.id)}</span> : null}
      </>}
    </button>
  );

  /** Week / day: a time grid (hours down the side), each class placed and sized by its time, overlapping classes side by side. */
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const timeGrid = (days: string[]) => {
    const all = days.flatMap((d) => byDay.get(d) ?? []);
    const first = Math.min(8, ...all.map((c) => Math.floor(mins(c.start) / 60)));
    const last = Math.max(18, ...all.map((c) => Math.ceil(mins(c.end) / 60)));
    const HOUR = 56;
    const hours = Array.from({ length: last - first }, (_, i) => first + i);
    const now = new Date(); const nowMins = now.getHours() * 60 + now.getMinutes();
    const lay = (list: CalClass[]) => {
      // overlapping classes share the column: each gets a lane within its group of overlaps
      const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
      const out: { c: CalClass; lane: number; lanes: number }[] = [];
      let group: { c: CalClass; lane: number; lanes: number }[] = []; let groupEnd = "";
      const close = () => { const n = Math.max(1, ...group.map((g) => g.lane + 1)); group.forEach((g) => { g.lanes = n; }); out.push(...group); group = []; };
      for (const c of sorted) {
        if (group.length && c.start >= groupEnd) close();
        const used = new Set(group.filter((g) => g.c.end > c.start).map((g) => g.lane));
        let lane = 0; while (used.has(lane)) lane++;
        group.push({ c, lane, lanes: 1 }); if (c.end > groupEnd) groupEnd = c.end;
      }
      if (group.length) close();
      return out;
    };
    return (
      <div className="overflow-x-auto rounded-lg border border-background-200 bg-background-50">
        <div className={days.length > 1 ? "min-w-[980px]" : ""}>
          <div className="grid border-b border-background-200" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
            <div />
            {days.map((d) => (
              <button key={d} type="button" onClick={() => { setAnchor(d); setView("day"); }}
                className={`border-l border-background-200 px-2 py-1.5 text-left text-xs font-semibold ${d === todayIso() ? "bg-primary-50 text-primary-800" : "text-foreground-700"}`}>
                {DAY_NAMES[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]} {Number(d.slice(8))}
                <span className="ml-1 font-normal text-foreground-400">{(byDay.get(d) ?? []).length ? `${(byDay.get(d) ?? []).length} class${(byDay.get(d) ?? []).length === 1 ? "" : "es"}` : ""}</span>
              </button>
            ))}
          </div>
          <div className="relative grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))`, height: hours.length * HOUR }}>
            <div className="relative">
              {hours.map((h, i) => <span key={h} className={`absolute right-2 text-2xs text-foreground-500 ${i ? "-translate-y-1/2" : ""}`} style={{ top: i * HOUR }}>{`${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`}</span>)}
            </div>
            {days.map((d) => (
              <div key={d} className={`relative border-l border-background-200 ${d === todayIso() ? "bg-primary-50/40" : ""}`}>
                {hours.map((h, i) => <div key={h} className="absolute inset-x-0 border-t border-background-200" style={{ top: i * HOUR }} />)}
                {d === todayIso() && nowMins >= first * 60 && nowMins <= last * 60 ? <div className="absolute inset-x-0 z-20 border-t-2 border-red-500" style={{ top: ((nowMins - first * 60) / 60) * HOUR }} title="Now" /> : null}
                {lay(byDay.get(d) ?? []).map(({ c, lane, lanes }) => {
                  const top = ((mins(c.start) - first * 60) / 60) * HOUR; const height = Math.max(22, ((mins(c.end) - mins(c.start)) / 60) * HOUR - 2);
                  return (
                    <button key={c.id} type="button" onClick={() => setOpen(c)} title={clash.get(c.id) ?? `${timeRange(c.start, c.end)} · ${c.courseCode} ${c.batch} · ${c.unitCode ?? ""} ${c.unitName ?? ""}`}
                      className={`absolute z-10 flex flex-col justify-start overflow-hidden rounded-md border px-1.5 py-1 text-left text-xs leading-tight shadow-sm ${courseColour(c.courseId)} ${c.prerequisite ? "border-dashed" : ""} ${clash.has(c.id) ? "ring-2 ring-red-500" : ""}`}
                      style={{ top, height, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}>
                      <span className="block font-semibold">{timeRange(c.start, c.end)}</span>
                      <span className="block truncate">{c.courseCode} {c.batch}{c.unitCode ? ` · ${c.unitCode}` : ""}</span>
                      {height > 64 ? <span className="block truncate opacity-80">{c.room ?? "No room"} · {trainerNames(c)}</span> : null}
                      {height > 84 ? <span className="block truncate opacity-80">{c.students} student{c.students === 1 ? "" : "s"}{days.length === 1 && c.unitName ? ` · ${c.unitName}` : ""}</span> : null}
                      {clash.has(c.id) && height > 100 ? <span className="block truncate font-semibold text-red-700">Clash</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const courseIntakes = (people?.intakes ?? []).filter((i) => i.courseId === filter.courseId);
  const sel = "!w-auto min-w-0 max-w-[14rem] !py-1.5 text-sm";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-background-300" role="group" aria-label="View">
          {(["month", "week", "day"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
              className={`px-3 py-1.5 text-sm font-medium capitalize ${view === v ? "bg-primary-500 text-white" : "bg-background-50 text-foreground-700 hover:bg-background-100"}`}>{v}</button>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={() => step(-1)} aria-label="Previous"><i className="ri-arrow-left-s-line" aria-hidden="true" /></Button>
        <Button size="sm" variant="outline" onClick={() => setAnchor(todayIso())}>Today</Button>
        <Button size="sm" variant="outline" onClick={() => step(1)} aria-label="Next"><i className="ri-arrow-right-s-line" aria-hidden="true" /></Button>
        <h3 className="ml-1 font-heading text-lg font-semibold text-foreground-950">{title}</h3>
        <span className="ml-auto text-sm text-foreground-500">{classes ? `${classes.length} class${classes.length === 1 ? "" : "es"}` : "Loading…"}{clash.size ? ` · ${clash.size} in a clash` : ""}</span>
      </div>

      {showFilters && people ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-background-200 bg-background-50 p-2">
          <Select className={sel} aria-label="Course" value={filter.courseId ?? ""} onChange={(e) => set("courseId", e.target.value)}>
            <option value="">All courses</option>{people.courses.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
          </Select>
          {filter.courseId ? <Select className={sel} aria-label="Intake" value={filter.intakeId ?? ""} onChange={(e) => set("intakeId", e.target.value)}>
            <option value="">All intakes</option>{courseIntakes.map((i) => <option key={i.id} value={i.id}>{shortDate(i.startDate)} – {shortDate(i.endDate)}</option>)}
          </Select> : null}
          <Select className={sel} aria-label="Trainer" value={filter.staffId ?? ""} onChange={(e) => set("staffId", e.target.value)}>
            <option value="">All trainers</option>{people.trainers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select className={sel} aria-label="Room" value={filter.roomId ?? ""} onChange={(e) => set("roomId", e.target.value)}>
            <option value="">All rooms</option>{people.rooms.map((r) => <option key={r.id} value={r.id}>{r.campus ? `${r.campus} · ` : ""}{r.name}</option>)}
          </Select>
          <Select className={sel} aria-label="Student" value={filter.studentId ?? ""} onChange={(e) => set("studentId", e.target.value)}>
            <option value="">All students</option>{people.students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          {Object.values(filter).some(Boolean) ? <Button size="sm" variant="outline" onClick={() => setFilter({})}>Clear</Button> : null}
        </div>
      ) : null}

      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

      {view === "month" ? (
        <div className="overflow-x-auto"><div className="grid min-w-[760px] grid-cols-7 overflow-hidden rounded-lg border border-background-200">
          {DAY_NAMES.map((d) => <div key={d} className="border-b border-background-200 bg-background-100 px-2 py-1 text-xs font-semibold text-foreground-600">{d}</div>)}
          {Array.from({ length: 42 }, (_, n) => addDays(range.from, n)).map((d) => {
            const list = byDay.get(d) ?? [];
            const other = d.slice(0, 7) !== anchor.slice(0, 7);
            return (
              <div key={d} className={`min-h-[110px] border-b border-r border-background-200 p-1 ${other ? "bg-background-100/60" : "bg-background-50"}`}>
                <button type="button" onClick={() => { setAnchor(d); setView("day"); }}
                  className={`mb-1 rounded px-1 text-xs font-semibold ${d === todayIso() ? "bg-primary-500 text-white" : other ? "text-foreground-400" : "text-foreground-700"}`}>{Number(d.slice(8))}</button>
                <div className="space-y-0.5">{list.slice(0, 3).map((c) => card(c, true))}
                  {list.length > 3 ? <button type="button" className="text-xs font-semibold text-primary-700" onClick={() => { setAnchor(d); setView("day"); }}>+{list.length - 3} more</button> : null}</div>
              </div>
            );
          })}
        </div></div>
      ) : view === "week" ? timeGrid(Array.from({ length: 7 }, (_, n) => addDays(range.from, n))) : (
        <div className="space-y-2">
          {classes && !(byDay.get(anchor) ?? []).length ? <p className="rounded-lg border border-dashed border-background-300 p-6 text-center text-sm text-foreground-500">No classes on this day.</p> : timeGrid([anchor])}
        </div>
      )}

      {open ? <ClassDetails c={open} clash={clash.get(open.id)} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function ClassDetails({ c, clash, onClose }: { c: CalClass; clash?: string; onClose: () => void }) {
  const [students, setStudents] = useState<ClassStudent[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    if (c.prerequisite) {
      setStudents((c.studentList ?? []).map((s) => ({ ...s, joined: null, carryOver: false, prereqFirst: true, status: "active", mark: null })));
    } else {
      loadClassStudents(c.id).then((r) => { if (live) setStudents(r); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Students did not load."); });
    }
    return () => { live = false; };
  }, [c.id, c.prerequisite, c.studentList]);
  const row = (label: string, value: string) => <div><dt className="text-xs text-foreground-500">{label}</dt><dd className="text-sm font-medium text-foreground-950">{value}</dd></div>;
  return (
    <Modal open title={`${c.courseCode} ${c.batch} · ${shortDate(c.date)}`} onClose={onClose} width="max-w-2xl"
      footer={<div className="flex flex-wrap justify-end gap-2">
        {c.prerequisite ? <Link to="/admin/lms/courses" className="rounded-md bg-primary-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-600">Open course › Prerequisite class</Link> : <>
        <Link to={`/admin/lms/intakes#${c.intakeId}`} className="rounded-md bg-primary-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-600">Open intake</Link></>}
      </div>}>
      {clash ? <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">Clash: {clash}</p> : null}
      <dl className="grid gap-3 sm:grid-cols-3">
        {row("Time", `${timeRange(c.start, c.end)} (${c.type})`)}
        {row("Unit", c.unitCode ? `${c.unitCode} ${c.unitName ?? ""}` : "—")}
        {row("Course", `${c.courseCode} ${c.courseName}`)}
        {row("Intake", c.prerequisite ? "Prerequisite class (late joiners)" : `${shortDate(c.intakeStart)} – ${shortDate(c.intakeEnd)}`)}
        {row("Room", c.room ? `${c.campus ? c.campus + " · " : ""}${c.room}` : "No room")}
        {row("Trainer", trainerNames(c))}
        {row("Attendance", c.attendance ? (c.attendance === "final" ? "Final register" : `Register ${c.attendance}`) : c.date <= todayIso() ? "Not marked yet" : "Not due yet")}
      </dl>
      <h4 className="mb-2 mt-4 text-sm font-semibold text-foreground-900">Students in this class {students ? `(${students.length})` : ""}</h4>
      {error ? <p className="text-sm text-red-700">{error}</p> : !students ? <p className="text-sm text-foreground-500">Loading…</p>
        : students.length ? <ul className="divide-y divide-background-200 rounded-lg border border-background-200">
          {students.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <Link to={`/admin/students/${s.id}`} className="font-medium text-primary-700 hover:underline">{s.name}</Link>
              <span className="text-xs text-foreground-600">
                {[s.joined ? `joined ${shortDate(s.joined)}` : "", s.prereqFirst ? "prerequisites first" : "", s.carryOver ? "carried over" : "", s.status !== "active" ? s.status : ""].filter(Boolean).join(" · ")}
                {s.mark ? <span className="ml-2 rounded-full bg-background-200 px-2 py-0.5 font-semibold capitalize text-foreground-800">{s.mark}</span> : null}
              </span>
            </li>
          ))}
        </ul> : <p className="text-sm text-foreground-500">No student is placed in this class.</p>}
    </Modal>
  );
}
