import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, EmptyState, PageHeader, TextInput } from "@/pages/admin/components/ui";
import { HrLink } from "@/pages/admin/components/Recruitment";
import EmployeeFormDialog from "@/pages/admin/components/EmployeeFormDialog";
import ResendLinkButton from "@/pages/admin/components/ResendLinkButton";
import { EMPLOYEE_STATUS_LABEL, formatMobile, listEmployees, type Employee, type EmployeeStatus } from "@/lib/employeesApi";
import { adminListStaff, type StaffListRow } from "@/lib/staffApi";
import { STAFF_STATUS_LABEL, STAFF_STATUS_TONE, type StaffStatus } from "@/lib/staffStatus";
import { staffEmployeePath } from "@/pages/admin/lib/staffRoutes";

type Filter = EmployeeStatus | "" | "onboarding" | "closed";
const FILTERS: { id: Filter; label: string }[] = [{ id: "", label: "All" }, { id: "onboarding", label: "Onboarding" }, { id: "active", label: "Active" }, { id: "inactive", label: "Inactive" },
  { id: "closed", label: "Rejected / Withdrawn" }];
/** Everyone between application and activation (HR-02 statuses). */
const ONBOARDING: readonly StaffStatus[] = ["applied", "invited", "documents_submitted", "offer_sent", "offer_signed"];
/** Applications that were rejected or withdrawn before the person became an employee (they can be reopened from their page). */
const CLOSED: readonly StaffStatus[] = ["rejected"];

/** Staff > Employees: everyone Active or Inactive. Add an employee, then open them to upload documents or change their status. */
export default function StaffPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Filter>("");
  const [onboarding, setOnboarding] = useState<StaffListRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Employee[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      setError("");
      if (status === "onboarding" || status === "closed") {
        setRows([]);
        void adminListStaff(status === "closed" ? CLOSED : ONBOARDING, search.trim()).then((r) => { if (current) setOnboarding(r.rows); }, (e: Error) => { if (current) { setOnboarding([]); setError(e.message); } });
      } else {
        setOnboarding(null);
        void listEmployees(status, search).then((r) => { if (current) setRows(r); }, (e: Error) => { if (current) { setRows([]); setError(e.message); } });
      }
    }, 150);
    return () => { current = false; window.clearTimeout(timer); };
  }, [status, search, reload]);

  return (
    <div>
      <PageHeader breadcrumb="HRMS" title="Employees" description="Add an employee as Active straight away, or start their onboarding: a document link by email, then the offer letter to sign, then activation. The Onboarding tab lists everyone in between; Rejected / Withdrawn keeps the applications that did not go ahead."
        actions={<Button onClick={() => setAdding(true)} icon="ri-user-add-line" data-testid="employee-add">Add employee</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Filter by status" className="inline-flex rounded-md border border-background-300 p-0.5">
          {FILTERS.map((f) => (
            <button key={f.id || "all"} type="button" role="tab" aria-selected={status === f.id} onClick={() => setStatus(f.id)}
              className={`cursor-pointer rounded px-3 py-1.5 text-sm ${status === f.id ? "bg-primary-500 font-semibold text-background-50" : "text-foreground-700 hover:bg-background-100"}`}>{f.label}</button>
          ))}
        </div>
        <div className="w-full sm:w-72"><TextInput type="search" aria-label="Search employees" placeholder="Search name, email or mobile" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>
      {notice ? <p role="status" className="mb-4 rounded-md border border-secondary-300 bg-secondary-50 px-3 py-2 text-sm text-foreground-900" data-testid="employees-notice">{notice}</p> : null}
      {error ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {!rows && !error ? <p role="status">Loading employees…</p> : null}
      {onboarding ? (onboarding.length ? (
        <Card className="data-table-frame">
          <table className="data-table w-full text-left text-sm" data-testid={status === "closed" ? "closed-table" : "onboarding-table"}>
            <thead className="border-b border-background-200 text-xs uppercase text-foreground-500"><tr>
              {["Name", "Email", "Job", "Documents approved", status === "closed" ? "Status" : "Stage", ...(status === "closed" ? [] : ["Document link"])].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}
            </tr></thead>
            <tbody>{onboarding.map((r) => (
              <tr key={r.id} className="border-b border-background-100 last:border-0" data-testid={`onboarding-row-${r.id}`}>
                <td data-label="Name" className="px-4 py-3"><HrLink to={staffEmployeePath(r.id)}>{r.name || r.email}</HrLink></td>
                <td data-label="Email" className="px-4 py-3">{r.email}</td>
                <td data-label="Job" className="px-4 py-3">{[r.jobTitle, r.department].filter(Boolean).join(" · ") || "—"}</td>
                <td data-label="Documents approved" className="px-4 py-3">{r.docs.approved}/{r.docs.required}{r.docs.rejected ? ` (${r.docs.rejected} rejected)` : ""}</td>
                <td data-label={status === "closed" ? "Status" : "Stage"} className="px-4 py-3"><Badge tone={STAFF_STATUS_TONE[r.status]}>{status === "closed" ? "Rejected / Withdrawn" : STAFF_STATUS_LABEL[r.status]}</Badge>{r.emailFailed ? <span className="ml-1.5" data-testid="staff-email-failed-badge"><Badge tone="primary">Email failed</Badge></span> : null}</td>
                {status === "closed" ? null : <td data-label="Document link" className="px-4 py-3"><ResendLinkButton row={r} onDone={(m) => { setNotice(m); setReload((n) => n + 1); }} /></td>}
              </tr>
            ))}</tbody>
          </table>
        </Card>
      ) : !error ? (status === "closed"
        ? <EmptyState icon="ri-user-unfollow-line" title={search ? "No matching rejected or withdrawn applications" : "No rejected or withdrawn applications"} description="Applications you withdraw or reject are kept here. Open one to see its history or reopen it." />
        : <EmptyState icon="ri-user-follow-line" title="Nobody in onboarding" description="Use Add employee > Start onboarding, or hire a candidate from Website > Candidates." />) : null) : null}
      {rows && !rows.length && !error && status !== "onboarding" && status !== "closed" ?<EmptyState icon="ri-team-line" title={search || status ? "No matching employees" : "No employees yet"} description={search || status ? "Try another search or filter." : "Add your first employee with the button above."} /> : null}
      {rows?.length ? (
        <Card className="data-table-frame">
          <table className="data-table w-full text-left text-sm" data-testid="employees-table">
            <thead className="border-b border-background-200 text-xs uppercase text-foreground-500"><tr>
              {["Name", "Email", "Mobile", "Documents", "Status"].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-b border-background-100 last:border-0" data-testid={`employee-row-${r.id}`}>
                <td data-label="Name" className="px-4 py-3"><HrLink to={staffEmployeePath(r.id)}>{[r.firstName, r.lastName].filter(Boolean).join(" ") || r.email}</HrLink></td>
                <td data-label="Email" className="px-4 py-3">{r.email}</td>
                <td data-label="Mobile" className="px-4 py-3">{formatMobile(r.phone)}</td>
                <td data-label="Documents" className="px-4 py-3">{r.documents}</td>
                <td data-label="Status" className="px-4 py-3"><Badge tone={r.status === "active" ? "success" : "muted"}>{EMPLOYEE_STATUS_LABEL[r.status]}</Badge></td>
              </tr>
            ))}</tbody>
          </table>
        </Card>
      ) : null}
      {adding ? <EmployeeFormDialog onClose={() => setAdding(false)} onSaved={(id, result) => navigate(staffEmployeePath(id), { state: { message: result?.message ?? "Employee added. Upload their documents below." } })} /> : null}
    </div>
  );
}
