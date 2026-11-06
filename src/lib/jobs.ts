// Job posts and job applications: the pure parts (labels, checks, the remembered "apply for this job" intent). Browser-free so
// scripts/test-staff-registration.ts covers them; the database (hr_admin_job_save, hr_job_apply) checks everything again.

export type EmploymentType = "full_time" | "part_time";
export const EMPLOYMENT_TYPES: readonly EmploymentType[] = ["full_time", "part_time"];
export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = { full_time: "Full time", part_time: "Part time" };

export type JobStatus = "open" | "closed";
export type JobApplicationStatus = "applied" | "hired" | "declined";
export const JOB_APPLICATION_STATUS_LABEL: Record<JobApplicationStatus, string> = { applied: "Applied", hired: "Hired", declined: "Declined" };

export interface JobForm { title: string; description: string; employmentType: EmploymentType; salary: string; location: string; status: JobStatus }
export const EMPTY_JOB: JobForm = { title: "", description: "", employmentType: "full_time", salary: "", location: "", status: "open" };

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
  if (form.status !== "open" && form.status !== "closed") problems.status = "A job is open or closed.";
  return problems;
}

/** Resume and cover letter files: PDF or Word, 10 MB or smaller. The extension the stored copy gets, by mime type. */
export const JOB_FILE_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf", "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
export const JOB_FILE_ACCEPT = ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const JOB_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** "" when the file can be uploaded, otherwise what is wrong. A .docx dragged from some browsers has no type: the name decides. */
export function jobFileProblem(file: { name: string; type: string; size: number }): string {
  if (!jobFileMime(file)) return "Upload a PDF or Word document (.pdf, .doc or .docx).";
  if (file.size <= 0 || file.size > JOB_FILE_MAX_BYTES) return "The file must be 10 MB or smaller.";
  return "";
}

/** The mime type to store, from the file's type or its extension; null when it is not a PDF or Word document. */
export function jobFileMime(file: { name: string; type: string }): string | null {
  if (JOB_FILE_EXTENSION[file.type]) return file.type;
  const ext = file.name.toLowerCase().match(/\.(pdf|docx?)$/)?.[1];
  if (ext === "pdf") return "application/pdf";
  if (ext === "doc") return "application/msword";
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return null;
}

/** What stops an application being sent, in the order the form shows it. Mirrors hr_job_apply. */
export function applyProblems(input: { hasResume: boolean; coverLetter: string; hasCoverLetterFile: boolean }): string[] {
  const problems: string[] = [];
  if (!input.hasResume) problems.push("Upload your resume.");
  const letter = input.coverLetter.trim();
  if (!letter && !input.hasCoverLetterFile) problems.push("Write a cover letter or upload one.");
  if (letter.length > 5000) problems.push("The cover letter must be 5,000 characters or fewer.");
  return problems;
}

/* ------------------------------------------------------------------ the remembered job while an account is created */

const INTENT_KEY = "skyline.jobIntent";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
function store(): Store | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/**
 * The job someone was applying for when they went off to create an account. Kept in localStorage (not sessionStorage) because the
 * emailed link may open in a new tab; /staff/apply then returns them to the job instead of the staff workspace.
 */
export function rememberJobIntent(jobId: string | null, s: Store | null = store()): void {
  try { if (jobId && UUID.test(jobId)) s?.setItem(INTENT_KEY, jobId); else s?.removeItem(INTENT_KEY); } catch { /* private mode */ }
}
export function readJobIntent(s: Store | null = store()): string | null {
  try { const v = s?.getItem(INTENT_KEY) ?? null; return v && UUID.test(v) ? v : null; } catch { return null; }
}
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

