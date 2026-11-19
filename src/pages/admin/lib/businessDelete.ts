/*
 * Delete business (owner 2026-11-20): the screens' rules, without React or the Supabase client (the database repeats every one of them in
 * public.admin_business_delete_block / admin_business_delete).
 */

/** The system businesses (SLIT's own students, the admin preview agency): never deleted. */
export const SYSTEM_BUSINESS_CODES = ["SLIT-DIRECT", "TEST-VIEW"] as const;

/** Delete business is offered for this row: a SLIT administrator, the application at "Application sent", not a system business. */
export const canOfferBusinessDelete = (row: { status: string; onboardingLabel?: string | null; agencyCode?: string | null }, isAdmin: boolean) =>
  isAdmin && row.status === "Onboarding" && row.onboardingLabel === "Application sent" && !(SYSTEM_BUSINESS_CODES as readonly string[]).includes(String(row.agencyCode ?? "").toUpperCase());

/** The typed confirmation: the business name (case and spaces ignored) or its ABN (digits only). */
export function deleteConfirmMatches(typed: string, name: string, abn: string): boolean {
  const norm = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const digits = (s: string) => String(s ?? "").replace(/\D/g, "");
  return (norm(typed) !== "" && norm(typed) === norm(name)) || (digits(abn).length === 11 && digits(typed) === digits(abn));
}

/** A business's own status dropdown: Active or Inactive only (Onboarding ends by itself; the database refuses it for an active business). */
export const businessDropdownStatuses = <T extends { value: string }>(catalog: readonly T[]): T[] => catalog.filter((item) => item.value === "Active" || item.value === "Inactive");
