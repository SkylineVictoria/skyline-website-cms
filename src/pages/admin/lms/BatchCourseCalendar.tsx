import { useEffect, useMemo, useState } from "react";
import { addDays, generateClassSessions, listBreaks, loadClassSessions, rtoFlow, shortDate, updateClassSession, type AcademicBreak, type ClassSession, type LocationRooms } from "@/pages/admin/lib/rto";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const parse = (s: string) => new Date(s + "T00:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (s: string) => s.slice(0, 7);
const tone: Record<string, string> = { theory: "bg-sky-50 ring-sky-200", practical: "bg-amber-50 ring-amber-200", assessment: "bg-emerald-50 ring-emerald-200" };

/**
 * The batch's whole course, month by month from the intake start: every class with its time, unit, room and trainer.
 * Term-break days are greyed out. Classes come from the saved class timing (generated when the timing is saved).
 */
export default function BatchCourseCalendar({ batchId, intakeStart, intakeEnd, hasSlots, canManage, reloadKey }: {
  batchId: string; intakeStart: string; intakeEnd: string | null; hasSlots: boolean; canManage: boolean; reloadKey: number;
}) {
  const [rows, setRows] = useState<ClassSession[]>([]);
  const [breaks, setBreaks] = useState<AcademicBreak[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ClassSession | null>(null);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState("");

  useEffect(() => { listBreaks().then(setBreaks).catch(() => undefined); }, []);
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    // The list is read 400 days at a time, from the intake start to a few months past its end.
    const until = addDays(intakeEnd && intakeEnd > intakeStart ? intakeEnd : addDays(intakeStart, 365), 180);
    const read = async () => {
      const all: ClassSession[] = [];
      for (let from = intakeStart; from <= until; from = addDays(from, 400)) {
        const to = addDays(from, 399) < until ? addDays(from, 399) : until;
        all.push(...await loadClassSessions(batchId, from, to));
      }
      return all;
    };
    (async () => {
      let list = await read();
      // Timing saved before classes were generated automatically: generate them once.
      if (!list.length && hasSlots && canManage) { await generateClassSessions(batchId).catch(() => null); list = await read(); }
      if (live) setRows(list);
    })().catch(e => { if (live) setError(e instanceof Error ? e.message : "Unable to load the classes."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [batchId, intakeStart, intakeEnd, hasSlots, canManage, reloadKey, version]);

  const byDate = useMemo(() => {
    const m = new Map<string, ClassSession[]>();
    for (const s of rows) m.set(s.date, [...(m.get(s.date) ?? []), s].sort((a, b) => a.startTime.localeCompare(b.startTime)));
    return m;
  }, [rows]);
  const scheduled = rows.filter(r => r.status === "scheduled");
  const last = scheduled.length ? scheduled[scheduled.length - 1].date : null;
  const lastShown = [last, intakeEnd].filter(Boolean).sort().pop() ?? intakeStart;
  const months = useMemo(() => {
    const out: string[] = [];
    for (let d = parse(monthKey(intakeStart) + "-01"); iso(d) <= lastShown; d.setUTCMonth(d.getUTCMonth() + 1)) out.push(iso(d));
    return out;
  }, [intakeStart, lastShown]);
  const hours = scheduled.reduce((t, s) => { const [a, b] = [s.startTime, s.endTime].map(x => { const [h, m] = x.split(":").map(Number); return h * 60 + m; }); return t + (b - a) / 60; }, 0);
  const breakOf = (d: string) => breaks.find(b => d >= b.startDate && d <= b.endDate);

  return <section className="rounded-2xl border border-background-200 bg-background-50 p-5 shadow-sm print:border-0 print:shadow-none">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-heading text-lg font-bold text-foreground-950">Course calendar</h2>
        <p className="text-sm text-foreground-600">From {shortDate(intakeStart)}{last ? ` to the last class on ${shortDate(last)}` : ""}{intakeEnd ? ` · intake ends ${shortDate(intakeEnd)}` : ""}
          {scheduled.length ? ` · ${scheduled.length} classes · ${Math.round(hours)} hours` : ""}</p>
      </div>
      <button type="button" onClick={() => window.print()} className="rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100 print:hidden">Print</button>
    </div>
    {notice && <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
    {canManage && rows.length > 0 && <p className="mt-2 text-xs text-foreground-500 print:hidden">Click a class to change its date, time or room, or to cancel it. Changed classes stay as you set them when the timing is saved again.</p>}
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    {loading ? <p className="py-10 text-center text-sm text-foreground-500">Loading the course calendar…</p>
    : !rows.length ? <p className="py-10 text-center text-sm text-foreground-500">{hasSlots ? "No classes yet. Open Edit class timing and click Save timing to fill the calendar." : "Set the class timing to fill the calendar."}</p>
    : <div className="mt-4 space-y-6">
      <div className="flex flex-wrap gap-3 text-xs text-foreground-600">
        {(["theory", "practical", "assessment"] as const).map(t => <span key={t} className="inline-flex items-center gap-1 capitalize"><span className={`inline-block h-3 w-3 rounded ring-1 ${tone[t]}`} />{t}</span>)}
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-background-200" />Term break</span>
      </div>
      {months.map(m => {
        const first = parse(m);
        const lead = (first.getUTCDay() + 6) % 7;
        const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
        const cells = Array.from({ length: Math.ceil((lead + count) / 7) * 7 }, (_, i) => { const n = i - lead; return n < 0 || n >= count ? null : addDays(m, n); });
        return <div key={m} className="break-inside-avoid">
          <h3 className="mb-2 font-heading text-base font-bold text-foreground-900">{first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</h3>
          <div className="overflow-x-auto"><div className="grid min-w-[900px] grid-cols-7 border-l border-t border-background-200 text-xs">
            {DAY_NAMES.map(d => <div key={d} className="border-b border-r border-background-200 bg-background-100 px-2 py-1 text-center font-semibold uppercase text-foreground-500">{d}</div>)}
            {cells.map((d, i) => {
              if (!d) return <div key={i} className="border-b border-r border-background-200 bg-background-100/40" />;
              const brk = breakOf(d);
              const outside = d < intakeStart;
              return <div key={d} className={`min-h-24 border-b border-r border-background-200 p-1 ${brk ? "bg-background-200/70" : outside ? "bg-background-100/40" : ""}`}>
                <div className="flex items-center justify-between"><span className={`font-semibold ${outside ? "text-foreground-300" : "text-foreground-700"}`}>{Number(d.slice(8))}</span>
                  {brk && <span className="truncate pl-1 text-[10px] text-foreground-500" title={brk.label}>{brk.label}</span>}</div>
                <div className="mt-1 space-y-1">{(byDate.get(d) ?? []).map(s => <button type="button" key={s.id} title={`${s.unitCode ?? ""} ${s.unitName ?? ""}${canManage ? " · click to change" : ""}`}
                  disabled={!canManage} onClick={() => { setNotice(""); setEditing(s); }}
                  className={`block w-full rounded px-1.5 py-1 text-left ring-1 ${tone[s.type] ?? ""} ${canManage ? "cursor-pointer hover:ring-2 hover:ring-primary-500" : "cursor-default"} ${s.status === "cancelled" ? "line-through opacity-50" : ""}`}>
                  <strong className="block">{s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)} {s.unitCode ?? ""}</strong>
                  <span className="block truncate"><i className="ri-door-open-line mr-0.5" aria-hidden="true" />{s.room ?? "No room"}</span>
                  <span className="block truncate"><i className="ri-user-line mr-0.5" aria-hidden="true" />{s.trainers || "No trainer"}</span>
                  {s.manual && <span className="block text-[10px] font-semibold text-primary-700">Changed</span>}
                </button>)}</div>
              </div>;
            })}
          </div></div>
        </div>;
      })}
    </div>}
    {editing && <ClassEditor session={editing} breaks={breaks} onClose={() => setEditing(null)}
      onSaved={msg => { setEditing(null); setNotice(msg); setVersion(v => v + 1); }} />}
  </section>;
}

/** Change one dated class: its date, time or room, or cancel / restore it. */
function ClassEditor({ session, breaks, onClose, onSaved }: { session: ClassSession; breaks: AcademicBreak[]; onClose: () => void; onSaved: (message: string) => void }) {
  const [date, setDate] = useState(session.date);
  const [start, setStart] = useState(session.startTime.slice(0, 5));
  const [end, setEnd] = useState(session.endTime.slice(0, 5));
  const [roomId, setRoomId] = useState(session.roomId ?? "");
  const [locations, setLocations] = useState<LocationRooms[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { rtoFlow<LocationRooms[]>("locations_rooms").then(setLocations).catch(() => undefined); }, []);
  const inBreak = breaks.find(b => date >= b.startDate && date <= b.endDate);
  const bad = !date || !start || !end || end <= start;
  const run = async (change: Parameters<typeof updateClassSession>[1], message: string) => {
    setBusy(true); setError("");
    try {
      const out = await updateClassSession(session.id, change);
      const clash = out.clashes.find(c => c.date === (change.date ?? session.date));
      onSaved(message + (clash ? ` Note: ${clash.room} is also booked by ${clash.otherBatch} at that time.` : ""));
    } catch (e) {
      const m = e instanceof Error ? e.message : "The class was not changed.";
      setError(/duplicate|unique/i.test(m) ? "This batch already has a class starting at that date and time." : m);
    } finally { setBusy(false); }
  };
  const field = "mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:hidden" onClick={onClose}>
    <div role="dialog" aria-modal="true" aria-label="Change class" className="w-full max-w-md rounded-2xl bg-background-50 p-5 shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{session.type} class</p>
          <h3 className="font-heading text-lg font-bold text-foreground-950">{session.unitCode ?? "Class"} <span className="text-sm font-normal text-foreground-600">{session.unitName ?? ""}</span></h3>
          <p className="text-xs text-foreground-500"><i className="ri-user-line mr-1" aria-hidden="true" />{session.trainers || "No trainer"}</p>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 text-foreground-600 hover:bg-background-100"><i className="ri-close-line text-lg" aria-hidden="true" /></button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="block text-xs font-semibold text-foreground-700 sm:col-span-3">Date<input type="date" className={field} value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="block text-xs font-semibold text-foreground-700">Starts<input type="time" className={field} value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="block text-xs font-semibold text-foreground-700">Ends<input type="time" className={field} value={end} onChange={e => setEnd(e.target.value)} /></label>
        <label className="block text-xs font-semibold text-foreground-700 sm:col-span-3">Room
          <select className={field} value={roomId} onChange={e => setRoomId(e.target.value)}>
            <option value="">No room</option>
            {locations.map(l => <optgroup key={l.id ?? "other"} label={l.name}>{l.rooms.filter(r => r.isActive || r.id === roomId).map(r => <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` (${r.capacity})` : ""}</option>)}</optgroup>)}
          </select></label>
      </div>
      {end <= start && <p className="mt-2 text-sm text-red-700">The class must end after it starts.</p>}
      {inBreak && <p className="mt-2 text-sm text-amber-800"><i className="ri-error-warning-line mr-1" aria-hidden="true" />{shortDate(date)} is in the {inBreak.label}.</p>}
      {error && <p role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        {session.status === "cancelled"
          ? <button type="button" disabled={busy} onClick={() => void run({ status: "scheduled" }, "Class restored.")} className="rounded-lg border border-emerald-300 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50">Restore class</button>
          : <button type="button" disabled={busy} onClick={() => { if (window.confirm("Cancel this class?")) void run({ status: "cancelled" }, "Class cancelled."); }} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">Cancel class</button>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold hover:bg-background-100">Close</button>
          <button type="button" disabled={busy || bad} onClick={() => void run({ date, startTime: start, endTime: end, roomId: roomId || null }, "Class changed.")}
            className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  </div>;
}
