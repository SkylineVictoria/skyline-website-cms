import { useEffect, useState } from "react";
import PersonMessageIcon from "@/pages/admin/components/PersonMessageIcon";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, DangerDialog, EmptyState, Field, Modal, PageHeader, TextInput } from "@/pages/admin/components/ui";
import { HrLink } from "@/pages/admin/components/Recruitment";
import EmployeeFormDialog from "@/pages/admin/components/EmployeeFormDialog";
import ResendLinkButton from "@/pages/admin/components/ResendLinkButton";
import { EMPLOYEE_STATUS_LABEL, formatMobile, listEmployees, type Employee, type EmployeeStatus } from "@/lib/employeesApi";
import { adminDeleteStaff, adminEditStaff, adminListStaff, type StaffListRow } from "@/lib/staffApi";
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
  const [editing, setEditing] = useState<StaffListRow | null>(null);
  const [deleting, setDeleting] = useState<StaffListRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      setError("");
      // rule-policy: technical list-filter Which server list each filter tab reads.
      if (status === "" || status === "onboarding" || status === "closed") {
        setRows([]);
        // rule-policy: technical list-filter All lists every staff record whatever its status, so nobody is hidden.
        void adminListStaff(status === "closed" ? CLOSED : status === "onboarding" ? ONBOARDING : [], search.trim(), 200).then((r) => { if (current) setOnboarding(r.rows); }, (e: Error) => { if (current) { setOnboarding([]); setError(e.message); } });
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
      {/* // rule-policy: technical loading-state Loading text until the list arrives. */}
      {(onboarding === null && !rows) && !error ? <p role="status">Loading employees…</p> : null}
      {onboarding ? (onboarding.length ? (
        <Card className="data-table-frame">
          {/* // rule-policy: technical test-id Test id per filter (All, Onboarding, Rejected / Withdrawn). */}
          <table className="data-table w-full text-left text-sm" data-testid={status === "closed" ? "closed-table" : status === "" ? "all-staff-table" : "onboarding-table"}>
            <thead className="border-b border-background-200 text-xs uppercase text-foreground-500"><tr>
              {/* // rule-policy: technical table-headings Column headings per filter. */}
              {["Name", "Email", "Job", "Documents approved", status === "onboarding" ? "Stage" : "Status", ...(status === "onboarding" ? ["Document link"] : []), "Actions"].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}
            </tr></thead>
            <tbody>{onboarding.map((r) => (
              <tr key={r.id} className="border-b border-background-100 last:border-0" data-testid={`onboarding-row-${r.id}`}>
                <td data-label="Name" className="px-4 py-3"><HrLink to={staffEmployeePath(r.id)}>{r.name || r.email}</HrLink><PersonMessageIcon phone={r.phone} name={r.name} email={r.email} /></td>
                <td data-label="Email" className="px-4 py-3">{r.email}</td>
                <td data-label="Job" className="px-4 py-3">{[r.jobTitle, r.department].filter(Boolean).join(" · ") || "—"}</td>
                <td data-label="Documents approved" className="px-4 py-3">{r.docs.approved}/{r.docs.required}{r.docs.rejected ? ` (${r.docs.rejected} rejected)` : ""}</td>
                {/* // rule-policy: technical status-label Shows each record's stored status; the document link column only on Onboarding. */}
                <td data-label={status === "onboarding" ? "Stage" : "Status"} className="px-4 py-3"><Badge tone={STAFF_STATUS_TONE[r.status]}>{r.status === "rejected" ? "Rejected / Withdrawn" : STAFF_STATUS_LABEL[r.status]}</Badge>{r.emailFailed ? <span className="ml-1.5" data-testid="staff-email-failed-badge"><Badge tone="primary">Email failed</Badge></span> : null}</td>
                {status !== "onboarding" ? null : <td data-label="Document link" className="px-4 py-3"><ResendLinkButton row={r} onDone={(m) => { setNotice(m); setReload((n) => n + 1); }} /></td>}
                <td data-label="Actions" className="px-4 py-3"><div className="flex gap-1.5">
                  <Button size="sm" variant="outline" icon="ri-edit-line" onClick={() => setEditing(r)} data-testid={`staff-edit-${r.id}`}>Edit</Button>
                  {/* // rule-policy: security delete-guard Active staff cannot be deleted (the database refuses it too); set them Inactive first. */}
                  <Button size="sm" variant="danger" icon="ri-delete-bin-line" disabled={r.status === "active"} title={r.status === "active" ? "Active staff cannot be deleted. Set them Inactive first." : undefined} onClick={() => { setDeleteError(""); setDeleting(r); }} data-testid={`staff-delete-${r.id}`}>Delete</Button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </Card>
      ) : !error ? (status === "closed"
        ? <EmptyState icon="ri-user-unfollow-line" title={search ? "No matching rejected or withdrawn applications" : "No rejected or withdrawn applications"} description="Applications you withdraw or reject are kept here. Open one to see its history or reopen it." />
        // rule-policy: technical empty-state Empty message for the All filter.
        : status === "" ? <EmptyState icon="ri-team-line" title={search ? "No matching staff" : "No staff yet"} description={search ? "Try another search." : "Add your first employee with the button above."} />
        : <EmptyState icon="ri-user-follow-line" title="Nobody in onboarding" description="Use Add employee > Start onboarding, or hire a candidate from Website > Candidates." />) : null) : null}
      {/* // rule-policy: technical empty-state Empty message for the Active / Inactive filters only. */}
      {rows && !rows.length && !error && status !== "" && status !== "onboarding" && status !== "closed" ?<EmptyState icon="ri-team-line" title={search || status ? "No matching employees" : "No employees yet"} description={search || status ? "Try another search or filter." : "Add your first employee with the button above."} /> : null}
      {rows?.length ? (
        <Card className="data-table-frame">
          <table className="data-table w-full text-left text-sm" data-testid="employees-table">
            <thead className="border-b border-background-200 text-xs uppercase text-foreground-500"><tr>
              {["Name", "Email", "Mobile", "Documents", "Status"].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-b border-background-100 last:border-0" data-testid={`employee-row-${r.id}`}>
                <td data-label="Name" className="px-4 py-3"><HrLink to={staffEmployeePath(r.id)}>{[r.firstName, r.lastName].filter(Boolean).join(" ") || r.email}</HrLink><PersonMessageIcon phone={r.phone} name={[r.firstName, r.lastName].filter(Boolean).join(" ")} email={r.email} /></td>
                <td data-label="Email" className="px-4 py-3">{r.email}</td>
                <td data-label="Mobile" className="px-4 py-3">{formatMobile(r.phone)}</td>
                <td data-label="Documents" className="px-4 py-3">{r.documents}</td>
                <td data-label="Status" className="px-4 py-3"><Badge tone={r.status === "active" ? "success" : "muted"}>{EMPLOYEE_STATUS_LABEL[r.status]}</Badge></td>
              </tr>
            ))}</tbody>
          </table>
        </Card>
      ) : null}
      {editing ? <StaffEditDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice("Details saved."); setReload((n) => n + 1); }} /> : null}
      <DangerDialog open={!!deleting} title={`Delete ${deleting?.name || deleting?.email || "this person"}?`} intro="Use this for test records or people added by mistake."
        items={["Their staff record and onboarding history", "Their uploaded documents and sign-in links", `The email ${deleting?.email ?? ""} becomes free to use again`]}
        busy={deleteBusy} error={deleteError} onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          setDeleteBusy(true); setDeleteError("");
          adminDeleteStaff(deleting.id).then((r) => {
            setDeleting(null);
            setNotice(r.filesLeft ? `${r.email} deleted. ${r.filesLeft} file(s) could not be removed from storage.` : `${r.email} deleted. The email can be used again.`);
            setReload((n) => n + 1);
          }, (e: Error) => setDeleteError(e.message)).finally(() => setDeleteBusy(false));
        }} />
      {adding ? <EmployeeFormDialog onClose={() => setAdding(false)} onSaved={(id, result) => navigate(staffEmployeePath(id), { state: { message: result?.message ?? "Employee added. Upload their documents below." } })} /> : null}
    </div>
  );
}

function StaffEditDialog({ row, onClose, onSaved }: { row: StaffListRow; onClose: () => void; onSaved: () => void }) {
  const [first, ...rest] = (row.name || "").trim().split(/\s+/);
  const [firstName, setFirstName] = useState(first ?? "");
  const [lastName, setLastName] = useState(rest.join(" "));
  const [email, setEmail] = useState(row.email);
  const [phone, setPhone] = useState(row.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = () => {
    setBusy(true); setError("");
    // rule-policy: technical form-submit Trims the typed values; the server checks them.
    adminEditStaff(row.id, firstName.trim(), lastName.trim(), email.trim(), phone.trim()).then(onSaved, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <Modal open title="Edit staff details" onClose={onClose} footer={<>
      <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button onClick={save} disabled={busy || !firstName.trim() || !lastName.trim() || !email.trim()} data-testid="staff-edit-save">{busy ? "Saving…" : "Save"}</Button>
    </>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {/* // rule-policy: technical form-field Name fields of the edit form. */}
          <Field label="First name" required><TextInput value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="off" /></Field>
          <Field label="Last name" required><TextInput value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="off" /></Field>
        </div>
        {/* // rule-policy: technical form-field Email field; the server refuses a change once the person has a login. */}
        <Field label="Email" required hint="Cannot be changed once the person has signed in."><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
        <Field label="Mobile" hint="Optional."><TextInput type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" /></Field>
        {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      </div>
    </Modal>
  );
}
