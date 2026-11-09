import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Modal, Select, TextArea } from "@/pages/admin/components/ui";
import { cancelLeave, decideLeave, listLeave, type LeaveRequest, type LeaveStatus } from "@/lib/hrmsApi";
import { LEAVE_STATUS_LABEL, fmtDate, fmtDateTime, hoursLabel } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";

const LEAVE_TONE: Record<LeaveStatus, "warn" | "success" | "primary" | "muted"> = { pending: "warn", approved: "success", rejected: "primary", cancelled: "muted" };

export function LeaveStatusBadge({ status }: { status: LeaveStatus }) { return <Badge tone={LEAVE_TONE[status]}>{LEAVE_STATUS_LABEL[status]}</Badge>; }

/** Leave requests of the team (manager) or the company (HR) with approve / reject / cancel. */
export default function LeaveApprovals({ refreshKey = 0 }: { refreshKey?: number }) {
  const [status, setStatus] = useState<LeaveStatus | "">("pending");
  const [rows, setRows] = useState<LeaveRequest[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<{ row: LeaveRequest; kind: "approved" | "rejected" | "cancelled" } | null>(null);
  const [note, setNote] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setError(""); setRows((await listLeave({ status: status || null })).requests); }
    catch (e) { setError(e instanceof Error ? e.message : "The leave requests could not be loaded."); }
  }, [status]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const act = async () => {
    if (!dialog) return;
    setBusy(true); setDialogError("");
    try {
      if (dialog.kind === "cancelled") await cancelLeave(dialog.row.id, note); else await decideLeave(dialog.row.id, dialog.kind, note);
      setNotice(`${dialog.row.personName}: ${dialog.row.leaveTypeName} ${LEAVE_STATUS_LABEL[dialog.kind].toLowerCase()}.`);
      setDialog(null); setNote("");
      await load();
    } catch (e) { setDialogError(e instanceof Error ? e.message : "The decision could not be saved."); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" data-testid="leave-approvals">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Show"><Select value={status} onChange={(e) => setStatus(e.target.value as LeaveStatus | "")} data-testid="leave-filter-status">
          <option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option><option value="">All</option>
        </Select></Field>
      </div>
      {error ? <p role="alert" className={ALERT}>{error}</p> : null}
      {notice ? <p role="status" className={NOTICE} data-testid="leave-notice">{notice}</p> : null}
      {rows && !rows.length ? <p className="text-sm text-foreground-600" data-testid="leave-empty">No {status ? LEAVE_STATUS_LABEL[status].toLowerCase() : ""} leave requests.</p> : null}
      {rows && rows.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600"><tr>
              <th className="px-3 py-2">Employee</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Dates</th><th className="px-3 py-2 text-right">Hours</th><th className="px-3 py-2">Note</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" />
            </tr></thead>
            <tbody className="divide-y divide-background-200">
              {rows.map((r) => (
                <tr key={r.id} data-testid={`leave-row-${r.id}`} className="align-top">
                  <td className="px-3 py-2 font-medium text-foreground-900">{r.personName}</td>
                  <td className="px-3 py-2">{r.leaveTypeName}{r.isPaid ? "" : <span className="block text-xs text-foreground-500">unpaid</span>}</td>
                  <td className="px-3 py-2">{fmtDate(r.startDate)}{r.endDate !== r.startDate ? ` – ${fmtDate(r.endDate)}` : ""}<span className="block text-xs text-foreground-500">{r.days.length} day{r.days.length === 1 ? "" : "s"} · requested {fmtDateTime(r.createdAt)}</span></td>
                  <td className="px-3 py-2 text-right">{hoursLabel(r.hours)}</td>
                  <td className="px-3 py-2 text-foreground-700">{r.note}{r.decisionNote ? <span className="block text-xs text-foreground-500">Decision: {r.decisionNote}</span> : null}</td>
                  <td className="px-3 py-2"><LeaveStatusBadge status={r.status} /></td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap gap-1">
                      {r.status === "pending" ? <>
                        <Button size="sm" onClick={() => { setDialog({ row: r, kind: "approved" }); setNote(""); setDialogError(""); }} data-testid={`leave-approve-${r.id}`}>Approve</Button>
                        <Button size="sm" variant="outline" onClick={() => { setDialog({ row: r, kind: "rejected" }); setNote(""); setDialogError(""); }} data-testid={`leave-reject-${r.id}`}>Reject</Button>
                      </> : null}
                      {r.status === "pending" || r.status === "approved" ? <Button size="sm" variant="ghost" onClick={() => { setDialog({ row: r, kind: "cancelled" }); setNote(""); setDialogError(""); }} data-testid={`leave-cancel-${r.id}`}>Cancel</Button> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Modal open={dialog !== null} title={dialog?.kind === "approved" ? "Approve leave" : dialog?.kind === "rejected" ? "Reject leave" : "Cancel leave"} onClose={() => setDialog(null)}
        footer={<><Button variant="outline" onClick={() => setDialog(null)}>Back</Button><Button disabled={busy} onClick={() => void act()} data-testid="leave-decision-confirm">{dialog?.kind === "approved" ? "Approve" : dialog?.kind === "rejected" ? "Reject" : "Cancel the leave"}</Button></>}>
        {dialog ? (
          <div className="space-y-3" data-testid="leave-decision-dialog">
            <p className="text-sm text-foreground-800">{dialog.row.personName}: {dialog.row.leaveTypeName}, {fmtDate(dialog.row.startDate)}{dialog.row.endDate !== dialog.row.startDate ? ` – ${fmtDate(dialog.row.endDate)}` : ""}, {hoursLabel(dialog.row.hours)}.</p>
            <Field label="Note (optional)"><TextArea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="leave-decision-note" /></Field>
            {dialogError ? <p role="alert" className={ALERT} data-testid="leave-decision-error">{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
