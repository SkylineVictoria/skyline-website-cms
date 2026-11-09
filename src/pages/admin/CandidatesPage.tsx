import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { HrFields, HrHistory, HrLink, HrNotice, HrPager, HrValue } from "@/pages/admin/components/Recruitment";
import { adminListJobs, type AdminJob } from "@/lib/jobsApi";
import { JOB_APPLICATION_STATUS_LABEL, JOB_FILE_ACCEPT } from "@/lib/jobs";
import { HR_PAGE_SIZE, hrName, hrDate, emptyPerson, getCandidate, listCandidates, progressCandidate, saveCandidate, stages, uploadCandidateFile, type Candidate, type CandidateAction, type CandidateRow, type Page } from "@/lib/recruitmentApi";
import { staffDocumentUrl } from "@/lib/staffApi";

const states = { ...stages, hired: "Hired", declined: "Rejected", withdrawn: "Withdrawn" };
const actionLabels = { screening: "Return to screening", shortlisted: "Shortlist", interview: "Schedule or record interview", selected: "Mark selected", hired: "Hire candidate", declined: "Reject", withdrawn: "Record withdrawal" };
const candidateLabel = (row: CandidateRow) => row.status === "applied" ? stages[row.stage] : JOB_APPLICATION_STATUS_LABEL[row.status];

function CandidateBadge({ row }: { row: CandidateRow }) {
  return <Badge tone={row.status === "hired" ? "success" : row.status === "applied" ? "warn" : "muted"}>{candidateLabel(row)}</Badge>;
}

export default function CandidatesPage() {
  const [params, setParams] = useSearchParams();
  const job = params.get("job") ?? "";
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
    void adminListJobs().then((data) => { if (current) setJobs(data); }, (e: Error) => { if (current) setJobsError(e.message); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      setResult(null); setError("");
      void listCandidates(job, state, search, HR_PAGE_SIZE, offset).then(
        (data) => { if (current) setResult(data); }, (e: Error) => { if (current) setError(e.message); },
      );
    }, 150);
    return () => { current = false; window.clearTimeout(timer); };
  }, [job, state, search, offset]);

  return <div>
    <PageHeader breadcrumb="Master Data" title="Candidates" description="Review Careers and manually entered applications in one recruitment pipeline."
      actions={<Button disabled={!jobs.length} onClick={() => setAdding(true)} icon="ri-add-line">Add Candidate</Button>} />
    <div className="mb-4 grid gap-2 sm:grid-cols-3">
      <TextInput aria-label="Search candidates" placeholder="Search name, email, phone or ID" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
      <Select aria-label="Filter by job" value={job} onChange={(e) => { setParams(e.target.value ? { job: e.target.value } : {}); setOffset(0); }}>
        <option value="">All jobs</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
      </Select>
      <Select aria-label="Filter by recruitment status" value={state} onChange={(e) => { setState(e.target.value); setOffset(0); }}>
        <option value="">All recruitment statuses</option>{Object.entries(states).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
    </div>
    <HrNotice error>{error || jobsError}</HrNotice>
    {!result && !error ? <p role="status">Loading candidates…</p> : null}
    {result && !result.rows.length ? <EmptyState icon="ri-user-search-line" title="No matching candidates" description="Adjust the filters or create a job and add a candidate." /> : null}
    {result?.rows.length ? <Card className="data-table-frame">
      <table className="data-table w-full text-left text-sm">
        <thead className="border-b border-background-200 text-xs uppercase text-foreground-500"><tr>
          {["Candidate", "Applied job", "Application date", "Source", "Status"].map((label) => <th key={label} className="px-4 py-3">{label}</th>)}
        </tr></thead>
        <tbody>{result.rows.map((row) => <tr key={row.id} className="border-b border-background-100 last:border-0">
          <td data-label="Candidate" className="px-4 py-3"><HrLink to={`/admin/candidates/${row.id}`}>{hrName(row)}</HrLink><div className="text-xs text-foreground-500">{row.email}</div></td>
          <td data-label="Applied job" className="px-4 py-3">{row.jobTitle}</td><td data-label="Application date" className="px-4 py-3">{hrDate(row.appliedAt)}</td>
          <td data-label="Source" className="px-4 py-3">{row.source === "manual" ? "Manual" : "Careers"}</td><td data-label="Status" className="px-4 py-3"><CandidateBadge row={row} /></td>
        </tr>)}</tbody>
      </table>
    </Card> : null}
    {result ? <HrPager total={result.total} offset={offset} onChange={setOffset} /> : null}
    {adding ? <CandidateForm jobs={jobs} job={job} onClose={() => setAdding(false)} onSaved={(id) => navigate(`/admin/candidates/${id}`, { state: { message: "Candidate added." } })} /> : null}
  </div>;
}

function CandidateForm({ row, jobs, job, onClose, onSaved }: { row?: Candidate; jobs: AdminJob[]; job: string; onClose: () => void; onSaved: (id: string) => void }) {
  const [person, setPerson] = useState(row ?? emptyPerson);
  const [jobId, setJobId] = useState(row?.jobId ?? job);
  const [letter, setLetter] = useState(row?.coverLetter ?? "");
  const [notes, setNotes] = useState(row?.recruiterNotes ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try { onSaved(await saveCandidate(row?.id ?? null, jobId, person, letter, notes)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <Modal open title={row ? "Edit candidate" : "Add candidate"} width="max-w-2xl" onClose={() => { if (!busy) onClose(); }}
    footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" form="candidate-form" disabled={busy}>{busy ? "Saving…" : "Save candidate"}</Button></>}>
    <form id="candidate-form" className="space-y-4" onSubmit={(e) => void submit(e)}>
      <HrNotice error>{error}</HrNotice>
      <HrFields value={person} onChange={setPerson} linked={row?.linkedAccount} />
      <Field label="Applied job" required><Select required value={jobId} disabled={Boolean(row && (row.source !== "manual" || row.status !== "applied" || row.stage !== "screening" || !jobs.length))} onChange={(e) => setJobId(e.target.value)}>
        <option value="">Choose a job</option>
        {row && !jobs.some((j) => j.id === row.jobId) ? <option value={row.jobId}>{row.jobTitle}</option> : null}
        {jobs.map((j) => <option value={j.id} key={j.id}>{j.title}</option>)}
      </Select></Field>
      {row?.source !== "careers" ? <Field label="Cover letter"><TextArea maxLength={5000} value={letter} onChange={(e) => setLetter(e.target.value)} /></Field> : null}
      <Field label="Recruiter notes"><TextArea maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
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
  async function openFile(path: string) {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const url = await staffDocumentUrl(path, 120);
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    } catch (e) { tab?.close(); setError((e as Error).message); }
  }
  async function upload(category: "Resume" | "Cover Letter", file: File) {
    setUploading(true); setError(""); setNotice("");
    try { await uploadCandidateFile(id, category, file); await reload(`${category} uploaded.`); }
    catch (e) { setError((e as Error).message); }
    finally { setUploading(false); }
  }

  if (!row) return <><HrLink to="/admin/candidates">All candidates</HrLink><HrNotice error>{error}</HrNotice>{!error ? <p role="status">Loading candidate…</p> : null}</>;
  const pending = row.status === "applied";
  const actions: CandidateAction[] = ["screening", "shortlisted", "interview"];
  if (row.stage === "interview" || row.stage === "selected") actions.push("selected");
  if (row.stage === "selected") actions.push("hired");
  actions.push("declined", "withdrawn");
  return <div>
    <PageHeader breadcrumb="Master Data / Candidates" title={hrName(row)} description={row.jobTitle}
      actions={<><CandidateBadge row={row} /><Button onClick={() => {
        setEditing(true);
        void adminListJobs().then(setJobs, (e: Error) => setError(e.message));
      }}>Edit Candidate</Button></>} />
    <div className="mb-4 flex flex-wrap gap-4 text-sm"><HrLink to={`/admin/candidates?job=${row.jobId}`}>All candidates for this job</HrLink>
      {row.employeeId ? <HrLink to={`/admin/employees/${row.employeeId}`}>View employee record</HrLink> : null}</div>
    <HrNotice error>{error}</HrNotice><HrNotice>{notice}</HrNotice>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4"><h2 className="mb-3 font-semibold">Application details</h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <HrValue label="Candidate ID">{row.profileId}</HrValue><HrValue label="Application ID">{row.id}</HrValue>
          <HrValue label="Email">{row.email}</HrValue><HrValue label="Phone">{row.phone}</HrValue>
          <HrValue label="Applied job">{row.jobTitle}</HrValue><HrValue label="Application date">{hrDate(row.appliedAt)}</HrValue>
          <HrValue label="Source">{row.source === "manual" ? "Manual" : "Careers"}</HrValue>
          <HrValue label="Decision">{row.decidedAt ? `${candidateLabel(row)} · ${hrDate(row.decidedAt)}` : "Pending"}</HrValue>
          {row.decisionNote ? <HrValue label="Decision reason">{row.decisionNote}</HrValue> : null}
        </dl>
      </Card>
      <Card className="p-4"><h2 className="mb-3 font-semibold">Recruitment</h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <HrValue label="Stage">{stages[row.stage]}</HrValue><HrValue label="Interview date and time">{hrDate(row.interviewAt)}</HrValue>
          <HrValue label="Interview notes">{row.interviewNotes}</HrValue><HrValue label="Recruiter notes">{row.recruiterNotes}</HrValue>
        </dl>
        {pending ? <div className="mt-4 flex flex-wrap gap-2">{actions.filter((a) => a !== row.stage || a === "interview").map((a) =>
          <Button key={a} size="sm" variant={a === "hired" ? "primary" : "outline"} disabled={uploading} onClick={() => setAction(a)}>{actionLabels[a]}</Button>)}</div> : null}
      </Card>
      <Card className="p-4"><h2 className="mb-3 font-semibold">Documents</h2>
        <div className="space-y-3">{(["Resume", "Cover Letter"] as const).map((category) => {
          const file = category === "Resume" ? row.resume : row.coverLetterDocument;
          return <div key={category}>
            {file ? <Button size="sm" variant="outline" onClick={() => void openFile(file.storagePath)}>View {category.toLowerCase()} · {file.filename}</Button> : <p className="text-sm text-foreground-600">{category} pending upload</p>}
            {pending && (row.source === "manual" || !file) ? <Field label={`Upload ${category.toLowerCase()}`}>
              <input className="block w-full text-sm" type="file" accept={JOB_FILE_ACCEPT} disabled={uploading} onChange={(e) => {
                const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void upload(category, file);
              }} />
            </Field> : null}
          </div>;
        })}
        {uploading ? <p role="status">Uploading document…</p> : null}
        {row.coverLetter ? <dl><HrValue label="Cover letter text">{row.coverLetter}</HrValue></dl> : null}</div>
      </Card>
      <Card className="p-4"><h2 className="mb-3 font-semibold">Application history</h2><HrHistory events={row.history} /></Card>
    </div>
    {editing ? <CandidateForm row={row} jobs={jobs} job={row.jobId} onClose={() => setEditing(false)} onSaved={() => {
      setEditing(false); void reload("Candidate updated.").catch((e: Error) => setError(e.message));
    }} /> : null}
    {action ? <CandidateDecision key={action} row={row} action={action} onClose={() => setAction(null)} onSaved={async (employeeId) => {
      setAction(null);
      if (action === "hired") navigate(`/admin/employees/${employeeId}`, { state: { message: "Candidate hired. You can now invite them to onboard." } });
      else await reload("Recruitment status updated.").catch((e: Error) => setError(e.message));
    }} /> : null}
    <Link to="/admin/candidates" className="mt-5 inline-block text-sm font-medium text-primary-700 hover:underline">Back to Candidates</Link>
  </div>;
}

function localDateTime(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function CandidateDecision({ row, action, onClose, onSaved }: { row: Candidate; action: CandidateAction; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [interview, setInterview] = useState(localDateTime(row.interviewAt));
  const [notes, setNotes] = useState(row.interviewNotes);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const terminal = action === "hired" || action === "declined" || action === "withdrawn";
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try { await onSaved(await progressCandidate(row.id, action, interview ? new Date(interview).toISOString() : "", notes, reason)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal open title={actionLabels[action]} onClose={() => { if (!busy) onClose(); }} footer={<>
    <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
    <Button form="candidate-action" type="submit" disabled={busy}>{busy ? "Saving…" : "Confirm"}</Button>
  </>}>
    <form className="space-y-3" id="candidate-action" onSubmit={(e) => void submit(e)}>
      <HrNotice error>{error}</HrNotice>
      <p className="text-sm">{hrName(row)} · {row.jobTitle}</p>
      {action === "hired" ? <p className="text-sm">Hiring creates or updates the employee record. Account activation is a separate step.</p> : null}
      {action === "interview" ? <Field label="Interview date and time" required>
        <TextInput required type="datetime-local" value={interview} onChange={(e) => setInterview(e.target.value)} />
      </Field> : null}
      {action === "interview" || action === "selected" ? <Field label="Interview notes"><TextArea maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field> : null}
      {terminal ? <Field label={action === "hired" ? "Decision note" : "Reason"} required={action !== "hired"} hint="Visible to the applicant.">
        <TextArea required={action !== "hired"} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field> : null}
    </form>
  </Modal>;
}
