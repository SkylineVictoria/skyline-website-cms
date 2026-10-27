import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { AdminLoading, Button, Field, TextInput } from "@/pages/admin/components/ui";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { resolveTenantSite } from "@/lib/tenantSite";
import { passwordRecoveryUrl } from "@/lib/siteUrl";
import { readCachedBrand, tenantBrandKey } from "@/lib/brandCache";
import { tenantThemeStyle } from "@/lib/tenantTheme";
import type { PortalAccessState } from "@/pages/agency/lib/applicationAccess";
import {
  DESTINATION_LABEL, decideLogin, destinationFor, loginErrorMessage, loginNotice, markSessionSeen, readLastDestination, rememberDestination,
  type AccessSummary, type CmsAccess, type LoginDestination,
} from "@/lib/loginRouting";

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
  return { cms, portal };
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const notice = loginNotice(params.get("reason"));
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState(notice);
  const [choice, setChoice] = useState<{ userId: string; options: LoginDestination[] } | null>(null);
  const routing = useRef(false);

  // Tenant domains show the tenant's cached logo / name / colour; the main Skyline domain keeps the built-in branding.
  const tenant = requestWebsiteDomain();
  const brand = useMemo(() => (tenant ? readCachedBrand(tenantBrandKey()) : null), [tenant]);
  const brandName = brand?.name || tenant || "Skyline Institute of Technology";
  const themeStyle = useMemo<CSSProperties>(() => {
    if (!brand) return {};
    const { "--font-heading": _h, "--font-body": _b, "--font-label": _l, ...colours } = tenantThemeStyle({ primaryColor: brand.primary, accentColor: brand.accent, headingFont: "system-ui", bodyFont: "system-ui" }) as Record<string, string>;
    void _h; void _b; void _l;
    return colours as CSSProperties;
  }, [brand]);

  const route = useCallback(async (userId: string) => {
    if (routing.current) return;
    routing.current = true;
    const decision = decideLogin(await fetchAccess(userId), next, readLastDestination(userId));
    if (decision.kind === "blocked") {
      // Nothing usable: end the session so no half-signed-in state is left behind.
      await supabase.auth.signOut();
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
    navigate(decision.to, { replace: true });
  }, [next, navigate]);

  // Someone who is already signed in (or returning from an invite / reset) is routed without seeing the form.
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session?.user) void route(data.session.user.id);
      else setChecking(false);
    }).catch(() => { if (active) setChecking(false); });
    return () => { active = false; };
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

  const forgot = async () => {
    setError(""); setInfo("");
    if (!email.trim()) { setError("Enter your email address first, then choose “Forgot password?”."); return; }
    setResetBusy(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: passwordRecoveryUrl() });
    setResetBusy(false);
    if (resetError) setError(loginErrorMessage(resetError).replace("Incorrect email or password.", "We could not send the reset email. Please try again later."));
    else setInfo("If that email belongs to an account, a password reset link is on its way.");
  };

  if (checking) {
    return <div className="flex min-h-screen items-center justify-center bg-background-100" style={themeStyle}><AdminLoading label="Checking your session…" /></div>;
  }

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
          <h1 className="font-heading text-3xl font-bold leading-tight">Welcome back</h1>
          <p className="mt-4 max-w-md text-sm text-background-50/85">
            One sign-in for website staff, administrators, agency administrators and agents. We take you to the right place for your role.
          </p>
        </div>
        {tenant ? <p className="text-xs text-background-50/70">{tenant}</p> : <p className="text-xs text-background-50/70">RTO 45989 &middot; CRICOS 04114B</p>}
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-background-50/10" />
        <div className="pointer-events-none absolute -bottom-24 right-10 h-72 w-72 rounded-full bg-background-50/10" />
      </div>

      <div className="flex w-full flex-1 items-center justify-center px-5 py-10 lg:w-[54%]">
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

          {choice ? (
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
              <h2 className="font-heading text-2xl font-bold text-foreground-950">Sign in</h2>
              <p className="mt-1.5 text-sm text-foreground-600">Sign in to your Skyline account</p>

              <form onSubmit={submit} className="mt-7 space-y-4">
                <Field label="Email address" required>
                  <TextInput type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="username" />
                </Field>
                <Field label="Password" required>
                  <div className="relative">
                    <TextInput type={show ? "text" : "password"} name="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" className="pr-10" />
                    <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-foreground-500 hover:bg-background-100">
                      <i className={show ? "ri-eye-off-line" : "ri-eye-line"} aria-hidden="true" />
                    </button>
                  </div>
                </Field>
                <div className="flex justify-end">
                  <button type="button" onClick={forgot} disabled={resetBusy} className="cursor-pointer text-[13px] font-medium text-primary-700 hover:text-primary-800 disabled:cursor-not-allowed disabled:opacity-60">
                    {resetBusy ? "Sending…" : "Forgot password?"}
                  </button>
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

              <p className="mt-6 text-center text-xs text-foreground-500">
                Accounts are created by invitation. Need help signing in? Contact your administrator or IT Support.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
