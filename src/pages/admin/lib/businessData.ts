import { supabase } from "@/pages/admin/lib/supabase";
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

export type BusinessStatus = "Active" | "Inactive";
export type StatusCounts = Record<string, number>;
export interface ListCounts { all: number; active: number; inactive: number }

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
}

export interface BusinessDetail {
  id: string;
  name: string;
  status: BusinessStatus;
  createdAt: string;
  agency: {
    id: string; code: string; name: string; status: BusinessStatus; email: string; phone: string; address: string;
    country: string; contact: string; registrationNumber: string; createdAt: string;
  };
  counts: { admins: number; agents: number; inactiveAgents: number; students: number; applications: number };
  statusCounts: StatusCounts;
  /** Onboarding: a business is activated only once its agent agreement is signed (uploaded or through Skyline Sign). */
  onboarding?: {
    completedAt: string | null;
    agreementReady: boolean;
    contact: { agentId: string; name: string; email: string; hasLogin: boolean } | null;
  };
}

export interface BusinessDocument { id: string; kind: "agent_agreement" | "other"; fileName: string; path: string; size: number; createdAt: string; uploadedBy: string }

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
  courses: Array<{ code: string; title: string }>;
}

/** Migration 116: students per student status (the search and business/agent filters apply; the status tab does not). */
export interface StudentCounts { all: number; active: number; inactive: number }

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
export const deleteStudentRecord = (id: string) =>
  call<{ deleted: boolean; applicationsDeleted?: number; filesQueued?: number }>("admin_student_delete", { p_student: id }, "We could not delete this student.");

export const listBusinesses = (f: { search?: string; status?: string; limit: number; offset: number }) =>
  call<{ total: number; counts: ListCounts; rows: BusinessRow[] }>("admin_business_list", {
    p_search: f.search ?? "", p_status: f.status ?? "", p_limit: f.limit, p_offset: f.offset,
  }, "We could not load businesses. Please try again.");

export const getBusiness = (id: string) => call<BusinessDetail | null>("admin_business_detail", { p_business: id }, "We could not load this business.");

/** Add business: the business starts inactive (onboarding) with its point of contact; nothing is sent. */
export const createBusiness = (agency: Record<string, string>, contactEmail: string, contactName: string) =>
  call<{ agencyId: string; businessId: string; agencyName: string; contactAgentId: string }>("admin_business_create",
    { p_agency: agency, p_contact_email: contactEmail, p_contact_name: contactName }, "We could not create this business.");

export const listBusinessDocuments = (id: string) => call<BusinessDocument[]>("admin_business_documents", { p_business: id }, "We could not load this business’s documents.");

const DOCUMENT_BUCKET = "business-documents";

/** Uploads a signed agreement (or other document) to the private bucket and records it against the business. */
export async function uploadBusinessDocument(businessId: string, file: File, kind: BusinessDocument["kind"] = "agent_agreement") {
  if (file.size > 15 * 1024 * 1024) throw new Error("The file is larger than 15 MB.");
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "document";
  const path = `${businessId}/${crypto.randomUUID()}-${safe}`;
  const { error } = await supabase.storage.from(DOCUMENT_BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error(error.message || "We could not upload this file.");
  await call<{ id: string }>("admin_business_document_add", { p_business: businessId, p_kind: kind, p_path: path, p_name: file.name, p_size: file.size }, "We could not save this document.");
}

export const removeBusinessDocument = (id: string) => call<{ ok: boolean }>("admin_business_document_remove", { p_id: id }, "We could not remove this document.");

export async function openBusinessDocument(path: string) {
  const { data, error } = await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(path, 120);
  if (error || !data?.signedUrl) throw new Error("We could not open this document.");
  window.open(data.signedUrl, "_blank", "noopener");
}

export const listBusinessAgents = (id: string) => call<DirectoryAgent[]>("admin_business_agents", { p_business: id }, "We could not load this business’s agents.");

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
export const listStudents = (f: { search?: string; status?: string; studentStatus?: string; businessId?: string | null; agentId?: string | null; limit: number; offset: number }) =>
  call<{ total: number; counts?: StudentCounts; rows: StudentRow[] }>("admin_students_list", {
    p_search: f.search ?? "", p_status: f.status ?? "", p_business: f.businessId ?? null, p_agent: f.agentId ?? null, p_limit: f.limit, p_offset: f.offset,
    p_student_status: f.studentStatus ?? "",
  }, "We could not load students. Please try again.");

export const getStudent = (id: string) => call<StudentDetail | null>("admin_student_detail", { p_student: id }, "We could not load this student.");

/* ------------------------------------------------------------------ agents */

/**
 * Active: approved (their business is active); they may not have set a password yet, see awaitingPassword.
 * Invited: waiting for their business to be approved. Inactive: everything else (the default).
 */
export type AgentStatus = "Active" | "Invited" | "Inactive";
export interface AgentCounts { all: number; active: number; invited: number; inactive: number }

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
  applications: ApplicationRow[];
  students: Array<{ id: string; name: string; email: string }>;
}

export interface ActivationResult {
  agentId: string; businessId: string; businessName: string; agencyId: string;
  businessCreated: boolean; businessActivated: boolean; hasLogin: boolean; email: string; name: string; role: "agent" | "agency_admin";
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
export function awaitingPassword(agent: { status: string; profileId: string | null }): boolean {
  return agent.status !== "Inactive" && !agent.profileId;
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

export const deactivateAgent = (agentId: string) => call<{ agentId: string; status: "Inactive" }>("admin_agent_deactivate", { p_agent: agentId }, "We could not deactivate this agent.");
