import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { loginUrl } from "@/lib/loginRouting";

/**
 * /agency/accept-invite#t=<token>: the set-password link from an invitation email (INV-LINK, 2026-11-17).
 * Nothing happens on opening the page: the token is checked only when the person presses Continue, so a mail scanner (Outlook Safe
 * Links, Gmail previews) that opens the link does not use it up. The token stays in the URL fragment (never sent to a server log) and
 * is removed from the address bar once read. Continue asks portal-invite-activate for the hashed recovery token of this email, the
 * browser verifies it (a session, no Supabase redirect), the person sets their password with its confirmation, the invitation is
 * accepted (portal_resolve_access) and they land on the agent dashboard, signed in. An expired or used link shows "This link has
 * expired" with "Send me a new link" (rate-limited by the server).
 */
type Step = "ready" | "verifying" | "password" | "saving" | "already" | "expired" | "broken";
const RULES: Array<{ id: string; label: string; ok: (p: string) => boolean }> = [
  { id: "length", label: "At least 10 characters", ok: (p) => p.length >= 10 },
  { id: "letter", label: "A letter", ok: (p) => /[A-Za-z]/.test(p) },
  { id: "number", label: "A number", ok: (p) => /\d/.test(p) },
  { id: "space", label: "No spaces at the start or end", ok: (p) => p === p.trim() },
];

export default function AcceptInvitePage() {
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [step, setStep] = useState<Step>("ready");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [resendEmail, setResendEmail] = useState("");
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t") ?? "";
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(t)) { setStep("broken"); setMessage("This link is incomplete. Open it again from the email, or ask for a new one below."); return; }
    setToken(t);
  }, []);

  const continueToPassword = async () => {
    if (step !== "ready" || !token) return;
    setStep("verifying"); setMessage("");
    const { data, error } = await supabase.functions.invoke("portal-invite-activate", { body: { token } });
    if (error || !data?.ok) {
      let text = "This link has expired or was already used.";
      const context = (error as { context?: unknown } | null)?.context;
      if (context instanceof Response) { try { text = ((await context.clone().json()) as { error?: string }).error || text; } catch { /* keep */ } }
      setStep("expired"); setMessage(text); return;
    }
    if (data.alreadyActive === true) { setStep("already"); return; }
    // Anyone signed in on this browser (possibly someone else) is signed out first; then this email's recovery token becomes the session.
    await supabase.auth.signOut().catch(() => undefined);
    const verified = await supabase.auth.verifyOtp({ token_hash: String(data.tokenHash ?? ""), type: "recovery" });
    if (verified.error || !verified.data.user) { setStep("expired"); setMessage("This link has expired or was already used."); return; }
    setEmail(verified.data.user.email ?? String(data.email ?? ""));
    setStep("password");
  };

  const rulesOk = RULES.every((r) => r.ok(password));
  const canSave = rulesOk && password === confirm && step === "password";
  const savePassword = async () => {
    if (!canSave) return;
    setStep("saving"); setMessage("");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setStep("password"); setMessage(error.message || "The password could not be saved. Try another one."); return; }
    const { data: access, error: accessError } = await supabase.rpc("portal_resolve_access");
    const state = (access as { state?: string } | null)?.state ?? "";
    if (accessError || !["active", "org_admin"].includes(state)) {
      setStep("password");
      setMessage(state === "agency_onboarding" ? "Your password is saved, but your agency's onboarding is not complete yet. Sign in once Skyline confirms it."
        : "Your password is saved, but the portal could not be opened yet. Sign in from the login page, or contact SLIT Administration.");
      return;
    }
    navigate("/agency/dashboard", { replace: true });
  };

  const resend = async () => {
    if (resending || !/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(resendEmail.trim())) return;
    setResending(true);
    await supabase.functions.invoke("portal-invite-activate", { body: { action: "resend", email: resendEmail.trim() } }).catch(() => undefined);
    setResending(false); setResent(true);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-100 px-5">
      <div className="w-full max-w-md rounded-card border border-background-200 bg-background-50 p-6" data-testid="accept-invite" data-step={step}>
        {step === "ready" || step === "verifying" ? (
          <div className="text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-xl text-primary-600"><i className="ri-lock-password-line" aria-hidden="true" /></span>
            <h1 className="mt-4 font-heading text-lg font-bold text-foreground-950">Set your password</h1>
            <p className="mt-2 text-sm text-foreground-600">You have been invited to the Skyline agent portal. Press Continue to create your password; this link is for you only.</p>
            <button type="button" disabled={step === "verifying" || !token} onClick={() => void continueToPassword()} data-testid="invite-continue"
              className="mt-5 inline-block rounded-md bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60">{step === "verifying" ? "Checking your link…" : "Continue"}</button>
          </div>
        ) : step === "password" || step === "saving" ? (
          <form onSubmit={(e) => { e.preventDefault(); void savePassword(); }} className="space-y-4">
            <div>
              <h1 className="font-heading text-lg font-bold text-foreground-950">Create your password</h1>
              <p className="mt-1 text-sm text-foreground-600">For <strong>{email}</strong>. You will be signed in straight away.</p>
            </div>
            {message ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{message}</p> : null}
            <label className="block text-sm">
              <span className="font-medium text-foreground-800">New password</span>
              <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus data-testid="invite-password"
                className="mt-1 w-full rounded-md border border-background-300 px-3 py-2 text-foreground-950" />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground-800">Confirm password</span>
              <input type={showPassword ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" data-testid="invite-confirm"
                className="mt-1 w-full rounded-md border border-background-300 px-3 py-2 text-foreground-950" />
              {confirm && confirm !== password ? <span className="mt-1 block text-xs text-red-700">The two passwords do not match.</span> : null}
            </label>
            <label className="flex items-center gap-2 text-xs text-foreground-600"><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} className="h-4 w-4" />Show password</label>
            <ul className="space-y-1 text-xs" aria-label="Password requirements">
              {RULES.map((r) => <li key={r.id} className={r.ok(password) ? "text-emerald-700" : "text-foreground-600"}><i className={r.ok(password) ? "ri-checkbox-circle-fill" : "ri-checkbox-blank-circle-line"} aria-hidden="true" /> {r.label}</li>)}
            </ul>
            <button type="submit" disabled={!canSave} data-testid="invite-save"
              className="w-full rounded-md bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60">{step === "saving" ? "Saving…" : "Save password and open the portal"}</button>
          </form>
        ) : step === "already" ? (
          <div className="text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-50 text-xl text-green-700"><i className="ri-check-line" aria-hidden="true" /></span>
            <h1 className="mt-4 font-heading text-lg font-bold text-foreground-950">Your access is already active</h1>
            <p className="mt-2 text-sm text-foreground-600">Sign in to open the portal. If you don&rsquo;t know your password, use &ldquo;Forgot password?&rdquo; on the sign-in page.</p>
            <Link to={loginUrl("/agency")} className="mt-5 inline-block rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700">Sign in</Link>
          </div>
        ) : (
          <div>
            <div className="text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-xl text-primary-600"><i className="ri-time-line" aria-hidden="true" /></span>
              <h1 className="mt-4 font-heading text-lg font-bold text-foreground-950">This link has expired</h1>
              <p role="alert" className="mt-2 text-sm text-foreground-600">{message || "This link has expired or was already used."} Enter your email address and we will send you a new one.</p>
            </div>
            {resent ? <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="invite-resent">If that address has an invitation waiting, a new link is on its way. It can take a minute to arrive; check your junk folder too.</p>
              : <form onSubmit={(e) => { e.preventDefault(); void resend(); }} className="mt-4 space-y-3">
                <label className="block text-sm">
                  <span className="font-medium text-foreground-800">Your email address</span>
                  <input type="email" value={resendEmail} onChange={(e) => setResendEmail(e.target.value)} autoComplete="email" data-testid="invite-resend-email" className="mt-1 w-full rounded-md border border-background-300 px-3 py-2 text-foreground-950" />
                </label>
                <button type="submit" disabled={resending} data-testid="invite-resend" className="w-full rounded-md bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60">{resending ? "Sending…" : "Send me a new link"}</button>
              </form>}
            <p className="mt-4 text-center text-xs text-foreground-500">Already have a password? <Link to={loginUrl("/agency")} className="font-medium text-primary-700 underline-offset-2 hover:underline">Sign in</Link></p>
          </div>
        )}
      </div>
    </div>
  );
}
