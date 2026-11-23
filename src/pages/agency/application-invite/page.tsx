import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { Button } from "@/pages/admin/components/ui";

export default function ApplicationInvitePage() {
  const { authUser, authLoading, reloadIdentity, signOut } = usePortalAuth();
  const navigate = useNavigate();
  const storeKey = `slit-application-invitation:${window.location.host}`;
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const linkToken = params.get("t");
    try {
      const saved = linkToken ?? sessionStorage.getItem(storeKey) ?? "";
      if (/^[A-Za-z0-9_-]{43}$/.test(saved)) setToken(saved);
    } catch {
      if (linkToken && /^[A-Za-z0-9_-]{43}$/.test(linkToken)) setToken(linkToken);
    }
    if (linkToken) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, [storeKey]);

  const sendSignIn = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      sessionStorage.setItem(storeKey, token);
      const { error: failure } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: { emailRedirectTo: `${window.location.origin}/agency/application-invite` },
      });
      if (failure) throw failure;
      setNotice("Open the sign-in email in this browser, then select Open application.");
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
      if (failure || typeof data !== "string") throw new Error("This invitation is invalid, expired, or belongs to a different email address.");
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
          <p>Open the invitation from your email. Contact SLIT Admissions if you need a new link.</p>
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
