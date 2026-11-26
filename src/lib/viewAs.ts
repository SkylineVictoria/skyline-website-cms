// Switch view: an administrator opens the Student, Agent or Staff workspace as that workspace's shared test account, or as a
// chosen real student, agent or staff member (full access; every switch is recorded with the person), then
// returns to their own admin session. The admin-view-as Edge Function (admins only) hands back a one-time sign-in token for the
// test account; the admin's own session is kept in this browser while they look around and restored by "Back to admin".
// The kept session is dropped on any sign-out, when another account is signed in, and after admin.view_as_hours (12 hours).
import { supabase } from "@/pages/admin/lib/supabase";
import { onRules, rulesLoaded, ruleNumber } from "@/lib/businessRules";

export type ViewKind = "student" | "agent" | "staff";
export const VIEW_LABELS: Record<ViewKind, string> = { student: "Student", agent: "Agent", staff: "Staff" };
const VIEW_HOME: Record<ViewKind, string> = { student: "/agency/dashboard", agent: "/agency/dashboard", staff: "/staff" };
const KEY = "skyline.viewAs";
/** How long the kept admin session lasts: Business Rule admin.view_as_hours (12 until the values load). */
const maxAgeMs = () => Math.max(1, ruleNumber("admin.view_as_hours", 12)) * 60 * 60 * 1000;

export interface ViewAsState { kind: ViewKind; adminEmail: string; testUserId: string | null; at: number; access: string; refresh: string; personName?: string }
/** Someone an admin can sign in as. */
export interface ViewPerson { userId: string; name: string; email: string; detail: string }

/** VIEW-AS-ALL-AGENTS: an agent in the grouped list (every agent of Master Data, with or without a login). */
export interface ViewAgent { id: string; name: string; email: string; status: string; hasLogin: boolean }
export interface ViewAgentGroup { business: { id: string | null; name: string }; agents: ViewAgent[] }

async function failure(error: unknown, fallback: string): Promise<string> {
  if (error && typeof error === "object" && "context" in error && error.context instanceof Response) {
    try { return (await error.context.clone().json()).error || fallback; } catch { /* keep default */ }
  }
  return fallback;
}

/** Every agent, grouped by business (A-Z), matching a business name, agent name or email. */
export async function listViewAgents(query: string): Promise<ViewAgentGroup[]> {
  // Read from the database for the signed-in administrator (migration 20261126230517); the function's list is the fallback.
  const direct = await supabase.rpc("admin_view_as_agents_list", { p_query: query.slice(0, 80) });
  if (!direct.error && Array.isArray(direct.data)) return direct.data as ViewAgentGroup[];
  if (direct.error?.code === "42501") throw new Error("Administrator access required.");
  const { data, error } = await supabase.functions.invoke("admin-view-as", { body: { kind: "agent", action: "agents", query } });
  if (error || !Array.isArray(data?.groups)) throw new Error(await failure(error, "The list could not be loaded. Is the Sign in as update applied?"));
  return data.groups as ViewAgentGroup[];
}

/** Signing in by agent needs admin-view-as with the agent path (an older one would open the test account instead). */
async function agentSwitchReady(): Promise<boolean> {
  const { data } = await supabase.functions.invoke("admin-view-as", { body: { action: "version" } }).catch(() => ({ data: null }));
  return Number(data?.version ?? 0) >= 2;
}

/** Closes the admin's open switch in the audit (Back to admin, or before the next switch). Best effort. */
async function endSwitch(): Promise<void> {
  await supabase.functions.invoke("admin-view-as", { body: { action: "end" } }).catch(() => undefined);
}

/** People of a workspace an admin can sign in as, matching a name or email (at most 25). */
export async function listViewPeople(kind: ViewKind, query: string): Promise<ViewPerson[]> {
  const { data, error } = await supabase.functions.invoke("admin-view-as", { body: { kind, action: "people", query } });
  if (error || !Array.isArray(data?.people)) {
    let message = "The list could not be loaded.";
    if (error && "context" in error && error.context instanceof Response) { try { message = (await error.context.clone().json()).error || message; } catch { /* keep default */ } }
    throw new Error(message);
  }
  return data.people as ViewPerson[];
}

export function readViewAs(): ViewAsState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as ViewAsState;
    if (!v || !v.refresh || !v.access || !(v.kind in VIEW_LABELS) || Date.now() - v.at > maxAgeMs()) { localStorage.removeItem(KEY); return null; }
    return v;
  } catch { return null; }
}
// Once the Business Rules values load, a kept session older than the rule allows is dropped.
onRules(() => { if (rulesLoaded()) readViewAs(); });
export function clearViewAs(): void { try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ } }
function save(v: ViewAsState): void { localStorage.setItem(KEY, JSON.stringify(v)); }

/** Opens a workspace as its test account, or as the given person. Navigates on success; throws with a readable message otherwise. */
export async function switchView(kind: ViewKind, person?: { userId?: string; agentId?: string; name: string }): Promise<void> {
  // Already looking at a test account: go back to the admin session first (only an admin may ask for a switch).
  const current = readViewAs();
  if (current) {
    const { error } = await supabase.auth.setSession({ access_token: current.access, refresh_token: current.refresh });
    if (error) { clearViewAs(); throw new Error("Your admin session has ended. Sign in again."); }
    clearViewAs();
    await endSwitch();
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in again to switch view.");
  if (person?.agentId && !(await agentSwitchReady())) {
    throw new Error("Signing in as an agent needs the admin-view-as update to be deployed (Deploy Edge Functions on GitHub). The list is ready; ask an administrator to run the deploy.");
  }
  const { data, error } = await supabase.functions.invoke("admin-view-as", { body: person?.agentId ? { kind, agentId: person.agentId } : person ? { kind, userId: person.userId } : { kind } });
  if (error || !data?.tokenHash) {
    let message = "Switch view is not available yet.";
    if (error && "context" in error && error.context instanceof Response) { try { message = (await error.context.clone().json()).error || message; } catch { /* keep default */ } }
    else if (data?.error) message = String(data.error);
    throw new Error(message);
  }
  const personName = person?.name;
  save({ kind, adminEmail: session.user.email ?? "", testUserId: null, at: Date.now(), access: session.access_token, refresh: session.refresh_token, personName });
  const signedIn = await supabase.auth.verifyOtp({ token_hash: String(data.tokenHash), type: "magiclink" });
  if (signedIn.error || !signedIn.data.user) {
    await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token }).catch(() => undefined);
    clearViewAs();
    throw new Error(person ? `Could not sign in as ${person.name}. Try again.` : "The test account could not be opened. Try again.");
  }
  save({ kind, adminEmail: session.user.email ?? "", testUserId: signedIn.data.user.id, at: Date.now(), access: session.access_token, refresh: session.refresh_token, personName });
  window.location.assign(VIEW_HOME[kind]);
}

/** Restores the administrator's own session and opens the admin area. */
export async function returnToAdmin(): Promise<void> {
  const v = readViewAs();
  clearViewAs();
  if (!v) { window.location.assign("/admin"); return; }
  const { error } = await supabase.auth.setSession({ access_token: v.access, refresh_token: v.refresh });
  if (error) { await supabase.auth.signOut().catch(() => undefined); window.location.assign("/login"); return; }
  await endSwitch();
  window.location.assign("/admin");
}
