import { useCallback, useEffect, useState } from "react";
import { Button, Field, Select, TextArea, TextInput } from "@/pages/admin/components/ui";

import { cancelLeave, myLeave, requestLeave, type MyLeave as MyLeaveData } from "@/lib/hrmsApi";
import { LEAVE_STATUS_LABEL, fmtDate, hoursLabel } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
const TONE: Record<string, string> = { pending: "bg-amber-50 text-amber-900", approved: "bg-secondary-50 text-secondary-900", rejected: "bg-primary-50 text-primary-900", cancelled: "bg-background-200 text-foreground-700" };

/** My HR > Leave: balances, a request (days or hours), the history with cancel. */
export default function MyLeave() {
  const [data, setData] = useState<MyLeaveData | null>(null);
  const [form, setForm] = useState({ leaveTypeId: "", startDate: "", endDate: "", unit: "days" as "days" | "hours", quantity: "", note: "" });
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setError(""); const d = await myLeave(); setData(d); setForm((f) => ({ ...f, leaveTypeId: f.leaveTypeId || d.types[0]?.id || "" })); }
    catch (e) { setError(e instanceof Error ? e.message : "Your leave could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const send = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await requestLeave({ leaveTypeId: form.leaveTypeId, startDate: form.startDate, endDate: form.endDate || form.startDate, unit: form.unit, quantity: form.quantity ? Number(form.quantity) : null, note: form.note });
      setNotice(`${r.leaveTypeName} requested for ${fmtDate(r.startDate)}${r.endDate !== r.startDate ? ` – ${fmtDate(r.endDate)}` : ""} (${hoursLabel(r.hours)}). Your manager will review it.`);
      patch({ startDate: "", endDate: "", quantity: "", note: "" }); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "The leave request could not be sent."); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => {
    setBusy(true); setError("");
    try { await cancelLeave(id); setNotice("The request was cancelled."); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "The request could not be cancelled."); }
    finally { setBusy(false); }
  };
  const type = data?.types.find((t) => t.id === form.leaveTypeId);
  return (
    <div data-testid="my-hr-leave">
      {error ? <p role="alert" className={`mb-3 ${ALERT}`} data-testid="my-leave-error">{error}</p> : null}
      {notice ? <p role="status" className={`mb-3 ${NOTICE}`} data-testid="my-leave-notice">{notice}</p> : null}
      {!data ? <p className="text-sm text-foreground-600">Loading…</p> : (
        <>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-600">Balances</h3>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2" data-testid="my-leave-balances">
            {data.balances.filter((b) => b.requiresBalance || b.accrualMethod === "entitlement").map((b) => (
              <li key={b.leaveTypeId} className="flex items-center justify-between rounded-md bg-background-100 px-3 py-2 text-sm" data-testid={`my-leave-balance-${b.code}`}>
                <span className="text-foreground-800">{b.name}</span>
                <span className="font-semibold text-foreground-950">{hoursLabel(b.availableHours ?? b.balanceHours)}{Number(b.pendingHours) ? <span className="ml-1 text-xs font-normal text-foreground-500">({hoursLabel(b.pendingHours)} pending)</span> : null}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-foreground-500">A day of leave is {hoursLabel(data.dailyHours)}. Balances grow when each pay period is finalised.</p>

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-foreground-600">Request leave</h3>
          <div className="mt-1 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Leave type"><Select value={form.leaveTypeId} onChange={(e) => patch({ leaveTypeId: e.target.value })} data-testid="my-leave-type">{data.types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isPaid ? "" : " (unpaid)"}</option>)}</Select></Field>
            <Field label="First day" required><TextInput type="date" value={form.startDate} onChange={(e) => patch({ startDate: e.target.value })} data-testid="my-leave-start" /></Field>
            <Field label="Last day"><TextInput type="date" value={form.endDate} min={form.startDate} onChange={(e) => patch({ endDate: e.target.value })} data-testid="my-leave-end" /></Field>
            <Field label="Request in"><Select value={form.unit} onChange={(e) => patch({ unit: e.target.value as "days" | "hours" })} data-testid="my-leave-unit"><option value="days">Days</option><option value="hours">Hours</option></Select></Field>
            <Field label={form.unit === "days" ? "Days (blank = all your work days in the range)" : "Hours"}><TextInput type="number" step="0.25" min="0" value={form.quantity} onChange={(e) => patch({ quantity: e.target.value })} data-testid="my-leave-quantity" /></Field>
            <Field label="Note"><TextInput value={form.note} maxLength={1000} onChange={(e) => patch({ note: e.target.value })} data-testid="my-leave-note" /></Field>
          </div>
          {type?.description ? <p className="mt-1 text-xs text-foreground-500">{type.description}</p> : null}
          <div className="mt-2"><Button disabled={busy || !form.startDate || !form.leaveTypeId} onClick={() => void send()} data-testid="my-leave-send">{busy ? "Sending…" : "Send request"}</Button></div>

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-foreground-600">Your requests</h3>
          {data.requests.length ? (
            <ul className="mt-1 divide-y divide-background-200" data-testid="my-leave-requests">
              {data.requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-testid={`my-leave-request-${r.id}`}>
                  <span className="text-foreground-800">{r.leaveTypeName}: {fmtDate(r.startDate)}{r.endDate !== r.startDate ? ` – ${fmtDate(r.endDate)}` : ""} · {hoursLabel(r.hours)}{r.decisionNote ? <span className="block text-xs text-foreground-500">{r.decisionNote}</span> : null}</span>
                  <span className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[r.status]}`} data-testid={`my-leave-status-${r.id}`}>{LEAVE_STATUS_LABEL[r.status]}</span>
                    {r.status === "pending" || (r.status === "approved" && r.startDate > new Date().toISOString().slice(0, 10)) ? <button type="button" className="cursor-pointer text-xs font-semibold text-primary-700 hover:underline" disabled={busy} onClick={() => void cancel(r.id)} data-testid={`my-leave-cancel-${r.id}`}>Cancel</button> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-1 text-sm text-foreground-600">No leave requests yet.</p>}
        </>
      )}
    </div>
  );
}
