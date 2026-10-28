import { DEFAULT_DIAL, formatPhone, normalizePhoneInput, validatePhone } from "../../../../supabase/functions/_shared/validation/identifiers";
import { validateEmail, validateName } from "@/pages/agency/lib/userValidation";
import type { PortalAgency } from "@/pages/agency/lib/portalAuthContext";

export interface AgencyFormState {
  name: string;
  code: string;
  registrationNumber: string;
  businessEmail: string;
  phone: string;
  address: string;
  country: string;
  primaryContact: string;
  status: "Active" | "Inactive";
}

export const EMPTY_AGENCY_FORM: AgencyFormState = {
  name: "", code: "", registrationNumber: "", businessEmail: "", phone: "", address: "", country: "Australia", primaryContact: "", status: "Active",
};

export function agencyToForm(agency: PortalAgency): AgencyFormState {
  return {
    name: agency.name, code: agency.code, registrationNumber: agency.registrationNumber, businessEmail: agency.businessEmail,
    phone: formatPhone(agency.phone), address: agency.address, country: agency.country, primaryContact: agency.primaryContact,
    status: agency.status === "Inactive" ? "Inactive" : "Active",
  };
}

/** A starting code from the name (initials plus a number); the administrator can change it. */
export function suggestAgencyCode(name: string, suffix: number): string {
  const initials = name.split(/\s+/).filter(Boolean).map((word) => word[0]).join("").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 5) || "AG";
  return `${initials}-${suffix}`;
}

export type AgencyFormErrors = Partial<Record<keyof AgencyFormState | "firstName" | "firstEmail", string>>;

/** Validates the agency fields; the phone defaults to +61 and is returned as E.164. */
export function validateAgencyForm(form: AgencyFormState): { errors: AgencyFormErrors; phone: string } {
  const errors: AgencyFormErrors = {};
  if (form.name.trim().length < 2) errors.name = "Enter the agency name.";
  if (!form.code.trim()) errors.code = "Enter a unique agency code.";
  const email = validateEmail(form.businessEmail);
  if (email) errors.businessEmail = email;
  let phone = "";
  if (form.phone.trim()) {
    const normalized = normalizePhoneInput(DEFAULT_DIAL, form.phone);
    const problem = validatePhone(normalized.dial, normalized.national);
    if (problem) errors.phone = problem;
    else phone = normalized.e164;
  }
  return { errors, phone };
}

/** The optional first person: both fields or neither. */
export function validateFirstPerson(name: string, email: string): { name?: string; email?: string } {
  if (!name.trim() && !email.trim()) return {};
  const errors: { name?: string; email?: string } = {};
  const nameError = validateName(name);
  if (nameError) errors.name = nameError;
  const emailError = validateEmail(email);
  if (emailError) errors.email = emailError;
  return errors;
}
