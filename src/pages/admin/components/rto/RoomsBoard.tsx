// Courses › Rooms: every room (by location) against the days of a week and morning / afternoon / evening, from the batches'
// class timing. Two batches in one room at the same time are red. An empty slot: put a batch there; a filled one opens the batch.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import { MoreMenu, SkeletonLines } from "@/pages/admin/components/rto/overlay";
import { RoomsManager } from "@/pages/admin/ClassroomsPage";
import {
  DAYS, SLOTS, WEEKDAYS, addDays, mondayOf, rtoFlow, shortDate, timeRange, todayIso, type BoardSession, type Clash, type RoomsBoardData, type Slot,
} from "@/pages/admin/lib/rto";

type Target = { roomId: string; room: string; weekday: number; slot: Slot };

export default function RoomsBoard({ canEdit }: { canEdit: boolean }) {
  const navigate = useNavigate();
  const { push } = useToast();
  const [week, setWeek] = useState(() => mondayOf(todayIso()));
  const [data, setData] = useState<RoomsBoardData | null>(null);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [manage, setManage] = useState(false);

  const load = useCallback(async () => {
    try { setData(await rtoFlow<RoomsBoardData>("rooms_board", { from: week, to: addDays(week, 6) })); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The rooms board did not load."); }
  }, [week]);
  useEffect(() => { setData(null); void load(); }, [load]);

  // Two classes clash: same room and weekday, overlapping times, and both batches run in overlapping dates.
  const clashing = useMemo(() => {
    const out = new Set<string>();
    const list = (data?.sessions ?? []).filter((s) => s.roomId);
    for (let a = 0; a < list.length; a++) for (let c = a + 1; c < list.length; c++) {
      const x = list[a], y = list[c];
      if (x.roomId === y.roomId && x.weekday === y.weekday && x.batchId !== y.batchId && x.startTime < y.endTime && y.startTime < x.endTime
        && x.batchStart <= y.batchEnd && y.batchStart <= x.batchEnd) { out.add(x.id); out.add(y.id); }
    }
    return out;
  }, [data]);
  const days = useMemo(() => [1, 2, 3, 4, 5, 6, 7].filter((d) => d <= 5 || (data?.sessions ?? []).some((s) => s.weekday === d)), [data]);
  const cell = (roomId: string, weekday: number, slot: Slot) => (data?.sessions ?? []).filter((s) => s.roomId === roomId && s.weekday === weekday && s.slot === slot);
  const noRoom = (data?.sessions ?? []).filter((s) => !s.roomId);

  const assign = async (batchId: string) => {
    if (!target) return;
    const t = target; setTarget(null);
    try {
      const out = await rtoFlow<{ sessionId: string; clashes: Clash[] }>("session_add", { batchId, weekday: t.weekday, slot: t.slot, roomId: t.roomId });
      const b = data?.batches.find((x) => x.id === batchId);
      const label = `${b?.courseCode ?? ""} ${b?.name ?? "The batch"}`.trim();
      push(`${label} now uses ${t.room} on ${WEEKDAYS[t.weekday - 1]} ${t.slot}${out.clashes.length ? " (the room is double-booked)" : ""}.`, out.clashes.length ? "info" : "success", {
        label: "Undo", onClick: () => { rtoFlow("session_delete", { sessionId: out.sessionId }).then(() => void load()).catch(() => undefined); },
      });
      void load();
    } catch (e) { push(e instanceof Error ? e.message : "Not saved.", "error"); }
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-md border border-background-300 bg-background-50">
          <button type="button" aria-label="Previous week" className="px-2.5 py-1.5 text-foreground-600 hover:bg-background-100" onClick={() => setWeek((w) => addDays(w, -7))}><i className="ri-arrow-left-s-line" aria-hidden="true" /></button>
          <span className="px-2 text-sm font-medium tabular-nums text-foreground-900">Week of {shortDate(week)}</span>
          <button type="button" aria-label="Next week" className="px-2.5 py-1.5 text-foreground-600 hover:bg-background-100" onClick={() => setWeek((w) => addDays(w, 7))}><i className="ri-arrow-right-s-line" aria-hidden="true" /></button>
        </div>
        <TextInput type="date" aria-label="Go to a date" className="w-40" value={week} onChange={(e) => { if (e.target.value) setWeek(mondayOf(e.target.value)); }} />
        {week !== mondayOf(todayIso()) ? <Button size="sm" variant="ghost" onClick={() => setWeek(mondayOf(todayIso()))}>This week</Button> : null}
        <span className="ml-auto flex items-center gap-3 text-xs text-foreground-600">
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-red-300 bg-red-100" />Double-booked</span>
          {canEdit ? <MoreMenu label="Rooms options" items={[{ label: "Manage rooms…", icon: "ri-building-line", onClick: () => setManage(true) }]} /> : null}
        </span>
      </div>
      <p className="text-sm text-foreground-600">Each room’s classes this week. {canEdit ? "Click an empty slot to put a batch there; click a batch to open it." : "Click a batch to open it."}</p>
      <ErrorNote text={error} />
      {!data ? <SkeletonLines lines={8} /> : (
        <div className="max-w-full overflow-x-auto rounded-card border border-background-200 bg-background-50">
          <table className="w-max min-w-full border-collapse text-xs">
            <thead>
              <tr>
                <th rowSpan={2} className="sticky left-0 z-10 min-w-[9rem] border-b border-r border-background-200 bg-background-50 px-3 py-2 text-left font-medium text-foreground-500">Room</th>
                {days.map((d) => <th key={d} colSpan={3} className="border-b border-l border-background-200 px-2 py-1.5 text-center font-semibold text-foreground-800">{DAYS[d - 1]} <span className="font-normal text-foreground-500">{shortDate(addDays(week, d - 1)).replace(/ \d{4}$/, "")}</span></th>)}
              </tr>
              <tr>
                {days.map((d) => SLOTS.map((s, x) => <th key={`${d}${s.id}`} className={`border-b border-background-200 px-1 py-1 text-center font-normal text-foreground-500 ${x === 0 ? "border-l" : ""}`}>{s.label.slice(0, 3)}</th>))}
              </tr>
            </thead>
            <tbody>
              {data.locations.map((l) => (
                <LocationRows key={l.id ?? "other"} name={l.name} rooms={l.rooms.filter((r) => r.isActive)} days={days} cell={cell} clashing={clashing} canEdit={canEdit}
                  onOpen={(s) => navigate(`/admin/batches/${s.batchId}`)} onEmpty={(t) => setTarget(t)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.sessions.length === 0 ? <p className="text-sm text-foreground-500">No batch has classes in a room this week.</p> : null}
      {noRoom.length ? (
        <p className="text-sm text-amber-800"><i className="ri-error-warning-line mr-1" aria-hidden="true" />Classes without a room this week: {[...new Set(noRoom.map((s) => `${s.courseCode} ${s.batch} (${DAYS[s.weekday - 1]} ${timeRange(s.startTime, s.endTime)})`))].join(", ")}.</p>
      ) : null}

      {target && data ? <AssignDrawer target={target} batches={data.batches} onClose={() => setTarget(null)} onPick={(id) => void assign(id)} /> : null}
      {manage ? <Drawer open width="max-w-2xl" title="Rooms" onClose={() => { setManage(false); void load(); }}><RoomsManager /></Drawer> : null}
    </div>
  );
}

function LocationRows({ name, rooms, days, cell, clashing, canEdit, onOpen, onEmpty }: {
  name: string; rooms: { id: string; name: string }[]; days: number[]; cell: (roomId: string, weekday: number, slot: Slot) => BoardSession[]; clashing: Set<string>;
  canEdit: boolean; onOpen: (s: BoardSession) => void; onEmpty: (t: Target) => void;
}) {
  if (!rooms.length) return null;
  return (
    <>
      <tr><td colSpan={1 + days.length * 3} className="sticky left-0 border-b border-background-200 bg-background-100 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-foreground-600">{name}</td></tr>
      {rooms.map((r) => (
        <tr key={r.id}>
          <th scope="row" className="sticky left-0 z-10 border-b border-r border-background-200 bg-background-50 px-3 py-1.5 text-left font-medium text-foreground-900">{r.name}</th>
          {days.map((d) => SLOTS.map((s, x) => {
            const list = cell(r.id, d, s.id);
            const red = list.some((c) => clashing.has(c.id));
            return (
              <td key={`${d}${s.id}`} className={`h-12 min-w-[5.5rem] border-b border-background-200 p-0.5 align-top ${x === 0 ? "border-l" : ""} ${red ? "bg-red-50" : ""}`}>
                {list.length ? (
                  <div className="space-y-0.5">
                    {list.map((c) => (
                      <button key={c.id} type="button" onClick={() => onOpen(c)} title={`${c.courseCode} ${c.batch} · ${c.intakeName} · ${timeRange(c.startTime, c.endTime)}${c.trainers.length ? ` · ${c.trainers.join(", ")}` : ""}`}
                        className={`block w-full truncate rounded px-1.5 py-1 text-left font-medium transition-colors duration-150 ${clashing.has(c.id) ? "border border-red-300 bg-red-100 text-red-900 hover:bg-red-200" : c.type === "practical" ? "bg-accent-100 text-accent-900 hover:bg-accent-200" : c.type === "assessment" ? "bg-secondary-100 text-secondary-900 hover:bg-secondary-200" : "bg-primary-50 text-primary-900 hover:bg-primary-100"}`}>
                        {c.courseCode} {c.batch}<span className="block text-2xs font-normal opacity-80">{timeRange(c.startTime, c.endTime)}</span>
                      </button>
                    ))}
                  </div>
                ) : canEdit ? (
                  <button type="button" aria-label={`Put a batch in ${r.name} on ${WEEKDAYS[d - 1]} ${s.label.toLowerCase()}`} onClick={() => onEmpty({ roomId: r.id, room: r.name, weekday: d, slot: s.id })}
                    className="flex h-full min-h-[2.75rem] w-full items-center justify-center rounded text-foreground-300 opacity-0 transition-opacity duration-150 hover:bg-background-100 hover:text-primary-600 hover:opacity-100 focus-visible:opacity-100">
                    <i className="ri-add-line text-base" aria-hidden="true" />
                  </button>
                ) : null}
              </td>
            );
          }))}
        </tr>
      ))}
    </>
  );
}

function AssignDrawer({ target, batches, onClose, onPick }: { target: Target; batches: RoomsBoardData["batches"]; onClose: () => void; onPick: (batchId: string) => void }) {
  const [q, setQ] = useState("");
  const slot = SLOTS.find((s) => s.id === target.slot);
  const shown = batches.filter((b) => !q.trim() || `${b.courseCode} ${b.name} ${b.intakeName}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Drawer open title={`${target.room} · ${WEEKDAYS[target.weekday - 1]} ${slot?.label.toLowerCase()}`} onClose={onClose}>
      <p className="text-sm text-foreground-600">Choose the batch that meets here. Its class runs {timeRange(slot?.start, slot?.end)}; change the time on the batch’s page.</p>
      <TextInput autoFocus placeholder="Search course or batch" aria-label="Search batches" value={q} onChange={(e) => setQ(e.target.value)} />
      {shown.length === 0 ? <p className="text-sm text-foreground-500">No batch runs this week{q ? " with that name" : ""}.</p> : (
        <div className="divide-y divide-background-200 rounded-md border border-background-200">
          {shown.map((b) => (
            <button key={b.id} type="button" onClick={() => onPick(b.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-background-100">
              <span className="font-medium text-foreground-900">{b.courseCode} {b.name}</span><span className="truncate text-xs text-foreground-500">{b.intakeName}</span>
            </button>
          ))}
        </div>
      )}
    </Drawer>
  );
}
