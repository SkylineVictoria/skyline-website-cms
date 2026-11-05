// Staff application statuses and the allowed moves. Pure and browser-free so it is tested offline (scripts/test-staff-registration.ts).
// The database is the authority: hr.staff_transition_allowed() / the hr.staff_status_guard trigger enforce the same table, and
// every change is logged in hr.staff_status_events. This copy only decides which buttons to offer.

export type StaffStatus = "draft" | "submitted" | "preboarding" | "active" | "rejected" | "inactive";
export type StaffRole = "admin" | "trainer";

export const STAFF_STATUSES: readonly StaffStatus[] = ["draft", "submitted", "preboarding", "active", "rejected", "inactive"];
export const STAFF_ROLES: readonly StaffRole[] = ["admin", "trainer"];

export const STAFF_STATUS_LABEL: Record<StaffStatus, string> = {
  draft: "Draft", submitted: "Submitted", preboarding: "Preboarding", active: "Active", rejected: "Rejected", inactive: "Inactive",
};

/** rejected -> draft is the Admin-only reopen; inactive -> active is an Admin reactivation. */
const MOVES: ReadonlyArray<readonly [StaffStatus, StaffStatus]> = [
  ["draft", "submitted"], ["submitted", "preboarding"], ["submitted", "rejected"],
  ["preboarding", "active"], ["preboarding", "rejected"],
  ["active", "inactive"], ["inactive", "active"], ["rejected", "draft"],
];

export function canTransition(from: StaffStatus, to: StaffStatus): boolean {
  return MOVES.some(([a, b]) => a === from && b === to);
}

/** The admin actions available for a status, in the order the buttons are shown. */
export type StaffAdminAction = "approve" | "reject" | "activate" | "deactivate" | "reopen";
export function adminActionsFor(status: StaffStatus): StaffAdminAction[] {
  switch (status) {
    case "submitted": return ["approve", "reject"];
    case "preboarding": return ["activate", "reject"];
    case "active": return ["deactivate"];
    case "inactive": return ["activate"];
    case "rejected": return ["reopen"];
    default: return [];
  }
}

export const isStaffStatus = (value: unknown): value is StaffStatus => typeof value === "string" && (STAFF_STATUSES as readonly string[]).includes(value);

/** The one text a visitor sees when an email or number cannot be used. It never says whether a student, agent or admin holds it. */
export const NEUTRAL_EMAIL_MESSAGE = "This email can't be used. Sign in or contact the administrator.";
export const NEUTRAL_PHONE_MESSAGE = "This number can't be used. Sign in or contact the administrator.";

export interface StaffPrecheck { ok?: boolean; emailConflict?: boolean; phoneConflict?: boolean; reason?: string }

/** Turns the database precheck into what to show: null when the details may be used. */
export function conflictMessage(check: StaffPrecheck): { field: "email" | "phone" | "form"; message: string } | null {
  if (check.ok === true) return null;
  if (check.emailConflict) return { field: "email", message: NEUTRAL_EMAIL_MESSAGE };
  if (check.phoneConflict) return { field: "phone", message: NEUTRAL_PHONE_MESSAGE };
  if (check.reason === "invalid_phone") return { field: "phone", message: "Enter your mobile number with its country code." };
  if (check.reason === "invalid_email") return { field: "email", message: "Enter a valid email address." };
  return { field: "form", message: "Check your email address and mobile number." };
}

/** Everything the applicant needs before Submit, in the order the wizard shows it. Mirrors hr_staff_submit. */
export interface StaffSubmitInput {
  firstName: string; lastName: string; dateOfBirth: string | null; addressStreet: string; addressCountry: string;
  emergencyName: string; emergencyRelationship: string; emergencyPhone: string | null; requestedRole: string | null; hasPassport: boolean;
}
export function submitProblems(input: StaffSubmitInput): string[] {
  const problems: string[] = [];
  if (!input.hasPassport) problems.push("Upload your passport.");
  if (!input.firstName.trim() || !input.lastName.trim()) problems.push("Enter your first and last name.");
  if (!input.dateOfBirth) problems.push("Enter your date of birth.");
  if (!input.addressStreet.trim() || !input.addressCountry.trim()) problems.push("Enter your address.");
  if (!input.emergencyName.trim() || !input.emergencyRelationship.trim() || !input.emergencyPhone) problems.push("Enter an emergency contact: name, relationship and phone.");
  if (!input.requestedRole) problems.push("Choose the role you are requesting.");
  return problems;
}

/** Badge tone per status (admin lists). */
export const STAFF_STATUS_TONE: Record<StaffStatus, "muted" | "warn" | "secondary" | "success" | "primary" | "accent"> = {
  draft: "muted", submitted: "warn", preboarding: "secondary", active: "success", rejected: "muted", inactive: "muted",
};
