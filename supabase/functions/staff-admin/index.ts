// Staff administration (verify_jwt = true): link emails (document / re-upload invites), reject with the optional email, retry
// a failed email, drain the HR outbox. hr_admin_* run with the caller's JWT (hr.require_admin decides); the service role is used
// only to log email outcomes and to send queued mail. Rules and order live in core.ts.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { linkUrl, readHrMailConfig, selectHrMailProvider, sendLinkEmail } from "../_shared/hr-mail.ts";
import { HR_MAIL_ENV, drainHrOutbox } from "../_shared/hr-mail-drain.ts";
import { handleAdmin } from "./core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const env: Record<string, string> = { SUPABASE_URL };
for (const name of HR_MAIL_ENV) env[name] = Deno.env.get(name) ?? "";
const config = readHrMailConfig(env);
const provider = selectHrMailProvider(env);

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY, ANON_KEY);
  if (configuration) return json(configuration, 503);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Authentication required." }, 401);
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ error: "The request could not be read." }, 400); }

  const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const asError = (e: { code?: string; message?: string } | null) => (e ? { code: e.code, message: e.message } : null);

  const result = await handleAdmin(body, {
    adminRpc: async (name, args) => { const { data, error } = await caller.rpc(name, args); return { data, error: asError(error) }; },
    serviceRpc: async (name, args) => { const { data, error } = await service.rpc(name, args); return { data, error: asError(error) }; },
    newLink: async () => {
      const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
      return { token, hash: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))) };
    },
    config,
    sendLink: (mail) => sendLinkEmail(provider, config, mail),
    linkUrl: (purpose, token) => linkUrl(config.siteUrl!, purpose, token),
    drain: () => drainHrOutbox(service, env),
  });
  return json(result.body, result.status);
});
