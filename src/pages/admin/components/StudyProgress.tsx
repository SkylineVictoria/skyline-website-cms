import { shortDate } from "@/pages/admin/lib/rto";

export interface ProgressUnit { code: string; name: string; status: string; start: string | null; end: string | null; batch: string | null; intake: string | null; signedOn: string | null; hours: number }
export interface ProgressCourse {
  courseId: string; courseCode: string; courseName: string; total: number; competent: number; inProgress: number; upcoming: number; owed: number; notYet: number; awaiting: number;
  hoursTotal: number; hoursDone: number; percent: number; units: ProgressUnit[];
}

const STATUS: Record<string, { label: string; tone: string }> = {
  competent: { label: "Finished", tone: "bg-green-100 text-green-900" },
  in_progress: { label: "Studying now", tone: "bg-primary-100 text-primary-900" },
  upcoming: { label: "Coming up", tone: "bg-sky-100 text-sky-900" },
  awaiting_result: { label: "Waiting for result", tone: "bg-amber-100 text-amber-900" },
  not_yet_competent: { label: "Not yet competent", tone: "bg-red-100 text-red-900" },
  owed: { label: "Still to do (next intake)", tone: "bg-background-200 text-foreground-800" },
};

/** How much of each course is finished and what is left, with every unit's status. Used on the CMS student page and My learning. */
export default function StudyProgress({ courses }: { courses: ProgressCourse[] }) {
  if (!courses.length) return null;
  return (
    <div className="space-y-4" data-testid="study-progress">
      {courses.map((c) => (
        <div key={c.courseId} className="rounded-md border border-background-200 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-medium text-foreground-900">{c.courseCode} {c.courseName}</p>
            <p className="text-sm font-semibold text-foreground-900">{c.competent} of {c.total} units finished · {c.percent}%</p>
          </div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-background-200" role="progressbar" aria-valuenow={c.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${c.courseCode} progress`}>
            <div className="h-full rounded-full bg-green-600" style={{ width: `${c.percent}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-foreground-600">
            {c.total - c.competent} to go{c.inProgress ? ` · ${c.inProgress} studying now` : ""}{c.upcoming ? ` · ${c.upcoming} coming up` : ""}{c.owed ? ` · ${c.owed} still to place in a later intake` : ""}
            {c.awaiting ? ` · ${c.awaiting} waiting for a result` : ""}{c.notYet ? ` · ${c.notYet} not yet competent` : ""}
            {c.hoursTotal ? ` · ${c.hoursDone} of ${c.hoursTotal} hours done` : ""}
          </p>
          <ul className="mt-3 divide-y divide-background-100">
            {c.units.map((u) => {
              const s = STATUS[u.status] ?? { label: u.status, tone: "bg-background-200 text-foreground-800" };
              return (
                <li key={u.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm">
                  <span className="min-w-0 flex-1"><strong className="font-semibold text-foreground-950">{u.code}</strong> <span className="text-foreground-700">{u.name}</span></span>
                  <span className="text-xs text-foreground-500">
                    {u.status === "competent" ? (u.signedOn ? `Finished ${shortDate(u.signedOn)}` : "") : u.start && u.end ? `${shortDate(u.start)} – ${shortDate(u.end)}${u.intake ? ` · ${u.intake} intake` : ""}` : ""}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
