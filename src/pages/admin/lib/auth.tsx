import { defaultUsers, passwordResetUrl, SessionUser, LoginResult, AuthContextValue, AuthContext, useAuth } from "./authContext";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import type { AdminUser, Role } from "@/pages/admin/lib/types";
import { passwordRecoveryUrl } from "@/lib/siteUrl";
import { markSessionSeen } from "@/lib/loginRouting";
import { checkSession, retryUntil } from "@/lib/authSession";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { resolveTenantSite } from "@/lib/tenantSite";

function basePathPrefix(): string {
  const base = __BASE_PATH__.split("/").filter(Boolean).join("/");
  return base ? `/${base}` : "";
}

async function fetchProfiles(): Promise<AdminUser[]> {
  if (requestWebsiteDomain()) return [];
  const { data, error } = await supabase.from("cms_users").select("*").order("email");
  if (error) return [];
  return (data ?? []).map((u) => ({
    id: String(u.id),
    name: String(u.name ?? ""),
    email: String(u.email ?? ""),
    role: u.role === "Admin" ? "Admin" : "Editor",
    status: u.status === "Inactive" ? "Inactive" : "Active",
    lastLogin: String(u.last_login ?? ""),
  }));
}

/** The profile lookup itself failed (network, server); the user's access is unknown, so it must not be treated as "no access". */
class ProfileUnavailable extends Error {}

const SESSION_CHECK_TIMEOUT_MS = 15000;
const SESSION_UNAVAILABLE = "We couldn't verify your admin session. Check your connection and try again.";

/** Resolve a session to a CMS staff member. Returns null when the signed-in
 * user has no (active) CMS profile — i.e. they must not access the CMS.
 * Throws ProfileUnavailable when that could not be determined. */
async function resolveSessionUser(authUserId: string | undefined, email: string | undefined, signal?: AbortSignal): Promise<SessionUser | null> {
  if (!authUserId && !email) return null;
  if (requestWebsiteDomain()) {
    try {
      await resolveTenantSite();
      // Claim any pending invitation for this institution (needs a confirmed email); a failure must not block sign-in.
      const accept = supabase.rpc("tenant_accept_pending_invites");
      try { await (signal ? accept.abortSignal(signal) : accept); } catch { /* the invitation stays pending */ }
      const identity = supabase.rpc("tenant_cms_identity");
      const { data, error } = await (signal ? identity.abortSignal(signal) : identity);
      if (error) throw new ProfileUnavailable(error.message);
      return data ? data as SessionUser : null;
    } catch (error) {
      if (error instanceof ProfileUnavailable) throw error;
      throw new ProfileUnavailable(error instanceof Error ? error.message : "unavailable");
    }
  }
  const base = supabase
    .from("cms_users")
    .select("id, name, email, role, status, must_change_password");
  const query = authUserId ? base.eq("auth_user_id", authUserId) : base.ilike("email", email as string);
  const { data, error } = await (signal ? query.abortSignal(signal) : query).maybeSingle();
  if (error) throw new ProfileUnavailable(error.message);
  if (!data) return null;
  if (data.status === "Inactive") return null;
  return {
    id: String(data.id),
    name: String(data.name ?? email ?? ""),
    email: String(data.email ?? email ?? ""),
    role: data.role === "Admin" ? "Admin" : "Editor",
    mustChangePassword: Boolean(data.must_change_password),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authAttempt, setAuthAttempt] = useState(0);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const usersRef = useRef<AdminUser[]>([]);
  const retryAuth = useCallback(() => {
    setAuthError(null);
    setAuthAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    let sequence = 0;
    let stopRetry = () => {};
    let deadline: number | undefined;
    let authEventTimer: number | undefined;
    let controller: AbortController | undefined;

    const cancelPending = () => {
      sequence++;
      stopRetry();
      window.clearTimeout(authEventTimer);
      window.clearTimeout(deadline);
      controller?.abort();
    };

    const settle = (resolved: SessionUser | null, attempt: number) => {
      if (attempt !== sequence) return;
      setUser(resolved);
      setAuthLoading(false);
      setAuthError(null);
      if (!resolved) {
        setUsers([]);
        return;
      }
      // The staff directory is used by editors. Only the verified CMS identity gates entry.
      void fetchProfiles().then((profiles) => {
        if (attempt === sequence && profiles.length) setUsers(profiles);
      }).catch(() => { /* directory requests can be retried from the users screen */ });
    };

    const verify = async (attempt: number, authUser?: { id: string; email?: string }): Promise<boolean> => {
      if (attempt !== sequence) return true;
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => {
        request.abort();
        if (attempt === sequence) setAuthError(SESSION_UNAVAILABLE);
      }, SESSION_CHECK_TIMEOUT_MS);
      deadline = timeout;
      try {
        if (!authUser) {
          const check = await checkSession();
          if (attempt !== sequence) return true;
          if (check.kind === "unavailable") throw new ProfileUnavailable(SESSION_UNAVAILABLE);
          if (check.kind === "session") authUser = check.session.user;
        }
        // A session can arrive after the deadline when another tab releases the auth lock.
        // Retry with a fresh request in that case.
        if (request.signal.aborted && authUser) return false;
        const resolved = authUser ? await resolveSessionUser(authUser.id, authUser.email, request.signal) : null;
        settle(resolved, attempt);
        return true;
      } catch {
        if (attempt !== sequence) return true;
        setAuthError(SESSION_UNAVAILABLE);
        return false;
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const verifyWithRetry = (attempt: number, authUser?: { id: string; email?: string }) => {
      void verify(attempt, authUser).then((done) => {
        if (!done && attempt === sequence) stopRetry = retryUntil(() => verify(attempt));
      });
    };

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // Initial restoration is handled below. Supabase requests must run outside the auth callback's lock.
      if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      if (event === "SIGNED_OUT") {
        cancelPending();
        settle(null, sequence);
      } else if (session?.user) {
        cancelPending();
        const attempt = sequence;
        authEventTimer = window.setTimeout(() => verifyWithRetry(attempt, session.user), 0);
      }
    });
    verifyWithRetry(sequence);

    return () => {
      sub.subscription.unsubscribe();
      cancelPending();
    };
  }, [authAttempt]);

  const login: AuthContextValue["login"] = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error || !data.user) {
      return { ok: false, error: error?.message ?? "Incorrect email or password." };
    }
    const resolved = await resolveSessionUser(data.user.id, data.user.email);
    if (!resolved) {
      await supabase.auth.signOut({ scope: "local" });
      return { ok: false, error: "This account does not have access to the CMS." };
    }
    const profiles = await fetchProfiles();
    if (profiles.length) setUsers(profiles);
    setUser(resolved);
    return { ok: true, mustChangePassword: resolved.mustChangePassword };
  }, []);

  const logout = useCallback(async () => {
    await supabase.auth.signOut({ scope: "local" });
    markSessionSeen(false);
    setUser(null);
    setUsers([]);
  }, []);

  const refreshUsers = useCallback(async () => {
    const profiles = await fetchProfiles();
    if (profiles.length) setUsers(profiles);
  }, []);

  /** Rotate the signed-in user's password, then clear the forced-rotation flag. */
  const changePassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return { ok: false, error: error.message };
    // Safe SECURITY DEFINER RPC — only clears the flag for the caller.
    await supabase.rpc("cms_clear_password_rotation");
    setUser((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
    return { ok: true };
  }, []);

  const verifyAndChangePassword = useCallback(async (currentPassword: string, password: string) => {
    const { data: sessionData } = await supabase.auth.getSession();
    const email = sessionData.session?.user.email;
    if (!email) return { ok: false, error: "Your session has expired. Please sign in again." };
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
    if (verifyError) return { ok: false, error: "Your current password is incorrect." };
    const { error } = await supabase.auth.updateUser({ password });
    return error ? { ok: false, error: error.message } : { ok: true };
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: passwordResetUrl(),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, []);

  const can: AuthContextValue["can"] = useCallback(() => user?.role === "Admin", [user]);

  // Updates CMS profile rows (name/role/status) only — never auth credentials.
  const saveUsers = useCallback((next: AdminUser[]) => {
    const removed = usersRef.current.filter((u) => !next.some((n) => n.id === u.id)).map((u) => u.id);
    setUsers(next);
    void (async () => {
      try {
        const rows = next.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          status: u.status,
          last_login: u.lastLogin,
        }));
        if (rows.length) await supabase.from("cms_users").upsert(rows);
        if (removed.length) await supabase.from("cms_users").delete().in("id", removed);
      } catch (e) {
        console.error("Could not save users", e);
      }
    })();
  }, []);

  const value = useMemo(
    () => ({ user, authLoading, authError, retryAuth, users, login, logout, can, saveUsers, refreshUsers, changePassword, verifyAndChangePassword, sendPasswordReset }),
    [user, authLoading, authError, retryAuth, users, login, logout, can, saveUsers, refreshUsers, changePassword, verifyAndChangePassword, sendPasswordReset],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
