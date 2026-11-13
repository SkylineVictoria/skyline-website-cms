import { useCallback, useEffect, useState } from "react";
import { Button, Card, PageHeader, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { ErrorNote, ReadOnlyNote } from "@/pages/admin/components/rto/shared";
import { SkeletonLines } from "@/pages/admin/components/rto/overlay";
import { rto, rtoFlow, type LocationRooms, type Room } from "@/pages/admin/lib/rto";

/** Master Data › Rooms (also opened from Courses › Rooms): the rooms batches meet in, by location. RTO Managers edit; others view. */
export default function ClassroomsPage() {
  return (
    <div>
      <PageHeader title="Rooms" description="The rooms batches meet in, by location. A batch picks its rooms in its class timing." />
      <RoomsManager />
    </div>
  );
}

/** Rooms by location: rename, seats and active save when you leave the field; "+ Add room" per location. */
export function RoomsManager() {
  const { push } = useToast();
  const [locations, setLocations] = useState<LocationRooms[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState<{ locationId: string | null; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, me] = await Promise.all([rtoFlow<LocationRooms[]>("locations_rooms"), rto<{ rtoManager: boolean }>("me")]);
      setLocations(l); setCanEdit(me.rtoManager); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Rooms did not load."); setLocations((x) => x ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (room: Room, patch: Partial<{ name: string; capacity: string; isActive: boolean }>, message: string) => {
    try { setLocations(await rtoFlow<LocationRooms[]>("room_save", { id: room.id, ...patch })); push(message); }
    catch (e) { push(e instanceof Error ? e.message : "Not saved.", "error"); void load(); }
  };
  const add = async () => {
    if (!adding?.name.trim()) return;
    try { setLocations(await rtoFlow<LocationRooms[]>("room_save", { name: adding.name, locationId: adding.locationId })); push(`${adding.name.trim()} added.`); setAdding(null); }
    catch (e) { push(e instanceof Error ? e.message : "Not added.", "error"); }
  };

  if (!locations) return <SkeletonLines lines={6} />;
  return (
    <div className="space-y-3">
      <ErrorNote text={error} />
      {!canEdit ? <ReadOnlyNote>Only an RTO Manager can add or change rooms.</ReadOnlyNote> : null}
      {locations.map((l) => (
        <Card key={l.id ?? "other"} className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-background-200 px-4 py-2.5">
            <div className="min-w-0"><p className="font-heading font-semibold text-foreground-950">{l.name}</p>{l.address ? <p className="text-xs text-foreground-500">{l.address}</p> : null}</div>
            {canEdit && l.id ? <Button size="sm" variant="outline" icon="ri-add-line" onClick={() => setAdding({ locationId: l.id, name: "" })}>Add room</Button> : null}
          </div>
          <div className="divide-y divide-background-100">
            {l.rooms.map((r) => <RoomRow key={r.id} room={r} canEdit={canEdit} onSave={(patch, message) => void save(r, patch, message)} />)}
            {adding && adding.locationId === l.id ? (
              <div className="flex flex-wrap items-center gap-2 px-4 py-2">
                <TextInput autoFocus className="w-56" placeholder="Room name, e.g. Room 8.5" aria-label="New room name" value={adding.name}
                  onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void add(); if (e.key === "Escape") setAdding(null); }} />
                <Button size="sm" disabled={!adding.name.trim()} onClick={() => void add()}>Add</Button>
                <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
              </div>
            ) : null}
            {l.rooms.length === 0 && !(adding && adding.locationId === l.id) ? <p className="px-4 py-3 text-sm text-foreground-500">No rooms yet.</p> : null}
          </div>
        </Card>
      ))}
    </div>
  );
}

function RoomRow({ room, canEdit, onSave }: { room: Room; canEdit: boolean; onSave: (patch: Partial<{ name: string; capacity: string; isActive: boolean }>, message: string) => void }) {
  const [name, setName] = useState(room.name);
  const [capacity, setCapacity] = useState(room.capacity ? String(room.capacity) : "");
  useEffect(() => { setName(room.name); setCapacity(room.capacity ? String(room.capacity) : ""); }, [room.name, room.capacity]);
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_6rem_auto] items-center gap-2 px-4 py-2 ${room.isActive ? "" : "opacity-60"}`}>
      <TextInput disabled={!canEdit} aria-label="Room name" value={name} onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name.trim() && name.trim() !== room.name) onSave({ name }, `${room.name} renamed to ${name.trim()}.`); else setName(room.name); }} />
      <TextInput disabled={!canEdit} aria-label="Seats" inputMode="numeric" placeholder="Seats" value={capacity} onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ""))}
        onBlur={() => { if (capacity !== (room.capacity ? String(room.capacity) : "")) onSave({ capacity }, `${room.name}: ${capacity || "no"} seats.`); }} />
      <Toggle disabled={!canEdit} checked={room.isActive} onChange={(v) => onSave({ isActive: v }, `${room.name} ${v ? "in use" : "not in use"}.`)} />
    </div>
  );
}
