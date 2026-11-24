// An intake's class timetable, the one way to set it (used by Timetable › Create timetable, the intake's Class setup and the new
// course wizard). Owner, 2026-11-19: 1 the rooms the course uses (each for theory and / or practical, open hours from
// Bookings › Availability), 2 its trainers (free Monday to Sunday 9 am – 10 pm unless Bookings says otherwise), 3 the intake's CoE or
// VoE (saved on the intake: CoE at least 20 class hours a week, VoE 40; the unit dates are laid out again when it changes), 4 a Monday-to-Sunday week filled by itself from the units' theory / practical / assessment
// split, where any hour can be clicked and class times added by hand. Create classes saves the week (rto_course_flow batch_setup)
// and creates the dated classes inside the intake's unit dates (rto_class_sessions_generate).
import { useEffect, useMemo, useState } from "react";
import { onRules, ruleNumber, ruleObject, weekdayIndex } from "@/lib/businessRules";
import { Link } from "react-router-dom";
import { Button, Modal, Select } from "@/pages/admin/components/ui";
import { roomAvailability, trainerAvailability, type AvailabilityRow, type RoomUse } from "@/lib/bookingApi";
import { loadClosedDays, loadCourseNeed, planCourse, weeklyHoursNeeded, type CourseNeed } from "@/pages/admin/lib/coursePlan";
import {
  DAYS, LOAD_HOURS, clashText, generateClassSessions, loadIntakeLoads, rto, rtoFlow, setIntakeLoad, shortDate,
  type BatchSession, type StudyLoad, type Clash, type CourseDetail, type GenerateResult, type IntakeDetail, type LocationRooms, type RtoIntake, type SessionType, type StaffOption,
} from "@/pages/admin/lib/rto";

/** A class time in the week (minutes from midnight; weekday 1 = Monday ... 7 = Sunday). */
type Block = { weekday: number; start: number; end: number; type: SessionType; roomId: string; trainerId: string; manual: boolean };
/** The days and times a room or trainer is booked for this course (owner, 2026-11-20: not only whole days). */
type Window = { days: number[]; from: string; to: string };
/** A room or trainer chosen for this course (once each), with the days and times it is booked for the course (owner,
 * 2026-11-20: staff choose the slot, inside its Bookings › Availability). Other intakes' classes are still kept free. */
type Pick = { key: string; id: string; theory: boolean; practical: boolean; /** Sized by the system, not changed by hand yet. */ fresh?: boolean; /** A trainer booking: the room booking it was made from. */ room?: string } & Window;
let pickSeq = 0;
const newKey = (id: string) => `${id}:${++pickSeq}`;
/** A new room or trainer booking: the days and times of Business Rule lms.class_setup_availability_fallback (Mon–Sun 9 am – 10 pm today). */
let WINDOW: Window = { days: [1, 2, 3, 4, 5, 6, 7], from: "09:00", to: "22:00" };
type Hours = { avail: AvailabilityRow[]; uses: RoomUse[] };

const TYPES: SessionType[] = ["theory", "practical", "assessment"];
const TYPE_LABEL: Record<SessionType, string> = { theory: "Theory", practical: "Practical", assessment: "Assessment" };
const TYPE_LOOK: Record<SessionType, string> = {
  theory: "border-blue-300 bg-blue-100 text-blue-900",
  practical: "border-orange-300 bg-orange-100 text-orange-900",
  assessment: "border-violet-300 bg-violet-100 text-violet-900",
};
/** Earliest and latest class times (Business Rules lms.class_suggestion_hours, 7 am and 10 pm today), in minutes. */
let EARLIEST = 7 * 60, LATEST = 22 * 60;
/** The grid: 9 am (or the earliest time when later) to the latest time; suggestions never end after it. */
let FIRST_HOUR = 9, LAST_HOUR = 22;
let HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);
/** A trainer with no hours in Bookings is free Monday to Sunday, 9 am – 10 pm. */
let TRAINER_DEFAULT: AvailabilityRow[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "22:00" }));
onRules(() => {
  const f = ruleObject("lms.class_setup_availability_fallback", { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as unknown, start: "09:00", end: "22:00" });
  const days = (Array.isArray(f.days) ? f.days : []).map((d) => weekdayIndex(String(d))).filter((d) => d >= 0);
  TRAINER_DEFAULT = days.map((weekday) => ({ weekday, start: String(f.start), end: String(f.end) }));
  WINDOW = { days: [...new Set(days.map((d) => (d === 0 ? 7 : d)))].sort((a, b) => a - b), from: String(f.start), to: String(f.end) };
});

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const clock = (m: number) => { const h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${h >= 12 ? "pm" : "am"}`; };
const covers = (rows: AvailabilityRow[], weekday: number, s: number, e: number) => rows.some((r) => r.weekday === weekday % 7 && toMin(r.start) <= s && toMin(r.end) >= e);
const inWindow = (w: Window, weekday: number, s: number, e: number) => w.days.includes(weekday) && toMin(w.from) <= s && toMin(w.to) >= e;
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
/** Hours a week of each type, split like the units' hours (Business Rule lms.unit_hours_split, 40 / 40 / 20 today, when the units have none). */
function splitHours(total: number, need: CourseNeed | null): Record<SessionType, number> {
  const split = ruleObject("lms.unit_hours_split", { theoryPercent: 40, practicalPercent: 40, assessmentPercent: 20 });
  const base = need && need.total > 0 ? need : { theory: Number(split.theoryPercent), practical: Number(split.practicalPercent), assessment: Number(split.assessmentPercent), total: 100 };
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
let TIME_OPTIONS = Array.from({ length: 31 }, (_, i) => toTime(7 * 60 + i * 30)); // earliest – latest (7 am – 10 pm today), half hours
onRules(() => {
  const h = ruleObject("lms.class_suggestion_hours", { earliest: "07:00" as unknown, latest: "22:00" as unknown });
  const time = (v: unknown) => (typeof v === "string" && /^([01]\d|2[0-3]):(00|30)$|^24:00$/.test(v) ? toMin(v) : null);
  const e = time(h.earliest), l = time(h.latest);
  [EARLIEST, LATEST] = e !== null && l !== null && e < l ? [e, l] : [7 * 60, 22 * 60];
  FIRST_HOUR = Math.max(9, Math.ceil(EARLIEST / 60));
  LAST_HOUR = Math.max(FIRST_HOUR + 1, Math.floor(LATEST / 60));
  HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);
  TIME_OPTIONS = Array.from({ length: Math.floor((LATEST - EARLIEST) / 30) + 1 }, (_, i) => toTime(EARLIEST + i * 30));
});
/** The days and times a room or trainer is booked for this course, inside its Bookings hours (`avail`; none = any time). */
function SlotEditor({ value, onChange, avail, disabled, label, limit, taken = [] }: {
  value: Window; onChange: (w: Window) => void; avail: AvailabilityRow[] | null; disabled?: boolean; label: string;
  /** Its other bookings for this course: never two at the same time. */
  taken?: Window[];
  /** CoE 20 / VoE 40 (owner, 2026-11-20): the most hours a week, what the other bookings of the list already take, and its name. */
  limit: { max: number; others: number; name: string };
}) {
  const over = (w: Window) => limit.others + slotHours(w) > limit.max + 1e-9;
  const openOn = (day: number) => !avail || !avail.length || avail.some((r) => r.weekday === day % 7);
  const rows = (avail ?? []).filter((r) => value.days.some((d) => r.weekday === d % 7));
  const lo = rows.length ? Math.min(...rows.map((r) => toMin(r.start))) : EARLIEST, hi = rows.length ? Math.max(...rows.map((r) => toMin(r.end))) : LATEST;
  const options = TIME_OPTIONS.filter((t) => toMin(t) >= lo && toMin(t) <= hi);
  const outside = avail?.length ? value.days.filter((d) => !covers(avail, d, toMin(value.from), toMin(value.to))) : [];
  const bad = !value.days.length ? "Pick at least one day." : toMin(value.to) <= toMin(value.from) ? "The end must be after the start." : "";
  const timeSelect = (which: "from" | "to") => <select aria-label={`${label}: ${which}`} value={value[which]} disabled={disabled}
    onChange={(e) => onChange({ ...value, [which]: e.target.value })}
    className="h-8 rounded-md border border-background-300 bg-background-50 px-2 text-sm font-medium text-foreground-900">
    {(options.includes(value[which]) ? options : [value[which], ...options]).map((t) => {
      const past = t !== value[which] && over({ ...value, [which]: t });
      return <option key={t} value={t}>{clock(toMin(t))}{past ? ` · over ${limit.name}` : ""}</option>;
    })}
  </select>;
  return <div className="space-y-1.5">
    <div className="flex flex-wrap gap-1">
      {DAYS.map((d, i) => {
        const on = value.days.includes(i + 1), open = openOn(i + 1);
        const tooMany = !on && open && over({ ...value, days: [...value.days, i + 1] });
        const held = !on && taken.some((w) => slotsOverlap(w, { ...value, days: [i + 1] }));
        return <button key={d} type="button" aria-pressed={on} aria-label={`${label}: ${d}${open ? "" : " (closed in Bookings)"}${tooMany ? ` (over ${limit.name})` : ""}`} disabled={disabled || (!open && !on) || held}
          title={!open ? "Closed on this day in Bookings › Availability" : held ? "Already booked for this course at these times (its other booking)" : tooMany ? `Adding this day takes the week over ${limit.max} hrs (${limit.name}): shorten the times after` : undefined}
          onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== i + 1) : [...value.days, i + 1].sort((a, b) => a - b) })}
          className={`h-8 w-9 rounded border text-xs font-semibold ${on ? "border-primary-600 bg-primary-600 text-white" : open && !held ? `bg-background-50 text-foreground-600 hover:bg-background-100 ${tooMany ? "border-amber-400" : "border-background-300"}` : "cursor-not-allowed border-background-200 bg-background-200 text-foreground-400 line-through"}`}>{d.slice(0, 2)}</button>;
      })}
    </div>
    <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-foreground-600">{timeSelect("from")}<span>to</span>{timeSelect("to")}</div>
    {!bad ? <p className={`text-xs ${over(value) ? "font-semibold text-red-700" : "text-foreground-600"}`}>{value.days.length} day{value.days.length === 1 ? "" : "s"} × {(toMin(value.to) - toMin(value.from)) / 60} h = {slotHours(value)} h a week</p> : null}
    {!bad && taken.some((w) => slotsOverlap(w, value)) ? <p role="alert" className="text-xs font-semibold text-red-700">Overlaps its other booking: change the days or times.</p> : null}
    {bad ? <p role="alert" className="text-xs font-semibold text-red-700">{bad}</p>
      : over(value) ? <p role="alert" className="text-xs font-semibold text-red-700">Over {limit.name}: {limit.others + slotHours(value)} of {limit.max} hrs a week with the others. Shorten the times or untick a day.</p>
      : outside.length ? <p className="text-xs text-amber-800">Closed at part of these times on {outside.map((d) => DAYS[d - 1]).join(", ")}: no class goes there then.</p> : null}
  </div>;
}
/** Two slots share a day and overlap in time. */
const slotsOverlap = (a: Window, b: Window) => a.days.some((d) => b.days.includes(d)) && toMin(a.from) < toMin(b.to) && toMin(b.from) < toMin(a.to);
const slotBad = (w: Window) => !w.days.length || toMin(w.to) <= toMin(w.from);
/** A list with a booking that overlaps another booking of the same room or trainer. */
const doubleBooked = (l: Pick[]) => l.some((p) => l.some((x) => x.key !== p.key && x.id === p.id && slotsOverlap(x, p)));
/** Hours a week a slot books: days × (to − from). */
const slotHours = (w: Window) => w.days.length * Math.max(0, (toMin(w.to) - toMin(w.from)) / 60);
/** A slot of at most `h` hours a week from `start` (minutes), the same times each day, Monday first: the day count that books
 *  the most hours without going over (Business Rules: 5 days preferred, up to 8 hours a day and never past 10 pm today). */
function fitSlot(h: number, start: number): Window {
  let best: Window = { days: [], from: toTime(start), to: toTime(start) };
  let bestTotal = 0;
  const preferred = Math.min(7, Math.max(1, Math.round(ruleNumber("lms.class_suggestion_preferred_days", 5))));
  for (const d of [preferred, ...[5, 4, 3, 6, 2, 7, 1].filter((x) => x !== preferred)]) {
    const perDay = Math.min(ruleNumber("lms.class_suggested_day_cap", 8), Math.floor((h * 2) / d) / 2, (LATEST - start) / 60);
    if (perDay < 0.5 || d * perDay <= bestTotal) continue;
    bestTotal = d * perDay;
    best = { days: Array.from({ length: d }, (_, i) => i + 1), from: toTime(start), to: toTime(start + perDay * 60) };
  }
  return best;
}
/** The window that holds a room's or trainer's saved classes: their days, first start to last end. */
const windowOf = (list: Block[]): Window => list.length
  ? { days: [...new Set(list.map((b) => b.weekday))].sort((a, b) => a - b), from: toTime(Math.min(...list.map((b) => b.start))), to: toTime(Math.max(...list.map((b) => b.end))) }
  : WINDOW;
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
  /** The units' hours are read (or could not be): the rooms and trainers are sized only then. */
  const [needRead, setNeedRead] = useState(false);
  const [kindRead, setKindRead] = useState(false);
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
      return { key: newKey(id), id, theory: mine.some((b) => b.type !== "practical"), practical: mine.some((b) => b.type === "practical"), ...windowOf(mine) };
    }));
  };

  useEffect(() => {
    let live = true;
    setDetail(null); setDone(null); setClashes([]); setError(""); setBlocks([]); setTouched(false); setRoomPicks([]); setTrainerPicks([]); setKind("coe"); setNeedRead(false); setKindRead(false); setPage("rooms"); setShowForm(false);
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
          if (savedTrainers.length) setTrainerPicks((l) => [...l, ...savedTrainers.map((id) => ({ key: newKey(id), id, theory: true, practical: true, fresh: true, ...WINDOW }))]);
        } else {
          // A new week starts with the first theory room and the first practical room; the trainers are added by hand.
          const firstOf = (k: "theory" | "practical") => roomList.find((r) => r.kind === k);
          const t = firstOf("theory"), p = firstOf("practical");
          const start = [t, p].filter((x): x is NonNullable<typeof x> => !!x);
          setRoomPicks((start.length ? start : roomList.slice(0, 1)).map((r) => ({ key: newKey(r.id), id: r.id, theory: r.kind !== "practical", practical: r.kind === "practical", fresh: true, ...WINDOW })));
          if (savedTrainers.length) setTrainerPicks(savedTrainers.map((id) => ({ key: newKey(id), id, theory: true, practical: true, fresh: true, ...WINDOW })));
        }
        // Rooms and trainers chosen on this computer and not yet saved with Create classes (the wizard closed in between).
        try {
          const draft = JSON.parse(window.localStorage.getItem(DRAFT + intakeId) ?? "null") as { rooms: Pick[]; trainers: Pick[]; page: Page } | null;
          if (draft?.rooms?.length) {
            const once = (l: Pick[]) => l.filter((x, i) => l.findIndex((y) => y.key === x.key) === i)
              .map((x) => (x.days?.length && x.from && x.to && slotHours(x) < slotHours(WINDOW) ? { ...x, fresh: false } : { ...x, ...WINDOW, fresh: true }));
            setRoomPicks(once(draft.rooms)); setTrainerPicks(once(draft.trainers ?? [])); if (!saved.length) setPage(draft.page ?? "rooms");
          }
        } catch { /* no draft */ }
        void loadClosedDays(d.intake.startDate, courseId).then((f) => { if (live) setClosed(() => f); });
      }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The intake did not load."); });
    void loadCourseNeed(courseId).then((n) => { if (live) setNeed(n); }).catch(() => undefined).finally(() => { if (live) setNeedRead(true); });
    void loadIntakeLoads(courseId).then((m) => { if (live) setKind(m[intakeId] ?? "coe"); }).catch(() => undefined).finally(() => { if (live) setKindRead(true); });
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

  /** The default week (owner, 2026-11-20), from availability: theory, then practical, then assessment, Monday first, in one block a
   * day of up to 8 hours from the first hour a room of that type is open and free (no other intake) and, when the course has
   * trainers, one of them is open and free too. */
  const autoWeek = () => {
    const out: Block[] = [];
    const dayHours = (d: number) => out.filter((b) => b.weekday === d).reduce((t, b) => t + (b.end - b.start) / 60, 0);
    for (const t of TYPES) {
      let left = split[t];
      for (let weekday = 1; weekday <= 7 && left > 0; weekday++) {
        let started = false;
        for (let h = FIRST_HOUR; h < LAST_HOUR && left > 0 && dayHours(weekday) < ruleNumber("lms.class_suggested_day_cap", 8); h++) {
          const s0 = h * 60;
          const p = taken(out, weekday, s0, s0 + 60) ? null : pickFor(t, weekday, s0, s0 + 60);
          if (!p || (trainerPicks.length && !p.trainerId)) { if (started) break; continue; }
          out.push({ weekday, start: s0, end: s0 + 60, type: t, roomId: p.roomId, trainerId: p.trainerId, manual: false });
          left--; started = true;
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
    if (!detail || !roomPicks.length) return;
    try { window.localStorage.setItem(DRAFT + intakeId, JSON.stringify({ rooms: roomPicks, trainers: trainerPicks, page })); } catch { /* storage off */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saved whenever the choices change
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
  // Each room and each trainer is chosen once (owner, 2026-11-20): the lists offer only those not chosen yet.
  // A room or trainer can be booked again for other days or times (owner, 2026-11-20), never twice at the same time.
  const freeRooms = rooms;
  /** Bookings of the same room that cross this one (same day, times overlap). */
  /** Other intakes' weekly classes during this intake's dates (they keep the room or trainer busy then). */
  const busyText = (uses: RoomUse[]) => { const mine = uses.filter((u) => u.intakeId !== intakeId && (!dates || ((!u.endDate || u.endDate >= dates.startDate) && (!dates.endDate || u.startDate <= dates.endDate))));
    return mine.length ? [...new Set(mine.map((u) => `${u.courseCode} ${DAYS[(u.weekday === 0 ? 7 : u.weekday) - 1]} ${clock(toMin(u.startTime))}–${clock(toMin(u.endTime))}`))].join(", ") : "None"; };
  const addRoom = (id: string) => {
    const r = rooms.find((x) => x.id === id);
    if (r) setRoomPicks((l) => [...l, { key: newKey(id), id, theory: r.kind !== "practical", practical: r.kind === "practical", fresh: true, ...WINDOW }]);
  };
  const freeStaff = staff;
  const addTrainer = (id: string) => {
    if (!id) return;
    setTrainerPicks((l) => [...l, { key: newKey(id), id, theory: true, practical: true, fresh: true, ...WINDOW }]);
  };

  const at = PAGES.findIndex((x) => x.id === page);
  const stepName = (i: number) => (steps ? `Step ${steps.first + i} of ${steps.total} · ${PAGES[i].label}` : `${i + 1}. ${PAGES[i].label}`);
  /** A room is used for theory or for practical: choosing one unticks the other. */
  const setRoomType = (key: string, practical: boolean) => setRoomPicks((l) => l.map((x) => (x.key === key ? { ...x, theory: !practical, practical, fresh: x.fresh || x.practical !== practical } : x)));

  // What the units need each week at this CoE / VoE rate, against what the rooms and trainers are booked for (owner, 2026-11-20):
  // theory rooms take theory and assessment classes, practical rooms practical ones.
  const needTheory = split.theory + split.assessment, needPractical = split.practical;
  // CoE / VoE (owner, 2026-11-20): rooms and trainers are booked for no more hours a week than the course may give. A room or
  // trainer the system added gets a slot sized to the hours still free: theory rooms from 9 am, practical rooms after them.
  const loadName = kind === "coe" ? "CoE" : "VoE";
  const roomTotal = roomPicks.reduce((t, x) => t + slotHours(x), 0);
  const trainerTotal = trainerPicks.reduce((t, x) => t + slotHours(x), 0);
  const roomsOver = roomTotal > target + 1e-9, trainersOver = trainerTotal > target + 1e-9;
  const sizeKey = `${needRead}|${kindRead}|${!!detail}|${target}|${needTheory}|${needPractical}|${roomPicks.map((x) => `${x.key}${x.fresh ? "*" : ""}${x.practical ? "p" : "t"}`).join(",")}|${trainerPicks.map((x) => `${x.key}${x.fresh ? "*" : ""}`).join(",")}`;
  useEffect(() => {
    if (!needRead || !kindRead || !detail || (!roomPicks.some((x) => x.fresh) && !trainerPicks.some((x) => x.fresh))) return;
    const rooms2 = [...roomPicks];
    const end = (l: Pick[]) => (l.length ? Math.max(...l.map((x) => toMin(x.to))) : FIRST_HOUR * 60);
    for (const practical of [false, true]) {
      const of = rooms2.filter((x) => x.practical === practical);
      let left = Math.min(practical ? needPractical : needTheory, target - rooms2.filter((x) => !x.fresh).reduce((t, x) => t + slotHours(x), 0))
        - of.filter((x) => !x.fresh).reduce((t, x) => t + slotHours(x), 0);
      const start = practical ? end(rooms2.filter((x) => !x.practical && x.days.length)) : FIRST_HOUR * 60;
      for (const x of of.filter((y) => y.fresh)) {
        // A second booking of the same room starts after its first one.
        const after = Math.max(start, end(rooms2.filter((y) => y !== x && y.id === x.id && y.days.length && !y.fresh)));
        const w = fitSlot(Math.max(0, left), Math.min(after, (LAST_HOUR - 1) * 60));
        left -= slotHours(w);
        rooms2[rooms2.indexOf(x)] = { ...x, ...w, fresh: false };
      }
    }
    // A trainer covers the room slots of what they teach, within what is left of the week.
    let tLeft = target - trainerPicks.filter((x) => !x.fresh).reduce((t, x) => t + slotHours(x), 0);
    const trainers2 = trainerPicks.map((x) => {
      if (!x.fresh) return x;
      const mine = rooms2.filter((r) => r.days.length && ((x.theory && !r.practical) || (x.practical && r.practical)));
      let w: Window = mine.length ? { days: [...new Set(mine.flatMap((r) => r.days))].sort((a, b) => a - b), from: toTime(Math.min(...mine.map((r) => toMin(r.from)))), to: toTime(Math.max(...mine.map((r) => toMin(r.to)))) } : fitSlot(tLeft, FIRST_HOUR * 60);
      if (slotHours(w) > tLeft) w = fitSlot(Math.max(0, tLeft), toMin(w.from));
      tLeft -= slotHours(w);
      return { ...x, ...w, fresh: false };
    });
    setRoomPicks(rooms2); setTrainerPicks(trainers2);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the picks, their types and the hours
  }, [sizeKey]);
  const hoursLine = (total: number, list: Pick[]) => {
    const of = (practical: boolean) => list.filter((x) => x.practical === practical || (!practical && x.theory)).reduce((t, x) => t + slotHours(x), 0);
    const over = total > target + 1e-9;
    return <p role={over ? "alert" : undefined} className={`rounded-lg border px-3 py-2 text-sm ${over ? "border-red-300 bg-red-50 font-semibold text-red-800" : "border-background-200 bg-background-100 text-foreground-700"}`}>
      Booked <b>{total} of {target} hrs a week</b> ({loadName} maximum){" · "}theory and assessment {of(false)} of {needTheory} · practical {of(true)} of {needPractical}
      {over ? `. Over ${loadName}: shorten a booking.` : total < needTheory + needPractical ? ". Fewer hours than the units need each week: the unit dates will run longer." : "."}</p>;
  };
  const roomsMissing = [needTheory > 0 && !roomPicks.some((r) => r.theory) ? "a theory room" : "", needPractical > 0 && !roomPicks.some((r) => r.practical) ? "a practical room" : ""].filter(Boolean);
  const trainersMissing = [needTheory > 0 && !trainerPicks.some((r) => r.theory) ? "a theory trainer" : "", needPractical > 0 && !trainerPicks.some((r) => r.practical) ? "a practical trainer" : ""].filter(Boolean);
  /** Other intakes' classes in this room during this booking (they cannot share it). */
  const usesIn = (uses: RoomUse[], p: Pick) => uses.filter((u) => u.intakeId !== intakeId && p.days.includes(u.weekday === 0 ? 7 : u.weekday)
    && toMin(u.startTime) < toMin(p.to) && toMin(u.endTime) > toMin(p.from) && (!dates || ((!u.endDate || u.endDate >= dates.startDate) && (!dates.endDate || u.startDate <= dates.endDate))));
  const usedBy = (p: Pick) => usesIn(roomHours[p.id]?.uses ?? [], p);
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
        <p className="text-sm text-foreground-600">Which rooms will this course use, and when? Each room is for theory or for practical; pick the days and times it is booked for this course. A class can go in a room only inside those times, when it is open in <Link className="font-semibold text-primary-700 hover:underline" to="/admin/bookings?tab=availability&who=rooms">Bookings › Availability</Link> and no other intake has a class in it then.</p>
        {roomPicks.length ? <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-background-100 text-left text-xs font-semibold text-foreground-600"><tr><th className="px-3 py-2">Room</th><th className="px-3 py-2">Used for</th><th className="px-3 py-2">Booked for this course</th><th className="px-3 py-2">Open (Bookings)</th><th className="px-3 py-2">Other intakes' classes</th><th className="px-3 py-2"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{roomPicks.map((p) => { const r = rooms.find((x) => x.id === p.id); const h = roomHours[p.id]; return (
              <tr key={p.key} className="border-t border-background-200 align-top">
                <td className="px-3 py-2 font-medium text-foreground-950">{r?.label ?? "Room"}</td>
                <td className="px-3 py-2"><div className="flex gap-1.5" role="radiogroup" aria-label={`${r?.name ?? "Room"} is used for`}>
                  <button type="button" role="radio" aria-checked={p.theory} disabled={busy} className={chip(p.theory, "theory")} onClick={() => setRoomType(p.key, false)}>Theory</button>
                  <button type="button" role="radio" aria-checked={p.practical} disabled={busy} className={chip(p.practical, "practical")} onClick={() => setRoomType(p.key, true)}>Practical</button>
                </div></td>
                <td className="px-3 py-2"><SlotEditor label={`${r?.name ?? "Room"} booked`} value={p} avail={h ? h.avail : null} disabled={busy} limit={{ max: target, others: roomTotal - slotHours(p), name: loadName }} taken={roomPicks.filter((x) => x.key !== p.key && x.id === p.id)}
                  onChange={(w) => setRoomPicks((l) => l.map((x) => (x.key === p.key ? { ...x, ...w, fresh: false } : x)))} /></td>
                <td className="px-3 py-2 text-xs text-foreground-700">{!h ? "…" : h.avail.length ? hoursText(h.avail) : "Any time (no hours set)"}</td>
                <td className="px-3 py-2 text-xs text-foreground-700">{!h ? "…" : busyText(h.uses)}</td>
                <td className="px-3 py-2 text-right"><button type="button" disabled={busy} aria-label={`Remove ${r?.name ?? "room"}`} className="rounded p-2 text-red-700 hover:bg-red-50"
                  onClick={() => setRoomPicks((l) => l.filter((x) => x.key !== p.key))}><i className="ri-delete-bin-line" aria-hidden="true" /></button></td>
              </tr>); })}</tbody>
          </table>
        </div> : <p className="text-sm text-foreground-500">No room yet.</p>}
        {freeRooms.length ? <Select className="!w-auto" aria-label="Add a room" value="" disabled={busy} onChange={(e) => addRoom(e.target.value)}>
          <option value="">+ Add a room…</option>{freeRooms.map((r) => <option key={r.id} value={r.id}>{r.label}{roomPicks.some((p) => p.id === r.id) ? " (book again, other times)" : ""}</option>)}
        </Select> : null}
        {roomPicks.length ? hoursLine(roomTotal, roomPicks) : null}
        {roomsMissing.length ? <p role="alert" className="text-sm font-semibold text-amber-800">Add {roomsMissing.join(" and ")}: the units have {roomsMissing.join(" and ").replace(/a (\w+) room/g, "$1")} hours.</p> : null}
        {detail && !rooms.length ? <p className="text-sm text-foreground-600">No rooms yet: add one in <Link className="font-semibold text-primary-700 hover:underline" to="/admin/lms/timetable-settings?tab=locations">Timetable settings</Link>.</p> : null}
      </section> : null}

      {page === "trainers" ? <section className="space-y-3">
        <p className="text-sm text-foreground-600">Who teaches this course, and when? Pick the days and times each trainer is booked for it. A trainer can take a class only inside those times, when they are free in <Link className="font-semibold text-primary-700 hover:underline" to="/admin/bookings?tab=availability&who=trainers">Bookings › Availability</Link> (Mon–Sun 9 am – 10 pm when they have no hours there) and are not teaching another intake then.</p>
        {trainerPicks.length ? <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-background-100 text-left text-xs font-semibold text-foreground-600"><tr><th className="px-3 py-2">Trainer</th><th className="px-3 py-2">Teaches</th><th className="px-3 py-2">Booked for this course</th><th className="px-3 py-2">Free (Bookings)</th><th className="px-3 py-2">Other intakes' classes</th><th className="px-3 py-2"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{trainerPicks.map((p) => { const h = trainerHours[p.id]; return (
              <tr key={p.key} className="border-t border-background-200 align-top">
                <td className="px-3 py-2 font-medium text-foreground-950">{trainerName(p.id)}</td>
                <td className="px-3 py-2"><div className="flex gap-1.5">
                  <button type="button" aria-pressed={p.theory} disabled={busy} className={chip(p.theory, "theory")} onClick={() => setTrainerPicks((l) => l.map((x) => (x.key === p.key ? { ...x, theory: !x.theory } : x)))}>Theory</button>
                  <button type="button" aria-pressed={p.practical} disabled={busy} className={chip(p.practical, "practical")} onClick={() => setTrainerPicks((l) => l.map((x) => (x.key === p.key ? { ...x, practical: !x.practical } : x)))}>Practical</button>
                </div></td>
                <td className="px-3 py-2"><SlotEditor label={`${trainerName(p.id)} booked`} value={p} avail={h ? (h.avail.length ? h.avail : TRAINER_DEFAULT) : null} disabled={busy} limit={{ max: target, others: trainerTotal - slotHours(p), name: loadName }} taken={trainerPicks.filter((x) => x.key !== p.key && x.id === p.id)}
                  onChange={(w) => setTrainerPicks((l) => l.map((x) => (x.key === p.key ? { ...x, ...w, fresh: false } : x)))} /></td>
                <td className="px-3 py-2 text-xs text-foreground-700">{!h ? "…" : h.avail.length ? hoursText(h.avail) : "Mon–Sun 9 am – 10 pm"}</td>
                <td className="px-3 py-2 text-xs text-foreground-700">{!h ? "…" : busyText(h.uses)}</td>
                <td className="px-3 py-2 text-right"><button type="button" disabled={busy} aria-label={`Remove ${trainerName(p.id)}`} className="rounded p-2 text-red-700 hover:bg-red-50"
                  onClick={() => setTrainerPicks((l) => l.filter((x) => x.key !== p.key))}><i className="ri-delete-bin-line" aria-hidden="true" /></button></td>
              </tr>); })}</tbody>
          </table>
        </div> : <p className="text-sm font-semibold text-amber-800">Add a trainer: every class needs one.</p>}
        {freeStaff.length ? <Select className="!w-auto" aria-label="Add a trainer" value="" disabled={busy} onChange={(e) => addTrainer(e.target.value)}>
          <option value="">+ Add a trainer…</option>{freeStaff.map((x) => <option key={x.id} value={x.id}>{x.name}{trainerPicks.some((p) => p.id === x.id) ? " (book again, other times)" : ""}</option>)}
        </Select> : null}
        {trainerPicks.length ? hoursLine(trainerTotal, trainerPicks) : null}
        {trainerPicks.length && trainersMissing.length ? <p role="alert" className="text-sm font-semibold text-amber-800">Add {trainersMissing.join(" and ")}, or tick it on a trainer.</p> : null}
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
                  const booked = null as Pick | null;
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
        {changing ? <p className="text-xs text-foreground-600">Striped: {brush} cannot go there (hover to see why: not booked on step {steps ? steps.first : 1} or {steps ? steps.first + 1 : 2}, closed, or used by another intake).{blocks.some((b) => b.start < FIRST_HOUR * 60 || b.end > LAST_HOUR * 60) ? " Some class times are outside 9 am – 10 pm: see the list below." : ""}</p> : null}

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
          ? <Button disabled={busy || (page === "rooms" && (roomsMissing.length > 0 || roomsOver || roomPicks.some(slotBad) || doubleBooked(roomPicks))) || (page === "trainers" && (trainersMissing.length > 0 || trainersOver || trainerPicks.some(slotBad) || doubleBooked(trainerPicks)))} icon="ri-arrow-right-line" onClick={() => setPage(PAGES[at + 1].id)}>Next: {PAGES[at + 1].label.toLowerCase()}</Button>
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
