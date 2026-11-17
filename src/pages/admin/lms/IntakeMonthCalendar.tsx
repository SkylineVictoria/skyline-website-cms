import { useMemo, useState } from "react";
import { addDays, mondayOf, parseDay, shortDate, todayIso, type ScheduleRow } from "@/pages/admin/lib/rto";

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const monthLabel = new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
const monthOf = (date: string) => date.slice(0, 7) + "-01";

export default function IntakeMonthCalendar({ schedule, onAdd }: {
  schedule: ScheduleRow[];
  onAdd: (unitId: string) => void;
}) {
  const [selectedMonth, setSelectedMonth] = useState<string>();
  const today = todayIso();
  const events = useMemo(() => {
    const byDate = new Map<string, { unit: ScheduleRow; kind: "Starts" | "Finishes" | "Starts and finishes" }[]>();
    const push = (date: string, unit: ScheduleRow, kind: "Starts" | "Finishes" | "Starts and finishes") => {
      const day = byDate.get(date) ?? [];
      day.push({ unit, kind });
      byDate.set(date, day);
    };
    for (const unit of schedule) {
      if (unit.startDate === unit.endDate) push(unit.startDate, unit, "Starts and finishes");
      else {
        push(unit.startDate, unit, "Starts");
        push(unit.endDate, unit, "Finishes");
      }
    }
    return byDate;
  }, [schedule]);
  const dates = Array.from(events.keys()).sort();
  if (!dates.length) return <section id="intake-calendar" aria-label="Intake calendar" className="col-span-full rounded-2xl border border-background-200 bg-background-50 p-4">
    <h2 className="font-heading text-lg font-bold text-foreground-950">Intake calendar</h2>
    <p className="mt-1 text-sm text-foreground-600">There are no scheduled unit dates for this intake.</p>
  </section>;

  const first = monthOf(dates[0]);
  const last = monthOf(dates[dates.length - 1]);
  const current = monthOf(today);
  const initial = current < first || current > last ? first : current;
  const month = selectedMonth && selectedMonth >= first && selectedMonth <= last ? selectedMonth : initial;
  const date = new Date(parseDay(month));
  const monthName = monthLabel.format(date);
  const shiftMonth = (direction: number) => setSelectedMonth(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, 1)).toISOString().slice(0, 10));
  const gridStart = mondayOf(month);
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));

  return <section id="intake-calendar" aria-label="Intake calendar" className="col-span-full min-w-0 scroll-mt-20 rounded-2xl border border-background-200 bg-background-50 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-heading text-lg font-bold text-foreground-950">Intake calendar</h2>
        <p className="text-sm text-foreground-600">{shortDate(dates[0])} – {shortDate(dates[dates.length - 1])}</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous month" disabled={month === first} onClick={() => shiftMonth(-1)}
          className="rounded-lg border border-background-300 px-3 py-2 disabled:opacity-40">‹</button>
        <span className="min-w-28 text-center text-sm font-semibold" aria-live="polite">{monthName}</span>
        <button type="button" aria-label="Next month" disabled={month === last} onClick={() => shiftMonth(1)}
          className="rounded-lg border border-background-300 px-3 py-2 disabled:opacity-40">›</button>
      </div>
    </div>
    <div className="mt-3 overflow-x-auto">
      <div className="min-w-[480px]">
        <div className="grid grid-cols-7 text-center text-xs font-semibold text-foreground-600">
          {weekdays.map(day => <span key={day} className="py-2">{day}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-background-200 bg-background-200">
          {days.map(day => monthOf(day) !== month
            ? <div key={day} aria-hidden="true" className="min-h-16 bg-background-100" />
            : <div key={day} className={`min-h-16 min-w-0 space-y-1 p-1.5 ${day === today ? "bg-primary-50" : "bg-background-50"}`}>
              <time dateTime={day} aria-current={day === today ? "date" : undefined} className="block text-xs font-semibold text-foreground-700">{Number(day.slice(8))}</time>
              {events.get(day)?.map(({ unit, kind }) => <button key={unit.id} type="button" onClick={() => onAdd(unit.unitId)}
                aria-label={`${kind} ${unit.code} on ${shortDate(day)}. Add students`} title={unit.name}
                className={`block w-full break-words rounded px-1 py-1 text-left text-xs font-semibold hover:underline ${kind === "Finishes" ? "bg-background-200 text-foreground-800" : "bg-primary-100 text-primary-900"}`}>
                {kind} {unit.code}
              </button>)}
            </div>)}
        </div>
      </div>
    </div>
  </section>;
}
