import { supabase } from "@/pages/admin/lib/supabase";
import type { EmploymentType, JobApplicationStatus, JobForm, JobStatus } from "@/lib/jobs";
import type { StaffStatus } from "@/lib/staffStatus";

/** Browser-side calls for job posts (public list, CMS management) and the Applicants tab. Applying is the public staff form with the job
 *  attached (staffApi.applyAsStaff); sending the document link or rejecting is staff-admin (staffApi.staffAdminActions). */

export interface Job {
  id: string; title: string; description: string; employmentType: EmploymentType; salary: string; location: string; status: JobStatus; postedAt: string; updatedAt: string;
}
export interface AdminJob extends Job { applied: number; hired: number; declined: number }
/** One row of the Applicants tab: the application with the person it belongs to. */
export interface JobApplicationRow {
  id: string; jobId: string; jobTitle: string; employmentType: EmploymentType; location: string; profileId: string; name: string; email: string; phone: string;
  staffStatus: StaffStatus; status: JobApplicationStatus; appliedAt: string; decidedAt: string | null; decisionNote: string;
  resume: { filename: string; storagePath: string; mimeType: string | null } | null; coverLetter: string; coverLetterFile: { filename: string; storagePath: string; mimeType: string | null } | null;
}

function fail(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

/** Open jobs, newest first. Anyone may read them. */
export async function listOpenJobs(): Promise<Job[]> {
  const { data, error } = await supabase.rpc("jobs_open", { p_id: null });
  if (error) fail(error, "The jobs could not be loaded.");
  return (data ?? []) as Job[];
}

/** One job by id, open or closed; null when there is no such job. */
export async function getJob(id: string): Promise<Job | null> {
  const { data, error } = await supabase.rpc("jobs_open", { p_id: id });
  if (error) fail(error, "The job could not be loaded.");
  return ((data ?? []) as Job[])[0] ?? null;
}

/* ------------------------------------------------------------------ admin */

export async function adminListJobs(): Promise<AdminJob[]> {
  const { data, error } = await supabase.rpc("hr_admin_job_list");
  if (error) fail(error, "The job posts could not be loaded.");
  return (data ?? []) as AdminJob[];
}

export async function adminListJobApplications(jobId: string | null): Promise<JobApplicationRow[]> {
  const { data, error } = await supabase.rpc("hr_admin_job_applications", { p_job: jobId });
  if (error) fail(error, "The applicants could not be loaded.");
  return (data ?? []) as JobApplicationRow[];
}

export async function adminSaveJob(id: string | null, form: JobForm): Promise<Job> {
  const { data, error } = await supabase.rpc("hr_admin_job_save", { p_id: id, p_job: { ...form, title: form.title.trim(), description: form.description.trim(), salary: form.salary.trim(), location: form.location.trim() } });
  if (error) fail(error, "The job could not be saved.");
  return data as Job;
}
