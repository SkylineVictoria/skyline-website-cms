// Documents & Signatures (SIGN-01, SIGN-02). verify_jwt stays on: an administrator calls with their session, a link holder with the public
// anon key plus the token of their emailed link, and the scheduled job with the service-role key. All logic is in core.ts.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { loadLetterhead } from "../_shared/letterhead.ts";
import { readHrMailConfig, selectHrMailProvider } from "../_shared/hr-mail.ts";
import { HR_MAIL_ENV } from "../_shared/hr-mail-drain.ts";
import { handleSigning, readSigningRequest, SigningError, type SigningPorts } from "./core.ts";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Type": "application/json" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
const env: Record<string, string> = { SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? "" };
for (const key of HR_MAIL_ENV) env[key] = Deno.env.get(key) ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const mail = { provider: selectHrMailProvider(env), config: readHrMailConfig(env) };
const sameText = (a: string, b: string) => { if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const service = createClient(env.SUPABASE_URL, serviceKey, { auth: { persistSession: false } });
  const authorization = req.headers.get("authorization") ?? "";
  const caller = createClient(env.SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const bucket = service.storage.from("signing-documents");
  // deno-lint-ignore no-explicit-any
  const unwrap = (result: { data: any; error: { message: string; code?: string } | null }) => { if (result.error) throw { message: result.error.message, code: result.error.code }; return result.data; };
  const ports: SigningPorts = {
    service: async (action, args = {}) => unwrap(await service.rpc("signing_service", { p_action: action, p_hash: args.hash ?? null, p_id: args.id ?? null, p_data: args.data ?? {} })),
    admin: async (action, id = null, data = {}) => unwrap(await caller.rpc("signing_admin", { p_action: action, p_id: id, p_data: data })),
    callerRpc: async (name, args) => unwrap(await caller.rpc(name, args)),
    storage: {
      download: async (path) => { const { data, error } = await bucket.download(path); return error || !data ? null : new Uint8Array(await data.arrayBuffer()); },
      upload: async (path, bytes) => !(await bucket.upload(path, bytes, { contentType: "application/pdf", upsert: false })).error,
      remove: async (paths) => { await bucket.remove(paths); },
      signedUrl: async (path, seconds, name) => { const { data, error } = await bucket.createSignedUrl(path, seconds, name ? { download: name } : undefined); return error || !data ? null : data.signedUrl; },
    },
    letterhead: () => loadLetterhead(service),
    mail,
    isServiceCaller: sameText(authorization.replace(/^Bearer\s+/i, ""), serviceKey),
    uuid: () => crypto.randomUUID(),
    later: (work) => {
      // deno-lint-ignore no-explicit-any
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(work.catch(() => undefined)); else return work.then(() => undefined, () => undefined);
    },
  };
  try {
    const { body, upload } = await readSigningRequest(req);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64) || null;
    return json(await handleSigning({ body, upload, ip, userAgent: (req.headers.get("user-agent") ?? "").slice(0, 400) || null }, ports));
  } catch (error) {
    return error instanceof SigningError ? json({ error: error.message }, error.status) : json({ error: "The signing request could not be completed." }, 400);
  }
});
