import { clean, CODE_PATTERN, mapCricos, RESOURCES, type RawCricos, type Row } from "./cricos.ts";

// Reads the public CRICOS register for one course code. Never writes to the database; the CMS saves the reviewed
// values through rto_course_cricos_save. JWT verification stays on (signed-in CMS users only).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const API = "https://data.gov.au/data/api/3/action/datastore_search";
const HOUR = 3_600_000;
const cache = new Map<string, { expires: number; body: unknown }>();

function json(body: unknown, status = 200, cached = false) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json",
      "Cache-Control": status === 200 ? "private, max-age=3600" : "no-store", "X-Cricos-Cache": cached ? "hit" : "miss" },
  });
}

class RegisterError extends Error {}
async function search(resource: string, filters: Record<string, string>): Promise<Row[]> {
  const url = `${API}?resource_id=${resource}&limit=100&filters=${encodeURIComponent(JSON.stringify(filters))}`;
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } });
  } catch { throw new RegisterError("data.gov.au did not respond."); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new RegisterError(`data.gov.au returned HTTP ${response.status}.`); }
  const body = await response.json().catch(() => null) as { success?: boolean; result?: { records?: unknown } } | null;
  if (!body?.success || !Array.isArray(body.result?.records)) throw new RegisterError("data.gov.au returned an unexpected response.");
  return clean(body.result.records.filter((row): row is Row => !!row && typeof row === "object"));
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const input = await req.json().catch(() => null) as { cricos_code?: unknown } | null;
  const code = typeof input?.cricos_code === "string" ? input.cricos_code.trim().toUpperCase() : "";
  if (!CODE_PATTERN.test(code)) return json({ error: "A CRICOS course code is six digits and a letter, e.g. 112739C." }, 400);

  const hit = cache.get(code);
  if (hit && hit.expires > Date.now()) return json(hit.body, 200, true);
  try {
    const courses = await search(RESOURCES.courses, { "CRICOS Course Code": code });
    if (!courses.length) return json({ error: `${code} was not found on the CRICOS register.` }, 404);
    const provider = String(courses[0]["CRICOS Provider Code"] ?? "").trim();
    const [courseLocations, institutions, locations] = await Promise.all([
      search(RESOURCES.courseLocations, { "CRICOS Course Code": code }),
      provider ? search(RESOURCES.institutions, { "CRICOS Provider Code": provider }) : Promise.resolve([]),
      provider ? search(RESOURCES.locations, { "CRICOS Provider Code": provider }) : Promise.resolve([]),
    ]);
    const raw: RawCricos = { courses, courseLocations, institutions, locations };
    const mapped = mapCricos(raw);
    const fetchedAt = new Date().toISOString();
    // The snapshot keeps the raw register rows and the mapped values, so the CMS can reset a field without re-mapping.
    const body = { ...mapped, fetched_at: fetchedAt, snapshot: { fetched_at: fetchedAt, raw, fields: mapped.fields, locations: mapped.locations } };
    cache.set(code, { expires: Date.now() + HOUR, body });
    return json(body);
  } catch (error) {
    if (error instanceof RegisterError) return json({ error: `The CRICOS register could not be read: ${error.message}` }, 502);
    console.error("cricos-lookup unexpected error", error instanceof Error ? error.name : "unknown");
    return json({ error: "The CRICOS register could not be read." }, 502);
  }
});
