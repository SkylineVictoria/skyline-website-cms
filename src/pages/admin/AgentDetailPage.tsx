import { useCallback, useEffect, useState } from "react";
import WhatsAppLink from "@/components/base/WhatsAppLink";
import { Link, useParams } from "react-router-dom";
import SubjectSigningPanel from "./components/signing/SubjectSigningPanel";
import { Button, Card, ConfirmDialog, PageHeader, Select } from "@/pages/admin/components/ui";
import { AgencyStatusBadge, ApplicationStatusPills } from "@/pages/admin/components/AgencyStatus";
import ActivateAgentDialog from "@/pages/admin/components/ActivateAgentDialog";
import AgentStatusBadge from "@/pages/admin/components/AgentStatusBadge";
import ApplicationsList from "@/pages/admin/components/ApplicationsList";
import { ListMessage } from "@/pages/admin/components/ListControls";
import { useToast } from "@/pages/admin/components/toastContext";
import { deactivateAgent, getAgentOverview, resendInvitation, type AgentOverview, awaitingPassword } from "@/pages/admin/lib/businessData";
import { groupByStudent } from "@/pages/admin/lib/businessGroups";
import { formatDate } from "@/pages/agency/lib/portalData";

/** Agencies > Agents > {name}. The id may be the agent record, the portal login or the OMARA record. */
export default function AgentDetailPage() {
  const { id = "" } = useParams();
  const { push } = useToast();
  const [agent, setAgent] = useState<AgentOverview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    try {
      const found = await getAgentOverview(id);
      setAgent(found);
      setState(found ? "ready" : "missing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load this agent.");
      setState("error");
    }
  }, [id]);
  useEffect(() => { setState("loading"); void load(); }, [load]);

  const deactivate = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      await deactivateAgent(agent.agentId);
      push(`${agent.name} deactivated. They can no longer sign in.`);
      await load();
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not deactivate this agent.", "error");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  const resend = async () => {
    if (!agent) return;
    setBusy(true);
    try {
      push(await resendInvitation({ ...agent, businessId: agent.business.id }));
      await load();
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not resend that invitation.", "error");
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return <p className="p-6 text-sm text-foreground-600">Loading agent&hellip;</p>;
  if (!agent) {
    return (
      <div>
        <PageHeader title="Agent not found" />
        <p role="alert" className="text-sm text-red-700">{state === "error" ? error : "This agent could not be found."}</p>
        <Link to="/admin/agents" className="mt-3 inline-block text-sm font-semibold text-primary-700 underline">Back to Agents</Link>
      </div>
    );
  }

  const shown = status ? agent.applications.filter((a) => a.status === status) : agent.applications;
  const groups = groupByStudent(shown, agent.students);
  const counts: Record<string, number> = {};
  for (const a of agent.applications) counts[a.status] = (counts[a.status] ?? 0) + 1;

  return (
    <div>
      <Link to="/admin/agents" className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-foreground-600 hover:text-foreground-900">
        <i className="ri-arrow-left-line" aria-hidden="true" /> Agents
      </Link>
      <PageHeader
        titleSuffix={<WhatsAppLink phone={agent.phone} name={agent.name} />}
        title={agent.name}
        description={[agent.marn ? `MARN ${agent.marn}` : null, agent.role === "agency_admin" ? "Agency admin" : "Agent", `with ${agent.business.name}`].filter(Boolean).join(", ")}
        actions={<>
          <AgentStatusBadge status={agent.status} />
          {awaitingPassword(agent) && agent.email
            ? <Button variant="outline" icon="ri-mail-send-line" disabled={busy} onClick={() => void resend()}>{busy ? "Sending…" : "Resend invite"}</Button>
            : null}
          {agent.status === "Inactive"
            ? <Button onClick={() => setDialog(true)}>Activate agent</Button>
            : <Button variant="outline" disabled={busy} onClick={() => setConfirm(true)}>Deactivate agent</Button>}
        </>}
      />
      {awaitingPassword(agent) ? (
        <p role="status" className="-mt-2 mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {agent.status === "Active" ? "Active" : "Waiting for their business to be approved"}{agent.statusChangedAt ? ` since ${formatDate(agent.statusChangedAt)}` : ""}. {agent.email || "They"} hasn't set a password yet, so they cannot sign in until they open the invitation email. Use Resend invite if they lost it.
        </p>
      ) : agent.status === "Inactive" ? (
        <p role="status" className="-mt-2 mb-5 rounded-md border border-background-300 bg-background-100 px-4 py-3 text-sm text-foreground-700">
          Inactive. Activate this agent to let them sign in.
        </p>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="p-4">
          <h2 className="mb-2 font-heading text-[15px] font-semibold text-foreground-900">Business</h2>
          <div className="space-y-1.5 text-sm">
            <Link to={`/admin/businesses/${agent.business.id}`} className="font-semibold text-foreground-900 hover:text-primary-700">{agent.business.name}</Link>
            <div><AgencyStatusBadge status={agent.business.status} /></div>
          </div>
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 font-heading text-[15px] font-semibold text-foreground-900">Migration agent registration</h2>
          {agent.marn ? (
            <p className="text-sm"><span className="text-foreground-500">MARN </span><b className="tabular-nums text-foreground-900">{agent.marn}</b></p>
          ) : <p className="text-sm text-foreground-600">No MARN recorded. Add one when activating the agent.</p>}
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 font-heading text-[15px] font-semibold text-foreground-900">Contact and sign-in</h2>
          <dl className="space-y-1.5 text-sm">
            <dd className={agent.email ? "text-foreground-900" : "text-foreground-500"}>{agent.email || "No email"}</dd>
            {agent.phone ? <dd className="text-foreground-900">{agent.phone}</dd> : null}
            <dd className="text-foreground-600">{agent.profileId ? "Has a portal login" : awaitingPassword(agent) ? "Hasn't set a password yet" : "No portal login"}</dd>
          </dl>
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-semibold text-foreground-900">Students and applications</h2>
        {agent.applications.length ? (
          <span className="flex flex-wrap items-center gap-3">
            <ApplicationStatusPills counts={counts} />
            <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
              <option value="">All statuses</option>
              {Object.keys(counts).map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} ({counts[s]})</option>)}
            </Select>
          </span>
        ) : null}
      </div>
      {groups.length === 0 ? (
        <Card><ListMessage icon="ri-user-line" title={status ? "No applications in this status" : "No students yet"}
          text={status ? "Choose another status." : "Students appear here when they are added to this agent."} /></Card>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <Card key={g.student.id}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-background-200 px-4 py-3">
                <div>
                  <Link to={`/admin/students/${g.student.id}`} className="font-heading text-[15px] font-semibold text-foreground-900 hover:text-primary-700">{g.student.name || "Unnamed student"}</Link>
                  {g.student.email ? <p className="text-xs text-foreground-500">{g.student.email}</p> : null}
                </div>
                <span className="text-xs text-foreground-600"><b className="text-foreground-900">{g.applications.length}</b> application{g.applications.length === 1 ? "" : "s"}</span>
              </div>
              <ApplicationsList rows={g.applications} />
            </Card>
          ))}
        </div>
      )}

      <div className="mt-4"><SubjectSigningPanel type="agent" id={agent.agentId} name={agent.name} /></div>

      <ActivateAgentDialog open={dialog} onClose={() => setDialog(false)} onDone={() => void load()}
        agent={{ agentId: agent.agentId, name: agent.name, email: agent.email, phone: agent.phone, marn: agent.marn, role: agent.role,
          hasLogin: Boolean(agent.profileId), business: agent.business }} />
      <ConfirmDialog open={confirm} title={`Deactivate ${agent.name}?`}
        message="They will not be able to sign in, and an invitation still waiting is withdrawn. Their students and applications stay with the business. You can activate them again at any time."
        confirmLabel={busy ? "Deactivating…" : "Deactivate agent"} onConfirm={() => { if (!busy) void deactivate(); }} onCancel={() => { if (!busy) setConfirm(false); }} />
    </div>
  );
}
