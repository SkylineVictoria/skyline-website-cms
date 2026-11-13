// One intake in a sheet from the right (its address ends in #<intake id>): Overview · Timeline · Batches · Students. Changes save
// as they are made, with Undo on the toast.
import { useCallback, useEffect, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, ConfirmDialog, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Avatars, Drawer, ErrorNote, FeesEditor } from "@/pages/admin/components/rto/shared";
import SchedulePanel from "@/pages/admin/components/rto/SchedulePanel";
import BatchTimingDrawer, { type BatchSaved } from "@/pages/admin/components/rto/BatchTimingDrawer";
import StudentPicker, { type StudentsAdded } from "@/pages/admin/components/rto/StudentPicker";
import { Empty, MoreMenu, Sheet, SkeletonLines, StatusPicker } from "@/pages/admin/components/rto/overlay";
import {
  addDays, clashText, feeTotal, money, monthYear, registeredWeeks, rto, rtoFlow, shortDate, timingShort, weeksOf,
  type BatchStudent, type FeeItem, type IntakeDetail, type IntakeStatus, type RtoBatch, type RtoIntake, type ScheduleRow,
} from "@/pages/admin/lib/rto";

export type SheetTab = "overview" | "timeline" | "batches" | "students";
const TABS: { id: SheetTab; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "timeline", label: "Timeline" }, { id: "batches", label: "Batches" }, { id: "students", label: "Students" }];
const active = (s: BatchStudent) => s.status === "active" || s.status === "deferred";

export default function IntakeSheet({ intakeId, canEdit, canEnrol, startTab = "overview", startAddBatch = false, onClose, onChanged, onDuplicate, onDelete }: {
  intakeId: string; canEdit: boolean; canEnrol: boolean; startTab?: SheetTab; startAddBatch?: boolean;
  onClose: () => void; onChanged: () => void; onDuplicate: (i: RtoIntake) => void; onDelete: (i: RtoIntake) => void;
}) {
  const { push } = useToast();
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<SheetTab>(startAddBatch ? "batches" : startTab);
  const [adding, setAdding] = useState(startAddBatch);
  const [picker, setPicker] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setDetail(await rto<IntakeDetail>("intake_get", { intakeId })); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The intake did not load."); }
  }, [intakeId]);
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

  return (
    <Sheet open label={i ? `${i.courseCode} ${monthYear(i.startDate)} intake` : "Intake"} onClose={onClose}>
      {/* header */}
      <div className="shrink-0 border-b border-background-200 bg-background-50 px-4 pt-3 sm:px-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {i ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-heading text-2xl font-bold text-foreground-950">{monthYear(i.startDate)}</h2>
                  <StatusPicker status={i.status} canEdit={canEdit} onChange={setStatus} />
                </div>
                <p className="truncate text-sm text-foreground-700" title={i.courseName}>{i.courseName}</p>
                <p className="text-xs text-foreground-500">{shortDate(i.startDate)} – {shortDate(i.endDate)}{i.campus ? ` · ${i.campus}` : ""}</p>
              </>
            ) : <div className="h-14 w-64 animate-pulse rounded bg-background-200 motion-reduce:animate-none" />}
          </div>
          {i && canEdit ? <MoreMenu label="More actions" items={[
            { label: "Duplicate…", icon: "ri-file-copy-line", onClick: () => onDuplicate(i) },
            { label: "Delete intake…", icon: "ri-delete-bin-line", danger: true, onClick: () => onDelete(i) },
          ]} /> : null}
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-foreground-500 hover:bg-background-200"><i className="ri-close-line text-xl" aria-hidden="true" /></button>
        </div>
        <div className="-mb-px mt-3 flex gap-1 overflow-x-auto" role="tablist" aria-label="Intake">
          {TABS.map((t) => {
            const count = t.id === "batches" ? detail?.batches.length : t.id === "students" ? detail?.batches.reduce((s, b) => s + b.students.filter(active).length, 0) : undefined;
            return (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${tab === t.id ? "border-primary-500 text-primary-700" : "border-transparent text-foreground-600 hover:text-foreground-900"}`}>
                {t.label}{count ? <span className="ml-1.5 rounded-full bg-background-200 px-1.5 text-2xs text-foreground-700">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

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
            {tab === "batches" ? <Batches detail={detail} canEdit={canEdit} onAdd={() => setAdding(true)} /> : null}
            {tab === "students" ? (
              <Students detail={detail} canEnrol={canEnrol} setDetail={setDetail} onChanged={onChanged} reload={load} undoable={undoable}
                onAdd={(batchId) => setPicker(batchId)} onAddBatch={() => { setTab("batches"); setAdding(true); }} canEdit={canEdit} />
            ) : null}
          </div>
        )}
      </div>

      {adding && detail ? (
        <BatchTimingDrawer intake={detail.intake} batches={detail.batches} onClose={() => setAdding(false)}
          onSaved={(out: BatchSaved) => {
            setAdding(false); setDetail(out); onChanged();
            const made = out.batches.find((b) => b.id === out.batchId);
            push(out.clashes.length ? `${made?.name ?? "Batch"} added. ${clashText(out.clashes[0])}.` : `${made?.name ?? "Batch"} added.`, out.clashes.length ? "info" : "success");
          }} />
      ) : null}
      {picker !== null && detail ? (
        <StudentPicker courseId={detail.intake.courseId} batchId={picker || undefined} rtoManager={canEdit}
          batches={detail.batches.filter((b) => b.isActive).map((b) => ({ id: b.id, name: b.name, capacity: b.capacity, enrolled: b.students.filter(active).length, studentIds: b.students.filter(active).map((s) => s.id) }))}
          onClose={() => setPicker(null)}
          onAdded={({ out, batchId, studentIds, names }: StudentsAdded) => {
            setPicker(null); setDetail(out); onChanged();
            const b = out.batches.find((x) => x.id === batchId);
            const enrolments = (b?.students ?? []).filter((s) => studentIds.includes(s.id)).map((s) => s.enrolmentId);
            undoable(`${names.length === 1 ? names[0] : `${names.length} students`} added to ${b?.name ?? "the batch"}.`, () => {
              void Promise.all(enrolments.map((id) => rtoFlow("enrolment_set", { enrolmentId: id, status: "withdrawn" }))).finally(() => { void load(); onChanged(); });
            });
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
  const places = i.capacity ?? (detail.batches.length && detail.batches.every((b) => b.capacity) ? detail.batches.reduce((s, b) => s + (b.capacity ?? 0), 0) : null);
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
      {registered && weeks && registered !== weeks ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span><i className="ri-error-warning-line mr-1" aria-hidden="true" />This intake runs {weeks} weeks; the course is registered for {registered} weeks. CoE dates should match.</span>
          {canEdit && detail.schedule.length ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setFit(true)}>Fit to {registered} weeks</Button> : null}
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Dates" value={`${shortDate(first)} – ${shortDate(last)}`} />
        <Fact label="Length" value={weeks ? `${weeks} weeks` : "—"} note={registered ? `Course: ${registered} weeks` : undefined} />
        <Fact label="Teaching hours" value={hours ? `${hours} hours` : "—"} note={`${detail.schedule.length} units`} action={<button type="button" className="text-xs font-medium text-primary-600 hover:underline" onClick={() => openTab("timeline")}>See timeline</button>} />
        <Fact label="Batches" value={detail.batches.length ? detail.batches.map((b) => b.name).join(", ") : "None yet"} action={<button type="button" className="text-xs font-medium text-primary-600 hover:underline" onClick={() => openTab("batches")}>{detail.batches.length ? "See batches" : "Add a batch"}</button>} />
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

// ------------------------------------------------------------------ Batches
function Batches({ detail, canEdit, onAdd }: { detail: IntakeDetail; canEdit: boolean; onAdd: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-600">A batch is one class group with its own days, room and trainer. Open a batch for its students and unit dates.</p>
        {canEdit && detail.batches.length ? <Button icon="ri-add-line" onClick={onAdd}>Add batch</Button> : null}
      </div>
      {detail.batches.length === 0 ? (
        <Empty icon="ri-group-line" title="No batches yet" text="Add the first batch: pick a trainer, the class days and a room."
          action={canEdit ? <Button icon="ri-add-line" onClick={onAdd}>Add batch</Button> : undefined} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {detail.batches.map((b) => <BatchCard key={b.id} batch={b} onOpen={() => navigate(`/admin/batches/${b.id}`)} />)}
        </div>
      )}
    </div>
  );
}

export function BatchCard({ batch: b, onOpen }: { batch: RtoBatch; onOpen: () => void }) {
  const enrolled = b.students.filter(active).length;
  return (
    <button type="button" onClick={onOpen}
      className={`group w-full rounded-card border border-background-200 bg-background-50 p-4 text-left transition-shadow duration-150 ease-out hover:border-primary-300 hover:shadow-md ${b.isActive ? "" : "opacity-70"}`}>
      <div className="flex items-center gap-3">
        <span className="font-heading text-xl font-bold text-foreground-950">{b.name}</span>
        <Avatars names={b.trainers.map((t) => t.name)} max={3} />
        {b.trainers.length === 1 ? <span className="truncate text-sm text-foreground-700">{b.trainers[0].name}</span> : null}
        <span className="ml-auto text-sm tabular-nums text-foreground-700"><i className="ri-group-line mr-1 text-foreground-400" aria-hidden="true" />{enrolled}{b.capacity ? `/${b.capacity}` : ""}</span>
      </div>
      <p className="mt-2 text-sm text-foreground-600">{timingShort(b) || "No class times yet"}</p>
      <div className="mt-2 flex items-center justify-between">
        {b.isActive ? <span /> : <Badge>Inactive</Badge>}
        <span className="text-xs font-medium text-primary-600 opacity-0 transition-opacity duration-150 group-hover:opacity-100">Open batch <i className="ri-arrow-right-line" aria-hidden="true" /></span>
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ Students: one column per batch; drag a student to move them
function Students({ detail, canEnrol, canEdit, setDetail, onChanged, reload, undoable, onAdd, onAddBatch }: {
  detail: IntakeDetail; canEnrol: boolean; canEdit: boolean; setDetail: (f: (d: IntakeDetail | null) => IntakeDetail | null) => void; onChanged: () => void; reload: () => Promise<void>;
  undoable: (message: string, undo: () => void) => void; onAdd: (batchId: string) => void; onAddBatch: () => void;
}) {
  const { push } = useToast();
  const [over, setOver] = useState<string | null>(null);
  const batches = detail.batches.filter((b) => b.isActive);

  /** Moves a student between batches at once on screen, then on the server; Undo moves them back. */
  const move = (enrolmentId: string, toBatchId: string, quiet = false) => {
    const from = detail.batches.find((b) => b.students.some((s) => s.enrolmentId === enrolmentId));
    const student = from?.students.find((s) => s.enrolmentId === enrolmentId);
    const to = detail.batches.find((b) => b.id === toBatchId);
    if (!from || !student || !to || from.id === to.id) return;
    setDetail((d) => d && { ...d, batches: d.batches.map((b) => b.id === from.id ? { ...b, students: b.students.filter((s) => s.enrolmentId !== enrolmentId) }
      : b.id === to.id ? { ...b, students: [...b.students, student].sort((x, y) => x.name.localeCompare(y.name)) } : b) });
    rtoFlow("student_move", { enrolmentId, toBatchId }).then(() => {
      onChanged();
      if (!quiet) undoable(`${student.name} moved to ${to.name}.`, () => move(enrolmentId, from.id, true));
    }).catch((e) => { push(e instanceof Error ? e.message : "Not moved.", "error"); void reload(); });
  };
  const remove = (enrolmentId: string) => {
    const from = detail.batches.find((b) => b.students.some((s) => s.enrolmentId === enrolmentId));
    const student = from?.students.find((s) => s.enrolmentId === enrolmentId);
    if (!from || !student) return;
    setDetail((d) => d && { ...d, batches: d.batches.map((b) => (b.id === from.id ? { ...b, students: b.students.map((s) => (s.enrolmentId === enrolmentId ? { ...s, status: "withdrawn" } : s)) } : b)) });
    rtoFlow("enrolment_set", { enrolmentId, status: "withdrawn" }).then(() => {
      onChanged();
      undoable(`${student.name} removed from ${from.name}.`, () => {
        rtoFlow("enrolment_set", { enrolmentId, status: "active" }).then(() => { void reload(); onChanged(); })
          .catch((e) => push(e instanceof Error ? e.message : "Not brought back.", "error"));
      });
    }).catch((e) => { push(e instanceof Error ? e.message : "Not removed.", "error"); void reload(); });
  };

  if (!batches.length) {
    return <Empty icon="ri-group-line" title="Add a batch first" text="Students join a batch. Add one, then add students to it." action={canEdit ? <Button icon="ri-add-line" onClick={onAddBatch}>Add batch</Button> : undefined} />;
  }
  const total = batches.reduce((s, b) => s + b.students.filter(active).length, 0);
  const drop = (e: DragEvent, batchId: string) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/enrolment"); if (id) move(id, batchId); };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-600">{canEnrol && batches.length > 1 ? "Drag a student onto another batch to move them." : "The students of each batch."}</p>
        {canEnrol ? <Button icon="ri-user-add-line" onClick={() => onAdd(batches[0].id)}>Students</Button> : null}
      </div>
      {total === 0 ? (
        <Empty icon="ri-user-add-line" title="No students yet" text="Add the students who applied for this course."
          action={canEnrol ? <Button icon="ri-user-add-line" onClick={() => onAdd(batches[0].id)}>Add students</Button> : undefined} />
      ) : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {batches.map((b) => {
          const list = b.students.filter(active);
          return (
            <div key={b.id} onDragOver={(e) => { if (canEnrol) { e.preventDefault(); setOver(b.id); } }} onDragLeave={() => setOver((o) => (o === b.id ? null : o))} onDrop={(e) => drop(e, b.id)}
              className={`rounded-card border bg-background-50 transition-colors duration-150 ${over === b.id ? "border-primary-400 bg-primary-50/40" : "border-background-200"}`}>
              <div className="flex items-center justify-between border-b border-background-200 px-3 py-2">
                <p className="font-heading font-semibold text-foreground-950">{b.name} <span className="text-sm font-normal tabular-nums text-foreground-500">{list.length}{b.capacity ? `/${b.capacity}` : ""}</span></p>
                {canEnrol ? <button type="button" className="text-xs font-medium text-primary-600 hover:underline" onClick={() => onAdd(b.id)}>+ Add</button> : null}
              </div>
              <ul className="min-h-[3rem] divide-y divide-background-100">
                {list.length === 0 ? <li className="px-3 py-3 text-xs text-foreground-500">{canEnrol ? "Drop a student here or add one." : "No students."}</li> : list.map((s) => (
                  <li key={s.enrolmentId} draggable={canEnrol} onDragStart={(e) => { e.dataTransfer.setData("text/enrolment", s.enrolmentId); e.dataTransfer.effectAllowed = "move"; }}
                    className={`flex items-center gap-2 px-3 py-2 ${canEnrol ? "cursor-grab active:cursor-grabbing" : ""}`}>
                    {canEnrol ? <i className="ri-draggable text-foreground-300" aria-hidden="true" /> : null}
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm text-foreground-900">{s.name}</span><span className="block truncate text-xs text-foreground-500">{s.email}</span></span>
                    <Badge tone="accent">{s.type}</Badge>
                    {canEnrol ? <MoreMenu label={`Actions for ${s.name}`} items={[
                      ...batches.filter((o) => o.id !== b.id).map((o) => ({ label: `Move to ${o.name}`, icon: "ri-arrow-left-right-line", onClick: () => move(s.enrolmentId, o.id) })),
                      { label: "Remove from batch", icon: "ri-user-unfollow-line", danger: true, onClick: () => remove(s.enrolmentId) },
                    ]} /> : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
