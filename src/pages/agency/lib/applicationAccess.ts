
/**
 * UI affordance only. The database is the authority and enforces the same
 * agency/assignment restrictions through RLS. Never infer this from progress,
 * submission dates, extraction state, or the current user's display role.
 */
export type PortalAccessState = "org_admin" | "active" | "agency_suspended" | "user_suspended" | "invite_expired" | "no_access" | "pending_review" | "registration_declined";

/** Landing page per database-resolved role. Navigation convenience only; RLS and the edge function decide access. */
export function portalLanding(role: "slit_admin" | "agency_admin" | "agent" | "student" | null): string {
  return role === "slit_admin" ? "/agency/dashboard" : role === "student" ? "/agency/applications" : "/agency/workspace";
}

/** Only organization and agency administrators see user management. The server enforces the same rule. */
export function canManagePortalUsers(role: "slit_admin" | "agency_admin" | "agent" | "student" | null): boolean {
  return role === "slit_admin" || role === "agency_admin";
}

/** Clear explanation for a signed-in account that has no usable portal role. */
export function portalAccessMessage(state: PortalAccessState | string | null): string {
  switch (state) {
    case "agency_suspended": return "Your agency is currently suspended. Contact SLIT Administration.";
    case "user_suspended": return "Your account has been deactivated. Contact your agency administrator or SLIT Administration.";
    case "invite_expired": return "Your invitation has expired. Ask the person who invited you to resend it.";
    case "pending_review": return "Thanks for registering. SLIT is reviewing your agent account and will email you once it is approved.";
    case "registration_declined": return "Your agent registration was not approved. Contact SLIT Administration if you think this is a mistake.";
    default: return "This account is not linked to an agency. Ask your agency administrator or SLIT Administration to invite you.";
  }
}
