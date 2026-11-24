// Qualification cycles (owner, 2026-11-20): how far ahead the course is scheduled, chosen EITHER as a number of cycles OR as a
// "Calendar till" date; the other one is worked out (a date is rounded up to whole cycles). At most MAX_YEARS (Business Rules). RTO Managers are
// alerted weekly from ALERT_MONTHS before the end; from LOCK_MONTHS before it the course is locked until more is scheduled.
// FillSchoolBreaksButton adds the Victorian school holidays as term breaks for the years the plan covers.
import { useState } from "react";
import { shortDate } from "@/pages/admin/lib/rto";
import { VIC_DATES_SOURCE } from "@/pages/admin/lib/schoolTerms";
import { ALERT_MONTHS, LOCK_MONTHS, MAX_YEARS, cyclesUntil, fillSchoolBreaks, maxCyclesFor, planTill, type CyclePlan } from "@/pages/admin/lib/masterCycles";

const DAY = 86400000;
const addDays = (iso: string, days: number) => new Date(Date.parse(iso + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
const monthsBefore = (iso: string, months: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };
const field = "rounded-md border border-background-300 bg-background-50 px-2 py-1 text-sm disabled:opacity-60";

export default function MasterCyclesPanel({ cycles, onCycles, start, cycleEnd, plan, canEdit, busy }: {
  cycles: number; onCycles: (value: number) => void;
  /** First and last day of the current cycle on screen (saved or not). */
  start: string; cycleEnd: string | null;
  /** The saved plan, when there is one: its real last day and lock. */
  plan?: CyclePlan | null;
  canEdit: boolean; busy?: boolean;
}) {
  const [by, setBy] = useState<"cycles" | "till">("cycles");
  const [wanted, setWanted] = useState("");
  const { cycleDays, till, exact } = planTill(start, cycleEnd, cycles, plan);
  const maxCycles = maxCyclesFor(cycleDays);
  const latest = start ? addDays(start, Math.round(MAX_YEARS * 365.25) - 1) : undefined;
  const ready = canEdit && !busy && !!start && cycleDays > 0;
  const tab = (key: "cycles" | "till", label: string) => <button type="button" role="radio" aria-checked={by === key} disabled={!ready}
    onClick={() => { setBy(key); if (key === "till") setWanted(till ?? ""); }}
    className={"rounded px-2.5 py-1 text-xs font-semibold disabled:opacity-60 " + (by === key ? "bg-background-50 text-foreground-950 shadow-sm" : "text-foreground-600 hover:text-foreground-900")}>{label}</button>;

  return <div className={"rounded-lg border px-3 py-2.5 " + (plan?.locked ? "border-red-300 bg-red-50" : "border-background-200 bg-background-100/60")}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-sm font-semibold text-foreground-800">Plan by</span>
      <div role="radiogroup" aria-label="Plan by" className="inline-flex rounded-md bg-background-200 p-0.5">{tab("cycles", "Cycles")}{tab("till", "Calendar till")}</div>
      {by === "cycles"
        ? <input type="number" aria-label="Qualification cycles" min={1} max={maxCycles} step={1} className={field + " w-20 text-right"} value={cycles} disabled={!ready}
          onChange={e => { const n = Math.round(Number(e.target.value)); if (n >= 1) onCycles(Math.min(n, maxCycles)); }} />
        : <input type="date" aria-label="Calendar till" className={field} value={wanted} disabled={!ready} min={cycleEnd ?? undefined} max={latest}
          onChange={e => { setWanted(e.target.value); if (e.target.value && start) onCycles(Math.min(cyclesUntil(start, e.target.value, cycleDays), maxCycles)); }} />}
      <span className="text-sm text-foreground-800">
        {!start ? <span className="text-foreground-500">Pick the start date first.</span>
          : by === "cycles" ? <>until <b>{till ? shortDate(till) : "—"}</b></>
          : <>= <b>{cycles} cycle{cycles === 1 ? "" : "s"}</b>, until <b>{till ? shortDate(till) : "—"}</b></>}
        {till && !exact ? <span className="text-foreground-500"> (about)</span> : null}
      </span>
    </div>
    {till ? <p className="mt-1.5 text-xs text-foreground-600">Up to {MAX_YEARS} years ({maxCycles} cycles). Weekly reminder from {shortDate(monthsBefore(till, ALERT_MONTHS))} · course locked from {shortDate(monthsBefore(till, LOCK_MONTHS))} until more is planned.</p> : null}
    {plan?.locked ? <p role="alert" className="mt-1 text-sm font-semibold text-red-700"><i className="ri-lock-line mr-1" aria-hidden="true" />Locked: plan more cycles and save to unlock the course.</p> : null}
  </div>;
}

/** Automatic: the Victorian school holidays become term breaks of this course only, for `from` to `to`. Breaks already there are kept. */
export function FillSchoolBreaksButton({ courseId, from, to, disabled, onAdded }: { courseId: string; from: string; to: string | null; disabled?: boolean; onAdded: () => Promise<void> | void }) {
  const [filling, setFilling] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const fill = async () => {
    if (!from || !to || filling) return;
    setFilling(true); setNote(null);
    try {
      const b = await fillSchoolBreaks(courseId, from, to);
      setNote({ ok: true, text: b.added ? `${b.added} term break${b.added === 1 ? "" : "s"} added to this course${b.predicted ? ` (${b.predicted} forecast)` : ""}.` : "Term breaks are up to date." });
      await onAdded();
    } catch (e) { setNote({ ok: false, text: e instanceof Error ? e.message : "The school calendar could not be read." }); }
    finally { setFilling(false); }
  };
  return <span className="inline-flex flex-wrap items-center gap-2">
    <button type="button" disabled={disabled || filling || !from || !to} onClick={() => void fill()} title={`Source: ${VIC_DATES_SOURCE}; years not yet published are forecast`}
      className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-700 disabled:opacity-50">
      <i className={filling ? "ri-loader-4-line animate-spin" : "ri-sparkling-2-line"} aria-hidden="true" />{filling ? "Reading the school calendar…" : "Fill school holidays"}</button>
    {note ? <span role={note.ok ? "status" : "alert"} className={"text-xs " + (note.ok ? "text-green-800" : "text-red-700")}>{note.text}</span> : null}
  </span>;
}
