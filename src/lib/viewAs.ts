// Switch view: an administrator opens the Student, Agent or Staff workspace as that workspace's shared test account, or as a
// chosen real student, agent or staff member (full access; every switch is recorded with the person), then
// returns to their own admin session. The admin-view-as Edge Function (admins only) hands back a one-time sign-in token for the
// test account; the admin's own session is kept in this browser while they look around and restored by "Back to admin".
// The kept session is dropped on any sign-out, when another account is signed in, and after 12 hours.
import { supabase } from "@/pages/admin/lib/supabase";

export type ViewKind = "student" | "agent" | "staff";
export const VIEW_LABELS: Record<ViewKind, string> = { student: "Student", agent: "Agent", staff: "Staff" };
const VIEW_HOME: Record<ViewKind, string> = { student: "/agency/dashboard", agent: "/agency/dashboard", staff: "/staff" };
const KEY = "skyline.viewAs";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface ViewAsState { kind: ViewKind; adminEmail: string; testUserId: string | null; at: number; access: string; refresh: string; personName?: string }
/** Someone an admin can sign in as. */
export interface ViewPerson { userId: string; name: string; email: string; detail: string }

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
    if (!v || !v.refresh || !v.access || !(v.kind in VIEW_LABELS) || Date.now() - v.at > MAX_AGE_MS) { localStorage.removeItem(KEY); return null; }
    return v;
  } catch { return null; }
}
export function clearViewAs(): void { try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ } }
function save(v: ViewAsState): void { localStorage.setItem(KEY, JSON.stringify(v)); }

/** Opens a workspace as its test account, or as the given person. Navigates on success; throws with a readable message otherwise. */
export async function switchView(kind: ViewKind, person?: Pick<ViewPerson, "userId" | "name">): Promise<void> {
  // Already looking at a test account: go back to the admin session first (only an admin may ask for a switch).
  const current = readViewAs();
  if (current) {
    const { error } = await supabase.auth.setSession({ access_token: current.access, refresh_token: current.refresh });
    if (error) { clearViewAs(); throw new Error("Your admin session has ended. Sign in again."); }
    clearViewAs();
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Sign in again to switch view.");
  const { data, error } = await supabase.functions.invoke("admin-view-as", { body: person ? { kind, userId: person.userId } : { kind } });
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
  window.location.assign("/admin");
}
