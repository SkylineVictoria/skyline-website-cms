import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { type HoursLookup, ImportError, qualificationDetails } from "./tga.ts";
import { unitDetails } from "./units.ts";

const headers = {
  "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const blank = (value: unknown) => value === null || value === undefined || String(value).trim() === "";
const HOURS_SOURCE = "NCVER nationally agreed nominal hours (2026)";

/**
 * Re-reads Training.gov.au and NCVER hours for an existing course and fills what is missing (CRICOS: cricos-lookup).
 * Register data columns (tga_*) are refreshed; fields people edit (code, name,
 * career, description, entry requirements, training package, link) are only filled when empty. Missing units of the
 * release are added (core active, electives inactive); active units get their training.gov.au content. Nothing is erased.
 */
export async function syncCourse(db: SupabaseClient, tenantId: string | null, courseId: string,
  providerCode: string | null, hoursLookup: HoursLookup) {
  let query = db.from("cms_courses")
    .select("id,code,career,full_description,entry_requirements,training_package,tga_url").eq("id", courseId);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  const { data: course, error: courseError } = await query.maybeSingle();
  if (courseError) return reply({ error: "The course could not be read." }, 500);
  if (!course) return reply({ error: "Course not found." }, 404);
  const code = String(course.code ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{4,19}$/.test(code)) {
    throw new ImportError("This course has no qualification code that Training.gov.au can look up.", 422);
  }

  const review = await qualificationDetails(code, providerCode, hoursLookup);
  const g = review.government;
  const patch: Record<string, unknown> = {};
  const filled: string[] = [];
  const set = (column: string, value: unknown) => {
    if (blank(value) || (Array.isArray(value) && !value.length)) return;
    patch[column] = value;
  };
  const fill = (column: string, label: string, value: unknown) => {
    if (blank(value) || !blank((course as Record<string, unknown>)[column])) return;
    patch[column] = value;
    filled.push(label);
  };

  set("tga_training_package_code", review.packageCode);
  set("tga_national_status", review.status);
  set("tga_release_number", review.releaseNumber);
  set("tga_release_date", review.releaseDate ? review.releaseDate.slice(0, 10) : null);
  set("tga_packaging_rules", review.packagingRules);
  set("tga_anzsco_code", g.anzscoCode); set("tga_anzsco_title", g.anzscoTitle);
  set("tga_field_of_education_code", g.fieldOfEducationCode); set("tga_field_of_education", g.fieldOfEducation);
  set("tga_qualification_level", g.qualificationLevel); set("tga_developer", g.developer); set("tga_developer_url", g.developerUrl);
  set("tga_usage_recommendation", g.usageRecommendation); set("tga_supersedes_code", g.supersedesCode);
  set("tga_supersedes_title", g.supersedesTitle);
  if (typeof g.supersedesEquivalent === "boolean") patch.tga_supersedes_equivalent = g.supersedesEquivalent;
  set("tga_occupations", g.occupations); set("tga_industry_sectors", g.industrySectors);
  set("tga_foundation_skills", g.foundationSkills); set("tga_documents", g.documents); set("tga_companion_url", g.companionUrl);
  patch.tga_imported_at = new Date().toISOString();

  fill("full_description", "description", review.description);
  fill("entry_requirements", "entry requirements", review.entryRequirements);
  fill("training_package", "training package", review.packageName);
  fill("tga_url", "training.gov.au link", `https://training.gov.au/training/details/${code}`);
  fill("career", "career outcomes", g.occupations.join(", "));

  // CRICOS: only reported here (registered under the site's provider code or not); the CMS fetches and saves the
  // full register entry through cricos-lookup and rto_course_cricos_save.
  patch.updated_at = new Date().toISOString();
  let update = db.from("cms_courses").update(patch).eq("id", courseId);
  update = tenantId ? update.eq("tenant_id", tenantId) : update.is("tenant_id", null);
  const { error: updateError } = await update;
  if (updateError) return reply({ error: "The course could not be updated." }, 500);

  // Existing units: fill hours and groups, refresh prerequisites and usage from the register.
  const { data: units } = await db.from("cms_course_units")
    .select("id,code,sort,nominal_hours,has_prerequisites,usage_recommendation,elective_groups").eq("course_id", courseId);
  const official = new Map([...review.core, ...review.electives].map(unit => [unit.code.toUpperCase(), unit]));
  const changes: { id: string; patch: Record<string, unknown> }[] = [];
  let hoursFilled = 0;
  for (const unit of units ?? []) {
    const source = official.get(String(unit.code ?? "").trim().toUpperCase());
    if (!source) continue;
    const next: Record<string, unknown> = {};
    if (unit.nominal_hours === null && source.nominalHours !== null) {
      next.nominal_hours = source.nominalHours; next.nominal_hours_source = HOURS_SOURCE; hoursFilled++;
    }
    if (source.hasPrerequisites !== null && unit.has_prerequisites !== source.hasPrerequisites) next.has_prerequisites = source.hasPrerequisites;
    if (source.usageRecommendation && unit.usage_recommendation !== source.usageRecommendation) next.usage_recommendation = source.usageRecommendation;
    if (blank(unit.elective_groups) && source.groups.length) next.elective_groups = source.groups.join(", ");
    if (Object.keys(next).length) changes.push({ id: unit.id, patch: next });
  }
  for (let index = 0; index < changes.length; index += 20) {
    const results = await Promise.all(changes.slice(index, index + 20).map(change =>
      db.from("cms_course_units").update(change.patch).eq("id", change.id).eq("course_id", courseId)));
    if (results.some((result: { error: unknown }) => result.error)) return reply({ error: "Some units could not be updated." }, 500);
  }

  // Every unit of the release is on the course: missing core units active, missing electives inactive (switch on the
  // electives you deliver). Existing units, their order and their active state are never changed.
  const have = new Set((units ?? []).map((unit: { code: unknown }) => String(unit.code ?? "").trim().toUpperCase()));
  let sort = Math.max(0, ...(units ?? []).map((unit: { sort?: unknown }) => Number(unit.sort) || 0));
  const missing = [...review.core.map(unit => ({ unit, core: true })), ...review.electives.map(unit => ({ unit, core: false }))]
    .filter(item => !have.has(item.unit.code.toUpperCase()));
  if (missing.length) {
    const { error: insertError } = await db.from("cms_course_units").insert(missing.map(({ unit, core }) => ({
      id: "unit-" + crypto.randomUUID().replaceAll("-", ""), course_id: courseId, code: unit.code, name: unit.name,
      category: core ? "Core" : "Elective", unit_type: core ? "core" : "elective", is_active: core, sort: ++sort,
      nominal_hours: unit.nominalHours, nominal_hours_source: unit.nominalHours === null ? null : HOURS_SOURCE,
      has_prerequisites: unit.hasPrerequisites, usage_recommendation: unit.usageRecommendation || null,
      elective_groups: unit.groups.length ? unit.groups.join(", ") : null,
    })));
    if (insertError) return reply({ error: "The missing units could not be added." }, 500);
  }
  const coreAdded = missing.filter(item => item.core).length;
  const electivesAdded = missing.length - coreAdded;

  // Active units get their training.gov.au details; elements and evidence only where the unit has none yet.
  const { data: activeUnits } = await db.from("cms_course_units").select("id,code").eq("course_id", courseId).eq("is_active", true).limit(80);
  const active = (activeUnits ?? []) as { id: string; code: string }[];
  const { data: existingElements } = active.length
    ? await db.from("asm_unit_elements").select("unit_id").in("unit_id", active.map(unit => unit.id)) : { data: [] };
  const withElements = new Set(((existingElements ?? []) as { unit_id: string }[]).map(row => row.unit_id));
  let detailsSynced = 0, elementsAdded = 0, detailsFailed = 0, columnsMissing = false;
  const queue = [...active];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let unit = queue.shift(); unit; unit = queue.shift()) {
      const details = await unitDetails(unit.code.trim().toUpperCase()).catch(() => null);
      if (!details) { detailsFailed++; continue; }
      if (!columnsMissing) {
        const { error } = await db.from("cms_course_units").update({
          tga_release_number: details.releaseNumber, tga_release_date: details.releaseDate, tga_application: details.application,
          tga_unit_sector: details.sector, tga_prerequisites: details.prerequisites, tga_supersedes_code: details.supersedesCode,
          tga_supersedes_title: details.supersedesTitle, tga_supersedes_equivalent: details.supersedesEquivalent,
          tga_developer: details.developer, tga_companion_url: details.companionUrl, tga_synced_at: new Date().toISOString(),
          ...(details.usage ? { usage_recommendation: details.usage } : {}),
        }).eq("id", unit.id);
        // Before migration 20261115140000 the detail columns do not exist; elements are still saved.
        if (error && (error.code === "42703" || error.code === "PGRST204")) columnsMissing = true;
        else if (!error) detailsSynced++;
      }
      if (withElements.has(unit.id) || !details.elements.length) continue;
      const ids = new Map<string, string>();
      const top = details.elements.filter(row => row.kind !== "performance_criterion").map((row, index) => {
        const id = crypto.randomUUID();
        if (row.kind === "element") ids.set(row.code, id);
        return { id, unit_id: unit.id, kind: row.kind, code: row.code.slice(0, 40), text: row.text, sort: index + 1 };
      });
      const criteria = details.elements.filter(row => row.kind === "performance_criterion").map((row, index) => ({
        unit_id: unit.id, kind: row.kind, code: row.code.slice(0, 40), text: row.text, sort: index + 1, parent_id: ids.get(row.parent ?? "") ?? null,
      }));
      const { error: topError } = await db.from("asm_unit_elements").insert(top);
      const { error: criteriaError } = topError || !criteria.length ? { error: topError } : await db.from("asm_unit_elements").insert(criteria);
      if (!topError && !criteriaError) elementsAdded++;
    }
  }));

  return reply({
    courseId, code, filled, coreAdded, electivesAdded, detailsSynced, detailsFailed, elementsAdded, columnsMissing, unitsUpdated: changes.length, hoursFilled, unitsMatched: (units ?? []).filter((unit: { code: unknown }) =>
      official.has(String(unit.code ?? "").trim().toUpperCase())).length, unitCount: (units ?? []).length,
    cricos: review.cricos ? { registered: review.cricos.registered, providerCode: review.cricos.providerCode,
      courseCode: review.cricos.registered ? review.cricos.courseCode : null } : null,
    failedSources: review.sources.filter(source => !source.ok).map(source => `${source.name}: ${source.detail}`),
  });
}
