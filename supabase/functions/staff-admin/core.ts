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
//
// Offers (HR-02e): offer_upload checks the PDF by content (pdf-lib must load AND modify it; encrypted or protected files are
// refused with a clear message) BEFORE anything is stored, stores it under {profile}/offer/ with the service role, and records
// it (with its sha256) through hr_admin_staff_offer_add as the caller; a refusal removes the stored file, and an unsent offer it
// replaces is deleted. offer_send works like a document link (purpose offer, 30 days). offer_withdraw needs a note.

export const ACTIONS = ["send_invite", "revoke_invite", "reject", "retry_email", "drain", "offer_upload", "offer_send", "offer_withdraw", "activate", "resend_activation", "purge", "add"] as const;
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
  sendLink(mail: { kind: LinkKind; to: string; name: string; link: string; expiresAt: string; rejected?: Array<{ category: string; note: string }>; deliveryId: string }):
    Promise<{ state: "sent" | "failed" | "skipped"; messageId?: string; error?: string }>;
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
  /** The uploaded file (multipart offer_upload), or null. */
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
  if (action !== "drain" && action !== "retry_email" && action !== "purge" && action !== "add" && !profileId) return { status: 400, body: { error: "Choose an application." } };

  // Makes a link (only its hash reaches the database through `rpc`), emails it inline, logs the outcome without the token, and
  // cancels that link at once when the email failed. Shared by document, re-upload and offer links.
  const sendLinkFlow = async (purpose: LinkPurpose, rpc: string, args: Record<string, unknown>, pid: string | null = profileId): Promise<AdminResult> => {
    if (!deps.config.siteUrl) return { status: 503, body: { error: "Links cannot be sent: EF_HR_PUBLIC_SITE_URL is not set.", code: "configuration_unavailable" } };
    const link = await deps.newLink();
    const made = await deps.adminRpc(rpc, { ...args, p_token_hash: link.hash });
    if (made.error) return fromDb(made.error);
    const invite = made.data as { invite: { id: string; expiresAt: string }; email: string; name: string; rejected?: Array<{ category: string; note: string }> };
    const kind: LinkKind = purpose === "documents" ? "document_invite" : purpose === "reupload" ? "reupload_invite" : "offer";
    const url = deps.linkUrl(purpose, link.token);
    const sent = await deps.sendLink({ kind, to: invite.email, name: invite.name, link: url, expiresAt: invite.invite.expiresAt, rejected: invite.rejected, deliveryId: `hr-invite-${invite.invite.id}` });
    // The log never holds the token or the link: only which invite it was and what happened.
    await deps.serviceRpc("hr_svc_email_log", { p_profile: pid, p_kind: kind, p_state: sent.state, p_message_id: sent.messageId ?? null, p_error: sent.error ?? null,
      p_payload: { inviteId: invite.invite.id, purpose, expiresAt: invite.invite.expiresAt } });
    if (sent.state === "failed") {
      const cancelled = await deps.adminRpc("hr_admin_staff_invite_cancel", { p_id: pid, p_invite: invite.invite.id });
      return { status: 502, body: { emailSent: false, linkCancelled: !cancelled.error, error: `The email could not be sent (${sent.error ?? "error"}). The link was cancelled; use Send again.`, detail: cancelled.data ?? null } };
    }
    if (sent.state === "skipped") {
      // Sending is off: hand the link to the admin ONCE to pass on themselves. It is not stored anywhere.
      return { status: 200, body: { emailSent: false, link: url, expiresAt: invite.invite.expiresAt, note: "Email sending is switched off. Copy this link now; it is not shown again." } };
    }
    return { status: 200, body: { emailSent: true, expiresAt: invite.invite.expiresAt } };
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

  switch (action as AdminAction) {
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
      const detail = d.data as { profile?: { status?: string }; application?: { joining_date?: string | null; account_invited_at?: string | null }; roles?: Array<{ role: string; revokedAt: string | null }> };
      const role = detail.roles?.find((r) => !r.revokedAt)?.role;
      const joiningDate = detail.application?.joining_date ?? null;
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
