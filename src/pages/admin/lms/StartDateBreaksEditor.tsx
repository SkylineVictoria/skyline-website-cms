// Step 4 of the new course wizard (the CoE weekly calendar): the start date and the term breaks of a course, each in a table, and the master timetable
// they give for one cycle: every unit's start and end date, one unit after another in its weeks (from its SLIT hours), prerequisites
// first, term breaks left out. The server (public.rto_master_timetable) calculates the dates; Save keeps them as the master
// timetable, which the Master timetable tab shows and edits afterwards. The course has no end: when its last unit ends the
// units start again (the next cycle), so only the cycle has a last day.
// Term breaks can be added, changed and removed; two breaks that apply to this course cannot overlap. Units can be moved up and
// down, and a unit's weeks or end date changed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { BreakDateField } from "@/pages/admin/components/rto/BreakDatePicker";
import { supabase } from "@/pages/admin/lib/supabase";
import { shortDate, type StudyLoad } from "@/pages/admin/lib/rto";
import MasterCyclesPanel, { FillSchoolBreaksButton } from "./MasterCyclesPanel";
import { COE_HOURS, CyclesUnavailable, courseStartFor, courseStartForEnd, cyclesCall, fixedWeeks, planTill, type CyclePlan } from "@/pages/admin/lib/masterCycles";

interface Row { unitId: string; code: string; name: string; hours: number | null; weeks: number; startDate: string | null; endDate: string | null; prerequisites: string[] }
interface Break { id: string; label: string; startDate: string; endDate: string; courseId: string | null }
interface Master { saved: boolean; startDate: string | null; endDate: string | null; rows: Row[]; problems: string[]; canEdit: boolean; breaks: Break[] }

async function call(action: "get" | "preview" | "save", data: Record<string, unknown>): Promise<Master> {
  const { data: out, error } = await supabase.rpc("rto_master_timetable", { p_action: action, p_data: data });
  if (error) throw new Error(error.message);
  return out as Master;
}
const weeksOf = (from: string, to: string) => {
  const w = (Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1) / 7;
  return Number.isInteger(w) ? String(w) : w.toFixed(1);
};
const weeksLabel = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const input = "rounded-md border border-background-300 bg-background-50 px-2 py-1 text-sm";
const th = "px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground-500";
const emptyDraft = { label: "", startDate: "", endDate: "" };
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
/** The breaks (other than `except`) that share a day with from..to. */
const overlapping = (list: Break[], from: string, to: string, except?: string) =>
  list.filter(b => b.id !== except && b.startDate <= to && from <= b.endDate);

export default function StartDateBreaksEditor({ course, stepLabel, onClose, nextStep, backStep, onStudyLoad }: {
  course: { id: string; code: string };
  stepLabel?: string;
  onClose: () => void;
  /** The step after saving (create the first intake); without it the footer shows Done. */
  nextStep?: { label: string; onClick: () => void };
  /** New course wizard: the step before this one. */
  backStep?: { label: string; onClick: () => void };
  /** This calendar is CoE only (owner, 2026-11-20: "remove VoE fully"): 20 class hours a week, every unit's weeks fixed at its
   * SLIT hours ÷ 20. The wizard is told so (its intake is CoE). */
  onStudyLoad?: (load: StudyLoad) => void;
  /** The CRICOS registered duration in weeks: the class hours a week are raised so one cycle fits in it (owner, 2026-11-20). */
  registeredWeeks?: number | null;
}) {
  const [master, setMaster] = useState<Master | null>(null);
  const [start, setStart] = useState("");
  const [order, setOrder] = useState<{ unitId: string; weeks: number }[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // Qualification cycles: kept here until Save, then the plan is built with them.
  const [cycles, setCycles] = useState(1);
  const [plan, setPlan] = useState<CyclePlan | null>(null);
  // The term break being changed in place.
  const [editing, setEditing] = useState<(typeof emptyDraft & { id: string; courseId: string | null }) | null>(null);
  const request = useRef(0);
  const breaks = useMemo(() => [...(master?.breaks ?? [])].sort((a, b) => a.startDate.localeCompare(b.startDate)), [master]);

  useEffect(() => {
    let live = true;
    call("get", { courseId: course.id }).then(data => {
      if (!live) return;
      setMaster(data); setStart(data.startDate ?? "");
      // Weeks are fixed: SLIT hours ÷ 20 (CoE), to the half week; a unit without hours keeps its weeks.
      const fixed = data.rows.map(r => ({ unitId: r.unitId, weeks: fixedWeeks(r.hours, Number(r.weeks)) }));
      setOrder(fixed);
      if (data.startDate && fixed.some((o, i) => o.weeks !== Number(data.rows[i].weeks))) void preview(data.startDate, fixed);
      onStudyLoad?.("coe");
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : "The units could not be loaded."); });
    cyclesCall("get", { courseId: course.id }).then(data => { if (live) { setPlan(data); setCycles(data.cyclesPlanned); } }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads once per course
  }, [course.id]);

  /** The dates for the start date on screen (nothing is saved). */
  const preview = useCallback(async (nextStart: string, rows?: { unitId: string; weeks: number }[]) => {
    const list = rows ?? order;
    if (!nextStart || !list.length || list.some(o => !(o.weeks > 0))) return;
    const mine = ++request.current;
    try {
      const data = await call("preview", { courseId: course.id, startDate: nextStart, rows: list });
      if (mine === request.current) { setMaster(data); setError(""); }
    } catch (e) { if (mine === request.current) setError(e instanceof Error ? e.message : "The dates could not be calculated."); }
  }, [course.id, order]);

  const changeStart = (value: string) => {
    setStart(value); setSaved(false);
    void preview(value);
  };
  // Term breaks: filled from the Victorian school calendar or typed in by hand (owner, 2026-11-20).
  const [breakMode, setBreakMode] = useState<"auto" | "manual">("auto");
  // Every term break of this course, for working dates out here (the master only returns those from its start on).
  const [allBreaks, setAllBreaks] = useState<Break[]>([]);
  const loadAllBreaks = async () => {
    const { data, error: e } = await supabase.from("academic_breaks").select("id,label,start_date,end_date,course_id").or(`course_id.is.null,course_id.eq.${course.id}`);
    if (e) throw new Error(e.message);
    const list = ((data ?? []) as { id: string; label: string; start_date: string; end_date: string; course_id: string | null }[])
      .map(b => ({ id: b.id, label: b.label, startDate: b.start_date, endDate: b.end_date, courseId: b.course_id }));
    setAllBreaks(list);
    return list;
  };
  useEffect(() => { void loadAllBreaks().catch(() => undefined); }, [master?.breaks.length]); // eslint-disable-line react-hooks/exhaustive-deps -- again when breaks change
  /** A unit's start or end date chosen: its weeks stay, so the course start that puts it there is worked out and every unit moves. */
  const moveUnitTo = async (index: number, edge: "start" | "end", date: string) => {
    if (!date) return;
    try {
      const list = await loadAllBreaks();
      const inBreak = (d: string) => list.some(b => d >= b.startDate && d <= b.endDate);
      if (inBreak(date)) { setError(`${shortDate(date)} is in a term break: pick a teaching day.`); return; }
      const weeks = order.map(o => o.weeks);
      changeStart(edge === "start" ? courseStartFor(date, index, weeks, inBreak) : courseStartForEnd(date, index, weeks, inBreak));
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "The term breaks could not be read."); }
  };
  const changeOrder = (next: { unitId: string; weeks: number }[]) => { setOrder(next); setSaved(false); void preview(start, next); };
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= order.length) return;
    const next = [...order]; [next[index], next[to]] = [next[to], next[index]];
    changeOrder(next);
  };


  const breakProblem = (d: typeof emptyDraft, except?: string) => !d.label.trim() ? "Enter a name." : !d.startDate || !d.endDate ? "Enter the first and last day."
    : d.endDate < d.startDate ? "The last day must be on or after the first day."
    : overlapping(breaks, d.startDate, d.endDate, except).map(b => `These days overlap "${b.label}" (${shortDate(b.startDate)} to ${shortDate(b.endDate)}).`)[0] ?? "";
  const draftProblem = breakProblem(draft);
  const editProblem = editing ? breakProblem(editing, editing.id) : "";
  const saveBreak = async () => {
    if (!editing || busy || editProblem) return;
    if (!editing.courseId && !window.confirm(`"${editing.label.trim()}" is a term break for every course. Change it for every course?`)) return;
    setBusy(true); setError("");
    const values = { label: editing.label.trim(), start_date: editing.startDate, end_date: editing.endDate };
    const { error: e } = await supabase.from("academic_breaks").update(values).eq("id", editing.id);
    setBusy(false);
    if (e) { setError(e.message); return; }
    const changed = editing;
    setMaster(m => (m ? { ...m, breaks: m.breaks.map(b => (b.id === changed.id ? { ...b, label: changed.label.trim(), startDate: changed.startDate, endDate: changed.endDate } : b)) } : m));
    setEditing(null); setSaved(false);
    await preview(start);
  };
  const addBreak = async () => {
    if (busy || draftProblem) return;
    setBusy(true); setError("");
    const { data, error: e } = await supabase.from("academic_breaks")
      .insert({ label: draft.label.trim(), start_date: draft.startDate, end_date: draft.endDate, course_id: course.id }).select("id").single();
    setBusy(false);
    if (e) { setError(e.message); return; }
    const added: Break = { id: (data as { id: string }).id, label: draft.label.trim(), startDate: draft.startDate, endDate: draft.endDate, courseId: course.id };
    setMaster(m => (m ? { ...m, breaks: [...m.breaks, added] } : m));
    setDraft(emptyDraft); setSaved(false);
    await preview(start);
  };
  const removeBreak = async (item: Break) => {
    if (busy || !window.confirm(`Remove the term break "${item.label}" (${shortDate(item.startDate)} to ${shortDate(item.endDate)})${item.courseId ? "" : " for EVERY course"}?`)) return;
    setBusy(true); setError("");
    const { error: e } = await supabase.from("academic_breaks").delete().eq("id", item.id);
    setBusy(false);
    if (e) { setError(e.message); return; }
    setMaster(m => (m ? { ...m, breaks: m.breaks.filter(b => b.id !== item.id) } : m));
    setSaved(false);
    await preview(start);
  };

  /** Saves the dates; in the wizard, Save and next goes on to the next step at once. */
  const save = async (next = false) => {
    if (busy || !start || !order.length) return;
    setBusy(true); setError("");
    try {
      setMaster(await call("save", { courseId: course.id, startDate: start, rows: order }));
      // Saving keeps only the current cycle: the later ones are built again for the cycles chosen.
      try { setPlan(await cyclesCall("set", { courseId: course.id, cycles })); }
      catch (e) { if (!(e instanceof CyclesUnavailable)) throw e; }
      setSaved(true); if (next && nextStep) nextStep.onClick();
    }
    catch (e) { setError(e instanceof Error ? e.message : "The dates were not saved."); }
    finally { setBusy(false); }
  };

  // Units in order, each preceded by the term breaks that begin before it starts.
  const lines = useMemo(() => {
    const byId = new Map((master?.rows ?? []).map(r => [r.unitId, r]));
    const inRange = breaks.filter(b => !master?.endDate || b.startDate <= master.endDate);
    const used = new Set<string>();
    const out: ({ kind: "unit"; row: Row; n: number } | { kind: "break"; item: Break })[] = [];
    order.forEach((o, i) => {
      const row = byId.get(o.unitId);
      if (!row) return;
      if (row.startDate) for (const b of inRange) if (!used.has(b.id) && b.startDate < row.startDate) { used.add(b.id); out.push({ kind: "break", item: b }); }
      out.push({ kind: "unit", row, n: i + 1 });
    });
    return out;
  }, [master, breaks, order]);

  const canEdit = !!master?.canEdit;
  const problems = master?.problems ?? [];
  const totalHours = (master?.rows ?? []).reduce((t, r) => t + (r.hours ?? 0), 0);
  const blocked = busy || !master || !canEdit || !start || !order.length || order.some(o => !(o.weeks > 0)) || problems.length > 0;
  const totalWeeks = order.reduce((t, o) => t + (o.weeks || 0), 0);

  return <Modal open keepOpen={!!stepLabel} title={`${stepLabel ? stepLabel + " · " : ""}CoE weekly calendar · ${course.code}`} width="max-w-5xl" onClose={() => { if (!busy) onClose(); }}
    footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-foreground-700">{start ? <><b>Starts {shortDate(start)}</b> · one cycle of {order.length} units, {weeksLabel(totalWeeks)} classroom weeks, then the units start again · {cycles} cycle{cycles === 1 ? "" : "s"}</> : "Enter the start date to see the dates."}</span>
      <div className="flex gap-2">
        {backStep ? <Button variant="outline" icon="ri-arrow-left-line" disabled={busy} onClick={backStep.onClick}>{backStep.label}</Button> : null}
        {nextStep
          ? saved ? <Button icon="ri-arrow-right-line" onClick={nextStep.onClick}>{nextStep.label}</Button>
            : <Button icon="ri-save-line" disabled={blocked} onClick={() => void save(true)}>{busy ? "Saving…" : `Save and ${nextStep.label.replace(/^Next/, "next")}`}</Button>
          : saved ? <Button variant="outline" onClick={onClose}>Done</Button>
            : <><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
              <Button disabled={blocked} onClick={() => void save()}>{busy ? "Saving…" : "Save dates"}</Button></>}
      </div>
    </div>}>
    {error ? <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {saved ? <p role="status" className="mb-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">Saved. This is now the master timetable of {course.code}; every intake follows these dates, and the units run again in the next cycle.</p> : null}
    {!master && !error ? <p className="text-sm text-foreground-500">Loading the units…</p> : master ? <div className="space-y-5">
      {problems.length ? <ul role="alert" className="list-disc rounded-lg border border-red-200 bg-red-50 py-2 pl-8 pr-3 text-sm text-red-700">{problems.map(p => <li key={p}>{p}</li>)}</ul> : null}

      <section className="space-y-3">
        <h3 className="text-sm font-bold text-foreground-950">1. Start date and plan</h3>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-foreground-800">Course starts
            <BreakDateField label="Start date" className="border-2 border-primary-300 font-semibold" value={start} disabled={!canEdit || busy} onChange={changeStart}
              breaks={breaks} breakNote="the course cannot start in a term break" /></label>
          <p className="text-sm text-foreground-700">One cycle: <b>{weeksLabel(totalWeeks)} teaching weeks</b>
            {start && master.endDate ? <> · {Math.round(((Date.parse(master.endDate) - Date.parse(start)) / 86400000 + 1) / 7)} weeks with breaks · ends <b>{shortDate(master.endDate)}</b></> : null}</p>
          <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-800" title={`Every unit's weeks are its SLIT hours ÷ ${COE_HOURS}`}>CoE · {COE_HOURS} h a week</span>
        </div>
        <MasterCyclesPanel cycles={cycles} onCycles={value => { setCycles(value); setSaved(false); }} start={start} cycleEnd={master.endDate} plan={plan} canEdit={canEdit} busy={busy} />
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-bold text-foreground-950">2. Term breaks</h3>
          {canEdit ? <div role="radiogroup" aria-label="How to enter term breaks" className="inline-flex rounded-md bg-background-200 p-0.5">
            {([["auto", "Automatic (Victorian school calendar)"], ["manual", "Manual"]] as const).map(([key, label]) => <button key={key} type="button" role="radio" aria-checked={breakMode === key}
              onClick={() => setBreakMode(key)} className={"rounded px-2.5 py-1 text-xs font-semibold " + (breakMode === key ? "bg-background-50 text-foreground-950 shadow-sm" : "text-foreground-600 hover:text-foreground-900")}>{label}</button>)}
          </div> : null}
        </div>
        {canEdit && breakMode === "auto" ? <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary-200 bg-primary-50/60 px-3 py-2">
          <FillSchoolBreaksButton courseId={course.id} from={start} to={planTill(start, master.endDate, cycles, plan).till} disabled={busy}
            onAdded={async () => { setSaved(false); await preview(start); }} />
          <span className="text-xs text-foreground-600">Victorian school holidays become term breaks of {course.code} only, for every year of the plan (years not yet published are forecast).</span>
        </div> : null}
        <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[620px] text-sm">
            <thead className="bg-background-100"><tr><th className={th}>Name</th><th className={th}>First day</th><th className={th}>Last day</th><th className={th + " text-right"}>Weeks</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {breaks.map(b => editing?.id === b.id ? <tr key={b.id} className="border-t border-background-100 bg-primary-50/50">
                <td className="px-2 py-1.5"><input aria-label="Term break name" maxLength={80} className={input + " w-full"} value={editing.label} disabled={busy} onChange={e => setEditing({ ...editing, label: e.target.value })} />
                  {!b.courseId ? <span className="mt-0.5 block text-xs text-amber-800">For every course</span> : null}</td>
                <td className="px-2 py-1.5"><BreakDateField label="First day" value={editing.startDate} disabled={busy} onChange={d => setEditing({ ...editing, startDate: d, endDate: editing.endDate && editing.endDate < d ? "" : editing.endDate })}
                  breaks={breaks.filter(x => x.id !== editing.id)} breakNote="already a term break" /></td>
                <td className="px-2 py-1.5"><BreakDateField label="Last day" value={editing.endDate} disabled={busy} onChange={d => setEditing({ ...editing, endDate: d })} today={editing.startDate || undefined} earlyNote="Before the first day"
                  breaks={breaks.filter(x => x.id !== editing.id)} breakNote="already a term break" /></td>
                <td className="px-2 py-1.5 text-right text-foreground-500">{editing.startDate && editing.endDate && editing.endDate >= editing.startDate ? weeksOf(editing.startDate, editing.endDate) : ""}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">
                  <button type="button" disabled={busy || !!editProblem} onClick={() => void saveBreak()} title={editProblem || undefined} className="rounded-lg bg-primary-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-primary-700 disabled:opacity-50">Save</button>
                  <button type="button" disabled={busy} onClick={() => setEditing(null)} className="ml-1 rounded-lg border border-background-300 px-2.5 py-1 text-xs font-semibold text-foreground-800 hover:bg-background-100">Cancel</button>
                </td>
              </tr> : <tr key={b.id} className="border-t border-background-100">
                <td className="px-2 py-1.5 font-semibold text-foreground-950">{b.label}{b.courseId ? "" : <span className="ml-1 text-xs font-normal text-foreground-500">(all courses)</span>}</td>
                <td className="whitespace-nowrap px-2 py-1.5">{shortDate(b.startDate)}</td><td className="whitespace-nowrap px-2 py-1.5">{shortDate(b.endDate)}</td>
                <td className="px-2 py-1.5 text-right">{weeksOf(b.startDate, b.endDate)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">{canEdit ? <>
                  <button type="button" disabled={busy || !!editing} onClick={() => setEditing({ id: b.id, courseId: b.courseId, label: b.label, startDate: b.startDate, endDate: b.endDate })} aria-label={`Change ${b.label}`}
                    className="rounded p-1 text-foreground-700 hover:bg-background-100 disabled:opacity-50"><i className="ri-pencil-line" aria-hidden="true" /></button>
                  <button type="button" disabled={busy || !!editing} onClick={() => void removeBreak(b)} aria-label={`Remove ${b.label}`}
                    className="rounded p-1 text-red-700 hover:bg-red-50 disabled:opacity-50"><i className="ri-delete-bin-line" aria-hidden="true" /></button></> : null}</td>
              </tr>)}
              {canEdit && breakMode === "manual" ? <tr className="border-t border-background-100 bg-background-50">
                <td className="px-2 py-1.5"><input aria-label="New term break name" placeholder="e.g. Summer break" maxLength={80} className={input + " w-full"} value={draft.label} disabled={busy} onChange={e => setDraft({ ...draft, label: e.target.value })} /></td>
                <td className="px-2 py-1.5"><BreakDateField label="New term break first day" value={draft.startDate} disabled={busy} onChange={d => setDraft({ ...draft, startDate: d, endDate: draft.endDate && draft.endDate < d ? "" : draft.endDate })}
                  breaks={breaks} breakNote="already a term break" /></td>
                <td className="px-2 py-1.5"><BreakDateField label="New term break last day" value={draft.endDate} disabled={busy} onChange={d => setDraft({ ...draft, endDate: d })} today={draft.startDate || undefined} earlyNote="Before the first day"
                  breaks={breaks} breakNote="already a term break" /></td>
                <td className="px-2 py-1.5 text-right text-foreground-500">{draft.startDate && draft.endDate && !draftProblem ? weeksOf(draft.startDate, draft.endDate) : ""}</td>
                <td className="px-2 py-1.5 text-right"><button type="button" disabled={busy || !!draftProblem} onClick={() => void addBreak()} title={draftProblem || undefined}
                  className="rounded-lg bg-primary-600 px-3 py-1 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">Add</button></td>
              </tr> : null}
            </tbody>
          </table>
          {!breaks.length && !canEdit ? <p className="p-3 text-center text-sm text-foreground-500">No term breaks.</p> : null}
        </div>
        {editProblem && editing?.startDate && editing.endDate ? <p role="alert" className="mt-1 text-xs font-semibold text-red-700">{editProblem}</p>
          : draftProblem && draft.startDate && draft.endDate ? <p role="alert" className="mt-1 text-xs font-semibold text-red-700">{draftProblem}</p> : null}
        <p className="mt-1 text-xs text-foreground-500">Days inside a term break are not counted: the unit dates move past them. Two breaks cannot share a day. A break marked (all courses) is changed for every course.</p>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-bold text-foreground-950">3. Master timetable <span className="font-normal text-foreground-500">(first cycle)</span></h3>
        {!order.length ? <p className="rounded-lg border border-background-200 p-4 text-center text-sm text-foreground-500">This course has no active units. Add units first.</p>
          : <div className="max-h-[40vh] overflow-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="sticky top-0 bg-background-100"><tr><th className={th}>#</th><th className={th}>Unit</th><th className={th + " text-right"}>SLIT hours</th><th className={th + " text-right"}>Weeks</th><th className={th}>Pre-requisite</th><th className={th}>Start date</th><th className={th}>End date</th>{canEdit ? <th className={th}><span className="sr-only">Move</span></th> : null}</tr></thead>
            <tbody>{lines.map(l => l.kind === "break"
              ? <tr key={"b:" + l.item.id} className="border-t border-background-100 bg-amber-100 text-amber-950">
                <td className="px-2 py-1.5" /><td className="px-2 py-1.5 font-semibold" colSpan={2}>{l.item.label}</td>
                <td className="px-2 py-1.5 text-right">{weeksOf(l.item.startDate, l.item.endDate)}</td><td className="px-2 py-1.5" />
                <td className="whitespace-nowrap px-2 py-1.5">{shortDate(l.item.startDate)}</td><td className="whitespace-nowrap px-2 py-1.5">{shortDate(l.item.endDate)}</td>{canEdit ? <td /> : null}</tr>
              : <tr key={l.row.unitId} className="border-t border-background-100">
                <td className="px-2 py-1.5 text-foreground-500">{l.n}</td>
                <td className="px-2 py-1.5"><span className="font-semibold text-foreground-950">{l.row.code}</span><span className="block max-w-[280px] truncate text-xs text-foreground-600" title={l.row.name}>{l.row.name}</span></td>
                <td className="px-2 py-1.5 text-right">{l.row.hours ?? "—"}</td>
                <td className="px-2 py-1.5 text-right">{weeksLabel(order[l.n - 1]?.weeks ?? Number(l.row.weeks))}</td>
                <td className="px-2 py-1.5 text-xs text-foreground-700">{l.row.prerequisites.join(", ")}</td>
                <td className="whitespace-nowrap px-2 py-1">{canEdit && start && l.row.startDate
                  ? <BreakDateField label={`Start date for ${l.row.code}`} value={l.row.startDate} disabled={busy} breaks={allBreaks} breakNote="a unit cannot start in a term break"
                    onChange={d => void moveUnitTo(l.n - 1, "start", d)} />
                  : start && l.row.startDate ? shortDate(l.row.startDate) : "—"}</td>
                <td className="whitespace-nowrap px-2 py-1">{canEdit && start && l.row.endDate
                  ? <BreakDateField label={`End date for ${l.row.code}`} value={l.row.endDate} disabled={busy} breaks={allBreaks} breakNote="a unit cannot end in a term break"
                    onChange={d => void moveUnitTo(l.n - 1, "end", d)} />
                  : start && l.row.endDate ? shortDate(l.row.endDate) : "—"}</td>
                {canEdit ? <td className="whitespace-nowrap px-1 py-1.5 text-right">
                  <button type="button" disabled={busy || l.n === 1} onClick={() => move(l.n - 1, -1)} aria-label={`Move ${l.row.code} up`} className="rounded p-1 text-foreground-700 hover:bg-background-200 disabled:opacity-30"><i className="ri-arrow-up-line" aria-hidden="true" /></button>
                  <button type="button" disabled={busy || l.n === order.length} onClick={() => move(l.n - 1, 1)} aria-label={`Move ${l.row.code} down`} className="rounded p-1 text-foreground-700 hover:bg-background-200 disabled:opacity-30"><i className="ri-arrow-down-line" aria-hidden="true" /></button>
                </td> : null}
              </tr>)}</tbody>
          </table>
        </div>}
        <p className="mt-1 text-xs text-foreground-500">Weeks are fixed (SLIT hours ÷ 20). Change any unit's start or end date and the whole timetable moves with it; move a unit with the arrows. A unit cannot come before a unit it needs.</p>
      </section>
    </div> : null}
  </Modal>;
}
