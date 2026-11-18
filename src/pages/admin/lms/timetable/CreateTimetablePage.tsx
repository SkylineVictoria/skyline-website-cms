// Create timetable (LMS › Timetable › Create timetable): one page to set an intake's weekly classes and create its dated classes.
// 1 course and intake · 2 the week (one-click presets, the course's saved timetables, copy from another intake, or tick the
// grid by hand) with one room, one trainer and the seats · 3 Create classes. The unit dates come from the intake (master
// timetable); the database checks the weekly hours and refuses room / trainer clashes. Unusual weeks (different times per
// day, a room per class) stay in the intake's Class setup.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Card, PageHeader, Select, TextInput } from "@/pages/admin/components/ui";
import { loadClosedDays, loadCourseNeed, planCourse, weeklyHoursNeeded, type CourseNeed } from "@/pages/admin/lib/coursePlan";
import {
  DAYS, SLOTS, clashText, generateClassSessions, rto, rtoFlow, shortDate, slotOf, sortIntakes, todayIso,
  type BatchSession, type Clash, type CourseTiming, type GenerateResult, type IntakeDetail, type LocationRooms, type RtoCourse, type RtoIntake,
  type SessionType, type Slot, type StaffOption,
} from "@/pages/admin/lib/rto";

type SlotRow = { start: string; end: string; type: SessionType };
type Rows = Record<Slot, SlotRow>;
const cellKey = (weekday: number, slot: Slot) => `${weekday}|${slot}`;
const freshRows = (): Rows => Object.fromEntries(SLOTS.map((s) => [s.id, { start: s.start, end: s.end, type: "theory" as SessionType }])) as Rows;
const PRESETS: { label: string; days: number[]; slots: Slot[] }[] = [
  { label: "Weekday mornings", days: [1, 2, 3, 4, 5], slots: ["morning"] },
  { label: "Weekday afternoons", days: [1, 2, 3, 4, 5], slots: ["afternoon"] },
  { label: "Weekday evenings", days: [1, 2, 3, 4, 5], slots: ["evening"] },
  { label: "Full days Mon–Fri", days: [1, 2, 3, 4, 5], slots: ["morning", "afternoon"] },
  { label: "Weekend full days", days: [6, 7], slots: ["morning", "afternoon"] },
];
const hours = (r: SlotRow) => { const [a, b] = [r.start, r.end].map((t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; }); return Math.max(0, (b - a) / 60); };

export default function CreateTimetablePage() {
  const [params, setParams] = useSearchParams();
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [locations, setLocations] = useState<LocationRooms[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [courseId, setCourseId] = useState(params.get("course") ?? "");
  const [intakeId, setIntakeId] = useState(params.get("intake") ?? "");
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [timings, setTimings] = useState<CourseTiming[]>([]);
  const [need, setNeed] = useState<CourseNeed | null>(null);
  const [closed, setClosed] = useState<((day: string) => boolean) | null>(null);
  const [cells, setCells] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Rows>(freshRows);
  const [roomId, setRoomId] = useState("");
  const [trainerId, setTrainerId] = useState("");
  const [seats, setSeats] = useState("");
  const [clashes, setClashes] = useState<Clash[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<GenerateResult | null>(null);

  useEffect(() => {
    void Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list"), rtoFlow<LocationRooms[]>("locations_rooms"), rto<StaffOption[]>("staff_list"), rto<{ rtoManager: boolean }>("me")])
      .then(([c, i, l, s, me]) => { setCourses(c); setIntakes(i); setLocations(l); setStaff(s); setCanEdit(Boolean(me.rtoManager)); })
      .catch((e) => setError(e instanceof Error ? e.message : "The page did not load."));
  }, []);

  const withIntakes = useMemo(() => courses.filter((c) => intakes.some((i) => i.courseId === c.id)), [courses, intakes]);
  const course = withIntakes.find((c) => c.id === courseId) ?? (intakeId ? withIntakes.find((c) => c.id === intakes.find((i) => i.id === intakeId)?.courseId) : null) ?? withIntakes[0] ?? null;
  const courseIntakes = useMemo(() => sortIntakes(intakes.filter((i) => i.courseId === course?.id && i.status !== "closed" && (!i.endDate || i.endDate >= todayIso()))), [intakes, course?.id]);
  const intake = courseIntakes.find((i) => i.id === intakeId) ?? courseIntakes[0] ?? null;
  const rooms = locations.flatMap((l) => l.rooms.filter((r) => r.isActive).map((r) => ({ id: r.id, label: `${l.name} · ${r.name}${r.capacity ? ` (${r.capacity} seats)` : ""}` })));

  /** The week from saved classes: each class goes to its part of the day; that part's times and type come from its first class. */
  const applySessions = (sessions: BatchSession[], keepRoom = false) => {
    const next = freshRows(); const set = new Set<string>(); const seen = new Set<Slot>();
    for (const s of sessions) {
      const slot = slotOf(s.startTime);
      if (!seen.has(slot)) { seen.add(slot); next[slot] = { start: s.startTime.slice(0, 5), end: s.endTime.slice(0, 5), type: s.type }; }
      set.add(cellKey(s.weekday, slot));
    }
    setRows(next); setCells(set);
    if (!keepRoom) { const room = sessions.find((s) => s.roomId)?.roomId; if (room) setRoomId(room); }
  };

  // The chosen intake: its saved class setup (if any), the course's saved timetables, hours and closed days.
  useEffect(() => {
    setDetail(null); setDone(null); setClashes([]); setError("");
    if (!intake) return;
    let live = true;
    void rto<IntakeDetail>("intake_get", { intakeId: intake.id }).then((d) => {
      if (!live) return;
      setDetail(d);
      const group = d.batches[0];
      applySessions(group?.sessions ?? []);
      setRoomId(group?.sessions?.find((s) => s.roomId)?.roomId ?? group?.classroomId ?? "");
      setTrainerId(group?.trainers[0]?.id ?? "");
      setSeats(d.intake.capacity ? String(d.intake.capacity) : group?.capacity ? String(group.capacity) : "");
      void loadClosedDays(d.intake.startDate, intake.courseId).then((f) => { if (live) setClosed(() => f); });
    }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The intake did not load."); });
    void rtoFlow<CourseTiming[]>("timing_list", { courseId: intake.courseId }).then((t) => { if (live) setTimings(t); }).catch(() => undefined);
    void loadCourseNeed(intake.courseId).then((n) => { if (live) setNeed(n); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads when another intake is chosen
  }, [intake?.id]);

  const sessions = useMemo(() => [...cells].map((key) => { const [day, slot] = key.split("|") as [string, Slot]; const r = rows[slot];
    return { weekday: Number(day), startTime: r.start, endTime: r.end, type: r.type, roomId: roomId || null }; })
    .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime)), [cells, rows, roomId]);
  const badTime = SLOTS.some((s) => [...cells].some((k) => k.endsWith(`|${s.id}`)) && (!rows[s.id].start || !rows[s.id].end || rows[s.id].end <= rows[s.id].start));
  const overlap = sessions.some((a, i) => sessions.some((b, j) => j > i && a.weekday === b.weekday && a.startTime < b.endTime && b.startTime < a.endTime));
  const weekly = sessions.reduce((sum, s) => sum + hours({ start: s.startTime, end: s.endTime, type: s.type }), 0);
  const dates = detail?.intake ?? intake;
  const needed = need && closed && dates?.endDate && need.total > 0 ? weeklyHoursNeeded(dates.startDate, dates.endDate, need.total, closed) : null;
  const plan = need && closed && dates && need.total > 0 && sessions.length && !badTime ? planCourse(dates.startDate, sessions, need, closed) : null;
  const enough = needed === null || weekly >= needed;

  // Rooms already taken at these times (asked as the week changes).
  const sessionsKey = JSON.stringify(sessions);
  useEffect(() => {
    if (!intake || !roomId || !sessions.length || badTime) { setClashes([]); return; }
    let live = true;
    const t = window.setTimeout(() => {
      rtoFlow<Clash[]>("clash_check", { batchId: detail?.batches[0]?.id ?? null, intakeId: intake.id, sessions })
        .then((c) => { if (live) setClashes(c); }).catch(() => undefined);
    }, 350);
    return () => { live = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the week
  }, [sessionsKey, intake?.id]);
  const clashLines = [...new Set(clashes.map(clashText))];

  const toggle = (weekday: number, slot: Slot) => { setDone(null); setCells((s) => { const n = new Set(s); const k = cellKey(weekday, slot); if (n.has(k)) n.delete(k); else n.add(k); return n; }); };
  const preset = (p: (typeof PRESETS)[number]) => { setDone(null); setRows(freshRows()); setCells(new Set(p.days.flatMap((d) => p.slots.map((s) => cellKey(d, s))))); };
  const copyFrom = async (id: string) => {
    if (!id) return;
    try { const d = await rto<IntakeDetail>("intake_get", { intakeId: id }); applySessions(d.batches[0]?.sessions ?? [], true); setDone(null); }
    catch (e) { setError(e instanceof Error ? e.message : "That intake's week could not be read."); }
  };
  const others = intakes.filter((i) => i.id !== intake?.id && (i.batchList ?? []).some((b) => b.days.length > 0));

  const create = async () => {
    if (!intake) return;
    setBusy(true); setError(""); setDone(null);
    try {
      const out = await rtoFlow<IntakeDetail & { batchId: string }>("batch_setup", { batchId: detail?.batches[0]?.id ?? null, intakeId: intake.id, sessions, capacity: seats.trim(), trainerIds: trainerId ? [trainerId] : [] });
      const made = await generateClassSessions(out.batchId);
      setDetail(out); setDone(made);
      setIntakes(await rto<RtoIntake[]>("intake_list"));
    } catch (e) { setError(e instanceof Error ? e.message : "The timetable was not saved."); }
    finally { setBusy(false); }
  };

  const pick = (next: { course?: string; intake?: string }) => {
    const c = next.course ?? course?.id ?? ""; const i = next.course ? "" : next.intake ?? "";
    setCourseId(c); setIntakeId(i); setParams(i ? { course: c, intake: i } : c ? { course: c } : {}, { replace: true });
  };
  const blocked = !canEdit || busy || !intake || !sessions.length || badTime || overlap || !roomId || clashLines.length > 0 || !enough;
  const why = !canEdit ? "Only an RTO Manager can create a timetable." : !sessions.length ? "Choose the class days and times." : badTime ? "Each class must end after it starts."
    : overlap ? "Two parts of the day overlap: change their times." : !roomId ? "Choose a room." : clashLines.length ? "Fix the room clash first."
    : !enough ? `This week gives ${weekly} hours; the course needs ${needed} a week to finish by ${shortDate(dates?.endDate ?? "")}.` : "";
  const step = "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-500 text-sm font-bold text-background-50";

  return (
    <div className="mx-auto max-w-5xl pb-10">
      <PageHeader title="Create timetable" description="Choose the intake, choose the week, press Create classes. Unit dates come from the master timetable; term breaks and public holidays are skipped." />
      {error ? <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

      <Card className="mb-4">
        <div className="flex items-start gap-3"><span className={step}>1</span>
          <div className="min-w-0 flex-1"><h2 className="font-heading text-lg font-semibold text-foreground-950">Course and intake</h2>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">Course
                <Select className="mt-1" value={course?.id ?? ""} onChange={(e) => pick({ course: e.target.value })}>
                  {withIntakes.length ? withIntakes.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>) : <option value="">No course has an intake yet</option>}
                </Select></label>
              <label className="text-sm font-medium">Intake
                <Select className="mt-1" value={intake?.id ?? ""} onChange={(e) => pick({ intake: e.target.value })}>
                  {courseIntakes.length ? courseIntakes.map((i) => <option key={i.id} value={i.id}>{i.customName || i.name} · {shortDate(i.startDate)} – {i.endDate ? shortDate(i.endDate) : "open"}</option>) : <option value="">No open intake</option>}
                </Select></label>
            </div>
            {!withIntakes.length ? <p className="mt-2 text-sm text-foreground-600">Create an intake first in <Link className="font-semibold text-primary-700 hover:underline" to="/admin/lms/intakes">Intakes</Link>.</p> : null}
            {detail?.batches[0]?.sessions?.length ? <p className="mt-2 text-sm text-foreground-600">This intake already has classes set up: change the week below and press Update classes.</p> : null}
          </div></div>
      </Card>

      {intake ? <Card className="mb-4">
        <div className="flex items-start gap-3"><span className={step}>2</span>
          <div className="min-w-0 flex-1"><h2 className="font-heading text-lg font-semibold text-foreground-950">The week</h2>
            <p className="mt-1 text-sm text-foreground-600">Start from a ready-made week, then tick or untick any box.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {PRESETS.map((p) => <Button key={p.label} size="sm" variant="outline" disabled={busy} onClick={() => preset(p)}>{p.label}</Button>)}
              {timings.map((t) => <Button key={t.id} size="sm" variant="outline" icon="ri-file-copy-2-line" disabled={busy}
                onClick={() => { applySessions(t.sessions); if (t.trainerStaffId) setTrainerId(t.trainerStaffId); setDone(null); }}>Course timetable: {t.name}</Button>)}
              {others.length ? <Select className="!w-auto" aria-label="Copy the week from another intake" value="" disabled={busy} onChange={(e) => void copyFrom(e.target.value)}>
                <option value="">Copy from another intake…</option>
                {others.map((i) => <option key={i.id} value={i.id}>{i.courseCode} · {i.customName || i.name}</option>)}
              </Select> : null}
              {cells.size ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { setCells(new Set()); setDone(null); }}>Clear</Button> : null}
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[900px] border-separate border-spacing-1 text-sm">
                <thead><tr><th className="w-[27rem] text-left text-xs font-semibold text-foreground-600">Part of the day</th>
                  {DAYS.map((d) => <th key={d} className="text-xs font-semibold text-foreground-600">{d}</th>)}</tr></thead>
                <tbody>{SLOTS.map((s) => (
                  <tr key={s.id}>
                    <td><div className="flex flex-nowrap items-center gap-1">
                      <span className="w-20 shrink-0 font-medium text-foreground-900">{s.label}</span>
                      <TextInput className="!w-32" type="time" aria-label={`${s.label} starts`} value={rows[s.id].start} disabled={busy} onChange={(e) => { setDone(null); setRows((r) => ({ ...r, [s.id]: { ...r[s.id], start: e.target.value } })); }} />
                      <TextInput className="!w-32" type="time" aria-label={`${s.label} ends`} value={rows[s.id].end} disabled={busy} onChange={(e) => { setDone(null); setRows((r) => ({ ...r, [s.id]: { ...r[s.id], end: e.target.value } })); }} />
                      <Select className="!w-auto" aria-label={`${s.label} class type`} value={rows[s.id].type} disabled={busy} onChange={(e) => { setDone(null); setRows((r) => ({ ...r, [s.id]: { ...r[s.id], type: e.target.value as SessionType } })); }}>
                        <option value="theory">Theory</option><option value="practical">Practical</option><option value="assessment">Assessment</option>
                      </Select></div></td>
                    {DAYS.map((d, i) => { const on = cells.has(cellKey(i + 1, s.id)); return (
                      <td key={d}><button type="button" aria-pressed={on} aria-label={`${d} ${s.label}`} disabled={busy} onClick={() => toggle(i + 1, s.id)}
                        className={`h-11 w-full rounded-lg border text-xs font-semibold ${on ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-400 hover:border-primary-300"}`}>
                        {on ? "Class" : "–"}</button></td>); })}
                  </tr>))}</tbody>
              </table>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="text-sm font-medium">Room
                <Select className="mt-1" value={roomId} disabled={busy} onChange={(e) => { setRoomId(e.target.value); setDone(null); }}>
                  <option value="">Choose a room</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </Select></label>
              <label className="text-sm font-medium">Trainer
                <Select className="mt-1" value={trainerId} disabled={busy} onChange={(e) => { setTrainerId(e.target.value); setDone(null); }}>
                  <option value="">No trainer yet</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select></label>
              <label className="text-sm font-medium">Seats
                <TextInput className="mt-1" inputMode="numeric" placeholder="Room size" value={seats} disabled={busy} onChange={(e) => setSeats(e.target.value.replace(/\D/g, ""))} /></label>
            </div>
            {!rooms.length ? <p className="mt-2 text-sm text-foreground-600">No rooms yet: add one in <Link className="font-semibold text-primary-700 hover:underline" to="/admin/lms/timetable-settings?tab=locations">Timetable settings</Link>.</p> : null}

            <div className={`mt-3 rounded-lg border p-3 text-sm ${clashLines.length || overlap || badTime ? "border-red-300 bg-red-50" : !enough ? "border-amber-300 bg-amber-50" : "border-green-300 bg-green-50"}`}>
              <p className="font-semibold text-foreground-950">{sessions.length} class{sessions.length === 1 ? "" : "es"} a week · {weekly} hours a week{needed !== null ? ` · the course needs ${needed}` : ""}</p>
              {plan?.lastDate ? <p className="text-foreground-700">Last class about {shortDate(plan.lastDate)}{dates?.endDate ? ` (intake ends ${shortDate(dates.endDate)})` : ""}.</p> : null}
              {clashLines.map((line) => <p key={line} role="alert" className="font-semibold text-red-700">{line}</p>)}
            </div>
            {detail?.batches[0] ? <p className="mt-2 text-xs text-foreground-500">Need different times on some days, or a room per class? Use <Link className="font-semibold text-primary-700 hover:underline" to={`/admin/lms/intakes#${intake.id}`}>the intake&apos;s Class setup</Link>.</p> : null}
          </div></div>
      </Card> : null}

      {intake ? <Card>
        <div className="flex items-start gap-3"><span className={step}>3</span>
          <div className="min-w-0 flex-1"><h2 className="font-heading text-lg font-semibold text-foreground-950">Create the classes</h2>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button icon="ri-calendar-check-line" disabled={blocked} onClick={() => void create()}>{busy ? "Creating classes…" : detail?.batches[0]?.sessions?.length ? "Update classes" : "Create classes"}</Button>
              {why && !busy ? <span className="text-sm text-foreground-600">{why}</span> : null}
            </div>
            {done ? <div className="mt-3 rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-foreground-900">
              <p className="font-semibold text-green-800">Timetable saved: {done.created} class{done.created === 1 ? "" : "es"} created{done.kept ? `, ${done.kept} kept` : ""}{done.endDate ? `, to ${shortDate(done.endDate)}` : ""}.</p>
              <p className="mt-1 flex flex-wrap gap-3">
                <Link className="font-semibold text-primary-700 hover:underline" to="/admin/lms/timetable">Open the calendar</Link>
                <Link className="font-semibold text-primary-700 hover:underline" to={`/admin/lms/intakes#${intake.id}`}>Open the intake</Link></p>
            </div> : null}
          </div></div>
      </Card> : null}
    </div>
  );
}
