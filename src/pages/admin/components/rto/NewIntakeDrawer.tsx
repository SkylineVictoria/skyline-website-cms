// New intake: one field, the start date, filled in from the calendar (the next term start this course has no intake for). The
// schedule is laid out from the course's units, skipping public holidays and term breaks. "Create" or "Create & set class
// timing" (the intake is the class group: its timetable is set in the class timetable form).
// A course with a master timetable (LMS > Courses > Master timetable) has no start date to choose: every intake of the course
// follows the master's dates, so the intake is one more group on that calendar.
import { useEffect, useMemo, useState } from "react";
import { ruleNumber, ruleText, weekdayIndex } from "@/lib/businessRules";
import { Button, Field, Select } from "@/pages/admin/components/ui";
import BreakDatePicker from "@/pages/admin/components/rto/BreakDatePicker";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import { supabase } from "@/pages/admin/lib/supabase";
import {
  addDays, intakeDefaultName, listBreaks, mondayOf, rto, setIntakeLoad, LOAD_HOURS, type StudyLoad, shortDate, todayIso, type AcademicBreak, type CourseDetail, type IntakeDetail,
} from "@/pages/admin/lib/rto";

/** The first term start (the start weekday after a break) at least the notice away that the course has no intake on; else the next free start weekday.
 * Notice and weekday come from Business Rules (lms.intake_suggested_notice_days, lms.intake_suggested_start_day). */
function suggestStart(breaks: AcademicBreak[], taken: Set<string>) {
  const soonest = addDays(todayIso(), ruleNumber("lms.intake_suggested_notice_days", 7));
  const dayName = ruleText("lms.intake_suggested_start_day", "Monday");
  const offset = (Math.max(0, weekdayIndex(dayName)) + 6) % 7; // days after Monday
  const onOrAfter = (d: string) => { let x = addDays(mondayOf(d), offset); if (x < d) x = addDays(x, 7); return x; };
  const starts = breaks.map((b) => onOrAfter(addDays(b.endDate, 1))).filter((d) => d >= soonest && !taken.has(d)).sort();
  if (starts.length) return { date: starts[0], why: "the next term start" };
  let d = onOrAfter(soonest);
  while (taken.has(d)) d = addDays(d, 7);
  return { date: d, why: `the next free ${dayName}` };
}

export default function NewIntakeDrawer({ open, onClose, courses, courseId, onCreated, allowBatch = true, requireUnitSchedule = false, zIndex, title = "New intake", createLabel = "Create" }: {
  open: boolean; onClose: () => void;
  /** Courses to choose from when the drawer is not opened from a course. */
  courses: { id: string; label: string }[];
  /** Opened from a course (or the enrolment wizard): the course is fixed and not shown as a choice. */
  courseId?: string;
  onCreated: (detail: IntakeDetail, addBatch: boolean) => void;
  /** "Create & set up classes" is for the LMS pages; the enrolment wizard only creates the intake. */
  allowBatch?: boolean;
  requireUnitSchedule?: boolean;
  /** Stacking layer when opened over another dialog (the wizard). */
  zIndex?: string;
  title?: string;
  /** The Create button's words (the new course wizard goes on to the class timing). */
  createLabel?: string;
}) {
  const [chosen, setChosen] = useState(courseId ?? "");
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [breaks, setBreaks] = useState<AcademicBreak[]>([]);
  const [start, setStart] = useState("");
  const [load, setLoad] = useState<StudyLoad | "">("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<"" | "create" | "batch">("");
  const [error, setError] = useState("");
  // The course's saved master timetable (first and last day), when it has one.
  const [master, setMaster] = useState<{ startDate: string; endDate: string | null } | null>(null);
  // On a master course the intakes share their dates, so each one is told apart by its name ("Intake 1", "Intake 2", ...).
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);

  useEffect(() => { if (open) { setChosen(courseId ?? ""); setTouched(false); setError(""); if (requireUnitSchedule) setStart(""); } }, [open, courseId, requireUnitSchedule]);
  useEffect(() => { if (open) listBreaks(chosen || null).then(setBreaks).catch(() => undefined); }, [open, chosen]);
  useEffect(() => {
    if (!open || !chosen) { setCourse(null); return; }
    let live = true;
    rto<CourseDetail>("course_get", { courseId: chosen }).then((d) => { if (live) setCourse(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "The course did not load."); });
    return () => { live = false; };
  }, [open, chosen]);

  useEffect(() => {
    setMaster(null);
    if (!open || !chosen) return;
    let live = true;
    supabase.rpc("rto_master_timetable", { p_action: "get", p_data: { courseId: chosen } }).then(({ data }) => {
      const found = data as { saved?: boolean; startDate?: string | null; endDate?: string | null } | null;
      if (live && found?.saved && found.startDate) { setMaster({ startDate: found.startDate, endDate: found.endDate ?? null }); setStart(found.startDate); }
    });
    return () => { live = false; };
  }, [open, chosen]);

  const taken = useMemo(() => new Set((course?.intakes ?? []).map((i) => i.startDate)), [course]);
  const suggestion = useMemo(() => (course ? suggestStart(breaks, taken) : null), [course, breaks, taken]);
  useEffect(() => { if (suggestion && !touched && !requireUnitSchedule && !master) setStart(suggestion.date); }, [suggestion, touched, requireUnitSchedule, master]);

  useEffect(() => { if (!open) { setName(""); setNamed(false); } }, [open]);
  useEffect(() => {
    if (master && course && !named && start) setName(intakeDefaultName(course.course.code, load || "coe", start, (course.intakes ?? []).map((i) => i.customName || i.name)));
  }, [master, course, named, load, start]);
  const units = (course?.units ?? []).filter((u) => u.isActive);
  const weeks = units.reduce((s, u) => s + (u.defaultWeeks || 0), 0);
  // With a master the dates are the master's: several intakes share them, and term breaks are already in the master.
  const inBreak = master ? undefined : breaks.find((b) => start >= b.startDate && start <= b.endDate);
  const clash = !master && start && taken.has(start);
  const blocked = !!busy || !chosen || !start || !load || !!clash || !!inBreak || (!!master && !name.trim())
    || (requireUnitSchedule && (course?.course.id !== chosen || !units.length));

  const create = async (addBatch: boolean) => {
    if (blocked) return;
    setBusy(addBatch ? "batch" : "create"); setError("");
    try {
      let out = await rto<IntakeDetail>("intake_save", { courseId: chosen, startDate: start, status: "open", generate: true, campus: course?.course.campus ?? "", ...(master ? { name: name.trim() } : {}) });
      // VoE: 40 hours a week, so the unit timeline is laid out again at twice the CoE rate.
      if (load === "voe") { await setIntakeLoad(out.intake.id, "voe"); out = await rto<IntakeDetail>("intake_get", { intakeId: out.intake.id }); }
      onCreated(out, addBatch);
    } catch (e) { setError(e instanceof Error ? e.message : "The intake was not created."); }
    finally { setBusy(""); }
  };

  return (
    <Drawer open={open} title={title} onClose={onClose} zIndex={zIndex}
      footer={<>
        <Button variant={allowBatch ? "outline" : undefined} disabled={blocked} onClick={() => void create(false)} data-testid="new-intake-create">{busy === "create" ? "Creating…" : createLabel}</Button>
        {allowBatch ? <Button disabled={blocked} onClick={() => void create(true)}>{busy === "batch" ? "Creating…" : "Create & set up classes"}</Button> : null}
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
      {master ? <Field label="Intake name" required hint="Intakes of this course share the master timetable's dates; the name tells them apart.">
        <input className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm" value={name} maxLength={80} data-testid="new-intake-name"
          onChange={(e) => { setName(e.target.value); setNamed(true); }} />
      </Field> : null}
      {master ? <p className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900" data-testid="new-intake-master">
        This course has a master timetable. The intake follows it: {shortDate(master.startDate)}{master.endDate ? ` to ${shortDate(master.endDate)}` : ""}. To change the dates, change the master timetable on the course.
      </p> : <Field label={requireUnitSchedule ? "Intake start date" : "Start date"} required hint={suggestion && start === suggestion.date ? `Filled in with ${suggestion.why}.` : undefined}>
        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground-900">{start ? new Date(start + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "Pick a day below"}</p>
          {requireUnitSchedule && suggestion && !start && <button type="button" onClick={() => {
            setStart(suggestion.date); setTouched(true);
          }} className="text-sm font-semibold text-primary-700 underline">Use {shortDate(suggestion.date)}</button>}
          <BreakDatePicker value={start} onChange={(d) => { setStart(d); setTouched(true); }} breaks={breaks} taken={taken} takenLabel="Another intake starts" today={todayIso()} />
        </div>
      </Field>}
      {!busy && !clash && !inBreak && (!load || !start) ? <p className="text-sm text-foreground-600">To create it, still choose: {[!load && "CoE or VoE", !start && "a start date"].filter(Boolean).join(" and ")}.</p> : null}
      {clash ? <p role="alert" className="text-sm text-primary-800">This course already has an intake starting on {shortDate(start)}.</p> : null}
      {inBreak ? <p className="text-sm text-amber-800"><i className="ri-error-warning-line mr-1" aria-hidden="true" />{shortDate(start)} is in the {inBreak.label.toLowerCase()} ({shortDate(inBreak.startDate)} – {shortDate(inBreak.endDate)}). Pick a day outside the break.</p> : null}
      {course ? (
        <p className="rounded-md bg-background-100 px-3 py-2 text-sm text-foreground-700">
          {units.length
            ? master ? <>The intake gets the master timetable’s unit dates for the course’s {units.length} units. It is active as soon as it is created.</>
              : <>The timeline is laid out from the course’s {units.length} units (about {weeks} weeks of classes), skipping public holidays and term breaks. It is active as soon as it is created.</>
            : <>{requireUnitSchedule ? "Add active units to this course before creating its intake calendar." : "This course has no units yet. Add the units in the course’s Units & Timetable step."}</>}
        </p>
      ) : chosen ? <p className="text-sm text-foreground-500">Loading the course…</p> : null}
    </Drawer>
  );
}
