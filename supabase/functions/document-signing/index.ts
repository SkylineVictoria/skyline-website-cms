// Documents & Signatures (SIGN-01, SIGN-02). verify_jwt stays on: an administrator calls with their session, a link holder with the public
// anon key plus the token of their emailed link, and the scheduled job with the service-role key. All logic is in core.ts.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { loadLetterhead } from "../_shared/letterhead.ts";
import { readHrMailConfig, selectHrMailProvider } from "../_shared/hr-mail.ts";
import { loadEmailBranding } from "../_shared/email-html.ts";
import { HR_MAIL_ENV } from "../_shared/hr-mail-drain.ts";
import { handleSigning, readSigningRequest, SigningError, type SigningPorts } from "./core.ts";
import { GEOSCAPE_URL, searchAddresses } from "../_shared/validation/address.ts";
import { isLocalSupabaseUrl } from "../_shared/captcha.ts";
import { isServiceCaller } from "../_shared/service-role.ts";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Type": "application/json" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
const env: Record<string, string> = { SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? "" };
for (const key of HR_MAIL_ENV) env[key] = Deno.env.get(key) ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const mail = { provider: selectHrMailProvider(env), config: readHrMailConfig(env) };
// The F04 wizard address boxes: the SAME Geoscape key and helper as the address-search function (the key stays on the server).
const ADDRESS_KEY = Deno.env.get("EF_ADDRESS_SEARCH_GEOSCAPE_KEY") ?? "";
// LAB ONLY: EF_ADDRESS_SEARCH_API_URL sends the lookup to a mock, and only when SUPABASE_URL is local; otherwise plain fetch.
const ADDRESS_MOCK = (Deno.env.get("EF_ADDRESS_SEARCH_API_URL") ?? "").trim().replace(/\/+$/, "");
const addressFetch: typeof fetch = ADDRESS_MOCK && isLocalSupabaseUrl(env.SUPABASE_URL)
  ? ((input: string | URL | Request, init?: RequestInit) => fetch(String(input) === GEOSCAPE_URL ? `${ADDRESS_MOCK}/v1/verify/autocomplete/AU` : input, init)) as typeof fetch
  : fetch;
// The scheduled signing tick (pg_cron, vault signing_service_role_key) is the project's service-role JWT; SUPABASE_SERVICE_ROLE_KEY may hold
// a newer sb_secret_ key that no JWT equals (2026-11-20: every tick was refused with 403). One rule with the other workers: _shared/service-role.ts.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const service = createClient(env.SUPABASE_URL, serviceKey, { auth: { persistSession: false } });
  // The branded email layout (logo, colour, footer from Website settings; cached for five minutes per isolate).
  await loadEmailBranding(service);
  const authorization = req.headers.get("authorization") ?? "";
  const caller = createClient(env.SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const bucket = service.storage.from("signing-documents");
  const assets = service.storage.from("template-assets");
  // deno-lint-ignore no-explicit-any
  const unwrap = (result: { data: any; error: { message: string; code?: string } | null }) => { if (result.error) throw { message: result.error.message, code: result.error.code }; return result.data; };
  const ports: SigningPorts = {
    service: async (action, args = {}) => unwrap(await service.rpc("signing_service", { p_action: action, p_hash: args.hash ?? null, p_id: args.id ?? null, p_data: args.data ?? {} })),
    admin: async (action, id = null, data = {}) => unwrap(await caller.rpc("signing_admin", { p_action: action, p_id: id, p_data: data })),
    callerRpc: async (name, args) => unwrap(await caller.rpc(name, args)),
    serviceRpc: async (name, args) => unwrap(await service.rpc(name, args)),
    assets: {
      download: async (path) => { const { data, error } = await assets.download(path); return error || !data ? null : new Uint8Array(await data.arrayBuffer()); },
    },
    storage: {
      download: async (path) => { const { data, error } = await bucket.download(path); return error || !data ? null : new Uint8Array(await data.arrayBuffer()); },
      upload: async (path, bytes) => !(await bucket.upload(path, bytes, { contentType: "application/pdf", upsert: false })).error,
      remove: async (paths) => { await bucket.remove(paths); },
      signedUrl: async (path, seconds, name) => { const { data, error } = await bucket.createSignedUrl(path, seconds, name ? { download: name } : undefined); return error || !data ? null : data.signedUrl; },
    },
    letterhead: () => loadLetterhead(service),
    mail,
    abr: { guid: Deno.env.get("EF_ABR_GUID") || Deno.env.get("ABR_GUID") || "" },
    // Fallback only: the Google Maps key saved in Integrations > Connections (Vault) wins (core.ts placesKey).
    places: { key: Deno.env.get("EF_GOOGLE_MAPS_KEY") || "" },
    address: (query) => searchAddresses(query, ADDRESS_KEY, addressFetch),
    isServiceCaller: isServiceCaller(authorization, serviceKey, env.SUPABASE_URL),
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
