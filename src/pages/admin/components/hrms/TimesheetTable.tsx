import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Field, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import PeriodPicker from "./PeriodPicker";
import {
  correctTime, decideTimesheet, employeePunches, periodTimesheets, setPeriodStatus,
  type EmployeePunches, type MyTeam, type PayPeriod, type PeriodTimesheets, type PunchKind, type Shift, type TimesheetRow,
} from "@/lib/hrmsApi";
import { FLAG_LABEL, PERIOD_STATUS_LABEL, PUNCH_LABEL, fmtDate, fmtDateTime, fmtTime, hoursLabel, instantToZoned, minutesToHm, money, tzAbbrev, zonedToInstant } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
const FLAG_TONE: Record<string, "primary" | "warn" | "muted"> = { missing_punch_out: "primary", unclosed_break: "primary", weekend: "warn", public_holiday: "warn" };
const KINDS: (PunchKind | "void")[] = ["punch_in", "break_start", "break_end", "punch_out", "void"];

/** The time of a shift's punches in the HR zone, with the AEST/AEDT label. */
export function ShiftLine({ shift, timezone }: { shift: Shift; timezone: string }) {
  return (
    <span className="text-sm text-foreground-800">
      {fmtDate(shift.workDate)}: {fmtTime(shift.startedAt, timezone)} – {shift.endedAt ? fmtTime(shift.endedAt, timezone) : "open"} {tzAbbrev(shift.startedAt, timezone)}
      {" · "}{minutesToHm(shift.workedMinutes)} worked{shift.breakMinutes ? `, ${minutesToHm(shift.breakMinutes)} break` : ""}
      {shift.flags.map((f) => <span key={f} className="ml-1.5"><Badge tone={FLAG_TONE[f] ?? "muted"}>{FLAG_LABEL[f] ?? f}</Badge></span>)}
    </span>
  );
}

/**
 * Timesheets of one pay period: a row per employee (worked, break, leave, holidays, ordinary, overtime, estimated gross, flags,
 * approval), expandable to the shifts and punches with a correction dialog; approve / reject; lock / unlock (HR only). Managers
 * get the same table for their reports (the server scopes the rows).
 */
export default function TimesheetTable({ team, admin, initialPeriodId }: { team: MyTeam; admin: boolean; initialPeriodId?: string }) {
  const schedules = team.schedules;
  const today = new Date().toISOString().slice(0, 10);
  const defaultPeriod = useCallback((scheduleId: string): string => {
    const s = schedules.find((x) => x.id === scheduleId);
    const periods = s?.periods ?? [];
    return (periods.find((p) => p.startDate <= today && p.endDate >= today) ?? [...periods].sort((a, b) => (a.startDate < b.startDate ? 1 : -1)).find((p) => p.startDate <= today) ?? periods[0])?.id ?? "";
  }, [schedules, today]);
  const initial = initialPeriodId ? schedules.find((s) => s.periods.some((p) => p.id === initialPeriodId)) : undefined;
  const [scheduleId, setScheduleId] = useState(initial?.id ?? schedules[0]?.id ?? "");
  const [periodId, setPeriodId] = useState(initialPeriodId ?? defaultPeriod(schedules[0]?.id ?? ""));
  const [data, setData] = useState<PeriodTimesheets | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [punches, setPunches] = useState<EmployeePunches | null>(null);
  const [decision, setDecision] = useState<{ row: TimesheetRow; kind: "approved" | "rejected" } | null>(null);
  const [note, setNote] = useState("");
  const [correction, setCorrection] = useState<{ profileId: string; supersedes: string | null; kind: PunchKind | "void"; at: string; reason: string } | null>(null);
  const [dialogError, setDialogError] = useState("");
  const timezone = data?.timezone ?? "Australia/Melbourne";

  const load = useCallback(async () => {
    if (!periodId) { setData(null); return; }
    try { setError(""); setData(await periodTimesheets(periodId)); }
    catch (e) { setError(e instanceof Error ? e.message : "The timesheets could not be loaded."); }
  }, [periodId]);
  useEffect(() => { void load(); }, [load]);

  const period: PayPeriod | undefined = data?.period ?? schedules.flatMap((s) => s.periods).find((p) => p.id === periodId);
  const loadPunches = useCallback(async (profileId: string) => {
    if (!period) return;
    try { setPunches(await employeePunches(profileId, period.startDate, period.endDate)); }
    catch (e) { setError(e instanceof Error ? e.message : "The punches could not be loaded."); }
  }, [period]);
  const toggle = (profileId: string) => {
    if (expanded === profileId) { setExpanded(null); setPunches(null); return; }
    setExpanded(profileId); setPunches(null); void loadPunches(profileId);
  };

  const decide = async () => {
    if (!decision || !period) return;
    setBusy(decision.row.profileId); setDialogError("");
    try {
      await decideTimesheet(period.id, decision.row.profileId, decision.kind, note);
      setDecision(null); setNote("");
      setNotice(`${decision.row.name}: timesheet ${decision.kind}.`);
      await load();
    } catch (e) { setDialogError(e instanceof Error ? e.message : "The decision could not be saved."); }
    finally { setBusy(""); }
  };
  const setStatus = async (status: "open" | "locked") => {
    if (!period) return;
    setBusy("period"); setError("");
    try {
      await setPeriodStatus(period.id, status);
      setNotice(status === "locked" ? "The period is locked. Leave accrued for the approved timesheets." : "The period is open again; its accruals were removed.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "The period could not be updated."); }
    finally { setBusy(""); }
  };
  const saveCorrection = async () => {
    if (!correction) return;
    setBusy("correction"); setDialogError("");
    try {
      const at = correction.kind === "void" ? null : zonedToInstant(correction.at, timezone);
      await correctTime(correction.profileId, correction.supersedes, correction.kind, at, correction.reason);
      setCorrection(null);
      setNotice("The correction was recorded.");
      await load();
      if (expanded) await loadPunches(expanded);
    } catch (e) { setDialogError(e instanceof Error ? e.message : "The correction could not be saved."); }
    finally { setBusy(""); }
  };
  const openCorrection = (profileId: string, supersedes: string | null, kind: PunchKind | "void", at: string | null) =>
    setCorrection({ profileId, supersedes, kind, at: at ? instantToZoned(at, timezone) : instantToZoned(new Date(), timezone), reason: "" });

  const totals = useMemo(() => (data?.employees ?? []).reduce((t, r) => ({ worked: t.worked + Number(r.workedHours), overtime: t.overtime + Number(r.overtimeHours) }), { worked: 0, overtime: 0 }), [data]);

  if (!schedules.length) return <p className="text-sm text-foreground-600" data-testid="timesheet-no-schedules">No pay schedule exists yet.</p>;
  return (
    <div className="space-y-4" data-testid="timesheet-table">
      <Card className="p-4">
        <PeriodPicker schedules={schedules} scheduleId={scheduleId} periodId={periodId} testId="timesheet"
          onSchedule={(id) => { setScheduleId(id); setPeriodId(defaultPeriod(id)); setExpanded(null); }} onPeriod={(id) => { setPeriodId(id); setExpanded(null); }} />
        {period ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-foreground-700">
            <span data-testid="timesheet-period-status">
              <Badge tone={period.status === "exported" ? "success" : period.status === "locked" ? "warn" : "muted"}>{PERIOD_STATUS_LABEL[period.status]}</Badge>
              <span className="ml-2">Pay date {fmtDate(period.payDate)}</span>
              {data ? <span className="ml-2">· {data.employees.length} employee{data.employees.length === 1 ? "" : "s"} · {hoursLabel(totals.worked)} worked · {hoursLabel(totals.overtime)} overtime</span> : null}
            </span>
            {admin && period.status === "open" ? <Button size="sm" variant="outline" disabled={busy === "period"} onClick={() => void setStatus("locked")} data-testid="timesheet-lock">Lock period</Button> : null}
            {admin && period.status === "locked" ? <Button size="sm" variant="outline" disabled={busy === "period"} onClick={() => void setStatus("open")} data-testid="timesheet-unlock">Unlock period</Button> : null}
          </div>
        ) : null}
      </Card>
      {error ? <p role="alert" className={ALERT} data-testid="timesheet-error">{error}</p> : null}
      {notice ? <p role="status" className={NOTICE} data-testid="timesheet-notice">{notice}</p> : null}
      {data && !data.employees.length ? <p className="text-sm text-foreground-600" data-testid="timesheet-empty">No employee is on this pay schedule{data.scope === "team" ? " among your reports" : ""}. Pay setup is on each employee's page.</p> : null}
      {data && data.employees.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600">
              <tr>
                <th className="px-3 py-2">Employee</th><th className="px-3 py-2 text-right">Worked</th><th className="px-3 py-2 text-right">Break</th><th className="px-3 py-2 text-right">Leave</th>
                <th className="px-3 py-2 text-right">Holidays</th><th className="px-3 py-2 text-right">Ordinary</th><th className="px-3 py-2 text-right">Overtime</th><th className="px-3 py-2 text-right">Est. gross</th>
                <th className="px-3 py-2">Flags</th><th className="px-3 py-2">Approval</th><th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-background-200">
              {data.employees.map((r) => (
                <TimesheetRowView key={r.profileId} row={r} period={period!} timezone={timezone} expanded={expanded === r.profileId} punches={expanded === r.profileId ? punches : null}
                  busy={busy === r.profileId} onToggle={() => toggle(r.profileId)}
                  onDecide={(kind) => { setDecision({ row: r, kind }); setNote(""); setDialogError(""); }}
                  onCorrect={(supersedes, kind, at) => openCorrection(r.profileId, supersedes, kind, at)} />
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <Modal open={decision !== null} title={decision?.kind === "approved" ? "Approve timesheet" : "Reject timesheet"} onClose={() => setDecision(null)}
        footer={<><Button variant="outline" onClick={() => setDecision(null)}>Cancel</Button><Button disabled={Boolean(busy)} onClick={() => void decide()} data-testid="decision-confirm">{decision?.kind === "approved" ? "Approve" : "Reject"}</Button></>}>
        {decision ? (
          <div className="space-y-3" data-testid="decision-dialog">
            <p className="text-sm text-foreground-800">{decision.row.name}: {hoursLabel(decision.row.workedHours)} worked, {hoursLabel(decision.row.paidLeaveHours)} paid leave, {hoursLabel(decision.row.holidayHours)} paid holidays, {hoursLabel(decision.row.overtimeHours)} overtime.</p>
            <Field label="Note (optional)"><TextArea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="decision-note" /></Field>
            {dialogError ? <p role="alert" className={ALERT}>{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>

      <Modal open={correction !== null} title={correction?.supersedes ? (correction.kind === "void" ? "Void a punch" : "Correct a punch") : "Add a punch"} onClose={() => setCorrection(null)}
        footer={<><Button variant="outline" onClick={() => setCorrection(null)}>Cancel</Button><Button disabled={busy === "correction"} onClick={() => void saveCorrection()} data-testid="correction-save">Save correction</Button></>}>
        {correction ? (
          <div className="space-y-3" data-testid="correction-dialog">
            <Field label="Punch"><Select value={correction.kind} onChange={(e) => setCorrection({ ...correction, kind: e.target.value as PunchKind | "void" })} data-testid="correction-kind">
              {KINDS.filter((k) => k !== "void" || correction.supersedes).map((k) => <option key={k} value={k}>{PUNCH_LABEL[k]}</option>)}
            </Select></Field>
            {correction.kind !== "void" ? (
              <Field label={`Time (${tzAbbrev(new Date(), timezone)}, ${timezone})`}>
                <TextInput type="datetime-local" value={correction.at} onChange={(e) => setCorrection({ ...correction, at: e.target.value })} data-testid="correction-at" />
              </Field>
            ) : <p className="text-sm text-foreground-700">The punch is removed from the timesheet. The original row stays in the record.</p>}
            <Field label="Reason" required><TextArea rows={2} maxLength={500} value={correction.reason} onChange={(e) => setCorrection({ ...correction, reason: e.target.value })} data-testid="correction-reason" /></Field>
            {dialogError ? <p role="alert" className={ALERT} data-testid="correction-error">{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function TimesheetRowView({ row, period, timezone, expanded, punches, busy, onToggle, onDecide, onCorrect }: {
  row: TimesheetRow; period: PayPeriod; timezone: string; expanded: boolean; punches: EmployeePunches | null; busy: boolean;
  onToggle: () => void; onDecide: (kind: "approved" | "rejected") => void; onCorrect: (supersedes: string | null, kind: PunchKind | "void", at: string | null) => void;
}) {
  const canChange = period.status !== "exported";
  const canCorrect = period.status === "open" && row.canDecide;
  return (
    <>
      <tr data-testid={`timesheet-row-${row.profileId}`} className="align-top">
        <td className="px-3 py-2">
          <button type="button" className="cursor-pointer text-left font-semibold text-primary-700 hover:underline" onClick={onToggle} data-testid={`timesheet-expand-${row.profileId}`}>{row.name}</button>
          <p className="text-xs text-foreground-500">{row.jobTitle}{row.managerName ? ` · reports to ${row.managerName}` : ""}</p>
          {!row.hasPaySetup ? <p className="text-xs text-primary-800">No pay setup</p> : null}
        </td>
        <td className="px-3 py-2 text-right" data-testid={`timesheet-worked-${row.profileId}`}>{hoursLabel(row.workedHours)}</td>
        <td className="px-3 py-2 text-right">{minutesToHm(row.breakMinutes)}</td>
        <td className="px-3 py-2 text-right" data-testid={`timesheet-leave-${row.profileId}`}>{hoursLabel(row.paidLeaveHours)}{Number(row.unpaidLeaveHours) ? <span className="block text-xs text-foreground-500">+{hoursLabel(row.unpaidLeaveHours)} unpaid</span> : null}</td>
        <td className="px-3 py-2 text-right" data-testid={`timesheet-holiday-${row.profileId}`}>{hoursLabel(row.holidayHours)}{Number(row.unpaidHolidayHours) ? <span className="block text-xs text-foreground-500">+{hoursLabel(row.unpaidHolidayHours)} unpaid</span> : null}</td>
        <td className="px-3 py-2 text-right">{hoursLabel(row.ordinaryHours)}</td>
        <td className="px-3 py-2 text-right" data-testid={`timesheet-overtime-${row.profileId}`}>{hoursLabel(row.overtimeHours)}</td>
        <td className="px-3 py-2 text-right">{row.estimatedGross === null ? <span className="text-foreground-400">—</span> : money(row.estimatedGross)}</td>
        <td className="px-3 py-2"><span className="flex flex-wrap gap-1">{row.openShifts ? <Badge tone="primary">Open shift</Badge> : null}{row.flags.map((f) => <Badge key={f} tone={FLAG_TONE[f] ?? "muted"}>{FLAG_LABEL[f] ?? f}</Badge>)}</span></td>
        <td className="px-3 py-2" data-testid={`timesheet-approval-${row.profileId}`}>
          {row.approval ? <><Badge tone={row.approval.status === "approved" ? "success" : "primary"}>{row.approval.status === "approved" ? "Approved" : "Rejected"}</Badge><span className="block text-xs text-foreground-500">{row.approval.decidedByName ?? ""} {fmtDateTime(row.approval.decidedAt, timezone)}</span></> : <Badge tone="muted">Pending</Badge>}
        </td>
        <td className="px-3 py-2">
          {row.canDecide && canChange ? (
            <span className="flex flex-wrap gap-1">
              {row.approval?.status !== "approved" ? <Button size="sm" disabled={busy || !row.approvable} title={row.approvable ? "" : "Open shift or missing punch; correct it first"} onClick={() => onDecide("approved")} data-testid={`timesheet-approve-${row.profileId}`}>Approve</Button> : null}
              {row.approval?.status !== "rejected" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide("rejected")} data-testid={`timesheet-reject-${row.profileId}`}>Reject</Button> : null}
            </span>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-background-100/60"><td colSpan={11} className="px-4 py-3" data-testid={`timesheet-detail-${row.profileId}`}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-600">Shifts</h4>
              {row.shifts.length ? <ul className="space-y-1">{row.shifts.map((s) => <li key={s.startedAt}><ShiftLine shift={s} timezone={timezone} /></li>)}</ul> : <p className="text-sm text-foreground-500">No shifts in this period.</p>}
              {row.leave.length ? <><h4 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-foreground-600">Leave</h4>
                <ul className="space-y-0.5 text-sm">{row.leave.map((l) => <li key={`${l.requestId}-${l.day}`}>{fmtDate(l.day)}: {l.name} {hoursLabel(l.hours)}{l.isPaid ? "" : " (unpaid)"}</li>)}</ul></> : null}
              {row.holidays.length ? <><h4 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-foreground-600">Holidays</h4>
                <ul className="space-y-0.5 text-sm">{row.holidays.map((h) => <li key={`${h.day}-${h.name}`}>{fmtDate(h.day)}: {h.name} {hoursLabel(h.hours)}{h.isOptional ? ` (optional${h.isPaid ? "" : ", unpaid"})` : ""}</li>)}</ul></> : null}
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-600">Punches ({timezone})</h4>
                {canCorrect ? <Button size="sm" variant="outline" onClick={() => onCorrect(null, "punch_in", null)} data-testid="timesheet-add-punch">Add a punch</Button> : null}
              </div>
              {!punches ? <p className="text-sm text-foreground-500">Loading…</p> : punches.events.length ? (
                <ul className="divide-y divide-background-200 text-sm" data-testid="punch-list">
                  {punches.events.map((e) => (
                    <li key={e.id} className={`flex flex-wrap items-center justify-between gap-2 py-1 ${e.supersededBy || e.kind === "void" ? "text-foreground-400 line-through" : ""}`} data-testid={`punch-${e.id}`}>
                      <span>{PUNCH_LABEL[e.kind]} · {fmtDateTime(e.at, timezone)} {tzAbbrev(e.at, timezone)}{e.source === "correction" ? ` · correction: ${e.reason}` : ""}</span>
                      {canCorrect && !e.supersededBy && e.kind !== "void" ? (
                        <span className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => onCorrect(e.id, e.kind as PunchKind, e.at)} data-testid={`punch-correct-${e.id}`}>Correct</Button>
                          <Button size="sm" variant="ghost" onClick={() => onCorrect(e.id, "void", e.at)} data-testid={`punch-void-${e.id}`}>Void</Button>
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-foreground-500">No punches in this period.</p>}
            </div>
          </div>
        </td></tr>
      ) : null}
    </>
  );
}
