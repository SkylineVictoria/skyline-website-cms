import { useCallback, useEffect, useState } from "react";
import WhatsAppLink from "@/components/base/WhatsAppLink";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import SubjectSigningPanel from "./components/signing/SubjectSigningPanel";
import { Badge, Button, Card, Modal, PageHeader } from "@/pages/admin/components/ui";
import EmployeeFormDialog from "@/pages/admin/components/EmployeeFormDialog";
import PaySetupCard from "@/pages/admin/components/hrms/PaySetupCard";
import BankDetailsCard from "@/pages/admin/components/hrms/BankDetailsCard";
import StaffOnboardingDetail from "@/pages/admin/StaffOnboardingDetail";
import EmployeeDocumentsUpload from "@/pages/admin/components/EmployeeDocumentsUpload";
import EmploymentDialog from "@/pages/admin/components/hrms/EmploymentDialog";
import { StaffAdminError, staffAdminActions, type StaffEmployment } from "@/lib/staffApi";
import { EMPLOYMENT_TYPE_LABEL } from "@/lib/jobs";
import { PAY_TYPE_LABEL } from "../../../supabase/functions/_shared/hr-template";
import {
  EMPLOYEE_STATUS_LABEL, employeeDocumentUrl, formatMobile, getEmployee, removeEmployeeDocument, setEmployeeStatus, type EmployeeDetail,
} from "@/lib/employeesApi";
import { STAFF_EMPLOYEES_PATH } from "@/pages/admin/lib/staffRoutes";

const fullName = (e: EmployeeDetail) => [e.firstName, e.lastName].filter(Boolean).join(" ") || e.email;
const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const date = (value: string) => new Date(value).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/**
 * HRMS > Employees > one person. Someone still in onboarding (applied, document link sent, documents submitted, offer sent or signed)
 * gets the onboarding page: document link, document review, offer letter, activation. Active / Inactive employees get this page
 * (details, documents, bank, pay); "Onboarding and offer" opens their onboarding page too (?view=onboarding).
 */
export default function StaffDetailPage() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<string | null>(null);
  if (params.get("view") === "onboarding" || (status !== null && status !== "active" && status !== "inactive")) return <StaffOnboardingDetail />;
  return <SimpleEmployeePage onStatus={setStatus} />;
}

/** Staff > Employees > one employee: their details, Active / Inactive, and the documents an Admin uploads for them. */
function SimpleEmployeePage({ onStatus }: { onStatus: (status: string) => void }) {
  const { id = "" } = useParams();
  const location = useLocation();
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState((location.state as { message?: string } | null)?.message ?? "");
  const [editing, setEditing] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bankVersion, setBankVersion] = useState(0);
  const [editingEmployment, setEditingEmployment] = useState(false);
  const [confirmLink, setConfirmLink] = useState(false);
  const [shownLink, setShownLink] = useState<{ link: string; expiresAt?: string } | null>(null);

  const load = useCallback(async () => {
    try { const next = await getEmployee(id); onStatus(next.status); setEmployee(next); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The employee could not be loaded."); }
  }, [id, onStatus]);
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
      <PageHeader breadcrumb="HRMS" title="Employee" />
      {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : <p role="status">Loading…</p>}
      <p className="mt-4"><Link to={STAFF_EMPLOYEES_PATH} className="text-sm font-medium text-primary-700 hover:underline">Back to Employees</Link></p>
    </div>;
  }

  const active = employee.status === "active";
  return (
    <div>
      <PageHeader breadcrumb="HRMS › Employees" title={fullName(employee)} titleSuffix={<WhatsAppLink phone={employee.phone} name={fullName(employee)} />}
        actions={<>
          <Button variant="outline" onClick={() => setEditing(true)} icon="ri-pencil-line" data-testid="employee-edit">Edit</Button>
          <Link to="?view=onboarding" className="inline-flex items-center gap-1.5 rounded-md border border-background-300 px-3 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100" data-testid="employee-onboarding">
            <i className="ri-file-paper-2-line" aria-hidden="true" /> Onboarding and offer</Link>
          <Button variant="outline" onClick={() => setConfirmStatus(true)} data-testid="employee-status">{active ? "Make inactive" : "Make active"}</Button>
          {active && !(employee.hasLogin && employee.passwordSet) ? <Button onClick={() => setConfirmLink(true)} icon="ri-login-circle-line" data-testid="employee-login-link">{employee.hasLogin ? "Resend sign-in link" : "Send sign-in link"}</Button> : null}
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
          <div><dt className="text-xs uppercase text-foreground-500">My HR login</dt><dd className="mt-1" data-testid="employee-login-state">
            {employee.hasLogin && employee.passwordSet ? <Badge tone="success">Can sign in</Badge> : employee.hasLogin ? <Badge tone="warn">Link sent, password not chosen</Badge> : <Badge tone="muted">No login yet</Badge>}
          </dd></div>
        </dl>
        {active && !(employee.hasLogin && employee.passwordSet) ? <p className="mt-3 text-xs text-foreground-600">Until {employee.firstName || "this person"} has a login they cannot punch in or out or see their timesheet. Send them a sign-in link.</p> : null}
      </Card>

      <Card className="mb-4 p-5"><div data-testid="employee-employment">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground-950">Employment</h2>
          <Button size="sm" variant="outline" onClick={() => setEditingEmployment(true)} data-testid="employee-employment-edit">{employee.employment ? "Edit employment" : "Add employment details"}</Button>
        </div>
        {employee.employment ? (
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs uppercase text-foreground-500">Job title</dt><dd className="mt-1">{employee.employment.jobTitle || "—"}</dd></div>
            <div><dt className="text-xs uppercase text-foreground-500">Job type</dt><dd className="mt-1">{employee.employment.employmentType ? EMPLOYMENT_TYPE_LABEL[employee.employment.employmentType] : "—"}</dd></div>
            <div><dt className="text-xs uppercase text-foreground-500">Work location</dt><dd className="mt-1">{employee.employment.workLocation || "—"}</dd></div>
            <div><dt className="text-xs uppercase text-foreground-500">Pay type</dt><dd className="mt-1">{employee.employment.payType ? PAY_TYPE_LABEL[employee.employment.payType] : "Set in Pay setup"}</dd></div>
            <div><dt className="text-xs uppercase text-foreground-500">Department</dt><dd className="mt-1">{employee.employment.department || "—"}</dd></div>
            <div><dt className="text-xs uppercase text-foreground-500">Manager</dt><dd className="mt-1">{employee.employment.managerName || "—"}</dd></div>
            <div><dt className="text-xs uppercase text-foreground-500">Start date</dt><dd className="mt-1">{employee.employment.joiningDate ? date(`${employee.employment.joiningDate}T00:00:00`) : "—"}</dd></div>
          </dl>
        ) : <p className="text-sm text-foreground-500">No employment details yet: job title, job type, work location and manager.</p>}
      </div></Card>

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

      <div className="mb-4"><SubjectSigningPanel type="employee" id={employee.id} name={fullName(employee)} /></div>

      <BankDetailsCard key={`bank-${employee.id}-${bankVersion}`} profileId={employee.id} />
      <PaySetupCard profileId={employee.id} hasEmployment />

      {editingEmployment ? <EmploymentDialog profileId={employee.id} employment={(employee.employment ?? null) as StaffEmployment | null} onClose={() => setEditingEmployment(false)}
        onSaved={() => { setEditingEmployment(false); setNotice("The employment details were saved."); void load(); }} /> : null}
      {confirmLink ? (
        <Modal open title={employee.hasLogin ? "Resend sign-in link" : "Send sign-in link"} onClose={() => { if (!busy) setConfirmLink(false); }}
          footer={<><Button variant="outline" disabled={busy} onClick={() => setConfirmLink(false)}>Cancel</Button>
            <Button disabled={busy} data-testid="employee-login-link-confirm" onClick={() => { setConfirmLink(false); void act(async () => {
              const result = await staffAdminActions.inviteLogin(employee.id);
              if (result.link) setShownLink({ link: result.link, expiresAt: result.expiresAt });
              return result;
            }, "The sign-in link was emailed. Once they choose a password they can punch in and out and see their timesheet."); }}>{busy ? "Sending…" : "Send the email"}</Button></>}>
          <div className="space-y-2 text-sm text-foreground-800">
            <p>This emails <strong>{employee.email}</strong> one personal link to choose a password for My HR (punch in / out, timesheet, leave).</p>
            <ul className="list-disc space-y-1 pl-5 text-foreground-700">
              <li>A login is created for them if they do not have one. The link works once, for 7 days. No password is emailed.</li>
              <li>If they already sign in to Skyline (as an administrator, agent or student) that same login is linked and they use their existing password.</li>
              <li>If the email cannot be sent, the link is cancelled and you can send it again.</li>
            </ul>
          </div>
        </Modal>
      ) : null}
      {shownLink ? (
        <Modal open title="Sign-in link (shown once)" onClose={() => setShownLink(null)} footer={<Button onClick={() => setShownLink(null)}>Done</Button>}>
          <p className="mb-2 text-sm text-foreground-800">Email sending is switched off. Pass this link to {fullName(employee)} yourself{shownLink.expiresAt ? `; it works until ${date(shownLink.expiresAt)}` : ""}.</p>
          <code className="block break-all rounded-md border border-background-300 bg-background-50 p-3 text-xs" data-testid="employee-login-link-value">{shownLink.link}</code>
        </Modal>
      ) : null}
      {editing ? <EmployeeFormDialog id={employee.id} initial={{ firstName: employee.firstName, lastName: employee.lastName, email: employee.email, phone: employee.phone }}
        onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setNotice("Details saved."); setBankVersion((v) => v + 1); void load(); }} /> : null}
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
