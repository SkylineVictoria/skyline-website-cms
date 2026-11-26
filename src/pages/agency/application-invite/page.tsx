import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { Button } from "@/pages/admin/components/ui";
import { signInWithProvider } from "@/lib/authProviders";
import { passwordRecoveryUrl } from "@/lib/siteUrl";
import { inviteCheck, inviteSession, type InviteCheck } from "@/pages/agency/lib/handoff";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The student's application link (owner, 2026-11-26). The invited email already has a SLIT account (password or Google): sign in
 * only, with Forgot password. First time: Start my application opens it straight from the link (as a guest); the password is
 * created when the student signs the declarations at the end.
 */
export default function ApplicationInvitePage() {
  const { authUser, authLoading, reloadIdentity, signOut } = usePortalAuth();
  const { key: locationKey } = useLocation();
  const navigate = useNavigate();
  const storeKey = `slit-application-invitation:${window.location.host}`;
  const [token, setToken] = useState<string | null>(null);
  const [check, setCheck] = useState<InviteCheck | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const linkToken = new URLSearchParams(window.location.hash.slice(1)).get("t");
    let value = linkToken !== null && TOKEN.test(linkToken) ? linkToken : "";
    try {
      if (linkToken !== null) { if (value) sessionStorage.setItem(storeKey, value); else sessionStorage.removeItem(storeKey); }
      else value = sessionStorage.getItem(storeKey) ?? "";
    } catch { /* the emailed link still works when opened again */ }
    if (linkToken !== null) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    setToken(TOKEN.test(value) ? value : "");
  }, [locationKey, storeKey]);

  useEffect(() => {
    if (token === null) return;
    if (!token) { setCheck({ valid: false }); return; }
    let live = true;
    setCheck(null);
    inviteCheck(token).then((c) => { if (live) setCheck(c); }, (e: Error) => { if (live) { setCheck({ valid: false }); setError(e.message); } });
    return () => { live = false; };
  }, [token]);

  const accept = async () => {
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await supabase.rpc("portal_wizard_invite_accept", { p_token: token ?? "" });
      if (failure || typeof data !== "string") throw new Error("Open the newest SLIT application invitation and sign in with the email address that received it. If it still won't open, contact SLIT Admissions.");
      try { sessionStorage.removeItem(storeKey); } catch { /* already used */ }
      await reloadIdentity();
      navigate(`/agency/applications/${data}?wizard=1`, { replace: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The application could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  // Signed in with the invited email: open it.
  const signedInAsInvited = Boolean(authUser && check?.email && authUser.email?.toLowerCase() === check.email);
  useEffect(() => {
    if (signedInAsInvited && !busy) void accept();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the sign-in matches the invitation
  }, [signedInAsInvited]);

  const startAsGuest = async () => {
    setBusy(true); setError("");
    try {
      const { tokenHash } = await inviteSession(token ?? "");
      const { error: failure } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
      if (failure) throw new Error("Your application could not be opened. Open the newest invitation email and try again.");
      await reloadIdentity();
      await accept();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your application could not be opened.");
      setBusy(false);
    }
  };

  const passwordSignIn = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const { error: failure } = await supabase.auth.signInWithPassword({ email: check?.email ?? "", password });
      if (failure) throw new Error("That password is not right. Try again, or use Forgot password.");
      setPassword("");
      await reloadIdentity();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const forgotPassword = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const { error: failure } = await supabase.auth.resetPasswordForEmail(check?.email ?? "", { redirectTo: passwordRecoveryUrl() });
      if (failure) throw new Error(/rate|too many/i.test(failure.message) ? "Please wait a minute before asking for another reset email." : "We could not send a reset email. Try again later.");
      setNotice(`We emailed ${check?.email} a link to set a new password. Then open your application invitation again and sign in.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "We could not send a reset email.");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true); setError("");
    try { await signInWithProvider("google", "/agency/application-invite"); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Google sign-in could not start."); setBusy(false); }
  };

  const input = "w-full rounded-md border border-background-300 px-3 py-2";
  return (
    <main className="flex min-h-screen items-center justify-center bg-background-100 px-5">
      <section className="w-full max-w-md space-y-4 rounded-card border border-background-200 bg-background-50 p-6" data-testid="application-invite">
        <h1 className="font-heading text-xl font-semibold">Your SLIT application</h1>
        {authLoading || token === null || (token && !check) ? <p role="status">Checking your invitation…</p>
          : !check?.valid ? <p>This invitation is invalid, expired, or no longer available. Open the newest SLIT application invitation from your email, or contact SLIT Admissions for a new link.</p>
          : signedInAsInvited ? <p role="status">Opening your application…</p>
          : authUser ? (
            <>
              <p>You are signed in as {authUser.email}, but this invitation is for {check.email}.</p>
              <Button variant="outline" disabled={busy} onClick={() => void signOut()}>Sign out and continue as {check.email}</Button>
            </>
          ) : check.account === "login" ? (
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void passwordSignIn(); }} data-testid="invite-sign-in">
              <p className="text-sm text-foreground-700">{check.email} already has a SLIT account. Sign in to open your application.</p>
              <label className="block text-sm" htmlFor="invite-email">Email</label>
              <input id="invite-email" type="email" value={check.email} readOnly className={`${input} bg-background-100`} />
              <label className="block text-sm" htmlFor="invite-password">Password</label>
              <input id="invite-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className={input} />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={busy || !password}>Sign in</Button>
                <button type="button" disabled={busy} onClick={() => void forgotPassword()} className="text-sm font-semibold text-primary-700 hover:underline" data-testid="invite-forgot">Forgot password?</button>
              </div>
              {check.google ? <Button type="button" variant="outline" disabled={busy} onClick={() => void google()}><i className="ri-google-fill" aria-hidden="true" /> Continue with Google</Button> : null}
            </form>
          ) : (
            <div className="space-y-3" data-testid="invite-start">
              <p className="text-sm text-foreground-700">{check.studentName ? `Hello ${check.studentName}. ` : ""}Your application has been prepared for you. Open it, check and complete it, then sign it at the end.
                You will create your password when you sign, so you can sign in to your SLIT account later.</p>
              <Button disabled={busy} onClick={() => void startAsGuest()}>{busy ? "Opening…" : "Start my application"}</Button>
            </div>
          )}
        {notice ? <p role="status" className="text-sm">{notice}</p> : null}
        {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
      </section>
    </main>
  );
}
