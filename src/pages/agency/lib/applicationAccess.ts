import type { ApplicationStatus } from "@/pages/agency/lib/portalData";

/**
 * UI affordance only. The database is the authority and enforces the same
 * agency/assignment restrictions through RLS. Never infer this from progress,
 * submission dates, extraction state, or the current user's display role.
 */
/** Stored status values never change; only labels do. Legacy rows keep their label so they stay readable. */
export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  under_review: "Under review",
  action_required: "Action required",
  offer_issued: "Offer issued",
  offer_accepted: "Offer accepted",
  coe_issued: "CoE / VoE issued",
  enrolled: "Enrolled",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** Statuses offered in filters and pickers. under_review / offer_issued are legacy: existing rows keep them, nothing new is moved into them. */
export const SELECTABLE_STATUSES = ["draft", "submitted", "action_required", "offer_accepted", "coe_issued", "enrolled", "rejected", "withdrawn"] as const;
export const LEGACY_STATUSES = ["under_review", "offer_issued"] as const;

/** Default admissions graph (migration 91). The database enforces it; this only decides which options an administrator sees. */
const NEXT_STATUSES: Record<string, readonly string[]> = {
  submitted: ["action_required", "offer_accepted", "rejected", "withdrawn"],
  action_required: ["submitted", "offer_accepted", "rejected", "withdrawn"],
  offer_accepted: ["coe_issued", "rejected", "withdrawn"],
  coe_issued: ["enrolled", "withdrawn"],
  under_review: ["action_required", "offer_accepted", "rejected", "withdrawn"],
  offer_issued: ["offer_accepted", "rejected", "withdrawn"],
};
export function nextStatusOptions(status: string): readonly string[] {
  return NEXT_STATUSES[status] ?? [];
}

/** Agents and agency admins submit a draft once. After that they have no status transitions (an administrator returns an application from action_required). */
export function canSubmitApplicationStatus(status: ApplicationStatus | string): boolean {
  return status === "draft";
}

export function isEditableApplicationStatus(status: ApplicationStatus | string): boolean {
  return status === "draft" || status === "action_required";
}

export type PortalAccessState = "org_admin" | "active" | "agency_suspended" | "user_suspended" | "invite_expired" | "no_access";

/** Landing page per database-resolved role. Navigation convenience only; RLS and the edge function decide access. */
export function portalLanding(role: "slit_admin" | "agency_admin" | "agent" | null): string {
  return role === "agent" ? "/agency/applications" : "/agency/dashboard";
}

/** Only organization and agency administrators see user management. The server enforces the same rule. */
export function canManagePortalUsers(role: "slit_admin" | "agency_admin" | "agent" | null): boolean {
  return role === "slit_admin" || role === "agency_admin";
}

/** Clear explanation for a signed-in account that has no usable portal role. */
export function portalAccessMessage(state: PortalAccessState | string | null): string {
  switch (state) {
    case "agency_suspended": return "Your agency is currently suspended. Contact SLIT Administration.";
    case "user_suspended": return "Your account has been deactivated. Contact your agency administrator or SLIT Administration.";
    case "invite_expired": return "Your invitation has expired. Ask the person who invited you to resend it.";
    default: return "This account is not linked to an agency. Ask your agency administrator or SLIT Administration to invite you.";
  }
}
