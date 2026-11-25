/**
 * Residency questions after the passport scan (owner, 2026-11-25). An Australian or New Zealand passport makes the student
 * Domestic (no residency questions, no visa step). Anyone else is asked "Are you an Australian permanent resident?"
 * (values.au_permanent_resident): Yes asks for PR evidence (a visa grant notice, category Visa); No asks "Are you currently in
 * Australia?" (values.currently_in_australia): Yes needs the visa copy and its subclass, grant number and expiry; No needs no visa
 * yet (offshore: the CoE is issued first). The database derives residency_status from issuing_country and au_permanent_resident.
 */
export const PR_ANSWER = "au_permanent_resident";
export const IN_AUSTRALIA_ANSWER = "currently_in_australia";

/** What the visa step asks for: nothing (skipped), PR evidence, or the student visa copy with its details. */
export type VisaNeed = "none" | "pr" | "visa";

const DOMESTIC = new Set(["australia", "new zealand", "aus", "nzl", "au", "nz"]);

/** An Australian or New Zealand passport (the scanned issuing country, any case). */
export function isDomesticPassport(issuingCountry: string): boolean {
  return DOMESTIC.has(issuingCountry.trim().toLowerCase());
}

export function visaNeed(issuingCountry: string, pr: string, inAustralia: string): VisaNeed {
  if (isDomesticPassport(issuingCountry)) return "none";
  if (pr === "Yes") return "pr";
  if (pr === "No" && inAustralia === "Yes") return "visa";
  return "none";
}

/** The residency questions are answered (or not asked: Domestic). */
export function residencyAnswered(issuingCountry: string, pr: string, inAustralia: string): boolean {
  return isDomesticPassport(issuingCountry) || pr === "Yes" || (pr === "No" && (inAustralia === "Yes" || inAustralia === "No"));
}

/** Problems with the visa details asked when the student is in Australia on a visa (keyed by field name). */
export function visaDetailProblems(subclass: string, grantNumber: string, expiry: string, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!/^\d{3}$/.test(subclass.trim())) errors.visa_subclass = "Enter the visa subclass (3 digits, e.g. 500).";
  if (!grantNumber.trim()) errors.visa_grant_number = "Enter the visa grant number.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry.trim()) || Number.isNaN(new Date(`${expiry.trim()}T00:00:00`).getTime())) errors.visa_stay_until = "Enter the visa expiry date.";
  else if (expiry.trim() < today) errors.visa_stay_until = "This visa has expired. Upload the current visa.";
  return errors;
}
