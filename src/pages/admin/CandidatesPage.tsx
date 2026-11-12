import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, SectionTabs, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import RecruitmentTree from "@/pages/admin/components/RecruitmentTree";
import { HrFields, HrHistory, HrLink, HrNotice, HrPager, HrValue } from "@/pages/admin/components/Recruitment";
import { adminListJobs, type AdminJob } from "@/lib/jobsApi";
import { JOB_APPLICATION_STATUS_LABEL, JOB_FILE_ACCEPT, jobFileProblem } from "@/lib/jobs";
import {
  HR_PAGE_SIZE, hrName, hrDate, emptyPerson, getCandidate, hireCandidate, listCandidates, listCandidatesByJob, progressCandidate, saveCandidate, stages, uploadCandidateFile,
  type Candidate, type CandidateAction, type CandidateRow, type Page,
} from "@/lib/recruitmentApi";
import { StaffAdminError, staffDocumentUrl, type StaffAdminResult } from "@/lib/staffApi";
import { STAFF_STATUS_LABEL } from "@/lib/staffStatus";
import { isEmailTakenError } from "@/lib/identity/email";
import { STAFF_CANDIDATES_PATH, staffCandidatePath, staffEmployeePath } from "@/pages/admin/lib/staffRoutes";

/**
 * Staff > Candidates (HR-02j): every job application (Careers or entered by hand) in one pipeline. Stages: screening > shortlisted >
 * interview (date and notes) > selected. From selected: "Hire and send document link" marks the application hired, creates the
 * employment record from the job and emails HR-02's document link (the person's onboarding then runs on Staff > Employees). Declined /
 * withdrawn need a reason; for a person who is still just Applied they close the staff application too (HR-02's reject, email optional).
 * A manual candidate's resume and cover letter go through staff-admin (content checks, private bucket); Careers files are kept as sent.
 */

const states = { ...stages, hired: "Hired", declined: "Declined", withdrawn: "Withdrawn" };
const actionLabels: Record<CandidateAction, string> = {
  screening: "Return to screening", shortlisted: "Shortlist", interview: "Schedule or record interview", selected: "Mark selected",
  hired: "Hire and send document link", declined: "Decline", withdrawn: "Record withdrawal",
};
const candidateLabel = (row: CandidateRow) => row.status === "applied" ? stages[row.stage] : JOB_APPLICATION_STATUS_LABEL[row.status];

function CandidateBadge({ row }: { row: CandidateRow }) {
  return <span data-testid="candidate-status"><Badge tone={row.status === "hired" ? "success" : row.status === "applied" ? "warn" : "muted"}>{candidateLabel(row)}</Badge></span>;
}

export default function CandidatesPage() {
  const [params, setParams] = useSearchParams();
  const job = params.get("job") ?? "";
  const treeView = params.get("view") === "tree";
  const [byJob, setByJob] = useState<Map<string, CandidateRow[]> | null>(null);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [jobsError, setJobsError] = useState("");
  const [state, setState] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<Page<CandidateRow> | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let current = true;
    void adminListJobs().then((data) => { if (current) { setJobs(data); setJobsLoaded(true); } }, (e: Error) => { if (current) setJobsError(e.message); });
    return () => { current = false; };
  }, []);

  // Tree view: the candidates of each job (or of the chosen job), with the same status and search filters as the list.
  const treeJobs = job ? jobs.filter((j) => j.id === job) : jobs;
  useEffect(() => {
    if (!treeView || !jobsLoaded) return;
    let current = true;
    const timer = window.setTimeout(() => {
      setByJob(null); setError("");
      void listCandidatesByJob(job ? [job] : jobs.map((j) => j.id), state, search).then(
        (m) => { if (current) setByJob(m); }, (e: Error) => { if (current) setError(e.message); },
      );
    }, 150);
    return () => { current = false; window.clearTimeout(timer); };
  }, [treeView, jobsLoaded, jobs, job, state, search]);
  const setView = (view: string) => setParams(() => { const next = new URLSearchParams(params); if (view === "tree") next.set("view", "tree"); else next.delete("view"); return next; });

  useEffect(() => {
    if (treeView) return;
    let current = true;
    const timer = window.setTimeout(() => {
      setResult(null); setError("");
      void listCandidates(job, state, search, HR_PAGE_SIZE, offset).then(
        (data) => { if (current) setResult(data); }, (e: Error) => { if (current) setError(e.message); },
      );
    }, 150);
    return () => { current = false; window.clearTimeout(timer); };
  }, [treeView, job, state, search, offset]);

  return <div>
    <PageHeader breadcrumb="Website" title="Candidates" description="Careers applications and candidates entered by hand, in one pipeline: screening, shortlist, interview, selected, then hire (the document link) or decline."
      actions={<Button disabled={!jobs.length} onClick={() => setAdding(true)} icon="ri-add-line" data-testid="candidate-add">Add candidate</Button>} />
    <SectionTabs tabs={[{ id: "list", label: "List", icon: "ri-list-check" }, { id: "tree", label: "Tree", icon: "ri-node-tree" }]} active={treeView ? "tree" : "list"} onChange={setView} />
    <div className="mb-4 grid gap-2 sm:grid-cols-3">
      <TextInput aria-label="Search candidates" placeholder="Search name, email, phone or ID" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
      <Select aria-label="Filter by job" value={job} onChange={(e) => { setParams({ ...(e.target.value ? { job: e.target.value } : {}), ...(treeView ? { view: "tree" } : {}) }); setOffset(0); }}>
        <option value="">All jobs</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
      </Select>
      <Select aria-label="Filter by recruitment status" value={state} onChange={(e) => { setState(e.target.value); setOffset(0); }}>
        <option value="">All recruitment statuses</option>{Object.entries(states).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
    </div>
    <HrNotice error>{error || jobsError}</HrNotice>
    {treeView && !byJob && !error && !jobsError ? <p role="status">Loading candidates…</p> : null}
    {treeView && byJob ? <RecruitmentTree byJob={byJob}
      // With a status or search filter only the jobs that have matching candidates are shown.
      jobs={state || search.trim() ? treeJobs.filter((j) => byJob.get(j.id)?.length) : treeJobs}
      emptyText={{ title: "No matching candidates", description: "Careers applications appear here as people apply; or add a candidate by hand." }} /> : null}
    {!treeView && !result && !error ? <p role="status">Loading candidates…</p> : null}
    {!treeView && result && !result.rows.length ? <EmptyState icon="ri-user-search-line" title="No matching candidates" description="Careers applications appear here as people apply; or add a candidate by hand." /> : null}
    {!treeView && result?.rows.length ? <Card className="data-table-frame">
      <table className="data-table w-full text-left text-sm" data-testid="candidates-table">
        <thead className="border-b border-background-200 text-xs uppercase text-foreground-500"><tr>
          {["Candidate", "Applied job", "Application date", "Source", "Status"].map((label) => <th key={label} className="px-4 py-3">{label}</th>)}
        </tr></thead>
        <tbody>{result.rows.map((row) => <tr key={row.id} className="border-b border-background-100 last:border-0" data-testid={`candidate-row-${row.id}`}>
          <td data-label="Candidate" className="px-4 py-3"><HrLink to={staffCandidatePath(row.id)}>{hrName(row)}</HrLink><div className="text-xs text-foreground-500">{row.email}</div></td>
          <td data-label="Applied job" className="px-4 py-3">{row.jobTitle}</td><td data-label="Application date" className="px-4 py-3">{hrDate(row.appliedAt)}</td>
          <td data-label="Source" className="px-4 py-3">{row.source === "manual" ? "Manual" : "Careers"}</td><td data-label="Status" className="px-4 py-3"><CandidateBadge row={row} /></td>
        </tr>)}</tbody>
      </table>
    </Card> : null}
    {!treeView && result ? <HrPager total={result.total} offset={offset} onChange={setOffset} /> : null}
    {adding ? <CandidateForm jobs={jobs} job={job} onClose={() => setAdding(false)} onSaved={(id) => navigate(staffCandidatePath(id), { state: { message: "Candidate added. Upload their resume below, then move them through the stages." } })} /> : null}
  </div>;
}

function CandidateForm({ row, jobs, job, onClose, onSaved }: { row?: Candidate; jobs: AdminJob[]; job: string; onClose: () => void; onSaved: (id: string) => void }) {
  const [person, setPerson] = useState(row ?? emptyPerson);
  const [jobId, setJobId] = useState(row?.jobId ?? job);
  const [letter, setLetter] = useState(row?.coverLetter ?? "");
  const [notes, setNotes] = useState(row?.recruiterNotes ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<unknown>(null);
  const [emailBlocking, setEmailBlocking] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || emailBlocking) return;
    setBusy(true); setError(""); setEmailError(null);
    try { onSaved(await saveCandidate(row?.id ?? null, jobId, person, letter, notes)); }
    catch (e) {
      // An email already used by another staff profile is shown on the email field, not in the notice.
      if (isEmailTakenError(e)) setEmailError(e);
      else setError((e as Error).message);
    }
    finally { setBusy(false); }
  }

  return <Modal open title={row ? "Edit candidate" : "Add candidate"} width="max-w-2xl" onClose={() => { if (!busy) onClose(); }}
    footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" form="candidate-form" disabled={busy || emailBlocking} data-testid="candidate-save">{busy ? "Saving…" : "Save candidate"}</Button></>}>
    <form id="candidate-form" className="space-y-4" onSubmit={(e) => void submit(e)} data-testid="candidate-form">
      <HrNotice error>{error}</HrNotice>
      {!row ? <p className="text-sm text-foreground-700">A record is created for the person (no login until they are activated). Hiring later sends them the document link.</p> : null}
      <HrFields value={person} onChange={setPerson} linked={row?.linkedAccount} profileId={row?.profileId ?? null} savedEmail={row?.email ?? null}
        emailError={emailError} onEmailBlocking={setEmailBlocking} />
      <Field label="Applied job" required><Select required value={jobId} disabled={Boolean(row && (row.source !== "manual" || row.status !== "applied" || row.stage !== "screening" || !jobs.length))} onChange={(e) => setJobId(e.target.value)} data-testid="candidate-job">
        <option value="">Choose a job</option>
        {row && !jobs.some((j) => j.id === row.jobId) ? <option value={row.jobId}>{row.jobTitle}</option> : null}
        {jobs.map((j) => <option value={j.id} key={j.id}>{j.title}</option>)}
      </Select></Field>
      {row?.source !== "careers" ? <Field label="Cover letter"><TextArea maxLength={5000} value={letter} onChange={(e) => setLetter(e.target.value)} /></Field> : null}
      <Field label="Recruiter notes"><TextArea maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="candidate-recruiter-notes" /></Field>
    </form>
  </Modal>;
}

export function CandidateDetailPage() {
  const { id = "" } = useParams();
  const [row, setRow] = useState<Candidate | null>(null);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [error, setError] = useState("");
  const { state } = useLocation();
  const [notice, setNotice] = useState<string>(state?.message ?? "");
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<CandidateAction | null>(null);
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let current = true;
    setRow(null); setError("");
    void getCandidate(id).then((data) => { if (current) setRow(data); }, (e: Error) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [id]);

  async function reload(message: string) {
    setRow(await getCandidate(id));
    setError(""); setNotice(message);
  }
  // Files open through short-lived signed URLs; the window is opened first so the browser does not block it.
  async function openFile(path: string) {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const url = await staffDocumentUrl(path, 120);
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    } catch (e) { tab?.close(); setError((e as Error).message); }
  }
  async function upload(which: "resume" | "cover_letter", file: File) {
    const problem = jobFileProblem(file);
    if (problem) { setError(problem); return; }
    setUploading(true); setError(""); setNotice("");
    try { await uploadCandidateFile(id, which, file); await reload(`${which === "resume" ? "Resume" : "Cover letter"} uploaded.`); }
    catch (e) { setError((e as Error).message); }
    finally { setUploading(false); }
  }

  if (!row) return <><HrLink to={STAFF_CANDIDATES_PATH}>All candidates</HrLink><HrNotice error>{error}</HrNotice>{!error ? <p role="status">Loading candidate…</p> : null}</>;
  const pending = row.status === "applied";
  const actions: CandidateAction[] = ["screening", "shortlisted", "interview"];
  if (row.stage === "interview" || row.stage === "selected") actions.push("selected");
  if (row.stage === "selected") actions.push("hired");
  actions.push("declined", "withdrawn");
  return <div>
    <PageHeader breadcrumb="Website / Candidates" title={hrName(row)} description={row.jobTitle}
      actions={<><CandidateBadge row={row} /><Button variant="outline" onClick={() => {
        setEditing(true);
        void adminListJobs().then(setJobs, (e: Error) => setError(e.message));
      }}>Edit candidate</Button></>} />
    <div className="mb-4 flex flex-wrap gap-4 text-sm"><HrLink to={`${STAFF_CANDIDATES_PATH}?job=${row.jobId}`}>All candidates for this job</HrLink>
      <HrLink to={staffEmployeePath(row.profileId)}>{row.employeeId ? "View employee record" : "View staff record"}</HrLink></div>
    <HrNotice error>{error}</HrNotice><HrNotice>{notice}</HrNotice>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4"><h2 className="mb-3 font-semibold">Application details</h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <HrValue label="Email">{row.email}</HrValue><HrValue label="Phone">{row.phone}</HrValue>
          <HrValue label="Applied job">{row.jobTitle}{row.jobStatus !== "open" ? ` (${row.jobStatus})` : ""}</HrValue><HrValue label="Application date">{hrDate(row.appliedAt)}</HrValue>
          <HrValue label="Source">{row.source === "manual" ? "Manual" : "Careers"}</HrValue>
          <HrValue label="Staff record">{STAFF_STATUS_LABEL[row.staffStatus]}{row.linkedAccount ? " · has a login" : ""}</HrValue>
          <HrValue label="Decision">{row.decidedAt ? `${candidateLabel(row)} · ${hrDate(row.decidedAt)}` : "Pending"}</HrValue>
          {row.decisionNote ? <HrValue label="Decision reason">{row.decisionNote}</HrValue> : null}
        </dl>
      </Card>
      <Card className="p-4"><h2 className="mb-3 font-semibold">Recruitment</h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <HrValue label="Stage">{stages[row.stage]}</HrValue><HrValue label="Interview date and time">{hrDate(row.interviewAt)}</HrValue>
          <HrValue label="Interview notes">{row.interviewNotes}</HrValue><HrValue label="Recruiter notes">{row.recruiterNotes}</HrValue>
        </dl>
        {pending ? <div className="mt-4 flex flex-wrap gap-2" data-testid="candidate-actions">{actions.filter((a) => a !== row.stage || a === "interview").map((a) =>
          <Button key={a} size="sm" variant={a === "hired" ? "primary" : "outline"} disabled={uploading} onClick={() => setAction(a)} data-testid={`candidate-action-${a}`}>{actionLabels[a]}</Button>)}</div>
          : row.status === "hired" ? <p className="mt-4 text-sm text-foreground-700">Hired: their onboarding (documents, offer, activation) continues on <HrLink to={staffEmployeePath(row.profileId)}>their staff record</HrLink>.</p> : null}
      </Card>
      <Card className="p-4"><h2 className="mb-3 font-semibold">Documents</h2>
        <div className="space-y-3">{([["resume", "Resume", row.resume], ["cover_letter", "Cover letter", row.coverLetterFile]] as const).map(([which, label, file]) => <div key={which}>
          {file && !row.filesPurged ? <Button size="sm" variant="outline" onClick={() => void openFile(file.storagePath)} data-testid={`candidate-view-${which}`}>View {label.toLowerCase()} · {file.filename}</Button>
            : <p className="text-sm text-foreground-600">{row.filesPurged ? `${label} removed (retention)` : `No ${label.toLowerCase()} yet`}</p>}
          {pending && row.source === "manual" ? <Field label={`Upload ${label.toLowerCase()} (PDF or Word .docx, 5 MB)`}>
            <input className="block w-full text-sm" type="file" accept={JOB_FILE_ACCEPT} disabled={uploading} data-testid={`candidate-upload-${which}`} onChange={(e) => {
              const picked = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (picked) void upload(which, picked);
            }} />
          </Field> : null}
        </div>)}
        {row.source === "careers" ? <p className="text-xs text-foreground-500">Files sent through Careers are kept as submitted.</p> : null}
        {uploading ? <p role="status">Uploading document…</p> : null}
        {row.coverLetter ? <dl><HrValue label="Cover letter text">{row.coverLetter}</HrValue></dl> : null}</div>
      </Card>
      <Card className="p-4"><h2 className="mb-3 font-semibold">Application history</h2><HrHistory events={row.history} /></Card>
    </div>
    {editing ? <CandidateForm row={row} jobs={jobs} job={row.jobId} onClose={() => setEditing(false)} onSaved={() => {
      setEditing(false); void reload("Candidate updated.").catch((e: Error) => setError(e.message));
    }} /> : null}
    {action ? <CandidateDecision key={action} row={row} action={action} onClose={() => setAction(null)} onDone={async (result) => {
      setAction(null);
      if (action === "hired") navigate(staffEmployeePath(result?.profileId ?? row.profileId), { state: { message: result?.link ? "Hired. Email is switched off: the document link was shown once to pass on." : "Hired. The document link was emailed; their onboarding continues here." } });
      else await reload(action === "declined" || action === "withdrawn" ? "The application was closed." : "Recruitment status updated.").catch((e: Error) => setError(e.message));
    }} /> : null}
    <Link to={STAFF_CANDIDATES_PATH} className="mt-5 inline-block text-sm font-medium text-primary-700 hover:underline">Back to Candidates</Link>
  </div>;
}

function localDateTime(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** One recruitment action with its confirmation. Hire shows the link ONCE when email sending is off; it is never stored. */
function CandidateDecision({ row, action, onClose, onDone }: { row: Candidate; action: CandidateAction; onClose: () => void; onDone: (result: StaffAdminResult | null) => Promise<void> }) {
  const [interview, setInterview] = useState(localDateTime(row.interviewAt));
  const [notes, setNotes] = useState(row.interviewNotes);
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(action === "declined");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shownLink, setShownLink] = useState<StaffAdminResult | null>(null);
  const closing = action === "declined" || action === "withdrawn";
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (closing && !reason.trim()) { setError("Record a reason for this decision."); return; }
    setBusy(true); setError("");
    try {
      if (action === "hired") {
        const result = await hireCandidate(row.id);
        if (result.link) { setShownLink(result); return; }
        await onDone(result);
      } else {
        await progressCandidate(row.id, action, interview ? new Date(interview).toISOString() : "", notes, reason.trim(), notify);
        await onDone(null);
      }
    } catch (e) {
      setError(e instanceof StaffAdminError || e instanceof Error ? e.message : "That could not be done.");
    } finally { setBusy(false); }
  }
  if (shownLink) {
    return <Modal open title="Email is switched off: pass this link on" onClose={() => void onDone(shownLink)} footer={<Button onClick={() => void onDone(shownLink)} data-testid="candidate-link-done">I have copied it</Button>}>
      <div className="space-y-3" data-testid="candidate-shown-link">
        <p className="text-sm text-foreground-700">{hrName(row)} is hired. This private document link is shown only now and is not stored. Send it to {row.email} yourself{shownLink.expiresAt ? `; it works until ${new Date(shownLink.expiresAt).toLocaleDateString()}` : ""}.</p>
        <TextInput readOnly value={shownLink.link ?? ""} onFocus={(e) => e.currentTarget.select()} />
      </div>
    </Modal>;
  }
  return <Modal open title={actionLabels[action]} onClose={() => { if (!busy) onClose(); }} footer={<>
    <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
    <Button form="candidate-action" type="submit" disabled={busy} variant={closing ? "danger" : "primary"} data-testid="candidate-confirm">{busy ? "Working…" : actionLabels[action]}</Button>
  </>}>
    <form className="space-y-3" id="candidate-action" onSubmit={(e) => void submit(e)} data-testid="candidate-dialog">
      <HrNotice error>{error}</HrNotice>
      <p className="text-sm">{hrName(row)} · {row.jobTitle}</p>
      {action === "hired" ? <p className="text-sm text-foreground-700">Marks this application hired, creates the employment record from the job (department, title, type, location) and emails them a private link (valid 14 days) to add their details and documents. Their onboarding then continues on Staff &gt; Employees; the joining date is set at activation.</p> : null}
      {closing ? <p className="text-sm text-foreground-700">{row.staffStatus === "applied" ? "This is their only open application, so their staff application closes too (they can apply again later)." : "Only this job application closes; their staff record is not changed."}</p> : null}
      {action === "interview" ? <Field label="Interview date and time" required>
        <TextInput required type="datetime-local" value={interview} onChange={(e) => setInterview(e.target.value)} data-testid="candidate-interview-at" />
      </Field> : null}
      {action === "interview" || action === "selected" ? <Field label="Interview notes"><TextArea maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="candidate-interview-notes" /></Field> : null}
      {closing ? <>
        <Field label="Reason" required hint="For the record; it is not sent to the person.">
          <TextArea required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="candidate-reason" />
        </Field>
        {row.staffStatus === "applied" ? <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground-800">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 h-4 w-4" data-testid="candidate-notify" />
          <span>Email them that we are not continuing with the application (a short, polite message without your reason).</span>
        </label> : null}
      </> : null}
    </form>
  </Modal>;
}
