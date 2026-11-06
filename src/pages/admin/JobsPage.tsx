import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABEL, EMPTY_JOB, jobPath, jobProblems, type JobForm } from "@/lib/jobs";
import { adminListJobs, adminSaveJob, type AdminJob } from "@/lib/jobsApi";

type Problems = Partial<Record<keyof JobForm, string>>;

function F({ problem, children, ...rest }: { label: string; required?: boolean; hint?: string; problem?: string; children: ReactNode }) {
  return <div><Field {...rest}>{children}</Field>{problem ? <p role="alert" className="mt-1 text-xs text-primary-700">{problem}</p> : null}</div>;
}

/** Agencies > Staff > Job posts: the jobs shown at /careers. Post, edit, open or close them; the counts link to the applicants. */
export default function JobsPage() {
  const [jobs, setJobs] = useState<AdminJob[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; form: JobForm } | null>(null);
  const [problems, setProblems] = useState<Problems>({});
  const [dialogError, setDialogError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try { setJobs(await adminListJobs()); }
    catch (e) { setJobs(null); setError(e instanceof Error ? e.message : "The job posts could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = (job?: AdminJob) => {
    setProblems({}); setDialogError("");
    setEditing(job ? { id: job.id, form: { title: job.title, description: job.description, employmentType: job.employmentType, salary: job.salary, location: job.location, status: job.status } } : { id: null, form: { ...EMPTY_JOB } });
  };
  const patch = (next: Partial<JobForm>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...next } } : e));

  const save = async () => {
    if (!editing || busy) return;
    const found = jobProblems(editing.form);
    setProblems(found);
    if (Object.keys(found).length) return;
    setBusy(true); setDialogError("");
    try { await adminSaveJob(editing.id, editing.form); setEditing(null); await load(); }
    catch (e) { setDialogError(e instanceof Error ? e.message : "The job could not be saved."); }
    finally { setBusy(false); }
  };

  const toggle = async (job: AdminJob) => {
    try { await adminSaveJob(job.id, { title: job.title, description: job.description, employmentType: job.employmentType, salary: job.salary, location: job.location, status: job.status === "open" ? "closed" : "open" }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "The job could not be updated."); }
  };

  const form = editing?.form;
  return (
    <div>
      <PageHeader breadcrumb="Staff" title="Job posts" description="Jobs shown on the website at /careers. Visitors create an account and apply with a resume and cover letter; each applicant then appears under Staff with the status Job applied."
        actions={<><Link to="/admin/staff" className="inline-flex items-center rounded-md border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100">Applicants</Link><Button onClick={() => open()} data-testid="job-new">New job post</Button></>} />
      {error ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {jobs && jobs.length === 0 ? <EmptyState icon="ri-briefcase-line" title="No job posts yet" description="Post a job with its title, description, full time or part time, salary and location. It appears on the website at once." /> : null}
      {jobs && jobs.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm" data-testid="jobs-table">
            <thead className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
              <tr><th className="px-4 py-3">Title</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Location</th><th className="px-4 py-3">Salary</th><th className="px-4 py-3">Applicants</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Posted</th><th className="px-4 py-3" /></tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-background-100 last:border-0 hover:bg-background-100">
                  <td className="px-4 py-3 font-medium"><button type="button" onClick={() => open(job)} className="cursor-pointer text-left text-primary-700 hover:underline">{job.title}</button></td>
                  <td className="px-4 py-3 text-foreground-700">{EMPLOYMENT_TYPE_LABEL[job.employmentType]}</td>
                  <td className="px-4 py-3 text-foreground-700">{job.location}</td>
                  <td className="px-4 py-3 text-foreground-700">{job.salary || "—"}</td>
                  <td className="px-4 py-3 text-foreground-700"><Link to="/admin/staff?status=job_applied" className="text-primary-700 hover:underline">{job.applied} applied</Link>{job.hired ? ` · ${job.hired} hired` : ""}{job.declined ? ` · ${job.declined} declined` : ""}</td>
                  <td className="px-4 py-3"><Badge tone={job.status === "open" ? "success" : "muted"}>{job.status === "open" ? "Open" : "Closed"}</Badge></td>
                  <td className="px-4 py-3 text-xs text-foreground-500">{new Date(job.postedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <a href={jobPath(job.id)} target="_blank" rel="noopener noreferrer" className="rounded-md border border-background-300 px-2.5 py-1 text-xs font-semibold text-foreground-700 hover:bg-background-100">View</a>
                      <Button size="sm" variant="outline" onClick={() => void toggle(job)}>{job.status === "open" ? "Close" : "Reopen"}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <Modal open={editing !== null} title={editing?.id ? "Edit job post" : "New job post"} onClose={() => setEditing(null)}
        footer={<><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={() => void save()} disabled={busy} data-testid="job-save">{busy ? "Saving…" : editing?.id ? "Save changes" : "Post job"}</Button></>}>
        {form ? (
          <div className="space-y-4">
            <F label="Job title" required problem={problems.title}><TextInput value={form.title} onChange={(e) => patch({ title: e.target.value })} maxLength={150} data-testid="job-title" /></F>
            <F label="Job description" required problem={problems.description} hint="Responsibilities, requirements and how the role works. Line breaks are kept."><TextArea rows={8} value={form.description} onChange={(e) => patch({ description: e.target.value })} maxLength={10000} data-testid="job-description" /></F>
            <div className="grid gap-4 sm:grid-cols-2">
              <F label="Employment type" required problem={problems.employmentType}>
                <Select value={form.employmentType} onChange={(e) => patch({ employmentType: e.target.value as JobForm["employmentType"] })} data-testid="job-type">
                  {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_TYPE_LABEL[t]}</option>)}
                </Select>
              </F>
              <F label="Status" problem={problems.status}>
                <Select value={form.status} onChange={(e) => patch({ status: e.target.value as JobForm["status"] })}><option value="open">Open (shown on the website)</option><option value="closed">Closed</option></Select>
              </F>
              <F label="Salary" problem={problems.salary} hint="As you want it shown, e.g. $75,000 – $85,000 + super."><TextInput value={form.salary} onChange={(e) => patch({ salary: e.target.value })} maxLength={120} data-testid="job-salary" /></F>
              <F label="Location" required problem={problems.location}><TextInput value={form.location} onChange={(e) => patch({ location: e.target.value })} maxLength={150} placeholder="Melbourne, VIC" data-testid="job-location" /></F>
            </div>
            {dialogError ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
