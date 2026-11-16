import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Button, EmptyState, Field, Modal, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";

export type TeamRow = { id: string; name: string; description: string; archived: boolean; microsoft?: boolean; memberCount: number; isMember: boolean; lastAt: string | null; last: { author: string; text: string } | null; unread: number };
type Staff = { id: string; name: string; email: string; role: string };
export type TeamThread = { team: { id: string; name: string; description: string; archived: boolean; microsoft?: boolean; microsoftHost?: string | null }; me: string | null; members: { id: string; name: string; email: string }[];
  messages: { id: string; authorId: string | null; author: string; body: string; at: string; microsoft?: "sent" | "failed" | "sending" | null }[] };
export type Editing = { id: string | null; name: string; description: string; memberIds: string[]; microsoft: boolean; microsoftHost: string | null };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";

/** Staff team groups: a shared chat per team (members only). Any administrator can create a team and choose its members. */
export default function CommunicationTeams() {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("comm_teams_list", { p_include_archived: showArchived });
    setBusy(false);
    setError(error?.message ?? "");
    if (!error) setTeams((data ?? []) as TeamRow[]);
  }, [showArchived]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 20000); return () => clearInterval(t); }, [load]);

  const active = teams.find((t) => t.id === activeId) ?? null;

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
      <div className={`flex min-h-[60vh] flex-col rounded-xl border border-background-200 bg-background-50 ${activeId ? "hidden lg:flex" : "flex"}`}>
        <div className="space-y-2 border-b border-background-200 p-3">
          <Button icon="ri-team-line" className="w-full" onClick={() => setEditing({ id: null, name: "", description: "", memberIds: [], microsoft: false, microsoftHost: null })}>New team</Button>
          <label className="flex items-center gap-2 text-xs text-foreground-600">
            <input type="checkbox" className="h-4 w-4" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived teams
          </label>
        </div>
        <div className="flex-1 overflow-y-auto">
          {busy ? <p role="status" className="p-4 text-sm">Loading teams…</p>
            : error ? <p role="alert" className="p-4 text-sm">Could not load teams: {error}</p>
            : teams.length === 0 ? <div className="p-4"><EmptyState icon="ri-team-line" title="No teams yet" description="Create a team, for example Admissions or Trainers, and choose its members." /></div>
            : <ul>{teams.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setActiveId(t.id)} className={`w-full border-b border-background-100 px-3 py-2.5 text-left hover:bg-background-100 ${activeId === t.id ? "bg-primary-50" : ""} ${t.archived ? "opacity-60" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-foreground-950"><i className="ri-team-line mr-1.5 text-primary-600" aria-hidden="true" />{t.name}{t.microsoft ? <i className="ri-microsoft-line ml-1.5 text-foreground-500" title="Copied to Microsoft Teams" aria-label="Connected to Microsoft Teams" /> : null}</span>
                    {t.unread > 0 ? <span className="rounded-full bg-primary-500 px-2 text-xs font-semibold text-white">{t.unread}</span> : <span className="text-xs text-foreground-500">{when(t.lastAt)}</span>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-foreground-600">
                    {t.archived ? "Archived · " : ""}{t.memberCount} member{t.memberCount === 1 ? "" : "s"}{!t.isMember ? " · You're not a member" : t.last ? ` · ${t.last.author}: ${t.last.text}` : ""}
                  </p>
                </button>
              </li>))}</ul>}
        </div>
      </div>

      <div className={activeId ? "block" : "hidden lg:block"}>
        {active ? (active.isMember
          ? <TeamChat id={active.id} onBack={() => setActiveId(null)} onChanged={() => void load()}
              onManage={(t) => setEditing({ id: t.team.id, name: t.team.name, description: t.team.description, memberIds: t.members.map((m) => m.id), microsoft: !!t.team.microsoft, microsoftHost: t.team.microsoftHost ?? null })} />
          : <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 rounded-xl border border-background-200 bg-background-50 p-6 text-center">
              <EmptyState icon="ri-lock-line" title={`You're not in ${active.name}`} description="Only members can read and post in a team. Add yourself to join." />
              <Button variant="outline" onClick={() => setActiveId(null)} className="lg:hidden">Back</Button>
            </div>)
          : <div className="flex min-h-[60vh] items-center justify-center rounded-xl border border-dashed border-background-300 p-6"><EmptyState icon="ri-chat-smile-3-line" title="Choose a team" description="Teams are private group chats for your staff." /></div>}
      </div>

      {editing ? <TeamEditor initial={editing} archived={!!active?.archived && editing.id === active?.id}
        onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); setActiveId(id); void load(); }} /> : null}
    </section>
  );
}

export function TeamChat({ id, onBack, onManage, onChanged, compact = false }: { id: string; onBack: () => void; onManage: (t: TeamThread) => void; onChanged: () => void; compact?: boolean }) {
  const { push } = useToast();
  const [thread, setThread] = useState<TeamThread | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("comm_team_thread", { p_team: id });
    setError(error?.message ?? "");
    if (!error) setThread(data as TeamThread);
  }, [id]);
  useEffect(() => { setThread(null); void load().then(onChanged); const t = setInterval(() => void load(), 15000); return () => clearInterval(t); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps -- onChanged only refreshes unread counts once on open
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [thread?.messages.length]);

  const post = async () => {
    if (!text.trim()) return;
    setSending(true);
    const { error } = await supabase.rpc("comm_team_post", { p_team: id, p_body: text });
    setSending(false);
    if (error) { push(`Not sent: ${error.message}`, "error"); return; }
    setText("");
    await load(); onChanged();
  };

  if (error) return <p role="alert" className="rounded-xl border border-red-300 p-4">Could not load the team: {error}</p>;
  if (!thread) return <p role="status" className="p-4">Loading team…</p>;
  return (
    <div className={compact ? "flex h-full min-h-0 flex-col bg-background-50" : "flex min-h-[60vh] flex-col rounded-xl border border-background-200 bg-background-50"}>
      <header className="flex flex-wrap items-center gap-3 border-b border-background-200 p-3">
        <button type="button" onClick={onBack} className={`rounded-md p-1 text-foreground-600 hover:bg-background-100 ${compact ? "" : "lg:hidden"}`} aria-label="Back to teams"><i className="ri-arrow-left-line text-lg" aria-hidden="true" /></button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-foreground-950">{thread.team.name}{thread.team.archived ? <span className="ml-2 rounded bg-background-200 px-1.5 text-xs font-normal">Archived</span> : null}{thread.team.microsoft ? <span className="ml-2 rounded bg-primary-50 px-1.5 text-xs font-normal text-primary-800"><i className="ri-microsoft-line mr-1" aria-hidden="true" />Copied to Microsoft Teams{thread.team.microsoftHost ? ` · ${thread.team.microsoftHost}` : ""}</span> : null}</h2>
          <p className="truncate text-xs text-foreground-600" title={thread.members.map((m) => m.name).join(", ")}>{thread.team.description ? `${thread.team.description} · ` : ""}{thread.members.map((m) => m.name).join(", ")}</p>
        </div>
        <Button size="sm" variant="outline" icon="ri-settings-3-line" onClick={() => onManage(thread)}>Manage</Button>
      </header>
      <div className={`${compact ? "min-h-0" : "max-h-[55vh]"} flex-1 space-y-3 overflow-y-auto bg-background-100/40 p-3`}>
        {thread.messages.length === 0 ? <p className="py-8 text-center text-sm text-foreground-600">No messages yet. Say hello to your team.</p> : thread.messages.map((m) => {
          const mine = m.authorId === thread.me;
          return (
            <div key={m.id} className={`flex items-end gap-2 ${mine ? "flex-row-reverse" : ""}`}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-800" aria-hidden="true">{initials(m.author)}</span>
              <article className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${mine ? "bg-primary-500 text-white" : "border border-background-200 bg-white text-foreground-900"}`}>
                <p className={`mb-0.5 text-xs ${mine ? "text-white/80" : "text-foreground-500"}`}>{mine ? "You" : m.author} · {when(m.at)}</p>
                <p className="whitespace-pre-wrap">{m.body}</p>
                {m.microsoft ? <p className={`mt-1 text-[11px] ${mine ? "text-white/80" : "text-foreground-500"}`}><i className="ri-microsoft-line mr-1" aria-hidden="true" />{m.microsoft === "sent" ? "Copied to Microsoft Teams" : m.microsoft === "failed" ? "Could not copy to Microsoft Teams" : "Copying to Microsoft Teams…"}</p> : null}
              </article>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {thread.team.archived ? <p className="border-t border-background-200 p-3 text-sm text-foreground-600">This team is archived. Restore it from Manage to post again.</p> : (
        <div className="flex items-end gap-2 border-t border-background-200 p-3">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={4000} placeholder={`Message ${thread.team.name}`} aria-label="Message"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void post(); } }}
            className="min-w-0 flex-1 rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100" />
          <Button icon="ri-send-plane-2-line" disabled={sending || !text.trim()} onClick={() => void post()}>{sending ? "Sending…" : "Send"}</Button>
        </div>
      )}
    </div>
  );
}

export function TeamEditor({ initial, archived, onClose, onSaved }: { initial: Editing; archived: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const { push } = useToast();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [members, setMembers] = useState<string[]>(initial.memberIds);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void supabase.rpc("comm_staff_options").then(({ data }) => setStaff((data ?? []) as Staff[])); }, []);
  const toggle = (id: string) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  const save = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc("comm_team_save", { p_team: initial.id, p_name: name, p_description: description, p_member_ids: members });
    setBusy(false);
    if (error) { push(error.message, "error"); return; }
    push(initial.id ? "Team updated." : "Team created.");
    onSaved(String(data));
  };
  const archive = async (value: boolean) => {
    if (!initial.id) return;
    setBusy(true);
    const { error } = await supabase.rpc("comm_team_archive", { p_team: initial.id, p_archived: value });
    setBusy(false);
    if (error) { push(error.message, "error"); return; }
    push(value ? "Team archived." : "Team restored.");
    onSaved(initial.id);
  };
  return (
    <Modal open title={initial.id ? "Manage team" : "New team"} onClose={onClose}
      footer={<div className="flex flex-wrap items-center justify-between gap-2">
        <div>{initial.id ? <Button variant="ghost" disabled={busy} onClick={() => void archive(!archived)}>{archived ? "Restore team" : "Archive team"}</Button> : null}</div>
        <div className="flex gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || archived || !name.trim() || (initial.id !== null && members.length === 0)} onClick={() => void save()}>{initial.id ? "Save" : "Create team"}</Button></div>
      </div>}>
      <div className="space-y-4">
        <Field label="Team name" required><TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Admissions" disabled={archived} /></Field>
        <Field label="What the team is for"><TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} disabled={archived} /></Field>
        <fieldset disabled={archived}>
          <legend className="mb-1.5 text-label font-medium text-foreground-800">Members</legend>
          {initial.id === null ? <p className="mb-2 text-xs text-foreground-500">You are added automatically.</p> : null}
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-background-200 p-2">
            {staff.length === 0 ? <p className="text-sm text-foreground-500">Loading staff…</p> : staff.map((s) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-background-100">
                <input type="checkbox" className="h-4 w-4" checked={members.includes(s.id)} onChange={() => toggle(s.id)} />
                <span className="flex-1">{s.name}</span><span className="text-xs text-foreground-500">{s.role}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-foreground-500">Members are your staff who sign in to the admin area. Only Admins can open the Communication Hub today.</p>
        </fieldset>
        {initial.id ? <MicrosoftTeamsLink teamId={initial.id} connected={initial.microsoft} host={initial.microsoftHost} disabled={archived} onChanged={() => onSaved(initial.id as string)} /> : null}
      </div>
    </Modal>
  );
}

/** Links a hub team to one of the Microsoft Teams channels saved in Integrations › Connections (one-way copy). No links are entered here. */
function MicrosoftTeamsLink({ teamId, connected, host, disabled, onChanged }: { teamId: string; connected: boolean; host: string | null; disabled: boolean; onChanged: () => void }) {
  const { push } = useToast();
  const [channels, setChannels] = useState<string[] | null>(null);
  const [choice, setChoice] = useState(host ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void supabase.rpc("comm_team_microsoft_channels").then(({ data }) => setChannels((data ?? []) as string[])); }, []);
  const setLink = async (value: string) => {
    setBusy(true);
    const { error } = await supabase.rpc("comm_team_microsoft_set", { p_team: teamId, p_channel_name: value });
    if (!error && value) await supabase.rpc("comm_team_microsoft_test", { p_team: teamId });
    setBusy(false);
    if (error) { push(error.message, "error"); return; }
    push(value ? "Linked. A test message was sent to the Teams channel." : "Unlinked from Microsoft Teams.");
    onChanged();
  };
  const test = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("comm_team_microsoft_test", { p_team: teamId });
    setBusy(false);
    push(error ? error.message : "Test message sent. Check the Teams channel.", error ? "error" : "success");
  };
  return (
    <fieldset disabled={disabled || busy} className="rounded-lg border border-background-200 p-3">
      <legend className="px-1 text-label font-medium text-foreground-800"><i className="ri-microsoft-line mr-1" aria-hidden="true" />Microsoft Teams</legend>
      <p className="mb-2 text-sm text-foreground-600">Copy this team's messages into a Microsoft Teams channel. Channels are added in <Link className="font-medium text-primary-700 underline" to="/admin/integrations">Integrations › Microsoft Teams channels</Link>. Replies in Teams don't come back here.</p>
      {channels === null ? <p className="text-sm text-foreground-500">Loading channels…</p> : channels.length === 0 ? (
        <p className="text-sm text-foreground-700">No Microsoft Teams channels are connected yet. Add them in Integrations first.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Microsoft Teams channel"
            className="min-w-0 flex-1 rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm">
            <option value="">Not linked</option>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <Button size="sm" disabled={(choice || "") === (host ?? "")} onClick={() => void setLink(choice)}>{choice ? "Link channel" : "Unlink"}</Button>
          {connected ? <Button size="sm" variant="outline" onClick={() => void test()}>Send test message</Button> : null}
        </div>
      )}
    </fieldset>
  );
}
