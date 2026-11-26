import { useEffect, useState } from "react";
import { VIEW_LABELS, listViewAgents, listViewPeople, switchView, type ViewAgent, type ViewAgentGroup, type ViewKind, type ViewPerson } from "@/lib/viewAs";

/**
 * "Sign in as": an administrator searches the students, agents or staff of a workspace and signs in as the chosen person
 * (full access, recorded with the person), or opens the workspace's shared test account. CMS users are never listed.
 */
export default function ViewAsPicker({ kind, onClose }: { kind: ViewKind; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<ViewPerson[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const label = VIEW_LABELS[kind].toLowerCase();
  const article = /^[aeiou]/.test(label) ? "an" : "a";
  // VIEW-AS-ALL-AGENTS: agents come grouped by business (every agent, with or without a login).
  const [groups, setGroups] = useState<ViewAgentGroup[] | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [anyAgents, setAnyAgents] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      if (kind === "agent") {
        listViewAgents(query.trim())
          .then(list => { if (live) { setGroups(list); setError(""); if (!query.trim()) setAnyAgents(list.length > 0); } })
          .catch(e => { if (live) { setGroups([]); setError(e instanceof Error ? e.message : "The list could not be loaded."); } });
        return;
      }
      listViewPeople(kind, query.trim())
        .then(list => { if (live) { setPeople(list); setError(""); } })
        .catch(e => { if (live) { setPeople([]); setError(e instanceof Error ? e.message : "The list could not be loaded."); } });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [kind, query]);

  const openAgent = (agent: ViewAgent, business: string) => {
    const how = agent.hasLogin ? "" : " They have no login yet: one is made on their email with no password and nothing is emailed; it is switched off again when you go back.";
    if (!window.confirm(`Sign in as ${agent.name} (${agent.email}) of ${business}? You act with this agent's full access until you click Back to admin. The switch is recorded.${how}`)) return;
    setBusy(agent.id); setError("");
    void switchView("agent", { agentId: agent.id, name: agent.name })
      .catch(e => { setBusy(""); setError(e instanceof Error ? e.message : "The sign-in failed."); });
  };

  const agentList = groups === null ? <p className="px-3 py-6 text-center text-sm text-foreground-500">Loading…</p>
    : !groups.length ? <p className="px-3 py-6 text-center text-sm text-foreground-500" data-testid="view-as-agents-empty">
        {query.trim() && anyAgents !== false ? `No business or agent matches “${query}”.` : "No agents created yet. Add agents in Master Data → Agents."}</p>
    : <ul className="divide-y divide-background-200" data-testid="view-as-agent-groups">
        {groups.map(g => {
          const key = g.business.id ?? "none";
          const isClosed = closed[key] && !query.trim();
          return <li key={key}>
            <button type="button" aria-expanded={!isClosed} onClick={() => setClosed(c => ({ ...c, [key]: !c[key] }))}
              className="flex w-full items-center gap-2 bg-background-100 px-3 py-2 text-left text-sm font-semibold text-foreground-900 hover:bg-background-200">
              <i className={isClosed ? "ri-arrow-right-s-line" : "ri-arrow-down-s-line"} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{g.business.name} ({g.agents.length})</span>
            </button>
            {isClosed ? null : <ul className="divide-y divide-background-100">
              {g.agents.map(a => <li key={a.id}>
                <button type="button" disabled={!!busy} onClick={() => openAgent(a, g.business.name)} data-testid="view-as-agent"
                  className="flex w-full items-center gap-3 py-2.5 pl-8 pr-3 text-left hover:bg-primary-50 disabled:opacity-60">
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-foreground-950">{a.name}</span>
                    <span className="block truncate text-xs text-foreground-600">{a.email || "No email"}{a.status !== "Active" ? ` · ${a.status}` : ""}</span></span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${a.hasLogin ? "bg-emerald-100 text-emerald-800" : "bg-background-200 text-foreground-700"}`}>
                    {a.hasLogin ? "Has login" : "No login yet"}</span>
                  <span className="shrink-0 text-xs font-semibold text-primary-700">{busy === a.id ? "Signing in…" : "Sign in"}</span>
                </button>
              </li>)}
            </ul>}
          </li>;
        })}
      </ul>;

  const open = (person?: ViewPerson) => {
    if (person && !window.confirm(`Sign in as ${person.name} (${person.email})? You act with this ${label}'s full access until you click Back to admin. The switch is recorded.`)) return;
    setBusy(person?.userId ?? "test"); setError("");
    void switchView(kind, person ? { userId: person.userId, name: person.name } : undefined)
      .catch(e => { setBusy(""); setError(e instanceof Error ? e.message : "The sign-in failed."); });
  };

  return <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onClick={() => { if (!busy) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-label={`Sign in as ${article} ${label}`} className="w-full max-w-lg rounded-2xl bg-background-50 p-5 shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-bold text-foreground-950">Sign in as {article} {label}</h2>
          <p className="text-xs text-foreground-600">You get their full access until you click <b>Back to admin</b>. Every switch is recorded.</p>
        </div>
        <button type="button" aria-label="Close" disabled={!!busy} onClick={onClose} className="rounded-lg p-1.5 text-foreground-600 hover:bg-background-100"><i className="ri-close-line text-lg" aria-hidden="true" /></button>
      </div>
      <label className="relative mt-4 block"><span className="sr-only">Search {label}s</span>
        <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={kind === "agent" ? "Search business, agent name or email" : `Search ${label}s by name or email`}
          className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-3 text-sm" />
      </label>
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {kind === "agent" ? <div className="mt-3 max-h-[45vh] overflow-y-auto rounded-lg border border-background-200">{agentList}</div> :
      <ul className="mt-3 max-h-[45vh] divide-y divide-background-100 overflow-y-auto rounded-lg border border-background-200">
        {people === null ? <li className="px-3 py-6 text-center text-sm text-foreground-500">Loading…</li>
        : !people.length ? <li className="px-3 py-6 text-center text-sm text-foreground-500">{query ? `No ${label} matches “${query}”.` : `No ${label}s with a sign-in yet.`}</li>
        : people.map(p => <li key={p.userId}>
          <button type="button" disabled={!!busy} onClick={() => open(p)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-primary-50 disabled:opacity-60">
            <i className="ri-user-line text-lg text-primary-600" aria-hidden="true" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-foreground-950">{p.name}</span>
              <span className="block truncate text-xs text-foreground-600">{p.email}{p.detail ? ` · ${p.detail}` : ""}</span></span>
            <span className="shrink-0 text-xs font-semibold text-primary-700">{busy === p.userId ? "Signing in…" : "Sign in"}</span>
          </button>
        </li>)}
      </ul>}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-background-200 pt-3">
        <button type="button" disabled={!!busy} onClick={() => open()} className="text-sm font-semibold text-foreground-700 hover:underline">
          {busy === "test" ? "Opening…" : `Use the test ${label} account instead`}</button>
        <button type="button" disabled={!!busy} onClick={onClose} className="rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold hover:bg-background-100">Cancel</button>
      </div>
    </div>
  </div>;
}
