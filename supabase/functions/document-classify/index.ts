// BULK-DOCUMENTS (owner 2026-11-28: "while uploading files in bulk, scan each file and attach it to the category where it is needed; no
// manual category selection"). POST multipart { applicationId, file, firstName?, lastName? } (DOCUMENT-FINDER: with the names, also
// nameMatch: whether the document is that person's, so "Find my documents" keeps only the student's own): which application document this file is (passport, visa, English
// result, academic, driving licence, or none of them). The caller must be able to edit the application (portal_can_edit_application with
// their own token; JWT on). The file is not stored and nothing read from it is returned except its type; the wizard then uploads it
// through validated-document-upload, which checks it again against the category it is attached to. Same size / type limits and the same
// hourly limit per person as the checked upload (Business Rules). Env: OPENAI_API_KEY, OPENAI_DOCUMENT_MODEL (already set).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { createDocumentTypeDetector, type DetectedDocumentType } from "../_shared/document-extraction/classify.ts";
import { readerFetch } from "../_shared/document-extraction/lab-reader-fetch.ts";
import { DOCUMENT_MAX_BYTES, documentFileProblem, documentLimits } from "../_shared/validation/person.ts";
import { loadRules, ruleList, ruleNumber } from "../_shared/business-rules.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const detect = createDocumentTypeDetector({
  apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
  model: Deno.env.get("OPENAI_DOCUMENT_MODEL") ?? "",
  // LAB ONLY: the lab's mock reader when SUPABASE_URL is local (EF_OPENAI_API_URL); plain fetch on any hosted project.
  fetch: readerFetch({ SUPABASE_URL: url, EF_OPENAI_API_URL: Deno.env.get("EF_OPENAI_API_URL") ?? "" }),
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

/** The wizard's document step each detected type belongs to ("" = not one the application asks for). */
export const STEP_OF: Record<DetectedDocumentType, string> = {
  Passport: "passport", "Australian Visa": "visa", Visa: "visa", "English Evidence": "english", PTE: "english", Academic: "academic",
  "Driving Licence": "licence", "Health Insurance": "", Other: "", Unclear: "",
};

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
  const applicationId = String(form?.get("applicationId") ?? "").toLowerCase();
  const file = form?.get("file");
  if (!uuid.test(applicationId) || !(file instanceof File)) return fail("Choose a file.", 400);
  const { data: canEdit, error: accessError } = await caller.rpc("portal_can_edit_application", { app_id: applicationId });
  if (accessError || canEdit !== true) return fail("You cannot upload to this application.", 403);
  // Business Rules: the application document size and types SLIT allows (as the checked upload).
  const rules = await loadRules(caller, ["admissions.application_document_limit_mib", "admissions.application_document_types"]);
  const limits = documentLimits(ruleNumber(rules, "admissions.application_document_limit_mib", 10), ruleList(rules, "admissions.application_document_types", ["JPEG", "PNG", "PDF"]));
  const problem = documentFileProblem(file, new Uint8Array(await file.slice(0, 8).arrayBuffer()), limits);
  if (problem) return fail(problem, file.size > limits.maxBytes ? 413 : 415);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  // Business Rules admissions.document_uploads_per_hour: the same hourly allowance per signed-in person as the checked upload.
  const perHour = Math.max(1, Math.round(ruleNumber(await loadRules(admin, ["admissions.document_uploads_per_hour"]), "admissions.document_uploads_per_hour", 60)));
  const limit = await admin.rpc("public_assistant_take_rate_limit", { p_bucket: `document-classify:${auth.user.id}`, p_limit: perHour, p_window_seconds: 3600 });
  if (limit.error) return fail("Document checking is temporarily unavailable.", 503);
  if (limit.data !== true) return fail("Upload limit reached. Please try again later.", 429);

  // DOCUMENT-FINDER (owner 2026-11-28): with the student's first and last name, also whether the document is theirs (true / false / null).
  const name = (key: string) => String(form?.get(key) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
  const person = name("firstName") && name("lastName") ? { firstName: name("firstName"), lastName: name("lastName") } : undefined;
  const result = await detect({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, filename: file.name, person });
  if ("error" in result) return result.status === 422 ? reply({ type: "Unclear", step: "", nameMatch: null }) : fail(result.error, result.status);
  return reply({ type: result.type, step: STEP_OF[result.type], ...(person ? { nameMatch: result.nameMatch ?? null } : {}) });
});
