import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { ATTENDANCE_THRESHOLD, attendanceRate, type AttendanceCounts } from "./attendanceRate";

type Row = AttendanceCounts & { enrolmentId: string; studentId: string; studentName: string; enrolmentStatus: string; batchName: string; courseName: string };

export function RateBadge({ counts }: { counts: AttendanceCounts }) {
  const rate = attendanceRate(counts);
  if (rate === null) return <span className="text-xs text-foreground-500">No classes marked</span>;
  const low = rate < ATTENDANCE_THRESHOLD;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${low ? "bg-red-100 text-red-700" : "bg-green-100 text-green-800"}`}>
      {low ? <i className="ri-error-warning-line" aria-hidden="true" /> : null}{rate}%{low ? ` · below ${ATTENDANCE_THRESHOLD}%` : ""}
    </span>
  );
}

/** Attendance per student of a batch, or per enrolment of a student, from finalised registers. */
export default function AttendanceSummary({ batchId, studentId }: { batchId?: string; studentId?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setRows(null); setError("");
    supabase.rpc("lms_attendance_summary", { p_batch: batchId ?? null, p_student: studentId ?? null }).then(({ data, error: e }) => {
      if (!live) return;
      if (e) setError(e.message); else setRows((data ?? []) as Row[]);
    });
    return () => { live = false; };
  }, [batchId, studentId]);

  if (error) return <p role="alert" className="py-4 text-sm text-red-700">{error}</p>;
  if (!rows) return <p className="py-4 text-sm text-foreground-500">Loading attendance…</p>;
  if (!rows.length) return <p className="py-4 text-sm text-foreground-500">{studentId ? "Not enrolled in a batch yet." : "No students in this batch."}</p>;
  const low = rows.filter((r) => { const rate = attendanceRate(r); return rate !== null && rate < ATTENDANCE_THRESHOLD; }).length;
  return (
    <div>
      {batchId ? (
        <p className={`mb-3 rounded-lg px-3 py-2 text-sm ${low ? "border border-red-200 bg-red-50 text-red-700" : "border border-green-200 bg-green-50 text-green-800"}`}>
          {low ? `${low} student${low === 1 ? " is" : "s are"} below ${ATTENDANCE_THRESHOLD}% attendance.` : `Everyone is at or above ${ATTENDANCE_THRESHOLD}% attendance.`} Only saved (final) registers count; late counts as attended, excused is left out.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">
            <th className="px-3 py-2">{studentId ? "Course / batch" : "Student"}</th><th className="px-3 py-2">Classes</th><th className="px-3 py-2">Present</th>
            <th className="px-3 py-2">Late</th><th className="px-3 py-2">Absent</th><th className="px-3 py-2">Excused</th><th className="px-3 py-2">Attendance</th>
          </tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.enrolmentId} className="border-b border-background-100">
              <td className="px-3 py-2">{studentId
                ? <span className="text-foreground-900">{r.courseName} <span className="text-foreground-500">· {r.batchName}</span></span>
                : <Link to={`/admin/students/${r.studentId}`} className="font-semibold text-primary-700 hover:underline">{r.studentName}</Link>}
                {r.enrolmentStatus !== "active" ? <span className="ml-2 text-xs capitalize text-foreground-500">{r.enrolmentStatus}</span> : null}</td>
              <td className="px-3 py-2">{r.classes}</td><td className="px-3 py-2">{r.present}</td><td className="px-3 py-2">{r.late}</td>
              <td className="px-3 py-2">{r.absent}</td><td className="px-3 py-2">{r.excused}</td><td className="px-3 py-2"><RateBadge counts={r} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
