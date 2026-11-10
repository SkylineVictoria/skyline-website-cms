// Staff administration actions that need more than one database call or an email (verify_jwt = true). Runtime-neutral and
// injectable (tested offline). Every hr_admin_* call runs with the CALLER's JWT, so hr.require_admin() decides who may act;
// service-role calls are limited to logging email outcomes and draining the outbox.
//
// Link emails (HR-02d): the function makes a random token, passes only its sha256 to hr_admin_staff_invite (which replaces any
// earlier link of that kind) and sends the link inline. The token is never stored. If the send fails, that link is cancelled at
// once (hr_admin_staff_invite_cancel): no valid link exists that nobody received, the failure is logged for the admin, and
// "send again" makes exactly one new live link. An expired link is resent the same way. With sending switched off the link is
// returned to the admin once to pass on.
import type { HrMailConfig } from "../_shared/hr-mail.ts";
import { MAX_RESUME_BYTES, RESUME_TYPES, detectResume, safeFilename } from "../_shared/resume-file.ts";
import { builtInLoginEmail } from "../_shared/hr-mail.ts";
import { longDate, placeholderLabels, renderMessage, templateValues, type RenderedMessage, type TemplatePerson, type TemplateSource, type TemplateType } from "../_shared/hr-template.ts";
import { letterFileName } from "../_shared/offer-letter-pdf.ts";
//
// Onboarding flow (2026-11-10): `send_documents` is "Send document link" on the employee page (a Careers applicant is hired for their
// open job application, anyone else gets the plain link). Document and re-upload emails use the HRMS template of that kind when one
// exists (HRMS > Templates). `offer_generate` fills an offer letter template for the person, refuses while a placeholder has no
// value, makes the PDF and records it with the rendered HTML. `offer_send_login` sends the offer with the person's login: a login is
// created when none exists (unconfirmed, with no password anyone knows: it cannot sign in), the database marks the offer sent and records a one-time set-password
// link (hash only, 7 days), and ONE email carries the link. A failed email on the first send undoes everything (offer unsent, links
// revoked, the login made for it deleted); nothing half-made is left. `resend_login` emails a new one-time link while no password
// has been chosen. No password is ever generated, stored, logged or shown.
//
// Candidates (HR-02j): `hire` ("Hire and send document link", from the selected stage) lets the database mark the job application
// hired, write the employment record from the job and make the document link, then mails it like send_invite; the person is learned
// from the result. `candidate_file` stores a manual candidate's resume or cover letter after the same content checks as the public
// form (admin and state first, with the caller's JWT; service-role storage; recorded as the caller).
//
// Offers (HR-02e): offer_upload checks the PDF by content (pdf-lib must load AND modify it; encrypted or protected files are
// refused with a clear message) BEFORE anything is stored, stores it under {profile}/offer/ with the service role, and records
// it (with its sha256) through hr_admin_staff_offer_add as the caller; a refusal removes the stored file, and an unsent offer it
// replaces is deleted. offer_send works like a document link (purpose offer, 30 days). offer_withdraw needs a note.

export const ACTIONS = ["send_invite", "revoke_invite", "reject", "retry_email", "drain", "offer_upload", "offer_send", "offer_withdraw", "activate", "resend_activation", "purge", "add", "hire", "candidate_file", "send_documents", "offer_generate", "offer_send_login", "resend_login"] as const;
export type AdminAction = (typeof ACTIONS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LoginInfo { id: string; confirmed: boolean; invited: boolean; signedIn: boolean }
type LinkKind = "document_invite" | "reupload_invite" | "offer";
type LinkPurpose = "documents" | "reupload" | "offer";
export interface AdminResult { status: number; body: Record<string, unknown> }
type DbError = { code?: string; message?: string } | null;
export interface AdminDeps {
  /** hr_admin_* with the caller's JWT. */
  adminRpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: DbError }>;
  /** hr_svc_* with the service role (email log). */
  serviceRpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: DbError }>;
  newLink(): Promise<{ token: string; hash: string }>;
  config: HrMailConfig;
  sendLink(mail: { kind: LinkKind; to: string; name: string; link: string; expiresAt: string; rejected?: Array<{ category: string; note: string }>; deliveryId: string; rendered?: RenderedMessage | null }):
    Promise<{ state: "sent" | "failed" | "skipped"; messageId?: string; error?: string }>;
  /** The HRMS template to send for a kind of email (a chosen one, else the default) with the person's raw values; template null = none. */
  templateMail?(profileId: string, type: TemplateType, templateId?: string | null): Promise<{ template: (TemplateSource & { id: string; name: string }) | null; values: TemplatePerson } | null>;
  /** A template email sent inline (offer + sign-in link, new sign-in link). */
  sendTemplate?(mail: { to: string; message: { subject: string; text: string; html?: string }; deliveryId: string }): Promise<{ state: "sent" | "failed" | "skipped"; messageId?: string; error?: string }>;
  /** The one-time set-password page for a token. */
  accountUrl?(token: string): string;
  /** Auth (service role): a new, unconfirmed login for this email with no password anyone knows (it cannot sign in until the person sets one). */
  createLogin?(email: string, name: string): Promise<{ userId: string | null; error: string | null }>;
  /** Auth (service role): removes a login this request created. */
  deleteLogin?(userId: string): Promise<void>;
  /** The filled-in letter as a PDF (pdf-lib). */
  letterPdf?(input: { title: string; html: string; footer: string }): Promise<{ bytes: Uint8Array; pages: number }>;
  linkUrl(purpose: LinkPurpose, token: string): string;
  /** Auth (service role): the single login for an email, or null. */
  findLogin(email: string): Promise<{ login: LoginInfo | null; error: string | null }>;
  /** Auth invite (Supabase "Invite user" template) with the password-setup link to redirectTo; returns the new or re-invited login. */
  inviteLogin(email: string, name: string, redirectTo: string): Promise<{ userId: string | null; error: string | null }>;
  /** Retention (purge): true only for a verified service_role token of this project (the scheduled job), never a person. */
  isWorker?: boolean;
  /** EF_HR_RETENTION_MONTHS (1-120, default 6). */
  retentionMonths?: number;
  /** Deletes storage objects; resolves with an error text when the storage call failed (then nothing is marked). */
  purgeFiles?(paths: string[]): Promise<{ error: string | null }>;
  /** The uploaded file (multipart offer_upload / candidate_file), or null. */
  file?: { name: string; bytes: Uint8Array } | null;
  /** pdf-lib check of an offer (load and modify in memory). */
  inspectOffer(bytes: Uint8Array): Promise<{ ok: true; pages: number } | { ok: false; error: string }>;
  /** Service-role storage in the private staff-documents bucket. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: string | null }>;
  remove(paths: string[]): Promise<void>;
  sha256(bytes: Uint8Array): Promise<string>;
  newId(): string;
  /** Sends queued outbox mail now (best effort). */
  drain(): Promise<{ sent: number; failed: number; requeued: number }>;
}

function fromDb(error: NonNullable<DbError>): AdminResult {
  if (error.code === "42501") return { status: 403, body: { error: error.message || "Only an administrator can do this." } };
  if (["23514", "22023", "P0002", "23505"].includes(error.code ?? "")) return { status: 400, body: { error: error.message || "That could not be done." } };
  return { status: 500, body: { error: "Something went wrong. Please try again shortly." } };
}

/** A safe display name for the offer file (no path, no control characters, ends in .pdf). */
export function offerName(name: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from a user-supplied file name
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "offer-letter";
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

export async function handleAdmin(body: Record<string, unknown>, deps: AdminDeps): Promise<AdminResult> {
  const action = String(body.action ?? "");
  if (!(ACTIONS as readonly string[]).includes(action)) return { status: 400, body: { error: "Unknown action." } };
  const profileId = typeof body.profileId === "string" && UUID.test(body.profileId) ? body.profileId : null;
  const applicationId = typeof body.applicationId === "string" && UUID.test(body.applicationId) ? body.applicationId : null;
  const byCandidate = action === "hire" || action === "candidate_file";
  if (byCandidate && !applicationId) return { status: 400, body: { error: "Choose a candidate." } };
  if (!byCandidate && action !== "drain" && action !== "retry_email" && action !== "purge" && action !== "add" && !profileId) return { status: 400, body: { error: "Choose an application." } };

  // Makes a link (only its hash reaches the database through `rpc`), emails it inline, logs the outcome without the token, and
  // cancels that link at once when the email failed. Shared by document, re-upload, offer and hire links. The person is `pid`, or,
  // when the caller does not know them yet (hire: a candidate application id), the profileId the database answers with.
  const sendLinkFlow = async (purpose: LinkPurpose, rpc: string, args: Record<string, unknown>, pid: string | null = profileId): Promise<AdminResult> => {
    if (!deps.config.siteUrl) return { status: 503, body: { error: "Links cannot be sent: EF_HR_PUBLIC_SITE_URL is not set.", code: "configuration_unavailable" } };
    const link = await deps.newLink();
    const made = await deps.adminRpc(rpc, { ...args, p_token_hash: link.hash });
    if (made.error) return fromDb(made.error);
    const invite = made.data as { invite: { id: string; expiresAt: string }; email: string; name: string; rejected?: Array<{ category: string; note: string }>; profileId?: string };
    const owner = pid ?? (typeof invite.profileId === "string" && UUID.test(invite.profileId) ? invite.profileId : null);
    const kind: LinkKind = purpose === "documents" ? "document_invite" : purpose === "reupload" ? "reupload_invite" : "offer";
    const url = deps.linkUrl(purpose, link.token);
    // The HRMS template for this email (document request / re-upload), filled for the person; none = the built-in text. A template
    // that cannot be filled completely is not sent: it counts as a failed email (the link is cancelled, the admin sees why).
    let rendered: RenderedMessage | null = null;
    let templateError: string | null = null;
    const type: TemplateType | null = purpose === "documents" ? "document_request" : purpose === "reupload" ? "document_reupload" : null;
    if (type && owner && deps.templateMail) {
      const mail = await deps.templateMail(owner, type).catch(() => null);
      if (mail?.template) {
        rendered = renderMessage(mail.template, templateValues(mail.values ?? {}, { document_link: url, link_expiry: longDate(invite.invite.expiresAt), login_url: `${deps.config.siteUrl}/login`,
          rejected_documents: (invite.rejected ?? []).map((r) => `${r.category}: ${r.note}`).join("\n") }));
        const gaps = [...rendered.missing, ...rendered.unknown];
        if (gaps.length) templateError = `the "${mail.template.name}" template needs ${placeholderLabels(gaps)}, which this person does not have yet`;
      }
    }
    const sent = templateError ? { state: "failed" as const, error: templateError, messageId: undefined }
      : await deps.sendLink({ kind, to: invite.email, name: invite.name, link: url, expiresAt: invite.invite.expiresAt, rejected: invite.rejected, deliveryId: `hr-invite-${invite.invite.id}`, rendered });
    // The log never holds the token or the link: only which invite it was and what happened.
    await deps.serviceRpc("hr_svc_email_log", { p_profile: owner, p_kind: kind, p_state: sent.state, p_message_id: sent.messageId ?? null, p_error: sent.error ?? null,
      p_payload: { inviteId: invite.invite.id, purpose, expiresAt: invite.invite.expiresAt } });
    if (sent.state === "failed") {
      const cancelled = await deps.adminRpc("hr_admin_staff_invite_cancel", { p_id: owner, p_invite: invite.invite.id });
      return { status: 502, body: { emailSent: false, linkCancelled: !cancelled.error, error: `The email could not be sent (${sent.error ?? "error"}). The link was cancelled; use Send again.`, detail: cancelled.data ?? null, profileId: owner } };
    }
    if (sent.state === "skipped") {
      // Sending is off: hand the link to the admin ONCE to pass on themselves. It is not stored anywhere.
      return { status: 200, body: { emailSent: false, link: url, expiresAt: invite.invite.expiresAt, note: "Email sending is switched off. Copy this link now; it is not shown again.", profileId: owner } };
    }
    return { status: 200, body: { emailSent: true, expiresAt: invite.invite.expiresAt, profileId: owner } };
  };

  // offer_signed > active. The database checks first (role, joining date, Admin confirmation, status) and says whether a
  // CONFIRMED login already uses the email. That login (a student or agent) is linked and active at once, and HR emails "your
  // staff access is ready" (no Auth email). Otherwise the person gets the Supabase Auth invite (account_type "staff" for the
  // shared Invite user template) to /staff/welcome; the login is recorded, and they become active when they set a password there
  // (hr_staff_claim_account). A failed invite changes nothing; a resend re-invites the same, never-used login (new link).
  const activateFlow = async (role: "admin" | "trainer", joiningDate: string, confirmAdmin: boolean, resend: boolean): Promise<AdminResult> => {
    const args = { p_id: profileId, p_role: role, p_joining_date: joiningDate, p_confirm_admin: confirmAdmin };
    const checked = await deps.adminRpc("hr_admin_staff_activate_account", { ...args, p_auth_user_id: null });
    if (checked.error) return fromDb(checked.error);
    const { email, name, existingLogin } = checked.data as { email: string; name: string; existingLogin: boolean };
    const found = await deps.findLogin(email);
    if (found.error) return { status: 503, body: { error: "The login could not be checked. Please try again shortly." } };
    if (existingLogin) {
      if (resend) return { status: 400, body: { error: "This person already has a confirmed login; activate them instead." } };
      if (!found.login?.confirmed) return { status: 409, body: { error: "The login for this email changed. Please try again." } };
      const done = await deps.adminRpc("hr_admin_staff_activate_account", { ...args, p_auth_user_id: found.login.id });
      if (done.error) return fromDb(done.error);
      await deps.drain().catch(() => undefined);
      return { status: 200, body: { activated: true, inviteSent: false, existingLogin: true, detail: (done.data as { detail?: unknown }).detail } };
    }
    if (found.login && !(found.login.invited && !found.login.signedIn)) {
      return { status: 400, body: { error: "A login for this email exists but has not confirmed its email. Ask the person to confirm it (or remove that login), then activate again." } };
    }
    if (resend && !found.login) return { status: 400, body: { error: "There is no activation invite waiting for this person." } };
    if (!deps.config.siteUrl) return { status: 503, body: { error: "The invitation cannot be sent: EF_HR_PUBLIC_SITE_URL is not set.", code: "configuration_unavailable" } };
    const invited = await deps.inviteLogin(email, name, `${deps.config.siteUrl}/staff/welcome`);
    if (invited.error || !invited.userId) {
      return { status: 502, body: { inviteSent: false, error: `The invitation email could not be sent (${invited.error ?? "error"}). Nothing was changed; try again.` } };
    }
    const recorded = await deps.adminRpc("hr_admin_staff_activate_account", { ...args, p_auth_user_id: invited.userId });
    if (recorded.error) return fromDb(recorded.error);
    return { status: 200, body: { activated: false, inviteSent: true, existingLogin: false, resent: resend, detail: (recorded.data as { detail?: unknown }).detail } };
  };

  // The offer letter with the person's login, or a new sign-in link ("Resend login"). See the notes at the top of this file.
  const loginEmail = async (kind: "offer" | "login_link", templateId: string | null, links: Record<string, string>):
    Promise<{ ok: true; message: { subject: string; text: string; html?: string } } | { ok: false; result: AdminResult }> => {
    const mail = deps.templateMail ? await deps.templateMail(profileId!, kind === "offer" ? "offer_email" : "welcome_login", templateId).catch(() => null) : null;
    const values = templateValues(mail?.values ?? {}, links);
    if (!mail?.template) {
      if (templateId) return { ok: false, result: { status: 400, body: { error: "That email template was not found. Choose another one." } } };
      return { ok: true, message: builtInLoginEmail(kind, values) };
    }
    const rendered = renderMessage(mail.template, values);
    const gaps = [...rendered.missing, ...rendered.unknown];
    if (gaps.length) {
      return { ok: false, result: { status: 400, body: { error: `The "${mail.template.name}" email template needs ${placeholderLabels(gaps)}, which this person does not have yet. Fix the template or the person's details. Nothing was sent.`, missing: gaps } } };
    }
    return { ok: true, message: { subject: rendered.subject, text: rendered.text, html: rendered.html } };
  };

  switch (action as AdminAction) {
    case "send_documents":
      // "Send document link" on the employee page: the database hires an open job application (as Candidates does) or makes the
      // plain document link; the email, log and cancel rules are send_invite's.
      return sendLinkFlow("documents", "hr_admin_onboarding_documents_invite", { p_id: profileId });
    case "offer_generate": {
      const templateId = typeof body.templateId === "string" && UUID.test(body.templateId) ? body.templateId : null;
      if (!templateId) return { status: 400, body: { error: "Choose an offer letter template." } };
      if (!deps.letterPdf) return { status: 503, body: { error: "Offer letters cannot be made here." } };
      // Admin, state and everything the letter needs, with the caller's JWT: nothing is rendered or stored otherwise.
      const context = await deps.adminRpc("hr_admin_offer_letter_context", { p_id: profileId });
      if (context.error) return fromDb(context.error);
      const ctx = context.data as { problem: string | null; values: TemplatePerson; templates: Array<TemplateSource & { id: string; type: string; name: string }> };
      if (ctx.problem) return { status: 400, body: { error: ctx.problem } };
      const template = ctx.templates.find((t) => t.id === templateId && t.type === "offer_letter");
      if (!template) return { status: 400, body: { error: "That offer letter template was not found. Choose another one." } };
      const values = templateValues(ctx.values ?? {});
      const letter = renderMessage(template, values);
      const gaps = [...letter.missing, ...letter.unknown];
      if (gaps.length) {
        return { status: 400, body: { error: `The letter cannot be made yet: ${placeholderLabels(gaps)} ${gaps.length === 1 ? "has" : "have"} no value for this person. Add ${gaps.length === 1 ? "it" : "them"} in the pay details, or use another template.`, missing: gaps } };
      }
      let pdf: { bytes: Uint8Array; pages: number };
      try { pdf = await deps.letterPdf({ title: letter.subject, html: letter.html, footer: values.company_name }); }
      catch (e) { return { status: 400, body: { error: e instanceof Error && /^The letter/.test(e.message) ? e.message : "The letter could not be made into a PDF. Simplify the template and try again." } }; }
      // The same checks as an uploaded offer, so signing it later cannot fail on the file.
      const checked = await deps.inspectOffer(pdf.bytes);
      if (!checked.ok) return { status: 400, body: { error: checked.error } };
      const sha256 = await deps.sha256(pdf.bytes);
      const path = `${profileId}/offer/${deps.newId()}.pdf`;
      const stored = await deps.upload(path, pdf.bytes, "application/pdf");
      if (stored.error) return { status: 503, body: { error: "The letter could not be stored. Please try again." } };
      const added = await deps.adminRpc("hr_admin_offer_letter_add", { p_id: profileId, p_path: path, p_filename: letterFileName(letter.subject, values.full_name), p_size: pdf.bytes.length,
        p_sha256: sha256, p_template: template.id, p_title: letter.subject, p_html: letter.html, p_values: values });
      if (added.error) { await deps.remove([path]); return fromDb(added.error); }
      const result = added.data as { offer: unknown; replacedPath?: string | null };
      if (result.replacedPath) await deps.remove([result.replacedPath]);
      return { status: 200, body: { offer: result.offer, pages: pdf.pages, title: letter.subject, templateName: template.name } };
    }
    case "offer_send_login": {
      if (!deps.config.siteUrl) return { status: 503, body: { error: "The offer cannot be sent: EF_HR_PUBLIC_SITE_URL is not set.", code: "configuration_unavailable" } };
      if (!deps.sendTemplate || !deps.accountUrl || !deps.createLogin || !deps.deleteLogin) return { status: 503, body: { error: "Offers cannot be sent here." } };
      const templateId = typeof body.emailTemplateId === "string" && UUID.test(body.emailTemplateId) ? body.emailTemplateId : null;
      // Admin and state first, with the caller's JWT.
      const before = await deps.adminRpc("hr_admin_staff_detail", { p_id: profileId });
      if (before.error) return fromDb(before.error);
      const person = (before.data as { profile?: { status?: string; email?: string; first_name?: string; last_name?: string } }).profile ?? {};
      if (person.status !== "documents_submitted" && person.status !== "offer_sent") return { status: 400, body: { error: "An offer can be sent after the documents are submitted." } };
      const email = String(person.email ?? "");
      const name = [person.first_name, person.last_name].filter(Boolean).join(" ");
      // The email is checked before anything is created: a template that cannot be filled stops here.
      const trial = await loginEmail("offer", templateId, { signing_link: "https://example.invalid", login_url: `${deps.config.siteUrl}/login`, link_expiry: "1 January 2000" });
      if (!trial.ok) return trial.result;
      // The login: the one this email already has, or a new one without a password.
      const found = await deps.findLogin(email);
      if (found.error) return { status: 503, body: { error: "The login could not be checked. Please try again shortly." } };
      let userId = found.login?.id ?? null;
      let created = false;
      if (!userId) {
        const made = await deps.createLogin(email, name);
        if (made.error || !made.userId) return { status: 502, body: { error: `The login could not be created (${made.error ?? "error"}). Nothing was sent and nothing was changed.` } };
        userId = made.userId; created = true;
      }
      const needsPassword = !found.login?.confirmed;
      const link = needsPassword ? await deps.newLink() : null;
      const sentOffer = await deps.adminRpc("hr_admin_onboarding_offer_send", { p_id: profileId, p_auth_user_id: userId, p_account_hash: link?.hash ?? null });
      if (sentOffer.error) { if (created) await deps.deleteLogin(userId).catch(() => undefined); return fromDb(sentOffer.error); }
      const made = sentOffer.data as { firstSend: boolean; needsPassword: boolean; expiresAt: string | null; invite: { id: string } | null; offer: { id: string } };
      const signingLink = link ? deps.accountUrl(link.token) : `${deps.config.siteUrl}/login?next=%2Fstaff`;
      const composed = await loginEmail("offer", templateId, { signing_link: signingLink, login_url: `${deps.config.siteUrl}/login`,
        link_expiry: longDate(made.expiresAt ?? new Date(Date.now() + 30 * 86400_000).toISOString()) });
      const sent = composed.ok ? await deps.sendTemplate({ to: email, message: composed.message, deliveryId: `hr-offer-${made.offer.id}-${deps.newId().slice(0, 8)}` })
        : { state: "failed" as const, error: String(composed.result.body.error ?? "the email template could not be filled"), messageId: undefined };
      // The log never holds the token or the link.
      await deps.serviceRpc("hr_svc_email_log", { p_profile: profileId, p_kind: "offer", p_state: sent.state, p_message_id: sent.messageId ?? null, p_error: sent.error ?? null,
        p_payload: { offerId: made.offer.id, withLogin: true, setPasswordLink: Boolean(link), expiresAt: made.expiresAt } });
      if (sent.state === "failed") {
        if (made.firstSend) {
          // Nothing reached the person: put everything back, and remove the login this request made.
          const undone = await deps.adminRpc("hr_admin_onboarding_offer_unsend", { p_id: profileId, p_unlink: created });
          if (created && !undone.error) await deps.deleteLogin(userId).catch(() => undefined);
          return { status: 502, body: { emailSent: false, rolledBack: !undone.error, error: undone.error
            ? `The email could not be sent (${sent.error ?? "error"}) and the offer could not be put back automatically. Withdraw the offer, then send it again.`
            : `The email could not be sent (${sent.error ?? "error"}). Nothing went out and nothing was changed: the offer is not sent and no login was left behind. Fix the problem and send it again.` } };
        }
        if (made.invite) await deps.adminRpc("hr_admin_staff_invite_cancel", { p_id: profileId, p_invite: made.invite.id });
        return { status: 502, body: { emailSent: false, error: `The email could not be sent (${sent.error ?? "error"}). The offer is still out; the new sign-in link was cancelled. Use Resend login.` } };
      }
      if (sent.state === "skipped") {
        return { status: 200, body: { emailSent: false, link: signingLink, expiresAt: made.expiresAt, needsPassword, note: "Email sending is switched off. Copy this link now; it is not shown again." } };
      }
      return { status: 200, body: { emailSent: true, needsPassword, expiresAt: made.expiresAt, firstSend: made.firstSend } };
    }
    case "resend_login": {
      if (!deps.config.siteUrl) return { status: 503, body: { error: "The link cannot be sent: EF_HR_PUBLIC_SITE_URL is not set.", code: "configuration_unavailable" } };
      if (!deps.sendTemplate || !deps.accountUrl) return { status: 503, body: { error: "Sign-in links cannot be sent here." } };
      const link = await deps.newLink();
      const made = await deps.adminRpc("hr_admin_onboarding_login_resend", { p_id: profileId, p_account_hash: link.hash });
      if (made.error) return fromDb(made.error);
      const invite = made.data as { email: string; expiresAt: string; invite: { id: string } };
      const url = deps.accountUrl(link.token);
      const composed = await loginEmail("login_link", null, { signing_link: url, login_url: `${deps.config.siteUrl}/login`, link_expiry: longDate(invite.expiresAt) });
      const sent = composed.ok ? await deps.sendTemplate({ to: invite.email, message: composed.message, deliveryId: `hr-login-${invite.invite.id}` })
        : { state: "failed" as const, error: String(composed.result.body.error ?? "the email template could not be filled"), messageId: undefined };
      await deps.serviceRpc("hr_svc_email_log", { p_profile: profileId, p_kind: "login_link", p_state: sent.state, p_message_id: sent.messageId ?? null, p_error: sent.error ?? null,
        p_payload: { inviteId: invite.invite.id, expiresAt: invite.expiresAt } });
      if (sent.state === "failed") {
        await deps.adminRpc("hr_admin_staff_invite_cancel", { p_id: profileId, p_invite: invite.invite.id });
        return { status: 502, body: { emailSent: false, error: `The email could not be sent (${sent.error ?? "error"}). The link was cancelled; use Resend login again.` } };
      }
      if (sent.state === "skipped") return { status: 200, body: { emailSent: false, link: url, expiresAt: invite.expiresAt, note: "Email sending is switched off. Copy this link now; it is not shown again." } };
      return { status: 200, body: { emailSent: true, expiresAt: invite.expiresAt } };
    }
    case "send_invite": {
      const purpose = body.purpose === "reupload" ? "reupload" : body.purpose === "documents" ? "documents" : null;
      if (!purpose) return { status: 400, body: { error: "Choose a document or re-upload link." } };
      return sendLinkFlow(purpose, "hr_admin_staff_invite", { p_id: profileId, p_purpose: purpose });
    }
    case "offer_send":
      // First send (documents_submitted > offer_sent) or resend (a new link replaces the old one); same failure rules.
      return sendLinkFlow("offer", "hr_admin_staff_offer_send", { p_id: profileId });
    case "offer_withdraw": {
      const note = String(body.note ?? "").trim();
      if (!note || note.length > 2000) return { status: 400, body: { error: "Add a note explaining why the offer is withdrawn." } };
      const r = await deps.adminRpc("hr_admin_staff_offer_withdraw", { p_id: profileId, p_note: note });
      return r.error ? fromDb(r.error) : { status: 200, body: { detail: r.data } };
    }
    case "activate": {
      const role = body.role === "admin" || body.role === "trainer" ? body.role : null;
      const joiningDate = typeof body.joiningDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.joiningDate) ? body.joiningDate : null;
      if (!role) return { status: 400, body: { error: "Choose Admin or Trainer." } };
      if (!joiningDate) return { status: 400, body: { error: "Enter the joining date." } };
      return activateFlow(role, joiningDate, body.confirmAdmin === true, false);
    }
    case "resend_activation": {
      // The Auth invite link expired or was lost: send it again with the role and joining date already recorded. Only for a
      // person still waiting (offer_signed, invited login never used); the new link replaces the old one.
      const d = await deps.adminRpc("hr_admin_staff_detail", { p_id: profileId });
      if (d.error) return fromDb(d.error);
      const detail = d.data as { profile?: { status?: string }; application?: { account_invited_at?: string | null }; employment?: { joiningDate?: string | null } | null; roles?: Array<{ role: string; revokedAt: string | null }> };
      const role = detail.roles?.find((r) => !r.revokedAt)?.role;
      const joiningDate = detail.employment?.joiningDate ?? null;
      if (detail.profile?.status !== "offer_signed" || !detail.application?.account_invited_at || (role !== "admin" && role !== "trainer") || !joiningDate) {
        return { status: 400, body: { error: "There is no activation invite waiting for this person." } };
      }
      return activateFlow(role, joiningDate, true, true);
    }
    case "offer_upload": {
      const file = deps.file;
      if (!file) return { status: 400, body: { error: "Choose the offer letter (PDF).", field: "file" } };
      // Admin and state first, with the caller's JWT: a non-admin or a wrong state never gets a file stored.
      const before = await deps.adminRpc("hr_admin_staff_detail", { p_id: profileId });
      if (before.error) return fromDb(before.error);
      if ((before.data as { profile?: { status?: string } } | null)?.profile?.status !== "documents_submitted") {
        return { status: 400, body: { error: "Upload an offer once the documents are submitted (withdraw a sent offer first)." } };
      }
      const checked = await deps.inspectOffer(file.bytes);
      if (!checked.ok) return { status: 400, body: { error: checked.error, field: "file" } };
      const sha256 = await deps.sha256(file.bytes);
      const path = `${profileId}/offer/${deps.newId()}.pdf`;
      const stored = await deps.upload(path, file.bytes, "application/pdf");
      if (stored.error) return { status: 503, body: { error: "The upload failed. Please try again." } };
      const added = await deps.adminRpc("hr_admin_staff_offer_add", { p_id: profileId, p_path: path, p_filename: offerName(file.name), p_size: file.bytes.length, p_sha256: sha256 });
      if (added.error) { await deps.remove([path]); return fromDb(added.error); }
      const result = added.data as { offer: unknown; replacedPath?: string | null };
      if (result.replacedPath) await deps.remove([result.replacedPath]);
      return { status: 200, body: { offer: result.offer, pages: checked.pages } };
    }
    case "revoke_invite": {
      const r = await deps.adminRpc("hr_admin_staff_invite_revoke", { p_id: profileId, p_purpose: "documents" });
      return r.error ? fromDb(r.error) : { status: 200, body: { detail: r.data } };
    }
    case "reject": {
      const note = String(body.note ?? "").trim();
      if (!note || note.length > 2000) return { status: 400, body: { error: "Add a note explaining the decision." } };
      const r = await deps.adminRpc("hr_admin_staff_reject", { p_id: profileId, p_note: note, p_notify: body.notify !== false });
      if (r.error) return fromDb(r.error);
      await deps.drain().catch(() => undefined);
      return { status: 200, body: { detail: r.data } };
    }
    case "retry_email": {
      const id = Number(body.emailId);
      if (!Number.isSafeInteger(id) || id < 1) return { status: 400, body: { error: "Email not found." } };
      const r = await deps.adminRpc("hr_admin_staff_email_retry", { p_email: id });
      if (r.error) return fromDb(r.error);
      await deps.drain().catch(() => undefined);
      return { status: 200, body: { detail: r.data } };
    }
    case "add": {
      // HR-02i "Add staff member": an application on the person's behalf (no resume), then the document link at once. A failed email
      // leaves the record (Applied) with the cancelled link visible on its page, where the admin sends it again.
      const made = await deps.adminRpc("hr_admin_staff_add", { p_first_name: String(body.firstName ?? ""), p_last_name: String(body.lastName ?? ""), p_email: String(body.email ?? ""), p_phone: String(body.phone ?? "") });
      if (made.error) return fromDb(made.error);
      const newId = (made.data as { profileId: string }).profileId;
      const sent = await sendLinkFlow("documents", "hr_admin_staff_invite", { p_id: newId, p_purpose: "documents" }, newId);
      return { status: sent.status, body: { ...sent.body, profileId: newId } };
    }
    case "hire":
      // Candidates > "Hire and send document link" (HR-02j), from the selected stage: the database marks the job application hired,
      // writes the employment record from the job and makes the document link; the email, log and cancel rules are send_invite's.
      return sendLinkFlow("documents", "hr_admin_candidate_hire", { p_id: applicationId }, null);
    case "candidate_file": {
      // A manual candidate's resume or cover letter (HR-02j). Admin and state first, with the caller's JWT (a non-admin or a Careers
      // applicant never gets a file stored); then the public form's content checks; stored with the service role in the person's
      // folder; recorded as the caller. A refused record removes the stored file; a replaced file is deleted.
      const which = body.which === "resume" || body.which === "cover_letter" ? body.which : null;
      if (!which) return { status: 400, body: { error: "Choose the resume or the cover letter." } };
      const file = deps.file;
      if (!file) return { status: 400, body: { error: "Choose a PDF or Word (.docx) file.", field: "file" } };
      const before = await deps.adminRpc("hr_admin_candidate", { p_id: applicationId });
      if (before.error) return fromDb(before.error);
      const candidate = before.data as { profileId?: string; source?: string; status?: string } | null;
      if (!candidate?.profileId || !UUID.test(candidate.profileId) || candidate.source !== "manual" || candidate.status !== "applied") {
        return { status: 400, body: { error: "Files can be added to an open manual candidate only; a Careers applicant's files stay as submitted." } };
      }
      if (file.bytes.length > MAX_RESUME_BYTES) return { status: 400, body: { error: "The file must be 5 MB or smaller.", field: "file" } };
      const kind = detectResume(file.name, file.bytes);
      if (!kind) return { status: 400, body: { error: "Attach a PDF or Word (.docx) file.", field: "file" } };
      const path = `${candidate.profileId}/${which === "resume" ? "resume" : "cover-letter"}/${deps.newId()}.${kind}`;
      const stored = await deps.upload(path, file.bytes, RESUME_TYPES[kind]);
      if (stored.error) return { status: 503, body: { error: "The upload failed. Please try again." } };
      const name = safeFilename(file.name, kind);
      const recorded = await deps.adminRpc("hr_admin_candidate_file", { p_application: applicationId, p_which: which, p_path: path, p_filename: name, p_mime: RESUME_TYPES[kind], p_size: file.bytes.length });
      if (recorded.error) { await deps.remove([path]); return fromDb(recorded.error); }
      const result = recorded.data as { replacedPath?: string | null } | null;
      if (result?.replacedPath) await deps.remove([result.replacedPath]);
      return { status: 200, body: { ok: true, which, filename: name } };
    }
    case "purge": {
      // Retention (HR-02h): files of applications rejected more than EF_HR_RETENTION_MONTHS ago are deleted from storage, then the
      // application is marked files_purged_at (rows and metadata stay). Only the scheduled job (service_role) may run it. A storage
      // failure leaves that application unmarked, so the next run tries again; a file already gone counts as deleted.
      if (!deps.isWorker || !deps.purgeFiles) return { status: 403, body: { error: "Only the scheduled retention job can do this." } };
      const months = deps.retentionMonths ?? 6;
      const due = await deps.serviceRpc("hr_svc_retention_due", { p_months: months, p_limit: 50 });
      if (due.error) return { status: 500, body: { error: "The retention list could not be read." } };
      const totals = { months, applications: 0, files: 0, failed: 0 };
      for (const item of (due.data as Array<{ profileId: string; paths: string[] }>) ?? []) {
        const paths = (item.paths ?? []).filter((p) => typeof p === "string" && p.startsWith(`${item.profileId}/`));
        const removed = paths.length ? await deps.purgeFiles(paths) : { error: null };
        if (removed.error) { totals.failed++; continue; }
        const marked = await deps.serviceRpc("hr_svc_retention_mark", { p_profile: item.profileId, p_months: months });
        if (marked.error || marked.data !== true) { totals.failed++; continue; }
        totals.applications++; totals.files += paths.length;
      }
      return { status: totals.failed ? 207 : 200, body: totals };
    }
    case "drain": {
      // Admin-only: proves the caller is an admin with a cheap admin read before sending anything.
      const check = await deps.adminRpc("hr_admin_staff_list", { p_status: null, p_search: null, p_limit: 1, p_offset: 0, p_statuses: null });
      if (check.error) return fromDb(check.error);
      return { status: 200, body: await deps.drain() };
    }
  }
}
