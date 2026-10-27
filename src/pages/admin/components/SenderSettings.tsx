import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { useToast } from "@/pages/admin/components/toastContext";
import { Badge, Button, Card, Field, TextInput } from "@/pages/admin/components/ui";

interface SenderState {
  resolved: { name: string; email: string; replyTo?: string } | null;
  override: { email: string; name: string | null; replyTo: string | null } | null;
  domains: string[];
  canVerifyDomains: boolean;
}

/** Email sender for one organization (tenantId) or the legacy Skyline scope (null). The database enforces who may change it and which addresses are allowed. */
export default function SenderSettings({ tenantId }: { tenantId: string | null }) {
  const { push } = useToast();
  const [state, setState] = useState<SenderState | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [domain, setDomain] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("notification_sender_state", { p_tenant: tenantId });
    if (error || !data) { setState(null); return; } // not an organization administrator: the section stays hidden
    const next = data as SenderState;
    setState(next);
    setEmail(next.override?.email ?? next.resolved?.email ?? "");
    setName(next.override?.name ?? "");
    setReplyTo(next.override?.replyTo ?? "");
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (command: string, args: Record<string, unknown>, done: string) => {
    setBusy(true);
    const { error } = await supabase.rpc(command, args);
    setBusy(false);
    if (error) { push(error.code === "42501" ? "You do not have permission to do that." : error.message || "The change could not be saved.", "error"); return; }
    push(done);
    await load();
  };

  if (!state) return null;
  return (
    <Card className="p-5">
      <h3 className="text-sm font-semibold">Email sender</h3>
      <p className="mt-1 text-sm text-background-600">
        {state.resolved ? <>Emails are sent as <strong>{state.resolved.name}</strong> &lt;{state.resolved.email}&gt;.</> : <Badge tone="warn">No valid sender: emails fail safely and nothing is sent</Badge>}
      </p>
      <p className="mt-1 text-xs text-background-600">The address must be on a verified domain below and the same address or domain must be verified in Postmark. The name defaults to the organization name.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="From address"><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="From name (optional)"><TextInput value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Reply-To (optional)"><TextInput type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} /></Field>
      </div>
      <div className="mt-3"><Button disabled={busy || !email.trim()} onClick={() => void run("notification_save_sender", { p_tenant: tenantId, p_email: email, p_name: name, p_reply_to: replyTo }, "Sender saved")}>Save sender</Button></div>
      <p className="mt-4 text-xs text-background-600">Verified sender domains: {state.domains.length ? state.domains.join(", ") : "none"}</p>
      {state.canVerifyDomains && (
        <div className="mt-2 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Verify a domain"><TextInput value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.edu.au" /></Field>
          <Field label="Note (how it was verified)"><TextInput value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
          <Button variant="outline" disabled={busy || !domain.trim() || !note.trim()} onClick={() => void run("notification_set_sender_domain", { p_tenant: tenantId, p_domain: domain, p_verified: true, p_note: note }, "Domain verified").then(() => { setDomain(""); setNote(""); })}>Verify domain</Button>
        </div>
      )}
    </Card>
  );
}
