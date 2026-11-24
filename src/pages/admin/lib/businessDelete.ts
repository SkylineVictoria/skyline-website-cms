/*
 * Delete business (owner 2026-11-20): the screens' rules, without React or the Supabase client (the database repeats every one of them in
 * public.admin_business_delete_block / admin_business_delete).
 */

/** The system businesses (SLIT's own students, the admin preview agency): never deleted. */
export const SYSTEM_BUSINESS_CODES = ["SLIT-DIRECT", "TEST-VIEW"] as const;

/** The CMS role "Admin" (SLIT administrator), however the session spells it. */
export const isSlitAdmin = (role: string | null | undefined) => String(role ?? "").trim().toLowerCase() === "admin";

type DeleteRow = { status: string; onboardingLabel?: string | null; agencyCode?: string | null; students?: number | null; applications?: number | null };

/** Why Delete business is not available for this row (the tooltip of the greyed-out icon), or null when it is. */
export function deleteBlockReason(row: DeleteRow, isAdmin: boolean): string | null {
  if (!isAdmin) return "Only a SLIT administrator can delete a business.";
  if ((SYSTEM_BUSINESS_CODES as readonly string[]).includes(String(row.agencyCode ?? "").toUpperCase())) return "SLIT's own business: it can never be deleted.";
  if (Number(row.students ?? 0) > 0 || Number(row.applications ?? 0) > 0) return "Has students or applications: their records are kept, so it cannot be deleted.";
  // Owner 2026-11-24: any status (Active, Inactive, Onboarding at any stage).
  return null;
}

/** Delete business is offered for this row: a SLIT administrator, any status, not a system business, no students or applications. */
export const canOfferBusinessDelete = (row: DeleteRow, isAdmin: boolean) => deleteBlockReason(row, isAdmin) === null;

/** The typed confirmation: the business name (case and spaces ignored) or its ABN (digits only). */
export function deleteConfirmMatches(typed: string, name: string, abn: string): boolean {
  const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const digits = (s: string) => String(s ?? "").replace(/\D/g, "");
  return (norm(typed) !== "" && norm(typed) === norm(name)) || (digits(abn).length === 11 && digits(typed) === digits(abn));
}

/** A business's own status dropdown: Active or Inactive only (Onboarding ends by itself; the database refuses it for an active business). */
export const businessDropdownStatuses = <T extends { value: string }>(catalog: readonly T[]): T[] => catalog.filter((item) => item.value === "Active" || item.value === "Inactive");
