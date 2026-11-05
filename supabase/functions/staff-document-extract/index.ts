// Reads a staff applicant's document (passport, visa, driving licence, English test) to prefill name, date of birth, document number
// and expiry. Separate from portal-document-extract on purpose: that function's student queue and lease fencing are untouched; this
// one reuses only the shared provider adapters (_shared/document-extraction) and records the result in hr.staff_documents.
// JWT is verified by the platform. The caller's own session proves ownership (hr_staff_document_for_extraction returns only the
// caller's current document of a draft application); the result is written with the service role through
// hr_staff_document_apply_extraction, which fills only EMPTY profile fields. Provider settings are the same EF_* variables as the
// student function. The read runs after the response (EdgeRuntime.waitUntil); the browser polls hr_staff_me.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { createDocumentExtractionProvider } from "../_shared/document-extraction/select.ts";
import { STAFF_READER_CATEGORY, runStaffExtraction, type StaffExtractionPort } from "./core.ts";

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

const url = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const providerConfig: Record<string, string> = { OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") ?? "", OPENAI_DOCUMENT_MODEL: Deno.env.get("OPENAI_DOCUMENT_MODEL") ?? "" };
for (const name of ["EF_DOCUMENT_EXTRACTION_PROVIDER", "EF_DOCUMENT_EXTRACTION_ROUTES", "EF_AZURE_DOCUMENT_ENDPOINT", "EF_AZURE_DOCUMENT_API_KEY", "EF_AZURE_DOCUMENT_MODEL", "EF_AZURE_DOCUMENT_MODEL_MAP", "EF_AZURE_DOCUMENT_API_VERSION"]) providerConfig[name] = Deno.env.get(name) ?? "";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return reply({ ok: false, error: "Method not allowed." }, 405);
  const configuration = backendConfiguration(url, serviceKey, anonKey);
  if (configuration) return reply(configuration, 503);
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ ok: false, error: "Authentication required." }, 401);
  const { documentId } = await request.json().catch(() => ({}));
  if (typeof documentId !== "string") return reply({ ok: false, error: "Document ID is required." }, 400);

  const caller = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: doc, error } = await caller.rpc("hr_staff_document_for_extraction", { p_id: documentId });
  if (error || !doc) return reply({ ok: false, error: "Document not found or not authorised." }, 403);
  if (!STAFF_READER_CATEGORY[String(doc.category)]) return reply({ ok: false, error: "This document type is not read automatically." }, 422);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const port: StaffExtractionPort = {
    apply: async (status, extracted, message) => {
      const { error: applyError } = await admin.rpc("hr_staff_document_apply_extraction", { p_doc: doc.id, p_status: status, p_extracted: extracted, p_error: message ?? null });
      if (applyError) throw new Error("persistence");
    },
    download: async () => {
      const { data: blob } = await admin.storage.from("staff-documents").download(String(doc.storagePath));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    },
  };
  const selection = createDocumentExtractionProvider(providerConfig, { category: STAFF_READER_CATEGORY[String(doc.category)] });
  const task = runStaffExtraction({ id: doc.id, category: doc.category, filename: doc.filename, mimeType: doc.mimeType }, selection.provider, port, AbortSignal.timeout(110_000))
    .catch(async () => { try { await port.apply("failed", {}, "Reading the document stopped unexpectedly. Try again or enter your details yourself."); } catch { /* the document stays pending */ } });
  EdgeRuntime.waitUntil(task);
  return reply({ ok: true, state: selection.provider ? "processing" : "unavailable" });
});
