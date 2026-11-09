// Public staff application (verify_jwt = false): "Enroll now" > Staff posts name, email, mobile, resume and a CAPTCHA token
// as multipart/form-data with action "apply". No auth account is created; the logic and its order of checks live in core.ts.
// All data access is service-role only inside this function. Responses are never cached and send no referrer.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { selectCaptchaVerifier } from "../_shared/captcha.ts";
import { MAX_REQUEST_BYTES, handleApply } from "./core.ts";
import { HR_MAIL_ENV, drainHrOutbox } from "../_shared/hr-mail-drain.ts";

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const captcha = selectCaptchaVerifier({ EF_CAPTCHA_SECRET_KEY: Deno.env.get("EF_CAPTCHA_SECRET_KEY") ?? "", SUPABASE_URL });
const mailEnv: Record<string, string> = { SUPABASE_URL };
for (const name of HR_MAIL_ENV) mailEnv[name] = Deno.env.get(name) ?? "";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Max-Age": "600",
  "Access-Control-Expose-Headers": "Retry-After",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });

const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY);
  if (configuration) return json(configuration, 503);
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_REQUEST_BYTES) return json({ error: "The resume must be 5 MB or smaller.", field: "resume" }, 413);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json({ error: "Unknown action." }, 400);

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "The form could not be read." }, 400); }
  if (String(form.get("action") ?? "") !== "apply") return json({ error: "Unknown action." }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = admin.storage.from("staff-documents");
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const result = await handleApply(form, { ip }, {
    captcha,
    // A failed limiter call fails closed: anonymous requests are never allowed through unmetered.
    takeRateLimit: async (b, limit, windowSeconds) => {
      const { data, error } = await admin.rpc("public_assistant_take_rate_limit", { p_bucket: b, p_limit: limit, p_window_seconds: windowSeconds });
      return !error && data === true;
    },
    rpc: async (name, args) => { const { data, error } = await admin.rpc(name, args); return { data, error }; },
    upload: async (path, bytes, contentType) => {
      const { error } = await bucket.upload(path, bytes, { contentType, upsert: false });
      return { error: error ? error.message : null };
    },
    remove: async (path) => { await bucket.remove([path]); },
    hash: sha256,
    newId: () => crypto.randomUUID(),
  });
  // "Application received", "new application" or "already applied" may have been queued: send after the response.
  if (result.status === 200) EdgeRuntime.waitUntil(drainHrOutbox(admin, mailEnv).catch(() => undefined));
  return json(result.body, result.status, result.headers ?? {});
});
