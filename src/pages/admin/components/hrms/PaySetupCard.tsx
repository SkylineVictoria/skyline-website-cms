import { useCallback, useEffect, useState } from "react";
import { Button, Card, Field, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { BalanceTable } from "@/pages/admin/LeaveAdminPage";
import { adjustLeave, getEmployeePay, leaveBalances, saveEmployeePay, type EmployeePay, type EmployeePayForm, type LeaveBalances } from "@/lib/hrmsApi";
import { WEEKDAY_SHORT, hoursLabel, money, weekdayNames } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</dt><dd className="text-sm text-foreground-900">{children || "—"}</dd></div>;
}

/** Staff > Employees > person: the pay setup (schedule, basis, rate, ordinary hours, usual days, award, Xero id) and the leave balances. */
export default function PaySetupCard({ profileId, hasEmployment }: { profileId: string; hasEmployment: boolean }) {
  const [pay, setPay] = useState<EmployeePay | null>(null);
  const [balances, setBalances] = useState<LeaveBalances | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<EmployeePayForm | null>(null);
  const [adjust, setAdjust] = useState<{ leaveTypeId: string; hours: string; reason: string } | null>(null);
  const [dialogError, setDialogError] = useState(""); const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setError(""); const [p, b] = await Promise.all([getEmployeePay(profileId), leaveBalances(profileId)]); setPay(p); setBalances(b); }
    catch (e) { setError(e instanceof Error ? e.message : "The pay setup could not be loaded."); }
  }, [profileId]);
  useEffect(() => { void load(); }, [load]);

  const open = () => {
    if (!pay) return;
    setEditing({ payScheduleId: pay.payScheduleId ?? "", payBasis: pay.payBasis ?? "", rate: pay.rate === null ? "" : String(pay.rate), ordinaryHoursWeek: pay.ordinaryHoursWeek === null ? "" : String(pay.ordinaryHoursWeek), usualWorkDays: pay.usualWorkDays ?? pay.effectiveUsualWorkDays, award: pay.award ?? "", xeroEmployeeId: pay.xeroEmployeeId ?? "" });
    setDialogError("");
  };
  const save = async () => {
    if (!editing) return;
    setBusy(true); setDialogError("");
    try { setPay({ ...(await saveEmployeePay(profileId, editing)), schedules: pay?.schedules }); setEditing(null); setBalances(await leaveBalances(profileId)); }
    catch (e) { setDialogError(e instanceof Error ? e.message : "The pay setup could not be saved."); }
    finally { setBusy(false); }
  };
  const saveAdjust = async () => {
    if (!adjust) return;
    setBusy(true); setDialogError("");
    try { setBalances(await adjustLeave(profileId, adjust.leaveTypeId, Number(adjust.hours), adjust.reason)); setAdjust(null); }
    catch (e) { setDialogError(e instanceof Error ? e.message : "The balance could not be adjusted."); }
    finally { setBusy(false); }
  };
  const toggleDay = (d: number) => editing && setEditing({ ...editing, usualWorkDays: editing.usualWorkDays.includes(d) ? editing.usualWorkDays.filter((x) => x !== d) : [...editing.usualWorkDays, d].sort() });

  return (
    <>
      <Card className="mt-6 p-5"><div data-testid="staff-pay-setup">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-base font-bold text-foreground-950">Pay setup</h2>
          <Button size="sm" variant="outline" disabled={!pay || !hasEmployment} title={hasEmployment ? "" : "Add the employment details first"} onClick={open} data-testid="staff-pay-edit">{pay?.payScheduleId ? "Edit pay setup" : "Set up pay"}</Button>
        </div>
        {error ? <p role="alert" className={`mb-3 ${ALERT}`}>{error}</p> : null}
        {pay ? (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Row label="Pay schedule">{pay.payScheduleName ?? <span className="text-primary-800">Not on a schedule</span>}</Row>
            <Row label="Pay basis">{pay.payBasis === "salary" ? `Salary ${money(pay.rate)} a year` : pay.payBasis === "hourly" ? `Hourly ${money(pay.rate)}` : ""}</Row>
            <Row label="Ordinary hours / week">{hoursLabel(pay.effectiveOrdinaryHoursWeek)}{pay.ordinaryHoursWeek === null ? <span className="ml-1 text-xs text-foreground-500">(default)</span> : null}</Row>
            <Row label="Usual work days">{weekdayNames(pay.effectiveUsualWorkDays)} · {hoursLabel(pay.dailyHours)} a day</Row>
            <Row label="Award">{pay.award}</Row>
            <Row label="Xero employee id">{pay.xeroEmployeeId || <span className="text-primary-800">Missing (needed for the export)</span>}</Row>
          </dl>
        ) : <p className="text-sm text-foreground-600">Loading…</p>}
      </div></Card>
      <Card className="mt-6 p-5"><div data-testid="staff-leave-balances">
        <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Leave balances</h2>
        {balances ? <BalanceTable data={balances} onAdjust={(leaveTypeId) => { setAdjust({ leaveTypeId, hours: "", reason: "" }); setDialogError(""); }} /> : <p className="text-sm text-foreground-600">Loading…</p>}
      </div></Card>
      <Modal open={editing !== null} title="Pay setup" onClose={() => setEditing(null)}
        footer={<><Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="staff-pay-save">{busy ? "Saving…" : "Save"}</Button></>}>
        {editing && pay ? (
          <div className="space-y-3" data-testid="staff-pay-dialog">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Pay schedule"><Select value={editing.payScheduleId} onChange={(e) => setEditing({ ...editing, payScheduleId: e.target.value })} data-testid="staff-pay-schedule">
                <option value="">Not on a schedule</option>{(pay.schedules ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.frequency})</option>)}
              </Select></Field>
              <Field label="Pay basis"><Select value={editing.payBasis} onChange={(e) => setEditing({ ...editing, payBasis: e.target.value as EmployeePayForm["payBasis"] })} data-testid="staff-pay-basis">
                <option value="">Not set</option><option value="salary">Salary (annual)</option><option value="hourly">Hourly</option>
              </Select></Field>
              <Field label={editing.payBasis === "hourly" ? "Hourly rate (AUD)" : "Annual salary (AUD)"} hint="Display only; Xero is the source of truth."><TextInput type="number" step="0.01" min="0" value={editing.rate} onChange={(e) => setEditing({ ...editing, rate: e.target.value })} data-testid="staff-pay-rate" /></Field>
              <Field label="Ordinary hours per week" hint={`Blank = the HR default (${pay.effectiveOrdinaryHoursWeek} h)`}><TextInput type="number" step="0.5" min="1" max="80" value={editing.ordinaryHoursWeek} onChange={(e) => setEditing({ ...editing, ordinaryHoursWeek: e.target.value })} data-testid="staff-pay-hours" /></Field>
              <Field label="Award (optional)"><TextInput maxLength={150} value={editing.award} onChange={(e) => setEditing({ ...editing, award: e.target.value })} /></Field>
              <Field label="Xero employee id"><TextInput maxLength={80} value={editing.xeroEmployeeId} onChange={(e) => setEditing({ ...editing, xeroEmployeeId: e.target.value })} data-testid="staff-pay-xero" /></Field>
            </div>
            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-foreground-800">Usual work days</span>
              <div className="flex flex-wrap gap-2">{[1, 2, 3, 4, 5, 6, 7].map((d) => <label key={d} className="inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={editing.usualWorkDays.includes(d)} onChange={() => toggleDay(d)} /> {WEEKDAY_SHORT[d]}</label>)}</div>
            </div>
            {dialogError ? <p role="alert" className={ALERT} data-testid="staff-pay-error">{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
      <Modal open={adjust !== null} title="Adjust a leave balance" onClose={() => setAdjust(null)}
        footer={<><Button variant="outline" disabled={busy} onClick={() => setAdjust(null)}>Cancel</Button><Button disabled={busy} onClick={() => void saveAdjust()} data-testid="staff-leave-adjust-save">Save</Button></>}>
        {adjust && balances ? (
          <div className="space-y-3">
            <Field label="Leave type"><Select value={adjust.leaveTypeId} onChange={(e) => setAdjust({ ...adjust, leaveTypeId: e.target.value })}>
              {balances.balances.filter((b) => b.requiresBalance).map((b) => <option key={b.leaveTypeId} value={b.leaveTypeId}>{b.name}</option>)}
            </Select></Field>
            <Field label="Hours (negative to deduct)" required><TextInput type="number" step="0.25" value={adjust.hours} onChange={(e) => setAdjust({ ...adjust, hours: e.target.value })} data-testid="staff-leave-adjust-hours" /></Field>
            <Field label="Reason" required><TextArea rows={2} maxLength={500} value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} data-testid="staff-leave-adjust-reason" /></Field>
            {dialogError ? <p role="alert" className={ALERT}>{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
