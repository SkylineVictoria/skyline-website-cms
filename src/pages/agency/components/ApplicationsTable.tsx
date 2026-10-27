import { useMemo, useState, useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { queryApplications, type ApplicationListRow } from "@/pages/agency/lib/portalApplications";
import { STATUS_META, statusMeta, formatDate } from "@/pages/agency/lib/portalData";
import { SELECTABLE_STATUSES } from "@/pages/agency/lib/applicationAccess";
import { PortalEmpty, PortalError, PortalLoading, StatusBadge } from "@/pages/agency/components/PortalUI";

type SortKey = "reference" | "student" | "agency" | "agent" | "status" | "completion" | "created" | "updated";

interface Option {
  id: string;
  name: string;
}

interface ApplicationsTableProps {
  rows: ApplicationListRow[];
  remote?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  /** Show the search / status / course / intake filter bar. */
  showFilters?: boolean;
  /** SLIT Admin: filter by agency. */
  agencies?: Option[];
  /** Agency Admin / SLIT Admin: filter by assigned agent. */
  agents?: Option[];
  pageSize?: number;
  showPagination?: boolean;
  /** Fewer columns for dashboard embedding. */
  compact?: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
  emptyAction?: ReactNode;
}

const SELECT_CLASS =
  "rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";

const SORTABLE: SortKey[] = ["reference", "student", "agency", "agent", "status", "completion", "created", "updated"];

function sortValue(row: ApplicationListRow, key: SortKey): string | number {
  switch (key) {
    case "reference":
      return row.reference || "";
    case "student":
      return (row.studentName || row.studentEmail).toLowerCase();
    case "agency":
      return row.agencyName.toLowerCase();
    case "agent":
      return row.agentName.toLowerCase();
    case "status":
      return row.status;
    case "completion":
      return row.completion;
    case "created":
      return row.createdAt;
    case "updated":
    default:
      return row.updatedAt;
  }
}

export default function ApplicationsTable({
  rows: providedRows,
  remote = false,
  loading,
  error,
  onRetry,
  showFilters = true,
  agencies,
  agents,
  pageSize = 10,
  showPagination = true,
  compact = false,
  emptyTitle = "No applications yet",
  emptyMessage = "When a student application is created it will appear here.",
  emptyAction,
}: ApplicationsTableProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [agencyId, setAgencyId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [courseCode, setCourseCode] = useState("");
  const [intake, setIntake] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const [remoteRows, setRemoteRows] = useState<ApplicationListRow[]>([]);
  const [remoteTotal, setRemoteTotal] = useState(0);
  const [remoteError, setRemoteError] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const rows = remote ? remoteRows : providedRows;
  useEffect(() => {
    if (!remote) return;
    let active = true;
    setRemoteLoading(true); setRemoteError("");
    const timer = window.setTimeout(() => { void queryApplications({search,status,agencyId,agentId,courseCode,intake,sort,direction:dir,limit:pageSize,offset:(page-1)*pageSize}).then(result => {
      if (active) { setRemoteRows(result.rows); setRemoteTotal(result.total); }
    }).catch(e => { if (active) setRemoteError(e.message); }).finally(() => { if (active) setRemoteLoading(false); }); }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [remote, search, status, agencyId, agentId, courseCode, intake, sort, dir, page, pageSize, retry]);

  const courseOptions = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((row) => row.courses.forEach((c) => map.set(c.code, c.code)));
    return Array.from(map.keys()).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    if (remote) return rows;
    const term = search.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (term) {
          const haystack = `${row.studentName} ${row.studentEmail} ${row.reference}`.toLowerCase();
          if (!haystack.includes(term)) return false;
        }
        if (status && row.status !== status) return false;
        if (agencyId && row.agencyId !== agencyId) return false;
        if (agentId && row.agentId !== agentId) return false;
        if (courseCode && !row.courses.some((c) => c.code === courseCode)) return false;
        if (intake && !row.intake.toLowerCase().includes(intake.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        const av = sortValue(a, sort);
        const bv = sortValue(b, sort);
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
        return dir === "asc" ? cmp : -cmp;
      });
  }, [rows, search, status, agencyId, agentId, courseCode, intake, sort, dir, remote]);

  const totalPages = Math.max(1, Math.ceil((remote ? remoteTotal : filtered.length) / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = remote ? rows : showPagination
    ? filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : filtered.slice(0, pageSize);

  const toggleSort = (key: SortKey) => {
    if (!SORTABLE.includes(key)) return;
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(key === "updated" || key === "created" ? "desc" : "asc");
    }
  };

  const resetPage = () => setPage(1);

  const headerCell = (label: string, key: SortKey, extra = "") => (
    <th className={`whitespace-nowrap px-3 py-2.5 font-semibold ${extra}`}>
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="inline-flex cursor-pointer items-center gap-1 text-foreground-700 transition-colors hover:text-primary-600"
      >
        {label}
        <i
          className={
            sort === key
              ? dir === "asc"
                ? "ri-arrow-up-s-line"
                : "ri-arrow-down-s-line"
              : "ri-arrow-up-down-line text-foreground-300"
          }
          aria-hidden="true"
        />
      </button>
    </th>
  );

  if (loading && !remote) return <PortalLoading label="Loading applications\u2026" />;
  if (error) return <PortalError message={error} onRetry={onRetry} />;

  return (
    <div>
      {remoteLoading ? <p role="status">Loading applications...</p> : null}
      {remoteError ? <PortalError message={remoteError} onRetry={() => setRetry(value => value + 1)} /> : null}
      {showFilters ? (
        <div className="mb-4 rounded-card border border-background-200 bg-background-50 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
            <label className="flex items-center gap-2 rounded-md border border-background-300 bg-background-50 px-3 py-2 lg:col-span-2">
              <i className="ri-search-line text-base text-foreground-400" aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  resetPage();
                }}
                placeholder="Search name, email or reference"
                className="w-full bg-transparent text-sm text-foreground-900 placeholder:text-foreground-400 focus:outline-none"
              />
            </label>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                resetPage();
              }}
              className={SELECT_CLASS}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {SELECTABLE_STATUSES.map((value) => [value, STATUS_META[value]] as const).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>
            {agencies ? (
              <select
                value={agencyId}
                onChange={(e) => {
                  setAgencyId(e.target.value);
                  resetPage();
                }}
                className={SELECT_CLASS}
                aria-label="Filter by agency"
              >
                <option value="">All agencies</option>
                {agencies.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : null}
            {agents ? (
              <select
                value={agentId}
                onChange={(e) => {
                  setAgentId(e.target.value);
                  resetPage();
                }}
                className={SELECT_CLASS}
                aria-label="Filter by agent"
              >
                <option value="">All agents</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : null}
            <select
              value={courseCode}
              onChange={(e) => {
                setCourseCode(e.target.value);
                resetPage();
              }}
              className={SELECT_CLASS}
              aria-label="Filter by course"
            >
              <option value="">All courses</option>
              {courseOptions.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={intake}
              onChange={(e) => {
                setIntake(e.target.value);
                resetPage();
              }}
              placeholder="Intake e.g. 02/2026"
              className={SELECT_CLASS}
              aria-label="Filter by intake"
            />
          </div>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <PortalEmpty icon="ri-file-list-3-line" title={emptyTitle} message={emptyMessage} action={emptyAction} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-card border border-background-200 bg-background-50">
            <table className="w-full min-w-[880px] border-collapse text-left text-sm">
              <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-700">
                <tr>
                  {headerCell("Reference", "reference")}
                  {headerCell("Student", "student")}
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Course(s)</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Intake</th>
                  {!compact && agencies ? headerCell("Agency", "agency") : null}
                  {headerCell("Agent", "agent")}
                  {headerCell("Status", "status")}
                  {headerCell("Progress", "completion")}
                  {headerCell("Created", "created")}
                  {!compact ? headerCell("Submitted", "created") : null}
                  {headerCell("Updated", "updated")}
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((row) => {
                  const meta = statusMeta(row.status);
                  return (
                    <tr key={row.id} className="border-t border-background-200 transition-colors hover:bg-background-100/60">
                      <td className="whitespace-nowrap px-3 py-3">
                        <span className="font-mono text-xs font-semibold text-foreground-900">
                          {row.reference || "\u2014"}
                        </span>
                        {row.isTest ? (
                          <span className="ml-2 rounded-full bg-accent-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent-900">
                            Test
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <p className="font-medium text-foreground-950">{row.studentName || "Unnamed student"}</p>
                        <p className="text-xs text-foreground-500">{row.studentEmail || "\u2014"}</p>
                      </td>
                      <td className="px-3 py-3">
                        {row.courses.length === 0 ? (
                          <span className="text-xs text-foreground-400">Not selected</span>
                        ) : (
                          <span className="text-xs text-foreground-700">
                            {row.courses.map((c) => c.code).join(", ")}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-foreground-700">{row.intake || "\u2014"}</td>
                      {!compact && agencies ? (
                        <td className="px-3 py-3 text-xs text-foreground-700">{row.agencyName || "\u2014"}</td>
                      ) : null}
                      <td className="px-3 py-3 text-xs text-foreground-700">
                        {row.agentName || <span className="text-foreground-400">Unassigned</span>}
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-background-200">
                            <div className={`h-full rounded-full ${meta.icon ? "bg-primary-500" : ""}`} style={{ width: `${row.completion}%` }} />
                          </div>
                          <span className="text-xs text-foreground-600">{row.completion}%</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-foreground-600">{formatDate(row.createdAt)}</td>
                      {!compact ? (
                        <td className="whitespace-nowrap px-3 py-3 text-xs text-foreground-600">
                          {row.submittedAt ? formatDate(row.submittedAt) : "\u2014"}
                        </td>
                      ) : null}
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-foreground-600">{formatDate(row.updatedAt)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right">
                        <div className="inline-flex items-center gap-2">
                          {row.status === "draft" ? (
                            <Link
                              to={`/agency/applications/${row.id}`}
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-background-300 px-2.5 py-1.5 text-xs font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
                              title="Resume draft"
                            >
                              <i className="ri-play-line" aria-hidden="true" />
                              Resume
                            </Link>
                          ) : null}
                          <Link
                            to={`/agency/applications/${row.id}`}
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-primary-500 px-2.5 py-1.5 text-xs font-semibold text-background-50 transition-colors hover:bg-primary-600"
                          >
                            <i className="ri-eye-line" aria-hidden="true" />
                            View
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-foreground-500">
              Showing {paged.length} of {remote ? remoteTotal : filtered.length} application{filtered.length === 1 ? "" : "s"}
              {showFilters && !remote ? ` (of ${rows.length} total)` : ""}
            </p>
            {showPagination && totalPages > 1 ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="cursor-pointer rounded-md border border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-700 transition-colors hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="text-xs text-foreground-600">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage === totalPages}
                  className="cursor-pointer rounded-md border border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-700 transition-colors hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}