// Public staff sign-up gate (verify_jwt = false): staff register themselves from the sign-in page ("Needs approval", like agents).
// This function is the ONLY place the email code is requested for a staff sign-up. Before any email is sent it
//   1. rate-limits per caller IP and per email,
//   2. normalises the phone number to E.164 and checks the email and number against existing staff, students, agents, portal
//      users, waiting invitations and admin users (hr_staff_precheck, service role only),
//   3. answers a conflict with one neutral message that never says which kind of account exists.
// Only then does it ask Supabase Auth to email a one-time code / confirmation link (signInWithOtp). No SMS is ever sent: the phone
// number is collected, normalised and stored, not verified. Nothing here grants access; the verified email session does, and
// hr_staff_start re-checks everything. An existing student/agent signs in and attaches the application to the same login instead.
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
  if (action !== "check" && action !== "send_code") return json({ error: "Unknown action." }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
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
