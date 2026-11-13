import { normalizeAbn, validateAbn } from "../../../../supabase/functions/_shared/validation/abn";
import { supabase } from "@/pages/admin/lib/supabase";
import type { PortalAgency } from "@/pages/agency/lib/portalAuthContext";

/** Data access for the Agency Portal. Every read is scoped by database RLS. */

/** An application status: one of the values of the database's catalogue (application_statuses). */
export type ApplicationStatus = string;

export const ROLE_LABELS: Record<string, string> = {
  slit_admin: "SLIT Admin",
  agency_admin: "Business admin agent",
  agent: "Agent",
  student: "Student",
};

export interface DashboardCounts {
  total: number;
  drafts: number;
  offerAccepted: number;
  actionRequired: number;
  enrolled: number;
}

export interface AgencyMemberRow {
  profileId: string;
  fullName: string;
  email: string;
  role: "agency_admin" | "agent";
  status: string;
}

export interface PortalUserRow {
  profileId: string;
  authUserId: string;
  fullName: string;
  email: string;
  phone: string;
  status: string;
  role: "agency_admin" | "agent" | "student" | null;
  agencyId: string | null;
  agencyName: string;
}

export interface NotificationRow {
  id: string;
  reference: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

function mapAgency(row: Record<string, unknown>): PortalAgency {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    code: String(row.code ?? ""),
    registrationNumber: String(row.registration_number ?? ""),
    businessEmail: String(row.business_email ?? ""),
    phone: String(row.phone ?? ""),
    address: String(row.address ?? ""),
    country: String(row.country ?? ""),
    primaryContact: String(row.primary_contact ?? ""),
    status: String(row.status ?? "Active"),
    isPermanent: Boolean(row.is_permanent),
  };
}

const AGENCY_COLUMNS =
  "id, name, code, registration_number, business_email, phone, address, country, primary_contact, status, is_permanent";

export async function listAgencies(): Promise<PortalAgency[]> {
  const { data, error } = await supabase
    .from("agencies")
    .select(AGENCY_COLUMNS)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapAgency(row as Record<string, unknown>));
}

export interface AgencySummary extends PortalAgency {
  agentCount: number;
  applicationCount: number;
  createdAt: string;
}

export interface DirectoryAgency extends AgencySummary {
  directoryKey: string;
  existingAgencyId: string | null;
  source: 'portal' | 'directory';
  marn: string;
}

/** Live imported businesses plus scoped portal agencies, paged and authorized by SQL. */
export async function queryAgencyDirectory(filters: { search?: string; status?: string; limit: number; offset: number; key?: string }): Promise<{ total: number; rows: DirectoryAgency[] }> {
  const { data, error } = await supabase.rpc('admin_agency_directory', {
    p_search: filters.search ?? '', p_status: filters.status ?? '', p_limit: filters.limit,
    p_offset: filters.offset, p_key: filters.key ?? null,
  });
  if (error) throw new Error('We could not load the agency directory. Please try again.');
  const result = data as { total: number; rows: Record<string, unknown>[] };
  return { total: Number(result.total), rows: result.rows.map(r => ({
    ...mapAgency(r), createdAt: String(r.created_at ?? ''), agentCount: Number(r.agent_count ?? 0),
    applicationCount: Number(r.application_count ?? 0), directoryKey: String(r.directory_key),
    existingAgencyId: r.existing_agency_id ? String(r.existing_agency_id) : null,
    source: r.source === 'portal' ? 'portal' : 'directory', marn: String(r.marn ?? ''),
  })) };
}

/**
 * One page of agencies for the CMS list. Search, status, counts and paging are all done by the query: the agent and application
 * counts are embedded counts per agency row, and the total comes from the same filtered query.
 */
export async function queryAgencies(filters: { search?: string; status?: string; limit: number; offset: number }): Promise<{ total: number; rows: AgencySummary[] }> {
  let query = supabase
    .from("agencies")
    .select(`${AGENCY_COLUMNS}, created_at, agents:agency_memberships(count), applications:enrollment_applications(count)`, { count: "exact" })
    .eq("agents.role", "agent");
  const term = (filters.search ?? "").trim().replace(/[%,()*]/g, " ");
  if (term) query = query.or(`name.ilike.%${term}%,code.ilike.%${term}%,business_email.ilike.%${term}%`);
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error, count } = await query.order("name", { ascending: true }).range(filters.offset, filters.offset + filters.limit - 1);
  if (error) throw new Error(error.message);
  const counted = (value: unknown) => Number((value as Array<{ count?: number }> | undefined)?.[0]?.count ?? 0);
  return {
    total: count ?? 0,
    rows: (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return { ...mapAgency(r), createdAt: String(r.created_at ?? ""), agentCount: counted(r.agents), applicationCount: counted(r.applications) };
    }),
  };
}

export async function getAgency(id: string): Promise<AgencySummary | null> {
  const { data, error } = await supabase
    .from("agencies")
    .select(`${AGENCY_COLUMNS}, created_at, agents:agency_memberships(count), applications:enrollment_applications(count)`)
    .eq("id", id)
    .eq("agents.role", "agent")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const counted = (value: unknown) => Number((value as Array<{ count?: number }> | undefined)?.[0]?.count ?? 0);
  return { ...mapAgency(r), createdAt: String(r.created_at ?? ""), agentCount: counted(r.agents), applicationCount: counted(r.applications) };
}

/** Pending invitations of one agency; the agency is part of the query. */
export async function listAgencyInvitations(agencyId: string): Promise<InvitationRow[]> {
  const { data, error } = await supabase
    .from("agency_invitations")
    .select("id, email, full_name, role, agency_id, expires_at, invited_by, invited_by_name, agencies(name)")
    .eq("agency_id", agencyId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const expiresAt = String(r.expires_at ?? "");
    return {
      id: String(r.id), email: String(r.email ?? ""), fullName: String(r.full_name ?? ""),
      role: r.role === "agency_admin" ? "agency_admin" : "agent", agencyId: String(r.agency_id ?? ""),
      agencyName: String((r.agencies as Record<string, unknown> | null)?.name ?? ""),
      status: new Date(expiresAt).getTime() < Date.now() ? "expired" : "pending", expiresAt,
      invitedBy: r.invited_by ? String(r.invited_by) : null, invitedByName: String(r.invited_by_name ?? ""),
    } satisfies InvitationRow;
  });
}

/** Adds an agency record without a first administrator (with one, use the create_agency function, which is atomic). */
export async function createAgencyRecordWithBusiness(input: AgencyPatch & { status: "Active" | "Inactive" }): Promise<{ agencyId: string; businessId: string }> {
  const abnProblem = validateAbn(input.registrationNumber);
  if (abnProblem) throw new Error(abnProblem);
  const { data, error } = await supabase
    .from("agencies")
    .insert({
      name: input.name.trim(), code: input.code.trim(), registration_number: normalizeAbn(input.registrationNumber), business_email: input.businessEmail.trim(),
      phone: input.phone.trim(), address: input.address.trim(), country: input.country.trim(), primary_contact: input.primaryContact.trim(), status: input.status,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  // The business is the agency record, so both ids are the same.
  return { agencyId: String(data.id), businessId: String(data.id) };
}

export async function createAgencyRecord(input: AgencyPatch & { status: "Active" | "Inactive" }): Promise<string> {
  const created = await createAgencyRecordWithBusiness(input);
  return created.agencyId;
}

/**
 * Writes an administrator's change to an agency record to the audit log (the log accepts no direct client writes). Before the function is
 * released the change still saves; once it exists, a failed log is reported.
 */
export async function logAgencyChange(agencyId: string, action: "agency_created" | "agency_updated" | "agency_deactivated" | "agency_reactivated", detail: Record<string, unknown> = {}): Promise<void> {
  const { error } = await supabase.rpc("portal_log_agency_change", { p_agency: agencyId, p_action: action, p_detail: detail });
  if (!error || error.code === "PGRST202" || error.code === "42883") return;
  throw new Error(`Saved, but the change could not be written to the audit log. ${error.message}`);
}

export interface AgencyPatch {
  name: string;
  code: string;
  registrationNumber: string;
  businessEmail: string;
  phone: string;
  address: string;
  country: string;
  primaryContact: string;
}

/** Update an agency's core details (SLIT Admin only — enforced by RLS). */
export async function updateAgency(id: string, patch: AgencyPatch): Promise<void> {
  const { error } = await supabase
    .from("agencies")
    .update({
      name: patch.name.trim(),
      code: patch.code.trim(),
      registration_number: patch.registrationNumber.trim(),
      business_email: patch.businessEmail.trim(),
      phone: patch.phone.trim(),
      address: patch.address.trim(),
      country: patch.country.trim(),
      primary_contact: patch.primaryContact.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

/** Set an agency's active state (SLIT Admin only — enforced by RLS). */
export async function setAgencyStatus(id: string, status: "Active" | "Inactive"): Promise<void> {
  const { error } = await supabase
    .from("agencies")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

/** An agency already recorded with this ABN (stored with or without spaces), if any. */
export async function findAgencyByAbn(abn: string): Promise<{ id: string; name: string } | null> {
  const digits = normalizeAbn(abn);
  const spaced = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4");
  const { data, error } = await supabase.from("agencies").select("id, name").in("registration_number", [digits, spaced]).limit(1);
  if (error) throw new Error("We could not check whether this business already exists. Please try again.");
  const row = data?.[0];
  return row ? { id: String(row.id), name: String(row.name ?? "") } : null;
}

/** Delete an agency (SLIT Admin only). Blocked if it still owns applications. */
export async function deleteAgency(id: string): Promise<void> {
  const { error } = await supabase.from("agencies").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Members of one agency (visible to that agency's admin, or SLIT Admin). */
export async function listAgencyMembers(agencyId: string): Promise<AgencyMemberRow[]> {
  const { data, error } = await supabase
    .from("agency_memberships")
    .select("role, status, portal_profiles(id, full_name, email)")
    .eq("agency_id", agencyId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => {
    const profiles = (row as unknown as { portal_profiles?: Record<string, unknown> | Record<string, unknown>[] | null }).portal_profiles;
    const profile = (Array.isArray(profiles) ? profiles[0] : profiles) ?? {};
    return {
      profileId: String(profile.id ?? ""),
      fullName: String(profile.full_name ?? ""),
      email: String(profile.email ?? ""),
      role: (row as { role?: string }).role === "agency_admin" ? "agency_admin" : "agent",
      status: String((row as { status?: string }).status ?? "Active"),
    };
  });
}

/** Every portal user (SLIT Admin only — RLS returns nothing for others). */
export async function listPortalUsers(): Promise<PortalUserRow[]> {
  const { data, error } = await supabase
    .from("portal_profiles")
    .select("id, auth_user_id, full_name, email, phone, status, agency_memberships(role, status, agency_id, agencies(name))")
    .order("full_name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row): PortalUserRow => {
    const r = row as Record<string, unknown>;
    // PostgREST returns a single object (not an array) because agency_memberships.user_id is unique; accept both shapes.
    const embedded = r.agency_memberships as Record<string, unknown> | Array<Record<string, unknown>> | null | undefined;
    const m = Array.isArray(embedded) ? embedded[0] : embedded ?? undefined;
    const agency = (m?.agencies as Record<string, unknown> | undefined) ?? undefined;
    return {
      profileId: String(r.id),
      authUserId: String(r.auth_user_id ?? ""),
      fullName: String(r.full_name ?? ""),
      email: String(r.email ?? ""),
      phone: String(r.phone ?? ""),
      status: String(r.status ?? "Active"),
      role: m ? (m.role === "agency_admin" ? "agency_admin" : m.role === "student" ? "student" : "agent") : null,
      agencyId: m ? String(m.agency_id ?? "") || null : null,
      agencyName: String(agency?.name ?? ""),
    };
  // Students sign in too, but they are managed from the Students list, not as portal users.
  }).filter((row) => row.role !== "student");
}

/** Totals for the signed-in user's authorized scope (RLS decides the rows). */
export async function getDashboardCounts(): Promise<DashboardCounts> {
  const { data, error } = await supabase.rpc("portal_dashboard");
  if (error) throw new Error(error.message);
  return { total: data.total, drafts: data.statuses.draft ?? 0, offerAccepted: data.statuses.offer_accepted ?? 0, actionRequired: data.statuses.action_required ?? 0, enrolled: data.statuses.enrolled ?? 0 };
}

export async function listNotifications(): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from("portal_notifications")
    .select("id, reference, title, message, read, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      reference: String(r.reference ?? ""),
      title: String(r.title ?? ""),
      message: String(r.message ?? ""),
      read: Boolean(r.read),
      createdAt: String(r.created_at ?? ""),
    };
  });
}

export type NotificationEvent = "application_submitted" | "application_status_changed" | "offer_accepted" | "coe_voe_issued";

/** Email preferences of the signed-in user; an event with no row is on by default. */
export async function getEmailPreferences(): Promise<Record<NotificationEvent, boolean>> {
  const { data, error } = await supabase.from("notification_preferences").select("event, email_enabled");
  if (error) throw new Error(error.message);
  const result: Record<NotificationEvent, boolean> = { application_submitted: true, application_status_changed: true, offer_accepted: true, coe_voe_issued: true };
  for (const row of data ?? []) {
    const r = row as { event: NotificationEvent; email_enabled: boolean };
    if (r.event in result) result[r.event] = r.email_enabled;
  }
  return result;
}

export async function setEmailPreference(event: NotificationEvent, enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc("portal_set_notification_preference", { p_event: event, p_email_enabled: enabled });
  if (error) throw new Error(error.message);
}

export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await supabase.from("portal_notifications").update({ read: true }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function markAllNotificationsRead(): Promise<void> {
  const { data: session } = await supabase.auth.getSession();
  const uid = session.session?.user?.id;
  if (!uid) return;
  const { error } = await supabase.from("portal_notifications").update({ read: true }).eq("recipient", uid).eq("read", false);
  if (error) throw new Error(error.message);
}

export function formatDate(value: string | null): string {
  if (!value) return "\u2014";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

export interface InvitationRow {
  id: string;
  email: string;
  fullName: string;
  role: "agency_admin" | "agent";
  agencyId: string;
  agencyName: string;
  status: "pending" | "expired";
  expiresAt: string;
  invitedBy: string | null;
  invitedByName: string;
}

/** Pending invitations visible to the caller (RLS: organization admin = all, agency admin = own agency). */
export async function listInvitations(): Promise<InvitationRow[]> {
  const { data, error } = await supabase
    .from("agency_invitations")
    .select("id, email, full_name, role, agency_id, expires_at, invited_by, invited_by_name, agencies(name)")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const expiresAt = String(r.expires_at ?? "");
    return {
      id: String(r.id),
      email: String(r.email ?? ""),
      fullName: String(r.full_name ?? ""),
      role: r.role === "agency_admin" ? "agency_admin" : "agent",
      agencyId: String(r.agency_id ?? ""),
      agencyName: String((r.agencies as Record<string, unknown> | null)?.name ?? ""),
      status: new Date(expiresAt).getTime() < Date.now() ? "expired" : "pending",
      expiresAt,
      invitedBy: r.invited_by ? String(r.invited_by) : null,
      invitedByName: String(r.invited_by_name ?? ""),
    } satisfies InvitationRow;
  });
}

/** Calls portal-admin-users and surfaces the server's own error text instead of the generic non-2xx message. */
export async function invokePortalUsers(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke("portal-admin-users", { body });
  if (error) {
    let message = error.message;
    // The parsed body stays as `cause`: a 409 { code: 'email_taken' | 'login_role_conflict' } is mapped to the email field.
    let cause: unknown = error;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const parsed = (await context.clone().json()) as { error?: string };
        if (parsed && typeof parsed === "object") cause = parsed;
        if (parsed?.error) message = parsed.error;
      } catch { /* keep the generic message */ }
    }
    throw new Error(message, { cause });
  }
  if (data?.error) throw new Error(String(data.error), { cause: data });
  return (data ?? {}) as Record<string, unknown>;
}
