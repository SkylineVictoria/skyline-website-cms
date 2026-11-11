import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const migration=await readFile("supabase/migrations/20261015103645_public_assistant_knowledge.sql","utf8");
const assistant=await readFile("supabase/functions/public-assistant/index.ts","utf8");
const worker=await readFile("supabase/functions/public-assistant-index/index.ts","utf8");
const dispatchMigration=await readFile("supabase/migrations/20261023120000_event_driven_worker_dispatch_and_recovery.sql","utf8");
// Regression contracts: these are source-level mocks of DB/provider boundaries,
// runnable without Postgres, OpenAI or Supabase credentials.
// P09-01: every knowledge, cache, rate-limit and usage call names the resolved tenant.
assert.match(assistant,/"tenant_assistant_rate_limit"[\s\S]*?p_tenant: tenant/); assert.match(assistant,/"tenant_assistant_context", \{ p_tenant: tenant \}/); assert.match(assistant,/"tenant_assistant_search",\s*\{\s*p_tenant: tenant/); assert.match(assistant,/PUBLIC_ASSISTANT_ENABLE_GENERATION/); assert.match(assistant,/public_assistant_take_generation_slot/);
assert.match(assistant,/"tenant_assistant_cache_get", \{\s*p_tenant: tenant/); assert.match(assistant,/"tenant_assistant_cache_put", \{\s*p_tenant: tenant/); assert.match(assistant,/allowGeneration && tenant === null/);
assert.doesNotMatch(assistant,/from\("public_assistant_answer_cache"\)|from\("public_assistant_faqs"\)|from\("cms_courses"\)|public_assistant_search_chunks|public_assistant_content_version/);
assert.equal((assistant.match(/from\("public_assistant_usage_events"\)\.insert/g)??[]).length,(assistant.match(/tenant_id: tenant,/g)??[]).length,"every usage event names the tenant");
assert.match(assistant,/x-tenant-domain/); assert.match(assistant,/if \(typeof resolved !== "string" \|\| !resolved\) return unavailable\(\);/);
assert.doesNotMatch(assistant,/SLIT courses|"Contact SLIT"|"Apply to SLIT"|published SLIT context/);
const { publicTenantSelector, trustedDocumentLocation, isLegacyHostname } = await import("../supabase/functions/_shared/public-tenant.ts");
const sel = (h, o) => publicTenantSelector(h, o);
assert.deepEqual(sel(null, null), { ok: true, hostname: null }, "server-side caller without Origin is the legacy institution");
assert.deepEqual(sel(null, "https://slit.edu.au"), { ok: true, hostname: null }, "legacy host");
assert.deepEqual(sel(null, "https://skyline-website-cms.vercel.app"), { ok: true, hostname: null }, "legacy Vercel host");
assert.deepEqual(sel("b.example.edu.au", "https://b.example.edu.au"), { ok: true, hostname: "b.example.edu.au" }, "tenant host with matching header");
assert.deepEqual(sel("B.Example.edu.au.", null), { ok: true, hostname: "b.example.edu.au" }, "header normalised (no Origin)");
assert.deepEqual(sel(null, "https://b.example.edu.au"), { ok: true, hostname: "b.example.edu.au" }, "tenant Origin without header never falls back to legacy");
assert.deepEqual(sel(null, "http://p9-a.localhost:55430"), { ok: true, hostname: "p9-a.localhost" }, "lab tenant host");
assert.equal(sel("a.example.edu.au", "https://b.example.edu.au").code, "tenant_origin_mismatch", "spoofed header against the browser Origin");
assert.equal(sel("a.example.edu.au", "https://slit.edu.au").status, 403, "spoofed tenant header from the legacy site");
assert.equal(sel("a.example.edu.au", "https://b.example.edu.au").status, 403);
assert.equal(sel("evil..host", null).code, "invalid_tenant_domain"); assert.equal(sel("a/b", null).code, "invalid_tenant_domain"); assert.equal(sel(null, "https://user:pw@b.example.edu.au").code, "invalid_origin"); assert.equal(sel(null, "javascript:alert(1)").code, "invalid_origin");
assert.ok(isLegacyHostname("localhost") && !isLegacyHostname("p9-a.localhost") && !isLegacyHostname("slit.edu.au.evil.com"));
const T = "11111111-1111-4111-8111-111111111111", U = "22222222-2222-4222-8222-222222222222";
assert.ok(trustedDocumentLocation(null, "cms-media", "policies/a.pdf") && trustedDocumentLocation(null, "cms-media", "forms/a.pdf"), "legacy public documents");
assert.ok(trustedDocumentLocation(T, "tenant-public-media", `${T}/policies/a.pdf`), "tenant public documents");
for (const [tenant, bucket, path, why] of [
  [null, "enrollment-documents", "policies/a.pdf", "private student bucket"], [T, "enrollment-documents", `${T}/a.pdf`, "private student bucket (tenant)"],
  [null, "staff-documents", "policies/a.pdf", "private staff bucket"], [null, "signing-documents", "forms/a.pdf", "private signing bucket"],
  [null, "cms-media", "uploads/a.pdf", "legacy path outside forms/policies"], [null, "tenant-public-media", `${T}/a.pdf`, "legacy reading a tenant's media"],
  [T, "cms-media", "policies/a.pdf", "tenant reading the legacy institution's media"], [T, "tenant-public-media", `${U}/a.pdf`, "tenant reading another tenant's media"],
  [T, "tenant-public-media", `${T}/../${U}/a.pdf`, "path traversal"], [T, "tenant-public-media", `${T}/`, "empty name"], [null, "cms-media", "policies/../x.pdf", "legacy traversal"],
]) assert.equal(trustedDocumentLocation(tenant, bucket, path), false, why);
assert.match(worker,/trustedDocumentLocation\(doc\.tenant_id \?\? null, bucket, path\)/); assert.match(worker,/const owned = \(query: any\) => tenant === null \? query\.is\("tenant_id", null\) : query\.eq\("tenant_id", tenant\)/);
assert.equal((worker.match(/await owned\(admin\.from\("cms_/g)??[]).length,4,"course, sections, page and document reads are tenant-filtered");
const scopeMigration=await readFile("supabase/migrations/20261113220000_public_assistant_tenant_scope.sql","utf8");
assert.match(scopeMigration,/bucket_name=''tenant-public-media'' and storage_path like tenant_id::text\|\|''\/%''/); assert.match(scopeMigration,/Unexpected index commit predecessor/); assert.match(scopeMigration,/nulls not distinct/);
const widget=await readFile("src/components/feature/PublicAssistant.tsx","utf8");
assert.match(widget,/const submitQuestion = async/); assert.match(widget,/REQUEST_TIMEOUT_MS = 20_000/); assert.match(widget,/assistant_timeout/); assert.match(widget,/assistant_cancelled/); assert.match(widget,/requestId !== activeRequest\.current/); assert.match(widget,/onSubmit=\{handleSubmit\}/); assert.match(widget,/submitQuestion\(item\)/); assert.doesNotMatch(widget,/public-assistant-index/);
assert.match(migration,/publication_status='staged'/); assert.match(migration,/lease_token/); assert.match(migration,/public_assistant_finish_index_job/); assert.match(migration,/public_assistant_answer_cache/); assert.match(migration,/revoke all on public\.public_assistant_sources/);
assert.match(worker,/public_assistant_finish_index_job/); assert.match(worker,/public_assistant_fail_index_job/); assert.match(worker,/public_assistant_cancel_index_job/); assert.doesNotMatch(worker,/publication_status: "published"/);
assert.match(worker,/assistant_publication_approved/); assert.match(worker,/digitalPdfPages/); assert.match(worker,/ocrPdf/); assert.match(worker,/invalid_pdf_signature/); assert.match(worker,/page_limit_exceeded/); assert.match(worker,/public_assistant_document_pages/);
assert.doesNotMatch(assistant,/enrollment_applications|portal_profiles|student_/); assert.doesNotMatch(worker,/enrollment_applications|portal_profiles|student_/);
// Event dispatch is guarded by indexed queue checks, while the recovery jobs
// retain stable names and do not depend on production-specific job IDs.
assert.match(dispatchMigration,/portal_dispatch_document_extraction_worker/);
assert.match(dispatchMigration,/public_assistant_dispatch_index_worker/);
assert.match(dispatchMigration,/return null;[\s\S]*?net\.http_post/);
assert.match(dispatchMigration,/\*\/5 \* \* \* \*/);
assert.match(dispatchMigration,/\*\/15 \* \* \* \*/);
assert.match(dispatchMigration,/cron\.alter_job\(v_job_id/);
assert.match(dispatchMigration,/public_assistant_enqueue_index_job/);
assert.match(dispatchMigration,/state = 'cancelled'/);
assert.match(dispatchMigration,/public_assistant_course_sections_queue/);
assert.match(dispatchMigration,/assistant_publication_approved/);
assert.doesNotMatch(dispatchMigration,/enrollment_applications|portal_profiles|student_/);
console.log("public-assistant mocked regression contracts: passed (P09-01 tenant selection and document locations, retrieval, authorization boundary, freshness, failure and stale-worker paths)");
