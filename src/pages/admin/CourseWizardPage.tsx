import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import WizardStepper, { type WizardStepperItem } from "@/components/shared/wizard/WizardStepper";
import { WIZARD_PRIMARY_CLASS, WizardBackButton, WizardNotice } from "@/components/shared/wizard/WizardShell";
import { Badge, Card, StatusBadge } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { ErrorNote, FeesEditor, ReadOnlyNote } from "@/pages/admin/components/rto/shared";
import { CourseFacts, UnitsTab, WebsiteTab } from "@/pages/admin/components/rto/CourseSteps";
import IntakesStep from "@/pages/admin/components/rto/IntakesStep";
import CourseAssessmentsStep from "@/pages/admin/components/rto/CourseAssessmentsStep";
import { DEPOSIT_LIMIT_CENTS, money, rto, shortDate, stepPath, todayIso, type CourseDetail, type CourseStep, type RtoCourse } from "@/pages/admin/lib/rto";

const STEPS: { id: CourseStep; short: string; title: string; icon: string; hint: string }[] = [
  { id: "details", short: "Details", title: "Course details", icon: "ri-information-line", hint: "Name, codes, category, duration and campus." },
  { id: "timetable", short: "Units & Timetable", title: "Units & master timetable", icon: "ri-list-check-2", hint: "The units in delivery order with their weeks and hours. Every intake is generated from this." },
  { id: "fees", short: "Fees", title: "Fees", icon: "ri-money-dollar-circle-line", hint: "The fee lines as the offer letter prints them. Every intake uses these unless its fees are changed for that intake." },
  { id: "intakes", short: "Intakes", title: "Intakes and batches", icon: "ri-calendar-event-line", hint: "Each intake is one run of the course with its own dates. Open one for its timeline, batches and students." },
  { id: "assessments", short: "Assessments", title: "Assessments per unit", icon: "ri-edit-box-line", hint: "The form-built assessments mapped to each unit of competency; versions are published, then assigned to batches." },
  { id: "website", short: "Website", title: "Website", icon: "ri-global-line", hint: "Marketing settings and the publish checklist; facts come from the steps before." },
];

/** What a step still needs (empty: done). Short notes, shown on the step pill and above the step. */
function attention(d: CourseDetail): Record<CourseStep, string[]> {
  const c = d.course, today = todayIso();
  const active = d.units.filter((u) => u.isActive);
  const noHours = active.filter((u) => u.nominalHours === null).length;
  const deposit = d.fees.filter((f) => f.type === "initial_deposit").reduce((s, f) => s + f.amountCents, 0);
  return {
    details: [!c.name.trim() && "Add a name", !c.code.trim() && "Add the course code", !c.category && "Choose a category"].filter(Boolean) as string[],
    timetable: [active.length === 0 && "Add the units", active.some((u) => !(u.defaultWeeks >= 0.5)) && "Units missing weeks", noHours > 0 && `${noHours} unit${noHours === 1 ? " has" : "s have"} no hours`].filter(Boolean) as string[],
    fees: [!d.fees.some((f) => f.type === "tuition") && "No tuition fee", deposit > DEPOSIT_LIMIT_CENTS && `Deposit ${money(deposit)} is above $1,500`].filter(Boolean) as string[],
    intakes: [!d.intakes.some((i) => i.status === "open" && i.startDate >= today) && "No open intake"].filter(Boolean) as string[],
    assessments: [],
    website: [c.status !== "Published" && "Unpublished"].filter(Boolean) as string[],
  };
}

/** Courses › a course: one guided flow (Details → Units & Timetable → Fees → Intakes → Website), autosaved, one address per step. */
export default function CourseWizardPage() {
  const { id = "", step = "details" } = useParams();
  const navigate = useNavigate();
  const { push } = useToast();
  const { reload } = useAdminData();
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [role, setRole] = useState({ rtoManager: false, admin: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, me] = await Promise.all([rto<CourseDetail>("course_get", { courseId: id }), rto<{ rtoManager: boolean; admin: boolean }>("me")]);
      setDetail(d); setRole(me); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "The course did not load."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  /** Saves quietly (autosave): the result replaces the course; a failure is shown. */
  const save = useCallback(async (action: string, data: Record<string, unknown>) => {
    setBusy(true);
    try {
      const out = await rto<CourseDetail | RtoCourse>(action, { courseId: id, ...data });
      if ("course" in out) setDetail(out); else setDetail((d) => (d ? { ...d, course: out } : d));
      setSavedAt(new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }));
      reload(); // the website editor's copy of the course stays in step
    } catch (e) { push(e instanceof Error ? e.message : "Not saved.", "error"); }
    finally { setBusy(false); }
  }, [id, push, reload]);

  const websiteOnly = !role.rtoManager && !role.admin;
  const steps = websiteOnly ? STEPS.filter((s) => s.id === "website") : STEPS;
  const index = steps.findIndex((s) => s.id === step);
  const notes = useMemo(() => (detail ? attention(detail) : null), [detail]);

  if (error) return <Card className="p-8"><ErrorNote text={error} /><div className="mt-4"><Link to="/admin/course-fees" className="text-sm text-primary-600">Back to Courses</Link></div></Card>;
  if (!detail || !notes) return <p className="py-10 text-center text-foreground-500">Loading course…</p>;
  if (index < 0) return <Navigate to={stepPath(id, steps[0].id)} replace />;
  const current = steps[index];
  const c = detail.course;
  const canEdit = role.rtoManager;
  const go = (to: number) => { if (to >= 0 && to < steps.length) navigate(stepPath(id, steps[to].id)); };
  const items: WizardStepperItem[] = steps.map((s) => ({ id: s.id, short: s.short, icon: notes[s.id].length ? "ri-error-warning-line" : s.id === current.id ? "ri-edit-line" : "ri-checkbox-blank-circle-line", done: notes[s.id].length === 0 }));
  const doneCount = steps.filter((s) => notes[s.id].length === 0).length;

  return (
    <div className="w-full min-w-0">
      <div className="sticky top-0 z-10 mb-4 rounded-b-xl border border-t-0 border-background-200 bg-background-50/95 backdrop-blur">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-2 pt-3">
          <div className="min-w-0">
            <Link to="/admin/course-fees" className="inline-flex items-center gap-1 text-label font-medium text-foreground-500 hover:text-primary-600"><i className="ri-arrow-left-line" aria-hidden="true" />Courses</Link>
            <div className="flex flex-wrap items-center gap-2"><h1 className="font-heading text-xl font-bold text-foreground-950">{c.label}</h1><StatusBadge status={c.status} />{c.isActive ? null : <Badge>Inactive</Badge>}</div>
            <p className="text-xs text-foreground-500">{[c.cricos && `CRICOS ${c.cricos}`, c.duration, `${c.activeUnits} units`, c.totalCents ? `Total ${money(c.totalCents)}` : null, c.nextIntake ? `Next intake ${shortDate(c.nextIntake)}` : null].filter(Boolean).join(" · ")}</p>
          </div>
          <p className="text-xs text-foreground-500">{busy ? "Saving…" : savedAt ? `Saved ${savedAt}` : "Changes save automatically"}</p>
        </div>
        <div className="px-5 pb-1"><div className="h-1.5 overflow-hidden rounded-full bg-background-200" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount} aria-label={`${doneCount} of ${steps.length} steps complete`}>
          <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div></div>
        <WizardStepper items={items} current={index} onSelect={go} />
      </div>

      <div className="mb-3">
        <h2 className="font-heading text-lg font-semibold text-foreground-950">{index + 1}. {current.title}</h2>
        <p className="text-sm text-foreground-600">{current.hint}</p>
      </div>
      {notes[current.id].length ? <div className="mb-3 overflow-hidden rounded-md border border-background-200"><WizardNotice tone="warn">Needs attention: {notes[current.id].join(" · ")}</WizardNotice></div> : null}
      {!canEdit && current.id !== "website" ? <div className="mb-3"><ReadOnlyNote>{role.admin ? "You can view this course and enrol students into existing batches. Only an RTO Manager changes it." : "Read only."}</ReadOnlyNote></div> : null}

      {current.id === "details" ? <CourseFacts course={c} readOnly={!canEdit} busy={busy} autosave onSave={(data) => void save("course_save", data)} /> : null}
      {current.id === "timetable" ? <UnitsTab units={detail.units} readOnly={!canEdit} busy={busy} autosave onSave={(units) => void save("units_save", { units })} /> : null}
      {current.id === "fees" ? <Card className="p-5"><FeesEditor items={detail.fees} readOnly={!canEdit} busy={busy} autosave onSave={(items) => void save("fees_save", { items })} /></Card> : null}
      {current.id === "intakes" ? <IntakesStep detail={detail} canEdit={canEdit} canEnrol={role.rtoManager || role.admin} onChanged={() => void load()} /> : null}
      {current.id === "assessments" ? <CourseAssessmentsStep courseId={c.id} units={detail.units} /> : null}
      {current.id === "website" ? <WebsiteTab detail={detail} busy={busy} autosave onSave={(data) => void save("website_save", data)} /> : null}

      <div className="mt-5 flex items-center justify-between border-t border-background-200 pt-4">
        {index > 0 ? <WizardBackButton onClick={() => go(index - 1)} /> : <span />}
        {index < steps.length - 1
          ? <button type="button" className={WIZARD_PRIMARY_CLASS} onClick={() => go(index + 1)}>Next: {steps[index + 1].short}<i className="ri-arrow-right-line" aria-hidden="true" /></button>
          : <Link to="/admin/course-fees" className={WIZARD_PRIMARY_CLASS}>Done<i className="ri-check-line" aria-hidden="true" /></Link>}
      </div>
    </div>
  );
}

/** Old addresses (/admin/course-fees/:id?tab=…) open the matching wizard step. */
export function CourseWizardRedirect() {
  const { id = "" } = useParams();
  const tab = new URLSearchParams(window.location.search).get("tab") ?? "course";
  const map: Record<string, CourseStep> = { course: "details", units: "timetable", fees: "fees", intakes: "intakes", batches: "intakes", website: "website" };
  return <Navigate to={stepPath(id, map[tab] ?? "details")} replace />;
}
