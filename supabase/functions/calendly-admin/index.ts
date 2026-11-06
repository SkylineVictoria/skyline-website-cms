// =====================================================================
// calendly-admin — CMS: "Test connection" for the Calendly booking link.
//
// The Calendly API token is saved from the CMS into cms_integration_secrets (migration 20261106110000) and read here
// with the service role; it never reaches the browser. The caller must be a CMS Admin (Skyline site) or a tenant admin
// (tenant site), checked through cms_integration_can_manage with the caller's own JWT. Calendly is asked who the token
// belongs to (/users/me) and for the account's active event types, so the admin can pick the link shown on the
// Contact page instead of typing it.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CALENDLY_API = "https://api.calendly.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

type EventType = { name: string; schedulingUrl: string; duration: number };

async function calendly(path: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${CALENDLY_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { body = {}; }
  return { status: res.status, body };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY, ANON_KEY);
  if (configuration) return json(configuration, 503);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json({ error: "Missing authorization token." }, 401);

    let parsed: Record<string, unknown> = {};
    try { parsed = (await req.json()) as Record<string, unknown>; } catch { parsed = {}; }
    const action = String(parsed.action ?? "");
    if (action !== "verify") return json({ error: "Unknown action." }, 400);
    const tenantId = typeof parsed.tenantId === "string" && UUID.test(parsed.tenantId) ? parsed.tenantId : null;

    // Authority is decided in the database with the caller's own token.
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: callerData, error: callerErr } = await asCaller.auth.getUser(token);
    if (callerErr || !callerData.user) return json({ error: "Not authenticated." }, 401);
    const { data: allowed, error: allowedErr } = await asCaller.rpc("cms_integration_can_manage", { p_tenant: tenantId });
    if (allowedErr || allowed !== true) return json({ error: "Administrator access required." }, 403);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    let query = admin.from("cms_integration_secrets").select("secret").eq("provider", "calendly");
    query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
    const { data: secretRow, error: secretErr } = await query.maybeSingle();
    if (secretErr) return json({ error: "We could not read the saved token. Please try again." }, 503);
    const apiToken = String(secretRow?.secret ?? "");
    if (!apiToken) return json({ error: "Save a Calendly API token first." }, 409);

    const me = await calendly("/users/me", apiToken);
    if (me.status === 401 || me.status === 403) {
      return json({ error: "Calendly rejected the token. Create a new personal access token in Calendly (Integrations > API & webhooks) and save it again." }, 400);
    }
    if (me.status !== 200) return json({ error: `Calendly did not answer (HTTP ${me.status}). Please try again shortly.` }, 502);
    const resource = (me.body.resource ?? {}) as Record<string, unknown>;
    const name = String(resource.name ?? "");
    const email = String(resource.email ?? "");
    const schedulingUrl = String(resource.scheduling_url ?? "");
    const userUri = String(resource.uri ?? "");

    // Event types are a convenience: the connection is proven by /users/me already.
    let eventTypes: EventType[] = [];
    if (userUri) {
      const list = await calendly(`/event_types?user=${encodeURIComponent(userUri)}&active=true&count=50`, apiToken);
      if (list.status === 200 && Array.isArray(list.body.collection)) {
        eventTypes = (list.body.collection as Record<string, unknown>[])
          .map((item) => ({ name: String(item.name ?? ""), schedulingUrl: String(item.scheduling_url ?? ""), duration: Number(item.duration ?? 0) || 0 }))
          .filter((item) => item.name && /^https:\/\/calendly\.com\//.test(item.schedulingUrl));
      }
    }

    return json({ ok: true, name, email, schedulingUrl, eventTypes });
  } catch (err) {
    const message = err instanceof Error && err.name === "TimeoutError" ? "Calendly took too long to answer. Please try again." : "Unexpected error.";
    return json({ error: message }, 500);
  }
});
