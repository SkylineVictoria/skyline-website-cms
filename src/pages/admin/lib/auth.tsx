import { defaultUsers, passwordResetUrl, SessionUser, LoginResult, AuthContextValue, AuthContext, useAuth } from "./authContext";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import type { AdminUser, Role } from "@/pages/admin/lib/types";
import { passwordRecoveryUrl } from "@/lib/siteUrl";
import { markSessionSeen } from "@/lib/loginRouting";
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

/** Resolve a session to a CMS staff member. Returns null when the signed-in
 * user has no (active) CMS profile — i.e. they must not access the CMS. */
async function resolveSessionUser(authUserId: string | undefined, email: string | undefined): Promise<SessionUser | null> {
  if (!authUserId && !email) return null;
  if (requestWebsiteDomain()) {
    try {
      await resolveTenantSite();
      // Claim any pending invitation for this institution (needs a confirmed email); a failure must not block sign-in.
      try { await supabase.rpc("tenant_accept_pending_invites"); } catch { /* the invitation stays pending */ }
      const { data, error } = await supabase.rpc("tenant_cms_identity");
      return error || !data ? null : data as SessionUser;
    } catch { return null; }
  }
  const base = supabase
    .from("cms_users")
    .select("id, name, email, role, status, must_change_password");
  const query = authUserId ? base.eq("auth_user_id", authUserId) : base.ilike("email", email as string);
  const { data } = await query.maybeSingle();
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
  const [users, setUsers] = useState<AdminUser[]>([]);
  const usersRef = useRef<AdminUser[]>([]);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    let active = true;

    const applySession = async (authUserId: string | undefined, email: string | undefined) => {
      const resolved = await resolveSessionUser(authUserId, email);
      if (!active) return;
      setUser(resolved);
      if (resolved) {
        const profiles = await fetchProfiles();
        if (active && profiles.length) setUsers(profiles);
      }
      if (active) setAuthLoading(false);
    };

    supabase.auth
      .getSession()
      .then(({ data }) => {
        void applySession(data.session?.user?.id, data.session?.user?.email);
      })
      .catch(() => {
        if (active) setAuthLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      // Keep this callback synchronous: only react to the auth state here.
      void applySession(session?.user?.id, session?.user?.email);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

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
      await supabase.auth.signOut();
      return { ok: false, error: "This account does not have access to the CMS." };
    }
    const profiles = await fetchProfiles();
    if (profiles.length) setUsers(profiles);
    setUser(resolved);
    return { ok: true, mustChangePassword: resolved.mustChangePassword };
  }, []);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
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
    () => ({ user, authLoading, users, login, logout, can, saveUsers, refreshUsers, changePassword, verifyAndChangePassword, sendPasswordReset }),
    [user, authLoading, users, login, logout, can, saveUsers, refreshUsers, changePassword, verifyAndChangePassword, sendPasswordReset],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
