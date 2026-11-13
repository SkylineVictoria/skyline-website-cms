import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Field, Select, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { Drawer } from "@/pages/admin/components/rto/shared";
import { Empty } from "@/pages/admin/components/rto/overlay";
import { useToast } from "@/pages/admin/components/toastContext";
import { fmtDateTime, fromLocalInput, STATE_LABEL, toLocalInput } from "@/lib/assessment/api";
import { asmAdmin, type AssignmentRow, type AssignmentStudent, type BatchOption, type StaffOption } from "@/pages/admin/lib/assessments";

const fail = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Assignments of one assessment: batches, dates, trainers, practical sessions, and the students with their attempts. */
export default function AssignmentsPanel({ assessmentId, courseId, assignments, canAssign, onChanged, onOpenAttempt }: {
  assessmentId: string; courseId: string; assignments: AssignmentRow[]; canAssign: boolean; onChanged: () => void; onOpenAttempt: (attemptId: string) => void;
}) {
  const { push } = useToast();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<AssignmentRow | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-700">Assign the published version to batches. Students come from the batch's enrolments, assessors from its trainers.</p>
        <Button size="sm" icon="ri-send-plane-line" disabled={!canAssign} title={canAssign ? "" : "Publish a version first"} onClick={() => setCreating(true)}>Assign to batches</Button>
      </div>
      {assignments.length === 0 ? <Empty icon="ri-group-line" title="Not assigned yet" text="Once published, assign the assessment to one or more batches with a due date." /> : (
        <ul className="divide-y divide-background-100 rounded-md border border-background-200">{assignments.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(a)}><span className="block font-medium text-foreground-900">{a.batchName} · {a.intake}</span><span className="block text-xs text-foreground-600">v{a.versionNo} · due {fmtDateTime(a.dueAt)}{a.lateUntil ? ` · late until ${fmtDateTime(a.lateUntil)}` : ""} · {a.eligibleCount} student{a.eligibleCount === 1 ? "" : "s"}</span></button>
            <Badge tone={a.status === "open" ? "success" : a.status === "cancelled" ? "warn" : "muted"}>{a.status}</Badge>
            <Link to={`/admin/batches/${a.batchId}`} className="text-xs text-foreground-600 hover:text-primary-700">Batch page</Link>
          </li>))}</ul>
      )}
      {creating ? <CreateDrawer assessmentId={assessmentId} courseId={courseId} onClose={() => setCreating(false)} onDone={() => { setCreating(false); onChanged(); push("Assigned."); }} /> : null}
      {open ? <AssignmentDrawer assignment={open} onClose={() => setOpen(null)} onChanged={() => { onChanged(); }} onOpenAttempt={onOpenAttempt} /> : null}
    </div>
  );
}

function CreateDrawer({ assessmentId, courseId, onClose, onDone }: { assessmentId: string; courseId: string; onClose: () => void; onDone: () => void }) {
  const [batches, setBatches] = useState<BatchOption[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [trainers, setTrainers] = useState<string[]>([]);
  const [availableFrom, setAvailableFrom] = useState(toLocalInput(new Date().toISOString()));
  const [dueAt, setDueAt] = useState(toLocalInput(new Date(Date.now() + 14 * 86400000).toISOString()));
  const [lateUntil, setLateUntil] = useState("");
  const [rule, setRule] = useState<"follow_batch" | "keep">("follow_batch");
  const [notes, setNotes] = useState("");
  const [events, setEvents] = useState<{ kind: string; title: string; startsAt: string; endsAt: string }[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { void asmAdmin<BatchOption[]>("batch_list", { courseId }).then(setBatches).catch(() => setBatches([])); void asmAdmin<StaffOption[]>("staff_list").then(setStaff).catch(() => setStaff([])); }, [courseId]);
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const out = await asmAdmin<{ ok: boolean; created: number; errors: { message: string }[] }>("assignment_create", { assessmentId, batchIds: picked, availableFrom: fromLocalInput(availableFrom), dueAt: fromLocalInput(dueAt), lateUntil: fromLocalInput(lateUntil), trainerStaffIds: trainers, reassignRule: rule, notes, events: events.filter((e) => e.startsAt).map((e) => ({ ...e, startsAt: fromLocalInput(e.startsAt), endsAt: fromLocalInput(e.endsAt) })) });
      if (out.errors?.length) setError(out.errors.map((e) => e.message).join(" "));
      if (out.created > 0) onDone();
    } catch (e) { setError(fail(e)); } finally { setBusy(false); }
  };
  return (
    <Drawer open title="Assign to batches" onClose={onClose} width="max-w-2xl" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !picked.length || !dueAt} onClick={() => void submit()}>Assign</Button></>}>
      <div className="space-y-4">
        <div><span className="mb-1.5 block text-label font-medium text-foreground-800">Batches on this course</span>
          {batches.length === 0 ? <p className="text-sm text-foreground-600">No batches on this course yet (Courses › Intakes).</p> : <ul className="grid gap-1 sm:grid-cols-2">{batches.map((b) => <li key={b.id}><label className="flex items-center gap-2 rounded-md border border-background-200 px-2 py-1.5 text-sm"><input type="checkbox" checked={picked.includes(b.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, b.id] : picked.filter((x) => x !== b.id))} /><span className="min-w-0 flex-1 truncate">{b.name} · {b.intake}</span><span className="text-xs text-foreground-500">{b.students}</span></label></li>)}</ul>}</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Available from"><TextInput type="datetime-local" value={availableFrom} onChange={(e) => setAvailableFrom(e.target.value)} /></Field>
          <Field label="Due" required><TextInput type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
          <Field label="Late submissions until" hint="Only matters when the institution blocks late work"><TextInput type="datetime-local" value={lateUntil} onChange={(e) => setLateUntil(e.target.value)} /></Field>
        </div>
        <Field label="Extra assessors (the batch's trainers are always assessors)"><Select multiple size={4} value={trainers} onChange={(e) => setTrainers([...e.target.selectedOptions].map((o) => o.value))}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.isTrainer ? "" : " (no trainer role)"}</option>)}</Select></Field>
        <Field label="When a student leaves or joins the batch"><Select value={rule} onChange={(e) => setRule(e.target.value as "follow_batch" | "keep")}><option value="follow_batch">Follow the batch: leavers lose open drafts, joiners are added and told</option><option value="keep">Keep: existing attempts stay as they are</option></Select></Field>
        <div><span className="mb-1.5 block text-label font-medium text-foreground-800">Practical / observation sessions (calendar)</span>
          <ul className="space-y-1.5">{events.map((ev, i) => <li key={i} className="grid gap-1.5 sm:grid-cols-[7rem_1fr_1fr_1fr_auto]"><Select value={ev.kind} onChange={(e) => setEvents(events.map((x, k) => (k === i ? { ...x, kind: e.target.value } : x)))}><option value="practical">Practical</option><option value="observation">Observation</option><option value="other">Other</option></Select><TextInput placeholder="Title" value={ev.title} onChange={(e) => setEvents(events.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} /><TextInput type="datetime-local" value={ev.startsAt} onChange={(e) => setEvents(events.map((x, k) => (k === i ? { ...x, startsAt: e.target.value } : x)))} /><TextInput type="datetime-local" value={ev.endsAt} onChange={(e) => setEvents(events.map((x, k) => (k === i ? { ...x, endsAt: e.target.value } : x)))} /><Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Remove" onClick={() => setEvents(events.filter((_, k) => k !== i))} /></li>)}</ul>
          <Button size="sm" variant="outline" icon="ri-add-line" className="mt-2" onClick={() => setEvents([...events, { kind: "practical", title: "", startsAt: "", endsAt: "" }])}>Add session</Button></div>
        <Field label="Notes for students"><TextArea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {error ? <p className="text-sm text-primary-700" role="alert">{error}</p> : null}
      </div>
    </Drawer>
  );
}

export function AssignmentDrawer({ assignment: a, onClose, onChanged, onOpenAttempt }: { assignment: AssignmentRow; onClose: () => void; onChanged: () => void; onOpenAttempt: (id: string) => void }) {
  const { push } = useToast();
  const [students, setStudents] = useState<AssignmentStudent[] | null>(null);
  const [dueAt, setDueAt] = useState(toLocalInput(a.dueAt));
  const [lateUntil, setLateUntil] = useState(toLocalInput(a.lateUntil));
  const [status, setStatus] = useState(a.status);
  const [error, setError] = useState("");
  const load = () => asmAdmin<AssignmentStudent[]>("assignment_students", { id: a.id }).then(setStudents).catch((e) => setError(fail(e)));
  useEffect(() => { void load(); }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { try { await asmAdmin("assignment_update", { id: a.id, dueAt: fromLocalInput(dueAt), lateUntil: fromLocalInput(lateUntil), status }); push("Assignment saved."); onChanged(); } catch (e) { setError(fail(e)); } };
  const setStudent = async (studentId: string, data: Record<string, unknown>) => { try { await asmAdmin("assignment_student_set", { id: a.id, studentId, ...data }); await load(); onChanged(); } catch (e) { setError(fail(e)); } };
  return (
    <Drawer open title={`${a.assessmentTitle} · ${a.batchName}`} onClose={onClose} width="max-w-3xl" footer={<><Button variant="outline" onClick={onClose}>Close</Button><Button onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Due"><TextInput type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
          <Field label="Late until"><TextInput type="datetime-local" value={lateUntil} onChange={(e) => setLateUntil(e.target.value)} /></Field>
          <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value as AssignmentRow["status"])}><option value="open">Open</option><option value="closed">Closed</option><option value="cancelled">Cancelled</option></Select></Field>
        </div>
        <p className="text-xs text-foreground-600">Assessors: {a.trainers.map((t) => t.name).join(", ") || "none (add trainers to the batch)"}. Version {a.versionNo}.</p>
        {error ? <p className="text-sm text-primary-700" role="alert">{error}</p> : null}
        <div>
          <span className="mb-1.5 block text-label font-medium text-foreground-800">Students</span>
          {students === null ? <p className="text-sm text-foreground-600">Loading…</p> : students.length === 0 ? <p className="text-sm text-foreground-600">No active students in this batch.</p> : (
            <ul className="divide-y divide-background-100 rounded-md border border-background-200">{students.map((s) => (
              <li key={s.studentId} className={`px-3 py-2 text-sm ${s.excluded ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/admin/students/${s.studentId}`} className="min-w-0 flex-1 truncate font-medium text-foreground-900 hover:text-primary-700">{s.name}</Link>
                  <span className="text-xs text-foreground-600">due {fmtDateTime(s.dueAt)}</span>
                  {s.addedManually ? <Badge tone="accent">added</Badge> : null}
                  <Toggle label="Excluded" checked={s.excluded} onChange={(v) => void setStudent(s.studentId, { excluded: v })} />
                  <Button size="sm" variant="ghost" icon="ri-calendar-event-line" onClick={() => { const v = window.prompt("New due date/time for this student (YYYY-MM-DDTHH:MM, Melbourne):", toLocalInput(s.dueAt)); if (v !== null) void setStudent(s.studentId, { dueAt: fromLocalInput(v) }); }}>Extend</Button>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">{s.attempts.length === 0 ? <span className="text-xs text-foreground-500">Not started</span> : s.attempts.map((t) => <button key={t.id} type="button" className="rounded border border-background-300 px-2 py-0.5 text-xs text-foreground-800 hover:bg-background-100" onClick={() => onOpenAttempt(t.id)}>Attempt {t.attemptNo}: {STATE_LABEL[t.state] ?? t.state}{t.outcome ? ` · ${t.outcome}` : ""}</button>)}</div>
              </li>))}</ul>
          )}
        </div>
      </div>
    </Drawer>
  );
}
