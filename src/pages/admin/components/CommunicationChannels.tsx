import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";

type ChannelStatus = { channel: "email" | "sms" | "whatsapp" | "teams"; connected: boolean; label: string; managed?: boolean; connectedAt?: string | null };
const META: Record<ChannelStatus["channel"], { name: string; icon: string; about: string }> = {
  email: { name: "Email", icon: "ri-mail-line", about: "Sent through your existing email service. Always on." },
  sms: { name: "SMS (ClickSend)", icon: "ri-message-2-line", about: "Text messages to mobile numbers through your ClickSend account." },
  whatsapp: { name: "WhatsApp Business", icon: "ri-whatsapp-line", about: "WhatsApp messages through your WhatsApp Business (Meta) account." },
  teams: { name: "Microsoft Teams", icon: "ri-microsoft-line", about: "Staff team chats copied into Microsoft Teams channels. Link a channel from Teams › Manage." },
};

/** Communication Hub > Channels: only connected accounts can be used to message people. Details are stored privately and never shown again. */
export default function CommunicationChannels() {
  const [rows, setRows] = useState<ChannelStatus[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("comm_channels_status");
    setError(error?.message ?? "");
    if (!error) setRows((data ?? []) as ChannelStatus[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error) return <p role="alert" className="rounded-xl border border-red-300 p-4">Could not load channels: {error}</p>;
  return (
    <section className="space-y-3">
      <p className="text-sm text-foreground-600">Only connected channels can be used to message people, and every message sent is recorded in the person's conversation. Account details are stored privately and are never shown again after saving.</p>
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((r) => <ChannelCard key={r.channel} row={r} onChanged={() => void load()} />)}
      </div>
    </section>
  );
}

function ChannelCard({ row, onChanged }: { row: ChannelStatus; onChanged: () => void }) {
  const { push } = useToast();
  const m = META[row.channel];
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [c, setC] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testState, setTestState] = useState("");
  const editable = row.channel === "sms" || row.channel === "whatsapp";

  const save = async () => {
    setBusy(true);
    const { error } = row.channel === "sms"
      ? await supabase.rpc("comm_channel_connect_sms", { p_username: a, p_api_key: b, p_sender: c || null })
      : await supabase.rpc("comm_channel_connect_whatsapp", { p_phone_number_id: a, p_access_token: b, p_display_number: c || null });
    setBusy(false);
    if (error) { push(error.message, "error"); return; }
    push(`${m.name} connected. Send a test message to check it.`);
    setA(""); setB(""); setC(""); setEditing(false);
    onChanged();
  };
  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${m.name}? It will no longer be available in conversations.`)) return;
    setBusy(true);
    const { error } = await supabase.rpc("comm_channel_disconnect", { p_channel: row.channel });
    setBusy(false);
    if (error) { push(error.message, "error"); return; }
    push(`${m.name} disconnected.`);
    onChanged();
  };
  const test = async () => {
    setBusy(true); setTestState("Sending test…");
    const { data, error } = await supabase.rpc("comm_channel_test", { p_channel: row.channel, p_phone: testTo });
    if (error) { setBusy(false); setTestState(""); push(error.message, "error"); return; }
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await supabase.rpc("comm_channel_test_result", { p_channel: row.channel, p_request: data });
      const out = res.data as { status: string; reason?: string } | null;
      if (out && out.status !== "sending") { setTestState(out.status === "sent" ? "Test sent. Check the phone." : `Not delivered: ${out.reason ?? "unknown reason"}`); setBusy(false); return; }
    }
    setTestState("Still waiting for the provider. Check the phone in a minute."); setBusy(false);
  };

  return (
    <article className="rounded-xl border border-background-200 bg-background-50 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold"><i className={m.icon} aria-hidden="true" />{m.name}</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${row.connected ? "bg-primary-100 text-primary-800" : "bg-background-200 text-foreground-600"}`}>{row.connected ? "Connected" : "Not connected"}</span>
      </div>
      <p className="mt-1 text-sm text-foreground-600">{m.about}</p>
      {row.connected && row.label ? <p className="mt-1 text-xs text-foreground-500">{row.label}</p> : null}

      {editable && row.connected && !editing ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <TextInput type="tel" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Your mobile, e.g. 0412 345 678" aria-label="Test phone number" className="min-w-0 flex-1" />
            <Button size="sm" variant="outline" disabled={busy || !testTo.trim()} onClick={() => void test()}>Send test</Button>
          </div>
          {testState ? <p className="text-xs text-foreground-700" role="status">{testState}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>Replace details</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
          </div>
        </div>
      ) : null}

      {editable && (!row.connected || editing) ? (
        <div className="mt-3 space-y-3">
          {row.channel === "sms" ? <>
            <Field label="ClickSend API username" required hint="ClickSend dashboard › Developers › API Credentials."><TextInput value={a} onChange={(e) => setA(e.target.value)} autoComplete="off" /></Field>
            <Field label="ClickSend API key" required><TextInput type="password" value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" /></Field>
            <Field label="Sender name (optional)" hint="Up to 11 letters or numbers, e.g. Skyline. Register it with ClickSend first for Australian numbers."><TextInput value={c} onChange={(e) => setC(e.target.value)} maxLength={16} /></Field>
          </> : <>
            <Field label="Phone number ID" required hint="Meta for Developers › your app › WhatsApp › API Setup."><TextInput value={a} onChange={(e) => setA(e.target.value)} inputMode="numeric" autoComplete="off" /></Field>
            <Field label="Permanent access token" required hint="A System User token from Meta Business Settings with the whatsapp_business_messaging permission."><TextInput type="password" value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" /></Field>
            <Field label="Your WhatsApp business number (optional, for display)"><TextInput value={c} onChange={(e) => setC(e.target.value)} /></Field>
            <p className="text-xs text-foreground-500">WhatsApp only delivers a free message to someone who messaged your business in the last 24 hours. Otherwise Meta refuses it and the conversation shows "Not delivered".</p>
          </>}
          <div className="flex gap-2">
            <Button disabled={busy || !a.trim() || !b.trim()} onClick={() => void save()}>{row.connected ? "Save new details" : "Connect"}</Button>
            {editing ? <Button variant="outline" onClick={() => { setEditing(false); setA(""); setB(""); setC(""); }}>Cancel</Button> : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}
