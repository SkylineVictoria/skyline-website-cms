import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Modal } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import SearchPick, { type PickOption } from "@/pages/admin/components/SearchPick";
import AgentStatusBadge from "@/pages/admin/components/AgentStatusBadge";
import AddStudentRecordDialog, { type AddStudentRecordValue } from "@/pages/admin/components/AddStudentRecordDialog";
import { Field, TextInput } from "@/pages/admin/components/ui";
import EmailField from "@/components/identity/EmailField";
import ContactLinkFields from "@/components/shared/ContactLinkFields";
import { activateAgent, listBusinesses, setBusinessStatus, type BusinessStatus } from "@/pages/admin/lib/businessData";
import { createApplicationForStudent, agentPickable, findStudentByEmail, listActiveAgentsElsewhere, listAgentsOfBusiness, saveStudent, type BusinessAgentOption } from "@/pages/agency/lib/portalApplications";
import { isEmailTakenError, normalizeEmail, type EmailAvailability } from "@/lib/identity/email";
import { validateEmail } from "@/pages/agency/lib/userValidation";
import { textableMobile } from "@/lib/textableMobile";

function newClientKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type Business = { id: string; name: string; status: BusinessStatus };

/**
 * SLIT admin: add a student down the chain. Choose the business, then the agent who looks after them, then the student's name,
 * email and mobile. STUDENT-ONLY-ADD (owner 2026-11-27): only the student is saved (portal_student_save); then "Add an application
 * too?": Yes starts their application and opens the wizard (/admin/applications/:id?wizard=1); No opens the student's page and the
 * application is started later from Applications › New application. Agents and students keep their own flows.
 */
export default function AddStudentDialog({ open, onClose, onAdded, presetBusiness }: { open: boolean; onClose: () => void; onAdded?: () => void;
  /** Opened from a business page (2026-11-24): that business is already chosen. */
  presetBusiness?: Business }) {
  const { push } = useToast();
  const navigate = useNavigate();
  const [business, setBusiness] = useState<Business | null>(null);
  const [agent, setAgent] = useState<BusinessAgentOption | null>(null);
  const [recordDialogMode, setRecordDialogMode] = useState<"business" | "agent" | null>(null);
  const [initialAgentName, setInitialAgentName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Email unique within the student role: a refused email shows under the email field, not here.
  const [emailError, setEmailError] = useState<unknown>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [emailBlocked, setEmailBlocked] = useState(false);
  // The student just saved: the dialog then asks whether to add an application too.
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusiness(presetBusiness ?? null); setAgent(null); setRecordDialogMode(null); setInitialAgentName(""); setError("");
    setEmailError(null); setFirstName(""); setLastName(""); setEmail(""); setMobile(""); setSaved(null);
  }, [open, presetBusiness]);

  const checkEmail = useCallback(async (value: string): Promise<EmailAvailability> => {
    const result = await findStudentByEmail(value);
    return result.status === "taken" || result.status === "student"
      ? { available: false, message: "A student with this email already exists. Start their application from Applications." }
      : { available: true, message: null };
  }, []);

  const searchBusinesses = useCallback(async (q: string): Promise<PickOption[]> => {
    // Only active businesses and active agents can be chosen.
    const r = await listBusinesses({ search: q, status: "Active", limit: 8, offset: 0 });
    return r.rows.map((b) => ({
      id: b.id, label: b.name, meta: [b.abn ? `ABN ${b.abn}` : "", `${b.agents} agent${b.agents === 1 ? "" : "s"}`, `${b.students} student${b.students === 1 ? "" : "s"}`].filter(Boolean).join(", "),
      raw: b,
    })) as PickOption[];
  }, []);

  const businessId = business?.id ?? "";
  const searchAgents = useCallback(async (q: string): Promise<PickOption[]> => {
    if (!businessId) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w));
    const roleWord = (a: BusinessAgentOption) => a.role === "agency_admin" ? "Business admin agent" : "Agent";
    // Every active agent of this business (also those who have not signed in yet), then active agents of other businesses.
    const own = (await listAgentsOfBusiness(businessId)).filter(agentPickable)
      .filter((a) => hit(`${a.name} ${a.email} ${roleWord(a)}`))
      .map((a) => ({ id: a.id, label: a.name, meta: [a.email, roleWord(a)].filter(Boolean).join(", "), tag: <AgentStatusBadge status={a.status} />, raw: a }));
    const others = (await listActiveAgentsElsewhere(businessId).catch(() => []))
      .filter((o) => hit(`${o.agent.name} ${o.agent.email} ${o.business.name}`))
      .map((o) => ({ id: `other:${o.agent.id}`, label: o.agent.name, meta: [o.agent.email, `${roleWord(o.agent)} at ${o.business.name}`].filter(Boolean).join(", "),
        tag: <AgentStatusBadge status={o.agent.status} />, raw: { ...o.agent, otherBusiness: o.business } }));
    return [...own, ...others] as PickOption[];
  }, [businessId]);

  const saveNewRecord = (value: AddStudentRecordValue) => {
    setRecordDialogMode(null);
    if (value.kind === "business") {
      setBusiness({ id: value.business.agencyId, name: value.business.name, status: "Active" });
      setAgent(null);
    } else {
      setAgent({ id: value.agent.agentId, profileId: null, name: value.agent.name, email: value.agent.email, role: value.agent.role, status: "Invited" });
    }
  };

  // STUDENT-ONLY-ADD: save the student only, then ask whether to add an application too.
  const saveStudentOnly = async () => {
    if (!business || !agent || busy) return;
    const address = normalizeEmail(email);
    const problem = !firstName.trim() || !lastName.trim() ? "Enter the student's first and last name."
      : validateEmail(address) || (!textableMobile(mobile) ? "Enter the student's mobile number, with the country code." : "");
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError("");
    setEmailError(null);
    const notes: string[] = [];
    try {
      const existing = await findStudentByEmail(address);
      if (existing.status !== "free") { setError("A student with this email already exists. Start their application from Applications."); return; }
      if (business.status !== "Active") {
        await setBusinessStatus(business.id, "Active");
        notes.push(`${business.name} was activated.`);
      }
      if (agent.status === "Inactive") {
        await activateAgent({ agentId: agent.id, businessId: business.id, name: agent.name, email: agent.email, role: agent.role });
        notes.push(`${agent.name} was activated.`);
      }
      const student = await saveStudent({ agentId: agent.id, fullName: `${firstName.trim()} ${lastName.trim()}`, firstName: firstName.trim(), lastName: lastName.trim(), email: address, mobile });
      push([`${student.name || "Student"} added.`, ...notes].join(" "));
      onAdded?.();
      setSaved({ id: student.id, name: student.name || `${firstName.trim()} ${lastName.trim()}` });
    } catch (e) {
      if (isEmailTakenError(e)) { setEmailError(e); return; }
      setError(e instanceof Error ? e.message : "We could not add this student.");
    } finally {
      setBusy(false);
    }
  };

  // Yes: start the student's application and continue in the wizard.
  const addApplication = async () => {
    if (!saved || busy) return;
    setBusy(true);
    setError("");
    try {
      const { id } = await createApplicationForStudent(newClientKey(), saved.id);
      onClose();
      navigate(`/admin/applications/${id}?wizard=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not start the application. Start it from Applications › New application.");
    } finally {
      setBusy(false);
    }
  };

  // No: the student is saved; their application is started later from Applications.
  const skipApplication = () => {
    if (!saved) return;
    onClose();
    navigate(`/admin/students/${saved.id}`);
  };

  const chip = (title: string, sub: string, onChange: () => void, badge?: ReactNode) => (
    <div className="flex items-center justify-between gap-3 rounded-md border border-background-300 bg-background-50 px-3 py-2.5">
      <span className="min-w-0">
        <span className="flex items-center gap-2"><b className="truncate text-sm text-foreground-900">{title}</b>{badge}</span>
        <span className="block truncate text-xs text-foreground-500">{sub}</span>
      </span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onChange}>Change</Button>
    </div>
  );

  const ready = Boolean(business && agent);
  if (saved) {
    return (
      <Modal open={open} onClose={() => { if (!busy) skipApplication(); }} width="max-w-lg" title="Add an application too?"
        footer={<>
          <Button variant="outline" disabled={busy} onClick={skipApplication} data-testid="add-student-no-application">No, not now</Button>
          <Button icon="ri-file-add-line" disabled={busy} onClick={() => void addApplication()} data-testid="add-student-add-application">{busy ? "Starting…" : "Yes, add application"}</Button>
        </>}>
        <div className="space-y-3 text-sm text-foreground-700" data-testid="add-student-ask-application">
          <p><b className="text-foreground-900">{saved.name}</b> was added{agent ? ` under ${agent.name}` : ""}{business ? ` (${business.name})` : ""}.</p>
          <p>Do you want to add an application for them now? <b>Yes</b> opens the application wizard. <b>No</b> keeps the student only; start their application later from <b>Applications › New application</b>.</p>
          {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">{error}</p> : null}
        </div>
      </Modal>
    );
  }
  return (<>
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} width="max-w-2xl" title="Add student"
      footer={ready ? <>
        <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button icon="ri-user-add-line" disabled={busy || emailBlocked} onClick={() => void saveStudentOnly()} data-testid="add-student-save">{busy ? "Saving…" : "Add student"}</Button>
      </> : <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>}>
      <div className="space-y-5">
        {!ready ? <p className="text-sm text-foreground-600">Choose the business and the agent who looks after the student, then enter the student's name, email and mobile.</p> : null}

        {/* Business */}
        <div>
          <p className="mb-1.5 text-label font-medium text-foreground-800">Business</p>
          {business ? chip(business.name, business.status === "Active" ? "Active business" : "Inactive, activated when you add the student", () => { setBusiness(null); setAgent(null); }) : (
            <SearchPick label="Business" addNoun="business" autoFocus searchWhenEmpty placeholder="Search business name, ABN or agent"
              search={searchBusinesses}
              onPick={(o) => { const b = (o as PickOption & { raw: { id: string; name: string; status: BusinessStatus } }).raw; setBusiness({ id: b.id, name: b.name, status: b.status }); setAgent(null); }}
              onAddNew={() => { setInitialAgentName(""); setRecordDialogMode("business"); }} />
          )}
        </div>

        {/* Agent */}
        {business ? (
          <div>
            <p className="mb-1.5 text-label font-medium text-foreground-800">Agent</p>
            {agent ? (
              <>
                {chip(agent.name, agent.email || "No email on record", () => setAgent(null), <AgentStatusBadge status={agent.status} />)}
                {agent.status === "Inactive" ? <p className="mt-1.5 text-xs text-foreground-500">This agent is inactive. Adding the student activates them.</p> : null}
              </>
            ) : (
              <SearchPick label="Agent" addNoun="agent" placeholder={`Search or pick an agent at ${business.name}`} resetKey={business.id} autoFocus searchWhenEmpty openOnMount
                search={searchAgents}
                onPick={(o) => { const raw = (o as PickOption & { raw: BusinessAgentOption & { otherBusiness?: { id: string; name: string; status: "Active" } } }).raw;
                  // An agent of another business: the student goes to that business.
                  if (raw.otherBusiness) setBusiness({ id: raw.otherBusiness.id, name: raw.otherBusiness.name, status: raw.otherBusiness.status });
                  const { otherBusiness: _other, ...agentOnly } = raw; void _other; setAgent(agentOnly); }}
                onAddNew={(name) => { setInitialAgentName(name); setRecordDialogMode("agent"); }} />
            )}
          </div>
        ) : null}

        {/* Student */}
        {ready ? (
          <form className="space-y-4 border-t border-background-200 pt-5" noValidate onSubmit={(event) => { event.preventDefault(); void saveStudentOnly(); }}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" required><TextInput value={firstName} maxLength={100} autoFocus autoComplete="off" disabled={busy}
                onChange={(e) => { setFirstName(e.target.value); setError(""); }} data-testid="add-student-first-name" /></Field>
              <Field label="Last name" required><TextInput value={lastName} maxLength={100} autoComplete="off" disabled={busy}
                onChange={(e) => { setLastName(e.target.value); setError(""); }} data-testid="add-student-last-name" /></Field>
            </div>
            <div>
              <label htmlFor="add-student-email" className="mb-1.5 block text-label font-medium text-foreground-800">Email <span className="text-primary-600">*</span></label>
              <EmailField id="add-student-email" name="email" required maxLength={254} kind="student" context="admin"
                value={email} onChange={(value) => { setEmail(value); setError(""); }} serverError={emailError} checker={checkEmail}
                onStatusChange={(_status, blocked) => setEmailBlocked(blocked)} />
            </div>
            <ContactLinkFields id="add-student" mobile={mobile} onMobile={(value) => { setMobile(value); setError(""); }} mobileRequired locked={busy} who="the student" />
            {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </form>
        ) : error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      </div>
    </Modal>
    <AddStudentRecordDialog mode={recordDialogMode} initialAgentName={initialAgentName}
      business={business ? { id: business.id, name: business.name, status: business.status } : null}
      onCancel={() => setRecordDialogMode(null)} onSave={saveNewRecord} />
  </>);
}
