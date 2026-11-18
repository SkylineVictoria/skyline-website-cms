// Staff override of the automatic placement. Students are placed automatically when their offer is accepted; an Admin or RTO Manager can still place a
// student by hand, move one to another intake, or remove one, always with a reason that is kept on the record.
import { useEffect, useState } from "react";
import { Button, Field, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import { supabase } from "@/pages/admin/lib/supabase";
import { rto, todayIso, type EnrolmentType, type StudentOption } from "@/pages/admin/lib/rto";

interface BatchOption { id: string; name: string; full?: boolean }

/** Place a student in a chosen intake on a chosen day (override). `batches` = the intake(s) to choose from (their class group ids). */
export function PlaceByHandDrawer({ open, courseId, batches, batchId, intakeStart, intakeEnd, onClose, onDone }: {
  open: boolean; courseId: string; batches: BatchOption[]; batchId?: string; intakeStart: string; intakeEnd: string | null; onClose: () => void; onDone: (message: string) => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<StudentOption[]>([]);
  const [student, setStudent] = useState<StudentOption | null>(null);
  const firstOpen = () => batchId ?? (batches.find((x) => !x.full) ?? batches[0])?.id ?? "";
  const [batch, setBatch] = useState(firstOpen());
  const [type, setType] = useState<EnrolmentType>("CoE");
  const [on, setOn] = useState(todayIso() < intakeStart ? intakeStart : todayIso());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setBatch(firstOpen()); setStudent(null); setQ(""); setReason(""); setError(""); } }, [open, batchId, batches]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = window.setTimeout(() => { rto<StudentOption[]>("student_search", { courseId, q, all: true }).then((l) => { if (live) setFound(l); }).catch(() => undefined); }, 200);
    return () => { live = false; window.clearTimeout(t); };
  }, [open, courseId, q]);
  const submit = async () => {
    if (!student) return;
    setBusy(true); setError("");
    const { error: e } = await supabase.rpc("rto_staff_place", { p_batch: batch, p_student: student.id, p_type: type, p_on: on, p_reason: reason });
    setBusy(false);
    if (e) { setError(e.message); return; }
    onDone(`${student.name} placed by hand.`);
  };
  return (
    <Drawer open={open} title="Place a student by hand" onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !student || !batch || !reason.trim()} onClick={() => void submit()}>{busy ? "Placing…" : "Place student"}</Button></>}>
      <p className="mb-3 rounded-md bg-background-100 px-3 py-2 text-sm text-foreground-700">Students are placed automatically when their offer is accepted. Use this only to override that. The reason is kept on the record.</p>
      <ErrorNote text={error} />
      <Field label="Student" required>
        {student ? (
          <p className="flex items-center justify-between rounded-md border border-background-300 px-3 py-2 text-sm"><span>{student.name} <span className="text-foreground-500">{student.email}</span></span>
            <button type="button" className="text-xs font-medium text-primary-700 hover:underline" onClick={() => setStudent(null)}>Change</button></p>
        ) : (
          <div>
            <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email" />
            <ul className="mt-1 max-h-48 overflow-auto rounded-md border border-background-200">
              {found.length === 0 ? <li className="px-3 py-2 text-sm text-foreground-500">No students found.</li> : found.slice(0, 30).map((s) => (
                <li key={s.id}><button type="button" className="block w-full px-3 py-1.5 text-left text-sm hover:bg-background-100" onClick={() => setStudent(s)}>{s.name} <span className="text-foreground-500">{s.email}</span></button></li>
              ))}
            </ul>
          </div>
        )}
      </Field>
      {batches.length > 1 ? <Field label="Intake" required><Select value={batch} onChange={(e) => setBatch(e.target.value)}>{batches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.full ? " (full)" : ""}</option>)}</Select></Field>
        : batches[0]?.full ? <p className="text-sm text-amber-800">This intake is full.</p> : null}
      <Field label="How they study"><Select value={type} onChange={(e) => setType(e.target.value as EnrolmentType)}><option value="CoE">CoE</option><option value="VoE">VoE</option><option value="Domestic">Domestic</option></Select></Field>
      <Field label="Joins on" hint="Between the intake's first and last day."><TextInput type="date" value={on} min={intakeStart} max={intakeEnd ?? undefined} onChange={(e) => setOn(e.target.value)} /></Field>
      <Field label="Reason" required><TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this student placed by hand?" /></Field>
    </Drawer>
  );
}

/** Move or remove one student (override). */
export function OverrideStudentDrawer({ open, mode, enrolmentId, studentName, batches, currentBatchId, onClose, onDone }: {
  open: boolean; mode: "move" | "remove"; enrolmentId: string; studentName: string; batches: BatchOption[]; currentBatchId: string; onClose: () => void; onDone: (message: string) => void;
}) {
  const others = batches.filter((b) => b.id !== currentBatchId);
  const [to, setTo] = useState(others[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setTo(others[0]?.id ?? ""); setReason(""); setError(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    setBusy(true); setError("");
    const { error: e } = mode === "move"
      ? await supabase.rpc("rto_staff_move", { p_enrolment: enrolmentId, p_to_batch: to, p_reason: reason })
      : await supabase.rpc("rto_staff_remove", { p_enrolment: enrolmentId, p_reason: reason });
    setBusy(false);
    if (e) { setError(e.message); return; }
    onDone(mode === "move" ? `${studentName} moved.` : `${studentName} removed from the intake.`);
  };
  return (
    <Drawer open={open} title={mode === "move" ? `Move ${studentName}` : `Remove ${studentName}`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !reason.trim() || (mode === "move" && !to)} onClick={() => void submit()}>{busy ? "Saving…" : mode === "move" ? "Move student" : "Remove student"}</Button></>}>
      <p className="mb-3 rounded-md bg-background-100 px-3 py-2 text-sm text-foreground-700">{mode === "move" ? "Overrides the automatic placement." : "The automation will not place this student in this course again."} The reason is kept on the record.</p>
      <ErrorNote text={error} />
      {mode === "move" ? <Field label="Move to" required><Select value={to} onChange={(e) => setTo(e.target.value)}>{others.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field> : null}
      <Field label="Reason" required><TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why?" /></Field>
    </Drawer>
  );
}
