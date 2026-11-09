import { supabase } from "@/pages/admin/lib/supabase";
import { JOB_FILE_EXTENSION, jobFileMime, jobFileProblem, type EmploymentType, type JobApplicationStatus } from "@/lib/jobs";
import { staffApplyUrl } from "@/lib/staffApi";
import type { StaffStatus } from "@/lib/staffStatus";

export const HR_PAGE_SIZE = 20;
export const hrDate = (value: string | null) => value ? new Date(value).toLocaleString("en-AU") : "—";
export const hrName = (row: PersonForm) => [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email;

export const stages = { screening: "Screening", shortlisted: "Shortlisted", interview: "Interview", selected: "Selected" } as const;
export type Stage = keyof typeof stages;
export type CandidateAction = Stage | "hired" | "declined" | "withdrawn";

export interface PersonForm { firstName: string; lastName: string; email: string; phone: string }
export const emptyPerson: PersonForm = { firstName: "", lastName: "", email: "", phone: "" };
export interface HistoryEvent {
  id: string | number;
  action: string;
  at: string;
  details: { status?: string; stage?: string; decision?: string; fields?: string[]; job_title?: string; department?: string };
}
export interface CandidateRow extends PersonForm {
  id: string; profileId: string; jobTitle: string; source: "manual" | "careers"; appliedAt: string;
  status: JobApplicationStatus; stage: Stage;
}
interface CandidateFile { filename: string; storagePath: string }
export interface Candidate extends CandidateRow {
  jobId: string; linkedAccount: boolean; interviewAt: string | null; interviewNotes: string; recruiterNotes: string;
  coverLetter: string; decisionNote: string; decidedAt: string | null; employeeId: string | null; history: HistoryEvent[];
  resume: CandidateFile | null; coverLetterDocument: CandidateFile | null;
}
export interface EmploymentForm {
  department: string; jobTitle: string; employmentType: EmploymentType | ""; joiningDate: string; managerId: string; workLocation: string;
}
export interface Employee extends PersonForm, Omit<EmploymentForm, "employmentType" | "joiningDate" | "managerId"> {
  id: string; candidateId: string | null; linkedAccount: boolean; status: StaffStatus; managerName: string | null;
  employmentType: EmploymentType | null; joiningDate: string | null; managerId: string | null;
}
export interface EmployeeDetail extends Employee { history: HistoryEvent[] }
export interface Page<T> { rows: T[]; total: number }

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export function listCandidates(job: string, state: string, search: string, limit: number, offset: number) {
  return rpc<Page<CandidateRow>>("hr_admin_candidates", { p_job: job || null, p_state: state || null, p_search: search, p_limit: limit, p_offset: offset });
}
export function getCandidate(id: string) {
  return rpc<Candidate>("hr_admin_candidate", { p_id: id });
}
export function saveCandidate(id: string | null, jobId: string, person: PersonForm, letter: string, notes: string) {
  return rpc<string>("hr_admin_candidate_save", { p_id: id, p_job: jobId, p_person: person, p_cover_letter: letter, p_recruiter_notes: notes });
}
export function progressCandidate(id: string, action: CandidateAction, interview: string, notes: string, reason: string) {
  return rpc<string>("hr_admin_candidate_progress", { p_id: id, p_action: action, p_interview_at: interview || null,
    p_interview_notes: notes || null, p_reason: reason });
}
export async function uploadCandidateFile(id: string, category: "Resume" | "Cover Letter", file: File) {
  const problem = jobFileProblem(file);
  if (problem) throw new Error(problem);
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Sign in to upload the file.");
  const mime = jobFileMime(file)!;
  const path = `recruitment/${data.user.id}/${id}/${crypto.randomUUID()}.${JOB_FILE_EXTENSION[mime]}`;
  const bucket = supabase.storage.from("staff-documents");
  const { error } = await bucket.upload(path, file, { contentType: mime, upsert: false });
  if (error) throw new Error(error.message);
  try {
    await rpc("hr_admin_candidate_document", { p_id: id, p_category: category, p_path: path, p_filename: file.name.slice(0, 255), p_mime: mime, p_size: file.size });
  } catch (e) {
    await bucket.remove([path]);
    throw e;
  }
}

export function listEmployees(state: string, department: string, search: string, limit: number, offset: number) {
  return rpc<Page<Employee> & { departments: string[] }>("hr_admin_employees",
    { p_state: state || null, p_department: department || null, p_search: search, p_limit: limit, p_offset: offset });
}
export function getEmployee(id: string) {
  return rpc<EmployeeDetail>("hr_admin_employee", { p_id: id });
}
export function saveEmployee(id: string | null, person: PersonForm, employment: EmploymentForm) {
  return rpc<string>("hr_admin_employee_save", { p_id: id, p_person: person, p_employment: employment });
}
export async function inviteEmployee(id: string) {
  const { error } = await supabase.functions.invoke("staff-register", { body: { action: "employee_invite", profileId: id, redirectTo: staffApplyUrl() } });
  if (error) {
    const context = (error as { context?: unknown }).context;
    const parsed = context instanceof Response ? await context.clone().json().catch(() => null) : null;
    throw new Error(parsed?.error || error.message);
  }
}
