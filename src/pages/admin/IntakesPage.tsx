import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, EmptyState, PageHeader } from "@/pages/admin/components/ui";
import { ListMessage, SearchBox } from "@/pages/admin/components/ListControls";
import { ChipFilter, IntakeRow } from "@/pages/admin/components/rto/shared";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import { phase, rto, type IntakeStatus, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";

/** Intakes & Batches: every intake (the master timetable of a course run) with its progress, enrolments and trainers. */
export default function IntakesPage() {
  const [rows, setRows] = useState<RtoIntake[] | null>(null);
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [course, setCourse] = useState("");
  const [campus, setCampus] = useState("");
  const [status, setStatus] = useState<IntakeStatus | "">("");
  const [when, setWhen] = useState<"" | "upcoming" | "running" | "finished">("");
  const [drawer, setDrawer] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, cs, me] = await Promise.all([rto<RtoIntake[]>("intake_list"), rto<RtoCourse[]>("course_list"), rto<{ rtoManager: boolean }>("me")]);
      setRows(list); setCourses(cs); setCanEdit(me.rtoManager); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Intakes did not load."); setRows([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const courseChips = useMemo(() => [...new Map((rows ?? []).map((r) => [r.courseId, { id: r.courseId, label: r.courseCode || r.courseName }])).values()], [rows]);
  const campusChips = useMemo(() => [...new Set((rows ?? []).map((r) => r.campus).filter((c): c is string => Boolean(c)))].map((c) => ({ id: c, label: c })), [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => (!q || `${r.name} ${r.courseCode} ${r.courseName}`.toLowerCase().includes(q)) && (!course || r.courseId === course)
      && (!campus || r.campus === campus) && (!status || r.status === status) && (!when || phase(r) === when));
  }, [rows, search, course, campus, status, when]);

  return (
    <div>
      <PageHeader title="Intakes & Batches" description="Each intake is a course run with its unit schedule, batches, trainers and students."
        actions={canEdit ? <Button icon="ri-add-line" onClick={() => setDrawer(true)}>New intake</Button> : null} />
      <div className="sticky top-0 z-10 -mx-1 mb-4 space-y-3 bg-background-100/95 px-1 py-2 backdrop-blur">
        <SearchBox label="Search intakes" value={search} onSearch={setSearch} placeholder="Search intake or course" />
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <ChipFilter label="Course" value={course} options={courseChips} onChange={setCourse} />
          {campusChips.length > 1 ? <ChipFilter label="Campus" value={campus} options={campusChips} onChange={setCampus} /> : null}
          <ChipFilter label="Status" value={status} options={[{ id: "open", label: "Open" }, { id: "draft", label: "Draft" }, { id: "full", label: "Full" }, { id: "closed", label: "Closed" }]} onChange={(v) => setStatus(v as typeof status)} />
          <ChipFilter label="When" value={when} options={[{ id: "upcoming", label: "Upcoming" }, { id: "running", label: "Running" }, { id: "finished", label: "Finished" }]} onChange={(v) => setWhen(v as typeof when)} />
        </div>
      </div>
      {error ? <Card><ListMessage icon="ri-error-warning-line" title="Intakes did not load" text={error} action={<Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>} /></Card>
        : !rows ? <p className="py-10 text-center text-foreground-500">Loading intakes…</p>
        : shown.length === 0 ? <Card><EmptyState icon="ri-calendar-event-line" title={rows.length ? "No intakes match" : "No intakes yet"} description={rows.length ? "Clear a filter." : canEdit ? "Create the first intake: pick a course and a start date." : "An RTO Manager creates intakes."} /></Card>
        : <div className="space-y-2">{shown.map((r) => <IntakeRow key={r.id} intake={r} />)}</div>}
      <NewIntakeDrawer open={drawer} onClose={() => setDrawer(false)} courses={courses.filter((c) => c.isActive).map((c) => ({ id: c.id, label: c.label, campus: c.campus }))} />
    </div>
  );
}
