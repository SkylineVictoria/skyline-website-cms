import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, PageHeader } from "@/pages/admin/components/ui";
import { ListMessage, SearchBox } from "@/pages/admin/components/ListControls";
import { ChipFilter } from "@/pages/admin/components/rto/shared";
import { IntakesView } from "@/pages/admin/components/rto/IntakeCards";
import { useShortcuts } from "@/pages/admin/lib/useShortcuts";
import { phase, rto, sortIntakes, type IntakeStatus, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";

/** Every intake as a card (Courses › Intakes). / = search, N = new intake; a card opens the intake in a sheet. */
export default function IntakesPage({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<RtoIntake[] | null>(null);
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [role, setRole] = useState({ rtoManager: false, admin: false });
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [course, setCourse] = useState("");
  const [status, setStatus] = useState<IntakeStatus | "">("");
  const [when, setWhen] = useState<"" | "upcoming" | "running" | "finished">("");

  const load = useCallback(async () => {
    try {
      const [list, cs, me] = await Promise.all([rto<RtoIntake[]>("intake_list"), rto<RtoCourse[]>("course_list"), rto<{ rtoManager: boolean; admin: boolean }>("me")]);
      setRows(list); setCourses(cs); setRole(me); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Intakes did not load."); setRows((r) => r ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useShortcuts({ "/": () => document.querySelector<HTMLInputElement>('input[aria-label="Search intakes"]')?.focus() });

  const courseChips = useMemo(() => [...new Map((rows ?? []).map((r) => [r.courseId, { id: r.courseId, label: r.courseCode || r.courseName }])).values()]
    .sort((a, b) => a.label.localeCompare(b.label)), [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sortIntakes((rows ?? []).filter((r) => (!q || `${r.name} ${r.courseCode} ${r.courseName}`.toLowerCase().includes(q)) && (!course || r.courseId === course)
      && (!status || r.status === status) && (!when || phase(r) === when)));
  }, [rows, search, course, status, when]);
  const filtered = Boolean(search || course || status || when);

  return (
    <div>
      {embedded ? null : <PageHeader title="Intakes" description="Each intake is one run of a course with its own dates, batches and students." />}
      <div className="sticky top-0 z-10 -mx-1 mb-4 space-y-3 bg-background-100/95 px-1 py-2 backdrop-blur">
        <SearchBox label="Search intakes" value={search} onSearch={setSearch} placeholder="Search intake or course (press /)" />
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <ChipFilter label="Course" value={course} options={courseChips} onChange={setCourse} />
          <ChipFilter label="Status" value={status} options={[{ id: "open", label: "Open" }, { id: "draft", label: "Draft" }, { id: "full", label: "Full" }, { id: "closed", label: "Closed" }]} onChange={(v) => setStatus(v as typeof status)} />
          <ChipFilter label="When" value={when} options={[{ id: "upcoming", label: "Upcoming" }, { id: "running", label: "Running" }, { id: "finished", label: "Finished" }]} onChange={(v) => setWhen(v as typeof when)} />
        </div>
      </div>
      {error ? <Card><ListMessage icon="ri-error-warning-line" title="Intakes did not load" text={error} action={<Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>} /></Card> : null}
      <IntakesView intakes={shown} loading={rows === null} canEdit={role.rtoManager} canEnrol={role.rtoManager || role.admin} showCourse onReload={() => void load()}
        courses={courses.filter((c) => c.isActive).map((c) => ({ id: c.id, label: c.label }))}
        empty={filtered && rows?.length ? { title: "No intakes match", text: "Clear a filter or check the spelling." } : undefined} />
    </div>
  );
}
