// An intake's class timetable, the one way to set it (owner, 2026-11-19: no templates): the week from a one-click ready-made
// week, a copy of another intake, or ticking a day x part-of-day grid, with one room, one trainer and the seats; then
// Create classes saves the week (rto_course_flow batch_setup) and creates the dated classes inside the intake's unit dates
// (rto_class_sessions_generate). Used by Timetable › Create timetable, the intake's Class setup and the new course wizard.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { loadClosedDays, loadCourseNeed, planCourse, weeklyHoursNeeded, type CourseNeed } from "@/pages/admin/lib/coursePlan";
import {
  DAYS, SLOTS, clashText, generateClassSessions, rto, rtoFlow, shortDate, slotOf,
  type BatchSession, type Clash, type GenerateResult, type IntakeDetail, type LocationRooms, type RtoIntake, type SessionType, type Slot, type StaffOption,
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
const hoursOf = (start: string, end: string) => { const [a, b] = [start, end].map((t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; }); return Math.max(0, (b - a) / 60); };

export type ClassWeekSaved = { detail: IntakeDetail; generated: GenerateResult };

export default function ClassWeekSetup({ intakeId, courseId, canEdit, onSaved, createLabel }: {
  intakeId: string; courseId: string; canEdit: boolean;
  /** After the week is saved and the dated classes are created. */
  onSaved?: (out: ClassWeekSaved) => void;
  /** The button's words when the intake has no classes yet (default "Create classes"). */
  createLabel?: string;
}) {
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [locations, setLocations] = useState<LocationRooms[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [others, setOthers] = useState<RtoIntake[]>([]);
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

  /** The week from saved classes: each class goes to its part of the day; that part's times and type come from its first class. */
  const applySessions = (sessions: BatchSession[]) => {
    const next = freshRows(); const set = new Set<string>(); const seen = new Set<Slot>();
    for (const s of sessions) {
      const slot = slotOf(s.startTime);
      if (!seen.has(slot)) { seen.add(slot); next[slot] = { start: s.startTime.slice(0, 5), end: s.endTime.slice(0, 5), type: s.type }; }
      set.add(cellKey(s.weekday, slot));
    }
    setRows(next); setCells(set);
  };

  useEffect(() => {
    let live = true;
    setDetail(null); setDone(null); setClashes([]); setError("");
    void Promise.all([rto<IntakeDetail>("intake_get", { intakeId }), rtoFlow<LocationRooms[]>("locations_rooms"), rto<StaffOption[]>("staff_list"), rto<RtoIntake[]>("intake_list")])
      .then(([d, l, s, list]) => {
        if (!live) return;
        setDetail(d); setLocations(l); setStaff(s);
        setOthers(list.filter((i) => i.id !== intakeId && (i.batchList ?? []).some((b) => b.days.length > 0)));
        const group = d.batches[0];
        applySessions(group?.sessions ?? []);
        setRoomId(group?.sessions?.find((x) => x.roomId)?.roomId ?? group?.classroomId ?? "");
        setTrainerId(group?.trainers[0]?.id ?? "");
        setSeats(d.intake.capacity ? String(d.intake.capacity) : group?.capacity ? String(group.capacity) : "");
        void loadClosedDays(d.intake.startDate, courseId).then((f) => { if (live) setClosed(() => f); });
      }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The intake did not load."); });
    void loadCourseNeed(courseId).then((n) => { if (live) setNeed(n); }).catch(() => undefined);
    return () => { live = false; };
  }, [intakeId, courseId]);

  const rooms = locations.flatMap((l) => l.rooms.filter((r) => r.isActive).map((r) => ({ id: r.id, label: `${l.name} · ${r.name}${r.capacity ? ` (${r.capacity} seats)` : ""}` })));
  const sessions = useMemo(() => [...cells].map((key) => { const [day, slot] = key.split("|") as [string, Slot]; const r = rows[slot];
    return { weekday: Number(day), startTime: r.start, endTime: r.end, type: r.type, roomId: roomId || null }; })
    .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime)), [cells, rows, roomId]);
  const badTime = SLOTS.some((s) => [...cells].some((k) => k.endsWith(`|${s.id}`)) && (!rows[s.id].start || !rows[s.id].end || rows[s.id].end <= rows[s.id].start));
  const overlap = sessions.some((a, i) => sessions.some((b, j) => j > i && a.weekday === b.weekday && a.startTime < b.endTime && b.startTime < a.endTime));
  const weekly = sessions.reduce((sum, s) => sum + hoursOf(s.startTime, s.endTime), 0);
  const dates = detail?.intake ?? null;
  const needed = need && closed && dates?.endDate && need.total > 0 ? weeklyHoursNeeded(dates.startDate, dates.endDate, need.total, closed) : null;
  const plan = need && closed && dates && need.total > 0 && sessions.length && !badTime ? planCourse(dates.startDate, sessions, need, closed) : null;
  const enough = needed === null || weekly >= needed;
  const hasClasses = !!detail?.batches[0]?.sessions?.length;

  // Rooms already taken at these times (asked as the week changes).
  const sessionsKey = JSON.stringify(sessions);
  useEffect(() => {
    if (!detail || !roomId || !sessions.length || badTime) { setClashes([]); return; }
    let live = true;
    const t = window.setTimeout(() => {
      rtoFlow<Clash[]>("clash_check", { batchId: detail.batches[0]?.id ?? null, intakeId, sessions })
        .then((c) => { if (live) setClashes(c); }).catch(() => undefined);
    }, 350);
    return () => { live = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the week
  }, [sessionsKey, intakeId, detail?.intake.id]);
  const clashLines = [...new Set(clashes.map(clashText))];

  const toggle = (weekday: number, slot: Slot) => { setDone(null); setCells((s) => { const n = new Set(s); const k = cellKey(weekday, slot); if (n.has(k)) n.delete(k); else n.add(k); return n; }); };
  const preset = (p: (typeof PRESETS)[number]) => { setDone(null); setRows(freshRows()); setCells(new Set(p.days.flatMap((d) => p.slots.map((s) => cellKey(d, s))))); };
  const copyFrom = async (id: string) => {
    if (!id) return;
    try { const d = await rto<IntakeDetail>("intake_get", { intakeId: id }); applySessions(d.batches[0]?.sessions ?? []); setDone(null); }
    catch (e) { setError(e instanceof Error ? e.message : "That intake's week could not be read."); }
  };
  const setRow = (slot: Slot, patch: Partial<SlotRow>) => { setDone(null); setRows((r) => ({ ...r, [slot]: { ...r[slot], ...patch } })); };

  const create = async () => {
    setBusy(true); setError(""); setDone(null);
    try {
      const out = await rtoFlow<IntakeDetail & { batchId: string }>("batch_setup", { batchId: detail?.batches[0]?.id ?? null, intakeId, sessions, capacity: seats.trim(), trainerIds: trainerId ? [trainerId] : [] });
      const made = await generateClassSessions(out.batchId);
      setDetail(out); setDone(made);
      onSaved?.({ detail: out, generated: made });
    } catch (e) { setError(e instanceof Error ? e.message : "The timetable was not saved."); }
    finally { setBusy(false); }
  };

  const blocked = !canEdit || busy || !detail || !sessions.length || badTime || overlap || !roomId || clashLines.length > 0 || !enough;
  const why = !canEdit ? "Only an RTO Manager can create a timetable." : !sessions.length ? "Choose the class days and times." : badTime ? "Each class must end after it starts."
    : overlap ? "Two parts of the day overlap: change their times." : !roomId ? "Choose a room." : clashLines.length ? "Fix the room clash first."
    : !enough ? `This week gives ${weekly} hours; the course needs ${needed} a week to finish by ${shortDate(dates?.endDate ?? "")}.` : "";

  if (!detail && !error) return <p className="text-sm text-foreground-500">Loading…</p>;
  return (
    <div>
      {error ? <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <p className="text-sm text-foreground-600">Start from a ready-made week, then tick or untick any box.{dates ? ` Classes run inside the unit dates, ${shortDate(dates.startDate)} – ${dates.endDate ? shortDate(dates.endDate) : "open"}; term breaks and public holidays are skipped.` : ""}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {PRESETS.map((p) => <Button key={p.label} size="sm" variant="outline" disabled={busy} onClick={() => preset(p)}>{p.label}</Button>)}
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
                <TextInput className="!w-32" type="time" aria-label={`${s.label} starts`} value={rows[s.id].start} disabled={busy} onChange={(e) => setRow(s.id, { start: e.target.value })} />
                <TextInput className="!w-32" type="time" aria-label={`${s.label} ends`} value={rows[s.id].end} disabled={busy} onChange={(e) => setRow(s.id, { end: e.target.value })} />
                <Select className="!w-auto" aria-label={`${s.label} class type`} value={rows[s.id].type} disabled={busy} onChange={(e) => setRow(s.id, { type: e.target.value as SessionType })}>
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
      {detail && !rooms.length ? <p className="mt-2 text-sm text-foreground-600">No rooms yet: add one in <Link className="font-semibold text-primary-700 hover:underline" to="/admin/lms/timetable-settings?tab=locations">Timetable settings</Link>.</p> : null}

      <div className={`mt-3 rounded-lg border p-3 text-sm ${clashLines.length || overlap || badTime ? "border-red-300 bg-red-50" : !enough ? "border-amber-300 bg-amber-50" : "border-green-300 bg-green-50"}`}>
        <p className="font-semibold text-foreground-950">{sessions.length} class{sessions.length === 1 ? "" : "es"} a week · {weekly} hours a week{needed !== null ? ` · the course needs ${needed}` : ""}</p>
        {plan?.lastDate ? <p className="text-foreground-700">Last class about {shortDate(plan.lastDate)}{dates?.endDate ? ` (intake ends ${shortDate(dates.endDate)})` : ""}.</p> : null}
        {clashLines.map((line) => <p key={line} role="alert" className="font-semibold text-red-700">{line}</p>)}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button icon="ri-calendar-check-line" disabled={blocked} onClick={() => void create()}>{busy ? "Creating classes…" : hasClasses ? "Update classes" : createLabel ?? "Create classes"}</Button>
        {why && !busy ? <span className="text-sm text-foreground-600">{why}</span> : null}
      </div>
      {done ? <p role="status" className="mt-3 rounded-lg border border-green-300 bg-green-50 p-3 text-sm font-semibold text-green-800">
        Timetable saved: {done.created} class{done.created === 1 ? "" : "es"} created{done.kept ? `, ${done.kept} kept` : ""}{done.endDate ? `, to ${shortDate(done.endDate)}` : ""}.</p> : null}
    </div>
  );
}

/** The same timetable form in a dialog (the intake's Class setup, the new course wizard's last step). */
export function ClassWeekDialog({ title, intakeId, courseId, canEdit, createLabel, onClose, onSaved }: {
  title: string; intakeId: string; courseId: string; canEdit: boolean; createLabel?: string; onClose: () => void; onSaved?: (out: ClassWeekSaved) => void;
}) {
  return (
    <Modal open title={title} width="max-w-6xl" onClose={onClose} footer={<div className="flex justify-end"><Button variant="outline" onClick={onClose}>Close</Button></div>}>
      <ClassWeekSetup intakeId={intakeId} courseId={courseId} canEdit={canEdit} createLabel={createLabel} onSaved={onSaved} />
    </Modal>
  );
}
