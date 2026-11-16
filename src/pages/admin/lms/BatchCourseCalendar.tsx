import { useEffect, useMemo, useState } from "react";
import { addDays, generateClassSessions, listBreaks, loadClassSessions, shortDate, type AcademicBreak, type ClassSession } from "@/pages/admin/lib/rto";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const parse = (s: string) => new Date(s + "T00:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (s: string) => s.slice(0, 7);
const tone: Record<string, string> = { theory: "bg-sky-50 ring-sky-200", practical: "bg-amber-50 ring-amber-200", assessment: "bg-emerald-50 ring-emerald-200" };

/**
 * The batch's whole course, month by month from the intake start: every class with its time, unit, room and trainer.
 * Term-break days are greyed out. Classes come from the saved class timing (generated when the timing is saved).
 */
export default function BatchCourseCalendar({ batchId, intakeStart, intakeEnd, hasSlots, canManage, reloadKey }: {
  batchId: string; intakeStart: string; intakeEnd: string | null; hasSlots: boolean; canManage: boolean; reloadKey: number;
}) {
  const [rows, setRows] = useState<ClassSession[]>([]);
  const [breaks, setBreaks] = useState<AcademicBreak[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { listBreaks().then(setBreaks).catch(() => undefined); }, []);
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    // The list is read 400 days at a time, from the intake start to a few months past its end.
    const until = addDays(intakeEnd && intakeEnd > intakeStart ? intakeEnd : addDays(intakeStart, 365), 180);
    const read = async () => {
      const all: ClassSession[] = [];
      for (let from = intakeStart; from <= until; from = addDays(from, 400)) {
        const to = addDays(from, 399) < until ? addDays(from, 399) : until;
        all.push(...await loadClassSessions(batchId, from, to));
      }
      return all;
    };
    (async () => {
      let list = await read();
      // Timing saved before classes were generated automatically: generate them once.
      if (!list.length && hasSlots && canManage) { await generateClassSessions(batchId).catch(() => null); list = await read(); }
      if (live) setRows(list);
    })().catch(e => { if (live) setError(e instanceof Error ? e.message : "Unable to load the classes."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [batchId, intakeStart, intakeEnd, hasSlots, canManage, reloadKey]);

  const byDate = useMemo(() => {
    const m = new Map<string, ClassSession[]>();
    for (const s of rows) m.set(s.date, [...(m.get(s.date) ?? []), s].sort((a, b) => a.startTime.localeCompare(b.startTime)));
    return m;
  }, [rows]);
  const scheduled = rows.filter(r => r.status === "scheduled");
  const last = scheduled.length ? scheduled[scheduled.length - 1].date : null;
  const lastShown = [last, intakeEnd].filter(Boolean).sort().pop() ?? intakeStart;
  const months = useMemo(() => {
    const out: string[] = [];
    for (let d = parse(monthKey(intakeStart) + "-01"); iso(d) <= lastShown; d.setUTCMonth(d.getUTCMonth() + 1)) out.push(iso(d));
    return out;
  }, [intakeStart, lastShown]);
  const hours = scheduled.reduce((t, s) => { const [a, b] = [s.startTime, s.endTime].map(x => { const [h, m] = x.split(":").map(Number); return h * 60 + m; }); return t + (b - a) / 60; }, 0);
  const breakOf = (d: string) => breaks.find(b => d >= b.startDate && d <= b.endDate);

  return <section className="rounded-2xl border border-background-200 bg-background-50 p-5 shadow-sm print:border-0 print:shadow-none">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-heading text-lg font-bold text-foreground-950">Course calendar</h2>
        <p className="text-sm text-foreground-600">From {shortDate(intakeStart)}{last ? ` to the last class on ${shortDate(last)}` : ""}{intakeEnd ? ` · intake ends ${shortDate(intakeEnd)}` : ""}
          {scheduled.length ? ` · ${scheduled.length} classes · ${Math.round(hours)} hours` : ""}</p>
      </div>
      <button type="button" onClick={() => window.print()} className="rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100 print:hidden">Print</button>
    </div>
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    {loading ? <p className="py-10 text-center text-sm text-foreground-500">Loading the course calendar…</p>
    : !rows.length ? <p className="py-10 text-center text-sm text-foreground-500">{hasSlots ? "No classes yet. Open Edit class timing and click Save timing to fill the calendar." : "Set the class timing to fill the calendar."}</p>
    : <div className="mt-4 space-y-6">
      <div className="flex flex-wrap gap-3 text-xs text-foreground-600">
        {(["theory", "practical", "assessment"] as const).map(t => <span key={t} className="inline-flex items-center gap-1 capitalize"><span className={`inline-block h-3 w-3 rounded ring-1 ${tone[t]}`} />{t}</span>)}
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-background-200" />Term break</span>
      </div>
      {months.map(m => {
        const first = parse(m);
        const lead = (first.getUTCDay() + 6) % 7;
        const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
        const cells = Array.from({ length: Math.ceil((lead + count) / 7) * 7 }, (_, i) => { const n = i - lead; return n < 0 || n >= count ? null : addDays(m, n); });
        return <div key={m} className="break-inside-avoid">
          <h3 className="mb-2 font-heading text-base font-bold text-foreground-900">{first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</h3>
          <div className="overflow-x-auto"><div className="grid min-w-[900px] grid-cols-7 border-l border-t border-background-200 text-xs">
            {DAY_NAMES.map(d => <div key={d} className="border-b border-r border-background-200 bg-background-100 px-2 py-1 text-center font-semibold uppercase text-foreground-500">{d}</div>)}
            {cells.map((d, i) => {
              if (!d) return <div key={i} className="border-b border-r border-background-200 bg-background-100/40" />;
              const brk = breakOf(d);
              const outside = d < intakeStart;
              return <div key={d} className={`min-h-24 border-b border-r border-background-200 p-1 ${brk ? "bg-background-200/70" : outside ? "bg-background-100/40" : ""}`}>
                <div className="flex items-center justify-between"><span className={`font-semibold ${outside ? "text-foreground-300" : "text-foreground-700"}`}>{Number(d.slice(8))}</span>
                  {brk && <span className="truncate pl-1 text-[10px] text-foreground-500" title={brk.label}>{brk.label}</span>}</div>
                <div className="mt-1 space-y-1">{(byDate.get(d) ?? []).map(s => <div key={s.id} title={`${s.unitCode ?? ""} ${s.unitName ?? ""}`}
                  className={`rounded px-1.5 py-1 ring-1 ${tone[s.type] ?? ""} ${s.status === "cancelled" ? "line-through opacity-50" : ""}`}>
                  <strong className="block">{s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)} {s.unitCode ?? ""}</strong>
                  <span className="block truncate"><i className="ri-door-open-line mr-0.5" aria-hidden="true" />{s.room ?? "No room"}</span>
                  <span className="block truncate"><i className="ri-user-line mr-0.5" aria-hidden="true" />{s.trainers || "No trainer"}</span>
                </div>)}</div>
              </div>;
            })}
          </div></div>
        </div>;
      })}
    </div>}
  </section>;
}
