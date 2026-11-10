// Job posts and job applications: the pure parts (labels, checks, the remembered "apply for this job" intent). Browser-free so
// scripts/test-staff-registration.ts covers them; the database (hr_admin_job_save, hr_job_apply) checks everything again.

export type EmploymentType = "full_time" | "part_time";
export const EMPLOYMENT_TYPES: readonly EmploymentType[] = ["full_time", "part_time"];
export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType | "casual", string> = { full_time: "Full time", part_time: "Part time", casual: "Casual" };

export type JobStatus = "draft" | "open" | "closed";
export type JobApplicationStatus = "applied" | "hired" | "declined" | "withdrawn";
export const JOB_APPLICATION_STATUS_LABEL: Record<JobApplicationStatus, string> = { applied: "Applied", hired: "Hired", declined: "Declined", withdrawn: "Withdrawn" };

export interface JobForm { title: string; description: string; employmentType: EmploymentType; salary: string; location: string; status: JobStatus; department?: string; vacancies?: number }
export const EMPTY_JOB: JobForm = { title: "", description: "", employmentType: "full_time", salary: "", location: "", status: "draft", department: "", vacancies: 1 };

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

/** Resume and cover letter files on the public form: PDF or Word .docx, 5 MB or smaller (staff-register checks the content too). */
export const JOB_FILE_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
export const JOB_FILE_ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const JOB_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const COVER_LETTER_MAX = 5000;

/** "" when the file can be sent, otherwise what is wrong. A .docx dragged from some browsers has no type: the name decides. */
export function jobFileProblem(file: { name: string; type: string; size: number }): string {
  if (!jobFileMime(file)) return "Upload a PDF or Word (.docx) file.";
  if (file.size <= 0 || file.size > JOB_FILE_MAX_BYTES) return "The file must be 5 MB or smaller.";
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

