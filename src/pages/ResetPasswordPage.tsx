import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { passwordRecoveryUrl } from "@/lib/siteUrl";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/passwords";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";

type Phase = "checking" | "form" | "invalid" | "success";
const INVALID = "This password reset link is invalid, expired, or has already been used.";
const COOLDOWN_MS = 60_000;

function recoveryLink() {
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const rawError = hash.get("error_description") || search.get("error_description") || hash.get("error") || search.get("error");
  return { code: search.get("code"), accessToken: hash.get("access_token"), refreshToken: hash.get("refresh_token"), implicit: ["recovery", "invite"].includes(hash.get("type") ?? "") && hash.has("access_token") && hash.has("refresh_token"), error: rawError ? decodeURIComponent(rawError.replace(/\+/g, " ")) : "" };
}
function clearSensitiveUrl() { window.history.replaceState({}, document.title, window.location.pathname); }
function Notice({ error, children }: { error?: boolean; children: ReactNode }) {
  return <p className={`rounded-md border px-3 py-2.5 text-sm ${error ? "border-primary-200 bg-primary-50 text-primary-900" : "border-secondary-200 bg-secondary-50 text-secondary-900"}`} role={error ? "alert" : "status"}>{children}</p>;
}

/** Shared recovery landing route for both CMS and agency users. */
export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const link = useRef(recoveryLink()).current;
  const [phase, setPhase] = useState<Phase>("checking");
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [resendError, setResendError] = useState("");
  const [retryAt, setRetryAt] = useState(0);

  useEffect(() => {
    let live = true;
    const fail = (text = INVALID) => { if (live) { clearSensitiveUrl(); setMessage(text); setPhase("invalid"); } };
    const verified = () => { if (live) { clearSensitiveUrl(); setPhase("form"); } };
    if (link.error) { fail(); return () => { live = false; }; }
    // PKCE redirects carry a one-time code; exchange it explicitly.
    if (link.code) {
      void supabase.auth.exchangeCodeForSession(link.code).then(({ data, error }) => error || !data.session ? fail() : verified()).catch(() => fail());
      return () => { live = false; };
    }
    // Implicit flow is currently configured. A pre-existing login alone is
    // never accepted: the visited URL must itself carry a recovery token.
    if (!link.implicit) { fail(); return () => { live = false; }; }
    // Establish the session from this link's tokens. getSession() could return
    // an unrelated normal login, which is not recovery authorization.
    void supabase.auth.setSession({ access_token: link.accessToken!, refresh_token: link.refreshToken! })
      .then(({ data, error }) => error || !data.session ? fail() : verified())
      .catch(() => fail());
    return () => { live = false; };
  }, [link]);

  const save = async (event: FormEvent) => {
    event.preventDefault(); const problem = passwordProblem(password, confirm);
    if (problem) { setMessage(problem); return; }
    setMessage(""); setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setBusy(false); setMessage(error.message); return; }
    // The first sign-in after an invitation also accepts it. Everyone then returns to /login, which routes by role.
    await supabase.rpc("portal_resolve_access");
    await supabase.auth.signOut(); setBusy(false); setPhase("success");
    window.setTimeout(() => navigate("/login", { replace: true }), 2500);
  };
  const resend = async (event: FormEvent) => {
    event.preventDefault(); setResendError("");
    if (Date.now() < retryAt) return;
    if (!email.trim()) { setResendError("Enter your email address first."); return; }
    setBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: passwordRecoveryUrl() });
      if (error) setResendError(/rate|too many/i.test(error.message) ? "Please wait before requesting another reset email." : "We could not send a reset email. Please try again later.");
      else setSent(true);
      setRetryAt(Date.now() + COOLDOWN_MS);
    } catch { setResendError("We could not send a reset email. Please try again later."); }
    finally { setBusy(false); }
  };

  return <div className="flex min-h-screen items-center justify-center bg-background-100 px-5 py-10"><main className="w-full max-w-sm rounded-card bg-background-50 p-7 shadow-sm" aria-live="polite"><Link to="/" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-foreground-600 hover:text-primary-700"><i className="ri-arrow-left-line" aria-hidden="true" />Back to site</Link>
    {phase === "checking" && <p className="text-center text-sm text-foreground-600">Checking your reset link…</p>}
    {phase === "form" && <><h1 className="font-heading text-2xl font-bold text-foreground-950">Set a new password</h1><p className="mt-2 text-sm text-foreground-600">Use at least {MIN_PASSWORD_LENGTH} characters. This secure link is single-use.</p><form className="mt-6 space-y-4" onSubmit={save}><Field label="New password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}><div className="relative"><TextInput type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="pr-10" /><button type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-500"><i className={show ? "ri-eye-off-line" : "ri-eye-line"} /></button></div></Field><Field label="Confirm new password" required><TextInput type={show ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>{message && <Notice error>{message}</Notice>}<Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving…" : "Save new password"}</Button></form></>}
    {phase === "invalid" && <><h1 className="font-heading text-2xl font-bold text-foreground-950">Request a new link</h1><p className="mt-2 text-sm text-foreground-600">{message || INVALID} Recovery links are valid for 15 minutes when configured in Supabase.</p><form className="mt-6 space-y-4" onSubmit={resend}><Field label="Email address" required><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>{resendError && <Notice error>{resendError}</Notice>}{sent && <Notice>If that email belongs to an account, a reset link is on its way.</Notice>}<Button type="submit" className="w-full" disabled={busy}>{busy ? "Sending…" : "Email me a new link"}</Button></form></>}
    {phase === "success" && <><h1 className="font-heading text-2xl font-bold text-foreground-950">Password updated</h1><p className="mt-2 text-sm text-foreground-600">Your recovery session has been ended. Redirecting to sign in…</p></>}
    <p className="mt-6 text-center text-xs"><Link to="/login" className="font-medium text-primary-700">Back to sign in</Link></p>
  </main></div>;
}
