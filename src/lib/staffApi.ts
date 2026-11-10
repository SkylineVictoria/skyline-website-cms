import { supabase } from "@/pages/admin/lib/supabase";
import type { StaffDocCategory, StaffDocReview, StaffRole, StaffStatus } from "@/lib/staffStatus";

export type { StaffDocCategory } from "@/lib/staffStatus";

/** Browser-side calls for staff self-registration. Every write is a SECURITY DEFINER function (the hr schema is not exposed). */

export interface StaffProfile {
  id: string; first_name: string; middle_name: string; last_name: string; date_of_birth: string | null; email: string; phone_e164: string;
  address_street: string; address_line2: string; address_suburb: string; address_state: string; address_postcode: string; address_country: string;
  emergency_name: string; emergency_relationship: string; emergency_phone_e164: string | null; is_australian_citizen: boolean | null;
  status: StaffStatus; created_at: string; updated_at: string;
}
export interface StaffApplicationRow { id: string; requested_role: StaffRole | null; submitted_at: string | null; review_note: string; reviewed_at: string | null }
export interface StaffDocument {
  id: string; category: string; filename: string; mimeType: string; fileSize: number; storagePath: string;
  extractionStatus: "pending" | "processing" | "done" | "no_fields" | "failed" | "unavailable"; extracted: Record<string, string>; extractionError?: string | null;
  createdAt: string; expiryDate: string | null; status: StaffDocReview; reviewNote: string; reviewedAt: string | null;
}
/** hr.staff_doc_summary: required document types, how many have a file, how many are fully approved, any expiring within 30 days. */
export interface StaffDocSummary { required: number; uploaded: number; approved: number; rejected: number; expiringSoon: boolean; nextExpiry: string | null }
export interface StaffEvent { from: StaffStatus | null; to: StaffStatus; actorKind: string; note: string; at: string }
/** hr.employment (HR-02j): the employment details; the joining date is set at activation. */
export interface StaffEmployment {
  department: string; jobTitle: string; employmentType: "full_time" | "part_time" | "casual" | null; joiningDate: string | null;
  managerId: string | null; managerName: string | null; workLocation: string; candidateId: string | null; since: string;
}
/** hr_staff_me: the signed-in person's own staff record (documents, employment and the signed offer once they are active). */
export interface MyStaff {
  profile: StaffProfile; status: StaffStatus; role: StaffRole | null; joiningDate: string | null; documents: StaffDocument[];
  employment: StaffEmployment | null; jobApplications: StaffJobApplication[];
  signedOffer: { id: string; signedAt: string; signedPath: string; filename: string } | null;
}

function fail(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export interface StaffApplyInput {
  firstName: string; lastName: string; email: string; phone: string; resume: File; agreed: boolean; captchaToken: string; website?: string;
  /** Careers (HR-02i): the open job applied for, an optional cover letter text and/or file. */
  jobId?: string; coverLetter?: string; coverLetterFile?: File | null;
}

/**
 * Sends the public staff application (multipart: details, resume, CAPTCHA token) to the staff-register function. No login is
 * created. A clash with an existing application gets the same thank-you as a success. Errors carry the field to highlight.
 */
export async function applyAsStaff(input: StaffApplyInput): Promise<void> {
  const body = new FormData();
  body.set("action", "apply");
  body.set("firstName", input.firstName);
  body.set("lastName", input.lastName);
  body.set("email", input.email);
  body.set("phone", input.phone);
  body.set("agreed", input.agreed ? "true" : "false");
  body.set("captchaToken", input.captchaToken);
  body.set("website", input.website ?? "");
  body.set("resume", input.resume, input.resume.name);
  if (input.jobId) body.set("jobId", input.jobId);
  if (input.coverLetter?.trim()) body.set("coverLetter", input.coverLetter);
  if (input.coverLetterFile) body.set("coverLetterFile", input.coverLetterFile, input.coverLetterFile.name);
  const { data, error } = await supabase.functions.invoke("staff-register", { body });
  if (error) {
    let message = error.message;
    let field: string | undefined;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const parsed = (await context.clone().json()) as { error?: string; field?: string };
        if (parsed?.error) message = parsed.error;
        field = parsed?.field;
      } catch { /* keep the generic message */ }
    }
    throw Object.assign(new Error(message || "We could not send your application. Please try again."), { field });
  }
  if (data?.error) throw new Error(String(data.error));
}

/** After the Auth invite: offer_signed > active for the signed-in person (idempotent; returns My HR). */
export async function claimStaffAccount(): Promise<MyStaff | null> {
  const { data, error } = await supabase.rpc("hr_staff_claim_account");
  if (error) fail(error, "We could not finish setting up your staff account.");
  return (data ?? null) as MyStaff | null;
}

export async function getMyStaff(): Promise<MyStaff | null> {
  const { data, error } = await supabase.rpc("hr_staff_me");
  if (error) fail(error, "We could not load your staff record.");
  return (data ?? null) as MyStaff | null;
}

/** A short-lived signed link: the bucket is private, so files are never public URLs. */
export async function staffDocumentUrl(storagePath: string, seconds = 300): Promise<string> {
  const { data, error } = await supabase.storage.from("staff-documents").createSignedUrl(storagePath, seconds);
  if (error || !data?.signedUrl) throw new Error("The document could not be opened.");
  return data.signedUrl;
}

/** hr_staff_access: where the signed-in user stands ("none" when they have no staff application). */
export async function staffAccessState(): Promise<StaffStatus | "none"> {
  const { data, error } = await supabase.rpc("hr_staff_access");
  if (error) return "none";
  return (typeof data === "string" ? data : "none") as StaffStatus | "none";
}

/* ------------------------------------------------------------------ admin */

export interface StaffListRow {
  id: string; name: string; email: string; phone: string; status: StaffStatus; requestedRole: StaffRole | null; role: StaffRole | null;
  submittedAt: string | null; updatedAt: string; docs: StaffDocSummary; hasResume?: boolean; inviteExpiresAt?: string | null; emailFailed?: boolean; jobTitle?: string | null;
  department?: string; joiningDate?: string | null;
}
/** A job application on the person's record (HR-02i/j): Careers or a manual candidate, with its recruitment stage. */
export interface StaffJobApplication {
  id: string; jobId: string; jobTitle: string; jobStatus: "draft" | "open" | "closed"; status: "applied" | "hired" | "declined" | "withdrawn";
  stage: "screening" | "shortlisted" | "interview" | "selected"; source: "careers" | "manual"; appliedAt: string; decidedAt: string | null; decisionNote: string;
  coverLetter: string; coverLetterFile: { filename: string; storagePath: string; mimeType: string | null } | null;
}
export interface StaffInvite { id: string; purpose: "documents" | "reupload" | "offer" | "account"; createdAt: string; expiresAt: string; usedAt: string | null; lastSeenAt: string | null; state: "live" | "used" | "revoked" | "replaced" | "expired" }
export interface StaffOffer {
  id: string; filename: string; fileSize: number; storagePath: string; sha256: string; uploadedAt: string; sentAt: string | null; withdrawnAt: string | null;
  signedAt: string | null; signerName: string | null; signedPath: string | null; signedSha256: string | null;
}
export interface StaffEmail { id: number; kind: string; audience: "applicant" | "admin"; state: "queued" | "sending" | "sent" | "failed" | "skipped"; createdAt: string; sentAt: string | null; error: string | null; attempts: number; retryable: boolean }
export interface StaffApplicationDetail extends StaffApplicationRow {
  resume_path: string | null; resume_filename: string | null; resume_mime: string | null; resume_size: number | null; account_invited_at: string | null; files_purged_at: string | null;
}
export interface StaffDetail {
  profile: StaffProfile; application: StaffApplicationDetail; documents: StaffDocument[]; requiredCategories: StaffDocCategory[]; summary: StaffDocSummary;
  roles: Array<{ role: StaffRole; grantedAt: string; revokedAt: string | null }>; events: StaffEvent[]; hasCmsAccess: boolean; hasAccount: boolean;
  invites: StaffInvite[]; offers: StaffOffer[]; emails: StaffEmail[]; emailFailed: boolean; jobApplications: StaffJobApplication[]; employment: StaffEmployment | null;
}
/** The editable employment fields (hr_admin_staff_employment_save); the joining date is set at activation, not here. */
export interface StaffEmploymentForm { department: string; jobTitle: string; employmentType: "full_time" | "part_time" | "casual" | ""; managerId: string; workLocation: string }

/** One or more statuses (p_statuses); an empty list means every status. */
export async function adminListStaff(statuses: readonly StaffStatus[], search: string, limit = 50, offset = 0): Promise<{ total: number; rows: StaffListRow[] }> {
  const { data, error } = await supabase.rpc("hr_admin_staff_list", { p_statuses: statuses.length ? statuses : null, p_search: search || null, p_limit: limit, p_offset: offset });
  if (error) fail(error, "The staff list could not be loaded.");
  return data as { total: number; rows: StaffListRow[] };
}

export async function adminStaffDetail(id: string): Promise<StaffDetail> {
  const { data, error } = await supabase.rpc("hr_admin_staff_detail", { p_id: id });
  if (error) fail(error, "The application could not be loaded.");
  return data as StaffDetail;
}

export async function adminReviewStaffDocument(documentId: string, decision: "approved" | "rejected", note: string): Promise<StaffDetail> {
  const { data, error } = await supabase.rpc("hr_admin_staff_document_review", { p_doc: documentId, p_decision: decision, p_note: note || null });
  if (error) fail(error, "The review could not be saved.");
  return data as StaffDetail;
}

/* ------------------------------------------------------------------ admin actions (HR-02g) */

/** What staff-admin answers. A link email that could not be sent cancels that link (emailSent false, linkCancelled true); with
 *  email switched off the link is returned ONCE (link) for the admin to pass on. */
export interface StaffAdminResult {
  detail?: StaffDetail | null; emailSent?: boolean; linkCancelled?: boolean; link?: string; note?: string; expiresAt?: string;
  inviteSent?: boolean; activated?: boolean; existingLogin?: boolean; resent?: boolean; offer?: StaffOffer; pages?: number; profileId?: string;
  ok?: boolean; which?: "resume" | "cover_letter"; filename?: string;
  /** Onboarding flow: a generated letter (title, template), the offer sent with the login, an email that failed and was undone. */
  title?: string; templateName?: string; needsPassword?: boolean; firstSend?: boolean; rolledBack?: boolean; missing?: string[];
}
export class StaffAdminError extends Error {
  readonly status: number;
  readonly result: StaffAdminResult;
  constructor(message: string, status: number, result: StaffAdminResult) { super(message); this.status = status; this.result = result; }
}

async function staffAdmin(body: Record<string, unknown> | FormData): Promise<StaffAdminResult> {
  const { data, error } = await supabase.functions.invoke("staff-admin", { body });
  if (error) {
    let message = error.message, status = 500, result: StaffAdminResult = {};
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      status = context.status;
      try { const parsed = (await context.clone().json()) as StaffAdminResult & { error?: string }; result = parsed; if (parsed?.error) message = parsed.error; } catch { /* keep the generic message */ }
    }
    throw new StaffAdminError(message || "That could not be done.", status, result);
  }
  return (data ?? {}) as StaffAdminResult;
}

export const staffAdminActions = {
  sendLink: (profileId: string, purpose: "documents" | "reupload") => staffAdmin({ action: "send_invite", profileId, purpose }),
  revokeLink: (profileId: string) => staffAdmin({ action: "revoke_invite", profileId }),
  reject: (profileId: string, note: string, notify: boolean) => staffAdmin({ action: "reject", profileId, note, notify }),
  uploadOffer: (profileId: string, file: File) => {
    const form = new FormData();
    form.set("action", "offer_upload"); form.set("profileId", profileId); form.set("file", file, file.name);
    return staffAdmin(form);
  },
  sendOffer: (profileId: string) => staffAdmin({ action: "offer_send", profileId }),
  /** Onboarding flow: the document link from the employee page (a Careers applicant is hired for their open job application). */
  sendDocuments: (profileId: string) => staffAdmin({ action: "send_documents", profileId }),
  /** Fills an offer letter template for the person and stores the PDF with the rendered letter. */
  generateOffer: (profileId: string, templateId: string) => staffAdmin({ action: "offer_generate", profileId, templateId }),
  /** Sends the prepared offer with the person's login (one email with a one-time set-password link). Also the resend. */
  sendOfferWithLogin: (profileId: string, emailTemplateId: string | null) => staffAdmin({ action: "offer_send_login", profileId, emailTemplateId }),
  /** A new one-time set-password link, while the person has not chosen a password. */
  resendLogin: (profileId: string) => staffAdmin({ action: "resend_login", profileId }),
  withdrawOffer: (profileId: string, note: string) => staffAdmin({ action: "offer_withdraw", profileId, note }),
  activate: (profileId: string, role: StaffRole, joiningDate: string, confirmAdmin: boolean) => staffAdmin({ action: "activate", profileId, role, joiningDate, confirmAdmin }),
  resendActivation: (profileId: string) => staffAdmin({ action: "resend_activation", profileId }),
  retryEmail: (emailId: number) => staffAdmin({ action: "retry_email", emailId }),
  /** HR-02i: an application on the person's behalf, then the document link at once. */
  add: (person: { firstName: string; lastName: string; email: string; phone: string }) => staffAdmin({ action: "add", ...person }),
  /** HR-02j Candidates: "Hire and send document link" for a candidate application (selected stage); answers like sendLink, plus profileId. */
  hire: (applicationId: string) => staffAdmin({ action: "hire", applicationId }),
  /** HR-02j: a manual candidate's resume or cover letter, checked by content and stored by the function. */
  candidateFile: (applicationId: string, which: "resume" | "cover_letter", file: File) => {
    const form = new FormData();
    form.set("action", "candidate_file"); form.set("applicationId", applicationId); form.set("which", which); form.set("file", file, file.name);
    return staffAdmin(form);
  },
};

/** The employment details on Staff > Employees (department, title, type, manager, location). */
export async function adminSaveEmployment(id: string, form: StaffEmploymentForm): Promise<StaffDetail> {
  const { data, error } = await supabase.rpc("hr_admin_staff_employment_save", { p_id: id, p_employment: { ...form, employmentType: form.employmentType || null, managerId: form.managerId || null } });
  if (error) fail(error, "The employment details could not be saved.");
  return data as StaffDetail;
}

async function adminRpc(name: string, args: Record<string, unknown>, fallback: string): Promise<StaffDetail> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) fail(error, fallback);
  return data as StaffDetail;
}
export const adminDeactivateStaff = (id: string, note: string) => adminRpc("hr_admin_staff_deactivate", { p_id: id, p_note: note || null }, "That could not be done.");
export const adminReactivateStaff = (id: string, note: string) => adminRpc("hr_admin_staff_activate", { p_id: id, p_note: note || null }, "That could not be done.");
export const adminReopenStaff = (id: string, note: string) => adminRpc("hr_staff_reopen", { p_id: id, p_note: note }, "That could not be done.");

/* ------------------------------------------------------------------ onboarding flow (stages, pay details, history) */

export type OnboardingStageKey = "applied" | "shortlisted" | "documents_requested" | "documents_submitted" | "documents_approved" | "pay_details" | "offer_sent" | "offer_signed" | "active";
export interface OnboardingStep { key: OnboardingStageKey; label: string; state: "done" | "current" | "todo"; at: string | null }
export interface OnboardingTimelineEntry {
  at: string; type: "status" | "action" | "recruitment" | "email"; action: string; detail: Record<string, unknown>;
  actorKind: "admin" | "applicant" | "system"; actorName: string;
}
export interface OnboardingPay {
  payScheduleId: string | null; payScheduleName: string | null; payBasis: "salary" | "hourly" | null; rate: number | null; ordinaryHoursWeek: number | null;
  usualWorkDays: number[] | null; award: string; xeroEmployeeId: string; effectiveOrdinaryHoursWeek: number;
}
export interface OnboardingPayDetails {
  employment: StaffEmployment | null; pay: OnboardingPay; completedAt: string | null; schedules: Array<{ id: string; name: string; frequency: string }>;
}
export interface OnboardingAccount {
  hasLogin: boolean; passwordSet: boolean; lastSignInAt: string | null;
  link: { sentAt: string; expiresAt: string; usedAt: string | null; state: "live" | "used" | "revoked" | "replaced" | "expired" } | null;
}
/** hr_admin_onboarding: where the person is in the nine stages, with the date of each step, the pay details, the login and the history. */
export interface StaffOnboarding {
  stage: OnboardingStageKey; index: number; closed: "rejected" | "inactive" | null; steps: OnboardingStep[];
  documentsApproved: boolean; documentsProblem: string | null; payComplete: boolean; payProblem: string | null;
  payDetails: OnboardingPayDetails; documentLinkSentAt: string | null; account: OnboardingAccount;
  offerLetter: { offerId: string; templateName: string; title: string; createdAt: string } | null;
  timeline: OnboardingTimelineEntry[];
}
export async function adminOnboarding(id: string): Promise<StaffOnboarding> {
  const { data, error } = await supabase.rpc("hr_admin_onboarding", { p_id: id });
  if (error) fail(error, "The onboarding progress could not be loaded.");
  return data as StaffOnboarding;
}

/** The pay details form (hr_admin_onboarding_pay_save): everything the offer letter and payroll need, validated again by the database. */
export interface PayDetailsForm {
  jobTitle: string; department: string; employmentType: "full_time" | "part_time" | "casual" | ""; startDate: string; workLocation: string; managerId: string;
  payBasis: "hourly" | "salary" | ""; rate: string; payScheduleId: string; hoursPerWeek: string; award: string; xeroEmployeeId: string;
}
export async function adminSavePayDetails(id: string, form: PayDetailsForm): Promise<StaffOnboarding> {
  const { data, error } = await supabase.rpc("hr_admin_onboarding_pay_save", { p_id: id, p_details: form });
  if (error) fail(error, "The pay details could not be saved.");
  return data as StaffOnboarding;
}
