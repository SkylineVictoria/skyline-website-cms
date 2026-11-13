// Course wizard › Intakes: every intake of the course as an expandable row. Expanded: the intake's schedule (generated from the
// master timetable), its batches inline (they inherit the intake's unit dates; a batch keeps its own date only where staff change
// it), "+ Add batch", and enrolling students. "Duplicate" copies an intake to a new start date (no students).
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, Select, TextInput } from "@/pages/admin/components/ui";
import SchedulePanel from "@/pages/admin/components/rto/SchedulePanel";
import { useToast } from "@/pages/admin/components/toastContext";
import { Avatars, Drawer, ErrorNote, IntakeStatusChip } from "@/pages/admin/components/rto/shared";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import { BatchDrawer, EnrolDrawer } from "@/pages/admin/IntakeDetailPage";
import { phase, progress, rto, rtoFlow, shortDate, type CourseDetail, type EnrolmentType, type IntakeDetail, type IntakeStatus, type RtoBatch, type RtoIntake } from "@/pages/admin/lib/rto";

export default function IntakesStep({ detail, canEdit, canEnrol, onChanged }: { detail: CourseDetail; canEdit: boolean; canEnrol: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [duplicating, setDuplicating] = useState<RtoIntake | null>(null);
  const intakes = [...detail.intakes].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const unitWeeks = Object.fromEntries(detail.units.filter((u) => u.id).map((u) => [u.id as string, u.defaultWeeks]));
  return (
    <div className="w-full min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-600">{intakes.length ? `${intakes.length} intake${intakes.length === 1 ? "" : "s"}. Expand one for its schedule, batches and students.` : "No intakes yet."}</p>
        {canEdit ? <Button icon="ri-add-line" onClick={() => setCreating(true)}>New intake</Button> : null}
      </div>
      {intakes.length === 0 ? <Card><EmptyState icon="ri-calendar-event-line" title="No intakes yet" description={canEdit ? "Create one: pick a start date and the schedule is generated from the master timetable." : "An RTO Manager creates intakes."} /></Card> : null}
      {intakes.map((i) => (
        <IntakeItem key={i.id} intake={i} courseId={detail.course.id} courseDuration={detail.course.duration} unitWeeks={unitWeeks} expanded={open === i.id} onToggle={() => setOpen((x) => (x === i.id ? null : i.id))}
          canEdit={canEdit} canEnrol={canEnrol} onDuplicate={() => setDuplicating(i)} onChanged={onChanged} />
      ))}
      <NewIntakeDrawer open={creating} onClose={() => { setCreating(false); onChanged(); }} courses={[]} courseId={detail.course.id} stay />
      {duplicating ? <DuplicateDrawer intake={duplicating} onClose={() => setDuplicating(null)} onDone={(id) => { setDuplicating(null); setOpen(id); onChanged(); }} /> : null}
    </div>
  );
}

function IntakeItem({ intake, courseId, courseDuration, unitWeeks, expanded, onToggle, canEdit, canEnrol, onDuplicate, onChanged }: {
  intake: RtoIntake; courseId: string; courseDuration: string; unitWeeks: Record<string, number>; expanded: boolean; onToggle: () => void; canEdit: boolean; canEnrol: boolean; onDuplicate: () => void; onChanged: () => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [ask, setAsk] = useState<null | "collapse" | "delete">(null);
  const [menu, setMenu] = useState(false);
  const toggle = () => { if (expanded && dirty) setAsk("collapse"); else onToggle(); };
  const { push } = useToast();
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [batchDrawer, setBatchDrawer] = useState<RtoBatch | "new" | null>(null);
  const [enrol, setEnrol] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setDetail(await rto<IntakeDetail>("intake_get", { intakeId: intake.id })); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The intake did not load."); }
  }, [intake.id]);
  useEffect(() => { if (expanded) void load(); }, [expanded, load]);
  const run = async (call: () => Promise<IntakeDetail>, done: string) => {
    setBusy(true);
    try { setDetail(await call()); push(done); onChanged(); return true; }
    catch (e) { push(e instanceof Error ? e.message : "Not saved.", "error"); return false; }
    finally { setBusy(false); }
  };
  const pct = Math.round(progress(intake) * 100);
  const remove = async () => {
    setBusy(true);
    try { await rto("intake_delete", { intakeId: intake.id }); push(`${intake.name} deleted.`); onChanged(); }
    catch (e) { push(e instanceof Error ? e.message : "Not deleted.", "error"); }
    finally { setBusy(false); }
  };
  return (
    <Card className="w-full min-w-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button type="button" onClick={toggle} aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <i className={`${expanded ? "ri-arrow-down-s-line" : "ri-arrow-right-s-line"} text-lg text-foreground-400`} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate font-medium text-foreground-900">{intake.name}</span>
            <span className="block text-xs text-foreground-500">{shortDate(intake.startDate)} – {shortDate(intake.endDate)}{intake.campus ? ` · ${intake.campus}` : ""} · {intake.units} units · {intake.batches} batch{intake.batches === 1 ? "" : "es"}</span>
          </span>
        </button>
        <div className="hidden w-32 md:block"><div className="h-1.5 overflow-hidden rounded-full bg-background-200"><div className="h-full rounded-full bg-primary-500" style={{ width: `${pct}%` }} /></div><p className="mt-0.5 text-[11px] text-foreground-500">{phase(intake)}</p></div>
        <span className="text-sm tabular-nums text-foreground-700"><i className="ri-group-line mr-1 text-foreground-400" aria-hidden="true" />{intake.enrolled}{intake.capacity ? ` / ${intake.capacity}` : ""}</span>
        <Avatars names={intake.trainers} />
        {canEdit ? (
          <Select aria-label="Intake status" className="w-28" value={intake.status} disabled={busy}
            onChange={(e) => void run(() => rto<IntakeDetail>("intake_save", { id: intake.id, status: e.target.value as IntakeStatus }), "Status changed.")}>
            <option value="draft">Draft</option><option value="open">Open</option><option value="full">Full</option><option value="closed">Closed</option>
          </Select>
        ) : <IntakeStatusChip status={intake.status} />}
        <div className="relative">
          <Button variant="ghost" size="sm" icon="ri-more-2-fill" aria-label={`More actions for ${intake.name}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)} />
          {menu ? (
            <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-md border border-background-200 bg-background-50 py-1 text-sm shadow-lg" onMouseLeave={() => setMenu(false)}>
              {canEdit ? <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-background-100" onClick={() => { setMenu(false); onDuplicate(); }}><i className="ri-file-copy-line mr-2" aria-hidden="true" />Duplicate…</button> : null}
              <Link to={`/admin/intakes/${intake.id}`} className="block px-3 py-1.5 hover:bg-background-100"><i className="ri-external-link-line mr-2" aria-hidden="true" />Open on its own page</Link>
              {canEdit ? <button type="button" className="block w-full px-3 py-1.5 text-left text-red-700 hover:bg-red-50" onClick={() => { setMenu(false); setAsk("delete"); }}><i className="ri-delete-bin-line mr-2" aria-hidden="true" />Delete intake…</button> : null}
            </div>
          ) : null}
        </div>
      </div>
      <ConfirmDialog open={ask === "collapse"} title="Discard unsaved schedule changes?" message={`The schedule of ${intake.name} has changes that are not saved.`} confirmLabel="Discard changes"
        onCancel={() => setAsk(null)} onConfirm={() => { setAsk(null); setDirty(false); onToggle(); }} />
      <ConfirmDialog open={ask === "delete"} title={`Delete ${intake.name}?`} message="Its schedule and empty batches go too. An intake with students or applications cannot be deleted; close it instead." confirmLabel="Delete intake"
        onCancel={() => setAsk(null)} onConfirm={() => { setAsk(null); void remove(); }} />
      {expanded ? (
        <div className="min-w-0 space-y-4 border-t border-background-200 bg-background-100/40 p-4">
          <ErrorNote text={error} />
          {!detail ? <p className="text-sm text-foreground-500">Loading…</p> : (
            <>
              <SchedulePanel detail={detail} courseDuration={courseDuration} unitWeeks={unitWeeks} readOnly={!canEdit} busy={busy} onDirtyChange={setDirty}
                onSave={(rows) => void run(() => rto<IntakeDetail>("schedule_save", { intakeId: intake.id, rows }), "Schedule saved.")}
                onRegenerate={(fitEnd) => void run(() => rto<IntakeDetail>("intake_save", { id: intake.id, generate: true, ...(detail.schedule.length ? { unitIds: detail.schedule.map((r) => r.unitId) } : {}), ...(fitEnd ? { fitEnd } : {}) }),
                  fitEnd ? "Schedule fitted to the course duration." : "Schedule generated from the master timetable.")} />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-heading text-sm font-semibold text-foreground-950">Batches</h3>
                  {canEdit ? <Button size="sm" variant="outline" icon="ri-add-line" onClick={() => setBatchDrawer("new")}>Add batch</Button> : null}
                </div>
                {detail.batches.length === 0 ? <p className="text-sm text-foreground-500">No batches yet. A batch follows this intake’s unit dates; change a date only where the batch differs.</p> : null}
                {detail.batches.map((b) => (
                  <BatchItem key={b.id} batch={b} canEdit={canEdit} canEnrol={canEnrol} busy={busy} onEdit={() => setBatchDrawer(b)} onEnrol={() => setEnrol(b.id)}
                    onOverride={(intakeUnitId, startDate, endDate) => void run(() => rtoFlow<IntakeDetail>("batch_override_set", { batchId: b.id, intakeUnitId, startDate, endDate }), "Batch date saved.")}
                    onReset={(intakeUnitId) => void run(() => rtoFlow<IntakeDetail>("batch_override_reset", { batchId: b.id, intakeUnitId }), "The batch follows the intake again.")}
                    onWithdraw={(enrolmentId) => void run(() => rto<IntakeDetail>("unenrol", { enrolmentId }), "Student withdrawn.")} />
                ))}
              </div>
            </>
          )}
          {batchDrawer && detail ? <BatchDrawer batch={batchDrawer === "new" ? null : batchDrawer} existing={detail.batches} busy={busy} onClose={() => setBatchDrawer(null)}
            onSave={async (data) => { if (await run(() => rto<IntakeDetail>("batch_save", { intakeId: intake.id, ...data }), "Batch saved.")) setBatchDrawer(null); }}
            onDelete={async (batchId) => { if (await run(() => rto<IntakeDetail>("batch_delete", { batchId }), "Batch deleted.")) setBatchDrawer(null); }} /> : null}
          {enrol !== null && detail ? <EnrolDrawer courseId={courseId} batches={detail.batches.filter((b) => b.isActive)} batchId={enrol} busy={busy} rtoManager={canEdit} onClose={() => setEnrol(null)}
            onEnrol={async (batchId, students: { id: string; type: EnrolmentType }[]) => { if (await run(() => rto<IntakeDetail>("enrol", { batchId, students }), `${students.length} student${students.length === 1 ? "" : "s"} enrolled.`)) setEnrol(null); }} /> : null}
        </div>
      ) : null}
    </Card>
  );
}

function BatchItem({ batch, canEdit, canEnrol, busy, onEdit, onEnrol, onOverride, onReset, onWithdraw }: {
  batch: RtoBatch; canEdit: boolean; canEnrol: boolean; busy: boolean; onEdit: () => void; onEnrol: () => void;
  onOverride: (intakeUnitId: string, startDate: string, endDate: string) => void; onReset: (intakeUnitId: string) => void; onWithdraw: (enrolmentId: string) => void;
}) {
  const [show, setShow] = useState<"" | "dates" | "students">("");
  const schedule = batch.schedule ?? [];
  const overridden = schedule.filter((r) => r.overridden).length;
  const students = batch.students.filter((s) => s.status === "active" || s.status === "deferred");
  return (
    <div className="rounded-md border border-background-200 bg-background-50">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <p className="font-medium text-foreground-900">{batch.name} {batch.isActive ? null : <Badge>Inactive</Badge>} {overridden ? <Badge tone="warn">{overridden} date{overridden === 1 ? "" : "s"} overridden</Badge> : null}</p>
          <p className="text-xs text-foreground-500">{[batch.classroom, batch.classDays.join(" "), batch.startTime && `${batch.startTime}–${batch.endTime ?? ""}`].filter(Boolean).join(" · ") || "No class times yet"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Avatars names={batch.trainers.map((t) => t.name)} />
          <Button variant="ghost" size="sm" onClick={() => setShow((s) => (s === "students" ? "" : "students"))}><i className="ri-group-line" aria-hidden="true" />{students.length}{batch.capacity ? ` / ${batch.capacity}` : ""}</Button>
          <Button variant="ghost" size="sm" icon="ri-calendar-schedule-line" onClick={() => setShow((s) => (s === "dates" ? "" : "dates"))}>Unit dates</Button>
          {canEnrol && batch.isActive ? <Button variant="outline" size="sm" icon="ri-user-add-line" onClick={onEnrol}>Enrol</Button> : null}
          {canEdit ? <Button variant="ghost" size="sm" icon="ri-edit-line" aria-label={`Edit ${batch.name}`} onClick={onEdit} /> : null}
        </div>
      </div>
      {show === "dates" ? (
        <div className="border-t border-background-200 px-3 py-2">
          <p className="mb-2 text-xs text-foreground-500">Dates come from the intake. Change a date only where this batch differs; it is then marked overridden.</p>
          <div className="space-y-1">
            {schedule.map((r) => (
              <div key={r.intakeUnitId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-28 shrink-0 font-medium text-foreground-800">{r.code}</span>
                <span className="min-w-0 flex-1 truncate text-foreground-600" title={r.name}>{r.name}</span>
                {canEdit ? (
                  <>
                    <TextInput type="date" className="w-36 text-xs" aria-label={`${r.code} start for ${batch.name}`} value={r.startDate} disabled={busy}
                      onChange={(e) => { if (e.target.value && e.target.value <= r.endDate) onOverride(r.intakeUnitId, e.target.value, r.endDate); }} />
                    <TextInput type="date" className="w-36 text-xs" aria-label={`${r.code} end for ${batch.name}`} value={r.endDate} min={r.startDate} disabled={busy}
                      onChange={(e) => { if (e.target.value && e.target.value >= r.startDate) onOverride(r.intakeUnitId, r.startDate, e.target.value); }} />
                  </>
                ) : <span className="text-xs text-foreground-600">{shortDate(r.startDate)} – {shortDate(r.endDate)}</span>}
                {r.overridden ? (
                  <span className="text-xs text-accent-800">overridden ·{" "}
                    {canEdit ? <button type="button" className="font-medium text-primary-600 hover:underline" disabled={busy} onClick={() => onReset(r.intakeUnitId)}>reset</button> : "intake " + shortDate(r.intakeStartDate)}
                  </span>
                ) : <span className="text-xs text-foreground-400">from intake</span>}
              </div>
            ))}
            {schedule.length === 0 ? <p className="text-xs text-foreground-500">The intake has no schedule yet.</p> : null}
          </div>
        </div>
      ) : null}
      {show === "students" ? (
        <div className="border-t border-background-200 px-3 py-2">
          {students.length === 0 ? <p className="text-xs text-foreground-500">No students yet.</p> : students.map((s) => (
            <div key={s.enrolmentId} className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
              <Link to={`/admin/students/${s.id}`} className="text-foreground-900 hover:text-primary-600">{s.name} <span className="text-xs text-foreground-500">{s.email}</span></Link>
              <span className="flex items-center gap-2"><Badge tone="accent">{s.type}</Badge>{canEnrol ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => onWithdraw(s.enrolmentId)}>Withdraw</Button> : null}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DuplicateDrawer({ intake, onClose, onDone }: { intake: RtoIntake; onClose: () => void; onDone: (id: string) => void }) {
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try { const out = await rtoFlow<IntakeDetail>("intake_duplicate", { intakeId: intake.id, startDate: start }); onDone(out.intake.id); }
    catch (e) { setError(e instanceof Error ? e.message : "Not duplicated."); }
    finally { setBusy(false); }
  };
  return (
    <Drawer open title={`Duplicate ${intake.name}`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !start} onClick={() => void save()}>{busy ? "Duplicating…" : "Duplicate"}</Button></>}>
      <ErrorNote text={error} />
      <Field label="New start date" required hint={`Currently ${shortDate(intake.startDate)}. Every unit date moves by the same number of days.`}>
        <TextInput type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </Field>
      <p className="text-sm text-foreground-600">Copied: the schedule, batches, trainers, classrooms, class times and any batch date overrides. Not copied: students. The copy starts as a draft.</p>
    </Drawer>
  );
}
