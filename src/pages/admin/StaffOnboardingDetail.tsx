import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { STAFF_EMPLOYEES_PATH, staffCandidatePath } from "@/pages/admin/lib/staffRoutes";
import { Badge, Button, Card, Field, Modal, PageHeader, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import {
  StaffAdminError, adminDeactivateStaff, adminListStaff, adminOnboarding, adminOnboardingCheck, adminOnboardingExtras, adminReactivateStaff, adminReopenStaff, adminReviewStaffDocument, adminSaveEmployment, adminStaffDetail, staffAdminActions, staffDocumentUrl,
  type OnboardingCheck, type OnboardingExtras, type OnboardingSection, type StaffAdminResult, type StaffDetail, type StaffDocument, type StaffEmail, type StaffEmployment, type StaffEmploymentForm, type StaffListRow, type StaffOnboarding,
} from "@/lib/staffApi";
import OnboardingStepper from "@/pages/admin/components/hrms/OnboardingStepper";
import PayDetailsDialog from "@/pages/admin/components/hrms/PayDetailsDialog";
import SendOfferDialog from "@/pages/admin/components/hrms/SendOfferDialog";
import { EXTRACTED_LABEL, SECTION, accountText, timelineText } from "@/pages/admin/lib/onboardingText";
import { READABLE_CATEGORIES, taxSuperRows } from "@/lib/staffOnboardingWizard";
import { money } from "@/lib/hrTime";
import { EMPLOYMENT_TYPE_LABEL, JOB_APPLICATION_STATUS_LABEL } from "@/lib/jobs";
import PaySetupCard from "@/pages/admin/components/hrms/PaySetupCard";
import BankDetailsCard from "@/pages/admin/components/hrms/BankDetailsCard";
import {
  EMAIL_KIND_LABEL, EMPLOYEE_ACTION, EMPLOYEE_ACTION_TARGET, ONBOARDING_STAGE_HINT, STAFF_DOC_LABEL, STAFF_STATUS_LABEL, STAFF_STATUS_TONE, employeeActions, expiryState, staffChecklist, staffDocSlug,
  type EmployeeAction, type StaffDocCategory, type StaffRole,
} from "@/lib/staffStatus";

/**
 * HRMS > Employees > one person's onboarding (HR-02g; restored 2026-11-10 next to the simple Employees page, shown for anyone not yet
 * Active or Inactive, and for Active / Inactive people under "Onboarding and offer"). Every action opens a confirmation dialog that says what will happen; the buttons follow
 * the status and what exists (links, rejected documents, offer, activation invite), and the server re-checks each one. Link and
 * offer emails are sent by the staff-admin function: a failed email is shown here with its reason (the link is cancelled; send it
 * again), failed notification emails can be retried, and with email switched off the link is shown ONCE to pass on. Files (resume,
 * documents, offer, signed offer) open through short-lived signed URLs. The status history is at the bottom. HR-02j: the employment
 * details (hr.employment, written by a hire or edited here; the joining date comes with activation), and a Careers applicant or manual
 * candidate gets the document link from Staff > Candidates ("Hire") or from Send document link here, which hires them for that job too.
 *
 * Onboarding flow (2026-11-10): the nine stages are shown as a stepper at the top (hr_admin_onboarding: stage, dates, pay details,
 * login state, history). Only the action that fits the stage is offered: Send document link > review documents > Add pay details
 * > Send offer letter (a template, previewed, emailed with the person's sign-in link) > Activate. Rejecting a document can email
 * the reason with a re-upload link at once. The history lists every action with who did it and when.
 *
 * Onboarding wizard (2026-11-10): what the reader took from each document is listed beside it; every section (personal details, each
 * document type, bank details) has a "Verified by admin" tick that is recorded with who and when and cleared when that section's
 * document or bank details change; the bank details are masked until an Admin presses Reveal (which is recorded too).
 */
const STAGE_LABEL = { screening: "Screening", shortlisted: "Shortlisted", interview: "Interview", selected: "Selected" } as const;

const ROLE_LABEL: Record<StaffRole, string> = { admin: "Admin", trainer: "Trainer" };
const REVIEW_TONE = { pending: "warn", approved: "success", rejected: "muted" } as const;
const REVIEW_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected" } as const;
const EMAIL_TONE = { queued: "muted", sending: "muted", sent: "success", failed: "primary", skipped: "warn" } as const;
const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
const LINK_EMAIL_PURPOSE: Record<string, "documents" | "reupload" | "offer" | "login"> = { document_invite: "documents", reupload_invite: "reupload", offer: "offer", login_link: "login" };
const DEFAULT_REJECT_NOTE = "Please upload this document again.";
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

/** The "Verified by admin" tick of one section, with who ticked it and when. */
function SectionCheck({ section, check, busy, onToggle }: { section: OnboardingSection; check?: OnboardingCheck; busy: boolean; onToggle: (verified: boolean) => void }) {
  return (
    <label className={`flex cursor-pointer flex-wrap items-center gap-2 text-xs ${check ? "font-semibold text-accent-900" : "text-foreground-700"}`} data-testid={`staff-check-${section}`} data-verified={check ? "yes" : "no"}>
      <input type="checkbox" className="h-4 w-4" checked={Boolean(check)} disabled={busy} aria-label={`${SECTION[section]} verified by admin`} onChange={(e) => onToggle(e.target.checked)} />
      <span>Verified by admin</span>
      {check ? <span className="font-normal text-foreground-600">{check.verifiedByName}, {new Date(check.verifiedAt).toLocaleString()}</span> : null}
    </label>
  );
}

/** What the reader took from a document, beside it; or why there is nothing. */
function ExtractedDetails({ doc }: { doc: StaffDocument }) {
  const entries = Object.entries(doc.extracted ?? {}).filter(([, value]) => String(value ?? "").trim() !== "");
  if (doc.extractionStatus === "done" && entries.length) {
    return (
      <div className="mt-2 rounded-md bg-background-100 px-3 py-2" data-testid={`staff-doc-extracted-${doc.id}`}>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-500">Read from the document</p>
        <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          {entries.map(([key, value]) => (
            <div key={key} className="flex justify-between gap-3"><dt className="text-foreground-500">{EXTRACTED_LABEL[key] ?? key.replace(/_/g, " ")}</dt><dd className="min-w-0 break-words text-right font-medium text-foreground-900">{String(value)}</dd></div>
          ))}
        </dl>
      </div>
    );
  }
  const text = !READABLE_CATEGORIES.includes(doc.category) ? "This document type is not read automatically: check it by eye."
    : doc.extractionStatus === "pending" || doc.extractionStatus === "processing" ? "Not read yet."
      : doc.extractionStatus === "failed" ? `Reading failed${doc.extractionError ? `: ${doc.extractionError}` : "."}`
        : doc.extractionStatus === "unavailable" ? "Automatic reading is switched off." : "Nothing could be read from this file.";
  return <p className="mt-1 text-xs text-foreground-500" data-testid={`staff-doc-extracted-${doc.id}`}>{text}</p>;
}

export default function StaffOnboardingDetail() {
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [flow, setFlow] = useState<StaffOnboarding | null>(null);
  const [extras, setExtras] = useState<OnboardingExtras | null>(null);
  const [checkBusy, setCheckBusy] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState<"send" | "resend" | null>(null);
  const [emailReject, setEmailReject] = useState(true);
  const [error, setError] = useState("");
  const location = useLocation();
  const [notice, setNotice] = useState((location.state as { message?: string } | null)?.message ?? "");
  const [action, setAction] = useState<EmployeeAction | null>(null);
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [role, setRole] = useState<StaffRole>("trainer");
  const [joiningDate, setJoiningDate] = useState("");
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [shownLink, setShownLink] = useState<{ link: string; expiresAt?: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rejecting, setRejecting] = useState<StaffDocument | null>(null);
  const [docNote, setDocNote] = useState("");
  const [docBusy, setDocBusy] = useState("");
  const [retrying, setRetrying] = useState(0);
  const [editingEmployment, setEditingEmployment] = useState(false);

  const load = useCallback(async () => {
    try {
      const [next, progress, more] = await Promise.all([adminStaffDetail(id), adminOnboarding(id), adminOnboardingExtras(id)]);
      setDetail(next); setFlow(progress); setExtras(more); setError(""); return next;
    } catch (e) { setError(e instanceof Error ? e.message : "The application could not be loaded."); return null; }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const openAction = (next: EmployeeAction) => {
    setError(""); setNotice("");
    if (next === "add_pay_details" || next === "edit_pay_details") { setPayOpen(true); return; }
    if (next === "send_offer" || next === "resend_offer") { setOfferOpen(next === "send_offer" ? "send" : "resend"); return; }
    setAction(next); setNote(""); setNotify(true); setConfirmAdmin(false); setDialogError("");
    setRole(detail?.roles.find((r) => !r.revokedAt)?.role ?? detail?.application.requested_role ?? "trainer");
    setJoiningDate(detail?.employment?.joiningDate ?? "");
  };

  const run = async (): Promise<StaffAdminResult | StaffDetail | null> => {
    const pid = detail!.profile.id;
    switch (action) {
      case "send_documents_link": return staffAdminActions.sendDocuments(pid);
      case "resend_documents_link": return staffAdminActions.sendLink(pid, "documents");
      case "resend_login": return staffAdminActions.resendLogin(pid);
      case "send_reupload_link": return staffAdminActions.sendLink(pid, "reupload");
      case "revoke_link": return staffAdminActions.revokeLink(pid);
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
    if (spec.note === "required" && !note.trim()) { setDialogError("Add the reason."); return; }
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

  const review = async (doc: StaffDocument, decision: "approved" | "rejected", text = "", emailNow = false) => {
    setDocBusy(doc.id); setDialogError(""); setError(""); setNotice("");
    try {
      // The reason is optional for the admin; the record (and the email) always carries one.
      const next = await adminReviewStaffDocument(doc.id, decision, decision === "rejected" ? text.trim() || DEFAULT_REJECT_NOTE : "");
      setDetail(next); setRejecting(null);
      if (decision === "rejected" && emailNow) {
        // The re-upload email lists every rejected document with its reason and carries the link.
        try {
          const sent = await staffAdminActions.sendLink(next.profile.id, "reupload");
          if (sent.link) setShownLink({ link: sent.link, expiresAt: sent.expiresAt });
          setNotice(sent.link ? "Email is switched off: copy the re-upload link from the window and send it yourself." : "The document was rejected and the person was emailed the reason with a link to upload it again.");
        } catch (e) { setError(`The document was rejected, but the email could not be sent: ${e instanceof Error ? e.message : "error"} Use “Ask for documents again”.`); }
      }
      await load();
    }
    catch (e) { (decision === "rejected" ? setDialogError : setError)(e instanceof Error ? e.message : "The review could not be saved."); }
    finally { setDocBusy(""); }
  };

  /** Ticks or unticks a section as verified; the history (who and when) is refreshed with it. */
  const verify = async (section: OnboardingSection, verified: boolean) => {
    setCheckBusy(section); setError("");
    try { setExtras(await adminOnboardingCheck(id, section, verified)); setFlow(await adminOnboarding(id)); }
    catch (e) { setError(e instanceof Error ? e.message : "The tick could not be saved."); }
    finally { setCheckBusy(""); }
  };
  const tick = (section: OnboardingSection) => <SectionCheck section={section} check={extras?.checks[section]} busy={checkBusy === section} onToggle={(verified) => void verify(section, verified)} />;

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
  const openJob = detail.jobApplications.find((j) => j.status === "applied") ?? null;
  const actions = employeeActions({
    status: profile.status,
    liveDocumentLink: liveLinks.some((i) => i.purpose !== "offer"),
    rejectedDocuments: detail.documents.filter((d) => d.status === "rejected").length,
    allApproved: summary.required > 0 && summary.approved === summary.required,
    offer: openOffer ? { sent: Boolean(openOffer.sentAt) } : null,
    activationInvited: profile.status === "offer_signed" && Boolean(application.account_invited_at),
    openJobApplication: openJob !== null,
    payComplete: flow?.payComplete ?? false,
    hasLogin: flow?.account?.hasLogin ?? false,
    passwordSet: flow?.account?.passwordSet ?? false,
  });
  const pay = flow?.payDetails ?? null;
  const stageHint = flow && !flow.closed ? ONBOARDING_STAGE_HINT[flow.stage] : null;
  const employment = detail.employment;
  const joining = employment?.joiningDate ?? null;
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
      <PageHeader breadcrumb="HRMS / Employees / Onboarding" title={name}
        description={`${activeRole ? `Role: ${ROLE_LABEL[activeRole]} · ` : ""}${employment?.jobTitle ? `${employment.jobTitle} · ` : ""}Documents approved ${summary.approved}/${summary.required}${joining ? ` · Joining ${new Date(`${joining}T00:00:00`).toLocaleDateString()}` : ""}`}
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
          {failedEmails.length === 1 ? "An email" : `${failedEmails.length} emails`} to or about this person could not be sent. See Emails below to retry or resend the link.
        </p>
      ) : null}
      {flow ? (
        <Card className="mb-4 p-5"><div data-testid="staff-onboarding-progress" data-stage={flow.stage}>
          <OnboardingStepper steps={flow.steps} closed={flow.closed} />
          <p className="mt-4 border-t border-background-200 pt-3 text-sm text-foreground-800" data-testid="staff-stage-hint">
            {flow.closed === "rejected" ? "This application was withdrawn or rejected. Reopen it to continue."
              : flow.closed === "inactive" ? "This person is inactive. Their record and documents are kept."
                : stageHint}
            {!flow.closed && flow.stage === "documents_requested" && flow.documentLinkSentAt ? <span className="text-foreground-600"> Link last sent {when(flow.documentLinkSentAt)}.</span> : null}
            {!flow.closed && flow.stage === "documents_submitted" && summary.rejected > 0 ? <span className="text-foreground-600"> {summary.rejected === 1 ? "One document is" : `${summary.rejected} documents are`} rejected: use “Ask for documents again” if the person has not been emailed yet.</span> : null}
            {!flow.closed && flow.stage === "offer_sent" && flow.account.hasLogin && !flow.account.passwordSet ? <span className="text-foreground-600"> They have not chosen a password yet.</span> : null}
          </p>
        </div></Card>
      ) : null}
      {profile.status === "applied" && openJob ? (
        <p className={`mb-4 ${NOTICE}`} data-testid="staff-hire-hint">
          This person applied for <strong>{openJob.jobTitle}</strong> ({STAGE_LABEL[openJob.stage]}). Sending the document link also marks that application as hired, the same as hiring them from{" "}
          <Link to={staffCandidatePath(openJob.id)} className="font-semibold text-primary-700 hover:underline">Candidates</Link>.
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
            <Row label="Nationality">{profile.nationality}</Row><Row label="Passport number">{profile.passport_number}</Row>
            {profile.is_australian_citizen === false || profile.visa_subclass ? <Row label="Visa">{[profile.visa_subclass, profile.visa_conditions].filter(Boolean).join(" · ")}</Row> : null}
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
            <Row label="Login"><span data-testid="staff-login-state">{flow ? accountText(flow.account, when) : detail.hasAccount ? "Yes" : "None yet"}</span></Row>
            <Row label="Admin console access">{detail.hasCmsAccess ? "Yes (Admin)" : "No"}</Row>
          </dl>
          <div className="mt-4 border-t border-background-200 pt-3">{tick("personal")}</div>
          {liveLinks.length ? (
            <div className="mt-4 border-t border-background-200 pt-3 text-xs text-foreground-600" data-testid="staff-live-link">
              {liveLinks.filter((l) => l.purpose !== "offer").map((l) => <p key={l.id}>Live {l.purpose === "account" ? "sign-in" : l.purpose === "reupload" ? "re-upload" : "document"} link until {new Date(l.expiresAt).toLocaleDateString()}{l.lastSeenAt ? ` · last opened ${when(l.lastSeenAt)}` : " · not opened yet"}</p>)}
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
                          {canReview && d.status !== "rejected" ? <Button size="sm" variant="outline" onClick={() => { setRejecting(d); setDocNote(""); setEmailReject(true); setDialogError(""); }} disabled={docBusy === d.id} data-testid={`staff-doc-reject-${d.id}`}>Reject</Button> : null}
                        </span>
                      </div>
                      {d.status === "rejected" && d.reviewNote ? <p className="mt-1 text-xs text-primary-900">Note: {d.reviewNote}</p> : null}
                      <ExtractedDetails doc={d} />
                    </li>
                  ))}
                </ul>
                {item.files > 0 ? <div className="mt-2">{tick(staffDocSlug(item.kind.category) as OnboardingSection)}</div> : null}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-6 p-5"><div data-testid="staff-employment">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-base font-bold text-foreground-950">Employment</h2>
          <Button size="sm" variant="outline" onClick={() => setEditingEmployment(true)} data-testid="staff-employment-edit">{employment ? "Edit employment" : "Add employment details"}</Button>
        </div>
        {employment ? (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Row label="Job title">{employment.jobTitle}</Row><Row label="Department">{employment.department}</Row>
            <Row label="Employment type">{employment.employmentType ? EMPLOYMENT_TYPE_LABEL[employment.employmentType] : ""}</Row>
            <Row label="Work location">{employment.workLocation}</Row>
            <Row label="Manager">{employment.managerId ? <Link to={`${STAFF_EMPLOYEES_PATH}/${employment.managerId}`} className="font-semibold text-primary-700 hover:underline">{employment.managerName ?? "Manager"}</Link> : ""}</Row>
            <Row label="Joining date">{joining ? new Date(`${joining}T00:00:00`).toLocaleDateString() : <span className="text-foreground-500">Set with the pay details</span>}</Row>
          </dl>
        ) : <p className="text-sm text-foreground-600">No employment details yet. Hiring from Candidates fills them in from the job; the pay details add the rest.</p>}
      </div></Card>

      {pay && (flow?.documentsApproved || pay.completedAt) ? (
        <Card className="mt-6 p-5"><div data-testid="staff-pay-details">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-base font-bold text-foreground-950">Pay details <span className="ml-2 align-middle"><Badge tone={flow?.payComplete ? "success" : "warn"}>{flow?.payComplete ? "Complete" : "Needed before the offer"}</Badge></span></h2>
            {profile.status === "documents_submitted" && flow?.documentsApproved ? <Button size="sm" variant="outline" onClick={() => setPayOpen(true)} data-testid="staff-pay-details-edit">{pay.completedAt ? "Edit pay details" : "Add pay details"}</Button> : null}
          </div>
          {pay.completedAt ? (
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Row label="Position">{pay.employment?.jobTitle}</Row>
              <Row label="Employment type">{pay.employment?.employmentType ? EMPLOYMENT_TYPE_LABEL[pay.employment.employmentType] : ""}</Row>
              <Row label="Start date">{pay.employment?.joiningDate ? new Date(`${pay.employment.joiningDate}T00:00:00`).toLocaleDateString() : ""}</Row>
              <Row label="Pay">{pay.pay.payBasis === "salary" ? `${money(pay.pay.rate)} a year` : pay.pay.payBasis === "hourly" ? `${money(pay.pay.rate)} an hour` : ""}</Row>
              <Row label="Pay schedule">{pay.pay.payScheduleName}</Row>
              <Row label="Hours per week">{pay.pay.ordinaryHoursWeek ?? (pay.employment?.employmentType === "casual" ? "As rostered" : "")}</Row>
              <Row label="Reporting manager">{pay.employment?.managerName}</Row>
              <Row label="Xero employee id">{pay.pay.xeroEmployeeId || <span className="text-foreground-500">Not set yet</span>}</Row>
            </dl>
          ) : <p className="text-sm text-foreground-600">{flow?.payProblem ?? "Add the pay details to continue."} They fill the offer letter and set up payroll.</p>}
        </div></Card>
      ) : null}

      <BankDetailsCard profileId={profile.id} footer={extras?.bank ? tick("bank") : undefined} onChanged={() => void load()} />
      <Card className="mt-6 p-5"><div data-testid="staff-tax-super">
        <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Tax and super</h2>
        {profile.tax_residency || profile.super_choice ? (
          <>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{taxSuperRows(profile).map(([label, value]) => <Row key={label} label={label}>{value}</Row>)}</dl>
            <div className="mt-3">{tick("tax")}</div>
          </>
        ) : <p className="text-sm text-foreground-600">Not answered yet. The person answers these on the Tax and super step of their onboarding link. The tax file number is given through Xero, never here.</p>}
      </div></Card>
      {profile.status === "active" || profile.status === "inactive" ? <PaySetupCard profileId={profile.id} hasEmployment={Boolean(employment)} /> : null}

      {detail.jobApplications.length ? (
        <Card className="mt-6 p-5"><div data-testid="staff-job-applications">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Job applications</h2>
          <ul className="space-y-3 text-sm">
            {detail.jobApplications.map((j) => (
              <li key={j.id} className="rounded-md border border-background-200 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><span className="font-semibold text-foreground-900">{j.jobTitle}</span>{j.jobStatus !== "open" ? <span className="ml-1 text-xs text-foreground-500">({j.jobStatus})</span> : null}
                    <span className="block text-xs text-foreground-600">{j.source === "manual" ? "Entered by an administrator" : "Applied"} {when(j.appliedAt)}{j.decidedAt ? ` · ${j.status === "hired" ? "hired, document link sent" : j.status} ${when(j.decidedAt)}` : ""}</span></span>
                  <span className="flex items-center gap-2">
                    <Badge tone={j.status === "hired" ? "success" : j.status === "applied" ? "warn" : "muted"}>{j.status === "applied" ? STAGE_LABEL[j.stage] : JOB_APPLICATION_STATUS_LABEL[j.status]}</Badge>
                    <Link to={staffCandidatePath(j.id)} className="text-xs font-semibold text-primary-700 hover:underline">Open in Candidates</Link>
                    {j.coverLetterFile && !application.files_purged_at ? <Button size="sm" variant="outline" onClick={() => void view(`Cover letter: ${j.coverLetterFile!.filename}`, j.coverLetterFile!.storagePath, j.coverLetterFile!.mimeType)}>Cover letter</Button> : null}
                  </span>
                </div>
                {j.coverLetter ? <p className="mt-2 whitespace-pre-wrap text-foreground-800" data-testid="staff-job-cover-letter">{j.coverLetter}</p> : null}
              </li>
            ))}
          </ul>
        </div></Card>
      ) : null}

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
          ) : <p className="text-sm text-foreground-600">No offer yet. It is made from a template once the documents are approved and the pay details are in.</p>}
          {flow?.offerLetter ? <p className="mt-2 text-xs text-foreground-600" data-testid="staff-offer-template">Letter “{flow.offerLetter.title}” made from the “{flow.offerLetter.templateName}” template on {when(flow.offerLetter.createdAt)}. Later template edits do not change it.</p> : null}
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
                    {e.state === "failed" && !resolved(e) && !e.retryable && LINK_EMAIL_PURPOSE[e.kind] ? <span className="text-xs text-foreground-600">Use “{LINK_EMAIL_PURPOSE[e.kind] === "offer" ? "Send the offer email again" : LINK_EMAIL_PURPOSE[e.kind] === "login" ? "Resend login" : "Resend link"}”</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-foreground-600">No emails yet.</p>}
        </div></Card>
      </div>

      <Card className="mt-6 p-5"><div data-testid="staff-history">
        <h2 className="mb-1 font-heading text-base font-bold text-foreground-950">History</h2>
        <p className="mb-3 text-xs text-foreground-600">Every action on this record: who did it and when. Newest first.</p>
        {flow ? (
          <ol className="relative space-y-3 border-l border-background-300 pl-4" data-testid="staff-timeline">
            {flow.timeline.map((entry, i) => {
              const line = timelineText(entry);
              if (!line) return null;
              return (
                <li key={`${entry.at}-${entry.type}-${i}`} className="relative text-sm" data-testid="staff-timeline-entry" data-type={entry.type} data-action={entry.action}>
                  <span aria-hidden="true" className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background-50 ${entry.type === "status" ? "bg-primary-500" : entry.type === "email" ? "bg-secondary-500" : "bg-foreground-400"}`} />
                  <span className={entry.type === "status" ? "font-semibold text-foreground-950" : "text-foreground-900"}>{line.text}</span>
                  <span className="ml-2 text-xs text-foreground-500">{when(entry.at)} · {entry.type === "email" ? "System" : entry.actorName}</span>
                  {line.note ? <p className="text-foreground-700">{line.note}</p> : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <ol className="space-y-2">
            {[...detail.events].reverse().map((e, i) => (
              <li key={`${e.at}-${i}`} className="text-sm"><span className="font-semibold">{e.from ? `${STAFF_STATUS_LABEL[e.from]} → ` : ""}{STAFF_STATUS_LABEL[e.to]}</span>
                <span className="ml-2 text-xs text-foreground-500">{when(e.at)} · {e.actorKind === "admin" ? "an administrator" : e.actorKind === "applicant" ? "the applicant" : e.actorKind}</span>{e.note ? <p className="text-foreground-700">{e.note}</p> : null}</li>
            ))}
          </ol>
        )}
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
        footer={<><Button variant="outline" onClick={() => setRejecting(null)}>Cancel</Button><Button variant="danger" onClick={() => rejecting && void review(rejecting, "rejected", docNote, emailReject)} disabled={docBusy !== ""} data-testid="staff-doc-reject-confirm">{docBusy ? "Working…" : emailReject ? "Reject and email" : "Reject document"}</Button></>}>
        <div className="space-y-3">
          <Field label="Reason (optional)" hint={`They are told this. Left empty, it reads “${DEFAULT_REJECT_NOTE}”`}><TextArea rows={3} value={docNote} onChange={(e) => setDocNote(e.target.value)} data-testid="staff-doc-reject-note" /></Field>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground-800">
            <input type="checkbox" checked={emailReject} onChange={(e) => setEmailReject(e.target.checked)} className="mt-0.5 h-4 w-4" data-testid="staff-doc-reject-email" />
            <span>Email them now with the reason and a link to upload it again. The application goes back to <strong>Documents requested</strong> until they do. Untick this to reject more documents first, then use “Ask for documents again” (one email lists them all).</span>
          </label>
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
            {action === "send_documents_link" && openJob ? (
              <p className={NOTICE} data-testid="staff-action-hire-note">They applied for <strong>{openJob.jobTitle}</strong>. This also marks that job application as hired and fills the employment details from the job, the same as Candidates › Hire.</p>
            ) : null}
            {action === "send_documents_link" || action === "resend_documents_link" || action === "send_reupload_link" || action === "resend_login" ? (
              <p className="text-sm text-foreground-800" data-testid="staff-action-email-note">An email goes to <strong>{profile.email}</strong>.</p>
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
            {spec.note ? <Field label={spec.note === "required" ? "Reason (required)" : "Reason (optional)"}><TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="staff-decision-note" /></Field> : null}
            {dialogError ? <p role="alert" className={ALERT} data-testid="staff-action-error">{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>

      {payOpen && pay ? <PayDetailsDialog profileId={profile.id} current={pay} onClose={() => setPayOpen(false)}
        onSaved={(next) => { setPayOpen(false); setFlow(next); setNotice("The pay details were saved. You can send the offer letter now."); void load(); }} /> : null}
      {offerOpen ? <SendOfferDialog profileId={profile.id} name={name} email={profile.email} resend={offerOpen === "resend"} onClose={() => { setOfferOpen(null); void load(); }}
        onDone={(result, message) => { setOfferOpen(null); if (result.link) setShownLink({ link: result.link, expiresAt: result.expiresAt }); setNotice(message); void load(); }} /> : null}

      {editingEmployment ? <EmploymentDialog profileId={profile.id} employment={employment} onClose={() => setEditingEmployment(false)}
        onSaved={(next) => { setEditingEmployment(false); setDetail(next); setNotice("The employment details were saved."); }} /> : null}

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
    case "resend_login": return "A new sign-in link was emailed.";
    case "add_pay_details": case "edit_pay_details": return "The pay details were saved.";
    case "send_reupload_link": return "The re-upload link was emailed.";
    case "revoke_link": return "The link was revoked.";
    case "send_offer": case "resend_offer": return "The offer was emailed.";
    case "withdraw_offer": return "The offer was withdrawn.";
    case "activate": return result?.activated ? "Activated. They are a current employee now and were emailed that their staff access is ready." : "The set-a-password email was sent. They become active when they set it.";
    case "resend_activation": return "A new set-a-password email was sent.";
    case "reject": return "The application was withdrawn.";
    case "deactivate": return "Marked inactive.";
    case "reactivate": return "Reactivated.";
    case "reopen": return "Reopened.";
  }
}

/** The employment fields of hr.employment (HR-02j). The manager is an active employee (searched by name); the joining date is set at activation. */
function EmploymentDialog({ profileId, employment, onClose, onSaved }: { profileId: string; employment: StaffEmployment | null; onClose: () => void; onSaved: (detail: StaffDetail) => void }) {
  const [form, setForm] = useState<StaffEmploymentForm>({
    department: employment?.department ?? "", jobTitle: employment?.jobTitle ?? "", employmentType: employment?.employmentType ?? "", managerId: employment?.managerId ?? "", workLocation: employment?.workLocation ?? "",
  });
  const [managerSearch, setManagerSearch] = useState("");
  const [managers, setManagers] = useState<StaffListRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<StaffEmploymentForm>) => setForm((f) => ({ ...f, ...p }));

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      void adminListStaff(["active"], managerSearch, 25, 0).then((data) => { if (current) setManagers(data.rows.filter((m) => m.id !== profileId)); }, () => { if (current) setManagers([]); });
    }, 200);
    return () => { current = false; window.clearTimeout(timer); };
  }, [managerSearch, profileId]);

  const save = async () => {
    setBusy(true); setError("");
    try { onSaved(await adminSaveEmployment(profileId, form)); }
    catch (e) { setError(e instanceof Error ? e.message : "The employment details could not be saved."); }
    finally { setBusy(false); }
  };
  const currentManager = employment?.managerId && !managers.some((m) => m.id === employment.managerId) ? { id: employment.managerId, name: employment.managerName ?? "Current manager" } : null;
  return (
    <Modal open title="Employment details" onClose={() => { if (!busy) onClose(); }}
      footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="staff-employment-save">{busy ? "Saving…" : "Save"}</Button></>}>
      <div className="space-y-3" data-testid="staff-employment-dialog">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Job title"><TextInput maxLength={150} value={form.jobTitle} onChange={(e) => patch({ jobTitle: e.target.value })} data-testid="staff-employment-title" /></Field>
          <Field label="Department"><TextInput maxLength={120} value={form.department} onChange={(e) => patch({ department: e.target.value })} data-testid="staff-employment-department" /></Field>
          <Field label="Employment type"><Select value={form.employmentType} onChange={(e) => patch({ employmentType: e.target.value as StaffEmploymentForm["employmentType"] })} data-testid="staff-employment-type">
            <option value="">Not set</option><option value="full_time">Full time</option><option value="part_time">Part time</option><option value="casual">Casual</option>
          </Select></Field>
          <Field label="Work location"><TextInput maxLength={150} value={form.workLocation} onChange={(e) => patch({ workLocation: e.target.value })} data-testid="staff-employment-location" /></Field>
          <Field label="Find a manager" hint="Active employees only."><TextInput placeholder="Search by name or email" value={managerSearch} onChange={(e) => setManagerSearch(e.target.value)} /></Field>
          <Field label="Manager"><Select value={form.managerId} onChange={(e) => patch({ managerId: e.target.value })} data-testid="staff-employment-manager">
            <option value="">No manager assigned</option>
            {currentManager ? <option value={currentManager.id}>{currentManager.name}</option> : null}
            {managers.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
          </Select></Field>
        </div>
        <p className="text-xs text-foreground-600">The start date comes from the pay details and is confirmed at activation{employment?.joiningDate ? ` (${new Date(`${employment.joiningDate}T00:00:00`).toLocaleDateString()})` : ""}.</p>
        {error ? <p role="alert" className={ALERT} data-testid="staff-employment-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
