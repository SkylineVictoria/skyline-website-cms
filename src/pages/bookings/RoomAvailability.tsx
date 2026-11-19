// Bookings › Availability › Rooms: a room's weekly hours and time off, kept in the same Bookings tables as people's. The
// timetable only puts a class in a room inside these hours; blue tags show the intakes already using it.
import { useEffect, useState } from "react";
import { Button, Select } from "@/pages/admin/components/ui";
import { roomAvailability, saveRoomAvailability, type AvailabilityRow, type BookingRoom, type RoomAvailability as RoomData, type TimeOffRow } from "@/lib/bookingApi";
import { HoursCard, TimeOffCard } from "./AvailabilityCards";

export default function RoomAvailability({ rooms, canEdit, initialRoom, onSaved, onError }: {
  rooms: BookingRoom[]; canEdit: boolean; initialRoom?: string | null; onSaved: (message: string) => void; onError: (e: unknown) => void;
}) {
  const [roomId, setRoomId] = useState(initialRoom && rooms.some((r) => r.id === initialRoom) ? initialRoom : rooms[0]?.id ?? "");
  const [data, setData] = useState<RoomData | null>(null);
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [off, setOff] = useState<TimeOffRow[]>([]);
  const [busy, setBusy] = useState(false);
  const show = (d: RoomData) => { setData(d); setRows(d.availability); setOff(d.timeOff); };

  useEffect(() => {
    if (!roomId) return;
    let active = true;
    setData(null);
    roomAvailability(roomId).then((d) => { if (active) show(d); }).catch((e) => { if (active) onError(e); });
    return () => { active = false; };
  }, [roomId, onError]);

  const room = rooms.find((r) => r.id === roomId);
  const save = async () => {
    setBusy(true);
    try { show(await saveRoomAvailability(roomId, rows, off.filter((o) => o.start && o.end))); onSaved(`${room?.name ?? "The room"}'s availability was saved.`); }
    catch (e) { onError(e); } finally { setBusy(false); }
  };
  if (!rooms.length) return <p className="text-sm text-foreground-600">No rooms yet. Add rooms in LMS › Timetable › Settings › Locations &amp; rooms.</p>;

  const groups = [...new Set(rooms.map((r) => r.location))];
  return (
    <div className="space-y-5">
      <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground-900">Room
        <Select className="w-auto min-w-[16rem]" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          {groups.map((g) => <optgroup key={g} label={g}>{rooms.filter((r) => r.location === g).map((r) => (
            <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` · ${r.capacity} seats` : ""}{r.openDays ? "" : " · no hours set"}</option>
          ))}</optgroup>)}
        </Select>
      </label>
      {!canEdit ? <p className="rounded-md border border-background-200 bg-background-100 px-3 py-2 text-sm text-foreground-700">Only an RTO Manager can change room availability.</p> : null}
      {!data ? <p role="status" className="text-sm text-foreground-600">Loading…</p> : <>
        <HoursCard rows={rows} onChange={setRows} readOnly={!canEdit} emptyLabel="Closed"
          title={<>Weekly hours <span className="ml-2 rounded bg-primary-50 px-1.5 py-0.5 align-middle text-xs font-bold text-primary-700">{room?.name}</span></>}
          intro={rows.length ? "A day without hours means the room is closed. Blue tags are intakes using the room." : "No hours set: the room can be used at any time until you add hours."}
          extra={(weekday) => {
            const uses = data.bookings.filter((b) => b.weekday === weekday);
            return uses.length ? <div className="flex flex-wrap gap-1.5">{uses.map((b, i) => (
              <span key={i} title={`${b.courseCode} ${b.intake} · ${b.startDate} – ${b.endDate ?? "open"} · ${b.type}`}
                className="rounded border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800">{b.intake} · {b.courseCode} · {b.startTime}–{b.endTime}</span>
            ))}</div> : null;
          }} />
        <TimeOffCard rows={off} onChange={setOff} readOnly={!canEdit} notePlaceholder="Reason, e.g. Renovation"
          intro="Days the room cannot be used. Refused if classes are already in the room on those days." />
        {canEdit ? <Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save availability"}</Button> : null}
      </>}
    </div>
  );
}
