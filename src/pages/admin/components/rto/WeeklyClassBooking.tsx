// One screen for an intake's weekly classes (owner, 2026-11-20), in place of the Rooms, Trainers and Weekly class times pages:
// Monday to Sunday listed by default; each class is a row with its kind (Theory / Practical / Assessment), room, trainer and
// start / end time, and a day can have several classes as long as the times are free. Booking the week saves the room, the
// trainer and the class time of every row together (rto_course_flow batch_setup), then makes the dated classes
// (rto_class_sessions_generate). A CoE intake books 20 hours a week, a VoE intake 40 (one screen each in course setup).
// The room must be open then (Bookings › Availability) and not used by another intake; the trainer likewise; the server checks
// again on save (intake_class_times triggers, class_sessions_no_clash).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { roomAvailability, trainerAvailability, type AvailabilityRow, type RoomUse } from "@/lib/bookingApi";
import { loadCourseNeed, type CourseNeed } from "@/pages/admin/lib/coursePlan";
import {
  DAYS, LOAD_HOURS, clashText, generateClassSessions, loadIntakeLoads, rto, rtoFlow, setIntakeLoad,
  type Clash, type GenerateResult, type IntakeDetail, type LocationRooms, type SessionType, type StaffOption, type StudyLoad,
} from "@/pages/admin/lib/rto";

type Row = { key: string; weekday: number; type: SessionType; roomId: string; trainerId: string; start: string; end: string };
type Hours = { avail: AvailabilityRow[]; uses: RoomUse[] };
const TYPES: { id: SessionType; label: string }[] = [{ id: "theory", label: "Theory" }, { id: "practical", label: "Practical" }, { id: "assessment", label: "Assessment" }];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TIMES = Array.from({ length: 31 }, (_, i) => { const m = 7 * 60 + i * 30; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; });
const TRAINER_DEFAULT: AvailabilityRow[] = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: "09:00", end: "22:00" }));
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
  const base = need && need.total > 0 ? need : { theory: 40, practical: 40, assessment: 20, total: 100 };
  const theory = Math.round((total * base.theory) / base.total), practical = Math.min(total - theory, Math.round((total * base.practical) / base.total));
  return { theory, practical, assessment: Math.max(0, total - theory - practical) };
}
const field = "h-8 rounded-md border border-background-300 bg-background-50 px-2 text-sm text-foreground-900 disabled:opacity-60";
const th = "px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground-500";

export function WeeklyClassBooking({ intakeId, courseId, load, canEdit, onSaved, saveLabel = "Book the week", footerStart }: {
  intakeId: string; courseId: string; load: StudyLoad; canEdit: boolean;
  onSaved?: (made: GenerateResult) => void; saveLabel?: string; footerStart?: ReactNode;
}) {
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [locations, setLocations] = useState<LocationRooms[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [need, setNeed] = useState<CourseNeed | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [roomHours, setRoomHours] = useState<Record<string, Hours>>({});
  const [trainerHours, setTrainerHours] = useState<Record<string, Hours>>({});
  const [clashes, setClashes] = useState<Clash[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<GenerateResult | null>(null);
  const target = LOAD_HOURS[load];

  useEffect(() => {
    let live = true;
    setDetail(null); setRows([]); setError(""); setDone(null);
    void Promise.all([rto<IntakeDetail>("intake_get", { intakeId }), rtoFlow<LocationRooms[]>("locations_rooms"), rto<StaffOption[]>("staff_list")])
      .then(([d, l, s]) => {
        if (!live) return;
        setDetail(d); setLocations(l); setStaff(s);
        // Monday to Sunday by default; a saved week comes back with its classes (several on a day when it had them).
        const saved = (d.batches[0]?.sessions ?? []).map(x => ({ key: `r${++seq}`, weekday: x.weekday, type: x.type, roomId: x.roomId ?? "", trainerId: x.trainerId ?? "", start: x.startTime.slice(0, 5), end: x.endTime.slice(0, 5) }));
        setRows([1, 2, 3, 4, 5, 6, 7].flatMap(day => { const mine = saved.filter(r => r.weekday === day).sort((a, b) => a.start.localeCompare(b.start)); return mine.length ? mine : [blank(day)]; }));
      }).catch(e => { if (live) setError(e instanceof Error ? e.message : "The intake did not load."); });
    void loadCourseNeed(courseId).then(n => { if (live) setNeed(n); }).catch(() => undefined);
    return () => { live = false; };
  }, [intakeId, courseId]);

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
  /** Why a room cannot take this row's class ("" when it is free). The same room can be used again the same day at other times. */
  const roomBusy = (roomId: string, r: Row): string => {
    if (!r.start || !r.end || toMin(r.end) <= toMin(r.start)) return "";
    const s = toMin(r.start), e = toMin(r.end);
    const mine = rows.find(o => o !== r && o.roomId === roomId && o.weekday === r.weekday && o.start && o.end && toMin(o.start) < e && toMin(o.end) > s);
    if (mine) return `booked ${clock(mine.start)} – ${clock(mine.end)}`;
    const h = roomHours[roomId];
    if (h && h.avail.length && !covers(h.avail, r.weekday, s, e)) return "closed then";
    if (h && elsewhere(h.uses, r.weekday, s, e)) return "another intake then";
    return "";
  };
  /** Why a trainer cannot take this row's class ("" when free): another class here then, not available, or another intake. */
  const trainerBusy = (trainerId: string, r: Row, s = r.start ? toMin(r.start) : -1, e = r.end ? toMin(r.end) : -1): string => {
    if (s < 0 || e <= s) return "";
    const mine = rows.find(o => o !== r && o.trainerId === trainerId && o.weekday === r.weekday && o.start && o.end && toMin(o.start) < e && toMin(o.end) > s);
    if (mine) return `booked ${clock(mine.start)} – ${clock(mine.end)}`;
    const h = trainerHours[trainerId];
    if (h && !covers(h.avail.length ? h.avail : TRAINER_DEFAULT, r.weekday, s, e)) return "not available then";
    if (h && elsewhere(h.uses, r.weekday, s, e)) return "teaching another intake";
    return "";
  };
  /** Can this row's class run from s to e (minutes)? Not over another class of the day, and its room and trainer free then. */
  const slotFree = (r: Row, s: number, e: number) => {
    if (rows.some(o => o !== r && o.weekday === r.weekday && o.start && o.end && toMin(o.start) < e && toMin(o.end) > s)) return false;
    if (r.trainerId && trainerBusy(r.trainerId, r, s, e)) return false;
    if (r.roomId && roomBusy(r.roomId, { ...r, start: minTime(s), end: minTime(e) })) return false;
    return true;
  };
  /** What is wrong with a row ("" when it can be booked; an empty row is fine: no class). */
  const problem = (r: Row): string => {
    if (!filled(r)) return "";
    if (!r.start || !r.end) return "Pick the start and end time.";
    const s = toMin(r.start), e = toMin(r.end);
    if (e <= s) return "The end must be after the start.";
    if (!r.roomId) return "Pick a room.";
    if (!r.trainerId) return "Pick a trainer.";
    const day = DAY_NAMES[r.weekday - 1];
    const same = rows.find(o => o !== r && filled(o) && o.weekday === r.weekday && o.start && o.end && toMin(o.start) < e && toMin(o.end) > s);
    if (same) return `Overlaps the other class on ${day} (${clock(same.start)} – ${clock(same.end)}).`;
    const rh = roomHours[r.roomId];
    if (rh && rh.avail.length && !covers(rh.avail, r.weekday, s, e)) return `The room is not open on ${day} ${clock(r.start)} – ${clock(r.end)} (Bookings › Availability).`;
    if (rh && elsewhere(rh.uses, r.weekday, s, e)) return `Another intake uses the room on ${day} then.`;
    const tr = trainerHours[r.trainerId];
    if (tr && !covers(tr.avail.length ? tr.avail : TRAINER_DEFAULT, r.weekday, s, e)) return `The trainer is not available on ${day} ${clock(r.start)} – ${clock(r.end)}.`;
    if (tr && elsewhere(tr.uses, r.weekday, s, e)) return `The trainer teaches another intake on ${day} then.`;
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

  const set = (key: string, patch: Partial<Row>) => { setRows(list => list.map(r => (r.key === key ? { ...r, ...patch } : r))); setDone(null); };
  const addClass = (weekday: number) => setRows(list => { const at = list.map(r => r.weekday).lastIndexOf(weekday); const next = [...list]; next.splice(at + 1, 0, blank(weekday)); return next; });
  const remove = (r: Row) => setRows(list => (list.filter(x => x.weekday === r.weekday).length > 1 ? list.filter(x => x.key !== r.key) : list.map(x => (x.key === r.key ? blank(r.weekday) : x))));

  const book = async () => {
    if (why || busy) return;
    setBusy(true); setError(""); setDone(null);
    try {
      // The intake is CoE or VoE as this screen books it.
      const loads = await loadIntakeLoads(courseId).catch(() => ({} as Record<string, StudyLoad>));
      if ((loads[intakeId] ?? "coe") !== load) await setIntakeLoad(intakeId, load);
      const used = [...new Set(sessions.map(s => s.roomId))];
      const seats = used.map(id => rooms.find(r => r.id === id)?.capacity ?? null);
      const capacity = seats.length && seats.every(Boolean) ? String(Math.min(...(seats as number[]))) : "";
      const out = await rtoFlow<IntakeDetail & { batchId: string }>("batch_setup", { batchId: detail?.batches[0]?.id ?? null, intakeId, sessions, capacity, trainerIds: [...new Set(sessions.map(s => s.trainerId))] });
      const made = await generateClassSessions(out.batchId);
      setDetail(out); setDone(made);
      onSaved?.(made);
    } catch (e) { setError(e instanceof Error ? e.message : "The week was not booked."); }
    finally { setBusy(false); }
  };

  if (!detail) return <p className="text-sm text-foreground-500">{error || "Loading the intake…"}</p>;
  const roomsFor = (t: SessionType) => rooms.filter(r => t === "assessment" || r.kind === t);
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-background-200 bg-background-100/60 px-3 py-2 text-sm">
      <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-800">{load === "coe" ? "CoE" : "VoE"} · {target} h a week</span>
      {TYPES.map(t => { const h = byType(t.id); return <span key={t.id} className={h === split[t.id] ? "text-green-800" : "text-foreground-700"}>{t.label} <b>{h}</b> / {split[t.id]} h</span>; })}
      <span className={"ml-auto font-semibold " + (total === target ? "text-green-800" : total > target ? "text-red-700" : "text-foreground-900")}>Total {total} / {target} h</span>
    </div>
    {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {clashLines.length ? <ul role="alert" className="list-disc rounded-lg border border-red-200 bg-red-50 py-2 pl-8 pr-3 text-sm text-red-700">{clashLines.map(c => <li key={c}>{c}</li>)}</ul> : null}
    {done ? <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">Week booked: rooms, trainers and class times saved, and the dated classes made.</p> : null}

    <div className="overflow-x-auto rounded-lg border border-background-200">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="bg-background-100"><tr><th className={th}>Day</th><th className={th}>Kind</th><th className={th}>Room</th><th className={th}>Trainer</th><th className={th}>Start</th><th className={th}>End</th><th className={th + " text-right"}>Hours</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows.map((r, i) => {
          const first = i === 0 || rows[i - 1].weekday !== r.weekday;
          const last = i === rows.length - 1 || rows[i + 1].weekday !== r.weekday;
          const msg = problem(r);
          const roomList = roomsFor(r.type);
          return <tr key={r.key} className={(first ? "border-t border-background-200 " : "") + "align-top"}>
            <td className="px-2 py-1.5 font-semibold text-foreground-900">{first ? DAY_NAMES[r.weekday - 1] : ""}</td>
            <td className="px-2 py-1.5"><select aria-label={`${DAY_NAMES[r.weekday - 1]}: kind`} className={field} value={r.type} disabled={!canEdit || busy}
              onChange={e => { const type = e.target.value as SessionType; set(r.key, { type, roomId: roomsFor(type).some(x => x.id === r.roomId) ? r.roomId : "" }); }}>
              {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></td>
            <td className="px-2 py-1.5"><select aria-label={`${DAY_NAMES[r.weekday - 1]}: room`} className={field + " w-52"} value={r.roomId} disabled={!canEdit || busy} onChange={e => set(r.key, { roomId: e.target.value })}>
              <option value="">{roomList.length ? "Room…" : `No ${r.type} room`}</option>{roomList.map(x => { const why = roomBusy(x.id, r);
                return <option key={x.id} value={x.id} disabled={!!why && x.id !== r.roomId}>{x.label}{why ? ` — ${why}` : r.start && r.end ? " — free" : ""}</option>; })}</select></td>
            <td className="px-2 py-1.5"><select aria-label={`${DAY_NAMES[r.weekday - 1]}: trainer`} className={field + " w-44"} value={r.trainerId} disabled={!canEdit || busy} onChange={e => set(r.key, { trainerId: e.target.value })}>
              <option value="">Trainer…</option>{staff.map(x => { const why = trainerBusy(x.id, r);
                return <option key={x.id} value={x.id} disabled={!!why && x.id !== r.trainerId}>{x.name}{why ? ` — ${why}` : r.start && r.end ? " — free" : ""}</option>; })}</select></td>
            <td className="px-2 py-1.5"><select aria-label={`${DAY_NAMES[r.weekday - 1]}: start`} className={field} value={r.start} disabled={!canEdit || busy} onChange={e => set(r.key, { start: e.target.value })}>
              <option value="">—</option>{TIMES.slice(0, -1).map(t => { const s0 = toMin(t); const ok = slotFree(r, s0, s0 + 30);
                return <option key={t} value={t} disabled={!ok && t !== r.start}>{clock(t)}{ok ? "" : " — taken"}</option>; })}</select></td>
            <td className="px-2 py-1.5"><select aria-label={`${DAY_NAMES[r.weekday - 1]}: end`} className={field} value={r.end} disabled={!canEdit || busy} onChange={e => set(r.key, { end: e.target.value })}>
              <option value="">—</option>{TIMES.filter(t => !r.start || toMin(t) > toMin(r.start)).map(t => { const ok = !r.start || slotFree(r, toMin(r.start), toMin(t));
                return <option key={t} value={t} disabled={!ok && t !== r.end}>{clock(t)}{ok ? "" : " — taken"}</option>; })}</select>
              {msg ? <span role="alert" className="mt-0.5 block max-w-[260px] text-xs font-semibold text-red-700">{msg}</span> : null}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{hoursOf(r) || ""}</td>
            <td className="whitespace-nowrap px-2 py-1.5 text-right">{canEdit ? <>
              {filled(r) || rows.filter(x => x.weekday === r.weekday).length > 1 ? <button type="button" disabled={busy} onClick={() => remove(r)} aria-label="Remove this class" className="rounded p-1 text-red-700 hover:bg-red-50"><i className="ri-close-line" aria-hidden="true" /></button> : null}
              {last ? <button type="button" disabled={busy} onClick={() => addClass(r.weekday)} className="ml-1 rounded px-1.5 py-0.5 text-xs font-semibold text-primary-700 hover:bg-primary-50">+ another class</button> : null}</> : null}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
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
export default function WeeklyClassBookingDialog({ title, intakeId, courseId, load, canEdit, onClose, onBack, backLabel, onSaved, saveLabel }: {
  title: string; intakeId: string; courseId: string; load: StudyLoad; canEdit: boolean; onClose: () => void;
  onBack?: () => void; backLabel?: string; onSaved?: (made: GenerateResult) => void; saveLabel?: string;
}) {
  return <Modal open keepOpen title={title} width="max-w-6xl" onClose={onClose}>
    <WeeklyClassBooking intakeId={intakeId} courseId={courseId} load={load} canEdit={canEdit} onSaved={onSaved} saveLabel={saveLabel}
      footerStart={onBack ? <Button variant="outline" icon="ri-arrow-left-line" onClick={onBack}>{backLabel ?? "Back"}</Button> : null} />
  </Modal>;
}
