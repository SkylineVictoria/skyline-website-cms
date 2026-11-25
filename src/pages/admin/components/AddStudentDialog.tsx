import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Modal } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import SearchPick, { type PickOption } from "@/pages/admin/components/SearchPick";
import AgentStatusBadge from "@/pages/admin/components/AgentStatusBadge";
import AddStudentRecordDialog, { type AddStudentRecordValue } from "@/pages/admin/components/AddStudentRecordDialog";
import StudentDetailsStep, { type StudentDraft } from "@/pages/agency/components/StudentDetailsStep";
import { activateAgent, listBusinesses, setBusinessStatus, type BusinessStatus } from "@/pages/admin/lib/businessData";
import { createApplicationForStudent, createStudentDraft, listAgentsOfBusiness, sendApplicationInvitation, type BusinessAgentOption, type StudentMatch } from "@/pages/agency/lib/portalApplications";
import { isEmailTakenError } from "@/lib/identity/email";

function newClientKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type Business = { id: string; name: string; status: BusinessStatus };

/**
 * SLIT admin: add a student down the chain. Choose the business, then the agent who looks after them, then the student's
 * email. The student and an application draft are saved together
 * (/admin/applications/:id?wizard=1), as before.
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

  useEffect(() => {
    if (!open) return;
    setBusiness(presetBusiness ?? null); setAgent(null); setRecordDialogMode(null); setInitialAgentName(""); setError("");
  }, [open, presetBusiness]);

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
    return (await listAgentsOfBusiness(businessId))
      .filter((a) => a.status === "Active")
      .filter((a) => { const text = `${a.name} ${a.email} ${a.role === "agency_admin" ? "business admin agent" : "agent"}`.toLowerCase(); return words.every((w) => text.includes(w)); })
      .map((a) => ({ id: a.id, label: a.name, meta: [a.email, a.role === "agency_admin" ? "Business admin agent" : "Agent"].filter(Boolean).join(", "), tag: <AgentStatusBadge status={a.status} />, raw: a }));
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

  // Adding a student creates the record, then starts their application and opens the wizard (owner, 2026-11-23).
  const finish = async (draft: StudentDraft, existing: StudentMatch | null) => {
    if (!business || !agent) return;
    setBusy(true);
    setError("");
    setEmailError(null);
    const notes: string[] = [];
    try {
      if (business.status !== "Active") {
        await setBusinessStatus(business.id, "Active");
        notes.push(`${business.name} was activated.`);
      }
      if (agent.status === "Inactive") {
        await activateAgent({ agentId: agent.id, businessId: business.id, name: agent.name, email: agent.email, role: agent.role });
        notes.push(`${agent.name} was activated.`);
      }
      const key = newClientKey();
      const applicationId = existing
        ? (await createApplicationForStudent(key, existing.id)).id
        : await createStudentDraft(draft.email, agent.id, key);
      if (draft.invite) {
        try {
          await sendApplicationInvitation(applicationId);
          notes.push("Application invitation sent.");
        } catch (e) {
          notes.push(e instanceof Error ? e.message : "Invitation failed. Try again from Finish Application.");
        }
      }
      push(["Application draft saved.", ...notes].join(" "));
      onAdded?.();
      onClose();
      navigate(`/admin/applications/${applicationId}${draft.invite ? "" : "?wizard=1"}`);
    } catch (e) {
      if (isEmailTakenError(e)) { setEmailError(e); return; }
      setError(e instanceof Error ? e.message : "We could not add this student.");
    } finally {
      setBusy(false);
    }
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
  return (<>
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} width="max-w-2xl" title="Add student"
      footer={ready ? undefined : <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>}>
      <div className="space-y-5">
        {!ready ? <p className="text-sm text-foreground-600">Choose the business and the agent who looks after the student, then enter the student's email address.</p> : null}

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
                onPick={(o) => setAgent((o as PickOption & { raw: BusinessAgentOption }).raw)}
                onAddNew={(name) => { setInitialAgentName(name); setRecordDialogMode("agent"); }} />
            )}
          </div>
        ) : null}

        {/* Student */}
        {ready ? (
          <div className="border-t border-background-200 pt-5">
            <StudentDetailsStep busy={busy} error={error} context="admin" emailError={emailError}
              onContinue={(draft, existing) => void finish(draft, existing)}
              cancel={<Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>} />
          </div>
        ) : error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      </div>
    </Modal>
    <AddStudentRecordDialog mode={recordDialogMode} initialAgentName={initialAgentName}
      business={business ? { id: business.id, name: business.name, status: business.status } : null}
      onCancel={() => setRecordDialogMode(null)} onSave={saveNewRecord} />
  </>);
}
