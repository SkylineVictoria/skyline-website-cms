import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { useToast } from "@/pages/admin/components/toastContext";
import SenderSettings from "@/pages/admin/components/SenderSettings";
import EventRecipients from "@/pages/admin/components/EventRecipients";
import { AdminError, AdminLoading, Badge, Button, Card, EmptyState, Field, Modal, TextInput } from "@/pages/admin/components/ui";

interface Delivery { id: string; event: string; recipient: string; state?: string; attempts: number; errorCode: string | null; at: string }
interface Overview {
  activated: boolean;
  isPlatformAdmin: boolean;
  sender: { configured: string | null; allowed: boolean; approved: string[] };
  counts: Record<string, number>;
  review: Delivery[];
  recent: Delivery[];
}

const STATE_TONE: Record<string, "success" | "warn" | "muted" | "primary"> = { sent: "success", delivered: "success", pending: "primary", sending: "primary", suppressed: "muted", failed: "warn", bounced: "warn", complained: "warn", unknown: "warn" };
const EVENT_LABEL: Record<string, string> = { application_submitted: "Application submitted", application_status_changed: "Status changed", offer_accepted: "Offer accepted", coe_voe_issued: "CoE / VoE issued" };

function reason(error: { code?: string; message?: string }): string {
  if (error.code === "42501") return "You do not have permission to do that.";
  if (error.code === "22023" || error.code === "P0002") return error.message ?? "That value is not valid.";
  return "The change could not be saved. Please try again.";
}

/** Administrator view of email deliveries: recovery decisions, sender ownership and the owner activation switch. */
export default function DeliveriesPanel({ tenantId }: { tenantId: string }) {
  const { push } = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ delivery: Delivery; action: "retry" | "abandon" } | null>(null);
  const [why, setWhy] = useState("");
  const [note, setNote] = useState("");
  const [senderEmail, setSenderEmail] = useState("");

  const load = useCallback(async () => {
    const { data: overview, error } = await supabase.rpc("tenant_notification_overview", { p_tenant: tenantId });
    if (error || !overview) { setFailed(true); return; }
    setFailed(false);
    setData(overview as Overview);
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);

  const call = async (command: string, args: Record<string, unknown>, done: string) => {
    setBusy(true);
    const { error } = await supabase.rpc(command, args);
    setBusy(false);
    if (error) { push(reason(error), "error"); return false; }
    push(done);
    await load();
    return true;
  };

  if (failed) return <AdminError message="Delivery information is unavailable for this account." onRetry={() => void load()} />;
  if (!data) return <AdminLoading label="Loading deliveries…" />;

  const senderMode = !data.sender.configured ? "set below (organization name and address)" : data.sender.allowed ? "Institution sender" : "not approved, so emails fail safely until it is";

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={data.activated ? "success" : "warn"}>{data.activated ? "Email sending approved" : "Email sending not yet approved"}</Badge>
          <span className="text-sm text-background-600">Sender: {senderMode}{data.sender.configured ? ` (${data.sender.configured})` : ""}</span>
        </div>
        {!data.activated && <p className="mt-2 text-sm text-background-600">Notifications are queued but nothing is sent until a platform administrator has reviewed the templates and sender and approved sending.</p>}
        {data.isPlatformAdmin && (
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Review note (recorded in the audit history)"><TextInput value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
            <Button variant={data.activated ? "danger" : "primary"} disabled={busy || !note.trim()} onClick={async () => { if (await call("notification_set_activation", { p_tenant: tenantId, p_active: !data.activated, p_note: note }, data.activated ? "Sending paused" : "Sending approved")) setNote(""); }}>{data.activated ? "Pause sending" : "Approve sending"}</Button>
          </div>
        )}
        {data.isPlatformAdmin && (
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Approve a sender address for this institution" hint="Addresses on a verified institution hostname are allowed without approval."><TextInput type="email" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} /></Field>
            <Button variant="outline" disabled={busy || !senderEmail.trim() || !note.trim()} onClick={async () => { if (await call("tenant_set_notification_sender", { p_tenant: tenantId, p_email: senderEmail, p_approved: true, p_note: note }, "Sender approved")) setSenderEmail(""); }}>Approve sender</Button>
          </div>
        )}
        {data.sender.approved.length > 0 && <p className="mt-3 text-xs text-background-600">Approved senders: {data.sender.approved.join(", ")}</p>}
      </Card>

      <SenderSettings tenantId={tenantId} />

      <EventRecipients tenantId={tenantId} />

      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold">Last 30 days</h3>
        {Object.keys(data.counts).length === 0 ? <EmptyState title="No deliveries yet" /> : (
          <div className="flex flex-wrap gap-2">{Object.entries(data.counts).map(([state, n]) => <Badge key={state} tone={STATE_TONE[state] ?? "muted"}>{state}: {n}</Badge>)}</div>
        )}
      </Card>

      {data.review.length > 0 && (
        <Card className="p-5">
          <h3 className="mb-1 text-sm font-semibold">Needs review</h3>
          <p className="mb-3 text-sm text-background-600">The email provider did not confirm these. They may or may not have been sent, so they are never resent automatically.</p>
          <ul className="divide-y divide-background-200">
            {data.review.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <span>{EVENT_LABEL[d.event] ?? d.event} · {d.recipient} · {d.attempts} attempt(s) · {d.errorCode ?? "unknown"}</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => { setWhy(""); setPending({ delivery: d, action: "retry" }); }}>Send again</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setWhy(""); setPending({ delivery: d, action: "abandon" }); }}>Close</Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold">Recent deliveries</h3>
        {data.recent.length === 0 ? <EmptyState title="Nothing to show" /> : (
          <ul className="divide-y divide-background-200">
            {data.recent.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                <span>{EVENT_LABEL[d.event] ?? d.event} · {d.recipient} · {new Date(d.at).toLocaleString()}</span>
                <Badge tone={STATE_TONE[d.state ?? ""] ?? "muted"}>{d.state}{d.errorCode ? ` (${d.errorCode})` : ""}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={pending !== null}
        title={pending?.action === "retry" ? "Send this email again?" : "Close this delivery?"}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPending(null)}>Cancel</Button>
            <Button variant={pending?.action === "retry" ? "primary" : "danger"} disabled={busy || !why.trim()} onClick={async () => {
              if (!pending) return;
              const { delivery, action } = pending;
              setPending(null);
              await call("tenant_notification_resolve", { p_tenant: tenantId, p_delivery: delivery.id, p_action: action, p_reason: why }, action === "retry" ? "Queued to send again" : "Delivery closed");
            }}>{pending?.action === "retry" ? "Send again" : "Close delivery"}</Button>
          </>
        }
      >
        <p className="mb-3 text-sm">
          {pending?.action === "retry"
            ? "The recipient may receive this email twice if the first attempt did reach them. Confirm only after checking."
            : "The delivery will be marked failed and will not be sent."}
        </p>
        <Field label="Reason (recorded in the audit history)" required><TextInput value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}
