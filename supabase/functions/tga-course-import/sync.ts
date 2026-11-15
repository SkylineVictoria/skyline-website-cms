import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { type HoursLookup, ImportError, qualificationDetails } from "./tga.ts";

const headers = {
  "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const blank = (value: unknown) => value === null || value === undefined || String(value).trim() === "";
const HOURS_SOURCE = "NCVER nationally agreed nominal hours (2026)";

/**
 * Re-reads Training.gov.au and NCVER hours for an existing course and fills what is missing (CRICOS: cricos-lookup).
 * Register data columns (tga_*) are refreshed; fields people edit (code, name,
 * career, description, entry requirements, training package, link) are only filled when empty. Units are never
 * removed; a course without units gets the core units; existing units get missing hours, groups, prerequisites and usage. Nothing is ever erased.
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
    .select("id,code,nominal_hours,has_prerequisites,usage_recommendation,elective_groups").eq("course_id", courseId);
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
  // A course with no units yet (e.g. created from CRICOS) gets the release's core units; electives stay a choice.
  let coreAdded = 0;
  if (!(units ?? []).length && review.core.length) {
    const { error: insertError } = await db.from("cms_course_units").insert(review.core.map((unit, index) => ({
      id: "unit-" + crypto.randomUUID().replaceAll("-", ""), course_id: courseId, code: unit.code, name: unit.name,
      category: "Core", unit_type: "core", sort: index + 1, nominal_hours: unit.nominalHours,
      nominal_hours_source: unit.nominalHours === null ? null : HOURS_SOURCE, has_prerequisites: unit.hasPrerequisites,
      usage_recommendation: unit.usageRecommendation || null,
    })));
    if (insertError) return reply({ error: "The core units could not be added." }, 500);
    coreAdded = review.core.length;
  }
  for (let index = 0; index < changes.length; index += 20) {
    const results = await Promise.all(changes.slice(index, index + 20).map(change =>
      db.from("cms_course_units").update(change.patch).eq("id", change.id).eq("course_id", courseId)));
    if (results.some((result: { error: unknown }) => result.error)) return reply({ error: "Some units could not be updated." }, 500);
  }

  return reply({
    courseId, code, filled, coreAdded, unitsUpdated: changes.length, hoursFilled, unitsMatched: (units ?? []).filter((unit: { code: unknown }) =>
      official.has(String(unit.code ?? "").trim().toUpperCase())).length, unitCount: (units ?? []).length,
    cricos: review.cricos ? { registered: review.cricos.registered, providerCode: review.cricos.providerCode,
      courseCode: review.cricos.registered ? review.cricos.courseCode : null } : null,
    failedSources: review.sources.filter(source => !source.ok).map(source => `${source.name}: ${source.detail}`),
  });
}
