import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { listAgencies } from "@/pages/agency/lib/portalData";
import {
  createApplication,
  getApplication,
  listAssignableAgents,
  type AgentOption,
} from "@/pages/agency/lib/portalApplications";
import ApplicationWizard from "@/pages/agency/components/ApplicationWizard";
import { isEditableApplicationStatus } from "@/pages/agency/lib/applicationAccess";
import { PageHeading, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";

import { portalScopeCacheKey } from "@/lib/portalScope";

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

type Phase = "checking" | "pick" | "wizard";

export default function NewApplicationPage() {
  const { role, agency, authUser, authLoading, identityLoading } = usePortalAuth();
  const navigate = useNavigate();

  const clientKeyRef = useRef(newClientKey());
  const bootRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("checking");
  const [applicationId, setApplicationId] = useState("");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agencies, setAgencies] = useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = useState("");
  const [agencyId, setAgencyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const startDraft = useCallback(
    async (assignedAgentId: string | null, selectedAgencyId?: string | null): Promise<string> => {
      const { id } = await createApplication(clientKeyRef.current, assignedAgentId, selectedAgencyId);
      clientKeyRef.current = newClientKey();
      if (authUser?.id) writeSession(authUser.id, id);
      return id;
    },
    [authUser?.id],
  );

  // Resolve an existing wizard session, or create a fresh draft.
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
          if (app && isEditableApplicationStatus(app.status)) {
            setApplicationId(app.id);
            setPhase("wizard");
            return;
          }
          clearSession(authUser.id);
        }

        if (role === "agent") {
          setCreating(true);
          const id = await startDraft(null);
          setApplicationId(id);
          setPhase("wizard");
        } else {
          setPhase("pick");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "We could not start a new application.");
        setPhase(role === "agent" ? "checking" : "pick");
        bootRef.current = false;
      } finally {
        setCreating(false);
      }
    })();
  }, [authLoading, identityLoading, role, authUser, startDraft]);

  useEffect(() => {
    if (phase !== "pick") return;
    const selectedAgency = role === "slit_admin" ? agencyId : agency?.id;
    if (role === "slit_admin") {
      void listAgencies().then((items) => setAgencies(items.map((item) => ({ id: item.id, name: item.name })))).catch(() => setAgencies([]));
    }
    if (!selectedAgency) { setAgents([]); return; }
    void listAssignableAgents(selectedAgency).then(setAgents).catch(() => setAgents([]));
  }, [phase, role, agency?.id, agencyId]);

  const handlePick = async () => {
    setCreating(true);
    setError("");
    try {
      if (role === "slit_admin" && !agencyId) {
        setError("Select an agency before creating an application.");
        return;
      }
      const id = await startDraft(agentId || null, role === "slit_admin" ? agencyId : null);
      setApplicationId(id);
      setPhase("wizard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not start a new application.");
    } finally {
      setCreating(false);
    }
  };

  const handleFinish = () => {
    if (authUser?.id) clearSession(authUser.id);
    navigate(`/agency/applications/${applicationId}`, { replace: true });
  };

  const handleCancel = async () => {
    const uid = authUser?.id;
    if (uid) clearSession(uid);
    // A new draft has a real reference and must remain available even if the
    // document wizard is closed before any field is filled.
    navigate(`/agency/applications/${applicationId}`, { replace: true });
  };

  if (authLoading || identityLoading || phase === "checking") {
    return (
      <div>
        <PageHeading
          eyebrow="Add New Form"
          title="Starting a new application"
          description="Student details always start empty and are only ever filled from the documents you upload."
        />
        <div className="mt-6">
          {error ? (
            <div className="space-y-3">
              <PortalError message={error} />
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
              >
                <i className="ri-refresh-line" aria-hidden="true" />
                Try again
              </button>
            </div>
          ) : (
            <PortalLoading label={creating ? "Preparing your blank application\u2026" : "Opening\u2026"} />
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

  // Agency Admin: choose an agent before the wizard opens.
  return (
    <div>
      <PageHeading
        eyebrow="Add New Form"
        title="New student application"
        description="Creates a blank international student application. The agent and agency are filled in from your account — student details always start empty."
      />

      <div className="mt-6 max-w-2xl rounded-card border border-background-200 bg-background-50 p-6">
        <h2 className="font-heading text-base font-semibold text-foreground-950">Who is this application for?</h2>
        <p className="mt-1.5 text-sm text-foreground-600">
          Assign the application to an active agent in {role === "slit_admin" ? "the selected agency" : agency?.name ?? "your agency"}, or leave it unassigned and
          allocate it later. The document wizard opens next.
        </p>

        {role === "slit_admin" ? (
          <div className="mt-5">
            <label htmlFor="new-app-agency" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-foreground-700">Agency</label>
            <select id="new-app-agency" value={agencyId} onChange={(event) => { setAgencyId(event.target.value); setAgentId(""); }} className="w-full rounded-md border border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40">
              <option value="">Select an agency</option>
              {agencies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        ) : null}

        <div className="mt-5">
          <label htmlFor="new-app-agent" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-foreground-700">
            Assigned agent
          </label>
          <select
            id="new-app-agent"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            className="w-full rounded-md border border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40"
          >
            <option value="">Leave unassigned</option>
            {agents.map((agent) => (
              <option key={agent.profileId} value={agent.profileId}>
                {agent.fullName}
                {agent.email ? ` (${agent.email})` : ""}
              </option>
            ))}
          </select>
        </div>

        {error ? (
          <div className="mt-4">
            <PortalError message={error} />
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            disabled={creating}
            onClick={() => void handlePick()}
            className="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? (
              <>
                <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
                Creating&hellip;
              </>
            ) : (
              <>
                <i className="ri-magic-line" aria-hidden="true" />
                Start with document wizard
              </>
            )}
          </button>
          <Link
            to="/agency/applications"
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-background-300 px-5 py-3 text-sm font-semibold text-foreground-800 transition-colors hover:bg-background-100"
          >
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
