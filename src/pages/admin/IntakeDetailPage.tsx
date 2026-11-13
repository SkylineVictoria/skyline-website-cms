import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, SectionTabs, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { ClassroomsManager } from "@/pages/admin/ClassroomsPage";
import SchedulePanel from "@/pages/admin/components/rto/SchedulePanel";
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

      {tab === "schedule" ? <SchedulePanel detail={detail} readOnly={!canEdit} busy={busy}
        onSave={(rows) => void run("schedule_save", { rows }, "Schedule saved.")}
        onRegenerate={(fitEnd) => void run("intake_save", { id, generate: true, ...(detail.schedule.length ? { unitIds: detail.schedule.map((r) => r.unitId) } : {}), ...(fitEnd ? { fitEnd } : {}) }, "Schedule generated from the master timetable.")} /> : null}

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
      {enrolDrawer !== null ? <EnrolDrawer courseId={i.courseId} batches={detail.batches.filter((b) => b.isActive)} batchId={enrolDrawer} busy={busy} rtoManager={role.rtoManager} onClose={() => setEnrolDrawer(null)}
        onEnrol={async (batchId, students) => { if (await run("enrol", { batchId, students }, `${students.length} student${students.length === 1 ? "" : "s"} enrolled.`)) setEnrolDrawer(null); }} /> : null}
      <ConfirmDialog open={confirmDelete} title="Delete this intake?" message="Its schedule and empty batches go too. An intake with students or applications cannot be deleted; close it instead." confirmLabel="Delete intake"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); void rto("intake_delete", { intakeId: id }).then(() => { push("Intake deleted."); navigate("/admin/intakes"); }).catch((e) => push(e instanceof Error ? e.message : "Not deleted.", "error")); }} />
    </div>
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

export function BatchDrawer({ batch, existing, busy, onClose, onSave, onDelete }: {
  batch: RtoBatch | null; existing: RtoBatch[]; busy: boolean; onClose: () => void; onSave: (data: Record<string, unknown>) => void; onDelete: (id: string) => void;
}) {
  const nextName = () => { let n = 1; while (existing.some((b) => b.name === `B${n}`)) n++; return `B${n}`; };
  const [form, setForm] = useState({ name: batch?.name ?? nextName(), classroomId: batch?.classroomId ?? "", classDays: batch?.classDays ?? [], startTime: batch?.startTime ?? "",
    endTime: batch?.endTime ?? "", capacity: batch?.capacity ? String(batch.capacity) : "", isActive: batch?.isActive ?? true, trainerIds: batch?.trainers.map((t) => t.id) ?? [] });
  const [rooms, setRooms] = useState<Classroom[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [newRoom, setNewRoom] = useState({ name: "", campus: "", capacity: "" });
  const [adding, setAdding] = useState(false);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void Promise.all([rto<Classroom[]>("classroom_list"), rto<StaffOption[]>("staff_list")]).then(([r, s]) => { setRooms(r); setStaff(s); }).catch((e) => setError(e instanceof Error ? e.message : "Lists did not load."));
  }, []);
  const reloadRooms = () => { void rto<Classroom[]>("classroom_list").then(setRooms).catch(() => undefined); };
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const addRoom = async () => {
    if (!newRoom.name.trim()) return;
    try { const list = await rto<Classroom[]>("classroom_save", newRoom); setRooms(list); const made = list.find((r) => r.name === newRoom.name.trim()); if (made) set({ classroomId: made.id }); setNewRoom({ name: "", campus: "", capacity: "" }); setAdding(false); }
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
      <div>
        <Field label="Classroom">
          <Select value={adding ? "__new__" : form.classroomId} onChange={(e) => { if (e.target.value === "__new__") setAdding(true); else { setAdding(false); set({ classroomId: e.target.value }); } }}>
            <option value="">No classroom</option>
            {rooms.filter((r) => r.isActive || r.id === form.classroomId).map((r) => <option key={r.id} value={r.id}>{r.name}{r.campus ? ` · ${r.campus}` : ""}{r.capacity ? ` (${r.capacity})` : ""}</option>)}
            <option value="__new__">+ New classroom</option>
          </Select>
        </Field>
        {adding ? (
          <div className="mt-2 flex items-end gap-2 rounded-md bg-background-100 p-2">
            <TextInput autoFocus aria-label="New classroom name" placeholder="Classroom name" value={newRoom.name} onChange={(e) => setNewRoom((r) => ({ ...r, name: e.target.value }))} />
            <TextInput aria-label="Campus (optional)" placeholder="Campus (optional)" value={newRoom.campus} onChange={(e) => setNewRoom((r) => ({ ...r, campus: e.target.value }))} />
            <Button size="sm" disabled={!newRoom.name.trim()} onClick={() => void addRoom()}>Create</Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        ) : null}
        <button type="button" onClick={() => setManage(true)} className="mt-1 text-xs font-medium text-primary-600 hover:underline">Manage classrooms</button>
      </div>
      {manage ? <Drawer open title="Classrooms" onClose={() => { setManage(false); reloadRooms(); }}><ClassroomsManager onChanged={reloadRooms} /></Drawer> : null}
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

export function EnrolDrawer({ courseId, batches, batchId, busy, rtoManager, onClose, onEnrol }: {
  courseId: string; batches: RtoBatch[]; batchId: string; busy: boolean; rtoManager: boolean; onClose: () => void; onEnrol: (batchId: string, students: { id: string; type: EnrolmentType }[]) => void;
}) {
  const [target, setTarget] = useState(batchId || batches[0]?.id || "");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<StudentOption[] | null>(null);
  const [picked, setPicked] = useState<Record<string, EnrolmentType>>({});
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => { void rto<StudentOption[]>("student_search", { courseId, q, all }).then(setFound).catch((e) => setError(e instanceof Error ? e.message : "Search failed.")); }, 250);
    return () => clearTimeout(t);
  }, [courseId, q, all]);
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
      {rtoManager ? <Toggle checked={all} onChange={setAll} label="Include students without an application" /> : null}
      <p className="text-xs text-foreground-500">{all ? "A student without an application for this course gets one automatically, marked “direct enrolment”." : "Only students with an application for this course are listed."}</p>
      {found === null ? <p className="text-sm text-foreground-500">Searching…</p> : found.length === 0 ? <EmptyState icon="ri-user-search-line" title="No students found" description="A student appears once they have an application for this course." /> : (
        <div className="divide-y divide-background-200 rounded-md border border-background-200">
          {found.map((s) => {
            const on = s.id in picked, inBatch = already.has(s.id);
            return (
              <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <input type="checkbox" disabled={inBatch} checked={on} onChange={() => setPicked((p) => { const next = { ...p }; if (on) delete next[s.id]; else next[s.id] = "CoE"; return next; })} />
                  <span className="min-w-0"><span className="block truncate text-sm text-foreground-900">{s.name}{s.linked === false ? <span className="ml-1.5"><Badge tone="warn">Direct enrolment</Badge></span> : null}</span><span className="block truncate text-xs text-foreground-500">{s.email}</span></span>
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
