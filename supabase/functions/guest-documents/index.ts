import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createDocumentCategoryCheck } from "../_shared/document-extraction/classify.ts";
import { checkDocumentOwnership } from "../_shared/document-ownership.ts";
import { recordDocumentCategory } from "../_shared/validated-document-storage.ts";
import { backendConfiguration } from "../_shared/config.ts";
import {
  checkGuestFile, documentRef, GUEST_CONSENT_VERSION, isDeclarable, isGuestCategory, publicDocument, tokenHashHex, visaApplies,
} from "../_shared/guest-link.ts";
import { runGuestUpload, type UploadPort } from "../_shared/guest-upload.ts";

// Supabase's background-task API is supplied by the Edge runtime, not Deno CLI.
declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

// Students have no account. The gateway still verifies the anon JWT the browser sends; the private link token is checked in code.
// Every action is scoped to the one application the token resolves to, through service-role calls that take the link id.
// Responses carry status, the detected document type and the student's own answers: never a value read from a document.
const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const workerSecret = Deno.env.get("DOCUMENT_EXTRACTION_WORKER_SECRET") ?? "";
const checkCategory = createDocumentCategoryCheck({
  apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
  model: Deno.env.get("OPENAI_DOCUMENT_MODEL") ?? "",
});
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
// One generic answer for an unknown, expired, revoked or finished link: the response never says which.
const invalid = () => reply({ ok: false, error: "This link isn't valid." }, 404);
const failed = (error: string, status = 400) => reply({ ok: false, error }, status);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) => b.toString(16).padStart(2, "0")).join("");
}
const queuedMetadata = (extra: Record<string, unknown> = {}) => ({
  kind: "guest", ...extra,
  extraction: { extracted: {}, confirmed: {}, status: "queued", source: { engine: "openai-responses", parser: "document-extraction-v1", queuedAt: new Date().toISOString() } },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return failed("Method not allowed.", 405);
  const configuration = backendConfiguration(url, serviceKey);
  if (configuration) return failed("Service unavailable.", 503);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const forwarded = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipBucket = `ip:${(await sha256Hex(new TextEncoder().encode(forwarded))).slice(0, 32)}`;
  const hit = async (bucket: string, limit: number, seconds: number) => {
    const { data, error } = await admin.rpc("guest_rate_hit", { p_bucket: bucket, p_limit: limit, p_window_seconds: seconds });
    return !error && data === true;
  };
  if (!(await hit(ipBucket, 300, 600))) return failed("Too many requests. Please wait a few minutes.", 429);

  const contentType = request.headers.get("content-type") ?? "";
  const body: Record<string, unknown> = {};
  let file: File | null = null;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) return failed("Request not understood.");
    for (const [key, value] of form.entries()) { if (typeof value === "string") body[key] = value; else if (key === "file") file = value; }
  } else {
    Object.assign(body, await request.json().catch(() => ({})));
  }
  const action = String(body.action ?? "");
  const tokenHash = await tokenHashHex(String(body.token ?? ""));
  // Guessing tokens is throttled harder than normal use.
  if (!tokenHash) { await hit(`${ipBucket}:bad`, 20, 600); return invalid(); }
  const { data: resolved } = await admin.rpc("guest_link_resolve", { p_hash: tokenHash });
  const link = Array.isArray(resolved) ? resolved[0] : resolved;
  if (!link) { if (!(await hit(`${ipBucket}:bad`, 20, 600))) return failed("Too many requests. Please wait a few minutes.", 429); return invalid(); }
  const linkId = String(link.link_id), applicationId = String(link.application_id);
  if (!(await hit(`link:${linkId}`, 200, 600))) return failed("Too many requests. Please wait a few minutes.", 429);
  const finished = link.completed === true;

  const documentRows = async () => {
    const { data } = await admin.from("enrollment_application_documents").select("id, category, filename, metadata, created_at, storage_path")
      .eq("application_id", applicationId).eq("guest_link_id", linkId).eq("is_current", true).order("created_at");
    return data ?? [];
  };
  const loadDocuments = async () => await Promise.all((await documentRows()).map(async (row) => publicDocument(await documentRef(linkId, String(row.id)), row)));
  const findDocument = async (ref: unknown) => {
    for (const row of await documentRows()) if (typeof ref === "string" && (await documentRef(linkId, String(row.id))) === ref) return row;
    return null;
  };
  // Used only to decide whether the Visa step applies; the values themselves are never returned.
  const readValues = async () => {
    const { data } = await admin.from("enrollment_applications").select("data").eq("id", applicationId).maybeSingle();
    return ((data?.data as { values?: Record<string, unknown> } | null)?.values ?? {}) as Record<string, unknown>;
  };
  const declaredList = async () => {
    const { data } = await admin.from("guest_document_links").select("declared").eq("id", linkId).maybeSingle();
    return Object.keys((data?.declared as Record<string, unknown> | null) ?? {}).sort();
  };
  // Where extraction starts: the worker-secret path runs it now; without DOCUMENT_EXTRACTION_WORKER_SECRET only the recovery cron picks the job up.
  const dispatch = (job: { id?: string; tenant_id?: string | null }) => {
    if (!job?.id || !workerSecret) { console.log(JSON.stringify({ event: "guest_extraction_queued", trigger: "recovery_cron_only" })); return; }
    console.log(JSON.stringify({ event: "guest_extraction_queued", trigger: "worker_secret" }));
    EdgeRuntime.waitUntil(fetch(`${url}/functions/v1/portal-document-extract`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "x-worker-secret": workerSecret },
      body: JSON.stringify(job.tenant_id ? { jobId: job.id, tenantId: job.tenant_id } : {}),
    }).then((response) => response.body?.cancel()).catch(() => console.error(JSON.stringify({ event: "guest_extraction_dispatch_failed" }))));
  };
  const status = async () => {
    const documents = await loadDocuments();
    const passport = documents.find((doc) => doc.category === "Passport") ?? null;
    return { documents, declared: await declaredList(), visaApplies: visaApplies(passport, passport?.state === "done" ? await readValues() : {}) };
  };

  try {
    if (action === "open") {
      const { data: app } = await admin.from("enrollment_applications").select("tenant_id").eq("id", applicationId).maybeSingle();
      const tenantId = app?.tenant_id ?? null;
      const settingsQuery = admin.from("cms_settings").select("name, short_name, logo, primary_color").limit(1);
      const [{ data: settings }, { data: tenant }, { data: consent }] = await Promise.all([
        (tenantId ? settingsQuery.eq("tenant_id", tenantId) : settingsQuery.is("tenant_id", null)).maybeSingle(),
        tenantId ? admin.from("tenants").select("name").eq("id", tenantId).maybeSingle() : Promise.resolve({ data: null }),
        admin.from("guest_link_consents").select("id").eq("link_id", linkId).limit(1),
      ]);
      return reply({
        ok: true, finished, consentVersion: GUEST_CONSENT_VERSION, consented: (consent ?? []).length > 0,
        branding: { name: settings?.name || tenant?.name || "", shortName: settings?.short_name || "", logo: settings?.logo || "", primaryColor: settings?.primary_color || "" },
        ...(await status()),
      });
    }
    if (finished) return invalid();

    if (action === "consent") {
      if (body.version !== GUEST_CONSENT_VERSION) return failed("Request not understood.");
      const { error } = await admin.from("guest_link_consents").insert({ link_id: linkId, consent_version: GUEST_CONSENT_VERSION });
      return error ? failed("Could not record your choice. Please try again.", 503) : reply({ ok: true });
    }

    // Anything beyond reading the page needs recorded consent.
    const { data: consented } = await admin.from("guest_link_consents").select("id").eq("link_id", linkId).limit(1);
    if (!(consented ?? []).length) return failed("Please accept the notice first.", 403);

    if (action === "status") return reply({ ok: true, ...(await status()) });

    if (action === "upload") {
      if (!(await hit(`upload:${linkId}`, 60, 3600))) return failed("Upload limit reached. Please contact your agent.", 429);
      if (!isGuestCategory(body.category)) return failed("Request not understood.");
      if (!file) return failed("Please choose a file.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const checked = checkGuestFile(bytes, file.type, file.name);
      if (!checked.ok) {
        // One diagnostic line: the reason and the size only (no token, no file name, no content).
        console.log(JSON.stringify({ event: "guest_upload_rejected", reason: checked.code, found: checked.found ?? null, declared: file.type.slice(0, 60), bytes: bytes.length }));
        return failed(checked.code === "too_large" ? "Each file must be 10 MB or smaller." : checked.code === "empty" ? "This file is empty." : `This file looks like ${checked.found ?? "an unsupported file"}, not a PDF, JPG or PNG.`, checked.code === "too_large" ? 413 : 415);
      }
      const { data: app } = await admin.from("enrollment_applications").select("tenant_id").eq("id", applicationId).maybeSingle();
      const replaced = body.replaceRef ? await findDocument(body.replaceRef) : null;
      const checkOwnership = checkDocumentOwnership(admin, "enrollment-documents", checkCategory);
      const port: UploadPort = {
        checkOwnership: (document) => checkOwnership(document, applicationId),
        existing: async (category) => (await documentRows()).filter((row) => row.category === category)
          .map((row) => ({ id: String(row.id), sha256: String((row.metadata as { contentSha256?: string } | null)?.contentSha256 ?? "") })),
        countAll: async () => (await documentRows()).length,
        store: async (path, data, mime) => !(await admin.storage.from("enrollment-documents").upload(path, data, { upsert: false, contentType: mime })).error,
        insert: async (row) => {
          if (!(await recordDocumentCategory(admin, "enrollment-documents", row.storagePath, row.category, row.passportId))) return null;
          const { data } = await admin.from("enrollment_application_documents").insert({
            application_id: applicationId, tenant_id: app?.tenant_id ?? null, category: row.category, bucket_name: "enrollment-documents", storage_path: row.storagePath,
            filename: row.filename, mime_type: row.mime, file_size: row.size, uploaded_by: null, guest_link_id: linkId, metadata: queuedMetadata({ contentSha256: row.sha256 }),
          }).select("id").maybeSingle();
          return data ? String(data.id) : null;
        },
        discardObject: async (path) => { await admin.storage.from("enrollment-documents").remove([path]); },
        enqueue: async (documentId) => { const { data } = await admin.rpc("guest_enqueue_document_job", { p_link: linkId, p_document: documentId }); return data ?? null; },
        dispatch,
        remove: async (documentId) => {
          const { data: row } = await admin.from("enrollment_application_documents").select("id, storage_path").eq("id", documentId).eq("guest_link_id", linkId).maybeSingle();
          if (!row) return;
          await admin.from("enrollment_document_extraction_jobs").update({ state: "cancelled", lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString() }).eq("document_id", documentId).in("state", ["queued", "processing"]);
          await admin.storage.from("enrollment-documents").remove([String(row.storage_path)]);
          await admin.from("enrollment_application_documents").delete().eq("id", documentId).eq("guest_link_id", linkId);
        },
      };
      const outcome = await runGuestUpload(port, {
        category: body.category, replaceId: replaced ? String(replaced.id) : null, name: checked.name, mime: checked.mime, bytes, sha256: await sha256Hex(bytes),
        storagePath: `${applicationId}/validated-${crypto.randomUUID()}-${checked.name}`,
      });
      if (!outcome.ok) return failed(outcome.error, outcome.status);
      return reply({ ok: true, ref: await documentRef(linkId, outcome.documentId), category: body.category, ...(await status()) });
    }

    if (action === "retry") {
      const document = await findDocument(body.ref);
      if (!document) return failed("Request not understood.");
      const { data: job, error } = await admin.rpc("guest_enqueue_document_job", { p_link: linkId, p_document: document.id, p_reextract: true });
      if (error) return failed("Could not retry. Please try again.", 503);
      dispatch(job);
      return reply({ ok: true });
    }

    // "Yes, continue" / "Use it anyway": recorded on the document for the agent. The detected type is taken from the server's own record.
    if (action === "confirm") {
      const document = await findDocument(body.ref);
      if (!document) return failed("Request not understood.");
      const shown = publicDocument(await documentRef(linkId, String(document.id)), document);
      const { error } = await admin.rpc("guest_confirm_document", { p_link: linkId, p_document: document.id, p_used_anyway: body.usedAnyway === true || body.usedAnyway === "true", p_detected: shown.detected ?? "" });
      return error ? failed("Could not save. Please try again.", 503) : reply({ ok: true });
    }

    // "I don't have this" for Visa, English test and Academic; the agent sees it as "Student has no ...".
    if (action === "declare") {
      if (!isDeclarable(body.category)) return failed("Request not understood.");
      const { error } = await admin.rpc("guest_declare_missing", { p_link: linkId, p_category: body.category, p_missing: body.missing !== false && body.missing !== "false" });
      return error ? failed("Could not save. Please try again.", 503) : reply({ ok: true, ...(await status()) });
    }

    if (action === "finish") {
      const documents = await loadDocuments();
      if (!documents.some((doc) => doc.category === "Passport")) return failed("Please add your passport first.", 422);
      const { error } = await admin.rpc("guest_complete", { p_link: linkId });
      return error ? failed("Could not finish. Please try again.", 503) : reply({ ok: true });
    }

    return failed("Request not understood.");
  } catch {
    console.error(JSON.stringify({ event: "guest_documents_error", action }));
    return failed("Something went wrong. Please try again.", 500);
  }
});
