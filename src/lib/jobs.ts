// Job posts and job applications: the pure parts (labels, checks, the remembered "apply for this job" intent). Browser-free so
// scripts/test-staff-registration.ts covers them; the database (hr_admin_job_save, hr_job_apply) checks everything again.
import { hrList, hrNumber, hrObject, megabytes, onHrRules } from "@/lib/hrRules";

export type EmploymentType = "full_time" | "part_time";
export const EMPLOYMENT_TYPES: readonly EmploymentType[] = ["full_time", "part_time"];
/** Labels for every employment type a record may hold: job ads use full_time / part_time; staff records add contract (casual: legacy rows only). */
export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType | "contract" | "casual", string> = { full_time: "Full time", part_time: "Part time", contract: "Contract", casual: "Casual" };

export type JobStatus = "draft" | "open" | "closed";
export type JobApplicationStatus = "applied" | "hired" | "declined" | "withdrawn";
export const JOB_APPLICATION_STATUS_LABEL: Record<JobApplicationStatus, string> = { applied: "Applied", hired: "Hired", declined: "Declined", withdrawn: "Withdrawn" };

export interface JobForm { title: string; description: string; employmentType: EmploymentType; salary: string; location: string; status: JobStatus; department?: string; vacancies?: number }
export let EMPTY_JOB: JobForm = { title: "", description: "", employmentType: "full_time", salary: "", location: "", status: "draft", department: "", vacancies: 1 };

/** Employment types a staff record may be given, and the ones a job ad may use (Business Rule hrms.employment_types; the database
 * checks the same in hr_admin_staff_employment_save / hr_admin_onboarding_pay_save / hr_admin_job_save). A record keeps a type it has. */
export type StaffEmploymentType = EmploymentType | "contract";
const ALL_STAFF_TYPES: readonly StaffEmploymentType[] = ["full_time", "part_time", "contract"];
export let STAFF_EMPLOYMENT_TYPES: StaffEmploymentType[] = [...ALL_STAFF_TYPES];
export let JOB_AD_EMPLOYMENT_TYPES: EmploymentType[] = [...EMPLOYMENT_TYPES];
/** The options a type picker shows: the allowed ones, plus the value the record already has. */
export const typeOptions = <T extends string>(allowed: readonly T[], current: string): T[] =>
  current && !(allowed as readonly string[]).includes(current) ? [...allowed, current as T] : [...allowed];
const typeKey = (label: string) => label.trim().toLowerCase().replace(/\s+/g, "_");
onHrRules(() => {
  const keys = hrList("hrms.employment_types", ["Full time", "Part time", "Contract"]).map(typeKey)
    .filter((k): k is StaffEmploymentType => (ALL_STAFF_TYPES as readonly string[]).includes(k));
  STAFF_EMPLOYMENT_TYPES = keys.length ? [...new Set(keys)] : [...ALL_STAFF_TYPES];
  const ad = STAFF_EMPLOYMENT_TYPES.filter((k): k is EmploymentType => (EMPLOYMENT_TYPES as readonly string[]).includes(k));
  JOB_AD_EMPLOYMENT_TYPES = ad.length ? ad : [...EMPLOYMENT_TYPES];
  // hrms.new_job_defaults: what a new job ad starts with (hr.job_default in the database).
  const d = hrObject<{ employmentType: unknown; status: unknown; vacancies: unknown }>("hrms.new_job_defaults", { employmentType: "Full time", status: "Draft", vacancies: 1 });
  const type = typeKey(String(d.employmentType ?? ""));
  const status = String(d.status ?? "").trim().toLowerCase();
  const vacancies = typeof d.vacancies === "number" && d.vacancies >= 1 && d.vacancies <= 10000 ? Math.round(d.vacancies) : 1;
  EMPTY_JOB = { ...EMPTY_JOB, employmentType: (EMPLOYMENT_TYPES as readonly string[]).includes(type) ? type as EmploymentType : "full_time",
    status: (["draft", "open", "closed"] as string[]).includes(status) ? status as JobStatus : "draft", vacancies };
});

// eslint-disable-next-line no-control-regex -- control characters are never valid in a job post
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** What is wrong with a job post, by field; empty when it can be saved. Mirrors hr_admin_job_save. */
export function jobProblems(form: JobForm): Partial<Record<keyof JobForm, string>> {
  const problems: Partial<Record<keyof JobForm, string>> = {};
  const title = form.title.trim();
  if (title.length < 2 || title.length > 150 || CONTROL.test(title)) problems.title = "Enter a job title (2 to 150 characters).";
  const description = form.description.trim();
  if (!description || description.length > 10000 || CONTROL.test(description)) problems.description = "Enter a job description (up to 10,000 characters).";
  if (!EMPLOYMENT_TYPES.includes(form.employmentType)) problems.employmentType = "Choose Full time or Part time.";
  if (form.salary.trim().length > 120 || CONTROL.test(form.salary)) problems.salary = "The salary must be 120 characters or fewer.";
  const location = form.location.trim();
  if (!location || location.length > 150 || CONTROL.test(location)) problems.location = "Enter the job location.";
  if (!["draft", "open", "closed"].includes(form.status)) problems.status = "Choose Draft, Open or Closed.";
  if ((form.department?.trim().length ?? 0) > 120) problems.department = "The department must be 120 characters or fewer.";
  if (form.vacancies !== undefined && (!Number.isInteger(form.vacancies) || form.vacancies < 1 || form.vacancies > 10000)) problems.vacancies = "Enter a vacancy count between 1 and 10,000.";
  return problems;
}

/** Resume and cover letter files on the public form: PDF or Word .docx, 5 MB or smaller (staff-register checks the content too).
 * The size and the cover letter length are Business Rules (hrms.job_attachment_limit_mib, hrms.cover_letter_limit_chars). */
export const JOB_FILE_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
export const JOB_FILE_ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export let JOB_FILE_MAX_BYTES = 5 * 1024 * 1024;
export let COVER_LETTER_MAX = 5000;
onHrRules(() => {
  JOB_FILE_MAX_BYTES = hrNumber("hrms.job_attachment_limit_mib", 5) * 1024 * 1024;
  COVER_LETTER_MAX = hrNumber("hrms.cover_letter_limit_chars", 5000);
});

/** "" when the file can be sent, otherwise what is wrong. A .docx dragged from some browsers has no type: the name decides. */
export function jobFileProblem(file: { name: string; type: string; size: number }): string {
  if (!jobFileMime(file)) return "Upload a PDF or Word (.docx) file.";
  if (file.size <= 0 || file.size > JOB_FILE_MAX_BYTES) return `The file must be ${megabytes(JOB_FILE_MAX_BYTES)} or smaller.`;
  return "";
}

/** The mime type, from the file's type or its extension; null when it is not a PDF or .docx. */
export function jobFileMime(file: { name: string; type: string }): string | null {
  if (JOB_FILE_EXTENSION[file.type]) return file.type;
  const ext = file.name.toLowerCase().match(/.(pdf|docx)$/)?.[1];
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return null;
}

/** What stops a Careers application being sent, in the order the form shows it. The cover letter is optional. */
export function applyProblems(input: { hasResume: boolean; coverLetter: string }): string[] {
  const problems: string[] = [];
  if (!input.hasResume) problems.push("Attach your resume.");
  if (input.coverLetter.length > COVER_LETTER_MAX) problems.push(`Keep the cover letter under ${COVER_LETTER_MAX} characters.`);
  return problems;
}

/* ------------------------------------------------------------------ addresses */

export const jobApplyPath = (jobId: string) => `/careers/${jobId}/apply`;
export const jobPath = (jobId: string) => `/careers/${jobId}`;

/* ------------------------------------------------------------------ the Careers link on the website */

export const CAREERS_LINK = { label: "Careers", to: "/careers" } as const;

/**
 * The website header and footer menus are edited in the CMS; the Careers page is always reachable, so a "Careers" link is added
 * before "Contact Us" (or at the end) when nobody has put one in. A link to /careers anywhere in the menu, even under a group,
 * keeps the menu as it is.
 */
export function withCareersLink<T extends { label: string; to?: string; children?: Array<{ to?: string }> }>(items: T[], link: T): T[] {
  const has = (item: { to?: string; children?: Array<{ to?: string }> }) => item.to === CAREERS_LINK.to || (item.children ?? []).some((c) => c.to === CAREERS_LINK.to);
  if (items.some(has)) return items;
  const contact = items.findIndex((item) => item.to === "/contact");
  return contact < 0 ? [...items, link] : [...items.slice(0, contact), link, ...items.slice(contact)];
}

