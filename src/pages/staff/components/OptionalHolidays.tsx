import { useCallback, useEffect, useState } from "react";
import { Button, Select } from "@/pages/admin/components/ui";
import { cancelOptionalHoliday, myOptionalHolidays, pickOptionalHoliday, type MyOptionalHolidays } from "@/lib/hrmsApi";
import { LEAVE_STATUS_LABEL, fmtDate, isoToday } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
const TONE: Record<string, string> = { pending: "bg-amber-50 text-amber-900", approved: "bg-secondary-50 text-secondary-900", rejected: "bg-primary-50 text-primary-900", cancelled: "bg-background-200 text-foreground-700" };

/** My HR > Optional holidays: the year's optional days (Diwali, Eid, ...), pick up to HR's allowance; the manager or HR approves. */
export default function OptionalHolidays() {
  const thisYear = Number(isoToday().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState<MyOptionalHolidays | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try { setError(""); setData(await myOptionalHolidays(year)); } catch (e) { setError(e instanceof Error ? e.message : "Your optional holidays could not be loaded."); }
  }, [year]);
  useEffect(() => { void load(); }, [load]);

  const pick = async (holidayId: string, name: string) => {
    setBusy(holidayId); setError(""); setNotice("");
    try { await pickOptionalHoliday(holidayId); setNotice(`${name} requested. Your manager or HR will approve it.`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "The optional holiday could not be picked."); }
    finally { setBusy(""); }
  };
  const cancel = async (requestId: string, name: string) => {
    setBusy(requestId); setError(""); setNotice("");
    try { await cancelOptionalHoliday(requestId); setNotice(`${name} cancelled.`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "The request could not be cancelled."); }
    finally { setBusy(""); }
  };

  return (
    <div data-testid="my-hr-optional-holidays">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm text-foreground-700">Year
          <Select className="mt-1 w-28" value={year} onChange={(e) => setYear(Number(e.target.value))} data-testid="my-optional-year">{[thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}</Select>
        </label>
        {data ? <p className="text-sm text-foreground-700" data-testid="my-optional-allowance">
          {data.allowance ? <>You may take <strong>{data.allowance}</strong> optional holiday{data.allowance === 1 ? "" : "s"} in {data.year} ({data.isPaid ? "paid" : "unpaid"}); <strong>{data.used}</strong> picked, <strong>{data.remaining}</strong> left.</> : <>HR has not set an optional holiday allowance for {data.year} yet.</>}
        </p> : null}
      </div>
      {error ? <p role="alert" className={`mt-3 ${ALERT}`} data-testid="my-optional-error">{error}</p> : null}
      {notice ? <p role="status" className={`mt-3 ${NOTICE}`} data-testid="my-optional-notice">{notice}</p> : null}
      {!data ? <p className="mt-3 text-sm text-foreground-600">Loading…</p> : data.holidays.length ? (
        <ul className="mt-3 divide-y divide-background-200" data-testid="my-optional-list">
          {data.holidays.map((h) => {
            const r = h.request;
            const past = h.date < data.today;
            return (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-testid={`my-optional-${h.date}`}>
                <span className="text-foreground-800">{fmtDate(h.date)} · {h.name}{h.note ? <span className="block text-xs text-foreground-500">{h.note}</span> : null}</span>
                <span className="flex items-center gap-2">
                  {r ? <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[r.status]}`} data-testid={`my-optional-status-${h.date}`}>{LEAVE_STATUS_LABEL[r.status]}</span> : null}
                  {r ? (r.status === "pending" || (r.status === "approved" && !past) ? <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void cancel(r.id, h.name)} data-testid={`my-optional-cancel-${h.date}`}>Cancel</Button> : null)
                    : past ? <span className="text-xs text-foreground-500">Passed</span>
                    : <Button size="sm" variant="outline" disabled={busy === h.id || !data.allowance || data.remaining === 0} onClick={() => void pick(h.id, h.name)} data-testid={`my-optional-pick-${h.date}`}>Take this day</Button>}
                </span>
              </li>
            );
          })}
        </ul>
      ) : <p className="mt-3 text-sm text-foreground-600">No optional holidays are listed for {data.year}.</p>}
      {data && data.requests.some((r) => r.status === "rejected" || r.status === "cancelled") ? (
        <p className="mt-2 text-xs text-foreground-500" data-testid="my-optional-history">
          Earlier: {data.requests.filter((r) => r.status === "rejected" || r.status === "cancelled").map((r) => `${r.name} (${fmtDate(r.date)}) ${LEAVE_STATUS_LABEL[r.status].toLowerCase()}${r.decisionNote ? `: ${r.decisionNote}` : ""}`).join("; ")}.
        </p>
      ) : null}
    </div>
  );
}
