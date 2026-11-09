import { supabase } from "@/pages/admin/lib/supabase";
import { staffAdminActions } from "@/lib/staffApi";
import type { EmploymentType, JobApplicationStatus, JobStatus } from "@/lib/jobs";
import type { StaffStatus } from "@/lib/staffStatus";

/**
 * Staff > Candidates (HR-02j): the recruitment pipeline of a job application (screening > shortlisted > interview > selected), then
 * "Hire and send document link" (staff-admin `hire`: the employment record from the job and HR-02's document link) or declined /
 * withdrawn (HR-02's reject for a person who is still just applied, email optional). A Careers applicant's resume is the staff
 * application's and their cover letter file the job application's; a manual candidate's files arrive through staff-admin.
 */

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
export interface CandidateFile { filename: string; storagePath: string; mimeType: string | null }
export interface Candidate extends CandidateRow {
  jobId: string; jobStatus: JobStatus; staffStatus: StaffStatus; linkedAccount: boolean; interviewAt: string | null; interviewNotes: string; recruiterNotes: string;
  coverLetter: string; decisionNote: string; decidedAt: string | null; employeeId: string | null; filesPurged: boolean; history: HistoryEvent[];
  resume: CandidateFile | null; coverLetterFile: CandidateFile | null;
}
export interface Page<T> { rows: T[]; total: number }
export type { EmploymentType };

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
/** Add (id null) or edit a manual candidate: the person, the job, the cover letter text and the recruiter notes. */
export function saveCandidate(id: string | null, jobId: string, person: PersonForm, letter: string, notes: string) {
  return rpc<string>("hr_admin_candidate_save", { p_id: id, p_job: jobId, p_person: person, p_cover_letter: letter, p_recruiter_notes: notes });
}
/** A stage change, or declined / withdrawn with a reason (notify: email the person when it closes their application). */
export function progressCandidate(id: string, action: Stage | "declined" | "withdrawn", interview: string, notes: string, reason: string, notify = true) {
  return rpc<string>("hr_admin_candidate_progress", { p_id: id, p_action: action, p_interview_at: interview || null, p_interview_notes: notes || null, p_reason: reason || null, p_notify: notify });
}
/** "Hire and send document link" (selected stage): answers like a document link (emailSent, or the link once when email is off) plus profileId. */
export const hireCandidate = (id: string) => staffAdminActions.hire(id);
/** A manual candidate's resume or cover letter file: checked by content and stored by staff-admin, never uploaded from the browser. */
export const uploadCandidateFile = (id: string, which: "resume" | "cover_letter", file: File) => staffAdminActions.candidateFile(id, which, file);
