import { useEffect, useMemo, useState } from "react";
import { addDays, generateClassSessions, listBreaks, loadClassSessions, resetClassSessions, shortDate, type AcademicBreak, type ClassSession } from "@/pages/admin/lib/rto";
import CantRunDialog from "@/pages/admin/components/rto/CantRunDialog";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const parse = (s: string) => new Date(s + "T00:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (s: string) => s.slice(0, 7);
const tone: Record<string, string> = { theory: "border-l-sky-500 bg-sky-50", practical: "border-l-amber-500 bg-amber-50", assessment: "border-l-emerald-500 bg-emerald-50" };

/**
 * The intake's whole course, month by month from the intake start: every class with its time, unit, room and trainer.
 * Term-break days are greyed out. Classes come from the saved class timing (generated when the timing is saved).
 */
export default function BatchCourseCalendar({ batchId, courseId, intakeStart, intakeEnd, hasSlots, canManage, reloadKey, onRemoved }: {
  batchId: string; courseId: string; intakeStart: string; intakeEnd: string | null; hasSlots: boolean; canManage: boolean; reloadKey: number;
  /** After Remove calendar: clears the weekly class timing too, so the intake's class setup starts again from scratch. */
  onRemoved?: () => Promise<void>;
}) {
  const [rows, setRows] = useState<ClassSession[]>([]);
  const [breaks, setBreaks] = useState<AcademicBreak[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ClassSession | null>(null);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState("");
  const [resetting, setResetting] = useState(false);
  const [removed, setRemoved] = useState(false);
  const reset = async (regenerate: boolean) => {
    const changed = rows.filter(r => r.manual).length;
    const ask = regenerate
      ? `Recreate the whole course calendar from ${shortDate(intakeStart)} using the weekly class timing?${changed ? ` The ${changed} class${changed === 1 ? "" : "es"} you changed by hand will be lost.` : ""}`
      : `Remove this intake's course calendar (${rows.length} classes) and its weekly class timing? You then start again from scratch with a template or by hand.`;
    if (!window.confirm(ask)) return;
    setResetting(true); setError(""); setNotice("");
    try {
      const out = await resetClassSessions(batchId, regenerate);
      setNotice(regenerate ? `Calendar recreated: ${out.created ?? 0} classes${out.endDate ? `, last class ${shortDate(out.endDate)}` : ""}.` : `Calendar removed (${out.removed} classes).`);
      setRemoved(!regenerate);
      if (!regenerate && onRemoved) { await onRemoved(); return; }
      setVersion(v => v + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "The calendar was not changed."); }
    finally { setResetting(false); }
  };

  useEffect(() => { listBreaks(courseId).then(setBreaks).catch(() => undefined); }, [courseId]);
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
      if (!list.length && hasSlots && canManage && !removed) { await generateClassSessions(batchId).catch(() => null); list = await read(); }
      if (live) setRows(list);
    })().catch(e => { if (live) setError(e instanceof Error ? e.message : "Unable to load the classes."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [batchId, intakeStart, intakeEnd, hasSlots, canManage, reloadKey, version, removed]);

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
      <div className="flex flex-wrap gap-2 print:hidden">
        {canManage && hasSlots && <button type="button" disabled={resetting || loading} onClick={() => void reset(true)} title="Delete every class and build the calendar again from the intake start"
          className="inline-flex items-center gap-1 rounded-lg border border-primary-300 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-800 hover:bg-primary-100 disabled:opacity-50">
          <i className="ri-refresh-line" aria-hidden="true" />{resetting ? "Working…" : "Recreate calendar"}</button>}
        {canManage && rows.length > 0 && <button type="button" disabled={resetting || loading} onClick={() => void reset(false)}
          className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
          <i className="ri-delete-bin-line" aria-hidden="true" />Remove calendar</button>}
        <button type="button" onClick={() => window.print()} className="rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100">Print</button>
      </div>
    </div>
    {notice && <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
    {canManage && rows.length > 0 && <p className="mt-2 text-xs text-foreground-500 print:hidden">Click a class that can't run: the rescheduling rules find it a new time (no class is dropped). Changed classes stay as you set them when the timing is saved again.</p>}
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    {loading ? <p className="py-10 text-center text-sm text-foreground-500">Loading the course calendar…</p>
    : !rows.length ? <p className="py-10 text-center text-sm text-foreground-500">{hasSlots && removed ? "The calendar was removed. Click Recreate calendar to build it again from the intake start." : hasSlots ? "No classes yet. Open Edit class timing and click Save timing to fill the calendar." : "Set the class timing to fill the calendar."}</p>
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
                <div className="mt-1 space-y-1">{(byDate.get(d) ?? []).map(s => <button type="button" key={s.id} title={`${s.unitCode ?? ""} ${s.unitName ?? ""}${canManage ? " · click to change" : ""}`}
                  disabled={!canManage} onClick={() => { setNotice(""); setEditing(s); }}
                  className={`block w-full rounded border-l-4 px-1.5 py-1 text-left text-[11px] leading-tight ${tone[s.type] ?? ""} ${canManage ? "cursor-pointer hover:brightness-95" : "cursor-default"} ${s.status === "cancelled" ? "opacity-60 ring-1 ring-amber-400" : ""}`}>
                  <span className="flex items-baseline justify-between gap-1"><strong className="text-foreground-950">{s.unitCode ?? ""}</strong><span className="shrink-0 text-foreground-600">{s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)}</span></span>
                  <span className="block truncate text-foreground-700">{s.room ?? "No room"} · <span className={s.trainers ? "" : "font-semibold text-red-700"}>{s.trainers || "No trainer"}</span></span>
                  {s.status === "cancelled" ? <span className="block text-[10px] font-semibold text-amber-800">Not running · click for details</span> : s.manual && <span className="block text-[10px] font-semibold text-primary-700">Changed</span>}
                </button>)}</div>
              </div>;
            })}
          </div></div>
        </div>;
      })}
    </div>}
    {editing && <CantRunDialog sessionId={editing.id} onClose={() => setEditing(null)}
      onDone={msg => { setEditing(null); setNotice(msg); setVersion(v => v + 1); }} />}
  </section>;
}
