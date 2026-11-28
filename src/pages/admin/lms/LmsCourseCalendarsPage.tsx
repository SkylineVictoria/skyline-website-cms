import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import SearchableSelect from "@/components/ui/SearchableSelect";
import { rto, type CourseDetail, type RtoCourse } from "@/pages/admin/lib/rto";
import MasterTimetableTab from "./MasterTimetableTab";
import { VoeTab } from "./VoeCalendarEditor";
import { DailyTimetableTab } from "./CourseWeeklyTimetable";

/**
 * LMS › Master calendar and LMS › Weekly calendar (owner 2026-11-28: "separate screens under Courses in the main menu, not inside the
 * course view"). Pick a course and CoE or VoE: the Master calendar shows the course's cycles and unit dates (its intakes and batches
 * follow it; editable here); the Weekly calendar shows the week of the course's open intakes (days, times, rooms, trainers).
 * ?course=<id> (and ?load=coe|voe) opens a course directly.
 */
export default function LmsCourseCalendarsPage({ kind }: { kind: "master" | "weekly" }) {
  const [params, setParams] = useSearchParams();
  const [courses, setCourses] = useState<RtoCourse[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState("");
  const courseId = params.get("course") ?? "";
  const loadParam = params.get("load");
  const [detail, setDetail] = useState<CourseDetail | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([rto<RtoCourse[]>("course_list"), rto<{ rtoManager: boolean }>("me").catch(() => ({ rtoManager: false }))])
      .then(([list, me]) => { if (!live) return; setCourses(list); setCanEdit(!!me.rtoManager); })
      .catch((e) => { if (live) { setCourses([]); setError(e instanceof Error ? e.message : "The courses could not be loaded."); } });
    return () => { live = false; };
  }, []);
  // The first course when none is chosen.
  useEffect(() => {
    if (courses?.length && !courses.some((c) => c.id === courseId)) setParams((p) => { p.set("course", courses[0].id); return p; }, { replace: true });
  }, [courses, courseId, setParams]);
  useEffect(() => {
    if (!courseId || kind !== "weekly") { setDetail(null); return; }
    let live = true;
    setDetail(null);
    rto<CourseDetail>("course_get", { courseId }).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The course could not be loaded."); });
    return () => { live = false; };
  }, [courseId, kind]);

  const course = courses?.find((c) => c.id === courseId) ?? null;
  // A course on the CRICOS register runs CoE intakes first; otherwise VoE.
  const load: "coe" | "voe" = loadParam === "coe" || loadParam === "voe" ? loadParam : course?.cricos ? "coe" : "voe";
  const setLoad = (l: "coe" | "voe") => setParams((p) => { p.set("load", l); return p; }, { replace: true });
  const title = kind === "master" ? "Master calendar" : "Weekly calendar";

  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">{title}</h1>
        <p className="text-sm text-foreground-500">{kind === "master"
          ? "Each course's cycles and unit dates (CoE and VoE). Its intakes and batches follow them."
          : "The week of each course's open intakes: days, times, rooms and trainers."}</p>
      </div>
    </header>
    <section className="flex flex-wrap items-end gap-3 rounded-2xl border border-background-200 bg-background-50 p-4 shadow-sm">
      <label className="min-w-72 flex-1 text-sm font-medium text-foreground-800">Course
        <SearchableSelect aria-label="Course" value={courseId} disabled={!courses?.length}
          onChange={(e) => setParams((p) => { p.set("course", e.target.value); p.delete("load"); return p; }, { replace: true })}
          className="mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm">
          {!courses ? <option value="">Loading courses…</option> : !courses.length ? <option value="">No courses yet</option>
            : courses.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
        </SearchableSelect>
      </label>
      <div className="inline-flex overflow-hidden rounded-lg border border-background-300 text-sm font-semibold" role="group" aria-label="CoE or VoE">
        {([["coe", "CoE"], ["voe", "VoE"]] as const).map(([k, label]) => <button key={k} type="button" aria-pressed={load === k} onClick={() => setLoad(k)}
          className={`px-5 py-2 ${load === k ? "bg-primary-600 text-white" : "bg-background-50 text-foreground-700 hover:bg-background-100"}`}>{label}</button>)}
      </div>
    </section>
    {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {!course ? (courses ? null : <p className="text-sm text-foreground-500">Loading…</p>) : <section className="min-w-0 rounded-2xl border border-background-200 bg-background-50 p-5 shadow-sm">
      {kind === "master"
        ? (load === "coe" ? <MasterTimetableTab key={course.id + ":coe"} courseId={course.id} courseCode={course.code} />
          : <VoeTab key={course.id + ":voe"} course={course} canEdit={canEdit} />)
        : detail ? <DailyTimetableTab key={course.id + ":" + load} courseId={course.id} intakes={detail.intakes} canEdit={canEdit} load={load} />
          : <p className="text-sm text-foreground-500">Loading…</p>}
    </section>}
  </div>;
}
