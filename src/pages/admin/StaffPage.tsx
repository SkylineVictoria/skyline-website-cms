import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Select, TextInput } from "@/pages/admin/components/ui";
import WizardSteps from "@/pages/admin/components/WizardSteps";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { adminAddStaff, adminListStaff, type StaffListRow } from "@/lib/staffApi";
import { STAFF_STATUSES, STAFF_STATUS_LABEL, STAFF_STATUS_TONE, newStaffProblems, type NewStaffForm, type StaffRole } from "@/lib/staffStatus";

/** Agencies > Staff: staff applications, job applicants and current staff, filtered by status (?status= opens a filter), searchable by name, email or mobile; an Admin adds a staff member with the wizard. Admins only. */
export default function StaffPage() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState(() => { const s = params.get("status"); return s && (STAFF_STATUSES as readonly string[]).includes(s) ? s : ""; });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ total: number; rows: StaffListRow[] } | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");

  // Searching waits for a pause in typing.
  useEffect(() => { const t = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(t); }, [search]);

  const load = useCallback(async () => {
    setError("");
    try { setData(await adminListStaff(status, query)); }
    catch (e) { setData(null); setError(e instanceof Error ? e.message : "The staff list could not be loaded."); }
  }, [status, query]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <PageHeader title="Staff" description="People who applied for a staff account or for a job post, and current staff. Open a person to see their details, documents and job applications; hire or decline a job applicant, approve a staff application with a role or reject it with a note."
        actions={<Button onClick={() => setAdding(true)} data-testid="staff-add"><i className="ri-user-add-line" aria-hidden="true" /> Add staff member</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-64"><TextInput type="search" placeholder="Search name, email or mobile" aria-label="Search staff" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="w-full sm:w-48">
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STAFF_STATUSES.map((s) => <option key={s} value={s}>{STAFF_STATUS_LABEL[s]}</option>)}
          </Select>
        </div>
        {data ? <p className="text-xs text-foreground-500" role="status">{data.total} {data.total === 1 ? "person" : "people"}</p> : null}
      </div>
      {notice ? <p role="status" className="mb-4 rounded-md border border-secondary-300 bg-secondary-50 px-3 py-2 text-sm text-foreground-900">{notice}</p> : null}
      {error ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {data && data.rows.length === 0 ? <EmptyState icon="ri-user-line" title="No staff yet" description="Add a staff member here, or people appear after they apply from Enroll now > Staff or for a job post on the website." /> : null}
      {data && data.rows.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm" data-testid="staff-table">
            <thead className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
              <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Mobile</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Job</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Updated</th></tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id} className="border-b border-background-100 last:border-0 hover:bg-background-100">
                  <td className="px-4 py-3 font-medium"><Link to={`/admin/staff/${row.id}`} className="text-primary-700 hover:underline">{row.name || "(no name yet)"}</Link></td>
                  <td className="px-4 py-3 text-foreground-700">{row.email}</td>
                  <td className="px-4 py-3 text-foreground-700">{row.phone}</td>
                  <td className="px-4 py-3 capitalize text-foreground-700">{row.role ?? row.requestedRole ?? "—"}</td>
                  <td className="px-4 py-3 text-foreground-700">{row.jobTitle ?? "—"}</td>
                  <td className="px-4 py-3"><Badge tone={STAFF_STATUS_TONE[row.status]}>{STAFF_STATUS_LABEL[row.status]}</Badge></td>
                  <td className="px-4 py-3 text-xs text-foreground-500">{new Date(row.updatedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {adding ? <AddStaffWizard onClose={() => setAdding(false)} onDone={(message) => { setAdding(false); setNotice(message); void load(); }} /> : null}
    </div>
  );
}

const STEPS = ["Person", "Role", "Review and invite"];
const ROLE_TEXT: Record<StaffRole, string> = { trainer: "Delivers training; no admin console access.", admin: "Manages the website, applications and people once activated." };

/**
 * Add a staff member: name, email and mobile; the role they will hold; then an invitation. The staff-register function creates
 * the sign-in (an emailed link to set a password) and their draft staff record with the name filled in; they complete the rest
 * on their staff page, and the Admin approves and activates as usual.
 */
function AddStaffWizard({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<NewStaffForm>({ firstName: "", lastName: "", email: "", phone: "", role: "trainer" });
  const [problems, setProblems] = useState<Partial<Record<keyof NewStaffForm, string>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (next: Partial<NewStaffForm>) => setForm((f) => ({ ...f, ...next }));

  // Step 1 is a form so the country-code phone field (a hidden input named staff-phone) is read on Next.
  const person = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = { ...form, phone: String(new FormData(event.currentTarget).get("staff-phone") ?? "") };
    setForm(next);
    const found = newStaffProblems(next);
    setProblems(found);
    if (!Object.keys(found).length) setStep(1);
  };

  const invite = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await adminAddStaff(form);
      onDone(result.emailSent
        ? `${form.firstName.trim()} ${form.lastName.trim()} was added. An email asks them to set a password and complete their staff registration.`
        : `${form.firstName.trim()} ${form.lastName.trim()} was added to their existing sign-in (${form.email.trim().toLowerCase()}); they complete the staff registration after signing in.`);
    } catch (e) { setError(e instanceof Error ? e.message : "The staff member could not be added."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open title="Add staff member" onClose={onClose}
      footer={<>
        <Button variant="outline" onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}>{step === 0 ? "Cancel" : "Back"}</Button>
        {step === 0 ? <Button type="submit" form="add-staff-person" data-testid="staff-next">Next</Button> : null}
        {step === 1 ? <Button onClick={() => setStep(2)} data-testid="staff-next">Next</Button> : null}
        {step === 2 ? <Button onClick={() => void invite()} disabled={busy} data-testid="staff-invite">{busy ? "Sending…" : "Add and send invitation"}</Button> : null}
      </>}>
      <WizardSteps steps={STEPS} current={step} />
      {step === 0 ? (
        <form id="add-staff-person" onSubmit={person} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div><Field label="First name" required><TextInput value={form.firstName} onChange={(e) => patch({ firstName: e.target.value })} maxLength={100} data-testid="staff-first" /></Field>{problems.firstName ? <p role="alert" className="mt-1 text-xs text-primary-700">{problems.firstName}</p> : null}</div>
            <div><Field label="Last name" required><TextInput value={form.lastName} onChange={(e) => patch({ lastName: e.target.value })} maxLength={100} data-testid="staff-last" /></Field>{problems.lastName ? <p role="alert" className="mt-1 text-xs text-primary-700">{problems.lastName}</p> : null}</div>
          </div>
          <div><Field label="Email" required hint="They sign in with this address; the invitation goes here."><TextInput type="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} autoComplete="off" data-testid="staff-email" /></Field>{problems.email ? <p role="alert" className="mt-1 text-xs text-primary-700">{problems.email}</p> : null}</div>
          <div>
            <label htmlFor="staff-phone" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Mobile <span className="text-primary-600">*</span></label>
            <PhoneInput id="staff-phone" name="staff-phone" value={form.phone} required placeholder="041 234 5678" />
            {problems.phone ? <p role="alert" className="mt-1 text-xs text-primary-700">{problems.phone}</p> : null}
          </div>
        </form>
      ) : null}
      {step === 1 ? (
        <div role="radiogroup" aria-label="Role" className="space-y-2">
          {(["trainer", "admin"] as StaffRole[]).map((r) => (
            <button key={r} type="button" role="radio" aria-checked={form.role === r} onClick={() => patch({ role: r })} data-testid={`staff-role-${r}`}
              className={`block w-full cursor-pointer rounded-md border px-4 py-3 text-left ${form.role === r ? "border-primary-500 bg-primary-50" : "border-background-300 hover:bg-background-100"}`}>
              <span className="block text-sm font-semibold capitalize text-foreground-950">{r}</span>
              <span className="block text-xs text-foreground-600">{ROLE_TEXT[r]}</span>
            </button>
          ))}
          <p className="pt-1 text-xs text-foreground-500">The role is recorded as requested. It is granted when you approve their completed registration (an Admin role asks you to confirm again), and takes effect when you activate them.</p>
        </div>
      ) : null}
      {step === 2 ? (
        <div className="space-y-4">
          <dl className="grid gap-3 rounded-md border border-background-200 bg-background-100 p-4 text-sm sm:grid-cols-2">
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Name</dt><dd className="font-semibold text-foreground-950">{form.firstName.trim()} {form.lastName.trim()}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Role</dt><dd className="capitalize">{form.role}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Email</dt><dd>{form.email.trim().toLowerCase()}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Mobile</dt><dd>{form.phone}</dd></div>
          </dl>
          <p className="text-sm text-foreground-700">They receive an email to set a password, then complete their staff registration (personal details, passport and other documents). You approve and activate it from their page.</p>
          {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
        </div>
      ) : null}
    </Modal>
  );
}
