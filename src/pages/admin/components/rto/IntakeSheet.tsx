import AxcelerateBadge from "@/components/axcelerate/AxcelerateBadge";
// One intake in a sheet from the right (its address ends in #<intake id>): Overview · Timeline · Class setup · Students · Assessments.
// The intake is the class group (room, seats, trainers, weekly class times). Changes save as they are made, with Undo on the toast.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { Link } from "react-router-dom";
import { Badge, Button, ConfirmDialog, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Avatars, Drawer, ErrorNote, FeesEditor } from "@/pages/admin/components/rto/shared";
import SchedulePanel from "@/pages/admin/components/rto/SchedulePanel";
import { ClassWeekDialog } from "@/pages/admin/components/rto/ClassWeekSetup";
import HoursNote from "@/pages/admin/components/rto/HoursNote";
import { OverrideStudentDrawer, PlaceByHandDrawer } from "@/pages/admin/components/rto/OverridePlacement";
import IntakeAssessmentsPanel from "@/pages/admin/assessments/panels/BatchAssessmentsPanel";
import BatchCourseCalendar from "@/pages/admin/lms/BatchCourseCalendar";
import ClassesToReschedule from "@/pages/admin/components/rto/ClassesToReschedule";
import { Empty, MoreMenu, Section, Sheet, SkeletonLines, StatusPicker } from "@/pages/admin/components/rto/overlay";
import IntakeGroupPanel from "@/pages/admin/components/rto/IntakeGroupPanel";
import IntakeBatchesPanel from "@/pages/admin/components/rto/IntakeBatchesPanel";
import {
  addDays, clashText, feeTotal, money, monthYear, registeredWeeks, rto, rtoHoursCheck, shortDate, timingLines, timingShort, todayIso, weeksOf,
  type BatchStudent, type FeeItem, type HoursCheck, type IntakeDetail, type IntakeStatus, type RtoBatch, type RtoIntake, type ScheduleRow,
} from "@/pages/admin/lib/rto";

const seatText = (used: number, seats?: number | null) => (seats ? `${used} of ${seats} seats${used >= seats ? " · full" : ""}` : `${used} student${used === 1 ? "" : "s"}`);
/** The intake's own class group (same id as the intake; at most one). */
const classGroup = (d: IntakeDetail): RtoBatch | null => d.batches.find((b) => b.id === d.intake.id) ?? d.batches.find((b) => b.isActive) ?? d.batches[0] ?? null;
const hasSetup = (g: RtoBatch) => (g.sessions ?? []).length > 0 || g.classDays.length > 0;

export type SheetTab = "overview" | "timeline" | "classes" | "batches" | "students" | "group" | "assessments";
const TABS: { id: SheetTab; label: string }[] = [
  // One timetable per intake (owner, 2026-11-28: "remove calendars which are not needed"): the Timetable tab has the weekly class times
  // and the daily calendar; the course's CoE / VoE weekly calendars are on the course (Course calendars). A rolling intake (no end date)
  // has no Timeline: its batches carry the unit dates (Batches tab).
  { id: "overview", label: "Overview" }, { id: "timeline", label: "Timeline" }, { id: "classes", label: "Timetable" }, { id: "batches", label: "Batches" }, { id: "students", label: "Students" }, { id: "group", label: "Group" }, { id: "assessments", label: "Assessments" },
];
const active = (s: BatchStudent) => s.status === "active" || s.status === "deferred";

export default function IntakeSheet({ intakeId, canEdit, canEnrol, startTab = "overview", startAddBatch = false, wizard = false, onClose, onChanged, onDelete }: {
  intakeId: string; canEdit: boolean; canEnrol: boolean; startTab?: SheetTab;
  /** Opens the class setup drawer at once. */
  startAddBatch?: boolean;
  /** New course wizard, step 5 (class setup of the intake), straight after its first intake is created. Students are never added here. */
  wizard?: boolean;
  onClose: () => void; onChanged: () => void; onDelete: (i: RtoIntake) => void;
}) {
  const { push } = useToast();
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<SheetTab>(startAddBatch ? "classes" : startTab);
  const [setup, setSetup] = useState(startAddBatch || wizard);
  const [wizStep, setWizStep] = useState<"classes" | null>(wizard ? "classes" : null);
  const [hours, setHours] = useState<HoursCheck | undefined>(undefined);
  const [calendarKey, setCalendarKey] = useState(0);
  const group = detail ? classGroup(detail) : null;
  const groupKey = group ? `${group.id}:${JSON.stringify(group.sessions ?? [])}:${group.startTime}:${group.endTime}:${group.classDays.join("")}` : "";
  useEffect(() => {
    let live = true;
    const id = groupKey.split(":")[0];
    if (!id) { setHours(undefined); return; }
    void rtoHoursCheck([id]).then((r) => { if (live) setHours(r[id]); });
    return () => { live = false; };
  }, [groupKey]);

  const load = useCallback(async () => {
    try {
      const d = await rto<IntakeDetail>("intake_get", { intakeId });
      // An intake from the course wizard is not shown until the whole wizard is finished.
      const { data: pend } = await supabase.rpc("rto_intake_wizard", { p_action: "pending", p_data: { courseId: d.intake.courseId } });
      if (((pend ?? []) as { id: string }[]).some(x => x.id === intakeId)) { onClose(); return; }
      setDetail(d); setError("");
    }
    catch (e) { setError(e instanceof Error ? e.message : "The intake did not load."); }
  }, [intakeId, onClose]);
  useEffect(() => { setDetail(null); void load(); }, [load]);

  /** Runs a change; the result (an intake) replaces what is shown. Returns it, or null when it failed (the error is shown). */
  const run = useCallback(async (call: () => Promise<IntakeDetail>) => {
    setBusy(true);
    try { const out = await call(); setDetail(out); onChanged(); return out; }
    catch (e) { push(e instanceof Error ? e.message : "Not saved.", "error"); void load(); return null; }
    finally { setBusy(false); }
  }, [push, onChanged, load]);
  const undoable = (message: string, undo: () => void) => push(message, "success", { label: "Undo", onClick: undo });

  const i = detail?.intake;
  const setStatus = (status: IntakeStatus) => {
    if (!i || status === i.status) return;
    const before = i.status;
    setDetail((d) => (d ? { ...d, intake: { ...d.intake, status } } : d)); // shown at once
    void run(() => rto<IntakeDetail>("intake_save", { id: i.id, status })).then((ok) => {
      if (ok) undoable(`${monthYear(i.startDate)} intake is now ${status[0].toUpperCase()}${status.slice(1)}.`, () => setStatus(before));
    });
  };
  const setupLabel = group && hasSetup(group) ? "Change weekly timetable" : "Select weekly timetable";

  return (
    <Sheet open label={i ? `${i.courseCode} ${monthYear(i.startDate)} intake` : "Intake"} onClose={onClose}>
      {/* header */}
      <div className="shrink-0 border-b border-background-200 bg-background-50 px-4 pt-3 sm:px-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {i ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-heading text-2xl font-bold text-foreground-950">{i.customName || i.name || monthYear(i.startDate)}</h2>
                  <AxcelerateBadge table="public.course_intakes" id={intakeId} />
                  <StatusPicker status={i.status} canEdit={canEdit} onChange={setStatus} />
                </div>
                {!(i.customName || i.name || "").includes(i.courseName) ? <p className="truncate text-sm text-foreground-700" title={i.courseName}>{i.courseName}</p> : null}
                <p className="text-xs text-foreground-500">{i.endDate ? `${shortDate(i.startDate)} – ${shortDate(i.endDate)}` : `Rolling intake · ongoing since ${shortDate(i.startDate)}`}{i.campus ? ` · ${i.campus}` : ""}</p>
              </>
            ) : <div className="h-14 w-64 animate-pulse rounded bg-background-200 motion-reduce:animate-none" />}
          </div>
          {i && canEdit ? <MoreMenu label="More actions" items={[
            { label: "Delete intake…", icon: "ri-delete-bin-line", danger: true, onClick: () => onDelete(i) },
          ]} /> : null}
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-foreground-500 hover:bg-background-200"><i className="ri-close-line text-xl" aria-hidden="true" /></button>
        </div>
        <div className="-mb-px mt-3 flex gap-1 overflow-x-auto" role="tablist" aria-label="Intake">
          {/* A rolling intake (no end date): its batches carry the dates, class times and timetable (Batches & timetable). */}
          {TABS.filter((t) => !((t.id === "timeline" || t.id === "classes") && detail && !detail.intake.endDate)).map((t) => {
            const count = t.id === "students" ? group?.students.filter(active).length : undefined;
            return (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${tab === t.id ? "border-primary-500 text-primary-700" : "border-transparent text-foreground-600 hover:text-foreground-900"}`}>
                {t.id === "batches" && detail && !detail.intake.endDate ? "Batches & timetable" : t.label}{count ? <span className="ml-1.5 rounded-full bg-background-200 px-1.5 text-2xs text-foreground-700">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {wizStep && canEdit ? <div className="shrink-0 border-b border-primary-200 bg-primary-50 px-4 py-2.5 sm:px-6" role="status">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1"><b>Steps 5–7 · Rooms, trainers and weekly class times.</b> The week fills itself from the rooms, trainers and CoE or VoE hours. Students join through the enrolment wizard.</span>
          <Button size="sm" icon="ri-time-line" onClick={() => { setTab("classes"); setSetup(true); }}>{setupLabel}</Button>
        </div>
      </div> : null}

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <ErrorNote text={error} />
        {!detail ? <SkeletonLines lines={5} /> : (
          <div key={tab} className="fade-in">
            {tab === "overview" ? <Overview detail={detail} canEdit={canEdit} busy={busy} run={run} undoable={undoable} openTab={setTab} /> : null}
            {tab === "timeline" ? (
              <SchedulePanel detail={detail} courseDuration={detail.intake.courseDuration} readOnly={!canEdit} busy={busy} autosave
                onSave={(rows: ScheduleRow[], previous?: ScheduleRow[]) => void run(() => rto<IntakeDetail>("schedule_save", { intakeId, rows })).then((ok) => {
                  if (ok && previous) undoable("Timeline saved.", () => void run(() => rto<IntakeDetail>("schedule_save", { intakeId, rows: previous })));
                })}
                onRegenerate={(fitEnd) => void run(() => rto<IntakeDetail>("intake_save", { id: intakeId, generate: true, ...(detail.schedule.length ? { unitIds: detail.schedule.map((r) => r.unitId) } : {}), ...(fitEnd ? { fitEnd } : {}) }))
                  .then((ok) => { if (ok) push(fitEnd ? "Timeline fitted to the course length." : "Timeline laid out again from the course."); })} />
            ) : null}
            {tab === "classes" ? <ClassSetup detail={detail} group={group} canEdit={canEdit} hours={hours} setupLabel={setupLabel} calendarKey={calendarKey}
              onSetup={() => setSetup(true)} onReload={() => { void load(); onChanged(); }} /> : null}
            {tab === "students" ? (
              <Students detail={detail} group={group} canEdit={canEdit} canOverride={canEnrol} onChanged={() => { void load(); onChanged(); }} notify={(m) => push(m)}
                onSetup={() => { setTab("classes"); setSetup(true); }} />
            ) : null}
            {tab === "batches" ? <IntakeBatchesPanel intakeId={detail.intake.id} canEdit={canEdit} canAssign={canEdit || canEnrol} units={detail.schedule.map((r) => ({ unitId: r.unitId, code: r.code }))} /> : null}
            {tab === "group" ? <IntakeGroupPanel intakeId={intakeId} /> : null}
            {tab === "assessments" ? (group ? <IntakeAssessmentsPanel batchId={group.id} />
              : <Empty icon="ri-file-list-3-line" title="Weekly timetable not selected yet" text="Assessments are assigned to an intake once its classes are set up." />) : null}
          </div>
        )}
      </div>

      {setup && detail ? (
        <ClassWeekDialog title={`Select weekly timetable · ${detail.intake.customName || detail.intake.name}`} intakeId={detail.intake.id} courseId={detail.intake.courseId} canEdit={canEdit}
          onClose={() => setSetup(false)}
          onSaved={({ detail: out }) => {
            setSetup(false); setDetail(out); onChanged(); setCalendarKey((k) => k + 1);
            if (wizStep === "classes") { setWizStep(null); push("Course set up: units, hours, dates, intake and classes are ready. Students join through the enrolment wizard."); }
            else push("Weekly timetable saved.");
          }} />
      ) : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ Overview
function Overview({ detail, canEdit, busy, run, undoable, openTab }: {
  detail: IntakeDetail; canEdit: boolean; busy: boolean; run: (call: () => Promise<IntakeDetail>) => Promise<IntakeDetail | null>;
  undoable: (message: string, undo: () => void) => void; openTab: (t: SheetTab) => void;
}) {
  const i = detail.intake;
  const first = detail.schedule.length ? detail.schedule.reduce((m, r) => (r.startDate < m ? r.startDate : m), detail.schedule[0].startDate) : i.startDate;
  const last = detail.schedule.length ? detail.schedule.reduce((m, r) => (r.endDate > m ? r.endDate : m), detail.schedule[0].endDate) : i.endDate;
  const weeks = last ? weeksOf(first, last) : null;
  const registered = registeredWeeks(i.courseDuration);
  const hours = detail.schedule.reduce((s, r) => s + (r.hours ?? 0), 0);
  const group = classGroup(detail);
  const places = i.capacity ?? group?.capacity ?? null;
  const [fit, setFit] = useState(false);
  const [fees, setFees] = useState(false);
  const [capacity, setCapacity] = useState(i.capacity ? String(i.capacity) : "");
  useEffect(() => { setCapacity(i.capacity ? String(i.capacity) : ""); }, [i.capacity]);
  const saveCapacity = () => {
    const before = i.capacity ? String(i.capacity) : "";
    if (capacity === before) return;
    void run(() => rto<IntakeDetail>("intake_save", { id: i.id, capacity })).then((ok) => {
      if (ok) undoable(capacity ? `Places set to ${capacity}.` : "Places cleared.", () => void run(() => rto<IntakeDetail>("intake_save", { id: i.id, capacity: before })));
    });
  };
  const backToCourseFees = () => {
    const before: FeeItem[] = detail.fees;
    void run(() => rto<IntakeDetail>("intake_fees_save", { intakeId: i.id, items: [] })).then((ok) => {
      if (ok) undoable("This intake uses the course fees again.", () => void run(() => rto<IntakeDetail>("intake_fees_save", { intakeId: i.id, items: before })));
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* A rolling intake has no end: its batches carry their own dates (Batches tab). */}
        {i.endDate ? <Fact label="Dates" value={`${shortDate(first)} – ${shortDate(last)}`} /> : <Fact label="Dates" value={`Ongoing since ${shortDate(i.startDate)}`} note="Rolling intake: each batch has its own dates" />}
        {i.endDate ? <Fact label="Length" value={weeks ? `${weeks} weeks` : "—"} note={registered ? `Course: ${registered} weeks` : undefined} />
          : <Fact label="Course length" value={weeks ? `${weeks} weeks` : registered ? `${registered} weeks` : "—"} note="One full cycle of the course calendar" />}
        <Fact label="Teaching hours" value={hours ? `${hours} hours` : "—"} note={`${detail.schedule.length} units`} action={<button type="button" className="text-xs font-medium text-primary-600 hover:underline" onClick={() => openTab(i.endDate ? "timeline" : "batches")}>{i.endDate ? "See timeline" : "See batches"}</button>} />
        <Fact label="Timetable" value={group && hasSetup(group) ? timingShort(group) || "Set" : "Weekly timetable not selected yet"} action={<button type="button" className="text-xs font-medium text-primary-600 hover:underline" onClick={() => openTab(i.endDate ? "classes" : "batches")}>{!i.endDate ? "See batches and timetable" : group && hasSetup(group) ? "See class setup" : "Set up classes"}</button>} />
        <div className="rounded-card border border-background-200 bg-background-50 p-3">
          <p className="text-xs font-medium text-foreground-500">Students</p>
          <p className="mt-0.5 font-heading text-lg font-semibold tabular-nums text-foreground-950">{i.enrolled}{places ? <span className="text-sm font-normal text-foreground-500"> of {places} places</span> : null}</p>
          {places ? <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-background-200"><div className="h-full rounded-full bg-primary-500 transition-all duration-200" style={{ width: `${Math.min(100, (i.enrolled / places) * 100)}%` }} /></div> : null}
          {canEdit ? (
            <label className="mt-2 flex items-center gap-2 text-xs text-foreground-600">Places
              <TextInput className="h-8 w-20 text-sm" inputMode="numeric" value={capacity} placeholder="—" aria-label="Places in this intake"
                onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ""))} onBlur={saveCapacity} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            </label>
          ) : null}
        </div>
        <div className="rounded-card border border-background-200 bg-background-50 p-3">
          <p className="text-xs font-medium text-foreground-500">Fees</p>
          <p className="mt-0.5 font-heading text-lg font-semibold tabular-nums text-foreground-950">{money(feeTotal(detail.fees))}</p>
          <p className="text-xs text-foreground-500">{i.hasFeeOverride ? `Changed for this intake (course ${money(feeTotal(detail.courseFees))})` : "The course fees"}</p>
          {canEdit ? (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium">
              <button type="button" className="text-primary-600 hover:underline" onClick={() => setFees(true)}>{i.hasFeeOverride ? "Change" : "Change for this intake"}</button>
              {i.hasFeeOverride ? <button type="button" className="text-primary-600 hover:underline" disabled={busy} onClick={backToCourseFees}>Use the course fees</button> : null}
            </div>
          ) : null}
        </div>
      </div>
      <ConfirmDialog open={fit} title={`Fit the timeline to ${registered} weeks?`} confirmLabel="Fit timeline"
        message={`Every unit date is laid out again so the intake ends on ${shortDate(addDays(first, (registered ?? 0) * 7 - 1))}. Dates changed by hand are replaced.`}
        onCancel={() => setFit(false)}
        onConfirm={() => { setFit(false); void run(() => rto<IntakeDetail>("intake_save", { id: i.id, generate: true, unitIds: detail.schedule.map((r) => r.unitId), fitEnd: addDays(first, (registered ?? 0) * 7 - 1) })); }} />
      {fees ? (
        <Drawer open width="max-w-3xl" title={`Fees for the ${monthYear(i.startDate)} intake`} onClose={() => setFees(false)}>
          <p className="text-sm text-foreground-600">These fees apply to students of this intake only. Everyone else keeps the course fees.</p>
          <FeesEditor items={detail.fees} busy={busy} saveLabel="Save fees for this intake"
            onSave={(items) => { const before = i.hasFeeOverride ? detail.fees : []; void run(() => rto<IntakeDetail>("intake_fees_save", { intakeId: i.id, items })).then((ok) => {
              if (ok) { setFees(false); undoable("Fees saved for this intake.", () => void run(() => rto<IntakeDetail>("intake_fees_save", { intakeId: i.id, items: before }))); }
            }); }} />
        </Drawer>
      ) : null}
    </div>
  );
}

function Fact({ label, value, note, action }: { label: string; value: string; note?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-card border border-background-200 bg-background-50 p-3">
      <p className="text-xs font-medium text-foreground-500">{label}</p>
      <p className="mt-0.5 break-words font-heading text-lg font-semibold text-foreground-950">{value}</p>
      {note ? <p className="text-xs text-foreground-500">{note}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ Class setup: room, seats, trainers, weekly class times, hours, class dates
function ClassSetup({ detail, group: g, canEdit, hours, setupLabel, calendarKey, onSetup, onReload }: {
  detail: IntakeDetail; group: RtoBatch | null; canEdit: boolean; hours?: HoursCheck; setupLabel: string; calendarKey: number; onSetup: () => void; onReload: () => void;
}) {
  if (!g || !hasSetup(g)) {
    return (
      <Empty icon="ri-time-line" title="Weekly timetable not selected yet" text="Set the room, seats, trainer and weekly class times of this intake. Students are placed automatically once the classes are set up."
        action={canEdit ? <Button icon="ri-time-line" onClick={onSetup}>{setupLabel}</Button> : undefined} />
    );
  }
  const lines = timingLines(g.sessions ?? []);
  const rooms = [...new Set((g.sessions ?? []).map((s) => (s.room ? [s.location, s.room].filter(Boolean).join(", ") : "")).filter(Boolean))];
  const enrolled = g.students.filter(active).length;
  const upcoming = detail.intake.startDate > todayIso();
  return (
    <div className="space-y-4">
      <Section title="Weekly timetable" helper="Where and when this intake meets each week, and who teaches it."
        action={canEdit ? <Button size="sm" variant="outline" icon="ri-edit-line" onClick={onSetup}>{setupLabel}</Button> : undefined}>
        <div className="grid gap-3 sm:grid-cols-3">
          <SetupFact label="Room" value={rooms.length ? rooms.join(" · ") : g.classroom ?? "No room yet"} warn={!rooms.length && !g.classroom} />
          <SetupFact label="Seats" value={seatText(upcoming ? enrolled : g.occupied ?? enrolled, g.seats ?? g.capacity)} />
          <div className="rounded-card border border-background-200 bg-background-50 p-3">
            <p className="text-xs font-medium text-foreground-500">Trainers</p>
            {g.trainers.length ? <div className="mt-1 flex flex-wrap items-center gap-2"><Avatars names={g.trainers.map((t) => t.name)} max={3} /><span className="text-sm text-foreground-900">{g.trainers.map((t) => t.name).join(", ")}</span></div>
              : <p className="mt-0.5 text-sm text-amber-800">No trainer yet</p>}
          </div>
        </div>
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-foreground-500">Weekly class times</p>
          {lines.length === 0 ? <p className="text-sm text-foreground-700">{timingShort(g) || "No class times yet."}</p> : (
            <ul className="space-y-1.5">
              {lines.map((l) => (
                <li key={l.text} className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground-800">
                  <span className="w-24 shrink-0 font-semibold text-foreground-950">{l.text.split(" · ")[0]}</span>
                  <span>{l.days}</span><span className="text-foreground-400">·</span><span className="tabular-nums">{l.time}</span><span className="text-foreground-400">·</span><span className="text-foreground-600">{l.where}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {g.isActive ? null : <Badge>Takes no new students</Badge>}
          {g.autoCreated && !g.classroomId && !rooms.length ? <Badge tone="warn">Needs a room</Badge> : null}
        </div>
        <HoursNote check={hours} />
      </Section>
      <ClassesToReschedule intakeId={detail.intake.id} onChanged={onReload} />
      <Section title="Class dates" helper="Every class of the course, month by month; term breaks greyed out. Made from the weekly class times.">
        <BatchCourseCalendar key={`${g.id}:${calendarKey}`} batchId={g.id} courseId={detail.intake.courseId} intakeStart={detail.intake.startDate} intakeEnd={detail.intake.endDate}
          hasSlots={(g.sessions ?? []).length > 0} canManage={canEdit} reloadKey={calendarKey} onRemoved={async () => { onReload(); }} />
      </Section>
    </div>
  );
}

function SetupFact({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-card border border-background-200 bg-background-50 p-3">
      <p className="text-xs font-medium text-foreground-500">{label}</p>
      <p className={`mt-0.5 break-words text-sm font-semibold ${warn ? "text-amber-800" : "text-foreground-950"}`}>{value}</p>
    </div>
  );
}

// ------------------------------------------------------------------ Students of the intake (placement override: place, move to another intake, remove)
interface OtherIntake { id: string; name: string; full: boolean }
function Students({ detail, group: g, canEdit, canOverride, onChanged, notify, onSetup }: {
  detail: IntakeDetail; group: RtoBatch | null; canEdit: boolean; canOverride: boolean; onChanged: () => void; notify: (m: string) => void; onSetup: () => void;
}) {
  const [place, setPlace] = useState(false);
  const [act, setAct] = useState<null | { mode: "move" | "remove"; enrolmentId: string; name: string }>(null);
  const [others, setOthers] = useState<OtherIntake[]>([]);
  const i = detail.intake;
  useEffect(() => {
    if (!canOverride) return;
    let live = true;
    // Other intakes of the course that have their classes set up: where a student can be moved.
    rto<RtoIntake[]>("intake_list").then((list) => {
      if (!live) return;
      setOthers(list.filter((x) => x.courseId === i.courseId && x.id !== i.id && x.status !== "closed" && (x.batchList ?? []).some((b) => b.isActive))
        .map((x) => { const b = (x.batchList ?? []).find((c) => c.isActive)!; return { id: b.id, name: `${x.name} (${shortDate(x.startDate)})`, full: !!b.capacity && b.enrolled >= b.capacity }; }));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [canOverride, i.courseId, i.id]);
  if (!g) {
    return <Empty icon="ri-group-line" title="Weekly timetable not selected yet" text="Students are placed automatically when their offer is accepted, once the classes of this intake are set up (room, trainer, class times)."
      action={canEdit ? <Button icon="ri-time-line" onClick={onSetup}>Select weekly timetable</Button> : undefined} />;
  }
  const list = g.students.filter(active);
  const seats = g.seats ?? g.capacity;
  const full = !!seats && list.length >= seats;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm text-foreground-600">Students are placed automatically when their offer is accepted while the intake has a free seat, and in the next intake if they join after a prerequisite unit has finished. <span className="tabular-nums">{seatText(i.startDate > todayIso() ? list.length : g.occupied ?? list.length, seats)}</span></p>
        {canOverride && g.isActive ? <Button size="sm" variant="outline" icon="ri-hand-coin-line" onClick={() => setPlace(true)}>Override: place a student</Button> : null}
      </div>
      {list.length === 0 ? <Empty icon="ri-user-add-line" title="No students yet" text="They appear here as offers are accepted." /> : (
        <ul className="divide-y divide-background-100 rounded-card border border-background-200 bg-background-50">
          {list.map((s) => (
            <li key={s.enrolmentId} className="flex items-center gap-2 px-3 py-2">
              <Link to={`/admin/students/${s.id}`} className="min-w-0 flex-1"><span className="block truncate text-sm text-foreground-900 hover:text-primary-600">{s.name}</span><span className="block truncate text-xs text-foreground-500">{s.email}</span></Link>
              <Badge tone="accent">{s.type}</Badge>
              {canOverride ? <MoreMenu label={`Override for ${s.name}`} items={[
                ...(others.length ? [{ label: "Move to another intake (override)…", icon: "ri-arrow-left-right-line", onClick: () => setAct({ mode: "move", enrolmentId: s.enrolmentId, name: s.name }) }] : []),
                { label: "Remove from intake (override)…", icon: "ri-user-unfollow-line", danger: true, onClick: () => setAct({ mode: "remove", enrolmentId: s.enrolmentId, name: s.name }) },
              ]} /> : null}
            </li>
          ))}
        </ul>
      )}
      <PlaceByHandDrawer open={place} courseId={i.courseId} batches={[{ id: g.id, name: i.name, full }]} batchId={g.id} intakeStart={i.startDate} intakeEnd={i.endDate}
        onClose={() => setPlace(false)} onDone={(m) => { setPlace(false); notify(m); onChanged(); }} />
      {act ? <OverrideStudentDrawer open mode={act.mode} enrolmentId={act.enrolmentId} studentName={act.name} batches={[{ id: g.id, name: i.name }, ...others]} currentBatchId={g.id}
        onClose={() => setAct(null)} onDone={(m) => { setAct(null); notify(m); onChanged(); }} /> : null}
    </div>
  );
}

