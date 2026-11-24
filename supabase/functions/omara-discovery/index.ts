import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { ActionError, handle, type Ports } from "./core.ts";

// OMARA migration agent discovery (2026-11-24). Administrators only (cms_is_admin with the caller's JWT; JWT verification stays on).
// Actions: status, discover, import_urls, link, refresh, check. Search keys come from Integrations › Connections (Vault, service role);
// nothing is written to public.agents (registered migration agents are not SLIT education agents).
const url = Deno.env.get("SUPABASE_URL") ?? "";
const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);
  const token = request.headers.get("Authorization");
  if (!token?.startsWith("Bearer ")) return json({ message: "Sign in as an administrator." }, 401);
  if (!url || !anon || !serviceKey) return json({ message: "Agent discovery is unavailable." }, 503);
  const tenant = request.headers.get("x-tenant-domain");
  const caller = createClient(url, anon, { global: { headers: { Authorization: token, ...(tenant ? { "x-tenant-domain": tenant } : {}) } }, auth: { persistSession: false } });
  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ message: "Send a JSON body with an action." }, 400);

  const ports: Ports = {
    isAdmin: async () => (await caller.rpc("cms_is_admin", {})).data === true,
    callerId: async () => (await caller.auth.getUser()).data.user?.id ?? null,
    rpc: (fn, args) => caller.rpc(fn, args),
    service: async (fn, args) => {
      const { data, error } = await service.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    },
    agentsByContact: async (ids, since) => {
      let q = service.from("omara_agents").select("*").in("contact_id", ids);
      if (since) q = q.gte("verified_at", since);
      const { data } = await q;
      return (data ?? []) as Record<string, unknown>[];
    },
    agentByMarn: async (marn) => (await service.from("omara_agents").select("*").eq("marn", marn).maybeSingle()).data as Record<string, unknown> | null,
    agencyFacts: async (id) => {
      const { data } = await service.from("agencies").select("name, registration_number, abr_confirmed, abr_details, profile").eq("id", id).maybeSingle();
      if (!data) return null;
      const c = (data.abr_confirmed ?? {}) as Record<string, unknown>, d = (data.abr_details ?? {}) as Record<string, unknown>, p = (data.profile ?? {}) as Record<string, unknown>;
      const names = [s(data.name), s(c.tradingName), s(c.legalEntity), s(d.entityName), ...(Array.isArray(d.businessNames) ? d.businessNames.map(s) : [])].filter(Boolean);
      return { names: [...new Set(names)], website: s(p.agent_website) || null, postcode: s(p.office_postcode) || s(c.postcode) || null,
        state: s(p.office_state) || s(c.state) || null, abn: s(data.registration_number).replace(/\D/g, "") || null };
    },
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
  try {
    return json(await handle(body as Record<string, unknown>, ports));
  } catch (e) {
    if (e instanceof ActionError) return json({ message: e.message }, e.status);
    console.error("omara-discovery unexpected error", e instanceof Error ? e.name : "unknown");
    return json({ message: "Agent discovery failed. Try again." }, 500);
  }
});
