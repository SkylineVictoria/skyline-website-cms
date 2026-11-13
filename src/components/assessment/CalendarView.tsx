import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/pages/admin/components/ui";
import { asmCalendar, type CalendarEvent } from "@/lib/assessment/api";

const TZ = "Australia/Melbourne";
const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const timeOf = (iso: string) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const KIND: Record<string, { label: string; cls: string }> = {
  assessment_due: { label: "Due", cls: "bg-primary-100 text-primary-800 border-primary-200" },
  assessment_practical: { label: "Practical", cls: "bg-accent-100 text-accent-900 border-accent-200" },
  assessment_observation: { label: "Observation", cls: "bg-accent-100 text-accent-900 border-accent-200" },
  assessment_other: { label: "Assessment", cls: "bg-accent-100 text-accent-900 border-accent-200" },
  class: { label: "Class", cls: "bg-background-200 text-foreground-700 border-background-300" },
};

/** A month of assessment events and classes for the signed-in person (the database decides what they may see). */
export default function CalendarView({ batchId, compact = false }: { batchId?: string | null; compact?: boolean }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [year, mon] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, mon - 1, 1)); const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const from = `${month}-01`; const to = `${month}-${String(daysInMonth).padStart(2, "0")}`;

  const load = useCallback(async () => {
    try { setEvents(await asmCalendar(from, to, batchId ?? null)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "The calendar did not load."); }
  }, [from, to, batchId]);
  useEffect(() => { void load(); }, [load]);

  const byDay = useMemo(() => { const m = new Map<string, CalendarEvent[]>(); for (const e of events) { const k = dayKey(e.startsAt); m.set(k, [...(m.get(k) ?? []), e]); } return m; }, [events]);
  const shift = (d: number) => { const n = new Date(Date.UTC(year, mon - 1 + d, 1)); setMonth(`${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`); setSelected(null); };
  const title = first.toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
  const todayKey = dayKey(new Date().toISOString());
  const list = selected ? byDay.get(selected) ?? [] : events.slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return (
    <div className="space-y-3" data-testid="assessment-calendar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-base font-semibold text-foreground-950">{title}</h3>
        <div className="flex gap-1"><Button size="sm" variant="outline" icon="ri-arrow-left-s-line" aria-label="Previous month" onClick={() => shift(-1)} /><Button size="sm" variant="outline" onClick={() => { const d = new Date(); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); setSelected(null); }}>Today</Button><Button size="sm" variant="outline" icon="ri-arrow-right-s-line" aria-label="Next month" onClick={() => shift(1)} /></div>
      </div>
      {error ? <p role="alert" className="text-sm text-primary-700">{error}</p> : null}
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-background-200 bg-background-200 text-xs">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="bg-background-100 px-1 py-1 text-center font-medium text-foreground-600">{d}</div>)}
        {Array.from({ length: lead }, (_, i) => <div key={`lead-${i}`} className="bg-background-50" />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const k = `${month}-${String(i + 1).padStart(2, "0")}`; const items = byDay.get(k) ?? [];
          return (
            <button key={k} type="button" onClick={() => setSelected(selected === k ? null : k)} className={`min-h-[3.5rem] bg-background-50 p-1 text-left align-top hover:bg-background-100 ${selected === k ? "ring-2 ring-inset ring-primary-400" : ""}`}>
              <span className={`inline-block rounded px-1 ${k === todayKey ? "bg-primary-500 text-background-50" : "text-foreground-700"}`}>{i + 1}</span>
              {!compact ? <ul className="mt-0.5 space-y-0.5">{items.slice(0, 3).map((e, j) => <li key={j} className={`truncate rounded border px-1 ${KIND[e.kind]?.cls ?? KIND.class.cls}`}>{e.title}</li>)}{items.length > 3 ? <li className="text-foreground-500">+{items.length - 3} more</li> : null}</ul>
                : items.length ? <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary-500" /> : null}
            </button>
          );
        })}
      </div>
      <ul className="divide-y divide-background-100 rounded-md border border-background-200">
        {list.length === 0 ? <li className="px-3 py-3 text-sm text-foreground-600">{selected ? "Nothing on this day." : "Nothing this month."}</li> : null}
        {list.slice(0, 40).map((e, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${KIND[e.kind]?.cls ?? KIND.class.cls}`}>{KIND[e.kind]?.label ?? e.kind}</span>
            <span className="text-foreground-600">{dayKey(e.startsAt)} {timeOf(e.startsAt)}{e.endsAt ? `–${timeOf(e.endsAt)}` : ""}</span>
            <span className="min-w-0 flex-1 truncate text-foreground-900">{e.title}{e.batchName && e.kind !== "class" ? ` · ${e.batchName}` : ""}</span>
            {e.room ? <span className="text-xs text-foreground-500">{e.room}</span> : null}
            {e.trainer ? <span className="text-xs text-foreground-500">{e.trainer}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
