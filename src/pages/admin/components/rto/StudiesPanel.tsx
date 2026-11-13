import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, Field, Select } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import { rto, shortDate, type EnrolmentType, type StudyOption, type StudyRow } from "@/pages/admin/lib/rto";

/** Student profile › Studies: the intakes and batches this student is in, and "Enrol" (course → intake → batch). */
export default function StudiesPanel({ studentId }: { studentId: string }) {
  const { push } = useToast();
  const [rows, setRows] = useState<StudyRow[] | null>(null);
  const [options, setOptions] = useState<StudyOption[]>([]);
  const [canEnrol, setCanEnrol] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ courseId: "", intakeId: "", batchId: "", type: "CoE" as EnrolmentType });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, me] = await Promise.all([rto<{ enrolments: StudyRow[]; options: StudyOption[] }>("student_studies", { studentId }), rto<{ rtoManager: boolean; admin: boolean }>("me")]);
      setRows(s.enrolments); setOptions(s.options); setCanEnrol(me.rtoManager || me.admin); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Studies did not load."); setRows([]); }
  }, [studentId]);
  useEffect(() => { void load(); }, [load]);

  const course = options.find((o) => o.courseId === form.courseId);
  const intake = course?.intakes.find((i) => i.id === form.intakeId);
  const enrol = async () => {
    setBusy(true);
    try { await rto("enrol", { batchId: form.batchId, students: [{ id: studentId, type: form.type }] }); push("Student enrolled."); setOpen(false); void load(); }
    catch (e) { push(e instanceof Error ? e.message : "Not enrolled.", "error"); }
    finally { setBusy(false); }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-heading text-base font-semibold text-foreground-950">Studies</h2>
        {canEnrol && options.length ? <Button size="sm" icon="ri-user-add-line" onClick={() => { setForm({ courseId: options[0].courseId, intakeId: "", batchId: "", type: "CoE" }); setOpen(true); }}>Enrol</Button> : null}
      </div>
      <ErrorNote text={error} />
      {rows === null ? <p className="text-sm text-foreground-500">Loading…</p> : rows.length === 0 ? (
        <p className="text-sm text-foreground-500">{options.length ? "Not in a batch yet." : "Studies appear once the student has an application for a course."}</p>
      ) : (
        <div className="divide-y divide-background-200">
          {rows.map((r) => (
            <div key={r.enrolmentId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <Link to={`/admin/intakes/${r.intakeId}?tab=students`} className="font-medium text-foreground-900 hover:text-primary-600">{r.intake}</Link>
                <p className="text-xs text-foreground-500">{r.courseCode} {r.course} · {shortDate(r.startDate)} – {shortDate(r.endDate)}</p>
              </div>
              <div className="flex items-center gap-2"><Badge tone="secondary">{r.batch}</Badge><Badge tone="accent">{r.type}</Badge><Badge tone={r.status === "active" ? "primary" : "muted"}>{r.status}</Badge></div>
            </div>
          ))}
        </div>
      )}
      <Drawer open={open} title="Enrol in a batch" onClose={() => setOpen(false)}
        footer={<><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy || !form.batchId} onClick={() => void enrol()}>{busy ? "Enrolling…" : "Enrol"}</Button></>}>
        <Field label="Course"><Select value={form.courseId} onChange={(e) => setForm((f) => ({ ...f, courseId: e.target.value, intakeId: "", batchId: "" }))}>
          {options.map((o) => <option key={o.courseId} value={o.courseId}>{o.courseCode} {o.course}{o.linked === false ? " — direct enrolment" : ""}</option>)}</Select></Field>
        {course?.linked === false ? <p className="text-xs text-foreground-500">The student has no application for this course; one is created, marked “direct enrolment”.</p> : null}
        <Field label="Intake"><Select value={form.intakeId} onChange={(e) => setForm((f) => ({ ...f, intakeId: e.target.value, batchId: "" }))}>
          <option value="">{course?.intakes.length ? "Choose an intake" : "No intakes for this course"}</option>
          {course?.intakes.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.status})</option>)}</Select></Field>
        <Field label="Batch"><Select value={form.batchId} disabled={!intake} onChange={(e) => setForm((f) => ({ ...f, batchId: e.target.value }))}>
          <option value="">{intake && !intake.batches.length ? "No batches in this intake" : "Choose a batch"}</option>
          {intake?.batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label="Enrolment type"><Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as EnrolmentType }))}>
          <option value="CoE">CoE</option><option value="VoE">VoE</option><option value="Domestic">Domestic</option></Select></Field>
      </Drawer>
    </Card>
  );
}
