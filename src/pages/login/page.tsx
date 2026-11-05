import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { checkSession, retryUntil, type SessionCheck } from "@/lib/authSession";
import { supabase } from "@/pages/admin/lib/supabase";
import { AdminLoading, Button, Field, TextInput } from "@/pages/admin/components/ui";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { resolveTenantSite } from "@/lib/tenantSite";
import { readCachedBrand, tenantBrandKey } from "@/lib/brandCache";
import { tenantThemeStyle } from "@/lib/tenantTheme";
import type { PortalAccessState } from "@/pages/agency/lib/applicationAccess";
import {
  DESTINATION_LABEL, decideLogin, destinationFor, loginErrorMessage, loginNotice, markSessionSeen, readLastDestination, rememberDestination,
  type AccessSummary, type CmsAccess, type LoginDestination,
} from "@/lib/loginRouting";
import EnrolWizard from "@/pages/login/EnrolWizard";
import { staffAccessState } from "@/lib/staffApi";
import QuickSignIn from "@/pages/login/QuickSignIn";
import CompleteSignUp from "@/pages/login/CompleteSignUp";
import { isSelfSignUpAccount } from "@/lib/authProviders";
import type { User } from "@supabase/supabase-js";
import type { EnrolKind } from "@/lib/enrolForm";

/** What the DATABASE says this signed-in user may use. The page only routes; every request is still authorized by RLS / edge functions. */
async function fetchAccess(authUserId: string): Promise<AccessSummary> {
  let cms: CmsAccess | null = null;
  try {
    if (requestWebsiteDomain()) {
      await resolveTenantSite();
      // Claim any pending institution invitation for this verified email; a failure must not block sign-in.
      try { await supabase.rpc("tenant_accept_pending_invites"); } catch { /* the invitation stays pending */ }
      const { data } = await supabase.rpc("tenant_cms_identity");
      if (data) cms = { active: true, mustChangePassword: Boolean((data as { mustChangePassword?: boolean }).mustChangePassword) };
    } else {
      const { data } = await supabase.from("cms_users").select("status, must_change_password").eq("auth_user_id", authUserId).maybeSingle();
      if (data) cms = { active: data.status !== "Inactive", mustChangePassword: Boolean(data.must_change_password) };
    }
  } catch { cms = null; }
  let portal: PortalAccessState | null = null;
  try {
    // Also accepts a pending agency invitation for the user's verified email (migration 86).
    const { data } = await supabase.rpc("portal_resolve_access");
    portal = ((data as { state?: PortalAccessState } | null)?.state ?? null) as PortalAccessState | null;
  } catch { portal = null; }
  let staff: AccessSummary["staff"] = null;
  try { staff = await staffAccessState(); } catch { staff = null; }
  return { cms, portal, staff };
}


type Tab = "signin" | "enroll";

/** Resolves with `fallback` when `promise` has not settled after `ms`; the page must never wait forever on a stuck call. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(fallback), ms);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); }, (error) => { window.clearTimeout(timer); reject(error); });
  });
}
const SLOW = Symbol("slow");

export default function LoginPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const next = params.get("next");
  const notice = loginNotice(params.get("reason"));
  // Tenant domains (other institutions) only sign people in; self-enrolment is a SLIT-site feature.
  const tenant = requestWebsiteDomain();
  const enrolAllowed = !tenant;
  const tab: Tab = enrolAllowed && params.get("mode") === "enroll" ? "enroll" : "signin";
  const asKind = params.get("as");
  const initialKind: EnrolKind | null = asKind === "student" || asKind === "agent" || asKind === "staff" ? asKind : null;
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState(notice);
  const [choice, setChoice] = useState<{ userId: string; options: LoginDestination[] } | null>(null);
  // Signed up with Google, Facebook or a phone number and not a student yet: ask for the remaining details.
  const [completing, setCompleting] = useState<User | null>(null);
  const routing = useRef(false);
  // Opened on Enroll now (a link from the website): show it straight away; a saved session never holds it up or redirects.
  const enrolOnOpen = useRef(tab === "enroll");
  const [signedInAs, setSignedInAs] = useState<{ id: string; email: string } | null>(null);

  // Tenant domains show the tenant's cached logo / name / colour; the main Skyline domain keeps the built-in branding.
  const brand = useMemo(() => (tenant ? readCachedBrand(tenantBrandKey()) : null), [tenant]);
  const brandName = brand?.name || tenant || "Skyline Institute of Technology";
  const themeStyle = useMemo<CSSProperties>(() => {
    if (!brand) return {};
    const { "--font-heading": _h, "--font-body": _b, "--font-label": _l, ...colours } = tenantThemeStyle({ primaryColor: brand.primary, accentColor: brand.accent, headingFont: "system-ui", bodyFont: "system-ui" }) as Record<string, string>;
    void _h; void _b; void _l;
    return colours as CSSProperties;
  }, [brand]);

  const showTab = (value: Tab, kind?: EnrolKind) => {
    const query = new URLSearchParams(params);
    if (value === "enroll") { query.set("mode", "enroll"); if (kind) query.set("as", kind); else query.delete("as"); }
    else { query.delete("mode"); query.delete("as"); }
    setParams(query, { replace: true });
    setError(""); setInfo("");
  };

  const route = useCallback(async (userId: string) => {
    if (routing.current) return;
    routing.current = true;
    // A stuck or failed access check shows the form with a retry message instead of an endless "Checking your session…".
    let access: AccessSummary | typeof SLOW;
    try { access = await within<AccessSummary | typeof SLOW>(fetchAccess(userId), 12000, SLOW); }
    catch { access = SLOW; }
    if (access === SLOW) {
      setError("We could not check your access just now. Refresh the page to try again, or sign in below.");
      setChecking(false);
      routing.current = false;
      return;
    }
    const decision = decideLogin(access, next, readLastDestination(userId));
    if (decision.kind === "blocked" && access.portal === "no_access" && !access.cms) {
      const { data } = await supabase.auth.getUser();
      if (data.user && data.user.id === userId && isSelfSignUpAccount(data.user)) {
        setCompleting(data.user);
        setChecking(false);
        routing.current = false;
        return;
      }
    }
    if (decision.kind === "blocked") {
      // Nothing usable: end the session so no half-signed-in state is left behind.
      await supabase.auth.signOut({ scope: "local" });
      markSessionSeen(false);
      setError(decision.message);
      setChecking(false);
      routing.current = false;
      return;
    }
    markSessionSeen(true);
    if (decision.kind === "choose") { setChoice({ userId, options: decision.options }); setChecking(false); routing.current = false; return; }
    if (decision.to.startsWith("/admin")) rememberDestination(userId, "cms");
    else if (decision.to.startsWith("/agency")) rememberDestination(userId, "portal");
    else if (decision.to.startsWith("/staff")) rememberDestination(userId, "staff");
    navigate(decision.to, { replace: true });
  }, [next, navigate]);

  // Someone who is already signed in (or returning from an invite, reset or sign-in link) is routed without seeing the form.
  useEffect(() => {
    let active = true;
    let stopRetry = () => {};
    if (enrolOnOpen.current) {
      setChecking(false);
      void within<SessionCheck | typeof SLOW>(checkSession(), 6000, SLOW).catch((): typeof SLOW => SLOW).then((check) => {
        if (active && check !== SLOW && check.kind === "session") setSignedInAs({ id: check.session.user.id, email: check.session.user.email ?? "" });
      });
      return () => { active = false; };
    }
    // Reading the saved session waits on a lock shared by every open tab of this site; a tab that is stuck holding it must
    // not leave this page spinning, so after a few seconds the sign-in form is shown and a late answer still routes.
    void within<SessionCheck | typeof SLOW>(checkSession(), 6000, SLOW).catch((): typeof SLOW => SLOW).then((check) => {
      if (!active) return;
      if (check === SLOW) {
        setChecking(false);
        void checkSession().then((late) => { if (active && late.kind === "session") void route(late.session.user.id); }).catch(() => {});
        return;
      }
      if (check.kind === "session") { void route(check.session.user.id); return; }
      setChecking(false);
      // A saved session that could not be refreshed offline is routed as soon as the network is back.
      if (check.kind === "unavailable") stopRetry = retryUntil(async () => {
        const again = await checkSession();
        if (again.kind === "unavailable") return false;
        if (again.kind === "session" && active) void route(again.session.user.id);
        return true;
      });
    });
    return () => { active = false; stopRetry(); };
  }, [route]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(""); setInfo("");
    if (!email.trim() || !password) { setError("Please enter your email and password."); return; }
    setBusy(true);
    const { data, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (authError || !data.user) { setBusy(false); setError(loginErrorMessage(authError)); return; }
    await route(data.user.id);
    setBusy(false);
  };

  if (checking) {
    return <div className="flex min-h-screen items-center justify-center bg-background-100" style={themeStyle}><AdminLoading label="Checking your session…" /></div>;
  }

  const tabClass = (value: Tab) => `flex-1 cursor-pointer rounded-md px-3 py-2 text-center text-sm font-semibold transition-colors ${tab === value ? "bg-background-50 text-foreground-950 shadow-sm" : "text-foreground-600 hover:text-foreground-900"}`;

  return (
    <div className="flex min-h-screen bg-background-100" style={themeStyle}>
      <div className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-primary-500 p-10 text-background-50 lg:flex">
        <div className="flex items-center gap-3">
          {brand?.logoUrl ? (
            <img src={brand.logoUrl} alt="" className="h-10 w-auto rounded-lg bg-background-50/90 object-contain p-1" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-background-50/20"><i className="ri-building-2-line text-xl" aria-hidden="true" /></span>
          )}
          <span className="font-heading text-lg font-bold">{brandName}</span>
        </div>
        <div>
          <h1 className="font-heading text-3xl font-bold leading-tight">{tab === "enroll" ? "Join Skyline" : "Welcome back"}</h1>
          <p className="mt-4 max-w-md text-sm text-background-50/85">
            {tab === "enroll"
              ? "Students enroll in minutes. Education agents register their business and are reviewed by our team. Staff apply and are approved by an administrator, or join by invitation."
              : "Students, agents and staff all sign in here. We take you to your portal automatically."}
          </p>
        </div>
        {tenant ? <p className="text-xs text-background-50/70">{tenant}</p> : <p className="text-xs text-background-50/70">RTO 45989 &middot; CRICOS 04114B</p>}
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-background-50/10" />
        <div className="pointer-events-none absolute -bottom-24 right-10 h-72 w-72 rounded-full bg-background-50/10" />
      </div>

      <div className="flex w-full flex-1 items-start justify-center px-5 py-10 lg:w-[54%] lg:items-center">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-foreground-600 hover:text-primary-700">
            <i className="ri-arrow-left-line" aria-hidden="true" />
            Back to site
          </Link>
          <div className="mb-7 lg:hidden">
            {brand?.logoUrl ? <img src={brand.logoUrl} alt={brandName} className="h-11 w-auto object-contain" /> : (
              <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-500 text-background-50"><i className="ri-building-2-line text-xl" aria-hidden="true" /></span>
            )}
          </div>

          {completing ? (
            <CompleteSignUp
              user={completing}
              onStudentDone={(apply) => { const id = completing.id; setCompleting(null); if (apply) { navigate("/agency/applications/new", { replace: true }); return; } setChecking(true); void route(id); }}
              onAgentDone={(name) => {
                // Nothing to open until SLIT approves the business: end the session and say what happens next.
                void supabase.auth.signOut({ scope: "local" }).then(() => {
                  markSessionSeen(false); setCompleting(null); setError("");
                  setInfo(`Your application for ${name} has been received and our team is looking into it. We will get back to you.`);
                });
              }}
              onCancel={() => { void supabase.auth.signOut({ scope: "local" }).then(() => { markSessionSeen(false); setCompleting(null); }); }}
            />
          ) : choice ? (
            <div>
              <h2 className="font-heading text-2xl font-bold text-foreground-950">Where do you want to go?</h2>
              <p className="mt-1.5 text-sm text-foreground-600">Your account can use more than one area.</p>
              <div className="mt-6 space-y-3">
                {choice.options.map((option, index) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => { rememberDestination(choice.userId, option); navigate(destinationFor(option, next), { replace: true }); }}
                    className="flex w-full cursor-pointer items-center justify-between rounded-md border border-background-300 bg-background-50 px-4 py-3 text-left text-sm font-semibold text-foreground-900 transition-colors hover:border-primary-400 hover:bg-primary-50"
                  >
                    <span>{DESTINATION_LABEL[option]}{index === 0 && choice.options.length > 1 && readLastDestination(choice.userId) === option ? <span className="ml-2 text-xs font-normal text-foreground-500">last used</span> : null}</span>
                    <i className="ri-arrow-right-line" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {tab === "signin" ? (
                <>
                  <h2 className="font-heading text-2xl font-bold text-foreground-950">Welcome back</h2>
                  <p className="mt-1.5 text-sm text-foreground-600">{enrolAllowed ? "Students, agents and staff all sign in here." : `Sign in to ${brandName}.`}</p>
                </>
              ) : null}

              {enrolAllowed ? (
                <div role="tablist" aria-label="Sign in or enrol" className={`flex rounded-lg border border-background-300 bg-background-200 p-1 ${tab === "signin" ? "mt-6" : ""}`}>
                  <button type="button" role="tab" aria-selected={tab === "signin"} className={tabClass("signin")} onClick={() => showTab("signin")}>Sign in</button>
                  <button type="button" role="tab" aria-selected={tab === "enroll"} className={tabClass("enroll")} onClick={() => showTab("enroll")}>Enroll now</button>
                </div>
              ) : null}

              {tab === "enroll" ? (
                <div className="mt-6">
                  {signedInAs ? (
                    <div role="status" className="mb-4 rounded-md border border-background-300 bg-background-50 px-3 py-2.5 text-[13px] text-foreground-700">
                      You are signed in{signedInAs.email ? ` as ${signedInAs.email}` : ""}.{" "}
                      <button type="button" className="font-semibold text-primary-700 underline" onClick={() => { const id = signedInAs.id; setSignedInAs(null); setChecking(true); void route(id); }}>Go to my account</button>
                      {" or "}
                      <button type="button" className="font-semibold text-primary-700 underline" onClick={() => { void supabase.auth.signOut({ scope: "local" }).then(() => { markSessionSeen(false); setSignedInAs(null); }); }}>sign out</button>
                      {" to enrol a new account."}
                    </div>
                  ) : null}
                  <EnrolWizard key={initialKind ?? "none"} initialKind={initialKind} onSignIn={() => showTab("signin")} onSignedIn={(id) => { setChecking(true); void route(id); }} />
                </div>
              ) : (
                <>
                  <form onSubmit={submit} className="mt-6 space-y-4">
                    <Field label="Email" required>
                      <TextInput type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="username" />
                    </Field>
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[13px] font-medium text-foreground-800">Password <span className="text-primary-600">*</span></span>
                        <Link to="/forgot-password" className="text-[13px] font-medium text-primary-700 hover:text-primary-800">Forgot password?</Link>
                      </div>
                      <div className="relative">
                        <TextInput type={show ? "text" : "password"} name="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" className="pr-10" aria-label="Password" />
                        <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-foreground-500 hover:bg-background-100">
                          <i className={show ? "ri-eye-off-line" : "ri-eye-line"} aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    {error ? (
                      <div className="flex items-start gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-[13px] text-primary-900" role="alert">
                        <i className="ri-error-warning-line mt-0.5 text-base" aria-hidden="true" /><span>{error}</span>
                      </div>
                    ) : null}
                    {info ? (
                      <div className="flex items-start gap-2 rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2.5 text-[13px] text-secondary-900" role="status">
                        <i className="ri-mail-check-line mt-0.5 text-base" aria-hidden="true" /><span>{info}</span>
                      </div>
                    ) : null}

                    <Button type="submit" className="w-full" disabled={busy} icon={busy ? undefined : "ri-login-circle-line"}>{busy ? "Signing in…" : "Sign in"}</Button>
                  </form>

                  <div className="my-5 flex items-center gap-3 text-xs text-foreground-500" aria-hidden="true">
                    <span className="h-px flex-1 bg-background-300" />or<span className="h-px flex-1 bg-background-300" />
                  </div>
                  <QuickSignIn create={false} onSignedIn={(id) => { setChecking(true); void route(id); }} />

                  <p className="mt-8 text-center text-xs text-foreground-500">
                    {enrolAllowed ? "You’ll be taken to your Student, Agent or Staff portal automatically." : "Need help signing in? Contact your administrator."}
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
