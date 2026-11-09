// Public staff sign-up gate (verify_jwt = false): staff register themselves from the sign-in page ("Needs approval", like agents).
// This function is the ONLY place the email code is requested for a staff sign-up. Before any email is sent it
//   1. rate-limits per caller IP and per email,
//   2. normalises the phone number to E.164 and checks the email and number against existing staff, students, agents, portal
//      users, waiting invitations and admin users (hr_staff_precheck, service role only),
//   3. answers a conflict with one neutral message that never says which kind of account exists.
// Only then does it ask Supabase Auth to email a one-time code / confirmation link (signInWithOtp). No SMS is ever sent: the phone
// number is collected, normalised and stored, not verified. Nothing here grants access; the verified email session does, and
// hr_staff_start re-checks everything. An existing student/agent signs in and attaches the application to the same login instead.
// Action admin_add (an Active CMS Admin, verified from the bearer token): adds a staff member from the CMS. The person is invited
// by email (Auth invite; an existing sign-in is reused and gets no email) and hr_admin_staff_create (service role) writes their draft
// staff record with the name filled in. The same duplicate checks apply.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { cleanEmail } from "../_shared/user-input.ts";
import { toE164 } from "../_shared/staff-phone.ts";

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
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, ...extra } });

const NEUTRAL_EMAIL = "This email can't be used. Sign in or contact the administrator.";
const NEUTRAL_PHONE = "This number can't be used. Sign in or contact the administrator.";

const hash = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, "0")).join("");

// deno-lint-ignore no-explicit-any
async function withinLimit(admin: any, bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await admin.rpc("public_assistant_take_rate_limit", { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds });
  // A failed limiter call fails closed: anonymous requests are never allowed through unmetered.
  return !error && data === true;
}

/** Where the email link may send the caller: only this deployment's /staff/apply page (Auth's own allow-list applies too). */
function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) return undefined;
    return url.pathname.endsWith("/staff/apply") ? url.toString() : undefined;
  } catch { return undefined; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY, ANON_KEY);
  if (configuration) return json(configuration, 503);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { body = {}; }
  const action = String(body.action ?? "");
  if (action !== "check" && action !== "send_code" && action !== "admin_add" && action !== "employee_invite") return json({ error: "Unknown action." }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  if (action === "admin_add") return adminAdd(req, body, admin);
  if (action === "employee_invite") return employeeInvite(req, body, admin);
  const callerKey = await hash(req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "anonymous");
  if (!(await withinLimit(admin, `staff-register:caller:${action}:${callerKey}`, action === "check" ? 30 : 8, 600))) {
    return json({ error: "Please wait a few minutes before trying again." }, 429, { "Retry-After": "600" });
  }
  // A filled honeypot field is a bot: answer as if it worked and record nothing.
  if (String(body.website ?? "").trim()) return json({ ok: true });

  const email = cleanEmail(body.email);
  if (!email.ok) return json({ error: email.error }, 400);
  const phone = toE164(body.phone);
  if (!phone) return json({ error: "Enter your mobile number with its country code." }, 400);
  if (body.agreed !== true) return json({ error: "Please agree to the terms and privacy policy." }, 400);
  if (!(await withinLimit(admin, `staff-register:email:${action}:${await hash(email.value)}`, action === "check" ? 12 : 3, 3600))) {
    return json({ error: "Please wait a while before requesting another email for this address." }, 429, { "Retry-After": "3600" });
  }

  const { data: check, error: checkError } = await admin.rpc("hr_staff_precheck", { p_email: email.value, p_phone: phone });
  if (checkError || !check) return json({ error: "We could not check these details right now. Please try again shortly." }, 503);
  if (check.ok !== true) {
    // The neutral text never says whether the match is a student, an agent or an administrator.
    if (check.emailConflict) return json({ error: NEUTRAL_EMAIL, field: "email" }, 409);
    if (check.phoneConflict) return json({ error: NEUTRAL_PHONE, field: "phone" }, 409);
    return json({ error: "Check your email address and mobile number." }, 400);
  }
  if (action === "check") return json({ ok: true, phone });

  // The code / link comes from Supabase Auth (custom SMTP), exactly like student sign-up mail; the phone number rides in the
  // sign-up metadata so the link can be opened on another device. hr_staff_start reads and re-validates it.
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await anon.auth.signInWithOtp({
    email: email.value,
    options: { shouldCreateUser: true, emailRedirectTo: safeRedirect(body.redirectTo), data: { staff_phone: phone, registrant: "staff" } },
  });
  if (error) return json({ error: "We could not send the email. Please try again shortly." }, 502);
  return json({ ok: true, phone });
});

/** The caller must be an Active CMS Admin (the token is verified with the anon client, the role read with the service role). */
// deno-lint-ignore no-explicit-any
async function callerAdmin(req: Request, admin: any): Promise<{ id: string } | null> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: row } = await admin.from("cms_users").select("role, status").eq("auth_user_id", data.user.id).maybeSingle();
  return row && row.role === "Admin" && row.status === "Active" ? { id: data.user.id } : null;
}

// deno-lint-ignore no-explicit-any
async function findAuthUserByEmail(admin: any, email: string): Promise<{ id: string } | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) return null;
    const match = data.users.find((u: { email?: string | null }) => (u.email ?? "").toLowerCase() === email);
    if (match) return { id: match.id };
    if (data.users.length < 200) break;
  }
  return null;
}

// deno-lint-ignore no-explicit-any
async function adminAdd(req: Request, body: Record<string, unknown>, admin: any): Promise<Response> {
  const caller = await callerAdmin(req, admin);
  if (!caller) return json({ error: "Only an administrator can add staff." }, 403);
  const email = cleanEmail(body.email);
  if (!email.ok) return json({ error: email.error, field: "email" }, 400);
  const phone = toE164(body.phone);
  if (!phone) return json({ error: "Enter the mobile number with its country code.", field: "phone" }, 400);
  const firstName = String(body.firstName ?? "").trim(), lastName = String(body.lastName ?? "").trim();
  if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) return json({ error: "Enter the first and last name." }, 400);
  const role = body.role === "admin" || body.role === "trainer" ? body.role : null;

  const { data: check, error: checkError } = await admin.rpc("hr_staff_precheck", { p_email: email.value, p_phone: phone });
  if (checkError || !check) return json({ error: "We could not check these details right now. Please try again shortly." }, 503);
  if (check.ok !== true) {
    if (check.emailConflict) return json({ error: "This email already belongs to a student, agent, staff member or admin user.", field: "email" }, 409);
    if (check.phoneConflict) return json({ error: "This mobile number already belongs to a student, agent, staff member or admin user.", field: "phone" }, 409);
    return json({ error: "Check the email address and mobile number." }, 400);
  }

  // An existing sign-in (not matched above, so it has no record of its own) is reused; otherwise Auth emails an invitation.
  let user = await findAuthUserByEmail(admin, email.value);
  let emailSent = false, created = false;
  if (!user) {
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email.value, {
      data: { registrant: "staff", staff_phone: phone, name: `${firstName} ${lastName}` }, redirectTo: safeRedirect(body.redirectTo),
    });
    if (inviteError || !invited?.user) return json({ error: "The invitation email could not be sent. Please try again shortly." }, 502);
    user = { id: invited.user.id }; emailSent = true; created = true;
  }
  const { data, error } = await admin.rpc("hr_admin_staff_create", {
    p_auth_user_id: user.id, p_email: email.value, p_phone: phone, p_first_name: firstName, p_last_name: lastName, p_role: role, p_admin: caller.id,
  });
  if (error) {
    if (created) await admin.auth.admin.deleteUser(user.id).catch(() => undefined);
    return json({ error: error.message || "The staff member could not be added." }, 400);
  }
  return json({ ok: true, profileId: data?.id ?? null, emailSent });
}


// deno-lint-ignore no-explicit-any
async function employeeInvite(req: Request, body: Record<string, unknown>, admin: any): Promise<Response> {
  const caller = await callerAdmin(req, admin);
  if (!caller) return json({ error: "Only an administrator can invite an employee." }, 403);
  const profileId = String(body.profileId ?? "");
  const redirectTo = safeRedirect(body.redirectTo);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(profileId) || !redirectTo) {
    return json({ error: "Check the employee and invitation destination." }, 400);
  }
  const { data: target, error: targetError } = await admin.rpc("hr_employee_invite_target", { p_id: profileId });
  if (targetError || !target) return json({ error: targetError?.message ?? "Employee record not found." }, 400);
  if (!(await withinLimit(admin, `staff-register:employee-invite:${profileId}`, 3, 3600))) {
    return json({ error: "Please wait before requesting another invitation." }, 429, { "Retry-After": "3600" });
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = target.hasAccount
    ? await anon.auth.signInWithOtp({ email: target.email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } })
    : await admin.auth.admin.inviteUserByEmail(target.email, {
      redirectTo, data: { registrant: "staff", staff_phone: target.phone, name: target.name },
    });
  if (error) return json({ error: "The invitation could not be sent. Check the address or try again shortly." }, 502);
  const { error: auditError } = await admin.rpc("hr_employee_invite_logged", { p_id: profileId, p_actor: caller.id });
  if (auditError) console.error("Employee invitation audit write failed", auditError.code);
  return json({ ok: true, emailSent: true });
}
