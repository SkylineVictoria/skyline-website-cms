/**
 * Residency question after the passport scan (owner, 2026-11-25). An Australian or New Zealand passport makes the student
 * Domestic (no question, no visa step). Anyone else is asked "Are you an Australian permanent resident?"
 * (values.au_permanent_resident): Yes asks for PR evidence (a visa grant notice, category Visa); No needs no visa upload at all
 * (whether the student is in Australia or not does not matter, so it is not asked). The database derives residency_status from
 * issuing_country and au_permanent_resident.
 */
export const PR_ANSWER = "au_permanent_resident";

/** What the visa step asks for: nothing (skipped) or PR evidence. */
export type VisaNeed = "none" | "pr";

const DOMESTIC = new Set(["australia", "new zealand", "aus", "nzl", "au", "nz"]);

/** An Australian or New Zealand passport (the scanned issuing country, any case). */
export function isDomesticPassport(issuingCountry: string): boolean {
  return DOMESTIC.has(issuingCountry.trim().toLowerCase());
}

export function visaNeed(issuingCountry: string, pr: string): VisaNeed {
  return !isDomesticPassport(issuingCountry) && pr === "Yes" ? "pr" : "none";
}

/** The residency question is answered (or not asked: Domestic). */
export function residencyAnswered(issuingCountry: string, pr: string): boolean {
  return isDomesticPassport(issuingCountry) || pr === "Yes" || pr === "No";
}
