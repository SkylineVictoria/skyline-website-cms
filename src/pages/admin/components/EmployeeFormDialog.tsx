import { useState, type FormEvent } from "react";
import { Button, Field, Modal, TextInput } from "@/pages/admin/components/ui";
import { EMPTY_EMPLOYEE, employeeProblems, saveEmployee, type EmployeeForm } from "@/lib/employeesApi";

type Problems = Partial<Record<keyof EmployeeForm, string>>;

/** Add an employee (Active at once) or edit their name, email and mobile. Checked here and again by the database. */
export default function EmployeeFormDialog({ id, initial, onClose, onSaved }: {
  id?: string; initial?: EmployeeForm; onClose: () => void; onSaved: (id: string) => void;
}) {
  const [form, setForm] = useState<EmployeeForm>(initial ?? EMPTY_EMPLOYEE);
  const [problems, setProblems] = useState<Problems>({});
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (next: Partial<EmployeeForm>) => {
    const value = { ...form, ...next };
    setForm(value);
    if (touched) setProblems(employeeProblems(value));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found = employeeProblems(form);
    setTouched(true); setProblems(found); setError("");
    if (Object.keys(found).length) return;
    setBusy(true);
    try { onSaved(await saveEmployee(id ?? null, form)); }
    catch (err) { setError(err instanceof Error ? err.message : "The employee could not be saved."); }
    finally { setBusy(false); }
  };

  const field = (key: keyof EmployeeForm, label: string, props: Record<string, unknown>) => (
    <div>
      <Field label={label} required>
        <TextInput value={form[key]} onChange={(e) => patch({ [key]: e.target.value })} aria-invalid={Boolean(problems[key])} data-testid={`employee-${key}`} {...props} />
      </Field>
      {problems[key] ? <p role="alert" className="mt-1 text-xs text-primary-700">{problems[key]}</p> : null}
    </div>
  );

  return (
    <Modal open title={id ? "Edit employee" : "Add employee"} onClose={() => { if (!busy) onClose(); }}
      footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" form="employee-form" disabled={busy} data-testid="employee-save">{busy ? "Saving…" : id ? "Save" : "Add employee"}</Button></>}>
      <form id="employee-form" noValidate className="space-y-3" onSubmit={(e) => void submit(e)}>
        {!id ? <p className="text-sm text-foreground-700">They are added as Active straight away. You can upload their documents on the next screen.</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {field("firstName", "First name", { maxLength: 100, autoComplete: "off", autoFocus: true })}
          {field("lastName", "Last name", { maxLength: 100, autoComplete: "off" })}
        </div>
        {field("email", "Email", { type: "email", maxLength: 254, autoComplete: "off", inputMode: "email" })}
        {field("phone", "Mobile", { type: "tel", maxLength: 20, autoComplete: "off", inputMode: "tel", placeholder: "0412 345 678" })}
        {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      </form>
    </Modal>
  );
}
