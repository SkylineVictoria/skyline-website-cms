import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { shortDate, type ScheduleRow, type StudyLoad, type AcademicBreak } from "@/pages/admin/lib/rto";

type Unit = { unitId: string; code: string; name: string; startDate: string; endDate: string; hours: number | null };
type Plan = { startDate: string; endDate: string | null; units: Unit[]; offDays: string[] };

const COLORS = ["bg-sky-200 text-sky-900", "bg-amber-200 text-amber-900", "bg-emerald-200 text-emerald-900", "bg-violet-200 text-violet-900", "bg-rose-200 text-rose-900",
  "bg-lime-200 text-lime-900", "bg-cyan-200 text-cyan-900", "bg-orange-200 text-orange-900", "bg-fuchsia-200 text-fuchsia-900", "bg-teal-200 text-teal-900"];
const DOT = ["bg-sky-500", "bg-amber-500", "bg-emerald-500", "bg-violet-500", "bg-rose-500", "bg-lime-500", "bg-cyan-500", "bg-orange-500", "bg-fuchsia-500", "bg-teal-500"];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(s + "T00:00:00Z");
const weeks = (a: string, b: string) => Math.max(1, Math.round((utc(b).getTime() - utc(a).getTime()) / 86400000 / 7 + 1 / 7));

/**
 * The intake's unit timeline: each unit's start and end date. When the start date or CoE / VoE differs from what is saved, the
 * dates are previewed (intake_schedule_preview: the same layout Save makes, holidays and term breaks skipped, nothing stored).
 * "Calendar" opens every month of the intake with each day coloured by its unit.
 */
export default function IntakeTimeline({ intakeId, title, saved, savedStart, start, load, savedLoad, breaks }: {
  intakeId: string; title: string; saved: ScheduleRow[]; savedStart: string; start: string; load: StudyLoad; savedLoad: StudyLoad; breaks: AcademicBreak[];
}) {
  const changed = !!start && (start !== savedStart || load !== savedLoad);
  const [preview, setPreview] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [calendar, setCalendar] = useState(false);

  useEffect(() => {
    setPreview(null); setError("");
    if (!intakeId || !start) return;
    let live = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      supabase.rpc("intake_schedule_preview", { p_intake: intakeId, p_start: start, p_load: changed ? load : null }).then(({ data, error: e }) => {
        if (!live) return;
        setLoading(false);
        if (e) setError(e.message); else setPreview(data as Plan);
      });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [intakeId, start, load, changed]);

  const units: Unit[] = changed ? (preview?.units ?? []) : (saved.map((s) => ({ unitId: s.unitId, code: s.code, name: s.name, startDate: s.startDate, endDate: s.endDate, hours: s.hours })));
  const end = units.length ? units[units.length - 1].endDate : null;
  const off = new Set(preview?.offDays ?? []);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground-800">Unit timeline {changed ? <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Preview, not saved</span> : null}</p>
        <button type="button" disabled={!units.length} onClick={() => setCalendar(true)} className="inline-flex items-center gap-1 rounded-lg border border-background-300 px-2.5 py-1 text-xs font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50">
          <i className="ri-calendar-2-line" aria-hidden="true" />Calendar</button>
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}
      {loading && changed && !preview ? <p className="text-xs text-foreground-500">Working out the unit dates…</p> : null}
      {!units.length && !loading ? <p className="text-xs text-foreground-500">This course has no units yet. Add them in Courses › Units.</p> : null}
      {units.length ? (
        <>
          <ol className="divide-y divide-background-200 rounded-lg border border-background-200">
            {units.map((u, i) => (
              <li key={u.unitId + i} className="flex items-start gap-2 px-3 py-2">
                <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[i % DOT.length]}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground-900">{u.code} {u.name}</span>
                  <span className="block text-xs text-foreground-600">{shortDate(u.startDate)} – {shortDate(u.endDate)} · {weeks(u.startDate, u.endDate)} wk{u.hours ? ` · ${u.hours} h` : ""}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-foreground-600">{units.length} units · ends {end ? shortDate(end) : "—"}{preview?.offDays.length ? ` · ${preview.offDays.length} weekday${preview.offDays.length === 1 ? "" : "s"} off for holidays / breaks` : ""}</p>
        </>
      ) : null}
      {calendar ? <CalendarModal title={title} units={units} off={off} breaks={breaks} preview={changed} onClose={() => setCalendar(false)} /> : null}
    </div>
  );
}

function CalendarModal({ title, units, off, breaks, preview, onClose }: { title: string; units: Unit[]; off: Set<string>; breaks: AcademicBreak[]; preview: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
                      const isOff = off.has(day) || (!!br && !weekend);
                      const cls = weekend ? "bg-background-100 text-foreground-400"
                        : isOff ? "bg-[repeating-linear-gradient(45deg,#e5e7eb,#e5e7eb_3px,#f9fafb_3px,#f9fafb_6px)] text-foreground-500"
                        : ui >= 0 ? COLORS[ui % COLORS.length] : "text-foreground-400";
                      const label = ui >= 0 ? `${units[ui].code} ${units[ui].name}` : "";
                      return <span key={day} title={[shortDate(day), isOff ? (br?.label ?? "Public holiday / break") : label].filter(Boolean).join(" · ")}
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
