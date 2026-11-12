import { useCallback, useEffect, useState } from "react";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import { listCourseIntakes, type CourseIntake } from "@/pages/admin/lib/courseIntakes";

interface FeeRow { id: string; intakeId: string | null; tuition: number | null; enrolment: number | null; material: number | null; oshc: number | null; deposit: number | null; paymentPlan: string | null; campus: string | null; orientation: string | null; hoursPerWeek: string | null }
const MONEY = [["tuition", "Tuition fee"], ["enrolment", "Enrolment fee"], ["material", "Material fee"], ["oshc", "OSHC"], ["deposit", "Initial deposit"]] as const;
type Form = Record<(typeof MONEY)[number][0] | "paymentPlan" | "campus" | "orientation" | "hoursPerWeek", string>;
const blank: Form = { tuition: "", enrolment: "", material: "", oshc: "", deposit: "", paymentPlan: "", campus: "", orientation: "", hoursPerWeek: "" };
const aud = (n: number | null) => (n === null ? "—" : `AUD$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/**
 * Fees of a course (the offer letter's Fees variables): one set for every intake, and optionally one per intake that overrides it
 * field by field. Amounts are typed as numbers and print as AUD$14,500.00.
 */
export default function CourseFees({ courseId }: { courseId: string }) {
  const [rows, setRows] = useState<FeeRow[] | null>(null);
  const [intakes, setIntakes] = useState<CourseIntake[]>([]);
  const [target, setTarget] = useState<string>("");
  const [form, setForm] = useState<Form>(blank);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc("cms_course_fees", { p_course: courseId });
    if (e) { setError(e.message); setRows([]); return; }
    setRows(data as FeeRow[]);
  }, [courseId]);
  useEffect(() => { void load(); void listCourseIntakes(courseId).then(setIntakes, () => setIntakes([])); }, [courseId, load]);
  useEffect(() => {
    const row = rows?.find((r) => (r.intakeId ?? "") === target);
    setForm(row ? { tuition: row.tuition?.toString() ?? "", enrolment: row.enrolment?.toString() ?? "", material: row.material?.toString() ?? "", oshc: row.oshc?.toString() ?? "",
      deposit: row.deposit?.toString() ?? "", paymentPlan: row.paymentPlan ?? "", campus: row.campus ?? "", orientation: row.orientation ?? "", hoursPerWeek: row.hoursPerWeek ?? "" } : blank);
  }, [rows, target]);

  const save = async () => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    const { error: e } = await supabase.rpc("cms_course_fee_save", { p_course: courseId, p_intake: target || null, p_data: form });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setNotice(target ? "The intake's fees were saved." : "The course's fees were saved.");
    void load();
  };
  const intakeName = (id: string | null) => (id ? intakes.find((i) => i.id === id)?.display ?? "An intake" : "Every intake");

  return (
    <section className="space-y-3" data-testid="course-fees">
      <div>
        <h3 className="text-base font-semibold text-foreground-900">Fees</h3>
        <p className="text-sm text-foreground-600">What offer letters print for this course. Fees for one intake override the course's fees for that intake.</p>
      </div>
      {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-emerald-800">{notice}</p> : null}
      {rows?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-background-300 text-left text-xs uppercase tracking-wide text-foreground-500"><th className="py-1.5 pr-3">For</th>{MONEY.map(([, label]) => <th key={label} className="py-1.5 pr-3">{label}</th>)}<th className="py-1.5">Campus</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-b border-background-200" data-testid="fee-row">
                <td className="py-1.5 pr-3 font-medium">{intakeName(r.intakeId)}</td>
                {MONEY.map(([key]) => <td key={key} className="py-1.5 pr-3">{aud(r[key])}</td>)}
                <td className="py-1.5">{r.campus || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : rows ? <p className="text-sm text-foreground-600">No fees yet: offer letters ask for them when they are issued.</p> : null}
      <div className="space-y-3 rounded-md border border-background-300 p-3">
        <Field label="Fees for">
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="h-10 w-full rounded-md border border-background-300 bg-background-50 px-3 text-sm" data-testid="fee-target">
            <option value="">Every intake (the course's fees)</option>
            {intakes.map((i) => <option key={i.id} value={i.id}>{i.display}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {MONEY.map(([key, label]) => (
            <Field key={key} label={`${label} (AUD)`}><TextInput inputMode="decimal" value={form[key]} placeholder="e.g. 14500.00" onChange={(e) => setForm({ ...form, [key]: e.target.value })} data-testid={`fee-${key}`} /></Field>
          ))}
          <Field label="Campus" hint="Empty: the head office address"><TextInput value={form.campus} maxLength={300} onChange={(e) => setForm({ ...form, campus: e.target.value })} data-testid="fee-campus" /></Field>
          <Field label="Orientation day"><TextInput value={form.orientation} maxLength={200} placeholder="e.g. 02/02/2027, 9:30 am" onChange={(e) => setForm({ ...form, orientation: e.target.value })} data-testid="fee-orientation" /></Field>
          <Field label="Hours per week"><TextInput value={form.hoursPerWeek} maxLength={20} placeholder="e.g. 20" onChange={(e) => setForm({ ...form, hoursPerWeek: e.target.value })} data-testid="fee-hours" /></Field>
        </div>
        <Field label="Payment plan" hint="Printed as written, line by line">
          <textarea rows={3} maxLength={2000} value={form.paymentPlan} onChange={(e) => setForm({ ...form, paymentPlan: e.target.value })} className="w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm" />
        </Field>
        <Button disabled={busy} onClick={() => void save()} data-testid="fee-save">{busy ? "Saving…" : "Save fees"}</Button>
      </div>
    </section>
  );
}
