import ResponsiveTable from "@/components/ui/ResponsiveTable";
import WhatsAppLink from "@/components/base/WhatsAppLink";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ConfirmDialog, PageHeader } from "@/pages/admin/components/ui";
import { ApplicationStatusPills } from "@/pages/admin/components/AgencyStatus";
import ActivateAgentDialog from "@/pages/admin/components/ActivateAgentDialog";
import { toActivate, type AgentToActivate } from "@/pages/admin/lib/agentActivation";
import { ListMessage, Pager, SearchBox, StatusTabs } from "@/pages/admin/components/ListControls";
import { useToast } from "@/pages/admin/components/toastContext";
import { deactivateAgent, listAgentDirectory, resendInvitation, type AgentCounts, type AgentStatus, type DirectoryAgent, awaitingPassword } from "@/pages/admin/lib/businessData";
import { useListParams } from "@/pages/admin/lib/listParams";
import { useStatusCatalog } from "@/pages/agency/lib/statusCatalog";

const PAGE_SIZE = 100;
const KEYS = ["q", "status", "sort", "dir"] as const;
type SortKey = "business" | "agent" | "students" | "applications" | "status";
const SORT_KEYS: SortKey[] = ["business", "agent", "students", "applications", "status"];
const STATUS_RANK: Record<AgentStatus, number> = { Active: 0, Invited: 1, Inactive: 2 };
const applicationTotal = (r: DirectoryAgent) => Object.values(r.statusCounts).reduce((sum, n) => sum + Number(n || 0), 0);
const text = (value: string) => value.trim().toLowerCase();
const inactiveBusiness = (r: DirectoryAgent) => Boolean(r.businessStatus) && r.businessStatus !== "Active";

function compareAgents(a: DirectoryAgent, b: DirectoryAgent, key: SortKey): number {
  switch (key) {
    case "business": return text(a.businessName).localeCompare(text(b.businessName)) || text(a.name).localeCompare(text(b.name));
    case "agent": return text(a.name).localeCompare(text(b.name));
    case "students": return a.students - b.students || text(a.name).localeCompare(text(b.name));
    case "applications": return applicationTotal(a) - applicationTotal(b) || text(a.name).localeCompare(text(b.name));
    case "status": return STATUS_RANK[a.status] - STATUS_RANK[b.status] || text(a.name).localeCompare(text(b.name));
  }
}

const STATUS_SELECT: Record<AgentStatus, string> = {
  Active: "border-emerald-200 bg-emerald-50 text-emerald-800",
  Invited: "border-amber-200 bg-amber-50 text-amber-900",
  Inactive: "border-background-300 bg-background-100 text-foreground-600",
};

/** Agencies > Agents: every agent of every business, with their students and applications. */
export default function AgentsPage() {
  const { push } = useToast();
  const { values, page, update, setPage, clear } = useListParams(KEYS);
  // Tabs and each row's dropdown use the backend's agent statuses.
  const agentStatuses = useStatusCatalog().agent;
  // Active is the default tab; "all" in the address shows every agent.
  const status = values.status === "all" ? "" : agentStatuses.some((item) => item.value === values.status) ? values.status : "Active";
  const [rows, setRows] = useState<DirectoryAgent[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<AgentCounts | null>(null);
  const countFor = (value: string) => (value === "Active" ? counts?.active : value === "Invited" ? counts?.invited : value === "Inactive" ? counts?.inactive : undefined) ?? null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [activating, setActivating] = useState<AgentToActivate | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState<DirectoryAgent | null>(null);
  const [busyKey, setBusyKey] = useState("");
  const sortKey = SORT_KEYS.includes(values.sort as SortKey) ? values.sort as SortKey : null;
  const sortDir = values.dir === "desc" ? "desc" : "asc";
  // Sorts the loaded page (up to 100 agents); without a sort the server order applies (Active, Invited, Inactive, then name).
  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const out = [...rows].sort((a, b) => compareAgents(a, b, sortKey));
    if (sortDir === "desc") out.reverse();
    // Agents of an inactive business always stay at the bottom.
    return [...out.filter((r) => !inactiveBusiness(r)), ...out.filter(inactiveBusiness)];
  }, [rows, sortKey, sortDir]);
  const toggleSort = (key: SortKey) => update({ sort: key, dir: sortKey === key && sortDir === "asc" ? "desc" : "asc", page: page > 1 ? String(page) : "" });
  const sortHeader = (key: SortKey, label: string, className: string) => (
    <th className={className} aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 hover:text-foreground-900">
        {label}
        <i aria-hidden="true" className={sortKey === key ? (sortDir === "asc" ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line") : "ri-arrow-up-down-line text-foreground-400"} />
      </button>
    </th>
  );
  // The status menu: activating opens the Activate dialog (business, email, invitation); deactivating asks first.
  const changeStatus = (row: DirectoryAgent, next: string) => {
    if (next === row.status) return;
    if (next === "Active") openActivate(toActivate(row));
    else if (next === "Inactive") setConfirm(row);
  };
  const applicationsHref = (row: DirectoryAgent, status?: string) => {
    const query = new URLSearchParams();
    query.set("business", row.businessId);
    if (row.profileId) query.set("agent", row.profileId);
    if (status) query.set("status", status);
    return `/admin/applications?${query.toString()}`;
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listAgentDirectory({ search: values.q, status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      .then((r) => { if (active) { setRows(r.rows); setTotal(r.total); setCounts(r.counts); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "We could not load agents."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [values.q, status, page, reload]);

  const openActivate = (agent: AgentToActivate | null) => { setActivating(agent); setDialogOpen(true); };
  const deactivate = async (row: DirectoryAgent) => {
    setBusyKey(row.key);
    try {
      await deactivateAgent(row.agentId);
      push(`${row.name} deactivated. They can no longer sign in; their students and applications are kept.`);
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not deactivate this agent.", "error");
    } finally {
      setBusyKey("");
      setConfirm(null);
    }
  };

  const resend = async (row: DirectoryAgent) => {
    setBusyKey(row.key);
    try {
      push(await resendInvitation(row));
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not resend that invitation.", "error");
    } finally {
      setBusyKey("");
    }
  };

  const filtered = Boolean(values.q || values.status);
  return (
    <div>
      <PageHeader title="Agents"
        description="Every agent belongs to one business and looks after their own students. Adding an agent can send their sign-in invitation; deactivating one blocks their sign-in but keeps their students."
        actions={<Button icon="ri-user-add-line" onClick={() => openActivate(null)}>Add agent</Button>} />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <StatusTabs label="Agent status" value={status || "all"} onChange={(v) => update({ status: v === "Active" ? "" : v })}
          tabs={[{ id: "all", label: "All", count: counts?.all ?? null }, ...agentStatuses.map((item) => ({ id: item.value, label: item.label, count: countFor(item.value) }))]} />
        <div className="flex-1"><SearchBox label="Search agents" value={values.q} onSearch={(q) => update({ q })} placeholder="Search name, MARN, email, business or city" /></div>
      </div>
      <Card>
        {error ? (
          <ListMessage icon="ri-error-warning-line" title="Agents did not load" text={error} action={<Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>Try again</Button>} />
        ) : !loading && rows.length === 0 ? (
          <ListMessage icon="ri-team-line" title={filtered ? "No agents match" : "No agents yet"}
            text={filtered ? "Check the spelling, search fewer words, or clear the filter." : "Add an agent to a business to get started."}
            action={filtered ? <Button variant="outline" size="sm" onClick={clear}>Clear search and filter</Button> : undefined} />
        ) : (
          <div className={loading && counts ? "opacity-60 transition-opacity" : ""}>
            <ResponsiveTable aria-busy={loading}>
              <thead>
                <tr>
                  {sortHeader("agent", "Agent", "w-[28%]")}
                  {sortHeader("business", "Business", "w-[24%]")}
                  {sortHeader("students", "Students", "w-[9%]")}
                  {sortHeader("applications", "Applications", "w-[23%]")}
                  {sortHeader("status", "Status", "w-[16%]")}
                </tr>
              </thead>
              <tbody>
                {loading && !counts ? <tr><td colSpan={5} className="py-10 text-center text-foreground-500">Loading agents…</td></tr> : sorted.map((r) => (
                  <tr key={r.key} className={inactiveBusiness(r) ? "bg-background-100/70 text-foreground-500 opacity-60" : ""} title={inactiveBusiness(r) ? "This agent's business is inactive" : undefined}>
                    <td>
                      <Link to={`/admin/agents/${r.key}`} className="font-semibold text-foreground-900 hover:text-primary-700">{r.name}</Link><WhatsAppLink phone={r.phone} name={r.name} />
                      <p className="mt-0.5 text-xs text-foreground-500">
                        {[r.marn ? `MARN ${r.marn}` : null, r.role === "agency_admin" ? "Business admin agent" : null, r.email].filter(Boolean).join(", ")}
                      </p>
                      {r.registered === false ? <p className="text-xs font-medium text-amber-700">No longer registered with OMARA</p> : null}
                    </td>
                    <td>
                      <Link to={`/admin/businesses/${r.businessId}`} className="font-medium text-foreground-800 hover:text-primary-700">{r.businessName}</Link>
                      {inactiveBusiness(r) ? <p className="text-xs font-medium text-foreground-600">Business inactive</p> : null}
                    </td>
                    <td>{r.students > 0 ? <Link to={`/admin/agents/${r.key}`} className="font-bold text-foreground-900 hover:text-primary-700">{r.students}</Link> : <span className="text-xs text-foreground-500">None</span>}</td>
                    <td>
                      {applicationTotal(r) > 0 ? (
                        <div className="flex flex-col items-start gap-1">
                          <Link to={applicationsHref(r)} className="text-xs font-semibold text-primary-700 hover:underline">{applicationTotal(r)} application{applicationTotal(r) === 1 ? "" : "s"}</Link>
                          <ApplicationStatusPills counts={r.statusCounts} limit={3} hrefFor={(status) => applicationsHref(r, status)} />
                        </div>
                      ) : <span className="text-xs text-foreground-500">None</span>}
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={`status-${r.key}`}>Status for {r.name}</label>
                      <select id={`status-${r.key}`} value={r.status} disabled={busyKey === r.key} onChange={(e) => changeStatus(r, e.target.value)}
                        className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium outline-none focus:ring-2 focus:ring-primary-100 disabled:opacity-60 ${STATUS_SELECT[r.status]}`}>
                        {/* The backend's agent statuses. Invited follows from the invitation, so it is never chosen here;
                            Active from Inactive opens the activation dialog; Inactive asks first. */}
                        {agentStatuses.map((item) => (
                          <option key={item.value} value={item.value}
                            disabled={item.value !== r.status && (item.value === "Invited" || (item.value === "Active" && r.status !== "Inactive"))}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      {r.status === "Active" && !r.profileId ? <p className="mt-1 text-2xs font-medium text-amber-700">Hasn't set a password yet</p> : null}
                      {awaitingPassword(r) && r.email ? (
                        <button type="button" disabled={busyKey === r.key} onClick={() => void resend(r)}
                          className="mt-1.5 flex cursor-pointer items-center gap-1 text-xs font-semibold text-primary-700 hover:underline disabled:cursor-not-allowed disabled:opacity-60">
                          <i className="ri-mail-send-line" aria-hidden="true" /> {busyKey === r.key ? "Sending…" : "Resend invite"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
        )}
        {!error ? <Pager page={page} pageSize={PAGE_SIZE} total={total} loading={loading} onPage={setPage} /> : null}
      </Card>

      <ActivateAgentDialog agent={activating} open={dialogOpen} onClose={() => setDialogOpen(false)} onDone={() => setReload((n) => n + 1)} />
      <ConfirmDialog open={Boolean(confirm)} title={`Deactivate ${confirm?.name ?? "this agent"}?`}
        message="They will not be able to sign in, and an invitation still waiting is withdrawn. Their students and applications stay with the business. You can activate them again at any time."
        confirmLabel={busyKey ? "Deactivating…" : "Deactivate agent"} onConfirm={() => { if (confirm && !busyKey) void deactivate(confirm); }} onCancel={() => { if (!busyKey) setConfirm(null); }} />
    </div>
  );
}
