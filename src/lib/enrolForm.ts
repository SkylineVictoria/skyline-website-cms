/**
 * The "Enroll now" forms on the sign-in page: what a student or an agent types, and the checks run before anything is
 * sent. Pure and browser-free so the offline test script covers it; the Edge Function and database check again.
 */

import { validateAbn } from "../../supabase/functions/_shared/validation/abn";
import { CONTROL, dateOfBirthProblem, emailProblem, mobileProblem, nameProblem, parseDateOfBirth } from "../../supabase/functions/_shared/validation/person";
import { passwordProblem } from "./passwords";

// Email, name, mobile and date-of-birth rules are the shared ones (also used by the staff onboarding wizard).
export { dateOfBirthProblem, dateOfBirthRange, emailProblem, mobileProblem, parseDateOfBirth, validEmail } from "../../supabase/functions/_shared/validation/person";

export type EnrolKind = "student" | "agent" | "staff";

export interface StudentEnrolForm {
  firstName: string; lastName: string; email: string; mobile: string;
  /** YYYY-MM-DD from the date picker (DD/MM/YYYY is also understood). */
  dateOfBirth: string; course: string; referralCode: string; agreed: boolean;
  /** Their own password: the account is ready at once and they go straight into their application. */
  password: string;
}

export interface AgentEnrolForm { businessName: string; abn: string; contactName: string; email: string; phone: string; agreed: boolean }

export const EMPTY_STUDENT_ENROL: StudentEnrolForm = { firstName: "", lastName: "", email: "", mobile: "", dateOfBirth: "", course: "", referralCode: "", agreed: false, password: "" };
export const EMPTY_AGENT_ENROL: AgentEnrolForm = { businessName: "", abn: "", contactName: "", email: "", phone: "", agreed: false };

/** The one-time code emailed when a student claims a record their agent or SLIT created: 6 digits (up to 10 if SLIT lengthens it). */
export function codeProblem(raw: string): string {
  return /^\d{6,10}$/.test(raw.replace(/\s/g, "")) ? "" : "Enter the 6-digit code from the email.";
}

/** The same ABN check the Edge Function runs; "" when valid, otherwise what is wrong. */
export function abnProblem(raw: string): string {
  const digits = raw.replace(/\s/g, "");
  if (!digits) return "Enter the business's ABN.";
  return validateAbn(digits);
}

/** 11 digits shown as 12 345 678 901. */
export function formatAbn(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 11);
  return [digits.slice(0, 2), digits.slice(2, 5), digits.slice(5, 8), digits.slice(8, 11)].filter(Boolean).join(" ");
}

export type EnrolErrors<T> = Partial<Record<keyof T | "form", string>>;

export function validateStudentEnrol(form: StudentEnrolForm, today?: Date): EnrolErrors<StudentEnrolForm> {
  const errors: EnrolErrors<StudentEnrolForm> = {};
  // Email and mobile only, like an application; a name or date of birth is checked only when given.
  const first = form.firstName.trim() ? nameProblem(form.firstName, "first name") : ""; if (first) errors.firstName = first;
  const last = form.lastName.trim() ? nameProblem(form.lastName, "last name") : ""; if (last) errors.lastName = last;
  const email = emailProblem(form.email); if (email) errors.email = email;
  const mobile = mobileProblem(form.mobile); if (mobile) errors.mobile = mobile;
  const password = passwordProblem(form.password); if (password) errors.password = password;
  const dob = form.dateOfBirth.trim() ? dateOfBirthProblem(form.dateOfBirth, today) : ""; if (dob) errors.dateOfBirth = dob;
  if (form.referralCode.trim().length > 40 || CONTROL.test(form.referralCode)) errors.referralCode = "Check the referral code.";
  if (!form.agreed) errors.agreed = "Please agree to the terms and privacy policy.";
  return errors;
}

export function validateAgentEnrol(form: AgentEnrolForm): EnrolErrors<AgentEnrolForm> {
  const errors: EnrolErrors<AgentEnrolForm> = {};
  const business = form.businessName.trim();
  if (business.length < 2 || business.length > 200 || CONTROL.test(business)) errors.businessName = "Enter the agency or company name.";
  const abn = abnProblem(form.abn); if (abn) errors.abn = abn;
  const contact = nameProblem(form.contactName, "contact person's name"); if (contact) errors.contactName = contact;
  const email = emailProblem(form.email); if (email) errors.email = email.replace("your email address", "your work email address");
  // The country-code phone field gives +61… (Australian numbers: 10 digits starting with 0) or another country's number.
  const phone = mobileProblem(form.phone);
  if (phone) errors.phone = phone.replace("mobile number", "phone number");
  if (!form.agreed) errors.agreed = "Please agree to the terms and privacy policy.";
  return errors;
}

/** What the Edge Function receives for a student. */
export function studentEnrolPayload(form: StudentEnrolForm, today?: Date) {
  return {
    kind: "student" as const,
    firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim().toLowerCase(),
    phone: form.mobile.trim(), dateOfBirth: parseDateOfBirth(form.dateOfBirth, today) ?? "",
    course: form.course.trim(), referralCode: form.referralCode.trim(),
  };
}

/** What the Edge Function receives for an agent. */
export function agentEnrolPayload(form: AgentEnrolForm) {
  return {
    kind: "agent" as const,
    businessName: form.businessName.trim(), abn: form.abn.replace(/\s/g, ""), contactName: form.contactName.trim(),
    email: form.email.trim().toLowerCase(), phone: form.phone.trim(),
  };
}

/** True for the server's "already linked to another company" message (agent email or phone), shown as a popup. */
export function isContactConflict(message: string): boolean {
  return /already linked to another company/i.test(message);
}
