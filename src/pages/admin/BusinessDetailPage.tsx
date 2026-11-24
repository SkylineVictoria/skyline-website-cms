import ResponsiveTable from "@/components/ui/ResponsiveTable";
import MessagePersonButton from "@/pages/admin/components/MessagePersonButton";
import PersonMessageIcon from "@/pages/admin/components/PersonMessageIcon";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ACTIVE_STAGES, STAGE_LABEL, type OnboardingStage } from "@/pages/admin/lib/agentOnboarding";
import { Button, Card, ConfirmDialog, PageHeader } from "@/pages/admin/components/ui";
import { AgencyStatusBadge, ApplicationStatusPills, OnboardingStatusPill } from "@/pages/admin/components/AgencyStatus";
import { ListMessage } from "@/pages/admin/components/ListControls";
import StudentsTable from "@/pages/admin/components/StudentsTable";
import ActivateAgentDialog from "@/pages/admin/components/ActivateAgentDialog";
import BusinessOnboarding from "@/pages/admin/components/BusinessOnboarding";
import AgentStatusBadge from "@/pages/admin/components/AgentStatusBadge";
import { toActivate, type AgentToActivate } from "@/pages/admin/lib/agentActivation";
import { useToast } from "@/pages/admin/components/toastContext";
import { ApplicationsTab, DetailsTab } from "@/pages/admin/AgencyDetailPage";
import { agentOnboardingWords, agentSignInStatus, awaitingPassword, changeBusinessStatus, deactivateAgent, getBusiness, resendInvitation, listBusinessAgents, type BusinessDetail, type BusinessStatus, type DirectoryAgent } from "@/pages/admin/lib/businessData";
import { formatDate, getAgency, type AgencySummary } from "@/pages/agency/lib/portalData";
import { activateBusinessOnboarding } from "@/lib/signingApi";
import { useAuth } from "@/pages/admin/lib/authContext";
import DeleteBusinessDialog from "@/pages/admin/components/DeleteBusinessDialog";
import { businessDeleteCheck, isSlitAdmin } from "@/pages/admin/lib/businessData";
import OmaraAgentsPanel from "@/pages/admin/components/OmaraAgentsPanel";
import { listOnboarding } from "@/pages/admin/lib/agentOnboarding";
import { BusinessOfficesCard } from "@/pages/admin/components/OfficeLocations";

type Tab = "details" | "documents" | "agents" | "students" | "applications";
const TAB_IDS: Tab[] = ["details", "documents", "agents", "students", "applications"];

/** Agencies > Businesses > {name}: the business, its agents, their students and the students' applications. The tab lives in the URL. */
export default function BusinessDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  // Delete business (2026-11-20): offered when the database says this administrator may delete it (any status since 2026-11-24).
  const { user } = useAuth();
  const isAdmin = isSlitAdmin(user?.role);
  const [deletable, setDeletable] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as Tab | null;
  const { push } = useToast();
  const [business, setBusiness] = useState<BusinessDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // Reloads can overlap (opening the page, closing Prepare application, Send): only the latest one's answer is shown, so an older,
  // slower answer never puts the header back to an earlier status ("Not sent yet" after Send, 2026-11-20).
  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latestLoad.current;
    setLoading(true);
    setError("");
    try {
      const found = await getBusiness(id);
      if (mine !== latestLoad.current) return;
      setBusiness(found);
      if (!found) setError("This business could not be found.");
    } catch (e) {
      if (mine !== latestLoad.current) return;
      setBusiness(null);
      setError(e instanceof Error ? e.message : "We could not load this business.");
    } finally {
      if (mine === latestLoad.current) setLoading(false);
    }
  }, [id]);
  useEffect(() => { setBusiness(null); void load(); }, [load]);
  useEffect(() => {
    let cancelled = false;
    if (!isAdmin || !business || business.status !== "Onboarding") { setDeletable(false); return; }
    businessDeleteCheck(business.id).then((r) => { if (!cancelled) setDeletable(r.deletable); }, () => { if (!cancelled) setDeletable(false); });
    return () => { cancelled = true; };
  }, [isAdmin, business]);

  const change = async (next: BusinessStatus) => {
    if (!business) return;
    setBusy(true);
    try {
      if (next === "Active" && business.status === "Onboarding") {
        const r = await activateBusinessOnboarding(business.id);
        const parts = [`${business.name} is active.`];
        if (r.emailed.length) parts.push(`Set-password email sent to ${r.emailed.join(", ")}.`);
        if (r.heldReleased) parts.push(`${r.heldReleased} held agent invitation${r.heldReleased === 1 ? "" : "s"} released.`);
        if (r.failed.length) parts.push(`Not emailed (use Resend invite on the Agents tab): ${r.failed.join(", ")}.`);
        if (r.skipped.length) parts.push(`Skipped: ${r.skipped.map((x) => `${x.email} (${x.reason})`).join(", ")}.`);
        push(parts.join(" "));
        await load();
        return;
      }
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
  // The gate (migration 20261117220000): agents, invites and the workspace need an operational business (Active with a signed, unexpired agreement, or SLIT's own).
  const operational = business.operational ?? business.status === "Active";
  const stage = (business.onboarding?.stage ?? null) as OnboardingStage | null;
  const onboardingRunning = !!stage && ACTIVE_STAGES.includes(stage);
  // 2026-11-18: approved businesses are Active before the agent agreement is signed (effective status Onboarding): the panel stays until then.
  const onboardingOpen = business.status !== "Active" || business.effectiveStatus === "Onboarding";
  const onboardingWords = operational ? "No active business admin agent yet."
    : business.onboarding?.readyToActivate ? "Agreement signed: ready to activate."
    : onboardingRunning ? `Onboarding: ${STAGE_LABEL[stage!] ?? stage}.`
    : stage ? `Onboarding ${(STAGE_LABEL[stage] ?? stage).toLowerCase()}; start it again.` : "Onboarding not started.";
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "details", label: "Details" },
    { id: "documents", label: "Documents" },
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
            {business.onboarding?.readyToActivate ? <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200" data-testid="ready-to-activate">Ready to activate</span>
              : business.onboarding?.label && onboardingOpen ? <OnboardingStatusPill label={business.onboarding.label} />
              : <AgencyStatusBadge status={business.effectiveStatus ?? business.status} />}
            {business.status === "Active" && business.operational === false && business.gateReason ? <span className="text-xs font-medium text-amber-700" data-testid="business-gate-reason">{business.gateReason}</span> : null}
            <MessagePersonButton kind="agency" refId={agency.id} name={business.name} />
            {deletable ? <Button variant="outline" icon="ri-delete-bin-line" onClick={() => setDeleting(true)} data-testid="delete-business">Delete business</Button> : null}
            {business.status === "Active"
              ? <Button variant="outline" disabled={busy} onClick={() => setConfirm(true)}>Deactivate business</Button>
              : <Button disabled={busy || !business.onboarding?.agreementReady} title={business.onboarding?.agreementReady ? undefined : "Needs the signed agent agreement"}
                onClick={() => void change("Active")} data-testid="activate-business">{busy ? "Activating…" : business.status === "Onboarding" ? "Activate" : "Activate & invite"}</Button>}
          </>
        }
      />

      {onboardingOpen ? (
        <BusinessOnboarding business={business} onChanged={load} />
      ) : null}

      <dl className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-background-200 bg-background-200 lg:grid-cols-3">
        <Summary label="Agents" value={people} note={`${c.admins} business admin agent${c.admins === 1 ? "" : "s"}, ${c.agents} other agent${c.agents === 1 ? "" : "s"}${c.inactiveAgents ? `, ${c.inactiveAgents} inactive` : ""}`}
          warnText={c.admins === 0 ? onboardingWords : undefined}
          onClick={() => setParams({ tab: "agents" })} />
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
      {tab === "documents" ? <BusinessOnboarding business={business} onChanged={load} part="documents" /> : null}
      {tab === "details" ? <BusinessOfficesCard agencyId={business.id} businessName={business.name} /> : null}
      {tab === "details" ? <OmaraAgentsPanel mode="linked" agencyId={business.id} /> : null}
      {tab === "agents" ? <AgentsSection business={{ id: business.id, name: business.name, status: business.status, operational, gateReason: business.gateReason ?? null, holding: !operational && business.status === "Onboarding" && stage !== "declined" }} onChanged={load} /> : null}
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
      {deleting && business ? <DeleteBusinessDialog business={{ id: business.id, name: business.name, abn: String(agency?.registrationNumber ?? "") }}
        onClose={() => setDeleting(false)} onDeleted={(message) => { setDeleting(false); push(message); navigate("/admin/businesses"); }} /> : null}
    </div>
  );
}

function Summary({ label, value, note, warnText, action, onClick }: { label: string; value: number; note?: string; warnText?: string; action?: ReactNode; onClick: () => void }) {
  return (
    <div className="bg-background-50 px-4 py-3">
      <dt className="text-xs text-foreground-500">{label}</dt>
      <dd className="mt-1">
        <button type="button" onClick={onClick} className="font-heading text-xl font-bold tabular-nums text-foreground-950 hover:text-primary-700">{value}</button>
        {note ? <p className={`mt-0.5 text-xs ${warnText ? "font-medium text-amber-700" : "text-foreground-600"}`} data-testid={warnText ? "summary-onboarding-stage" : undefined}>{warnText ? `${warnText} ${note}` : note}</p> : null}
        {action ? <div className="mt-1.5">{action}</div> : null}
      </dd>
    </div>
  );
}

function DetailsSection({ agencyId, onSaved }: { agencyId: string; onSaved: () => Promise<void> }) {
  const [agency, setAgency] = useState<AgencySummary | null>(null);
  // A failed load is shown with Try again (owner 2026-11-24: "Loading details is not loading"), never an endless "Loading".
  const [failed, setFailed] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed("");
    void getAgency(agencyId).then((found) => {
      if (!active) return;
      setAgency(found);
      if (!found) setFailed("The business details could not be found.");
    }).catch((e: unknown) => { if (active) { setAgency(null); setFailed(e instanceof Error ? e.message : "The business details could not be loaded."); } });
    return () => { active = false; };
  }, [agencyId, attempt]);
  if (agency) return <DetailsTab key={agency.id} agency={agency} onSaved={onSaved} />;
  return failed ? <p role="alert" className="text-sm text-red-700" data-testid="details-error">{failed}{" "}
    <button type="button" className="font-semibold underline" onClick={() => setAttempt((n) => n + 1)}>Try again</button></p>
    : <p className="text-sm text-foreground-600">Loading details&hellip;</p>;
}

/** The business's agents: add, activate, deactivate, and resend a sign-in invitation still waiting. */
function AgentsSection({ business, onChanged }: { business: { id: string; name: string; status: BusinessStatus; operational: boolean; gateReason: string | null; holding: boolean }; onChanged: () => Promise<void> }) {
  const { push } = useToast();
  const [rows, setRows] = useState<DirectoryAgent[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [activating, setActivating] = useState<AgentToActivate | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState<DirectoryAgent | null>(null);
  const [busyId, setBusyId] = useState("");
  // Referee checks still out on the business's onboarding (shown under an Active agent as "Reference check pending").
  const [refsPending, setRefsPending] = useState(0);
  useEffect(() => {
    let live = true;
    void listOnboarding(business.id).then((rows) => {
      const latest = rows.find((r) => r.kind !== "agent") ?? rows[0];
      if (live) setRefsPending(latest ? latest.referees.filter((r) => r.status !== "received" && r.status !== "cancelled").length : 0);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [business.id]);
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
        <p className="text-sm text-foreground-600">Agents of {business.name}. Each agent has their own students. Agents are covered by the business&apos;s onboarding: adding one sends only their sign-in invitation{business.holding ? ", held until an administrator activates the business" : ""}.</p>
        {business.operational || business.holding ? <Button size="sm" icon="ri-user-add-line" onClick={() => openDialog({ name: "", email: "", business })} data-testid="add-agent">Add agent</Button>
          : <span className="flex items-center gap-2"><Button size="sm" icon="ri-user-add-line" disabled title={business.gateReason ?? "Available once the business is active with a signed agent agreement."} data-testid="add-agent">Add agent</Button>
            <span className="text-xs font-medium text-amber-700" data-testid="add-agent-reason">{business.gateReason ?? "Agents can be added once the business is active with a signed, unexpired agent agreement."}</span></span>}
      </div>
      {error ? <ListMessage icon="ri-error-warning-line" title="Agents did not load" text={error} action={<Button size="sm" variant="outline" onClick={() => setReload((n) => n + 1)}>Try again</Button>} />
        : rows === null ? <p className="p-6 text-sm text-foreground-500">Loading agents…</p>
        : rows.length === 0 ? <ListMessage icon="ri-team-line" title="No agents yet" text={business.operational || business.holding ? "Add this business's first agent." : "Complete the onboarding first."} action={business.operational || business.holding ? <Button size="sm" onClick={() => openDialog({ name: "", email: "", business })}>Add agent</Button> : undefined} /> : (
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
                    <Link to={`/admin/agents/${r.agentId}`} className="font-semibold text-foreground-900 hover:text-primary-700">{r.name}</Link><PersonMessageIcon phone={r.phone} name={r.name} email={r.email} />
                    <p className="mt-0.5 text-xs text-foreground-500">{[r.role === "agency_admin" ? "Business admin agent" : "Agent", r.email].filter(Boolean).join(", ")}</p>
                    {r.registered === false ? <p className="text-xs font-medium text-amber-700">No longer registered with OMARA</p> : null}
                    {r.externalOnDirect ? <p className="text-xs font-medium text-amber-700" data-testid="external-on-direct">External account on SLIT-DIRECT (not @slit.edu.au); kept as is, for a decision</p> : null}
                  </td>
                  <td className="tabular-nums">{r.marn || <span className="text-xs text-foreground-500">None</span>}</td>
                  <td><Link to={`/admin/agents/${r.agentId}`} className="font-bold text-foreground-900 hover:text-primary-700">{r.students}</Link></td>
                  <td>{Object.keys(r.statusCounts).length ? <ApplicationStatusPills counts={r.statusCounts} limit={3} /> : <span className="text-xs text-foreground-500">None</span>}</td>
                  {/* Owner 2026-11-24: once the business is Active its admin agent shows Active; what is still open is a sub-status under it. */}
                  {/* Owner 2026-11-24: Active only once the agent has created their password; Invited until then; Not invited when none was sent. */}
                  <td><AgentStatusBadge status={agentSignInStatus(r)} />
                    {agentSignInStatus(r) === "Invited" ? <p className="mt-1 text-2xs font-medium text-amber-700">Waiting for them to create a password</p> : null}
                    {(r.status === "Active" || r.status === "Invited") && r.role === "agency_admin" && refsPending > 0 ? <p className="mt-1 text-2xs font-medium text-sky-800" data-testid="agent-refs-pending">Reference check pending ({refsPending})</p> : null}
                    {r.status === "Onboarding" ? <p className={`mt-1 text-2xs font-medium ${r.onboarding?.ready ? "text-emerald-700" : "text-sky-800"}`} data-testid="agent-onboarding-words">{agentOnboardingWords(r.onboarding)}</p> : null}
                    {r.status === "Declined" ? <p className="mt-1 text-2xs font-medium text-red-700">Rejected; no sign-in</p> : null}</td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {awaitingPassword(r) && r.email ? <Button size="sm" variant={r.invitationId ? "outline" : "primary"} icon="ri-mail-send-line" disabled={busyId === r.agentId} onClick={() => void resend(r)} data-testid={`send-invite-${r.agentId}`}>{busyId === r.agentId ? "Sending…" : r.invitationId ? "Resend invite" : "Send invite"}</Button> : null}
                      {r.status === "Onboarding" ? <span className="text-xs text-foreground-500">Sent at Activate</span>
                        : r.status === "Inactive" || r.status === "Declined"
                        ? !business.operational ? null : <Button size="sm" onClick={() => openDialog(toActivate(r))}>Activate</Button>
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
