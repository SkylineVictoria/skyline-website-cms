// Create timetable (LMS › Timetable › Create timetable): choose the course and intake, then the one timetable form
// (ClassWeekSetup: the week, room, trainer, seats, Create classes). Unit dates come from the intake (master timetable).
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, PageHeader, Select } from "@/pages/admin/components/ui";
import ClassWeekSetup from "@/pages/admin/components/rto/ClassWeekSetup";
import { rto, shortDate, sortIntakes, todayIso, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";

export default function CreateTimetablePage() {
  const [params, setParams] = useSearchParams();
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [courseId, setCourseId] = useState(params.get("course") ?? "");
  const [intakeId, setIntakeId] = useState(params.get("intake") ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list"), rto<{ rtoManager: boolean }>("me")])
      .then(([c, i, me]) => { setCourses(c); setIntakes(i); setCanEdit(Boolean(me.rtoManager)); })
      .catch((e) => setError(e instanceof Error ? e.message : "The page did not load."));
  }, []);

  const withIntakes = useMemo(() => courses.filter((c) => intakes.some((i) => i.courseId === c.id)), [courses, intakes]);
  const course = withIntakes.find((c) => c.id === courseId) ?? (intakeId ? withIntakes.find((c) => c.id === intakes.find((i) => i.id === intakeId)?.courseId) : null) ?? withIntakes[0] ?? null;
  const courseIntakes = useMemo(() => sortIntakes(intakes.filter((i) => i.courseId === course?.id && i.status !== "closed" && (!i.endDate || i.endDate >= todayIso()))), [intakes, course?.id]);
  const intake = courseIntakes.find((i) => i.id === intakeId) ?? courseIntakes[0] ?? null;
  const pick = (next: { course?: string; intake?: string }) => {
    const c = next.course ?? course?.id ?? ""; const i = next.course ? "" : next.intake ?? "";
    setCourseId(c); setIntakeId(i); setSaved(false); setParams(i ? { course: c, intake: i } : c ? { course: c } : {}, { replace: true });
  };
  const step = "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-500 text-sm font-bold text-background-50";

  return (
    <div className="mx-auto max-w-6xl pb-10">
      <PageHeader title="Create timetable" description="Choose the intake, choose the week, press Create classes. Unit dates come from the master timetable." />
      {error ? <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <Card className="mb-4">
        <div className="flex items-start gap-3"><span className={step}>1</span>
          <div className="min-w-0 flex-1"><h2 className="font-heading text-lg font-semibold text-foreground-950">Course and intake</h2>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">Course
                <Select className="mt-1" value={course?.id ?? ""} onChange={(e) => pick({ course: e.target.value })}>
                  {withIntakes.length ? withIntakes.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>) : <option value="">No course has an intake yet</option>}
                </Select></label>
              <label className="text-sm font-medium">Intake
                <Select className="mt-1" value={intake?.id ?? ""} onChange={(e) => pick({ intake: e.target.value })}>
                  {courseIntakes.length ? courseIntakes.map((i) => <option key={i.id} value={i.id}>{i.customName || i.name} · {shortDate(i.startDate)} – {i.endDate ? shortDate(i.endDate) : "open"}</option>) : <option value="">No open intake</option>}
                </Select></label>
            </div>
            {!withIntakes.length ? <p className="mt-2 text-sm text-foreground-600">Create an intake first in <Link className="font-semibold text-primary-700 hover:underline" to="/admin/lms/intakes">Intakes</Link>.</p> : null}
          </div></div>
      </Card>
      {intake ? <Card>
        <div className="flex items-start gap-3"><span className={step}>2</span>
          <div className="min-w-0 flex-1"><h2 className="mb-1 font-heading text-lg font-semibold text-foreground-950">The week and the classes</h2>
            <ClassWeekSetup key={intake.id} intakeId={intake.id} courseId={intake.courseId} canEdit={canEdit}
              onSaved={() => { setSaved(true); void rto<RtoIntake[]>("intake_list").then(setIntakes).catch(() => undefined); }} />
            {saved ? <p className="mt-2 flex flex-wrap gap-3 text-sm">
              <Link className="font-semibold text-primary-700 hover:underline" to="/admin/lms/timetable">Open the calendar</Link>
              <Link className="font-semibold text-primary-700 hover:underline" to={`/admin/lms/intakes#${intake.id}`}>Open the intake</Link></p> : null}
          </div></div>
      </Card> : null}
    </div>
  );
}
