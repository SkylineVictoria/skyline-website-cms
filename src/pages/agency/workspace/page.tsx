import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { listAgencyMembers, ROLE_LABELS, formatDate, type AgencyMemberRow } from "@/pages/agency/lib/portalData";
import { listApplications, type ApplicationListRow } from "@/pages/agency/lib/portalApplications";
import { PortalEmpty, PortalError, PortalLoading, StatusBadge } from "@/pages/agency/components/PortalUI";

/**
 * Agency workspace: one screen per business.
 *   Business profile  ->  its agents  ->  each agent's candidates  ->  their applications.
 * Candidates are students grouped from applications (by email, falling back to name).
 * Visibility is still decided server-side: an agent's query only ever returns their own applications.
 */

interface Candidate {
  key: string;
  name: string;
  email: string;
  applications: ApplicationListRow[];
  lastUpdated: string;
}

interface AgentGroup {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  candidates: Candidate[];
}

const UNASSIGNED = "__unassigned__";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

function groupCandidates(rows: ApplicationListRow[]): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const row of rows) {
    const key = (row.studentEmail || row.studentName || row.id).trim().toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.applications.push(row);
      if (row.updatedAt > existing.lastUpdated) existing.lastUpdated = row.updatedAt;
    } else {
      map.set(key, {
        key,
        name: row.studentName || "Unnamed student",
        email: row.studentEmail,
        applications: [row],
        lastUpdated: row.updatedAt,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
}

function matches(text: string, q: string): boolean {
  return text.toLowerCase().includes(q);
}

function candidateMatches(c: Candidate, q: string): boolean {
  if (matches(c.name, q) || matches(c.email, q)) return true;
  return c.applications.some(
    (a) => matches(a.reference, q) || matches(a.intake, q) || a.courses.some((course) => matches(`${course.code} ${course.title}`, q)),
  );
}

export default function AgencyWorkspacePage() {
  const { role, agency, profile, authUser } = usePortalAuth();
  const isAdmin = role === "agency_admin";
  const [members, setMembers] = useState<AgencyMemberRow[]>([]);
  const [rows, setRows] = useState<ApplicationListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showDetails, setShowDetails] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [apps, team] = await Promise.all([
        listApplications(),
        isAdmin && agency ? listAgencyMembers(agency.id) : Promise.resolve([] as AgencyMemberRow[]),
      ]);
      setRows(apps);
      setMembers(team);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load your workspace.");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, agency]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo<AgentGroup[]>(() => {
    const byAgent = new Map<string, ApplicationListRow[]>();
    for (const row of rows) {
      const key = row.agentId ?? UNASSIGNED;
      byAgent.set(key, [...(byAgent.get(key) ?? []), row]);
    }

    if (!isAdmin) {
      const selfId = profile?.id ?? authUser?.id ?? "me";
      return [
        {
          id: selfId,
          name: profile?.fullName || authUser?.name || "You",
          email: authUser?.email ?? "",
          role: role ? ROLE_LABELS[role] : "Agent",
          status: "Active",
          candidates: groupCandidates(rows),
        },
      ];
    }

    const list: AgentGroup[] = members.map((m) => ({
      id: m.profileId,
      name: m.fullName || m.email,
      email: m.email,
      role: ROLE_LABELS[m.role],
      status: m.status,
      candidates: groupCandidates(byAgent.get(m.profileId) ?? []),
    }));
    // Applications assigned to someone no longer in the member list still belong to the business.
    const known = new Set(members.map((m) => m.profileId));
    for (const [agentId, agentRows] of byAgent) {
      if (agentId === UNASSIGNED || known.has(agentId)) continue;
      list.push({ id: agentId, name: agentRows[0]?.agentName || "Former agent", email: "", role: "Agent", status: "Inactive", candidates: groupCandidates(agentRows) });
    }
    const unassigned = byAgent.get(UNASSIGNED);
    if (unassigned?.length) {
      list.push({ id: UNASSIGNED, name: "Not assigned", email: "", role: "", status: "", candidates: groupCandidates(unassigned) });
    }
    return list;
  }, [rows, members, isAdmin, profile, authUser, role]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => {
        const agentHit = matches(g.name, q) || matches(g.email, q);
        return { ...g, candidates: agentHit ? g.candidates : g.candidates.filter((c) => candidateMatches(c, q)) };
      })
      .filter((g) => g.candidates.length > 0 || matches(g.name, q) || matches(g.email, q));
  }, [groups, q]);

  const totalCandidates = groups.reduce((n, g) => n + g.candidates.length, 0);
  const agentCount = isAdmin ? members.length : 1;
  const singleAgent = !isAdmin;

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const details = agency
    ? [
        { label: "Code", value: agency.code },
        { label: "Registration / ABN", value: agency.registrationNumber },
        { label: "Primary contact", value: agency.primaryContact },
        { label: "Email", value: agency.businessEmail },
        { label: "Phone", value: agency.phone },
        { label: "Country", value: agency.country },
        { label: "Address", value: agency.address },
      ].filter((d) => d.value)
    : [];

  if (role === "student") return <Navigate to="/agency/applications" replace />;
  return (
    <div className="mx-auto max-w-5xl">
      {/* Business profile */}
      <section className="rounded-card border border-background-200 bg-background-50 p-5 md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary-500 font-heading text-lg font-bold text-background-50">
              {initialsOf(agency?.name ?? "Agency")}
            </span>
            <div className="min-w-0">
              <h1 className="truncate font-heading text-xl font-bold text-foreground-950 md:text-2xl">{agency?.name ?? "Your business"}</h1>
              <p className="mt-0.5 text-sm text-foreground-600">
                {agentCount} {agentCount === 1 ? "agent" : "agents"}, {totalCandidates} {totalCandidates === 1 ? "candidate" : "candidates"}
                {agency?.status ? (
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold ${agency.status === "Active" ? "bg-accent-100 text-accent-900" : "bg-background-200 text-foreground-600"}`}>
                    {agency.status}
                  </span>
                ) : null}
              </p>
            </div>
          </div>
          {details.length ? (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
              className="inline-flex cursor-pointer items-center gap-1 self-start whitespace-nowrap text-sm font-semibold text-primary-700 hover:text-primary-800"
            >
              {showDetails ? "Hide business details" : "Business details"}
              <i className={`ri-arrow-${showDetails ? "up" : "down"}-s-line`} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {showDetails ? (
          <dl className="mt-5 grid grid-cols-1 gap-x-8 gap-y-3 border-t border-background-200 pt-4 text-sm sm:grid-cols-2">
            {details.map((d) => (
              <div key={d.label}>
                <dt className="text-xs text-foreground-500">{d.label}</dt>
                <dd className="mt-0.5 break-words text-foreground-900">{d.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      {/* Search + add */}
      <div className="sticky top-[57px] z-30 -mx-1 mt-5 flex flex-col gap-3 bg-background-100 px-1 py-2 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">Search agents and candidates</span>
          <i className="ri-search-line pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg text-foreground-400" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isAdmin ? "Search agents, candidates, email, course or reference" : "Search your candidates, email, course or reference"}
            className="w-full rounded-md border border-background-300 bg-background-50 py-2.5 pl-10 pr-3 text-sm text-foreground-900 placeholder:text-foreground-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
          />
        </label>
        <div className="flex gap-2">
          <Link
            to="/agency/applications/new"
            className="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 sm:flex-none"
          >
            <i className="ri-user-add-line" aria-hidden="true" />
            Add candidate
          </Link>
          {isAdmin ? (
            <Link
              to="/agency/users?add=1"
              className="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:bg-background-100 sm:flex-none"
            >
              <i className="ri-team-line" aria-hidden="true" />
              Add agent
            </Link>
          ) : null}
        </div>
      </div>

      {/* Agents -> candidates */}
      <div className="mt-3">
        {error ? (
          <PortalError message={error} onRetry={() => void load()} />
        ) : loading ? (
          <PortalLoading label="Loading agents and candidates…" />
        ) : visible.length === 0 ? (
          q ? (
            <PortalEmpty icon="ri-search-line" title={`Nothing matches “${query.trim()}”`} message="Try a student name, email, course code or application reference." />
          ) : (
            <PortalEmpty
              icon="ri-user-add-line"
              title="No agents yet"
              message="Add an agent to your business, then start a candidate’s application."
              action={
                isAdmin ? (
                  <Link to="/agency/users?add=1" className="inline-flex items-center gap-1.5 rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 hover:bg-primary-600">
                    Add agent
                  </Link>
                ) : undefined
              }
            />
          )
        ) : (
          <ul className="space-y-3">
            {visible.map((g) => {
              const expanded = singleAgent || Boolean(q) || open.has(g.id);
              return (
                <li key={g.id} className="overflow-hidden rounded-card border border-background-200 bg-background-50">
                  {singleAgent ? (
                    <div className="flex items-center justify-between gap-3 border-b border-background-200 px-4 py-3">
                      <h2 className="font-heading text-base font-semibold text-foreground-950">Your candidates</h2>
                      <span className="text-sm text-foreground-500">{g.candidates.length}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggle(g.id)}
                      aria-expanded={expanded}
                      className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-background-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
                    >
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${g.id === UNASSIGNED ? "bg-background-200 text-foreground-600" : "bg-accent-100 text-accent-900"}`}>
                        {g.id === UNASSIGNED ? <i className="ri-question-mark" aria-hidden="true" /> : initialsOf(g.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-foreground-950">{g.name}</span>
                          {g.role ? <span className="shrink-0 text-xs text-foreground-500">{g.role}</span> : null}
                          {g.status && g.status !== "Active" ? (
                            <span className="shrink-0 rounded-full bg-background-200 px-2 py-0.5 text-2xs font-semibold text-foreground-600">{g.status}</span>
                          ) : null}
                        </span>
                        {g.email ? <span className="block truncate text-xs text-foreground-500">{g.email}</span> : null}
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-sm font-semibold text-foreground-900">{g.candidates.length}</span>
                        <span className="block text-2xs text-foreground-500">{g.candidates.length === 1 ? "candidate" : "candidates"}</span>
                      </span>
                      <i className={`ri-arrow-${expanded ? "up" : "down"}-s-line shrink-0 text-lg text-foreground-500`} aria-hidden="true" />
                    </button>
                  )}

                  {expanded ? (
                    g.candidates.length === 0 ? (
                      <div className="flex flex-col items-start gap-2 border-t border-background-200 px-4 py-5 text-sm text-foreground-600 sm:flex-row sm:items-center sm:justify-between">
                        <span>No candidates yet.</span>
                        <Link to="/agency/applications/new" className="font-semibold text-primary-700 hover:text-primary-800">
                          Add candidate
                        </Link>
                      </div>
                    ) : (
                      <ul className={`divide-y divide-background-200 ${singleAgent ? "" : "border-t border-background-200 bg-background-100/40"}`}>
                        {g.candidates.map((c) => (
                          <li key={c.key} className="px-4 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-foreground-950">{c.name}</p>
                                {c.email ? <p className="truncate text-xs text-foreground-500">{c.email}</p> : null}
                              </div>
                              <span className="shrink-0 text-xs text-foreground-500">Updated {formatDate(c.lastUpdated)}</span>
                            </div>
                            <ul className="mt-2 space-y-1.5">
                              {c.applications.map((a) => (
                                <li key={a.id}>
                                  <Link
                                    to={`/agency/applications/${a.id}`}
                                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-background-200 bg-background-50 px-3 py-2 text-sm transition-colors hover:border-primary-300 hover:bg-primary-50"
                                  >
                                    <span className="font-medium text-foreground-900">{a.courses.map((course) => course.code).join(", ") || "No course yet"}</span>
                                    {a.intake ? <span className="text-xs text-foreground-500">{a.intake}</span> : null}
                                    <span className="text-xs text-foreground-400">{a.reference}</span>
                                    <span className="ml-auto">
                                      <StatusBadge status={a.status} />
                                    </span>
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
