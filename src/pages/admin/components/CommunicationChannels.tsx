import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Button, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";

type ChannelStatus = { channel: "email" | "sms" | "whatsapp" | "teams"; connected: boolean; label: string; managed?: boolean };
const META: Record<ChannelStatus["channel"], { name: string; icon: string; about: string }> = {
  email: { name: "Email", icon: "ri-mail-line", about: "Sent through your existing email service. Always on." },
  sms: { name: "SMS (ClickSend)", icon: "ri-message-2-line", about: "Text messages to mobile numbers through your ClickSend account." },
  whatsapp: { name: "WhatsApp Business", icon: "ri-whatsapp-line", about: "WhatsApp messages through your WhatsApp Business (Meta) account." },
  teams: { name: "Microsoft Teams channels", icon: "ri-microsoft-line", about: "Staff team chats copied into Microsoft Teams channels (link a team in Teams › Manage)." },
};

/** Communication Hub > Channels: status only. Every account is connected and its details kept in Integrations › Connections. */
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-background-200 bg-background-50 p-4">
        <p className="max-w-2xl text-sm text-foreground-600">Only connected channels can be used to message people, and every message is recorded in the person's conversation. All external accounts and their details are kept in one place: <b>Integrations › Connections</b>.</p>
        <Link to="/admin/integrations" className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-sm font-medium text-background-50 hover:bg-primary-600"><i className="ri-plug-line" aria-hidden="true" />Manage in Integrations</Link>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((r) => <ChannelCard key={r.channel} row={r} />)}
      </div>
    </section>
  );
}

function ChannelCard({ row }: { row: ChannelStatus }) {
  const { push } = useToast();
  const m = META[row.channel];
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [testState, setTestState] = useState("");
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
      {!row.connected && row.channel !== "email" ? <p className="mt-2 text-sm"><Link className="font-medium text-primary-700 underline" to="/admin/integrations">Connect in Integrations</Link> (Add Connection › {m.name}).</p> : null}
      {row.connected && (row.channel === "sms" || row.channel === "whatsapp") ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <TextInput type="tel" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Your mobile, e.g. 0412 345 678" aria-label="Test phone number" className="min-w-0 flex-1" />
            <Button size="sm" variant="outline" disabled={busy || !testTo.trim()} onClick={() => void test()}>Send test</Button>
          </div>
          {testState ? <p className="text-xs text-foreground-700" role="status">{testState}</p> : null}
        </div>
      ) : null}
    </article>
  );
}
