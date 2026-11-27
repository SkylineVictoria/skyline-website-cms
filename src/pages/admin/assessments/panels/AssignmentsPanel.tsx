import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Field, Select, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { Drawer } from "@/pages/admin/components/rto/shared";
import { Empty } from "@/pages/admin/components/rto/overlay";
import { useToast } from "@/pages/admin/components/toastContext";
import { fmtDateTime, fromLocalInput, STATE_LABEL, toLocalInput } from "@/lib/assessment/api";
import { ruleNumber } from "@/lib/businessRules";
import { supabase } from "@/pages/admin/lib/supabase";

/** LMS-BATCHES (2026-11-25): an assignment's window comes from the intake's Master unit dates (CoE / VoE), not class sessions. */
type MasterWindow = { intake_unit_id: string; opens_at: string; closes_at: string; master_kind: string | null; master_cycle: number | null; start_date: string; end_date: string };
async function masterWindow(assessmentId: string, intakeId: string): Promise<MasterWindow | null> {
  const { data, error } = await supabase.rpc("asm_master_window", { p_assessment: assessmentId, p_intake: intakeId });
  if (error) return null;
  return ((data as MasterWindow[] | null) ?? [])[0] ?? null;
}
/**
 * ASM-DATES (owner 2026-11-27): when late work is allowed for the assessment, an assignment needs "Late until" (the last moment late
 * work is accepted); the database refuses an assignment without it (asm_assignments_late_until). null while asking.
 */
function useLateAllowed(assessmentId: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let off = false;
    // rule-policy: technical asm-late-setting-read Reads the existing late_submission setting (allow / block, block when none); the owner's rule adds no new value.
    void supabase.rpc("asm_late_allowed", { p_assessment: assessmentId }).then(({ data, error }) => { if (!off) setAllowed(error ? false : data === true); });
    return () => { off = true; };
  }, [assessmentId]);
  return allowed;
}
// rule-policy: technical asm-late-setting-read Reads the existing late_submission setting (allow / block, block when none); the owner's rule adds no new value.
const lateHint = (allowed: boolean | null) => (allowed ? "Late work is allowed for this assessment: the last moment it is accepted, after the due date." : "Optional: late work is accepted until then.");

const windowText = (w: MasterWindow | null | undefined) => (w ? `${fmtDateTime(w.opens_at)} – ${fmtDateTime(w.closes_at)} (${(w.master_kind ?? "coe").toUpperCase()} Master${w.master_cycle ? `, cycle ${w.master_cycle}` : ""})` : "No Master dates for this unit in the intake");
import { asmAdmin, type AssignmentRow, type AssignmentStudent, type BatchOption, type StaffOption } from "@/pages/admin/lib/assessments";

const fail = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Assignments of one assessment: intakes, dates, trainers, practical sessions, and the students with their attempts. */
export default function AssignmentsPanel({ assessmentId, courseId, assignments, canAssign, onChanged, onOpenAttempt }: {
  assessmentId: string; courseId: string; assignments: AssignmentRow[]; canAssign: boolean; onChanged: () => void; onOpenAttempt: (attemptId: string) => void;
}) {
  const { push } = useToast();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<AssignmentRow | null>(null);
  return (
    <div className="space-y-3">
      <section className="overflow-hidden rounded-xl border border-background-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-background-200 bg-background-50 px-4 py-2.5">
          <p className="text-sm font-semibold text-foreground-900">Assignments <span className="font-normal text-foreground-500">· students come from the intake's enrolments, assessors from its trainers</span></p>
          <Button size="sm" icon="ri-send-plane-line" disabled={!canAssign} title={canAssign ? "" : "Publish a version first"} onClick={() => setCreating(true)}>Assign to intakes</Button>
        </div>
        {assignments.length === 0 ? <div className="p-4"><Empty icon="ri-group-line" title="Not assigned yet" text="Once published, assign the assessment to one or more intakes with a due date." /></div> : (
          <ul className="divide-y divide-background-100" data-testid="assignments-list">{assignments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm hover:bg-background-50">
              <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left" onClick={() => setOpen(a)}>
                <span className="min-w-0 flex-1 truncate font-semibold text-foreground-900">{a.intake || a.batchName}</span>
                <span className="hidden shrink-0 text-xs text-foreground-600 sm:inline">v{a.versionNo} · due {fmtDateTime(a.dueAt)}{a.lateUntil ? ` · late until ${fmtDateTime(a.lateUntil)}` : ""}</span>
                <span className="shrink-0 text-xs text-foreground-600">{a.eligibleCount} student{a.eligibleCount === 1 ? "" : "s"}</span>
              </button>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold ${a.status === "open" ? "bg-green-100 text-green-900" : a.status === "cancelled" ? "bg-amber-100 text-amber-900" : "bg-background-100 text-foreground-600"}`}>{a.status === "open" ? "Open" : a.status === "cancelled" ? "Cancelled" : "Closed"}</span>
              <Link to={`/admin/lms/intakes#${a.intakeId || a.batchId}`} className="shrink-0 text-xs font-semibold text-primary-700 hover:underline">Intake page</Link>
            </li>))}</ul>
        )}
      </section>
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
  const [dueAt, setDueAt] = useState(toLocalInput(new Date(Date.now() + ruleNumber("lms.assessment_assignment_default_days", 7) * 86400000).toISOString()));
  const [lateUntil, setLateUntil] = useState("");
  const lateAllowed = useLateAllowed(assessmentId);
  // rule-policy: technical asm-late-setting-read Reads the existing late_submission setting (allow / block, block when none); the owner's rule adds no new value.
  const lateMissing = lateAllowed === true && !lateUntil;
  const [rule, setRule] = useState<"follow_master" | "keep">("follow_master");
  const [useMaster, setUseMaster] = useState(true);
  const [windows, setWindows] = useState<Record<string, MasterWindow | null>>({});
  const [notes, setNotes] = useState("");
  const [events, setEvents] = useState<{ kind: string; title: string; startsAt: string; endsAt: string }[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { void asmAdmin<BatchOption[]>("batch_list", { courseId }).then(setBatches).catch(() => setBatches([])); void asmAdmin<StaffOption[]>("staff_list").then(setStaff).catch(() => setStaff([])); }, [courseId]);
  useEffect(() => {
    for (const id of picked) if (!(id in windows)) void masterWindow(assessmentId, batches.find((b) => b.id === id)?.intakeId ?? id).then((w) => setWindows((x) => ({ ...x, [id]: w })));
  }, [picked, assessmentId, batches, windows]);
  const missingMaster = useMaster && picked.some((id) => windows[id] === null);
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const out = await asmAdmin<{ ok: boolean; created: number; errors: { message: string }[] }>("assignment_create", { assessmentId, batchIds: picked, availableFrom: useMaster ? undefined : fromLocalInput(availableFrom), dueAt: useMaster ? undefined : fromLocalInput(dueAt), lateUntil: fromLocalInput(lateUntil), trainerStaffIds: trainers, reassignRule: rule, notes, events: events.filter((e) => e.startsAt).map((e) => ({ ...e, startsAt: fromLocalInput(e.startsAt), endsAt: fromLocalInput(e.endsAt) })) });
      if (out.errors?.length) setError(out.errors.map((e) => e.message).join(" "));
      if (out.created > 0) onDone();
    } catch (e) { setError(fail(e)); } finally { setBusy(false); }
  };
  // rule-policy: technical asm-late-setting-read Reads the existing late_submission setting (allow / block, block when none); the owner's rule adds no new value.
  return (
    <Drawer open title="Assign to intakes" onClose={onClose} width="max-w-2xl" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !picked.length || (!useMaster && !dueAt) || missingMaster || lateMissing} onClick={() => void submit()}>Assign</Button></>}>
      <div className="space-y-4">
        <div><span className="mb-1.5 block text-label font-medium text-foreground-800">Intakes on this course</span>
          {batches.length === 0 ? <p className="text-sm text-foreground-600">No intakes on this course yet (Courses › Intakes).</p> : <ul className="grid gap-1 sm:grid-cols-2">{batches.map((b) => <li key={b.id}><label className="flex cursor-pointer items-center gap-2 rounded-lg border border-background-200 bg-white px-2.5 py-1.5 text-sm hover:border-primary-300"><input type="checkbox" checked={picked.includes(b.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, b.id] : picked.filter((x) => x !== b.id))} /><span className="min-w-0 flex-1 truncate">{b.name}</span><span className="text-xs text-foreground-500">{b.students}</span></label></li>)}</ul>}</div>
        <div className="rounded-xl border border-background-200 bg-white p-3" data-testid="assignment-master-window">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground-900"><input type="checkbox" checked={useMaster} onChange={(e) => setUseMaster(e.target.checked)} /> Use the Master unit dates (opens on the unit's start, due at the end of its last day)</label>
          {picked.length ? <ul className="mt-2 space-y-0.5 text-xs text-foreground-700">{picked.map((id) => <li key={id}><span className="font-medium">{batches.find((b) => b.id === id)?.name ?? "Intake"}:</span> {id in windows ? windowText(windows[id]) : "Loading…"}</li>)}</ul> : <p className="mt-1 text-xs text-foreground-600">Pick intakes to see their Master window.</p>}
          {missingMaster ? <p className="mt-1 text-xs text-red-700">An intake has no Master dates for this unit: untick to type the dates.</p> : null}
        </div>
        {useMaster ? null : <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Available from"><TextInput type="datetime-local" value={availableFrom} onChange={(e) => setAvailableFrom(e.target.value)} /></Field>
          <Field label="Due" required><TextInput type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
        </div>}
        {/* // rule-policy: technical asm-late-setting-read Reads the existing late_submission setting (allow / block, block when none); the owner's rule adds no new value. */}
        <Field label="Late submissions until" required={lateAllowed === true} hint={lateHint(lateAllowed)}><TextInput type="datetime-local" value={lateUntil} onChange={(e) => setLateUntil(e.target.value)} data-testid="assignment-late-until" /></Field>
        <Field label="Extra assessors (the intake's trainers are always assessors)"><Select multiple size={4} value={trainers} onChange={(e) => setTrainers([...e.target.selectedOptions].map((o) => o.value))}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.isTrainer ? "" : " (no trainer role)"}</option>)}</Select></Field>
        <Field label="When a student leaves or joins the intake"><Select value={rule} onChange={(e) => setRule(e.target.value as "follow_master" | "keep")}><option value="follow_master">Follow the Master: dates move with the Master unit dates; leavers lose open drafts, joiners are added and told</option><option value="keep">Keep: existing attempts stay as they are</option></Select></Field>
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
  const lateAllowed = useLateAllowed(a.assessmentId);
  const [status, setStatus] = useState(a.status);
  const [error, setError] = useState("");
  const [win, setWin] = useState<MasterWindow | null | undefined>(undefined);
  useEffect(() => { void masterWindow(a.assessmentId, a.intakeId).then(setWin); }, [a.assessmentId, a.intakeId]);
  const load = () => asmAdmin<AssignmentStudent[]>("assignment_students", { id: a.id }).then(setStudents).catch((e) => setError(fail(e)));
  useEffect(() => { void load(); }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { try { await asmAdmin("assignment_update", { id: a.id, dueAt: fromLocalInput(dueAt), lateUntil: fromLocalInput(lateUntil), status }); push("Assignment saved."); onChanged(); } catch (e) { setError(fail(e)); } };
  const setStudent = async (studentId: string, data: Record<string, unknown>) => { try { await asmAdmin("assignment_student_set", { id: a.id, studentId, ...data }); await load(); onChanged(); } catch (e) { setError(fail(e)); } };
  // rule-policy: technical asm-late-setting-read Reads the existing late_submission setting (allow / block, block when none); the owner's rule adds no new value.
  return (
    <Drawer open title={`${a.assessmentTitle} · ${a.intake || a.batchName}`} onClose={onClose} width="max-w-3xl" footer={<><Button variant="outline" onClick={onClose}>Close</Button><Button disabled={lateAllowed === true && !lateUntil} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Due"><TextInput type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
          {/* // rule-policy: technical asm-late-setting-read Reads the existing late_submission setting (allow / block, block when none); the owner's rule adds no new value. */}
          <Field label="Late until" required={lateAllowed === true} hint={lateHint(lateAllowed)}><TextInput type="datetime-local" value={lateUntil} onChange={(e) => setLateUntil(e.target.value)} data-testid="assignment-late-until" /></Field>
          <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value as AssignmentRow["status"])}><option value="open">Open</option><option value="closed">Closed</option><option value="cancelled">Cancelled</option></Select></Field>
        </div>
        <p className="text-xs text-foreground-700" data-testid="assignment-master-line">Master window: {win === undefined ? "Loading…" : windowText(win)}{a.reassignRule === "follow_master" ? " · follows the Master" : " · kept as set"}</p>
        <p className="text-xs text-foreground-600">Assessors: {a.trainers.map((t) => t.name).join(", ") || "none (add trainers to the intake's class setup)"}. Version {a.versionNo}.</p>
        {error ? <p className="text-sm text-primary-700" role="alert">{error}</p> : null}
        <div>
          <span className="mb-1.5 block text-label font-medium text-foreground-800">Students</span>
          {students === null ? <p className="text-sm text-foreground-600">Loading…</p> : students.length === 0 ? <p className="text-sm text-foreground-600">No active students in this intake.</p> : (
            <ul className="divide-y divide-background-100 overflow-hidden rounded-xl border border-background-200 bg-white">{students.map((s) => (
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
