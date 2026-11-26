// Public holidays of ONE course (owner, 2026-11-26: "holidays for a particular course, not all"). The confirmed public holidays
// (Staff › Public holidays) close every course by default; here an RTO Manager switches a holiday off for this course only, so
// its classes run that day (public.course_holiday_teaching, migration 20261127040517; read by rto_is_teaching_day / rto_is_working_day
// for the course being planned). After a change this course's running intakes are re-planned, as for a term break.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { generateClassSessions, rto, shortDate, type RtoIntake } from "@/pages/admin/lib/rto";
import { listHolidays, type Holiday } from "@/lib/hrmsApi";

const today = new Date().toISOString().slice(0, 10);
const addYears = (iso: string, n: number) => `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`;

export default function CourseHolidaysPanel({ courseId, courseCode, from, to, canEdit }: {
  courseId: string; courseCode: string; from?: string | null; to?: string | null; canEdit: boolean;
}) {
  const start = from || today;
  const end = to && to > start ? to : addYears(start, 2);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [teaching, setTeaching] = useState<Set<string>>(new Set());
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const [list, rows] = await Promise.all([
      listHolidays(start, end),
      supabase.from("course_holiday_teaching").select("holiday_date").eq("course_id", courseId),
    ]);
    setHolidays(list.filter(h => h.status === "confirmed" && !h.isOptional).sort((a, b) => a.date.localeCompare(b.date)));
    if (rows.error) { if (rows.error.code === "42P01" || rows.error.code === "PGRST205") setMissing(true); else throw new Error(rows.error.message); }
    else setTeaching(new Set((rows.data ?? []).map(r => (r as { holiday_date: string }).holiday_date)));
  }, [courseId, start, end]);
  useEffect(() => { if (open) void load().catch(e => setNote({ ok: false, text: e instanceof Error ? e.message : "The public holidays could not be loaded." })); }, [open, load]);

  /** Re-plans this course's intakes that are still running, so their classes follow the change. */
  const replan = async () => {
    const intakes = await rto<RtoIntake[]>("intake_list").catch(() => [] as RtoIntake[]);
    let done = 0;
    for (const i of intakes) if (i.courseId === courseId && (!i.endDate || i.endDate >= today))
      for (const b of i.batchList ?? []) if (b.isActive && b.days.length) { try { await generateClassSessions(b.id); done += 1; } catch { /* nothing to plan */ } }
    return done;
  };

  const toggle = async (h: Holiday) => {
    if (busy || !canEdit) return;
    const closing = teaching.has(h.date);
    setBusy(h.date); setNote(null);
    const res = closing
      ? await supabase.from("course_holiday_teaching").delete().eq("course_id", courseId).eq("holiday_date", h.date)
      : await supabase.from("course_holiday_teaching").insert({ course_id: courseId, holiday_date: h.date });
    if (res.error) { setBusy(""); setNote({ ok: false, text: res.error.message }); return; }
    setTeaching(prev => { const next = new Set(prev); if (closing) next.delete(h.date); else next.add(h.date); return next; });
    const n = h.date >= today ? await replan() : 0;
    setBusy("");
    setNote({ ok: true, text: `${h.name} (${shortDate(h.date)}): ${closing ? "no classes" : "classes run"} for ${courseCode} only.${n ? ` Classes updated for ${n} intake${n === 1 ? "" : "s"}.` : ""}` });
  };

  const off = holidays.filter(h => !teaching.has(h.date)).length;
  return <section className="rounded-lg border border-background-200">
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left">
      <span className="text-sm font-bold text-foreground-950">Public holidays for {courseCode}
        {open && holidays.length ? <span className="ml-2 text-xs font-normal text-foreground-500">{off} of {holidays.length} closed</span> : null}</span>
      <i className={open ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line"} aria-hidden="true" />
    </button>
    {open ? <div className="border-t border-background-200 px-3 py-2">
      <p className="text-xs text-foreground-600">Confirmed public holidays from {shortDate(start)} to {shortDate(end)}. Each one closes {courseCode} unless you switch it off here; other courses are not changed.</p>
      {missing ? <p role="alert" className="mt-2 text-sm text-amber-900">Per-course holidays need migration 20261127040517 on the database. Until then every public holiday closes every course.</p> : null}
      {note ? <p role={note.ok ? "status" : "alert"} className={"mt-2 text-xs " + (note.ok ? "text-green-800" : "text-red-700")}>{note.text}</p> : null}
      {!holidays.length ? <p className="py-3 text-center text-sm text-foreground-500">No public holidays in these dates.</p> : <ul className="mt-2 divide-y divide-background-100">
        {holidays.map(h => { const closed = !teaching.has(h.date); return <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
          <span className="text-sm"><b className="text-foreground-900">{shortDate(h.date)}</b> <span className="text-foreground-700">{h.name}</span></span>
          <button type="button" role="switch" aria-checked={closed} disabled={!canEdit || missing || !!busy} onClick={() => void toggle(h)}
            aria-label={`${h.name} ${shortDate(h.date)}: ${closed ? "no classes" : "classes run"}`}
            className={"min-h-9 rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-60 " + (closed ? "bg-amber-100 text-amber-900" : "bg-green-100 text-green-800")}>
            {busy === h.date ? "Saving…" : closed ? "Closed: no classes" : "Open: classes run"}</button>
        </li>; })}
      </ul>}
    </div> : null}
  </section>;
}
