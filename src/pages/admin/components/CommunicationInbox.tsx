import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Badge, Button, EmptyState, Field, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { renderTemplate, smsInfo, templateVariables, type Channel } from "@/lib/communicationTemplates";

type Kind = "student" | "agent" | "staff" | "applicant" | "agency" | "other";
type SendChannel = Channel | "note";
type Person = { kind: Kind; ref: string; name: string; email: string | null; phone: string | null; detail: string; conversationId: string | null; lastMessageAt: string | null };
type ConversationRow = { id: string; kind: Kind; ref: string | null; name: string; email: string | null; phone: string | null; lastMessageAt: string | null; createdAt: string;
  last: { channel: SendChannel; direction: "in" | "out"; text: string; at: string } | null };
type Item = { id: string; source: "hub" | "automatic"; direction: "in" | "out"; channel: SendChannel; subject: string; body: string; to: string | null; by: string | null;
  template: string | null; at: string; status: "sending" | "sent" | "failed" | "not_sent" | "not_connected" | "recorded" | "received"; reason?: string | null };
type Thread = { conversation: { id: string; kind: Kind; ref: string | null; name: string; email: string | null; phone: string | null }; items: Item[] };
type Tpl = { key: string; name: string; category: string; subject: string; body: string; channels: Channel[] };

const KIND_LABELS: Record<Kind, string> = { student: "Student", agent: "Agent", staff: "Staff", applicant: "Job applicant", agency: "Agency", other: "Other" };
const CHANNEL_META: Record<SendChannel, { label: string; icon: string }> = {
  email: { label: "Email", icon: "ri-mail-line" }, sms: { label: "SMS", icon: "ri-message-2-line" },
  whatsapp: { label: "WhatsApp", icon: "ri-whatsapp-line" }, note: { label: "Internal note", icon: "ri-sticky-note-line" },
};
const STATUS_LABELS: Record<Item["status"], { label: string; tone: "primary" | "muted" | "warn" | "secondary" }> = {
  sending: { label: "Sending…", tone: "secondary" }, sent: { label: "Sent", tone: "primary" }, failed: { label: "Not delivered", tone: "warn" },
  not_sent: { label: "Not sent (opted out)", tone: "muted" }, not_connected: { label: "Recorded only (channel was not connected)", tone: "muted" },
  recorded: { label: "Note", tone: "muted" }, received: { label: "Reply", tone: "secondary" },
};
const INSTITUTION = "Skyline Institute of Technology";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

export default function CommunicationInbox() {
  const { push } = useToast();
  const [tab, setTab] = useState<"conversations" | "people">("conversations");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"" | Kind>("");
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const loadList = useCallback(async () => {
    setListBusy(true);
    const res = tab === "conversations"
      ? await supabase.rpc("comm_conversations_list", { p_search: search, p_limit: 200 })
      : await supabase.rpc("comm_people", { p_search: search, p_kind: kind, p_limit: 100 });
    setListBusy(false);
    setListError(res.error?.message ?? "");
    if (tab === "conversations") setConversations((res.data ?? []) as ConversationRow[]);
    else setPeople((res.data ?? []) as Person[]);
  }, [tab, search, kind]);
  useEffect(() => { const t = setTimeout(() => void loadList(), 250); return () => clearTimeout(t); }, [loadList]);

  const openPerson = async (p: Person) => {
    if (p.conversationId) { setActiveId(p.conversationId); return; }
    const { data, error } = await supabase.rpc("comm_open_conversation", { p_kind: p.kind, p_ref: p.ref });
    if (error) { push(`Could not open the conversation: ${error.message}`, "error"); return; }
    setActiveId(String(data));
  };

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
      <div className={`flex min-h-[60vh] flex-col rounded-xl border border-background-200 bg-background-50 ${activeId ? "hidden lg:flex" : "flex"}`}>
        <div className="space-y-3 border-b border-background-200 p-3">
          <div className="flex gap-1" role="tablist">
            {(["conversations", "people"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${tab === t ? "bg-primary-500 text-white" : "border border-background-200 text-foreground-700"}`}>
                {t === "conversations" ? "Conversations" : "Everyone"}
              </button>
            ))}
          </div>
          <TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email or phone" aria-label="Search" />
          {tab === "people" ? (
            <Select value={kind} onChange={(e) => setKind(e.target.value as "" | Kind)} aria-label="Type of person">
              <option value="">Everyone</option>
              {(["student", "agent", "staff", "applicant", "agency"] as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}s</option>)}
            </Select>
          ) : null}
          <Button size="sm" variant="outline" icon="ri-user-add-line" onClick={() => setNewOpen(true)} className="w-full">Message someone not in the list</Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {listBusy && !(tab === "conversations" ? conversations : people).length ? <p className="p-4 text-sm" role="status">Loading…</p>
            : listError ? <p role="alert" className="p-4 text-sm">Could not load: {listError}</p>
            : tab === "conversations" ? (
              conversations.length === 0 ? <div className="p-4"><EmptyState icon="ri-chat-3-line" title="No conversations yet" description="Open “Everyone” to start one with a student, agent, staff member or applicant." /></div>
              : <ul>{conversations.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setActiveId(c.id)} className={`w-full border-b border-background-100 px-3 py-2.5 text-left hover:bg-background-100 ${activeId === c.id ? "bg-primary-50" : ""}`}>
                    <div className="flex items-center justify-between gap-2"><span className="truncate font-medium text-foreground-950">{c.name}</span><span className="shrink-0 text-xs text-foreground-500">{when(c.last?.at ?? c.createdAt)}</span></div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-foreground-600">
                      <span className="rounded bg-background-200 px-1.5">{KIND_LABELS[c.kind]}</span>
                      {c.last ? <><i className={CHANNEL_META[c.last.channel].icon} aria-hidden="true" /><span className="truncate">{c.last.direction === "in" ? "Reply: " : ""}{c.last.text}</span></> : <span>No messages yet</span>}
                    </div>
                  </button>
                </li>))}</ul>
            ) : (
              people.length === 0 ? <p className="p-4 text-sm text-foreground-600">No one matches.</p>
              : <ul>{people.map((p) => (
                <li key={`${p.kind}-${p.ref}`}>
                  <button type="button" onClick={() => void openPerson(p)} className="w-full border-b border-background-100 px-3 py-2.5 text-left hover:bg-background-100">
                    <div className="flex items-center justify-between gap-2"><span className="truncate font-medium text-foreground-950">{p.name}</span><span className="shrink-0 rounded bg-background-200 px-1.5 text-xs">{KIND_LABELS[p.kind]}</span></div>
                    <p className="truncate text-xs text-foreground-600">{[p.email, p.phone, p.detail].filter(Boolean).join(" · ") || "No contact details"}</p>
                  </button>
                </li>))}</ul>
            )}
        </div>
      </div>

      <div className={activeId ? "block" : "hidden lg:block"}>
        {activeId ? <ConversationView id={activeId} onBack={() => setActiveId(null)} onSent={() => { if (tab === "conversations") void loadList(); }} />
          : <div className="flex min-h-[60vh] items-center justify-center rounded-xl border border-dashed border-background-300 p-6"><EmptyState icon="ri-chat-smile-2-line" title="Choose a conversation" description="Everything sent to a person – by your team or automatically – is shown in one place." /></div>}
      </div>

      {newOpen ? <NewPersonDialog onClose={() => setNewOpen(false)} onOpened={(id) => { setNewOpen(false); setActiveId(id); setTab("conversations"); void loadList(); }} /> : null}
    </section>
  );
}

/** One person's whole communication log with a composer (email / SMS / WhatsApp / note). Also used by the Message button on person pages. */
export function ConversationView({ id, onBack, onSent }: { id: string; onBack: () => void; onSent: () => void }) {
  const { push } = useToast();
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [channel, setChannel] = useState<SendChannel>("email");
  // Only channels whose account is connected in Integrations › Connections can be used; an internal note is always available.
  const [available, setAvailable] = useState<SendChannel[]>(["email", "note"]);
  useEffect(() => {
    void supabase.rpc("comm_channels_status").then(({ data }) => {
      const on = ((data ?? []) as { channel: string; connected: boolean }[]).filter((x) => x.connected).map((x) => x.channel);
      setAvailable((["email", "sms", "whatsapp"] as SendChannel[]).filter((c) => on.includes(c)).concat("note"));
    });
  }, []);
  const [templateKey, setTemplateKey] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("comm_thread", { p_conversation: id });
    setError(error?.message ?? "");
    if (!error) setThread(data as Thread);
  }, [id]);
  useEffect(() => { setThread(null); setSubject(""); setBody(""); setTemplateKey(""); void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [thread?.items.length]);
  useEffect(() => {
    void supabase.from("communication_templates").select("key,name,category,subject,body,channels").eq("status", "active").order("category").order("name")
      .then(({ data }) => setTemplates((data ?? []) as Tpl[]));
  }, []);

  const c = thread?.conversation;
  const values = useMemo<Record<string, string>>(() => {
    if (!c) return {};
    const first = c.name.split(/\s+/)[0] ?? c.name;
    return {
      first_name: c.kind === "agency" ? c.name : first, full_name: c.name, email: c.email ?? "", institution: INSTITUTION,
      ...(c.kind === "student" ? { student_name: c.name } : {}), ...(c.kind === "agent" ? { agent_name: c.name } : {}),
      ...(c.kind === "agency" ? { agency_name: c.name } : {}), ...(c.kind === "applicant" || c.kind === "staff" ? { booker_name: c.name } : {}),
    };
  }, [c]);
  const usable = templates.filter((t) => channel === "note" || t.channels.includes(channel as Channel));
  const chooseTemplate = (key: string) => {
    setTemplateKey(key);
    const t = templates.find((x) => x.key === key);
    if (!t) return;
    setSubject(renderTemplate(t.subject, values));
    setBody(renderTemplate(t.body, values));
  };
  const missing = templateVariables(subject, body);
  const blocked = !c || !body.trim() || (channel === "email" && (!c.email || !subject.trim())) || ((channel === "sms" || channel === "whatsapp") && !c.phone);

  const send = async () => {
    if (!c || blocked) return;
    if (missing.length && !window.confirm(`These details are still blank: ${missing.map((m) => `{{${m}}}`).join(", ")}. Send anyway?`)) return;
    setSending(true);
    const { error } = await supabase.rpc("comm_send", { p_conversation: c.id, p_channel: channel, p_subject: channel === "email" ? subject : "", p_body: body, p_template_key: templateKey || null });
    setSending(false);
    if (error) { push(`Not sent: ${error.message}`, "error"); return; }
    push(channel === "email" ? "Email sent – it will show as Sent within a minute." : channel === "note" ? "Note saved." : `${CHANNEL_META[channel].label} sent – it will show as Sent or Not delivered in a moment.`);
    setBody(""); setSubject(""); setTemplateKey("");
    await load(); onSent();
  };

  if (error) return <p role="alert" className="rounded-xl border border-red-300 p-4">Could not load the conversation: {error}</p>;
  if (!thread || !c) return <p role="status" className="p-4">Loading conversation…</p>;
  const sms = channel === "sms" ? smsInfo(body) : null;

  return (
    <div className="flex min-h-[60vh] flex-col rounded-xl border border-background-200 bg-background-50">
      <header className="flex flex-wrap items-center gap-3 border-b border-background-200 p-3">
        <button type="button" onClick={onBack} className="rounded-md p-1 text-foreground-600 hover:bg-background-100 lg:hidden" aria-label="Back to the list"><i className="ri-arrow-left-line text-lg" aria-hidden="true" /></button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-foreground-950">{c.name} <span className="ml-1 rounded bg-background-200 px-1.5 text-xs font-normal">{KIND_LABELS[c.kind]}</span></h2>
          <p className="truncate text-xs text-foreground-600">{[c.email ?? "No email", c.phone ?? "No phone"].join(" · ")}</p>
        </div>
      </header>

      <div className="max-h-[55vh] flex-1 space-y-3 overflow-y-auto bg-background-100/40 p-3">
        {thread.items.length === 0 ? <p className="py-8 text-center text-sm text-foreground-600">Nothing yet. Send the first message below.</p> : thread.items.map((m) => {
          const mine = m.direction === "out";
          const auto = m.source === "automatic";
          const long = m.body.length > 400;
          return (
            <article key={m.id} className={`max-w-[85%] rounded-xl border px-3 py-2 text-sm ${mine ? "ml-auto" : ""} ${m.channel === "note" ? "border-dashed border-background-300 bg-background-50" : auto ? "border-background-200 bg-background-50" : mine ? "border-primary-200 bg-primary-50" : "border-background-200 bg-white"}`}>
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-foreground-600">
                <i className={CHANNEL_META[m.channel].icon} aria-hidden="true" /><span>{CHANNEL_META[m.channel].label}</span>
                <span>·</span><span>{auto ? "Automatic" : m.direction === "in" ? "From " + c.name : m.by ?? "Staff"}</span>
                <span>·</span><time>{when(m.at)}</time>
                <Badge tone={STATUS_LABELS[m.status].tone}>{STATUS_LABELS[m.status].label}</Badge>
              </div>
              {m.subject ? <p className="font-semibold text-foreground-900">{m.subject}</p> : null}
              {m.status === "failed" && m.reason ? <p className="mb-1 text-xs text-primary-800">Not delivered: {m.reason}</p> : null}
              {m.body ? <p className="whitespace-pre-wrap text-foreground-800">{long && expanded !== m.id ? `${m.body.slice(0, 400)}…` : m.body}</p> : null}
              {long ? <button type="button" className="mt-1 text-xs font-medium text-primary-700 underline" onClick={() => setExpanded(expanded === m.id ? null : m.id)}>{expanded === m.id ? "Show less" : "Show all"}</button> : null}
            </article>
          );
        })}
        <div ref={endRef} />
      </div>

      <div className="space-y-2 border-t border-background-200 p-3">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Send by">
          {available.map((ch) => (
            <button key={ch} type="button" role="radio" aria-checked={channel === ch} onClick={() => { setChannel(ch); setTemplateKey(""); }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${channel === ch ? "bg-primary-500 text-white" : "border border-background-200 text-foreground-700"}`}>
              <i className={`${CHANNEL_META[ch].icon} mr-1`} aria-hidden="true" />{CHANNEL_META[ch].label}
            </button>
          ))}
        </div>
        {available.length <= 2 ? <p className="text-xs text-foreground-600">Only email is connected. Connect SMS (ClickSend) or WhatsApp Business in <Link className="font-medium text-primary-700 underline" to="/admin/integrations">Integrations</Link> to use them here.</p> : null}
        {channel === "email" && !c.email ? <p className="text-xs text-primary-800">This person has no email address.</p> : null}
        {(channel === "sms" || channel === "whatsapp") && !c.phone ? <p className="text-xs text-primary-800">This person has no phone number.</p> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={templateKey} onChange={(e) => chooseTemplate(e.target.value)} aria-label="Template">
            <option value="">Start from a template (optional)</option>
            {usable.map((t) => <option key={t.key} value={t.key}>{t.category} – {t.name}</option>)}
          </Select>
          {channel === "email" ? <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" maxLength={200} aria-label="Subject" /> : null}
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4000} placeholder={channel === "note" ? "Write a note for your team (not sent to the person)" : "Write your message"}
          aria-label="Message" className="w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100" />
        {missing.length ? <p className="text-xs text-primary-800">Fill in before sending: {missing.map((m) => `{{${m}}}`).join(", ")}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-foreground-500">{sms ? `${sms.characters} characters · ${sms.segments} SMS part${sms.segments === 1 ? "" : "s"}` : channel === "email" ? `To ${c.email ?? "—"}` : ""}</span>
          <Button icon={channel === "note" ? "ri-save-line" : "ri-send-plane-2-line"} disabled={sending || blocked} onClick={() => void send()}>
            {sending ? "Sending…" : channel === "note" ? "Save note" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function NewPersonDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const { push } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc("comm_open_conversation", { p_kind: "other", p_ref: null, p_name: name, p_email: email, p_phone: phone });
    setBusy(false);
    if (error) { push(error.message, "error"); return; }
    onOpened(String(data));
  };
  return (
    <Modal open title="Message someone new" onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !name.trim() || (!email.trim() && !phone.trim())} onClick={() => void save()}>Start conversation</Button></div>}>
      <div className="space-y-3">
        <Field label="Name" required><TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
        <Field label="Email"><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Mobile" hint="An email or a mobile is needed."><TextInput type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
