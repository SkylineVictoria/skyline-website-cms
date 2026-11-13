import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import { rto, type IntakeDetail, type IntakeStatus } from "@/pages/admin/lib/rto";

/** Pick a course and a start date; "Generate schedule" lays the course's active units out and sets the end date. */
export default function NewIntakeDrawer({ open, onClose, courses, courseId }: {
  open: boolean; onClose: () => void; courses: { id: string; label: string; campus?: string | null }[]; courseId?: string;
}) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ courseId: courseId ?? "", startDate: "", campus: "", capacity: "", status: "draft" as IntakeStatus, name: "", generate: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const chosen = form.courseId || courseId || "";

  const save = async () => {
    if (!chosen || !form.startDate) { setError("Choose a course and a start date."); return; }
    setBusy(true); setError("");
    try {
      const out = await rto<IntakeDetail>("intake_save", { courseId: chosen, startDate: form.startDate, campus: form.campus, capacity: form.capacity, status: form.status, name: form.name, generate: form.generate });
      onClose();
      navigate(`/admin/intakes/${out.intake.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "The intake was not created."); }
    finally { setBusy(false); }
  };

  return (
    <Drawer open={open} title="New intake" onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy ? "Creating…" : form.generate ? "Create & generate schedule" : "Create intake"}</Button></>}>
      <ErrorNote text={error} />
      {courseId ? null : (
        <Field label="Course" required>
          <Select value={form.courseId} onChange={(e) => set({ courseId: e.target.value, campus: courses.find((c) => c.id === e.target.value)?.campus ?? form.campus })}>
            <option value="">Choose a course</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Start date" required><TextInput type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Campus / delivery location"><TextInput value={form.campus} onChange={(e) => set({ campus: e.target.value })} /></Field>
        <Field label="Capacity"><TextInput inputMode="numeric" value={form.capacity} onChange={(e) => set({ capacity: e.target.value.replace(/\D/g, "") })} /></Field>
      </div>
      <Field label="Status" hint="Only Open intakes are offered on the website and the enrolment form.">
        <Select value={form.status} onChange={(e) => set({ status: e.target.value as IntakeStatus })}>
          <option value="draft">Draft</option><option value="open">Open</option><option value="full">Full</option><option value="closed">Closed</option>
        </Select>
      </Field>
      <Field label="Name" hint="Leave blank for the automatic name, e.g. “BSB50120 Feb 2027 – Nov 2027”."><TextInput value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      <div className="rounded-md bg-background-100 p-3">
        <Toggle checked={form.generate} onChange={(v) => set({ generate: v })} label="Generate schedule" />
        <p className="mt-1 text-xs text-foreground-500">Active units in course order, each for its default weeks of working days, skipping confirmed public holidays. The end date follows the last unit.</p>
      </div>
    </Drawer>
  );
}
