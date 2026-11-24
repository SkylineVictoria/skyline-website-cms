import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AdminError, AdminLoading, Badge, Button, Card, Field, Modal, PageHeader, Select, TextInput, Toggle } from "@/pages/admin/components/ui";

import { STAFF_TIMESHEETS_PATH } from "@/pages/admin/lib/staffRoutes";
import { getHrSettings, listSchedules, saveSchedule, setPeriodStatus, type HrSettings, type PaySchedule } from "@/lib/hrmsApi";
import { PERIOD_STATUS_LABEL, WEEKDAY_SHORT, fmtDate, fmtRange } from "@/lib/hrTime";
import { hrList, hrObject } from "@/lib/hrRules";
import { institutionTimeZone } from "@/lib/timeZone";

/** Business Rules hrms.pay_frequencies and hrms.pay_date_window (the database checks the same on save). */
const FREQUENCIES = ["fortnightly", "monthly"] as const;
const allowedFrequencies = (): ScheduleForm["frequency"][] => {
  const keys = hrList("hrms.pay_frequencies", ["Fortnightly", "Monthly"]).map((x) => x.trim().toLowerCase())
    .filter((k): k is ScheduleForm["frequency"] => (FREQUENCIES as readonly string[]).includes(k));
  return keys.length ? [...new Set(keys)] : [...FREQUENCIES];
};
const payDateWindow = () => {
  const w = hrObject<{ daysBefore: unknown; daysAfter: unknown }>("hrms.pay_date_window", { daysBefore: 14, daysAfter: 31 });
  return { before: typeof w.daysBefore === "number" ? w.daysBefore : 14, after: typeof w.daysAfter === "number" ? w.daysAfter : 31 };
};

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
type ScheduleForm = { id: string | null; name: string; frequency: "fortnightly" | "monthly"; anchorDate: string; payDateOffsetDays: string; isActive: boolean };

/** Staff > Pay Schedules: fortnightly and monthly schedules with their periods (lock / unlock), and the HR settings. */
export default function PaySchedulesPage() {
  const [schedules, setSchedules] = useState<PaySchedule[] | null>(null);
  const [settings, setSettings] = useState<HrSettings | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<ScheduleForm | null>(null);
  const [dialogError, setDialogError] = useState(""); const [busy, setBusy] = useState("");
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(async () => {
    try { setError(""); const [s, st] = await Promise.all([listSchedules(), getHrSettings()]); setSchedules(s); setSettings(st); }
    catch (e) { setError(e instanceof Error ? e.message : "The pay schedules could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!editing) return;
    setBusy("schedule"); setDialogError("");
    try {
      await saveSchedule(editing.id, { name: editing.name, frequency: editing.frequency, anchorDate: editing.anchorDate, payDateOffsetDays: Number(editing.payDateOffsetDays || 0), isActive: editing.isActive });
      setEditing(null); setNotice("The schedule was saved and its periods generated a year ahead."); await load();
    } catch (e) { setDialogError(e instanceof Error ? e.message : "The pay schedule could not be saved."); }
    finally { setBusy(""); }
  };
  const setStatus = async (periodId: string, status: "open" | "locked") => {
    setBusy(periodId); setError("");
    try { await setPeriodStatus(periodId, status); setNotice(status === "locked" ? "Period locked; leave accrued for the approved timesheets." : "Period reopened; its accruals were removed."); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "The period could not be updated."); }
    finally { setBusy(""); }
  };

  if (error && !schedules) return <AdminError message={error} onRetry={() => void load()} />;
  if (!schedules || !settings) return <AdminLoading label="Loading pay schedules…" />;
  return (
    <div>
      <PageHeader breadcrumb="HRMS" title="Pay schedules" description="Pay periods for Xero Payroll AU. Fortnightly periods run Monday to Sunday from the anchor Monday; monthly periods are calendar months. Periods are generated a year ahead and topped up daily."
        actions={<Button onClick={() => { setEditing({ id: null, name: "", frequency: allowedFrequencies()[0], anchorDate: "", payDateOffsetDays: "0", isActive: true }); setDialogError(""); }} data-testid="schedule-new">New schedule</Button>} />
      {error ? <p role="alert" className={`mb-4 ${ALERT}`}>{error}</p> : null}
      {notice ? <p role="status" className={`mb-4 ${NOTICE}`} data-testid="schedule-notice">{notice}</p> : null}
      <div className="space-y-6">
        {schedules.map((s) => {
          const periods = [...(s.periods ?? [])].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
          const visible = showAll[s.id] ? periods : periods.filter((p) => p.endDate >= today).slice(0, 6).concat(periods.filter((p) => p.endDate < today).slice(-3)).sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
          return (
            <Card key={s.id} className="p-5"><div data-testid={`schedule-${s.id}`}>
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-heading text-base font-bold text-foreground-950">{s.name} {s.isActive ? null : <Badge tone="muted">Inactive</Badge>}</h2>
                  <p className="text-xs text-foreground-600">{s.frequency === "fortnightly" ? "Fortnightly" : "Monthly"} · from {fmtDate(s.anchorDate)} · pay date {s.payDateOffsetDays >= 0 ? "+" : ""}{s.payDateOffsetDays} day{Math.abs(s.payDateOffsetDays) === 1 ? "" : "s"} after the period · {s.employeeCount ?? 0} employee{s.employeeCount === 1 ? "" : "s"}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => { setEditing({ id: s.id, name: s.name, frequency: s.frequency, anchorDate: s.anchorDate, payDateOffsetDays: String(s.payDateOffsetDays), isActive: s.isActive }); setDialogError(""); }} data-testid={`schedule-edit-${s.id}`}>Edit</Button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-foreground-600"><tr><th className="px-2 py-1">Period</th><th className="px-2 py-1">Pay date</th><th className="px-2 py-1">Status</th><th className="px-2 py-1" /></tr></thead>
                  <tbody className="divide-y divide-background-200">
                    {visible.map((p) => (
                      <tr key={p.id} data-testid={`period-${p.id}`} className={p.startDate <= today && p.endDate >= today ? "bg-secondary-50" : ""}>
                        <td className="px-2 py-1.5"><Link to={`${STAFF_TIMESHEETS_PATH}?period=${p.id}`} className="text-primary-700 hover:underline">{fmtRange(p.startDate, p.endDate)}</Link></td>
                        <td className="px-2 py-1.5">{fmtDate(p.payDate)}</td>
                        <td className="px-2 py-1.5"><Badge tone={p.status === "exported" ? "success" : p.status === "locked" ? "warn" : "muted"}>{PERIOD_STATUS_LABEL[p.status]}</Badge></td>
                        <td className="px-2 py-1.5 text-right">
                          {p.status === "open" ? <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => void setStatus(p.id, "locked")} data-testid={`period-lock-${p.id}`}>Lock</Button> : null}
                          {p.status === "locked" ? <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => void setStatus(p.id, "open")} data-testid={`period-unlock-${p.id}`}>Unlock</Button> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {periods.length > visible.length || showAll[s.id] ? <button type="button" className="mt-2 cursor-pointer text-xs font-semibold text-primary-700 hover:underline" onClick={() => setShowAll((m) => ({ ...m, [s.id]: !m[s.id] }))}>{showAll[s.id] ? "Show fewer periods" : `Show all ${periods.length} periods`}</button> : null}
            </div></Card>
          );
        })}
        {!schedules.length ? <p className="text-sm text-foreground-600">No pay schedule yet.</p> : null}
        <SettingsCard settings={settings} />
      </div>
      <Modal open={editing !== null} title={editing?.id ? "Edit pay schedule" : "New pay schedule"} onClose={() => setEditing(null)}
        footer={<><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy === "schedule"} onClick={() => void save()} data-testid="schedule-save">Save</Button></>}>
        {editing ? (
          <div className="space-y-3" data-testid="schedule-dialog">
            <Field label="Name" required><TextInput value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-testid="schedule-name" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Frequency"><Select value={editing.frequency} onChange={(e) => setEditing({ ...editing, frequency: e.target.value as ScheduleForm["frequency"] })} data-testid="schedule-frequency">{(allowedFrequencies().includes(editing.frequency) ? allowedFrequencies() : [...allowedFrequencies(), editing.frequency]).map((f) => <option key={f} value={f}>{f === "fortnightly" ? "Fortnightly" : "Monthly"}</option>)}</Select></Field>
              <Field label={editing.frequency === "fortnightly" ? "First period starts (a Monday)" : "First period starts (1st of a month)"} required><TextInput type="date" value={editing.anchorDate} onChange={(e) => setEditing({ ...editing, anchorDate: e.target.value })} data-testid="schedule-anchor" /></Field>
              <Field label="Pay date: days after the period ends" hint={`From ${-payDateWindow().before} to ${payDateWindow().after}.`}><TextInput type="number" min={-payDateWindow().before} max={payDateWindow().after} value={editing.payDateOffsetDays} onChange={(e) => setEditing({ ...editing, payDateOffsetDays: e.target.value })} data-testid="schedule-offset" /></Field>
              <div className="flex items-end pb-2"><Toggle label="Active" checked={editing.isActive} onChange={(v) => setEditing({ ...editing, isActive: v })} /></div>
            </div>
            {editing.id ? <p className="text-xs text-foreground-600">The frequency and start date can change only while no period of this schedule is locked or exported; open periods are regenerated.</p> : null}
            {dialogError ? <p role="alert" className={ALERT} data-testid="schedule-error">{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function SettingsCard({ settings }: { settings: HrSettings }) {
  // Every value here is set in Administration › Business Rules: the time zone is general.time_zone (the institution time zone
  // used everywhere); ordinary hours, open-shift flag, paid breaks and usual work days are hrms.* (written to hr.settings by
  // hr.settings_rules_sync, migration 20261121002517).
  const fixed = (label: string, value: string, testId?: string) => (
    <div><span className="mb-1.5 block text-label font-medium text-foreground-800">{label}</span><p className="text-sm text-foreground-950" data-testid={testId}>{value}</p></div>
  );
  return (
    <Card className="p-5"><div data-testid="hr-settings">
      <h2 className="mb-1 font-heading text-base font-bold text-foreground-950">HR settings</h2>
      <p className="mb-3 text-xs text-foreground-600">Every time is stored as an instant and shown in this time zone (daylight saving follows the IANA zone, never a fixed offset).</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {fixed("Time zone", institutionTimeZone().replace(/_/g, " "), "settings-timezone")}
        {fixed("Full-time ordinary hours per week", String(settings.ordinaryHoursWeek))}
        {fixed("Flag an open shift after (hours)", String(settings.openShiftFlagHours))}
        {fixed("Breaks are paid", settings.breaksPaid ? "Yes" : "No")}
      </div>
      <div className="mt-3">{fixed("Usual work days", [...settings.usualWorkDays].sort().map((d) => WEEKDAY_SHORT[d]).join(", "))}</div>
      <p className="mt-2 text-xs text-foreground-600">Time zone, hours, open-shift flag, paid breaks and work days: set in <Link to="/admin/business-rules" className="underline">Administration › Business Rules</Link>.</p>
    </div></Card>
  );
}
