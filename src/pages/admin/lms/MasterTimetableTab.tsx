// Master timetable of a course (LMS > Courses > a course > Master timetable): one start date gives every unit its start
// and end date, in whole 7-day weeks, one unit after another, with term breaks left out. Staff change a unit's weeks, move
// units up and down and add term breaks; the server (public.rto_master_timetable) calculates the dates and refuses an
// order that puts a unit before one it needs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { shortDate } from "@/pages/admin/lib/rto";

interface Row {
  unitId: string; code: string; name: string; unitType: string; hours: number | null; weeks: number;
  startDate: string | null; endDate: string | null; prerequisites: string[]; inMaster: boolean;
}
interface Break { id: string; label: string; startDate: string; endDate: string; courseId: string | null }
interface Master {
  courseId: string; saved: boolean; startDate: string | null; endDate: string | null; rows: Row[]; problems: string[]; canEdit: boolean; breaks: Break[];
  /** The cycle on screen (the master repeats), the next one when it has been created, and whether it is time to create it. */
  cycle?: number; next?: { cycle: number; startDate: string; endDate: string } | null; nextDue?: boolean;
}
interface NextCycle { cycle: number; startDate: string; endDate: string; created: boolean; rows: { unitId: string; code: string; name: string; weeks: number; startDate: string; endDate: string }[]; breaks: Break[] }

async function call(action: "get" | "preview" | "save", data: Record<string, unknown>): Promise<Master> {
  const { data: out, error } = await supabase.rpc("rto_master_timetable", { p_action: action, p_data: data });
  if (error) throw new Error(error.message);
  return out as Master;
}
const days = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;
const weeksLabel = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const input = "rounded-lg border border-background-300 bg-background-50 px-2 py-1.5 text-sm";
const th = "px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground-500";

export default function MasterTimetableTab({ courseId, courseCode, onSaved }: { courseId: string; courseCode: string; onSaved?: () => void }) {
  const [master, setMaster] = useState<Master | null>(null);
  const [start, setStart] = useState("");
  const [order, setOrder] = useState<{ unitId: string; weeks: number }[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [nextCycle, setNextCycle] = useState<NextCycle | null>(null);
  const [breakDraft, setBreakDraft] = useState<{ label: string; startDate: string; endDate: string } | null>(null);
  const request = useRef(0);

  const apply = (data: Master) => {
    setMaster(data);
    setOrder(data.rows.map(row => ({ unitId: row.unitId, weeks: Number(row.weeks) })));
  };
  const load = useCallback(async () => {
    setError("");
    try { const data = await call("get", { courseId }); apply(data); setStart(data.startDate ?? ""); setDirty(false); }
    catch (e) { setError(e instanceof Error ? e.message : "The master timetable could not be loaded."); }
  }, [courseId]);
  useEffect(() => { void load(); }, [load]);

  /** Ask the server for the dates of the order on screen (nothing is saved). */
  const preview = useCallback(async (nextStart: string, nextOrder: { unitId: string; weeks: number }[]) => {
    const mine = ++request.current;
    try {
      const data = await call("preview", { courseId, startDate: nextStart, rows: nextOrder });
      if (mine === request.current) { setMaster(current => ({ ...data, saved: current?.saved ?? false })); setError(""); }
    } catch (e) { if (mine === request.current) setError(e instanceof Error ? e.message : "The dates could not be calculated."); }
  }, [courseId]);
  const change = (nextStart: string, nextOrder: { unitId: string; weeks: number }[]) => {
    setStart(nextStart); setOrder(nextOrder); setDirty(true); setNotice("");
    if (nextOrder.every(row => row.weeks > 0)) void preview(nextStart, nextOrder);
  };
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order]; [next[index], next[to]] = [next[to], next[index]];
    change(start, next);
  };
  const setWeeks = (index: number, value: string) => {
    const weeks = Number(value);
    change(start, order.map((row, i) => i === index ? { ...row, weeks: Number.isFinite(weeks) ? weeks : 0 } : row));
  };

  const save = async () => {
    if (busy || !master?.canEdit) return;
    setBusy(true); setError(""); setNotice("");
    try { const data = await call("save", { courseId, startDate: start, rows: order }); apply(data); setDirty(false); setNotice("Master timetable saved."); onSaved?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "The master timetable was not saved."); }
    finally { setBusy(false); }
  };

  /** The next cycle as it would be with the term breaks entered so far (nothing is saved), or create it. */
  const next = async (create: boolean) => {
    if (busy) return;
    if (create && !window.confirm("Create the next cycle with these dates? Check that every term break for that period has been added first.")) return;
    setBusy(true); setError(""); setNotice("");
    const { data, error: e } = await supabase.rpc("rto_master_timetable", { p_action: create ? "next_create" : "next_preview", p_data: { courseId } });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setNextCycle(data as NextCycle);
    if (create) { setNotice("The next cycle is created. Intakes move onto it when the current cycle ends."); await load(); }
  };

  const breakProblem = !breakDraft ? "" : !breakDraft.label.trim() ? "Enter a name." : !breakDraft.startDate || !breakDraft.endDate ? "Enter the first and last day."
    : breakDraft.endDate < breakDraft.startDate ? "The last day must be on or after the first day." : "";
  const addBreak = async () => {
    if (!breakDraft || breakProblem || busy) return;
    setBusy(true); setError("");
    const { error: e } = await supabase.from("academic_breaks").insert({ label: breakDraft.label.trim(), start_date: breakDraft.startDate, end_date: breakDraft.endDate, course_id: courseId });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setBreakDraft(null); setDirty(true);
    await preview(start, order);
  };
  const removeBreak = async (item: Break) => {
    if (busy || !window.confirm(`Remove the term break "${item.label}" (${shortDate(item.startDate)} to ${shortDate(item.endDate)})? The unit dates will move.`)) return;
    setBusy(true); setError("");
    const { error: e } = await supabase.from("academic_breaks").delete().eq("id", item.id);
    setBusy(false);
    if (e) { setError(e.message); return; }
    setDirty(true);
    await preview(start, order);
  };

  const byId = useMemo(() => new Map((master?.rows ?? []).map(row => [row.unitId, row])), [master]);
  // Units in the order on screen, each followed by the term breaks that begin before the next unit starts.
  const lines = useMemo(() => {
    const rows = order.map(item => byId.get(item.unitId)).filter((row): row is Row => !!row);
    const breaks = (master?.breaks ?? []).filter(item => !master?.endDate || item.startDate <= master.endDate);
    const used = new Set<string>();
    const out: ({ kind: "unit"; row: Row; index: number } | { kind: "break"; item: Break })[] = [];
    rows.forEach((row, index) => {
      if (row.startDate) for (const item of breaks) if (!used.has(item.id) && item.startDate < row.startDate) { used.add(item.id); out.push({ kind: "break", item }); }
      out.push({ kind: "unit", row, index });
    });
    for (const item of breaks) if (!used.has(item.id) && start) out.push({ kind: "break", item });
    return out;
  }, [order, byId, master, start]);

  if (!master) return <p className="py-10 text-center text-sm text-foreground-500">{error || "Loading the master timetable…"}</p>;
  const canEdit = master.canEdit;
  const totalWeeks = order.reduce((sum, row) => sum + (row.weeks || 0), 0);
  const totalHours = master.rows.reduce((sum, row) => sum + (row.hours ?? 0), 0);
  const perWeek = (row: Row, index: number) => row.hours && order[index]?.weeks > 0 ? row.hours / order[index].weeks : null;
  const orderedRows = order.map(item => byId.get(item.unitId));
  const need = Math.max(0, ...orderedRows.map((row, index) => row ? perWeek(row, index) ?? 0 : 0));
  /** Every unit's weeks from its hours at a weekly rate (20 hours a week: 40 hours = 2 weeks), rounded up to whole weeks. */
  const fitWeeks = (rate: number) => change(start, order.map(item => {
    const hours = byId.get(item.unitId)?.hours;
    return hours ? { ...item, weeks: Math.max(1, Math.ceil(hours / rate)) } : item;
  }));
  const blocked = busy || !start || !order.length || order.some(row => !(row.weeks > 0)) || master.problems.length > 0;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium text-foreground-800">Start date
          <input type="date" className={input + " mt-1 block"} value={start} disabled={!canEdit || busy} onChange={e => change(e.target.value, order)} />
        </label>
        <dl className="flex gap-5 text-sm">
          <div><dt className="text-xs text-foreground-500" title="The course has no end: the units start again in the next cycle">This cycle ends</dt><dd className="font-semibold text-foreground-950">{master.endDate ? shortDate(master.endDate) : "—"}</dd></div>
          <div><dt className="text-xs text-foreground-500">Units</dt><dd className="font-semibold text-foreground-950">{order.length}</dd></div>
          <div><dt className="text-xs text-foreground-500">Classroom weeks</dt><dd className="font-semibold text-foreground-950">{weeksLabel(totalWeeks)}</dd></div>
          <div><dt className="text-xs text-foreground-500">Classroom hours</dt><dd className="font-semibold text-foreground-950">{totalHours.toLocaleString()}</dd></div>
          <div><dt className="text-xs text-foreground-500">Most hours a week</dt><dd className={"font-semibold " + (need > 40 ? "text-red-700" : "text-foreground-950")}>{need ? need.toFixed(1).replace(/\.0$/, "") : "—"}</dd></div>
        </dl>
      </div>
      {canEdit ? <div className="flex items-center gap-2">
        <span className="text-xs text-foreground-500" role="status">{dirty ? "Unsaved changes" : master.saved ? "Saved" : "Not saved yet"}</span>
        <button type="button" disabled={busy || !order.length} onClick={() => fitWeeks(20)} title="Sets every unit's weeks from its classroom hours at 20 hours a week (40 hours = 2 weeks)"
          className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50">Weeks from hours (20 a week)</button>
        <button type="button" disabled={busy} onClick={() => setBreakDraft({ label: "Term break", startDate: "", endDate: "" })}
          className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50">Add term break</button>
        <button type="button" disabled={blocked || (!dirty && master.saved)} onClick={() => void save()}
          className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving…" : "Save master timetable"}</button>
      </div> : null}
    </div>

    {!start ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Enter the start date and every unit gets its start and end date. Add the term breaks first so the dates are right.</p> : null}
    {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
    {notice ? <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</p> : null}
    {master.problems.length ? <ul role="alert" className="list-disc rounded-lg border border-red-200 bg-red-50 py-2 pl-8 pr-3 text-sm text-red-700">
      {master.problems.map(problem => <li key={problem}>{problem}</li>)}</ul> : null}
    {master.rows.some(row => !row.inMaster) && master.saved ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      Units added to the course since the last save are at the end of the list. Move them if needed, then save.</p> : null}

    {breakDraft ? <div className="flex flex-wrap items-end gap-2 rounded-lg border border-background-200 bg-background-100 p-3">
      <label className="text-xs font-medium text-foreground-700">Name<input className={input + " mt-1 block w-44"} value={breakDraft.label} maxLength={80} onChange={e => setBreakDraft({ ...breakDraft, label: e.target.value })} /></label>
      <label className="text-xs font-medium text-foreground-700">First day<input type="date" className={input + " mt-1 block"} value={breakDraft.startDate} onChange={e => setBreakDraft({ ...breakDraft, startDate: e.target.value })} /></label>
      <label className="text-xs font-medium text-foreground-700">Last day<input type="date" className={input + " mt-1 block"} value={breakDraft.endDate} min={breakDraft.startDate || undefined} onChange={e => setBreakDraft({ ...breakDraft, endDate: e.target.value })} /></label>
      <button type="button" disabled={busy || !!breakProblem} onClick={() => void addBreak()} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">Add for {courseCode}</button>
      <button type="button" disabled={busy} onClick={() => setBreakDraft(null)} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100">Cancel</button>
      {breakProblem && (breakDraft.startDate || breakDraft.endDate) ? <span className="text-xs text-red-700">{breakProblem}</span> : null}
    </div> : null}

    {!order.length ? <p className="py-10 text-center text-sm text-foreground-500">This course has no active units. Add units first.</p> : <div className="overflow-x-auto rounded-lg border border-background-200">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b border-background-200 bg-background-100"><tr>
          <th className={th}>Sr. No.</th><th className={th}>Unit code</th><th className={th}>Unit name</th><th className={th} title="Core or elective">C/E</th>
          <th className={th + " text-right"}>Classroom hours</th><th className={th + " text-right"}>Classroom weeks</th><th className={th + " text-right"} title="Classroom hours divided by classroom weeks: every intake's class times must give at least this many hours a week">Hours a week</th><th className={th}>Pre-requisite</th>
          <th className={th}>Start date</th><th className={th}>End date</th>{canEdit ? <th className={th}><span className="sr-only">Move</span></th> : null}
        </tr></thead>
        <tbody>{lines.map(line => line.kind === "break" ? <tr key={"break:" + line.item.id} className="border-b border-background-200 bg-amber-100 text-amber-950">
          <td className="px-2 py-2" /><td className="px-2 py-2 font-semibold" colSpan={3}>{line.item.label}{line.item.courseId ? "" : " (all courses)"}</td>
          <td className="px-2 py-2" /><td className="px-2 py-2 text-right">{weeksLabel(days(line.item.startDate, line.item.endDate) / 7)}</td><td className="px-2 py-2" /><td className="px-2 py-2" />
          <td className="whitespace-nowrap px-2 py-2">{shortDate(line.item.startDate)}</td><td className="whitespace-nowrap px-2 py-2">{shortDate(line.item.endDate)}</td>
          {canEdit ? <td className="px-2 py-2 text-right">{line.item.courseId ? <button type="button" disabled={busy} onClick={() => void removeBreak(line.item)} aria-label={`Remove ${line.item.label}`}
            className="rounded p-1 text-red-700 hover:bg-amber-200 disabled:opacity-50"><i className="ri-delete-bin-line" aria-hidden="true" /></button> : null}</td> : null}
        </tr> : <tr key={line.row.unitId} className={"border-b border-background-100 " + (line.row.inMaster || !master.saved ? "" : "bg-amber-50")}>
          <td className="px-2 py-2 text-foreground-500">{line.index + 1}</td>
          <td className="whitespace-nowrap px-2 py-2 font-semibold text-foreground-950">{line.row.code}{line.row.prerequisites.length ? <span title="Has prerequisites" aria-hidden="true">*</span> : null}</td>
          <td className="px-2 py-2 text-foreground-800">{line.row.name}</td>
          <td className="px-2 py-2">{line.row.unitType === "core" ? "C" : "E"}</td>
          <td className="px-2 py-2 text-right">{line.row.hours ?? "—"}</td>
          <td className="px-2 py-2 text-right">{canEdit ? <input type="number" min={0.5} max={104} step={0.5} aria-label={`Classroom weeks for ${line.row.code}`} disabled={busy}
            className={input + " w-20 text-right " + (order[line.index]?.weeks > 0 ? "" : "border-red-400")} value={order[line.index]?.weeks || ""} onChange={e => setWeeks(line.index, e.target.value)} />
            : weeksLabel(Number(line.row.weeks))}</td>
          <td className={"px-2 py-2 text-right " + ((perWeek(line.row, line.index) ?? 0) > 40 ? "font-semibold text-red-700" : "text-foreground-700")}>{perWeek(line.row, line.index)?.toFixed(1).replace(/\.0$/, "") ?? "—"}</td>
          <td className="px-2 py-2 text-xs text-foreground-700">{line.row.prerequisites.join(", ")}</td>
          <td className="whitespace-nowrap px-2 py-2">{line.row.startDate ? shortDate(line.row.startDate) : "—"}</td>
          <td className="whitespace-nowrap px-2 py-2">{line.row.endDate ? shortDate(line.row.endDate) : "—"}</td>
          {canEdit ? <td className="whitespace-nowrap px-2 py-2 text-right">
            <button type="button" disabled={busy || line.index === 0} onClick={() => move(line.index, -1)} aria-label={`Move ${line.row.code} up`} className="rounded p-1 text-foreground-700 hover:bg-background-200 disabled:opacity-30"><i className="ri-arrow-up-line" aria-hidden="true" /></button>
            <button type="button" disabled={busy || line.index === order.length - 1} onClick={() => move(line.index, 1)} aria-label={`Move ${line.row.code} down`} className="rounded p-1 text-foreground-700 hover:bg-background-200 disabled:opacity-30"><i className="ri-arrow-down-line" aria-hidden="true" /></button>
          </td> : null}
        </tr>)}</tbody>
      </table>
    </div>}
    {master.saved && !dirty ? <section aria-label="Next cycle" className={"rounded-lg border p-3 " + (master.nextDue ? "border-amber-300 bg-amber-50" : "border-background-200")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <h4 className="font-semibold text-foreground-950">Next cycle{master.cycle ? ` (cycle ${master.cycle + 1})` : ""}</h4>
          {master.next ? <p className="text-foreground-700">Created: {shortDate(master.next.startDate)} to {shortDate(master.next.endDate)}. The intakes move onto it when this cycle ends{master.endDate ? ` (${shortDate(master.endDate)})` : ""}.</p>
            : <p className={master.nextDue ? "text-amber-900" : "text-foreground-700"}>{master.nextDue ? "This cycle ends within three months. " : ""}When this cycle ends the units start again. Add the term breaks for that period above, then create the next cycle; the system does not create it by itself.</p>}
        </div>
        {!master.next ? <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void next(false)} className="rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50">Preview dates</button>
          {canEdit ? <button type="button" disabled={busy} onClick={() => void next(true)} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">Create the next cycle</button> : null}
        </div> : null}
      </div>
      {nextCycle && !master.next ? <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[520px] text-sm">
        <thead><tr><th className={th}>Unit</th><th className={th + " text-right"}>Weeks</th><th className={th}>Start date</th><th className={th}>End date</th></tr></thead>
        <tbody>{nextCycle.rows.map(row => <tr key={row.unitId} className="border-t border-background-200">
          <td className="px-2 py-1.5"><b>{row.code}</b> <span className="text-foreground-700">{row.name}</span></td><td className="px-2 py-1.5 text-right">{weeksLabel(Number(row.weeks))}</td>
          <td className="whitespace-nowrap px-2 py-1.5">{shortDate(row.startDate)}</td><td className="whitespace-nowrap px-2 py-1.5">{shortDate(row.endDate)}</td></tr>)}</tbody>
      </table>
        <p className="mt-1 text-xs text-foreground-600">{nextCycle.breaks.length ? `Term breaks in this period: ${nextCycle.breaks.map(item => `${item.label} (${shortDate(item.startDate)} to ${shortDate(item.endDate)})`).join("; ")}.` : "No term break has been entered for this period yet."}</p>
      </div> : null}
    </section> : null}
    <p className="text-xs text-foreground-500">Units run one after another in whole 7-day weeks, weekends included; days inside a term break are not counted. A unit marked * needs the units in the Pre-requisite column first.
      Changing weeks here does not change the unit itself. Every open intake of the course follows these dates, and an intake's class times must give at least the most hours a week shown above{need > 40 ? " (more than 40 hours a week cannot be timetabled: give the unit more weeks)" : ""}.</p>
  </div>;
}
