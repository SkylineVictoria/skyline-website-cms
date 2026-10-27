import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration, requiredConfiguration } from "../_shared/config.ts";
import { EXTRACTION_CATEGORIES, isSupportedDocument } from "../_shared/document-extraction/contract.ts";
import { createDocumentExtractionProvider } from "../_shared/document-extraction/select.ts";
import { runLeasedExtraction, settleFailure, type JobPort } from "../_shared/document-extraction/run.ts";

// Supabase's background-task API is supplied by the Edge runtime, not Deno CLI.
declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

const url = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const openAiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
const model = Deno.env.get("OPENAI_DOCUMENT_MODEL") ?? "";
// Provider settings, read once. EF_DOCUMENT_EXTRACTION_PROVIDER unset keeps the existing OpenAI adapter;
// "azure" selects the Azure adapter, which then needs its own EF_AZURE_DOCUMENT_* configuration.
const providerConfig: Record<string, string> = { OPENAI_API_KEY: openAiKey, OPENAI_DOCUMENT_MODEL: model };
for (const name of ["EF_DOCUMENT_EXTRACTION_PROVIDER", "EF_AZURE_DOCUMENT_ENDPOINT", "EF_AZURE_DOCUMENT_API_KEY", "EF_AZURE_DOCUMENT_MODEL", "EF_AZURE_DOCUMENT_MODEL_MAP", "EF_AZURE_DOCUMENT_API_VERSION"]) providerConfig[name] = Deno.env.get(name) ?? "";
const workerSecret = Deno.env.get("DOCUMENT_EXTRACTION_WORKER_SECRET") ?? "";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-secret, x-tenant-domain", "Content-Type": "application/json" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const MAX_BYTES = 10 * 1024 * 1024;

async function enqueue(request: Request) {
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ ok: false, error: "Authentication required." }, 401);
  const { documentId, reextract = false } = await request.json().catch(() => ({}));
  if (typeof documentId !== "string") return reply({ ok: false, error: "Document ID is required." }, 400);
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}`, ...(request.headers.has("x-tenant-domain") ? { "x-tenant-domain": request.headers.get("x-tenant-domain")! } : {}) } }, auth: { persistSession: false } });
  const { data: doc, error } = await caller.from("enrollment_application_documents").select("id, application_id, category, metadata, enrollment_applications!enrollment_application_documents_application_id_fkey(status)").eq("id", documentId).maybeSingle();
  const app = Array.isArray(doc?.enrollment_applications) ? doc?.enrollment_applications[0] : doc?.enrollment_applications;
  if (error || !doc) return reply({ ok: false, error: "Document not found or not authorised." }, 403);
  if (app?.status !== "draft" && app?.status !== "action_required") return reply({ ok: false, error: "Extraction is only available on editable applications." }, 409);
  if (!(EXTRACTION_CATEGORIES as readonly string[]).includes(String(doc.category))) return reply({ ok: false, error: "This document category is not supported for extraction." }, 422);
  const { data: job, error: jobError } = await caller.rpc("portal_enqueue_document_job", { p_document_id: doc.id, p_reextract: reextract });
  if (jobError || !job) return reply({ ok: false, error: "Document saved, but extraction could not be queued. It can be retried." }, 503);
  // Availability follows the selected provider (OpenAI or Azure), not only the OpenAI variables; manual entry continues either way.
  if (requiredConfiguration({ DOCUMENT_EXTRACTION_WORKER_SECRET: workerSecret }) || createDocumentExtractionProvider(providerConfig).unavailable) {
    return reply({ ok: true, jobId: job.id, state: job.state ?? "queued", extractionAvailable: false, configurationCode: "configuration_unavailable" });
  }
  // The caller is already authorised above. This is an in-process execution,
  // not a browser request carrying the worker secret. The durable queue plus
  // Cron recovery dispatcher handles an interrupted Edge Runtime instance.
  EdgeRuntime.waitUntil(
    processOne(job.tenant_id ? { job: job.id, tenant: job.tenant_id } : undefined)
      .then(() => console.log(JSON.stringify({ event: "document_extraction_immediate_dispatch_finished" })))
      // A lease makes a claimed job recoverable.  Do not swallow an unexpected
      // runtime failure: record a non-sensitive operational event for logs.
      .catch(() => console.error(JSON.stringify({ event: "document_extraction_immediate_dispatch_crashed" }))),
  );
  return reply({ ok: true, jobId: job?.id, state: job?.state ?? "queued" });
}

async function processOne(scope?: { job: string; tenant: string }) {
  // Nothing is claimed unless the worker secret and the selected provider are configured; values are never echoed.
  const workerIssue = requiredConfiguration({ DOCUMENT_EXTRACTION_WORKER_SECRET: workerSecret });
  const providerIssue = createDocumentExtractionProvider(providerConfig).unavailable;
  if (workerIssue || providerIssue) return reply({ error: "Edge Function configuration is unavailable.", code: providerIssue?.code === "configuration_invalid" ? "configuration_invalid" : "configuration_unavailable", variables: [...(workerIssue?.variables ?? []), ...(providerIssue?.variables ?? [])] }, 503);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: claimed, error } = scope ? await admin.rpc("portal_claim_tenant_document_job", { p_job: scope.job, p_tenant: scope.tenant }) : await admin.rpc("portal_claim_document_extraction_job");
  if (error) return reply({ ok: false, error: error.message }, 500);
  const job = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!job) return reply({ ok: true, processed: false });
  // Every write below is fenced by the job lease inside the database function.
  const port: JobPort = {
    loadOperation: async () => {
      const { data } = await admin.from("enrollment_document_extraction_operations").select("provider_engine, operation_id").eq("job_id", job.id).maybeSingle();
      return data ? { engine: String(data.provider_engine), operationId: String(data.operation_id) } : null;
    },
    recordOperation: async (engine, operationId) => {
      const { data, error } = await admin.rpc("portal_record_document_job_operation", { p_job: job.id, p_lease: job.lease_token, p_engine: engine, p_operation: operationId });
      if (error) throw new Error("operation receipt");
      return data === true;
    },
    finish: async (extraction, responseId, usage) => {
      // The database atomically validates lease/cancellation, merges current confirmed
      // metadata, applies candidates and records the terminal attempt exactly once.
      const { data, error } = await admin.rpc(scope ? "portal_finish_tenant_document_job" : "portal_finish_document_extraction_job", {
        ...(scope ? { p_tenant: scope.tenant } : {}),
        p_job: job.id, p_lease: job.lease_token, p_extraction: extraction, p_response_id: responseId, p_usage: usage,
      });
      if (error) throw new Error("persistence");
      return data === true;
    },
    fail: async (code, message, retry, delay) => {
      const { data, error } = await admin.rpc("portal_fail_document_extraction_job", { p_job: job.id, p_lease: job.lease_token, p_code: code, p_message: message, p_retry: retry, p_delay: delay });
      if (error) throw new Error("persistence");
      return data === true;
    },
  };
  const fail = async (code: string, message: string, retryable: boolean) => {
    let settled: Awaited<ReturnType<typeof settleFailure>>;
    try { settled = await settleFailure(port, Number(job.attempt_count ?? 1), code, message, retryable); }
    catch { return reply({ ok: false, error: "Unable to persist extraction outcome." }, 503); }
    if (!settled.accepted) return reply({ ok: true, processed: false, stale: true });
    return reply({ ok: false, jobId: job.id, retrying: settled.retrying, error: message }, settled.retrying ? 202 : 422);
  };
  try {
  const { data: doc } = await admin.from("enrollment_application_documents").select("id, application_id, category, bucket_name, storage_path, filename, mime_type, file_size, metadata, is_current, tenant_id").eq("id", job.document_id).maybeSingle();
  if (!doc || !doc.is_current || doc.application_id !== job.application_id || (doc.tenant_id ?? null) !== (job.tenant_id ?? null)) return await fail("stale", "The document was deleted or replaced before extraction.", false);
  const path = String(doc.storage_path ?? "");
  const segments = path.split("/");
  if (doc.bucket_name !== "enrollment-documents" || segments.length < 2 || segments[0] !== String(doc.application_id) ||
      // eslint-disable-next-line no-control-regex -- storage paths must not contain control characters
      segments.some((segment) => !segment || segment === "." || segment === "..") || /[\\%\u0000-\u001f]/.test(path)) {
    return await fail("target", "Document storage target is invalid.", false);
  }
  const { data: blob, error: blobError } = await admin.storage.from(doc.bucket_name).download(doc.storage_path);
  if (blobError || !blob) return await fail("storage", "The private document is no longer available.", false);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES || !isSupportedDocument(bytes, doc.mime_type ?? blob.type, doc.filename)) return await fail("validation", "The document must be a valid PDF, JPG, or PNG no larger than 10 MB.", false);
  const selection = createDocumentExtractionProvider(providerConfig);
  if (!selection.provider) return await fail("configuration", "The extraction provider is not configured.", true);
  const provider = selection.provider;
  const result = await runLeasedExtraction(provider, {
    bytes, mimeType: doc.mime_type || blob.type, filename: doc.filename, category: doc.category, jobId: job.id, attempt: Number(job.attempt_count ?? 1),
    // Cancellation is fenced by the database lease; there is no cooperative abort source yet.
    signal: new AbortController().signal,
  }, port);
  if (result.kind === "failure") return await fail(result.code, result.message, result.retryable);
  if (result.kind === "stale") return reply({ ok: true, processed: false, stale: true });
  return reply({ ok: true, processed: true, jobId: job.id });
  } catch {
    // The durable claim lease remains available for recovery even if this
    // best-effort record fails because the database itself is unavailable.
    return await fail("runtime", "The extraction worker stopped unexpectedly.", true);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  const configuration = backendConfiguration(url, serviceKey, anonKey);
  if (configuration) return reply(configuration, 503);
  if (request.method !== "POST") return reply({ ok: false, error: "Method not allowed." }, 405);
  if (request.headers.get("x-worker-secret") === workerSecret && workerSecret) { const body = await request.json().catch(() => ({})); return await processOne(typeof body.jobId === "string" && typeof body.tenantId === "string" ? { job: body.jobId, tenant: body.tenantId } : undefined); }
  return await enqueue(request);
});
