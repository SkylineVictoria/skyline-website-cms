import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { useToast } from "@/pages/admin/components/toastContext";
import StudentDetailsStep, { type StudentDraft } from "@/pages/agency/components/StudentDetailsStep";
import {
  createApplicationForStudent,
  getApplication,
  sendApplicationInvitation, saveWizardDraft, INVITE_SMS_LABEL,
  studentAgencyOptions,
  chooseStudentAgency,
  changeStudentAgent,
  listInstitutionCourses,
  type ApplicationCourseRow,
  type StudentAgencyOptions,
} from "@/pages/agency/lib/portalApplications";
import { useApplicationPaths } from "@/pages/agency/lib/applicationPaths";
import ApplicationWizard from "@/pages/agency/components/ApplicationWizard";
import { isEditableStatus, loadApplicationStatuses } from "@/lib/applicationStatuses";
import { PageHeading, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";

import { portalScopeCacheKey } from "@/lib/portalScope";
import SearchableSelect from "@/components/ui/SearchableSelect";
import IntakeSelect from "@/pages/agency/components/IntakeSelect";
import type { OpenIntake } from "@/pages/agency/lib/intakes";

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

type Phase = "checking" | "student" | "agency" | "wizard";

/**
 * New application: the student first, picked from the students the caller may see or added from the picker's last row
 * (STUDENT-PICKER, owner 2026-11-27; a new student is saved under their agent there), then the application is created for them.
 * A student starting their own application chooses their agent, course and start date instead.
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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  // A self-enrolled student's first application: are they working with an education agency?
  const [agencyChoices, setAgencyChoices] = useState<Array<{ id: string; name: string }>>([]);
  const [withAgency, setWithAgency] = useState<boolean | null>(null);
  const [chosenBusinessId, setChosenBusinessId] = useState("");
  const [agentChoices, setAgentChoices] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [chosenAgentId, setChosenAgentId] = useState("");
  const [agentsLoading, setAgentsLoading] = useState(false);
  // STUDENT-NEW-APPLICATION-AGENT: who the student is with now (their agent preselected; same business only).
  const [studentOptions, setStudentOptions] = useState<StudentAgencyOptions | null>(null);
  const withBusiness = Boolean(studentOptions?.current && !studentOptions.current.direct);
  // The course and start date are chosen on the same screen; the application then opens as the one page to check and sign.
  const [courseRows, setCourseRows] = useState<ApplicationCourseRow[] | null>(null);
  const [chosenCourseId, setChosenCourseId] = useState("");
  const [chosenIntake, setChosenIntake] = useState<OpenIntake | null>(null);
  useEffect(() => {
    if (phase !== "agency" || courseRows) return;
    listInstitutionCourses().then(setCourseRows, (e: unknown) => { setCourseRows([]); setError(e instanceof Error ? e.message : "The courses could not be loaded."); });
  }, [phase, courseRows]);

  const openWizard = (id: string) => {
    if (authUser?.id) writeSession(authUser.id, id);
    setApplicationId(id);
    setPhase("wizard");
  };

  // STUDENT-PICKER: the student is always one on record (picked, or added from the picker); the application is created for them.
  const start = async (draftValue: StudentDraft) => {
    setDraft(draftValue);
    setCreating(true);
    setError("");
    try {
      const key = clientKeyRef.current;
      const id = (await createApplicationForStudent(key, draftValue.student.id)).id;
      clientKeyRef.current = newClientKey();
      // CONTACT-LINKS: the mobile from the first screen goes on the application (the invitation texts it from there).
      if (draftValue.mobile) await saveWizardDraft(id, { values: { mobile: draftValue.mobile } }).catch(() => push("The mobile could not be saved. Add it in the application.", "error"));
      if (draftValue.invite) {
        try {
          const sms = await sendApplicationInvitation(id, undefined, Boolean(draftValue.sendText));
          push(["Application invitation sent by email.", INVITE_SMS_LABEL[sms]].filter(Boolean).join(" "));
        } catch (e) {
          push(e instanceof Error ? e.message : "Invitation failed. Try again from Finish Application.", "error");
        }
        navigate(paths.detail(id), { replace: true });
      } else {
        openWizard(id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not start a new application.");
    } finally {
      setCreating(false);
    }
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
            setPhase("wizard");
            return;
          }
          clearSession(authUser.id);
        }
        if (role === "student") {
          // A student starts their own application: no student step, no agent to choose.
          if (!studentId) throw new Error("Your student record could not be found. Ask your agent or SLIT Administration.");
          // Every new application starts with: are you working with an agent? (owner 2026-11-26)
          const options = await studentAgencyOptions().catch(() => null);
          setStudentOptions(options);
          if (options?.ask) setAgencyChoices(options.businesses);
          if (options?.current && !options.current.direct) {
            setWithAgency(true);
            setAgentChoices(options.agents);
            setChosenAgentId(options.current.agentId ?? "");
          }
          setPhase("agency");
          return;
        }
        setPhase("student");
      } catch (e) {
        setError(e instanceof Error ? e.message : "We could not start a new application.");
        setPhase(role === "student" ? "checking" : "student");
        bootRef.current = false;
      }
    })();
  }, [authLoading, identityLoading, role, studentId, authUser]);

  const handleFinish = () => {
    if (authUser?.id) clearSession(authUser.id);
    // Submitted from the wizard: on to the applications list (the review queue), not the form.
    navigate(paths.list, { replace: true });
  };

  const handleCancel = () => {
    if (authUser?.id) clearSession(authUser.id);
    navigate(paths.list, { replace: true });
  };

  // The student picked a business: its active agents are listed (a student with a business already has theirs).
  useEffect(() => {
    if (withBusiness) return;
    if (phase !== "agency" || !chosenBusinessId) { setAgentChoices([]); return; }
    let active = true;
    setAgentsLoading(true);
    studentAgencyOptions(chosenBusinessId)
      .then((options) => { if (active) setAgentChoices(options.agents); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "We could not load the agents."); })
      .finally(() => { if (active) setAgentsLoading(false); });
    return () => { active = false; };
  }, [phase, chosenBusinessId, withBusiness]);

  // "No, by myself" starts the application under SLIT; "Yes" first moves the student under the chosen business and agent.
  const startAsStudent = async (choice: { businessId: string; agentId: string } | null) => {
    if (!studentId) return;
    setCreating(true);
    setError("");
    try {
      if (choice && withBusiness) {
        // Same business only: another agent of the student's own business.
        if (choice.agentId !== studentOptions?.current?.agentId) {
          const changed = await changeStudentAgent(choice.agentId);
          push(`${changed.agentName} now looks after you.`);
        }
      } else if (choice) {
        const moved = await chooseStudentAgency(choice.businessId, choice.agentId);
        await reloadIdentity();
        push(`You are now recorded with ${moved.businessName}${moved.agentName ? `, looked after by ${moved.agentName}` : ""}.`);
      }
      const { id } = await createApplicationForStudent(clientKeyRef.current, studentId);
      clientKeyRef.current = newClientKey();
      // The chosen course and start date are saved first. The application page then opens the document wizard for a student's
      // first application (the whole application is finished there), or the one page for a returning student (course and intake).
      const course = courseRows?.find((row) => row.courseId === chosenCourseId) ?? null;
      if (course && chosenIntake) {
        await saveWizardDraft(id, {
          values: { courses_of_interest: [`${course.code} - ${course.title}`], preferred_intake: chosenIntake.display, intake_id: chosenIntake.id ?? "", intake_join_date: chosenIntake.joinDate ?? "" },
          courses: [{ ...course, intakeId: chosenIntake.id ?? undefined }],
        });
      }
      if (authUser?.id) clearSession(authUser.id);
      navigate(paths.detail(id), { replace: true });
    } catch (e) {
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
        agencyName={agency?.name ?? ""}
        onFinish={handleFinish}
        onCancel={() => void handleCancel()}
      />
    );
  }

  if (phase === "agency") {
    const selectClass = "w-full rounded-md border border-background-300 bg-background-50 px-3 py-2.5 text-sm text-foreground-900 focus:border-primary-500 focus:outline-none disabled:opacity-60";
    const current = studentOptions?.current ?? null;
    const ask = studentOptions?.ask ?? agencyChoices.length > 0;
    // Yes: a student with a business picks among its agents; a direct student with no application picks a business and agent.
    const yesBlocked = withAgency === true && !withBusiness && !ask;
    const noBlocked = withAgency === false && withBusiness;
    const canContinue = !creating && withAgency !== null && !yesBlocked && !noBlocked && Boolean(chosenCourseId && chosenIntake)
      && (withAgency === false || Boolean((withBusiness || chosenBusinessId) && chosenAgentId));
    const go = () => void startAsStudent(withAgency ? { businessId: withBusiness ? current?.businessId ?? "" : chosenBusinessId, agentId: chosenAgentId } : null);
    return (
      <div>
        <PageHeading
          eyebrow="New application"
          title="Before you start"
          description="Tell us who is helping you with this application."
        />
        <div className="mt-6 max-w-2xl rounded-card border border-background-200 bg-background-50 p-6">
          <h2 className="font-heading text-base font-semibold text-foreground-950">Are you working with an agent?</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button type="button" disabled={creating} onClick={() => setWithAgency(true)} data-testid="student-agent-yes"
              className={`cursor-pointer rounded-md border px-4 py-3 text-left text-sm transition-colors disabled:opacity-60 ${withAgency === true ? "border-primary-500 bg-primary-50 text-foreground-950" : "border-background-300 text-foreground-800 hover:bg-background-100"}`}>
              <b className="block font-semibold">Yes</b><span className="text-foreground-600">An agent is helping me apply.</span>
            </button>
            <button type="button" disabled={creating} onClick={() => setWithAgency(false)} data-testid="student-agent-no"
              className={`cursor-pointer rounded-md border px-4 py-3 text-left text-sm transition-colors disabled:opacity-60 ${withAgency === false ? "border-primary-500 bg-primary-50 text-foreground-950" : "border-background-300 text-foreground-800 hover:bg-background-100"}`}>
              <b className="block font-semibold">No</b><span className="text-foreground-600">I am applying by myself.</span>
            </button>
          </div>

          {withAgency && withBusiness ? (
            <div className="mt-5 space-y-4">
              <div>
                <p className="mb-1.5 text-label font-medium text-foreground-800">Agency</p>
                <p className="rounded-md border border-background-200 bg-background-100 px-3 py-2.5 text-sm text-foreground-900">{current?.businessName}</p>
              </div>
              <div>
                <label htmlFor="student-agent" className="mb-1.5 block text-label font-medium text-foreground-800">Agent <span className="text-primary-600">*</span></label>
                <SearchableSelect id="student-agent" className={selectClass} value={chosenAgentId} disabled={creating}
                  onChange={(e) => setChosenAgentId(e.target.value)}>
                  <option value="">{agentChoices.length ? "Select your agent" : "Your agency has no active agents"}</option>
                  {agentChoices.map((a) => <option key={a.id} value={a.id}>{a.name}{a.role === "agency_admin" ? " (business admin agent)" : ""}{a.id === current?.agentId ? " · your agent" : ""}</option>)}
                </SearchableSelect>
                <p className="mt-1 text-xs text-foreground-500">Your agent from before is chosen. You can pick any agent of {current?.businessName}.
                  {" "}Not happy with any of them? <Link to="/agency/messages" className="font-semibold text-primary-700 underline-offset-2 hover:underline">Message SLIT</Link>.</p>
              </div>
            </div>
          ) : withAgency && ask ? (
            <div className="mt-5 space-y-4">
              <div>
                <label htmlFor="student-business" className="mb-1.5 block text-label font-medium text-foreground-800">Business <span className="text-primary-600">*</span></label>
                <SearchableSelect id="student-business" className={selectClass} value={chosenBusinessId} disabled={creating}
                  onChange={(e) => { setChosenBusinessId(e.target.value); setChosenAgentId(""); }}>
                  <option value="">Select your agency</option>
                  {agencyChoices.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </SearchableSelect>
                {agencyChoices.length === 0 ? <p className="mt-1 text-xs text-foreground-500">No agencies are registered yet. Choose No to apply by yourself.</p> : null}
              </div>
              <div>
                <label htmlFor="student-agent" className="mb-1.5 block text-label font-medium text-foreground-800">Agent <span className="text-primary-600">*</span></label>
                <SearchableSelect id="student-agent" className={selectClass} value={chosenAgentId} disabled={creating || !chosenBusinessId || agentsLoading}
                  onChange={(e) => setChosenAgentId(e.target.value)}>
                  <option value="">{!chosenBusinessId ? "Choose the business first" : agentsLoading ? "Loading agents…" : agentChoices.length ? "Select your agent" : "This business has no active agents"}</option>
                  {agentChoices.map((a) => <option key={a.id} value={a.id}>{a.name}{a.role === "agency_admin" ? " (business admin agent)" : ""}</option>)}
                </SearchableSelect>
                <p className="mt-1 text-xs text-foreground-500">Your agent is not listed? Ask them to register with SLIT, or choose No for now.</p>
              </div>
            </div>
          ) : null}

          {yesBlocked ? <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">You applied to SLIT directly before. To work with an agency now, <Link to="/agency/messages" className="font-semibold underline">message SLIT</Link> to link you to it.</p> : null}
          {noBlocked ? <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">You are recorded with {current?.businessName}{current?.agentName ? ` (${current.agentName})` : ""}. To apply without an agent, <Link to="/agency/messages" className="font-semibold underline">message SLIT</Link>, or choose Yes.</p> : null}

          {withAgency !== null && !yesBlocked && !noBlocked ? (
            <div className="mt-6 space-y-4 border-t border-background-200 pt-5" data-testid="student-course-intake">
              <h2 className="font-heading text-base font-semibold text-foreground-950">Course and start date</h2>
              <div>
                <label htmlFor="student-course" className="mb-1.5 block text-label font-medium text-foreground-800">Course <span className="text-primary-600">*</span></label>
                <SearchableSelect id="student-course" className={selectClass} value={chosenCourseId} disabled={creating || !courseRows}
                  onChange={(e) => { setChosenCourseId(e.target.value); setChosenIntake(null); }}>
                  <option value="">{!courseRows ? "Loading courses…" : courseRows.length ? "Select a course" : "No course is open for applications"}</option>
                  {(courseRows ?? []).map((row) => <option key={row.courseId} value={row.courseId}>{row.code} - {row.title}</option>)}
                </SearchableSelect>
              </div>
              <div>
                <label htmlFor="student-intake" className="mb-1.5 block text-label font-medium text-foreground-800">Start date <span className="text-primary-600">*</span></label>
                <IntakeSelect id="student-intake" courseId={chosenCourseId || null} value={chosenIntake ? (chosenIntake.id ? (chosenIntake.joinDate ? `${chosenIntake.id}@${chosenIntake.joinDate}` : chosenIntake.id) : `month:${chosenIntake.display}`) : ""}
                  onChange={setChosenIntake} disabled={creating || !chosenCourseId} className={selectClass} />
              </div>
              <p className="text-xs text-foreground-500">Continue opens your application with every detail on one page: check it, change what you need, then sign.</p>
            </div>
          ) : null}

          {error ? <div className="mt-4"><PortalError message={error} /></div> : null}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Link to={paths.list} className={secondary}>Cancel</Link>
            <button type="button" disabled={!canContinue} onClick={go} className={primary} data-testid="student-agent-continue">
              {creating ? "Starting…" : "Continue"}
              <i className="ri-arrow-right-line" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeading
        eyebrow="Add New Form"
        title="New student application"
        description="Start with the student. Search for a student on record, or add a new one from the last row of the list."
      />
      <div className="mt-6 w-full max-w-2xl rounded-card border border-background-200 bg-background-50 p-4 sm:p-6">
        <StudentDetailsStep initial={draft ?? undefined} busy={creating} error={error}
          role={role === "slit_admin" ? "slit_admin" : role === "agency_admin" ? "agency_admin" : "agent"}
          agency={agency ? { id: agency.id, name: agency.name } : null} profileId={profile?.id ?? null}
          onContinue={(value) => void start(value)}
          cancel={<Link to={paths.list} className={secondary}>Cancel</Link>} />
      </div>
    </div>
  );
}
