import { Link } from "react-router-dom";
import { formatQualificationDate, qualificationTone, type QualificationRow } from "@/lib/qualification";

/** A list of Qualifications (staff list and the student's Qualification tab). */
export default function QualificationsTable({ rows, showStudent = true }: { rows: QualificationRow[]; showStudent?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm" data-testid="qualifications-table">
        <thead className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
          <tr>
            {showStudent ? <th className="px-4 py-2.5 font-medium">Student</th> : null}
            <th className="px-4 py-2.5 font-medium">Course</th>
            <th className="px-4 py-2.5 font-medium">Intake</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Start</th>
            <th className="px-4 py-2.5 font-medium">End</th>
            <th className="px-4 py-2.5 font-medium">Tasks</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.id} className="border-b border-background-100 last:border-0 hover:bg-background-100/60">
              {showStudent ? (
                <td className="px-4 py-2.5">
                  <Link to={`/admin/qualifications/${q.id}`} className="font-medium text-foreground-900 hover:text-primary-700">{q.studentName || "Unnamed student"}</Link>
                  {q.studentNumber ? <span className="ml-2 font-mono text-xs text-foreground-500">{q.studentNumber}</span> : null}
                </td>
              ) : null}
              <td className="px-4 py-2.5">
                <Link to={`/admin/qualifications/${q.id}`} className="text-foreground-900 hover:text-primary-700">{[q.courseCode, q.courseName].filter(Boolean).join(" ")}</Link>
                <span className="ml-2 text-xs text-foreground-500">{q.type}</span>
              </td>
              <td className="px-4 py-2.5 text-foreground-700">{q.intakeName}</td>
              <td className="px-4 py-2.5"><span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${qualificationTone(q.status)}`}>{q.label}</span></td>
              <td className="px-4 py-2.5 text-foreground-700">{formatQualificationDate(q.startDate)}</td>
              <td className="px-4 py-2.5 text-foreground-700">{formatQualificationDate(q.endDate)}</td>
              <td className="px-4 py-2.5">{q.openTasks ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{q.openTasks} open</span> : <span className="text-foreground-400">–</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
