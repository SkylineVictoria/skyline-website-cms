// VoE weekly calendar (owner, 2026-11-20): the step after the CoE calendar in course setup. Same units, order, start date and
// term breaks as the saved CoE calendar, but a VoE student may study up to 40 hours a week: at most two units at the same time,
// their weekly hours adding up to 40 or less. Allocation: Automatic (every week filled to 40 h: one unit 40 h, or two 20 h + 20 h)
// or Manual (staff choose each unit's hours a week); over 40 h is blocked either way. The dates and the week-by-week check follow
// (voeLayout / voeWeeks) and are saved as the course's VoE calendar (rto_voe_calendar, migration 20261121021000).
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import { shortDate } from "@/pages/admin/lib/rto";
import { VOE_MAX_HOURS, VOE_MAX_UNITS, voeLayout, voeWeeks, type VoeMethod } from "@/pages/admin/lib/masterDates";

interface Row { unitId: string; code: string; name: string; hours: number | null; prerequisites: string[]; endDate: string | null }
interface Master { saved: boolean; startDate: string | null; endDate: string | null; rows: Row[] }
const RATES = [10, 15, 20, 25, 30, 35, 40];
const th = "px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground-500";
const weeksLabel = (days: number) => { const w = Math.round((days / 7) * 10) / 10; return Number.isInteger(w) ? String(w) : w.toFixed(1); };

export default function VoeCalendarEditor({ course, stepLabel, onClose, nextStep, backStep, inline = false, onSavedChange }: {
  course: { id: string; code: string }; stepLabel?: string; onClose: () => void;
  /** Shown in the course's VoE Weekly Calendar tab instead of a dialog (owner, 2026-11-20). */
  inline?: boolean; onSavedChange?: () => void;
  nextStep?: { label: string; onClick: () => void }; backStep?: { label: string; onClick: () => void };
}) {
  const [master, setMaster] = useState<Master | null>(null);
  const [breaks, setBreaks] = useState<{ startDate: string; endDate: string }[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<VoeMethod>("automatic");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      const [m, b] = await Promise.all([
        supabase.rpc("rto_master_timetable", { p_action: "get", p_data: { courseId: course.id } }),
        supabase.from("academic_breaks").select("start_date,end_date").or(`course_id.is.null,course_id.eq.${course.id}`),
      ]);
      if (!live) return;
      if (m.error || b.error) { setError((m.error ?? b.error)!.message); return; }
      // The saved VoE calendar, when there is one: its allocation and (manual) each unit's hours a week.
      const v = await supabase.rpc("rto_voe_calendar", { p_action: "get", p_data: { courseId: course.id } });
      if (!live) return;
      if (v.error?.code === "PGRST202") setMissing(true);
      else if (!v.error) {
        const saved = v.data as { saved: boolean; method: VoeMethod | null; updatedAt: string | null; rows: { unitId: string; rates: number[] }[] };
        if (saved.saved && saved.method) {
          setMethod(saved.method); setSavedAt(saved.updatedAt);
          if (saved.method === "manual") setRates(Object.fromEntries(saved.rows.map(r => [r.unitId, Number(r.rates[0]) || 20])));
        }
      }
      setMaster(m.data as Master);
      setBreaks(((b.data ?? []) as { start_date: string; end_date: string }[]).map(x => ({ startDate: x.start_date, endDate: x.end_date })));
    })();
    return () => { live = false; };
  }, [course.id]);

  const isBreak = useMemo(() => (d: string) => breaks.some(b => d >= b.startDate && d <= b.endDate), [breaks]);
  const start = master?.startDate ?? "";
  const units = useMemo(() => (master?.rows ?? []).filter(r => (r.hours ?? 0) > 0)
    .map(r => ({ unitId: r.unitId, code: r.code, hours: r.hours ?? 0, rate: rates[r.unitId] ?? 20, prerequisites: r.prerequisites })), [master, rates]);
  const plan = useMemo(() => (start ? voeLayout(units, start, isBreak, method) : null), [units, start, isBreak, method]);
  const rows = plan?.rows ?? [];
  const weeks = useMemo(() => (plan && start ? voeWeeks(plan, start, isBreak) : []), [plan, start, isBreak]);
  const names = useMemo(() => new Map((master?.rows ?? []).map(r => [r.unitId, r.name])), [master]);
  const voeEnd = rows.reduce((m, r) => (r.endDate > m ? r.endDate : m), "");
  const bad = weeks.filter(w => !w.ok);
  const spanWeeks = (from: string, to: string) => Math.round(((Date.parse(to) - Date.parse(from)) / 86400000 + 1) / 7);
  /** Saves the VoE calendar on screen; true when saved. */
  const save = async () => {
    if (!plan || !start || busy) return false;
    setBusy(true); setError("");
    const { error: e } = await supabase.rpc("rto_voe_calendar", { p_action: "save", p_data: { courseId: course.id, method, startDate: start,
      rows: plan.rows.map(r => ({ unitId: r.unitId, rates: r.rates, startDate: r.startDate, endDate: r.endDate })) } });
    setBusy(false);
    if (e?.code === "PGRST202") { setMissing(true); return false; }
    if (e) { setError(e.message); return false; }
    setSavedAt(new Date().toISOString()); setDirty(false); onSavedChange?.();
    return true;
  };
  const setAll = (rate: number) => setRates(Object.fromEntries((master?.rows ?? []).map(r => [r.unitId, rate])));

  const footer = <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-foreground-700">{voeEnd ? <><b>VoE ends {shortDate(voeEnd)}</b> · CoE ends {master?.endDate ? shortDate(master.endDate) : "—"}{bad.length ? <span className="ml-2 font-semibold text-red-700">{bad.length} week{bad.length === 1 ? "" : "s"} over the limit</span> : null}</> : "Save the CoE calendar first."}</span>
      <div className="flex gap-2">
        {backStep ? <Button variant="outline" icon="ri-arrow-left-line" onClick={backStep.onClick}>{backStep.label}</Button> : null}
        {missing && nextStep ? <Button variant="outline" onClick={nextStep.onClick}>Finish without saving VoE</Button> : null}
        {nextStep
          ? <Button icon="ri-save-line" disabled={busy || !!bad.length || !plan || missing} onClick={() => void save().then(ok => { if (ok) nextStep.onClick(); })}>{busy ? "Saving…" : nextStep.label}</Button>
          : <>{inline ? null : <Button variant="outline" disabled={busy} onClick={onClose}>Close</Button>}
            <Button icon="ri-save-line" disabled={busy || !!bad.length || !plan || missing || (!dirty && !!savedAt)} onClick={() => void save()}>{busy ? "Saving…" : "Save VoE calendar"}</Button></>}
      </div>
    </div>;
  const body = <>
    {error ? <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {missing ? <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The VoE calendar cannot be saved on this database yet (migration 20261121021000 is not installed). The dates below are worked out but not kept.</p> : null}
    {savedAt && !dirty && !missing ? <p role="status" className="mb-3 rounded-lg border border-green-200 bg-green-50 p-2 text-sm text-green-800">VoE calendar saved {new Date(savedAt).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}.</p> : null}
    {!master && !error ? <p className="text-sm text-foreground-500">Loading the CoE calendar…</p> : master ? <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className="text-sm text-foreground-700">Starts <b>{start ? shortDate(start) : "—"}</b> (as the CoE calendar) · same units, order and term breaks</p>
        <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-800">VoE · up to {VOE_MAX_HOURS} h a week · {VOE_MAX_UNITS} units at once</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-background-200 bg-background-100/60 px-3 py-2">
        <span className="text-sm font-semibold text-foreground-800">Allocation</span>
        <div role="radiogroup" aria-label="Allocation" className="inline-flex rounded-md bg-background-200 p-0.5">
          {([["automatic", "Automatic"], ["manual", "Manual"]] as const).map(([key, label]) => <button key={key} type="button" role="radio" aria-checked={method === key} onClick={() => { setMethod(key); setDirty(true); }}
            className={"rounded px-2.5 py-1 text-xs font-semibold " + (method === key ? "bg-background-50 text-foreground-950 shadow-sm" : "text-foreground-600 hover:text-foreground-900")}>{label}</button>)}
        </div>
        <span className="text-xs text-foreground-600">{method === "automatic"
          ? `Every week filled to ${VOE_MAX_HOURS} h: one unit at ${VOE_MAX_HOURS} h, or two units at ${VOE_MAX_HOURS / 2} h + ${VOE_MAX_HOURS / 2} h.`
          : `Choose each unit's hours a week; two units together up to ${VOE_MAX_HOURS} h (20 + 15, 30 + 10). A unit that would go over waits.`}</span>
        {method === "manual" ? <label className="ml-auto flex items-center gap-2 text-xs font-semibold text-foreground-700">Every unit at
          <select className="rounded-md border border-background-300 bg-background-50 px-2 py-1 text-xs" value="" onChange={e => { if (e.target.value) { setAll(Number(e.target.value)); setDirty(true); } }}>
            <option value="">h a week…</option>{RATES.map(r => <option key={r} value={r}>{r} h</option>)}</select></label> : null}
      </div>
      {!start ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The CoE calendar has no start date yet: go back and save it first.</p> : null}

      {start ? <div className="max-h-[42vh] overflow-auto rounded-lg border border-background-200">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="sticky top-0 bg-background-100"><tr><th className={th}>Unit</th><th className={th + " text-right"}>SLIT hours</th><th className={th}>Hours a week</th><th className={th + " text-right"}>Weeks</th><th className={th}>Start</th><th className={th}>End</th><th className={th}>Runs with</th></tr></thead>
          <tbody>{rows.map(r => <tr key={r.unitId} className="border-t border-background-100">
            <td className="px-2 py-1.5"><span className="font-semibold text-foreground-950">{r.code}</span><span className="block max-w-[260px] truncate text-xs text-foreground-600" title={names.get(r.unitId)}>{names.get(r.unitId)}</span>
              {r.prerequisites.length ? <span className="block text-xs text-foreground-500">After {r.prerequisites.join(", ")}</span> : null}</td>
            <td className="px-2 py-1.5 text-right">{r.hours}</td>
            <td className="px-2 py-1.5">{method === "manual"
              ? <select aria-label={`VoE hours a week for ${r.code}`} className="rounded-md border border-background-300 bg-background-50 px-2 py-1 text-sm"
                value={rates[r.unitId] ?? 20} onChange={e => { setRates(x => ({ ...x, [r.unitId]: Number(e.target.value) })); setDirty(true); }}>{RATES.map(v => <option key={v} value={v}>{v} h</option>)}</select>
              : <span className="text-foreground-800" title="Automatic: 40 h when the unit runs alone, 20 h beside another unit">{r.rates.join(" / ")} h</span>}</td>
            <td className="px-2 py-1.5 text-right">{weeksLabel(r.days)}</td>
            <td className="whitespace-nowrap px-2 py-1.5">{shortDate(r.startDate)}</td>
            <td className="whitespace-nowrap px-2 py-1.5">{shortDate(r.endDate)}</td>
            <td className="px-2 py-1.5 text-xs text-foreground-700">{r.alongside.join(", ") || "—"}</td>
          </tr>)}</tbody>
        </table>
      </div> : null}

      {start ? <details open={bad.length > 0}>
        <summary className="cursor-pointer text-sm font-semibold text-foreground-800">Week by week: {weeks.filter(w => w.teaching).length} teaching weeks
          {bad.length ? <span className="text-red-700"> · {bad.length} over {VOE_MAX_HOURS} h or {VOE_MAX_UNITS} units</span> : <span className="font-normal text-green-800"> · every week allowed</span>}
          <span className="font-normal text-foreground-500"> · VoE runs {voeEnd ? spanWeeks(start, voeEnd) : "—"} weeks, CoE {master.endDate ? spanWeeks(start, master.endDate) : "—"}</span></summary>
        <ul className="mt-2 max-h-60 divide-y divide-background-100 overflow-auto rounded-lg border border-background-200 text-xs">
          {weeks.map(w => <li key={w.from} className={"flex items-center justify-between gap-3 px-3 py-1.5 " + (!w.teaching ? "bg-amber-50 text-amber-900" : w.ok ? "" : "bg-red-50 text-red-800")}>
            <span className="w-40 shrink-0 font-semibold">{shortDate(w.from)} – {shortDate(w.to)}</span>
            <span className="min-w-0 flex-1">{!w.teaching ? "Term break" : w.units.map(u => `${u.code} ${u.rate} h`).join(" + ") || "—"}</span>
            <span className="w-24 shrink-0 text-right font-semibold">{w.teaching ? `${w.total} h` : ""} {w.teaching ? (w.ok ? "✅" : "❌") : ""}</span>
          </li>)}
        </ul>
      </details> : null}
      <p className="text-xs text-foreground-500">Allowed: one unit up to {VOE_MAX_HOURS} h a week, or two units together up to {VOE_MAX_HOURS} h (20 + 20, 30 + 10, 15 + 20). A unit starts once its prerequisites have ended. The VoE calendar is kept with the course; intakes still follow the CoE calendar.</p>
    </div> : null}
  </>;
  if (inline) return <div className="space-y-4">{body}<div className="border-t border-background-200 pt-3">{footer}</div></div>;
  return <Modal open keepOpen={!!stepLabel} title={`${stepLabel ? stepLabel + " · " : ""}VoE weekly calendar · ${course.code}`} width="max-w-5xl" onClose={onClose} footer={footer}>
    {body}
  </Modal>;
}

/** Course › VoE Weekly Calendar: the saved VoE calendar in short, and the editor. */
/** Course › VoE Weekly Calendar: the VoE screen itself (Automatic / Manual, hours, dates, week by week), saved from here. */
export function VoeTab({ course, canEdit }: { course: { id: string; code: string }; canEdit: boolean }) {
  return <div className="space-y-2">
    {canEdit ? null : <p className="text-xs text-foreground-500">Only an RTO Manager can save changes to the VoE weekly calendar.</p>}
    <VoeCalendarEditor course={course} inline onClose={() => undefined} />
  </div>;
}
