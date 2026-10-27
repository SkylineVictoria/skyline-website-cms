import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { listAgencies, ROLE_LABELS, STATUS_META } from "@/pages/agency/lib/portalData";
import {
  getDashboardStats,
  listAssignableAgents,
  summarizeApplications,
  type AgentOption,
  type ApplicationListRow,
  type DashboardStats,
} from "@/pages/agency/lib/portalApplications";
import ApplicationsTable from "@/pages/agency/components/ApplicationsTable";
import { PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";

interface CardDef {
  key: keyof Pick<DashboardStats, "total" | "drafts" | "submitted" | "offerAccepted" | "actionRequired" | "enrolled">;
  label: string;
  icon: string;
  tone: string;
}

const CARDS: CardDef[] = [
  { key: "total", label: "Total applications", icon: "ri-file-list-3-line", tone: "bg-primary-100 text-primary-700" },
  { key: "drafts", label: "Drafts", icon: "ri-file-edit-line", tone: "bg-background-200 text-foreground-700" },
  { key: "submitted", label: "Submitted", icon: "ri-send-plane-line", tone: "bg-secondary-100 text-secondary-900" },
  { key: "offerAccepted", label: "Offer accepted", icon: "ri-checkbox-circle-line", tone: "bg-accent-100 text-accent-900" },
  { key: "actionRequired", label: "Action required", icon: "ri-alert-line", tone: "bg-primary-100 text-primary-800" },
  { key: "enrolled", label: "Enrolled", icon: "ri-graduation-cap-line", tone: "bg-accent-500 text-background-50" },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

export default function PortalDashboardPage() {
  const { role, profile, agency } = usePortalAuth();
  const [serverStats, setServerStats] = useState<DashboardStats | null>(null);
  const [rows, setRows] = useState<ApplicationListRow[]>([]);
  const [agencies, setAgencies] = useState<Array<{ id: string; name: string }>>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const isSlit = role === "slit_admin";
  const isAgent = role === "agent";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getDashboardStats();
      setServerStats(data);
      setRows(data.recent);
      if (isSlit) {
        const agencyList = await listAgencies();
        setAgencies(agencyList.map((a) => ({ id: a.id, name: a.name })));
        setAgents(await listAssignableAgents());
      } else if (role === "agency_admin") {
        setAgents(await listAssignableAgents(agency?.id));
        setAgencies([]);
      } else {
        setAgents([]);
        setAgencies([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load your dashboard.");
    } finally {
      setLoading(false);
    }
  }, [isSlit, role, agency?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => serverStats ?? summarizeApplications(rows), [rows, serverStats]);
  const firstName = (profile?.fullName || "").trim().split(/\s+/)[0] || "there";

  const breakdown = isSlit ? stats.byAgency : stats.byAgent;

  return (
    <div>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-label text-xs font-semibold uppercase tracking-wide text-primary-600">Dashboard</p>
          <h1 className="mt-1 font-heading text-2xl font-bold text-foreground-950 md:text-3xl">Welcome, {firstName}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground-600">
            {isSlit
              ? "Totals across every registered agency, with agency-wise and agent-wise breakdowns."
              : isAgent
                ? "Your assigned applications, drafts and enrolment outcomes."
                : `Activity across ${agency?.name ?? "your agency"}, including counts by agent.`}
          </p>
        </div>
        {!isSlit ? (
          <Link
            to="/agency/applications/new"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
          >
            <i className="ri-add-line" aria-hidden="true" />
            Add New Form
          </Link>
        ) : null}
      </header>

      <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-background-200 bg-background-50 px-3 py-1 text-xs font-medium text-foreground-600">
        <i className="ri-shield-user-line text-primary-500" aria-hidden="true" />
        Signed in as {role ? ROLE_LABELS[role] : ""}
        {!isSlit && agency?.name ? <span className="text-foreground-400">&middot; {agency.name}</span> : null}
      </div>

      {error ? (
        <div className="mt-6">
          <PortalError message={error} onRetry={() => void load()} />
        </div>
      ) : loading ? (
        <div className="mt-6">
          <PortalLoading label="Loading totals\u2026" />
        </div>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {CARDS.map((card) => (
              <div key={card.key} className="rounded-card border border-background-200 bg-background-50 p-5">
                <span className={`flex h-10 w-10 items-center justify-center rounded-md text-lg ${card.tone}`}>
                  <i className={card.icon} aria-hidden="true" />
                </span>
                <p className="mt-4 font-heading text-2xl font-bold text-foreground-950">{stats[card.key]}</p>
                <p className="mt-0.5 text-sm text-foreground-600">{card.label}</p>
              </div>
            ))}
          </section>

          <div className="mt-4 flex flex-wrap gap-3" aria-label="All application statuses">{Object.entries(STATUS_META).map(([status, meta]) => <span className="rounded border bg-background-50 px-3 py-2 text-sm" key={status}>{meta.label}: {stats.statuses?.[status] ?? 0}</span>)}</div>
          <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-[1fr_360px]">
            <section className="rounded-card border border-background-200 bg-background-50 p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-heading text-base font-semibold text-foreground-950">
                  {isSlit ? "Recent applications" : "Recent activity"}
                </h2>
                <Link
                  to={isSlit ? "/agency/all-applications" : "/agency/applications"}
                  className="text-xs font-semibold text-primary-600 hover:text-primary-700"
                >
                  View all
                </Link>
              </div>
              <div className="mt-4">
                <ApplicationsTable
                  rows={rows}
                  compact
                  showFilters
                  showPagination={false}
                  pageSize={6}
                  agencies={isSlit ? agencies : undefined}
                  agents={agents.map((a) => ({ id: a.profileId, name: a.fullName }))}
                  emptyTitle="No applications yet"
                  emptyMessage={
                    isAgent
                      ? "Applications assigned to you will appear here. Start a new one with Add New Form."
                      : "Applications created by your agency will appear here."
                  }
                  emptyAction={
                    !isSlit ? (
                      <Link
                        to="/agency/applications/new"
                        className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
                      >
                        <i className="ri-add-line" aria-hidden="true" />
                        Add New Form
                      </Link>
                    ) : undefined
                  }
                />
              </div>
            </section>

            <section className="rounded-card border border-background-200 bg-background-50 p-5">
              <h2 className="font-heading text-base font-semibold text-foreground-950">
                {isSlit ? "Agency-wise totals" : "By agent"}
              </h2>
              <p className="mt-1 text-xs text-foreground-500">
                {isSlit
                  ? "Applications grouped by agency."
                  : "Application counts for each agent in your agency."}
              </p>
              {breakdown.length === 0 ? (
                <p className="mt-4 rounded-md border border-dashed border-background-300 px-3 py-6 text-center text-xs text-foreground-500">
                  No data to show yet.
                </p>
              ) : (
                <ul className="mt-4 space-y-2.5">
                  {breakdown.map((bucket) => (
                    <li
                      key={bucket.id}
                      className="flex items-center gap-3 rounded-lg border border-background-200 bg-background-50 px-3 py-2.5"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-100 text-[11px] font-semibold text-accent-900">
                        {initialsOf(bucket.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground-900">{bucket.name}</p>
                        <p className="text-xs text-foreground-500">
                          {bucket.total} total &middot; {bucket.drafts} draft &middot; {bucket.submitted} submitted &middot; {bucket.offerAccepted} offer accepted
                          {bucket.actionRequired ? ` \u00b7 ${bucket.actionRequired} action` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-primary-100 px-2.5 py-1 text-xs font-semibold text-primary-700">
                        {bucket.total}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {isSlit ? (
                <div className="mt-5 border-t border-background-200 pt-4">
                  <h3 className="font-heading text-sm font-semibold text-foreground-950">Agent-wise totals</h3>
                  {stats.byAgent.length === 0 ? (
                    <p className="mt-2 text-xs text-foreground-500">No agent activity yet.</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {stats.byAgent.slice(0, 6).map((bucket) => (
                        <li key={bucket.id} className="flex items-center justify-between gap-3 text-xs">
                          <span className="truncate text-foreground-700">{bucket.name}</span>
                          <span className="shrink-0 font-semibold text-foreground-900">{bucket.total}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
          </div>
        </>
      )}
    </div>
  );
}