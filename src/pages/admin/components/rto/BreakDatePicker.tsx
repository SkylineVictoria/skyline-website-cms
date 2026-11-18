// A month calendar for picking a date: term-break days are greyed out and cannot be picked, nor can days before `today`
// (when given) or days listed in `taken` (for example the start of another intake of the same course).
// BreakDateField is the same calendar behind a button, for use inside tables and forms.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shortDate } from "@/pages/admin/lib/rto";

type BreakDays = { label: string; startDate: string; endDate: string };
const DAY = 86_400_000;
const parse = (s: string) => new Date(s + "T00:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (s: string) => s.slice(0, 7) + "-01";
const shiftMonth = (s: string, n: number) => { const d = parse(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };

interface PickerProps {
  value: string;
  onChange: (date: string) => void;
  breaks: BreakDays[];
  taken?: Set<string>;
  takenLabel?: string;
  /** The earliest date that can be picked (yyyy-mm-dd); without it any day can be. */
  today?: string;
  /** Why a term-break day cannot be picked (after the break's name). */
  breakNote?: string;
  /** Why a day before `today` cannot be picked. */
  earlyNote?: string;
}

export default function BreakDatePicker({ value, onChange, breaks, taken, takenLabel = "Taken", today, breakNote = "no intake can start", earlyNote = "In the past" }: PickerProps) {
  const [month, setMonth] = useState(() => monthStart(value || today || iso(new Date())));
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
        <button type="button" className={nav} aria-label="Previous month" disabled={!!today && shown <= monthStart(today)} onClick={() => setMonth(shiftMonth(shown, -1))}><i className="ri-arrow-left-s-line text-lg" aria-hidden="true" /></button>
        <p className="text-sm font-semibold text-foreground-900">{title}</p>
        <button type="button" className={nav} aria-label="Next month" onClick={() => setMonth(shiftMonth(shown, 1))}><i className="ri-arrow-right-s-line text-lg" aria-hidden="true" /></button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs" role="grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d} className="py-1 font-semibold text-foreground-500">{d}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const inBreak = breakOf(d);
          const isTaken = taken?.has(d);
          const past = !!today && d < today;
          const blocked = !!inBreak || !!isTaken || past;
          const selected = d === value;
          return (
            <button key={d} type="button" disabled={blocked} onClick={() => onChange(d)} aria-pressed={selected}
              title={inBreak ? `${inBreak.label}: ${breakNote}` : isTaken ? takenLabel : past ? earlyNote : undefined}
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

const WIDTH = 300, HEIGHT = 350;
/** A date shown on a button; clicking it opens the calendar above, where term-break days are greyed out. */
export function BreakDateField({ label, disabled, className = "", ...picker }: PickerProps & { label: string; disabled?: boolean; className?: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    setAt({ top: r.bottom + HEIGHT + 8 > window.innerHeight ? Math.max(8, r.top - HEIGHT - 4) : r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)) });
  };
  useEffect(() => {
    if (!at) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setAt(null); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [at]);
  return <>
    <button ref={button} type="button" aria-label={label} aria-haspopup="dialog" disabled={disabled} onClick={open}
      className={"inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-2 py-1 text-sm disabled:opacity-60 " + className}>
      <span className={picker.value ? "" : "text-foreground-400"}>{picker.value ? shortDate(picker.value) : "Pick a date"}</span><i className="ri-calendar-line text-foreground-500" aria-hidden="true" />
    </button>
    {/* On <body>, above the modal: a table frame would clip it. */}
    {at ? createPortal(<div className="fixed inset-0 z-[95]" onMouseDown={() => setAt(null)}>
      <div role="dialog" aria-label={label} className="absolute rounded-lg shadow-xl" style={{ top: at.top, left: at.left, width: WIDTH }} onMouseDown={(e) => e.stopPropagation()}>
        <BreakDatePicker {...picker} onChange={(d) => { picker.onChange(d); setAt(null); }} />
      </div>
    </div>, document.body) : null}
  </>;
}
