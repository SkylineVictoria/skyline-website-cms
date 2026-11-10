// Staff administration (verify_jwt = true): link emails (document / re-upload invites), reject with the optional email, retry
// a failed email, drain the HR outbox; offers: upload (multipart, PDF checked with pdf-lib), send, withdraw; activate (Auth invite
// to /staff/welcome, or the existing confirmed login). hr_admin_* run with the caller's JWT (hr.require_admin decides); the service role is used
// only to log email outcomes and to send queued mail. Rules and order live in core.ts.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { linkUrl, readHrMailConfig, selectHrMailProvider, sendLinkEmail, sendTemplateEmail } from "../_shared/hr-mail.ts";
import type { TemplatePerson, TemplateSource } from "../_shared/hr-template.ts";
import { HR_MAIL_ENV, drainHrOutbox } from "../_shared/hr-mail-drain.ts";
import { handleAdmin } from "./core.ts";
import { findAuthUserByEmail } from "../_shared/invite-delivery.ts";
import { authorizeWorker } from "../_shared/notification/delivery.ts";
import { MAX_OFFER_BYTES } from "../_shared/offer-rules.ts";
import { loadLetterhead } from "../_shared/letterhead.ts";
// The PDF code (pdf-lib, the embedded fonts) is loaded only by the requests that make or check a PDF, so the worker boots light.
const letterPdfModule = () => import("../_shared/offer-letter-pdf.ts");
const offerPdfModule = () => import("../_shared/offer-pdf.ts");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const env: Record<string, string> = { SUPABASE_URL };
for (const name of HR_MAIL_ENV) env[name] = Deno.env.get(name) ?? "";
const config = readHrMailConfig(env);
const retentionRaw = Number(Deno.env.get("EF_HR_RETENTION_MONTHS") ?? "6");
const RETENTION_MONTHS = Number.isInteger(retentionRaw) && retentionRaw >= 1 && retentionRaw <= 120 ? retentionRaw : 6;
const provider = selectHrMailProvider(env);

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const configuration = backendConfiguration(SUPABASE_URL, SERVICE_KEY, ANON_KEY);
  if (configuration) return json(configuration, 503);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Authentication required." }, 401);
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_OFFER_BYTES + 64 * 1024) return json({ error: "The file is too large: an offer letter may be 7 MB, a resume or cover letter 5 MB.", field: "file" }, 413);
  let body: Record<string, unknown> = {};
  let file: { name: string; bytes: Uint8Array } | null = null;
  try {
    if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      const form = await req.formData();
      body = { action: form.get("action"), profileId: form.get("profileId"), applicationId: form.get("applicationId"), which: form.get("which") };
      const f = form.get("file");
      if (f && typeof f !== "string") file = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    } else {
      body = (await req.json()) as Record<string, unknown>;
    }
  } catch { return json({ error: "The request could not be read." }, 400); }

  const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = service.storage.from("staff-documents");
  const asError = (e: { code?: string; message?: string } | null) => (e ? { code: e.code, message: e.message } : null);

  const result = await handleAdmin(body, {
    adminRpc: async (name, args) => { const { data, error } = await caller.rpc(name, args); return { data, error: asError(error) }; },
    serviceRpc: async (name, args) => { const { data, error } = await service.rpc(name, args); return { data, error: asError(error) }; },
    newLink: async () => {
      const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
      return { token, hash: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))) };
    },
    config,
    sendLink: (mail) => sendLinkEmail(provider, config, mail),
    // HRMS > Templates: the template to send (a chosen one, else the default of that kind) with the person's values.
    templateMail: async (profileId, type, templateId) => {
      const { data, error } = await service.rpc("hr_svc_template_mail", { p_profile: profileId, p_type: type, p_template: templateId ?? null });
      if (error || !data) return null;
      const mail = data as { template: (TemplateSource & { id: string; name: string }) | null; values: TemplatePerson | null };
      return { template: mail.template, values: mail.values ?? {} };
    },
    sendTemplate: (mail) => sendTemplateEmail(provider, config, mail),
    accountUrl: (token) => `${config.siteUrl}/staff/welcome#t=${encodeURIComponent(token)}`,
    // An unconfirmed login with no password given (Auth stores a random one nobody knows): it cannot sign in until the person
    // chooses a password through their one-time link, which also confirms the email.
    createLogin: async (email, name) => {
      const { data, error } = await service.auth.admin.createUser({ email, email_confirm: false, user_metadata: { name, account_type: "staff" } });
      return { userId: data?.user?.id ?? null, error: error ? error.message : null };
    },
    deleteLogin: async (userId) => { await service.auth.admin.deleteUser(userId); },
    // The letter carries the Website Settings letterhead (name, logo, colour): the same styling as every Skyline PDF.
    letterPdf: async (input) => (await letterPdfModule()).buildLetterPdf({ ...input, letterhead: await loadLetterhead(service) }),
    unsupportedText: async (texts) => (await letterPdfModule()).unsupportedText(texts),
    linkUrl: (purpose, token) => linkUrl(config.siteUrl!, purpose, token),
    drain: () => drainHrOutbox(service, env),
    file,
    inspectOffer: async (bytes) => (await offerPdfModule()).inspectOfferPdf(bytes),
    upload: async (path, bytes, contentType) => { const { error } = await bucket.upload(path, bytes, { contentType, upsert: false }); return { error: error ? error.message : null }; },
    remove: async (paths) => { if (paths.length) await bucket.remove(paths); },
    sha256: async (bytes) => hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    newId: () => crypto.randomUUID(),
    // The retention job: a verified service_role token of this project (same check as the notification worker).
    isWorker: body.action === "purge" && (await authorizeWorker(req.headers.get("Authorization"), SUPABASE_URL)) === 200,
    retentionMonths: RETENTION_MONTHS,
    purgeFiles: async (paths) => { const { error } = await bucket.remove(paths); return { error: error ? error.message : null }; },
    findLogin: async (email) => {
      const found = await findAuthUserByEmail(service, email.toLowerCase());
      if (found.error) return { login: null, error: found.error };
      const u = found.user as { id: string; email_confirmed_at?: string | null; invited_at?: string | null; last_sign_in_at?: string | null } | null;
      return { login: u ? { id: u.id, confirmed: Boolean(u.email_confirmed_at), invited: Boolean(u.invited_at), signedIn: Boolean(u.last_sign_in_at) } : null, error: null };
    },
    inviteLogin: async (email, name, redirectTo) => {
      const { data, error } = await service.auth.admin.inviteUserByEmail(email, { data: { name, account_type: "staff" }, redirectTo });
      return { userId: data?.user?.id ?? null, error: error ? error.message : null };
    },
  });
  return json(result.body, result.status);
});
