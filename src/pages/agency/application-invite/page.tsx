import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { Button } from "@/pages/admin/components/ui";
import { passwordProblem } from "@/lib/passwords";

export default function ApplicationInvitePage() {
  const { authUser, authLoading, reloadIdentity, signOut } = usePortalAuth();
  const { key: locationKey } = useLocation();
  const navigate = useNavigate();
  const storeKey = `slit-application-invitation:${window.location.host}`;
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // STUDENT-PASSWORD (2026-11-24, owner): a student who opens the finish-application link creates a password before the application
  // opens, so they can sign in to their workspace afterwards (null = still checking).
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!authUser) { setHasPassword(null); return; }
    let active = true;
    supabase.rpc("portal_my_password_set").then(({ data, error: failure }) => {
      // Until the database function exists, behave as before (no password step).
      if (active) setHasPassword(failure ? true : data === true);
    });
    return () => { active = false; };
  }, [authUser]);

  const savePassword = async () => {
    const problem = passwordProblem(password, confirm);
    if (problem) { setError(problem); return; }
    setBusy(true); setError("");
    try {
      const { error: failure } = await supabase.auth.updateUser({ password });
      if (failure) throw new Error(failure.message || "The password could not be saved. Try another one.");
      setHasPassword(true); setPassword(""); setConfirm("");
      setNotice("Password saved. Next time, sign in to your SLIT workspace with your email and this password.");
      await accept();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The password could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const linkToken = params.get("t");
    const validLinkToken = linkToken !== null && /^[A-Za-z0-9_-]{43}$/.test(linkToken);
    if (linkToken !== null) {
      // Keep the link just opened across reloads and the sign-in redirect in this tab.
      try {
        if (validLinkToken) sessionStorage.setItem(storeKey, linkToken);
        else sessionStorage.removeItem(storeKey);
      } catch {
        // An already signed-in student can still use the link in this page.
      }
      setToken(validLinkToken ? linkToken : "");
      setError("");
      setNotice("");
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      return;
    }

    try {
      const saved = sessionStorage.getItem(storeKey) ?? "";
      setToken(/^[A-Za-z0-9_-]{43}$/.test(saved) ? saved : "");
    } catch {
      // Opening the original email link again works when tab storage is unavailable.
    }
  }, [locationKey, storeKey]);

  const sendSignIn = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const { error: failure } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: { emailRedirectTo: `${window.location.origin}/agency/application-invite` },
      });
      if (failure) throw failure;
      setNotice("Open the sign-in email. Then return to your latest SLIT application invitation in the same browser.");
    } catch {
      setError("The sign-in email could not be requested. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await supabase.rpc("portal_wizard_invite_accept", { p_token: token });
      if (failure?.code === "42501") {
        throw new Error("Open the newest SLIT application invitation and sign in with the email address that received it. If it still won't open, contact SLIT Admissions.");
      }
      if (failure || typeof data !== "string") throw new Error("The application could not be opened. Try again.");
      try { sessionStorage.removeItem(storeKey); } catch { /* The database already consumed the invitation. */ }
      await reloadIdentity();
      navigate(`/agency/applications/${data}?wizard=1`, { replace: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The application could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background-100 px-5">
      <section className="w-full max-w-md space-y-4 rounded-card border border-background-200 bg-background-50 p-6">
        <h1 className="font-heading text-xl font-semibold">Complete your SLIT application</h1>
        {authLoading ? <p role="status">Checking your sign-in…</p> : !token ? (
          <p>Open the newest SLIT application invitation from your email in this browser. Contact SLIT Admissions if you need a new link.</p>
        ) : authUser && hasPassword === null ? <p role="status">Checking your account…</p> : authUser && !hasPassword ? (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void savePassword(); }} data-testid="application-invite-password">
            <p>Signed in as {authUser.email}. Create your password first: you will use it to sign in to your SLIT workspace.</p>
            <label className="block text-sm" htmlFor="application-invite-password">New password</label>
            <input id="application-invite-password" type={showPassword ? "text" : "password"} autoComplete="new-password" required
              className="w-full rounded-md border border-background-300 px-3 py-2" value={password} onChange={(event) => setPassword(event.target.value)} />
            <label className="block text-sm" htmlFor="application-invite-confirm">Confirm password</label>
            <input id="application-invite-confirm" type={showPassword ? "text" : "password"} autoComplete="new-password" required
              className="w-full rounded-md border border-background-300 px-3 py-2" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            {password ? <p className="text-xs text-foreground-600">{passwordProblem(password, confirm || undefined) ?? "Looks good."}</p> : null}
            <label className="flex items-center gap-2 text-xs text-foreground-600"><input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} className="h-4 w-4" />Show password</label>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={busy || !!passwordProblem(password, confirm)}>Save password and open application</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void signOut()}>Use a different email</Button>
            </div>
          </form>
        ) : authUser ? (
          <>
            <p>Signed in as {authUser.email}.</p>
            <div className="flex flex-wrap gap-3">
              <Button disabled={busy} onClick={() => void accept()}>Open application</Button>
              <Button variant="outline" disabled={busy} onClick={() => void signOut()}>Use a different email</Button>
            </div>
          </>
        ) : (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void sendSignIn(); }}>
            <label className="block" htmlFor="application-invite-email">Enter the email address that received your invitation.</label>
            <input id="application-invite-email" type="email" autoComplete="email" required maxLength={254}
              className="w-full rounded-md border border-background-300 px-3 py-2" value={email}
              onChange={(event) => setEmail(event.target.value)} />
            <Button type="submit" disabled={busy}>Email me a secure sign-in link</Button>
          </form>
        )}
        {notice ? <p role="status" className="text-sm">{notice}</p> : null}
        {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
      </section>
    </main>
  );
}
