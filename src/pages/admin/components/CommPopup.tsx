import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { ConversationView, NewPersonDialog } from "@/pages/admin/components/CommunicationInbox";
import { TeamChat, TeamEditor, type Editing, type TeamRow } from "@/pages/admin/components/CommunicationTeams";
import { COMM_POPUP_EVENT, type CommPopupTarget } from "@/lib/commPopup";

type Tab = "conversations" | "people" | "teams";
type Kind = "student" | "agent" | "staff" | "applicant" | "agency" | "other";
type Conv = { id: string; kind: Kind; name: string; lastMessageAt: string | null; createdAt: string; last: { channel: string; direction: string; text: string; at: string } | null };
type Person = { kind: Kind; ref: string; name: string; email: string | null; phone: string | null; detail: string; conversationId: string | null };
const KIND: Record<Kind, string> = { student: "Student", agent: "Agent", staff: "Staff", applicant: "Applicant", agency: "Agency", other: "Other" };
const ICON: Record<string, string> = { email: "ri-mail-line", sms: "ri-message-2-line", whatsapp: "ri-whatsapp-line", note: "ri-sticky-note-line" };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

/**
 * The one place to communicate: a chat button on every admin page opens a small panel with Conversations (everyone you have
 * messaged), Everyone (any student, agent, staff member, applicant or agency) and Teams (staff group chats). Opening a person or a
 * team shows the whole history and the composer (email / SMS / WhatsApp when connected / note) in the same panel.
 */
export default function CommPopup() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("conversations");
  const [search, setSearch] = useState("");
  const [convs, setConvs] = useState<Conv[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [error, setError] = useState("");
  const [conversation, setConversation] = useState<string | null>(null);
  const [team, setTeam] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [adding, setAdding] = useState(false);
  const [unread, setUnread] = useState(0);

  const loadTeams = useCallback(async () => {
    const { data, error } = await supabase.rpc("comm_teams_list", { p_include_archived: false });
    if (!error) { const rows = (data ?? []) as TeamRow[]; setTeams(rows); setUnread(rows.reduce((s, t) => s + (t.unread || 0), 0)); }
  }, []);
  const loadList = useCallback(async () => {
    setError("");
    if (tab === "teams") { await loadTeams(); return; }
    const res = tab === "conversations"
      ? await supabase.rpc("comm_conversations_list", { p_search: search, p_limit: 100 })
      : await supabase.rpc("comm_people", { p_search: search, p_kind: "", p_limit: 60 });
    if (res.error) { setError(res.error.message); return; }
    if (tab === "conversations") setConvs((res.data ?? []) as Conv[]); else setPeople((res.data ?? []) as Person[]);
  }, [tab, search, loadTeams]);

  // Unread team messages on the button, checked now and then even while closed.
  useEffect(() => { void loadTeams(); const t = setInterval(() => void loadTeams(), 60000); return () => clearInterval(t); }, [loadTeams]);
  useEffect(() => { if (!open || conversation || team) return; const t = setTimeout(() => void loadList(), 200); return () => clearTimeout(t); }, [open, conversation, team, loadList]);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<CommPopupTarget>).detail ?? {};
      setOpen(true);
      if (d.tab) setTab(d.tab);
      if (d.conversationId) { setTeam(null); setConversation(d.conversationId); }
      if (d.teamId) { setConversation(null); setTeam(d.teamId); setTab("teams"); }
    };
    window.addEventListener(COMM_POPUP_EVENT, onOpen);
    return () => window.removeEventListener(COMM_POPUP_EVENT, onOpen);
  }, []);

  const openPerson = async (p: Person) => {
    if (p.conversationId) { setConversation(p.conversationId); return; }
    const { data, error } = await supabase.rpc("comm_open_conversation", { p_kind: p.kind, p_ref: p.ref });
    if (error) { setError(error.message); return; }
    setConversation(String(data));
  };
  const back = () => { setConversation(null); setTeam(null); void loadList(); };
  const activeTeam = teams.find((t) => t.id === team);

  return (
    <>
      <button type="button" onClick={() => setOpen(!open)} aria-label={open ? "Close messages" : "Open messages"} data-testid="comm-popup-button"
        className="fixed bottom-5 right-5 z-[900] flex h-14 w-14 items-center justify-center rounded-full bg-primary-500 text-2xl text-white shadow-lg hover:bg-primary-600">
        <i className={open ? "ri-close-line" : "ri-chat-3-line"} aria-hidden="true" />
        {!open && unread > 0 ? <span className="absolute -right-0.5 -top-0.5 rounded-full bg-foreground-950 px-1.5 text-xs font-semibold">{unread}</span> : null}
      </button>
      {open ? (
        <section role="dialog" aria-label="Messages" data-testid="comm-popup"
          className="fixed inset-x-2 bottom-24 top-16 z-[900] flex flex-col overflow-hidden rounded-xl border border-background-200 bg-background-50 shadow-2xl sm:inset-x-auto sm:right-5 sm:top-auto sm:h-[min(640px,calc(100vh-8rem))] sm:w-[420px]">
          {conversation ? (
            <ConversationView id={conversation} compact onBack={back} onSent={() => undefined} />
          ) : team ? (
            activeTeam && !activeTeam.isMember ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-foreground-700">
                <p>You're not a member of <b>{activeTeam.name}</b>. Only members can read and post.</p>
                <button type="button" className="font-medium text-primary-700 underline" onClick={back}>Back</button>
              </div>
            ) : (
              <TeamChat id={team} compact onBack={back} onChanged={() => void loadTeams()}
                onManage={(t) => setEditing({ id: t.team.id, name: t.team.name, description: t.team.description, memberIds: t.members.map((m) => m.id), microsoft: !!t.team.microsoft, microsoftHost: t.team.microsoftHost ?? null })} />
            )
          ) : (
            <>
              <header className="space-y-2 border-b border-background-200 p-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-foreground-950">Messages</h2>
                  {tab === "teams"
                    ? <button type="button" className="text-xs font-semibold text-primary-700 hover:underline" onClick={() => setEditing({ id: null, name: "", description: "", memberIds: [], microsoft: false, microsoftHost: null })}>+ New team</button>
                    : <button type="button" className="text-xs font-semibold text-primary-700 hover:underline" onClick={() => setAdding(true)}>+ Someone new</button>}
                </div>
                <div className="flex gap-1" role="tablist">
                  {(["conversations", "people", "teams"] as Tab[]).map((t) => (
                    <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                      className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold ${tab === t ? "bg-primary-500 text-white" : "border border-background-200 text-foreground-700"}`}>
                      {t === "conversations" ? "Conversations" : t === "people" ? "Everyone" : `Teams${unread ? ` (${unread})` : ""}`}
                    </button>
                  ))}
                </div>
                {tab !== "teams" ? <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email or phone" aria-label="Search"
                  className="w-full rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-sm" /> : null}
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {error ? <p role="alert" className="p-3 text-sm">{error}</p> : null}
                {tab === "conversations" ? (
                  convs.length === 0 ? <p className="p-4 text-sm text-foreground-600">No conversations yet. Use Everyone to message someone.</p>
                  : <ul>{convs.map((c) => (
                    <li key={c.id}><button type="button" onClick={() => setConversation(c.id)} className="w-full border-b border-background-100 px-3 py-2 text-left hover:bg-background-100">
                      <div className="flex justify-between gap-2"><span className="truncate text-sm font-medium">{c.name}</span><span className="shrink-0 text-xs text-foreground-500">{when(c.last?.at ?? c.createdAt)}</span></div>
                      <p className="flex items-center gap-1 truncate text-xs text-foreground-600"><span className="rounded bg-background-200 px-1">{KIND[c.kind]}</span>{c.last ? <><i className={ICON[c.last.channel] ?? "ri-chat-1-line"} aria-hidden="true" /><span className="truncate">{c.last.direction === "in" ? "Reply: " : ""}{c.last.text}</span></> : "No messages yet"}</p>
                    </button></li>))}</ul>
                ) : tab === "people" ? (
                  people.length === 0 ? <p className="p-4 text-sm text-foreground-600">No one matches.</p>
                  : <ul>{people.map((p) => (
                    <li key={`${p.kind}-${p.ref}`}><button type="button" onClick={() => void openPerson(p)} className="w-full border-b border-background-100 px-3 py-2 text-left hover:bg-background-100">
                      <div className="flex justify-between gap-2"><span className="truncate text-sm font-medium">{p.name}</span><span className="shrink-0 rounded bg-background-200 px-1 text-xs">{KIND[p.kind]}</span></div>
                      <p className="truncate text-xs text-foreground-600">{[p.email, p.phone, p.detail].filter(Boolean).join(" · ") || "No contact details"}</p>
                    </button></li>))}</ul>
                ) : (
                  teams.length === 0 ? <p className="p-4 text-sm text-foreground-600">No teams yet. Use + New team.</p>
                  : <ul>{teams.map((t) => (
                    <li key={t.id}><button type="button" onClick={() => setTeam(t.id)} className="w-full border-b border-background-100 px-3 py-2 text-left hover:bg-background-100">
                      <div className="flex justify-between gap-2"><span className="truncate text-sm font-medium"><i className="ri-team-line mr-1 text-primary-600" aria-hidden="true" />{t.name}</span>
                        {t.unread > 0 ? <span className="rounded-full bg-primary-500 px-2 text-xs font-semibold text-white">{t.unread}</span> : <span className="text-xs text-foreground-500">{when(t.lastAt)}</span>}</div>
                      <p className="truncate text-xs text-foreground-600">{t.memberCount} member{t.memberCount === 1 ? "" : "s"}{!t.isMember ? " · not a member" : t.last ? ` · ${t.last.author}: ${t.last.text}` : ""}</p>
                    </button></li>))}</ul>
                )}
              </div>
            </>
          )}
        </section>
      ) : null}
      {editing ? <TeamEditor initial={editing} archived={false} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); setTab("teams"); setTeam(id); void loadTeams(); }} /> : null}
      {adding ? <NewPersonDialog onClose={() => setAdding(false)} onOpened={(id) => { setAdding(false); setConversation(id); }} /> : null}
    </>
  );
}
