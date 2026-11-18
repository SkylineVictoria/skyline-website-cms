// New intake: one field, the start date, filled in from the calendar (the next term start this course has no intake for). The
// schedule is laid out from the course's units, skipping public holidays and term breaks. "Create" or "Create & add batch".
import { useEffect, useMemo, useState } from "react";
import { Button, Field, Select } from "@/pages/admin/components/ui";
import BreakDatePicker from "@/pages/admin/components/rto/BreakDatePicker";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import {
  addDays, listBreaks, mondayOf, rto, setIntakeLoad, LOAD_HOURS, type StudyLoad, shortDate, todayIso, type AcademicBreak, type CourseDetail, type IntakeDetail,
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

export default function NewIntakeDrawer({ open, onClose, courses, courseId, onCreated, allowBatch = true, requireUnitSchedule = false, zIndex, title = "New intake" }: {
  open: boolean; onClose: () => void;
  /** Courses to choose from when the drawer is not opened from a course. */
  courses: { id: string; label: string }[];
  /** Opened from a course (or the enrolment wizard): the course is fixed and not shown as a choice. */
  courseId?: string;
  onCreated: (detail: IntakeDetail, addBatch: boolean) => void;
  /** "Create & add batch" is for the LMS pages; the enrolment wizard only creates the intake. */
  allowBatch?: boolean;
  requireUnitSchedule?: boolean;
  /** Stacking layer when opened over another dialog (the wizard). */
  zIndex?: string;
  title?: string;
}) {
  const [chosen, setChosen] = useState(courseId ?? "");
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [breaks, setBreaks] = useState<AcademicBreak[]>([]);
  const [start, setStart] = useState("");
  const [load, setLoad] = useState<StudyLoad | "">("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<"" | "create" | "batch">("");
  const [error, setError] = useState("");

  useEffect(() => { if (open) { setChosen(courseId ?? ""); setTouched(false); setError(""); if (requireUnitSchedule) setStart(""); } }, [open, courseId, requireUnitSchedule]);
  useEffect(() => { if (open) listBreaks(chosen || null).then(setBreaks).catch(() => undefined); }, [open, chosen]);
  useEffect(() => {
    if (!open || !chosen) { setCourse(null); return; }
    let live = true;
    rto<CourseDetail>("course_get", { courseId: chosen }).then((d) => { if (live) setCourse(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "The course did not load."); });
    return () => { live = false; };
  }, [open, chosen]);

  const taken = useMemo(() => new Set((course?.intakes ?? []).map((i) => i.startDate)), [course]);
  const suggestion = useMemo(() => (course ? suggestStart(breaks, taken) : null), [course, breaks, taken]);
  useEffect(() => { if (suggestion && !touched && !requireUnitSchedule) setStart(suggestion.date); }, [suggestion, touched, requireUnitSchedule]);

  const units = (course?.units ?? []).filter((u) => u.isActive);
  const weeks = units.reduce((s, u) => s + (u.defaultWeeks || 0), 0);
  const inBreak = breaks.find((b) => start >= b.startDate && start <= b.endDate);
  const clash = start && taken.has(start);
  const blocked = !!busy || !chosen || !start || !load || !!clash || !!inBreak
    || (requireUnitSchedule && (course?.course.id !== chosen || !units.length));

  const create = async (addBatch: boolean) => {
    if (blocked) return;
    setBusy(addBatch ? "batch" : "create"); setError("");
    try {
      let out = await rto<IntakeDetail>("intake_save", { courseId: chosen, startDate: start, status: "open", generate: true, campus: course?.course.campus ?? "" });
      // VoE: 40 hours a week, so the unit timeline is laid out again at twice the CoE rate.
      if (load === "voe") { await setIntakeLoad(out.intake.id, "voe"); out = await rto<IntakeDetail>("intake_get", { intakeId: out.intake.id }); }
      onCreated(out, addBatch);
    } catch (e) { setError(e instanceof Error ? e.message : "The intake was not created."); }
    finally { setBusy(""); }
  };

  return (
    <Drawer open={open} title={title} onClose={onClose} zIndex={zIndex}
      footer={<>
        <Button variant={allowBatch ? "outline" : undefined} disabled={blocked} onClick={() => void create(false)} data-testid="new-intake-create">{busy === "create" ? "Creating…" : "Create"}</Button>
        {allowBatch ? <Button disabled={blocked} onClick={() => void create(true)}>{busy === "batch" ? "Creating…" : "Create & add batch"}</Button> : null}
      </>}>
      <ErrorNote text={error} />
      {courseId ? null : (
        <Field label="Course" required>
          <Select value={chosen} onChange={(e) => { setChosen(e.target.value); setTouched(false); if (requireUnitSchedule) setStart(""); }}>
            <option value="">Choose a course</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Students on" required hint="CoE students have 20 class hours a week; VoE students have 40.">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="CoE or VoE">
          {(["coe", "voe"] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={load === l} onClick={() => setLoad(l)}
              className={`rounded-lg border-2 px-3 py-2.5 text-left text-sm ${load === l ? "border-primary-600 bg-primary-50 font-semibold text-primary-900" : "border-background-300 hover:border-primary-400"}`}>
              <span className="block text-base font-bold">{l === "coe" ? "CoE" : "VoE"}</span>
              <span className="block text-xs text-foreground-600">{LOAD_HOURS[l]} hours a week</span>
            </button>
          ))}
        </div>
      </Field>
      <Field label={requireUnitSchedule ? "Intake start date" : "Start date"} required hint={suggestion && start === suggestion.date ? `Filled in with ${suggestion.why}.` : undefined}>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground-900">{start ? new Date(start + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "Pick a day below"}</p>
          {requireUnitSchedule && suggestion && !start && <button type="button" onClick={() => {
            setStart(suggestion.date); setTouched(true);
          }} className="text-sm font-semibold text-primary-700 underline">Use {shortDate(suggestion.date)}</button>}
          <BreakDatePicker value={start} onChange={(d) => { setStart(d); setTouched(true); }} breaks={breaks} taken={taken} takenLabel="Another intake starts" today={todayIso()} />
        </div>
      </Field>
      {!busy && !clash && !inBreak && (!load || !start) ? <p className="text-sm text-foreground-600">To create it, still choose: {[!load && "CoE or VoE", !start && "a start date"].filter(Boolean).join(" and ")}.</p> : null}
      {clash ? <p role="alert" className="text-sm text-primary-800">This course already has an intake starting on {shortDate(start)}.</p> : null}
      {inBreak ? <p className="text-sm text-amber-800"><i className="ri-error-warning-line mr-1" aria-hidden="true" />{shortDate(start)} is in the {inBreak.label.toLowerCase()} ({shortDate(inBreak.startDate)} – {shortDate(inBreak.endDate)}). Pick a day outside the break.</p> : null}
      {course ? (
        <p className="rounded-md bg-background-100 px-3 py-2 text-sm text-foreground-700">
          {units.length
            ? <>The timeline is laid out from the course’s {units.length} units (about {weeks} weeks of classes), skipping public holidays and term breaks. It is active as soon as it is created.</>
            : <>{requireUnitSchedule ? "Add active units to this course before creating its intake calendar." : "This course has no units yet. Add the units in the course’s Units & Timetable step."}</>}
        </p>
      ) : chosen ? <p className="text-sm text-foreground-500">Loading the course…</p> : null}
    </Drawer>
  );
}
