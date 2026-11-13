// =====================================================================
// address-search — Australian address suggestions for the portal forms (Geoscape Verify Autocomplete).
// The provider key is the function secret EF_ADDRESS_SEARCH_GEOSCAPE_KEY and never reaches the browser.
// Agents and administrators only (verified JWT, then the database's own view of the caller). Queries and results are never
// logged or stored. A provider fault or exhausted quota answers "unavailable"; the form then falls back to plain typing.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { MIN_QUERY, searchAddresses, takeSlot } from "../_shared/validation/address.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROVIDER_KEY = Deno.env.get("EF_ADDRESS_SEARCH_GEOSCAPE_KEY") ?? "";

const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY, ANON_KEY);
  if (configuration) return json(configuration, 503);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Authentication required." }, 401);

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: callerData, error: callerError } = await anon.auth.getUser(token);
  if (callerError || !callerData.user) return json({ ok: false, error: "Not authenticated." }, 401);

  // Only people who work in the portal or the CMS: the database decides, from the verified subject.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: context, error: contextError } = await admin.rpc("portal_actor_context", { p_actor: callerData.user.id });
  if (contextError) return json({ ok: false, error: "Unable to verify your access." }, 503);
  if (context?.slit !== true && !context?.role) return json({ ok: false, error: "Agent or administrator access required." }, 403);

  if (!takeSlot(hits, callerData.user.id, Date.now(), RATE_LIMIT, RATE_WINDOW_MS)) return json({ ok: false, error: "Too many address searches. Please wait a moment." }, 429);

  const body = (await req.json().catch(() => ({}))) as { q?: unknown };
  const q = typeof body.q === "string" ? body.q.trim() : "";
  if (q.length < MIN_QUERY) return json({ ok: true, suggestions: [] });

  const result = await searchAddresses(q, PROVIDER_KEY);
  if (result.kind === "unavailable") {
    // Server-side only: a reason code, never the key, the query or any result.
    console.warn(`address-search unavailable: ${result.reason}`);
    return json({ ok: false, unavailable: true }, 503);
  }
  return json({ ok: true, suggestions: result.suggestions, attribution: result.attribution });
});
