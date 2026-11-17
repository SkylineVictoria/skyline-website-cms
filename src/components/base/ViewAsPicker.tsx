import { useEffect, useState } from "react";
import { VIEW_LABELS, listViewPeople, switchView, type ViewKind, type ViewPerson } from "@/lib/viewAs";

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

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      listViewPeople(kind, query.trim())
        .then(list => { if (live) { setPeople(list); setError(""); } })
        .catch(e => { if (live) { setPeople([]); setError(e instanceof Error ? e.message : "The list could not be loaded."); } });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [kind, query]);

  const open = (person?: ViewPerson) => {
    if (person && !window.confirm(`Sign in as ${person.name} (${person.email})? You act with this ${label}'s full access until you click Back to admin. The switch is recorded.`)) return;
    setBusy(person?.userId ?? "test"); setError("");
    void switchView(kind, person ? { userId: person.userId, name: person.name } : undefined)
      .catch(e => { setBusy(""); setError(e instanceof Error ? e.message : "The sign-in failed."); });
  };

  return <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onClick={() => { if (!busy) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-label={`Sign in as a ${label}`} className="w-full max-w-lg rounded-2xl bg-background-50 p-5 shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-bold text-foreground-950">Sign in as a {label}</h2>
          <p className="text-xs text-foreground-600">You get their full access until you click <b>Back to admin</b>. Every switch is recorded.</p>
        </div>
        <button type="button" aria-label="Close" disabled={!!busy} onClick={onClose} className="rounded-lg p-1.5 text-foreground-600 hover:bg-background-100"><i className="ri-close-line text-lg" aria-hidden="true" /></button>
      </div>
      <label className="relative mt-4 block"><span className="sr-only">Search {label}s</span>
        <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${label}s by name or email`}
          className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-3 text-sm" />
      </label>
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
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
      </ul>
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-background-200 pt-3">
        <button type="button" disabled={!!busy} onClick={() => open()} className="text-sm font-semibold text-foreground-700 hover:underline">
          {busy === "test" ? "Opening…" : `Use the test ${label} account instead`}</button>
        <button type="button" disabled={!!busy} onClick={onClose} className="rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold hover:bg-background-100">Cancel</button>
      </div>
    </div>
  </div>;
}
