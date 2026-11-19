// "Classes to reschedule" (CLASS-RESCHEDULE): classes that can't run and have no new time yet. Shown on the dashboard
// (every intake) and on an intake's Weekly timetable tab. Hidden when empty.
import { useCallback, useEffect, useState } from "react";
import CantRunDialog from "@/pages/admin/components/rto/CantRunDialog";
import { reschedule, whenText, type SessionInfo } from "@/pages/admin/lib/reschedule";

export default function ClassesToReschedule({ intakeId, onChanged }: { intakeId?: string; onChanged?: () => void }) {
  const [rows, setRows] = useState<SessionInfo[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const load = useCallback(() => {
    reschedule<SessionInfo[]>("waiting", intakeId ? { intakeId } : {}).then((r) => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([]));
  }, [intakeId]);
  useEffect(() => { load(); }, [load]);
  if (!rows.length && !notice) return null;
  return (
    <section className="mb-4 rounded-xl border border-amber-300 bg-amber-50/60 p-4">
      <h2 className="font-heading text-base font-semibold text-foreground-950">
        Classes to reschedule {rows.length ? <span className="ml-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs font-bold text-amber-900">{rows.length}</span> : null}</h2>
      <p className="text-sm text-foreground-600">No rule found a time for these. Each needs a new time before its unit ends.</p>
      {notice ? <p role="status" className="mt-2 text-sm text-emerald-800">{notice}</p> : null}
      <ul className="mt-2 divide-y divide-amber-200">
        {rows.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <div>
            <p className="text-sm font-semibold text-foreground-950">{r.unitCode} · {whenText(r.date, r.start, r.end)}</p>
            <p className="text-xs text-foreground-600">{[r.courseCode, r.intakeName, r.reason, r.unitEnds ? `unit ends ${new Date(r.unitEnds + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" })}` : ""].filter(Boolean).join(" · ")}</p>
          </div>
          <button type="button" onClick={() => { setNotice(""); setOpen(r.id); }} className="rounded-md bg-primary-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-600">Pick a time</button>
        </li>)}
      </ul>
      {open ? <CantRunDialog sessionId={open} onClose={() => setOpen(null)} onDone={(msg) => { setOpen(null); setNotice(msg); load(); onChanged?.(); }} /> : null}
    </section>
  );
}
