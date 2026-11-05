import { portalAccessMessage, type PortalAccessState } from "../pages/agency/lib/applicationAccess";
import type { StaffStatus } from "./staffStatus";

/**
 * Routing helpers for the single /login page. Pure and browser-free so they can be tested offline.
 * Nothing here grants access: it only decides where to send someone whose role the DATABASE already resolved
 * (cms_users / tenant_cms_identity / portal_resolve_access). RLS and the edge functions still authorize every request.
 */

export type LoginDestination = "cms" | "portal" | "staff";
export const DESTINATION_PATH: Record<LoginDestination, string> = { cms: "/admin", portal: "/agency", staff: "/staff" };
export const DESTINATION_LABEL: Record<LoginDestination, string> = { cms: "Website admin (CMS)", portal: "Agency portal", staff: "My staff application" };
export const SET_PASSWORD_PATH = "/admin/set-password";

/** A same-origin, router-relative path or null. Rejects absolute URLs, protocol-relative URLs, backslashes, control characters and /login loops. */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  // eslint-disable-next-line no-control-regex -- control characters are never valid in a return path
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value) || value.length > 2000) return null;
  let url: URL;
  try { url = new URL(value, "https://same-origin.invalid"); } catch { return null; }
  if (url.origin !== "https://same-origin.invalid") return null;
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** /login with an optional validated return path and, when a previous session existed, the expired-session notice. */
export function loginUrl(next?: string | null, expired = false): string {
  const params = new URLSearchParams();
  const safe = safeNext(next ?? null);
  if (safe) params.set("next", safe);
  if (expired) params.set("reason", "expired");
  const query = params.toString();
  return query ? `/login?${query}` : "/login";
}

/** Old login URLs (/admin/login, /agency/login): keep a safe return path from ?next= or router state, otherwise none. */
export function legacyLoginTarget(search: string, stateFrom?: unknown): string {
  const next = safeNext(new URLSearchParams(search).get("next")) ?? safeNext(stateFrom);
  return loginUrl(next);
}

export interface CmsAccess { active: boolean; mustChangePassword: boolean }
/** staff: the person's staff application status from hr_staff_access ("none" or absent when they have none). */
export interface AccessSummary { cms: CmsAccess | null; portal: PortalAccessState | null; staff?: StaffStatus | "none" | null }

export type LoginDecision =
  | { kind: "go"; to: string }
  | { kind: "password"; to: string }
  | { kind: "choose"; options: LoginDestination[] }
  | { kind: "blocked"; message: string };

/** Which kinds of access the database reports for the signed-in user. */
export function availableDestinations(access: AccessSummary): LoginDestination[] {
  const options: LoginDestination[] = [];
  if (access.cms?.active) options.push("cms");
  if (access.portal === "active" || access.portal === "org_admin") options.push("portal");
  // A staff application or account has its own workspace. Once active, an Admin uses the CMS, so the staff page is not offered beside it.
  if (access.staff && access.staff !== "none" && !(access.staff === "active" && options.includes("cms"))) options.push("staff");
  return options;
}

export function decideLogin(access: AccessSummary, next: string | null = null, last: LoginDestination | null = null): LoginDecision {
  const options = availableDestinations(access);
  if (options.length === 0) {
    if (access.cms && !access.cms.active) return { kind: "blocked", message: "This account has been suspended. Contact your administrator." };
    return { kind: "blocked", message: portalAccessMessage(access.portal) };
  }
  // The forced password change always comes first and uses the existing flow.
  if (options.includes("cms") && access.cms?.mustChangePassword) return { kind: "password", to: SET_PASSWORD_PATH };
  const target = safeNext(next);
  // An explicit return path wins when the user actually has access to that area.
  if (target) {
    if (options.includes("cms") && /^\/admin(?:[/?#]|$)/.test(target)) return { kind: "go", to: target };
    if (options.includes("portal") && /^\/agency(?:[/?#]|$)/.test(target)) return { kind: "go", to: target };
    if (options.includes("staff") && /^\/staff(?:[/?#]|$)/.test(target)) return { kind: "go", to: target };
  }
  if (options.length === 1) return { kind: "go", to: DESTINATION_PATH[options[0]] };
  // A SLIT administrator manages everything from the CMS (its menu links to the portal pages), so there is nothing to choose.
  if (access.portal === "org_admin" && options.includes("cms")) return { kind: "go", to: DESTINATION_PATH.cms };
  // Last used first, so the remembered choice is one click.
  return { kind: "choose", options: last && options.includes(last) ? [last, ...options.filter((o) => o !== last)] : options };
}

/** Where a chosen destination goes: the validated return path when it belongs to that area, otherwise the area's landing page. */
export function destinationFor(option: LoginDestination, next: string | null): string {
  const target = safeNext(next);
  if (target && (option === "cms" ? /^\/admin(?:[/?#]|$)/ : option === "staff" ? /^\/staff(?:[/?#]|$)/ : /^\/agency(?:[/?#]|$)/).test(target)) return target;
  return DESTINATION_PATH[option];
}

/** Sign-in failures. Wrong email and wrong password are deliberately indistinguishable. */
export function loginErrorMessage(error: { message?: string; status?: number; code?: string } | null | undefined): string {
  const code = error?.code ?? "";
  if (error?.status === 429 || code === "over_request_rate_limit" || /rate limit|too many/i.test(error?.message ?? "")) return "Too many attempts. Please wait a few minutes and try again.";
  if (code === "email_not_confirmed" || /not confirmed/i.test(error?.message ?? "")) return "Your invitation has not been accepted yet. Open the invitation email to set your password, or ask for it to be resent.";
  if (code === "user_banned" || /banned|suspended/i.test(error?.message ?? "")) return "This account has been suspended. Contact your administrator.";
  return "Incorrect email or password.";
}

export function loginNotice(reason: string | null): string {
  return reason === "expired" ? "Your session has expired. Please sign in again." : "";
}

/**
 * Public header account control: the same "Login / Enroll Now" button for everyone (owner's choice, 2026-11-05). /login has
 * Sign in and Enroll now side by side; someone already signed in gets "Go to my account" or "Sign out" there.
 */
export function headerAccountLink(signedIn: boolean): { label: string; to: string } {
  void signedIn;
  return { label: "Login / Enroll Now", to: "/login" };
}

const SEEN_KEY = "skyline.session.seen";
/** Remembers that someone signed in, so a later redirect to /login can say "expired" instead of nothing. Cleared on explicit sign-out. */
export function markSessionSeen(seen: boolean): void {
  try { if (seen) window.localStorage.setItem(SEEN_KEY, "1"); else window.localStorage.removeItem(SEEN_KEY); } catch { /* storage unavailable */ }
}
export function hadSession(): boolean {
  try { return window.localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; }
}

const LAST_KEY = "skyline.login.last";
export function readLastDestination(userId: string): LoginDestination | null {
  try { const v = window.localStorage.getItem(`${LAST_KEY}:${userId}`); return v === "cms" || v === "portal" || v === "staff" ? v : null; } catch { return null; }
}
export function rememberDestination(userId: string, destination: LoginDestination): void {
  try { window.localStorage.setItem(`${LAST_KEY}:${userId}`, destination); } catch { /* storage unavailable */ }
}
