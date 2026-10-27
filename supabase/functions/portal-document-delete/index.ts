import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain", "Content-Type": "application/json" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  const configuration = backendConfiguration(url, serviceKey, anonKey);
  if (configuration) return reply(configuration, 503);
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ ok: false, error: "Authentication required." }, 401);
  const { documentId } = await request.json().catch(() => ({}));
  if (typeof documentId !== "string") return reply({ ok: false, error: "Document ID is required." }, 400);
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}`, ...(request.headers.has("x-tenant-domain") ? { "x-tenant-domain": request.headers.get("x-tenant-domain")! } : {}) } }, auth: { persistSession: false } });
  // RLS lookup establishes caller access before the service client is used.
  const { data: document, error } = await caller.from("enrollment_application_documents").select("id, application_id, bucket_name, storage_path, category, metadata, enrollment_applications!enrollment_application_documents_application_id_fkey(status)").eq("id", documentId).maybeSingle();
  if (error || !document) return reply({ ok: false, error: "Document not found or not authorised." }, 403);
  const application = Array.isArray(document.enrollment_applications) ? document.enrollment_applications[0] : document.enrollment_applications;
  if (application?.status !== "draft" && application?.status !== "action_required") return reply({ ok: false, error: "This document is retained because its application is no longer an editable draft." }, 409);
  if (["Consent", "Offer", "CoE"].includes(String(document.category))) return reply({ ok: false, error: "This document is retained and cannot be permanently deleted here." }, 409);
  // Never let a caller-visible metadata row choose an unrelated privileged target.
  const path = String(document.storage_path ?? "");
  const segments = path.split("/");
  if (document.bucket_name !== "enrollment-documents" || segments.length < 2 ||
      segments[0] !== String(document.application_id) ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      // eslint-disable-next-line no-control-regex -- storage paths must not contain control characters
      /[\\%\u0000-\u001f]/.test(path)) {
    return reply({ ok: false, error: "Document storage target is invalid." }, 403);
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  // Cancel active work first. A worker rechecks the row before persisting, so a
  // result cannot be written after the user has requested deletion.
  await admin
    .from("enrollment_document_extraction_jobs")
    .update({ state: "cancelled", lease_expires_at: null, updated_at: new Date().toISOString() })
    .eq("document_id", documentId)
    .in("state", ["queued", "processing"]);
  // Storage and SQL cannot be one transaction. Delete the object first; on a
  // subsequent row-delete failure, mark the row for reconciliation instead.
  const { error: storageError } = await admin.storage.from(String(document.bucket_name)).remove([String(document.storage_path)]);
  // A prior successful request can leave the row while the object is already
  // gone. Treat that as the intended idempotent outcome, not a false failure.
  if (storageError && !/not found|does not exist|unknown key/i.test(storageError.message)) {
    await admin.from("enrollment_document_deletion_recovery").upsert({ document_id: document.id, application_id: document.application_id, bucket_name: document.bucket_name, storage_path: document.storage_path, state: "storage_failed", last_error: storageError.message, requested_at: new Date().toISOString() });
    return reply({ ok: false, error: `Storage deletion failed: ${storageError.message}` }, 502);
  }
  const { error: rowError } = await admin.from("enrollment_application_documents").delete().eq("id", documentId);
  if (rowError) {
    await admin.from("enrollment_application_documents").update({ metadata: { ...(document.metadata ?? {}), deletion: { state: "storage_deleted_reconcile", requestedAt: new Date().toISOString() } } }).eq("id", documentId);
    await admin.from("enrollment_document_deletion_recovery").upsert({ document_id: document.id, application_id: document.application_id, bucket_name: document.bucket_name, storage_path: document.storage_path, state: "storage_deleted_row_failed", last_error: rowError.message, requested_at: new Date().toISOString() });
    return reply({ ok: false, error: "Storage object was deleted, but database cleanup is pending reconciliation." }, 502);
  }
  await admin.from("enrollment_document_deletion_recovery").update({ resolved_at: new Date().toISOString() }).eq("document_id", documentId);
  return reply({ ok: true, documentId });
});
