import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, EmptyState, PageHeader, TextInput } from "@/pages/admin/components/ui";
import { HrLink } from "@/pages/admin/components/Recruitment";
import EmployeeFormDialog from "@/pages/admin/components/EmployeeFormDialog";
import { EMPLOYEE_STATUS_LABEL, formatMobile, listEmployees, type Employee, type EmployeeStatus } from "@/lib/employeesApi";
import { staffEmployeePath } from "@/pages/admin/lib/staffRoutes";

const FILTERS: { id: EmployeeStatus | ""; label: string }[] = [{ id: "", label: "All" }, { id: "active", label: "Active" }, { id: "inactive", label: "Inactive" }];

/** Staff > Employees: everyone Active or Inactive. Add an employee, then open them to upload documents or change their status. */
export default function StaffPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<EmployeeStatus | "">("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Employee[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      setError("");
      void listEmployees(status, search).then((r) => { if (current) setRows(r); }, (e: Error) => { if (current) { setRows([]); setError(e.message); } });
    }, 150);
    return () => { current = false; window.clearTimeout(timer); };
  }, [status, search]);

  return (
    <div>
      <PageHeader breadcrumb="Staff" title="Employees" description="Add an employee with their name, email and mobile; they are Active straight away. Open an employee to upload their documents or make them inactive."
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
      {error ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {!rows && !error ? <p role="status">Loading employees…</p> : null}
      {rows && !rows.length && !error ? <EmptyState icon="ri-team-line" title={search || status ? "No matching employees" : "No employees yet"} description={search || status ? "Try another search or filter." : "Add your first employee with the button above."} /> : null}
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
      {adding ? <EmployeeFormDialog onClose={() => setAdding(false)} onSaved={(id) => navigate(staffEmployeePath(id), { state: { message: "Employee added. Upload their documents below." } })} /> : null}
    </div>
  );
}
