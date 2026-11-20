// Course wizard > Intakes: the course's usual classes (days, times, room) and seats. A new intake with no class setup gets it from
// these, so its dated calendar appears at once.
import { useEffect, useState } from "react";
import { Button, Select, TextInput } from "@/pages/admin/components/ui";
import { ErrorNote } from "@/pages/admin/components/rto/shared";
import { rto, rtoPlace, type ClassDefaults as Defaults, type SessionType } from "@/pages/admin/lib/rto";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
interface Room { id: string; name: string; campus: string | null; capacity: number | null; isActive: boolean }

export default function ClassDefaults({ courseId, canEdit }: { courseId: string; canEdit: boolean }) {
  const [value, setValue] = useState<Defaults | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [error, setError] = useState(""); const [saved, setSaved] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all([rtoPlace<Defaults>("defaults_get", { courseId }), rto<Room[]>("classroom_list")])
      .then(([d, r]) => { if (live) { setValue(d); setRooms(r.filter((x) => x.isActive)); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "The class defaults did not load."); });
    return () => { live = false; };
  }, [courseId]);
  if (!value) return error ? <ErrorNote text={error} /> : null;
  const set = (patch: Partial<Defaults>) => { setValue({ ...value, ...patch }); setSaved(false); };
  const setClass = (i: number, patch: Partial<Defaults["sessions"][number]>) => set({ sessions: value.sessions.map((c, x) => (x === i ? { ...c, ...patch } : c)) });
  const room = rooms.find((r) => r.id === value.classroomId);
  const save = async () => {
    setBusy(true); setError("");
    try { setValue(await rtoPlace<Defaults>("defaults_set", { ...value })); setSaved(true); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved."); }
    finally { setBusy(false); }
  };
  const weeklyHours = Math.round(value.sessions.reduce((sum, c) => { const [h1, m1] = c.startTime.split(":").map(Number); const [h2, m2] = c.endTime.split(":").map(Number); return sum + Math.max(0, (h2 * 60 + m2 - h1 * 60 - m1) / 60); }, 0) * 10) / 10;
  return (
    <details className="mb-4 rounded-card border border-background-200 bg-background-50" data-testid="class-defaults">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-foreground-900">
        Usual classes and seats <span className="ml-2 font-normal text-foreground-500">{value.sessions.length ? `${value.sessions.length} class${value.sessions.length === 1 ? "" : "es"} a week` : "not set"}{value.seats ? ` · ${value.seats} seats` : ""}</span>
      </summary>
      <div className="space-y-3 border-t border-background-200 px-4 py-3">
        <p className="text-sm text-foreground-600">A new intake without a class setup gets its classes from these (so its dated classes appear straight away). Seats are the room&apos;s physical seats; the number here applies when no room is chosen.</p>
        <ErrorNote text={error} />
        {weeklyHours > 0 && weeklyHours < 20 ? (
          <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="defaults-hours-warning">
            <i className="ri-error-warning-line mr-1" aria-hidden="true" />These classes give {weeklyHours} hours a week. CoE students have 20 class hours a week (VoE 40), so an intake set up from these may not finish the course by the intake&apos;s end.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm"><span className="mb-1 block font-medium text-foreground-800">Usual room</span>
            <Select value={value.classroomId ?? ""} disabled={!canEdit} onChange={(e) => set({ classroomId: e.target.value || null })}>
              <option value="">No fixed room</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}{r.campus ? ` · ${r.campus}` : ""}{r.capacity ? ` · ${r.capacity} seats` : ""}</option>)}
            </Select></label>
          <label className="block text-sm"><span className="mb-1 block font-medium text-foreground-800">Seats when there is no room</span>
            <TextInput inputMode="numeric" disabled={!canEdit} value={value.seats ?? ""} placeholder="25" onChange={(e) => set({ seats: e.target.value.replace(/\D/g, "") ? Number(e.target.value.replace(/\D/g, "")) : null })} /></label>
        </div>
        {room?.capacity ? <p className="text-xs text-foreground-500">{room.name} has {room.capacity} seats, so an intake here seats {room.capacity} at most.</p> : null}
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground-800">Weekly classes</p>
          {value.sessions.length === 0 ? <p className="text-sm text-foreground-500">No classes yet.</p> : null}
          {value.sessions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select aria-label="Day" className="w-auto" disabled={!canEdit} value={c.weekday} onChange={(e) => setClass(i, { weekday: Number(e.target.value) })}>{DAYS.map((d, x) => <option key={d} value={x + 1}>{d}</option>)}</Select>
              <TextInput aria-label="Start" type="time" className="w-28" disabled={!canEdit} value={c.startTime} onChange={(e) => setClass(i, { startTime: e.target.value })} />
              <TextInput aria-label="End" type="time" className="w-28" disabled={!canEdit} value={c.endTime} onChange={(e) => setClass(i, { endTime: e.target.value })} />
              <Select aria-label="Type" className="w-auto" disabled={!canEdit} value={c.type} onChange={(e) => setClass(i, { type: e.target.value as SessionType })}>
                <option value="theory">Theory</option><option value="practical">Practical</option><option value="assessment">Assessment</option>
              </Select>
              {canEdit ? <button type="button" className="text-xs text-red-700 underline" onClick={() => set({ sessions: value.sessions.filter((_, x) => x !== i) })}>Remove</button> : null}
            </div>
          ))}
          {canEdit ? <Button variant="outline" size="sm" icon="ri-add-line" onClick={() => set({ sessions: [...value.sessions, { weekday: 1, startTime: "09:00", endTime: "13:00", type: "theory" }] })}>Add a class</Button> : null}
        </div>
        {canEdit ? <div className="flex items-center gap-3"><Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>{saved ? <span role="status" className="text-sm text-green-700">Saved.</span> : null}</div> : null}
      </div>
    </details>
  );
}
