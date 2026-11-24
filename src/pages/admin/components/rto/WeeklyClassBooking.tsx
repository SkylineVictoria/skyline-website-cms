// One screen for an intake's weekly classes (owner, 2026-11-20), in place of the Rooms, Trainers and Weekly class times pages:
// Monday to Sunday listed by default; each class is a row with its kind (Theory / Practical / Assessment), room, trainer and
// start / end time, and a day can have several classes as long as the times are free. Booking the week saves the room, the
// trainer and the class time of every row together (rto_course_flow batch_setup), then makes the dated classes
// (rto_class_sessions_generate). A CoE intake books 20 hours a week, a VoE intake 40 (one screen each in course setup).
// The room must be open then (Bookings › Availability) and not used by another intake; the trainer likewise; the server checks
// again on save (intake_class_times triggers, class_sessions_no_clash).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { onRules, ruleNumber, ruleObject, weekdayIndex } from "@/lib/businessRules";
import { supabase } from "@/pages/admin/lib/supabase";
import { roomAvailability, trainerAvailability, type AvailabilityRow, type RoomUse } from "@/lib/bookingApi";
import { loadCourseNeed, type CourseNeed } from "@/pages/admin/lib/coursePlan";
import {
  DAYS, LOAD_HOURS, clashText, generateClassSessions, loadIntakeLoads, rto, rtoFlow, setIntakeLoad,
  type Clash, type GenerateResult, type IntakeDetail, type LocationRooms, type SessionType, type StaffOption, type StudyLoad,
} from "@/pages/admin/lib/rto";
import SearchableSelect from "@/components/ui/SearchableSelect";

type Row = { key: string; weekday: number; type: SessionType; roomId: string; trainerId: string; start: string; end: string };
type Hours = { avail: AvailabilityRow[]; uses: RoomUse[] };
/** A day and time a trainer or room is already used by another intake's dated classes (the prerequisite class too), from rto_intake_busy_windows. */
type Busy = { weekday: number; start: string; end: string; day: string; intake: string; course: string };
type BusyMap = { trainers: Record<string, Busy[]>; rooms: Record<string, Busy[]> };
const TYPES: { id: SessionType; label: string }[] = [{ id: "theory", label: "Theory" }, { id: "practical", label: "Practical" }, { id: "assessment", label: "Assessment" }];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
// Nothing below is typed in here: the times, the trainer fallback, the class length and the usual start times are Business Rules
// (Administration › Business Rules: lms.class_suggestion_hours, lms.class_setup_availability_fallback, lms.class_block_hours,
// lms.class_preferred_start_times). The numbers here are only what the screen uses until the rules have loaded.
const isTestAccount = (email: string | undefined) => /@blackhole\.postmarkapp\.com$/i.test(email ?? "");
const toTimeStr = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
let EARLIEST = 7 * 60, LATEST = 22 * 60;
let TIMES = Array.from({ length: Math.floor((LATEST - EARLIEST) / 30) + 1 }, (_, i) => toTimeStr(EARLIEST + i * 30));
let BLOCK_HOURS = 4;
let PREF_STARTS = ["09:00", "14:00"];
let TRAINER_DEFAULT: AvailabilityRow[] = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: "09:00", end: "22:00" }));
onRules(() => {
  const hm = (v: unknown) => (typeof v === "string" && /^([01]\d|2[0-3]):(00|30)$|^24:00$/.test(v) ? v : null);
  const h = ruleObject("lms.class_suggestion_hours", { earliest: "07:00" as unknown, latest: "22:00" as unknown });
  const e = hm(h.earliest), l = hm(h.latest);
  const em = e ? Number(e.slice(0, 2)) * 60 + Number(e.slice(3)) : 7 * 60, lm = l ? Number(l.slice(0, 2)) * 60 + Number(l.slice(3)) : 22 * 60;
  [EARLIEST, LATEST] = em < lm ? [em, lm] : [7 * 60, 22 * 60];
  TIMES = Array.from({ length: Math.floor((LATEST - EARLIEST) / 30) + 1 }, (_, i) => toTimeStr(EARLIEST + i * 30));
  BLOCK_HOURS = Math.min(8, Math.max(1, Math.round(ruleNumber("lms.class_block_hours", 4))));
  const st = ruleObject("lms.class_preferred_start_times", { first: "09:00" as unknown, second: "14:00" as unknown });
  PREF_STARTS = [hm(st.first), hm(st.second)].filter((x): x is string => !!x);
  const f = ruleObject("lms.class_setup_availability_fallback", { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as unknown, start: "09:00", end: "22:00" });
  const days = (Array.isArray(f.days) ? f.days : []).map(d => weekdayIndex(String(d))).filter(d => d >= 0);
  TRAINER_DEFAULT = days.map(weekday => ({ weekday, start: String(f.start), end: String(f.end) }));
});
const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
const minTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const clock = (t: string) => { const m = toMin(t), h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${h >= 12 ? "pm" : "am"}`; };
const covers = (rows: AvailabilityRow[], weekday: number, s: number, e: number) => rows.some(r => r.weekday === weekday % 7 && toMin(r.start) <= s && toMin(r.end) >= e);
let seq = 0;
const blank = (weekday: number): Row => ({ key: `r${++seq}`, weekday, type: "theory", roomId: "", trainerId: "", start: "", end: "" });
const filled = (r: Row) => !!(r.roomId || r.trainerId || r.start || r.end);
const hoursOf = (r: Row) => (r.start && r.end && toMin(r.end) > toMin(r.start) ? (toMin(r.end) - toMin(r.start)) / 60 : 0);
/** Hours a week of each kind, split like the units' hours (40 / 40 / 20 when the units have none). */
function splitHours(total: number, need: CourseNeed | null): Record<SessionType, number> {
  const pct = ruleObject("lms.unit_hours_split", { theoryPercent: 40, practicalPercent: 40, assessmentPercent: 20 });
  const base = need && need.total > 0 ? need : { theory: Number(pct.theoryPercent), practical: Number(pct.practicalPercent), assessment: Number(pct.assessmentPercent), total: Number(pct.theoryPercent) + Number(pct.practicalPercent) + Number(pct.assessmentPercent) };
  const theory = Math.round((total * base.theory) / base.total), practical = Math.min(total - theory, Math.round((total * base.practical) / base.total));
  return { theory, practical, assessment: Math.max(0, total - theory - practical) };
}
const field = "h-8 rounded-md border border-background-300 bg-background-50 px-2 text-sm text-foreground-900 disabled:opacity-60";
const th = "px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground-500";

/** One booked week (no intake yet): what the course wizard keeps until Finish, which then creates the intake and books it. */
export interface DraftWeek { sessions: { weekday: number; startTime: string; endTime: string; type: SessionType; roomId: string; trainerId: string }[]; capacity: string; trainerIds: string[] }
/** Draft mode: there is no intake yet. The week is only handed back (onDraft); `others` is another draft week (CoE for the VoE screen) whose rooms and trainers are taken. */
export interface DraftMode { startDate: string; initial?: DraftWeek | null; others?: DraftWeek | null; onDraft: (week: DraftWeek) => void | Promise<void> }

export function WeeklyClassBooking({ intakeId, courseId, load, canEdit, onSaved, saveLabel = "Book the week", footerStart, draft }: {
  intakeId: string | null; courseId: string; load: StudyLoad; canEdit: boolean;
  onSaved?: (made: GenerateResult) => void; saveLabel?: string; footerStart?: ReactNode; draft?: DraftMode;
}) {
  const [draftReady, setDraftReady] = useState(false);
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [locations, setLocations] = useState<LocationRooms[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [need, setNeed] = useState<CourseNeed | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [roomHours, setRoomHours] = useState<Record<string, Hours>>({});
  const [busyWin, setBusyWin] = useState<BusyMap | null>(null);
  const [trainerHours, setTrainerHours] = useState<Record<string, Hours>>({});
  const [clashes, setClashes] = useState<Clash[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<GenerateResult | null>(null);
  const target = LOAD_HOURS[load];
  const [roomsBusy, setRoomsBusy] = useState(false);
  /** Rooms again after one was added in Locations & rooms (the + Add room link opens it in a new tab). */
  const reloadRooms = async () => {
    setRoomsBusy(true);
    try { setLocations(await rtoFlow<LocationRooms[]>("locations_rooms")); } catch (e) { setError(e instanceof Error ? e.message : "The rooms could not be read."); }
    finally { setRoomsBusy(false); }
  };

  useEffect(() => {
    let live = true;
    setDetail(null); setRows([]); setError(""); setDone(null); setDraftReady(false);
    if (draft || !intakeId) {
      void Promise.all([rtoFlow<LocationRooms[]>("locations_rooms"), rto<StaffOption[]>("staff_list")]).then(([l, st]) => {
        if (!live) return;
        setLocations(l); setStaff(st);
        const saved = (draft?.initial?.sessions ?? []).map(x => ({ key: `r${++seq}`, weekday: x.weekday, type: x.type, roomId: x.roomId ?? "", trainerId: x.trainerId ?? "", start: x.startTime.slice(0, 5), end: x.endTime.slice(0, 5) }));
        setRows([1, 2, 3, 4, 5, 6, 7].flatMap(day => { const mine = saved.filter(r => r.weekday === day).sort((a, b) => a.start.localeCompare(b.start)); return mine.length ? mine : [blank(day)]; }));
        setDraftReady(true);
      }).catch(e => { if (live) setError(e instanceof Error ? e.message : "The rooms could not be read."); });
      void loadCourseNeed(courseId).then(n => { if (live) setNeed(n); }).catch(() => undefined);
      void supabase.rpc("rto_busy_windows_from", { p_start: draft?.startDate }).then(({ data }) => { if (live) setBusyWin((data as BusyMap | null) ?? { trainers: {}, rooms: {} }); });
      return () => { live = false; };
    }
    void Promise.all([rto<IntakeDetail>("intake_get", { intakeId }), rtoFlow<LocationRooms[]>("locations_rooms"), rto<StaffOption[]>("staff_list")])
      .then(([d, l, s]) => {
        if (!live) return;
        setDetail(d); setLocations(l); setStaff(s);
        // Monday to Sunday by default; a saved week comes back with its classes (several on a day when it had them).
        const saved = (d.batches[0]?.sessions ?? []).map(x => ({ key: `r${++seq}`, weekday: x.weekday, type: x.type, roomId: x.roomId ?? "", trainerId: x.trainerId ?? "", start: x.startTime.slice(0, 5), end: x.endTime.slice(0, 5) }));
        setRows([1, 2, 3, 4, 5, 6, 7].flatMap(day => { const mine = saved.filter(r => r.weekday === day).sort((a, b) => a.start.localeCompare(b.start)); return mine.length ? mine : [blank(day)]; }));
      }).catch(e => { if (live) setError(e instanceof Error ? e.message : "The intake did not load."); });
    void loadCourseNeed(courseId).then(n => { if (live) setNeed(n); }).catch(() => undefined);
    void supabase.rpc("rto_intake_busy_windows", { p_intake: intakeId }).then(({ data }) => { if (live) setBusyWin((data as BusyMap | null) ?? { trainers: {}, rooms: {} }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only for another intake, course or start date
  }, [intakeId, courseId, draft?.startDate]);

  const rooms = useMemo(() => locations.flatMap(l => l.rooms.filter(r => r.isActive).map(r => ({ id: r.id, kind: l.kind, label: `${r.name}${l.name ? ` · ${l.name}` : ""}${r.capacity ? ` (${r.capacity} seats)` : ""}`, capacity: r.capacity }))), [locations]);
  // Open hours and other intakes' classes of the rooms and trainers in use (Bookings); unreadable ones count as free.
  const roomKey = rooms.map(r => r.id).join(","), trainerKey = staff.map(x => x.id).join(",");
  useEffect(() => {
    for (const id of roomKey ? roomKey.split(",") : []) if (!roomHours[id]) void roomAvailability(id)
      .then(r => setRoomHours(m => ({ ...m, [id]: { avail: r.availability, uses: r.bookings } }))).catch(() => setRoomHours(m => ({ ...m, [id]: { avail: [], uses: [] } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every room, once (the dropdown shows which are free)
  }, [roomKey]);
  useEffect(() => {
    for (const id of trainerKey ? trainerKey.split(",") : []) if (!trainerHours[id]) void trainerAvailability(id)
      .then(r => setTrainerHours(m => ({ ...m, [id]: { avail: r.availability, uses: r.bookings } }))).catch(() => setTrainerHours(m => ({ ...m, [id]: { avail: [], uses: [] } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every trainer, once (the dropdown shows who is free)
  }, [trainerKey]);

  const dates = detail?.intake ?? null;
  const elsewhere = (uses: RoomUse[], weekday: number, s: number, e: number) => uses.some(u => u.intakeId !== intakeId && u.weekday === weekday % 7 && toMin(u.startTime) < e && toMin(u.endTime) > s
    && (!dates || ((!u.endDate || u.endDate >= dates.startDate) && (!dates.endDate || u.startDate <= dates.endDate))));
  /** Another intake's dated class (or the prerequisite class) on this weekday and time, for a trainer or a room: the booking would fail on that date. */
  const datedBusy = (list: Busy[] | undefined, weekday: number, s: number, e: number) => (list ?? []).find(w => w.weekday === weekday && toMin(w.start) < e && toMin(w.end) > s);
  const busyText = (w: Busy) => `${w.course} class on ${new Date(w.day + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })}, ${w.start}–${w.end}`;
  /** Why a room cannot take this row's class ("" when it is free). The same room can be used again the same day at other times. */
  const roomBusy = (roomId: string, r: Row, list: Row[] = rows): string => {
    if (!r.start || !r.end || toMin(r.end) <= toMin(r.start)) return "";
    const s = toMin(r.start), e = toMin(r.end);
    const mine = list.find(o => o !== r && o.roomId === roomId && o.weekday === r.weekday && o.start && o.end && toMin(o.start) < e && toMin(o.end) > s);
    if (mine) return `booked ${clock(mine.start)} – ${clock(mine.end)}`;
    if (draft?.others?.sessions.some(o => o.roomId === roomId && o.weekday === r.weekday && toMin(o.startTime) < e && toMin(o.endTime) > s)) return "used by the other timetable then";
    const h = roomHours[roomId];
    if (h && h.avail.length && !covers(h.avail, r.weekday, s, e)) return "closed then";
    if (h && elsewhere(h.uses, r.weekday, s, e)) return "another intake then";
    if (datedBusy(busyWin?.rooms[roomId], r.weekday, s, e)) return "used by another class then";
    return "";
  };
  /** Why a trainer cannot take this row's class ("" when free): another class here then, not available, or another intake. */
  const trainerBusy = (trainerId: string, r: Row, s = r.start ? toMin(r.start) : -1, e = r.end ? toMin(r.end) : -1, list: Row[] = rows): string => {
    if (s < 0 || e <= s) return "";
    const mine = list.find(o => o !== r && o.trainerId === trainerId && o.weekday === r.weekday && o.start && o.end && toMin(o.start) < e && toMin(o.end) > s);
    if (mine) return `booked ${clock(mine.start)} – ${clock(mine.end)}`;
    if (draft?.others?.sessions.some(o => o.trainerId === trainerId && o.weekday === r.weekday && toMin(o.startTime) < e && toMin(o.endTime) > s)) return "teaching the other timetable then";
    const h = trainerHours[trainerId];
    if (h && !covers(h.avail.length ? h.avail : TRAINER_DEFAULT, r.weekday, s, e)) return "not available then";
    if (h && elsewhere(h.uses, r.weekday, s, e)) return "teaching another intake";
    if (datedBusy(busyWin?.trainers[trainerId], r.weekday, s, e)) return "teaching another class then";
    return "";
  };
  /** Can this row's class run from s to e (minutes)? Not over another class of the day, and its room and trainer free then. */
  const slotFree = (r: Row, s: number, e: number) => {
    if (rows.some(o => o !== r && o.weekday === r.weekday && o.start && o.end && toMin(o.start) < e && toMin(o.end) > s)) return false;
    const at = { ...r, start: minTime(s), end: minTime(e) };
    // With a room (or trainer) chosen it must be open / available then; with none chosen, at least one of its kind must be.
    const roomsHere = roomsFor(r.type);
    if (r.roomId ? roomBusy(r.roomId, at) : roomsHere.length > 0 && !roomsHere.some(x => !roomBusy(x.id, at))) return false;
    if (r.trainerId ? trainerBusy(r.trainerId, r, s, e) : staff.length > 0 && !staff.some(x => !trainerBusy(x.id, r, s, e))) return false;
    return true;
  };
  /** What is wrong with a row ("" when it can be booked; an empty row is fine: no class). */
  const problem = (r: Row, list: Row[] = rows): string => {
    if (!filled(r)) return "";
    if (!r.start || !r.end) return "Pick the start and end time.";
    const s = toMin(r.start), e = toMin(r.end);
    if (e <= s) return "The end must be after the start.";
    if (!r.roomId) return "Pick a room.";
    if (!r.trainerId) return "Pick a trainer.";
    const day = DAY_NAMES[r.weekday - 1];
    const same = list.find(o => o !== r && filled(o) && o.weekday === r.weekday && o.start && o.end && toMin(o.start) < e && toMin(o.end) > s);
    if (same) return `Overlaps the other class on ${day} (${clock(same.start)} – ${clock(same.end)}).`;
    // The other draft week (the CoE week, on the VoE screen) runs on the same dates: its rooms and trainers are taken then.
    // Without this the VoE auto-fill reused the CoE room / trainer and Finish failed on the server (owner, 2026-11-23).
    const other = draft?.others?.sessions ?? [];
    const otherAt = (match: (o: (typeof other)[number]) => boolean) => other.find(o => match(o) && o.weekday === r.weekday && toMin(o.startTime) < e && toMin(o.endTime) > s);
    const roomOther = otherAt(o => o.roomId === r.roomId);
    if (roomOther) return `The room is used by the CoE timetable on ${day} ${clock(roomOther.startTime.slice(0, 5))} – ${clock(roomOther.endTime.slice(0, 5))}.`;
    const trainerOther = otherAt(o => o.trainerId === r.trainerId);
    if (trainerOther) return `The trainer teaches the CoE timetable on ${day} ${clock(trainerOther.startTime.slice(0, 5))} – ${clock(trainerOther.endTime.slice(0, 5))}.`;
    const rh = roomHours[r.roomId];
    if (rh && rh.avail.length && !covers(rh.avail, r.weekday, s, e)) return `The room is not open on ${day} ${clock(r.start)} – ${clock(r.end)} (Bookings › Availability).`;
    if (rh && elsewhere(rh.uses, r.weekday, s, e)) return `Another intake uses the room on ${day} then.`;
    const rb = datedBusy(busyWin?.rooms[r.roomId], r.weekday, s, e);
    if (rb) return `The room is used on ${day} then: ${busyText(rb)}.`;
    const tr = trainerHours[r.trainerId];
    if (tr && !covers(tr.avail.length ? tr.avail : TRAINER_DEFAULT, r.weekday, s, e)) return `The trainer is not available on ${day} ${clock(r.start)} – ${clock(r.end)}.`;
    if (tr && elsewhere(tr.uses, r.weekday, s, e)) return `The trainer teaches another intake on ${day} then.`;
    const tb = datedBusy(busyWin?.trainers[r.trainerId], r.weekday, s, e);
    if (tb) return `The trainer already teaches on ${day} then: ${busyText(tb)}.`;
    return "";
  };

  const booked = rows.filter(filled);
  const sessions = booked.filter(r => !problem(r)).map(r => ({ weekday: r.weekday, startTime: r.start, endTime: r.end, type: r.type, roomId: r.roomId, trainerId: r.trainerId }));
  // Rooms already taken by other intakes, checked by the server as the week changes.
  const sessionsKey = JSON.stringify(sessions);
  useEffect(() => {
    if (!detail || !sessions.length) { setClashes([]); return; }
    let live = true;
    const t = window.setTimeout(() => { rtoFlow<Clash[]>("clash_check", { batchId: detail.batches[0]?.id ?? null, intakeId, sessions }).then(c => { if (live) setClashes(c); }).catch(() => undefined); }, 350);
    return () => { live = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the week
  }, [sessionsKey, intakeId, detail?.intake.id]);
  const clashLines = [...new Set(clashes.map(clashText))];

  const split = splitHours(target, need);
  const byType = (t: SessionType) => booked.filter(r => r.type === t).reduce((s, r) => s + hoursOf(r), 0);
  const total = booked.reduce((s, r) => s + hoursOf(r), 0);
  const bad = booked.filter(r => problem(r)).length;
  const why = !canEdit ? "Only an RTO Manager can book classes." : !booked.length ? "Add the week's classes." : bad ? `${bad} class${bad === 1 ? "" : "es"} to fix.`
    : clashLines.length ? "Fix the clash first." : total > target ? `${total} h is more than the ${target} h a week ${load === "coe" ? "CoE" : "VoE"} allows.`
    : total < target ? `${total} of ${target} h booked: add ${target - total} h more.` : "";

  // ---- Auto-fill (owner, 2026-11-21): the week is laid out for you. Monday to Friday in 4-hour classes (CoE: one a day, VoE: morning and
  // afternoon), kinds shared out like the units' hours, then a room and a trainer that are free for each class. Change anything after.
  const [autoNote, setAutoNote] = useState("");
  const [showWeekend, setShowWeekend] = useState(false);
  const autoDone = useRef(false);
  const roomsFor = (t: SessionType) => rooms.filter(r => t === "assessment" || r.kind === t);
  const autoFill = (): Row[] => {
    // THE RULES (owner, 2026-11-21: "fill the form without mistakes"). Every class written here passes the same check (`problem`) that blocks booking,
    // and every number comes from Business Rules (none is typed into this screen):
    //  1. Hours a week: lms.coe_weekly_study_hours / lms.voe_weekly_study_hours (20 / 40 today), shared between Theory, Practical and Assessment like
    //     the course's unit hours (lms.unit_hours_split when the units have none).
    //  2. Days: lms.class_suggestion_preferred_days a week (5 today: Monday to Friday); classes of lms.class_block_hours (4 today), then shorter to fill the
    //     rest; at most lms.class_suggested_day_cap hours a day (8 today); the day with fewest hours first.
    //  3. Times: lms.class_preferred_start_times first (9:00, 14:00 today), then every half hour between lms.class_suggestion_hours (7:00 to 22:00 today);
    //     a time is used only when it is free.
    //  4. A class needs a room of its kind (Theory room, Practical room; Assessment any) that is open then, not used by another intake and not used by
    //     another class of this week, and a trainer who is available then (lms.class_setup_availability_fallback when none is set), not teaching another
    //     intake and not in another class of this week.
    //  5. The same room and trainer are kept through the week when free; otherwise the next free one (biggest room first).
    //  6. If no free time, room and trainer exist for the rest of the hours, nothing is written for them: the banner says how many hours are left.
    const target0 = target;
    const sp = splitHours(target0, need);
    const left: Record<SessionType, number> = { theory: sp.theory, practical: sp.practical, assessment: sp.assessment };
    const cap = ruleNumber("lms.class_suggested_day_cap", 8);
    const dayCount = Math.min(7, Math.max(1, Math.round(ruleNumber("lms.class_suggestion_preferred_days", 5))));
    const workDays = Array.from({ length: dayCount }, (_, i) => i + 1);
    const starts = [...new Set([...PREF_STARTS, ...TIMES.slice(0, -1)])];
    const built: Row[] = [];
    const lastRoom: Partial<Record<SessionType, string>> = {};
    let lastTrainer = "";
    const dayHours = (d: number) => built.filter(r => r.weekday === d).reduce((x, r) => x + hoursOf(r), 0);
    // Which kind is placed next: the one with the most hours still to place (theory first on a tie).
    const kinds: SessionType[] = ["theory", "practical", "assessment"];
    const usable = (t: SessionType) => roomsFor(t).length > 0;
    const place = (kind: SessionType, hours: number): number => {
      for (const len of [BLOCK_HOURS, ...[3, 2, 1].filter(x => x < BLOCK_HOURS)]) {
        if (len > hours) continue;
        const L = len;
        const days = workDays.filter(d => dayHours(d) + L <= cap).sort((x, y) => dayHours(x) - dayHours(y) || x - y);
        for (const weekday of days) for (const start of starts) {
          if (toMin(start) + L * 60 > LATEST) continue;
          const end = minTime(toMin(start) + L * 60);
          const proto: Row = { key: `r${++seq}`, weekday, type: kind, roomId: "", trainerId: "", start, end };
          const roomOrder = [...roomsFor(kind)].sort((a, b) => Number(b.id === lastRoom[kind]) - Number(a.id === lastRoom[kind]) || (b.capacity ?? 0) - (a.capacity ?? 0));
          // Real trainers first; a test account (a mailbox that goes nowhere) only when no real trainer is free; then the one used last.
          const trainerOrder = [...staff].sort((a, b) => Number(isTestAccount(a.email)) - Number(isTestAccount(b.email)) || Number(b.id === lastTrainer) - Number(a.id === lastTrainer));
          for (const room of roomOrder) for (const trainer of trainerOrder) {
            const row = { ...proto, roomId: room.id, trainerId: trainer.id };
            if (problem(row, built)) continue;
            built.push(row); lastRoom[kind] = room.id; lastTrainer = trainer.id;
            return L;
          }
        }
      }
      return 0;
    };
    let guard = 0;
    while (guard++ < 40) {
      const next = kinds.filter(k => left[k] >= 1 && usable(k)).sort((a, b) => left[b] - left[a])[0];
      if (!next) break;
      const placed = place(next, left[next]);
      if (!placed) { left[next] = 0; continue; }
      left[next] -= placed;
    }
    // A kind with no room of its own (no Practical room) falls back to Theory hours in a Theory room.
    for (const k of kinds) if (left[k] >= 1 && !usable(k) && usable("theory")) { let h = left[k]; left[k] = 0; while (h >= 1) { const p = place("theory", h); if (!p) break; h -= p; } left.theory += h; }
    const got = total0(built);
    built.sort((x, y) => x.weekday - y.weekday || x.start.localeCompare(y.start));
    setRows([1, 2, 3, 4, 5, 6, 7].flatMap(day => { const mine = built.filter(r => r.weekday === day); return mine.length ? mine : [blank(day)]; }));
    setDone(null);
    const testUsed = built.filter(r => isTestAccount(staff.find(x => x.id === r.trainerId)?.email)).length;
    // Why hours are left: for each day with less than its share, who is busy and why (the first free hour of the morning and the afternoon).
    const why: string[] = [];
    if (got < target0) {
      const share = target0 / dayCount;
      for (const d of workDays.filter(x => dayHours(x) < share)) {
        const lines = staff.map(t => {
          const reason = [PREF_STARTS[0] ?? "09:00", PREF_STARTS[1] ?? "14:00"].map(st => trainerBusy(t.id, { key: "p", weekday: d, type: "theory", roomId: "", trainerId: t.id, start: st, end: minTime(toMin(st) + BLOCK_HOURS * 60) }, toMin(st), toMin(st) + BLOCK_HOURS * 60, built)).find(Boolean);
          return reason ? `${t.name} ${reason}` : null;
        }).filter(Boolean);
        why.push(`${DAY_NAMES[d - 1]}: ${lines.length ? lines.join("; ") : "no free room"}`);
      }
    }
    setAutoNote(got >= target0
      ? `Filled in for you: ${got} of ${target0} h, every class on a time when its room and trainer are free (rules: Administration › Business Rules).${testUsed ? ` ${testUsed} class${testUsed === 1 ? "" : "es"} use a test account as trainer because no real trainer was free then: pick a real trainer when one is available.` : ""} Change anything you like, then book the week.`
      : `Filled in ${got} of ${target0} h. For the other ${target0 - got} h no free time, room and trainer exist. ${why.join(" · ")}. Free a trainer (move or cancel that class, or add the trainer's hours in Bookings › Availability) or add a trainer, then press Auto-fill again; nothing was guessed.`);
    return built;
  };
  const total0 = (list: Row[]) => list.reduce((s, r) => s + hoursOf(r), 0);
  // A week that was never booked fills itself once the rooms' and trainers' open hours are read.
  const hoursReady = !!busyWin && rooms.length > 0 && staff.length > 0 && rooms.every(r => roomHours[r.id]) && staff.every(x => trainerHours[x.id]);
  useEffect(() => {
    if (autoDone.current || !canEdit || (!detail && !draftReady) || !hoursReady) return;
    if ((detail?.batches[0]?.sessions ?? []).length || rows.some(filled)) { autoDone.current = true; return; }
    autoDone.current = true; autoFill();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when everything it needs has loaded
  }, [hoursReady, detail, draftReady, canEdit]);

  const set = (key: string, patch: Partial<Row>) => { setRows(list => list.map(r => (r.key === key ? { ...r, ...patch } : r))); setDone(null); };
  const addClass = (weekday: number) => setRows(list => { const at = list.map(r => r.weekday).lastIndexOf(weekday); const next = [...list]; next.splice(at + 1, 0, blank(weekday)); return next; });
  const remove = (r: Row) => setRows(list => (list.filter(x => x.weekday === r.weekday).length > 1 ? list.filter(x => x.key !== r.key) : list.map(x => (x.key === r.key ? blank(r.weekday) : x))));

  const book = async (list: typeof sessions = sessions) => {
    if (busy || (list === sessions && why)) return;
    setBusy(true); setError(""); setDone(null);
    try {
      if (draft || !intakeId) {
        // No intake yet: keep the week; the course wizard creates the intake and books it at Finish.
        const used = [...new Set(list.map(x => x.roomId))];
        const seats = used.map(id => rooms.find(r => r.id === id)?.capacity ?? null);
        const capacity = seats.length && seats.every(Boolean) ? String(Math.min(...(seats as number[]))) : "";
        await draft?.onDraft({ sessions: list, capacity, trainerIds: [...new Set(list.map(x => x.trainerId))] });
        return;
      }
      // The intake is CoE or VoE as this screen books it.
      const loads = await loadIntakeLoads(courseId).catch(() => ({} as Record<string, StudyLoad>));
      if ((loads[intakeId] ?? "coe") !== load) await setIntakeLoad(intakeId, load);
      const used = [...new Set(list.map(s => s.roomId))];
      const seats = used.map(id => rooms.find(r => r.id === id)?.capacity ?? null);
      const capacity = seats.length && seats.every(Boolean) ? String(Math.min(...(seats as number[]))) : "";
      const out = await rtoFlow<IntakeDetail & { batchId: string }>("batch_setup", { batchId: detail?.batches[0]?.id ?? null, intakeId, sessions: list, capacity, trainerIds: [...new Set(list.map(s => s.trainerId))] });
      let made: GenerateResult;
      try { made = await generateClassSessions(out.batchId); }
      catch (g) {
        setDetail(out);
        setError(`The week's times are saved, but the dated classes could not be made: ${g instanceof Error ? g.message : "error"} Change that class's trainer, room or time (the lists show only free ones) and book again.`);
        return;
      }
      setDetail(out); setDone(made);
      onSaved?.(made);
    } catch (e) { setError(e instanceof Error ? e.message : "The week was not booked."); }
    finally { setBusy(false); }
  };

  if (!detail && !draftReady) return <p className="text-sm text-foreground-500">{error || "Loading the intake…"}</p>;
  // Saturday and Sunday stay out of the way unless they have a class or are asked for.
  const vis = rows.filter(r => r.weekday <= 5 || showWeekend || filled(r));
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-background-200 bg-background-100/60 px-3 py-2 text-sm">
      <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-800">{load === "coe" ? "CoE" : "VoE"} · {target} h a week</span>
      {TYPES.map(t => { const h = byType(t.id); return <span key={t.id} className={h === split[t.id] ? "text-green-800" : "text-foreground-700"}>{t.label} <b>{h}</b> / {split[t.id]} h</span>; })}
      <span className={"ml-auto font-semibold " + (total === target ? "text-green-800" : total > target ? "text-red-700" : "text-foreground-900")}>Total {total} / {target} h</span>
    </div>
    {canEdit ? <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
      <button type="button" disabled={busy || !hoursReady} onClick={() => {
        // The AI takes over the whole week: it fills every class and, when all the hours fit, books it (nothing to click after).
        const built = autoFill();
        const list = built.map(r => ({ weekday: r.weekday, startTime: r.start, endTime: r.end, type: r.type, roomId: r.roomId, trainerId: r.trainerId }));
        if (built.length && total0(built) >= target && !built.some(r => problem(r, built))) void book(list);
      }}
        className="inline-flex items-center gap-1 rounded-md bg-primary-600 px-2.5 py-1 font-semibold text-white hover:bg-primary-700 disabled:opacity-50" title="Fills the whole week and books it when every hour fits">
        <i className="ri-magic-line" aria-hidden="true" />Auto-fill and book the week</button>
      <button type="button" disabled={busy || !hoursReady} onClick={() => { autoFill(); }}
        className="inline-flex items-center gap-1 rounded-md border border-background-300 px-2 py-1 font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50" title="Fills the week for you to check before booking">Fill only</button>
      <button type="button" disabled={busy} onClick={() => { setRows([1, 2, 3, 4, 5, 6, 7].map(blank)); setAutoNote(""); setDone(null); }}
        className="inline-flex items-center gap-1 rounded-md border border-background-300 px-2 py-1 font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50">Clear the week</button>
      <span className="text-foreground-500">{rooms.length} room{rooms.length === 1 ? "" : "s"} · {staff.length} trainer{staff.length === 1 ? "" : "s"}</span>
      <a href="/admin/lms/locations" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-background-300 px-2 py-1 font-semibold text-foreground-800 hover:bg-background-100">
        <i className="ri-add-line" aria-hidden="true" />Add room</a>
      <button type="button" disabled={roomsBusy} onClick={() => void reloadRooms()} className="inline-flex items-center gap-1 rounded-md border border-background-300 px-2 py-1 font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50">
        <i className={roomsBusy ? "ri-loader-4-line animate-spin" : "ri-refresh-line"} aria-hidden="true" />Reload rooms</button>
    </div> : null}
    {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {autoNote ? <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800"><i className="ri-magic-line mr-1" aria-hidden="true" />{autoNote}</p> : null}
    {clashLines.length ? <ul role="alert" className="list-disc rounded-lg border border-red-200 bg-red-50 py-2 pl-8 pr-3 text-sm text-red-700">{clashLines.map(c => <li key={c}>{c}</li>)}</ul> : null}
    {done ? <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">Week booked: rooms, trainers and class times saved, and the dated classes made.</p> : null}

    <div className="overflow-x-auto rounded-lg border border-background-200">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="bg-background-100"><tr><th className={th}>Day</th><th className={th}>Kind</th><th className={th}>Room</th><th className={th}>Trainer</th><th className={th}>Start</th><th className={th}>End</th><th className={th + " text-right"}>Hours</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{vis.map((r, i) => {
          const first = i === 0 || vis[i - 1].weekday !== r.weekday;
          const last = i === vis.length - 1 || vis[i + 1].weekday !== r.weekday;
          const msg = problem(r);
          const roomList = roomsFor(r.type);
          return <tr key={r.key} className={(first ? "border-t border-background-200 " : "") + "align-top"}>
            <td className="px-2 py-1.5 font-semibold text-foreground-900">{first ? DAY_NAMES[r.weekday - 1] : ""}</td>
            <td className="px-2 py-1.5"><SearchableSelect aria-label={`${DAY_NAMES[r.weekday - 1]}: kind`} className={field} value={r.type} disabled={!canEdit || busy}
              onChange={e => { const type = e.target.value as SessionType; set(r.key, { type, roomId: roomsFor(type).some(x => x.id === r.roomId) ? r.roomId : "" }); }}>
              {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</SearchableSelect></td>
            <td className="px-2 py-1.5"><SearchableSelect aria-label={`${DAY_NAMES[r.weekday - 1]}: room`} className={field + " w-52"} value={r.roomId} disabled={!canEdit || busy} onChange={e => set(r.key, { roomId: e.target.value })}>
              <option value="">{roomList.length ? "Room…" : `No ${r.type} room`}</option>{roomList.filter(x => x.id === r.roomId || !roomBusy(x.id, r)).map(x =>
                <option key={x.id} value={x.id}>{x.label}</option>)}</SearchableSelect></td>
            <td className="px-2 py-1.5"><SearchableSelect aria-label={`${DAY_NAMES[r.weekday - 1]}: trainer`} className={field + " w-44"} value={r.trainerId} disabled={!canEdit || busy} onChange={e => set(r.key, { trainerId: e.target.value })}>
              <option value="">Trainer…</option>{staff.filter(x => x.id === r.trainerId || !trainerBusy(x.id, r)).map(x =>
                <option key={x.id} value={x.id}>{x.name}</option>)}</SearchableSelect></td>
            <td className="px-2 py-1.5"><SearchableSelect aria-label={`${DAY_NAMES[r.weekday - 1]}: start`} className={field} value={r.start} disabled={!canEdit || busy} onChange={e => set(r.key, { start: e.target.value })}>
              <option value="">—</option>{TIMES.slice(0, -1).filter(t => t === r.start || slotFree(r, toMin(t), toMin(t) + 30)).map(t =>
                <option key={t} value={t}>{clock(t)}</option>)}</SearchableSelect></td>
            <td className="px-2 py-1.5"><SearchableSelect aria-label={`${DAY_NAMES[r.weekday - 1]}: end`} className={field} value={r.end} disabled={!canEdit || busy} onChange={e => set(r.key, { end: e.target.value })}>
              <option value="">—</option>{TIMES.filter(t => t === r.end || (!r.start ? slotFree(r, toMin(t) - 30, toMin(t)) : toMin(t) > toMin(r.start) && slotFree(r, toMin(r.start), toMin(t)))).map(t =>
                <option key={t} value={t}>{clock(t)}</option>)}</SearchableSelect>
              {msg ? <span role="alert" className="mt-0.5 block max-w-[260px] text-xs font-semibold text-red-700">{msg}</span> : null}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{hoursOf(r) || ""}</td>
            <td className="whitespace-nowrap px-2 py-1.5 text-right">{canEdit ? <>
              {filled(r) || rows.filter(x => x.weekday === r.weekday).length > 1 ? <button type="button" disabled={busy} onClick={() => remove(r)} aria-label="Remove this class" className="rounded p-1 text-red-700 hover:bg-red-50"><i className="ri-close-line" aria-hidden="true" /></button> : null}
              {last ? <button type="button" disabled={busy} onClick={() => addClass(r.weekday)} className="ml-1 rounded px-1.5 py-0.5 text-xs font-semibold text-primary-700 hover:bg-primary-50">+ another class</button> : null}</> : null}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {canEdit && !showWeekend && !rows.some(r => r.weekday > 5 && filled(r)) ? <button type="button" onClick={() => setShowWeekend(true)} className="text-xs font-semibold text-primary-700 hover:underline">+ Add Saturday or Sunday classes</button> : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">{footerStart}</div>
      <div className="flex items-center gap-3">
        {why ? <span className="text-sm font-semibold text-amber-800">{why}</span> : null}
        <Button icon="ri-calendar-check-line" disabled={!!why || busy} onClick={() => void book()}>{busy ? "Booking…" : saveLabel}</Button>
      </div>
    </div>
    <p className="text-xs text-foreground-500">An empty day has no class. A room can be used again the same day at other times; it must be open then in Bookings › Availability and not used by another intake; a trainer must be available and free. Theory and assessment classes use theory rooms (assessment can use any room); practical classes use practical rooms. {DAYS.length} days, several classes a day allowed.</p>
  </div>;
}

/** Course setup: the CoE or VoE intake's weekly classes in a dialog. */
export default function WeeklyClassBookingDialog({ title, intakeId, courseId, load, canEdit, onClose, onBack, backLabel, onSaved, saveLabel, draft }: {
  draft?: DraftMode;
  title: string; intakeId: string | null; courseId: string; load: StudyLoad; canEdit: boolean; onClose: () => void;
  onBack?: () => void; backLabel?: string; onSaved?: (made: GenerateResult) => void; saveLabel?: string;
}) {
  return <Modal open keepOpen title={title} width="max-w-[96vw]" onClose={onClose}>
    <WeeklyClassBooking intakeId={intakeId} courseId={courseId} load={load} canEdit={canEdit} onSaved={onSaved} saveLabel={saveLabel} draft={draft}
      footerStart={onBack ? <Button variant="outline" icon="ri-arrow-left-line" onClick={onBack}>{backLabel ?? "Back"}</Button> : null} />
  </Modal>;
}
