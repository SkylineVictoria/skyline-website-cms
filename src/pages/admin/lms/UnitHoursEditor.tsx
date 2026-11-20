// Every selected unit's SLIT hours in one table: SLIT hours split into theory, practical and assessment (40 / 40 / 20 suggested
// from the nominal hours), with the weeks they take. Saving accepts the hours of every row and sets each unit's duration.
// Used from Courses > Units ("Edit all hours") and as step 3 of the new course wizard.
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { HOURS_PER_WEEK, loadUnitHours, rto, saveUnitHours, shownHours, suggestHours, weeksForHours, type CourseDetail, type HoursSplit, type RtoCourse, type RtoUnit, type UnitHours } from "@/pages/admin/lib/rto";

type Row = HoursSplit & { unit: RtoUnit; accepted: boolean; touched: boolean };
const PARTS = [["theoryHours", "Theory"], ["practicalHours", "Practical"], ["assessmentHours", "Assessment"]] as const;
const num = (v: string) => (v.trim() === "" ? 0 : Math.max(0, Math.round(Number(v) || 0)));

export default function UnitHoursEditor({ course, onClose, onSaved, stepLabel, nextStep, backStep }: {
  course: Pick<RtoCourse, "id" | "code" | "name">;
  onClose: () => void;
  onSaved: () => void;
  /** New course wizard: "Step 3 of 5 · Hours" in the title. */
  stepLabel?: string;
  /** New course wizard: hours are required, and the one button saves them and goes to this step. */
  nextStep?: { label: string; onClick: () => void };
  /** New course wizard: the step before this one. */
  backStep?: { label: string; onClick: () => void };
}) {
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([rto<CourseDetail>("course_get", { courseId: course.id }), loadUnitHours(course.id).catch((): UnitHours[] => [])])
      .then(([d, hours]) => {
        if (!live) return;
        const byId = new Map(hours.map(h => [h.unitId, h]));
        setDetail(d);
        setRows(d.units.filter(u => u.isActive && u.id).map(u => {
          const shown = shownHours(byId.get(u.id as string), u.nominalHours) ?? suggestHours(0);
          return { unit: u, slitHours: shown.slitHours, theoryHours: shown.theoryHours, practicalHours: shown.practicalHours,
            assessmentHours: shown.assessmentHours, accepted: !!byId.get(u.id as string)?.confirmedAt, touched: false };
        }));
      })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "The units could not be loaded."); });
    return () => { live = false; };
  }, [course.id]);

  const set = (i: number, patch: Partial<Row>) => setRows(list => list.map((r, k) => (k === i ? { ...r, ...patch, touched: true } : r)));
  const sumOf = (r: Row) => r.theoryHours + r.practicalHours + r.assessmentHours;
  const bad = rows.filter(r => r.slitHours <= 0 || sumOf(r) !== r.slitHours);
  const total = rows.reduce((t, r) => t + r.slitHours, 0);
  const toAccept = rows.filter(r => !r.accepted || r.touched).length;
  const weeks = useMemo(() => Math.ceil((total / HOURS_PER_WEEK) * 2) / 2, [total]);

  const fillFromNominal = () => setRows(list => list.map(r => (r.accepted || r.unit.nominalHours === null ? r
    : { ...r, ...suggestHours(r.unit.nominalHours), touched: true })));

  const save = async () => {
    if (busy || bad.length || !detail || !rows.length) return;
    setBusy(true); setError("");
    try {
      const durations = new Map<string, number>();
      const todo = rows.filter(r => !r.accepted || r.touched);
      // Six units at a time: one after another made a long course wait.
      for (let i = 0; i < todo.length; i += 6) {
        const done = await Promise.all(todo.slice(i, i + 6).map(async r => ({ r, out: await saveUnitHours(r.unit.id as string, { slitHours: r.slitHours, theoryHours: r.theoryHours, practicalHours: r.practicalHours, assessmentHours: r.assessmentHours }) })));
        for (const { r, out } of done) durations.set(out.unitId, weeksForHours(out.slitHours ?? r.slitHours));
      }
      // Each unit's duration follows its SLIT hours (20 hours a week).
      if (durations.size) await rto("units_save", { courseId: course.id, units: detail.units.map(u => (u.id && durations.has(u.id) ? { ...u, defaultWeeks: durations.get(u.id) } : u)) });
      setRows(list => list.map(r => ({ ...r, accepted: true, touched: false })));
      setSaved(true); onSaved();
      if (nextStep) nextStep.onClick();
    } catch (e) { setError(e instanceof Error ? e.message : "The hours were not saved."); }
    finally { setBusy(false); }
  };

  const cell = "w-20 rounded-md border border-background-300 bg-background-50 px-2 py-1 text-right text-sm";
  return <Modal open keepOpen={!!stepLabel} title={`${stepLabel ? stepLabel + " · " : ""}Unit hours · ${course.code}`} width="max-w-5xl" onClose={() => { if (!busy) onClose(); }}
    footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-foreground-700"><b>{total.toLocaleString()} SLIT hours</b> · about {weeks} weeks at {HOURS_PER_WEEK} hours a week (CoE)</span>
      <div className="flex gap-2">
        {backStep ? <Button variant="outline" icon="ri-arrow-left-line" disabled={busy} onClick={backStep.onClick}>{backStep.label}</Button> : null}
        {nextStep ? <Button icon="ri-calendar-event-line" disabled={busy || !detail || !!bad.length || !rows.length} onClick={() => void save()}>{busy ? "Saving…" : nextStep.label}</Button>
          : <><Button variant="outline" disabled={busy} onClick={onClose}>{saved ? "Close" : "Cancel"}</Button>
            <Button disabled={busy || !detail || !!bad.length || (!toAccept && !nextStep)} onClick={() => void save()}>{busy ? "Saving…" : `Save hours${toAccept ? ` (${toAccept})` : ""}`}</Button></>}
      </div>
    </div>}>
    {error ? <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {saved ? <p role="status" className="mb-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">Hours saved for every unit. Each unit's duration now follows its SLIT hours.</p> : null}
    {!detail && !error ? <p className="text-sm text-foreground-500">Loading the units…</p> : detail ? <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-600">{nextStep ? "Hours are required for every unit before the dates can be set. " : ""}Enter SLIT hours for each unit; theory, practical and assessment are suggested 40 / 40 / 20 and can be changed. They must add up to the SLIT hours.</p>
        <button type="button" disabled={busy} onClick={fillFromNominal} className="rounded-lg border border-primary-300 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-800 hover:bg-primary-100">
          Fill empty units from nominal hours</button>
      </div>
      {bad.length ? <p role="alert" className="text-sm font-semibold text-red-700">{bad.length} unit{bad.length === 1 ? "" : "s"} need fixing: SLIT hours above 0, and theory + practical + assessment equal to them.</p> : null}
      <div className="max-h-[55vh] overflow-auto rounded-lg border border-background-200">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="sticky top-0 bg-background-100"><tr className="text-xs font-semibold uppercase tracking-wide text-foreground-500">
            <th className="px-3 py-2">Unit</th><th className="px-2 py-2 text-right">Nominal</th><th className="px-2 py-2 text-right">SLIT hours</th>
            {PARTS.map(([, label]) => <th key={label} className="px-2 py-2 text-right">{label}</th>)}<th className="px-2 py-2 text-right">Weeks</th><th className="px-2 py-2" /></tr></thead>
          <tbody>{rows.map((r, i) => {
            const wrong = r.slitHours <= 0 || sumOf(r) !== r.slitHours;
            return <tr key={r.unit.id} className={"border-t border-background-100 " + (wrong ? "bg-red-50" : "")}>
              <td className="px-3 py-1.5"><span className="font-semibold text-foreground-950">{r.unit.code}</span>
                <span className="block max-w-[260px] truncate text-xs text-foreground-600" title={r.unit.name}>{r.unit.name}</span></td>
              <td className="px-2 py-1.5 text-right text-foreground-500">{r.unit.nominalHours ?? "—"}</td>
              <td className="px-2 py-1.5 text-right"><input aria-label={`${r.unit.code} SLIT hours`} inputMode="numeric" className={cell + " border-2 border-primary-300 font-semibold"} value={r.slitHours || ""}
                onChange={e => set(i, suggestHours(num(e.target.value)))} /></td>
              {PARTS.map(([key, label]) => <td key={key} className="px-2 py-1.5 text-right"><input aria-label={`${r.unit.code} ${label}`} inputMode="numeric" className={cell}
                value={r[key]} onChange={e => set(i, { [key]: num(e.target.value) } as Partial<Row>)} /></td>)}
              <td className="px-2 py-1.5 text-right text-foreground-600">{r.slitHours ? weeksForHours(r.slitHours) : "—"}</td>
              <td className="px-2 py-1.5 text-xs">{wrong ? <span className="font-semibold text-red-700">{r.slitHours <= 0 ? "Enter hours" : `${sumOf(r)} of ${r.slitHours}`}</span>
                : r.accepted && !r.touched ? <span className="text-green-700">Accepted</span> : <span className="text-amber-700">To save</span>}</td>
            </tr>;
          })}</tbody>
        </table>
        {!rows.length ? <p className="p-4 text-center text-sm text-foreground-500">No units are selected on this course yet. Add units first.</p> : null}
      </div>
    </div> : null}
  </Modal>;
}
