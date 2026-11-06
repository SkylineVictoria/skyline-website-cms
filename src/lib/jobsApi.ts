import { supabase } from "@/pages/admin/lib/supabase";
import type { EmploymentType, JobApplicationStatus, JobForm, JobStatus } from "@/lib/jobs";
import { JOB_FILE_EXTENSION, jobFileMime, jobFileProblem } from "@/lib/jobs";
import type { StaffDetail, StaffMe } from "@/lib/staffApi";
import type { StaffStatus } from "@/lib/staffStatus";

/** Browser-side calls for job posts (public list, CMS management) and job applications. The hr schema is reached through functions only. */

export interface Job {
  id: string; title: string; description: string; employmentType: EmploymentType; salary: string; location: string; status: JobStatus; postedAt: string; updatedAt: string;
}
export interface AdminJob extends Job { applied: number; hired: number; declined: number }
/** One row of the Applicants tab: the application with the person it belongs to. */
export interface JobApplicationRow {
  id: string; jobId: string; jobTitle: string; employmentType: EmploymentType; location: string; profileId: string; name: string; email: string; phone: string;
  staffStatus: StaffStatus; status: JobApplicationStatus; appliedAt: string; decidedAt: string | null; decisionNote: string; resume: { filename: string; storagePath: string } | null;
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

export async function adminDecideJobApplication(applicationId: string, decision: Exclude<JobApplicationStatus, "applied">, note: string): Promise<StaffDetail> {
  const { data, error } = await supabase.rpc("hr_admin_job_decide", { p_application: applicationId, p_decision: decision, p_note: note.trim() || null });
  if (error) fail(error, "That could not be done.");
  return data as StaffDetail;
}

/* ------------------------------------------------------------------ applicant */

/** Uploads a resume or cover letter to the private staff bucket and registers it (it replaces the previous one of its kind). Never sent for reading. */
export async function uploadJobDocument(me: StaffMe, uid: string, category: "Resume" | "Cover Letter", file: File): Promise<{ id: string; filename: string }> {
  const problem = jobFileProblem(file);
  if (problem) throw new Error(problem);
  const mime = jobFileMime(file)!;
  const path = `${uid}/${me.application.id}/${category.toLowerCase().replace(/\s+/g, "-")}-${crypto.randomUUID()}.${JOB_FILE_EXTENSION[mime]}`;
  const up = await supabase.storage.from("staff-documents").upload(path, file, { contentType: mime, upsert: false });
  if (up.error) throw new Error("The upload failed. Please try again.");
  const { data, error } = await supabase.rpc("hr_staff_document_register", { p_category: category, p_path: path, p_filename: file.name.slice(0, 255), p_mime: mime, p_size: file.size });
  if (error) {
    await supabase.storage.from("staff-documents").remove([path]);
    fail(error, "The document could not be saved.");
  }
  const result = data as { id: string; replacedPaths: string[] };
  if (result.replacedPaths.length) await supabase.storage.from("staff-documents").remove(result.replacedPaths);
  return { id: result.id, filename: file.name.slice(0, 255) };
}

export async function applyForJob(jobId: string, coverLetter: string, resumeDocumentId: string, coverLetterDocumentId: string | null): Promise<StaffMe> {
  const { data, error } = await supabase.rpc("hr_job_apply", { p_job: jobId, p_cover_letter: coverLetter.trim() || null, p_resume_document: resumeDocumentId, p_cover_letter_document: coverLetterDocumentId });
  if (error) fail(error, "Your application could not be sent.");
  return data as StaffMe;
}
