import { useEffect, useState, type FormEvent } from "react";
import { Button, Field, Modal, TextInput } from "@/pages/admin/components/ui";
import { PhoneInput } from "@/components/feature/applicationInputs";
import BankDetailsFields from "@/pages/admin/components/hrms/BankDetailsFields";
import {
  EMPTY_BANK, EMPTY_EMPLOYEE, bankIsEmpty, bankProblems, employeeProblems, getEmployeeBank, saveEmployee, saveEmployeeBank,
  type EmployeeBank, type EmployeeForm,
} from "@/lib/employeesApi";
import { staffAdminActions } from "@/lib/staffApi";
import { toE164 } from "@/lib/staffPhone";

type Problems = Partial<Record<keyof EmployeeForm, string>>;
type BankProblems = Partial<Record<keyof EmployeeBank, string>>;
/** "active": added as Active at once (documents uploaded by an Admin). "onboard": HR-02 onboarding, the person gets a private link
 *  to add their details and documents; then the offer letter is sent and signed, and the account is activated (employee page). */
type Mode = "active" | "onboard";
export interface EmployeeSaved { id: string; mode: Mode; message: string }

/**
 * Add an employee or edit their name, email, mobile and bank details. Checked here and again by the database.
 * Adding offers two ways: Active straight away, or Start onboarding (document link by email, then the offer letter).
 */
export default function EmployeeFormDialog({ id, initial, onClose, onSaved }: {
  id?: string; initial?: EmployeeForm; onClose: () => void; onSaved: (id: string, result?: EmployeeSaved) => void;
}) {
  const [form, setForm] = useState<EmployeeForm>(initial ?? EMPTY_EMPLOYEE);
  const [mode, setMode] = useState<Mode>("onboard");
  const [bank, setBank] = useState<EmployeeBank>(EMPTY_BANK);
  const [bankLoaded, setBankLoaded] = useState(!id);
  const [problems, setProblems] = useState<Problems>({});
  const [bankIssues, setBankIssues] = useState<BankProblems>({});
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Once the person is saved, a retry (e.g. after a bank details error) edits them instead of adding them twice.
  const [savedId, setSavedId] = useState<string | null>(id ?? null);

  useEffect(() => {
    if (!id) return;
    let current = true;
    void getEmployeeBank(id).then((b) => { if (current) { setBank(b ?? EMPTY_BANK); setBankLoaded(true); } },
      () => { if (current) setBankLoaded(true); });
    return () => { current = false; };
  }, [id]);

  const patch = (next: Partial<EmployeeForm>) => {
    const value = { ...form, ...next };
    setForm(value);
    if (touched) setProblems(employeeProblems(value));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found = employeeProblems(form);
    const foundBank = bankProblems(bank);
    setTouched(true); setProblems(found); setBankIssues(foundBank); setError("");
    if (Object.keys(found).length || Object.keys(foundBank).length) return;
    setBusy(true);
    let personId = savedId;
    let message = id ? "Details saved." : "";
    try {
      if (!personId && mode === "onboard") {
        // HR-02 "Add staff member": creates their application and emails the document link (staff-admin).
        try {
          const result = await staffAdminActions.add({ firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim().toLowerCase(), phone: toE164(form.phone) ?? form.phone.trim() });
          personId = result.profileId ?? null;
          message = result.link ? "Onboarding started. Email is switched off: copy the document link on this page and send it to them." : "Onboarding started: the document link was emailed. Next: review their documents, then send the offer letter.";
        } catch (err) {
          const created = (err as { result?: { profileId?: string } }).result?.profileId;
          if (!created) throw err;
          personId = created; // created; only the email failed: their page shows why and lets you send it again
          message = `Added, but the document link email failed: ${err instanceof Error ? err.message : "unknown error"}. Send it again on this page.`;
        }
        if (!personId) throw new Error("The staff member could not be added.");
      } else {
        personId = await saveEmployee(personId, form);
        if (!id) message = "Employee added as Active. Upload their documents below.";
      }
      setSavedId(personId);
      if (id ? bankLoaded : !bankIsEmpty(bank)) {
        try { await saveEmployeeBank(personId, bank); }
        catch (err) { setError(`${id ? "Details" : "The employee"} saved, but the bank details were not: ${err instanceof Error ? err.message : "please try again"}.`); return; }
      }
      onSaved(personId, { id: personId, mode: id ? "active" : mode, message });
    } catch (err) { setError(err instanceof Error ? err.message : "The employee could not be saved."); }
    finally { setBusy(false); }
  };

  const field = (key: keyof EmployeeForm, label: string, props: Record<string, unknown>) => (
    <div>
      <Field label={label} required>
        <TextInput value={form[key]} onChange={(e) => patch({ [key]: e.target.value })} aria-invalid={Boolean(problems[key])} data-testid={`employee-${key}`} disabled={Boolean(savedId && !id)} {...props} />
      </Field>
      {problems[key] ? <p role="alert" className="mt-1 text-xs text-primary-700">{problems[key]}</p> : null}
    </div>
  );

  const option = (value: Mode, title: string, text: string) => (
    <label className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${mode === value ? "border-primary-400 bg-primary-50" : "border-background-300"}`}>
      <input type="radio" name="employee-mode" className="mt-1" checked={mode === value} disabled={busy || Boolean(savedId)} onChange={() => setMode(value)} data-testid={`employee-mode-${value}`} />
      <span><span className="block font-semibold text-foreground-950">{title}</span><span className="text-foreground-700">{text}</span></span>
    </label>
  );

  return (
    <Modal open width="max-w-2xl" title={id ? "Edit employee" : "Add employee"} onClose={() => { if (!busy) onClose(); }}
      footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" form="employee-form" disabled={busy || !bankLoaded} data-testid="employee-save">
          {busy ? "Saving…" : id ? "Save" : mode === "onboard" ? "Add and send document link" : "Add employee"}</Button></>}>
      <form id="employee-form" noValidate className="space-y-4" onSubmit={(e) => void submit(e)}>
        {!id ? (
          <fieldset className="grid gap-2 sm:grid-cols-2" data-testid="employee-mode">
            <legend className="mb-1.5 text-[13px] font-medium text-foreground-800">How do you want to add them?</legend>
            {option("onboard", "Start onboarding", "Email a private link to add their details and documents. Then send the offer letter to sign, and activate them.")}
            {option("active", "Add as Active now", "No emails. They are Active straight away and you upload their documents yourself.")}
          </fieldset>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {field("firstName", "First name", { maxLength: 100, autoComplete: "off", autoFocus: true })}
          {field("lastName", "Last name", { maxLength: 100, autoComplete: "off" })}
        </div>
        {field("email", "Email", { type: "email", maxLength: 254, autoComplete: "off", inputMode: "email" })}
        {/* The same phone field as the student and agent forms: country code + number, formatted and checked as you type. */}
        <div data-testid="employee-phone" onInput={(e) => { const t = e.target as HTMLInputElement; if (t.name === "employee_phone") patch({ phone: t.value }); }}>
          <p className="mb-1.5 text-[13px] font-medium text-foreground-800">Mobile <span className="text-primary-600">*</span></p>
          <PhoneInput id="employee-phone-input" name="employee_phone" value={initial?.phone ?? ""} required locked={busy} placeholder="041 234 5678" />
          {/* A wrong number is already shown under the field by PhoneInput (after leaving it); only the empty case is ours. */}
          {problems.phone === "Enter the mobile number." ? <p role="alert" className="mt-1 text-xs text-primary-700">{problems.phone}</p> : null}
        </div>
        <fieldset className="rounded-md border border-background-200 p-3" data-testid="employee-bank">
          <legend className="px-1 text-[13px] font-semibold text-foreground-900">Bank details (for pay) <span className="font-normal text-foreground-500">optional</span></legend>
          {!bankLoaded ? <p role="status" className="text-sm">Loading bank details…</p> : (
            <BankDetailsFields value={bank} problems={bankIssues} disabled={busy}
              onChange={(next) => { setBank(next); if (touched) setBankIssues(bankProblems(next)); }} />
          )}
          <p className="mt-2 text-xs text-foreground-500">Only Admins can see these. Their other documents come from the onboarding link or your uploads.</p>
        </fieldset>
        {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      </form>
    </Modal>
  );
}
