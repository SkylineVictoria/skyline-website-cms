import { useCallback, useEffect, useState } from "react";
import { Select } from "@/pages/admin/components/ui";
import { myTimesheet, type MyTimesheet as MyTimesheetData } from "@/lib/hrmsApi";
import { FLAG_LABEL, fmtDate, fmtRange, fmtTime, hoursLabel, minutesToHm, tzAbbrev } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const STATUS: Record<string, string> = { open: "Open", locked: "Locked", exported: "Sent to payroll" };

/** My HR > My timesheet: the pay period's hours, leave and holidays, with every shift. */
/** refreshKey: bump it (e.g. after a punch) to re-read the period. */
export default function MyTimesheet({ refreshKey = 0 }: { refreshKey?: number } = {}) {
  const [data, setData] = useState<MyTimesheetData | null>(null);
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setError(""); setData(await myTimesheet(periodId)); } catch (e) { setError(e instanceof Error ? e.message : "Your timesheet could not be loaded."); }
  }, [periodId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const tz = data?.timezone ?? "Australia/Melbourne";
  const s = data?.summary;
  return (
    <div data-testid="my-hr-timesheet">
      {error ? <p role="alert" className={`mb-3 ${ALERT}`}>{error}</p> : null}
      {!data ? <p className="text-sm text-foreground-600">Loading…</p> : !data.hasPaySetup ? <p className="text-sm text-foreground-600" data-testid="my-timesheet-none">HR has not put you on a pay schedule yet. Your punches are kept and will show here once they do.</p> : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-foreground-700">Pay period
              <Select className="mt-1 sm:w-80" value={data.period?.id ?? ""} onChange={(e) => setPeriodId(e.target.value)} data-testid="my-timesheet-period">
                {data.periods.map((p) => <option key={p.id} value={p.id}>{fmtRange(p.startDate, p.endDate)} · {STATUS[p.status]}</option>)}
              </Select>
            </label>
            {data.period ? <p className="text-sm text-foreground-600">Pay date {fmtDate(data.period.payDate)}</p> : null}
          </div>
          {s ? (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {[["Worked", hoursLabel(s.workedHours), "my-timesheet-worked"], ["Paid leave", hoursLabel(s.paidLeaveHours), "my-timesheet-leave"], ["Public holidays", hoursLabel(s.holidayHours), "my-timesheet-holidays"], ["Ordinary", hoursLabel(s.ordinaryHours), ""], ["Overtime", hoursLabel(s.overtimeHours), "my-timesheet-overtime"], ["Breaks", minutesToHm(s.breakMinutes), ""]].map(([k, v, id]) => (
                  <div key={k} className="rounded-md bg-background-100 px-3 py-2"><dt className="text-xs text-foreground-600">{k}</dt><dd className="text-base font-semibold text-foreground-950" data-testid={id || undefined}>{v}</dd></div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-foreground-600" data-testid="my-timesheet-approval">
                {s.approval ? `${s.approval.status === "approved" ? "Approved" : "Returned"} by ${s.approval.decidedByName ?? "your manager"}${s.approval.note ? `: ${s.approval.note}` : ""}` : "Not yet approved by your manager."}
                {s.openShifts ? " · You have an open shift." : ""}
              </p>
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-foreground-600">Shifts</h3>
              {s.shifts.length ? (
                <ul className="mt-1 divide-y divide-background-200 text-sm" data-testid="my-timesheet-shifts">
                  {s.shifts.map((sh) => (
                    <li key={sh.startedAt} className="py-1.5 text-foreground-800">
                      {fmtDate(sh.workDate)}: {fmtTime(sh.startedAt, tz)} – {sh.endedAt ? fmtTime(sh.endedAt, tz) : "open"} {tzAbbrev(sh.startedAt, tz)} · {minutesToHm(sh.workedMinutes)}{sh.breakMinutes ? `, ${minutesToHm(sh.breakMinutes)} break` : ""}
                      {sh.flags.map((f) => <span key={f} className="ml-2 rounded-full bg-primary-50 px-2 py-0.5 text-[11px] text-primary-900">{FLAG_LABEL[f] ?? f}</span>)}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-sm text-foreground-600">No shifts in this period.</p>}
              {s.leave.length ? <><h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-foreground-600">Leave</h3>
                <ul className="mt-1 text-sm text-foreground-800" data-testid="my-timesheet-leave-days">{s.leave.map((l) => <li key={`${l.requestId}-${l.day}`}>{fmtDate(l.day)}: {l.name} {hoursLabel(l.hours)}{l.isPaid ? "" : " (unpaid)"}</li>)}</ul></> : null}
              {s.holidays.length ? <><h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-foreground-600">Public holidays</h3>
                <ul className="mt-1 text-sm text-foreground-800" data-testid="my-timesheet-holiday-days">{s.holidays.map((h) => <li key={h.day}>{fmtDate(h.day)}: {h.name} {hoursLabel(h.hours)}</li>)}</ul></> : null}
            </>
          ) : <p className="mt-2 text-sm text-foreground-600">No pay period covers today yet.</p>}
        </>
      )}
    </div>
  );
}
