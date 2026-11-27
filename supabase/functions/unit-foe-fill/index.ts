import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// Fills cms_course_units.field_of_education_code (AVETMISS NAT00060) from training.gov.au.
// The unit's classification scheme 03 = "ASCED Module/Unit of Competency Field of Education Identifier".
// Called by the database when units are added (pg_net), by an hourly cron sweep, or by CMS staff.

const API = "https://training.gov.au/api/training/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** The JWT's role claim. The gateway (verify_jwt) has already checked the signature. */
function jwtRole(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

async function fieldOfEducation(code: string): Promise<string | null | undefined> {
  // undefined = could not reach training.gov.au (retry later); null = no code published
  try {
    const response = await fetch(`${API}${encodeURIComponent(code)}/classification`, {
      redirect: "error", signal: AbortSignal.timeout(12_000), headers: { Accept: "application/json" },
    });
    if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return undefined; }
    const rows = await response.json();
    if (!Array.isArray(rows)) return undefined;
    const pick = rows.filter((row) => row && row.schemeCode === "03" && /^\d{6}$/.test(String(row.valueCode ?? "")));
    const best = pick.find((row) => row.isPrimary) ?? pick[0];
    return best ? String(best.valueCode) : null;
  } catch {
    return undefined;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return json({ error: "Missing Supabase configuration." }, 503);
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const auth = { persistSession: false, autoRefreshToken: false };

  // The database/cron call with a service-role key; otherwise the caller must be signed-in CMS staff.
  if (token !== service && jwtRole(token) !== "service_role") {
    const caller = createClient(url, anon, { auth, global: { headers: { Authorization: authorization } } });
    const { data: staff } = await caller.rpc("cms_is_staff");
    if (staff !== true) return json({ error: "CMS staff access is required." }, 403);
  }

  const input = await req.json().catch(() => ({})) as { unitIds?: unknown };
  const ids = Array.isArray(input.unitIds) ? input.unitIds.filter((id): id is string => typeof id === "string").slice(0, 200) : [];
  const db = createClient(url, service, { auth });
  let query = db.from("cms_course_units").select("id,code").is("field_of_education_code", null).limit(200);
  if (ids.length) query = query.in("id", ids);
  const { data: units, error } = await query;
  if (error) return json({ error: "Units could not be read." }, 500);

  // One lookup per distinct unit code, a few at a time.
  const codes = [...new Set((units ?? []).map((unit) => String(unit.code ?? "").trim().toUpperCase()).filter((code) => /^[A-Z][A-Z0-9]{4,19}$/.test(code)))];
  const found = new Map<string, string | null | undefined>();
  const queue = [...codes];
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let code = queue.shift(); code; code = queue.shift()) found.set(code, await fieldOfEducation(code));
  }));

  let filled = 0;
  const notPublished: string[] = [];
  const unreachable: string[] = [];
  for (const [code, foe] of found) {
    if (foe === undefined) { unreachable.push(code); continue; }
    if (foe === null) { notPublished.push(code); continue; }
    const unitIds = (units ?? []).filter((unit) => String(unit.code ?? "").trim().toUpperCase() === code).map((unit) => unit.id);
    const { error: updateError, count } = await db.from("cms_course_units")
      .update({ field_of_education_code: foe }, { count: "exact" })
      .in("id", unitIds).is("field_of_education_code", null);
    if (!updateError) filled += count ?? 0;
    else unreachable.push(code);
  }
  return json({ checked: codes.length, filled, notPublished, unreachable });
});
