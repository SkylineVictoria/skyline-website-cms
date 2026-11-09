/**
 * The "Enroll now" forms on the sign-in page: what a student or an agent types, and the checks run before anything is
 * sent. Pure and browser-free so the offline test script covers it; the Edge Function and database check again.
 */

import { validateAbn } from "../../supabase/functions/_shared/validation/abn";
import { parseStoredPhone, validateStoredPhone } from "../../supabase/functions/_shared/validation/identifiers";
import { passwordProblem } from "./passwords";

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

const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
// eslint-disable-next-line no-control-regex -- control characters are never valid in names
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A real-looking address: one @, a name of allowed characters that does not start or end with a dot and has no "..",
 * and a domain of dot-separated labels (letters, digits, inner hyphens) ending in a 2+ letter extension (.com, .com.au).
 */
export function validEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || CONTROL.test(email) || !EMAIL.test(email)) return false;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (email.indexOf("@") !== at || !local || local.length > 64) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || !/^[a-z]{2,}$/.test(labels[labels.length - 1])) return false;
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** What is wrong with an email, or "" when it is fine. */
export function emailProblem(value: string): string {
  if (!value.trim()) return "Enter your email address.";
  return validEmail(value) ? "" : "Enter a valid email address, like name@company.com.au.";
}

function nameProblem(value: string, what: string): string {
  const name = value.trim();
  if (!name) return `Enter your ${what}.`;
  if (CONTROL.test(name) || name.length > 100) return `The ${what} must be 100 characters or fewer.`;
  return "";
}

/**
 * The mobile as the shared country-code phone field stores it (E.164, e.g. +61412345678 or +919876543210), the same
 * format every other student mobile is saved in. "" when valid, otherwise what is wrong.
 */
export function mobileProblem(e164: string): string {
  const value = e164.trim();
  if (!value || !value.startsWith("+") || !parseStoredPhone(value)?.national) return "Enter your mobile number.";
  return validateStoredPhone(value);
}

/** The date-of-birth limits, as YYYY-MM-DD, for the date picker's min and max. */
/** The one-time code emailed when a student claims a record their agent or SLIT created: 6 digits (up to 10 if SLIT lengthens it). */
export function codeProblem(raw: string): string {
  return /^\d{6,10}$/.test(raw.replace(/\s/g, "")) ? "" : "Enter the 6-digit code from the email.";
}

export function dateOfBirthRange(today: Date = new Date()): { min: string; max: string } {
  const iso = (years: number) => new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
  return { min: iso(100), max: iso(10) };
}

/** "" when the date of birth is usable, otherwise a message that says which rule failed. */
export function dateOfBirthProblem(raw: string, today: Date = new Date()): string {
  const text = raw.trim();
  if (!text) return "Enter your date of birth.";
  if (parseDateOfBirth(text, today)) return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const [year, month, day] = iso ? [+iso[1], +iso[2], +iso[3]] : dmy ? [+dmy[3], +dmy[2], +dmy[1]] : [0, 0, 0];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? "You must be between 10 and 100 years old." : "Enter a real date of birth.";
}

/** DD/MM/YYYY (or YYYY-MM-DD) to an ISO date; null when it is not a real date or not 10 to 100 years ago. */
export function parseDateOfBirth(raw: string, today: Date = new Date()): string | null {
  const text = raw.trim();
  let year: number, month: number, day: number;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dmy) { day = Number(dmy[1]); month = Number(dmy[2]); year = Number(dmy[3]); }
  else if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
  else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const youngest = new Date(Date.UTC(today.getUTCFullYear() - 10, today.getUTCMonth(), today.getUTCDate()));
  const oldest = new Date(Date.UTC(today.getUTCFullYear() - 100, today.getUTCMonth(), today.getUTCDate()));
  if (date > youngest || date < oldest) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
