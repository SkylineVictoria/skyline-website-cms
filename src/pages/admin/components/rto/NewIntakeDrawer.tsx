// New intake: one field, the start date, filled in from the calendar (the next term start this course has no intake for). The
// schedule is laid out from the course's units, skipping public holidays and term breaks. "Create" or "Create & add batch".
import { useEffect, useMemo, useState } from "react";
import { Button, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import {
  addDays, listBreaks, mondayOf, rto, shortDate, todayIso, type AcademicBreak, type CourseDetail, type IntakeDetail,
} from "@/pages/admin/lib/rto";

/** The first term start (the Monday after a break) at least a week away that the course has no intake on; else next Monday. */
function suggestStart(breaks: AcademicBreak[], taken: Set<string>) {
  const soonest = addDays(todayIso(), 7);
  const starts = breaks.map((b) => addDays(b.endDate, 1)).map((d) => (mondayOf(d) === d ? d : addDays(mondayOf(d), 7))).filter((d) => d >= soonest && !taken.has(d)).sort();
  if (starts.length) return { date: starts[0], why: "the next term start" };
  let d = mondayOf(soonest) < soonest ? addDays(mondayOf(soonest), 7) : mondayOf(soonest);
  while (taken.has(d)) d = addDays(d, 7);
  return { date: d, why: "the next free Monday" };
}

export default function NewIntakeDrawer({ open, onClose, courses, courseId, onCreated }: {
  open: boolean; onClose: () => void;
  /** Courses to choose from when the drawer is not opened from a course. */
  courses: { id: string; label: string }[];
  courseId?: string;
  onCreated: (detail: IntakeDetail, addBatch: boolean) => void;
}) {
  const [chosen, setChosen] = useState(courseId ?? "");
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [breaks, setBreaks] = useState<AcademicBreak[]>([]);
  const [start, setStart] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<"" | "create" | "batch">("");
  const [error, setError] = useState("");

  useEffect(() => { if (open) { setChosen(courseId ?? ""); setTouched(false); setError(""); } }, [open, courseId]);
  useEffect(() => { if (open) listBreaks().then(setBreaks).catch(() => undefined); }, [open]);
  useEffect(() => {
    if (!open || !chosen) { setCourse(null); return; }
    let live = true;
    rto<CourseDetail>("course_get", { courseId: chosen }).then((d) => { if (live) setCourse(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "The course did not load."); });
    return () => { live = false; };
  }, [open, chosen]);

  const taken = useMemo(() => new Set((course?.intakes ?? []).map((i) => i.startDate)), [course]);
  const suggestion = useMemo(() => (course ? suggestStart(breaks, taken) : null), [course, breaks, taken]);
  useEffect(() => { if (suggestion && !touched) setStart(suggestion.date); }, [suggestion, touched]);

  const units = (course?.units ?? []).filter((u) => u.isActive);
  const weeks = units.reduce((s, u) => s + (u.defaultWeeks || 0), 0);
  const inBreak = breaks.find((b) => start >= b.startDate && start <= b.endDate);
  const clash = start && taken.has(start);

  const create = async (addBatch: boolean) => {
    if (!chosen || !start) { setError("Choose a course and a start date."); return; }
    setBusy(addBatch ? "batch" : "create"); setError("");
    try {
      const out = await rto<IntakeDetail>("intake_save", { courseId: chosen, startDate: start, status: "draft", generate: true, campus: course?.course.campus ?? "" });
      onCreated(out, addBatch);
    } catch (e) { setError(e instanceof Error ? e.message : "The intake was not created."); }
    finally { setBusy(""); }
  };

  return (
    <Drawer open={open} title="New intake" onClose={onClose}
      footer={<>
        <Button variant="outline" disabled={!!busy || !chosen || !start || !!clash} onClick={() => void create(false)}>{busy === "create" ? "Creating…" : "Create"}</Button>
        <Button disabled={!!busy || !chosen || !start || !!clash} onClick={() => void create(true)}>{busy === "batch" ? "Creating…" : "Create & add batch"}</Button>
      </>}>
      <ErrorNote text={error} />
      {courseId ? null : (
        <Field label="Course" required>
          <Select value={chosen} onChange={(e) => { setChosen(e.target.value); setTouched(false); }}>
            <option value="">Choose a course</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Start date" required hint={suggestion && start === suggestion.date ? `Filled in with ${suggestion.why}.` : undefined}>
        <TextInput type="date" autoFocus value={start} onChange={(e) => { setStart(e.target.value); setTouched(true); }} />
      </Field>
      {clash ? <p role="alert" className="text-sm text-primary-800">This course already has an intake starting on {shortDate(start)}.</p> : null}
      {inBreak ? <p className="text-sm text-amber-800"><i className="ri-error-warning-line mr-1" aria-hidden="true" />{shortDate(start)} is in the {inBreak.label.toLowerCase()} ({shortDate(inBreak.startDate)} – {shortDate(inBreak.endDate)}); classes start after it.</p> : null}
      {course ? (
        <p className="rounded-md bg-background-100 px-3 py-2 text-sm text-foreground-700">
          {units.length
            ? <>The timeline is laid out from the course’s {units.length} units (about {weeks} weeks of classes), skipping public holidays and term breaks. It starts as a draft; open it when you are ready to take students.</>
            : <>This course has no units yet, so the intake starts without a timeline. Add the units in the course’s Units &amp; Timetable step.</>}
        </p>
      ) : chosen ? <p className="text-sm text-foreground-500">Loading the course…</p> : null}
    </Drawer>
  );
}
