import { PortalRole, PortalProfile, PortalAgency, PortalMembership, ActionResult, PortalAuthValue, PortalAuthContext, portalPasswordResetUrl, usePortalAuth } from "./portalAuthContext";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRef } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/pages/admin/lib/supabase";
import { countPortalMetric } from "@/pages/agency/lib/devMetrics";
import { passwordRecoveryUrl } from "@/lib/siteUrl";
import { useNavigate } from "react-router-dom";
import { markSessionSeen } from "@/lib/loginRouting";
import { portalAccessMessage } from "@/pages/agency/lib/applicationAccess";
import { currentPortalScope, setPortalScope, flushPortalBeforeSwitch, type PortalScope } from "@/lib/portalScope";

function basePathPrefix(): string {
  const base = __BASE_PATH__.split("/").filter(Boolean).join("/");
  return base ? `/${base}` : "";
}

function mapAuthUser(user: User) {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const metaName = String(meta.full_name ?? meta.name ?? "").trim();
  const email = user.email ?? "";
  const fallback = email ? email.split("@")[0] : "User";
  return { id: user.id, email, name: metaName || fallback };
}

function mapProfile(row: Record<string, unknown>): PortalProfile {
  return {
    id: String(row.id),
    fullName: String(row.full_name ?? ""),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    jobTitle: String(row.job_title ?? ""),
    status: String(row.status ?? "Active"),
  };
}

function mapAgency(row: Record<string, unknown>): PortalAgency {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    code: String(row.code ?? ""),
    registrationNumber: String(row.registration_number ?? ""),
    businessEmail: String(row.business_email ?? ""),
    phone: String(row.phone ?? ""),
    address: String(row.address ?? ""),
    country: String(row.country ?? ""),
    primaryContact: String(row.primary_contact ?? ""),
    status: String(row.status ?? "Active"),
    isPermanent: Boolean(row.is_permanent),
  };
}

export function PortalAuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [scopes, setScopes] = useState<PortalScope[]>([]);
  const [selectedScope, setSelectedScope] = useState<PortalScope | null>(null);
  const [scopeEpoch, setScopeEpoch] = useState(0);
  const identitySequence = useRef(0);
  const [authUser, setAuthUser] = useState<{ id: string; email: string; name: string } | null>(null);
  const [role, setRole] = useState<PortalRole | null>(null);
  const [profile, setProfile] = useState<PortalProfile | null>(null);
  const [agency, setAgency] = useState<PortalAgency | null>(null);
  const [membership, setMembership] = useState<PortalMembership | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityError, setIdentityError] = useState("");
  const identityRef = useRef<{ userId: string; at: number; pending: Promise<void> | null }>({ userId: "", at: 0, pending: null });

  const clearIdentity = useCallback(() => {
    ++identitySequence.current;
    identityRef.current = { userId: "", at: 0, pending: null };
    setScopes([]);
    setPortalScope(null);
    setSelectedScope(null);
    setRole(null);
    setProfile(null);
    setAgency(null);
    setMembership(null);
  }, []);

  const resolveIdentity = useCallback(
    async (u: { id: string; email: string; name: string }, requestedKey?: string, force = false) => {
      const stamp = Date.now();
      if (!force && identityRef.current.userId === u.id && stamp - identityRef.current.at < 120000) {
        if (identityRef.current.pending) return identityRef.current.pending;
        return;
      }
      const sequence = ++identitySequence.current;
      identityRef.current.userId = u.id;
      identityRef.current.at = stamp;
      setIdentityLoading(true);
      setIdentityError("");
      const task = (async () => { try {
        countPortalMetric("identity.fetch");
        // Accept a pending invitation for this verified email and learn why access may be missing (database-resolved).
        let accessState = "active";
        try {
          const { data: access } = await supabase.rpc("portal_resolve_access");
          accessState = String((access as { state?: string } | null)?.state ?? "active");
        } catch { /* older database without migration 86: fall back to the identity check */ }
        const { data: options, error: optionsError } = await supabase.rpc("portal_scope_options");
        if (optionsError) throw new Error(optionsError.message);
        const available: PortalScope[] = (options.choices ?? []).map((item: { tenantId: string; name: string; domain: string }) => ({ key: item.tenantId, tenantId: item.tenantId, name: item.name, domain: item.domain, userId: u.id }));
        if (options.legacyAllowed) available.unshift({ key: "legacy", tenantId: null, name: "Skyline (existing portal)", domain: null, userId: u.id });
        if (sequence !== identitySequence.current) return;
        setScopes(available);
        let stored: string | null = null;
        try { stored = sessionStorage.getItem("skyline-portal-scope:" + u.id); } catch { /* storage unavailable */ }
        const wanted = requestedKey ?? stored ?? available[0]?.key;
        const selected = available.find((option) => option.key === wanted);
        if (!selected && available.length === 0 && !["active", "org_admin"].includes(accessState)) throw new Error(portalAccessMessage(accessState));
        if (!selected) {
          setPortalScope({ key: "denied", tenantId: null, name: "Unavailable", domain: "unavailable.invalid", userId: u.id });
          setRole(null); setProfile(null); setAgency(null); setMembership(null); setSelectedScope(null);
          throw new Error("The selected institution is no longer authorized. Choose an available institution.");
        }
        setPortalScope(selected);
        const { data, error } = await supabase.rpc("portal_identity");
        if (error) throw new Error(error.message);
        const identity = (data ?? {}) as { role?: PortalRole | null; profile_id?: string | null; agency_id?: string | null };
        if (!identity.role) throw new Error(accessState === "active" || accessState === "org_admin" ? "Access to this institution is not granted." : portalAccessMessage(accessState));
        const [p, a, m] = await Promise.all([
          identity.profile_id ? supabase.from("portal_profiles").select("id,full_name,email,phone,job_title,status").eq("id", identity.profile_id).maybeSingle() : Promise.resolve({data:null,error:null}),
          identity.agency_id ? supabase.from("agencies").select("*").eq("id", identity.agency_id).maybeSingle() : Promise.resolve({data:null,error:null}),
          identity.profile_id ? supabase.from("agency_memberships").select("role,status").eq("user_id", identity.profile_id).maybeSingle() : Promise.resolve({data:null,error:null}),
        ]);
        if (sequence !== identitySequence.current) return;
        if (p.error || a.error || m.error) throw new Error("Could not load authorized portal details.");
        setRole(identity.role);
        setProfile(p.data ? mapProfile(p.data as Record<string, unknown>) : null);
        setAgency(a.data ? mapAgency(a.data as Record<string, unknown>) : null);
        setMembership(m.data ? { role: m.data.role === "agency_admin" ? "agency_admin" : "agent", status: String(m.data.status) } : null);
        setSelectedScope(selected);
        try { sessionStorage.setItem("skyline-portal-scope:" + u.id, selected.key); } catch { /* storage unavailable */ }
      } catch (e) {
        if (sequence !== identitySequence.current) return;
        setRole(null); setProfile(null); setAgency(null); setMembership(null);
        setIdentityError(e instanceof Error ? e.message : "Could not verify institution access.");
      } finally {
        if (sequence === identitySequence.current) { setIdentityLoading(false); identityRef.current.pending = null; }
      } })();
      identityRef.current.pending = task;
      return task;
    }, []);

  const selectScope = useCallback(async (key: string) => {
    if (!authUser || !scopes.some((option) => option.key === key)) return;
    try {
      await flushPortalBeforeSwitch();
      setRole(null); setProfile(null); setAgency(null); setMembership(null);
      await resolveIdentity(authUser, key, true);
      setScopeEpoch((epoch) => epoch + 1);
      navigate("/agency/dashboard", { replace: true });
    } catch (e) { setIdentityError(e instanceof Error ? e.message : "Save changes before switching institution."); }
  }, [authUser, scopes, resolveIdentity, navigate]);

  useEffect(() => {
    let active = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        countPortalMetric("auth.getSession");
        if (!active) return;
        const nextUser = data.session?.user ? mapAuthUser(data.session.user) : null;
        setAuthUser(nextUser);
        setAuthLoading(false);
        if (nextUser) void resolveIdentity(nextUser);
      })
      .catch(() => {
        if (active) {
          setAuthLoading(false);
          setIdentityError("We could not verify your session.");
        }
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      // Keep this callback synchronous — only update local auth state here.
      const nextUser = session?.user ? mapAuthUser(session.user) : null;
      setAuthUser(nextUser);
      if (nextUser) void resolveIdentity(nextUser);
      else clearIdentity();
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [resolveIdentity, clearIdentity]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error || !data.user) {
      return { ok: false, error: error?.message ?? "Incorrect email or password." };
    }
    return { ok: true };
  }, []);

  const signOut = useCallback(async () => {
    await flushPortalBeforeSwitch();
    await supabase.auth.signOut();
    markSessionSeen(false);
    setAuthUser(null);
    clearIdentity();
  }, [clearIdentity]);

  const requestReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: portalPasswordResetUrl(),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, []);

  const reloadIdentity = useCallback(async () => {
    if (authUser) await resolveIdentity(authUser, currentPortalScope()?.key, true);
  }, [authUser, resolveIdentity]);

  const updateOwnProfile = useCallback(
    async (patch: Partial<Pick<PortalProfile, "fullName" | "phone" | "jobTitle">>) => {
      if (!authUser) return { ok: false, error: "You are not signed in." };
      const { error } = await supabase
        .from("portal_profiles")
        .update({
          full_name: patch.fullName ?? profile?.fullName ?? authUser.name,
          phone: patch.phone ?? profile?.phone ?? "",
          job_title: patch.jobTitle ?? profile?.jobTitle ?? "",
          updated_at: new Date().toISOString(),
        })
        .eq("auth_user_id", authUser.id);
      if (error) return { ok: false, error: error.message };
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              fullName: patch.fullName ?? prev.fullName,
              phone: patch.phone ?? prev.phone,
              jobTitle: patch.jobTitle ?? prev.jobTitle,
            }
          : prev,
      );
      return { ok: true };
    },
    [authUser, profile],
  );

  // Supabase does not expose a plaintext-password comparison API. Signing in
  // with the current account's email is the supported verification mechanism;
  // it refreshes the same user's session only after the password is valid.
  const changeOwnPassword = useCallback(async (currentPassword: string, password: string) => {
    if (!authUser?.email) return { ok: false, error: "You are not signed in." };
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email: authUser.email, password: currentPassword });
    if (verifyError) return { ok: false, error: "Your current password is incorrect." };
    const { error } = await supabase.auth.updateUser({ password });
    return error ? { ok: false, error: error.message } : { ok: true };
  }, [authUser?.email]);

  const value = useMemo<PortalAuthValue>(
    () => ({
      authUser,
      scopes, selectedScope, scopeEpoch, selectScope,
      role,
      profile,
      agency,
      membership,
      authLoading,
      identityLoading,
      identityError,
      signIn,
      signOut,
      requestReset,
      reloadIdentity,
      updateOwnProfile,
      changeOwnPassword,
    }),
    [
      authUser,
      scopes, selectedScope, scopeEpoch, selectScope,
      role,
      profile,
      agency,
      membership,
      authLoading,
      identityLoading,
      identityError,
      signIn,
      signOut,
      requestReset,
      reloadIdentity,
      updateOwnProfile,
      changeOwnPassword,
    ],
  );

  return <PortalAuthContext.Provider value={value}>
    {authUser && scopes.length > 0 ? <div className="border-b border-background-200 bg-background-50 px-5 py-3">
      <label className="flex items-center gap-3 text-sm">Institution
        <select aria-label="Institution" className="rounded border border-background-300 px-3 py-2" value={selectedScope?.key ?? ""} disabled={identityLoading} onChange={(event) => void selectScope(event.target.value)}>
          {!selectedScope ? <option value="">Choose an institution</option> : null}
          {scopes.map((scope) => <option key={scope.key} value={scope.key}>{scope.name}</option>)}
        </select>
      </label>
    </div> : null}
    {children}
  </PortalAuthContext.Provider>;
}
