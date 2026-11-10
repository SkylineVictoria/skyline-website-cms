import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { MAX_OFFER_BYTES } from "../_shared/offer-rules.ts";
import { loadLetterhead } from "../_shared/letterhead.ts";
import { fillSigningTemplate, signingHtml, signingNameValid, signingReceipt, signingVariables, SIGNING_CONSENT } from "../_shared/signing.ts";
import { templateValues, type TemplatePerson } from "../_shared/hr-template.ts";
import { readHrMailConfig, selectHrMailProvider, sendTemplateEmail } from "../_shared/hr-mail.ts";
import { HR_MAIL_ENV } from "../_shared/hr-mail-drain.ts";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Type": "application/json" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))].map((b) => b.toString(16).padStart(2, "0")).join("");
const env: Record<string, string> = { SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? "" };
for (const key of HR_MAIL_ENV) env[key] = Deno.env.get(key) ?? "";
const config = readHrMailConfig(env), provider = selectHrMailProvider(env);
// The PDF engine (pdf-lib + fontkit through deno.json) loads on the first request that makes, checks or signs a PDF, not at boot.
const letterPdfModule = () => import("../_shared/offer-letter-pdf.ts");
const offerPdfModule = () => import("../_shared/offer-pdf.ts");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let stagedPath: string | null = null;
  const service = createClient(env.SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const bucket = service.storage.from("signing-documents");
  try {
    // Bounded read even when Content-Length is omitted.
    const reader = req.body?.getReader();
    if (!reader) return json({ error: "Request body required" }, 400);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > MAX_OFFER_BYTES + 128 * 1024) { await reader.cancel(); return json({ error: "Document is too large" }, 413); } chunks.push(part.value); }
    const raw = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
    const parsed = new Response(raw, { headers: { "Content-Type": req.headers.get("content-type") ?? "application/json" } });
    let body: Record<string, unknown>; let upload: File | null = null;
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await parsed.formData(); body = JSON.parse(String(form.get("data") ?? "{}"));
      const file = form.get("file"); if (file instanceof File) upload = file;
    } else body = await parsed.json();
    const action = String(body.action ?? "");
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await service.rpc(name, args); if (error) throw new Error(error.message); return data;
    };
    const fileBytes = async (path: string, expected: string) => {
      const { data, error } = await bucket.download(path);
      if (error || !data) throw new Error("The document could not be opened.");
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (await hash(bytes) !== expected) throw new Error("The document integrity check failed.");
      return bytes;
    };
    const fileUrl = async (path: string) => {
      const { data, error } = await bucket.createSignedUrl(path, 60);
      if (error || !data) throw new Error("The document link could not be created.");
      return data.signedUrl;
    };
    const storePdf = async (path: string, bytes: Uint8Array) => {
      const { error } = await bucket.upload(path, bytes, { contentType: "application/pdf", upsert: false });
      if (error) throw new Error("The document could not be saved.");
      stagedPath = path;
    };
    if (["open", "sign", "decline"].includes(action)) {
      const token = String(body.token ?? "");
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ error: "This signing link is invalid or expired." }, 403);
      const tokenHash = await hash(new TextEncoder().encode(token));
      const record = await rpc("signing_service", { p_action: "open", p_hash: tokenHash });
      if (action === "decline") {
        await rpc("signing_service", { p_action: "decline", p_hash: tokenHash });
        return json({ declined: true });
      }
      if (action === "sign") {
        if (body.agreed !== true || !signingNameValid(body.name)) throw new Error("Enter your full name and tick the agreement.");
        if (record.state === "signed") throw new Error("This document is already signed.");
        // Require acknowledgement of the exact bytes displayed, not just a request ID.
        if (body.documentHash !== record.original_hash) throw new Error("Open the current document before signing.");
        if (await (await letterPdfModule()).unsupportedText([body.name.trim()])) throw new Error("Please type your name using Latin letters for this PDF signature.");
        const original = await fileBytes(record.original_path, record.original_hash);
        const signedAt = new Date().toISOString();
        const bytes = await signingReceipt(original, { id: record.id, title: record.title, recipientEmail: record.recipient_email,
          signerName: body.name.trim(), signedAt, sourceHash: record.original_hash, consent: SIGNING_CONSENT }, await loadLetterhead(service));
        const path = `${record.id}/signed-${crypto.randomUUID()}.pdf`;
        await storePdf(path, bytes);
        await rpc("signing_service", { p_action: "sign", p_hash: tokenHash, p_data: { signer_name: body.name.trim(), signed_at: signedAt,
          signed_path: path, signed_hash: await hash(bytes), original_hash: record.original_hash, consent: SIGNING_CONSENT } });
        stagedPath = null; // Committed. Never remove the authoritative signed copy on a later URL error.
        return json({ signed: true });
      }
      const path = record.signed_path ?? record.original_path;
      await fileBytes(path, record.signed_hash ?? record.original_hash);
      return json({ id: record.id, title: record.title, recipientName: record.recipient_name, state: record.state, signedAt: record.signed_at,
        consent: SIGNING_CONSENT, documentHash: record.original_hash, url: await fileUrl(path) });
    }
    const caller = createClient(env.SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: req.headers.get("authorization") ?? "" } }, auth: { persistSession: false } });
    const admin = async (operation: string, id: unknown = null, data: unknown = {}) => {
      const result = await caller.rpc("signing_admin", { p_action: operation, p_id: id, p_data: data });
      if (result.error) throw new Error(result.error.message); return result.data;
    };
    /**
     * A document from a template: the variables come from the staff member's record (hr_admin_template_values, with the caller's
     * JWT) when one is chosen, and from the typed values otherwise; a variable without a value stops here, named. The admin may
     * edit the filled text for THIS copy (no {{variable}} may remain; the template is untouched). Text the PDF font cannot set is
     * refused. The same preparation serves the preview and the saved draft, so the preview is the document that goes out.
     */
    const prepareDocument = async (context: { templates: Array<{ id: string; name: string; title: string; body: string }> }) => {
      const profileId = typeof body.profileId === "string" && UUID.test(body.profileId) ? body.profileId : null;
      let record: Record<string, string> = {};
      if (profileId) {
        const person = await caller.rpc("hr_admin_template_values", { p_id: profileId });
        if (person.error) throw new Error(person.error.message);
        record = templateValues((person.data ?? {}) as TemplatePerson);
      }
      const name = String(body.recipientName ?? record.full_name ?? "").trim(), email = String(body.recipientEmail ?? record.email ?? "").trim().toLowerCase();
      if (!signingNameValid(name) || !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(email)) throw new Error("Enter the recipient's full name and email.");
      const template = context.templates.find((t) => t.id === body.templateId);
      if (!template) throw new Error("Choose a saved template or upload a PDF.");
      const typed = typeof body.values === "object" && body.values ? body.values as Record<string, unknown> : {};
      const recordFilled = Object.fromEntries(Object.entries(record).filter(([, v]) => String(v ?? "").trim() !== ""));
      // A record value wins over a typed one for the same name; a typed value fills what the record lacks.
      const values: Record<string, unknown> = { ...typed, ...recordFilled, full_name: name, email };
      const title = fillSigningTemplate(template.title, values);
      const rendered = fillSigningTemplate(template.body, values);
      let text = rendered, edited = false;
      if (typeof body.text === "string" && body.text.trim()) {
        if (body.text.length > 40000) throw new Error("Keep the document text under 40,000 characters.");
        const left = signingVariables(body.text);
        if (left.length) throw new Error(`The edited text still has ${left.map((k) => `{{${k}}}`).join(", ")} in it. Fill it in or remove it.`);
        text = body.text.replace(/\r\n/g, "\n"); edited = text !== rendered;
      }
      if (!title || title.length > 200 || /[\r\n]/.test(title)) throw new Error("Enter a document title up to 200 characters on one line.");
      const letterPdf = await letterPdfModule();
      const bad = await letterPdf.unsupportedText([title, text]);
      if (bad !== null) throw new Error(`Some characters ${bad === title ? "in the title" : "in the text"} cannot be printed in the PDF (the font has no glyph for them): "${bad.slice(0, 80)}". Replace them, or upload a ready-made PDF.`);
      const bytes = (await letterPdf.buildLetterPdf({ title, html: signingHtml(text), letterhead: await loadLetterhead(service), kind: "Document" })).bytes;
      return { profileId, name, email, template, title, rendered, text, edited, values, bytes, variables: signingVariables(`${template.title}\n${template.body}`) };
    };
    // Authorization before generating or storing files, or sending any mail.
    if (action === "preview") {
      const context = await admin("list");
      const made = await prepareDocument(context);
      return json({ pdfBase64: toBase64(made.bytes), title: made.title, text: made.text, templateText: made.rendered, edited: made.edited,
        recipientName: made.name, recipientEmail: made.email, variables: made.variables, templateName: made.template.name });
    }
    if (action === "create") {
      const context = await admin("list");
      let title = String(body.title ?? "").trim(), rendered: string | null = null, templateId: string | null = null, templateText: string | null = null;
      let name = String(body.recipientName ?? "").trim(), email = String(body.recipientEmail ?? "").trim(), profileId: string | null = null, edited = false;
      let values: Record<string, unknown> = {}; let bytes: Uint8Array;
      if (upload) {
        if (!signingNameValid(name) || !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(email)) throw new Error("Enter the recipient's full name and email.");
        if (!title || title.length > 200 || /[\r\n]/.test(title)) throw new Error("Enter a document title up to 200 characters on one line.");
        profileId = typeof body.profileId === "string" && UUID.test(body.profileId) ? body.profileId : null;
        bytes = new Uint8Array(await upload.arrayBuffer());
        const inspected = await (await offerPdfModule()).inspectOfferPdf(bytes); if (!inspected.ok) throw new Error(inspected.error);
      } else {
        const made = await prepareDocument(context);
        ({ title, name, email, profileId, edited, values, bytes } = made);
        rendered = made.text; templateText = made.rendered; templateId = made.template.id;
      }
      const id = crypto.randomUUID(); await storePdf(`${id}/original.pdf`, bytes);
      const record = await admin("create", id, { title, recipient_name: name, recipient_email: email, template_id: templateId,
        rendered_text: rendered, field_values: values, original_hash: await hash(bytes), profile_id: profileId, edited, template_text: edited ? templateText : null });
      stagedPath = null;
      return json(record);
    }
    if (action === "admin_url") {
      const record = await admin("detail", body.id);
      const path = record.signed_path ?? record.original_path;
      await fileBytes(path, record.signed_hash ?? record.original_hash);
      return json({ url: await fileUrl(path) });
    }
    if (action === "send") {
      await admin("detail", body.id);
      if (!provider || !config.siteUrl || !config.from) throw new Error("Signing email is not configured. The draft has been kept.");
      const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const deliveryId = crypto.randomUUID();
      const record = await admin("send", body.id, { token_hash: await hash(new TextEncoder().encode(token)), delivery_id: deliveryId });
      let outcome: { state: string } = { state: "failed" };
      try {
        outcome = await sendTemplateEmail(provider, config, { to: record.recipient_email, deliveryId,
          message: { subject: `Please sign: ${record.title}`, text: `Hello ${record.recipient_name},\n\nPlease review and sign ${record.title}:\n${config.siteUrl}/sign#t=${token}\n\nThis private link expires in 14 days. Please do not forward it.\n\nSkyline Institute of Technology` } });
      } catch { /* Mark failed and invalidate the token, even if the provider response was lost. */ }
      const result = await rpc("signing_service", { p_action: "delivery_result", p_id: record.id, p_data: { delivery_id: deliveryId, state: outcome.state } });
      if (result.stale) throw new Error("The request changed while sending. Refresh its status.");
      if (outcome.state !== "sent") throw new Error("The email could not be confirmed. Send again to issue a new link.");
      return json({ sent: true });
    }
    return json({ error: "Unknown signing action" }, 400);
  } catch (error) {
    if (stagedPath) {
      // A lost RPC response can mean the transaction committed. Never delete a referenced PDF.
      const referenced = await service.rpc("signing_service", { p_action: "path_referenced", p_data: { path: stagedPath } });
      if (!referenced.error && referenced.data === false) await bucket.remove([stagedPath]);
    }
    return json({ error: error instanceof Error ? error.message : "The signing request could not be completed." }, 400);
  }
});
