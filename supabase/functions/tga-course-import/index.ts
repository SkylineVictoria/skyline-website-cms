import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { coreUnits, ImportError, qualificationDetails, rtoScope, searchQualifications, selectedUnits } from "./tga.ts";
import { addUnits, syncCourse } from "./sync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return json({ error: "The import service is missing its Supabase configuration." }, 503);
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "Sign in to the CMS first." }, 401);

  const auth = { persistSession: false, autoRefreshToken: false };
  const headers: Record<string, string> = { Authorization: authorization };
  const domain = req.headers.get("x-tenant-domain");
  if (domain) headers["x-tenant-domain"] = domain;
  const caller = createClient(url, anon, { auth, global: { headers } });

  let stage = "authorize";
  try {
    const { data: { user }, error: authError } = await caller.auth.getUser(authorization.slice(7));
    if (authError || !user) return json({ error: "Your session has expired. Sign in again." }, 401);
    const { data: scope, error: scopeError } = await caller.rpc("rto_tga_import_scope");
    if (scopeError?.code === "42501") return json({ error: "RTO Manager access is required for this site." }, 403);
    if (scopeError || !scope) return json({ error: "Could not verify course import access." }, 503);

    const input: unknown = await req.json().catch(() => null);
    if (!input || typeof input !== "object" || !("action" in input)) {
      return json({ error: "Invalid import request." }, 400);
    }
    if (input.action === "search") {
      const query = "query" in input && typeof input.query === "string" ? input.query.trim() : "";
      if (query.length < 2 || query.length > 120) return json({ error: "Enter a qualification code or name between 2 and 120 characters." }, 400);
      stage = "search";
      return json(await searchQualifications(query));
    }
    const db = createClient(url, service, { auth });
    // The tenant's CRICOS provider code (Settings), else the site-wide one, to look up its CRICOS registration.
    const { data: settings } = await db.from("cms_settings").select("tenant_id,cricos,rto")
      .or(scope.tenantId ? `tenant_id.eq.${scope.tenantId},tenant_id.is.null` : "tenant_id.is.null");
    const rows = (settings ?? []) as { tenant_id: string | null; cricos: string | null; rto: string | null }[];
    const siteSettings = rows.find(row => row.tenant_id === scope.tenantId) ?? rows.find(row => row.tenant_id === null);
    const providerCode = siteSettings?.cricos?.trim().toUpperCase() || null;
    const hoursLookup = async (codes: string[]) => {
      const { data, error } = await db.from("tga_nominal_hours").select("unit_code,hours").in("unit_code", [...new Set(codes)]);
      if (error) throw error;
      return new Map((data ?? []).map(row => [row.unit_code as string, row.hours as number]));
    };
    if (input.action === "scope") {
      // The qualifications on the site's RTO scope (Settings > RTO code), for the bulk Training.gov.au sync.
      stage = "scope";
      return json(await rtoScope(siteSettings?.rto ?? ""));
    }
    if (input.action === "create_core") {
      // A draft course for one qualification with its core units; electives are added later on the course.
      if (!("code" in input) || typeof input.code !== "string" || !/^[A-Z]{3}\d{5}$/.test(input.code.trim().toUpperCase())) {
        return json({ error: "Choose a qualification code." }, 400);
      }
      stage = "create_core";
      const review = await qualificationDetails(input.code.trim().toUpperCase(), providerCode, hoursLookup);
      const units = coreUnits(review);
      const { data: courseId, error } = await db.rpc("rto_tga_import_save", {
        p_actor: user.id, p_tenant: scope.tenantId, p_course: {
          code: review.code, name: review.name, aqf: review.aqf, packageName: review.packageName,
          description: review.description, entryRequirements: review.entryRequirements,
          packageCode: review.packageCode, status: review.status, releaseNumber: review.releaseNumber,
          releaseDate: review.releaseDate, packagingRules: review.packagingRules,
          government: review.government, cricos: review.cricos,
          specialisationCode: null, specialisationTitle: null,
          coreUnits: units.length, electiveUnits: 0,
        }, p_units: units,
      });
      if (error?.code === "23505") return json({ error: "A course with this qualification code already exists." }, 409);
      if (error?.code === "42501") return json({ error: "RTO Manager access is required for this site." }, 403);
      if (error || !courseId) return json({ error: "The draft course could not be saved." }, 500);
      return json({ courseId, coreUnits: units.length, electives: review.electives.length }, 201);
    }
    if (input.action === "sync") {
      if (!("courseId" in input) || typeof input.courseId !== "string" || !input.courseId) return json({ error: "Choose a course to sync." }, 400);
      stage = "sync";
      return await syncCourse(db, scope.tenantId ?? null, input.courseId, providerCode, hoursLookup);
    }
    if (input.action === "add_units") {
      if (!("courseId" in input) || typeof input.courseId !== "string" || !input.courseId || !("codes" in input) || !Array.isArray(input.codes)
          || !input.codes.length || input.codes.length > 250 || input.codes.some(code => typeof code !== "string")) {
        return json({ error: "Choose the units to add." }, 400);
      }
      stage = "add_units";
      return await addUnits(db, scope.tenantId ?? null, input.courseId, input.codes as string[], hoursLookup);
    }
    if ((input.action !== "details" && input.action !== "save") || !("code" in input) || typeof input.code !== "string") {
      return json({ error: "Invalid qualification request." }, 400);
    }
    if (input.action === "save" && (!("revision" in input) || typeof input.revision !== "string" ||
        !("electives" in input) || !Array.isArray(input.electives) || input.electives.length > 200 ||
        input.electives.some(code => typeof code !== "string"))) {
      return json({ error: "The approved qualification review is required." }, 400);
    }
    stage = "review";
    const review = await qualificationDetails(input.code.trim().toUpperCase(), providerCode, hoursLookup);
    if (input.action === "details") return json(review);
    if (!("revision" in input) || input.revision !== review.revision) {
      return json({ error: "The government release details changed. Reopen the qualification to review them again." }, 409);
    }
    stage = "save";
    const { units, specialisation } = selectedUnits(review, "electives" in input ? input.electives : null,
      "attested" in input && input.attested, "specialisation" in input ? input.specialisation : null);
    const { data: courseId, error } = await db.rpc("rto_tga_import_save", {
      p_actor: user.id, p_tenant: scope.tenantId, p_course: {
        code: review.code, name: review.name, aqf: review.aqf, packageName: review.packageName,
        description: review.description, entryRequirements: review.entryRequirements,
        packageCode: review.packageCode, status: review.status, releaseNumber: review.releaseNumber,
        releaseDate: review.releaseDate, packagingRules: review.packagingRules,
        government: review.government, cricos: review.cricos,
        specialisationCode: specialisation?.code ?? null, specialisationTitle: specialisation?.title ?? null,
        coreUnits: units.filter(unit => unit.type === "core").length, electiveUnits: units.filter(unit => unit.type === "elective").length,
      }, p_units: units,
    });
    if (error?.code === "23505") return json({ error: "A course with this qualification code already exists, or its course URL is already in use." }, 409);
    if (error?.code === "42501") return json({ error: "RTO Manager access is required for this site." }, 403);
    if (error || !courseId) return json({ error: "The draft course could not be saved." }, 500);
    return json({ courseId }, 201);
  } catch (error) {
    if (error instanceof ImportError) {
      if (error.status >= 500) console.warn("tga-course-import", stage, error.message);
      return json({ error: error.message }, error.status);
    }
    const location = error instanceof Error
      ? error.stack?.match(/(?:tga\.ts|index\.ts):\d+:\d+/)?.[0]
      : undefined;
    console.error("tga-course-import unexpected error", stage, location ?? "unknown location");
    return json({ error: "The course import could not be completed." }, 502);
  }
});
