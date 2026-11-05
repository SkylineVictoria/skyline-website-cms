import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/pages/admin/lib/supabase";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { getMyStaffApplication, setStaffPassword, startStaffApplication } from "@/lib/staffApi";
import { toE164 } from "@/lib/staffPhone";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background-100 px-5 py-10">
      <div className="w-full max-w-md rounded-card border border-background-200 bg-background-50 p-6 shadow-sm">{children}</div>
    </div>
  );
}

function Problem({ text }: { text: string }) {
  return text ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-[13px] text-primary-900">{text}</p> : null;
}

/**
 * Where the emailed staff link lands, and where an existing account attaches a staff application.
 * - New staff (email verified through staff-register): choose a password, then the draft is created and the workspace opens.
 * - Anyone else who is signed in (an existing student, agent or portal user): the application is attached to THIS login. No second
 *   account is created; the email on the account is the one used, and the mobile number goes through the same duplicate checks.
 */
export default function StaffApplyPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const take = (u: User | null) => { if (!cancelled) setUser(u); };
    // The session from an emailed link arrives a moment after the page opens; wait briefly before deciding nobody is signed in.
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) take(data.session.user);
      else window.setTimeout(() => { void supabase.auth.getSession().then(({ data: later }) => take(later.session?.user ?? null)); }, 1500);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => { if (session?.user) take(session.user); });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  const meta = (user?.user_metadata ?? {}) as { registrant?: string; staff_password_set?: boolean; staff_phone?: string };
  const registeredAsStaff = meta.registrant === "staff";

  // Someone who already has an application goes straight to it; a staff sign-up that already chose its password resumes.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        const me = await getMyStaffApplication();
        if (cancelled) return;
        if (me) { navigate("/staff", { replace: true }); return; }
        if (registeredAsStaff && meta.staff_password_set) {
          await startStaffApplication();
          if (!cancelled) navigate("/staff", { replace: true });
        }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "We could not load your application."); }
    })();
    return () => { cancelled = true; };
  }, [user, registeredAsStaff, meta.staff_password_set, navigate]);

  const choosePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password.length < MIN_PASSWORD_LENGTH) { setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`); return; }
    if (password !== again) { setError("The two passwords do not match."); return; }
    setBusy(true); setError("");
    try { await setStaffPassword(password); await startStaffApplication(); navigate("/staff", { replace: true }); }
    catch (e) { setError(e instanceof Error ? e.message : "We could not save your password."); }
    finally { setBusy(false); }
  };

  const attach = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const phone = toE164(new FormData(event.currentTarget).get("attach-phone"));
    if (!phone) { setError("Enter your mobile number with its country code."); return; }
    setBusy(true); setError("");
    try { await startStaffApplication(phone); navigate("/staff", { replace: true }); }
    catch (e) { setError(e instanceof Error ? e.message : "We could not start your application."); }
    finally { setBusy(false); }
  };

  if (user === undefined) {
    return <Shell><p className="text-center text-sm text-foreground-600" role="status"><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Checking your sign-in…</p></Shell>;
  }
  if (user === null) {
    return (
      <Shell>
        <h1 className="font-heading text-xl font-bold text-foreground-950">Staff application</h1>
        <p className="mt-2 text-sm text-foreground-600">Open the link in the email we sent you, or sign in to continue. Links work once and expire.</p>
        <div className="mt-5 flex flex-col gap-2">
          <Link to="/login?next=%2Fstaff%2Fapply" className="rounded-md bg-primary-500 px-4 py-2.5 text-center text-sm font-semibold text-background-50 hover:bg-primary-600">Sign in</Link>
          <Link to="/login?mode=enroll&as=staff" className="rounded-md border border-background-300 px-4 py-2.5 text-center text-sm font-semibold text-foreground-800 hover:bg-background-100">Apply for a staff account</Link>
        </div>
      </Shell>
    );
  }
  if (registeredAsStaff && !meta.staff_password_set) {
    return (
      <Shell>
        <h1 className="font-heading text-xl font-bold text-foreground-950">Choose a password</h1>
        <p className="mt-2 text-sm text-foreground-600">Your email {user.email} is confirmed. You sign in with it and this password.</p>
        <form onSubmit={choosePassword} className="mt-5 space-y-4" noValidate>
          <Field label="Password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}><TextInput type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Repeat password" required><TextInput type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
          <Problem text={error} />
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving…" : "Save password and continue"}</Button>
        </form>
      </Shell>
    );
  }
  if (registeredAsStaff) {
    return <Shell><p className="text-center text-sm text-foreground-600" role="status">{error ? <Problem text={error} /> : "Opening your application…"}</p></Shell>;
  }
  return (
    <Shell>
      <h1 className="font-heading text-xl font-bold text-foreground-950">Apply as staff</h1>
      <p className="mt-2 text-sm text-foreground-600">You are signed in as <strong>{user.email}</strong>. Your staff application is attached to this account; you do not need a second login. An administrator reviews it.</p>
      <form onSubmit={attach} className="mt-5 space-y-4" noValidate>
        <div>
          <label htmlFor="attach-phone" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Mobile <span className="text-primary-600">*</span></label>
          <PhoneInput id="attach-phone" name="attach-phone" required placeholder="041 234 5678" />
        </div>
        <Problem text={error} />
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Starting…" : "Start staff application"}</Button>
      </form>
    </Shell>
  );
}
