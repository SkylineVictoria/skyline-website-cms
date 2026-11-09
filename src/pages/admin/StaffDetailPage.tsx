import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { STAFF_EMPLOYEES_PATH } from "@/pages/admin/lib/staffRoutes";
import { Badge, Button, Card, Field, Modal, PageHeader, TextArea, TextInput } from "@/pages/admin/components/ui";
import {
  StaffAdminError, adminDeactivateStaff, adminReactivateStaff, adminReopenStaff, adminReviewStaffDocument, adminStaffDetail, staffAdminActions, staffDocumentUrl,
  type StaffAdminResult, type StaffDetail, type StaffDocument, type StaffEmail,
} from "@/lib/staffApi";
import {
  EMAIL_KIND_LABEL, EMPLOYEE_ACTION, EMPLOYEE_ACTION_TARGET, STAFF_DOC_LABEL, STAFF_STATUS_LABEL, STAFF_STATUS_TONE, employeeActions, expiryState, staffChecklist,
  type EmployeeAction, type StaffDocCategory, type StaffRole,
} from "@/lib/staffStatus";

/**
 * Staff > Employees > one person (HR-02g). Every action opens a confirmation dialog that says what will happen; the buttons follow
 * the status and what exists (links, rejected documents, offer, activation invite), and the server re-checks each one. Link and
 * offer emails are sent by the staff-admin function: a failed email is shown here with its reason (the link is cancelled; send it
 * again), failed notification emails can be retried, and with email switched off the link is shown ONCE to pass on. Files (resume,
 * documents, offer, signed offer) open through short-lived signed URLs. The status history is at the bottom.
 */

const ROLE_LABEL: Record<StaffRole, string> = { admin: "Admin", trainer: "Trainer" };
const REVIEW_TONE = { pending: "warn", approved: "success", rejected: "muted" } as const;
const REVIEW_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected" } as const;
const EMAIL_TONE = { queued: "muted", sending: "muted", sent: "success", failed: "primary", skipped: "warn" } as const;
const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
const LINK_EMAIL_PURPOSE: Record<string, "documents" | "reupload" | "offer"> = { document_invite: "documents", reupload_invite: "reupload", offer: "offer" };
const todayIso = () => new Date().toISOString().slice(0, 10);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</dt><dd className="text-sm text-foreground-900">{children || "—"}</dd></div>;
}
function Expiry({ date }: { date: string | null }) {
  if (!date) return null;
  const state = expiryState(date);
  return (
    <span className={state === "soon" || state === "expired" ? "font-semibold text-primary-800" : "text-foreground-600"} data-expiry={state}>
      Expires {new Date(`${date}T00:00:00`).toLocaleDateString()}{state === "soon" ? " (expiring soon)" : state === "expired" ? " (expired)" : ""}
    </span>
  );
}
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

type Preview = { title: string; url: string; kind: "pdf" | "image" | "other" };

export default function StaffDetailPage() {
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<EmployeeAction | null>(null);
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [role, setRole] = useState<StaffRole>("trainer");
  const [joiningDate, setJoiningDate] = useState("");
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [offerFile, setOfferFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [shownLink, setShownLink] = useState<{ link: string; expiresAt?: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rejecting, setRejecting] = useState<StaffDocument | null>(null);
  const [docNote, setDocNote] = useState("");
  const [docBusy, setDocBusy] = useState("");
  const [retrying, setRetrying] = useState(0);

  const load = useCallback(async () => {
    try { const next = await adminStaffDetail(id); setDetail(next); setError(""); return next; }
    catch (e) { setError(e instanceof Error ? e.message : "The application could not be loaded."); return null; }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const openAction = (next: EmployeeAction) => {
    setAction(next); setNote(""); setNotify(true); setConfirmAdmin(false); setOfferFile(null); setDialogError("");
    setRole(detail?.roles.find((r) => !r.revokedAt)?.role ?? detail?.application.requested_role ?? "trainer");
    setJoiningDate(detail?.application.joining_date ?? "");
  };

  const run = async (): Promise<StaffAdminResult | StaffDetail | null> => {
    const pid = detail!.profile.id;
    switch (action) {
      case "send_documents_link": case "resend_documents_link": return staffAdminActions.sendLink(pid, "documents");
      case "send_reupload_link": return staffAdminActions.sendLink(pid, "reupload");
      case "revoke_link": return staffAdminActions.revokeLink(pid);
      case "upload_offer": return staffAdminActions.uploadOffer(pid, offerFile!);
      case "send_offer": case "resend_offer": return staffAdminActions.sendOffer(pid);
      case "withdraw_offer": return staffAdminActions.withdrawOffer(pid, note.trim());
      case "activate": return staffAdminActions.activate(pid, role, joiningDate, confirmAdmin);
      case "resend_activation": return staffAdminActions.resendActivation(pid);
      case "reject": return staffAdminActions.reject(pid, note.trim(), notify);
      case "deactivate": return adminDeactivateStaff(pid, note.trim());
      case "reactivate": return adminReactivateStaff(pid, note.trim());
      case "reopen": return adminReopenStaff(pid, note.trim());
      default: return null;
    }
  };

  const confirm = async () => {
    if (!action || !detail) return;
    const spec = EMPLOYEE_ACTION[action];
    if (spec.note === "required" && !note.trim()) { setDialogError("Add a note explaining the decision."); return; }
    if (action === "upload_offer" && !offerFile) { setDialogError("Choose the offer letter (PDF)."); return; }
    if (action === "activate") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(joiningDate)) { setDialogError("Enter the joining date."); return; }
      if (role === "admin" && !confirmAdmin) { setDialogError("Tick the box to confirm this person should become an Admin."); return; }
    }
    // Status check: refuse if someone else changed this person since the page was loaded (the server checks again).
    const fresh = await adminStaffDetail(detail.profile.id).catch(() => null);
    if (fresh && fresh.profile.status !== detail.profile.status) {
      setDetail(fresh); setAction(null);
      setError(`This person is now ${STAFF_STATUS_LABEL[fresh.profile.status]} (changed by someone else). Nothing was done; check and try again.`);
      return;
    }
    setBusy(true); setDialogError(""); setNotice("");
    try {
      const result = (await run()) as StaffAdminResult | null;
      setAction(null);
      if (result && "link" in result && result.link) setShownLink({ link: result.link, expiresAt: result.expiresAt });
      await load();
      setNotice(doneMessage(action, result));
    } catch (e) {
      // A failed link email also cancelled that link: show why, and refresh so the failure appears under Emails.
      setDialogError(e instanceof Error ? e.message : "That could not be done.");
      if (e instanceof StaffAdminError && e.status === 502) await load();
    } finally { setBusy(false); }
  };

  const view = async (title: string, path: string, mime: string | null) => {
    setError("");
    try {
      const url = await staffDocumentUrl(path, 120);
      const kind = mime === "application/pdf" ? "pdf" : mime?.startsWith("image/") ? "image" : "other";
      if (kind === "other") window.open(url, "_blank", "noopener,noreferrer");
      else setPreview({ title, url, kind });
    } catch (e) { setError(e instanceof Error ? e.message : "The file could not be opened."); }
  };

  const review = async (doc: StaffDocument, decision: "approved" | "rejected", text = "") => {
    if (decision === "rejected" && !text.trim()) { setDialogError("Add a note telling them what to fix."); return; }
    setDocBusy(doc.id); setDialogError(""); setError("");
    try { setDetail(await adminReviewStaffDocument(doc.id, decision, text.trim())); setRejecting(null); }
    catch (e) { (decision === "rejected" ? setDialogError : setError)(e instanceof Error ? e.message : "The review could not be saved."); }
    finally { setDocBusy(""); }
  };

  const retry = async (email: StaffEmail) => {
    setRetrying(email.id); setError(""); setNotice("");
    try { await staffAdminActions.retryEmail(email.id); await load(); setNotice("The email was queued again and sent."); }
    catch (e) { setError(e instanceof Error ? e.message : "The email could not be retried."); }
    finally { setRetrying(0); }
  };

  if (error && !detail) return <div><PageHeader title="Staff member" /><p role="alert" className={ALERT}>{error}</p></div>;
  if (!detail) return <p className="text-sm text-foreground-600" role="status">Loading…</p>;
  const { profile, application, summary } = detail;
  const activeRole = detail.roles.find((r) => !r.revokedAt)?.role;
  const openOffer = detail.offers.find((o) => !o.withdrawnAt && !o.signedAt) ?? null;
  const signedOffer = detail.offers.find((o) => o.signedAt) ?? null;
  const liveLinks = detail.invites.filter((i) => i.state === "live");
  const actions = employeeActions({
    status: profile.status,
    liveDocumentLink: liveLinks.some((i) => i.purpose !== "offer"),
    rejectedDocuments: detail.documents.filter((d) => d.status === "rejected").length,
    allApproved: summary.required > 0 && summary.approved === summary.required,
    offer: openOffer ? { sent: Boolean(openOffer.sentAt) } : null,
    activationInvited: profile.status === "offer_signed" && Boolean(application.account_invited_at),
  });
  const canReview = profile.status === "documents_submitted";
  const address = [profile.address_street, profile.address_line2, profile.address_suburb, profile.address_state, profile.address_postcode, profile.address_country].filter(Boolean).join(", ");
  const checklist = staffChecklist(detail.documents, profile.is_australian_citizen);
  // A failure stops counting once an email of the same kind was sent later (same rule as hr.staff_email_failed and the list badge).
  const resolved = (e: StaffEmail) => detail.emails.some((l) => l.kind === e.kind && l.state === "sent" && l.id > e.id);
  const failedEmails = detail.emails.filter((e) => e.state === "failed" && !resolved(e));
  const name = [profile.first_name, profile.middle_name, profile.last_name].filter(Boolean).join(" ") || profile.email || "Personal data removed (retention)";
  const spec = action ? EMPLOYEE_ACTION[action] : null;
  const target = action ? EMPLOYEE_ACTION_TARGET[action] : null;

  return (
    <div>
      <PageHeader breadcrumb="Staff / Employees" title={name}
        description={`${activeRole ? `Role: ${ROLE_LABEL[activeRole]} · ` : ""}Documents approved ${summary.approved}/${summary.required}${application.joining_date ? ` · Joining ${new Date(`${application.joining_date}T00:00:00`).toLocaleDateString()}` : ""}`}
        actions={<>
          <span data-testid="staff-detail-status"><Badge tone={STAFF_STATUS_TONE[profile.status]}>{STAFF_STATUS_LABEL[profile.status]}</Badge></span>
          {actions.map((a, i) => (
            <Button key={a} variant={EMPLOYEE_ACTION[a].danger ? "outline" : i === 0 ? "primary" : "outline"} onClick={() => openAction(a)} data-testid={`staff-action-${a}`}>{EMPLOYEE_ACTION[a].label}</Button>
          ))}
        </>} />
      <p className="-mt-3 mb-4 text-sm"><Link to={STAFF_EMPLOYEES_PATH} className="text-primary-700 hover:underline">&larr; All employees</Link></p>
      {error ? <p role="alert" className={`mb-4 ${ALERT}`}>{error}</p> : null}
      {notice ? <p role="status" className={`mb-4 ${NOTICE}`} data-testid="staff-notice">{notice}</p> : null}
      {failedEmails.length ? (
        <p className={`mb-4 ${ALERT}`} data-testid="staff-email-failed">
          {failedEmails.length === 1 ? "An email" : `${failedEmails.length} emails`} to or about this person could not be sent. See Emails below to retry or send the link again.
        </p>
      ) : null}
      {application.files_purged_at ? <p className={`mb-4 ${NOTICE}`} data-testid="staff-files-purged">The resume, documents and offer files were deleted on {new Date(application.files_purged_at).toLocaleDateString()} under the retention rule. The record stays.</p> : null}
      {summary.expiringSoon ? <p className={`mb-4 ${ALERT}`} data-testid="staff-detail-expiring">A document expires within 30 days or has expired. Check the dates below.</p> : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Details</h2>
          <dl className="grid gap-3">
            <Row label="Email">{profile.email}</Row><Row label="Mobile">{profile.phone_e164}</Row>
            <Row label="Date of birth">{profile.date_of_birth}</Row><Row label="Address">{address}</Row>
            <Row label="Australian citizen">{profile.is_australian_citizen === null ? "" : profile.is_australian_citizen ? "Yes" : "No"}</Row>
            <Row label="Emergency contact">{[profile.emergency_name, profile.emergency_relationship, profile.emergency_phone_e164].filter(Boolean).join(" · ")}</Row>
            <Row label="Applied">{when(profile.created_at)}</Row>
            <Row label="Documents submitted">{when(application.submitted_at)}</Row>
            <Row label="Resume">
              {application.resume_path && !application.files_purged_at ? (
                <button type="button" className="cursor-pointer font-semibold text-primary-700 hover:underline" data-testid="staff-resume-view"
                  onClick={() => void view(`Resume: ${application.resume_filename ?? "resume"}`, application.resume_path!, application.resume_mime)}>
                  {application.resume_filename ?? "Open resume"}
                </button>
              ) : ""}
            </Row>
            <Row label="Login">{detail.hasAccount ? (profile.status === "offer_signed" ? "Invited, waiting for the password" : "Yes") : "None yet"}</Row>
            <Row label="Admin console access">{detail.hasCmsAccess ? "Yes (Admin)" : "No"}</Row>
          </dl>
          {liveLinks.length ? (
            <div className="mt-4 border-t border-background-200 pt-3 text-xs text-foreground-600" data-testid="staff-live-link">
              {liveLinks.map((l) => <p key={l.id}>Live {l.purpose === "offer" ? "offer" : l.purpose === "reupload" ? "re-upload" : "document"} link until {new Date(l.expiresAt).toLocaleDateString()}{l.lastSeenAt ? ` · last opened ${when(l.lastSeenAt)}` : " · not opened yet"}</p>)}
            </div>
          ) : null}
        </Card>

        <Card className="p-5 lg:col-span-3">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Documents</h2>
          {!canReview ? <p className="mb-3 text-xs text-foreground-600">{profile.status === "applied" || profile.status === "invited" ? "Documents can be reviewed once they are submitted." : "Reviews are made while the documents are submitted (before the offer)."}</p> : null}
          <ul className="space-y-4" data-testid="staff-documents">
            {checklist.map((item) => (
              <li key={item.kind.category}>
                <p className="mb-1.5 text-sm font-semibold text-foreground-950">{item.kind.label}{item.kind.required ? "" : " (optional)"}
                  {item.state === "missing" ? <span className="ml-2"><Badge tone="muted">{item.kind.required ? "Missing" : "Not provided"}</Badge></span> : null}</p>
                <ul className="space-y-2">
                  {detail.documents.filter((d) => d.category === item.kind.category).map((d) => (
                    <li key={d.id} className="rounded-md border border-background-200 px-3 py-2 text-sm" data-testid={`staff-doc-row-${d.id}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block truncate text-foreground-800">{d.filename}</span>
                          <span className="flex flex-wrap gap-x-3 text-xs"><Expiry date={d.expiryDate} />{d.reviewedAt ? <span className="text-foreground-500">Reviewed {new Date(d.reviewedAt).toLocaleDateString()}</span> : null}</span>
                        </span>
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone={REVIEW_TONE[d.status]}>{REVIEW_LABEL[d.status]}</Badge>
                          {application.files_purged_at ? null : <Button size="sm" variant="outline" onClick={() => void view(`${STAFF_DOC_LABEL[d.category as StaffDocCategory] ?? d.category}: ${d.filename}`, d.storagePath, d.mimeType)} data-testid={`staff-doc-view-${d.id}`}>Preview</Button>}
                          {canReview && d.status !== "approved" ? <Button size="sm" onClick={() => void review(d, "approved")} disabled={docBusy === d.id} data-testid={`staff-doc-approve-${d.id}`}>Approve</Button> : null}
                          {canReview && d.status !== "rejected" ? <Button size="sm" variant="outline" onClick={() => { setRejecting(d); setDocNote(""); setDialogError(""); }} disabled={docBusy === d.id} data-testid={`staff-doc-reject-${d.id}`}>Reject</Button> : null}
                        </span>
                      </div>
                      {d.status === "rejected" && d.reviewNote ? <p className="mt-1 text-xs text-primary-900">Note: {d.reviewNote}</p> : null}
                      {d.extractionStatus === "done" ? <p className="mt-1 text-xs text-foreground-600">Read from the document: {[d.extracted.passport_number && `number ${d.extracted.passport_number}`, d.extracted.passport_expiry && `expires ${d.extracted.passport_expiry}`, d.extracted.dob && `born ${d.extracted.dob}`].filter(Boolean).join(" · ") || "details filled"}</p> : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-5"><div data-testid="staff-offer-card">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Offer</h2>
          {openOffer || signedOffer ? (
            <ul className="space-y-2 text-sm">
              {[signedOffer, openOffer].filter(Boolean).map((o) => (
                <li key={o!.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-background-200 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-foreground-800">{o!.filename}</span>
                    <span className="text-xs text-foreground-600">{o!.signedAt ? `Signed by ${o!.signerName} on ${when(o!.signedAt)}` : o!.sentAt ? `Sent ${when(o!.sentAt)}, not signed yet` : `Uploaded ${when(o!.uploadedAt)}, not sent`}</span>
                  </span>
                  <span className={`flex gap-2 ${application.files_purged_at ? "hidden" : ""}`}>
                    <Button size="sm" variant="outline" onClick={() => void view(`Offer: ${o!.filename}`, o!.storagePath, "application/pdf")} data-testid="staff-offer-view">Offer</Button>
                    {o!.signedPath ? <Button size="sm" variant="outline" onClick={() => void view(`Signed offer: ${o!.filename}`, o!.signedPath!, "application/pdf")} data-testid="staff-offer-signed-view">Signed copy</Button> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-foreground-600">No offer yet. Upload one once every required document is approved.</p>}
        </div></Card>

        <Card className="p-5"><div data-testid="staff-emails">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Emails</h2>
          {detail.emails.length ? (
            <ul className="divide-y divide-background-200 text-sm">
              {detail.emails.map((e) => (
                <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-2" data-testid={`staff-email-${e.id}`}>
                  <span className="min-w-0">
                    <span className="block text-foreground-900">{EMAIL_KIND_LABEL[e.kind] ?? e.kind}</span>
                    <span className="text-xs text-foreground-600">{e.state === "sent" ? `Sent ${when(e.sentAt)}` : e.state === "skipped" ? "Not sent (email switched off)" : `${when(e.createdAt)}${e.attempts ? ` · ${e.attempts} attempt${e.attempts === 1 ? "" : "s"}` : ""}`}</span>
                    {e.state === "failed" && e.error ? <span className="block text-xs text-primary-900">Reason: {e.error}</span> : null}
                  </span>
                  <span className="flex items-center gap-2">
                    {e.state === "failed" && resolved(e) ? <Badge tone="muted">Failed, sent again later</Badge> : <Badge tone={EMAIL_TONE[e.state]}>{e.state === "failed" ? "Failed" : e.state === "sent" ? "Sent" : e.state === "skipped" ? "Skipped" : "Waiting"}</Badge>}
                    {e.state === "failed" && !resolved(e) && e.retryable ? <Button size="sm" variant="outline" disabled={retrying === e.id} onClick={() => void retry(e)} data-testid={`staff-email-retry-${e.id}`}>{retrying === e.id ? "Retrying…" : "Retry"}</Button> : null}
                    {e.state === "failed" && !resolved(e) && !e.retryable && LINK_EMAIL_PURPOSE[e.kind] ? <span className="text-xs text-foreground-600">Use “{LINK_EMAIL_PURPOSE[e.kind] === "offer" ? "Send the offer link again" : "Send the link again"}”</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-foreground-600">No emails yet.</p>}
        </div></Card>
      </div>

      <Card className="mt-6 p-5"><div data-testid="staff-history">
        <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Status history</h2>
        <ol className="space-y-2">
          {[...detail.events].reverse().map((e, i) => (
            <li key={`${e.at}-${i}`} className="text-sm"><span className="font-semibold">{e.from ? `${STAFF_STATUS_LABEL[e.from]} → ` : ""}{STAFF_STATUS_LABEL[e.to]}</span>
              <span className="ml-2 text-xs text-foreground-500">{when(e.at)} · {e.actorKind === "admin" ? "an administrator" : e.actorKind === "applicant" ? "the applicant" : e.actorKind}</span>{e.note ? <p className="text-foreground-700">{e.note}</p> : null}</li>
          ))}
        </ol>
      </div></Card>

      <Modal open={preview !== null} title={preview?.title ?? ""} onClose={() => setPreview(null)}
        footer={<>{preview ? <a href={preview.url} target="_blank" rel="noopener noreferrer" className="mr-auto text-sm font-semibold text-primary-700">Open in a new tab</a> : null}<Button variant="outline" onClick={() => setPreview(null)}>Close</Button></>}>
        {preview ? (
          <div className="h-[65vh] w-full overflow-auto rounded-md bg-background-100" data-testid="staff-doc-preview">
            {preview.kind === "pdf"
              ? <iframe title={preview.title} src={`${preview.url}#toolbar=0&navpanes=0`} className="h-full w-full border-0" />
              : <img src={preview.url} alt={preview.title} className="mx-auto max-h-full object-contain" />}
          </div>
        ) : null}
      </Modal>

      <Modal open={rejecting !== null} title={rejecting ? `Reject ${rejecting.filename}` : ""} onClose={() => setRejecting(null)}
        footer={<><Button variant="outline" onClick={() => setRejecting(null)}>Cancel</Button><Button variant="danger" onClick={() => rejecting && void review(rejecting, "rejected", docNote)} disabled={docBusy !== ""} data-testid="staff-doc-reject-confirm">Reject document</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-foreground-700">They see this note when you ask for the documents again (“Ask for documents again” sends them a re-upload link).</p>
          <Field label="What needs fixing (required)"><TextArea rows={3} value={docNote} onChange={(e) => setDocNote(e.target.value)} data-testid="staff-doc-reject-note" /></Field>
          {dialogError ? <p role="alert" className={ALERT}>{dialogError}</p> : null}
        </div>
      </Modal>

      <Modal open={action !== null} title={spec ? `${spec.label}: ${name}` : ""} onClose={() => setAction(null)}
        footer={<><Button variant="outline" onClick={() => setAction(null)}>Cancel</Button><Button variant={spec?.danger ? "danger" : "primary"} onClick={() => void confirm()} disabled={busy} data-testid="staff-decision-confirm">{busy ? "Working…" : spec?.confirm ?? ""}</Button></>}>
        {spec ? (
          <div className="space-y-4" data-testid="staff-action-dialog">
            <p className="text-sm text-foreground-700">{spec.explain}</p>
            <p className="text-xs text-foreground-600" data-testid="staff-action-status">
              Now: <strong>{STAFF_STATUS_LABEL[profile.status]}</strong>{target && target !== profile.status ? <> → after this: <strong>{STAFF_STATUS_LABEL[target]}</strong></> : " (the status does not change)"}
            </p>
            {action === "upload_offer" ? (
              <Field label="Offer letter (PDF)" required>
                <input type="file" accept="application/pdf,.pdf" data-testid="staff-offer-file" onChange={(e) => setOfferFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
              </Field>
            ) : null}
            {action === "activate" ? (
              <>
                <Field label="Role" required>
                  <div role="radiogroup" aria-label="Role" className="flex gap-2">
                    {(["trainer", "admin"] as StaffRole[]).map((r) => (
                      <button key={r} type="button" role="radio" aria-checked={role === r} data-testid={`staff-grant-${r}`} onClick={() => { setRole(r); setConfirmAdmin(false); }}
                        className={`cursor-pointer rounded-md border px-4 py-2 text-sm font-semibold ${role === r ? "border-primary-500 bg-primary-50 text-primary-800" : "border-background-300 text-foreground-700"}`}>{ROLE_LABEL[r]}</button>
                    ))}
                  </div>
                </Field>
                <Field label="Joining date" required>
                  <TextInput type="date" value={joiningDate} min={todayIso()} onChange={(e) => setJoiningDate(e.target.value)} data-testid="staff-joining-date" />
                </Field>
                {role === "admin" ? (
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-sm text-primary-900">
                    <input type="checkbox" data-testid="staff-confirm-admin" checked={confirmAdmin} onChange={(e) => setConfirmAdmin(e.target.checked)} className="mt-0.5 h-4 w-4" />
                    <span>I confirm that <strong>{profile.email}</strong> should become an <strong>Admin</strong>, with full access to the admin console.</span>
                  </label>
                ) : <p className="text-xs text-foreground-600">A Trainer gets My HR but no admin console access.</p>}
              </>
            ) : null}
            {action === "reject" ? (
              <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground-800">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 h-4 w-4" data-testid="staff-reject-notify" />
                <span>Email them that we are not continuing with the application (a short, polite message without your note).</span>
              </label>
            ) : null}
            {spec.note ? <Field label={spec.note === "required" ? "Note (required)" : "Note (optional)"}><TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="staff-decision-note" /></Field> : null}
            {dialogError ? <p role="alert" className={ALERT} data-testid="staff-action-error">{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>

      <Modal open={shownLink !== null} title="Email is switched off: pass this link on" onClose={() => setShownLink(null)}
        footer={<Button onClick={() => setShownLink(null)}>I have copied it</Button>}>
        {shownLink ? (
          <div className="space-y-3" data-testid="staff-shown-link">
            <p className="text-sm text-foreground-700">This private link is shown only now and is not stored. Send it to {profile.email} yourself{shownLink.expiresAt ? `; it works until ${new Date(shownLink.expiresAt).toLocaleDateString()}` : ""}.</p>
            <TextInput readOnly value={shownLink.link} onFocus={(e) => e.currentTarget.select()} />
            <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(shownLink.link)}>Copy</Button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function doneMessage(action: EmployeeAction, result: StaffAdminResult | null): string {
  if (result?.link) return "Email is switched off: copy the link from the window and send it yourself.";
  switch (action) {
    case "send_documents_link": case "resend_documents_link": return "The document link was emailed.";
    case "send_reupload_link": return "The re-upload link was emailed.";
    case "revoke_link": return "The link was revoked.";
    case "upload_offer": return `The offer letter was checked and uploaded${result?.pages ? ` (${result.pages} page${result.pages === 1 ? "" : "s"})` : ""}.`;
    case "send_offer": case "resend_offer": return "The offer link was emailed.";
    case "withdraw_offer": return "The offer was withdrawn.";
    case "activate": return result?.activated ? "Activated on their existing login. HR emailed them that their access is ready." : "The set-a-password email was sent. They become active when they set it.";
    case "resend_activation": return "A new set-a-password email was sent.";
    case "reject": return "The application was rejected.";
    case "deactivate": return "Deactivated.";
    case "reactivate": return "Reactivated.";
    case "reopen": return "Reopened.";
  }
}
