// Admissions and offer Business Rules the application screens read (BUSINESS-RULES-LIVE batch 4). SLIT sets them on
// Administration › Business Rules; until they load (or when one is switched off) each getter returns today's value.
import { onRules, ruleList, ruleNumber, ruleObject, ruleText } from "@/lib/businessRules";
import { setDocumentExpiryRules } from "@/pages/agency/lib/documentExpiry";

onRules(() => setDocumentExpiryRules({
  warningMonths: ruleNumber("admissions.document_expiry_warning_months", 6),
  englishValidYears: ruleNumber("admissions.english_result_valid_years", 2),
}));

export const ENGLISH_ALTERNATIVE_AUS_STUDY = "At least 2 years of study in Australia";
export const ENGLISH_ALTERNATIVE_CAMBRIDGE = "Cambridge English course with Skyline";
/** Which ways other than an English test result are accepted (admissions.english_test_alternatives). */
export function englishAlternatives(): { ausStudy: boolean; cambridge: boolean } {
  const list = ruleList("admissions.english_test_alternatives", [ENGLISH_ALTERNATIVE_AUS_STUDY, ENGLISH_ALTERNATIVE_CAMBRIDGE]);
  return { ausStudy: list.includes(ENGLISH_ALTERNATIVE_AUS_STUDY), cambridge: list.includes(ENGLISH_ALTERNATIVE_CAMBRIDGE) };
}

/** The minimum overall English scores printed on the form (admissions.english_minimum_scores). */
export function englishMinimumScores(): { IELTS: number; PTE: number; TOEFL: number } {
  const v = ruleObject("admissions.english_minimum_scores", { IELTS: 6, PTE: 50, TOEFL: 60 });
  const num = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
  return { IELTS: num(v.IELTS, 6), PTE: num(v.PTE, 50), TOEFL: num(v.TOEFL, 60) };
}
/** "6.0" for IELTS (one decimal, as IELTS prints bands), whole numbers for PTE and TOEFL. */
export const formatEnglishScore = (test: "IELTS" | "PTE" | "TOEFL", score: number) => (test === "IELTS" ? score.toFixed(1) : String(Math.round(score)));

/** The wizard's document steps the agent cannot skip (admissions.application_required_documents), by wizard step id. */
const REQUIRED_STEP: Record<string, string> = { Passport: "passport", "English test": "english", "Academic results": "academic", Visa: "visa", "Driving licence": "licence" };
export function requiredDocumentSteps(): Set<string> {
  const list = ruleList("admissions.application_required_documents", ["Passport", "English test", "Academic results", "Visa"]);
  return new Set(list.map((label) => REQUIRED_STEP[label]).filter(Boolean));
}

/** Is a USI needed before the application can go further (admissions.usi_required)? */
export const usiRequired = () => ruleText("admissions.usi_required", "Required") !== "Optional";

/** Who may press Accept offer in the portal (admissions.offer_accept_in_portal + admissions.offer_accept_portal_roles). */
export function portalOfferAcceptAllowed(role: string | null | undefined): boolean {
  if (ruleText("admissions.offer_accept_in_portal", "Allowed") !== "Allowed") return false;
  const roles = ruleList("admissions.offer_accept_portal_roles", ["Student", "Agent", "Agency admin"]);
  const label = role === "student" ? "Student" : role === "agent" ? "Agent" : role === "agency_admin" ? "Agency admin" : role === "slit_admin" ? "SLIT staff" : "";
  return Boolean(label) && roles.includes(label);
}

/** The applicant age range on sign-up (admissions.applicant_age_range). */
export function applicantAgeRange(): { min: number; max: number } {
  const v = ruleObject("admissions.applicant_age_range", { minimum: 10, maximum: 100 });
  const min = typeof v.minimum === "number" && Number.isInteger(v.minimum) ? v.minimum : 10;
  const max = typeof v.maximum === "number" && Number.isInteger(v.maximum) ? v.maximum : 100;
  return min <= max ? { min, max } : { min: 10, max: 100 };
}

/** The largest offer letter PDF staff may upload, in bytes (admissions.offer_letter_upload_mib, never above the 3 MB the database stores). */
export const offerLetterMaxMib = () => Math.min(3, ruleNumber("admissions.offer_letter_upload_mib", 3));

/** The discount range staff may enter on an offer (finance.offer_discount_range). */
export function offerDiscountRange(): { min: number; max: number } {
  const v = ruleObject("finance.offer_discount_range", { minimum: 0, maximum: 100 });
  const min = typeof v.minimum === "number" ? Math.max(0, v.minimum) : 0;
  const max = typeof v.maximum === "number" ? Math.min(100, v.maximum) : 100;
  return min <= max ? { min, max } : { min: 0, max: 100 };
}

/** Deposit reminders as the screens describe them (finance.deposit_* rules, already live). */
export function depositReminderText() {
  return {
    everyDays: ruleNumber("finance.deposit_automatic_reminder_interval", 3),
    cap: ruleNumber("finance.deposit_automatic_reminder_cap", 3),
    cooldownHours: ruleNumber("finance.deposit_manual_reminder_cooldown", 24),
  };
}

/** The commission range an agency agreement may carry (agents.commission_range) and the figure suggested on the forms (agents.commission_suggested). */
export function commissionRange(): { min: number; max: number } {
  const v = ruleObject("agents.commission_range", { minimum: 0, maximum: 100 });
  const min = typeof v.minimum === "number" ? Math.max(0, v.minimum) : 0;
  const max = typeof v.maximum === "number" ? Math.min(100, v.maximum) : 100;
  return min <= max ? { min, max } : { min: 0, max: 100 };
}
export const commissionSuggested = () => String(ruleNumber("agents.commission_suggested", 25));
/** "" when the typed commission is a percentage inside the range, otherwise the message to show. */
export function commissionProblem(typed: string): string {
  const text = typed.trim().replace(/%$/, "").trim();
  const { min, max } = commissionRange();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text) || Number(text) > 100) return `Enter the commission as a percentage, for example ${commissionSuggested()}.`;
  return Number(text) < min || Number(text) > max ? `The commission must be between ${min} and ${max} percent.` : "";
}
