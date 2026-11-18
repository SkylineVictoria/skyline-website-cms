// A course's Prerequisite class: late joiners who missed a prerequisite unit are assigned to it for those units (their catch-up
// dates), then join their intake's group at the next regular unit. Staff set its trainer, room and weekly class times here.
// Data: prereq_class_admin (migration 20261119173527_prerequisite_class).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Select, TextInput } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import { friendlyDbError, rto, rtoFlow, shortDate, type LocationRooms, type StaffOption } from "@/pages/admin/lib/rto";

interface Time { weekday: number; start: string; end: string; type: "theory" | "practical" | "assessment"; roomId: string | null }
interface Member {
  studentId: string; name: string; email: string | null; intake: string | null; intakeStart: string; from: string; to: string; returnOn: string | null;
  units: { code: string; name: string; start: string; end: string }[];
}
interface PrereqClass { class: { id: string; trainerId: string | null; roomId: string | null } | null; times: Time[]; members: Member[] }
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

async function call(action: "get" | "save", data: Record<string, unknown>) {
  const { data: out, error } = await supabase.rpc("prereq_class_admin", { p_action: action, p_data: data });
  if (error) throw new Error(friendlyDbError(error.message));
  return out as PrereqClass;
}

export default function PrerequisiteClassTab({ courseId, canEdit }: { courseId: string; canEdit: boolean }) {
  const [data, setData] = useState<PrereqClass | null>(null);
  const [trainerId, setTrainerId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [times, setTimes] = useState<Time[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [locations, setLocations] = useState<LocationRooms[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    let live = true;
    call("get", { courseId }).then((d) => {
      if (!live) return;
      setData(d); setTrainerId(d.class?.trainerId ?? ""); setRoomId(d.class?.roomId ?? ""); setTimes(d.times);
    }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The Prerequisite class did not load."); });
    rto<StaffOption[]>("staff_list").then((s) => { if (live) setStaff(s); }).catch(() => undefined);
    rtoFlow<LocationRooms[]>("locations_rooms").then((l) => { if (live) setLocations(l); }).catch(() => undefined);
    return () => { live = false; };
  }, [courseId]);

  const rooms = locations.flatMap((l) => l.rooms.filter((r) => r.isActive).map((r) => ({ id: r.id, label: `${l.name} · ${r.name}` })));
  const setTime = (i: number, patch: Partial<Time>) => setTimes((t) => t.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const bad = times.some((t) => !t.start || !t.end || t.end <= t.start);
  const dup = new Set(times.map((t) => `${t.weekday}|${t.start}`)).size < times.length;
  const save = async () => {
    setBusy(true); setError(""); setSaved("");
    try {
      const d = await call("save", { courseId, trainerId: trainerId || null, roomId: roomId || null, times });
      setData(d); setTimes(d.times); setSaved("Saved. The prerequisite classes are planned on these times for every student in this class.");
    } catch (e) { setError(e instanceof Error ? e.message : "Not saved."); }
    finally { setBusy(false); }
  };

  if (!data && !error) return <p className="text-sm text-foreground-500">Loading…</p>;
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-primary-200 bg-primary-50 p-3 text-sm text-foreground-800">
        A student who joins after a prerequisite unit has started is put in this class for the prerequisite units first, on their own dates
        from the day they join. When those are finished they join their intake&apos;s group at the next regular unit. Set the trainer, room and
        class times once; the classes are planned for every student in it.
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

      <section className="space-y-3 rounded-lg border border-background-200 p-4">
        <h3 className="font-heading text-base font-semibold text-foreground-950">Class setup</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">Trainer
            <Select className="mt-1" value={trainerId} disabled={!canEdit || busy} onChange={(e) => setTrainerId(e.target.value)}>
              <option value="">Choose a trainer</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select></label>
          <label className="text-sm font-medium">Room
            <Select className="mt-1" value={roomId} disabled={!canEdit || busy} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">Choose a room</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </Select></label>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Weekly class times</p>
          {times.length ? times.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select className="!w-auto" aria-label="Day" value={t.weekday} disabled={!canEdit || busy} onChange={(e) => setTime(i, { weekday: Number(e.target.value) })}>
                {DAYS.map((d, n) => <option key={d} value={n + 1}>{d}</option>)}
              </Select>
              <TextInput className="!w-28" type="time" aria-label="Starts" value={t.start} disabled={!canEdit || busy} onChange={(e) => setTime(i, { start: e.target.value })} />
              <span className="text-sm text-foreground-500">to</span>
              <TextInput className="!w-28" type="time" aria-label="Ends" value={t.end} disabled={!canEdit || busy} onChange={(e) => setTime(i, { end: e.target.value })} />
              <Select className="!w-auto" aria-label="Type" value={t.type} disabled={!canEdit || busy} onChange={(e) => setTime(i, { type: e.target.value as Time["type"] })}>
                <option value="theory">Theory</option><option value="practical">Practical</option><option value="assessment">Assessment</option>
              </Select>
              <Select className="!w-auto" aria-label="Room for this class" value={t.roomId ?? ""} disabled={!canEdit || busy} onChange={(e) => setTime(i, { roomId: e.target.value || null })}>
                <option value="">Class room</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </Select>
              {canEdit ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setTimes((x) => x.filter((_, n) => n !== i))}>Remove</Button> : null}
            </div>
          )) : <p className="text-sm text-foreground-500">No class times yet: no prerequisite classes are planned until you add them.</p>}
          {canEdit ? <Button size="sm" variant="outline" icon="ri-add-line" disabled={busy}
            onClick={() => setTimes((x) => [...x, { weekday: 1, start: "09:00", end: "13:00", type: "theory", roomId: null }])}>Add class time</Button> : null}
        </div>
        {canEdit ? <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy || bad || dup} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
          {bad ? <span className="text-sm text-red-700">Each class must end after it starts.</span> : null}
          {dup ? <span className="text-sm text-red-700">Two classes start on the same day at the same time: remove one.</span> : null}
          {saved ? <span className="text-sm text-green-700">{saved}</span> : null}
        </div> : <p className="text-sm text-foreground-500">Only an RTO Manager can change this class.</p>}
      </section>

      <section className="space-y-2">
        <h3 className="font-heading text-base font-semibold text-foreground-950">Students in this class ({data?.members.length ?? 0})</h3>
        {data?.members.length ? (
          <div className="overflow-x-auto rounded-lg border border-background-200">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead><tr className="bg-background-100 text-xs text-foreground-600">
                <th className="px-3 py-2">Student</th><th className="px-3 py-2">Intake</th><th className="px-3 py-2">Prerequisite units</th><th className="px-3 py-2">Back with the group</th>
              </tr></thead>
              <tbody>{data.members.map((m) => (
                <tr key={m.studentId} className="border-t border-background-200 align-top">
                  <td className="px-3 py-2"><Link to={`/admin/students/${m.studentId}`} className="font-medium text-primary-700 hover:underline">{m.name}</Link>
                    <span className="block text-xs text-foreground-500">{m.email}</span></td>
                  <td className="px-3 py-2">{m.intake ?? shortDate(m.intakeStart)}</td>
                  <td className="px-3 py-2">{m.units.map((u) => <span key={u.code + u.start} className="block"><b>{u.code}</b> {u.name}
                    <span className="text-xs text-foreground-500"> · {shortDate(u.start)} – {shortDate(u.end)}</span></span>)}</td>
                  <td className="px-3 py-2">{m.returnOn ? shortDate(m.returnOn) : "Next cycle"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="rounded-lg border border-dashed border-background-300 p-6 text-center text-sm text-foreground-500">No student needs prerequisites right now.</p>}
      </section>
    </div>
  );
}
