import { supabase } from "@/pages/admin/lib/supabase";
import { ruleNumber } from "@/lib/businessRules";
import { invokePortalUsers } from "@/pages/agency/lib/portalData";
import { portalPasswordResetUrl } from "@/pages/agency/lib/portalAuthContext";

/**
 * Emails a student their sign-in invitation: the waiting one again when there is one, otherwise a new one. The email
 * and name come from the student record (the database checks them). Returns the message to show.
 */
export async function sendStudentInvitation(student: { id: string; email: string; name: string; agencyId: string; login?: StudentLogin }): Promise<string> {
  if (!student.email) throw new Error("Add the student's email before inviting them to sign in.");
  if (student.login?.status === "active") return `${student.name || student.email} can already sign in.`;
  const data = student.login?.invitationId
    ? await invokePortalUsers({ action: "resend", invitationId: student.login.invitationId, redirectTo: portalPasswordResetUrl() })
    : await invokePortalUsers({ action: "invite", role: "student", studentId: student.id, email: student.email, name: student.name || student.email, agencyId: student.agencyId, redirectTo: portalPasswordResetUrl() });
  return data.warning ? String(data.warning) : `Sign-in invitation sent to ${student.email}.`;
}

/**
 * Sends an Invited agent their sign-in invitation again: the waiting one when there is one, otherwise a new one (the
 * first was never sent, or it expired or was withdrawn). Returns the message to show.
 */
export async function resendInvitation(agent: { invitationId: string | null; email: string; name: string; role: "agent" | "agency_admin"; businessId: string }): Promise<string> {
  if (!agent.email) throw new Error("Add the agent's email before sending an invitation.");
  const data = agent.invitationId
    ? await invokePortalUsers({ action: "resend", invitationId: agent.invitationId, redirectTo: portalPasswordResetUrl() })
    : await invokePortalUsers({ action: "invite", email: agent.email, name: agent.name, role: agent.role, agencyId: agent.businessId, redirectTo: portalPasswordResetUrl() });
  return data.warning ? String(data.warning) : `Invitation sent to ${agent.email}.`;
}

/**
 * SLIT administrator views of the one chain: business (an agency record, unique by ABN) -> agents -> students -> applications.
 * Every call is a SQL function that checks for a SLIT administrator itself (migration 20261104090000), so nothing here relies on hiding UI.
 */

/** Stored status; "Onboarding" is a business made by staff whose agent agreement is not signed yet (migration 20261117220000). */
export type BusinessStatus = "Active" | "Inactive" | "Onboarding";
export type StatusCounts = Record<string, number>;
/** The tabs (2026-11-20): each business in exactly one of active / onboarding / inactive / pending (waiting for review); they add up to all. */
export interface ListCounts { all: number; active: number; inactive: number; onboarding?: number; pending?: number }

/** A business an agent registered from the sign-in page, waiting for a SLIT decision (migration 119). */
export interface PendingRegistration {
  id: string; name: string; abn: string; contact: string; email: string; phone: string; requestedAt: string | null;
  invitation: null | { id: string; status: "pending" | "expired" | "accepted" | "revoked"; expiresAt: string | null; email: string; name: string };
  signedIn: boolean;
}

export interface BusinessRow {
  id: string;
  name: string;
  status: BusinessStatus;
  /** The same id: the business is the agency record. Kept so callers that pass an agency id keep working. */
  agencyId: string;
  agencyCode: string;
  abn: string;
  place: string;
  contact: string;
  email: string;
  admins: number;
  agents: number;
  students: number;
  applications: number;
  statusCounts: StatusCounts;
  /** 2026-11-18: where the onboarding is up to (Application sent ... Active), or null for SLIT's own / no onboarding. */
  onboardingLabel?: string | null;
}

export interface BusinessDetail {
  id: string;
  name: string;
  status: BusinessStatus;
  /**
   * What the business is for its agents (agency_effective_status): Active only with a signed, unexpired agent agreement (or SLIT's own direct
   * business); otherwise Onboarding or Inactive. `operational` is that test; `gateReason` says, in staff words, why agents cannot be added.
   */
  effectiveStatus?: BusinessStatus;
  operational?: boolean;
  gateReason?: string | null;
  isDirect?: boolean;
  createdAt: string;
  agency: {
    id: string; code: string; name: string; status: BusinessStatus; email: string; phone: string; address: string;
    country: string; contact: string; registrationNumber: string; createdAt: string;
  };
  counts: { admins: number; agents: number; inactiveAgents: number; onboardingAgents?: number; readyAgents?: number; students: number; applications: number };
  statusCounts: StatusCounts;
  /** Onboarding: a business is activated only once its agent agreement is signed (uploaded or through Skyline Sign). */
  onboarding?: {
    completedAt: string | null;
    agreementReady: boolean;
    /** The latest onboarding's stage (agency_onboarding.stage), if any. */
    stage?: string | null;
    /** 2026-11-18: the business status in words (Application sent, Awaiting referees, Ready for review, Correction requested, Resubmitted, Active). */
    label?: string | null;
    onboardingId?: string | null;
    /** The agreement is signed (online or an uploaded copy) and the business is still onboarding: an administrator presses Activate. */
    readyToActivate?: boolean;
    /** Agents added while the business is onboarding: their sign-in invitations go out at Activate. */
    heldAgents?: number;
    contact: { agentId: string; name: string; email: string; hasLogin: boolean } | null;
  };
  /** The agent agreement sent through the onboarding documents (2026-11-17): where it is up to and its two-year term. */
  agreement?: { status: "none" | "sent" | "signed"; commencementDate: string | null; expiryDate: string | null; onboardingId: string | null; expired?: boolean };
  /** What the agent entered on the Agent Application Form, by the form's variable names. */
  profile?: Record<string, string>;
}

export type BusinessDocumentKind = "agent_agreement" | "id" | "insurance" | "other";
export interface BusinessDocument { id: string; kind: BusinessDocumentKind; fileName: string; path: string; size: number; createdAt: string; uploadedBy: string; reason?: string | null }

export interface ApplicationRow {
  id: string;
  reference: string;
  status: string;
  intake: string;
  completion: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  studentId: string;
  agentId: string | null;
  agentName: string;
  courses: Array<{ code: string; title: string; discountPercent?: number }>;
}

/** Migration 116: students per student status (the search and business/agent filters apply; the status tab does not). */
export interface StudentCounts { all: number; active: number; inactive: number;
  /** 2026-11-21: by portal access (within the enrolment filter) and by enrolment stage (within the access filter). */
  access?: Record<"all" | PortalAccess, number>; enrolment?: Partial<Record<EnrolmentStage, number>> }

/** Portal access (2026-11-21): whether the student can use the portal, never whether they are enrolled. */
export type PortalAccess = "not_invited" | "invited" | "active" | "disabled";
export const PORTAL_ACCESS_LABEL: Record<PortalAccess, string> = { not_invited: "Not invited", invited: "Invited", active: "Active", disabled: "Disabled" };
/** Enrolment, derived from the student's applications (the most advanced one); nothing is set by hand. */
export type EnrolmentStage = "none" | "applicant" | "offer_issued" | "offer_accepted" | "deposit_paid" | "enrolled" | "withdrawn";
export const ENROLMENT_LABEL: Record<EnrolmentStage, string> = { none: "No application", applicant: "Applicant", offer_issued: "Offer issued", offer_accepted: "Offer accepted",
  deposit_paid: "Deposit paid", enrolled: "Enrolled (CoE issued)", withdrawn: "Withdrawn / rejected" };
export const ENROLMENT_ORDER: EnrolmentStage[] = ["applicant", "offer_issued", "offer_accepted", "deposit_paid", "enrolled", "withdrawn", "none"];
export interface StudentEnrolment { stage: EnrolmentStage; label: string; applicationId: string | null; reference: string | null; status: string | null; course: string | null }

/** A student's sign-in (migration 118): none, invited (expired after 7 days), active, or disabled. */
export interface StudentLogin {
  status: "none" | "invited" | "expired" | "active" | "disabled";
  invitationId: string | null;
  invitedAt: string | null;
  expiresAt: string | null;
  profileId: string | null;
  email: string | null;
}

/** "can sign in", "invited, not accepted yet", "invitation expired", "sign-in disabled" or "no sign-in yet". */
export function studentLoginLabel(login: StudentLogin | undefined): string {
  switch (login?.status) {
    case "active": return "can sign in";
    case "invited": return "invited, not accepted yet";
    case "expired": return "invitation expired";
    case "disabled": return "sign-in disabled";
    default: return "no sign-in yet";
  }
}

export interface StudentRow {
  id: string; name: string; email: string; phone: string; dateOfBirth: string | null; passportNumber: string; createdAt: string; lastUpdated: string | null;
  agencyId: string; businessId: string; businessName: string; agentId: string | null; agentName: string;
  applications: number; statusCounts: StatusCounts;
  /** Migration 116: the business's status; students of an inactive business are greyed out and listed last. */
  businessStatus?: BusinessStatus;
  /** Migration 107: nationality and each application of the student (absent on older databases). */
  nationality?: string;
  applicationRows?: StudentApplication[];
  /** Migration 118: whether the student can sign in (absent on older databases). */
  login?: StudentLogin;
  /** Migration 112: Active, or Inactive (Disabled: every application of the student is locked). */
  status?: "Active" | "Inactive";
  /** 2026-11-21: portal access and enrolment, derived by the database. */
  portalAccess?: PortalAccess; enrolment?: StudentEnrolment;
}

export interface StudentApplication {
  id: string; reference: string; status: string; intake: string; completion: number; updatedAt: string; course: string | null;
  /** Moves the backend allows for the signed-in administrator (empty while the student is disabled). */
  nextStatuses?: string[];
}

/** Enable (Active) or disable (Inactive) a student; disabling locks all of their applications. */
export const setStudentStatus = (id: string, status: "Active" | "Inactive") =>
  call<{ studentId: string; status: "Active" | "Inactive" }>("admin_student_set_status", { p_student: id, p_status: status }, "We could not change this student's status.");

export interface StudentDetail {
  id: string; name: string; email: string; phone: string; dateOfBirth: string | null; passportNumber: string; nationality: string; createdAt: string;
  business: { id: string; name: string; status: BusinessStatus }; agencyId: string;
  agent: null | { id: string; name: string; email: string };
  applications: ApplicationRow[];
  login?: StudentLogin;
  /** Migration 119: what a self-enrolled student asked about, and whether they enrolled themselves. */
  courseOfInterest?: string;
  selfEnrolled?: boolean;
}

async function call<T>(fn: string, params: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.rpc(fn, params);
  // The PostgREST error stays as `cause` so the forms can map an email-taken answer (23505 / email_taken) to the field.
  if (error) throw new Error(friendly(error.message) || fallback, { cause: error });
  return data as T;
}

/** Database messages written for people are passed through; anything technical becomes the caller's fallback. */
function friendly(message: string | undefined): string {
  if (!message) return "";
  return /^(SLIT administrator|Business|Agency|That business|This business|An agency|An agent|This MARN|Say how|Portal user|OMARA agent|Status must|Agent not found|Student not found|A business with|Choose the business|Choose an agent|This agent|This student|Another student|Delete this|Enter |Role must|Only the student)/.test(message) ? message : "";
}

/** Edits a student's details (migration 113). Email and mobile stay unique across all students. */
export const updateStudent = (id: string, input: {
  fullName: string; email: string; mobile: string; dateOfBirth: string; passportNumber: string; nationality: string; agentId: string | null;
}) => call<{ id: string }>("admin_student_update", {
  p_student: id, p_full_name: input.fullName, p_email: input.email, p_phone: input.mobile, p_date_of_birth: input.dateOfBirth || null,
  p_passport: input.passportNumber, p_nationality: input.nationality, p_agent: input.agentId,
}, "We could not save this student.");

/** Deletes a student and all of their applications (migration 115); refused when one has an issued CoE / VoE or a registration. */
/** What a student is linked to, per table (migration 20261125070517), for the delete confirmation. */
export const studentLinks = (id: string) =>
  call<{ applications: number; links: { table: string; count: number }[] }>("admin_student_links", { p_student: id }, "We could not read what this student is linked to.");
/** Deletes the student with everything linked to them, enrolled or not (owner 2026-11-25; migration 20261125070517). */
export const purgeStudentRecord = (id: string) =>
  call<{ deleted: boolean; applicationsDeleted?: number; filesQueued?: number }>("admin_student_purge", { p_student: id, p_confirm: "DELETE" }, "We could not delete this student.");
export const deleteStudentRecord = (id: string) =>
  call<{ deleted: boolean; archived?: boolean; applicationsDeleted?: number; filesQueued?: number }>("admin_student_delete", { p_student: id }, "We could not delete this student.");

export const listBusinesses = (f: { search?: string; status?: string; limit: number; offset: number }) =>
  call<{ total: number; counts: ListCounts; rows: BusinessRow[] }>("admin_business_list", {
    p_search: f.search ?? "", p_status: f.status ?? "", p_limit: f.limit, p_offset: f.offset,
  }, "We could not load businesses. Please try again.");

export const getBusiness = (id: string) => call<BusinessDetail | null>("admin_business_detail", { p_business: id }, "We could not load this business.");

/** The business and its point of contact only (no email). The CMS uses createBusinessWithOnboarding (signingApi), which also sends the application form. */
export const createBusiness = (agency: Record<string, string>, contactEmail: string, contactName: string) =>
  call<{ agencyId: string; businessId: string; agencyName: string; contactAgentId: string }>("admin_business_create",
    { p_agency: agency, p_contact_email: contactEmail, p_contact_name: contactName }, "We could not create this business.");

export const listBusinessDocuments = (id: string) => call<BusinessDocument[]>("admin_business_documents", { p_business: id }, "We could not load this business’s documents.");

const DOCUMENT_BUCKET = "business-documents";
/** Business Rules agents.signed_copy_upload_max_mb (15 before the rule; 15 MB is also the bucket's ceiling). The database checks it too. */
export const businessDocumentLimitMb = () => Math.min(15, Math.max(1, Math.round(ruleNumber("agents.signed_copy_upload_max_mb", 15))));

/** The Documents tab's upload kinds (2026-11-24); "Agreement" stands in for the online agreement, so it needs a reason (the database checks it). */
export const BUSINESS_DOCUMENT_KINDS: Array<{ value: BusinessDocumentKind; label: string }> = [
  { value: "agent_agreement", label: "Agreement" }, { value: "id", label: "ID" }, { value: "insurance", label: "Insurance" }, { value: "other", label: "Other" },
];
export const businessDocumentKindLabel = (kind: string) => BUSINESS_DOCUMENT_KINDS.find((k) => k.value === kind)?.label ?? "Other";
/** What the business-documents bucket accepts (its allowed MIME types): checked before uploading so staff get a plain message. */
export const BUSINESS_DOCUMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const extensionOf = (name: string) => (name.split(".").pop() ?? "").toLowerCase();
/** The file's problem for the bucket (type or size), or null. */
export function businessDocumentProblem(file: { name: string; size: number; type?: string }): string | null {
  const ext = extensionOf(file.name);
  if (!BUSINESS_DOCUMENT_TYPES[ext]) return "Choose a PDF, PNG, JPG, DOC or DOCX file.";
  if (file.size <= 0) return "The file is empty.";
  if (file.size > businessDocumentLimitMb() * 1024 * 1024) return `The file is larger than ${businessDocumentLimitMb()} MB.`;
  return null;
}
/** PDFs and pictures open in the browser; Word files only download. */
export const opensInBrowser = (name: string) => ["pdf", "png", "jpg", "jpeg"].includes(extensionOf(name));

/** Uploads a document to the private bucket and records it against the business (the database checks the administrator and logs it). */
export async function uploadBusinessDocument(businessId: string, file: File, kind: BusinessDocumentKind = "agent_agreement", reason = "") {
  const problem = businessDocumentProblem(file);
  if (problem) throw new Error(problem);
  // A signed copy instead of the online agreement needs a reason (kept on the record and in the onboarding history); the server checks it too.
  if (kind === "agent_agreement" && reason.trim().length < Math.max(1, ruleNumber("agents.onboarding_reason_min_chars", 5))) throw new Error("Give the reason for recording a signed copy instead of the online agreement.");
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "document";
  const path = `${businessId}/${crypto.randomUUID()}-${safe}`;
  const { error } = await supabase.storage.from(DOCUMENT_BUCKET).upload(path, file, { contentType: BUSINESS_DOCUMENT_TYPES[extensionOf(file.name)] || file.type || undefined, upsert: false });
  if (error) throw new Error(error.message || "We could not upload this file.");
  await call<{ id: string }>("admin_business_document_add", { p_business: businessId, p_kind: kind, p_path: path, p_name: file.name, p_size: file.size, p_reason: reason.trim() || null }, "We could not save this document.");
}

export const removeBusinessDocument = (id: string) => call<{ ok: boolean }>("admin_business_document_remove", { p_id: id }, "We could not remove this document.");

/** A 60-second link to an uploaded document (the bucket lets SLIT administrators only make one): inline, or as a download. */
async function businessDocumentUrl(path: string, downloadName?: string): Promise<string> {
  const { data, error } = await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(path, 60, downloadName ? { download: downloadName } : undefined);
  if (error || !data?.signedUrl) throw new Error("We could not open this document.");
  return data.signedUrl;
}
/**
 * Opens a tab at once (inside the tap, so phones do not block it) and points it at the document when its address is ready; when the
 * browser refused the tab, the current page goes there instead.
 */
export async function openInNewTab(address: () => Promise<string>): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const url = await address();
    if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
  } catch (e) { tab?.close(); throw e; }
}
/** A short-lived link for the in-page viewer (DocumentViewer). */
export const businessDocumentViewUrl = (path: string) => businessDocumentUrl(path);
export const viewBusinessDocument = (path: string) => openInNewTab(() => businessDocumentUrl(path));
export async function downloadBusinessDocument(path: string, name: string) { window.location.assign(await businessDocumentUrl(path, name)); }
/** Kept for older callers: opens the document (inline when the browser can show it). */
export const openBusinessDocument = (path: string) => viewBusinessDocument(path);

/** The Documents tab's state: the agency admin (point of contact), whether the application is signed, the last resend and the wait. */
export interface BusinessDocumentStatus {
  onboardingId: string | null; applicationSent: boolean; applicationSigned: boolean; hasAgreement: boolean;
  contact: { agentId: string; name: string; email: string; hasLogin: boolean } | null;
  lastSentAt: string | null; waitSeconds: number;
}
export const businessDocumentStatus = (id: string) => call<BusinessDocumentStatus>("admin_business_document_status", { p_business: id }, "We could not load this business’s document status.");

/** Resend application (unsigned: the same signing link again, rotated when expired) or email the signed copies (document-signing). */
export async function resendBusinessApplication(id: string): Promise<{ mode: "resent" | "signed"; to: string; linkRotated?: boolean; files?: string[]; mail?: { sent: number; failed: number; requeued: number } }> {
  const { signingAction } = await import("@/lib/signingApi");
  return await signingAction({ action: "agent_onboarding_business_resend", agencyId: id });
}

/**
 * Change the agency admin's email (document-signing agent_onboarding_contact_email: records, waiting signing links, login). A sign-in
 * invitation that was waiting at the old address is withdrawn by the database; a new one goes to the new address from here.
 */
export async function changeBusinessContactEmail(businessId: string, email: string, reason: string): Promise<{ message: string; warning?: string }> {
  const { signingAction } = await import("@/lib/signingApi");
  const result = await signingAction<{ old: string; new: string; signingLinks: number; loginChanged: boolean; reinvite: Array<{ role: "agency_admin" | "agent"; name: string }> }>(
    { action: "agent_onboarding_contact_email", agencyId: businessId, email, reason });
  const parts = [`Email changed to ${result.new}.`];
  if (result.signingLinks) parts.push(`New signing link${result.signingLinks === 1 ? "" : "s"} sent; the old link${result.signingLinks === 1 ? " no longer works" : "s no longer work"}.`);
  if (result.loginChanged) parts.push("They now sign in with the new email.");
  let warning: string | undefined;
  for (const invite of result.reinvite ?? []) {
    try {
      await invokePortalUsers({ action: "invite", email: result.new, name: invite.name, role: invite.role, agencyId: businessId, redirectTo: portalPasswordResetUrl() });
      parts.push("Sign-in invitation sent to the new email.");
    } catch (e) {
      warning = `The old sign-in invitation was withdrawn, but a new one could not be sent: ${e instanceof Error ? e.message : "try Resend invitation on the Agents tab"}.`;
    }
  }
  return { message: parts.join(" "), warning };
}

export const listBusinessAgents = (id: string) => call<DirectoryAgent[]>("admin_business_agents", { p_business: id }, "We could not load this business’s agents.");

export { businessDropdownStatuses, canOfferBusinessDelete, deleteBlockReason, deleteConfirmMatches, isSlitAdmin, SYSTEM_BUSINESS_CODES } from "@/pages/admin/lib/businessDelete";
/** Whether this administrator can delete the business now, and if not why (public.admin_business_delete_check). */
export const businessDeleteCheck = (id: string) =>
  call<{ deletable: boolean; reason: string | null; name: string; abn: string | null }>("admin_business_delete_check", { p_business: id }, "We could not check this business.");
/** Delete business (document-signing agent_onboarding_business_delete): every row and file of the business, nobody emailed. */
export async function deleteBusiness(id: string, confirm: string): Promise<{ deleted: boolean; name: string; abn: string | null; filesRemoved: number; filesLeft: number }> {
  const { signingAction } = await import("@/lib/signingApi");
  return await signingAction({ action: "agent_onboarding_business_delete", agencyId: id, confirm });
}

export const setBusinessStatus = (id: string, status: BusinessStatus) =>
  call<{ businessId: string; status: BusinessStatus; agencyId: string; workspaceCreated: boolean; reviewed?: boolean; pendingInvitation?: { id: string; email: string; name: string } | null }>(
    "admin_business_set_status", { p_business: id, p_status: status }, "We could not change this business’s status.");

/**
 * Activates or deactivates a business and says what happened. Activating a business whose administrator has not set a
 * password yet (a website registration) also emails their invitation, however the business was activated.
 */
export async function changeBusinessStatus(business: { id: string; name: string }, next: BusinessStatus): Promise<string> {
  const result = await setBusinessStatus(business.id, next);
  if (next === "Inactive") return `${business.name} deactivated. Its people can no longer sign in.`;
  let message = `${business.name} activated.`;
  const waiting = result.pendingInvitation;
  if (waiting) {
    try {
      message += ` ${await resendInvitation({ invitationId: waiting.id, email: waiting.email, name: waiting.name, role: "agency_admin", businessId: business.id })}`;
      message += " They are active; until they set their password they show \"Hasn't set a password yet\".";
    } catch (e) {
      message += ` The invitation email could not be sent${e instanceof Error && e.message ? ` (${e.message})` : ""}; use Resend invite on the Agents tab.`;
    }
  }
  return message;
}

export const listPendingRegistrations = () =>
  call<PendingRegistration[]>("admin_registration_list", {}, "We could not load the registrations waiting for review.");

/** Students, optionally filtered by the student's own status (a value from the backend's student status list). */
export const listStudents = (f: { search?: string; status?: string; studentStatus?: string; access?: PortalAccess | ""; enrolment?: EnrolmentStage | ""; businessId?: string | null; agentId?: string | null; limit: number; offset: number }) =>
  call<{ total: number; counts?: StudentCounts; rows: StudentRow[] }>("admin_students_list", {
    p_search: f.search ?? "", p_status: f.status ?? "", p_business: f.businessId ?? null, p_agent: f.agentId ?? null, p_limit: f.limit, p_offset: f.offset,
    p_student_status: f.studentStatus ?? "", p_access: f.access ?? "", p_enrolment: f.enrolment ?? "",
  }, "We could not load students. Please try again.");

export const getStudent = (id: string) => call<StudentDetail | null>("admin_student_detail", { p_student: id }, "We could not load this student.");

/* ------------------------------------------------------------------ agents */

/**
 * Active: approved (their business is active); they may not have set a password yet, see awaitingPassword.
 * Invited: waiting for their business to be approved. Inactive: everything else (the default).
 * Onboarding: added to a business that is still onboarding (2026-11-19): covered by the business's onboarding, their sign-in invitation
 * held until an administrator activates the business. Declined: rejected in a per-agent onboarding before 2026-11-19 (never invited).
 */
export type AgentStatus = "Active" | "Invited" | "Inactive" | "Onboarding" | "Declined";
export interface AgentCounts { all: number; active: number; invited: number; inactive: number; onboarding?: number; declined?: number }
/** An agent's own onboarding from before 2026-11-19 (migration 20261118004521), kept for the record. */
export interface AgentOnboardingSummary { id: string; stage: string; createdAt: string; received: number; total: number; ready: boolean; agreementState?: string | null }
/** An agent waiting for their business (2026-11-19): agents have no onboarding of their own, the business's covers them. */
export function agentOnboardingWords(_o?: AgentOnboardingSummary | null): string {
  return "Covered by business onboarding: invitation held until the business is activated";
}

export interface DirectoryAgent {
  /** The agent record's id, used in links. */
  key: string;
  agentId: string;
  omaraId: string | null;
  profileId: string | null;
  /** The sign-in invitation still waiting for this agent, if any. */
  invitationId: string | null;
  name: string;
  email: string;
  phone: string;
  role: "agent" | "agency_admin";
  status: AgentStatus;
  statusChangedAt: string | null;
  marn: string;
  registered: boolean | null;
  /** The agent's own onboarding, when they were added through it. */
  onboarding?: AgentOnboardingSummary | null;
  /** On SLIT's direct business, an agent whose address is not @slit.edu.au (kept as is, flagged for a decision). */
  externalOnDirect?: boolean;
  businessId: string;
  businessName: string;
  businessStatus: BusinessStatus;
  students: number;
  statusCounts: StatusCounts;
}

export interface AgentOverview {
  key: string;
  agentId: string;
  profileId: string | null;
  omaraId: string | null;
  invitationId: string | null;
  name: string;
  email: string;
  phone: string;
  role: "agent" | "agency_admin";
  status: AgentStatus;
  statusChangedAt: string | null;
  marn: string;
  business: { id: string; name: string; status: BusinessStatus };
  onboarding?: AgentOnboardingSummary | null;
  applications: ApplicationRow[];
  students: Array<{ id: string; name: string; email: string }>;
}

export interface ActivationResult {
  agentId: string; businessId: string; businessName: string; agencyId: string;
  businessCreated: boolean; businessActivated: boolean; hasLogin: boolean; email: string; name: string; role: "agent" | "agency_admin";
  /** The business is still onboarding (2026-11-19): the agent is recorded, their sign-in invitation held until the business is activated. */
  held?: boolean;
}

export const listAgentDirectory = (f: { search?: string; status?: string; businessId?: string | null; limit: number; offset: number }) =>
  call<{ total: number; counts: AgentCounts; rows: DirectoryAgent[] }>("admin_agent_directory", {
    p_search: f.search ?? "", p_status: f.status ?? "", p_business: f.businessId ?? null, p_limit: f.limit, p_offset: f.offset,
  }, "We could not load agents. Please try again.");

/** Accepts an agent id, a portal profile id or an OMARA agent id. */
/**
 * Invited agents of each active business in which nobody has signed in yet (no Active agent). Such a business shows as
 * Invited; Resend invite sends these agents their invitation again. Reads every agent (100 a page).
 */
/** Approved or waiting, but has not set a password yet: shown with "Hasn't set a password yet" and Resend invite. */
/**
 * What staff and the business admin see as the agent's status (owner 2026-11-24): Active only once the agent has created their password
 * (a portal login); Invited while a sign-in invitation waits for them; Not invited when none was sent. Onboarding / Inactive / Declined as stored.
 */
export type AgentSignInStatus = AgentStatus | "Not invited";
/** Per email: a portal login with a password exists (e.g. created while signing the application), and the last sign-in (migration 20261124191517). */
export interface PortalLoginState { passwordSet: boolean; setAtSigning: boolean; lastSignInAt: string | null }
export const portalLoginState = (emails: string[]) =>
  call<Record<string, PortalLoginState>>("admin_portal_login_state", { p_emails: emails.filter(Boolean).slice(0, 200) }, "We could not read the sign-in state.");

export function agentSignInStatus(agent: { status: string; profileId: string | null; invitationId?: string | null }): AgentSignInStatus {
  if (agent.status !== "Active" && agent.status !== "Invited") return agent.status as AgentStatus;
  if (agent.profileId) return "Active";
  return agent.invitationId ? "Invited" : "Not invited";
}
export function awaitingPassword(agent: { status: string; profileId: string | null }): boolean {
  return (agent.status === "Active" || agent.status === "Invited") && !agent.profileId;
}

export async function invitedBusinesses(): Promise<Map<string, DirectoryAgent[]>> {
  const all: DirectoryAgent[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await listAgentDirectory({ limit: 100, offset });
    all.push(...page.rows);
    if (page.rows.length < 100 || all.length >= page.total) break;
  }
  const byBusiness = new Map<string, { active: boolean; invited: DirectoryAgent[] }>();
  for (const agent of all) {
    if (!agent.businessId || agent.businessStatus !== "Active") continue;
    const entry = byBusiness.get(agent.businessId) ?? { active: false, invited: [] };
    if (agent.status === "Active" && agent.profileId) entry.active = true;
    if (awaitingPassword(agent)) entry.invited.push(agent);
    byBusiness.set(agent.businessId, entry);
  }
  const result = new Map<string, DirectoryAgent[]>();
  for (const [id, entry] of byBusiness) if (!entry.active && entry.invited.length) result.set(id, entry.invited);
  return result;
}

export const getAgentOverview = (id: string) => call<AgentOverview | null>("admin_agent_overview", { p_id: id }, "We could not load this agent.");

/** Adds an agent to a business, or activates an existing one. `marn` links the agent to the OMARA register when given. */
export const activateAgent = (input: {
  agentId?: string | null; businessId: string | null; name: string; email: string; phone?: string; marn?: string; role: "agent" | "agency_admin";
}) => call<ActivationResult>("admin_agent_activate", {
  p_agent: input.agentId ?? null, p_business: input.businessId, p_name: input.name, p_email: input.email, p_phone: input.phone ?? "", p_marn: input.marn ?? "", p_role: input.role,
}, "We could not activate this agent.");

export interface AgentDeletePreview {
  agentId: string; name: string; students: number; assignedApplications: number; pointOfContact: boolean;
  moveTo: Array<{ id: string; name: string; status: string; role: "agent" | "agency_admin" }>;
}
/** What deleting an agent affects (admin_agent_delete_preview): students to hand over, whether they are the business's point of contact. */
export const agentDeletePreview = (agentId: string) => call<AgentDeletePreview>("admin_agent_delete_preview", { p_agent: agentId }, "We could not check this agent.");
/** Deletes an agent (admin_agent_delete): their students go to `moveTo` (another agent of the same business); applications and history stay. */
export const deleteAgent = (agentId: string, moveTo: string | null) =>
  call<{ name: string; studentsMoved: number; applicationsMoved: number; movedTo: string | null; businessId: string }>(
    "admin_agent_delete", { p_agent: agentId, p_move_to: moveTo }, "We could not delete this agent.");
export const deactivateAgent = (agentId: string) => call<{ agentId: string; status: "Inactive" }>("admin_agent_deactivate", { p_agent: agentId }, "We could not deactivate this agent.");
