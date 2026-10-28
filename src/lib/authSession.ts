import { isAuthRetryableFetchError, type Session } from "@supabase/supabase-js";
import { supabase } from "@/pages/admin/lib/supabase";

/**
 * Restoring a saved session has three outcomes, and only "none" means signed out:
 *  - session: usable (refreshed first when the access token had expired);
 *  - none: nothing saved, or the refresh token was rejected as invalid / revoked (supabase-js then clears the session);
 *  - unavailable: the refresh could not be attempted right now (offline, server unreachable). The saved session is kept
 *    and the caller must show a loader and retry, never redirect to the login page.
 */
export type SessionCheck = { kind: "session"; session: Session } | { kind: "none" } | { kind: "unavailable" };

/** A network-type failure rather than a decision by the auth server. */
export function isTransientAuthError(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  if (error instanceof TypeError) return true; // fetch rejects with TypeError when the network is down
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export async function checkSession(): Promise<SessionCheck> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (data.session) return { kind: "session", session: data.session };
    return error && isTransientAuthError(error) ? { kind: "unavailable" } : { kind: "none" };
  } catch (error) {
    return isTransientAuthError(error) ? { kind: "unavailable" } : { kind: "none" };
  }
}

const RETRY_MS = 5000;

/**
 * Runs `attempt` again every few seconds, and immediately when the browser comes back online or the tab becomes visible,
 * until it returns true. Returns a function that stops the retrying.
 */
export function retryUntil(attempt: () => Promise<boolean>): () => void {
  let stopped = false;
  let running = false;
  const cleanup = () => {
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", onVisible);
  };
  async function run() {
    if (stopped || running) return;
    running = true;
    try {
      if (await attempt()) cleanup();
    } catch {
      /* try again on the next tick */
    } finally {
      running = false;
    }
  }
  function onVisible() {
    if (document.visibilityState === "visible") void run();
  }
  const timer = window.setInterval(() => void run(), RETRY_MS);
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", onVisible);
  return cleanup;
}
