import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

type Mark = "present" | "late" | "absent" | "excused";
type Register = { sessionId: string; date: string; start: string; end: string; state: "new" | "draft" | "final"; canChangeFinal: boolean;
  students: { enrolmentId: string; name: string; status: Mark | null }[] };
const MARKS: Mark[] = ["present", "late", "absent", "excused"];
const TONE: Record<Mark, string> = { present: "bg-green-100 text-green-800 ring-green-300", late: "bg-amber-100 text-amber-800 ring-amber-300",
  absent: "bg-red-100 text-red-700 ring-red-300", excused: "bg-background-200 text-foreground-700 ring-background-300" };

/** Every student of a register not saved yet starts as Present, so the trainer only taps the exceptions. */
function startingMarks(r: Pick<Register, "state" | "students">): Record<string, Mark> {
  return Object.fromEntries(r.students.flatMap((s) => (s.status ? [[s.enrolmentId, s.status]] : r.state === "new" ? [[s.enrolmentId, "present" as Mark]] : [])));
}

/** Trainer > My classes > a class: mark each student present / late / absent / excused, save a draft or the final register. */
export default function TrainerAttendanceDialog({ sessionId, title, onClose, onSaved }: { sessionId: string; title: string; onClose: () => void; onSaved?: (state: "draft" | "final") => void }) {
  const [reg, setReg] = useState<Register | null>(null);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    supabase.rpc("trainer_session_attendance", { p_session: sessionId }).then(({ data, error: e }) => {
      if (e) { setError(e.message); return; }
      const r = data as Register;
      setReg(r);
      setMarks(startingMarks(r));
    });
  }, [sessionId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const locked = reg?.state === "final" && !reg.canChangeFinal;
  const save = async (state: "draft" | "final") => {
    if (!reg) return;
    if (state === "final" && reg.students.some((s) => !marks[s.enrolmentId])) { setError("Mark every student before saving the final register."); return; }
    setBusy(true); setError(""); setSaved("");
    const { error: e } = await supabase.rpc("trainer_session_attendance_save", { p_session: sessionId, p_state: state,
      p_marks: Object.entries(marks).map(([enrolmentId, status]) => ({ enrolmentId, status })) });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setReg({ ...reg, state });
    setSaved(state === "final" ? "Attendance saved." : "Draft saved.");
    onSaved?.(state);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Mark attendance" className="flex max-h-full w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between gap-3 border-b border-background-200 p-4">
          <div><h2 className="font-heading text-lg font-bold text-foreground-950">Attendance</h2><p className="text-xs text-foreground-600">{title}</p></div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 text-foreground-600 hover:bg-background-100"><i className="ri-close-line text-lg" aria-hidden="true" /></button>
        </header>
        <div className="overflow-y-auto p-4">
          {error ? <p role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
          {saved ? <p role="status" className="mb-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{saved}</p> : null}
          {!reg ? (!error ? <p className="text-sm text-foreground-500">Loading students…</p> : null) : !reg.students.length ? <p className="text-sm text-foreground-500">No students in this class on this day.</p> : (
            <>
              {locked ? <p className="mb-3 rounded-md bg-background-100 px-3 py-2 text-xs text-foreground-700">This register is final. Ask an RTO Manager if something needs changing.</p> : null}
              {reg.state === "new" ? <p className="mb-3 rounded-md bg-primary-50 px-3 py-2 text-xs text-primary-900" data-testid="attendance-default-hint">Everyone starts as Present. Tap only the students who are absent, late or excused, then Save final.</p> : null}
              <div className="mb-2 flex justify-end"><button type="button" disabled={locked} className="text-xs font-semibold text-primary-700 hover:underline disabled:opacity-50"
                onClick={() => setMarks(Object.fromEntries(reg.students.map((s) => [s.enrolmentId, "present" as Mark])))}>Mark all present</button></div>
              <ul className="divide-y divide-background-100">
                {reg.students.map((s) => (
                  <li key={s.enrolmentId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="text-sm font-semibold text-foreground-900">{s.name}</span>
                    <span className="flex flex-wrap gap-1">{MARKS.map((m) => (
                      <button key={m} type="button" disabled={locked} aria-pressed={marks[s.enrolmentId] === m} onClick={() => setMarks((x) => ({ ...x, [s.enrolmentId]: m }))}
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize disabled:cursor-default ${marks[s.enrolmentId] === m ? TONE[m] + " ring-1" : "text-foreground-500 hover:bg-background-100"}`}>{m}</button>
                    ))}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {reg && reg.students.length && !locked ? (
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-background-200 p-4">
            <span className="text-xs text-foreground-500">{Object.keys(marks).length} / {reg.students.length} marked · {reg.state === "new" ? "not saved" : reg.state}</span>
            <span className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void save("draft")} className="rounded-md border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:opacity-50">Save draft</button>
              <button type="button" disabled={busy} onClick={() => void save("final")} className="rounded-md bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving…" : "Save final"}</button>
            </span>
          </footer>
        ) : null}
      </section>
    </div>
  );
}
