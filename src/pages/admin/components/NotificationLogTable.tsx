import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Badge, Card, EmptyState, Select, TextInput } from "@/pages/admin/components/ui";
import { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_LABELS } from "@/lib/notificationEvents";

const PAGE_SIZE = 25;

interface LogRow {
  id: string;
  at: string;
  event: keyof typeof NOTIFICATION_EVENT_LABELS;
  applicationId: string;
  reference: string;
  recipient: string;
  role: string;
  status: "queued" | "sent" | "failed" | "blocked";
  reason: string | null;
  attempts: number;
  error: string | null;
}

const STATUS_TONE: Record<LogRow["status"], "success" | "muted" | "warn" | "secondary"> = { sent: "success", queued: "secondary", failed: "warn", blocked: "muted" };
const REASONS: Record<string, string> = {
  legacy_scope_not_activated: "sending is not approved yet",
  recipient_opted_out: "recipient opted out",
  invalid_recipient: "no valid address",
  provider_unavailable: "email provider is not configured",
  sender_unconfigured: "no approved sender",
  attachment_unavailable: "attachment could not be loaded",
};
const describe = (code: string | null) => (code ? REASONS[code] ?? code.replace(/_/g, " ") : "");
const time = (value: string) => new Date(value).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** The notification outbox for administrators: one row per recipient, filtered and paged by the database. Pinned to one application when given. */
export default function NotificationLogTable({ applicationId }: { applicationId?: string }) {
  const [event, setEvent] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [previousApplication, setPreviousApplication] = useState(applicationId);
  if (previousApplication !== applicationId) { setPreviousApplication(applicationId); setPage(1); setRows([]); }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void (async () => {
      const { data, error: failure } = await supabase.rpc("notification_log_query", {
        p_event: event, p_status: status,
        p_from: from ? new Date(`${from}T00:00:00`).toISOString() : null,
        p_to: to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : null,
        p_application: applicationId ?? null, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE,
      });
      if (!active) return;
      setLoading(false);
      if (failure) {
        if (failure.code === "PGRST202" || failure.code === "42883") setUnavailable(true);
        else setError(failure.code === "42501" ? "Only administrators can see the notification log." : failure.message);
        return;
      }
      setUnavailable(false);
      setRows((data?.rows ?? []) as LogRow[]);
      setTotal(Number(data?.total ?? 0));
    })();
    return () => { active = false; };
  }, [event, status, from, to, page, applicationId]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const reset = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPage(1); };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Select aria-label="Filter by event" value={event} onChange={(e) => reset(setEvent)(e.target.value)}>
            <option value="">All events</option>
            {NOTIFICATION_EVENTS.map((key) => <option key={key} value={key}>{NOTIFICATION_EVENT_LABELS[key].title}</option>)}
          </Select>
          <Select aria-label="Filter by status" value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="blocked">Blocked</option>
          </Select>
          <TextInput type="date" aria-label="From date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
          <TextInput type="date" aria-label="To date" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
        </div>
      </Card>

      <Card>
        {unavailable ? (
          <p role="status" className="p-6 text-sm text-foreground-600">The notification log is not available on this database yet. It appears once the latest database update is released.</p>
        ) : error ? (
          <p role="alert" className="p-6 text-sm text-red-700">{error}</p>
        ) : !loading && rows.length === 0 ? (
          <EmptyState icon="ri-mail-line" title="No notifications" description="Nothing matches these filters. Notifications appear here when an application is submitted or changes status." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm" aria-busy={loading}>
              <thead>
                <tr className="border-b border-background-200 text-xs uppercase text-foreground-500">
                  <th className="p-3">Time</th><th className="p-3">Event</th>{applicationId ? null : <th className="p-3">Application</th>}
                  <th className="p-3">Recipient</th><th className="p-3">Status</th><th className="p-3">Attempts</th><th className="p-3">Last error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-background-200">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="p-3 text-xs text-foreground-600">{time(row.at)}</td>
                    <td className="p-3 text-xs">{NOTIFICATION_EVENT_LABELS[row.event]?.title ?? row.event}</td>
                    {applicationId ? null : (
                      <td className="p-3 text-xs"><Link className="font-semibold text-primary-700 hover:underline" to={`/admin/applications/${row.applicationId}`}>{row.reference || row.applicationId.slice(0, 8)}</Link></td>
                    )}
                    <td className="p-3 text-xs"><span className="break-all">{row.recipient}</span><span className="ml-1 text-foreground-500">({row.role})</span></td>
                    <td className="p-3"><Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>{row.status === "blocked" && row.reason ? <div className="mt-1 text-[11px] text-foreground-500">{describe(row.reason)}</div> : null}</td>
                    <td className="p-3 text-xs">{row.attempts}</td>
                    <td className="p-3 text-xs text-foreground-600">{row.status === "failed" ? describe(row.error) || "—" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between border-t border-background-200 p-4 text-xs text-foreground-600">
            <span>Page {Math.min(page, pages)} of {pages} · {total} notifications</span>
            <span className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="cursor-pointer rounded border border-background-300 px-3 py-1 font-semibold disabled:opacity-50">Previous</button>
              <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="cursor-pointer rounded border border-background-300 px-3 py-1 font-semibold disabled:opacity-50">Next</button>
            </span>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
