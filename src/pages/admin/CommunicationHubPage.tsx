import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import CommunicationTemplates from "@/pages/admin/components/CommunicationTemplates";
import CommunicationInbox from "@/pages/admin/components/CommunicationInbox";

type Notice = { id: string; title: string | null; message: string | null; event: string | null; created_at: string | null; application_id: string | null };
const sections = ["Conversations", "Templates", "Activity", "Channels"] as const;
type Section = typeof sections[number];

export default function CommunicationHubPage() {
  const [section, setSection] = useState<Section>("Conversations");
  const [items, setItems] = useState<Notice[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    void supabase.from("portal_notifications").select("id,title,message,event,created_at,application_id").order("created_at", { ascending: false }).limit(100).then(({ data, error }) => {
      if (!active) return;
      setItems((data ?? []) as Notice[]);
      setError(error?.message ?? "");
      setBusy(false);
    });
    return () => { active = false; };
  }, []);
  const filtered = items.filter(n => [n.title,n.message,n.event].some(s => (s ?? "").toLowerCase().includes(query.toLowerCase())));
  return <main className="mx-auto max-w-6xl space-y-6 pb-12">
    <header><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Shared services</p>
      <h1 className="mt-1 font-heading text-3xl font-bold text-foreground-950">Communication Hub</h1>
      <p className="mt-2 text-sm text-foreground-600">Talk to students, agents, staff and applicants from one place. Every message is recorded in the person's conversation.</p>
    </header>
    <nav className="flex flex-wrap gap-2" aria-label="Communication sections">{sections.map(s =>
      <button key={s} type="button" onClick={() => setSection(s)} aria-current={section === s ? "page" : undefined}
        className={`rounded-lg px-4 py-2 text-sm font-semibold ${section === s ? "bg-primary-500 text-white" : "border border-background-200 bg-background-50 text-foreground-700"}`}>{s}</button>)}</nav>
    {section === "Conversations" ? <CommunicationInbox /> : section === "Activity" ? <section className="space-y-4">
      <div className="rounded-xl border border-background-200 bg-background-50 p-4">
        <h2 className="font-semibold">Portal notification activity</h2>
        <p className="mt-1 text-sm text-foreground-600">Read-only events from the existing portal notification system. This is not yet a two-way email or WhatsApp inbox.</p>
        <label htmlFor="communication-search" className="mt-4 block text-sm font-medium">Search notifications</label>
        <input id="communication-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search subject or message" className="mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2" />
      </div>
      {busy ? <p role="status">Loading notifications…</p> : error ? <p role="alert" className="rounded-lg border border-red-300 p-4">Unable to load notification activity: {error}</p> : filtered.length === 0 ? <p className="rounded-xl border border-background-200 p-6 text-foreground-600">No matching notifications found.</p> :
      <div className="space-y-2">{filtered.map(n => <article key={n.id} className="rounded-xl border border-background-200 bg-background-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{n.title || n.event || "Notification"}</h3><time className="text-xs text-foreground-500">{n.created_at ? new Date(n.created_at).toLocaleString() : ""}</time></div>
        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground-700">{n.message || "No message text"}</p>
        {n.application_id ? <Link className="mt-2 inline-block text-sm font-medium text-primary-600 underline" to={`/admin/applications/${n.application_id}`}>View application</Link> : null}
      </article>)}</div>}
    </section> : section === "Templates" ? <CommunicationTemplates /> : section === "Channels" ? <ChannelsStatus /> : null}
  </main>;
}

const CHANNEL_STATUS: { name: string; icon: string; connected: boolean; note: string }[] = [
  { name: "Email", icon: "ri-mail-line", connected: true, note: "Sent through your existing email service. Messages show as Sent within about a minute." },
  { name: "SMS", icon: "ri-message-2-line", connected: false, note: "Needs a ClickSend account. Until then, text messages are recorded in the conversation but not sent." },
  { name: "WhatsApp", icon: "ri-whatsapp-line", connected: false, note: "Needs a WhatsApp Business account. Until then, WhatsApp messages are recorded but not sent." },
  { name: "Replies", icon: "ri-reply-line", connected: false, note: "Replies from people will appear in their conversation once inbound email and SMS are set up." },
];

function ChannelsStatus() {
  return <section className="grid gap-3 md:grid-cols-2">{CHANNEL_STATUS.map(c =>
    <article key={c.name} className="rounded-xl border border-background-200 bg-background-50 p-4">
      <div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 font-semibold"><i className={c.icon} aria-hidden="true" />{c.name}</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.connected ? "bg-primary-100 text-primary-800" : "bg-background-200 text-foreground-600"}`}>{c.connected ? "Connected" : "Not connected yet"}</span></div>
      <p className="mt-2 text-sm text-foreground-600">{c.note}</p>
    </article>)}</section>;
}
