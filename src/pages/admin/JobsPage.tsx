import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, SectionTabs, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import WizardSteps from "@/pages/admin/components/WizardSteps";
import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABEL, EMPTY_JOB, JOB_APPLICATION_STATUS_LABEL, jobPath, jobProblems, type JobForm } from "@/lib/jobs";
import { adminListJobApplications, adminListJobs, adminSaveJob, type AdminJob, type JobApplicationRow } from "@/lib/jobsApi";
import { STAFF_STATUS_LABEL, STAFF_STATUS_TONE } from "@/lib/staffStatus";
import { staffAdminActions, staffDocumentUrl } from "@/lib/staffApi";
import { staffEmployeePath } from "@/pages/admin/lib/staffRoutes";

type Problems = Partial<Record<keyof JobForm, string>>;
type Tab = "posts" | "applicants";
const STEPS = ["Role", "Description", "Review and post"];

function F({ problem, children, ...rest }: { label: string; required?: boolean; hint?: string; problem?: string; children: ReactNode }) {
  return <div><Field {...rest}>{children}</Field>{problem ? <p role="alert" className="mt-1 text-xs text-primary-700">{problem}</p> : null}</div>;
}
const Alert = ({ text }: { text: string }) => (text ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{text}</p> : null);

/** Agencies > Jobs: the job posts shown at /careers (post with a short wizard, edit, open or close) and everyone who applied. Admins only. */
export default function JobsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "applicants" ? "applicants" : "posts";
  const [jobs, setJobs] = useState<AdminJob[] | null>(null);
  const [error, setError] = useState("");
  const [wizard, setWizard] = useState<{ id: string | null; form: JobForm } | null>(null);

  const load = useCallback(async () => {
    setError("");
    try { setJobs(await adminListJobs()); }
    catch (e) { setJobs(null); setError(e instanceof Error ? e.message : "The job posts could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = (job?: AdminJob) => setWizard(job
    ? { id: job.id, form: { title: job.title, description: job.description, employmentType: job.employmentType, salary: job.salary, location: job.location, status: job.status } }
    : { id: null, form: { ...EMPTY_JOB } });

  const toggle = async (job: AdminJob) => {
    try { await adminSaveJob(job.id, { title: job.title, description: job.description, employmentType: job.employmentType, salary: job.salary, location: job.location, status: job.status === "open" ? "closed" : "open" }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "The job could not be updated."); }
  };

  return (
    <div>
      <PageHeader breadcrumb="Agencies" title="Jobs" description="Job posts shown on the website at /careers, and the people who applied. A visitor creates an account, applies with a resume and cover letter, and appears under Staff with the status Job applied."
        actions={<Button onClick={() => open()} data-testid="job-new"><i className="ri-add-line" aria-hidden="true" /> New job post</Button>} />
      <SectionTabs tabs={[{ id: "posts", label: "Job posts", icon: "ri-briefcase-line" }, { id: "applicants", label: "Applicants", icon: "ri-user-received-line" }]} active={tab}
        onChange={(id) => setParams(id === "posts" ? {} : { tab: id })} />
      <Alert text={error} />
      {tab === "posts" ? <JobTable jobs={jobs} onEdit={open} onToggle={toggle} /> : <ApplicantsTable jobs={jobs ?? []} />}
      {wizard ? <JobWizard id={wizard.id} initial={wizard.form} onClose={() => setWizard(null)} onSaved={() => { setWizard(null); void load(); }} /> : null}
    </div>
  );
}

function JobTable({ jobs, onEdit, onToggle }: { jobs: AdminJob[] | null; onEdit: (job: AdminJob) => void; onToggle: (job: AdminJob) => void }) {
  if (jobs === null) return <p className="text-sm text-foreground-600" role="status">Loading…</p>;
  if (jobs.length === 0) return <EmptyState icon="ri-briefcase-line" title="No job posts yet" description="Click New job post: title, description, full time or part time, salary and location. It appears on the website at once." />;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm" data-testid="jobs-table">
        <thead className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
          <tr><th className="px-4 py-3">Title</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Location</th><th className="px-4 py-3">Salary</th><th className="px-4 py-3">Applicants</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Posted</th><th className="px-4 py-3" /></tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-b border-background-100 last:border-0 hover:bg-background-100">
              <td className="px-4 py-3 font-medium"><button type="button" onClick={() => onEdit(job)} className="cursor-pointer text-left text-primary-700 hover:underline">{job.title}</button></td>
              <td className="px-4 py-3 text-foreground-700">{EMPLOYMENT_TYPE_LABEL[job.employmentType]}</td>
              <td className="px-4 py-3 text-foreground-700">{job.location}</td>
              <td className="px-4 py-3 text-foreground-700">{job.salary || "—"}</td>
              <td className="px-4 py-3 text-foreground-700"><Link to={`/admin/jobs?tab=applicants&job=${job.id}`} className="text-primary-700 hover:underline">{job.applied} applied</Link>{job.hired ? ` · ${job.hired} hired` : ""}{job.declined ? ` · ${job.declined} declined` : ""}</td>
              <td className="px-4 py-3"><Badge tone={job.status === "open" ? "success" : "muted"}>{job.status === "open" ? "Open" : "Closed"}</Badge></td>
              <td className="px-4 py-3 text-xs text-foreground-500">{new Date(job.postedAt).toLocaleDateString()}</td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end gap-2">
                  <a href={jobPath(job.id)} target="_blank" rel="noopener noreferrer" className="rounded-md border border-background-300 px-2.5 py-1 text-xs font-semibold text-foreground-700 hover:bg-background-100">View on site</a>
                  <Button size="sm" variant="outline" onClick={() => onEdit(job)}>Edit</Button>
                  <Button size="sm" variant="outline" onClick={() => onToggle(job)}>{job.status === "open" ? "Close" : "Reopen"}</Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Everyone who applied, newest first, filtered by job. HR-02i: "Send document link" (the old Hire) and "Reject" are the Employees
 *  actions (staff-admin), each confirmed; the job application follows (Hired / Declined). Resume and cover letter open via short links. */
function ApplicantsTable({ jobs }: { jobs: AdminJob[] }) {
  const [params, setParams] = useSearchParams();
  const job = params.get("job") ?? "";
  const [rows, setRows] = useState<JobApplicationRow[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<{ row: JobApplicationRow; action: "send" | "reject" } | null>(null);
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    adminListJobApplications(job || null).then((r) => { if (!cancelled) setRows(r); }, (e) => { if (!cancelled) { setRows([]); setError(e instanceof Error ? e.message : "The applicants could not be loaded."); } });
    return () => { cancelled = true; };
  }, [job, reload]);
  const open = async (path: string) => {
    try { window.open(await staffDocumentUrl(path, 120), "_blank", "noopener,noreferrer"); } catch (e) { setError(e instanceof Error ? e.message : "The file could not be opened."); }
  };
  const run = async () => {
    if (!confirm) return;
    if (confirm.action === "reject" && !note.trim()) { setDialogError("Add a note explaining the decision."); return; }
    setBusy(true); setDialogError(""); setNotice("");
    try {
      const result = confirm.action === "send" ? await staffAdminActions.sendLink(confirm.row.profileId, "documents") : await staffAdminActions.reject(confirm.row.profileId, note.trim(), notify);
      setNotice(confirm.action === "send" ? (result.link ? "Email is switched off: open the person under Employees to copy the link." : "The document link was emailed to " + confirm.row.email + ".") : "The application was rejected.");
      setConfirm(null); setReload((n) => n + 1);
    } catch (e) { setDialogError(e instanceof Error ? e.message : "That could not be done."); setReload((n) => n + 1); }
    finally { setBusy(false); }
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-72">
          <Select aria-label="Filter by job" value={job} onChange={(e) => setParams(e.target.value ? { tab: "applicants", job: e.target.value } : { tab: "applicants" })}>
            <option value="">All jobs</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}{j.status === "closed" ? " (closed)" : ""}</option>)}
          </Select>
        </div>
        {rows ? <p className="text-xs text-foreground-500" role="status">{rows.length} {rows.length === 1 ? "applicant" : "applicants"}</p> : null}
      </div>
      <Alert text={error} />
      {notice ? <p role="status" className="mb-4 rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900" data-testid="applicants-notice">{notice}</p> : null}
      {rows === null ? <p className="text-sm text-foreground-600" role="status">Loading…</p> : null}
      {rows && rows.length === 0 && !error ? <EmptyState icon="ri-user-received-line" title="No applicants yet" description="People who apply for a job post on the website appear here and under Staff > Employees > Applications." /> : null}
      {rows && rows.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm" data-testid="applicants-table">
            <thead className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
              <tr><th className="px-4 py-3">Applicant</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Mobile</th><th className="px-4 py-3">Job</th><th className="px-4 py-3">Applied</th><th className="px-4 py-3">Application</th><th className="px-4 py-3">Staff status</th><th className="px-4 py-3">Files</th><th className="px-4 py-3">Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-background-100 last:border-0 hover:bg-background-100">
                  <td className="px-4 py-3 font-medium"><Link to={staffEmployeePath(r.profileId)} className="text-primary-700 hover:underline">{r.name || r.email}</Link>{r.coverLetter ? <span className="block max-w-xs truncate text-xs font-normal text-foreground-500" title={r.coverLetter}>{r.coverLetter}</span> : null}</td>
                  <td className="px-4 py-3 text-foreground-700">{r.email}</td>
                  <td className="px-4 py-3 text-foreground-700">{r.phone}</td>
                  <td className="px-4 py-3 text-foreground-700">{r.jobTitle}</td>
                  <td className="px-4 py-3 text-xs text-foreground-500">{new Date(r.appliedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3"><Badge tone={r.status === "hired" ? "success" : r.status === "declined" ? "muted" : "warn"}>{JOB_APPLICATION_STATUS_LABEL[r.status]}</Badge></td>
                  <td className="px-4 py-3"><Badge tone={STAFF_STATUS_TONE[r.staffStatus]}>{STAFF_STATUS_LABEL[r.staffStatus]}</Badge></td>
                  <td className="px-4 py-3 text-xs">
                    {r.resume ? <button type="button" className="mr-2 cursor-pointer font-semibold text-primary-700 hover:underline" onClick={() => void open(r.resume!.storagePath)} data-testid={"applicant-resume-" + r.id}>Resume</button> : null}
                    {r.coverLetterFile ? <button type="button" className="cursor-pointer font-semibold text-primary-700 hover:underline" onClick={() => void open(r.coverLetterFile!.storagePath)}>Cover letter</button> : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-2">
                      {r.status === "applied" && r.staffStatus === "applied" ? <Button size="sm" onClick={() => { setConfirm({ row: r, action: "send" }); setDialogError(""); }} data-testid={"applicant-send-" + r.id}>Send document link</Button> : null}
                      {r.status !== "declined" && ["applied", "invited", "documents_submitted", "offer_sent", "offer_signed"].includes(r.staffStatus) ? <Button size="sm" variant="outline" onClick={() => { setConfirm({ row: r, action: "reject" }); setNote(""); setNotify(true); setDialogError(""); }} data-testid={"applicant-reject-" + r.id}>Reject</Button> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Modal open={confirm !== null} title={confirm ? (confirm.action === "send" ? "Send document link: " : "Reject: ") + (confirm.row.name || confirm.row.email) : ""} onClose={() => setConfirm(null)}
        footer={<><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button variant={confirm?.action === "reject" ? "danger" : "primary"} onClick={() => void run()} disabled={busy} data-testid="applicant-confirm">{busy ? "Working…" : confirm?.action === "send" ? "Send the link" : "Reject"}</Button></>}>
        {confirm ? (
          <div className="space-y-3" data-testid="applicant-dialog">
            <p className="text-sm text-foreground-700">{confirm.action === "send"
              ? "Emails " + confirm.row.email + " a private link (valid 14 days) to add personal details and documents. The application moves to Invited and the job application to Hired."
              : "Ends this person's application (every job they applied for is declined). The note is for the record."}</p>
            {confirm.action === "reject" ? (
              <>
                <Field label="Note (required)"><TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="applicant-note" /></Field>
                <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground-800">
                  <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 h-4 w-4" />
                  <span>Email them that we are not continuing (a short message without your note).</span>
                </label>
              </>
            ) : null}
            {dialogError ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/** Three steps: the role (title, type, location, salary), the description, then a review with Post / Save. */
function JobWizard({ id, initial, onClose, onSaved }: { id: string | null; initial: JobForm; onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<JobForm>(initial);
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (next: Partial<JobForm>) => setForm((f) => ({ ...f, ...next }));

  const next = () => {
    const found = jobProblems(form);
    const own: Array<keyof JobForm> = step === 0 ? ["title", "employmentType", "location", "salary", "status"] : ["description"];
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
    try { await adminSaveJob(id, form); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "The job could not be saved."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open title={id ? "Edit job post" : "New job post"} onClose={onClose}
      footer={<>
        <Button variant="outline" onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}>{step === 0 ? "Cancel" : "Back"}</Button>
        {step < STEPS.length - 1
          ? <Button onClick={next} data-testid="job-next">Next</Button>
          : <Button onClick={() => void save()} disabled={busy} data-testid="job-save">{busy ? "Saving…" : id ? "Save changes" : form.status === "open" ? "Post job" : "Save as closed"}</Button>}
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
            <F label="Salary" problem={problems.salary} hint="As shown on the website, e.g. $75,000 – $85,000 + super."><TextInput value={form.salary} onChange={(e) => patch({ salary: e.target.value })} maxLength={120} data-testid="job-salary" /></F>
            <F label="Status" problem={problems.status}>
              <Select value={form.status} onChange={(e) => patch({ status: e.target.value as JobForm["status"] })}><option value="open">Open (shown on the website)</option><option value="closed">Closed</option></Select>
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
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Status</dt><dd>{form.status === "open" ? "Open: shown on the website" : "Closed: not shown"}</dd></div>
          </dl>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Description</p><p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-line rounded-md border border-background-200 p-3 text-sm text-foreground-800">{form.description}</p></div>
          <Alert text={error} />
        </div>
      ) : null}
    </Modal>
  );
}
