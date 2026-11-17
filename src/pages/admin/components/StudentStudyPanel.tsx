import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { addDays, shortDate, todayIso } from "@/pages/admin/lib/rto";
import StudyProgress, { type ProgressCourse } from "@/pages/admin/components/StudyProgress";

interface ClassRow { date: string; start: string; end: string; type: string; status: string; batch: string; courseCode: string; unitCode: string | null; unitName: string | null; room: string | null }

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
  const [progress, setProgress] = useState<ProgressCourse[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [tab, setTab] = useState<"progress" | "classes" | "placements">("progress");
  useEffect(() => {
    let live = true;
    void supabase.rpc("admin_student_progress", { p_student: studentId }).then(({ data }) => { if (live && data) setProgress(data as ProgressCourse[]); });
    void supabase.rpc("admin_student_schedule", { p_student: studentId, p_from: todayIso(), p_to: addDays(todayIso(), 120) }).then(({ data }) => { if (live && data) setClasses(data as ClassRow[]); });
    return () => { live = false; };
  }, [studentId]);
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
      <h2 className="font-heading text-lg font-semibold text-foreground-950">Study progress <span className="text-sm font-normal text-foreground-500">{rows.length || ""}</span></h2>
      <div className="mt-3 flex gap-2" role="tablist">
        {([["progress", "Progress"], ["classes", "Classes"], ["placements", "Where they study"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`rounded-full px-3 py-1 text-sm ${tab === k ? "bg-primary-600 font-semibold text-background-50" : "bg-background-100 text-foreground-700 hover:bg-background-200"}`}>{l}</button>
        ))}
      </div>
      {tab === "progress" ? <div className="mt-3">{progress.length ? <StudyProgress courses={progress} /> : <p className="text-sm text-foreground-600">No units yet: the student is not placed in an intake.</p>}</div> : null}
      {tab === "classes" ? (
        <div className="mt-3">
          {classes.length === 0 ? <p className="text-sm text-foreground-600">No classes in the next 120 days.</p> : (
            <ul className="divide-y divide-background-100 text-sm">
              {classes.map((c, i) => (
                <li key={i} className={`flex flex-wrap items-center gap-x-3 py-1.5 ${c.status === "cancelled" ? "text-foreground-400 line-through" : ""}`}>
                  <span className="w-32 font-medium text-foreground-900">{new Date(c.date + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</span>
                  <span className="tabular-nums text-foreground-700">{c.start}–{c.end}</span>
                  <span className="min-w-0 flex-1 text-foreground-700">{c.unitCode ? `${c.unitCode} ${c.unitName ?? ""}` : c.courseCode} · {c.type}{c.room ? ` · ${c.room}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {tab !== "placements" ? null : rows.length === 0 ? <p className="mt-2 text-sm text-foreground-600">Not placed in a batch yet. Add them from the course&apos;s intake (Courses › Intakes › the intake › Students).</p> : (
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
