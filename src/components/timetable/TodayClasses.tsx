import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import TrainerAttendanceDialog from "@/components/timetable/TrainerAttendanceDialog";

type Session = { id: string; date: string; start: string; end: string; status: string; batchName: string; courseName: string; courseCode: string;
  unitCode: string | null; unitName: string | null; room: string | null; campus: string | null };
type RegState = "new" | "draft" | "final";

/** Class days follow the college's clock (Melbourne), the same day the server uses to allow marking. */
const melbourneToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
const nowHm = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Australia/Melbourne", hour: "2-digit", minute: "2-digit", hour12: false });
const BADGE: Record<RegState, { label: string; tone: string }> = {
  new: { label: "Not taken", tone: "bg-amber-100 text-amber-800" },
  draft: { label: "Draft saved", tone: "bg-background-200 text-foreground-700" },
  final: { label: "Done", tone: "bg-green-100 text-green-800" },
};

/** Trainer shortcut: today's classes, each with one Take attendance button and whether the register is done. Renders nothing on a day without classes. */
export default function TodayClasses({ className = "" }: { className?: string }) {
  const [rows, setRows] = useState<Session[] | null>(null);
  const [states, setStates] = useState<Record<string, RegState>>({});
  const [marking, setMarking] = useState<Session | null>(null);
  useEffect(() => {
    let live = true;
    const day = melbourneToday();
    const range = { p_from: day, p_to: day };
    Promise.all([supabase.rpc("my_class_schedule", range), supabase.rpc("my_prereq_classes", range)]).then(async ([main, pre]) => {
      if (!live) return;
      const all = [...(main.error ? [] : ((main.data as { sessions?: Session[] } | null)?.sessions ?? [])), ...(pre.error ? [] : ((pre.data as Session[] | null) ?? []))]
        .filter((s) => s.date === day && s.status !== "cancelled" && s.unitCode)
        .sort((a, b) => a.start.localeCompare(b.start));
      setRows(all);
      // One small read per class (a trainer has a handful a day) for the register state; a class that cannot be read shows no badge.
      const found = await Promise.all(all.map((s) => supabase.rpc("trainer_session_attendance", { p_session: s.id })
        .then(({ data, error }) => [s.id, error ? null : (data as { state: RegState }).state] as const)));
      if (live) setStates(Object.fromEntries(found.filter(([, st]) => st)));
    });
    return () => { live = false; };
  }, []);
  if (!rows || !rows.length) return null;
  const now = nowHm();
  const open = rows.filter((s) => states[s.id] !== "final").length;

  return (
    <section className={`rounded-lg border border-primary-300 bg-white p-4 ring-1 ring-primary-200 ${className}`} data-testid="today-classes">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-lg font-bold text-foreground-950">Today's classes</h2>
        <span className="text-xs text-foreground-600">{open ? `${open} register${open === 1 ? "" : "s"} to take` : "All registers done"}</span>
      </div>
      <ul className="mt-3 space-y-2">
        {rows.map((s) => {
          const st = states[s.id];
          const running = s.start <= now && now < s.end;
          return (
            <li key={s.id} className={`flex flex-wrap items-center gap-3 rounded-md border p-3 ${running ? "border-primary-300 bg-primary-50" : "border-background-200"}`}>
              <span className="w-28 shrink-0 text-sm font-semibold tabular-nums text-foreground-900">{s.start} – {s.end}{running ? <span className="block text-2xs font-semibold uppercase text-primary-700">Now</span> : null}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground-900">{s.unitCode} {s.unitName ?? ""}</span>
                <span className="block text-xs text-foreground-600">{[`Class ${s.batchName}`, s.room ? `Room ${s.room}${s.campus ? `, ${s.campus}` : ""}` : ""].filter(Boolean).join(" · ")}</span>
              </span>
              {st ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[st].tone}`}>{BADGE[st].label}</span> : null}
              <button type="button" onClick={() => setMarking(s)}
                className={st === "final" ? "rounded-md border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100" : "rounded-md bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-700"}>
                <i className="ri-checkbox-circle-line" aria-hidden="true" /> {st === "final" ? "View attendance" : "Take attendance"}
              </button>
            </li>
          );
        })}
      </ul>
      {marking ? <TrainerAttendanceDialog sessionId={marking.id} title={`Today ${marking.start}–${marking.end} · ${marking.unitCode ?? ""} · Class ${marking.batchName}`}
        onSaved={(state) => setStates((x) => ({ ...x, [marking.id]: state }))} onClose={() => setMarking(null)} /> : null}
    </section>
  );
}
