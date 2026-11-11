import { useCallback, useEffect, useState } from "react";
import { Button, Field, TextInput, Toggle } from "@/pages/admin/components/ui";
import { deleteCourseIntake, listCourseIntakes, saveCourseIntake, type CourseIntake } from "@/pages/admin/lib/courseIntakes";

const empty = { startDate: "", endDate: "", label: "" };

/**
 * Intakes of one course (INT-01). The enrolment form offers the active intakes that start today or later; staff add, relabel,
 * deactivate or delete them here. An intake already chosen on an application keeps its start date (deactivate it and add a new one).
 */
export default function CourseIntakes({ courseId }: { courseId: string }) {
  const [rows, setRows] = useState<CourseIntake[] | null>(null);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => listCourseIntakes(courseId).then(setRows).catch((e: Error) => { setRows([]); setError(e.message); }), [courseId]);
  useEffect(() => { void load(); }, [load]);
  const run = async (work: () => Promise<CourseIntake[]>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { setRows(await work()); return true; } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); return false; } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!form.startDate) { setError("Enter the start date."); return; }
    const ok = await run(() => saveCourseIntake(courseId, editing, { startDate: form.startDate, endDate: form.endDate || undefined, label: form.label.trim() || undefined }));
    if (ok) { setForm(empty); setEditing(null); }
  };

  return (
    <section className="space-y-4" data-testid="course-intakes">
      <div>
        <h3 className="text-base font-semibold text-foreground-900">Intakes</h3>
        <p className="text-sm text-foreground-600">The enrolment form lists the active intakes of this course that start today or later, earliest first. Without one, students cannot submit an application for this course.</p>
      </div>
      {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      <div className="grid grid-cols-1 gap-3 rounded-md border border-background-300 p-3 md:grid-cols-[repeat(3,minmax(0,1fr))_auto] md:items-end">
        <Field label="Start date" required><TextInput type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} data-testid="intake-start" /></Field>
        <Field label="End date" hint="Optional"><TextInput type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} data-testid="intake-end" /></Field>
        <Field label="Label" hint="Optional. Without one the month and year are shown."><TextInput value={form.label} maxLength={80} onChange={(e) => setForm({ ...form, label: e.target.value })} data-testid="intake-label" /></Field>
        <div className="flex gap-2 pb-0.5">
          <Button disabled={busy} onClick={() => void submit()} data-testid="intake-save">{editing ? "Save intake" : "Add intake"}</Button>
          {editing ? <Button variant="outline" disabled={busy} onClick={() => { setEditing(null); setForm(empty); }}>Cancel</Button> : null}
        </div>
      </div>
      {rows === null ? <p className="text-sm text-foreground-600">Loading intakes…</p> : rows.length === 0 ? <p className="text-sm text-foreground-600" data-testid="intakes-empty">No intakes yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-background-300 text-left text-xs uppercase tracking-wide text-foreground-500"><th className="py-2 pr-3">Intake</th><th className="py-2 pr-3">Ends</th><th className="py-2 pr-3">Shown on the form</th><th className="py-2 pr-3">Applications</th><th className="py-2 pr-3">Active</th><th className="py-2" /></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-background-200" data-testid="intake-row">
                  <td className="py-2 pr-3 font-medium">{row.display}</td>
                  <td className="py-2 pr-3">{row.endDate ?? "—"}</td>
                  <td className="py-2 pr-3">{row.open ? "Yes" : row.isActive ? "No (already started)" : "No (inactive)"}</td>
                  <td className="py-2 pr-3">{row.applications}</td>
                  <td className="py-2 pr-3"><Toggle checked={row.isActive} disabled={busy} label={`Active: ${row.display}`} onChange={(v) => void run(() => saveCourseIntake(courseId, row.id, { startDate: row.startDate, endDate: row.endDate ?? undefined, label: row.label || undefined, isActive: v }))} /></td>
                  <td className="whitespace-nowrap py-2 text-right">
                    <button type="button" className="mr-3 text-primary-700 underline" disabled={busy} onClick={() => { setEditing(row.id); setForm({ startDate: row.startDate, endDate: row.endDate ?? "", label: row.label }); }}>Edit</button>
                    <button type="button" className="text-red-700 underline disabled:opacity-40" disabled={busy || row.applications > 0} title={row.applications > 0 ? "Chosen on applications: deactivate it instead" : undefined}
                      onClick={() => { if (window.confirm(`Delete the intake ${row.display}?`)) void run(() => deleteCourseIntake(courseId, row.id)); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
