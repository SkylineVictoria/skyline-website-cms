import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { HrFields, HrHistory, HrLink, HrNotice, HrPager, HrValue } from "@/pages/admin/components/Recruitment";
import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABEL } from "@/lib/jobs";
import { HR_PAGE_SIZE, hrName, emptyPerson, getEmployee, inviteEmployee, listEmployees, saveEmployee, type Employee, type EmployeeDetail, type EmploymentForm, type Page } from "@/lib/recruitmentApi";
import { adminDecideStaff } from "@/lib/staffApi";
import { STAFF_STATUS_LABEL, STAFF_STATUS_TONE } from "@/lib/staffStatus";

const employmentStates = { onboarding: "Onboarding", active: "Active", inactive: "Inactive", rejected: "Onboarding declined" } as const;
const emptyEmployment: EmploymentForm = { department: "", jobTitle: "", employmentType: "", joiningDate: "", managerId: "", workLocation: "" };
const employmentLabel = (status: Employee["status"]) => status === "active" || status === "inactive" || status === "rejected"
  ? employmentStates[status] : employmentStates.onboarding;

function EmployeeBadge({ status }: { status: Employee["status"] }) {
  return <Badge tone={STAFF_STATUS_TONE[status]}>{employmentLabel(status)}</Badge>;
}

export default function EmployeesPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [department, setDepartment] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<(Page<Employee> & { departments: string[] }) | null>(null);
  const [departments, setDepartments] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      setError(""); setResult(null);
      void listEmployees(status, department, search, HR_PAGE_SIZE, offset).then(
        (data) => { if (current) { setResult(data); setDepartments(data.departments); } }, (e: Error) => { if (current) setError(e.message); },
      );
    }, 150);
    return () => { current = false; window.clearTimeout(timer); };
  }, [status, department, search, offset]);

  return <div>
    <PageHeader title="Employees" breadcrumb="Master Data" description="Manage employment records, reporting lines and onboarding."
      actions={<Button onClick={() => setAdding(true)} icon="ri-add-line">Add Employee</Button>} />
    <div className="mb-4 grid gap-2 sm:grid-cols-3">
      <TextInput aria-label="Search employees" placeholder="Search employee, job title or ID" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
      <Select aria-label="Filter by employment status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
        <option value="">All employment statuses</option>{Object.entries(employmentStates).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
      <Select aria-label="Filter by department" value={department} onChange={(e) => { setDepartment(e.target.value); setOffset(0); }}>
        <option value="">All departments</option>{departments.map((d) => <option key={d}>{d}</option>)}
      </Select>
    </div>
    <HrNotice error>{error}</HrNotice>
    {!result && !error ? <p role="status">Loading employees…</p> : null}
    {result && !result.rows.length ? <EmptyState icon="ri-team-line" title="No matching employees" description="Add an employee directly or hire someone from Candidates." /> : null}
    {result?.rows.length ? <Card className="data-table-frame">
      <table className="data-table w-full text-left text-sm">
        <thead className="border-b border-background-200 text-xs uppercase text-foreground-500"><tr>
          {["Employee", "Job title", "Department", "Location", "Status"].map((label) => <th key={label} className="px-4 py-3">{label}</th>)}
        </tr></thead>
        <tbody>{result.rows.map((row) => <tr key={row.id} className="border-b border-background-100 last:border-0">
          <td data-label="Employee" className="px-4 py-3"><HrLink to={`/admin/employees/${row.id}`}>{hrName(row)}</HrLink><div className="text-xs text-foreground-500">{row.email}</div></td>
          <td data-label="Job title" className="px-4 py-3">{row.jobTitle || "—"}</td><td data-label="Department" className="px-4 py-3">{row.department || "—"}</td>
          <td data-label="Location" className="px-4 py-3">{row.workLocation || "—"}</td><td data-label="Status" className="px-4 py-3"><EmployeeBadge status={row.status} /></td>
        </tr>)}</tbody>
      </table>
    </Card> : null}
    {result ? <HrPager total={result.total} offset={offset} onChange={setOffset} /> : null}
    {adding ? <EmployeeForm onClose={() => setAdding(false)} onSaved={(id) => navigate(`/admin/employees/${id}`, { state: { message: "Employee added. You can now send their onboarding invitation." } })} /> : null}
  </div>;
}

function EmployeeForm({ row, onClose, onSaved }: { row?: Employee; onClose: () => void; onSaved: (id: string) => void }) {
  const [person, setPerson] = useState(row ?? emptyPerson);
  const [employment, setEmployment] = useState<EmploymentForm>(row ? {
    department: row.department, jobTitle: row.jobTitle, employmentType: row.employmentType ?? "", joiningDate: row.joiningDate ?? "",
    managerId: row.managerId ?? "", workLocation: row.workLocation,
  } : emptyEmployment);
  const [managerSearch, setManagerSearch] = useState("");
  const [managers, setManagers] = useState<Employee[]>([]);
  const [selectedManager, setSelectedManager] = useState(row?.managerId ? { id: row.managerId, name: row.managerName ?? row.managerId } : null);
  const [managerError, setManagerError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (update: Partial<EmploymentForm>) => setEmployment((previous) => ({ ...previous, ...update }));

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      void listEmployees("active", "", managerSearch, 25, 0).then(
        (data) => { if (current) { setManagers(data.rows.filter((m) => m.id !== row?.id)); setManagerError(""); } },
        (e: Error) => { if (current) setManagerError(e.message); },
      );
    }, 150);
    return () => { current = false; window.clearTimeout(timer); };
  }, [managerSearch, row?.id]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try { onSaved(await saveEmployee(row?.id ?? null, person, employment)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <Modal open title={row ? "Edit employee" : "Add employee"} width="max-w-2xl" onClose={() => { if (!busy) onClose(); }}
    footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" form="employee-form" disabled={busy}>{busy ? "Saving…" : "Save employee"}</Button></>}>
    <form id="employee-form" className="space-y-4" onSubmit={(e) => void submit(e)}>
      <HrNotice error>{error}</HrNotice>
      <HrFields value={person} onChange={setPerson} linked={row?.linkedAccount} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Job title" required><TextInput required maxLength={150} value={employment.jobTitle} onChange={(e) => patch({ jobTitle: e.target.value })} /></Field>
        <Field label="Department"><TextInput maxLength={120} value={employment.department} onChange={(e) => patch({ department: e.target.value })} /></Field>
        <Field label="Employment type" required><Select required value={employment.employmentType} onChange={(e) => patch({ employmentType: e.target.value as EmploymentForm["employmentType"] })}>
          <option value="">Choose employment type</option>{EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_TYPE_LABEL[t]}</option>)}
        </Select></Field>
        <Field label="Joining date"><TextInput type="date" min="1900-01-01" max="2100-12-31" value={employment.joiningDate} onChange={(e) => patch({ joiningDate: e.target.value })} /></Field>
        <Field label="Work location"><TextInput maxLength={150} value={employment.workLocation} onChange={(e) => patch({ workLocation: e.target.value })} /></Field>
        <Field label="Find a manager"><TextInput placeholder="Search active employees" value={managerSearch} onChange={(e) => setManagerSearch(e.target.value)} /></Field>
        <Field label="Manager"><Select value={employment.managerId} onChange={(e) => {
          const id = e.target.value;
          const selected = managers.find((m) => m.id === id);
          if (selected) setSelectedManager({ id, name: hrName(selected) });
          if (!id) setSelectedManager(null);
          patch({ managerId: id });
        }}>
          <option value="">No manager assigned</option>
          {selectedManager && !managers.some((m) => m.id === selectedManager.id) ? <option value={selectedManager.id}>{selectedManager.name}</option> : null}
          {managers.map((m) => <option value={m.id} key={m.id}>{hrName(m)}</option>)}
        </Select></Field>
      </div>
      <HrNotice error>{managerError}</HrNotice>
    </form>
  </Modal>;
}

type EmployeeAction = "invite" | "activate" | "deactivate";
const actionLabel = { invite: "Send onboarding invitation", activate: "Reactivate employment", deactivate: "Deactivate employment" };

export function EmployeeDetailPage() {
  const { id = "" } = useParams();
  const [row, setRow] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState("");
  const { state } = useLocation();
  const [notice, setNotice] = useState<string>(state?.message ?? "");
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<EmployeeAction | null>(null);
  const [actionError, setActionError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setRow(null); setError("");
    void getEmployee(id).then((data) => { if (current) setRow(data); }, (e: Error) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [id]);

  async function reload(message: string) {
    setNotice(message);
    try { setRow(await getEmployee(id)); setError(""); }
    catch (e) { setError((e as Error).message); }
  }
  function ask(next: EmployeeAction) { setAction(next); setNote(""); setActionError(""); }
  async function confirm() {
    if (!action || busy) return;
    setBusy(true); setActionError("");
    try {
      if (action === "invite") await inviteEmployee(id);
      else await adminDecideStaff(id, { action, note: note.trim() });
      setAction(null);
      await reload(action === "invite" ? "Onboarding email sent." : action === "activate" ? "Employment reactivated." : "Employment deactivated.");
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!row) return <><HrLink to="/admin/employees">All employees</HrLink><HrNotice error>{error}</HrNotice>{!error ? <p role="status">Loading employee…</p> : null}</>;
  const canInvite = ["draft", "submitted", "preboarding"].includes(row.status);
  return <div>
    <PageHeader breadcrumb="Master Data / Employees" title={hrName(row)} description={row.jobTitle}
      actions={<><EmployeeBadge status={row.status} /><Button variant="outline" onClick={() => setEditing(true)}>Edit Employee</Button>
        {canInvite ? <Button onClick={() => ask("invite")}>Invite Employee</Button> : null}
        {row.status === "active" ? <Button variant="outline" onClick={() => ask("deactivate")}>Deactivate</Button> : null}
        {row.status === "inactive" ? <Button onClick={() => ask("activate")}>Reactivate</Button> : null}
      </>} />
    <div className="mb-4 flex flex-wrap gap-4 text-sm"><HrLink to="/admin/employees">All employees</HrLink>
      <HrLink to={`/admin/employees/${id}/onboarding`}>Review onboarding and access</HrLink>
      {row.candidateId ? <HrLink to={`/admin/candidates/${row.candidateId}`}>View linked application</HrLink> : null}</div>
    <HrNotice error>{error}</HrNotice><HrNotice>{notice}</HrNotice>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4"><h2 className="mb-3 font-semibold">Employment details</h2><dl className="grid gap-3 sm:grid-cols-2">
        <HrValue label="Employee ID">{row.id}</HrValue><HrValue label="Account setup">{row.linkedAccount ? "Linked" : "Pending"}</HrValue>
        <HrValue label="Email">{row.email}</HrValue><HrValue label="Phone">{row.phone}</HrValue>
        <HrValue label="Department">{row.department}</HrValue><HrValue label="Job title">{row.jobTitle}</HrValue>
        <HrValue label="Employment type">{row.employmentType ? EMPLOYMENT_TYPE_LABEL[row.employmentType] : ""}</HrValue>
        <HrValue label="Joining date">{row.joiningDate}</HrValue><HrValue label="Work location">{row.workLocation}</HrValue>
        <HrValue label="Onboarding status">{STAFF_STATUS_LABEL[row.status]}</HrValue>
        <HrValue label="Manager">{row.managerId ? <HrLink to={`/admin/employees/${row.managerId}`}>{row.managerName ?? row.managerId}</HrLink> : ""}</HrValue>
      </dl></Card>
      <Card className="p-4"><h2 className="mb-3 font-semibold">Employment history</h2><HrHistory events={row.history} /></Card>
    </div>
    {editing ? <EmployeeForm row={row} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void reload("Employee updated."); }} /> : null}
    {action ? <Modal open title={actionLabel[action]} onClose={() => { if (!busy) setAction(null); }} footer={<>
      <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>Cancel</Button>
      <Button disabled={busy} onClick={() => void confirm()}>{busy ? "Working…" : "Confirm"}</Button>
    </>}>
      <HrNotice error>{actionError}</HrNotice>
      <p className="mb-3 text-sm">{action === "invite" ? `Send a Skyline onboarding link to ${row.email}?` : `${actionLabel[action]} for ${hrName(row)}?`}</p>
      {action !== "invite" ? <Field label="Reason"><TextArea maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></Field> : null}
    </Modal> : null}
  </div>;
}
