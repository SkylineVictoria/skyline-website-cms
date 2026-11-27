import { checkedDocumentCategory } from "../../../../supabase/functions/_shared/document-category";
import { RejectedDocumentError, uploadValidatedDocument } from "@/lib/validatedDocumentUpload";
import { documentFileProblem, documentLimits, DOCUMENT_LIMITS, type DocumentLimits } from "../../../../supabase/functions/_shared/validation/person";
import { onRules, ruleList, ruleNumber } from "@/lib/businessRules";
import { supabase } from "@/pages/admin/lib/supabase";
import { countPortalMetric } from "@/pages/agency/lib/devMetrics";
import type { ApplicationStatus } from "@/pages/agency/lib/portalData";

/**
 * Data access for student applications in the Agency Portal.
 *
 * Every read is scoped by database RLS — an Agent only ever receives rows
 * assigned to them, an Agency Admin only rows for their agency, and SLIT Admin
 * rows across every agency. Nothing here trusts a client-supplied scope.
 */

const draftVersions = new Map<string, number>();
const wizardSaveStamps = new Map<string, string | null>();
const draftQueues = new Map<string, Promise<unknown>>();
if (typeof window !== "undefined") window.addEventListener("portal-scope-changed", () => {
  draftVersions.clear(); wizardSaveStamps.clear(); draftQueues.clear();
});
export async function flushApplicationEdits(id: string): Promise<void> { await draftQueues.get(id); }
/** An Error carrying the Postgres code (23514 = check_violation: its message is meant for the user). */
export function dbError(error: { message: string; code?: string }): Error & { code?: string } {
  return Object.assign(new Error(error.message), { code: error.code });
}
export const isCheckViolation = (e: unknown): e is Error => e instanceof Error && (e as { code?: string }).code === "23514";

/** AVETMISS-CHECK: answers checked against the AVETMISS code lists (public.avetmiss_check_answers). fieldErrors only flags values that
 * are filled in and invalid (blank passes); missingForSubmit lists what the student's record still lacks to submit. Null when the
 * database has no such check (the save itself still refuses a bad value). */
/** missingInAnswers (AVETMISS-PAGE-CHECK, 20261127110517): the same required answers as missingForSubmit, read from the answers sent. */
export interface AvetmissCheck { fieldErrors: Record<string, string>; missingForSubmit: string[]; missingInAnswers: string[] }
export async function avetmissCheckAnswers(values: Record<string, unknown>, studentId: string | null): Promise<AvetmissCheck | null> {
  const { data, error } = await supabase.rpc("avetmiss_check_answers", { p_values: values, p_student: studentId });
  if (error) { if (error.code === "PGRST202") return null; throw new Error(error.message); }
  const row = (data ?? {}) as { fieldErrors?: Record<string, string>; missingForSubmit?: string[]; missingInAnswers?: string[] };
  return { fieldErrors: row.fieldErrors ?? {}, missingForSubmit: Array.isArray(row.missingForSubmit) ? row.missingForSubmit.map(String) : [],
    missingInAnswers: Array.isArray(row.missingInAnswers) ? row.missingInAnswers.map(String) : [] };
}

async function draftCommand(id: string, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const prior = draftQueues.get(id) ?? Promise.resolve();
  const task = prior.catch(() => undefined).then(async () => {
    if (!draftVersions.has(id)) throw new Error("Reload the application before editing.");
    const stamp = fn === "portal_wizard_save" ? { p_saved_at: wizardSaveStamps.get(id) ?? null } : {};
    const { data, error } = await supabase.rpc(fn, { p_application_id: id, p_expected_version: draftVersions.get(id), ...stamp, ...args });
    if (error) throw dbError(error);
    draftVersions.set(id, Number(typeof data === "number" ? data : data.draft_version));
    if (fn === "portal_wizard_save") wizardSaveStamps.set(id, data.saved_at ?? null);
    return data;
  });
  draftQueues.set(id, task);
  return task;
}

export interface ApplicationCourseRow {
  courseId: string;
  code: string;
  title: string;
  variant: string;
  /** The chosen intake of this course (INT-01, course_intakes.id). */
  intakeId?: string;
  /** Discount on this course's fees in the offer letter, 0 to 100 (enrollment_application_courses.discount_percent). */
  discountPercent?: number;
}

export interface ApplicationListRow {
  id: string;
  reference: string;
  status: ApplicationStatus;
  studentName: string;
  studentEmail: string;
  intake: string;
  completion: number;
  agencyId: string;
  agencyName: string;
  agentId: string | null;
  agentName: string;
  courses: ApplicationCourseRow[];
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  isTest: boolean;
  /** Migration 109: where a SLIT administrator may move this application, decided by the backend rules (absent before it). */
  nextStatuses?: string[];
}

export interface ApplicationFilters {
  search?: string;
  status?: string;
  agencyId?: string;
  agentId?: string;
  courseCode?: string;
  intake?: string;
}

function str(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

async function profileNames(ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const { data, error } = await supabase.from("portal_profiles").select("id, full_name").in("id", unique);
  if (error) return map;
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    map.set(str(r.id), str(r.full_name));
  }
  return map;
}

/** Email and phone of one profile; RLS lets the profile itself, its agency admin and SLIT admins read it. */
async function profileContact(id: string): Promise<{ email: string; phone: string }> {
  if (!id) return { email: "", phone: "" };
  const { data, error } = await supabase.from("portal_profiles").select("email, phone").eq("id", id).maybeSingle();
  if (error || !data) return { email: "", phone: "" };
  const r = data as Record<string, unknown>;
  return { email: str(r.email), phone: str(r.phone) };
}

/** Every application the caller is authorised to see, with agency/agent/course detail. */
export async function listApplications(filters: ApplicationFilters = {}): Promise<ApplicationListRow[]> {
  countPortalMetric("applications.list");
  const rows: ApplicationListRow[] = [];
  let total = 1;
  while (rows.length < total) {
    const page = await queryApplications({ ...filters, limit: 100, offset: rows.length });
    total = page.total;
    rows.push(...page.rows);
    if (!page.rows.length) break;
  }
  return rows;
}

/** The application statuses the backend defines, in workflow order (empty before migration 109). */
export async function listApplicationStatuses(): Promise<Array<{ value: string; label: string }>> {
  const { data, error } = await supabase.rpc("portal_application_statuses");
  if (error || !Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map((item) => ({ value: str(item.value), label: str(item.label) })).filter((item) => item.value);
}

export async function queryApplications(filters: ApplicationFilters & { sort?: string; direction?: string; limit?: number; offset?: number } = {}): Promise<{ total: number; rows: ApplicationListRow[] }> {
  const { data, error } = await supabase.rpc("portal_query_applications", { p_search: filters.search ?? "", p_status: filters.status ?? "", p_agency: filters.agencyId || null, p_agent: filters.agentId || null, p_course: filters.courseCode ?? "", p_intake: filters.intake ?? "", p_sort: filters.sort ?? "updated", p_direction: filters.direction ?? "desc", p_limit: filters.limit ?? 25, p_offset: filters.offset ?? 0 });
  if (error) throw new Error(error.message);
  return { total: data.total, rows: (data.rows ?? []).map((r: Record<string, unknown>) => ({ id: str(r.id), reference: str(r.reference), status: str(r.status) as ApplicationStatus, studentName: str(r.student_name), studentEmail: str(r.student_email), intake: str(r.intake), completion: Number(r.completion), agencyId: str(r.agency_id), agencyName: str(r.agency_name), agentId: r.assigned_agent_id ? str(r.assigned_agent_id) : null, agentName: str(r.agent_name), courses: r.courses as ApplicationCourseRow[], createdAt: str(r.created_at), updatedAt: str(r.updated_at), submittedAt: r.submitted_at ? str(r.submitted_at) : null, isTest: Boolean(r.is_test), nextStatuses: Array.isArray(r.next_statuses) ? (r.next_statuses as unknown[]).map(String) : undefined })) };
}

async function fetchAgencyNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data, error } = await supabase.from("agencies").select("id, name").in("id", ids);
  if (error) return map;
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    map.set(str(r.id), str(r.name));
  }
  return map;
}

async function fetchCoursesByApplication(appIds: string[]): Promise<Map<string, ApplicationCourseRow[]>> {
  const map = new Map<string, ApplicationCourseRow[]>();
  if (appIds.length === 0) return map;
  const { data, error } = await supabase
    .from("enrollment_application_courses")
    .select("application_id, course_id, course_code, course_title, variant, intake_id, discount_percent")
    .in("application_id", appIds);
  if (error) return map;
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const key = str(r.application_id);
    const list = map.get(key) ?? [];
    const discount = Number(r.discount_percent ?? 0) || 0;
    list.push({
      courseId: str(r.course_id),
      code: str(r.course_code),
      title: str(r.course_title),
      variant: str(r.variant),
      ...(r.intake_id ? { intakeId: str(r.intake_id) } : {}),
      ...(discount > 0 ? { discountPercent: discount } : {}),
    });
    map.set(key, list);
  }
  return map;
}

/* --------------------------------------------------------------- Dashboard */

export interface StatBucket {
  id: string;
  name: string;
  total: number;
  drafts: number;
  submitted: number;
  offerAccepted: number;
  statuses?: Record<string, number>;
  actionRequired: number;
  enrolled: number;
}

export interface DashboardStats {
  total: number;
  drafts: number;
  submitted: number;
  offerAccepted: number;
  actionRequired: number;
  enrolled: number;
  byAgency: StatBucket[];
  byAgent: StatBucket[];
  recent: ApplicationListRow[];
  statuses?: Record<string, number>;
}

function emptyBucket(id: string, name: string): StatBucket {
  return { id, name, total: 0, drafts: 0, submitted: 0, offerAccepted: 0, actionRequired: 0, enrolled: 0 };
}

function addToBucket(bucket: StatBucket, status: ApplicationStatus): void {
  bucket.total += 1;
  if (status === "draft") bucket.drafts += 1;
  else if (status === "submitted") bucket.submitted += 1;
  else if (status === "offer_accepted") bucket.offerAccepted += 1;
  else if (status === "action_required") bucket.actionRequired += 1;
  else if (status === "enrolled") bucket.enrolled += 1;
}

/** Totals + agency-wise and agent-wise breakdowns for a set of applications. */
export function summarizeApplications(rows: ApplicationListRow[]): DashboardStats {
  const stats: DashboardStats = {
    total: 0,
    drafts: 0,
    submitted: 0,
    offerAccepted: 0,
    actionRequired: 0,
    enrolled: 0,
    byAgency: [],
    byAgent: [],
    recent: rows.slice(0, 6),
  };

  const agencies = new Map<string, StatBucket>();
  const agents = new Map<string, StatBucket>();

  for (const row of rows) {
    stats.total += 1;
    if (row.status === "draft") stats.drafts += 1;
    else if (row.status === "submitted") stats.submitted += 1;
    else if (row.status === "offer_accepted") stats.offerAccepted += 1;
    else if (row.status === "action_required") stats.actionRequired += 1;
    else if (row.status === "enrolled") stats.enrolled += 1;

    if (row.agencyId) {
      const bucket = agencies.get(row.agencyId) ?? emptyBucket(row.agencyId, row.agencyName || "Agency");
      addToBucket(bucket, row.status);
      agencies.set(row.agencyId, bucket);
    }
    if (row.agentId) {
      const bucket = agents.get(row.agentId) ?? emptyBucket(row.agentId, row.agentName || "Agent");
      addToBucket(bucket, row.status);
      agents.set(row.agentId, bucket);
    }
  }

  stats.byAgency = Array.from(agencies.values()).sort((a, b) => b.total - a.total);
  stats.byAgent = Array.from(agents.values()).sort((a, b) => b.total - a.total);
  return stats;
}

/** Convenience wrapper that fetches the caller's scope then summarises it. */
export async function getDashboardStats(): Promise<DashboardStats> {
  const [{ data, error }, recent] = await Promise.all([supabase.rpc("portal_dashboard"), queryApplications({limit:6})]);
  if (error) throw new Error(error.message);
  const counts = (statuses: Record<string, number>) => ({ drafts: statuses.draft ?? 0, submitted: statuses.submitted ?? 0, offerAccepted: statuses.offer_accepted ?? 0, actionRequired: statuses.action_required ?? 0, enrolled: statuses.enrolled ?? 0 });
  const buckets = (rows: Array<{ id: string; name: string; total: number; statuses: Record<string, number> }>) => rows.map(row => ({ ...row, id: row.id ?? "unassigned", ...counts(row.statuses) }));
  return { total: data.total, ...counts(data.statuses), statuses: data.statuses, byAgent: buckets(data.byAgent), byAgency: buckets(data.byAgency), recent: recent.rows };
}

/* -------------------------------------------------------------- Detail */

export interface ConsentRow {
  id: string;
  method: string;
  signedDocumentRef: string;
  declarationVersion: string;
  recordedByName: string;
  createdAt: string;
}

export interface ApplicationDetail {
  id: string;
  reference: string;
  status: ApplicationStatus;
  agencyId: string;
  agencyName: string;
  createdBy: string | null;
  createdByName: string;
  agentId: string | null;
  agentName: string;
  /** Contact details of the assigned agent (not the signed-in user); empty when unassigned or unreadable. */
  agentEmail: string;
  agentPhone: string;
  submittedByName: string;
  studentName: string;
  studentEmail: string;
  /** The student record (enrollment_students) this application belongs to. */
  studentId: string | null;
  intake: string;
  completion: number;
  /**
   * The form as one map: `values` holds the student's answers (kept on the student record) merged with this
   * application's own answers; `academicQualifications` is the student's list. Saves send the whole map and the
   * database routes each answer to the student or the application.
   */
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  version: number;
  draftVersion: number;
  tenantId: string | null;
  isTest: boolean;
  courses: ApplicationCourseRow[];
  consents: ConsentRow[];
}

export interface StatusHistoryRow {
  id: string;
  previousStatus: string;
  newStatus: string;
  actorName: string;
  actorRole: string;
  note: string;
  createdAt: string;
  /** OFFER-DEPOSIT: "deposit_paid" rows keep the status and carry the note "Initial deposit paid AUD$x". */
  actionKey: string | null;
}

export interface DocumentRow {
  id: string;
  category: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  reviewState: string;
  isCurrent: boolean;
  createdAt: string;
  storagePath: string;
  metadata: Record<string, unknown>;
}

export async function getApplication(id: string, refreshDraftRevision = true): Promise<ApplicationDetail | null> {
  countPortalMetric("applications.detail");
  const { data, error } = await supabase.rpc("portal_wizard_application", { p_application: id });
  if (error) throw new Error(error.message);
  if (!data) return null;

  const r = data as Record<string, unknown>;
  const merged = (r.data as Record<string, unknown>) ?? {};
  if (refreshDraftRevision) {
    draftVersions.set(id, Number(r.draft_version ?? 0));
    wizardSaveStamps.set(id, str(merged.savedAt) || null);
  }
  const agencyId = str(r.agency_id);
  const [nameMap, agencyMap, courseMap, consents, agentContact] = await Promise.all([
    profileNames([str(r.created_by), str(r.assigned_agent_id), str(r.submitted_by)]),
    fetchAgencyNames([agencyId]),
    fetchCoursesByApplication([id]),
    r.status === "draft" ? Promise.resolve([]) : listConsents(id),
    profileContact(str(r.assigned_agent_id)),
  ]);

  return {
    id: str(r.id),
    reference: str(r.reference),
    status: (str(r.status, "draft") as ApplicationStatus) ?? "draft",
    agencyId,
    agencyName: agencyMap.get(agencyId) ?? "",
    createdBy: str(r.created_by) || null,
    createdByName: nameMap.get(str(r.created_by)) ?? "",
    agentId: str(r.assigned_agent_id) || null,
    agentName: nameMap.get(str(r.assigned_agent_id)) ?? "",
    agentEmail: agentContact.email,
    agentPhone: agentContact.phone,
    submittedByName: nameMap.get(str(r.submitted_by)) ?? "",
    studentName: str(r.student_name),
    studentEmail: str(r.student_email),
    studentId: str(r.student_id) || null,
    intake: str(r.intake),
    completion: Number(r.completion ?? 0),
    data: merged,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    submittedAt: r.submitted_at ? str(r.submitted_at) : null,
    version: Number(r.version ?? 1),
    draftVersion: Number(r.draft_version ?? 0),
    tenantId: r.tenant_id ? String(r.tenant_id) : null,
    isTest: Boolean(r.is_test),
    courses: courseMap.get(id) ?? [],
    consents,
  };
}

export async function listConsents(applicationId: string): Promise<ConsentRow[]> {
  const { data, error } = await supabase
    .from("enrollment_application_consents")
    .select("id, method, signed_document_ref, declaration_version, recorded_by_name, created_at")
    .eq("application_id", applicationId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: str(r.id),
      method: str(r.method),
      signedDocumentRef: str(r.signed_document_ref),
      declarationVersion: str(r.declaration_version),
      recordedByName: str(r.recorded_by_name),
      createdAt: str(r.created_at),
    };
  });
}

export async function listStatusHistory(applicationId: string): Promise<StatusHistoryRow[]> {
  const { data, error } = await supabase
    .from("enrollment_application_status_history")
    .select("id, previous_status, new_status, actor_name, actor_role, note, created_at, action_key")
    .eq("application_id", applicationId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: str(r.id),
      previousStatus: str(r.previous_status),
      newStatus: str(r.new_status),
      actorName: str(r.actor_name),
      actorRole: str(r.actor_role),
      note: str(r.note),
      createdAt: str(r.created_at),
      actionKey: typeof r.action_key === "string" ? r.action_key : null,
    };
  });
}

/** STUDENT-DOCUMENTS (20261127150517): an application's documents are its own (consent, offer, ...) plus its student's personal
 *  documents, which every application of the student shares. */
async function applicationDocumentIds(applicationId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("portal_application_document_ids", { p_application: applicationId });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? (data as unknown[]).map(String) : [];
}

export async function listApplicationDocuments(applicationId: string): Promise<DocumentRow[]> {
  countPortalMetric("documents.metadata");
  const ids = await applicationDocumentIds(applicationId).catch(() => null);
  if (!ids || ids.length === 0) return [];
  const { data, error } = await supabase
    .from("enrollment_application_documents")
    .select("id, category, filename, mime_type, file_size, review_state, is_current, created_at, storage_path, metadata")
    .in("id", ids)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: str(r.id),
      category: str(r.category, "Other"),
      filename: str(r.filename),
      mimeType: str(r.mime_type),
      fileSize: Number(r.file_size ?? 0),
      reviewState: str(r.review_state, "Pending"),
      isCurrent: Boolean(r.is_current),
      createdAt: str(r.created_at),
      storagePath: str(r.storage_path),
      metadata: (r.metadata as Record<string, unknown>) ?? {},
    };
  });
}

/**
 * The most recently updated application, visible to the caller under RLS, whose student has this email or mobile.
 * Mobiles are stored as E.164; older drafts may hold the national 0-prefixed form, so both are matched.
 */
/* ------------------------------------------------------------ Students */
// One chain: business -> agent -> student -> applications. A student is created once and reused for every application.

export interface StudentMatch {
  id: string; name: string; email: string; phone: string; dateOfBirth: string | null; passportNumber: string;
  businessId: string; businessName: string; agentId: string | null; agentName: string; applications: number;
  emailMatch: boolean; phoneMatch: boolean; passportMatch: boolean;
  /** A student the caller may not see (20261113250000): nothing else is known about them. */
  taken?: boolean;
}

/** Students the caller may see with this email, mobile or passport number, newest first. */
export async function findStudents(email: string, mobileE164: string, passport = ""): Promise<StudentMatch[]> {
  const { data, error } = await supabase.rpc("portal_student_find", { p_email: email, p_phone: mobileE164, p_passport: passport });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: str(r.id), name: str(r.name), email: str(r.email), phone: str(r.phone), dateOfBirth: r.dateOfBirth ? str(r.dateOfBirth) : null,
    passportNumber: str(r.passportNumber), businessId: str(r.businessId), businessName: str(r.businessName),
    agentId: r.agentId ? str(r.agentId) : null, agentName: str(r.agentName), applications: Number(r.applications ?? 0),
    emailMatch: Boolean(r.emailMatch), phoneMatch: Boolean(r.phoneMatch), passportMatch: Boolean(r.passportMatch),
    taken: r.taken === true,
  }));
}

/**
 * The application email step (20261113230000): free = a new student; student = one the caller may start an application for
 * (reuse it, never a second one); taken = another student the caller cannot see (only the generic message is shown).
 */
export type StudentEmailLookup = { status: "free" } | { status: "student"; id: string; fullName: string } | { status: "taken" };
export async function findStudentByEmail(email: string): Promise<StudentEmailLookup> {
  const { data, error } = await supabase.rpc("find_student_by_email", { p_email: email });
  if (error) throw new Error(error.message, { cause: error });
  const row = (data ?? {}) as Record<string, unknown>;
  if (row.status === "student" && row.id) return { status: "student", id: str(row.id), fullName: str(row.full_name) };
  return row.status === "free" ? { status: "free" } : { status: "taken" };
}

export interface StudentInput {
  studentId?: string | null;
  /** The agent (agents.id) who looks after the student; the business follows from it. */
  agentId: string;
  fullName: string;
  email: string;
  mobile: string;
  dateOfBirth?: string;
  passportNumber?: string;
  nationality?: string;
  /** Migration 117: first and last name typed on Add student (sent only when given). */
  firstName?: string;
  lastName?: string;
}

/** Creates or updates a student. A new student matching an existing one of the business comes back as that student (`reused`). */
export async function saveStudent(input: StudentInput): Promise<{ id: string; name: string; email: string; phone: string; businessId: string; agentId: string | null; reused: boolean }> {
  const { data, error } = await supabase.rpc("portal_student_save", {
    p_student: input.studentId ?? null, p_agent: input.agentId, p_full_name: input.fullName, p_email: input.email, p_phone: input.mobile,
    p_date_of_birth: input.dateOfBirth || null, p_passport: input.passportNumber ?? "", p_nationality: input.nationality ?? "",
    ...(input.firstName || input.lastName ? { p_first_name: input.firstName ?? "", p_last_name: input.lastName ?? "" } : {}),
  });
  if (error) throw new Error(error.message, { cause: error });
  const r = (data ?? {}) as Record<string, unknown>;
  return { id: str(r.id), name: str(r.name), email: str(r.email), phone: str(r.phone), businessId: str(r.businessId), agentId: r.agentId ? str(r.agentId) : null, reused: Boolean(r.reused) };
}

/** A draft just created has no draft version yet: read it once (as getApplication does) so the first save can be checked
 * against it (STUDENT-NEW-APPLICATION-SAVE). An error leaves it untracked; draftCommand then asks for a reload as before. */
async function trackNewDraft(id: string): Promise<void> {
  const { data, error } = await supabase.rpc("portal_wizard_application", { p_application: id });
  if (error || !data) return;
  const r = data as Record<string, unknown>;
  const merged = (r.data as Record<string, unknown>) ?? {};
  draftVersions.set(id, Number(r.draft_version ?? 0));
  wizardSaveStamps.set(id, str(merged.savedAt) || null);
}

/** Creates the student and draft in one transaction. */
export async function createStudentDraft(email: string, agentId: string, clientKey: string): Promise<string> {
  const { data, error } = await supabase.rpc("portal_start_student_draft", {
    p_email: email, p_agent: agentId, p_client_key: clientKey,
  });
  if (error) throw new Error(error.message, { cause: error });
  if (typeof data !== "string") throw new Error("The draft could not be created.");
  await trackNewDraft(data);
  return data;
}

/** INVITE-SMS: what happened to the text message sent with the invitation email. */
export type InviteSmsResult = "sent" | "failed" | "no_mobile" | "not_connected" | "not_requested" | "skipped";
export const INVITE_SMS_LABEL: Record<InviteSmsResult, string> = {
  sent: "Also sent by text message.", failed: "The text message could not be sent (the email went).",
  no_mobile: "No text sent: the application has no mobile number.", not_connected: "No text sent: ClickSend is not connected (Integrations › Connections).",
  not_requested: "", skipped: "",
};

export async function sendApplicationInvitation(applicationId: string, correctedEmail?: string, text = true): Promise<InviteSmsResult> {
  const { data, error } = await supabase.functions.invoke("student-application-invite", {
    body: { applicationId, correctedEmail, channels: text ? ["email", "sms"] : ["email"] },
  });
  if (error) {
    const detail = error.context instanceof Response ? await error.context.json().catch(() => null) : null;
    throw new Error(detail?.error ?? "The invitation could not be sent. Try again from Finish Application.");
  }
  return (data?.sms as InviteSmsResult) ?? "not_requested";
}

export interface WizardSummary {
  invitationStatus: string;
  status: string;
  completion: number;
  lastSaved: string;
  lastStep: string | null;
  updatedBy: string;
}

export async function getWizardSummary(id: string): Promise<WizardSummary | null> {
  const { data, error } = await supabase.rpc("portal_wizard_invitation_status", { p_application: id });
  if (error) throw new Error(error.message);
  return data as WizardSummary | null;
}

export const needsInitialWizard = (application: { status: string; submittedAt?: string | null }): boolean =>
  application.status === "draft" && !application.submittedAt;

/** A new draft application for a student; its business and assigned agent come from the student. */
export async function createApplicationForStudent(clientKey: string, studentId: string): Promise<{ id: string; reference: string }> {
  const { data, error } = await supabase.rpc("portal_create_student_application", { p_client_key: clientKey, p_student: studentId });
  if (error) throw new Error(error.message, { cause: error });
  const row = (Array.isArray(data) ? data[0] : data) as { application_id?: string; application_reference?: string } | null | undefined;
  if (!row?.application_id) throw new Error("The application could not be created.");
  await trackNewDraft(String(row.application_id));
  return { id: String(row.application_id), reference: String(row.application_reference ?? "") };
}

export interface StudentAgencyOptions {
  /** The student is under SLIT's direct business with no application yet, so "Are you working with an agency?" is asked. */
  ask: boolean;
  businesses: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string; role: string }>;
  /** Who the student is recorded with now (STUDENT-NEW-APPLICATION-AGENT; null before migration 20261127030517). */
  current: { businessId: string | null; businessName: string | null; direct: boolean; agentId: string | null; agentName: string | null; hasApplications: boolean } | null;
}

/** Active businesses a self-enrolled student may choose, and (for one business) its active agents. */
export async function studentAgencyOptions(businessId?: string): Promise<StudentAgencyOptions> {
  const { data, error } = await supabase.rpc("portal_student_agency_options", { p_business: businessId ?? null });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as Partial<StudentAgencyOptions>;
  return { ask: row.ask === true, businesses: row.businesses ?? [], agents: row.agents ?? [], current: row.current ?? null };
}

/** The signed-in student picks another active agent of their own business (portal_student_change_agent). */
export async function changeStudentAgent(agentId: string): Promise<{ agentName: string }> {
  const { data, error } = await supabase.rpc("portal_student_change_agent", { p_agent: agentId });
  if (error) throw new Error(error.message);
  return { agentName: String((data as { agentName?: string } | null)?.agentName ?? "") };
}

/** Moves the signed-in student (record, sign-in and pending invitation) under the chosen business and agent. */
export async function chooseStudentAgency(businessId: string, agentId: string): Promise<{ businessName: string; agentName: string }> {
  const { data, error } = await supabase.rpc("portal_student_choose_agency", { p_business: businessId, p_agent: agentId });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as { businessName?: string; agentName?: string };
  return { businessName: String(row.businessName ?? ""), agentName: String(row.agentName ?? "") };
}

export interface BusinessAgentOption {
  id: string;
  profileId: string | null;
  name: string;
  email: string;
  role: "agent" | "agency_admin";
  /** Active: approved and signed in. Invited: approved, no login yet. Inactive: cannot be given students until activated. */
  status: "Active" | "Invited" | "Inactive";
}

const toAgentOption = (r: Record<string, unknown>): BusinessAgentOption => ({
  id: str(r.id), profileId: r.profile_id ? str(r.profile_id) : null, name: str(r.full_name), email: str(r.email),
  role: r.role === "agency_admin" ? "agency_admin" : "agent",
  status: r.status !== "Active" ? "Inactive" : r.profile_id ? "Active" : "Invited",
});

/** The agents of one business (SLIT administrators see every business; portal users their own). */
export async function listAgentsOfBusiness(businessId: string): Promise<BusinessAgentOption[]> {
  const { data, error } = await supabase.from("agents").select("id, profile_id, full_name, email, role, status").eq("business_id", businessId).order("full_name");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => toAgentOption(r as Record<string, unknown>));
}

/** Can be given a student: the agent record is Active (signed in or not yet; owner 2026-11-25: "Invited" agents were hidden). */
export const agentPickable = (a: BusinessAgentOption) => a.status !== "Inactive";

/** Active agents of every other Active business (SLIT staff pick any agent; owner 2026-11-25), with their business. */
export async function listActiveAgentsElsewhere(excludeBusinessId: string): Promise<{ agent: BusinessAgentOption; business: { id: string; name: string; status: "Active" } }[]> {
  const { data, error } = await supabase.from("agents").select("id, profile_id, full_name, email, role, status, business_id")
    .eq("status", "Active").neq("business_id", excludeBusinessId).order("full_name").limit(500);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  const ids = [...new Set(rows.map((r) => str(r.business_id)).filter(Boolean))];
  if (!ids.length) return [];
  const { data: biz, error: bizError } = await supabase.from("agencies").select("id, name, status").in("id", ids);
  if (bizError) throw new Error(bizError.message);
  const active = new Map(((biz ?? []) as Record<string, unknown>[]).filter((b) => b.status === "Active").map((b) => [str(b.id), str(b.name)]));
  return rows.filter((r) => active.has(str(r.business_id)))
    .map((r) => ({ agent: toAgentOption(r), business: { id: str(r.business_id), name: active.get(str(r.business_id)) ?? "", status: "Active" as const } }));
}

/** The agent record behind a portal login, if any. */
export async function findAgentByProfile(profileId: string): Promise<BusinessAgentOption | null> {
  const { data, error } = await supabase.from("agents").select("id, profile_id, full_name, email, role, status").eq("profile_id", profileId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toAgentOption(data as Record<string, unknown>) : null;
}

/* ------------------------------------------------------------ Mutation */

export interface DraftPatch {
  data: Record<string, unknown>;
  studentName: string;
  studentEmail: string;
  intake: string;
  completion: number;
}

/** Atomically saves form values while retaining wizard/review metadata under RLS. */
export async function saveApplicationDraft(id: string, patch: DraftPatch): Promise<void> {
  await draftCommand(id, "portal_save_draft_v2", { p_patch: patch.data });
}

export async function saveWizardDraft(id: string, patch: Record<string, unknown>): Promise<void> {
  await draftCommand(id, "portal_wizard_save", { p_patch: patch });
}

export async function listInstitutionCourses(): Promise<ApplicationCourseRow[]> {
  const { data, error } = await supabase.rpc("portal_course_options");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Replaces the selected course rows for an application. */
export async function replaceApplicationCourses(
  id: string,
  coursesToSave: ApplicationCourseRow[],
): Promise<void> {
  const { error: deleteError } = await supabase
    .from("enrollment_application_courses")
    .delete()
    .eq("application_id", id);
  if (deleteError) throw new Error(deleteError.message);
  if (coursesToSave.length === 0) return;
  const { error } = await supabase.from("enrollment_application_courses").insert(
    coursesToSave.map((course) => ({
      application_id: id,
      course_id: course.courseId,
      course_code: course.code,
      course_title: course.title,
      variant: course.variant,
    })),
  );
  if (error) throw new Error(error.message);
}

export interface ConsentInput {
  method: string;
  signedDocumentRef: string;
  declarationVersion: string;
  recordedByName: string;
}

export async function recordConsent(applicationId: string, consent: ConsentInput): Promise<void> {
  const { error } = await supabase.from("enrollment_application_consents").insert({
    application_id: applicationId,
    method: consent.method,
    signed_document_ref: consent.signedDocumentRef,
    declaration_version: consent.declarationVersion,
    recorded_by_name: consent.recordedByName,
  });
  if (error) throw new Error(error.message);
}

/** Uploads a signed consent document into the private application store. */
export async function uploadConsentDocument(applicationId: string, file: File): Promise<string> {
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const path = `${applicationId}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage.from("enrollment-documents").upload(path, file, { upsert: false });
  if (error) throw new Error(error.message);
  const { error: docError } = await supabase.from("enrollment_application_documents").insert({
    application_id: applicationId,
    category: "Consent",
    bucket_name: "enrollment-documents",
    storage_path: path,
    filename: file.name,
    mime_type: file.type || null,
    file_size: file.size,
  });
  if (docError) throw new Error(docError.message);
  return path;
}

/* -------------------------------------------------------------- RPCs */

export async function assignApplicationAgent(applicationId: string, agentProfileId: string | null): Promise<void> {
  const { error } = await supabase.rpc("portal_assign_agent", {
    p_application_id: applicationId,
    p_agent_profile_id: agentProfileId,
  });
  if (error) throw new Error(error.message);
}

/**
 * APPLICATION-STUDENT-SIGNS: only the student signs and submits (the database refuses anyone else). consent = { declarations:
 * { key: hash of the text shown } }. A student under 18 waits for their parent / guardian (waitingGuardian, no reference yet).
 */
export async function submitApplication(
  applicationId: string,
  consent: { declarations: Record<string, string>; signature?: string },
): Promise<{ reference: string; waitingGuardian: boolean }> {
  const key = "submission:" + applicationId + ":" + (draftVersions.get(applicationId) ?? "unknown");
  const { data, error } = await supabase.rpc("portal_submit_v2", {
    p_application_id: applicationId, p_expected_version: draftVersions.get(applicationId),
    p_request_key: key, p_consent: consent,
  });
  if (error) throw dbError(error);
  return { reference: String(data?.reference ?? ""), waitingGuardian: data?.state === "waiting_guardian" };
}

export async function setApplicationStatus(applicationId: string, status: string, note = ""): Promise<void> {
  const { error } = await supabase.rpc("portal_set_application_status", {
    p_application_id: applicationId,
    p_status: status,
    p_note: note,
  });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------- Offer letter and workflow commands */

export interface OfferRecipient { kind: "agent" | "student"; name: string; email: string; reason: string; declarationMismatch: boolean }
/** OFFER-DEPOSIT: the initial deposit asked for with a letter and where its Stripe payment stands (hr.sign_payment_json plus the letter's own request). */
export interface OfferPayment {
  id?: string; status?: string; amount_cents?: number; currency?: string; paid_at?: string | null; amount_paid_cents?: number | null; failure_reason?: string | null; livemode?: boolean | null;
  receipt_url?: string | null; stripe_payment_intent_id?: string | null;
  requestedAmountCents: number | null; requestedCurrency: string; requestedDescription: string | null; note: string | null; depositPaidAt: string | null;
  /** OFFER-DEPOSIT: reminders sent for this deposit and the letter's automatic-reminder switch. */
  reminder_count?: number | null; last_reminder_at?: string | null; autoRemind?: boolean | null;
}
/** "Paid" / "Payment pending" / "Payment failed" and the amount, for the offer letter lists. */
export function offerPaymentState(payment: OfferPayment | null | undefined): { label: string; tone: "paid" | "pending" | "failed" } | null {
  if (!payment || (payment.requestedAmountCents == null && !payment.status)) return null;
  const cents = payment.status === "paid" && payment.amount_paid_cents != null ? payment.amount_paid_cents : payment.amount_cents ?? payment.requestedAmountCents ?? 0;
  const amount = `${(payment.currency ?? payment.requestedCurrency ?? "aud").toUpperCase()} ${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (payment.status === "paid" || payment.depositPaidAt) return { label: `Paid ${amount}`, tone: "paid" };
  if (payment.status === "refunded") return { label: `Refunded ${amount}`, tone: "failed" };
  if (payment.status === "failed") return { label: `Payment failed · ${amount}`, tone: "failed" };
  return { label: `Payment pending · ${amount}`, tone: "pending" };
}
export interface OfferLetter {
  id: string; fileName: string; sizeBytes: number; source: string; message: string; recipientKind: "agent" | "student"; recipientName: string; recipientEmail: string;
  issuedAt: string; issuedByName: string; resentAt: string | null; acceptedAt: string | null; acceptedByName: string; acceptedVia: "portal" | "staff" | "signing" | "signing_and_payment" | null;
  payment?: OfferPayment | null;
}
/**
 * OFFER-DEPOSIT: where the letter's initial deposit stands, apart from its acceptance. "Not required" when the letter asked for none
 * (or staff removed the payment), "Pending" until Stripe verified it, "Paid" with the date after that.
 */
export function offerDepositState(payment: OfferPayment | null | undefined): { label: string; tone: "paid" | "pending" | "none" | "failed"; amount: string | null } {
  if (!payment || (payment.requestedAmountCents == null && !payment.status) || (!payment.status && !payment.depositPaidAt)) return { label: "Not required", tone: "none", amount: null };
  const cents = payment.status === "paid" && payment.amount_paid_cents != null ? payment.amount_paid_cents : payment.amount_cents ?? payment.requestedAmountCents ?? 0;
  const amount = `${(payment.currency ?? payment.requestedCurrency ?? "aud").toUpperCase()}$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const paidOn = payment.depositPaidAt ?? payment.paid_at ?? null;
  if (paidOn || payment.status === "paid") return { label: `Paid${paidOn ? ` (${new Date(paidOn).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })})` : ""}`, tone: "paid", amount };
  if (payment.status === "refunded") return { label: "Refunded", tone: "failed", amount };
  if (payment.status === "failed") return { label: "Payment failed", tone: "failed", amount };
  return { label: "Pending", tone: "pending", amount };
}
/** "Offer accepted: Yes · Deposit: Pending", the one line staff and agents read on a letter. */
export function offerAcceptanceLine(letter: { acceptedAt: string | null; payment?: OfferPayment | null }): string {
  const deposit = offerDepositState(letter.payment);
  return `Offer accepted: ${letter.acceptedAt ? "Yes" : "No"} · Deposit: ${deposit.label}${deposit.amount && deposit.tone !== "none" ? ` · ${deposit.amount}` : ""}`;
}
/** Send payment reminder (staff, or the application's agent): the student gets their personal link again. P0024: one was sent in the last 24 hours (force to send anyway). */
export async function sendDepositReminder(applicationId: string, force = false): Promise<{ reminderCount: number; lastReminderAt: string | null }> {
  const { data, error } = await supabase.rpc("offer_deposit_reminder_send", { p_application: applicationId, p_force: force });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as { reminderCount: number; lastReminderAt: string | null };
}
/** Staff: automatic reminders for this offer's deposit (every 3 days, at most 3), default off. */
export const setDepositAutoRemind = (applicationId: string, on: boolean) => rpcOrThrow<{ autoRemind: boolean }>("offer_deposit_set_auto_remind", { p_application: applicationId, p_on: on });

const rpcOrThrow = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
};

/** Who the offer letter will go to and why, and whether the declaration needs a staff note (staff only). */
export const offerLetterRecipient = (applicationId: string) => rpcOrThrow<OfferRecipient>("portal_offer_letter_recipient", { p_application: applicationId });
/** Send offer letter: the PDF (template or upload, base64), an optional message and, for a declaration mismatch, the staff note. */
export const issueOfferLetter = (input: { applicationId: string; source: "template" | "upload"; fileName: string; contentBase64: string; templateId?: string | null; message?: string; overrideNote?: string }) =>
  rpcOrThrow<{ id: string }>("portal_offer_letter_issue", { p_application: input.applicationId, p_source: input.source, p_file_name: input.fileName, p_content_base64: input.contentBase64,
    p_template: input.templateId ?? null, p_message: input.message ?? "", p_override_note: input.overrideNote ?? "" });
export const resendOfferLetter = (applicationId: string, note = "") => rpcOrThrow<void>("portal_offer_letter_resend", { p_application: applicationId, p_note: note });
export const currentOfferLetter = (applicationId: string) => rpcOrThrow<OfferLetter | null>("portal_offer_letter_current", { p_application: applicationId });
export const offerLetterList = (applicationId: string) =>
  rpcOrThrow<Array<{ id: string; fileName: string; sizeBytes: number; issuedAt: string; acceptedAt: string | null; recipientKind: string; recipientEmail: string; templateName?: string; templateVersion?: number | null;
    acceptedVia?: string | null; signedAt?: string | null; hasSigned?: boolean; hasPaymentCopy?: boolean; hasCertificate?: boolean; prepaidMore?: "YES" | "NO" | null; payment?: OfferPayment | null;
    signing?: { status: string; expiresAt: string | null; viewedAt: string | null; reference: string } | null }>>("portal_offer_letter_list", { p_application: applicationId });
/**
 * The signed offer letter (signed online), or its payment-confirmed copy (Payment made: Yes and the date added once the deposit is paid),
 * opened in a new tab. The signing audit record is never downloadable (owner 2026-11-20).
 */
export async function openOfferLetterFile(letterId: string, kind: "signed" | "payment_confirmed"): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const file = await rpcOrThrow<{ fileName: string; contentBase64: string }>("portal_offer_letter_file", { p_letter: letterId, p_kind: kind });
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0))], { type: "application/pdf" }));
    if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { tab?.close(); throw error; }
}
/** Opens an offer letter PDF in a new tab (the tab is opened first, while the click still counts). */
export async function openOfferLetter(letterId: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const letter = await rpcOrThrow<{ fileName: string; contentBase64: string }>("portal_offer_letter_content", { p_letter: letterId });
    const bytes = Uint8Array.from(atob(letter.contentBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { tab?.close(); throw error; }
}
/** Accept offer: the student or agent confirms (no signature); the application moves to Offer accepted. */
export const acceptOffer = (applicationId: string) => rpcOrThrow<void>("portal_offer_accept", { p_application: applicationId });
/** Resubmit (Action required → Submitted): the student signs the declarations again ({ declarations: { key: hash } }); only the student. */
export const resubmitApplication = (applicationId: string, note = "", consent: { declarations: Record<string, string>; signature?: string } | null = null) =>
  rpcOrThrow<void>("portal_application_resubmit", { p_application: applicationId, p_note: note, p_consent: consent });
/** Send reminder: emails the student or agent what Action required still asks for. */
export const sendActionReminder = (applicationId: string, note = "") => rpcOrThrow<void>("portal_application_reminder", { p_application: applicationId, p_note: note });
/** Payload of change_application_status: a reason from status_reasons ("Other" with its text), a note, notify (default true), the enrolment date. */
export interface StatusChangePayload { reason_id?: string; reason_text?: string; note?: string; notify?: boolean; enrolment_date?: string }
/** The one staff command for status moves, reminders and resends (the database checks the transition, the role, access and the reason). */
export const changeApplicationStatus = (applicationId: string, action: string, payload: StatusChangePayload = {}) =>
  rpcOrThrow<{ status: string; label: string; from?: string; undoable?: boolean }>("change_application_status", { p_application: applicationId, p_action: action, p_payload: payload });
/** Undo (the toast, 15 seconds) of the caller's last change with a reason. */
export const revertApplicationStatus = (applicationId: string) => rpcOrThrow<{ status: string; label: string }>("revert_application_status", { p_application: applicationId });
/** Issue CoE / VoE in one step: the document (PDF, base64), its number and issue date, a note; the status moves to CoE / VoE issued. */
export const issueCoeVoe = (input: { applicationId: string; kind: "coe" | "voe"; number: string; issueDate: string; fileName: string; contentBase64: string; note: string; notify: boolean }) =>
  rpcOrThrow<{ documentId: string; status?: string; label?: string }>("issue_coe_voe", { p_application: input.applicationId, p_kind: input.kind, p_number: input.number, p_issue_date: input.issueDate,
    p_file_name: input.fileName, p_content: input.contentBase64, p_note: input.note, p_notify: input.notify });

/* --------------------------------------------------------------- Agents */

export interface AgentOption {
  profileId: string;
  fullName: string;
  email: string;
  agencyId: string;
  agencyName: string;
}

/** Active agents the caller may assign work to. */
export async function listAssignableAgents(agencyId?: string): Promise<AgentOption[]> {
  let query = supabase
    .from("agency_memberships")
    .select("user_id, agency_id, role, status, portal_profiles(id, full_name, email), agencies(name)")
    .eq("role", "agent")
    .eq("status", "Active");
  if (agencyId) query = query.eq("agency_id", agencyId);

  const { data, error } = await query;
  if (error) return [];
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const profile = (r.portal_profiles as Record<string, unknown> | null) ?? {};
    const agency = (r.agencies as Record<string, unknown> | null) ?? {};
    return {
      profileId: str(r.user_id),
      fullName: str(profile.full_name),
      email: str(profile.email),
      agencyId: str(r.agency_id),
      agencyName: str(agency.name),
    };
  });
}

/* ------------------------------------------- Wizard: documents + drafts */

/** Business Rules admissions.application_document_limit_mib / admissions.application_document_types (never above the 10 MB, PDF / JPG / PNG ceiling). */
let documentRules: DocumentLimits = DOCUMENT_LIMITS;
export let MAX_DOCUMENT_BYTES = DOCUMENT_LIMITS.maxBytes;
onRules(() => {
  documentRules = documentLimits(ruleNumber("admissions.application_document_limit_mib", 10), ruleList("admissions.application_document_types", ["JPEG", "PNG", "PDF"]));
  MAX_DOCUMENT_BYTES = documentRules.maxBytes;
});

/** Size, declared type and content of a picked file: the shared rule (also the staff onboarding wizard's and its Edge Function's). */
async function validateDocumentFile(file: File): Promise<void> {
  const problem = documentFileProblem(file, new Uint8Array(await file.slice(0, 8).arrayBuffer()), documentRules);
  if (problem) throw new RejectedDocumentError(problem);
}

export interface UploadDocumentInput {
  applicationId: string;
  category: string;
  file: File;
  uploadedBy?: string | null;
  metadata?: Record<string, unknown>;
  /** Called once the object and its metadata row are stored, before extraction is queued. */
  onStored?: (doc: UploadedDocument) => void;
}

export interface UploadedDocument {
  id: string;
  path: string;
  category: string;
  filename: string;
}

async function sha256(file: File): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Uploads a document into the private `enrollment-documents` bucket and records
 * its metadata row. Storage success is only reported once BOTH the object upload
 * and the metadata insert succeed — if the metadata write fails we remove the
 * orphaned object so storage and the database can never drift apart.
 */
export async function uploadApplicationDocument(input: UploadDocumentInput): Promise<UploadedDocument> {
  const { applicationId, category, file, uploadedBy, metadata, onStored } = input;
  await validateDocumentFile(file);
  const contentSha256 = await sha256(file);
  // A retry after a lost response must return the original document, rather than
  // creating another private object and another qualification.
  const protectedCategory = checkedDocumentCategory(category);
  const documentIds = await applicationDocumentIds(applicationId);
  const { data: duplicate, error: duplicateError } = await supabase.from("enrollment_application_documents")
    .select("id, application_id, storage_path, category, filename")
    .in("id", documentIds.length ? documentIds : ["00000000-0000-0000-0000-000000000000"])
    .eq("category", category)
    .eq("is_current", true)
    .eq("metadata->>contentSha256", contentSha256)
    .maybeSingle();
  if (duplicateError) throw new Error(duplicateError.message);
  if (duplicate) {
    const id = String(duplicate.id);
    const path = String(duplicate.storage_path);
    // Check retries against the current passport before returning the saved file. The same file the student already gave in another
    // application (STUDENT-DOCUMENTS) is simply theirs already: nothing to upload or check again.
    if (protectedCategory && String(duplicate.application_id) === applicationId) {
      await uploadValidatedDocument("enrollment", applicationId, category, file, id);
    }
    return { id, path, category: String(duplicate.category), filename: String(duplicate.filename) };
  }

  const bucket = supabase.storage.from("enrollment-documents");
  let path: string;
  if (protectedCategory) {
    path = await uploadValidatedDocument("enrollment", applicationId, category, file);
  } else {
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    path = `${applicationId}/${crypto.randomUUID()}-${safeName}`;
    const { error } = await bucket.upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (error) throw new Error(error.message);
  }

  const { data, error: metaError } = await supabase
    .from("enrollment_application_documents")
    .insert({
      application_id: applicationId,
      category,
      bucket_name: "enrollment-documents",
      storage_path: path,
      filename: file.name,
      mime_type: file.type || null,
      file_size: file.size,
      uploaded_by: uploadedBy ?? null,
      metadata: { ...(metadata ?? {}), contentSha256 },
    })
    .select("id")
    .maybeSingle();

  if (metaError) {
    // Metadata failed → remove the orphaned object so storage stays consistent.
    await supabase.storage.from("enrollment-documents").remove([path]);
    throw new Error(metaError.message);
  }

  const id = String(data?.id ?? "");
  onStored?.({ id, path, category, filename: file.name });
  // Queue through a trusted backend after the row exists. A failed enqueue does
  // not invalidate an upload; it remains visible and can be retried explicitly.
  try { await queueDocumentExtraction(id); } catch { /* surfaced by the document's retry control */ }
  return { id, path, category, filename: file.name };
}

/** Queues one authorised document for backend extraction; never sends file data or provider credentials from the browser. */
export async function queueDocumentExtraction(documentId: string, reextract = false): Promise<void> {
  const { data, error } = await supabase.functions.invoke("portal-document-extract", { body: { documentId, reextract } });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(String(data?.error ?? "Document extraction could not be queued."));
}

/** Serialised server-side with extraction writes; no browser read/modify/write race. */
export async function saveDocumentReview(input: {
  applicationId: string; values: Record<string, string>; provenance: Record<string, string>;
  confirmed: string[]; resolutions?: Array<{ field: string; documentId?: string | null; candidateValue?: string; state: "confirmed" | "corrected" | "rejected" }>;
  wizard?: Record<string, unknown>; studentName?: string;
}): Promise<void> {
  await draftCommand(input.applicationId, "portal_review_draft_v2", {
    p_values: input.values, p_provenance: input.provenance,
    p_confirmed: input.confirmed, p_resolutions: input.resolutions ?? [], p_wizard: input.wizard ?? {}, p_student_name: input.studentName ?? null,
  });
}


/** Removes a document (object + metadata row) the caller is authorised to delete. */
export async function deleteApplicationDocument(doc: { id: string; storagePath: string }): Promise<void> {
  // The server resolves bucket/path from the authorised document row. Never
  // accept a browser-controlled storage path for destructive operations.
  const { data, error } = await supabase.functions.invoke("portal-document-delete", { body: { documentId: doc.id } });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(String(data?.error ?? "Document deletion failed."));
}

/** Creates a short-lived signed URL so an authorised user can view a private document. */
export async function getDocumentSignedUrl(storagePath: string, expiresIn = 300, downloadName?: string): Promise<string> {
  countPortalMetric("documents.signedUrl");
  if (!storagePath) throw new Error("This document has no stored file.");
  const { data, error } = await supabase.storage
    .from("enrollment-documents")
    .createSignedUrl(storagePath, expiresIn, downloadName ? { download: downloadName } : undefined);
  if (error) throw new Error(error.message);
  return data?.signedUrl ?? "";
}

/** Removes a draft the caller owns (used only when a wizard session is abandoned empty). */
export async function deleteApplicationDraft(id: string): Promise<void> {
  const { error } = await supabase.from("enrollment_applications").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** STUDENT-PORTAL-INVITE (2026-11-24): the student's workspace sign-in as the agent, the business admin agent or SLIT sees it. */
export type StudentPortalStatus = "active" | "no_password" | "invited" | "expired" | "disabled" | "none";
export interface StudentPortalState { status: StudentPortalStatus; invitationId: string | null; invitedAt: string | null; email: string }
export async function getStudentPortalState(studentId: string): Promise<StudentPortalState> {
  const { data, error } = await supabase.rpc("portal_student_portal_state", { p_student: studentId });
  if (error) throw new Error(error.message || "The student's sign-in could not be loaded.");
  const r = (data ?? {}) as Record<string, unknown>;
  return { status: String(r.status ?? "none") as StudentPortalStatus, invitationId: r.invitationId ? String(r.invitationId) : null,
    invitedAt: r.invitedAt ? String(r.invitedAt) : null, email: String(r.email ?? "") };
}
/** What the screen shows and offers for a student's sign-in state (Active only once the student has created a password). */
export function studentPortalLabel(status: StudentPortalStatus): { label: string; action: "invite" | "resend" | null } {
  switch (status) {
    case "active": return { label: "Portal: Active", action: null };
    case "no_password": return { label: "Portal: no password yet", action: null };
    case "invited": return { label: "Portal: Invited", action: "resend" };
    case "expired": return { label: "Portal: Invited (link expired)", action: "resend" };
    case "disabled": return { label: "Portal: Disabled", action: null };
    default: return { label: "Portal: Not invited", action: "invite" };
  }
}
