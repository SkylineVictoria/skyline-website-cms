import type { AdminJob } from "@/lib/jobsApi";
import type { CandidateRow, Stage } from "@/lib/recruitmentApi";

/**
 * Tree views of Staff > Jobs and Staff > Candidates: department > job > recruitment stage > candidate. Pure functions only; the
 * candidates of each job come from hr_admin_candidates with p_job (its rows carry no job id).
 */

export type TreeStage = Stage | "hired" | "declined" | "withdrawn";
export const TREE_STAGES: { key: TreeStage; label: string }[] = [
  { key: "screening", label: "Screening" }, { key: "shortlisted", label: "Shortlisted" }, { key: "interview", label: "Interview" },
  { key: "selected", label: "Selected" }, { key: "hired", label: "Hired" }, { key: "declined", label: "Declined" }, { key: "withdrawn", label: "Withdrawn" },
];
/** Where a candidate sits: their stage while the application is open, else how it closed. */
export const treeStage = (c: Pick<CandidateRow, "status" | "stage">): TreeStage => (c.status === "applied" ? c.stage : c.status);

export interface StageBranch { key: TreeStage; label: string; candidates: CandidateRow[] }
export interface JobBranch { job: AdminJob; stages: StageBranch[]; total: number; inProgress: number }
export interface DepartmentBranch { name: string; jobs: JobBranch[]; total: number }

const candidateName = (c: CandidateRow) => ([c.firstName, c.lastName].filter(Boolean).join(" ") || c.email).toLowerCase();

/** One job with its candidates grouped by stage, in pipeline order; empty stages are left out. */
export function buildJobBranch(job: AdminJob, candidates: CandidateRow[]): JobBranch {
  const stages = TREE_STAGES.map(({ key, label }) => ({
    key, label, candidates: candidates.filter((c) => treeStage(c) === key).sort((a, b) => candidateName(a).localeCompare(candidateName(b))),
  })).filter((s) => s.candidates.length);
  return { job, stages, total: candidates.length, inProgress: candidates.filter((c) => c.status === "applied").length };
}

/** Jobs grouped by department (A–Z, "No department" last); jobs inside sorted by title. */
export function buildDepartmentTree(jobs: AdminJob[], byJob: Map<string, CandidateRow[]>): DepartmentBranch[] {
  const groups = new Map<string, JobBranch[]>();
  for (const job of jobs) {
    const name = job.department?.trim() || "";
    groups.set(name, [...(groups.get(name) ?? []), buildJobBranch(job, byJob.get(job.id) ?? [])]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([name, branches]) => ({
      name: name || "No department",
      jobs: branches.sort((a, b) => a.job.title.localeCompare(b.job.title)),
      total: branches.reduce((n, b) => n + b.total, 0),
    }));
}

/** Whether the candidate matches the search (name, email or phone). */
export function candidateMatches(c: CandidateRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [c.firstName, c.lastName, c.email, c.phone].some((v) => (v ?? "").toLowerCase().includes(q))
    || [c.firstName, c.lastName].filter(Boolean).join(" ").toLowerCase().includes(q);
}

/** Whether the job (title, department, location) or any of its candidates matches the search. */
export function jobBranchMatches(branch: JobBranch, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const j = branch.job;
  return [j.title, j.department, j.location].some((v) => (v ?? "").toLowerCase().includes(q))
    || branch.stages.some((s) => s.candidates.some((c) => candidateMatches(c, q)));
}
