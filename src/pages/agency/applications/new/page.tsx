import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { activateAgent, listBusinesses, sendStudentInvitation, setBusinessStatus, type BusinessStatus } from "@/pages/admin/lib/businessData";
import { useToast } from "@/pages/admin/components/toastContext";
import SearchPick, { type PickOption } from "@/pages/admin/components/SearchPick";
import AgentStatusBadge from "@/pages/admin/components/AgentStatusBadge";
import AddStudentRecordDialog, { type AddStudentRecordValue } from "@/pages/admin/components/AddStudentRecordDialog";
import StudentDetailsStep, { type StudentDraft } from "@/pages/agency/components/StudentDetailsStep";
import {
  createApplicationForStudent,
  deleteApplicationDocument,
  deleteApplicationDraft,
  findAgentByProfile,
  getApplication,
  listAgentsOfBusiness,
  listApplicationDocuments,
  saveApplicationDraft,
  saveStudent,
  studentAgencyOptions,
  chooseStudentAgency,
  type BusinessAgentOption,
  type StudentMatch,
} from "@/pages/agency/lib/portalApplications";
import { formatPhone } from "../../../../../supabase/functions/_shared/validation/identifiers";
import { useApplicationPaths } from "@/pages/agency/lib/applicationPaths";
import ApplicationWizard from "@/pages/agency/components/ApplicationWizard";
import { isEditableStatus, loadApplicationStatuses } from "@/lib/applicationStatuses";
import { PageHeading, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";

import { portalScopeCacheKey } from "@/lib/portalScope";
import { isEmailTakenError } from "@/lib/identity/email";

function newClientKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A pending wizard session, so reopening the wizard resumes the SAME draft. */
function sessionKey(uid: string): string {
  return `slit-portal-wizard-v1:${portalScopeCacheKey()}:${uid}`;
}

function readSession(uid: string): string | null {
  try {
    const raw = window.localStorage.getItem(sessionKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { applicationId?: string };
    return parsed.applicationId ?? null;
  } catch {
    return null;
  }
}

function writeSession(uid: string, applicationId: string): void {
  try {
    window.localStorage.setItem(sessionKey(uid), JSON.stringify({ applicationId }));
  } catch {
    /* storage unavailable — the wizard still works for this session */
  }
}

function clearSession(uid: string): void {
  try {
    window.localStorage.removeItem(sessionKey(uid));
  } catch {
    /* ignore */
  }
}

type Phase = "checking" | "student" | "pick" | "agency" | "wizard";

type Business = { id: string; name: string; status: BusinessStatus };

/** A draft started before students were recorded separately still needs its contact details before the wizard. */
async function saveContact(id: string, student: StudentDraft): Promise<void> {
  // Saves are version-checked; a draft created a moment ago has no known version until it is read once.
  await getApplication(id);
  return saveApplicationDraft(id, {
    data: { values: { email: student.email, confirm_email: student.email, mobile: student.mobile } },
    studentName: student.fullName,
    studentEmail: student.email,
    intake: "",
    completion: 0,
  });
}

/**
 * New application, down the chain: the student first (an existing student is offered when their email, mobile or passport
 * is on record), then — unless the person signed in is the agent — the business and agent who look after them.
 */
export default function NewApplicationPage() {
  const paths = useApplicationPaths();
  const { role, studentId, agency, profile, authUser, authLoading, identityLoading, reloadIdentity } = usePortalAuth();
  const navigate = useNavigate();
  const { push } = useToast();

  const clientKeyRef = useRef(newClientKey());
  const bootRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("checking");
  const [applicationId, setApplicationId] = useState("");
  const [draft, setDraft] = useState<StudentDraft | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [agent, setAgent] = useState<BusinessAgentOption | null>(null);
  const [recordDialogMode, setRecordDialogMode] = useState<"business" | "agent" | null>(null);
  const [initialAgentName, setInitialAgentName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  // An email refused when the student is saved (email unique within the student role) goes back to the email field.
  const [emailError, setEmailError] = useState<unknown>(null);
  // A self-enrolled student's first application: are they working with an education agency?
  const [agencyChoices, setAgencyChoices] = useState<Array<{ id: string; name: string }>>([]);
  const [withAgency, setWithAgency] = useState<boolean | null>(null);
  const [chosenBusinessId, setChosenBusinessId] = useState("");
  const [agentChoices, setAgentChoices] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [chosenAgentId, setChosenAgentId] = useState("");
  const [agentsLoading, setAgentsLoading] = useState(false);

  // Agency users work inside their own business; SLIT administrators choose one.
  const ownBusiness: Business | null = role !== "slit_admin" && agency ? { id: agency.id, name: agency.name, status: "Active" } : null;
  const chosenBusiness = ownBusiness ?? business;

  const searchBusinesses = useCallback(async (q: string): Promise<PickOption[]> => {
    // Only active businesses can be chosen.
    const result = await listBusinesses({ search: q, status: "Active", limit: 8, offset: 0 });
    return result.rows.map((row) => ({
      id: row.id,
      label: row.name,
      meta: [row.abn ? `ABN ${row.abn}` : "", `${row.agents} agent${row.agents === 1 ? "" : "s"}`, `${row.students} student${row.students === 1 ? "" : "s"}`].filter(Boolean).join(", "),
      raw: row,
    })) as PickOption[];
  }, []);

  const businessId = chosenBusiness?.id ?? "";
  const searchAgents = useCallback(async (q: string): Promise<PickOption[]> => {
    if (!businessId) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (await listAgentsOfBusiness(businessId))
      // Only active agents can be chosen.
      .filter((a) => a.status === "Active")
      .filter((a) => { const text = `${a.name} ${a.email} ${a.role === "agency_admin" ? "agency admin" : "agent"}`.toLowerCase(); return words.every((w) => text.includes(w)); })
      .map((a) => ({ id: a.id, label: a.name, meta: [a.email, a.role === "agency_admin" ? "Agency admin" : "Agent"].filter(Boolean).join(", "), tag: <AgentStatusBadge status={a.status} />, raw: a }));
  }, [businessId]);

  const openWizard = (id: string) => {
    if (authUser?.id) writeSession(authUser.id, id);
    setApplicationId(id);
    setPhase("wizard");
  };

  // The student record is saved (or the existing one reused) under the agent, then the application is created for them.
  const start = useCallback(async (student: StudentDraft, existing: StudentMatch | null, chosen: { business: Business | null; agent: BusinessAgentOption } | null) => {
    setCreating(true);
    setError("");
    const notes: string[] = [];
    try {
      let studentId = existing?.id ?? "";
      if (!existing) {
        if (!chosen) throw new Error("Choose the agent who looks after this student.");
        if (role === "slit_admin" && chosen.business && chosen.business.status !== "Active") {
          await setBusinessStatus(chosen.business.id, "Active");
          notes.push(`${chosen.business.name} was activated.`);
        }
        if (role === "slit_admin" && chosen.agent.status === "Inactive") {
          await activateAgent({ agentId: chosen.agent.id, businessId: chosen.business?.id ?? null, name: chosen.agent.name, email: chosen.agent.email, role: chosen.agent.role });
          notes.push(`${chosen.agent.name} was activated.`);
        }
        const saved = await saveStudent({ agentId: chosen.agent.id, fullName: student.fullName, email: student.email, mobile: student.mobile, dateOfBirth: student.dateOfBirth, passportNumber: student.passportNumber });
        studentId = saved.id;
        if (saved.reused) notes.push(`${saved.name} was already on record with this passport or email and date of birth, so that record is used.`);
        else if (student.invite) {
          try { notes.push(await sendStudentInvitation({ id: saved.id, email: saved.email || student.email, name: saved.name || student.fullName, agencyId: saved.businessId })); }
          catch (e) { notes.push(`The student's sign-in invitation was not sent${e instanceof Error && e.message ? `: ${e.message}` : "."} Send it from Students.`); }
        }
      } else {
        notes.push(`New application for ${existing.name || "the existing student"}${existing.agentName ? `, looked after by ${existing.agentName}` : ""}.`);
      }
      const { id } = await createApplicationForStudent(clientKeyRef.current, studentId);
      clientKeyRef.current = newClientKey();
      if (notes.length) push(notes.join(" "));
      openWizard(id);
    } catch (e) {
      if (isEmailTakenError(e)) { setEmailError(e); setPhase("student"); return; }
      setError(e instanceof Error ? e.message : "We could not start a new application.");
    } finally {
      setCreating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, authUser?.id]);

  const continueFromStudent = async (student: StudentDraft, existing: StudentMatch | null) => {
    setDraft(student);
    setError("");
    setEmailError(null);
    // A resumed draft keeps its student, business and agent; only the contact details are added to it.
    if (applicationId) {
      setCreating(true);
      try {
        await saveContact(applicationId, student);
        setPhase("wizard");
      } catch (e) {
        if (isEmailTakenError(e)) { setEmailError(e); return; }
        setError(e instanceof Error ? e.message : "We could not start a new application.");
      } finally {
        setCreating(false);
      }
      return;
    }
    if (existing) { await start(student, existing, null); return; }
    if (role === "agent") {
      // The signed-in agent looks after their own students.
      setCreating(true);
      try {
        const own = profile ? await findAgentByProfile(profile.id) : null;
        if (!own) throw new Error("Your sign-in is not set up as an agent of this business yet. Ask your administrator.");
        setCreating(false);
        await start(student, null, { business: ownBusiness, agent: own });
      } catch (e) {
        setError(e instanceof Error ? e.message : "We could not start a new application.");
        setCreating(false);
      }
      return;
    }
    setPhase("pick");
  };

  // Resolve an existing wizard session, or start with the student.
  useEffect(() => {
    if (authLoading || identityLoading) return;
    if (!role || !authUser) return;
    if (bootRef.current) return;
    bootRef.current = true;

    (async () => {
      setError("");
      try {
        const existing = readSession(authUser.id);
        if (existing) {
          const app = await getApplication(existing).catch(() => null);
          const statuses = app ? await loadApplicationStatuses() : null;
          if (app && statuses && isEditableStatus(statuses, app.status)) {
            setApplicationId(app.id);
            // Drafts started before the student step existed must still collect the contact details before the wizard.
            const values = (app.data?.values ?? {}) as Record<string, unknown>;
            const saved = { fullName: app.studentName ?? "", email: String(values.email ?? ""), mobile: String(values.mobile ?? ""), dateOfBirth: "", passportNumber: "" };
            setDraft(saved);
            setPhase(saved.email && saved.mobile ? "wizard" : "student");
            return;
          }
          clearSession(authUser.id);
        }
        if (role === "student") {
          // A student starts their own application: no student step, no agent to choose.
          if (!studentId) throw new Error("Your student record could not be found. Ask your agent or SLIT Administration.");
          // Signed up by themselves and no application yet: first, are they working with an agency?
          const options = await studentAgencyOptions().catch(() => null);
          if (options?.ask) { setAgencyChoices(options.businesses); setPhase("agency"); return; }
          const { id } = await createApplicationForStudent(clientKeyRef.current, studentId);
          clientKeyRef.current = newClientKey();
          openWizard(id);
          return;
        }
        setPhase("student");
      } catch (e) {
        setError(e instanceof Error ? e.message : "We could not start a new application.");
        setPhase(role === "student" ? "checking" : "student");
        bootRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, identityLoading, role, studentId, authUser]);

  const saveNewRecord = (value: AddStudentRecordValue) => {
    setRecordDialogMode(null);
    if (value.kind === "business") {
      setBusiness({ id: value.business.agencyId, name: value.business.name, status: "Active" });
      setAgent(null);
    } else {
      setAgent({ id: value.agent.agentId, profileId: null, name: value.agent.name, email: value.agent.email, role: value.agent.role, status: "Invited" });
    }
  };

  const handleFinish = () => {
    if (authUser?.id) clearSession(authUser.id);
    navigate(paths.detail(applicationId), { replace: true });
  };

  // Cancelling discards the unfinished draft and its uploads, then starts a fresh application.
  const handleCancel = async () => {
    const uid = authUser?.id;
    if (uid) clearSession(uid);
    const abandoned = applicationId;
    setApplicationId("");
    setPhase("checking");
    setCreating(true);
    setError("");
    try {
      const docs = await listApplicationDocuments(abandoned).catch(() => []);
      await Promise.all(docs.map((doc) => deleteApplicationDocument({ id: doc.id, storagePath: doc.storagePath }).catch(() => undefined)));
      await deleteApplicationDraft(abandoned).catch(() => undefined);
      if (role === "student") { navigate(paths.list, { replace: true }); return; }
      setBusiness(null);
      setAgent(null);
      setDraft(null);
      setPhase("student");
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not start a new application.");
    } finally {
      setCreating(false);
    }
  };

  // The student picked a business: its active agents are listed.
  useEffect(() => {
    if (phase !== "agency" || !chosenBusinessId) { setAgentChoices([]); return; }
    let active = true;
    setAgentsLoading(true);
    studentAgencyOptions(chosenBusinessId)
      .then((options) => { if (active) setAgentChoices(options.agents); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "We could not load the agents."); })
      .finally(() => { if (active) setAgentsLoading(false); });
    return () => { active = false; };
  }, [phase, chosenBusinessId]);

  // "No, by myself" starts the application under SLIT; "Yes" first moves the student under the chosen business and agent.
  const startAsStudent = async (choice: { businessId: string; agentId: string } | null) => {
    if (!studentId) return;
    setCreating(true);
    setError("");
    try {
      if (choice) {
        const moved = await chooseStudentAgency(choice.businessId, choice.agentId);
        await reloadIdentity();
        push(`You are now recorded with ${moved.businessName}${moved.agentName ? `, looked after by ${moved.agentName}` : ""}.`);
      }
      const { id } = await createApplicationForStudent(clientKeyRef.current, studentId);
      clientKeyRef.current = newClientKey();
      openWizard(id);
    } catch (e) {
      if (isEmailTakenError(e)) { setEmailError(e); setPhase("student"); return; }
      setError(e instanceof Error ? e.message : "We could not start a new application.");
    } finally {
      setCreating(false);
    }
  };

  const secondary = "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-background-300 px-5 py-3 text-sm font-semibold text-foreground-800 transition-colors hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-60";
  const primary = "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60";

  if (authLoading || identityLoading || phase === "checking") {
    return (
      <div>
        <PageHeading
          eyebrow="Add New Form"
          title="Starting a new application"
          description="Starting with the student; everything else is filled from the documents you upload."
        />
        <div className="mt-6">
          {error ? (
            <div className="space-y-3">
              <PortalError message={error} />
              <button type="button" onClick={() => window.location.reload()} className={primary}>
                <i className="ri-refresh-line" aria-hidden="true" />
                Try again
              </button>
            </div>
          ) : (
            <PortalLoading label={creating ? "Preparing your blank application…" : "Opening…"} />
          )}
        </div>
      </div>
    );
  }

  if (phase === "wizard") {
    return (
      <ApplicationWizard
        applicationId={applicationId}
        agencyName={chosenBusiness?.name ?? agency?.name ?? ""}
        onFinish={handleFinish}
        onCancel={() => void handleCancel()}
      />
    );
  }

  if (phase === "agency") {
    const selectClass = "w-full rounded-md border border-background-300 bg-background-50 px-3 py-2.5 text-sm text-foreground-900 focus:border-primary-500 focus:outline-none disabled:opacity-60";
    const canContinue = Boolean(chosenBusinessId && chosenAgentId) && !creating;
    return (
      <div>
        <PageHeading
          eyebrow="New application"
          title="Before you start"
          description="Tell us who is helping you with your application. You can only choose this once, so ask SLIT Administration if it needs changing later."
        />
        <div className="mt-6 max-w-2xl rounded-card border border-background-200 bg-background-50 p-6">
          <h2 className="font-heading text-base font-semibold text-foreground-950">Are you working with an education agency?</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button type="button" disabled={creating} onClick={() => setWithAgency(true)}
              className={`cursor-pointer rounded-md border px-4 py-3 text-left text-sm transition-colors disabled:opacity-60 ${withAgency === true ? "border-primary-500 bg-primary-50 text-foreground-950" : "border-background-300 text-foreground-800 hover:bg-background-100"}`}>
              <b className="block font-semibold">Yes</b><span className="text-foreground-600">An agent is helping me apply.</span>
            </button>
            <button type="button" disabled={creating} onClick={() => { setWithAgency(false); void startAsStudent(null); }}
              className={`cursor-pointer rounded-md border px-4 py-3 text-left text-sm transition-colors disabled:opacity-60 ${withAgency === false ? "border-primary-500 bg-primary-50 text-foreground-950" : "border-background-300 text-foreground-800 hover:bg-background-100"}`}>
              <b className="block font-semibold">No</b><span className="text-foreground-600">I am applying by myself.</span>
            </button>
          </div>

          {withAgency ? (
            <div className="mt-5 space-y-4">
              <div>
                <label htmlFor="student-business" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Business <span className="text-primary-600">*</span></label>
                <select id="student-business" className={selectClass} value={chosenBusinessId} disabled={creating}
                  onChange={(e) => { setChosenBusinessId(e.target.value); setChosenAgentId(""); }}>
                  <option value="">Select your agency</option>
                  {agencyChoices.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                {agencyChoices.length === 0 ? <p className="mt-1 text-xs text-foreground-500">No agencies are registered yet. Choose No to apply by yourself.</p> : null}
              </div>
              <div>
                <label htmlFor="student-agent" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Agent <span className="text-primary-600">*</span></label>
                <select id="student-agent" className={selectClass} value={chosenAgentId} disabled={creating || !chosenBusinessId || agentsLoading}
                  onChange={(e) => setChosenAgentId(e.target.value)}>
                  <option value="">{!chosenBusinessId ? "Choose the business first" : agentsLoading ? "Loading agents…" : agentChoices.length ? "Select your agent" : "This business has no active agents"}</option>
                  {agentChoices.map((a) => <option key={a.id} value={a.id}>{a.name}{a.role === "agency_admin" ? " (agency admin)" : ""}</option>)}
                </select>
                <p className="mt-1 text-xs text-foreground-500">Your agent is not listed? Ask them to register with SLIT, or choose No for now.</p>
              </div>
            </div>
          ) : null}

          {error ? <div className="mt-4"><PortalError message={error} /></div> : null}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Link to={paths.list} className={secondary}>Cancel</Link>
            {withAgency ? (
              <button type="button" disabled={!canContinue} onClick={() => void startAsStudent({ businessId: chosenBusinessId, agentId: chosenAgentId })} className={primary}>
                {creating ? "Starting…" : "Continue"}
                <i className="ri-arrow-right-line" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (phase === "student") {
    return (
      <div>
        <PageHeading
          eyebrow="Add New Form"
          title="New student application"
          description="Start with the student. A student already on record keeps one record with all their applications."
        />
        <div className="mt-6 max-w-2xl rounded-card border border-background-200 bg-background-50 p-6">
          <StudentDetailsStep initial={draft ?? undefined} busy={creating} error={error} allowStudentWithoutApplication offerInvite={role !== "agent"}
            context={role === "slit_admin" ? "admin" : "portal"} emailError={emailError}
            onContinue={(student, existing) => void continueFromStudent(student, existing)}
            cancel={<Link to={paths.list} className={secondary}>Cancel</Link>} />
        </div>
      </div>
    );
  }

  const ready = Boolean(chosenBusiness && agent);
  return (
    <div>
      <PageHeading
        eyebrow="Add New Form"
        title="New student application"
        description={role === "slit_admin" ? "Choose the business and the agent who looks after this student." : "Choose the agent who looks after this student."}
      />

      {draft ? (
        <div className="mt-6 flex max-w-2xl items-center justify-between gap-3 rounded-card border border-background-200 bg-background-50 px-4 py-3">
          <span className="min-w-0 text-sm text-foreground-700">
            <span className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Student</span>{" "}
            <b className="font-medium text-foreground-900">{draft.email}</b> &middot; {formatPhone(draft.mobile)}
          </span>
        </div>
      ) : null}

      <div className="mt-4 max-w-2xl rounded-card border border-background-200 bg-background-50 p-6">
        <h2 className="font-heading text-base font-semibold text-foreground-950">Who looks after this student?</h2>
        <p className="mt-1.5 text-sm text-foreground-600">The student is recorded under this agent. Next opens the document wizard.</p>

        <div className="mt-5 space-y-5">
          {role === "slit_admin" ? (
            <div>
              {business ? (
                <>
                  <p className="mb-1.5 text-[13px] font-medium text-foreground-800">Business</p>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-background-300 bg-background-50 px-3 py-2.5">
                    <span className="min-w-0">
                      <b className="block truncate text-sm text-foreground-900">{business.name}</b>
                      <span className="block truncate text-xs text-foreground-500">{business.status === "Active" ? "Active business" : "Inactive, activated when you start the application"}</span>
                    </span>
                    <button type="button" disabled={creating} onClick={() => { setBusiness(null); setAgent(null); }} className="rounded px-2 py-1 text-sm font-medium text-primary-700 hover:bg-background-100 disabled:opacity-60">Change</button>
                  </div>
                </>
              ) : (
                <SearchPick label="Business" addNoun="business" autoFocus placeholder="Search business name, ABN or agent"
                  search={searchBusinesses}
                  onPick={(option) => { const row = (option as PickOption & { raw: { id: string; name: string; status: BusinessStatus } }).raw; setBusiness({ id: row.id, name: row.name, status: row.status }); setAgent(null); }}
                  onAddNew={() => { setInitialAgentName(""); setRecordDialogMode("business"); }} />
              )}
            </div>
          ) : null}

          {chosenBusiness ? (
            <div>
              {agent ? (
                <>
                  <p className="mb-1.5 text-[13px] font-medium text-foreground-800">Agent</p>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-background-300 bg-background-50 px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="flex items-center gap-2"><b className="truncate text-sm text-foreground-900">{agent.name}</b><AgentStatusBadge status={agent.status} /></span>
                      <span className="block truncate text-xs text-foreground-500">{[agent.email, agent.role === "agency_admin" ? "Agency admin" : "Agent"].filter(Boolean).join(", ")}</span>
                    </span>
                    <button type="button" disabled={creating} onClick={() => setAgent(null)} className="rounded px-2 py-1 text-sm font-medium text-primary-700 hover:bg-background-100 disabled:opacity-60">Change</button>
                  </div>
                </>
              ) : (
                <SearchPick label="Agent" addNoun="agent" placeholder={`Search or pick an agent at ${chosenBusiness.name}`} resetKey={chosenBusiness.id} autoFocus searchWhenEmpty openOnMount
                  search={searchAgents}
                  onPick={(option) => setAgent((option as PickOption & { raw: BusinessAgentOption }).raw)}
                  onAddNew={role === "slit_admin" ? (name) => { setInitialAgentName(name); setRecordDialogMode("agent"); } : undefined} />
              )}
            </div>
          ) : null}

          {business && business.status !== "Active" && agent ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{business.name} will be activated when the application starts.</p>
          ) : null}
        </div>

        {error ? <div className="mt-4"><PortalError message={error} /></div> : null}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
          <Link to={paths.list} className={secondary}>Cancel</Link>
          <div className="flex flex-col-reverse gap-3 sm:ml-auto sm:flex-row">
            <button type="button" disabled={creating} onClick={() => { setError(""); setPhase("student"); }} className={secondary}>
              <i className="ri-arrow-left-line" aria-hidden="true" />
              Back
            </button>
            <button type="button" disabled={creating || !ready || !draft} onClick={() => { if (draft && agent) void start(draft, null, { business: chosenBusiness, agent }); }} className={primary}>
              {creating ? <><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Creating&hellip;</> : <>Next <i className="ri-arrow-right-line" aria-hidden="true" /></>}
            </button>
          </div>
        </div>
      </div>
      <AddStudentRecordDialog
        mode={recordDialogMode}
        business={chosenBusiness ? { id: chosenBusiness.id, name: chosenBusiness.name, status: chosenBusiness.status } : null}
        initialAgentName={initialAgentName}
        onCancel={() => setRecordDialogMode(null)}
        onSave={saveNewRecord}
      />
    </div>
  );
}
