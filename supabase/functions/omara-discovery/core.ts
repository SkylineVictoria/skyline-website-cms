// omara-discovery: the actions, with every outside call behind a port (the Edge Function wires Supabase, fetch and the clock; the
// offline tests wire mocks). See _shared/omara.ts for the method (search API + one plain GET per public detail page, nothing else).
import { loadRules, ruleBool, ruleList, ruleNumber, ruleText, type RuleValues } from "../_shared/business-rules.ts";
import {
  allowedHosts, DEFAULTS, discover, fetchPage, fromRow, OMARA_HOST, OmaraError, parseDetailUrl, parseOmaraDetail, readDetails, scoreMatch, upsertPayload, webSearch,
  type BusinessFacts, type DiscoveredAgent, type OmaraAgent, type Provider,
} from "../_shared/omara.ts";

export const RULE_IDS = ["omara.discovery_enabled", "omara.search_provider", "omara.max_search_queries", "omara.max_agent_pages", "omara.request_gap_ms",
  "omara.match_threshold", "omara.reverify_days", "omara.allowed_domains", "omara.search_cost_usd"];

export interface Ports {
  isAdmin(): Promise<boolean>;
  callerId(): Promise<string | null>;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  /** Service-role RPC (key getters, upserts, run log). */
  service(fn: string, args: Record<string, unknown>): Promise<unknown>;
  /** Service-role reads of omara_agents. */
  agentsByContact(contactIds: string[], since: string | null): Promise<Record<string, unknown>[]>;
  agentByMarn(marn: string): Promise<Record<string, unknown> | null>;
  agencyFacts(agencyId: string): Promise<(BusinessFacts & { abn?: string | null }) | null>;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): Date;
}
export class ActionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const uuid = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null);
const connectorOf = (p: Provider) => (p === "brave" ? "brave_search" : "tavily");

interface Settings { enabled: boolean; provider: Provider; maxQueries: number; maxPages: number; gapMs: number; threshold: number; reverifyDays: number; allowed: string[]; costUsd: number }
export function settingsFrom(r: RuleValues): Settings {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    enabled: ruleBool(r, "omara.discovery_enabled", true),
    provider: ruleText(r, "omara.search_provider", "Brave").toLowerCase() === "tavily" ? "tavily" : "brave",
    maxQueries: clamp(ruleNumber(r, "omara.max_search_queries", DEFAULTS.maxQueries), 1, 20),
    maxPages: clamp(ruleNumber(r, "omara.max_agent_pages", DEFAULTS.maxPages), 1, 50),
    // Never faster than one request every 500 ms, whatever the rule says.
    gapMs: clamp(ruleNumber(r, "omara.request_gap_ms", DEFAULTS.gapMs), 500, 10000),
    threshold: clamp(ruleNumber(r, "omara.match_threshold", DEFAULTS.threshold), 0, 100),
    reverifyDays: clamp(ruleNumber(r, "omara.reverify_days", DEFAULTS.reverifyDays), 0, 365),
    allowed: allowedHosts(ruleList(r, "omara.allowed_domains", DEFAULTS.allowed)),
    costUsd: Math.max(0, ruleNumber(r, "omara.search_cost_usd", DEFAULTS.costUsd)),
  };
}

function factsFrom(body: Record<string, unknown>, stored: BusinessFacts | null): BusinessFacts {
  const names = [...(Array.isArray(body.names) ? body.names : []).map((n) => str(n, 200)), ...(stored?.names ?? [])].filter(Boolean);
  return { names: [...new Set(names)].slice(0, 8), website: str(body.website) || stored?.website || null,
    postcode: str(body.postcode, 4) || stored?.postcode || null, state: str(body.state, 3).toUpperCase() || stored?.state || null };
}

async function save(ports: Ports, agents: DiscoveredAgent[]): Promise<void> {
  for (const a of agents) if (a.verification === "verified") await ports.service("omara_agent_upsert", { p: upsertPayload(a as OmaraAgent) });
}
async function record(ports: Ports, run: Record<string, unknown>): Promise<string | null> {
  try { return (await ports.service("omara_discovery_run_record", { p: { ...run, createdBy: await ports.callerId() } })) as string; } catch { return null; }
}
async function keyFor(ports: Ports, provider: Provider): Promise<string | null> {
  try { return ((await ports.service("integration_search_api_key", { p_connector: connectorOf(provider) })) as string | null) || null; } catch { return null; }
}
const storedPort = (ports: Ports, s: Settings) => async (ids: string[]) => {
  const map = new Map<string, OmaraAgent>();
  if (!ids.length) return map;
  // reverify_days 0 = never fetch again automatically: any stored record is used.
  const since = s.reverifyDays === 0 ? null : new Date(ports.now().getTime() - s.reverifyDays * 86_400_000).toISOString();
  for (const r of await ports.agentsByContact(ids, since)) { const a = fromRow(r); if (a.contactId) map.set(a.contactId, a); }
  return map;
};

export async function handle(body: Record<string, unknown>, ports: Ports): Promise<Record<string, unknown>> {
  if (!(await ports.isAdmin())) throw new ActionError("Only administrators can look up registered migration agents.", 403);
  const action = str(body.action, 40);
  const s = settingsFrom(await loadRules({ rpc: (fn, args) => ports.rpc(fn, args) as PromiseLike<{ data: unknown; error: unknown }> }, RULE_IDS));

  if (action === "status") {
    const key = await keyFor(ports, s.provider);
    return { enabled: s.enabled, configured: !!key, provider: s.provider, threshold: s.threshold, maxPages: s.maxPages };
  }

  if (action === "discover") {
    const agencyId = uuid(body.agencyId);
    const stored = agencyId ? await ports.agencyFacts(agencyId) : null;
    const facts = factsFrom(body, stored);
    const abn = str(body.abn, 14).replace(/\D/g, "") || stored?.abn || null;
    if (!facts.names.length) throw new ActionError("Give the business's name to search for.");
    if (!s.enabled) return { enabled: false, configured: false, provider: s.provider, agents: [], message: "Finding agents automatically is switched off (Business Rules › omara.discovery_enabled). Paste OMARA links instead." };
    const key = await keyFor(ports, s.provider);
    const out = await discover(facts, { provider: s.provider, key, fetch: ports.fetch, sleep: ports.sleep, now: ports.now, maxQueries: s.maxQueries,
      maxPages: s.maxPages, gapMs: s.gapMs, threshold: s.threshold, allowed: s.allowed, stored: storedPort(ports, s) });
    if (!out.configured) {
      return { enabled: true, configured: false, provider: s.provider, agents: [],
        message: `No ${s.provider === "brave" ? "Brave Search" : "Tavily"} key is saved (Integrations › Connections). Paste OMARA links instead.` };
    }
    await save(ports, out.agents);
    const estCostUsd = Math.round(out.searches * s.costUsd * 10000) / 10000;
    const runId = await record(ports, { agencyId, abn, names: facts.names, provider: s.provider, queries: out.queries, results: out.results,
      pagesFetched: out.pagesFetched, estCostUsd, error: out.errors.join(" | ").slice(0, 500) || null });
    return { enabled: true, configured: true, provider: s.provider, threshold: s.threshold, agents: out.agents,
      run: { id: runId, queries: out.queries, results: out.results, pagesFetched: out.pagesFetched, searches: out.searches, estCostUsd, errors: out.errors } };
  }

  if (action === "import_urls") {
    const agencyId = uuid(body.agencyId);
    const stored = agencyId ? await ports.agencyFacts(agencyId) : null;
    const facts = factsFrom(body, stored);
    const raw = (Array.isArray(body.urls) ? body.urls : typeof body.urls === "string" ? body.urls.split(/\s+/) : []).map((u) => str(u, 1000)).filter(Boolean);
    if (!raw.length) throw new ActionError("Paste at least one OMARA agent link.");
    const links = new Map<string, { contactId: string; url: string }>();
    const rejected: string[] = [];
    for (const u of raw) { const d = parseDetailUrl(u, s.allowed); if (d) links.set(d.contactId, d); else rejected.push(u); }
    if (!links.size) throw new ActionError(`None of these is an OMARA agent page (${OMARA_HOST}/…/register-of-migration-agent-details/?ContactID=…).`);
    const capped = [...links.values()].slice(0, s.maxPages);
    const read = await readDetails(capped, facts, { provider: null, key: null, fetch: ports.fetch, sleep: ports.sleep, now: ports.now, maxQueries: 0, maxPages: s.maxPages,
      gapMs: s.gapMs, threshold: s.threshold, allowed: s.allowed });
    await save(ports, read.agents);
    const runId = await record(ports, { agencyId, abn: str(body.abn, 14).replace(/\D/g, "") || stored?.abn || null, names: facts.names, provider: "manual",
      queries: [], results: capped.length, pagesFetched: read.pagesFetched, estCostUsd: 0, error: read.errors.join(" | ").slice(0, 500) || null });
    return { agents: read.agents, rejected, skipped: links.size - capped.length, run: { id: runId, pagesFetched: read.pagesFetched, errors: read.errors } };
  }

  if (action === "link") {
    const agencyId = uuid(body.agencyId);
    const marns = (Array.isArray(body.marns) ? body.marns : []).map((m) => str(m, 7)).filter((m) => /^\d{7}$/.test(m));
    if (!agencyId || !marns.length) throw new ActionError("Choose the business and at least one agent.");
    const { data, error } = await ports.rpc("omara_link_agents", { p_agency: agencyId, p_marns: marns, p_evidence: body.evidence && typeof body.evidence === "object" ? body.evidence : {} });
    if (error) throw new ActionError((error as { message?: string }).message ?? "The agents could not be linked.");
    return data as Record<string, unknown>;
  }

  if (action === "refresh") {
    const marn = str(body.marn, 7);
    if (!/^\d{7}$/.test(marn)) throw new ActionError("A MARN has 7 digits.");
    const row = await ports.agentByMarn(marn);
    if (!row) throw new ActionError("This agent has not been read from the register yet.", 404);
    const link = parseDetailUrl(String(row.source_url ?? ""), s.allowed);
    if (!link) throw new ActionError("This agent's register link is not on an allowed address.");
    try {
      const agent = parseOmaraDetail(await fetchPage(link.url, ports.fetch), link.url, ports.now().toISOString());
      if (!agent) throw new OmaraError("The page is not an agent record any more.", "not_found", 404);
      if (agent.marn !== marn) throw new OmaraError(`The page now shows MARN ${agent.marn}, not ${marn}.`, "not_found", 404);
      const saved = await ports.service("omara_agent_upsert", { p: upsertPayload(agent) }) as { outcome?: string; changed?: unknown } | null;
      const agencyId = uuid(body.agencyId);
      const facts = agencyId ? await ports.agencyFacts(agencyId) : null;
      return { agent: { ...agent, ...(facts ? scoreMatch(agent, facts) : {}), verification: "verified" }, outcome: saved?.outcome ?? null, changed: saved?.changed ?? {} };
    } catch (e) {
      const code = e instanceof OmaraError ? e.code : "error";
      await ports.service("omara_agent_check_failed", { p_marn: marn, p_url: link.url, p_outcome: code === "not_found" ? "not_found" : "error" }).catch(() => null);
      throw new ActionError(e instanceof Error ? e.message : "The register could not be read.", e instanceof OmaraError && e.status === 404 ? 404 : 502);
    }
  }

  if (action === "check") {
    const provider: Provider = str(body.connector, 20) === "tavily" ? "tavily" : str(body.connector, 20) === "brave_search" ? "brave" : s.provider;
    const key = await keyFor(ports, provider);
    if (!key) return { ok: false, configured: false, provider, message: "No key is saved for this connection." };
    try {
      const hits = await webSearch(provider, key, `site:${OMARA_HOST} "Registered migration agent details"`, ports.fetch, s.allowed);
      await ports.service("integration_search_check_record", { p_connector: connectorOf(provider), p_ok: true, p_code: "" }).catch(() => null);
      return { ok: true, configured: true, provider, results: hits.length };
    } catch (e) {
      const code = e instanceof OmaraError ? e.code : "error";
      await ports.service("integration_search_check_record", { p_connector: connectorOf(provider), p_ok: false, p_code: code }).catch(() => null);
      return { ok: false, configured: true, provider, code, message: e instanceof Error ? e.message : "The search failed." };
    }
  }

  throw new ActionError("Unknown action.");
}
