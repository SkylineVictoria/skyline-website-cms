// Bookings › Availability › Rooms / Trainers: one room's or trainer's weekly hours and time off, kept in the same Bookings
// tables as everyone's. The timetable only uses a room or trainer inside these hours; blue tags show the classes already there.
import { useEffect, useState } from "react";
import { Button, Select } from "@/pages/admin/components/ui";
import type { AvailabilityRow, RoomAvailability as Data, TimeOffRow } from "@/lib/bookingApi";
import { HoursCard, TimeOffCard } from "./AvailabilityCards";

export interface ResourceOption { id: string; name: string; group: string; detail: string }
export interface ResourceKind {
  noun: "room" | "trainer";
  load: (id: string) => Promise<Data & { ownPage?: boolean }>;
  save: (id: string, availability: AvailabilityRow[], timeOff: TimeOffRow[]) => Promise<Data & { ownPage?: boolean }>;
  empty: string;
}

export default function ResourceAvailability({ kind, options, canEdit, initial, onSaved, onError }: {
  kind: ResourceKind; options: ResourceOption[]; canEdit: boolean; initial?: string | null;
  onSaved: (message: string) => void; onError: (e: unknown) => void;
}) {
  const [id, setId] = useState(initial && options.some((o) => o.id === initial) ? initial : options[0]?.id ?? "");
  const [data, setData] = useState<(Data & { ownPage?: boolean }) | null>(null);
  const [rows, setRows] = useState<AvailabilityRow[]>([]);
  const [off, setOff] = useState<TimeOffRow[]>([]);
  const [busy, setBusy] = useState(false);
  const show = (d: Data & { ownPage?: boolean }) => { setData(d); setRows(d.availability); setOff(d.timeOff); };
  const { load, save: saveIt } = kind;

  useEffect(() => {
    if (!id) return;
    let active = true;
    setData(null);
    load(id).then((d) => { if (active) show(d); }).catch((e) => { if (active) onError(e); });
    return () => { active = false; };
  }, [id, load, onError]);

  const current = options.find((o) => o.id === id);
  const save = async () => {
    setBusy(true);
    try { show(await saveIt(id, rows, off.filter((o) => o.start && o.end))); onSaved(`${current?.name ?? "The"} availability was saved.`); }
    catch (e) { onError(e); } finally { setBusy(false); }
  };
  if (!options.length) return <p className="text-sm text-foreground-600">{kind.empty}</p>;

  const label = kind.noun === "room" ? "Room" : "Trainer";
  const groups = [...new Set(options.map((o) => o.group))];
  return (
    <div className="space-y-5">
      <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground-900">{label}
        <Select className="w-auto min-w-[16rem]" value={id} onChange={(e) => setId(e.target.value)}>
          {groups.map((g) => <optgroup key={g} label={g}>{options.filter((o) => o.group === g).map((o) => (
            <option key={o.id} value={o.id}>{o.name}{o.detail ? ` · ${o.detail}` : ""}</option>
          ))}</optgroup>)}
        </Select>
      </label>
      {!canEdit ? <p className="rounded-md border border-background-200 bg-background-100 px-3 py-2 text-sm text-foreground-700">Only an RTO Manager can change {kind.noun} availability.</p> : null}
      {data && kind.noun === "trainer" ? <p className="text-sm text-foreground-600">{data.ownPage
        ? "These are the trainer's own Bookings hours: they see and can change the same hours under Availability › Me."
        : "The trainer has no booking page yet. These hours become theirs when they open Bookings."}</p> : null}
      {!data ? <p role="status" className="text-sm text-foreground-600">Loading…</p> : <>
        <HoursCard rows={rows} onChange={setRows} readOnly={!canEdit} emptyLabel={kind.noun === "room" ? "Closed" : "Not available"}
          title={<>Weekly hours <span className="ml-2 rounded bg-primary-50 px-1.5 py-0.5 align-middle text-xs font-bold text-primary-700">{current?.name}</span></>}
          intro={rows.length
            ? `A day without hours means the ${kind.noun} ${kind.noun === "room" ? "is closed" : "does not teach"}. Blue tags are classes already ${kind.noun === "room" ? "in the room" : "taught"}.`
            : `No hours set: the ${kind.noun} can be used at any time until you add hours.`}
          extra={(weekday) => {
            const uses = data.bookings.filter((b) => b.weekday === weekday);
            return uses.length ? <div className="flex flex-wrap gap-1.5">{uses.map((b, i) => (
              <span key={i} title={`${b.courseCode} ${b.intake} · ${b.startDate} – ${b.endDate ?? "open"} · ${b.type}`}
                className="rounded border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800">{b.intake} · {b.courseCode} · {b.startTime}–{b.endTime}</span>
            ))}</div> : null;
          }} />
        <TimeOffCard rows={off} onChange={setOff} readOnly={!canEdit}
          notePlaceholder={kind.noun === "room" ? "Reason, e.g. Renovation" : "Reason, e.g. Leave"}
          intro={kind.noun === "room" ? "Days the room cannot be used. Refused if classes are already in the room on those days."
            : "Days the trainer cannot teach. Refused if they already teach classes on those days."} />
        {canEdit ? <Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save availability"}</Button> : null}
      </>}
    </div>
  );
}
