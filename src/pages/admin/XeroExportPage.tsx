import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AdminError, AdminLoading, Badge, Button, Card, ConfirmDialog, PageHeader } from "@/pages/admin/components/ui";
import PeriodPicker from "@/pages/admin/components/hrms/PeriodPicker";
import { STAFF_TIMESHEETS_PATH, staffEmployeePath } from "@/pages/admin/lib/staffRoutes";
import { downloadText, myTeam, xeroExport, xeroExports, xeroReadiness, type MyTeam, type XeroExport, type XeroReadiness } from "@/lib/hrmsApi";
import { PERIOD_STATUS_LABEL, fmtDate, fmtDateTime, fmtRange, hoursLabel } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
const csvName = (x: XeroExport) => `xero-payroll-${x.period.scheduleName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${x.period.startDate}-${x.period.endDate}.csv`;

/** Staff > Xero Export: one line per employee, local date and pay item for a locked, fully approved period; CSV download. */
export default function XeroExportPage() {
  const [team, setTeam] = useState<MyTeam | null>(null);
  const [scheduleId, setScheduleId] = useState(""); const [periodId, setPeriodId] = useState("");
  const [readiness, setReadiness] = useState<XeroReadiness | null>(null);
  const [result, setResult] = useState<XeroExport | null>(null);
  const [history, setHistory] = useState<XeroExport[]>([]);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(async () => {
    try {
      setError("");
      const [t, h] = await Promise.all([myTeam(), xeroExports() as Promise<XeroExport[]>]);
      setTeam(t); setHistory(h);
      if (!scheduleId && t.schedules[0]) {
        const s = t.schedules[0];
        const p = [...s.periods].sort((a, b) => (a.startDate < b.startDate ? 1 : -1)).find((x) => x.endDate < today && x.status !== "exported") ?? s.periods[0];
        setScheduleId(s.id); setPeriodId(p?.id ?? "");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "The export page could not be loaded."); }
  }, [scheduleId, today]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!periodId) { setReadiness(null); return; }
    let current = true;
    // Re-read the readiness when the period changes or an export lands; keep the result card of the export just made.
    xeroReadiness(periodId).then((r) => { if (current) { setReadiness(r); setResult((x) => (x && x.periodId === periodId ? x : null)); } }, (e: unknown) => { if (current) setError(e instanceof Error ? e.message : "The readiness could not be loaded."); });
    return () => { current = false; };
  }, [periodId, history.length]);

  const run = async () => {
    setBusy(true); setError(""); setConfirm(false);
    try { const x = await xeroExport(periodId); setResult(x); setNotice(`Exported ${x.lineCount} lines for ${x.employeeCount} employees. The period is now final.`); setHistory(await xeroExports() as XeroExport[]); setTeam(await myTeam()); }
    catch (e) { setError(e instanceof Error ? e.message : "The export could not be produced."); }
    finally { setBusy(false); }
  };
  const download = async (x: XeroExport) => {
    try { const full = x.csv ? x : (await xeroExports(x.id) as XeroExport); downloadText(csvName(full), full.csv ?? ""); }
    catch (e) { setError(e instanceof Error ? e.message : "The CSV could not be downloaded."); }
  };

  if (error && !team) return <AdminError message={error} onRetry={() => void load()} />;
  if (!team) return <AdminLoading label="Loading…" />;
  const period = readiness?.period;
  const ready = Boolean(period && period.status === "locked" && readiness && readiness.employees.length && readiness.employees.every((e) => e.approved && e.xeroEmployeeId));
  return (
    <div>
      <PageHeader breadcrumb="Staff" title="Xero export" description="Approved hours, leave and public holidays per pay period for Xero Payroll AU (pay items Ordinary, Overtime, Public Holiday and each leave type, one line per employee per day). Payroll itself is calculated in Xero." />
      {error ? <p role="alert" className={`mb-4 ${ALERT}`} data-testid="xero-error">{error}</p> : null}
      {notice ? <p role="status" className={`mb-4 ${NOTICE}`} data-testid="xero-notice">{notice}</p> : null}
      {team.schedules.length ? (
        <Card className="p-4"><PeriodPicker schedules={team.schedules} scheduleId={scheduleId} periodId={periodId} testId="xero"
          onSchedule={(id) => { setScheduleId(id); const s = team.schedules.find((x) => x.id === id); setPeriodId(s?.periods[0]?.id ?? ""); }} onPeriod={setPeriodId} /></Card>
      ) : <p className="text-sm text-foreground-600">No pay schedule exists yet.</p>}
      {readiness && period ? (
        <Card className="mt-4 p-5"><div data-testid="xero-readiness">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-base font-bold text-foreground-950">{period.scheduleName}: {fmtRange(period.startDate, period.endDate)} <Badge tone={period.status === "exported" ? "success" : period.status === "locked" ? "warn" : "muted"}>{PERIOD_STATUS_LABEL[period.status]}</Badge></h2>
            {period.status === "locked" ? <Button disabled={!ready || busy} onClick={() => setConfirm(true)} data-testid="xero-export">Export to Xero</Button> : null}
          </div>
          <ul className="space-y-1 text-sm" data-testid="xero-checklist">
            <li className={period.status === "locked" || period.status === "exported" ? "text-secondary-900" : "text-primary-900"}><i className={`${period.status === "open" ? "ri-close-circle-line" : "ri-checkbox-circle-line"} mr-1`} aria-hidden="true" />Period {period.status === "open" ? "is still open: lock it in " : "locked"}{period.status === "open" ? <Link to={`${STAFF_TIMESHEETS_PATH}?period=${period.id}`} className="font-semibold text-primary-700 hover:underline">Timesheets</Link> : null}</li>
            {readiness.employees.map((e) => (
              <li key={e.profileId} className={e.approved && e.xeroEmployeeId ? "text-secondary-900" : "text-primary-900"} data-testid={`xero-employee-${e.profileId}`}>
                <i className={`${e.approved && e.xeroEmployeeId ? "ri-checkbox-circle-line" : "ri-close-circle-line"} mr-1`} aria-hidden="true" />
                <Link to={staffEmployeePath(e.profileId)} className="font-semibold hover:underline">{e.name}</Link>: {e.approved ? "approved" : "not approved"}, {e.xeroEmployeeId ? `Xero id ${e.xeroEmployeeId}` : "no Xero employee id"}
              </li>
            ))}
            {!readiness.employees.length ? <li className="text-primary-900">No employee is on this pay schedule.</li> : null}
          </ul>
          {readiness.exports.length ? <p className="mt-3 text-xs text-foreground-600">Exported {readiness.exports.map((x) => fmtDateTime(x.exportedAt)).join(", ")}.</p> : null}
        </div></Card>
      ) : null}
      {result?.lines ? (
        <Card className="mt-4 overflow-x-auto"><div data-testid="xero-result">
          <div className="flex flex-wrap items-center justify-between gap-2 p-4">
            <h2 className="font-heading text-base font-bold text-foreground-950">Export lines ({result.lineCount})</h2>
            <Button variant="outline" onClick={() => void download(result)} data-testid="xero-download">Download CSV</Button>
          </div>
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600"><tr><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Xero id</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Pay item</th><th className="px-3 py-2 text-right">Hours</th></tr></thead>
            <tbody className="divide-y divide-background-200">{result.lines.map((l, i) => <tr key={i}><td className="px-3 py-1.5">{l.employeeName}</td><td className="px-3 py-1.5">{l.xeroEmployeeId}</td><td className="px-3 py-1.5">{fmtDate(l.date)}</td><td className="px-3 py-1.5">{l.payItem}</td><td className="px-3 py-1.5 text-right">{hoursLabel(l.hours)}</td></tr>)}</tbody>
          </table>
        </div></Card>
      ) : null}
      <Card className="mt-6 p-5"><div data-testid="xero-history">
        <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Past exports</h2>
        {history.length ? (
          <ul className="divide-y divide-background-200 text-sm">
            {history.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`xero-export-${x.id}`}>
                <span>{x.period.scheduleName}: {fmtRange(x.period.startDate, x.period.endDate)} · {x.employeeCount} employees, {x.lineCount} lines · {fmtDateTime(x.exportedAt)}{x.exportedByName ? ` by ${x.exportedByName}` : ""}</span>
                <Button size="sm" variant="outline" onClick={() => void download(x)}>Download CSV</Button>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-foreground-600">Nothing exported yet.</p>}
      </div></Card>
      <ConfirmDialog open={confirm} title="Export to Xero" message={period ? `Export ${period.scheduleName} ${fmtRange(period.startDate, period.endDate)}? The period becomes final: no further corrections, approvals or leave changes.` : ""} confirmLabel="Export" onCancel={() => setConfirm(false)} onConfirm={() => void run()} />
    </div>
  );
}
