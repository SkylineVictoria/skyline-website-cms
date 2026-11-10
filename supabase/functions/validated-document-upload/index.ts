import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { checkedDocumentCategory } from "../_shared/document-category.ts";
import { createDocumentCategoryCheck } from "../_shared/document-extraction/classify.ts";
import { checkDocumentOwnership } from "../_shared/document-ownership.ts";
import { recordDocumentCategory } from "../_shared/validated-document-storage.ts";
import { DOCUMENT_MAX_BYTES, documentFileProblem } from "../_shared/validation/person.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const checkCategory = createDocumentCategoryCheck({
  apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
  model: Deno.env.get("OPENAI_DOCUMENT_MODEL") ?? "",
});
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (error: string, status: number) => reply({ error }, status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return fail("Method not allowed.", 405);
  if (backendConfiguration(url, serviceKey, anonKey)) return fail("Document checking is unavailable.", 503);
  const bearer = request.headers.get("Authorization");
  if (!bearer?.startsWith("Bearer ")) return fail("Sign in to upload a document.", 401);
  const caller = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: bearer } } });
  const { data: auth, error: authError } = await caller.auth.getUser(bearer.slice(7));
  if (authError || !auth.user) return fail("Sign in to upload a document.", 401);
  if (Number(request.headers.get("content-length") ?? 0) > DOCUMENT_MAX_BYTES + 64 * 1024) return fail("The file must be 10 MB or smaller.", 413);
  const form = await request.formData().catch(() => null);
  const target = String(form?.get("target") ?? "");
  const ownerId = String(form?.get("ownerId") ?? "").toLowerCase();
  const category = String(form?.get("category") ?? "");
  const file = form?.get("file");
  const existingDocumentId = String(form?.get("existingDocumentId") ?? "");
  if (!uuid.test(ownerId) || !checkedDocumentCategory(category) || !(file instanceof File)) return fail("Choose a file and a document type.", 400);
  if (existingDocumentId && (target !== "enrollment" || !uuid.test(existingDocumentId))) return fail("Choose a valid document.", 400);
  if (file.size === 0 || file.size > DOCUMENT_MAX_BYTES) return fail("The file must be greater than 0 bytes and 10 MB or smaller.", 413);

  let bucketName: "enrollment-documents" | "staff-documents", folder: string;
  if (target === "enrollment") {
    const { data, error } = await caller.rpc("portal_can_edit_application", { app_id: ownerId });
    if (error || data !== true) return fail("You cannot upload to this application.", 403);
    const problem = documentFileProblem(file, new Uint8Array(await file.slice(0, 8).arrayBuffer()));
    if (problem) return fail(problem, 415);
    bucketName = "enrollment-documents";
    folder = ownerId;
  } else if (target === "employee") {
    const { data, error } = await caller.rpc("hr_admin_emp_get", { p_id: ownerId });
    if (error || !["active", "inactive"].includes(data?.status)) return fail("You cannot upload to this employee.", 403);
    bucketName = "staff-documents";
    folder = `employees/${ownerId}`;
  } else {
    return fail("Choose an upload location.", 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const limit = await admin.rpc("public_assistant_take_rate_limit", {
    p_bucket: `validated-document-upload:${auth.user.id}`, p_limit: 60, p_window_seconds: 3600,
  });
  if (limit.error) return fail("Document checking is temporarily unavailable.", 503);
  if (limit.data !== true) return fail("Upload limit reached. Please try again later.", 429);

  const bytes = new Uint8Array(await file.arrayBuffer());
  let existingPath: string | null = null;
  if (existingDocumentId) {
    const { data: document, error } = await caller.from("enrollment_application_documents")
      .select("bucket_name, storage_path").eq("id", existingDocumentId).eq("application_id", ownerId)
      .eq("category", category).eq("is_current", true).maybeSingle();
    if (error || document?.bucket_name !== bucketName || !document.storage_path.startsWith(`${folder}/`)) {
      return fail("The existing document could not be checked. Try the upload again.", 409);
    }
    const { data: existing } = await caller.storage.from(bucketName).download(document.storage_path);
    if (!existing || existing.size !== bytes.length) return fail("The existing document could not be checked.", 409);
    const saved = new Uint8Array(await existing.arrayBuffer());
    if (!bytes.every((byte, index) => byte === saved[index])) return fail("The existing document could not be checked.", 409);
    existingPath = document.storage_path;
  }
  const checkOwnership = checkDocumentOwnership(admin, bucketName, checkCategory);
  const ownership = await checkOwnership({ category, bytes, mime: file.type, filename: file.name, australianVisaOnly: target === "enrollment" }, ownerId);
  if (!ownership.ok) return fail(ownership.error, ownership.status);
  if (existingPath) return reply({ path: existingPath });
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const path = `${folder}/validated-${crypto.randomUUID()}${ext}`;
  const bucket = admin.storage.from(bucketName);
  const { error } = await bucket.upload(path, bytes, { upsert: false, contentType: file.type });
  if (error) return fail("The file could not be uploaded. Please try again.", 503);
  if (!(await recordDocumentCategory(admin, bucketName, path, category, ownership.passportId))) {
    await bucket.remove([path]);
    return fail("The file could not be verified. Please try again.", 503);
  }
  return reply({ path });
});
