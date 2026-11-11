// Documents & Signatures: everything the function does, behind injected ports (database RPCs, the private bucket, email), so the same code
// runs in the Edge Function (index.ts) and in the offline tests and the lab. Authorization is in the database: the caller's own RPC
// (public.signing_admin, CMS Admin only) for administrator actions, the service RPC (public.signing_service) for link holders, whose only
// credential is the token of an emailed link. No file is ever reachable by a public URL: links are signed for a few minutes after the
// stored bytes were re-hashed against the recorded sha256.
import { MAX_OFFER_BYTES } from "../_shared/offer-rules.ts";
import type { Letterhead } from "../_shared/letterhead.ts";
import { checkRecipients, fillSigningTemplate, renderSigningEmail, sampleFill, signingHtml, signingNameValid, signingToday, signingVariables, templateVariables, SIGNING_CONSENT,
  type SigningMailJob } from "../_shared/signing.ts";
import { toBase64 } from "../_shared/notification/attachment.ts";
import { templateValues, type TemplatePerson } from "../_shared/hr-template.ts";
import type { EmailProvider } from "../_shared/notification/delivery.ts";
import { outcomeState, type HrMailConfig } from "../_shared/hr-mail.ts";

export class SigningError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export interface RpcError { message: string; code?: string }
export interface SigningPorts {
  /** public.signing_service with the service role. */
  // deno-lint-ignore no-explicit-any
  service(action: string, args?: { hash?: string | null; id?: string | null; data?: unknown }): Promise<any>;
  /** public.signing_admin as the caller (their JWT): the database refuses anyone who is not a CMS Admin. */
  // deno-lint-ignore no-explicit-any
  admin(action: string, id?: string | null, data?: unknown): Promise<any>;
  /** Any other RPC as the caller (the staff record's letter variables, hr_admin_template_values: Admin only in the database). */
  // deno-lint-ignore no-explicit-any
  callerRpc?(name: string, args: Record<string, unknown>): Promise<any>;
  storage: {
    download(path: string): Promise<Uint8Array | null>;
    upload(path: string, bytes: Uint8Array): Promise<boolean>;
    remove(paths: string[]): Promise<void>;
    signedUrl(path: string, seconds: number, downloadName?: string): Promise<string | null>;
  };
  letterhead(): Promise<Letterhead | null>;
  mail: { provider: EmailProvider | null; config: HrMailConfig };
  /** True when the request carries the service-role key itself (the scheduled job). */
  isServiceCaller: boolean;
  uuid(): string;
  /** Runs after the response where the runtime allows it (EdgeRuntime.waitUntil); awaited otherwise. */
  later(work: Promise<unknown>): void | Promise<void>;
}
export interface SigningCall { body: Record<string, unknown>; upload: { name: string; bytes: Uint8Array } | null; ip: string | null; userAgent: string | null }

export const sha256Hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))].map((b) => b.toString(16).padStart(2, "0")).join("");
const TOKEN = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_INVALID = "This signing link is invalid or expired.";
// The PDF engine (pdf-lib + fontkit) loads on the first request that makes, checks or signs a PDF, not at boot.
const letterPdfModule = () => import("../_shared/offer-letter-pdf.ts");
const offerPdfModule = () => import("../_shared/offer-pdf.ts");
const signingPdfModule = () => import("../_shared/signing-pdf.ts");
const safeName = (title: string) => (title.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 80) || "document");

export async function handleSigning(call: SigningCall, ports: SigningPorts): Promise<unknown> {
  const body = { ...call.body };
  // The released single-recipient form (20261110154917, 20261113100000): recipientName / recipientEmail and a staff member's profileId.
  if (typeof body.profileId === "string" && UUID.test(body.profileId) && !body.subjectType) { body.subjectType = "employee"; body.subjectId = body.profileId; }
  if (!Array.isArray(body.recipients) && (body.recipientName || body.recipientEmail)) body.recipients = [{ name: body.recipientName, email: body.recipientEmail }];
  const action = String(body.action ?? "");
  const staged: string[] = [];
  const store = async (path: string, bytes: Uint8Array) => {
    if (!(await ports.storage.upload(path, bytes))) throw new SigningError("The document could not be saved.");
    staged.push(path);
  };
  const fileBytes = async (path: string, expected: string) => {
    const bytes = await ports.storage.download(path);
    if (!bytes) throw new SigningError("The document could not be opened.");
    if (await sha256Hex(bytes) !== expected) throw new SigningError("The document integrity check failed. It was not opened.");
    return bytes;
  };
  const fileUrl = async (path: string, expected: string, name?: string) => {
    await fileBytes(path, expected);
    const url = await ports.storage.signedUrl(path, 300, name);
    if (!url) throw new SigningError("The document link could not be created.");
    return url;
  };
  try {
    // ------------------------------------------------------------------ link holders (no account)
    if (["open", "sign", "decline"].includes(action)) {
      const token = String(body.token ?? "");
      if (!TOKEN.test(token)) throw new SigningError(LINK_INVALID, 403);
      const hash = await sha256Hex(new TextEncoder().encode(token));
      const linkCall = async (name: string, data: unknown = {}) => {
        try { return await ports.service(name, { hash, data }); }
        catch (error) { const e = error as RpcError; if (e.code === "SG409") throw error; throw new SigningError(/invalid or expired/.test(e.message) ? LINK_INVALID : e.message, /invalid or expired/.test(e.message) || e.code === "42501" ? 403 : 400); }
      };
      const record = await linkCall("open", { ip: call.ip });
      if (action === "decline") {
        const after = await linkCall("decline", { reason: String(body.reason ?? "").slice(0, 500) });
        await ports.later(drainSigningMail(ports));
        return { declined: true, state: after.state };
      }
      if (action === "sign") {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (body.agreed !== true || !signingNameValid(name)) throw new SigningError("Enter your full name and tick the agreement.");
        const kind = ["typed", "drawn", "uploaded"].includes(String(body.signatureKind)) ? String(body.signatureKind) : "typed";
        const values = body.values && typeof body.values === "object" ? body.values as Record<string, unknown> : {};
        const [pdf, letter] = await Promise.all([signingPdfModule(), letterPdfModule()]);
        let image: string | null = null, signatureHash: string;
        if (kind === "typed") signatureHash = await sha256Hex(new TextEncoder().encode(name));
        else { const bytes = pdf.signatureImageBytes(body.signatureImage); image = toBase64(bytes); signatureHash = await sha256Hex(bytes); }
        const typed = [name, ...Object.values(values).filter((v): v is string => typeof v === "string" && v !== "true" && v !== "false")];
        if (await letter.unsupportedText(typed)) throw new SigningError("Please use Latin letters for your name and answers on this PDF. You can draw your signature in any script.");
        const data = { signer_name: name, signature_kind: kind, signature_image: image, signature_hash: signatureHash, consent: SIGNING_CONSENT, values,
          document_hash: body.documentHash, ip: call.ip, user_agent: call.userAgent };
        for (let attempt = 0; ; attempt++) {
          // What the document looks like once this person has signed; nothing is written yet.
          const plan = await linkCall("sign_plan", data);
          const original = await fileBytes(plan.original_path, plan.original_hash);
          const stamp = { reference: plan.reference, title: plan.title, fields: plan.fields, recipients: plan.recipients };
          const signed = await pdf.stampDocument(original, stamp);
          const signedHash = await sha256Hex(signed);
          const mine: string[] = [];
          const currentPath = `${plan.id}/signed-${ports.uuid()}.pdf`;
          await store(currentPath, signed); mine.push(currentPath);
          let certificatePath: string | null = null, certificateHash: string | null = null;
          if (plan.complete) {
            const certificate = await pdf.buildCertificate({ ...stamp, id: plan.id, createdAt: plan.created_at, sentAt: plan.sent_at, completedAt: plan.signed_at, signingMode: plan.signing_mode,
              originalHash: plan.original_hash, signedHash, consent: SIGNING_CONSENT, chainOk: plan.chain_ok,
              events: [...plan.events, { event: "signed", at: plan.signed_at, recipient_id: plan.recipient_id }, { event: "completed", at: plan.signed_at }] }, await ports.letterhead());
            certificatePath = `${plan.id}/certificate-${ports.uuid()}.pdf`; certificateHash = await sha256Hex(certificate);
            await store(certificatePath, certificate); mine.push(certificatePath);
          }
          try {
            const after = await ports.service("sign", { hash, data: { ...data, revision: plan.revision, signed_at: plan.signed_at, current_path: currentPath, current_hash: signedHash,
              certificate_path: certificatePath, certificate_hash: certificateHash } });
            staged.length = 0; // Committed: these files are the record now and are never removed on a later error.
            await ports.later(drainSigningMail(ports));
            return { signed: true, complete: after.state === "signed", state: after.state };
          } catch (error) {
            const e = error as RpcError;
            // Someone else signed between the plan and the commit: this copy is out of date, render again from the new state.
            if (e.code === "SG409" && attempt < 3) { await ports.storage.remove(mine); staged.length = 0; continue; }
            throw e.code === "SG409" ? new SigningError("Several people are signing at once. Please select Sign again.") : new SigningError(e.message, e.code === "42501" ? 403 : 400);
          }
        }
      }
      const done = record.state === "signed";
      const path = done ? record.signed_path : record.current_path ?? record.original_path;
      const expected = done ? record.signed_hash : record.current_hash ?? record.original_hash;
      return { id: record.id, reference: record.reference, title: record.title, state: record.state, message: record.message, expiresAt: record.expires_at, signedAt: record.signed_at,
        recipient: record.recipient, fields: record.fields, signers: record.signers, consent: SIGNING_CONSENT, documentHash: record.original_hash,
        url: await fileUrl(path, expected, `${safeName(record.title)}${done ? "-signed" : ""}.pdf`),
        certificateUrl: done && record.certificate_path ? await fileUrl(record.certificate_path, record.certificate_hash, `${safeName(record.title)}-certificate.pdf`) : null };
    }

    // ------------------------------------------------------------------ the schedule (service role) or an administrator: reminders, expiry, queued mail
    if (action === "tick") {
      if (!ports.isServiceCaller) await ports.admin("subject_search", null, { type: "none" });
      const tick = await ports.service("tick");
      return { ...tick, mail: await drainSigningMail(ports) };
    }

    // ------------------------------------------------------------------ administrators. Authorization comes before any file is made or stored.
    const admin = async (operation: string, id: unknown = null, data: unknown = {}) => {
      if (id !== null && !UUID.test(String(id))) throw new SigningError("Not found.", 404);
      try { return await ports.admin(operation, id as string | null, data); }
      catch (error) { const e = error as RpcError; throw new SigningError(e.message, e.code === "42501" ? 403 : 400); }
    };
    /** A template's document for a set of values: a letter from its text, or its PDF. `sample` shows [name] for what is still missing. */
    // deno-lint-ignore no-explicit-any
    const templateDocument = async (template: Record<string, any>, values: Record<string, unknown>, sample: boolean, editedText: unknown = null) => {
      const fill = (source: string) => sample ? sampleFill(source, values) : fillSigningTemplate(source, values);
      const title = fill(String(template.title ?? ""));
      // The administrator may edit the filled text of THIS copy (text templates; the template is untouched): no {{variable}} may remain.
      let text: string | null = null;
      if (template.kind !== "pdf" && typeof editedText === "string" && editedText.trim()) {
        if (editedText.length > 40000) throw new SigningError("Keep the document text under 40,000 characters.");
        const left = signingVariables(editedText);
        if (left.length) throw new SigningError(`The edited text still has ${left.map((k) => `{{${k}}}`).join(", ")} in it. Fill it in or remove it.`);
        text = editedText.replace(/\r\n/g, "\n");
      }
      const senderFields = (Array.isArray(template.fields) ? template.fields : []).map((f: Record<string, unknown>) => f.role === "sender" ? { ...f, value: String(f.value ?? "").trim() ? fill(String(f.value)).trim() : "" } : f);
      if (template.kind === "pdf") return { title, rendered: null as string | null, templateText: null as string | null, edited: false, bytes: await fileBytes(template.source_path, template.source_hash), fields: senderFields };
      const templateText = fill(String(template.body ?? "")), rendered = text ?? templateText;
      const letterPdf = await letterPdfModule();
      const bad = await letterPdf.unsupportedText([title, rendered]);
      if (bad !== null) throw new SigningError(`Some characters ${bad === title ? "in the title" : "in the text"} cannot be printed in the PDF: "${bad.slice(0, 80)}". Replace them, or upload a ready-made PDF.`);
      return { title, rendered, templateText, edited: rendered !== templateText, bytes: (await letterPdf.buildLetterPdf({ title, html: signingHtml(rendered), letterhead: await ports.letterhead(), kind: "Document" })).bytes, fields: senderFields };
    };
    /** The record's values: the signing names (student.*, employee.*, agent.*) and, for an employee, the letter names of HRMS Templates ({{job_title}}…). */
    const subjectValues = async (type: unknown, id: unknown) => {
      if (!type) return null;
      const subject = (await admin("subject_values", id, { type })) as { name: string; email: string; values: Record<string, string> };
      if (type === "employee" && ports.callerRpc) {
        try {
          const letter = templateValues(((await ports.callerRpc("hr_admin_template_values", { p_id: id })) ?? {}) as TemplatePerson);
          subject.values = { ...Object.fromEntries(Object.entries(letter).filter(([, v]) => String(v ?? "").trim())), ...subject.values };
        } catch { /* the signing names still fill */ }
      }
      return subject;
    };
    const inspect = async (bytes: Uint8Array) => {
      const inspected = await (await offerPdfModule()).inspectOfferPdf(bytes);
      if (!inspected.ok) throw new SigningError(inspected.error.replaceAll("offer letter", "document"));
      return inspected.pages;
    };

    if (action === "template_upload") {
      await admin("subject_search", null, { type: "none" });
      if (!call.upload) throw new SigningError("Choose a PDF to upload.");
      const pages = await inspect(call.upload.bytes);
      const id = UUID.test(String(body.id ?? "")) ? String(body.id) : ports.uuid();
      const path = `templates/${id}/source-${ports.uuid()}.pdf`;
      await store(path, call.upload.bytes);
      const saved = await admin("template_save", id, { ...(body.template as Record<string, unknown> ?? {}), kind: "pdf", source_path: path, source_hash: await sha256Hex(call.upload.bytes), source_pages: pages });
      staged.length = 0;
      return saved;
    }
    if (action === "template_duplicate") {
      const context = await admin("list");
      const template = context.templates.find((t: { id: string }) => t.id === body.id);
      if (!template) throw new SigningError("Template not found.", 404);
      const newId = ports.uuid(); let path: string | null = null;
      if (template.kind === "pdf") { path = `templates/${newId}/source-${ports.uuid()}.pdf`; await store(path, await fileBytes(template.source_path, template.source_hash)); }
      const saved = await admin("template_duplicate", template.id, { new_id: newId, source_path: path });
      staged.length = 0;
      return saved;
    }
    if (action === "template_preview") {
      // A saved template, or the one being edited (text only): the populated document, never stored.
      let template = body.template as Record<string, unknown> | undefined;
      if (body.id) { const context = await admin("list"); template = context.templates.find((t: { id: string }) => t.id === body.id); }
      else await admin("subject_search", null, { type: "none" });
      if (!template) throw new SigningError("Template not found.", 404);
      if (!body.id && template.kind === "pdf") throw new SigningError("Save the PDF template before previewing it.");
      const subject = await subjectValues(body.subjectType, body.subjectId);
      const values = { current_date: signingToday(), ...(subject?.values ?? {}), ...(body.values && typeof body.values === "object" ? body.values : {}) };
      const made = await templateDocument(template, values, true);
      const sender = made.fields.filter((f: Record<string, unknown>) => f.role === "sender").map((f: Record<string, unknown>) => ({ ...f, recipient_id: null, done: true })) as unknown as import("../_shared/signing-pdf.ts").StampField[];
      const bytes = sender.length ? await (await signingPdfModule()).stampDocument(made.bytes, { reference: "PREVIEW", title: made.title, fields: sender, recipients: [] }) : made.bytes;
      return { title: made.title, pdfBase64: toBase64(bytes), variables: templateVariables(template as never), values };
    }
    if (action === "template_url") {
      const context = await admin("list");
      const template = context.templates.find((t: { id: string }) => t.id === body.id);
      if (!template || template.kind !== "pdf") throw new SigningError("Template not found.", 404);
      return { url: await fileUrl(template.source_path, template.source_hash) };
    }
    if (action === "preview") {
      // The released compose flow (20261113100000): the PDF exactly as it will be sent, the filled text and the template's own render.
      const context = await admin("list");
      const recipients = checkRecipients(body.recipients);
      const template = context.templates.find((t: { id: string; status: string }) => t.id === body.templateId && t.status === "active");
      if (!template) throw new SigningError("Choose a saved template or upload a PDF.");
      const subject = await subjectValues(body.subjectType, body.subjectId);
      const values = { current_date: signingToday(), ...(subject?.values ?? {}), ...(typeof body.values === "object" && body.values ? body.values : {}), full_name: recipients[0].name, email: recipients[0].email };
      const made = await templateDocument(template, values, false, body.text);
      return { pdfBase64: toBase64(made.bytes), title: made.title, text: made.rendered, templateText: made.templateText, edited: made.edited,
        recipientName: recipients[0].name, recipientEmail: recipients[0].email, variables: templateVariables(template), templateName: template.name };
    }
    if (action === "create") {
      const context = await admin("list");
      const recipients = checkRecipients(body.recipients);
      const subject = await subjectValues(body.subjectType, body.subjectId);
      let title = String(body.title ?? "").trim(), rendered: string | null = null, templateId: string | null = null, category = String(body.category ?? "other");
      let values: Record<string, unknown> = {}; let bytes: Uint8Array; let fields: Array<Record<string, unknown>> = [];
      let edited = false, templateText: string | null = null;
      const options: Record<string, unknown> = { signing_mode: body.signingMode === "parallel" ? "parallel" : "sequential" };
      if (call.upload) {
        bytes = call.upload.bytes;
        await inspect(bytes);
      } else {
        const template = context.templates.find((t: { id: string; status: string }) => t.id === body.templateId && t.status === "active");
        if (!template) throw new SigningError("Choose a saved template or upload a PDF.");
        // The record's own values first, then what the administrator typed (a correction wins), and the two first-stage names.
        values = { current_date: signingToday(), ...(subject?.values ?? {}), ...(typeof body.values === "object" && body.values ? body.values : {}), full_name: recipients[0].name, email: recipients[0].email };
        const made = await templateDocument(template, values, false, body.text);
        title = made.title; rendered = made.rendered; bytes = made.bytes; templateId = template.id; category = template.category;
        edited = made.edited; templateText = made.templateText;
        // What the sender prints on a PDF template (its variables) becomes part of the document itself, before anyone sees or signs it.
        const printed = made.fields.filter((f: Record<string, unknown>) => f.role === "sender" && f.value).map((f: Record<string, unknown>) => ({ ...f, recipient_id: null, done: true })) as unknown as import("../_shared/signing-pdf.ts").StampField[];
        if (printed.length) bytes = await (await signingPdfModule()).stampDocument(bytes, { reference: "", title, fields: printed, recipients: [] });
        fields = made.fields.filter((f: Record<string, unknown>) => recipients.some((r) => r.role === f.role));
        options.signing_mode = body.signingMode ? options.signing_mode : template.signing_mode;
        options.expiry_days = body.expiryDays ?? template.expiry_days; options.reminder_days = body.reminderDays ?? template.reminder_days;
      }
      if (!title || title.length > 200 || /[\r\n]/.test(title)) throw new SigningError("Enter a document title up to 200 characters on one line.");
      const id = ports.uuid();
      await store(`${id}/original.pdf`, bytes);
      const record = await admin("create", id, { title, template_id: templateId, rendered_text: rendered, field_values: values, original_hash: await sha256Hex(bytes), recipients, fields,
        subject_type: body.subjectType ?? null, subject_id: body.subjectId ?? null, category, message: body.message ?? null, edited, template_text: edited ? templateText : null,
        expiry_days: body.expiryDays ?? undefined, reminder_days: body.reminderDays ?? undefined, ...options });
      staged.length = 0;
      return record;
    }
    if (action === "admin_url") {
      const record = await admin("detail", body.id);
      const which = String(body.which ?? "document");
      if (which === "certificate") {
        if (!record.certificate_path) throw new SigningError("The certificate is made when everyone has signed.");
        return { url: await fileUrl(record.certificate_path, record.certificate_hash, `${safeName(record.title)}-certificate.pdf`) };
      }
      if (which === "original") return { url: await fileUrl(record.original_path, record.original_hash, `${safeName(record.title)}.pdf`) };
      const path = record.signed_path ?? record.current_path ?? record.original_path;
      return { url: await fileUrl(path, record.signed_hash ?? record.current_hash ?? record.original_hash, `${safeName(record.title)}${record.signed_path ? "-signed" : ""}.pdf`) };
    }
    if (action === "verify") {
      // Tamper check: the history chain in the database, and every stored file against the hash recorded when it was made.
      const record = await admin("detail", body.id);
      const files = [["Original document", record.original_path, record.original_hash], ["Signed document", record.signed_path ?? record.current_path, record.signed_hash ?? record.current_hash],
        ["Completion certificate", record.certificate_path, record.certificate_hash]].filter((f) => f[1]);
      const checked = [];
      for (const [name, path, expected] of files) {
        const bytes = await ports.storage.download(path);
        checked.push({ name, ok: !!bytes && await sha256Hex(bytes) === expected, sha256: expected });
      }
      return { chainOk: record.chain_ok === true, files: checked, ok: record.chain_ok === true && checked.every((f) => f.ok) };
    }
    if (action === "send" || action === "resend") {
      await admin("detail", body.id);
      if (!ports.mail.provider || !ports.mail.config.siteUrl || !ports.mail.config.from) throw new SigningError("Signing email is not configured, so nothing was sent. The request was kept as it is.");
      const record = await admin(action, body.id, action === "resend" ? { recipient_id: body.recipientId } : {});
      const mail = await drainSigningMail(ports);
      return { ...record, mail };
    }
    if (action === "void") {
      const record = await admin("void", body.id, { reason: body.reason ?? "" });
      await ports.later(drainSigningMail(ports));
      return record;
    }
    throw new SigningError("Unknown signing action");
  } catch (error) {
    for (const path of staged) {
      // A lost RPC response can mean the transaction committed. Never delete a referenced PDF.
      try { if (await ports.service("path_referenced", { data: { path } }) === false) await ports.storage.remove([path]); } catch { /* left for a later clean-up */ }
    }
    if (error instanceof SigningError) throw error;
    throw new SigningError((error as RpcError)?.message || "The signing request could not be completed.", (error as RpcError)?.code === "42501" ? 403 : 400);
  }
}

/**
 * Sends queued signing mail. Each job is claimed with a lease and has a unique key in the database, so two runs never send the same email;
 * a job for a request that has closed is cancelled by the claim itself. Sending off: nothing is claimed and the jobs wait.
 */
export async function drainSigningMail(ports: SigningPorts, limit = 20): Promise<{ sent: number; failed: number; requeued: number }> {
  const totals = { sent: 0, failed: 0, requeued: 0 };
  const { provider, config } = ports.mail;
  if (!provider || !config.from || !config.siteUrl) return totals;
  // deno-lint-ignore no-explicit-any
  let jobs: Array<SigningMailJob & Record<string, any>>;
  try { jobs = await ports.service("notify_claim", { data: { limit } }); } catch { return totals; }
  for (const job of jobs ?? []) {
    const result = async (state: string, messageId?: string, error?: string) => {
      try { await ports.service("notify_result", { data: { id: job.id, state, message_id: messageId ?? null, error: error ?? null } }); } catch { /* the lease expires and the job is retried */ }
      if (state === "sent") totals.sent++; else if (state === "queued") totals.requeued++; else totals.failed++;
    };
    try {
      const to = job.audience === "admin" ? (job.sender_email || config.adminTo.join(", ")) : job.to;
      const message = renderSigningEmail(job, job.token ? `${config.siteUrl}/sign#t=${job.token}` : null);
      if (!to || !message) { await result("failed", undefined, !to ? "no recipient address" : "no template"); continue; }
      let attachments: Array<{ name: string; contentType: string; contentBase64: string }> | undefined;
      if (job.kind === "completed") {
        // This email exists to deliver the signed PDF: a missing or changed file is not sent (failed, visible to the administrator).
        const files: Array<[string, string, string]> = [[job.signed_path, job.signed_hash, `${safeName(job.title)}-signed.pdf`], [job.certificate_path, job.certificate_hash, `${safeName(job.title)}-certificate.pdf`]];
        attachments = [];
        for (const [path, expected, name] of files) {
          const bytes = path ? await ports.storage.download(path) : null;
          if (!bytes || await sha256Hex(bytes) !== expected) { attachments = undefined; break; }
          attachments.push({ name, contentType: "application/pdf", contentBase64: toBase64(bytes) });
        }
        if (!attachments || attachments.reduce((n, a) => n + a.contentBase64.length, 0) > 9_000_000) { await result("failed", undefined, "the signed PDF could not be attached"); continue; }
      }
      const outcome = outcomeState(await provider.send({ deliveryId: `sign-${job.id}`, from: config.from, to, subject: message.subject, textBody: message.text, ...(attachments ? { attachments } : {}) }));
      await result(outcome.state, outcome.messageId, outcome.error);
    } catch (error) {
      await result("queued", undefined, String((error as Error)?.message ?? error).slice(0, 200));
    }
  }
  return totals;
}

/** Bounded read of the request body, even when Content-Length is omitted. JSON, or multipart with "data" (JSON) and "file". */
export async function readSigningRequest(req: Request): Promise<{ body: Record<string, unknown>; upload: SigningCall["upload"] }> {
  const reader = req.body?.getReader();
  if (!reader) throw new SigningError("Request body required");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > MAX_OFFER_BYTES + 512 * 1024) { await reader.cancel(); throw new SigningError("Document is too large", 413); }
    chunks.push(part.value);
  }
  const raw = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  const parsed = new Response(raw, { headers: { "Content-Type": req.headers.get("content-type") ?? "application/json" } });
  try {
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await parsed.formData();
      const file = form.get("file");
      return { body: JSON.parse(String(form.get("data") ?? "{}")), upload: file instanceof File ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null };
    }
    const body = await parsed.json();
    if (!body || typeof body !== "object") throw new Error("not an object");
    return { body, upload: null };
  } catch { throw new SigningError("The request could not be read."); }
}
