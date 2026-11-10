// Staff onboarding by emailed link (verify_jwt = false; the link token is the only credential). JSON actions, or
// multipart/form-data for `upload`. The rules and their order live in core.ts; every database call is service-role only and
// re-checks the link (hr_svc_*). Document reading (Passport, Visa, English, Driving Licence) runs after the response with the
// shared reader (reader.ts) and fills only EMPTY details; without provider settings it records
// "unavailable" and the person types their details. Responses are never cached and send no referrer.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { createDocumentCategoryCheck } from "../_shared/document-extraction/classify.ts";
import { recordDocumentCategory } from "../_shared/validated-document-storage.ts";
import { createDocumentExtractionProvider } from "../_shared/document-extraction/select.ts";
import { STAFF_READER_CATEGORY, readerFetch, runStaffExtraction } from "./reader.ts";
import { MAX_REQUEST_BYTES, handleOnboarding, type DocumentToRead } from "./core.ts";
import { DOCUMENT_SIZE_MESSAGE } from "../_shared/validation/person.ts";
import { GEOSCAPE_URL, searchAddresses } from "../_shared/validation/address.ts";
import { isLocalSupabaseUrl } from "../_shared/captcha.ts";
import { HR_MAIL_ENV, drainHrOutbox } from "../_shared/hr-mail-drain.ts";
import { loadLetterhead } from "../_shared/letterhead.ts";
// The PDF code (pdf-lib, the embedded fonts) is loaded only when an offer is signed, so the worker boots light.
const offerPdfModule = () => import("../_shared/offer-pdf.ts");

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const providerConfig: Record<string, string> = { OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") ?? "", OPENAI_DOCUMENT_MODEL: Deno.env.get("OPENAI_DOCUMENT_MODEL") ?? "" };
const mailEnv: Record<string, string> = { SUPABASE_URL };
for (const name of HR_MAIL_ENV) mailEnv[name] = Deno.env.get(name) ?? "";
const fetchForReader = readerFetch({ SUPABASE_URL, EF_OPENAI_API_URL: Deno.env.get("EF_OPENAI_API_URL") ?? "" });
const checkCategory = createDocumentCategoryCheck({ apiKey: providerConfig.OPENAI_API_KEY, model: providerConfig.OPENAI_DOCUMENT_MODEL, fetch: fetchForReader });
for (const name of ["EF_DOCUMENT_EXTRACTION_PROVIDER", "EF_DOCUMENT_EXTRACTION_ROUTES", "EF_AZURE_DOCUMENT_ENDPOINT", "EF_AZURE_DOCUMENT_API_KEY", "EF_AZURE_DOCUMENT_MODEL", "EF_AZURE_DOCUMENT_MODEL_MAP", "EF_AZURE_DOCUMENT_API_VERSION"]) providerConfig[name] = Deno.env.get(name) ?? "";

// The address search uses the SAME key and helper as the address-search function (the student form's): the key stays on the server.
const ADDRESS_KEY = Deno.env.get("EF_ADDRESS_SEARCH_GEOSCAPE_KEY") ?? "";
// LAB ONLY: EF_ADDRESS_SEARCH_API_URL sends the lookup to a mock, and only when SUPABASE_URL is local; otherwise plain fetch.
const ADDRESS_MOCK = (Deno.env.get("EF_ADDRESS_SEARCH_API_URL") ?? "").trim().replace(/\/+$/, "");
const addressFetch: typeof fetch = ADDRESS_MOCK && isLocalSupabaseUrl(SUPABASE_URL)
  ? ((input: string | URL | Request, init?: RequestInit) => fetch(String(input) === GEOSCAPE_URL ? `${ADDRESS_MOCK}/v1/verify/autocomplete/AU` : input, init)) as typeof fetch
  : fetch;

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Max-Age": "600",
  "Access-Control-Expose-Headers": "Retry-After",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY);
  if (configuration) return json(configuration, 503);
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_REQUEST_BYTES) return json({ error: DOCUMENT_SIZE_MESSAGE, field: "file" }, 413);

  let action = "", token: unknown = null, file: File | null = null;
  let fields: Record<string, unknown> = {};
  try {
    if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      const form = await req.formData();
      action = String(form.get("action") ?? "");
      token = form.get("t");
      const f = form.get("file");
      file = f && typeof f !== "string" ? f : null;
      fields = { category: form.get("category"), expiryDate: form.get("expiryDate"), replaces: form.get("replaces") };
    } else {
      const body = (await req.json()) as Record<string, unknown>;
      action = String(body.action ?? "");
      token = body.t;
      fields = body;
    }
  } catch { return json({ error: "The request could not be read." }, 400); }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  // A signed-in person (no link token): the session is verified with Auth; the anon key and expired or forged tokens give no session.
  let session: { userId: string } | null = null;
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if ((token === null || token === undefined || token === "") && bearer && bearer.split(".").length === 3) {
    const { data, error } = await admin.auth.getUser(bearer);
    if (!error && data?.user?.id && data.user.email_confirmed_at) session = { userId: data.user.id };
  }
  const bucket = admin.storage.from("staff-documents");
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const scheduleExtraction = (doc: DocumentToRead) => {
    const selection = createDocumentExtractionProvider(providerConfig, { category: STAFF_READER_CATEGORY[doc.category], fetch: fetchForReader });
    const port = {
      apply: async (status: string, extracted: Record<string, string>, message?: string) => {
        const { error } = await admin.rpc("hr_staff_document_apply_extraction", { p_doc: doc.id, p_status: status, p_extracted: extracted, p_error: message ?? null });
        if (error) throw new Error("persistence");
      },
      download: async () => {
        const { data } = await bucket.download(doc.storagePath);
        return data ? new Uint8Array(await data.arrayBuffer()) : null;
      },
    };
    const task = runStaffExtraction(doc, selection.provider, port, AbortSignal.timeout(110_000))
      .catch(async () => { try { await port.apply("failed", {}, "Reading the document stopped unexpectedly. Try again or enter your details yourself."); } catch { /* stays pending */ } });
    EdgeRuntime.waitUntil(task);
  };

  const userAgent = req.headers.get("user-agent");
  const result = await handleOnboarding({ action, token, ip, userAgent, fields, file, session }, {
    takeRateLimit: async (b, limit, windowSeconds) => {
      const { data, error } = await admin.rpc("public_assistant_take_rate_limit", { p_bucket: b, p_limit: limit, p_window_seconds: windowSeconds });
      return !error && data === true; // a failed limiter fails closed
    },
    rateCount: async (b, windowSeconds) => {
      const { data, error } = await admin.rpc("hr_svc_rate_count", { p_bucket: b, p_window_seconds: windowSeconds });
      return error ? Number.MAX_SAFE_INTEGER : Number(data ?? 0); // an unreadable counter fails closed
    },
    rpc: async (name, args) => { const { data, error } = await admin.rpc(name, args); return { data, error: error ? { code: error.code, message: error.message } : null }; },
    upload: async (path, bytes, contentType) => { const { error } = await bucket.upload(path, bytes, { contentType, upsert: false }); return { error: error ? error.message : null }; },
    remove: async (paths) => { if (paths.length) await bucket.remove(paths); },
    signedUrl: async (path, seconds) => { const { data } = await bucket.createSignedUrl(path, seconds); return data?.signedUrl ?? null; },
    checkCategory,
    recordCategory: (path, category) => recordDocumentCategory(admin, "staff-documents", path, category),
    scheduleExtraction,
    hash: sha256,
    newId: () => crypto.randomUUID(),
    download: async (path) => { const { data } = await bucket.download(path); return data ? new Uint8Array(await data.arrayBuffer()) : null; },
    sha256: async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map((x) => x.toString(16).padStart(2, "0")).join(""),
    stampOffer: async (original, signature) => (await offerPdfModule()).stampSignedOffer(original, signature, await loadLetterhead(admin)),
    now: () => new Date(),
    searchAddress: (query) => searchAddresses(query, ADDRESS_KEY, addressFetch),
    setPassword: async (userId, password) => {
      const { error } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
      return { error: error ? error.message : null };
    },
  });
  // Submit queues "X has uploaded documents" for the admins: send it after the response.
  // Signing queues the signed copy for the applicant and HR (with the PDF attached).
  if ((action === "submit" || action === "offer_sign") && result.status === 200) EdgeRuntime.waitUntil(drainHrOutbox(admin, mailEnv).catch(() => undefined));
  return json(result.body, result.status, result.headers ?? {});
});
