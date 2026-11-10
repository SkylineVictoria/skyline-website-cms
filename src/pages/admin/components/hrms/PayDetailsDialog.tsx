import { useEffect, useState } from "react";
import { Button, Field, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { adminListStaff, adminSavePayDetails, type OnboardingPayDetails, type PayDetailsForm, type StaffListRow, type StaffOnboarding } from "@/lib/staffApi";
import { payDetailsProblems, type PayDetailsInput } from "@/lib/staffStatus";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";

/**
 * "Add pay details" (after every required document is approved, before the offer): position, employment type, start date, pay
 * basis and rate, pay schedule, hours per week, reporting manager and the fields payroll and the Xero export use. Everything is
 * checked here and again by hr_admin_onboarding_pay_save; the values fill the offer letter.
 */
export default function PayDetailsDialog({ profileId, current, onClose, onSaved }: {
  profileId: string; current: OnboardingPayDetails; onClose: () => void; onSaved: (next: StaffOnboarding) => void;
}) {
  const e = current.employment;
  const p = current.pay;
  const [form, setForm] = useState<PayDetailsForm>({
    jobTitle: e?.jobTitle ?? "", department: e?.department ?? "", employmentType: e?.employmentType ?? "", startDate: e?.joiningDate ?? "",
    workLocation: e?.workLocation ?? "", managerId: e?.managerId ?? "", payBasis: p.payBasis ?? "", rate: p.rate === null || p.rate === undefined ? "" : String(p.rate),
    payScheduleId: p.payScheduleId ?? "", hoursPerWeek: p.ordinaryHoursWeek === null || p.ordinaryHoursWeek === undefined ? "" : String(p.ordinaryHoursWeek),
    award: p.award ?? "", xeroEmployeeId: p.xeroEmployeeId ?? "",
  });
  const [problems, setProblems] = useState<Partial<Record<keyof PayDetailsInput, string>>>({});
  const [managerSearch, setManagerSearch] = useState("");
  const [managers, setManagers] = useState<StaffListRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (next: Partial<PayDetailsForm>) => setForm((f) => ({ ...f, ...next }));

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void adminListStaff(["active"], managerSearch, 25, 0).then((data) => { if (live) setManagers(data.rows.filter((m) => m.id !== profileId)); }, () => { if (live) setManagers([]); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [managerSearch, profileId]);

  const save = async () => {
    const found = payDetailsProblems(form);
    setProblems(found);
    if (Object.keys(found).length) { setError("Check the highlighted fields."); return; }
    setBusy(true); setError("");
    try { onSaved(await adminSavePayDetails(profileId, { ...form, jobTitle: form.jobTitle.trim(), rate: form.rate.trim(), hoursPerWeek: form.hoursPerWeek.trim() })); }
    catch (err) { setError(err instanceof Error ? err.message : "The pay details could not be saved."); }
    finally { setBusy(false); }
  };

  const currentManager = e?.managerId && !managers.some((m) => m.id === e.managerId) ? { id: e.managerId, name: e.managerName ?? "Current manager" } : null;
  const problem = (key: keyof PayDetailsInput) => (problems[key] ? <p className="mt-1 text-xs text-primary-700" role="alert" data-testid={`pay-problem-${key}`}>{problems[key]}</p> : null);
  const hourly = form.payBasis === "hourly";

  return (
    <Modal open width="max-w-2xl" title="Pay details" onClose={() => { if (!busy) onClose(); }}
      footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="pay-details-save">{busy ? "Saving…" : "Save pay details"}</Button></>}>
      <div className="space-y-4" data-testid="pay-details-dialog">
        <p className="text-sm text-foreground-700">These details fill the offer letter and set the person up for payroll. Nothing is sent when you save.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Field label="Position (job title)" required><TextInput maxLength={150} value={form.jobTitle} onChange={(ev) => patch({ jobTitle: ev.target.value })} aria-invalid={Boolean(problems.jobTitle)} data-testid="pay-job-title" /></Field>{problem("jobTitle")}</div>
          <div><Field label="Employment type" required><Select value={form.employmentType} onChange={(ev) => patch({ employmentType: ev.target.value as PayDetailsForm["employmentType"] })} aria-invalid={Boolean(problems.employmentType)} data-testid="pay-employment-type">
            <option value="">Choose…</option><option value="full_time">Full time</option><option value="part_time">Part time</option><option value="casual">Casual</option>
          </Select></Field>{problem("employmentType")}</div>
          <div><Field label="Start date" required><TextInput type="date" value={form.startDate} onChange={(ev) => patch({ startDate: ev.target.value })} aria-invalid={Boolean(problems.startDate)} data-testid="pay-start-date" /></Field>{problem("startDate")}</div>
          <div><Field label="Pay schedule" required><Select value={form.payScheduleId} onChange={(ev) => patch({ payScheduleId: ev.target.value })} aria-invalid={Boolean(problems.payScheduleId)} data-testid="pay-schedule">
            <option value="">Choose…</option>{current.schedules.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.frequency})</option>)}
          </Select></Field>{problem("payScheduleId")}</div>
          <div><Field label="Pay basis" required><Select value={form.payBasis} onChange={(ev) => patch({ payBasis: ev.target.value as PayDetailsForm["payBasis"] })} aria-invalid={Boolean(problems.payBasis)} data-testid="pay-basis">
            <option value="">Choose…</option><option value="hourly">Hourly</option><option value="salary">Annual salary</option>
          </Select></Field>{problem("payBasis")}</div>
          <div><Field label={hourly ? "Hourly rate (AUD)" : form.payBasis === "salary" ? "Annual salary (AUD)" : "Pay rate (AUD)"} required>
            <TextInput inputMode="decimal" placeholder={hourly ? "38.50" : "85000"} value={form.rate} onChange={(ev) => patch({ rate: ev.target.value })} aria-invalid={Boolean(problems.rate)} data-testid="pay-rate" />
          </Field>{problem("rate")}</div>
          <div><Field label="Hours per week" required={form.employmentType !== "casual"} hint={form.employmentType === "casual" ? "Optional for a casual." : undefined}>
            <TextInput inputMode="decimal" placeholder="38" value={form.hoursPerWeek} onChange={(ev) => patch({ hoursPerWeek: ev.target.value })} aria-invalid={Boolean(problems.hoursPerWeek)} data-testid="pay-hours" />
          </Field>{problem("hoursPerWeek")}</div>
          <Field label="Work location"><TextInput maxLength={150} value={form.workLocation} onChange={(ev) => patch({ workLocation: ev.target.value })} data-testid="pay-location" /></Field>
          <Field label="Department"><TextInput maxLength={120} value={form.department} onChange={(ev) => patch({ department: ev.target.value })} data-testid="pay-department" /></Field>
          <Field label="Award (optional)"><TextInput maxLength={150} value={form.award} onChange={(ev) => patch({ award: ev.target.value })} /></Field>
          <Field label="Find a reporting manager" hint="Active employees only."><TextInput placeholder="Search by name or email" value={managerSearch} onChange={(ev) => setManagerSearch(ev.target.value)} /></Field>
          <Field label="Reporting manager"><Select value={form.managerId} onChange={(ev) => patch({ managerId: ev.target.value })} data-testid="pay-manager">
            <option value="">No manager assigned</option>
            {currentManager ? <option value={currentManager.id}>{currentManager.name}</option> : null}
            {managers.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
          </Select></Field>
          <Field label="Xero employee id" hint="Needed for the Xero export; you can add it later."><TextInput maxLength={80} value={form.xeroEmployeeId} onChange={(ev) => patch({ xeroEmployeeId: ev.target.value })} data-testid="pay-xero" /></Field>
        </div>
        {current.schedules.length === 0 ? <p className={ALERT}>There is no active pay schedule yet. Add one under HRMS › Pay Schedules first.</p> : null}
        {error ? <p role="alert" className={ALERT} data-testid="pay-details-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
