import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Card, PageHeader } from "@/pages/admin/components/ui";
import BatchTimingDrawer from "@/pages/admin/components/rto/BatchTimingDrawer";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import { useToast } from "@/pages/admin/components/toastContext";
import { ListMessage, SearchBox } from "@/pages/admin/components/ListControls";
import { SkeletonCards } from "@/pages/admin/components/rto/overlay";
import HoursNote from "@/pages/admin/components/rto/HoursNote";
import { monthYear, rto, rtoHoursCheck, shortDate, sortIntakes, todayIso, type HoursCheck, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";

/** Batches in three columns: Course (the first is selected) › its Intakes › the selected intake's Batches. RTO Managers add an intake
 *  (column 2) or a batch (column 3) in place; a batch opens its own page. The system also opens a batch by itself when one is full. */
export default function LmsBatchesOverview() {
  const [courses, setCourses] = useState<RtoCourse[] | null>(null);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [hours, setHours] = useState<Record<string, HoursCheck>>({});
  const [canEdit, setCanEdit] = useState(false);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [newIntake, setNewIntake] = useState(false);
  const [addFor, setAddFor] = useState<RtoIntake | null>(null);
  const navigate = useNavigate();
  const { push } = useToast();

  const load = useCallback(async () => {
    try {
      const [cs, list, me] = await Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list"), rto<{ rtoManager: boolean }>("me")]);
      setCourses(cs); setIntakes(list); setCanEdit(Boolean(me.rtoManager)); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Batches did not load."); setCourses([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let live = true;
    void rtoHoursCheck(intakes.flatMap((i) => (i.batchList ?? []).filter((b) => b.isActive).map((b) => b.id))).then((r) => { if (live) setHours(r); });
    return () => { live = false; };
  }, [intakes]);

  const shownCourses = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (courses ?? []).filter((c) => !q || `${c.code} ${c.name}`.toLowerCase().includes(q));
  }, [courses, search]);
  // Column 1: the first course is selected by default (and again when the selected one is filtered out).
  const course = shownCourses.find((c) => c.id === courseId) ?? shownCourses[0] ?? null;
  const courseIntakes = useMemo(() => sortIntakes(intakes.filter((i) => i.courseId === course?.id)), [intakes, course?.id]);
  // Column 2: the selected intake, else the first (running, then upcoming, then finished).
  const intake = courseIntakes.find((i) => i.id === intakeId) ?? courseIntakes[0] ?? null;
  const batches = (intake?.batchList ?? []).filter((b) => b.isActive);
  const intakeOpen = !!intake && intake.status !== "closed" && (!intake.endDate || intake.endDate >= todayIso());
  const count = (courseKey: string) => intakes.filter((i) => i.courseId === courseKey).length;

  const col = "min-w-0 rounded-card border border-background-200 bg-background-50";
  const head = "flex items-center justify-between gap-2 border-b border-background-200 px-3 py-2.5";
  const item = (on: boolean) => `block w-full rounded-lg px-3 py-2 text-left text-sm ${on ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100"}`;

  return (
    <div>
      <PageHeader title="Batches" description="Choose a course, then an intake, to see its batches. Students are placed in a batch with a free seat; a new batch opens by itself when one is full." />
      <div className="mb-4"><SearchBox label="Search courses" value={search} onSearch={setSearch} placeholder="Search course code or name" /></div>
      {error ? <Card><ListMessage icon="ri-error-warning-line" title="Batches did not load" text={error} /></Card> : null}
      {courses === null ? <SkeletonCards /> : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
          {/* 1 · Course */}
          <section className={col} aria-label="Courses">
            <div className={head}><h2 className="font-heading text-base font-semibold text-foreground-900">1 · Course</h2><span className="text-xs text-foreground-500">{shownCourses.length}</span></div>
            <div className="max-h-[70vh] space-y-1 overflow-y-auto p-2">
              {shownCourses.length ? shownCourses.map((c) => (
                <button key={c.id} type="button" aria-pressed={c.id === course?.id} className={item(c.id === course?.id)} onClick={() => { setCourseId(c.id); setIntakeId(""); }}>
                  <span className="flex items-baseline justify-between gap-2"><b className="text-foreground-950">{c.code}</b><span className="text-xs text-foreground-500">{count(c.id)} intake{count(c.id) === 1 ? "" : "s"}</span></span>
                  <span className="block truncate text-foreground-700">{c.name}</span>
                </button>
              )) : <p className="p-3 text-sm text-foreground-500">{search ? "No course matches." : "No courses yet."}</p>}
            </div>
          </section>

          {/* 2 · Intake */}
          <section className={col} aria-label="Intakes">
            <div className={head}>
              <h2 className="font-heading text-base font-semibold text-foreground-900">2 · Intake</h2>
              {canEdit && course ? <Button size="sm" variant="outline" icon="ri-add-line" onClick={() => setNewIntake(true)}>New intake</Button> : null}
            </div>
            <div className="max-h-[70vh] space-y-1 overflow-y-auto p-2">
              {courseIntakes.length ? courseIntakes.map((i) => {
                const running = i.startDate <= todayIso() && (!i.endDate || i.endDate >= todayIso());
                return (
                  <button key={i.id} type="button" aria-pressed={i.id === intake?.id} className={item(i.id === intake?.id)} onClick={() => setIntakeId(i.id)}>
                    <span className="flex items-baseline justify-between gap-2">
                      <b className="text-foreground-950">{shortDate(i.startDate)} – {shortDate(i.endDate)}</b>
                      <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold ${i.status === "closed" ? "bg-background-200 text-foreground-600" : running ? "bg-green-100 text-green-800" : "bg-primary-100 text-primary-800"}`}>
                        {i.status === "closed" ? "Closed" : running ? "Running" : i.endDate && i.endDate < todayIso() ? "Finished" : "Upcoming"}</span>
                    </span>
                    <span className="block text-xs text-foreground-600">{i.batches} batch{i.batches === 1 ? "" : "es"} · {i.enrolled} student{i.enrolled === 1 ? "" : "s"}</span>
                  </button>
                );
              }) : <p className="p-3 text-sm text-foreground-500">{course ? "No intake for this course yet." : "Choose a course."}</p>}
            </div>
          </section>

          {/* 3 · Batch */}
          <section className={col} aria-label="Batches">
            <div className={head}>
              <h2 className="font-heading text-base font-semibold text-foreground-900">3 · Batch{intake ? <span className="ml-1 font-normal text-foreground-500">· {monthYear(intake.startDate)}</span> : null}</h2>
              {canEdit && intakeOpen ? <Button size="sm" icon="ri-add-line" onClick={() => setAddFor(intake)}>Add batch</Button> : null}
            </div>
            <div className="max-h-[70vh] space-y-2 overflow-y-auto p-2">
              {!intake ? <p className="p-3 text-sm text-foreground-500">Choose an intake.</p>
                : batches.length ? batches.map((b) => {
                  const full = !!b.capacity && b.enrolled >= b.capacity;
                  return (
                    <Link key={b.id} to={`/admin/batches/${b.id}`} className="block rounded-lg border border-background-200 p-3 hover:border-primary-300 hover:shadow-md">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="font-heading text-lg font-bold text-foreground-950">{b.name}</p>
                        <span className={`text-sm tabular-nums ${full ? "font-semibold text-primary-700" : "text-foreground-600"}`}>
                          {b.capacity ? `${b.enrolled} of ${b.capacity} seats${full ? " · full" : ""}` : `${b.enrolled} student${b.enrolled === 1 ? "" : "s"}`}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-foreground-700">{b.days.length ? b.days.join(", ") : "No class days set"}</p>
                      <HoursNote check={hours[b.id]} compact />
                    </Link>
                  );
                }) : <p className="p-3 text-sm text-foreground-500">No batch in this intake yet.{canEdit && intakeOpen ? " Add one, or let the system open one when the first student is placed." : ""}</p>}
            </div>
          </section>
        </div>
      )}

      {newIntake && course ? <NewIntakeDrawer open courses={[{ id: course.id, label: course.label }]} courseId={course.id} onClose={() => setNewIntake(false)}
        onCreated={(d, addBatch) => {
          setNewIntake(false); setIntakeId(d.intake.id); void load();
          push(`${course.code} ${monthYear(d.intake.startDate)} intake created.`);
          if (addBatch) setAddFor(d.intake);
        }} /> : null}
      {addFor ? <BatchTimingDrawer intake={addFor} onClose={() => setAddFor(null)}
        onSaved={(out) => {
          setAddFor(null); void load();
          const made = out.batches.find((b) => b.id === out.batchId);
          push(`${made?.name ?? "Batch"} added to ${addFor.courseCode} ${monthYear(addFor.startDate)}.`);
          if (out.batchId) navigate(`/admin/batches/${out.batchId}`);
        }} /> : null}
    </div>
  );
}
