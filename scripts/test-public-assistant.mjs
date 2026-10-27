import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const migration=await readFile("supabase/migrations/20261015103645_public_assistant_knowledge.sql","utf8");
const assistant=await readFile("supabase/functions/public-assistant/index.ts","utf8");
const worker=await readFile("supabase/functions/public-assistant-index/index.ts","utf8");
const dispatchMigration=await readFile("supabase/migrations/20261023120000_event_driven_worker_dispatch_and_recovery.sql","utf8");
// Regression contracts: these are source-level mocks of DB/provider boundaries,
// runnable without Postgres, OpenAI or Supabase credentials.
assert.match(assistant,/public_assistant_take_rate_limit/); assert.match(assistant,/public_assistant_content_version/); assert.match(assistant,/public_assistant_search_chunks/); assert.match(assistant,/PUBLIC_ASSISTANT_ENABLE_GENERATION/); assert.match(assistant,/public_assistant_take_generation_slot/);
const widget=await readFile("src/components/feature/PublicAssistant.tsx","utf8");
assert.match(widget,/const submitQuestion = async/); assert.match(widget,/REQUEST_TIMEOUT_MS = 20_000/); assert.match(widget,/assistant_timeout/); assert.match(widget,/assistant_cancelled/); assert.match(widget,/requestId !== activeRequest\.current/); assert.match(widget,/onSubmit=\{handleSubmit\}/); assert.match(widget,/submitQuestion\(item\)/); assert.doesNotMatch(widget,/public-assistant-index/);
assert.match(migration,/publication_status='staged'/); assert.match(migration,/lease_token/); assert.match(migration,/public_assistant_finish_index_job/); assert.match(migration,/public_assistant_answer_cache/); assert.match(migration,/revoke all on public\.public_assistant_sources/);
assert.match(worker,/public_assistant_finish_index_job/); assert.match(worker,/public_assistant_fail_index_job/); assert.match(worker,/public_assistant_cancel_index_job/); assert.doesNotMatch(worker,/publication_status: "published"/);
assert.match(worker,/assistant_publication_approved/); assert.match(worker,/bucket !== "cms-media"/); assert.match(worker,/digitalPdfPages/); assert.match(worker,/ocrPdf/); assert.match(worker,/invalid_pdf_signature/); assert.match(worker,/page_limit_exceeded/); assert.match(worker,/public_assistant_document_pages/);
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
console.log("public-assistant mocked regression contracts: passed (retrieval, authorization boundary, freshness, failure and stale-worker paths)");
