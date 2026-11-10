import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, SectionTabs, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import RecruitmentTree from "@/pages/admin/components/RecruitmentTree";
import { HrLink, HrNotice, HrPager, HrValue } from "@/pages/admin/components/Recruitment";
import { HR_PAGE_SIZE, hrDate, listCandidatesByJob, type CandidateRow } from "@/lib/recruitmentApi";
import WizardSteps from "@/pages/admin/components/WizardSteps";
import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABEL, EMPTY_JOB, jobPath, jobProblems, type JobForm } from "@/lib/jobs";
import { adminListJobs, adminSaveJob, adminSetJobStatus, type AdminJob } from "@/lib/jobsApi";
import { STAFF_CANDIDATES_PATH } from "@/pages/admin/lib/staffRoutes";

type Problems = Partial<Record<keyof JobForm, string>>;
const STEPS = ["Role", "Description", "Review and post"];

function F({ problem, children, ...rest }: { label: string; required?: boolean; hint?: string; problem?: string; children: ReactNode }) {
  return <div><Field {...rest}>{children}</Field>{problem ? <p role="alert" className="mt-1 text-xs text-primary-700">{problem}</p> : null}</div>;
}
const Alert = ({ text }: { text: string }) => (text ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{text}</p> : null);

const statusLabel = { draft: "Draft", open: "Open", closed: "Closed" } as const;

export default function JobsPage() {
  const [params, setParams] = useSearchParams();
  const treeView = params.get("view") === "tree";
  const [byJob, setByJob] = useState<Map<string, CandidateRow[]> | null>(null);
  const [jobs, setJobs] = useState<AdminJob[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [employmentType, setEmploymentType] = useState("");
  const [sort, setSort] = useState("recent");
  const [offset, setOffset] = useState(0);
  const [wizard, setWizard] = useState<{ id: string | null; form: JobForm } | null>(null);
  const [view, setView] = useState<AdminJob | null>(null);
  const [confirm, setConfirm] = useState<AdminJob | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setJobs(await adminListJobs()); setError(""); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { if (params.get("tab") !== "applicants") void load(); }, [load, params]);
  // Tree view: every candidate of every job, loaded when the tree is shown (and again after the jobs reload).
  useEffect(() => {
    if (!treeView || !jobs) return;
    let current = true;
    setByJob(null);
    void listCandidatesByJob(jobs.map((j) => j.id)).then((m) => { if (current) setByJob(m); }, (e: Error) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [treeView, jobs]);

  const open = (job?: AdminJob) => {
    setView(null);
    setWizard(job ? { id: job.id, form: job } : { id: null, form: { ...EMPTY_JOB } });
  };
  const changeStatus = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    try {
      const status = confirm.status === "open" ? "closed" : "open";
      await adminSetJobStatus(confirm.id, status);
      setConfirm(null); setNotice(status === "open" ? "Job published to Careers." : "Job closed.");
      await load();
    } catch (e) { setConfirm(null); setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (params.get("tab") === "applicants") {
    const job = params.get("job");
    return <Navigate to={job ? `${STAFF_CANDIDATES_PATH}?job=${encodeURIComponent(job)}` : STAFF_CANDIDATES_PATH} replace />;
  }
  const rows = (jobs ?? []).filter((j) =>
    (!filter || j.status === filter) && (!employmentType || j.employmentType === employmentType) &&
    [j.title, j.location, j.department].some((v) => v?.toLowerCase().includes(search.trim().toLowerCase())),
  ).sort((a, b) => sort === "title" ? a.title.localeCompare(b.title)
    : sort === "candidates" ? (b.candidateCount ?? b.applied) - (a.candidateCount ?? a.applied) : b.postedAt.localeCompare(a.postedAt));
  const pageOffset = Math.min(offset, Math.max(0, Math.ceil(rows.length / HR_PAGE_SIZE) - 1) * HR_PAGE_SIZE);
  const label = (j: AdminJob) => j.status === "open" ? "Close" : j.status === "draft" ? "Publish" : "Reopen";
  return <div>
    <PageHeader breadcrumb="Website" title="Jobs" description="Manage vacancies, publish openings to Careers and review their candidates (Website > Candidates)."
      actions={<Button onClick={() => open()} icon="ri-add-line" data-testid="job-new">Add Job</Button>} />
    <SectionTabs tabs={[{ id: "list", label: "List", icon: "ri-list-check" }, { id: "tree", label: "Tree", icon: "ri-node-tree" }]}
      active={treeView ? "tree" : "list"} onChange={(id) => setParams(id === "tree" ? { view: "tree" } : {})} />
    <HrNotice error>{error}</HrNotice><HrNotice>{notice}</HrNotice>
    <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <TextInput aria-label="Search jobs" placeholder="Search title, department or location" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
      <Select aria-label="Filter by job status" value={filter} onChange={(e) => { setFilter(e.target.value); setOffset(0); }}><option value="">All job statuses</option>
        {Object.entries(statusLabel).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</Select>
      <Select aria-label="Filter by employment type" value={employmentType} onChange={(e) => { setEmploymentType(e.target.value); setOffset(0); }}>
        <option value="">All employment types</option>{EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_TYPE_LABEL[t]}</option>)}
      </Select>
      <Select aria-label="Sort jobs" value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }}>
        <option value="recent">Newest first</option><option value="title">Title A–Z</option><option value="candidates">Most candidates</option>
      </Select>
    </div>
    {!jobs && !error ? <p role="status">Loading jobs…</p> : null}
    {treeView && jobs && rows.length && !byJob && !error ? <p role="status">Loading candidates…</p> : null}
    {treeView && jobs && rows.length && byJob ? <RecruitmentTree byDepartment jobs={rows} byJob={byJob}
      emptyText={{ title: "No matching jobs", description: "Add a job or adjust the current filters." }} /> : null}
    {jobs && !rows.length ? <EmptyState icon="ri-briefcase-line" title="No matching jobs" description="Add a job or adjust the current filters." /> : null}
    {!treeView && rows.length ? <Card className="data-table-frame">
      <table className="data-table w-full text-left text-sm" data-testid="jobs-table">
        <thead className="border-b border-background-200 text-xs uppercase text-foreground-500"><tr>
          {["Job title", "Department", "Location", "Vacancies", "Candidates", "Status", "Actions"].map((heading) => <th className="px-4 py-3" key={heading}>{heading}</th>)}
        </tr></thead>
        <tbody>{rows.slice(pageOffset, pageOffset + HR_PAGE_SIZE).map((j) => <tr key={j.id} className="border-b border-background-100 last:border-0">
          <td data-label="Job title" className="px-4 py-3"><button className="text-left font-medium text-primary-700 hover:underline" onClick={() => setView(j)}>{j.title}</button>
            <div className="text-xs text-foreground-500">{EMPLOYMENT_TYPE_LABEL[j.employmentType]}</div></td>
          <td data-label="Department" className="px-4 py-3">{j.department || "—"}</td><td data-label="Location" className="px-4 py-3">{j.location}</td><td data-label="Vacancies" className="px-4 py-3">{j.vacancies ?? 1}</td>
          <td data-label="Candidates" className="px-4 py-3"><HrLink to={`${STAFF_CANDIDATES_PATH}?job=${j.id}`}>{j.candidateCount ?? j.applied + j.hired + j.declined} candidates</HrLink></td>
          <td data-label="Status" className="px-4 py-3"><Badge tone={j.status === "open" ? "success" : "muted"}>{statusLabel[j.status]}</Badge></td>
          <td data-label="Actions" className="px-4 py-3"><div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => open(j)}>Edit</Button>
            <Button size="sm" variant="outline" onClick={() => setConfirm(j)}>{label(j)}</Button>
          </div></td>
        </tr>)}</tbody>
      </table>
    </Card> : null}
    {!treeView ? <HrPager offset={pageOffset} total={rows.length} onChange={setOffset} /> : null}
    {view ? <Modal open title={view.title} onClose={() => setView(null)} footer={<><Button variant="outline" onClick={() => setView(null)}>Close</Button><Button onClick={() => open(view)}>Edit Job</Button></>}>
      <dl className="grid gap-3 sm:grid-cols-2">
        <HrValue label="Status">{statusLabel[view.status]}</HrValue><HrValue label="Employment type">{EMPLOYMENT_TYPE_LABEL[view.employmentType]}</HrValue>
        <HrValue label="Department">{view.department}</HrValue><HrValue label="Location">{view.location}</HrValue>
        <HrValue label="Salary range">{view.salary}</HrValue><HrValue label="Vacancies">{view.vacancies ?? 1}</HrValue>
        <HrValue label="Published">{hrDate(view.publishedAt ?? null)}</HrValue>
        <HrValue label="Candidates"><HrLink to={`${STAFF_CANDIDATES_PATH}?job=${view.id}`}>View candidates</HrLink></HrValue>
      </dl>
      <dl className="my-4"><HrValue label="Description">{view.description}</HrValue></dl>
      {view.status === "open" ? <Link className="text-sm font-medium text-primary-700 hover:underline" to={jobPath(view.id)} target="_blank" rel="noopener noreferrer">View on Careers</Link> : null}
    </Modal> : null}
    {confirm ? <Modal open title={`${label(confirm)} job`} onClose={() => { if (!busy) setConfirm(null); }} footer={<>
      <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
      <Button disabled={busy} onClick={() => void changeStatus()}>{busy ? "Saving…" : label(confirm)}</Button>
    </>}>
      <p className="text-sm">{confirm.status === "open" ? `Close ${confirm.title} and stop accepting new applications?` : `Publish ${confirm.title} and accept applications on Careers?`}</p>
    </Modal> : null}
    {wizard ? <JobWizard id={wizard.id} initial={wizard.form} onClose={() => setWizard(null)} onSaved={(status) => {
      setWizard(null); setNotice(status === "open" ? "Job saved and visible on Careers." : "Job saved."); void load();
    }} /> : null}
  </div>;
}

/** Three steps: the role (title, type, location, salary), the description, then a review with Post / Save. */
function JobWizard({ id, initial, onClose, onSaved }: { id: string | null; initial: JobForm; onClose: () => void; onSaved: (status: JobForm["status"]) => void }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<JobForm>(initial);
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (next: Partial<JobForm>) => setForm((f) => ({ ...f, ...next }));

  const next = () => {
    const found = jobProblems(form);
    const own: Array<keyof JobForm> = step === 0 ? ["title", "employmentType", "location", "salary", "department", "vacancies", "status"] : ["description"];
    const here = Object.fromEntries(Object.entries(found).filter(([k]) => own.includes(k as keyof JobForm))) as Problems;
    setProblems(here);
    if (Object.keys(here).length) return;
    setStep((s) => s + 1);
  };
  const save = async () => {
    if (busy) return;
    const found = jobProblems(form);
    if (Object.keys(found).length) { setProblems(found); setStep(found.description && Object.keys(found).length === 1 ? 1 : 0); return; }
    setBusy(true); setError("");
    try { await adminSaveJob(id, form); onSaved(form.status); }
    catch (e) { setError(e instanceof Error ? e.message : "The job could not be saved."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open title={id ? "Edit job post" : "New job post"} onClose={() => { if (!busy) onClose(); }}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}>{step === 0 ? "Cancel" : "Back"}</Button>
        {step < STEPS.length - 1
          ? <Button onClick={next} data-testid="job-next">Next</Button>
          : <Button onClick={() => void save()} disabled={busy} data-testid="job-save">{busy ? "Saving…" : form.status === "open" ? "Save and publish" : form.status === "draft" ? "Save draft" : "Save closed job"}</Button>}
      </>}>
      <WizardSteps steps={STEPS} current={step} />
      {step === 0 ? (
        <div className="space-y-4">
          <F label="Job title" required problem={problems.title}><TextInput value={form.title} onChange={(e) => patch({ title: e.target.value })} maxLength={150} placeholder="e.g. Commercial Cookery Trainer" data-testid="job-title" /></F>
          <div className="grid gap-4 sm:grid-cols-2">
            <F label="Employment type" required problem={problems.employmentType}>
              <Select value={form.employmentType} onChange={(e) => patch({ employmentType: e.target.value as JobForm["employmentType"] })} data-testid="job-type">
                {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_TYPE_LABEL[t]}</option>)}
              </Select>
            </F>
            <F label="Location" required problem={problems.location}><TextInput value={form.location} onChange={(e) => patch({ location: e.target.value })} maxLength={150} placeholder="Melbourne, VIC" data-testid="job-location" /></F>
            <F label="Salary range" problem={problems.salary} hint="As shown on the website, e.g. $75,000 – $85,000 + super."><TextInput value={form.salary} onChange={(e) => patch({ salary: e.target.value })} maxLength={120} data-testid="job-salary" /></F>
            <F label="Department" problem={problems.department}><TextInput maxLength={120} value={form.department ?? ""} onChange={(e) => patch({ department: e.target.value })} /></F>
            <F label="Vacancies" required problem={problems.vacancies}><TextInput type="number" min={1} max={10000} value={Number.isNaN(form.vacancies) ? "" : form.vacancies ?? 1} onChange={(e) => patch({ vacancies: e.target.valueAsNumber })} /></F>
            <F label="Status" problem={problems.status}>
              <Select value={form.status} onChange={(e) => patch({ status: e.target.value as JobForm["status"] })}><option value="draft">Draft</option><option value="open">Open (published to Careers)</option><option value="closed">Closed</option></Select>
            </F>
          </div>
        </div>
      ) : null}
      {step === 1 ? (
        <F label="Job description" required problem={problems.description} hint="Responsibilities, requirements, hours and how to stand out. Line breaks are kept on the website.">
          <TextArea rows={12} value={form.description} onChange={(e) => patch({ description: e.target.value })} maxLength={10000} data-testid="job-description" />
        </F>
      ) : null}
      {step === 2 ? (
        <div className="space-y-4">
          <dl className="grid gap-3 rounded-md border border-background-200 bg-background-100 p-4 text-sm sm:grid-cols-2">
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Title</dt><dd className="font-semibold text-foreground-950">{form.title}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Type</dt><dd>{EMPLOYMENT_TYPE_LABEL[form.employmentType]}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Location</dt><dd>{form.location}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Salary</dt><dd>{form.salary || "Not stated"}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Status</dt><dd>{statusLabel[form.status]}</dd></div>
          </dl>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Description</p><p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-line rounded-md border border-background-200 p-3 text-sm text-foreground-800">{form.description}</p></div>
          <Alert text={error} />
        </div>
      ) : null}
    </Modal>
  );
}
