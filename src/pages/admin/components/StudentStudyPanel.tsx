import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { shortDate } from "@/pages/admin/lib/rto";

interface Placement {
  enrolmentId: string; status: string; type: string; enrolledOn: string; carryOver: boolean; courseCode: string; courseName: string;
  intakeId: string; intake: string; batchId: string; batch: string; room: string | null;
  units: { code: string; name: string; start: string; end: string }[];
  path: { skipped: number; from: { batch: string; intake: string } | null; next: { batchId: string; batch: string; intake: string; startDate: string; units: number } | null };
}

/** Where the student studies: each placement with its intake, batch, room, join day and units, and where the path continues. */
export default function StudentStudyPanel({ studentId }: { studentId: string }) {
  const [rows, setRows] = useState<Placement[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void supabase.rpc("admin_student_study", { p_student: studentId }).then(({ data, error: e }) => {
      if (!live) return;
      if (e) { setError(e.message); setRows([]); } else setRows((data ?? []) as Placement[]);
    });
    return () => { live = false; };
  }, [studentId]);
  if (rows === null) return null;
  if (error) return null;
  return (
    <section className="rounded-card border border-background-200 bg-background-50 p-4" data-testid="student-study">
      <h2 className="font-heading text-lg font-semibold text-foreground-950">Study <span className="text-sm font-normal text-foreground-500">{rows.length || ""}</span></h2>
      {rows.length === 0 ? <p className="mt-2 text-sm text-foreground-600">Not placed in a batch yet. Add them from the course&apos;s intake (Courses › Intakes › the intake › Students).</p> : (
        <div className="mt-3 space-y-3">
          {rows.map((r) => (
            <div key={r.enrolmentId} className="rounded-md border border-background-200 p-3">
              <p className="font-medium text-foreground-900">{r.courseCode} {r.courseName}</p>
              <p className="text-sm text-foreground-700">
                {r.intake} intake · <Link className="font-semibold text-primary-700 hover:underline" to={`/admin/batches/${r.batchId}`}>batch {r.batch}</Link>{r.room ? ` · ${r.room}` : ""} · {r.type} · joined {shortDate(r.enrolledOn)}
                {r.status !== "active" ? ` · ${r.status}` : ""}
              </p>
              {r.carryOver && r.path.from ? <p className="mt-1 text-xs text-foreground-600">Continues from {r.path.from.intake} (batch {r.path.from.batch}).</p> : null}
              {r.units.length ? (
                <p className="mt-2 flex flex-wrap gap-1.5">{r.units.map((u) => <span key={u.code} title={`${u.name}: ${shortDate(u.start)} – ${shortDate(u.end)}`} className="rounded-full bg-background-100 px-2 py-0.5 text-xs text-foreground-800">{u.code}</span>)}</p>
              ) : <p className="mt-2 text-sm text-amber-800">No unit of this intake now: they start with the prerequisite units in the next intake.</p>}
              {!r.carryOver && r.path.skipped > 0 && r.units.length ? <p className="mt-1 text-xs text-foreground-600">{r.path.skipped} unit{r.path.skipped === 1 ? "" : "s"} of this intake come before they joined; they are carried into the next intake.</p> : null}
              {r.path.next ? <p className="mt-1 text-xs text-foreground-700">Then {r.path.next.units} unit{r.path.next.units === 1 ? "" : "s"} in the {r.path.next.intake} intake (batch {r.path.next.batch}) from {shortDate(r.path.next.startDate)}.</p> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
