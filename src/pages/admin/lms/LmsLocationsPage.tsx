import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { rto } from "@/pages/admin/lib/rto";

interface Room { id: string; name: string; capacity: number | null; isActive: boolean; locationId: string | null }
interface Location { id: string; name: string; address: string | null; kind: "theory" | "practical"; isActive: boolean; rooms: Room[] }
type LocDraft = { id: string | null; name: string; address: string; kind: "theory" | "practical"; isActive: boolean };
type RoomDraft = { id: string | null; name: string; capacity: string; isActive: boolean; locationId: string | null };

const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const field = "mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";

/** Class locations and their rooms: the room lists in class timing, templates and the course calendar come from here. */
export default function LmsLocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loose, setLoose] = useState<Room[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loc, setLoc] = useState<LocDraft | null>(null);
  const [room, setRoom] = useState<RoomDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [l, r] = await Promise.all([
      supabase.from("locations").select("id, name, address, kind, is_active, sort").order("sort").order("name"),
      supabase.from("classrooms").select("id, name, capacity, is_active, location_id, sort").order("sort").order("name"),
    ]);
    if (l.error) throw new Error(l.error.message);
    if (r.error) throw new Error(r.error.message);
    const rooms: Room[] = (r.data ?? []).map((x: { id: string; name: string; capacity: number | null; is_active: boolean; location_id: string | null }) =>
      ({ id: x.id, name: x.name, capacity: x.capacity, isActive: x.is_active, locationId: x.location_id }));
    const locs: Location[] = (l.data ?? []).map((x: { id: string; name: string; address: string | null; kind: "theory" | "practical"; is_active: boolean }) =>
      ({ id: x.id, name: x.name, address: x.address, kind: x.kind, isActive: x.is_active, rooms: rooms.filter(rm => rm.locationId === x.id) }));
    setLocations(locs);
    setLoose(rooms.filter(rm => !rm.locationId || !locs.some(x => x.id === rm.locationId)));
  }, []);
  useEffect(() => {
    Promise.all([load(), rto<{ rtoManager: boolean }>("me").then(me => setCanEdit(me.rtoManager))])
      .catch(e => setError(e instanceof Error ? e.message : "Unable to load locations"))
      .finally(() => setLoading(false));
  }, [load]);

  const run = async (work: () => PromiseLike<{ error: { message: string } | null }>, message: string, after?: () => void) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const { error: e } = await work();
      if (e) throw new Error(/duplicate|unique/i.test(e.message) ? "That name is already used." : e.message);
      await load(); setNotice(message); after?.();
    } catch (e) { setError(e instanceof Error ? e.message : "Not saved."); }
    finally { setBusy(false); }
  };
  const saveLocation = () => {
    if (!loc || !loc.name.trim()) return;
    const values = { name: loc.name.trim(), address: loc.address.trim() || null, kind: loc.kind, is_active: loc.isActive };
    void run(() => loc.id ? supabase.from("locations").update(values).eq("id", loc.id) : supabase.from("locations").insert(values),
      `${values.name} saved.`, () => setLoc(null));
  };
  const deleteLocation = (l: Location) => {
    if (!window.confirm(`Delete the location ${l.name}? Its ${l.rooms.length} room(s) stay and move to "Rooms without a location".`)) return;
    void run(() => supabase.from("locations").delete().eq("id", l.id), `${l.name} deleted.`);
  };
  const saveRoom = () => {
    if (!room || !room.name.trim()) return;
    const cap = room.capacity.trim() ? Number(room.capacity) : null;
    if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 10000)) { setError("Places must be a whole number from 1 to 10000."); return; }
    const values = { name: room.name.trim(), capacity: cap, is_active: room.isActive, location_id: room.locationId };
    void run(() => room.id ? supabase.from("classrooms").update(values).eq("id", room.id) : supabase.from("classrooms").insert(values),
      `${values.name} saved.`, () => setRoom(null));
  };
  const deleteRoom = (r: Room) => {
    if (!window.confirm(`Delete the room ${r.name}? Classes booked in it will show "No room". To keep them, untick Active instead.`)) return;
    void run(() => supabase.from("classrooms").delete().eq("id", r.id), `${r.name} deleted.`);
  };

  const roomList = (rooms: Room[], locationId: string | null) => <div className="mt-3">
    {!rooms.length ? <p className="text-sm text-foreground-500">No rooms yet.</p> : <ul className="divide-y divide-background-100 rounded-lg border border-background-200">
      {rooms.map(r => <li key={r.id} className={"flex flex-wrap items-center gap-3 px-3 py-2 text-sm " + (r.isActive ? "" : "text-foreground-400")}>
        <i className="ri-door-open-line text-foreground-500" aria-hidden="true" />
        <span className="flex-1 font-semibold">{r.name}{!r.isActive && <span className="ml-2 rounded-full bg-background-200 px-2 py-0.5 text-xs font-medium">Inactive</span>}</span>
        <span className="text-xs text-foreground-500">{r.capacity ? `${r.capacity} places` : "No limit set"}</span>
        {canEdit && <span className="flex gap-3">
          <button type="button" disabled={busy} onClick={() => { setNotice(""); setRoom({ id: r.id, name: r.name, capacity: r.capacity ? String(r.capacity) : "", isActive: r.isActive, locationId: r.locationId }); }} className="text-xs font-semibold text-primary-700 hover:underline">Edit</button>
          <button type="button" disabled={busy} onClick={() => deleteRoom(r)} className="text-xs font-semibold text-red-700 hover:underline">Delete</button>
        </span>}
      </li>)}
    </ul>}
    {canEdit && <button type="button" onClick={() => { setNotice(""); setRoom({ id: null, name: "", capacity: "", isActive: true, locationId }); }}
      className="mt-2 inline-flex items-center gap-1 rounded-lg border-2 border-dashed border-primary-200 px-3 py-1.5 text-sm font-semibold text-primary-700 hover:border-primary-500 hover:bg-primary-50">
      <i className="ri-add-line" aria-hidden="true" />Add room</button>}
  </div>;

  return <div className="mx-auto max-w-5xl space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Locations &amp; rooms</h1>
        <p className="text-sm text-foreground-600">Where classes are held. The room lists in class timing, templates and the course calendar come from here.</p>
      </div>
      {canEdit && <button type="button" onClick={() => { setNotice(""); setLoc({ id: null, name: "", address: "", kind: "theory", isActive: true }); }}
        className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-5 py-3 text-base font-semibold text-white shadow-sm hover:bg-primary-700">
        <i className="ri-add-line text-lg" aria-hidden="true" />Add location</button>}
    </header>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
    {loading ? <p className="py-10 text-center text-sm text-foreground-500">Loading…</p> : <>
      {!locations.length && <p className={card + " p-6 text-center text-sm text-foreground-500"}>No locations yet.</p>}
      {locations.map(l => <section key={l.id} className={card + " p-5 " + (l.isActive ? "" : "opacity-60")}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-lg font-bold text-foreground-950">{l.name}
              <span className="ml-2 rounded-full bg-background-200 px-2 py-0.5 text-xs font-medium capitalize text-foreground-700">{l.kind}</span>
              {!l.isActive && <span className="ml-2 rounded-full bg-background-200 px-2 py-0.5 text-xs font-medium text-foreground-600">Inactive</span>}</h2>
            <p className="text-sm text-foreground-600"><i className="ri-map-pin-line mr-1" aria-hidden="true" />{l.address || "No address"}</p>
          </div>
          {canEdit && <div className="flex gap-2">
            <button type="button" onClick={() => { setNotice(""); setLoc({ id: l.id, name: l.name, address: l.address ?? "", kind: l.kind, isActive: l.isActive }); }} className="inline-flex items-center gap-1 rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100"><i className="ri-pencil-line" aria-hidden="true" />Edit</button>
            <button type="button" disabled={busy} onClick={() => deleteLocation(l)} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50"><i className="ri-delete-bin-line" aria-hidden="true" />Delete</button>
          </div>}
        </div>
        {roomList(l.rooms, l.id)}
      </section>)}
      {loose.length > 0 && <section className={card + " p-5"}>
        <h2 className="font-heading text-lg font-bold text-foreground-950">Rooms without a location</h2>
        <p className="text-sm text-foreground-600">Edit a room to put it in a location.</p>
        {roomList(loose, null)}
      </section>}
    </>}

    {(loc || room) && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { setLoc(null); setRoom(null); }}>
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl bg-background-50 p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        {loc ? <>
          <h3 className="font-heading text-lg font-bold text-foreground-950">{loc.id ? "Edit location" : "Add location"}</h3>
          <div className="mt-3 space-y-3">
            <label className="block text-xs font-semibold text-foreground-700">Name<input autoFocus maxLength={120} className={field} value={loc.name} placeholder="e.g. Level 8, 123 Example St" onChange={e => setLoc({ ...loc, name: e.target.value })} /></label>
            <label className="block text-xs font-semibold text-foreground-700">Address<input maxLength={300} className={field} value={loc.address} onChange={e => setLoc({ ...loc, address: e.target.value })} /></label>
            <label className="block text-xs font-semibold text-foreground-700">Used for
              <select className={field} value={loc.kind} onChange={e => setLoc({ ...loc, kind: e.target.value as LocDraft["kind"] })}>
                <option value="theory">Theory classes</option><option value="practical">Practical classes (workshop)</option>
              </select></label>
            <label className="flex items-center gap-2 text-sm text-foreground-800"><input type="checkbox" checked={loc.isActive} onChange={e => setLoc({ ...loc, isActive: e.target.checked })} />Active (shown in room lists)</label>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setLoc(null)} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold hover:bg-background-100">Cancel</button>
            <button type="button" disabled={busy || !loc.name.trim()} onClick={saveLocation} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving…" : "Save location"}</button>
          </div>
        </> : room ? <>
          <h3 className="font-heading text-lg font-bold text-foreground-950">{room.id ? "Edit room" : "Add room"}</h3>
          <div className="mt-3 space-y-3">
            <label className="block text-xs font-semibold text-foreground-700">Room name<input autoFocus maxLength={120} className={field} value={room.name} placeholder="e.g. Room 8.1" onChange={e => setRoom({ ...room, name: e.target.value })} /></label>
            <label className="block text-xs font-semibold text-foreground-700">Places<input inputMode="numeric" className={field} value={room.capacity} placeholder="e.g. 25" onChange={e => setRoom({ ...room, capacity: e.target.value.replace(/\D/g, "") })} /></label>
            <label className="block text-xs font-semibold text-foreground-700">Location
              <select className={field} value={room.locationId ?? ""} onChange={e => setRoom({ ...room, locationId: e.target.value || null })}>
                <option value="">No location</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></label>
            <label className="flex items-center gap-2 text-sm text-foreground-800"><input type="checkbox" checked={room.isActive} onChange={e => setRoom({ ...room, isActive: e.target.checked })} />Active (can be booked)</label>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setRoom(null)} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold hover:bg-background-100">Cancel</button>
            <button type="button" disabled={busy || !room.name.trim()} onClick={saveRoom} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving…" : "Save room"}</button>
          </div>
        </> : null}
      </div>
    </div>}
  </div>;
}
