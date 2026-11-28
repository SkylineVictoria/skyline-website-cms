import AxcelerateBadge from "@/components/axcelerate/AxcelerateBadge";
import { useCallback, useEffect, useState } from "react";
import { hrNumber } from "@/lib/hrRules";
import MessagePersonButton from "@/pages/admin/components/MessagePersonButton";
import PersonMessageIcon from "@/pages/admin/components/PersonMessageIcon";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import SubjectSigningPanel from "./components/signing/SubjectSigningPanel";
import { Badge, Button, Card, Modal, PageHeader } from "@/pages/admin/components/ui";
import EmployeeFormDialog from "@/pages/admin/components/EmployeeFormDialog";
import PaySetupCard from "@/pages/admin/components/hrms/PaySetupCard";
import BankDetailsCard from "@/pages/admin/components/hrms/BankDetailsCard";
import EmployeeMessages from "@/pages/admin/components/hrms/EmployeeMessages";
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
  const [params, setParams] = useSearchParams();
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
  // EMPLOYEE-PAGE-LAYOUT (2026-11-24, owner: "look like the business page"): back link, header with status and actions, a summary
  // strip, then tabs (Details, Documents, Pay and bank, Signing) in the business page's style.
  const tab = (["details", "documents", "pay", "signing", "messages"] as const).find((t) => t === params.get("tab")) ?? "details";
  const goTab = (next: string) => setParams(next === "details" ? {} : { tab: next });
  const signIn = employee.hasLogin && employee.passwordSet ? "Can sign in" : employee.hasLogin ? "Link sent" : "No login yet";
  const tabs: Array<{ id: string; label: string; count?: number }> = [
    { id: "details", label: "Details" },
    { id: "documents", label: "Documents", count: employee.documentList.length },
    { id: "pay", label: "Pay and bank" },
    { id: "signing", label: "Signing" },
    { id: "messages", label: "Messages" },
  ];
  const row = (label: string, value: React.ReactNode) => (
    <div><dt className="text-xs text-foreground-500">{label}</dt><dd className="mt-1 break-words text-sm text-foreground-900">{value || "—"}</dd></div>
  );
  return (
    <div>
      <Link to={STAFF_EMPLOYEES_PATH} className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-foreground-600 hover:text-foreground-900">
        <i className="ri-arrow-left-line" aria-hidden="true" /> Employees
      </Link>
      <PageHeader title={fullName(employee)}
        description={[employee.employment?.jobTitle, employee.email, `since ${date(employee.createdAt)}`].filter(Boolean).join(", ")}
        actions={<>
          <Badge tone={active ? "success" : "muted"}>{EMPLOYEE_STATUS_LABEL[employee.status]}</Badge>
          <AxcelerateBadge table="hr.staff_profiles" id={employee.id} />
          <MessagePersonButton kind="staff" refId={employee.id} name={fullName(employee)} />
          <Button variant="outline" onClick={() => setEditing(true)} icon="ri-pencil-line" data-testid="employee-edit">Edit</Button>
          <Link to="?view=onboarding" className="inline-flex items-center gap-1.5 rounded-md border border-background-300 px-3 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100" data-testid="employee-onboarding">
            <i className="ri-file-paper-2-line" aria-hidden="true" /> Onboarding and offer</Link>
          <Button variant="outline" onClick={() => setConfirmStatus(true)} data-testid="employee-status">{active ? "Make inactive" : "Make active"}</Button>
          {active && !(employee.hasLogin && employee.passwordSet) ? <Button onClick={() => setConfirmLink(true)} icon="ri-login-circle-line" data-testid="employee-login-link">{employee.hasLogin ? "Resend sign-in link" : "Send sign-in link"}</Button> : null}
        </>} />
      {notice ? <p role="status" className="mb-4 rounded-md border border-secondary-300 bg-secondary-50 px-3 py-2 text-sm text-foreground-900">{notice}</p> : null}
      {error ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}

      <dl className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-background-200 bg-background-200 lg:grid-cols-4" data-testid="employee-summary">
        <div className="bg-background-50 px-4 py-3"><dt className="text-xs text-foreground-500">Status</dt><dd className="mt-1 font-heading text-xl font-bold text-foreground-950">{EMPLOYEE_STATUS_LABEL[employee.status]}</dd></div>
        <div className="bg-background-50 px-4 py-3"><dt className="text-xs text-foreground-500">My HR sign-in</dt><dd className="mt-1 font-heading text-xl font-bold text-foreground-950" data-testid="employee-login-state">{signIn}</dd>
          {active && !(employee.hasLogin && employee.passwordSet) ? <p className="mt-0.5 text-xs font-medium text-amber-700">Cannot punch in or see their timesheet yet.</p> : null}</div>
        <div className="bg-background-50 px-4 py-3"><dt className="text-xs text-foreground-500">Documents</dt><dd className="mt-1">
          <button type="button" onClick={() => goTab("documents")} className="font-heading text-xl font-bold tabular-nums text-foreground-950 hover:text-primary-700">{employee.documentList.length}</button></dd></div>
        <div className="bg-background-50 px-4 py-3"><dt className="text-xs text-foreground-500">Start date</dt><dd className="mt-1 font-heading text-xl font-bold text-foreground-950">{employee.employment?.joiningDate ? date(`${employee.employment.joiningDate}T00:00:00`) : "—"}</dd></div>
      </dl>

      <nav className="mb-5 flex flex-wrap gap-1 border-b border-background-200" aria-label="Employee sections">
        {tabs.map((item) => (
          <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => goTab(item.id)} data-testid={`employee-tab-${item.id}`}
            className={`-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-sm font-medium ${tab === item.id ? "border-primary-500 text-primary-700" : "border-transparent text-foreground-600 hover:text-foreground-900"}`}>
            {item.label}
            {item.count !== undefined ? <span className="ml-1.5 rounded-full bg-background-200 px-1.5 py-0.5 text-2xs tabular-nums text-foreground-700">{item.count}</span> : null}
          </button>
        ))}
      </nav>

      {tab === "details" ? (
        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="mb-3 text-base font-semibold text-foreground-950">Contact</h2>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {row("Email", <span className="break-all">{employee.email}</span>)}
              {row("Mobile", formatMobile(employee.phone))}
              {row("Added", date(employee.createdAt))}
              {row("Status", <Badge tone={active ? "success" : "muted"}>{EMPLOYEE_STATUS_LABEL[employee.status]}</Badge>)}
            </dl>
          </Card>
          <Card className="p-5"><div data-testid="employee-employment">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-foreground-950">Employment</h2>
              <Button size="sm" variant="outline" onClick={() => setEditingEmployment(true)} data-testid="employee-employment-edit">{employee.employment ? "Edit employment" : "Add employment details"}</Button>
            </div>
            {employee.employment ? (
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {row("Job title", employee.employment.jobTitle)}
                {row("Job type", employee.employment.employmentType ? EMPLOYMENT_TYPE_LABEL[employee.employment.employmentType] : "")}
                {row("Work location", employee.employment.workLocation)}
                {row("Pay type", employee.employment.payType ? PAY_TYPE_LABEL[employee.employment.payType] : "Set in Pay setup")}
                {row("Department", employee.employment.department)}
                {row("Manager", employee.employment.managerName)}
                {row("Start date", employee.employment.joiningDate ? date(`${employee.employment.joiningDate}T00:00:00`) : "")}
              </dl>
            ) : <p className="text-sm text-foreground-500">No employment details yet: job title, job type, work location and manager.</p>}
          </div></Card>
        </div>
      ) : null}

      {tab === "documents" ? (
        <Card className="p-5">
          <h2 className="mb-3 text-base font-semibold text-foreground-950">Documents</h2>
          <EmployeeDocumentsUpload employeeId={employee.id} onUploaded={(message) => { setNotice(message); setError(""); void load(); }} />
          {employee.documentList.length ? (
            <ul className="mt-3 divide-y divide-background-200 rounded-md border border-background-200" data-testid="employee-documents">
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
          ) : <p className="mt-3 text-sm text-foreground-500">No documents yet. Choose or drop the files above, check each type, then Upload.</p>}
          <p className="mt-2 text-xs text-foreground-500">Uploading a new file of the same type replaces the current one.</p>
        </Card>
      ) : null}

      {tab === "pay" ? (
        <div className="space-y-4">
          <BankDetailsCard key={`bank-${employee.id}-${bankVersion}`} profileId={employee.id} />
          <PaySetupCard profileId={employee.id} hasEmployment />
        </div>
      ) : null}

      {tab === "signing" ? <SubjectSigningPanel type="employee" id={employee.id} name={fullName(employee)} /> : null}
      {tab === "messages" ? <EmployeeMessages profileId={employee.id} /> : null}

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
              <li>A login is created for them if they do not have one. The link works once, for {hrNumber("hrms.staff_account_link_days", 7)} days. No password is emailed.</li>
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
