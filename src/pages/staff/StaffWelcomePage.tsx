import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/passwords";
import { claimStaffAccount } from "@/lib/staffApi";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";

/**
 * /staff/welcome: where the Supabase Auth "Invite user" email lands (HR-02f, redirectTo set by staff-admin `activate`). The
 * person sets a password, then hr_staff_claim_account() makes them active (offer_signed > active) and they go to My HR (/staff).
 * Like /reset-password, only a session created from THIS link's tokens is accepted, never an unrelated existing login.
 */

type Phase = "checking" | "form" | "invalid" | "done";
const INVALID = "This invitation link is invalid, expired, or has already been used. Please ask us to send a new one.";

function inviteLink() {
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const error = hash.get("error_description") || search.get("error_description") || hash.get("error") || search.get("error") || "";
  return { code: search.get("code"), accessToken: hash.get("access_token"), refreshToken: hash.get("refresh_token"),
    implicit: ["invite", "signup", "magiclink"].includes(hash.get("type") ?? "") && hash.has("access_token") && hash.has("refresh_token"), error };
}
const clearSensitiveUrl = () => window.history.replaceState({}, document.title, window.location.pathname);

function Notice({ error, children }: { error?: boolean; children: ReactNode }) {
  return <p className={`rounded-md border px-3 py-2.5 text-sm ${error ? "border-primary-200 bg-primary-50 text-primary-900" : "border-secondary-200 bg-secondary-50 text-secondary-900"}`} role={error ? "alert" : "status"}>{children}</p>;
}

export default function StaffWelcomePage() {
  const navigate = useNavigate();
  const link = useRef(inviteLink()).current;
  const [phase, setPhase] = useState<Phase>("checking");
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const fail = () => { if (live) { clearSensitiveUrl(); setPhase("invalid"); } };
    const ready = () => { if (live) { clearSensitiveUrl(); setPhase("form"); } };
    if (link.error) { fail(); return () => { live = false; }; }
    if (link.code) {
      void supabase.auth.exchangeCodeForSession(link.code).then(({ data, error }) => (error || !data.session ? fail() : ready())).catch(fail);
      return () => { live = false; };
    }
    if (!link.implicit) { fail(); return () => { live = false; }; }
    void supabase.auth.setSession({ access_token: link.accessToken!, refresh_token: link.refreshToken! })
      .then(({ data, error }) => (error || !data.session ? fail() : ready())).catch(fail);
    return () => { live = false; };
  }, [link]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) { setMessage(problem); return; }
    setMessage("");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setBusy(false); setMessage(error.message); return; }
    try {
      await claimStaffAccount();
      setPhase("done");
      window.setTimeout(() => navigate("/staff", { replace: true }), 1500);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "We could not finish setting up your account.");
    } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-100 px-5 py-10">
      <main className="w-full max-w-sm rounded-card bg-background-50 p-7 shadow-sm" aria-live="polite">
        {phase === "checking" && <p className="text-center text-sm text-foreground-600">Checking your invitation…</p>}
        {phase === "form" && (
          <>
            <h1 className="font-heading text-2xl font-bold text-foreground-950">Welcome to Skyline</h1>
            <p className="mt-2 text-sm text-foreground-600">Choose a password for your staff account. Use at least {MIN_PASSWORD_LENGTH} characters.</p>
            <form className="mt-6 space-y-4" onSubmit={(e) => void save(e)}>
              <Field label="Password" required><TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
              <Field label="Confirm password" required><TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
              {message && <Notice error>{message}</Notice>}
              <Button type="submit" className="w-full" disabled={busy}>{busy ? "Setting up…" : "Set password and continue"}</Button>
            </form>
          </>
        )}
        {phase === "invalid" && (
          <>
            <h1 className="font-heading text-2xl font-bold text-foreground-950">This link cannot be used</h1>
            <p className="mt-2 text-sm text-foreground-600">{INVALID} If you already set your password, sign in instead.</p>
          </>
        )}
        {phase === "done" && (
          <>
            <h1 className="font-heading text-2xl font-bold text-foreground-950">You are all set</h1>
            <p className="mt-2 text-sm text-foreground-600">Your staff account is active. Taking you to My HR…</p>
          </>
        )}
        <p className="mt-6 text-center text-xs"><Link to="/login" className="font-medium text-primary-700">Sign in</Link></p>
      </main>
    </div>
  );
}
