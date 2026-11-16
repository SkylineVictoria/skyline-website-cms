// A month calendar for picking a start date: term-break days are greyed out and cannot be picked, nor can past days or
// days listed in `taken` (for example the start of another intake of the same course).
import { useEffect, useState } from "react";
import type { AcademicBreak } from "@/pages/admin/lib/rto";

const DAY = 86_400_000;
const parse = (s: string) => new Date(s + "T00:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (s: string) => s.slice(0, 7) + "-01";
const shiftMonth = (s: string, n: number) => { const d = parse(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };

export default function BreakDatePicker({ value, onChange, breaks, taken, takenLabel = "Taken", today }: {
  value: string;
  onChange: (date: string) => void;
  breaks: AcademicBreak[];
  taken?: Set<string>;
  takenLabel?: string;
  /** The earliest date that can be picked (yyyy-mm-dd). */
  today: string;
}) {
  const [month, setMonth] = useState(() => monthStart(value || today));
  // Show the month of a date filled in from outside (such as the suggested next term start).
  useEffect(() => { if (value) setMonth(monthStart(value)); }, [value]);
  const shown = month;
  const first = parse(shown);
  const lead = (first.getUTCDay() + 6) % 7; // days before the 1st, weeks starting Monday
  const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells = Array.from({ length: Math.ceil((lead + daysInMonth) / 7) * 7 }, (_, i) => {
    const n = i - lead;
    return n < 0 || n >= daysInMonth ? null : iso(new Date(first.getTime() + n * DAY));
  });
  const breakOf = (d: string) => breaks.find((b) => d >= b.startDate && d <= b.endDate);
  const title = first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const nav = "rounded-md p-1.5 text-foreground-600 hover:bg-background-100 disabled:opacity-30";

  return (
    <div data-break-picker className="rounded-lg border border-background-300 bg-background-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" className={nav} aria-label="Previous month" disabled={shown <= monthStart(today)} onClick={() => setMonth(shiftMonth(shown, -1))}><i className="ri-arrow-left-s-line text-lg" aria-hidden="true" /></button>
        <p className="text-sm font-semibold text-foreground-900">{title}</p>
        <button type="button" className={nav} aria-label="Next month" onClick={() => setMonth(shiftMonth(shown, 1))}><i className="ri-arrow-right-s-line text-lg" aria-hidden="true" /></button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs" role="grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d} className="py-1 font-semibold text-foreground-500">{d}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const inBreak = breakOf(d);
          const isTaken = taken?.has(d);
          const past = d < today;
          const blocked = !!inBreak || !!isTaken || past;
          const selected = d === value;
          return (
            <button key={d} type="button" disabled={blocked} onClick={() => onChange(d)} aria-pressed={selected}
              title={inBreak ? `${inBreak.label}: no intake can start` : isTaken ? takenLabel : past ? "In the past" : undefined}
              className={`rounded-md py-1.5 text-sm ${selected ? "bg-primary-600 font-bold text-white"
                : inBreak ? "cursor-not-allowed bg-background-200 text-foreground-400 line-through"
                : isTaken ? "cursor-not-allowed bg-amber-50 text-amber-700 line-through"
                : past ? "cursor-not-allowed text-foreground-300"
                : "font-medium text-foreground-900 hover:bg-primary-50 hover:text-primary-700"}`}>
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-foreground-500">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-background-200" />Term break</span>
        {taken?.size ? <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-amber-100" />{takenLabel}</span> : null}
      </div>
    </div>
  );
}
