import { useEffect, useMemo } from "react";
import { shortDate, type AcademicBreak } from "@/pages/admin/lib/rto";

export type CalendarUnit = { unitId: string; code: string; name: string; startDate: string; endDate: string };

const COLORS = ["bg-sky-200 text-sky-900", "bg-amber-200 text-amber-900", "bg-emerald-200 text-emerald-900", "bg-violet-200 text-violet-900", "bg-rose-200 text-rose-900",
  "bg-lime-200 text-lime-900", "bg-cyan-200 text-cyan-900", "bg-orange-200 text-orange-900", "bg-fuchsia-200 text-fuchsia-900", "bg-teal-200 text-teal-900"];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(s + "T00:00:00Z");

/** An intake's units on a month-by-month calendar: each day coloured by its unit, weekends grey, public holidays and term breaks striped. Printable. */
export default function IntakeCalendarModal({ title, units, holidays, breaks, preview = false, onClose }: { title: string; units: CalendarUnit[]; holidays: { date: string; name: string }[]; breaks: AcademicBreak[]; preview?: boolean; onClose: () => void }) {
  const off = new Map(holidays.map((h) => [h.date, h.name]));
  useEffect(() => {
    // Capture Escape first so it closes only the calendar, not the intake panel underneath.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const months = useMemo(() => {
    if (!units.length) return [];
    const first = utc(units[0].startDate), last = utc(units[units.length - 1].endDate);
    const out: Date[] = [];
    for (let d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)); d <= last; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) out.push(d);
    return out;
  }, [units]);
  const unitOf = (day: string) => units.findIndex((u) => day >= u.startDate && day <= u.endDate);
  const breakOf = (day: string) => breaks.find((b) => day >= b.startDate && day <= b.endDate);
  const today = iso(new Date());

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-2 sm:p-6" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Intake calendar" className="flex max-h-full w-full max-w-6xl flex-col rounded-2xl bg-background-50 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-background-200 p-4">
          <div>
            <h2 className="font-heading text-lg font-bold text-foreground-950">{title} · calendar{preview ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Preview, not saved</span> : null}</h2>
            <p className="text-xs text-foreground-600">{shortDate(units[0].startDate)} – {shortDate(units[units.length - 1].endDate)} · {units.length} units. Grey days are weekends; striped days are public holidays or term breaks.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => window.print()} className="rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100 print:hidden"><i className="ri-printer-line" aria-hidden="true" /> Print</button>
            <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 text-foreground-600 hover:bg-background-100"><i className="ri-close-line text-lg" aria-hidden="true" /></button>
          </div>
        </header>
        <div className="overflow-y-auto p-4">
          <ul className="mb-4 flex flex-wrap gap-2">
            {units.map((u, i) => <li key={u.unitId + i} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${COLORS[i % COLORS.length]}`} title={`${u.name}: ${shortDate(u.startDate)} – ${shortDate(u.endDate)}`}>{u.code}</li>)}
          </ul>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {months.map((m) => {
              const y = m.getUTCFullYear(), mo = m.getUTCMonth();
              const days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
              const lead = (m.getUTCDay() + 6) % 7;
              return (
                <div key={iso(m)} className="rounded-xl border border-background-200 bg-white p-3">
                  <p className="mb-2 text-sm font-semibold text-foreground-900">{m.toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" })}</p>
                  <div className="grid grid-cols-7 gap-0.5 text-center text-[11px]">
                    {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i} className="pb-1 font-semibold text-foreground-500">{d}</span>)}
                    {Array.from({ length: lead }, (_, i) => <span key={"l" + i} />)}
                    {Array.from({ length: days }, (_, i) => {
                      const day = iso(new Date(Date.UTC(y, mo, i + 1)));
                      const weekend = (lead + i) % 7 >= 5;
                      const ui = unitOf(day);
                      const br = breakOf(day);
                      const isOff = !weekend && (off.has(day) || !!br);
                      const cls = weekend ? "bg-background-100 text-foreground-400"
                        : isOff ? "bg-[repeating-linear-gradient(45deg,#e5e7eb,#e5e7eb_3px,#f9fafb_3px,#f9fafb_6px)] text-foreground-500"
                        : ui >= 0 ? COLORS[ui % COLORS.length] : "text-foreground-400";
                      const label = ui >= 0 ? `${units[ui].code} ${units[ui].name}` : "";
                      return <span key={day} title={[shortDate(day), isOff ? (off.get(day) ?? br?.label ?? "Public holiday / break") : label].filter(Boolean).join(" · ")}
                        className={`rounded py-1 tabular-nums ${cls} ${day === today ? "ring-2 ring-primary-500" : ""}`}>{i + 1}</span>;
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
