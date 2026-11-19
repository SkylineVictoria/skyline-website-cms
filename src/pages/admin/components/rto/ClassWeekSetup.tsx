// An intake's class timetable, the one way to set it (used by Timetable › Create timetable, the intake's Class setup and the new
// course wizard). Owner, 2026-11-19: 1 the rooms the course uses (each for theory and / or practical, open hours from
// Bookings › Availability), 2 its trainers (free Monday to Sunday 9 am – 10 pm unless Bookings says otherwise), 3 the intake's CoE or
// VoE (saved on the intake: CoE at least 20 class hours a week, VoE 40; the unit dates are laid out again when it changes), 4 a Monday-to-Sunday week filled by itself from the units' theory / practical / assessment
// split, where any hour can be clicked and class times added by hand. Create classes saves the week (rto_course_flow batch_setup)
// and creates the dated classes inside the intake's unit dates (rto_class_sessions_generate).
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Modal, Select } from "@/pages/admin/components/ui";
import { roomAvailability, saveTrainerAvailability, trainerAvailability, type AvailabilityRow, type RoomUse } from "@/lib/bookingApi";
import { loadClosedDays, loadCourseNeed, planCourse, weeklyHoursNeeded, type CourseNeed } from "@/pages/admin/lib/coursePlan";
import {
  DAYS, LOAD_HOURS, clashText, generateClassSessions, loadIntakeLoads, rto, rtoFlow, setIntakeLoad, shortDate,
  type BatchSession, type StudyLoad, type Clash, type CourseDetail, type GenerateResult, type IntakeDetail, type LocationRooms, type RtoIntake, type SessionType, type StaffOption,
} from "@/pages/admin/lib/rto";

/** A class time in the week (minutes from midnight; weekday 1 = Monday ... 7 = Sunday). */
type Block = { weekday: number; start: number; end: number; type: SessionType; roomId: string; trainerId: string; manual: boolean };
/** The days and times a room or trainer is booked for this course (owner, 2026-11-20: not only whole days). */
type Window = { days: number[]; from: string; to: string };
/** A room or trainer booked for this course. A room can be booked more than once (say theory Mon–Thu, practical Fri), never twice
 * at the same time: `key` tells its bookings apart. */
type Pick = { key: string; id: string; theory: boolean; practical: boolean; /** Sized by the system, not changed by hand yet. */ fresh?: boolean; /** A trainer booking: the room booking it was made from. */ room?: string } & Window;
let pickSeq = 0;
const newKey = (id: string) => `${id}:${++pickSeq}`;
/** Two bookings of the same room overlap when they share a day and their times cross. */
const overlaps = (a: Window, b: Window) => a.days.some((d) => b.days.includes(d)) && toMin(a.from) < toMin(b.to) && toMin(b.from) < toMin(a.to);
const windowText = (w: Window) => `${w.days.length === 7 ? "Mon–Sun" : w.days.map((d) => DAYS[d - 1]).join(", ") || "no days"} ${clock(toMin(w.from))} – ${clock(toMin(w.to))}`;
const WINDOW: Window = { days: [1, 2, 3, 4, 5, 6, 7], from: "09:00", to: "22:00" };
type Hours = { avail: AvailabilityRow[]; uses: RoomUse[] };

const TYPES: SessionType[] = ["theory", "practical", "assessment"];
const TYPE_LABEL: Record<SessionType, string> = { theory: "Theory", practical: "Practical", assessment: "Assessment" };
const TYPE_LOOK: Record<SessionType, string> = {
  theory: "border-blue-300 bg-blue-100 text-blue-900",
  practical: "border-orange-300 bg-orange-100 text-orange-900",
  assessment: "border-violet-300 bg-violet-100 text-violet-900",
};
const FIRST_HOUR = 9, LAST_HOUR = 22; // the grid: 9 am to 10 pm
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);
/** A trainer with no hours in Bookings is free Monday to Sunday, 9 am – 10 pm. */
const TRAINER_DEFAULT: AvailabilityRow[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "22:00" }));

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const clock = (m: number) => { const h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${h >= 12 ? "pm" : "am"}`; };
/** Times to pick from, 6 am to 11 pm in quarter hours. */
/** A booking of exactly `hours` a week from `firstDay` on: the fewest days of at most 8 hours that split into quarter hours, 9 am on. */
function fitWindow(hours: number, firstDay: number): Window {
  if (hours <= 0) return { days: [], from: "09:00", to: "17:00" };
  let n = Math.min(7, Math.max(1, Math.ceil(hours / 8)));
  while (n < 7 && (hours * 4) % n !== 0) n += 1;
  const minutes = Math.ceil((hours * 60) / n / 15) * 15;
  const days = Array.from({ length: n }, (_, i) => ((firstDay - 1 + i) % 7) + 1).sort((a, b) => a - b);
  return { days, from: "09:00", to: toTime(9 * 60 + Math.min(minutes, 13 * 60)) };
}
const TIME_OPTIONS = Array.from({ length: (23 - 6) * 4 + 1 }, (_, i) => toTime(6 * 60 + i * 15));
const covers = (rows: AvailabilityRow[], weekday: number, s: number, e: number) => rows.some((r) => r.weekday === weekday % 7 && toMin(r.start) <= s && toMin(r.end) >= e);
const inWindow = (w: Window, weekday: number, s: number, e: number) => w.days.includes(weekday) && toMin(w.from) <= s && toMin(w.to) >= e;
/** The booked days and times of the classes in a saved week (for the rooms and trainers it uses). */
const windowOf = (list: Block[]): Window => list.length
  ? { days: [...new Set(list.map((b) => b.weekday))].sort((a, b) => a - b), from: toTime(Math.min(...list.map((b) => b.start))), to: toTime(Math.max(...list.map((b) => b.end))) }
  : WINDOW;
/** Days (Mo–Su) and a from–to time: when a room or trainer is booked for this course. */
function WindowEditor({ value, onChange, disabled, label, taken = [], limit }: {
  value: Window; onChange: (w: Window) => void; disabled?: boolean; label: string; taken?: Window[];
  /** The weekly hours allowed (CoE 20 / VoE 40), what the other bookings already take, and its name for the warning. */
  limit?: { max: number; others: number; name: string };
}) {
  const hours = (w: Window) => w.days.length * Math.max(0, (toMin(w.to) - toMin(w.from)) / 60);
  const round = (n: number) => Math.round(n * 100) / 100;
  const total = limit ? limit.others + hours(value) : 0;
  const over = !!limit && total > limit.max;
  const timeSelect = (which: "from" | "to") => <select aria-label={`${label}: ${which}`} value={value[which]} disabled={disabled}
    onChange={(e) => onChange({ ...value, [which]: e.target.value })}
    className={`h-8 rounded-md border bg-background-50 px-2 text-sm font-medium text-foreground-900 ${over ? "border-red-400" : "border-background-300"}`}>
    {(TIME_OPTIONS.includes(value[which]) ? TIME_OPTIONS : [value[which], ...TIME_OPTIONS]).map((t) => {
      // Times that would take the week over the limit are marked in the list.
      const past = !!limit && t !== value[which] && limit.others + hours({ ...value, [which]: t }) > limit.max;
      return <option key={t} value={t} disabled={past}>{clock(toMin(t))}{past ? " · over " + limit!.name : ""}</option>;
    })}
  </select>;
  return <div className="space-y-1.5">
    <div className="flex flex-wrap gap-1">
      {DAYS.map((d, i) => {
        const on = value.days.includes(i + 1);
        // A day another booking of this room already holds at these times cannot be ticked.
        const held = !on && taken.some((w) => overlaps(w, { ...value, days: [i + 1] }));
        const tooMany = !on && !held && !!limit && limit.others + hours({ ...value, days: [...value.days, i + 1] }) > limit.max;
        return <button key={d} type="button" aria-pressed={on} aria-label={`${label}: ${d}${held ? " (already booked)" : ""}`} disabled={disabled || held || tooMany} title={held ? "Already booked for this course at these times" : tooMany ? `More than ${limit?.max} hrs a week (${limit?.name})` : undefined}
          onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== i + 1) : [...value.days, i + 1].sort((a, b) => a - b) })}
          className={`h-8 w-8 rounded border text-xs font-semibold ${on ? "border-primary-600 bg-primary-600 text-white" : held || tooMany ? "cursor-not-allowed border-background-200 bg-background-200 text-foreground-400 line-through" : "border-background-300 bg-background-50 text-foreground-500"}`}>{d.slice(0, 2)}</button>;
      })}
    </div>
    <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-foreground-600">{timeSelect("from")}<span>to</span>{timeSelect("to")}</div>
    {value.days.length ? <p className={`text-xs ${over ? "font-semibold text-red-700" : "text-foreground-600"}`} role={over ? "alert" : undefined}>
      {value.days.length} day{value.days.length === 1 ? "" : "s"} × {round((toMin(value.to) - toMin(value.from)) / 60)} hrs = {round(hours(value))} hrs a week
      {limit ? over ? ` · over ${limit.name}: ${round(total)} of ${limit.max} hrs with the other rooms. Shorten the times or untick a day.` : ` · ${round(total)} of ${limit.max} hrs used` : ""}</p> : null}
  </div>;
}
const same = (a: Block, b: Block) => a.type === b.type && a.roomId === b.roomId && a.trainerId === b.trainerId && a.manual === b.manual;
/** Sorted, with touching class times of the same kind joined into one. */
function normalize(list: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of [...list].sort((x, y) => x.weekday - y.weekday || x.start - y.start)) {
    const last = out[out.length - 1];
    if (last && last.weekday === b.weekday && last.end === b.start && same(last, b)) last.end = b.end;
    else out.push({ ...b });
  }
  return out;
}
/** Takes one hour out of the week (a class time over it is split). */
const cutHour = (list: Block[], weekday: number, h: number) => list.flatMap((b) => {
  const s = h * 60, e = s + 60;
  if (b.weekday !== weekday || b.end <= s || b.start >= e) return [b];
  return [...(b.start < s ? [{ ...b, end: s }] : []), ...(b.end > e ? [{ ...b, start: e }] : [])];
});
/** Hours a week of each type, split like the units' hours (40 / 40 / 20 when the units have none). */
function splitHours(total: number, need: CourseNeed | null): Record<SessionType, number> {
  const base = need && need.total > 0 ? need : { theory: 40, practical: 40, assessment: 20, total: 100 };
  const theory = Math.round((total * base.theory) / base.total), practical = Math.min(total - theory, Math.round((total * base.practical) / base.total));
  return { theory, practical, assessment: Math.max(0, total - theory - practical) };
}
/** Bookings rows as "Mon–Fri 8 am – 6 pm; Sat 9 am – 1 pm". */
function hoursText(rows: AvailabilityRow[]) {
  const byTime = new Map<string, number[]>();
  for (const r of rows) { const k = `${r.start}|${r.end}`; byTime.set(k, [...(byTime.get(k) ?? []), r.weekday === 0 ? 7 : r.weekday]); }
  return [...byTime].map(([k, days]) => {
    const d = [...new Set(days)].sort((a, b) => a - b);
    const run = d.length > 2 && d[d.length - 1] - d[0] === d.length - 1 ? `${DAYS[d[0] - 1]}–${DAYS[d[d.length - 1] - 1]}` : d.map((x) => DAYS[x - 1]).join(", ");
    const [s, e] = k.split("|");
    return `${run} ${clock(toMin(s))} – ${clock(toMin(e))}`;
  }).join("; ");
}
const chip = (on: boolean, type: SessionType) => `min-h-9 rounded-full border px-3 text-xs font-semibold ${on ? TYPE_LOOK[type] : "border-background-300 bg-background-50 text-foreground-600 hover:bg-background-100"}`;

export type ClassWeekSaved = { detail: IntakeDetail; generated: GenerateResult };

type Page = "rooms" | "trainers" | "week";
/** localStorage key (+ intake id) of the rooms and trainers chosen and not yet saved. */
const DRAFT = "skyline.classweek.";
const PAGES: { id: Page; label: string }[] = [{ id: "rooms", label: "Rooms" }, { id: "trainers", label: "Trainers" }, { id: "week", label: "Weekly class times" }];

export default function ClassWeekSetup({ intakeId, courseId, canEdit, onSaved, createLabel, steps, onBack }: {
  intakeId: string; courseId: string; canEdit: boolean;
  /** In the new course wizard: the number of the Rooms step and of the last step ("Step 5 of 7 · Rooms"). */
  steps?: { first: number; total: number };
  /** New course wizard: Back on the first screen goes to the step before (start date and term breaks). */
  onBack?: () => void;
  /** After the week is saved and the dated classes are created. */
  onSaved?: (out: ClassWeekSaved) => void;
  /** The button's words when the intake has no classes yet (default "Create classes"). */
  createLabel?: string;
}) {
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [cricos, setCricos] = useState("");
  const [locations, setLocations] = useState<LocationRooms[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [others, setOthers] = useState<RtoIntake[]>([]);
  const [need, setNeed] = useState<CourseNeed | null>(null);
  const [closed, setClosed] = useState<((day: string) => boolean) | null>(null);
  const [roomPicks, setRoomPicks] = useState<Pick[]>([]);
  const [trainerPicks, setTrainerPicks] = useState<Pick[]>([]);
  const [roomHours, setRoomHours] = useState<Record<string, Hours>>({});
  const [trainerHours, setTrainerHours] = useState<Record<string, Hours>>({});
  const [kind, setKind] = useState<StudyLoad>("coe");
  const [blocks, setBlocks] = useState<Block[]>([]);
  /** False while the week is the automatic one: it fills again when the rooms, trainers or hours change. */
  const [touched, setTouched] = useState(false);
  const [brush, setBrush] = useState<SessionType>("theory");
  /** One screen at a time: rooms, then trainers, then the week (an intake with classes opens on the week). */
  const [page, setPage] = useState<Page>("rooms");
  const [showForm, setShowForm] = useState(false);
  /** Step 7 shows the week as made (owner, 2026-11-20); "Change the week" opens the tools to change it. */
  const [changing, setChanging] = useState(false);
  const [form, setForm] = useState({ days: [] as number[], start: "09:00", end: "13:00", type: "theory" as SessionType, roomId: "", trainerId: "" });
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [clashes, setClashes] = useState<Clash[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<GenerateResult | null>(null);

  const rooms = useMemo(() => locations.flatMap((l) => l.rooms.filter((r) => r.isActive).map((r) => ({ id: r.id, name: r.name, kind: l.kind, capacity: r.capacity, label: `${l.name} · ${r.name}${r.capacity ? ` (${r.capacity} seats)` : ""}` }))), [locations]);
  const roomName = (id: string) => rooms.find((r) => r.id === id)?.name ?? "No room";
  const trainerName = (id: string) => staff.find((s) => s.id === id)?.name ?? "Trainer to be set";

  /** The week from saved classes, with the rooms and trainers they use. */
  const applySessions = (sessions: BatchSession[], roomList = rooms) => {
    const list = normalize(sessions.map((s) => ({ weekday: s.weekday, start: toMin(s.startTime), end: toMin(s.endTime), type: s.type, roomId: s.roomId ?? "", trainerId: s.trainerId ?? "", manual: false })));
    setBlocks(list); setTouched(list.length > 0);
    const rIds = [...new Set(list.map((b) => b.roomId).filter(Boolean))];
    if (rIds.length) setRoomPicks(rIds.map((id) => {
      const types = list.filter((b) => b.roomId === id).map((b) => b.type);
      const k = roomList.find((r) => r.id === id)?.kind;
      const practical = types.length ? types.every((t) => t === "practical") : k === "practical";
      return { key: newKey(id), id, theory: !practical, practical, ...windowOf(list.filter((b) => b.roomId === id)) };
    }));
    const tIds = [...new Set(list.map((b) => b.trainerId).filter(Boolean))];
    if (tIds.length) setTrainerPicks(tIds.map((id) => {
      const mine = list.filter((b) => b.trainerId === id);
      const practical = mine.every((b) => b.type === "practical");
      return { key: newKey(id), id, theory: !practical, practical, ...windowOf(mine) };
    }));
  };

  useEffect(() => {
    let live = true;
    setDetail(null); setDone(null); setClashes([]); setError(""); setBlocks([]); setTouched(false); setRoomPicks([]); setTrainerPicks([]); setKind("coe"); setPage("rooms"); setShowForm(false);
    void Promise.all([rto<IntakeDetail>("intake_get", { intakeId }), rtoFlow<LocationRooms[]>("locations_rooms"), rto<StaffOption[]>("staff_list"), rto<RtoIntake[]>("intake_list"),
      rto<CourseDetail>("course_get", { courseId }).catch(() => null)])
      .then(([d, l, s, list, course]) => {
        if (!live) return;
        setDetail(d); setLocations(l); setStaff(s); setCricos(course?.course.cricos ?? "");
        setOthers(list.filter((i) => i.id !== intakeId && (i.batchList ?? []).some((b) => b.days.length > 0)));
        const roomList = l.flatMap((x) => x.rooms.filter((r) => r.isActive).map((r) => ({ id: r.id, name: r.name, kind: x.kind, capacity: r.capacity, label: r.name })));
        const saved = d.batches[0]?.sessions ?? [];
        // Trainers saved on the intake but on none of its class times (saved before a class had them) come back as fresh bookings.
        const savedTrainers = (d.batches[0]?.trainers ?? []).map((t) => t.id).filter((id) => !saved.some((x) => x.trainerId === id));
        if (saved.length) {
          applySessions(saved, roomList); setPage("week");
          if (savedTrainers.length) setTrainerPicks((l) => [...l, ...savedTrainers.map((id) => ({ key: newKey(id), id, theory: true, practical: false, fresh: true, ...WINDOW }))]);
        } else {
          // A new week starts with the first theory room and the first practical room; the trainers are added by hand.
          const firstOf = (k: "theory" | "practical") => roomList.find((r) => r.kind === k);
          const t = firstOf("theory"), p = firstOf("practical");
          const start = [t, p].filter((x): x is NonNullable<typeof x> => !!x);
          setRoomPicks((start.length ? start : roomList.slice(0, 1)).map((r) => ({ key: newKey(r.id), id: r.id, theory: r.kind !== "practical", practical: r.kind === "practical", fresh: true, ...WINDOW })));
          if (savedTrainers.length) setTrainerPicks(savedTrainers.map((id) => ({ key: newKey(id), id, theory: true, practical: false, fresh: true, ...WINDOW })));
        }
        // Rooms and trainers chosen on this computer and not yet saved with Create classes (the wizard closed in between).
        try {
          const draft = JSON.parse(window.localStorage.getItem(DRAFT + intakeId) ?? "null") as { rooms: Pick[]; trainers: Pick[]; page: Page } | null;
          if (draft?.rooms?.length) { setRoomPicks(draft.rooms.map((x) => ({ ...x, fresh: false }))); setTrainerPicks((draft.trainers ?? []).map((x) => ({ ...x, fresh: false }))); if (!saved.length) setPage(draft.page ?? "rooms"); }
        } catch { /* no draft */ }
        void loadClosedDays(d.intake.startDate, courseId).then((f) => { if (live) setClosed(() => f); });
      }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The intake did not load."); });
    void loadCourseNeed(courseId).then((n) => { if (live) setNeed(n); }).catch(() => undefined);
    void loadIntakeLoads(courseId).then((m) => { if (live) setKind(m[intakeId] ?? "coe"); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads once per intake
  }, [intakeId, courseId]);

  // Open hours and other intakes' classes of each chosen room and trainer (Bookings). Unreadable ones count as always free.
  const roomKey = [...new Set(roomPicks.map((r) => r.id))].join(","), trainerKey = [...new Set(trainerPicks.map((t) => t.id))].join(",");
  useEffect(() => {
    let live = true;
    for (const id of roomKey ? roomKey.split(",") : []) if (!roomHours[id]) void roomAvailability(id)
      .then((r) => { if (live) setRoomHours((m) => ({ ...m, [id]: { avail: r.availability, uses: r.bookings } })); })
      .catch(() => { if (live) setRoomHours((m) => ({ ...m, [id]: { avail: [], uses: [] } })); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the chosen rooms
  }, [roomKey]);
  useEffect(() => {
    let live = true;
    for (const id of trainerKey ? trainerKey.split(",") : []) if (!trainerHours[id]) void trainerAvailability(id)
      .then((r) => { if (live) setTrainerHours((m) => ({ ...m, [id]: { avail: r.availability, uses: r.bookings } })); })
      .catch(() => { if (live) setTrainerHours((m) => ({ ...m, [id]: { avail: [], uses: [] } })); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the chosen trainers
  }, [trainerKey]);

  const dates = detail?.intake ?? null;
  const busyElsewhere = (uses: RoomUse[], weekday: number, s: number, e: number) => uses.some((u) => u.intakeId !== intakeId && u.weekday === weekday % 7
    && toMin(u.startTime) < e && toMin(u.endTime) > s && (!dates || ((!u.endDate || u.endDate >= dates.startDate) && (!dates.endDate || u.startDate <= dates.endDate))));
  const roomFree = (id: string, weekday: number, s: number, e: number, type?: SessionType) => {
    const own = roomPicks.filter((x) => x.id === id && (!type || roomsFor(type).includes(x)));
    if (own.length && !own.some((p) => inWindow(p, weekday, s, e))) return false;
    const h = roomHours[id];
    return !h || ((h.avail.length === 0 || covers(h.avail, weekday, s, e)) && !busyElsewhere(h.uses, weekday, s, e));
  };
  const trainerFree = (id: string, weekday: number, s: number, e: number, type?: SessionType) => {
    const own = trainerPicks.filter((x) => x.id === id && (!type || trainersFor(type).includes(x)));
    if (own.length && !own.some((p) => inWindow(p, weekday, s, e))) return false;
    const h = trainerHours[id];
    return covers(h?.avail.length ? h.avail : TRAINER_DEFAULT, weekday, s, e) && !busyElsewhere(h?.uses ?? [], weekday, s, e);
  };
  const roomsFor = (t: SessionType) => {
    const fit = roomPicks.filter((r) => (t === "practical" ? r.practical : r.theory));
    return t === "assessment" && !fit.length ? roomPicks : fit;
  };
  /** Free in Bookings (or Mon–Sun 9 am – 10 pm) and not teaching another intake then, whatever this course's booking says. */
  const trainerOpen = (id: string, weekday: number, s: number, e: number) => {
    const h = trainerHours[id];
    return covers(h?.avail.length ? h.avail : TRAINER_DEFAULT, weekday, s, e) && !busyElsewhere(h?.uses ?? [], weekday, s, e);
  };
  /** The trainer for a class: one booked for its type and time; else one of this course's trainers for its type who is free; else any of them free. */
  const trainerAt = (t: SessionType, weekday: number, s: number, e: number) =>
    trainersFor(t).find((x) => inWindow(x, weekday, s, e) && trainerFree(x.id, weekday, s, e))
    ?? trainersFor(t).find((x) => trainerOpen(x.id, weekday, s, e))
    ?? trainerPicks.find((x) => trainerOpen(x.id, weekday, s, e));
  const trainersFor = (t: SessionType) => trainerPicks.filter((x) => t === "assessment" || (t === "practical" ? x.practical : x.theory));
  /** A free room (and trainer, when the course has any) for this type at this time; null when there is none. */
  const pickFor = (t: SessionType, weekday: number, s: number, e: number) => {
    const room = roomsFor(t).find((r) => inWindow(r, weekday, s, e) && roomFree(r.id, weekday, s, e));
    if (!room) return null;
    const trainer = trainerPicks.length ? trainerAt(t, weekday, s, e) : undefined;
    // No booked trainer free then: the class still goes in the booked room, with "Trainer to be set" (changed on step 6 or by hand).
    return { roomId: room.id, trainerId: trainer?.id ?? "" };
  };
  const taken = (list: Block[], weekday: number, s: number, e: number) => list.some((b) => b.weekday === weekday && b.start < e && b.end > s);

  // Hours a week: the intake's CoE (20) or VoE (40), or more when the unit dates need it; they can be raised by hand.
  const needed = need && closed && dates?.endDate && need.total > 0 ? weeklyHoursNeeded(dates.startDate, dates.endDate, need.total, closed) : null;
  const floor = LOAD_HOURS[kind];
  // CoE 20 / VoE 40 class hours a week is the most a week can have (owner, 2026-11-20): the week is filled to it and never past it.
  const target = floor;
  /** CoE / VoE is saved on the intake at once: its unit dates are laid out again at that rate. */
  const changeKind = async (k: StudyLoad) => {
    if (k === kind || !detail) return;
    setBusy(true); setError(""); setDone(null);
    try {
      await setIntakeLoad(intakeId, k);
      const d = await rto<IntakeDetail>("intake_get", { intakeId });
      setDetail(d); setKind(k);
    } catch (e) { setError(e instanceof Error ? e.message : "CoE / VoE was not changed."); }
    finally { setBusy(false); }
  };
  const split = splitHours(target, need);

  /** The default week (owner, 2026-11-20): each type's hours placed inside the times its rooms are booked for (step 5), day by day
   * from the first booked hour, wherever a booked trainer is free too. Theory first, then practical, then assessment in the theory
   * rooms' hours that are left. */
  const autoWeek = () => {
    const out: Block[] = [];
    const slots = (w: Window) => w.days.flatMap((weekday) => {
      const list: { weekday: number; s: number }[] = [];
      for (let m = toMin(w.from); m + 60 <= toMin(w.to); m += 60) list.push({ weekday, s: m });
      return list;
    });
    for (const t of TYPES) {
      let left = split[t];
      for (const w of roomsFor(t)) {
        for (const { weekday, s } of slots(w)) {
          if (left <= 0) break;
          if (taken(out, weekday, s, s + 60)) continue;
          const p = pickFor(t, weekday, s, s + 60);
          if (!p) continue;
          out.push({ weekday, start: s, end: s + 60, type: t, roomId: p.roomId, trainerId: p.trainerId, manual: false });
          left--;
        }
      }
    }
    return normalize(out);
  };
  /** Why a type cannot be booked at this hour (for the striped cells). */
  const whyNot = (t: SessionType, weekday: number, s: number, e: number) => {
    const rs = roomsFor(t);
    if (!rs.length) return `no ${t} room chosen (step ${steps ? steps.first : 1})`;
    const inTime = rs.filter((r) => inWindow(r, weekday, s, e));
    if (!inTime.length) return `no ${t} room booked at this time (step ${steps ? steps.first : 1})`;
    for (const r of inTime) {
      const h = roomHours[r.id];
      const use = h?.uses.find((u) => u.intakeId !== intakeId && u.weekday === weekday % 7 && toMin(u.startTime) < e && toMin(u.endTime) > s);
      if (use) return `${roomName(r.id)} is used by ${use.courseCode} ${use.intake} then`;
      if (h?.avail.length && !covers(h.avail, weekday, s, e)) return `${roomName(r.id)} is closed then (Bookings)`;
    }
    const ts = trainersFor(t);
    if (ts.length && !ts.some((x) => inWindow(x, weekday, s, e))) return `no ${t} trainer booked at this time (step ${steps ? steps.first + 1 : 2})`;
    return `no ${t} trainer free then`;
  };
  const hoursReady = roomPicks.every((r) => roomHours[r.id]) && trainerPicks.every((t) => trainerHours[t.id]);
  const pickKey = (x: Pick) => `${+x.theory}${+x.practical}${x.days.join("")}${x.from}${x.to}`;
  const autoKey = `${roomKey}|${roomPicks.map(pickKey).join(",")}|${trainerKey}|${trainerPicks.map(pickKey).join(",")}|${target}|${need?.total ?? 0}|${hoursReady}`;
  useEffect(() => {
    if (!detail || touched || !hoursReady) return;
    setBlocks(autoWeek());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refills when what the default week depends on changes
  }, [autoKey, touched, detail?.intake.id]);
  const draftKey = `${roomPicks.map((x) => x.key + pickKey(x)).join(",")}|${trainerPicks.map((x) => x.key + pickKey(x)).join(",")}|${page}`;
  useEffect(() => {
    if (!detail || !roomPicks.length || roomPicks.some((x) => x.fresh) || trainerPicks.some((x) => x.fresh)) return;
    try { window.localStorage.setItem(DRAFT + intakeId, JSON.stringify({ rooms: roomPicks, trainers: trainerPicks, page })); } catch { /* storage off */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saved whenever the choices change
  }, [draftKey]);
  useEffect(() => {
    if (!trainerPicks.some((t) => t.fresh) || !roomPicks.length || roomPicks.some((r) => r.fresh)) return;
    setTrainerPicks((l) => {
      const kept = l.filter((t) => !t.fresh);
      return [...new Set(l.filter((t) => t.fresh).map((t) => t.id))].reduce((acc, id) => [...acc, ...roomCopies(id, acc)], kept);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the rooms are known
  }, [draftKey]);
  // A class time without a trainer (a saved week, or one changed by hand) gets a booked trainer free for all of it, as soon as one is.
  const trainerWindowsKey = `${trainerKey}|${trainerPicks.map(pickKey).join(",")}|${hoursReady}`;
  useEffect(() => {
    if (!hoursReady || !trainerPicks.length) return;
    setBlocks((list) => {
      let changed = false;
      const next = list.map((b) => {
        if (b.trainerId) return b;
        const t = trainerAt(b.type, b.weekday, b.start, b.end);
        if (!t) return b;
        changed = true;
        return { ...b, trainerId: t.id };
      });
      return changed ? normalize(next) : list;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the trainers or their bookings change
  }, [trainerWindowsKey]);

  const sessions = useMemo(() => blocks.map((b) => ({ weekday: b.weekday, startTime: toTime(b.start), endTime: toTime(b.end), type: b.type, roomId: b.roomId || null, trainerId: b.trainerId || null })), [blocks]);
  const weekly = blocks.reduce((sum, b) => sum + (b.end - b.start) / 60, 0);
  const byType = TYPES.map((t) => ({ t, h: blocks.filter((b) => b.type === t).reduce((s, b) => s + (b.end - b.start) / 60, 0) }));
  const plan = need && closed && dates && need.total > 0 && sessions.length ? planCourse(dates.startDate, sessions, need, closed) : null;
  const usedRooms = [...new Set(blocks.map((b) => b.roomId).filter(Boolean))];
  const seatOf = (id: string) => rooms.find((r) => r.id === id)?.capacity ?? null;
  const roomSeats = usedRooms.length && usedRooms.every((id) => seatOf(id)) ? Math.min(...usedRooms.map((id) => seatOf(id)!)) : null;
  const noRoom = blocks.some((b) => !b.roomId);
  const hasClasses = !!detail?.batches[0]?.sessions?.length;

  // Rooms and trainers already taken at these times, checked by the server as the week changes.
  const sessionsKey = JSON.stringify(sessions);
  useEffect(() => {
    if (!detail || !sessions.some((x) => x.roomId)) { setClashes([]); return; }
    let live = true;
    const t = window.setTimeout(() => {
      rtoFlow<Clash[]>("clash_check", { batchId: detail.batches[0]?.id ?? null, intakeId, sessions })
        .then((c) => { if (live) setClashes(c); }).catch(() => undefined);
    }, 350);
    return () => { live = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the week
  }, [sessionsKey, intakeId, detail?.intake.id]);
  const clashLines = [...new Set(clashes.map(clashText))];

  const edit = (next: Block[]) => { setBlocks(normalize(next)); setTouched(true); setDone(null); setFormMsg(null); };
  const clickHour = (weekday: number, h: number) => {
    const s = h * 60, e = s + 60;
    if (taken(blocks, weekday, s, e)) return edit(cutHour(blocks, weekday, h));
    if (weekly + 1 > target) { setFormMsg({ ok: false, text: `The week already has ${weekly} of the ${target} hours ${kind === "coe" ? "CoE" : "VoE"} allows: remove a class first.` }); setShowForm(true); return; }
    const p = pickFor(brush, weekday, s, e);
    if (p) edit([...blocks, { weekday, start: s, end: e, type: brush, ...p, manual: true }]);
  };
  const addByHand = () => {
    const s = toMin(form.start), e = toMin(form.end);
    const fail = (text: string) => setFormMsg({ ok: false, text });
    const roomId = form.roomId || roomsFor(form.type)[0]?.id || "";
    if (!form.days.length) return fail("Pick at least one day.");
    if (!form.start || !form.end || e <= s) return fail("The end time must be after the start time.");
    if (!roomId) return fail(`No room is chosen for ${form.type} classes: add one under 1. Rooms.`);
    const days = [...form.days].sort((a, b) => a - b);
    if (weekly + (days.length * (e - s)) / 60 > target) return fail(`That adds ${(days.length * (e - s)) / 60} hours to the ${weekly} booked: more than the ${target} hours a week ${kind === "coe" ? "CoE" : "VoE"} allows.`);
    for (const d of days) {
      const day = DAYS[d - 1];
      if (taken(blocks, d, s, e)) return fail(`${day} already has a class between ${clock(s)} and ${clock(e)}. Remove it first or pick other times.`);
      if (!roomFree(roomId, d, s, e, form.type)) return fail(`${roomName(roomId)} is not free on ${day} ${clock(s)} – ${clock(e)} (not booked for this course then, closed in Bookings › Availability, or another intake uses it).`);
      if (form.trainerId && !trainerFree(form.trainerId, d, s, e, form.type)) return fail(`${trainerName(form.trainerId)} is not free on ${day} ${clock(s)} – ${clock(e)}.`);
    }
    edit([...blocks, ...days.map((weekday) => ({ weekday, start: s, end: e, type: form.type, roomId, trainerId: form.trainerId, manual: true }))]);
    setFormMsg({ ok: true, text: `Added: ${days.map((d) => DAYS[d - 1]).join(", ")} ${clock(s)} – ${clock(e)}, ${form.type} in ${roomName(roomId)}${form.trainerId ? ` with ${trainerName(form.trainerId)}` : ""}.` });
  };
  const copyFrom = async (id: string) => {
    if (!id) return;
    try { const d = await rto<IntakeDetail>("intake_get", { intakeId: id }); applySessions(d.batches[0]?.sessions ?? []); setDone(null); }
    catch (e) { setError(e instanceof Error ? e.message : "That intake's week could not be read."); }
  };

  const create = async (list: Block[] = blocks) => {
    setBusy(true); setError(""); setDone(null);
    try {
      const week = list.map((b) => ({ weekday: b.weekday, startTime: toTime(b.start), endTime: toTime(b.end), type: b.type, roomId: b.roomId || null, trainerId: b.trainerId || null }));
      const ids = [...new Set(list.map((b) => b.roomId).filter(Boolean))];
      const seats = ids.length && ids.every((id) => seatOf(id)) ? Math.min(...ids.map((id) => seatOf(id)!)) : null;
      const out = await rtoFlow<IntakeDetail & { batchId: string }>("batch_setup", { batchId: detail?.batches[0]?.id ?? null, intakeId, sessions: week, capacity: seats ? String(seats) : "", trainerIds: [...new Set([...week.map((x) => x.trainerId), ...trainerPicks.map((t) => t.id)].filter(Boolean))] });
      const made = await generateClassSessions(out.batchId);
      setDetail(out); setDone(made);
      try { window.localStorage.removeItem(DRAFT + intakeId); } catch { /* storage off */ }
      onSaved?.({ detail: out, generated: made });
    } catch (e) { setError(e instanceof Error ? e.message : "The timetable was not saved."); }
    finally { setBusy(false); }
  };

  const over = weekly > target;
  const short = weekly < target;
  // The unit dates need more hours a week than CoE / VoE allows: the course runs longer (shown, does not block).
  const behind = needed !== null && needed > target;
  const noTrainer = blocks.filter((b) => !b.trainerId).length;
  const blocked = !canEdit || busy || !detail || !sessions.length || noRoom || noTrainer > 0 || clashLines.length > 0 || over || short;
  const why = !canEdit ? "Only an RTO Manager can create a timetable." : !sessions.length ? "Add class times to the week." : noRoom ? "Every class needs a room." : noTrainer ? `${noTrainer} class time${noTrainer === 1 ? " has" : "s have"} no trainer: book a trainer for ${noTrainer === 1 ? "it" : "them"} on step ${steps ? steps.first + 1 : 2}, or change the week.`
    : clashLines.length ? "Fix the clash first." : over ? `${weekly} hours is more than the ${target} a week ${kind === "coe" ? "CoE" : "VoE"} allows.`
    : short ? `The week has ${weekly} of the ${target} hours a week: add ${target - weekly} more.` : "";
  const freeRooms = rooms;
  /** Bookings of the same room that cross this one (same day, times overlap). */
  const clashOf = (p: Pick) => roomPicks.filter((x) => x.key !== p.key && x.id === p.id && overlaps(x, p));
  const roomsBad = roomPicks.some((p) => !p.days.length || toMin(p.to) <= toMin(p.from) || clashOf(p).length > 0);
  /** A room added again starts on the days its other bookings leave free. */
  const addRoom = (id: string) => {
    const r = rooms.find((x) => x.id === id);
    if (!r) return;
    const used = new Set(roomPicks.filter((x) => x.id === id).flatMap((x) => x.days));
    const again = used.size > 0;
    const practical = again ? !roomPicks.find((x) => x.id === id)?.practical : r.kind === "practical";
    const missing = Math.max(0, Math.min(target - roomTotal, (practical ? needPractical : needTheory) - bookedHours(roomPicks, practical)));
    const allUsed = new Set(roomPicks.flatMap((x) => x.days));
    const firstFree = WINDOW.days.find((d) => !allUsed.has(d)) ?? 1;
    const w = fitWindow(missing, firstFree);
    setRoomPicks((l) => [...l, { key: newKey(id), id, theory: !practical, practical, ...w }]);
  };
  const freeStaff = staff;
  const trainerClashOf = (p: Pick) => trainerPicks.filter((x) => x.key !== p.key && x.id === p.id && overlaps(x, p));
  const trainersBad = trainerPicks.some((p) => !p.days.length || toMin(p.to) <= toMin(p.from) || trainerClashOf(p).length > 0);
  /** The room bookings no trainer covers yet, as bookings for this trainer (never two of its own at once). */
  const roomCopies = (id: string, list: Pick[], rooms = roomPicks) => {
    const out: Pick[] = [];
    for (const r of rooms) {
      if (!r.days.length || list.some((t) => t.practical === r.practical && overlaps(t, r))) continue;
      if ([...list, ...out].some((t) => t.id === id && overlaps(t, r))) continue;
      out.push({ key: newKey(id), id, theory: r.theory, practical: r.practical, days: [...r.days], from: r.from, to: r.to, room: r.key });
    }
    return out;
  };
  const addTrainer = (id: string) => {
    if (!id) return;
    const copies = roomCopies(id, trainerPicks);
    setTrainerPicks((l) => [...l, ...(copies.length ? copies : [{ key: newKey(id), id, theory: true, practical: false, days: [], from: "09:00", to: "17:00" }])]);
  };
  /** Adds this booking's days and times to the trainer's own hours in Bookings › Availability (the server only lets a trainer teach
   * inside them). */
  const addTrainerHours = async (p: Pick, days: number[]) => {
    setBusy(true); setError("");
    try {
      const cur = await trainerAvailability(p.id);
      const rows = [...cur.availability, ...days.map((d) => ({ weekday: d % 7, start: p.from, end: p.to }))];
      const out = await saveTrainerAvailability(p.id, rows, cur.timeOff);
      setTrainerHours((m) => ({ ...m, [p.id]: { avail: out.availability, uses: out.bookings } }));
    } catch (e) { setError(e instanceof Error ? e.message : "The trainer's hours were not saved."); }
    finally { setBusy(false); }
  };
  const setTrainerType = (key: string, practical: boolean) => setTrainerPicks((l) => l.map((x) => (x.key === key ? { ...x, theory: !practical, practical } : x)));

  const at = PAGES.findIndex((x) => x.id === page);
  const stepName = (i: number) => (steps ? `Step ${steps.first + i} of ${steps.total} · ${PAGES[i].label}` : `${i + 1}. ${PAGES[i].label}`);
  /** A room is used for theory or for practical: choosing one unticks the other. */
  const setRoomType = (key: string, practical: boolean) => setRoomPicks((l) => l.map((x) => (x.key === key ? { ...x, theory: !practical, practical } : x)));

  // What the units need each week at this CoE / VoE rate, against what the rooms and trainers are booked for (owner, 2026-11-20):
  // theory rooms take theory and assessment classes, practical rooms practical ones.
  const windowHours = (w: Window) => w.days.length * Math.max(0, (toMin(w.to) - toMin(w.from)) / 60);
  const needTheory = split.theory + split.assessment, needPractical = split.practical;
  const bookedHours = (list: Pick[], practical: boolean) => list.filter((x) => (practical ? x.practical : x.theory)).reduce((sum, x) => sum + windowHours(x), 0);
  const roomCheck = [
    { label: "Theory and assessment", need: needTheory, got: bookedHours(roomPicks, false) },
    { label: "Practical", need: needPractical, got: bookedHours(roomPicks, true) },
  ].filter((x) => x.need > 0);
  const trainerCheck = [
    { label: "Theory and assessment", need: needTheory, got: bookedHours(trainerPicks, false) },
    { label: "Practical", need: needPractical, got: bookedHours(trainerPicks, true) },
  ].filter((x) => x.need > 0);
  const roomsShort = roomCheck.some((x) => x.got < x.need);
  const trainersShort = trainerPicks.length > 0 && trainerCheck.some((x) => x.got < x.need);
  const trainerTotal = trainerPicks.reduce((sum, x) => sum + windowHours(x), 0);
  const trainersOver = trainerTotal > target;
  const needKey = `${needTheory}|${needPractical}|${roomPicks.map((x) => `${x.key}${x.fresh ? "f" : ""}${+x.practical}`).join(",")}`;
  useEffect(() => {
    if (!need || !roomPicks.some((x) => x.fresh) || !roomPicks.every((r) => roomHours[r.id])) return;
    // Each booking goes on days and times its room is open and no other intake uses it, and never at the same time as another
    // booking of this course (the students cannot be in two rooms at once).
    const sized = new Map<string, Window>();
    const placed: Window[] = roomPicks.filter((x) => !x.fresh && x.days.length);
    const free = (id: string, w: Window) => w.days.every((d) => {
      const h = roomHours[id];
      return (!h?.avail.length || covers(h.avail, d, toMin(w.from), toMin(w.to))) && !busyElsewhere(h?.uses ?? [], d, toMin(w.from), toMin(w.to));
    }) && !placed.some((x) => overlaps(x, w));
    for (const practical of [false, true]) {
      const mine = roomPicks.filter((x) => x.fresh && x.practical === practical);
      const total = practical ? needPractical : needTheory;
      mine.forEach((x, i) => {
        const share = Math.floor(total / mine.length) + (i < total % mine.length ? 1 : 0);
        const shape = fitWindow(share, 1);
        let best: Window | null = null;
        // The same length each day, from 9 am on: the first start time with enough free days.
        for (let startMin = 9 * 60; !best && startMin + (toMin(shape.to) - toMin(shape.from)) <= 22 * 60; startMin += 60) {
          const w0 = { from: toTime(startMin), to: toTime(startMin + toMin(shape.to) - toMin(shape.from)) };
          const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => free(x.id, { days: [d], ...w0 }));
          if (days.length >= shape.days.length) best = { days: days.slice(0, shape.days.length), ...w0 };
        }
        const w = best ?? shape;
        sized.set(x.key, w); placed.push(w);
      });
    }
    setRoomPicks((l) => l.map((x) => (sized.has(x.key) ? { ...x, ...sized.get(x.key)!, fresh: false } : x)));
    // A trainer the system added gets the rooms' bookings.
    const sizedRooms = roomPicks.map((x) => (sized.has(x.key) ? { ...x, ...sized.get(x.key)! } : x));
    setTrainerPicks((l) => {
      const kept = l.filter((t) => !t.fresh);
      const ids = [...new Set(l.filter((t) => t.fresh).map((t) => t.id))];
      return ids.reduce((acc, id) => [...acc, ...roomCopies(id, acc, sizedRooms)], kept);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sizes the system's own bookings once the hours are known
  }, [needKey, !!need, roomPicks.every((r) => roomHours[r.id])]);
  // Bookings kept from before (a draft) that another intake now uses are placed again on free times, with the trainers following,
  // once per opening and only while the intake has no saved classes.
  const reclaimed = useRef("");
  const roomsLoaded = roomPicks.length > 0 && roomPicks.every((r) => roomHours[r.id]);
  useEffect(() => {
    if (!detail || !roomsLoaded || reclaimed.current === intakeId || detail.batches[0]?.sessions?.length) return;
    reclaimed.current = intakeId;
    const bad = roomPicks.filter((x) => !x.fresh && usedBy(x).length);
    if (!bad.length) return;
    setRoomPicks((l) => l.map((x) => (bad.some((b) => b.key === x.key) ? { ...x, fresh: true } : x)));
    setTrainerPicks((l) => l.map((t) => ({ ...t, fresh: true })));
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the rooms' bookings are known
  }, [roomsLoaded, detail?.intake.id]);
  /** Other intakes' classes in this room during this booking (they cannot share it). */
  const usedBy = (p: Pick) => (roomHours[p.id]?.uses ?? []).filter((u) => u.intakeId !== intakeId && p.days.includes(u.weekday === 0 ? 7 : u.weekday)
    && toMin(u.startTime) < toMin(p.to) && toMin(u.endTime) > toMin(p.from) && (!dates || ((!u.endDate || u.endDate >= dates.startDate) && (!dates.endDate || u.startDate <= dates.endDate))));
  const roomTotal = roomPicks.reduce((sum, x) => sum + windowHours(x), 0);
  const roomsOver = roomTotal > target;
  const hoursBox = (rows: { label: string; need: number; got: number }[], what: string, total?: number) => (
    <div className={`rounded-lg border p-3 text-sm ${total !== undefined && total > target ? "border-red-300 bg-red-50" : rows.some((x) => x.got < x.need) ? "border-amber-300 bg-amber-50" : "border-green-300 bg-green-50"}`}>
      <p className="font-semibold text-foreground-950">Each week the units need ({kind === "coe" ? "CoE" : "VoE"}, {target} hrs):</p>
      <ul className="mt-1 space-y-0.5">{rows.map((x) => <li key={x.label} className={x.got < x.need ? "text-amber-900" : "text-green-800"}>
        <i className={`${x.got < x.need ? "ri-error-warning-line" : "ri-checkbox-circle-line"} mr-1`} aria-hidden="true" />
        {x.label}: {x.need} hrs · {what} booked {Math.round(x.got * 10) / 10} hrs{x.got < x.need ? `, ${Math.round((x.need - x.got) * 10) / 10} more needed` : ""}</li>)}</ul>
      {total !== undefined ? <p role={total > target ? "alert" : undefined} className={`mt-1 font-semibold ${total > target ? "text-red-700" : "text-foreground-800"}`}>
        <i className={`${total > target ? "ri-close-circle-line" : "ri-time-line"} mr-1`} aria-hidden="true" />
        All {what} together: {Math.round(total * 10) / 10} of {target} hrs a week{total > target ? `: ${Math.round((total - target) * 10) / 10} hrs too many for ${kind === "coe" ? "CoE" : "VoE"}. Shorten the days or times.` : ""}</p> : null}
    </div>
  );
  // CoE / VoE is chosen on the Rooms step (owner, 2026-11-20): the rooms are sized to it, so later steps cannot change it.
  const kindLocked = !!steps || page !== "rooms";
  const loadPanel = (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-background-200 bg-background-100/60 p-3">
      {/* Once chosen, CoE / VoE is only shown, greyed out (owner, 2026-11-20). */}
      {kindLocked ? <div className="flex items-center gap-2 rounded-lg border border-background-300 bg-background-200/70 px-3 py-1.5 text-sm text-foreground-600" aria-label={`Students on ${kind === "coe" ? "CoE" : "VoE"}`}>
        <i className="ri-lock-line" aria-hidden="true" />
        <span><span className="block font-bold">{kind === "coe" ? "CoE" : "VoE"} · {LOAD_HOURS[kind]} hrs a week</span>
          <span className="block text-xs">{steps ? `Chosen on step ${steps.first - 1}` : "Chosen on the Rooms step"}</span></span>
      </div> : <div className="flex gap-2" role="radiogroup" aria-label="Students on">
        {(["coe", "voe"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} disabled={busy || !canEdit} onClick={() => void changeKind(k)}
          className={`rounded-lg border px-3 py-1.5 text-left text-sm ${kind === k ? "border-2 border-primary-600 bg-primary-50 text-primary-900" : "border-background-300 bg-background-50 text-foreground-700"}`}>
          <span className="block font-bold">{k === "coe" ? "CoE" : "VoE"}</span><span className="block text-xs">{LOAD_HOURS[k]} hrs a week</span>
        </button>)}
      </div>}
      <div className="text-center"><span className="block text-xl font-bold tabular-nums">{target}</span><span className="block text-xs text-foreground-600">hrs a week</span></div>
      <p className="min-w-[220px] flex-1 text-sm text-foreground-700">{split.theory} theory + {split.practical} practical + {split.assessment} assessment
        {need?.total ? <span className="block text-xs text-foreground-600">{need.total} hrs ÷ {target} a week ≈ {Math.ceil((need.total / target) * 2) / 2} teaching weeks{dates ? ` · unit dates ${shortDate(dates.startDate)} – ${dates.endDate ? shortDate(dates.endDate) : "open"}` : ""}</span> : null}</p>
    </div>
  );

  if (!detail && !error) return <p className="text-sm text-foreground-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <nav aria-label="Timetable steps" className="flex flex-wrap gap-2">
        {PAGES.map((x, i) => <button key={x.id} type="button" aria-current={page === x.id ? "step" : undefined} disabled={busy} onClick={() => setPage(x.id)}
          className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${page === x.id ? "border-primary-600 bg-primary-600 text-white" : i < at ? "border-primary-200 bg-primary-50 text-primary-800" : "border-background-300 bg-background-50 text-foreground-600"}`}>
          {i < at ? "✓ " : ""}{stepName(i)}</button>)}
      </nav>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      {loadPanel}

      {page === "rooms" ? <section className="space-y-3">
        <p className="text-sm text-foreground-600">Which rooms will this course use? Each room is for theory or for practical. Open hours come from <Link className="font-semibold text-primary-700 hover:underline" to="/admin/bookings?tab=availability&who=rooms">Bookings › Availability</Link>.</p>
        {roomPicks.length ? <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-background-100 text-left text-xs font-semibold text-foreground-600"><tr><th className="px-3 py-2">Room</th><th className="px-3 py-2">Used for</th><th className="px-3 py-2">Booked for this course</th><th className="px-3 py-2">Open (Bookings)</th><th className="px-3 py-2"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{roomPicks.map((p) => { const r = rooms.find((x) => x.id === p.id); const h = roomHours[p.id]; const clash = clashOf(p); return (
              <tr key={p.key} className="border-t border-background-200 align-top">
                <td className="px-3 py-2 font-medium text-foreground-950">{r?.label ?? "Room"}
                  {usedBy(p).length ? <span role="alert" className="mt-1 block text-xs font-semibold text-amber-800">Already used then by {[...new Set(usedBy(p).map((u) => `${u.courseCode} ${u.intake}`))].join(", ")} ({[...new Set(usedBy(p).map((u) => `${DAYS[(u.weekday === 0 ? 7 : u.weekday) - 1]} ${clock(toMin(u.startTime))}–${clock(toMin(u.endTime))}`))].join(", ")}): pick other days or times.</span> : null}
                  {clash.length ? <span role="alert" className="mt-1 block text-xs font-semibold text-red-700">Overlaps its other booking ({windowText(clash[0])}): change the days or times.</span>
                    : !p.days.length ? <span role="alert" className="mt-1 block text-xs font-semibold text-red-700">Pick at least one day.</span>
                    : toMin(p.to) <= toMin(p.from) ? <span role="alert" className="mt-1 block text-xs font-semibold text-red-700">The end time must be after the start.</span> : null}</td>
                <td className="px-3 py-2"><div className="flex gap-1.5" role="radiogroup" aria-label={`${r?.name ?? "Room"} is used for`}>
                  <button type="button" role="radio" aria-checked={p.theory} disabled={busy} className={chip(p.theory, "theory")} onClick={() => setRoomType(p.key, false)}>Theory</button>
                  <button type="button" role="radio" aria-checked={p.practical} disabled={busy} className={chip(p.practical, "practical")} onClick={() => setRoomType(p.key, true)}>Practical</button>
                </div></td>
                <td className="px-3 py-2"><WindowEditor label={`${r?.name ?? "Room"} booked`} value={p} disabled={busy} taken={roomPicks.filter((x) => x.key !== p.key && x.id === p.id)}
                  limit={{ max: target, others: roomTotal - windowHours(p), name: kind === "coe" ? "CoE" : "VoE" }} onChange={(w) => setRoomPicks((l) => l.map((x) => (x.key === p.key ? { ...x, ...w, fresh: false } : x)))} /></td>
                <td className="px-3 py-2 text-xs text-foreground-700">{!h ? "…" : h.avail.length ? hoursText(h.avail) : "Any time (no hours set)"}</td>
                <td className="px-3 py-2 text-right"><button type="button" disabled={busy} aria-label={`Remove ${r?.name ?? "room"}`} className="rounded p-2 text-red-700 hover:bg-red-50"
                  onClick={() => setRoomPicks((l) => l.filter((x) => x.key !== p.key))}><i className="ri-delete-bin-line" aria-hidden="true" /></button></td>
              </tr>); })}</tbody>
          </table>
        </div> : <p className="text-sm text-foreground-500">No room yet.</p>}
        {freeRooms.length ? <Select className="!w-auto" aria-label="Add a room" value="" disabled={busy} onChange={(e) => addRoom(e.target.value)}>
          <option value="">+ Add another room…</option>{freeRooms.map((r) => <option key={r.id} value={r.id}>{r.label}{roomPicks.some((x) => x.id === r.id) ? " (book again, other times)" : ""}</option>)}
        </Select> : null}
        {roomPicks.length ? hoursBox(roomCheck, "rooms", roomTotal) : null}
        {detail && !rooms.length ? <p className="text-sm text-foreground-600">No rooms yet: add one in <Link className="font-semibold text-primary-700 hover:underline" to="/admin/lms/timetable-settings?tab=locations">Timetable settings</Link>.</p> : null}
      </section> : null}

      {page === "trainers" ? <section className="space-y-3">
        <p className="text-sm text-foreground-600">Who teaches this course? Like the rooms, each booking of a trainer is for theory or for practical, and a trainer is never booked twice at the same time. A trainer you add is booked for the rooms' times that no trainer has yet; change them if you need to. Every trainer is free Mon–Sun 9 am – 10 pm unless <Link className="font-semibold text-primary-700 hover:underline" to="/admin/bookings?tab=availability&who=trainers">Bookings › Availability</Link> says otherwise.</p>
        {trainerPicks.length ? <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-background-100 text-left text-xs font-semibold text-foreground-600"><tr><th className="px-3 py-2">Trainer</th><th className="px-3 py-2">Teaches</th><th className="px-3 py-2">Booked for this course</th><th className="px-3 py-2">Free (Bookings)</th><th className="px-3 py-2"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{trainerPicks.map((p) => { const h = trainerHours[p.id]; const clash = trainerClashOf(p); return (
              <tr key={p.key} className="border-t border-background-200 align-top">
                <td className="px-3 py-2 font-medium text-foreground-950">{trainerName(p.id)}
                  {clash.length ? <span role="alert" className="mt-1 block text-xs font-semibold text-red-700">Overlaps their other booking ({windowText(clash[0])}): change the days or times.</span>
                    : !p.days.length ? <span role="alert" className="mt-1 block text-xs font-semibold text-red-700">Pick at least one day.</span>
                    : toMin(p.to) <= toMin(p.from) ? <span role="alert" className="mt-1 block text-xs font-semibold text-red-700">The end time must be after the start.</span> : null}</td>
                <td className="px-3 py-2"><div className="flex gap-1.5" role="radiogroup" aria-label={`${trainerName(p.id)} teaches`}>
                  <button type="button" role="radio" aria-checked={p.theory} disabled={busy} className={chip(p.theory, "theory")} onClick={() => setTrainerType(p.key, false)}>Theory</button>
                  <button type="button" role="radio" aria-checked={p.practical} disabled={busy} className={chip(p.practical, "practical")} onClick={() => setTrainerType(p.key, true)}>Practical</button>
                </div></td>
                <td className="px-3 py-2">
                  <WindowEditor label={`${trainerName(p.id)} booked`} value={p} disabled={busy} taken={trainerPicks.filter((x) => x.key !== p.key && x.id === p.id)}
                    limit={{ max: target, others: trainerTotal - windowHours(p), name: kind === "coe" ? "CoE" : "VoE" }}
                    onChange={(w) => setTrainerPicks((l) => l.map((x) => (x.key === p.key ? { ...x, ...w, fresh: false } : x)))} />
                  {/* The room booking this trainer booking came from (made by the system when the trainer was added). */}
                  {(() => {
                    // Days and times of this booking outside the trainer's own Bookings hours (allowed, shown so staff know).
                    const avail = trainerHours[p.id]?.avail ?? [];
                    const outside = avail.length ? p.days.filter((d) => !covers(avail, d, toMin(p.from), toMin(p.to))) : [];
                    return outside.length ? <div className="mt-1 rounded border border-red-200 bg-red-50 p-1.5 text-xs text-red-800">
                      <p className="font-semibold"><i className="ri-error-warning-line mr-1" aria-hidden="true" />{trainerName(p.id)} is not available on {outside.map((d) => DAYS[d - 1]).join(", ")} in Bookings (only {hoursText(avail)}), so no class can have them then.</p>
                      {canEdit ? <button type="button" disabled={busy} onClick={() => void addTrainerHours(p, outside)} className="mt-1 rounded border border-red-300 bg-background-50 px-2 py-1 font-semibold text-red-800 hover:bg-red-100">
                        Add {outside.map((d) => DAYS[d - 1]).join(", ")} {clock(toMin(p.from))} – {clock(toMin(p.to))} to {trainerName(p.id)}'s Bookings hours</button> : null}
                    </div> : null;
                  })()}
                  {(() => { const r = roomPicks.find((x) => x.key === p.room); return r ? <p className="mt-1 text-xs text-foreground-600"><i className="ri-door-open-line mr-1" aria-hidden="true" />With {roomName(r.id)}{r.days.join() === p.days.join() && r.from === p.from && r.to === p.to ? "" : " (times changed)"}</p> : null; })()}</td>
                <td className="px-3 py-2 text-xs text-foreground-700">{!h ? "…" : h.avail.length ? hoursText(h.avail) : "Mon–Sun 9 am – 10 pm"}</td>
                <td className="px-3 py-2 text-right"><button type="button" disabled={busy} aria-label={`Remove this booking of ${trainerName(p.id)}`} className="rounded p-2 text-red-700 hover:bg-red-50"
                  onClick={() => setTrainerPicks((l) => l.filter((x) => x.key !== p.key))}><i className="ri-delete-bin-line" aria-hidden="true" /></button></td>
              </tr>); })}</tbody>
          </table>
        </div> : <p className="text-sm font-semibold text-amber-800">Add a trainer: every class needs one.</p>}
        {trainerTotal >= target ? <p className="text-sm text-foreground-600"><i className="ri-information-line mr-1" aria-hidden="true" />All {target} hrs a week have a trainer. To add another, shorten or remove a booking first.</p>
          : freeStaff.length ? <Select className="!w-auto" aria-label="Add a trainer" value="" disabled={busy} onChange={(e) => addTrainer(e.target.value)}>
          <option value="">+ Add a trainer…</option>{freeStaff.map((x) => <option key={x.id} value={x.id}>{x.name}{trainerPicks.some((t) => t.id === x.id) ? " (book again, other times)" : ""}</option>)}
        </Select> : null}
        {trainerPicks.length ? hoursBox(trainerCheck, "trainers", trainerTotal) : null}
      </section> : null}

      {page === "week" ? <section className="space-y-3">
        {noTrainer ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <span className="min-w-0 flex-1"><b>{noTrainer} class time{noTrainer === 1 ? " has" : "s have"} no trainer.</b> {trainerPicks.length ? "Book a trainer for those days and times." : "Add the trainer who teaches this course."} Classes cannot be saved without one.</span>
          <Button size="sm" icon="ri-user-add-line" disabled={busy} onClick={() => setPage("trainers")}>Go to trainers</Button>
        </div> : null}
        {/* The week is made from the rooms and trainers by itself and shown as it is; staff change it only if they want to. */}
        {!changing ? <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-foreground-700">{touched ? "Your weekly calendar, with your changes." : "Your weekly calendar, made from the rooms and trainers you booked."}</p>
          {canEdit ? <Button size="sm" variant="outline" icon="ri-edit-line" disabled={busy} onClick={() => setChanging(true)}>Change the week</Button> : null}
        </div> : <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary-200 bg-primary-50/40 p-2">
          <span className="text-xs font-semibold text-foreground-700">Pick a type and click an hour to add it; click a class to remove it. Add as:</span>
          {TYPES.map((t) => <button key={t} type="button" aria-pressed={brush === t} disabled={busy} className={chip(brush === t, t)} onClick={() => setBrush(t)}>{TYPE_LABEL[t]}</button>)}
          <span className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { setTouched(false); setBlocks(autoWeek()); setFormMsg(null); setDone(null); }}>{touched ? "Undo my changes" : "Make it again"}</Button>
            {blocks.length ? <Button size="sm" variant="outline" disabled={busy} onClick={() => edit([])}>Clear</Button> : null}
            <Button size="sm" variant="outline" icon="ri-add-line" disabled={busy} onClick={() => setShowForm((v) => !v)}>Add a class time yourself</Button>
            <Button size="sm" icon="ri-check-line" disabled={busy} onClick={() => { setChanging(false); setShowForm(false); }}>Done changing</Button>
          </span>
        </div>}

        {changing && showForm ? <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/40 p-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
            {DAYS.map((d, i) => { const on = form.days.includes(i + 1); return <button key={d} type="button" aria-pressed={on} disabled={busy}
              onClick={() => { setFormMsg(null); setForm((f) => ({ ...f, days: on ? f.days.filter((x) => x !== i + 1) : [...f.days, i + 1] })); }}
              className={`min-h-10 min-w-12 rounded-lg border px-2 text-sm font-semibold ${on ? "border-primary-600 bg-primary-600 text-white" : "border-background-300 bg-background-50 text-foreground-700"}`}>{d}</button>; })}
          </div>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6 lg:items-end">
            <label className="text-xs font-semibold text-foreground-700">From<input type="time" step={900} value={form.start} disabled={busy} onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))} className="mt-1 block h-10 w-full rounded-lg border border-background-300 bg-background-50 px-2 text-sm" /></label>
            <label className="text-xs font-semibold text-foreground-700">To<input type="time" step={900} value={form.end} disabled={busy} onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))} className="mt-1 block h-10 w-full rounded-lg border border-background-300 bg-background-50 px-2 text-sm" /></label>
            <label className="text-xs font-semibold text-foreground-700">Type<Select className="mt-1" value={form.type} disabled={busy} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as SessionType, roomId: "" }))}>
              {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</Select></label>
            <label className="text-xs font-semibold text-foreground-700">Room<Select className="mt-1" value={form.roomId} disabled={busy} onChange={(e) => setForm((f) => ({ ...f, roomId: e.target.value }))}>
              <option value="">{roomsFor(form.type)[0] ? `${roomName(roomsFor(form.type)[0].id)} (first free)` : "No room chosen"}</option>
              {[...new Set(roomsFor(form.type).map((r) => r.id))].map((id) => <option key={id} value={id}>{roomName(id)}</option>)}</Select></label>
            <label className="text-xs font-semibold text-foreground-700">Trainer<Select className="mt-1" value={form.trainerId} disabled={busy} onChange={(e) => setForm((f) => ({ ...f, trainerId: e.target.value }))}>
              <option value="">To be set</option>{[...new Set(trainersFor(form.type).map((x) => x.id))].map((id) => <option key={id} value={id}>{trainerName(id)}</option>)}</Select></label>
            <Button icon="ri-add-line" disabled={busy} onClick={addByHand}>Add</Button>
          </div>
          {formMsg ? <p role="status" className={`rounded-lg p-2 text-sm font-semibold ${formMsg.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>{formMsg.text}</p> : null}
        </div> : null}

        <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[860px] table-fixed border-separate border-spacing-0.5 text-xs">
            <thead><tr><th className="w-16" />{DAYS.map((d) => <th key={d} className="py-1.5 text-sm font-semibold text-foreground-700">{d}</th>)}</tr></thead>
            <tbody>{HOURS.map((h) => (
              <tr key={h}>
                <td className="pr-2 text-right align-top text-foreground-600">{clock(h * 60)}</td>
                {DAYS.map((d, i) => {
                  const weekday = i + 1, s = h * 60, e = s + 60;
                  const b = blocks.find((x) => x.weekday === weekday && x.start < e && x.end > s);
                  if (b) {
                    // One block per class time (owner, 2026-11-20): the room and trainer shown together with its type and times.
                    const firstRow = Math.max(FIRST_HOUR, Math.floor(b.start / 60));
                    if (h !== firstRow) return null;
                    const span = HOURS.filter((x) => x * 60 < b.end && x * 60 + 60 > b.start).length;
                    return <td key={d} rowSpan={span} className="align-top">
                      <button type="button" disabled={busy || !changing} onClick={() => edit(blocks.filter((x) => x !== b))}
                        aria-label={`${d} ${clock(b.start)} – ${clock(b.end)}: ${TYPE_LABEL[b.type]}, ${roomName(b.roomId)}, ${trainerName(b.trainerId)}${changing ? ", click to remove" : ""}`}
                        style={{ height: span * 44 + (span - 1) * 2 }}
                        className={`flex w-full flex-col gap-0.5 overflow-hidden rounded-md border-l-4 px-2 py-1.5 text-left text-xs leading-snug disabled:cursor-default disabled:opacity-100 ${TYPE_LOOK[b.type]} ${changing ? "hover:brightness-95" : ""}`}>
                        <span className="font-bold">{TYPE_LABEL[b.type]}</span>
                        <span className="text-[11px] opacity-80">{clock(b.start)} – {clock(b.end)}</span>
                        <span className="mt-0.5 flex items-center gap-1 truncate"><i className="ri-door-open-line" aria-hidden="true" />{roomName(b.roomId)}</span>
                        <span className={`flex items-center gap-1 truncate ${b.trainerId ? "" : "font-semibold text-red-700"}`}><i className="ri-user-line" aria-hidden="true" />{b.trainerId ? trainerName(b.trainerId) : "No trainer"}</span>
                      </button></td>;
                  }
                  if (!changing) return <td key={d}><span className="block h-11 w-full rounded border border-background-100 bg-background-50" /></td>;
                  const free = !!pickFor(brush, weekday, s, e);
                  // Hours the rooms are booked for (step 5) show with the room's name even before a class is put there.
                  const booked = roomPicks.find((r) => inWindow(r, weekday, s, e));
                  const why = free ? "" : whyNot(brush, weekday, s, e);
                  return <td key={d}><button type="button" disabled={busy || !free} onClick={() => clickHour(weekday, h)}
                    aria-label={free ? `${d} ${clock(s)}: ${booked ? `${roomName(booked.id)} booked, ` : ""}click to add ${brush}` : `${d} ${clock(s)}: ${why}`}
                    title={free ? undefined : `${d} ${clock(s)}: ${why}`}
                    className={`h-11 w-full overflow-hidden rounded border px-1 text-left leading-tight ${booked
                      ? `border-dashed ${booked.practical ? "border-orange-300 bg-orange-50 text-orange-800" : "border-blue-300 bg-blue-50 text-blue-800"} ${free ? "hover:border-solid" : "cursor-not-allowed opacity-70"}`
                      : free ? "border-dashed border-background-300 bg-background-50 text-foreground-400 hover:border-primary-400 hover:text-primary-700"
                      : "cursor-not-allowed border-background-200 bg-[repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6_4px,#e5e7eb_4px,#e5e7eb_8px)]"}`}>
                    {booked ? <><span className="block truncate text-[11px] font-semibold">{booked.practical ? "Practical" : "Theory"} room</span><span className="block truncate text-[11px]">{roomName(booked.id)}{free ? " · +" : ""}</span></> : free ? "+" : ""}</button></td>;
                })}
              </tr>))}</tbody>
          </table>
        </div>
        {!blocks.length ? <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          No class could be placed: {roomPicks.some((p) => usedBy(p).length) ? "the rooms' booked times are used by other intakes." : "the rooms and trainers have no booked times that are free."} Go back to step {steps ? steps.first : 1} and pick other days or times.</p> : null}
        {changing ? <p className="text-xs text-foreground-600">Dashed blue / orange: hours a theory / practical room is booked for (step {steps ? steps.first : 1}). Striped: {brush} cannot go there (hover to see why: not booked on step {steps ? steps.first : 1} or {steps ? steps.first + 1 : 2}, closed, or used by another intake).{blocks.some((b) => b.start < FIRST_HOUR * 60 || b.end > LAST_HOUR * 60) ? " Some class times are outside 9 am – 10 pm: see the list below." : ""}</p> : null}

        {blocks.length ? <details className="rounded-lg border border-background-200">
          <summary className="cursor-pointer px-3 py-2 text-sm font-bold text-foreground-950">Class times this week ({blocks.length})</summary>
          <ul className="border-t border-background-200">{blocks.map((b, i) => (
            <li key={`${b.weekday}-${b.start}-${i}`} className="flex flex-wrap items-center gap-3 border-b border-background-100 px-3 py-1.5 text-sm last:border-0">
              <span className={`h-3 w-3 rounded border ${TYPE_LOOK[b.type]}`} aria-hidden="true" />
              <span className="min-w-[180px] font-semibold text-foreground-950">{DAYS[b.weekday - 1]} {clock(b.start)} – {clock(b.end)}</span>
              <span className="min-w-[90px]">{TYPE_LABEL[b.type]}</span>
              <span className="min-w-[160px] flex-1 text-foreground-700">{roomName(b.roomId)} · {trainerName(b.trainerId)}</span>
              {b.manual ? <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-800">Added by hand</span> : null}
              <button type="button" disabled={busy} aria-label={`Remove ${DAYS[b.weekday - 1]} ${clock(b.start)} class`} className="rounded px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                onClick={() => edit(blocks.filter((_, j) => j !== i))}>Remove</button>
            </li>))}</ul>
        </details> : null}

        <div className={`rounded-lg border p-3 text-sm ${clashLines.length ? "border-red-300 bg-red-50" : over ? "border-red-300 bg-red-50" : short || behind ? "border-amber-300 bg-amber-50" : "border-green-300 bg-green-50"}`}>
          <p className="font-semibold text-foreground-950">{weekly} of {target} hours a week booked · {byType.filter((x) => x.h).map((x) => `${x.h} ${x.t}`).join(", ") || "no classes"}</p>
          <p className="text-foreground-700">Seats: {roomSeats ? `${roomSeats} (the smallest room used)` : usedRooms.length ? "a room has no seat count: set it in Locations & rooms" : "from the rooms"}.{plan?.lastDate ? ` Last class about ${shortDate(plan.lastDate)}${dates?.endDate ? ` (intake ends ${shortDate(dates.endDate)})` : ""}.` : ""}</p>
          {behind ? <p className="text-amber-900">At most {target} hours a week, the units need until about {plan?.lastDate ? shortDate(plan.lastDate) : "later"} — past the unit dates ({dates?.endDate ? shortDate(dates.endDate) : ""}). Fewer unit hours (step 3) would shorten it.</p> : null}
          {clashLines.map((line) => <p key={line} role="alert" className="font-semibold text-red-700">{line}</p>)}
        </div>
      </section> : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-background-200 pt-3">
        <Button variant="outline" icon="ri-arrow-left-line" disabled={busy || (at === 0 && !onBack)} onClick={() => (at === 0 ? onBack?.() : setPage(PAGES[at - 1].id))}>
          {at === 0 && onBack && steps ? `Back: step ${steps.first - 1}` : "Back"}</Button>
        {page !== "week"
          ? <Button disabled={busy || (page === "rooms" && (!roomPicks.length || roomsBad || roomsShort || roomsOver)) || (page === "trainers" && (!trainerPicks.length || trainersShort || trainersBad || trainersOver))} icon="ri-arrow-right-line" onClick={() => setPage(PAGES[at + 1].id)}>Next: {PAGES[at + 1].label.toLowerCase()}</Button>
          : <span className="flex flex-wrap items-center justify-end gap-3">
            {why && !busy ? <span className="text-sm text-foreground-600">{why}</span> : null}
            <Button icon="ri-calendar-check-line" disabled={blocked} onClick={() => void create()}>{busy ? "Creating classes…" : hasClasses ? "Update classes" : createLabel ?? "Create classes"}</Button>
          </span>}
      </div>
      {done ? <p role="status" className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm font-semibold text-green-800">
        Timetable saved: {done.created} class{done.created === 1 ? "" : "es"} created{done.kept ? `, ${done.kept} kept` : ""}{done.endDate ? `, to ${shortDate(done.endDate)}` : ""}.</p> : null}
    </div>
  );
}

/** The same timetable form in a dialog (the intake's Class setup, the new course wizard's last step). */
export function ClassWeekDialog({ title, intakeId, courseId, canEdit, createLabel, onClose, onSaved, steps, onBack }: {
  title: string; intakeId: string; courseId: string; canEdit: boolean; createLabel?: string; onClose: () => void; onSaved?: (out: ClassWeekSaved) => void;
  steps?: { first: number; total: number }; onBack?: () => void;
}) {
  return (
    <Modal open keepOpen title={title} width="max-w-6xl" onClose={onClose}>
      <ClassWeekSetup intakeId={intakeId} courseId={courseId} canEdit={canEdit} createLabel={createLabel} onSaved={onSaved} steps={steps} onBack={onBack} />
    </Modal>
  );
}
