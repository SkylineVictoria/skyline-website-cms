import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState } from "@/pages/admin/components/ui";
import { hrDate, hrName, type CandidateRow } from "@/lib/recruitmentApi";
import type { AdminJob } from "@/lib/jobsApi";
import { EMPLOYMENT_TYPE_LABEL } from "@/lib/jobs";
import { buildDepartmentTree, buildJobBranch, candidateMatches, jobBranchMatches, type JobBranch, type StageBranch, type TreeStage } from "@/lib/recruitmentTree";
import { STAFF_CANDIDATES_PATH, staffCandidatePath } from "@/pages/admin/lib/staffRoutes";
import { ORG_CSS } from "@/pages/admin/components/treeCss";

const jobStatusLabel = { draft: "Draft", open: "Open", closed: "Closed" } as const;
const stageTone = (key: TreeStage) => (key === "hired" ? "success" : key === "declined" || key === "withdrawn" ? "muted" : "warn");
/** Closed applications start folded so the open pipeline stands out. */
const startsFolded = (key: TreeStage) => key === "declined" || key === "withdrawn";

/**
 * Staff > Jobs and Staff > Candidates, Tree view: (department >) job > stage > candidate. `byDepartment` adds the department level
 * (Jobs); `search` keeps a job when it or one of its candidates matches and shows every branch open.
 */
export default function RecruitmentTree({ jobs, byJob, byDepartment, search = "", emptyText }: {
  jobs: AdminJob[]; byJob: Map<string, CandidateRow[]>; byDepartment?: boolean; search?: string; emptyText: { title: string; description: string };
}) {
  // Keys: "d:<department>", "j:<job id>", "s:<job id>:<stage>". Value: true = open.
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const searching = search.trim().length > 0;
  const isOpen = (key: string, byDefault = true) => searching || (toggled.get(key) ?? byDefault);
  const toggle = (key: string, byDefault = true) => setToggled((m) => new Map(m).set(key, !(m.get(key) ?? byDefault)));

  const departments = byDepartment
    ? buildDepartmentTree(jobs, byJob).map((d) => ({ ...d, jobs: d.jobs.filter((j) => jobBranchMatches(j, search)) })).filter((d) => d.jobs.length)
    : [];
  const flat = byDepartment ? [] : jobs.map((j) => buildJobBranch(j, byJob.get(j.id) ?? [])).filter((j) => jobBranchMatches(j, search));
  const allKeys = (open: boolean) => {
    const m = new Map<string, boolean>();
    const branches = byDepartment ? departments.flatMap((d) => { m.set(`d:${d.name}`, open); return d.jobs; }) : flat;
    for (const b of branches) { m.set(`j:${b.job.id}`, open); for (const s of b.stages) m.set(`s:${b.job.id}:${s.key}`, open); }
    return m;
  };

  if (!(byDepartment ? departments.length : flat.length)) return <EmptyState icon="ri-node-tree" title={emptyText.title} description={emptyText.description} />;

  const fold = (key: string, count: number, label: string, byDefault = true) => (count && !searching ? (
    <button type="button" onClick={() => toggle(key, byDefault)} aria-expanded={isOpen(key, byDefault)} aria-label={`${isOpen(key, byDefault) ? "Hide" : "Show"} ${label}`}
      className="flex h-6 cursor-pointer items-center gap-1 rounded-full border border-background-300 bg-background-50 px-2 text-[11px] font-medium text-foreground-700 hover:bg-background-100">
      <i className={isOpen(key, byDefault) ? "ri-subtract-line" : "ri-add-line"} aria-hidden="true" />{count}
    </button>
  ) : null);
  const box = (children: ReactNode, testId: string, extra = "") => (
    <div className={`flex min-w-[220px] max-w-[360px] items-start gap-3 rounded-card border border-background-200 bg-background-50 p-3 text-left shadow-sm ${extra}`} data-testid={testId}>{children}</div>
  );

  const candidateNode = (c: CandidateRow) => (
    <li key={c.id} className="org-tree-item">
      {box(<>
        <i className="ri-user-line mt-0.5 text-foreground-500" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <Link to={staffCandidatePath(c.id)} className="block truncate text-sm font-semibold text-foreground-950 hover:text-primary-700 hover:underline">{hrName(c)}</Link>
          <span className="block truncate text-xs text-foreground-600">{c.email}</span>
          <span className="block text-[11px] text-foreground-500">{c.source === "manual" ? "Manual" : "Careers"} · applied {hrDate(c.appliedAt)}</span>
        </span>
      </>, `tree-candidate-${c.id}`)}
    </li>
  );

  const stageNode = (b: JobBranch, s: StageBranch) => {
    const key = `s:${b.job.id}:${s.key}`;
    const shown = s.candidates.filter((c) => !searching || candidateMatches(c, search) || jobBranchMatches({ ...b, stages: [] }, search));
    if (!shown.length) return null;
    return (
      <li key={key} className="org-tree-item">
        <div className="flex items-center gap-2" data-testid={`tree-stage-${b.job.id}-${s.key}`}>
          <Badge tone={stageTone(s.key)}>{s.label}</Badge><span className="text-xs text-foreground-500">{s.candidates.length}</span>
          {fold(key, s.candidates.length, `${s.label} candidates for ${b.job.title}`, !startsFolded(s.key))}
        </div>
        {isOpen(key, !startsFolded(s.key)) ? <ul className="org-tree">{shown.map(candidateNode)}</ul> : null}
      </li>
    );
  };

  const jobNode = (b: JobBranch) => {
    const key = `j:${b.job.id}`;
    const j = b.job;
    return (
      <li key={j.id} className="org-tree-item">
        <div className="flex items-center gap-2">
          {box(<>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-800" aria-hidden="true"><i className="ri-briefcase-line" /></span>
            <span className="min-w-0 flex-1">
              <Link to={`${STAFF_CANDIDATES_PATH}?job=${encodeURIComponent(j.id)}`} className="block truncate text-sm font-semibold text-foreground-950 hover:text-primary-700 hover:underline">{j.title}</Link>
              <span className="block truncate text-xs text-foreground-600">{EMPLOYMENT_TYPE_LABEL[j.employmentType]}{j.location ? ` · ${j.location}` : ""}</span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone={j.status === "open" ? "success" : "muted"}>{jobStatusLabel[j.status]}</Badge>
                <span className="text-[11px] text-foreground-500">{b.total} {b.total === 1 ? "candidate" : "candidates"} · {b.inProgress} in progress · {j.vacancies ?? 1} {(j.vacancies ?? 1) === 1 ? "vacancy" : "vacancies"}</span>
              </span>
            </span>
          </>, `tree-job-${j.id}`)}
          {fold(key, b.stages.length, `the stages of ${j.title}`)}
        </div>
        {b.stages.length && isOpen(key) ? <ul className="org-tree">{b.stages.map((s) => stageNode(b, s))}</ul> : null}
        {!b.stages.length ? <p className="ml-7 mt-1 text-xs text-foreground-500">No candidates yet.</p> : null}
      </li>
    );
  };

  return (
    <Card className="overflow-x-auto p-4">
      <style>{ORG_CSS}</style>
      {!searching ? <div className="mb-3 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setToggled(allKeys(true))}>Expand all</Button>
        <Button size="sm" variant="ghost" onClick={() => setToggled(allKeys(false))}>Collapse all</Button>
      </div> : null}
      <ul className="org-tree org-tree-root" data-testid="recruitment-tree">
        {byDepartment ? departments.map((d) => {
          const key = `d:${d.name}`;
          return (
            <li key={key} className="org-tree-item">
              <div className="flex items-center gap-2" data-testid={`tree-department-${d.name}`}>
                <i className="ri-building-line text-foreground-600" aria-hidden="true" />
                <span className="text-sm font-semibold text-foreground-900">{d.name}</span>
                <span className="text-xs text-foreground-500">{d.jobs.length} {d.jobs.length === 1 ? "job" : "jobs"} · {d.total} {d.total === 1 ? "candidate" : "candidates"}</span>
                {fold(key, d.jobs.length, `the ${d.name} jobs`)}
              </div>
              {isOpen(key) ? <ul className="org-tree">{d.jobs.map(jobNode)}</ul> : null}
            </li>
          );
        }) : flat.map(jobNode)}
      </ul>
    </Card>
  );
}
