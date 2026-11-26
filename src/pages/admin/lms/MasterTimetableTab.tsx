// Master timetable of a course (LMS > Courses > a course > Master timetable): one start date gives every unit its start
// and end date, in whole 7-day weeks, one unit after another, with term breaks left out. Staff change a unit's weeks, move
// units up and down and add term breaks; the server (public.rto_master_timetable) calculates the dates and refuses an
// order that puts a unit before one it needs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { LOAD_HOURS, shortDate } from "@/pages/admin/lib/rto";
import MasterCyclesPanel, { FillSchoolBreaksButton } from "./MasterCyclesPanel";
import CourseHolidaysPanel from "./CourseHolidaysPanel";
import { COE_HOURS, CyclesUnavailable, cyclesCall, fixedWeeks, planTill, type CyclePlan } from "@/pages/admin/lib/masterCycles";

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

async function call(action: "get" | "preview" | "save", data: Record<string, unknown>): Promise<Master> {
  const { data: out, error } = await supabase.rpc("rto_master_timetable", { p_action: action, p_data: data });
  if (error) throw new Error(error.message);
  return out as Master;
}
const days = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;
const weeksLabel = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
/** Does unit `a` need unit `b` first (b is one of a's prerequisites)? */
const needs = (a: Row | undefined, b: Row | undefined) => !!a && !!b && a.prerequisites.some(code => code.trim().toUpperCase() === b.code.trim().toUpperCase());
/** Is this unit a prerequisite of any other unit on the course? */
const isPrereq = (row: Row | undefined, all: Iterable<Row>) => !!row && [...all].some(other => other !== row && needs(other, row));
/**
 * Weekly Calendar order (owner, 2026-11-20: "we teach all prereqs first before starting the course"): every unit that is a
 * prerequisite of another unit comes first, as one block, then the rest of the course. Inside each block a unit still follows
 * the units it needs. Stable: units keep their order otherwise; a loop is left as it is.
 */
function prerequisitesFirst(order: { unitId: string; weeks: number }[], rows: Map<string, Row>) {
  const sortBlock = (block: typeof order) => {
    const left = [...block];
    const out: typeof order = [];
    while (left.length) {
      const i = left.findIndex(item => !left.some(other => other !== item && needs(rows.get(item.unitId), rows.get(other.unitId))));
      out.push(...left.splice(i < 0 ? 0 : i, 1));
    }
    return out;
  };
  const all = [...rows.values()];
  const prereqs = order.filter(item => isPrereq(rows.get(item.unitId), all));
  return [...sortBlock(prereqs), ...sortBlock(order.filter(item => !prereqs.includes(item)))];
}
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
  // Qualification cycles (all scheduled at once): saved with the master timetable.
  const [cycles, setCycles] = useState(1);
  const [plan, setPlan] = useState<CyclePlan | null>(null);
  const [breakDraft, setBreakDraft] = useState<{ label: string; startDate: string; endDate: string } | null>(null);
  const request = useRef(0);

  const apply = (data: Master) => {
    setMaster(data);
    setOrder(data.rows.map(row => ({ unitId: row.unitId, weeks: Number(row.weeks) })));
  };
  /** Ask the server for the dates of the order on screen (nothing is saved). */
  const preview = useCallback(async (nextStart: string, nextOrder: { unitId: string; weeks: number }[]) => {
    const mine = ++request.current;
    try {
      const data = await call("preview", { courseId, startDate: nextStart, rows: nextOrder });
      if (mine === request.current) { setMaster(current => ({ ...data, saved: current?.saved ?? false })); setError(""); }
    } catch (e) { if (mine === request.current) setError(e instanceof Error ? e.message : "The dates could not be calculated."); }
  }, [courseId]);
  const load = useCallback(async () => {
    setError("");
    try {
      const data = await call("get", { courseId }); apply(data); setStart(data.startDate ?? ""); setDirty(false);
      const cyclePlan = await cyclesCall("get", { courseId }).catch(() => null);
      if (cyclePlan) { setPlan(cyclePlan); setCycles(cyclePlan.cyclesPlanned); }
      // A unit listed before one of its prerequisites is moved after it; staff save to keep the new order.
      const current = data.rows.map(row => ({ unitId: row.unitId, weeks: Number(row.weeks) }));
      // Weeks are fixed at SLIT hours ÷ 20 (CoE, owner 2026-11-20), and the prerequisite units come first.
      const sorted = prerequisitesFirst(data.rows.map(row => ({ unitId: row.unitId, weeks: fixedWeeks(row.hours, Number(row.weeks)) })), new Map(data.rows.map(row => [row.unitId, row])));
      const moved = sorted.some((item, i) => item.unitId !== current[i].unitId);
      const reweeked = sorted.some(item => item.weeks !== current.find(row => row.unitId === item.unitId)?.weeks);
      if (moved || reweeked) {
        setOrder(sorted); setDirty(true);
        setNotice([moved ? "Prerequisite units were moved to the start of the course." : "", reweeked ? `Unit weeks were set to their SLIT hours ÷ ${COE_HOURS}.` : "", "Save to keep this."].filter(Boolean).join(" "));
        if (sorted.every(row => row.weeks > 0)) void preview(data.startDate ?? "", sorted);
      }
    }
    catch (e) { setError(e instanceof Error ? e.message : "The master timetable could not be loaded."); }
  }, [courseId, preview]);
  useEffect(() => { void load(); }, [load]);

  const change = (nextStart: string, nextOrder: { unitId: string; weeks: number }[]) => {
    setStart(nextStart); setOrder(nextOrder); setDirty(true); setNotice("");
    if (nextOrder.every(row => row.weeks > 0)) void preview(nextStart, nextOrder);
  };
  // A unit cannot go above a unit it needs, nor below a unit that needs it.
  // Nor can a prerequisite unit go below a unit that is not one (all prerequisites are taught first).
  const moveBlocked = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= order.length) return true;
    const self = byId.get(order[index].unitId), other = byId.get(order[to].unitId);
    const [upper, lower] = by < 0 ? [other, self] : [self, other];
    return needs(upper, lower) || (isPrereq(upper, byId.values()) && !isPrereq(lower, byId.values()));
  };
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (moveBlocked(index, by)) return;
    const next = [...order]; [next[index], next[to]] = [next[to], next[index]];
    change(start, next);
  };


  const save = async () => {
    if (busy || !master?.canEdit) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await call("save", { courseId, startDate: start, rows: order }); apply(data);
      // Saving keeps only the current cycle: the later ones are built again for the cycles chosen (and the term breaks now).
      let note = "Master timetable saved.";
      try { setPlan(await cyclesCall("set", { courseId, cycles })); }
      catch (e) { if (!(e instanceof CyclesUnavailable)) throw e; note += " " + e.message; }
      setDirty(false); setNotice(note); onSaved?.();
    }
    catch (e) { setError(e instanceof Error ? e.message : "The master timetable was not saved."); }
    finally { setBusy(false); }
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
  /** The most class hours a week an intake can have (VoE hours a week). */
  const maxWeek = LOAD_HOURS.voe;
  const blocked = busy || !start || !order.length || order.some(row => !(row.weeks > 0)) || master.problems.length > 0;

  const small = "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-foreground-700 hover:bg-background-100 disabled:opacity-50";
  const fact = (label: string, value: string, warn = false) => <span className="whitespace-nowrap"><span className="text-foreground-500">{label}</span> <b className={warn ? "text-red-700" : "text-foreground-900"}>{value}</b></span>;
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-background-200 bg-background-100/60 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <label className="flex items-center gap-2 text-xs font-semibold text-foreground-700">Start
          <input type="date" aria-label="Start date" className={input + " py-1"} value={start} disabled={!canEdit || busy} onChange={e => change(e.target.value, order)} />
        </label>
        <span title="The course has no end: the units start again in the next cycle">{fact("This cycle ends", master.endDate ? shortDate(master.endDate) : "—")}</span>
        {fact("Units", String(order.length))}
        {fact("Weeks", weeksLabel(totalWeeks))}
        {fact("Hours", totalHours.toLocaleString())}
        {fact("Max a week", need ? need.toFixed(1).replace(/\.0$/, "") + " h" : "—", need > maxWeek)}
      </div>
      {canEdit ? <div className="flex items-center gap-2">
        <span className="text-xs text-foreground-500" role="status">{dirty ? "Unsaved changes" : master.saved ? "Saved" : "Not saved yet"}</span>
        <button type="button" disabled={blocked || (!dirty && master.saved)} onClick={() => void save()}
          className="rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
      </div> : null}
    </div>
    {canEdit ? <div className="flex flex-wrap items-center gap-1">
      <button type="button" disabled={busy} onClick={() => setBreakDraft({ label: "Term break", startDate: "", endDate: "" })} className={small}>
        <i className="ri-calendar-close-line" aria-hidden="true" />Add term break</button>
      {canEdit ? <FillSchoolBreaksButton courseId={courseId} from={start} to={planTill(start, master.endDate, cycles, plan).till} disabled={busy}
        onAdded={async () => { setDirty(true); setNotice("Term breaks added: save to move the dates past them."); if (order.every(row => row.weeks > 0)) await preview(start, order); }} /> : null}
      {!start ? <span className="ml-2 text-xs text-foreground-500">Enter the start date: every unit gets its dates. Add term breaks first.</span> : null}
    </div> : null}

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

    <CourseHolidaysPanel courseId={courseId} courseCode={courseCode} from={start} to={planTill(start, master.endDate, cycles, plan).till} canEdit={canEdit} />

    {!order.length ? <p className="py-10 text-center text-sm text-foreground-500">This course has no active units. Add units first.</p> : <div className="overflow-x-auto rounded-lg border border-background-200">
      <table className="w-full min-w-[700px] text-sm">
        <thead className="sticky top-0 z-[1] border-b border-background-200 bg-background-100"><tr>
          <th className={th + " w-10"}>#</th><th className={th}>Unit</th>
          <th className={th + " text-right"} title="Classroom hours">Hours</th><th className={th + " text-right"} title="Classroom weeks">Weeks</th>
          <th className={th + " text-right"} title="Classroom hours divided by classroom weeks: every intake's class times must give at least this many hours a week">Hrs / wk</th>
          <th className={th}>Starts</th><th className={th}>Ends</th>{canEdit ? <th className={th + " w-16"}><span className="sr-only">Move</span></th> : null}
        </tr></thead>
        <tbody>{lines.map(line => line.kind === "break" ? <tr key={"break:" + line.item.id} className="border-b border-amber-200 bg-amber-50 text-amber-950">
          <td className="px-2 py-2 text-center"><i className="ri-calendar-close-line" aria-hidden="true" /></td>
          <td className="px-2 py-2 font-semibold" colSpan={2}>{line.item.label}<span className="ml-2 text-xs font-normal">Term break{line.item.courseId ? "" : " · all courses"}</span></td>
          <td className="px-2 py-2 text-right tabular-nums">{weeksLabel(days(line.item.startDate, line.item.endDate) / 7)}</td><td className="px-2 py-2" />
          <td className="whitespace-nowrap px-2 py-2">{shortDate(line.item.startDate)}</td><td className="whitespace-nowrap px-2 py-2">{shortDate(line.item.endDate)}</td>
          {canEdit ? <td className="px-2 py-2 text-right">{line.item.courseId ? <button type="button" disabled={busy} onClick={() => void removeBreak(line.item)} aria-label={`Remove ${line.item.label}`}
            className="rounded p-1 text-red-700 hover:bg-amber-200 disabled:opacity-50"><i className="ri-delete-bin-line" aria-hidden="true" /></button> : null}</td> : null}
        </tr> : <tr key={line.row.unitId} className={"border-b border-background-100 align-top hover:bg-background-100/60 " + (line.row.inMaster || !master.saved ? "" : "bg-amber-50")}>
          <td className="px-2 py-2.5 text-foreground-500 tabular-nums">{line.index + 1}</td>
          <td className="px-2 py-2.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-semibold text-foreground-950">{line.row.code}</span>
              <span className={"rounded-full px-1.5 py-px text-2xs font-semibold " + (line.row.unitType === "core" ? "bg-primary-100 text-primary-800" : "bg-background-200 text-foreground-700")}>{line.row.unitType === "core" ? "Core" : "Elective"}</span>
            </span>
            <span className="block text-foreground-700">{line.row.name}</span>
            {line.row.prerequisites.length ? <span className="mt-0.5 block text-xs text-foreground-500"><i className="ri-git-merge-line mr-1" aria-hidden="true" />After {line.row.prerequisites.join(", ")}</span> : null}
          </td>
          <td className="px-2 py-2.5 text-right tabular-nums">{line.row.hours ?? "—"}</td>
          <td className="px-2 py-2 text-right">{weeksLabel(order[line.index]?.weeks ?? Number(line.row.weeks))}</td>
          <td className={"px-2 py-2.5 text-right tabular-nums " + ((perWeek(line.row, line.index) ?? 0) > maxWeek ? "font-semibold text-red-700" : "text-foreground-700")}>{perWeek(line.row, line.index)?.toFixed(1).replace(/\.0$/, "") ?? "—"}</td>
          <td className="whitespace-nowrap px-2 py-2.5 font-medium text-foreground-950">{line.row.startDate ? shortDate(line.row.startDate) : "—"}</td>
          <td className="whitespace-nowrap px-2 py-2.5 font-medium text-foreground-950">{line.row.endDate ? shortDate(line.row.endDate) : "—"}</td>
          {canEdit ? <td className="whitespace-nowrap px-2 py-2 text-right">
            <button type="button" disabled={busy || moveBlocked(line.index, -1)} title={line.index > 0 && moveBlocked(line.index, -1) ? "Prerequisite units are taught first, and a unit stays after the units it needs." : undefined} onClick={() => move(line.index, -1)} aria-label={`Move ${line.row.code} up`} className="rounded p-1 text-foreground-700 hover:bg-background-200 disabled:opacity-30"><i className="ri-arrow-up-line" aria-hidden="true" /></button>
            <button type="button" disabled={busy || moveBlocked(line.index, 1)} title={line.index < order.length - 1 && moveBlocked(line.index, 1) ? "Prerequisite units are taught first, and a unit stays after the units it needs." : undefined} onClick={() => move(line.index, 1)} aria-label={`Move ${line.row.code} down`} className="rounded p-1 text-foreground-700 hover:bg-background-200 disabled:opacity-30"><i className="ri-arrow-down-line" aria-hidden="true" /></button>
          </td> : null}
        </tr>)}</tbody>
      </table>
    </div>}
    <MasterCyclesPanel cycles={cycles} onCycles={value => { setCycles(value); setDirty(true); setNotice(""); }} start={start} cycleEnd={master.endDate} plan={plan}
      canEdit={canEdit} busy={busy} />
    <p className="text-xs text-foreground-500">Units run one after another in whole 7-day weeks, weekends included; days inside a term break are not counted. A unit marked * needs the units in the Pre-requisite column first.
      Every open intake of the course follows these dates, and an intake's class times must give at least the most hours a week shown above{need > maxWeek ? ` (more than ${maxWeek} hours a week cannot be timetabled)` : ""}.</p>
  </div>;
}
