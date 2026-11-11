// =====================================================================
// holiday-sync — Victorian public holidays from the official sources into hr.public_holidays (owner's brief 2026-11-11).
//
// Called by the weekly pg_cron job (hr-holiday-sync -> public.hr_holiday_sync_dispatch -> pg_net, Bearer = the service-role key from
// Vault) and by "Sync now" on Staff > Public holidays (an administrator's JWT). verify_jwt = true: the gateway checks the token, the
// database decides (hr_holiday_sync_begin: service role or hr.require_admin). The function fetches the current and the next year
// (data.gov.au, then Nager.Date), and hands the lists to hr_holiday_sync_finish, which upserts, never deletes, and records the run.
// Nothing personal leaves Skyline: the two sources receive only the year and the state. A failed fetch is recorded on the run.
// LAB ONLY: EF_HOLIDAY_SYNC_DATA_GOV_URL / EF_HOLIDAY_SYNC_NAGER_URL point the fetches at mocks, and only when SUPABASE_URL is local.
// =====================================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serviceRoleStatus } from "../_shared/service-role.ts";
import { isLocalSupabaseUrl } from "../_shared/captcha.ts";
import { DATA_GOV_API, NAGER_API, runSync, type SyncResult } from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const local = isLocalSupabaseUrl(SUPABASE_URL);
const override = (name: string, fallback: string) => { const v = (Deno.env.get(name) ?? "").trim().replace(/\/+$/, ""); return local && v ? v : fallback; };
const APIS = { dataGov: override("EF_HOLIDAY_SYNC_DATA_GOV_URL", DATA_GOV_API), nager: override("EF_HOLIDAY_SYNC_NAGER_URL", NAGER_API) };
const FETCH_TIMEOUT_MS = 15000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/** GET as JSON with a timeout; the error message names the host and status, never the body. */
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  try { return await res.json(); } catch { throw new Error(`${new URL(url).host} did not answer with JSON`); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !ANON_KEY) return json({ error: "The function is not configured." }, 503);
  const authorization = req.headers.get("Authorization") ?? "";
  const jwt = /^Bearer (.+)$/i.exec(authorization.trim())?.[1] ?? "";
  if (!jwt) return json({ error: "Sign in to sync the holidays." }, 401);
  const isWorker = serviceRoleStatus(authorization, SUPABASE_URL) === 200;
  const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } });

  const begin = await caller.rpc("hr_holiday_sync_begin");
  if (begin.error) {
    const code = begin.error.code ?? "";
    return json({ error: begin.error.message || "The sync could not start." }, code === "42501" ? 403 : code === "55P03" ? 409 : 400);
  }
  const run = begin.data as { id: number; years: number[]; state: string };
  let result: SyncResult;
  try {
    result = await runSync(run.years, run.state || "VIC", fetchJson, APIS);
  } catch (e) {
    result = { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 2000), years: {}, detail: { dataGov: APIS.dataGov, nager: APIS.nager, skipped: [] } };
  }
  const finish = await caller.rpc("hr_holiday_sync_finish", { p_run: run.id, p_result: result });
  if (finish.error) return json({ error: finish.error.message || "The sync could not be recorded.", runId: run.id }, 500);
  return json({ run: finish.data, trigger: isWorker ? "cron" : "manual" });
});
