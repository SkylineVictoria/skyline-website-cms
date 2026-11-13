import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, SectionTabs, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Avatars, Drawer, ErrorNote, FeesEditor, IntakeStatusChip, ReadOnlyNote } from "@/pages/admin/components/rto/shared";
import {
  DAYS, addDays, daysBetween, feeTotal, money, parseDay, rto, shortDate,
  type Classroom, type EnrolmentType, type IntakeDetail, type IntakeStatus, type RtoBatch, type ScheduleRow, type StaffOption, type StudentOption,
} from "@/pages/admin/lib/rto";

const TABS = [
  { id: "schedule", label: "Schedule", icon: "ri-calendar-schedule-line" }, { id: "batches", label: "Batches", icon: "ri-group-line" },
  { id: "students", label: "Students", icon: "ri-user-line" }, { id: "fees", label: "Fees", icon: "ri-money-dollar-circle-line" },
];

/** Intakes › an intake: the unit schedule, its batches, students and fees. */
export default function IntakeDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "schedule";
  const { push } = useToast();
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [role, setRole] = useState({ rtoManager: false, admin: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [batchDrawer, setBatchDrawer] = useState<RtoBatch | "new" | null>(null);
  const [enrolDrawer, setEnrolDrawer] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, me] = await Promise.all([rto<IntakeDetail>("intake_get", { intakeId: id }), rto<{ rtoManager: boolean; admin: boolean }>("me")]);
      setDetail(d); setRole(me); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "The intake did not load."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (action: string, data: Record<string, unknown>, done: string) => {
    setBusy(true);
    try { setDetail(await rto<IntakeDetail>(action, { intakeId: id, ...data })); push(done); return true; }
    catch (e) { push(e instanceof Error ? e.message : "Not saved.", "error"); return false; }
    finally { setBusy(false); }
  };

  if (error) return <Card className="p-8"><ErrorNote text={error} /><div className="mt-4"><Link to="/admin/intakes" className="text-sm text-primary-600">Back to Intakes</Link></div></Card>;
  if (!detail) return <p className="py-10 text-center text-foreground-500">Loading intake…</p>;
  const i = detail.intake;
  const canEdit = role.rtoManager, canEnrol = role.rtoManager || role.admin;

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-1 mb-4 border-b border-background-200 bg-background-100/95 px-1 pb-3 pt-1 backdrop-blur">
        <Link to="/admin/intakes" className="mb-1 inline-flex items-center gap-1 text-[13px] font-medium text-foreground-500 hover:text-primary-600"><i className="ri-arrow-left-line" aria-hidden="true" />Intakes</Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2"><h1 className="font-heading text-xl font-bold text-foreground-950">{i.name}</h1><IntakeStatusChip status={i.status} /></div>
            <p className="mt-1 text-sm text-foreground-500">
              <Link to={`/admin/course-fees/${encodeURIComponent(i.courseId)}?tab=intakes`} className="hover:text-primary-600">{i.courseCode} {i.courseName}</Link>
              {` · ${shortDate(i.startDate)} – ${shortDate(i.endDate)} · ${i.enrolled}${i.capacity ? ` / ${i.capacity}` : ""} enrolled`}{i.campus ? ` · ${i.campus}` : ""}
            </p>
          </div>
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Intake status" value={i.status} disabled={busy} onChange={(e) => void run("intake_save", { id, status: e.target.value as IntakeStatus }, "Status changed.")}>
                <option value="draft">Draft</option><option value="open">Open</option><option value="full">Full</option><option value="closed">Closed</option>
              </Select>
              <Button variant="ghost" size="sm" icon="ri-delete-bin-line" aria-label="Delete intake" onClick={() => setConfirmDelete(true)} />
            </div>
          ) : null}
        </div>
      </div>
      <SectionTabs tabs={TABS} active={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} />
      {!canEdit ? <div className="mb-3"><ReadOnlyNote>{canEnrol ? "You can add students to existing batches. Only an RTO Manager changes the schedule, batches and fees." : "Read only."}</ReadOnlyNote></div> : null}

      {tab === "schedule" ? <ScheduleTab detail={detail} readOnly={!canEdit} busy={busy}
        onSave={(rows) => void run("schedule_save", { rows }, "Schedule saved.")}
        onRegenerate={() => void run("intake_save", { id, generate: true }, "Schedule generated from the course's active units.")} /> : null}

      {tab === "batches" ? (
        <div className="space-y-2">
          {canEdit ? <div className="flex justify-end"><Button icon="ri-add-line" onClick={() => setBatchDrawer("new")}>New batch</Button></div> : null}
          {detail.batches.length === 0 ? <Card><EmptyState icon="ri-group-line" title="No batches yet" description={canEdit ? "Create a batch (B1, B2…) with its classroom, class times and trainers." : "An RTO Manager creates batches."} /></Card> : detail.batches.map((b) => {
            const active = b.students.filter((s) => s.status === "active" || s.status === "deferred").length;
            return (
              <Card key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium text-foreground-900">{b.name} {b.isActive ? null : <Badge>Inactive</Badge>}</p>
                  <p className="text-xs text-foreground-500">{[b.classroom, b.classDays.join(" "), b.startTime && `${b.startTime}–${b.endTime ?? ""}`].filter(Boolean).join(" · ") || "No class times yet"}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm tabular-nums text-foreground-700"><i className="ri-group-line mr-1 text-foreground-400" aria-hidden="true" />{active}{b.capacity ? ` / ${b.capacity}` : ""}</span>
                  <Avatars names={b.trainers.map((t) => t.name)} />
                  {canEnrol ? <Button variant="outline" size="sm" icon="ri-user-add-line" onClick={() => setEnrolDrawer(b.id)}>Add students</Button> : null}
                  {canEdit ? <Button variant="ghost" size="sm" icon="ri-edit-line" aria-label={`Edit ${b.name}`} onClick={() => setBatchDrawer(b)} /> : null}
                </div>
              </Card>
            );
          })}
        </div>
      ) : null}

      {tab === "students" ? <StudentsTab detail={detail} canEnrol={canEnrol} busy={busy} onAdd={() => setEnrolDrawer(detail.batches.find((b) => b.isActive)?.id ?? "")}
        onWithdraw={(enrolmentId) => void run("unenrol", { enrolmentId }, "Student withdrawn from the batch.")} /> : null}

      {tab === "fees" ? <FeesTab detail={detail} readOnly={!canEdit} busy={busy} onSave={(items) => void run("intake_fees_save", { items }, items.length ? "Intake fees saved." : "This intake uses the course fees again.")} /> : null}

      {batchDrawer ? <BatchDrawer batch={batchDrawer === "new" ? null : batchDrawer} existing={detail.batches} busy={busy} onClose={() => setBatchDrawer(null)}
        onSave={async (data) => { if (await run("batch_save", data, "Batch saved.")) setBatchDrawer(null); }}
        onDelete={async (batchId) => { if (await run("batch_delete", { batchId }, "Batch deleted.")) setBatchDrawer(null); }} /> : null}
      {enrolDrawer !== null ? <EnrolDrawer courseId={i.courseId} batches={detail.batches.filter((b) => b.isActive)} batchId={enrolDrawer} busy={busy} onClose={() => setEnrolDrawer(null)}
        onEnrol={async (batchId, students) => { if (await run("enrol", { batchId, students }, `${students.length} student${students.length === 1 ? "" : "s"} enrolled.`)) setEnrolDrawer(null); }} /> : null}
      <ConfirmDialog open={confirmDelete} title="Delete this intake?" message="Its schedule and empty batches go too. An intake with students or applications cannot be deleted; close it instead." confirmLabel="Delete intake"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); void rto("intake_delete", { intakeId: id }).then(() => { push("Intake deleted."); navigate("/admin/intakes"); }).catch((e) => push(e instanceof Error ? e.message : "Not deleted.", "error")); }} />
    </div>
  );
}

/** A CSS-grid timeline. Change a unit's dates inline or drag its bar; the units after it move by the same number of days. */
function ScheduleTab({ detail, readOnly, busy, onSave, onRegenerate }: {
  detail: IntakeDetail; readOnly: boolean; busy: boolean; onSave: (rows: ScheduleRow[]) => void; onRegenerate: () => void;
}) {
  const [rows, setRows] = useState<ScheduleRow[]>(detail.schedule);
  const [confirm, setConfirm] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; x: number; moved: number } | null>(null);
  const [dragDays, setDragDays] = useState<{ index: number; days: number } | null>(null);
  useEffect(() => { setRows(detail.schedule); }, [detail.schedule]);

  const first = rows.length ? rows.reduce((m, r) => (r.startDate < m ? r.startDate : m), rows[0].startDate) : detail.intake.startDate;
  const last = rows.length ? rows.reduce((m, r) => (r.endDate > m ? r.endDate : m), rows[0].endDate) : detail.intake.endDate ?? detail.intake.startDate;
  const span = Math.max(1, daysBetween(first, last) + 1);
  const months = useMemo(() => {
    const out: { label: string; left: number }[] = [];
    let d = new Date(parseDay(first)); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    while (d.getTime() <= parseDay(last)) {
      const left = Math.max(0, daysBetween(first, d.toISOString().slice(0, 10)) / span);
      out.push({ label: d.toLocaleDateString("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" }), left });
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
    return out;
  }, [first, last, span]);

  /** Move unit `index` (and every later unit) by `days`; or change only its end and shift the later ones. */
  const shift = (index: number, startDays: number, endDays: number) => setRows((list) => list.map((r, x) => {
    if (x < index) return r;
    if (x === index) return { ...r, startDate: addDays(r.startDate, startDays), endDate: addDays(r.endDate, endDays) };
    return { ...r, startDate: addDays(r.startDate, endDays), endDate: addDays(r.endDate, endDays) };
  }));
  const setStart = (index: number, value: string) => { if (value) { const delta = daysBetween(rows[index].startDate, value); shift(index, delta, delta); } };
  const setEnd = (index: number, value: string) => { if (value && value >= rows[index].startDate) shift(index, 0, daysBetween(rows[index].endDate, value)); };
  const pxPerDay = () => (track.current?.clientWidth ?? 600) / span;
  const onPointerDown = (index: number, e: React.PointerEvent) => {
    if (readOnly) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { index, x: e.clientX, moved: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const days = Math.round((e.clientX - drag.current.x) / pxPerDay());
    if (days !== drag.current.moved) { drag.current.moved = days; setDragDays({ index: drag.current.index, days }); }
  };
  const onPointerUp = () => {
    if (drag.current && drag.current.moved) shift(drag.current.index, drag.current.moved, drag.current.moved);
    drag.current = null; setDragDays(null);
  };
  const dirty = JSON.stringify(rows) !== JSON.stringify(detail.schedule);

  if (!rows.length) {
    return <Card><EmptyState icon="ri-calendar-schedule-line" title="No schedule yet" description={readOnly ? "An RTO Manager generates the schedule." : "Generate it from the course's active units."} />
      {readOnly ? null : <div className="flex justify-center pb-6"><Button disabled={busy} onClick={onRegenerate}>Generate schedule</Button></div>}</Card>;
  }
  return (
    <Card className="p-0">
      <div className="grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)] border-b border-background-200 text-xs text-foreground-500">
        <div className="px-4 py-2 font-medium">Unit</div>
        <div ref={track} className="relative h-8">{months.map((m) => <span key={m.label} className="absolute top-2 border-l border-background-300 pl-1" style={{ left: `${m.left * 100}%` }}>{m.label}</span>)}</div>
      </div>
      <div onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {rows.map((r, index) => {
          const offset = dragDays && index >= dragDays.index ? dragDays.days : 0;
          const left = (daysBetween(first, r.startDate) + offset) / span, width = (daysBetween(r.startDate, r.endDate) + 1) / span;
          return (
            <div key={r.id} className="grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)] items-center border-b border-background-100 last:border-0">
              <div className="min-w-0 px-4 py-2">
                <p className="truncate text-sm font-medium text-foreground-900" title={r.name}>{r.code} <span className="font-normal text-foreground-600">{r.name}</span></p>
                {readOnly ? <p className="text-xs text-foreground-500">{shortDate(r.startDate)} – {shortDate(r.endDate)}</p> : (
                  <div className="mt-1 flex items-center gap-1">
                    <input type="date" aria-label={`${r.code} start`} value={r.startDate} onChange={(e) => setStart(index, e.target.value)} className="w-[8.2rem] rounded border border-background-300 px-1 py-0.5 text-xs" />
                    <span className="text-xs text-foreground-400">–</span>
                    <input type="date" aria-label={`${r.code} end`} value={r.endDate} min={r.startDate} onChange={(e) => setEnd(index, e.target.value)} className="w-[8.2rem] rounded border border-background-300 px-1 py-0.5 text-xs" />
                  </div>
                )}
              </div>
              <div className="relative h-10">
                <div onPointerDown={(e) => onPointerDown(index, e)} title={`${r.code}: ${shortDate(r.startDate)} – ${shortDate(r.endDate)}`}
                  className={`absolute top-2 h-6 rounded ${r.unitType === "elective" ? "bg-secondary-300" : "bg-primary-400"} ${readOnly ? "" : "cursor-grab touch-none active:cursor-grabbing"}`}
                  style={{ left: `${left * 100}%`, width: `${Math.max(width * 100, 0.8)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {readOnly ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-background-200 px-4 py-3">
          <Button variant="outline" size="sm" icon="ri-refresh-line" disabled={busy} onClick={() => setConfirm(true)}>Regenerate</Button>
          <p className="text-xs text-foreground-500">Drag a bar or change a date; later units move with it.</p>
          <div className="flex gap-2">{dirty ? <Button variant="ghost" size="sm" onClick={() => setRows(detail.schedule)}>Undo</Button> : null}
            <Button disabled={busy || !dirty} onClick={() => onSave(rows)}>{busy ? "Saving…" : "Save schedule"}</Button></div>
        </div>
      )}
      <ConfirmDialog open={confirm} title="Regenerate the schedule?" message="Every unit date is laid out again from the start date. Your manual changes are replaced." confirmLabel="Regenerate"
        onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); onRegenerate(); }} />
    </Card>
  );
}

function StudentsTab({ detail, canEnrol, busy, onAdd, onWithdraw }: { detail: IntakeDetail; canEnrol: boolean; busy: boolean; onAdd: () => void; onWithdraw: (enrolmentId: string) => void }) {
  const rows = detail.batches.flatMap((b) => b.students.map((s) => ({ ...s, batch: b.name })));
  return (
    <div className="space-y-2">
      {canEnrol && detail.batches.some((b) => b.isActive) ? <div className="flex justify-end"><Button icon="ri-user-add-line" onClick={onAdd}>Add students</Button></div> : null}
      {rows.length === 0 ? <Card><EmptyState icon="ri-user-line" title="No students yet" description={detail.batches.length ? "Add students to a batch." : "Create a batch first."} /></Card> : (
        <Card className="divide-y divide-background-200">
          {rows.map((s) => (
            <div key={s.enrolmentId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0"><Link to={`/admin/students/${s.id}`} className="font-medium text-foreground-900 hover:text-primary-600">{s.name}</Link><p className="text-xs text-foreground-500">{s.email}</p></div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="secondary">{s.batch}</Badge><Badge tone="accent">{s.type}</Badge>
                <Badge tone={s.status === "active" ? "primary" : "muted"}>{s.status}</Badge>
                <span className="text-xs text-foreground-500">{shortDate(s.enrolledOn)}</span>
                {canEnrol && s.status === "active" ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => onWithdraw(s.enrolmentId)}>Withdraw</Button> : null}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function FeesTab({ detail, readOnly, busy, onSave }: { detail: IntakeDetail; readOnly: boolean; busy: boolean; onSave: (items: IntakeDetail["fees"]) => void }) {
  const [override, setOverride] = useState(detail.fees.length > 0);
  useEffect(() => { setOverride(detail.fees.length > 0); }, [detail.fees]);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-foreground-600">{detail.fees.length ? "This intake has its own fees. Offer letters for it use them." : `This intake uses the course fees (total ${money(feeTotal(detail.courseFees))}).`}</p>
        {readOnly ? null : <Toggle checked={override} onChange={(v) => { setOverride(v); if (!v && detail.fees.length) onSave([]); }} label="Override for this intake" />}
      </div>
      <FeesEditor items={override ? (detail.fees.length ? detail.fees : detail.courseFees) : detail.courseFees} readOnly={readOnly || !override} busy={busy} onSave={onSave} saveLabel="Save intake fees" />
    </Card>
  );
}

function BatchDrawer({ batch, existing, busy, onClose, onSave, onDelete }: {
  batch: RtoBatch | null; existing: RtoBatch[]; busy: boolean; onClose: () => void; onSave: (data: Record<string, unknown>) => void; onDelete: (id: string) => void;
}) {
  const nextName = () => { let n = 1; while (existing.some((b) => b.name === `B${n}`)) n++; return `B${n}`; };
  const [form, setForm] = useState({ name: batch?.name ?? nextName(), classroomId: batch?.classroomId ?? "", classDays: batch?.classDays ?? [], startTime: batch?.startTime ?? "",
    endTime: batch?.endTime ?? "", capacity: batch?.capacity ? String(batch.capacity) : "", isActive: batch?.isActive ?? true, trainerIds: batch?.trainers.map((t) => t.id) ?? [] });
  const [rooms, setRooms] = useState<Classroom[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [newRoom, setNewRoom] = useState({ name: "", campus: "", capacity: "" });
  const [error, setError] = useState("");
  useEffect(() => {
    void Promise.all([rto<Classroom[]>("classroom_list"), rto<StaffOption[]>("staff_list")]).then(([r, s]) => { setRooms(r); setStaff(s); }).catch((e) => setError(e instanceof Error ? e.message : "Lists did not load."));
  }, []);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const addRoom = async () => {
    if (!newRoom.name.trim()) return;
    try { const list = await rto<Classroom[]>("classroom_save", newRoom); setRooms(list); const made = list.find((r) => r.name === newRoom.name.trim()); if (made) set({ classroomId: made.id }); setNewRoom({ name: "", campus: "", capacity: "" }); }
    catch (e) { setError(e instanceof Error ? e.message : "Classroom not saved."); }
  };
  return (
    <Drawer open title={batch ? `Edit ${batch.name}` : "New batch"} onClose={onClose}
      footer={<>{batch ? <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => onDelete(batch.id)}>Delete</Button> : null}
        <Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !form.name.trim()} onClick={() => onSave({ id: batch?.id, ...form })}>{busy ? "Saving…" : "Save batch"}</Button></>}>
      <ErrorNote text={error} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required><TextInput value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Capacity"><TextInput inputMode="numeric" value={form.capacity} onChange={(e) => set({ capacity: e.target.value.replace(/\D/g, "") })} /></Field>
      </div>
      <Field label="Classroom">
        <Select value={form.classroomId} onChange={(e) => set({ classroomId: e.target.value })}>
          <option value="">No classroom</option>
          {rooms.filter((r) => r.isActive || r.id === form.classroomId).map((r) => <option key={r.id} value={r.id}>{r.name}{r.campus ? ` · ${r.campus}` : ""}{r.capacity ? ` (${r.capacity})` : ""}</option>)}
        </Select>
      </Field>
      <div className="flex items-end gap-2">
        <TextInput aria-label="New classroom name" placeholder="New classroom" value={newRoom.name} onChange={(e) => setNewRoom((r) => ({ ...r, name: e.target.value }))} />
        <TextInput aria-label="Campus" placeholder="Campus" value={newRoom.campus} onChange={(e) => setNewRoom((r) => ({ ...r, campus: e.target.value }))} />
        <Button variant="outline" size="sm" disabled={!newRoom.name.trim()} onClick={() => void addRoom()}>Add</Button>
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-foreground-800">Class days</p>
        <div className="flex flex-wrap gap-1.5">{DAYS.map((d) => (
          <button key={d} type="button" onClick={() => set({ classDays: DAYS.filter((x) => toggle(form.classDays, d).includes(x)) })}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${form.classDays.includes(d) ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 text-foreground-700"}`}>{d}</button>
        ))}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts"><TextInput type="time" value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} /></Field>
        <Field label="Ends"><TextInput type="time" value={form.endTime} onChange={(e) => set({ endTime: e.target.value })} /></Field>
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-foreground-800">Trainers</p>
        {staff.length === 0 ? <p className="text-xs text-foreground-500">No active staff yet.</p> : (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-background-200 p-2">
            {staff.map((s) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-background-100">
                <input type="checkbox" checked={form.trainerIds.includes(s.id)} onChange={() => set({ trainerIds: toggle(form.trainerIds, s.id) })} />
                {s.name}<span className="text-xs text-foreground-500">{s.email}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <Toggle checked={form.isActive} onChange={(v) => set({ isActive: v })} label="Active" />
    </Drawer>
  );
}

function EnrolDrawer({ courseId, batches, batchId, busy, onClose, onEnrol }: {
  courseId: string; batches: RtoBatch[]; batchId: string; busy: boolean; onClose: () => void; onEnrol: (batchId: string, students: { id: string; type: EnrolmentType }[]) => void;
}) {
  const [target, setTarget] = useState(batchId || batches[0]?.id || "");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<StudentOption[] | null>(null);
  const [picked, setPicked] = useState<Record<string, EnrolmentType>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => { void rto<StudentOption[]>("student_search", { courseId, q }).then(setFound).catch((e) => setError(e instanceof Error ? e.message : "Search failed.")); }, 250);
    return () => clearTimeout(t);
  }, [courseId, q]);
  const already = new Set(batches.find((b) => b.id === target)?.students.filter((s) => s.status === "active").map((s) => s.id) ?? []);
  const chosen = Object.entries(picked);
  return (
    <Drawer open title="Add students" onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !target || chosen.length === 0} onClick={() => onEnrol(target, chosen.map(([id, type]) => ({ id, type })))}>{busy ? "Enrolling…" : `Enrol ${chosen.length || ""}`}</Button></>}>
      <ErrorNote text={error} />
      <Field label="Batch" required>
        <Select value={target} onChange={(e) => setTarget(e.target.value)}>{batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
      </Field>
      <TextInput placeholder="Search students on this course by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search students" />
      <p className="text-xs text-foreground-500">Only students with an application for this course are listed.</p>
      {found === null ? <p className="text-sm text-foreground-500">Searching…</p> : found.length === 0 ? <EmptyState icon="ri-user-search-line" title="No students found" description="A student appears once they have an application for this course." /> : (
        <div className="divide-y divide-background-200 rounded-md border border-background-200">
          {found.map((s) => {
            const on = s.id in picked, inBatch = already.has(s.id);
            return (
              <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <input type="checkbox" disabled={inBatch} checked={on} onChange={() => setPicked((p) => { const next = { ...p }; if (on) delete next[s.id]; else next[s.id] = "CoE"; return next; })} />
                  <span className="min-w-0"><span className="block truncate text-sm text-foreground-900">{s.name}</span><span className="block truncate text-xs text-foreground-500">{s.email}</span></span>
                </label>
                {inBatch ? <Badge>In batch</Badge> : on ? (
                  <Select aria-label={`Enrolment type for ${s.name}`} value={picked[s.id]} onChange={(e) => setPicked((p) => ({ ...p, [s.id]: e.target.value as EnrolmentType }))} className="w-28">
                    <option value="CoE">CoE</option><option value="VoE">VoE</option><option value="Domestic">Domestic</option>
                  </Select>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Drawer>
  );
}
