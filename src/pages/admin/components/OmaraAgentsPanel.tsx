import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, TextArea } from "@/pages/admin/components/ui";
import {
  evidenceOf, isRecord, omaraDiscover, omaraImportUrls, omaraLink, omaraLinked, omaraRefresh, omaraStatus, omaraUnlink, splitLinks,
  type DiscoveredAgent, type LinkEvidence, type LinkedAgent, type OmaraFacts, type OmaraStatus,
} from "@/lib/omaraApi";

// OMARA migration agent discovery (2026-11-24). Two uses:
//  * mode "select" (Add business, before the business exists): find the business's registered migration agents, tick the ones that work
//    there; the form links the ticked ones right after the business is saved (onSelection).
//  * mode "linked" (the business page): the linked agents (Unlink, Re-verify), Discover again and Add from OMARA link.
// Never SLIT education agents: nothing here adds an agent to the business's agents.

const NOTE = "Registered migration agents from the public OMARA register. Contact details are for verification and onboarding only, not for marketing.";
const when = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
};
const day = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};
type AgentRecord = Extract<DiscoveredAgent, { marn: string }>;
export type { AgentRecord };
export interface OmaraSelection { marns: string[]; evidence: LinkEvidence }

function AgentCard({ a, checked, onToggle, linked, actions }: {
  a: AgentRecord | LinkedAgent; checked?: boolean; onToggle?: (v: boolean) => void; linked?: boolean; actions?: ReactNode;
}) {
  // Compact (owner 2026-11-24: "shrink the view, no clutter"): one line each, the evidence and register dates behind More.
  const [open, setOpen] = useState(false);
  const place = [a.suburb, a.state].filter(Boolean).join(" ");
  const verification = "verification" in a ? a.verification : "linked";
  const likely = "likely" in a ? a.likely : true;
  return (
    <li className={`px-3 py-2 text-sm ${likely ? "" : "opacity-80"}`} data-testid="omara-agent">
      <div className="flex items-center gap-3">
        {onToggle ? <input type="checkbox" checked={!!checked} onChange={(e) => onToggle(e.target.checked)} aria-label={`Select ${a.fullName}`} /> : null}
        <div className="min-w-0 flex-1">
          <p className="truncate"><span className="font-semibold text-foreground-900">{a.fullName}</span>
            <span className="text-foreground-500"> · MARN {a.marn}{place ? ` · ${place}` : ""}</span>
            {a.status && !/^registered$/i.test(a.status) ? <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-2xs font-medium text-amber-800">{a.status}</span> : null}
            {linked ? <span className="ml-2 rounded-full bg-sky-50 px-2 py-0.5 text-2xs font-medium text-sky-800">Linked</span> : null}
            <span className={`ml-2 rounded-full px-2 py-0.5 text-2xs font-medium ${a.confidence >= 60 ? "bg-emerald-50 text-emerald-800" : "bg-background-200 text-foreground-700"}`}>{a.confidence}%</span>
          </p>
          <p className="truncate text-xs text-foreground-600">{[a.email, a.phone].filter(Boolean).join(" · ") || "No contact details on the record"}</p>
        </div>
        <button type="button" className="shrink-0 text-xs font-semibold text-primary-700 hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Less" : "More"}</button>
        {actions ? <div className="flex shrink-0 gap-1">{actions}</div> : null}
      </div>
      {open ? <div className="mt-1 space-y-1 pl-7 text-2xs text-foreground-600">
        <p>{a.businessName || "—"}{[a.suburb, a.state, a.postcode].filter(Boolean).length ? ` · ${[a.suburb, a.state, a.postcode].filter(Boolean).join(" ")}` : ""}{a.website ? ` · ${a.website}` : ""}</p>
        {(a.evidence ?? []).length ? <div className="flex flex-wrap gap-1">{(a.evidence ?? []).map((e) => <span key={e} className="rounded-full bg-background-200 px-2 py-0.5">{e}</span>)}</div> : null}
        <p>
          {verification === "verified" ? `Verified on the register ${when(a.verifiedAt)}` : `Read from the register ${when(a.verifiedAt)}`}
          {a.registrationCommencedAt ? ` · registration commenced ${day(a.registrationCommencedAt)}` : ""}
          {a.registerUpdatedAt ? ` · register last updated ${day(a.registerUpdatedAt)}` : ""}
          {a.disciplinary?.length ? " · disciplinary decision found (see the official record)" : ""}
          {" · "}<a href={a.sourceUrl} target="_blank" rel="noreferrer" className="underline">Open official record</a>
        </p>
      </div> : null}
    </li>
  );
}

export default function OmaraAgentsPanel(props:
  | { mode: "select"; facts: OmaraFacts; disabled?: boolean; onSelection: (s: OmaraSelection) => void;
      /** Every registered agent found (Add business offers them as the business admin agent). */ onFound?: (agents: AgentRecord[]) => void }
  | { mode: "linked"; agencyId: string }) {
  const facts: OmaraFacts = props.mode === "select" ? props.facts : { agencyId: props.agencyId, names: [] };
  const [status, setStatus] = useState<OmaraStatus | null>(null);
  const [found, setFound] = useState<DiscoveredAgent[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [linked, setLinked] = useState<LinkedAgent[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [ran, setRan] = useState(false);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const autoRan = useRef("");
  const key = JSON.stringify(facts);

  const report = useCallback((sel: Set<string>, list: DiscoveredAgent[]) => {
    if (props.mode === "select") props.onSelection({ marns: [...sel], evidence: evidenceOf(list, [...sel]) });
  }, [props]);
  const setSelection = (sel: Set<string>, list = found) => { setChecked(sel); report(sel, list); };
  const mergeFound = (list: DiscoveredAgent[]) => {
    const byKey = new Map<string, DiscoveredAgent>();
    for (const a of [...found, ...list]) byKey.set(isRecord(a) ? a.marn : `c:${a.contactId}`, a);
    const merged = [...byKey.values()].sort((x, y) => y.confidence - x.confidence);
    const sel = new Set(checked);
    for (const a of list) if (isRecord(a) && a.likely && !linked.some((l) => l.marn === a.marn)) sel.add(a.marn);
    setFound(merged);
    setSelection(sel, merged);
  };

  const loadLinked = useCallback(async () => {
    if (props.mode !== "linked") return;
    try { setLinked(await omaraLinked(props.agencyId)); } catch (e) { setError(e instanceof Error ? e.message : "The linked agents could not be loaded."); }
  }, [props]);

  useEffect(() => { void omaraStatus().then(setStatus).catch(() => setStatus(null)); void loadLinked(); }, [loadLinked]);
  const onFound = props.mode === "select" ? props.onFound : undefined;
  useEffect(() => { onFound?.(found.filter(isRecord).sort((x, y) => y.confidence - x.confidence)); }, [found, onFound]);

  const discover = async () => {
    setBusy("discover"); setError(""); setMessage("");
    try {
      const r = await omaraDiscover(facts);
      setRan(true);
      if (!r.enabled || !r.configured) { setMessage(r.message ?? "Automatic search is not available. Paste OMARA links instead."); setShowPaste(true); return; }
      mergeFound(r.agents);
      const records = r.agents.filter(isRecord).length;
      setMessage(`${records ? `${records} registered migration agent${records === 1 ? "" : "s"} found` : "No registered migration agents found"} (${r.run?.searches ?? 0} search${r.run?.searches === 1 ? "" : "es"}, ${r.run?.pagesFetched ?? 0} register page${r.run?.pagesFetched === 1 ? "" : "s"} read).${r.run?.errors?.length ? ` Some steps failed: ${r.run.errors.slice(0, 2).join(" ")}` : ""}`);
    } catch (e) { setError(e instanceof Error ? e.message : "The search failed."); }
    finally { setBusy(""); }
  };

  // Add business: runs once by itself for these details when automatic search is on and a key is saved.
  useEffect(() => {
    if (props.mode !== "select" || !status?.enabled || !status.configured || !facts.names.length || autoRan.current === key) return;
    autoRan.current = key;
    void discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, key]);

  const importLinks = async () => {
    const urls = splitLinks(paste);
    if (!urls.length) { setError("Paste one or more OMARA agent links (https://portal.mara.gov.au/…?ContactID=…)."); return; }
    setBusy("import"); setError(""); setMessage("");
    try {
      const r = await omaraImportUrls(urls, facts);
      mergeFound(r.agents);
      setPaste("");
      setMessage(`${r.agents.filter(isRecord).length} of ${urls.length} link${urls.length === 1 ? "" : "s"} read from the register.${r.rejected.length ? ` Not OMARA agent pages: ${r.rejected.length}.` : ""}${r.skipped ? ` ${r.skipped} over the limit were not read.` : ""}`);
    } catch (e) { setError(e instanceof Error ? e.message : "The links could not be read."); }
    finally { setBusy(""); }
  };

  const linkSelected = async () => {
    if (props.mode !== "linked") return;
    const marns = [...checked].filter((m) => !linked.some((l) => l.marn === m));
    if (!marns.length) return;
    setBusy("link"); setError("");
    try {
      const n = await omaraLink(props.agencyId, marns, evidenceOf(found, marns));
      setMessage(`${n} agent${n === 1 ? "" : "s"} linked to this business.`);
      setFound((list) => list.filter((a) => !(isRecord(a) && marns.includes(a.marn))));
      setChecked(new Set());
      await loadLinked();
    } catch (e) { setError(e instanceof Error ? e.message : "The agents could not be linked."); }
    finally { setBusy(""); }
  };
  const unlink = async (marn: string) => {
    if (props.mode !== "linked") return;
    setBusy(`unlink:${marn}`); setError("");
    try { await omaraUnlink(props.agencyId, marn); await loadLinked(); setMessage(`MARN ${marn} unlinked.`); }
    catch (e) { setError(e instanceof Error ? e.message : "The agent could not be unlinked."); }
    finally { setBusy(""); }
  };
  const reverify = async (marn: string) => {
    setBusy(`verify:${marn}`); setError("");
    try {
      const r = await omaraRefresh(marn, props.mode === "linked" ? props.agencyId : undefined);
      await loadLinked();
      const changed = Object.keys(r.changed ?? {});
      setMessage(`MARN ${marn} re-read from the register: ${changed.length ? `changed (${changed.join(", ")})` : "no change"}.`);
    } catch (e) { setError(e instanceof Error ? e.message : "The official record could not be read."); }
    finally { setBusy(""); }
  };

  const byMatch = <T extends { confidence: number; fullName: string }>(x: T, y: T) => y.confidence - x.confidence || x.fullName.localeCompare(y.fullName);
  const records = found.filter(isRecord).filter((a) => !linked.some((l) => l.marn === a.marn)).sort(byMatch);
  const linkedSorted = [...linked].sort(byMatch);
  const searchOnly = found.filter((a) => !isRecord(a));
  const disabled = props.mode === "select" && !!props.disabled;
  const canSearch = status?.enabled && status.configured;

  return (
    <section className="mt-4 rounded-lg border border-violet-200 bg-violet-50/40 p-4" aria-label="Registered migration agents (OMARA)" data-testid="omara-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground-900"><i className="ri-government-line" aria-hidden="true" />Registered migration agents (OMARA)</p>
          <p className="mt-0.5 text-xs text-foreground-600">{NOTE} They are not added as this business&rsquo;s agents.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" icon="ri-search-line" disabled={disabled || !!busy || !canSearch || (props.mode === "select" && !facts.names.length)}
            title={canSearch ? undefined : "Needs a Brave Search or Tavily key in Integrations › Connections (and the Business Rule on)"}
            onClick={() => void discover()} data-testid="omara-discover">{busy === "discover" ? "Searching…" : ran || props.mode === "linked" ? "Discover again" : "Discover"}</Button>
          <Button type="button" variant="outline" icon="ri-link" disabled={disabled || !!busy} onClick={() => setShowPaste((v) => !v)} data-testid="omara-paste-toggle">Add from OMARA link</Button>
        </div>
      </div>
      {status && !canSearch ? <p className="mt-2 text-xs text-foreground-600" data-testid="omara-manual-note">
        {status.enabled ? "Automatic search is not set up (no Brave Search or Tavily key in Integrations › Connections)." : "Automatic search is switched off in Business Rules."}
        {" "}Search the register yourself at <a className="underline" href="https://portal.mara.gov.au/search-the-register-of-migration-agents/" target="_blank" rel="noreferrer">portal.mara.gov.au</a>, open each agent and paste the links below.</p> : null}
      {showPaste ? (
        <div className="mt-3 space-y-2">
          <TextArea rows={3} value={paste} disabled={disabled || !!busy} onChange={(e) => setPaste(e.target.value)} aria-label="OMARA agent links"
            placeholder="https://portal.mara.gov.au/search-the-register-of-migration-agents/register-of-migration-agent-details/?ContactID=…  (one or more)" data-testid="omara-paste" />
          <Button type="button" variant="secondary" disabled={disabled || !!busy || !paste.trim()} onClick={() => void importLinks()} data-testid="omara-import">{busy === "import" ? "Reading…" : "Read from the register"}</Button>
        </div>
      ) : null}
      <div aria-live="polite">
        {message ? <p className="mt-2 text-xs text-foreground-700" role="status">{message}</p> : null}
        {error ? <p className="mt-2 text-xs font-medium text-red-700" role="alert">{error}</p> : null}
      </div>

      {props.mode === "linked" ? (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Linked to this business ({linked.length})</p>
          {linked.length ? <ul className="mt-2 divide-y divide-background-200 rounded-md border border-background-200 bg-white">{linkedSorted.map((a) => (
            <AgentCard key={a.marn} a={a} linked actions={<>
              <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void reverify(a.marn)}>{busy === `verify:${a.marn}` ? "Reading…" : "Re-verify"}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => void unlink(a.marn)}>{busy === `unlink:${a.marn}` ? "Unlinking…" : "Unlink"}</Button>
            </>} />))}</ul> : <p className="mt-1 text-xs text-foreground-500">No registered migration agents are linked yet.</p>}
        </div>
      ) : null}

      {records.length ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs font-medium text-foreground-700">
              <input type="checkbox" disabled={disabled} checked={records.every((a) => checked.has(a.marn))}
                onChange={(e) => setSelection(e.target.checked ? new Set(records.map((a) => a.marn)) : new Set())} data-testid="omara-select-all" />
              Select all ({records.length})
            </label>
            {props.mode === "linked"
              ? <Button type="button" size="sm" disabled={!!busy || ![...checked].some((m) => records.some((a) => a.marn === m))} onClick={() => void linkSelected()} data-testid="omara-link">{busy === "link" ? "Linking…" : `Link selected (${[...checked].filter((m) => records.some((a) => a.marn === m)).length})`}</Button>
              : <p className="text-xs text-foreground-600">{checked.size} selected: linked when you create the business. Check each official record first.</p>}
          </div>
          <ul className="mt-2 max-h-80 divide-y divide-background-200 overflow-y-auto rounded-md border border-background-200 bg-white">{records.map((a) => <AgentCard key={a.marn} a={a} checked={checked.has(a.marn)}
            onToggle={disabled ? undefined : (v) => { const next = new Set(checked); if (v) next.add(a.marn); else next.delete(a.marn); setSelection(next); }} />)}</ul>
        </div>
      ) : ran && !searchOnly.length && !error ? <p className="mt-2 text-xs text-foreground-500">Nothing to link from this search.</p> : null}

      {searchOnly.length ? (
        <div className="mt-3">
          <p className="text-xs font-semibold text-foreground-700">Found in search, not verified ({searchOnly.length})</p>
          <ul className="mt-1 space-y-1 text-xs text-foreground-600">{searchOnly.map((a) => a.verification === "search_only" ? (
            <li key={a.contactId}><a className="underline" href={a.sourceUrl} target="_blank" rel="noreferrer">{a.title || a.sourceUrl}</a> — {a.reason}</li>) : null)}</ul>
        </div>
      ) : null}
    </section>
  );
}
