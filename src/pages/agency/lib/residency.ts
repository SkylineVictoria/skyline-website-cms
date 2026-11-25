/**
 * Residency question after the passport scan (owner, 2026-11-25). An Australian or New Zealand passport makes the student
 * Domestic (no question, no visa step). Anyone else is asked "Are you an Australian permanent resident?"
 * (values.au_permanent_resident): Yes asks for PR evidence (a visa grant notice, category Visa); No asks for the student's visa
 * (grant notice or VEVO record) to get their status, required as the Business Rule admissions.application_required_documents says
 * (whether the student is in Australia or not is not asked). The database derives residency_status from issuing_country and
 * au_permanent_resident.
 */
export const PR_ANSWER = "au_permanent_resident";

/** What the visa step asks for: nothing (skipped: domestic passport or unanswered), PR evidence, or the student's visa. */
export type VisaNeed = "none" | "pr" | "visa";

const DOMESTIC = new Set(["australia", "new zealand", "aus", "nzl", "au", "nz"]);

/** An Australian or New Zealand passport (the scanned issuing country, any case). */
export function isDomesticPassport(issuingCountry: string): boolean {
  return DOMESTIC.has(issuingCountry.trim().toLowerCase());
}

export function visaNeed(issuingCountry: string, pr: string): VisaNeed {
  if (isDomesticPassport(issuingCountry)) return "none";
  return pr === "Yes" ? "pr" : pr === "No" ? "visa" : "none";
}

/** The residency question is answered (or not asked: Domestic). */
export function residencyAnswered(issuingCountry: string, pr: string): boolean {
  return isDomesticPassport(issuingCountry) || pr === "Yes" || pr === "No";
}

/** Domestic (AU / NZ passport, or an Australian permanent resident), international (not PR), or "" while unanswered. */
export function studentKind(issuingCountry: string, pr: string): "domestic" | "international" | "" {
  if (isDomesticPassport(issuingCountry) || pr === "Yes") return "domestic";
  return pr === "No" ? "international" : "";
}

// Australian permanent visa subclasses (Home Affairs): the PR evidence is checked against these. A subclass read from the upload that
// is not here (e.g. 500 Student, 485 Graduate) is flagged for the agent to check; SLIT staff still verify the visa before approval.
const PERMANENT_SUBCLASSES = new Set([
  "100", "101", "102", "103", "114", "115", "116", "117", "124", "132", "143", "151", "155", "157", "175", "176", "186", "187", "189",
  "190", "191", "192", "200", "201", "202", "203", "204", "801", "802", "804", "808", "835", "836", "837", "838", "851", "855", "856",
  "857", "858", "864", "866", "885", "886", "887", "888", "890", "891", "892", "893",
]);

/** The visa subclass read from the PR evidence is not a permanent visa ("" or an unreadable subclass is not flagged). */
export function notPermanentSubclass(subclass: string): boolean {
  const digits = subclass.replace(/\D/g, "");
  return digits.length === 3 && !PERMANENT_SUBCLASSES.has(digits);
}
