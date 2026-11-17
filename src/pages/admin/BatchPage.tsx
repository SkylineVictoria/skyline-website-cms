// A batch on one page: 1 Class timing, 2 Trainers, 3 Units (dates only), 4 Students, 5 Assessments & Results (from Assessment
// Management, read only). Every change saves at once with Undo on the toast.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Badge, Button, ConfirmDialog, Field, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Avatars, Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import HoursNote from "@/pages/admin/components/rto/HoursNote";
import { OverrideStudentDrawer, PlaceByHandDrawer } from "@/pages/admin/components/rto/OverridePlacement";
import BatchTimingDrawer, { type BatchSaved } from "@/pages/admin/components/rto/BatchTimingDrawer";
import BatchAssessmentsPanel from "@/pages/admin/assessments/panels/BatchAssessmentsPanel";
import { Empty, MoreMenu, Section, SkeletonLines } from "@/pages/admin/components/rto/overlay";
import {
  clashText, monthYear, rto, rtoFlow, rtoHoursCheck, shortDate, stepPath, timingLines, type BatchPageData, type BatchScheduleRow, type HoursCheck, type BatchSession, type BatchStudent,
  type IntakeDetail, type StaffOption,
} from "@/pages/admin/lib/rto";

const active = (s: BatchStudent) => s.status === "active" || s.status === "deferred";

export default function BatchPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { push } = useToast();
  const [data, setData] = useState<BatchPageData | null>(null);
  const [error, setError] = useState("");
  const [timing, setTiming] = useState(false);
  const [details, setDetails] = useState(false);
  const [place, setPlace] = useState(false);
  const [act, setAct] = useState<null | { mode: "move" | "remove"; enrolmentId: string; name: string }>(null);
  const [hours, setHours] = useState<HoursCheck | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try { setData(await rtoFlow<BatchPageData>("batch_get", { batchId: id })); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The batch did not load."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const timingKey = JSON.stringify(data?.batch.sessions ?? []);
  useEffect(() => {
    let live = true;
    void rtoHoursCheck([id]).then((r) => { if (live) setHours(r[id]); });
    return () => { live = false; };
  }, [id, timingKey]);
  const undoable = (message: string, undo: () => void) => push(message, "success", { label: "Undo", onClick: undo });
  const fail = (e: unknown, text: string) => { push(e instanceof Error ? e.message : text, "error"); void load(); };

  if (error) return <div className="mx-auto max-w-3xl py-10"><ErrorNote text={error} /><Link to="/admin/course-fees?view=intakes" className="mt-4 inline-block text-sm text-primary-600">Back to intakes</Link></div>;
  if (!data) return <div className="space-y-4 py-4"><div className="h-16 w-80 animate-pulse rounded bg-background-200 motion-reduce:animate-none" /><SkeletonLines lines={6} /></div>;

  const { batch: b, intake: i } = data;
  const canEdit = data.rtoManager, canEnrol = data.rtoManager || data.admin;
  const back = `${stepPath(i.courseId, "intakes")}#${i.id}`;
  const students = b.students.filter(active);
  const lines = timingLines(b.sessions ?? []);
  const clashLines = [...new Set(data.clashes.map(clashText))];

  // ---- 2 trainers
  const setTrainers = (ids: string[], message: string, before: string[]) => {
    rtoFlow("batch_trainers_set", { batchId: b.id, trainerIds: ids }).then(() => { void load(); undoable(message, () => setTrainers(before, "Trainers put back.", ids)); })
      .catch((e) => fail(e, "Trainers not saved."));
  };
  // ---- 3 unit dates for this batch
  const setDates = (r: BatchScheduleRow, startDate: string, endDate: string, quiet = false) => {
    rtoFlow<IntakeDetail>("batch_override_set", { batchId: b.id, intakeUnitId: r.intakeUnitId, startDate, endDate }).then(() => {
      void load();
      if (!quiet) undoable(`${r.code} dates changed for ${b.name}.`, () => (r.overridden ? setDates(r, r.startDate, r.endDate, true) : reset(r, true)));
    }).catch((e) => fail(e, "Dates not saved."));
  };
  const reset = (r: BatchScheduleRow, quiet = false) => {
    rtoFlow<IntakeDetail>("batch_override_reset", { batchId: b.id, intakeUnitId: r.intakeUnitId }).then(() => {
      void load();
      if (!quiet) undoable(`${r.code} follows the intake dates again.`, () => setDates(r, r.startDate, r.endDate, true));
    }).catch((e) => fail(e, "Not reset."));
  };
  // ---- 4 students

  return (
    <div className="mx-auto w-full max-w-4xl min-w-0 space-y-4 pb-10">
      <div>
        <Link to={back} className="inline-flex items-center gap-1 text-label font-medium text-foreground-500 hover:text-primary-600"><i className="ri-arrow-left-line" aria-hidden="true" />{i.courseCode} · {monthYear(i.startDate)} intake</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-3xl font-bold text-foreground-950">{b.name}</h1>
          {b.isActive ? <Badge tone="primary">Active</Badge> : <Badge>Inactive</Badge>}
          <span className="text-sm tabular-nums text-foreground-600"><i className="ri-group-line mr-1 text-foreground-400" aria-hidden="true" />{students.length}{b.capacity ? ` of ${b.capacity} places` : " students"}</span>
          <div className="ml-auto">{canEdit ? <MoreMenu size="md" label="More actions" items={[
            { label: "Name and places…", icon: "ri-edit-line", onClick: () => setDetails(true) },
            { label: "Delete batch…", icon: "ri-delete-bin-line", danger: true, onClick: () => setConfirmDelete(true) },
          ]} /> : null}</div>
        </div>
        <p className="mt-0.5 text-sm text-foreground-600">{i.courseName} · {shortDate(b.startDate ?? i.startDate)} – {shortDate(b.endDate ?? i.endDate)}</p>
      </div>

      <HoursNote check={hours} />

      <Section n={1} title="Class timing" helper="When and where this batch meets each week."
        action={canEdit ? <Button size="sm" variant={lines.length ? "outline" : "primary"} icon="ri-time-line" onClick={() => setTiming(true)}>{lines.length ? "Change timing" : "Set class timing"}</Button> : undefined}>
        {lines.length === 0 ? <p className="text-sm text-foreground-500">No class times yet.</p> : (
          <ul className="space-y-1.5">
            {lines.map((l) => (
              <li key={l.text} className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground-800">
                <span className="w-24 shrink-0 font-semibold text-foreground-950">{l.text.split(" · ")[0]}</span>
                <span>{l.days}</span><span className="text-foreground-400">·</span><span className="tabular-nums">{l.time}</span><span className="text-foreground-400">·</span><span className="text-foreground-600">{l.where}</span>
              </li>
            ))}
          </ul>
        )}
        {clashLines.length ? (
          <div role="status" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <i className="ri-error-warning-line mr-1" aria-hidden="true" />{clashLines.map((t) => `${t}.`).join(" ")}
          </div>
        ) : null}
      </Section>

      <Section n={2} title="Trainers" helper="Who teaches this batch.">
        <TrainersEditor trainers={b.trainers} canEdit={canEdit}
          onAdd={(t) => setTrainers([...b.trainers.map((x) => x.id), t.id], `${t.name} added.`, b.trainers.map((x) => x.id))}
          onRemove={(t) => setTrainers(b.trainers.filter((x) => x.id !== t.id).map((x) => x.id), `${t.name} removed.`, b.trainers.map((x) => x.id))} />
      </Section>

      <Section n={3} title="Units" helper="The intake’s units in order. Change a date only where this batch differs from the intake.">
        {(b.schedule ?? []).length === 0 ? <p className="text-sm text-foreground-500">The intake has no timeline yet.</p> : (
          <div className="divide-y divide-background-100">
            {(b.schedule ?? []).map((r) => (
              <div key={r.intakeUnitId} className="grid grid-cols-1 items-center gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <p className="min-w-0 text-sm text-foreground-800"><strong className="font-semibold text-foreground-950">{r.code}</strong> <span className="text-foreground-600">{r.name}</span></p>
                <div className="flex flex-wrap items-center gap-2">
                  {canEdit ? (
                    <>
                      <TextInput type="date" className="w-36 text-xs" aria-label={`${r.code} starts`} value={r.startDate}
                        onChange={(e) => { const v = e.target.value; if (v && v <= r.endDate && v !== r.startDate) setDates(r, v, r.endDate); }} />
                      <TextInput type="date" className="w-36 text-xs" aria-label={`${r.code} ends`} value={r.endDate} min={r.startDate}
                        onChange={(e) => { const v = e.target.value; if (v && v >= r.startDate && v !== r.endDate) setDates(r, r.startDate, v); }} />
                    </>
                  ) : <span className="text-xs tabular-nums text-foreground-600">{shortDate(r.startDate)} – {shortDate(r.endDate)}</span>}
                  {r.overridden ? (
                    <span className="text-xs text-accent-800">changed for this batch{canEdit ? <> · <button type="button" className="font-medium text-primary-600 hover:underline" onClick={() => reset(r)}>reset</button></> : null}</span>
                  ) : <span className="w-[8.5rem] text-xs text-foreground-400">same as the intake</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section n={4} title="Students" helper="Placed automatically when their offer is accepted. Staff can override."
        action={canEnrol && b.isActive ? <Button size="sm" variant="outline" icon="ri-hand-coin-line" onClick={() => setPlace(true)}>Override: place a student</Button> : undefined}>
        {students.length === 0 ? (
          <Empty icon="ri-user-add-line" title="No students yet" text="Students are placed in this batch automatically when their offer is accepted and it has a free seat." />
        ) : (
          <ul className="divide-y divide-background-100">
            {students.map((s) => (
              <li key={s.enrolmentId} className="flex flex-wrap items-center gap-2 py-2">
                <Link to={`/admin/students/${s.id}`} className="min-w-0 flex-1"><span className="block truncate text-sm text-foreground-900 hover:text-primary-600">{s.name}</span><span className="block truncate text-xs text-foreground-500">{s.email}</span></Link>
                <Badge tone="accent">{s.type}</Badge>
                {canEnrol ? <MoreMenu label={`Override for ${s.name}`} items={[
                  ...(data.siblings.length ? [{ label: "Move to another batch (override)…", icon: "ri-arrow-left-right-line", onClick: () => setAct({ mode: "move", enrolmentId: s.enrolmentId, name: s.name }) }] : []),
                  { label: "Remove from batch (override)…", icon: "ri-user-unfollow-line", danger: true, onClick: () => setAct({ mode: "remove", enrolmentId: s.enrolmentId, name: s.name }) },
                ]} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section n={5} title="Assessments & Results" helper="Assigned from Master Data › Assessments; open one for its students and attempts.">
        <BatchAssessmentsPanel batchId={b.id} />
      </Section>

      <PlaceByHandDrawer open={place} courseId={i.courseId} batches={[{ id: b.id, name: b.name }]} batchId={b.id} intakeStart={i.startDate} intakeEnd={i.endDate}
        onClose={() => setPlace(false)} onDone={(m) => { setPlace(false); push(m); void load(); }} />
      {act ? <OverrideStudentDrawer open mode={act.mode} enrolmentId={act.enrolmentId} studentName={act.name} batches={[{ id: b.id, name: b.name }, ...data.siblings.map((o) => ({ id: o.id, name: o.name }))]} currentBatchId={b.id}
        onClose={() => setAct(null)} onDone={(m) => { setAct(null); push(m); void load(); }} /> : null}
      {timing ? (
        <BatchTimingDrawer intake={i} batch={b} onClose={() => setTiming(false)}
          onSaved={(out: BatchSaved, previous?: BatchSession[]) => {
            setTiming(false); void load();
            const restore = () => { rtoFlow("batch_setup", { batchId: b.id, sessions: previous ?? [] }).then(() => void load()).catch((e) => fail(e, "Not put back.")); };
            if (out.clashes.length) push(`Timing saved. ${clashText(out.clashes[0])}.`, "info", { label: "Undo", onClick: restore });
            else undoable("Class timing saved.", restore);
          }} />
      ) : null}
      {details ? <DetailsDrawer name={b.name} capacity={b.capacity} isActive={b.isActive} onClose={() => setDetails(false)}
        onSave={(patch) => rtoFlow("batch_setup", { batchId: b.id, ...patch }).then(() => { setDetails(false); void load(); push("Batch saved."); }).catch((e) => fail(e, "Not saved."))} /> : null}
      <ConfirmDialog open={confirmDelete} title={`Delete ${b.name}?`} confirmLabel="Delete batch"
        message="Its class timing and dates go too. A batch with students cannot be deleted; make it inactive instead."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); rto("batch_delete", { batchId: b.id }).then(() => { push(`${b.name} deleted.`); navigate(back); }).catch((e) => fail(e, "Not deleted.")); }} />
    </div>
  );
}

function TrainersEditor({ trainers, canEdit, onAdd, onRemove }: {
  trainers: { id: string; name: string }[]; canEdit: boolean; onAdd: (t: { id: string; name: string }) => void; onRemove: (t: { id: string; name: string }) => void;
}) {
  const [staff, setStaff] = useState<StaffOption[] | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (adding && staff === null) rto<StaffOption[]>("staff_list").then(setStaff).catch(() => setStaff([])); }, [adding, staff]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {trainers.length === 0 && !adding ? <span className="text-sm text-foreground-500">No trainer yet.</span> : null}
      {trainers.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-2 rounded-full border border-background-200 bg-background-100 py-1 pl-1 pr-2 text-sm text-foreground-900">
          <Avatars names={[t.name]} />{t.name}
          {canEdit ? <button type="button" aria-label={`Remove ${t.name}`} className="rounded-full p-0.5 text-foreground-400 hover:bg-background-200 hover:text-foreground-700" onClick={() => onRemove(t)}><i className="ri-close-line" aria-hidden="true" /></button> : null}
        </span>
      ))}
      {canEdit ? (adding ? (
        <Select autoFocus aria-label="Trainer to add" className="w-60" value="" onBlur={() => setAdding(false)}
          onChange={(e) => { const s = staff?.find((x) => x.id === e.target.value); if (s) { onAdd({ id: s.id, name: s.name }); setAdding(false); } }}>
          <option value="">{staff === null ? "Loading…" : "Choose a trainer"}</option>
          {(staff ?? []).filter((s) => !trainers.some((t) => t.id === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      ) : <Button size="sm" variant="outline" icon="ri-user-add-line" onClick={() => setAdding(true)}>Add trainer</Button>) : null}
    </div>
  );
}

function DetailsDrawer({ name, capacity, isActive, onClose, onSave }: {
  name: string; capacity: number | null; isActive: boolean; onClose: () => void; onSave: (patch: { name: string; capacity: string; isActive: boolean }) => void;
}) {
  const [form, setForm] = useState({ name, capacity: capacity ? String(capacity) : "", isActive });
  return (
    <Drawer open title={`${name}: name and places`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!form.name.trim()} onClick={() => onSave(form)}>Save</Button></>}>
      <Field label="Name" required><TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
      <Field label="Places" hint="Leave empty for no limit."><TextInput inputMode="numeric" value={form.capacity} onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value.replace(/\D/g, "") }))} /></Field>
      <Toggle checked={form.isActive} onChange={(v) => setForm((f) => ({ ...f, isActive: v }))} label="Active (inactive batches take no new students)" />
    </Drawer>
  );
}
