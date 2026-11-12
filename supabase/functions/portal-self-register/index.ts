// Public "Enroll now" endpoint (verify_jwt = false): a student or an agent enrols from the sign-in page. Every write goes
// through portal_self_register (service_role), which creates the ordinary student / business record and the same
// invitation the CMS would create; this function validates input, rate-limits by caller and email, and sends the Auth
// password-setup mail. Nothing it returns identifies other people: existing records only ever surface as the same
// error text the database raises for the caller's own email.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { cleanEmail, cleanName } from "../_shared/user-input.ts";
import { lookupAgencyAbn, normalizeAbn, validateAbn, type AgencyAbnDetails } from "../_shared/validation/abn.ts";
import { deliverInvite, findAuthUserByEmail } from "../_shared/invite-delivery.ts";
import { emailConflictBody, publicEmailTakenBody } from "../_shared/identity-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Max-Age": "600",
  "Access-Control-Expose-Headers": "Retry-After",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, ...extra } });

// portal_self_register's own refusals for an email that already has an account or a pending invitation (20261105140000),
// next to the identity trigger's hint. The sign-up page shows one public sentence for all of them, never the role.
const EMAIL_ACCOUNT_REFUSAL = /^This email (already has an account|has already been invited)\b/;

function rpcFailure(error: { code?: string; message?: string; hint?: string; details?: string }) {
  if (error.code === "23505" && (emailConflictBody(error) || EMAIL_ACCOUNT_REFUSAL.test(error.message ?? ""))) return json(publicEmailTakenBody(), 409);
  const message = error.message || "The request could not be completed.";
  switch (error.code) {
    case "23505":
    case "23514": return json({ error: message }, 409);
    case "22023":
    case "23503": return json({ error: message }, 400);
    case "P0002": return json({ error: message }, 404);
    default: return json({ error: "We could not complete your enrolment. Please try again shortly." }, 500);
  }
}

const hash = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, "0")).join("");

// deno-lint-ignore no-explicit-any
async function withinLimit(admin: any, bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await admin.rpc("public_assistant_take_rate_limit", { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds });
  // A failed limiter call fails closed: anonymous writes are never allowed through unmetered.
  return !error && data === true;
}

/** Where the password-setup mail may send the caller: only this deployment's /reset-password page (Auth's own allow-list applies too). */
function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) return undefined;
    if (!url.pathname.endsWith("/reset-password")) return undefined;
    return url.toString();
  } catch { return undefined; }
}

const abnCache = new Map<string, { expires: number; business: AgencyAbnDetails }>();
const ABN_REGISTERED = "The ABN you entered already exists in our system. Please contact Skyline to get registered.";
// The shared phone field sends E.164 (+ country code, 8 to 15 digits in all).
const MOBILE = /^\+[1-9]\d{7,14}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY, ANON_KEY);
  if (configuration) return json(configuration, 503);

  let parsed: Record<string, unknown> = {};
  try { parsed = (await req.json()) as Record<string, unknown>; } catch { parsed = {}; }
  const action = String(parsed.action ?? "");
  const text = (key: string, max = 200) => String(parsed[key] ?? "").trim().slice(0, max);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const callerKey = await hash(req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "anonymous");
  if (!(await withinLimit(admin, `self-register:caller:${callerKey}`, action === "lookup_abn" || action === "check_abn" ? 20 : 8, 600))) {
    return json({ error: "Please wait a few minutes before trying again." }, 429, { "Retry-After": "600" });
  }
  // A filled honeypot field is a bot: answer as if it worked and record nothing.
  if (text("website")) return json({ ok: true, kind: text("kind"), emailSent: true, existingIdentity: false });

  try {
    if (action === "lookup_abn" || action === "check_abn") {
      const abn = normalizeAbn(text("abn", 20));
      const problem = validateAbn(abn);
      if (problem) return json({ error: problem }, 400);
      // An ABN already in the system is refused before anything else (the business registers once, through Skyline).
      const { data: registered, error: registeredError } = await admin.rpc("portal_abn_registered", { p_abn: abn });
      if (registeredError) return json({ error: "We could not check this ABN right now. Please try again shortly." }, 503);
      if (registered === true) return json({ error: ABN_REGISTERED, registered: true }, 409);
      if (action === "check_abn") return json({ registered: false });
      const cached = abnCache.get(abn);
      if (cached && cached.expires > Date.now()) return json({ business: cached.business });
      try {
        const business = await lookupAgencyAbn(abn);
        if (abnCache.size >= 256) abnCache.clear();
        abnCache.set(abn, { expires: Date.now() + 5 * 60 * 1000, business });
        return json({ business });
      } catch {
        return json({ error: "We could not look this ABN up right now. Enter the details yourself or try again shortly." }, 503);
      }
    }

    if (action !== "register") return json({ error: "Unknown action." }, 400);
    const kind = text("kind", 10);
    if (kind !== "student" && kind !== "agent") return json({ error: "Choose Student or Agent." }, 400);
    const email = cleanEmail(parsed.email);
    if (!email.ok) return json({ error: email.error }, 400);
    if (parsed.agreed !== true) return json({ error: "Please agree to the terms and privacy policy." }, 400);
    if (!(await withinLimit(admin, `self-register:email:${await hash(email.value)}`, 3, 3600))) {
      return json({ error: "We have already received an enrolment for this email. Check your inbox, or try again in an hour." }, 429, { "Retry-After": "3600" });
    }

    const input: Record<string, unknown> = { email: email.value };
    let displayName = "";
    if (kind === "student") {
      // A student signs up with their email and mobile only (like an application); name and date of birth come later
      // from the passport and the application form, and are checked here only when given.
      const first = text("firstName", 100) ? cleanName(parsed.firstName) : { ok: true as const, value: "" };
      const last = text("lastName", 100) ? cleanName(parsed.lastName) : { ok: true as const, value: "" };
      if (!first.ok) return json({ error: "Check your first name." }, 400);
      if (!last.ok) return json({ error: "Check your last name." }, 400);
      const mobile = text("phone", 40).replace(/[\s().-]/g, "");
      if (!MOBILE.test(mobile)) return json({ error: "Enter your mobile number with its country code." }, 400);
      const dob = text("dateOfBirth", 10);
      if (dob && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob)))) return json({ error: "Enter a valid date of birth." }, 400);
      const referral = text("referralCode", 40);
      if (/[^A-Za-z0-9 ._-]/.test(referral)) return json({ error: "Check the referral code." }, 400);
      Object.assign(input, { firstName: first.value, lastName: last.value, phone: mobile, dateOfBirth: dob, course: text("course", 200), referralCode: referral });
      displayName = `${first.value} ${last.value}`.trim();
    } else {
      const contact = cleanName(parsed.contactName);
      if (!contact.ok) return json({ error: "Enter the contact person's name." }, 400);
      const abn = normalizeAbn(text("abn", 20));
      const abnProblem = validateAbn(abn);
      if (abnProblem) return json({ error: abnProblem }, 400);
      const businessName = text("businessName", 200);
      if (businessName.length < 2) return json({ error: "Enter the agency or company name." }, 400);
      const phone = text("phone", 40);
      if (!/^\+?[\d\s().-]{6,40}$/.test(phone)) return json({ error: "Enter a phone number." }, 400);
      Object.assign(input, { contactName: contact.value, abn, businessName, phone });
      displayName = contact.value;
    }

    // A brand-new student who chose a password gets a ready account (no email round trip) and goes straight into their
    // application. An email already on a student record (added by an agent or SLIT) is claimed instead: the database
    // checks the mobile matches that record, then a one-time code goes to the email and the page sets the password once
    // the code is right. An email with a sign-in but no student record never gets a password here: that sign-in may be
    // someone else's, so its owner proves the email through the emailed link instead.
    const password = kind === "student" && typeof parsed.password === "string" ? parsed.password : "";
    let accountId = "";
    let passwordRefused = false;
    let claim = false;
    let hasSignIn = false;
    if (password) {
      if (password.length < 10 || password.length > 72) return json({ error: "Choose a password of 10 to 72 characters." }, 400);
      if (/skyline|slit/i.test(password)) return json({ error: "Please avoid using the organisation name in your password." }, 400);
      const { data: onRecord, error: recordError } = await admin.from("enrollment_students").select("id").ilike("email", email.value.replace(/[\\%_]/g, "\\$&")).limit(1);
      const existing = await findAuthUserByEmail(admin, email.value);
      if (recordError || existing.error) return json({ error: "We could not complete your enrolment. Please try again shortly." }, 503);
      hasSignIn = Boolean(existing.user);
      if ((onRecord ?? []).length) claim = true;
      else if (existing.user) passwordRefused = true;
      else {
        const { data: created, error: createErr } = await admin.auth.admin.createUser({ email: email.value, password, email_confirm: true, user_metadata: { name: displayName } });
        if (createErr || !created?.user) {
          const weak = /password/i.test(createErr?.message ?? "");
          return json({ error: weak ? createErr!.message : "We could not create your account. Please try again shortly." }, weak ? 400 : 503);
        }
        accountId = created.user.id;
      }
    }

    const { data, error } = await admin.rpc("portal_self_register", { p_kind: kind, p_input: input });
    if (error) {
      if (accountId) await admin.auth.admin.deleteUser(accountId).catch(() => undefined);
      return rpcFailure(error);
    }
    // The pending invitation is accepted when they sign in (portal_resolve_access), which the page does at once.
    if (accountId) return json({ ok: true, kind, signIn: true, emailSent: false, existingIdentity: false, businessName: null, direct: data?.direct ?? null, warning: null });

    if (claim) {
      // The mobile matched the record (portal_self_register refuses otherwise). The code lands on a sign-in for this
      // email, made here without a password when there is none yet; the page sets the password once the code is right.
      if (!hasSignIn) {
        const { error: createErr } = await admin.auth.admin.createUser({ email: email.value, email_confirm: true, user_metadata: { name: String(data?.name ?? displayName) } });
        if (createErr) return json({ error: "We could not prepare your account. Please try again shortly." }, 503);
      }
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: codeErr } = await anon.auth.signInWithOtp({ email: email.value, options: { shouldCreateUser: false } });
      if (codeErr) console.error("portal-self-register code email failed", codeErr.message);
      return json({
        ok: true, kind, claim: true, emailSent: !codeErr, existingIdentity: false, businessName: null, direct: data?.direct ?? null,
        warning: codeErr ? "We could not email your code right now. Use \"Send the code again\" in a moment." : null,
      });
    }

    // The record and its invitation exist; the mail is best effort (a resend is one click away for SLIT staff).
    const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const delivery = await deliverInvite(admin, anon, email.value, String(data?.name ?? displayName), safeRedirect(parsed.redirectTo));
    return json({
      ok: true, kind, emailSent: delivery.emailSent, existingIdentity: delivery.existingIdentity,
      businessName: data?.businessName ?? null, direct: data?.direct ?? null,
      warning: delivery.error ? "Your enrolment was recorded, but the email could not be sent. Use \"Forgot password?\" on the sign-in tab to get a link."
        : passwordRefused && !delivery.existingIdentity ? "This email is already on a student record, so for your security we've emailed you a link to choose your password. Open it, then sign in to continue your application." : null,
    });
  } catch (error) {
    console.error("portal-self-register failed", error);
    return json({ error: "We could not complete your enrolment. Please try again shortly." }, 500);
  }
});
