import ResponsiveTable from "@/components/ui/ResponsiveTable";
import WhatsAppLink from "@/components/base/WhatsAppLink";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Button, Card, ConfirmDialog, PageHeader } from "@/pages/admin/components/ui";
import { AgencyStatusBadge, ApplicationStatusPills } from "@/pages/admin/components/AgencyStatus";
import { ListMessage } from "@/pages/admin/components/ListControls";
import StudentsTable from "@/pages/admin/components/StudentsTable";
import ActivateAgentDialog from "@/pages/admin/components/ActivateAgentDialog";
import BusinessOnboarding from "@/pages/admin/components/BusinessOnboarding";
import AgentStatusBadge from "@/pages/admin/components/AgentStatusBadge";
import { toActivate, type AgentToActivate } from "@/pages/admin/lib/agentActivation";
import { useToast } from "@/pages/admin/components/toastContext";
import { ApplicationsTab, DetailsTab } from "@/pages/admin/AgencyDetailPage";
import { awaitingPassword, changeBusinessStatus, deactivateAgent, getBusiness, resendInvitation, listBusinessAgents, type BusinessDetail, type BusinessStatus, type DirectoryAgent } from "@/pages/admin/lib/businessData";
import { formatDate, getAgency, type AgencySummary } from "@/pages/agency/lib/portalData";

type Tab = "details" | "agents" | "students" | "applications";
const TAB_IDS: Tab[] = ["details", "agents", "students", "applications"];

/** Agencies > Businesses > {name}: the business, its agents, their students and the students' applications. The tab lives in the URL. */
export default function BusinessDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as Tab | null;
  const { push } = useToast();
  const [business, setBusiness] = useState<BusinessDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const found = await getBusiness(id);
      setBusiness(found);
      if (!found) setError("This business could not be found.");
    } catch (e) {
      setBusiness(null);
      setError(e instanceof Error ? e.message : "We could not load this business.");
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { setBusiness(null); void load(); }, [load]);

  const change = async (next: BusinessStatus) => {
    if (!business) return;
    setBusy(true);
    try {
      push(await changeBusinessStatus(business, next));
      await load();
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not change this business’s status.", "error");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  if (loading && !business) return <p className="p-6 text-sm text-foreground-600">Loading business&hellip;</p>;
  if (!business) {
    return (
      <div>
        <PageHeader title="Business not found" />
        <p role="alert" className="text-sm text-red-700">{error || "This business could not be found."}</p>
        <Link to="/admin/businesses" className="mt-3 inline-block text-sm font-semibold text-primary-700 underline">Back to Businesses</Link>
      </div>
    );
  }

  const tab: Tab = requested && TAB_IDS.includes(requested) ? requested : "details";
  const agency = business.agency;
  const c = business.counts;
  const people = c.admins + c.agents;
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "details", label: "Details" },
    { id: "agents", label: "Agents", count: people + c.inactiveAgents },
    { id: "students", label: "Students", count: c.students },
    { id: "applications", label: "Applications", count: c.applications },
  ];

  return (
    <div>
      <Link to="/admin/businesses" className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-foreground-600 hover:text-foreground-900">
        <i className="ri-arrow-left-line" aria-hidden="true" /> Businesses
      </Link>
      <PageHeader
        title={business.name}
        description={[agency.registrationNumber ? `ABN ${agency.registrationNumber}` : agency.code, agency.address, `since ${formatDate(agency.createdAt)}`].filter(Boolean).join(", ")}
        actions={
          <>
            <AgencyStatusBadge status={business.status} />
            {business.status === "Active"
              ? <Button variant="outline" disabled={busy} onClick={() => setConfirm(true)}>Deactivate business</Button>
              : <Button disabled={busy || !business.onboarding?.agreementReady} title={business.onboarding?.agreementReady ? undefined : "Needs the signed agent agreement"}
                onClick={() => void change("Active")}>{busy ? "Activating…" : "Activate & invite"}</Button>}
          </>
        }
      />

      {business.status !== "Active" ? (
        <BusinessOnboarding business={business} onChanged={load} onActivate={() => void change("Active")} activating={busy} />
      ) : null}

      <dl className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-background-200 bg-background-200 lg:grid-cols-3">
        <Summary label="Agents" value={people} note={`${c.admins} business admin agent${c.admins === 1 ? "" : "s"}, ${c.agents} other agent${c.agents === 1 ? "" : "s"}${c.inactiveAgents ? `, ${c.inactiveAgents} inactive` : ""}`}
          warn={c.admins === 0} onClick={() => setParams({ tab: "agents" })} />
        <Summary label="Students" value={c.students} onClick={() => setParams({ tab: "students" })} />
        <div className="bg-background-50 px-4 py-3">
          <dt className="text-xs text-foreground-500">Applications</dt>
          <dd className="mt-1">
            <button type="button" onClick={() => setParams({ tab: "applications" })} className="font-heading text-xl font-bold tabular-nums text-foreground-950 hover:text-primary-700">{c.applications}</button>
            <div className="mt-1.5"><ApplicationStatusPills counts={business.statusCounts} hrefFor={(s) => `/admin/businesses/${business.id}?tab=applications&status=${s}`} /></div>
          </dd>
        </div>
      </dl>

      <nav className="mb-5 flex flex-wrap gap-1 border-b border-background-200" aria-label="Business sections">
        {tabs.map((item) => (
          <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => setParams(item.id === "details" ? {} : { tab: item.id })}
            className={`-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-sm font-medium ${tab === item.id ? "border-primary-500 text-primary-700" : "border-transparent text-foreground-600 hover:text-foreground-900"}`}>
            {item.label}
            {item.count !== undefined ? <span className="ml-1.5 rounded-full bg-background-200 px-1.5 py-0.5 text-2xs tabular-nums text-foreground-700">{item.count}</span> : null}
          </button>
        ))}
      </nav>

      {tab === "details" ? <DetailsSection agencyId={agency.id} onSaved={load} /> : null}
      {tab === "details" && business.status === "Active" ? <div className="mt-6"><BusinessOnboarding business={business} onChanged={load} /></div> : null}
      {tab === "agents" ? <AgentsSection business={{ id: business.id, name: business.name, status: business.status }} onChanged={load} /> : null}
      {tab === "students" ? <StudentsTable businessId={business.id} emptyText="Students appear here when this business’s agents add them." /> : null}
      {tab === "applications" ? <ApplicationsTab key={`${agency.id}:${params.get("status") ?? ""}`} agencyId={agency.id} initialStatus={params.get("status") ?? ""} /> : null}

      <ConfirmDialog
        open={confirm}
        title={`Deactivate ${business.name}?`}
        message={`Its ${people} agent${people === 1 ? "" : "s"} will not be able to sign in. Students, applications and history are kept, and you can activate it again at any time.`}
        confirmLabel={busy ? "Deactivating…" : "Deactivate business"}
        onConfirm={() => { if (!busy) void change("Inactive"); }}
        onCancel={() => { if (!busy) setConfirm(false); }}
      />
    </div>
  );
}

function Summary({ label, value, note, warn = false, onClick }: { label: string; value: number; note?: string; warn?: boolean; onClick: () => void }) {
  return (
    <div className="bg-background-50 px-4 py-3">
      <dt className="text-xs text-foreground-500">{label}</dt>
      <dd className="mt-1">
        <button type="button" onClick={onClick} className="font-heading text-xl font-bold tabular-nums text-foreground-950 hover:text-primary-700">{value}</button>
        {note ? <p className={`mt-0.5 text-xs ${warn ? "font-medium text-amber-700" : "text-foreground-600"}`}>{warn ? `No active business admin agent yet. ${note}` : note}</p> : null}
      </dd>
    </div>
  );
}

function DetailsSection({ agencyId, onSaved }: { agencyId: string; onSaved: () => Promise<void> }) {
  const [agency, setAgency] = useState<AgencySummary | null>(null);
  useEffect(() => {
    let active = true;
    void getAgency(agencyId).then((found) => { if (active) setAgency(found); }).catch(() => { if (active) setAgency(null); });
    return () => { active = false; };
  }, [agencyId]);
  return agency ? <DetailsTab key={agency.id} agency={agency} onSaved={onSaved} /> : <p className="text-sm text-foreground-600">Loading details&hellip;</p>;
}

/** The business's agents: add, activate, deactivate, and resend a sign-in invitation still waiting. */
function AgentsSection({ business, onChanged }: { business: { id: string; name: string; status: BusinessStatus }; onChanged: () => Promise<void> }) {
  const { push } = useToast();
  const [rows, setRows] = useState<DirectoryAgent[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [activating, setActivating] = useState<AgentToActivate | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState<DirectoryAgent | null>(null);
  const [busyId, setBusyId] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    listBusinessAgents(business.id).then((r) => { if (active) setRows(r); }).catch((e) => { if (active) setError(e instanceof Error ? e.message : "We could not load agents."); });
    return () => { active = false; };
  }, [business.id, reload]);
  const refresh = () => { setReload((n) => n + 1); void onChanged(); };
  const openDialog = (agent: AgentToActivate | null) => { setActivating(agent); setDialogOpen(true); };
  const deactivate = async (row: DirectoryAgent) => {
    setBusyId(row.agentId);
    try {
      await deactivateAgent(row.agentId);
      push(`${row.name} deactivated.`);
      refresh();
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not deactivate this agent.", "error");
    } finally {
      setBusyId("");
      setConfirm(null);
    }
  };
  const resend = async (row: DirectoryAgent) => {
    setBusyId(row.agentId);
    try {
      push(await resendInvitation(row));
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not resend that invitation.", "error");
    } finally {
      setBusyId("");
    }
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-background-200 px-4 py-3">
        <p className="text-sm text-foreground-600">Agents of {business.name}. Each agent has their own students; activating an agent can send their sign-in invitation.</p>
        {business.status === "Active" ? <Button size="sm" icon="ri-user-add-line" onClick={() => openDialog({ name: "", email: "", business })}>Add agent</Button>
          : <span className="text-xs font-medium text-amber-700">Agents can be added once the business is activated.</span>}
      </div>
      {error ? <ListMessage icon="ri-error-warning-line" title="Agents did not load" text={error} action={<Button size="sm" variant="outline" onClick={() => setReload((n) => n + 1)}>Try again</Button>} />
        : rows === null ? <p className="p-6 text-sm text-foreground-500">Loading agents…</p>
        : rows.length === 0 ? <ListMessage icon="ri-team-line" title="No agents yet" text={business.status === "Active" ? "Add this business's first agent." : "Activate the business first."} action={business.status === "Active" ? <Button size="sm" onClick={() => openDialog({ name: "", email: "", business })}>Add agent</Button> : undefined} /> : (
          <ResponsiveTable>
            <thead>
              <tr>
                <th className="w-[30%]">Agent</th>
                <th className="w-[12%]">MARN</th>
                <th className="w-[9%]">Students</th>
                <th className="w-[20%]">Applications</th>
                <th className="w-[11%]">Status</th>
                <th className="w-[18%]"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agentId}>
                  <td>
                    <Link to={`/admin/agents/${r.agentId}`} className="font-semibold text-foreground-900 hover:text-primary-700">{r.name}</Link><WhatsAppLink phone={r.phone} name={r.name} />
                    <p className="mt-0.5 text-xs text-foreground-500">{[r.role === "agency_admin" ? "Business admin agent" : "Agent", r.email].filter(Boolean).join(", ")}</p>
                    {r.registered === false ? <p className="text-xs font-medium text-amber-700">No longer registered with OMARA</p> : null}
                  </td>
                  <td className="tabular-nums">{r.marn || <span className="text-xs text-foreground-500">None</span>}</td>
                  <td><Link to={`/admin/agents/${r.agentId}`} className="font-bold text-foreground-900 hover:text-primary-700">{r.students}</Link></td>
                  <td>{Object.keys(r.statusCounts).length ? <ApplicationStatusPills counts={r.statusCounts} limit={3} /> : <span className="text-xs text-foreground-500">None</span>}</td>
                  <td><AgentStatusBadge status={r.status} />{r.status === "Active" && !r.profileId ? <p className="mt-1 text-2xs font-medium text-amber-700">Hasn't set a password yet</p> : null}</td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {awaitingPassword(r) && r.email ? <Button size="sm" variant="outline" disabled={busyId === r.agentId} onClick={() => void resend(r)}>Resend invite</Button> : null}
                      {r.status === "Inactive"
                        ? business.status !== "Active" ? null : <Button size="sm" onClick={() => openDialog(toActivate(r))}>Activate</Button>
                        : <Button size="sm" variant="ghost" disabled={busyId === r.agentId} onClick={() => setConfirm(r)}>Deactivate</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      <ActivateAgentDialog agent={activating} open={dialogOpen} onClose={() => setDialogOpen(false)} onDone={refresh} />
      <ConfirmDialog open={Boolean(confirm)} title={`Deactivate ${confirm?.name ?? "this agent"}?`}
        message="They will not be able to sign in, and an invitation still waiting is withdrawn. Their students and applications stay with the business."
        confirmLabel={busyId ? "Deactivating…" : "Deactivate agent"} onConfirm={() => { if (confirm && !busyId) void deactivate(confirm); }} onCancel={() => { if (!busyId) setConfirm(null); }} />
    </Card>
  );
}
