
import { formatPhone, parseStoredPhone, validateStoredPhone } from "../../supabase/functions/_shared/validation/identifiers";
import { bankDigits as digits, bankProblems as sharedBankProblems } from "../../supabase/functions/_shared/validation/person";

/** Staff > Employees, simple (20261110170000): types and the checks shared by the form and tests. No network here. */

export type EmployeeStatus = "active" | "inactive";
export const EMPLOYEE_STATUS_LABEL: Record<EmployeeStatus, string> = { active: "Active", inactive: "Inactive" };

/** The employment record beside an employee (hr.employment_json): job, type, location (from HRMS > Locations) and pay type. */
export interface EmployeeEmployment {
  department: string; jobTitle: string; employmentType: "full_time" | "part_time" | "contract" | "casual" | null; joiningDate: string | null;
  managerId: string | null; managerName: string | null; workLocation: string; locationId: string | null; payType: "fortnightly" | "monthly" | null;
}
export interface Employee {
  id: string; firstName: string; lastName: string; email: string; phone: string; status: EmployeeStatus;
  createdAt: string; statusChangedAt: string; hasLogin: boolean; documents: number;
  /** Whether the linked login has chosen a password (My HR opens only then) and the employment record, if any. */
  passwordSet?: boolean; employment?: EmployeeEmployment | null;
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

/* mobile: the same rules as the student and agent forms (PhoneInput: country code + number; validateStoredPhone) */

/** Why the stored mobile (E.164 from PhoneInput) is not accepted, or undefined. */
export function mobileProblem(stored: string): string | undefined {
  if (!parseStoredPhone(stored)?.national) return "Enter the mobile number.";
  return validateStoredPhone(stored) || undefined;
}

/** 041 234 5678 for Australia, +91 987 654 321 0 style otherwise (as on student and agent records). */
export const formatMobile = (value: string) => formatPhone(value);

/* several documents at once */

const GUESSES: [RegExp, EmployeeDocCategory][] = [
  [/passport/i, "Passport"],
  [/visa|vevo/i, "Visa"],
  [/driv|licen[cs]e/i, "Driving Licence"],
  [/\bpte\b|pearson/i, "PTE"],
  [/ielts|toefl|english/i, "English Certificate"],
  [/health|insurance|oshc|ovhc|medicare/i, "Health Insurance"],
  [/resume|\bcv\b|curriculum/i, "Resume"],
  [/degree|diploma|transcript|academic|certificate|qualification|bachelor|master/i, "Academic"],
];

/** A document type guessed from the file name; otherwise the first type not used yet in this batch (Passport first). */
export function guessDocCategory(filename: string, used: readonly string[] = []): EmployeeDocCategory {
  const name = filename.replace(/[_\-.]+/g, " ");
  const hit = GUESSES.find(([re]) => re.test(name));
  if (hit) return hit[1];
  return EMPLOYEE_DOC_CATEGORIES.find((c) => !used.includes(c)) ?? EMPLOYEE_DOC_CATEGORIES[0];
}

/** Types chosen for more than one file in the same batch (only the last would stay current). */
export function duplicateCategories(categories: readonly string[]): string[] {
  return [...new Set(categories.filter((c, i) => categories.indexOf(c) !== i))];
}

/* bank details (hr.employee_bank; stored encrypted since 20261112090000). The rules are the shared ones (bankProblems in
   supabase/functions/_shared/validation/person.ts), which the database repeats with the same messages. */

/** masked: true when the BSB and account number are shown masked (06••••, •••• 4321), as an administrator first sees them. */
export interface EmployeeBank { accountName: string; bsb: string; accountNumber: string; bankName: string; updatedAt?: string; masked?: boolean }
export const EMPTY_BANK: EmployeeBank = { accountName: "", bsb: "", accountNumber: "", bankName: "" };

/** True when nothing was typed (on Add / Edit employee the bank details are optional). */
export const bankIsEmpty = (b: EmployeeBank) => !b.accountName.trim() && !digits(b.bsb) && !digits(b.accountNumber) && !b.bankName.trim();

/** Field problems of the bank details; empty when they can be saved (or are all blank). */
export function bankProblems(b: EmployeeBank): Partial<Record<keyof EmployeeBank, string>> {
  if (bankIsEmpty(b)) return {};
  const out: Partial<Record<keyof EmployeeBank, string>> = sharedBankProblems(b);
  if (b.bankName.trim().length > 100) out.bankName = "The bank name must be 100 characters or fewer.";
  return out;
}

export { bsbBank, formatBsb } from "../../supabase/functions/_shared/validation/person";
