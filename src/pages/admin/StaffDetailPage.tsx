import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Badge, Button, Card, Modal, PageHeader } from "@/pages/admin/components/ui";
import EmployeeFormDialog from "@/pages/admin/components/EmployeeFormDialog";
import PaySetupCard from "@/pages/admin/components/hrms/PaySetupCard";
import EmployeeDocumentsUpload from "@/pages/admin/components/EmployeeDocumentsUpload";
import {
  EMPLOYEE_STATUS_LABEL, employeeDocumentUrl, formatMobile, getEmployee, removeEmployeeDocument, setEmployeeStatus, type EmployeeDetail,
} from "@/lib/employeesApi";
import { STAFF_EMPLOYEES_PATH } from "@/pages/admin/lib/staffRoutes";

const fullName = (e: EmployeeDetail) => [e.firstName, e.lastName].filter(Boolean).join(" ") || e.email;
const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const date = (value: string) => new Date(value).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** Staff > Employees > one employee: their details, Active / Inactive, and the documents an Admin uploads for them. */
export default function StaffDetailPage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState((location.state as { message?: string } | null)?.message ?? "");
  const [editing, setEditing] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setEmployee(await getEmployee(id)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The employee could not be loaded."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await work(); setNotice(done); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "That could not be done."); }
    finally { setBusy(false); }
  };

  const view = async (path: string) => {
    try { window.open(await employeeDocumentUrl(path), "_blank", "noopener,noreferrer"); }
    catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); }
  };

  if (!employee) {
    return <div>
      <PageHeader breadcrumb="Staff" title="Employee" />
      {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : <p role="status">Loading…</p>}
      <p className="mt-4"><Link to={STAFF_EMPLOYEES_PATH} className="text-sm font-medium text-primary-700 hover:underline">Back to Employees</Link></p>
    </div>;
  }

  const active = employee.status === "active";
  return (
    <div>
      <PageHeader breadcrumb="Staff › Employees" title={fullName(employee)}
        actions={<>
          <Button variant="outline" onClick={() => setEditing(true)} icon="ri-pencil-line" data-testid="employee-edit">Edit</Button>
          <Button variant="outline" onClick={() => setConfirmStatus(true)} data-testid="employee-status">{active ? "Make inactive" : "Make active"}</Button>
        </>} />
      <p className="mb-4"><Link to={STAFF_EMPLOYEES_PATH} className="text-sm font-medium text-primary-700 hover:underline">← All employees</Link></p>
      {notice ? <p role="status" className="mb-4 rounded-md border border-secondary-300 bg-secondary-50 px-3 py-2 text-sm text-foreground-900">{notice}</p> : null}
      {error ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}

      <Card className="mb-4 p-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs uppercase text-foreground-500">Status</dt><dd className="mt-1"><Badge tone={active ? "success" : "muted"}>{EMPLOYEE_STATUS_LABEL[employee.status]}</Badge></dd></div>
          <div><dt className="text-xs uppercase text-foreground-500">Email</dt><dd className="mt-1 break-all">{employee.email}</dd></div>
          <div><dt className="text-xs uppercase text-foreground-500">Mobile</dt><dd className="mt-1">{formatMobile(employee.phone)}</dd></div>
          <div><dt className="text-xs uppercase text-foreground-500">Added</dt><dd className="mt-1">{date(employee.createdAt)}</dd></div>
        </dl>
      </Card>

      <Card className="mb-4 p-5">
        <h2 className="mb-3 text-base font-semibold text-foreground-950">Documents</h2>
        <EmployeeDocumentsUpload employeeId={employee.id} onUploaded={(message) => { setNotice(message); setError(""); void load(); }} />
        {employee.documentList.length ? (
          <ul className="divide-y divide-background-200 rounded-md border border-background-200" data-testid="employee-documents">
            {employee.documentList.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <i className="ri-file-text-line text-foreground-500" aria-hidden="true" />
                <span className="min-w-0 flex-1"><span className="font-medium text-foreground-950">{d.category}</span>
                  <span className="ml-2 break-all text-foreground-600">{d.filename}</span>
                  <span className="ml-2 text-xs text-foreground-500">{size(d.size)} · {date(d.uploadedAt)}</span></span>
                <Button size="sm" variant="ghost" onClick={() => void view(d.storagePath)}>View</Button>
                {d.removable ? <Button size="sm" variant="ghost" disabled={busy}
                  onClick={() => { if (window.confirm(`Remove ${d.category} (${d.filename})?`)) void act(() => removeEmployeeDocument(d.id), `${d.category} removed.`); }}>Remove</Button> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-foreground-500">No documents yet. Choose or drop the files above, check each type, then Upload.</p>}
        <p className="mt-2 text-xs text-foreground-500">Uploading a new file of the same type replaces the current one.</p>
      </Card>

      <PaySetupCard profileId={employee.id} hasEmployment />

      {editing ? <EmployeeFormDialog id={employee.id} initial={{ firstName: employee.firstName, lastName: employee.lastName, email: employee.email, phone: employee.phone }}
        onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setNotice("Details saved."); void load(); }} /> : null}
      {confirmStatus ? (
        <Modal open title={active ? "Make inactive" : "Make active"} onClose={() => { if (!busy) setConfirmStatus(false); }}
          footer={<><Button variant="outline" disabled={busy} onClick={() => setConfirmStatus(false)}>Cancel</Button>
            <Button disabled={busy} data-testid="employee-status-confirm" onClick={() => { setConfirmStatus(false); void act(() => setEmployeeStatus(employee.id, active ? "inactive" : "active"), active ? "Marked inactive." : "Marked active."); }}>{active ? "Make inactive" : "Make active"}</Button></>}>
          <p className="text-sm">{active ? `Mark ${fullName(employee)} as inactive? Their record and documents are kept; you can make them active again at any time.` : `Mark ${fullName(employee)} as active again?`}</p>
        </Modal>
      ) : null}
    </div>
  );
}
