
/** Staff > Employees, simple (20261110170000): types and the checks shared by the form and tests. No network here. */

export type EmployeeStatus = "active" | "inactive";
export const EMPLOYEE_STATUS_LABEL: Record<EmployeeStatus, string> = { active: "Active", inactive: "Inactive" };

export interface Employee {
  id: string; firstName: string; lastName: string; email: string; phone: string; status: EmployeeStatus;
  createdAt: string; statusChangedAt: string; hasLogin: boolean; documents: number;
}
export interface EmployeeDocument {
  id: string; category: EmployeeDocCategory; filename: string; mimeType: string; size: number; storagePath: string; uploadedAt: string; removable: boolean;
}
export interface EmployeeDetail extends Employee { documentList: EmployeeDocument[] }
export interface EmployeeForm { firstName: string; lastName: string; email: string; phone: string }
export const EMPTY_EMPLOYEE: EmployeeForm = { firstName: "", lastName: "", email: "", phone: "" };

/** The document types the database accepts (hr.staff_documents category check on hosted). */
export const EMPLOYEE_DOC_CATEGORIES = ["Passport", "Visa", "Driving Licence", "Academic", "English Certificate", "PTE", "Health Insurance", "Resume"] as const;
export type EmployeeDocCategory = (typeof EMPLOYEE_DOC_CATEGORIES)[number];
export const EMPLOYEE_DOC_ACCEPT = ".pdf,.jpg,.jpeg,.png,.doc,.docx,application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC_MIME = ["application/pdf", "image/png", "image/jpeg", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
export const EMPLOYEE_DOC_MAX_BYTES = 10 * 1024 * 1024;

/* validation: the database checks the same rules (20261110170000) */

const NAME = /^\p{L}([\p{L} .'-]*[\p{L}.])?$/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

function nameProblem(value: string, label: string): string | undefined {
  const v = value.trim();
  if (!v) return `Enter the ${label}.`;
  if (v.length > 100) return `The ${label} must be 100 characters or fewer.`;
  if (!NAME.test(v)) return `The ${label} can only contain letters, spaces, hyphens, apostrophes and full stops.`;
  return undefined;
}

/** Field problems of the add / edit form; empty when it can be saved. */
export function employeeProblems(form: EmployeeForm): Partial<Record<keyof EmployeeForm, string>> {
  const out: Partial<Record<keyof EmployeeForm, string>> = {};
  const first = nameProblem(form.firstName, "first name"); if (first) out.firstName = first;
  const last = nameProblem(form.lastName, "last name"); if (last) out.lastName = last;
  const email = form.email.trim();
  if (!email) out.email = "Enter the email address.";
  else if (email.length > 254 || !EMAIL.test(email)) out.email = "Enter a valid email address.";
  const phone = mobileProblem(form.phone); if (phone) out.phone = phone;
  return out;
}

/** Why the file cannot be uploaded, or null. */
export function employeeFileProblem(file: { type: string; size: number; name: string }): string | null {
  if (!DOC_MIME.includes(file.type)) return "Upload a PDF, JPG, PNG or Word file.";
  if (file.size < 1) return "The file is empty.";
  if (file.size > EMPLOYEE_DOC_MAX_BYTES) return "The file must be 10 MB or smaller.";
  return null;
}

/** Storage path of a new upload: employees/<id>/<random>-<safe file name>. */
export function employeeDocPath(employeeId: string, filename: string, random: string): string {
  const safe = filename.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^[._]+/, "").slice(-120) || "document";
  return `employees/${employeeId}/${random}-${safe}`;
}

/* mobile: Australian mobiles only; the database checks the same shape (+614 and 8 digits, 20261110180000) */

/** An Australian mobile as +614XXXXXXXX from 0412 345 678, +61 412 345 678, 61412345678 or 0061 412 345 678; anything else null. */
export function toAuMobile(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw || /[^\d\s()+-]/.test(raw)) return null;
  const d = raw.replace(/[\s()-]/g, "");
  if (/^04\d{8}$/.test(d)) return `+61${d.slice(1)}`;
  if (/^\+614\d{8}$/.test(d)) return d;
  if (/^614\d{8}$/.test(d)) return `+${d}`;
  if (/^00614\d{8}$/.test(d)) return `+${d.slice(2)}`;
  return null;
}

/** Why the mobile number is not accepted, or undefined. */
export function mobileProblem(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return "Enter the mobile number.";
  if (/[^\d\s()+-]/.test(raw)) return "The mobile number can only contain digits, spaces and a leading +.";
  if (toAuMobile(raw)) return undefined;
  const d = raw.replace(/[\s()+-]/g, "").replace(/^(00)?61/, "0");
  if (/^0[2378]\d{8}$/.test(d)) return "That looks like a landline. Enter a mobile number starting with 04.";
  if (/^04\d*$/.test(d)) return d.length < 10 ? "The mobile number is too short: it has 10 digits (04XX XXX XXX)." : "The mobile number is too long: it has 10 digits (04XX XXX XXX).";
  return "Enter an Australian mobile number, for example 0412 345 678.";
}

/** +61412345678 as 0412 345 678 for display; any other value unchanged. */
export function formatMobile(value: string): string {
  const m = /^\+614(\d{2})(\d{3})(\d{3})$/.exec(value);
  return m ? `04${m[1]} ${m[2]} ${m[3]}` : value;
}

/** Keeps only what a phone number can contain while typing. */
export const mobileInput = (value: string) => value.replace(/[^\d\s()+-]/g, "").slice(0, 16);
