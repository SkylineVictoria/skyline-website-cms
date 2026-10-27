import { supabase } from "@/pages/admin/lib/supabase";
import type { PortalAgency } from "@/pages/agency/lib/portalAuthContext";
import { STATUS_LABELS } from "@/pages/agency/lib/applicationAccess";

/** Data access for the Agency Portal. Every read is scoped by database RLS. */

export type ApplicationStatus =
  | "draft"
  | "submitted"
  | "under_review"
  | "action_required"
  | "offer_issued"
  | "offer_accepted"
  | "coe_issued"
  | "enrolled"
  | "rejected"
  | "withdrawn";

export const STATUS_META: Record<ApplicationStatus, { label: string; className: string; icon: string }> = {
  draft: { label: STATUS_LABELS.draft, className: "bg-background-100 text-foreground-700", icon: "ri-file-edit-line" },
  submitted: { label: STATUS_LABELS.submitted, className: "bg-secondary-100 text-secondary-900", icon: "ri-send-plane-line" },
  under_review: { label: STATUS_LABELS.under_review, className: "bg-secondary-100 text-secondary-900", icon: "ri-search-eye-line" },
  action_required: { label: STATUS_LABELS.action_required, className: "bg-primary-100 text-primary-800", icon: "ri-alert-line" },
  offer_issued: { label: STATUS_LABELS.offer_issued, className: "bg-accent-100 text-accent-900", icon: "ri-mail-star-line" },
  offer_accepted: { label: STATUS_LABELS.offer_accepted, className: "bg-accent-100 text-accent-900", icon: "ri-checkbox-circle-line" },
  coe_issued: { label: STATUS_LABELS.coe_issued, className: "bg-accent-100 text-accent-900", icon: "ri-file-shield-2-line" },
  enrolled: { label: STATUS_LABELS.enrolled, className: "bg-accent-500 text-background-50", icon: "ri-graduation-cap-line" },
  rejected: { label: STATUS_LABELS.rejected, className: "bg-primary-100 text-primary-800", icon: "ri-close-circle-line" },
  withdrawn: { label: STATUS_LABELS.withdrawn, className: "bg-background-200 text-foreground-600", icon: "ri-arrow-go-back-line" },
};

export const ROLE_LABELS: Record<string, string> = {
  slit_admin: "SLIT Admin",
  agency_admin: "Agency Admin",
  agent: "Agent",
};

export function statusMeta(status: string) {
  return STATUS_META[status as ApplicationStatus] ?? STATUS_META.draft;
}

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
  role: "agency_admin" | "agent" | null;
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
  return (data ?? []).map((row) => {
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
      role: m ? (m.role === "agency_admin" ? "agency_admin" : "agent") : null,
      agencyId: m ? String(m.agency_id ?? "") || null : null,
      agencyName: String(agency?.name ?? ""),
    };
  });
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
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const parsed = (await context.clone().json()) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch { /* keep the generic message */ }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(String(data.error));
  return (data ?? {}) as Record<string, unknown>;
}
