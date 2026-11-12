import ResponsiveTable from "@/components/ui/ResponsiveTable";
import { useContext, useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import { useApplicationPaths } from "@/pages/agency/lib/applicationPaths";
import { Link, useNavigate } from "react-router-dom";
import { queryApplications, type ApplicationListRow } from "@/pages/agency/lib/portalApplications";
import { formatDate } from "@/pages/agency/lib/portalData";
import { PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { PortalAuthContext } from "@/pages/agency/lib/portalAuthContext";
import { actionsFor, currentStatuses, useApplicationStatuses } from "@/lib/applicationStatuses";
import StatusBadge from "@/components/shared/application-status/StatusBadge";
import TakeActionMenu from "@/components/shared/application-status/TakeActionMenu";
import Toast from "@/components/shared/application-form/Toast";
import { useToast } from "@/components/shared/application-form/useToast";

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
  /** Pins the list to one agency (the agency page): sent to the query, never filtered after loading. */
  fixedAgencyId?: string;
  /** Status filter selected when the table first renders (for links such as "2 Draft" on the Agencies list). */
  initialStatus?: string;
  /** Agency and assigned agent selected when the table first renders (for links from the Agents list). */
  initialAgencyId?: string;
  initialAgentId?: string;
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
  /** Remote mode: called with the total after each load. */
  onTotal?: (total: number) => void;
}

const SELECT_CLASS =
  "min-w-0 w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";

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
  fixedAgencyId = "",
  initialStatus = "",
  initialAgencyId = "",
  initialAgentId = "",
  agencies,
  agents,
  pageSize = 10,
  showPagination = true,
  compact = false,
  emptyTitle = "No applications yet",
  emptyMessage = "When a student application is created it will appear here.",
  emptyAction,
  onTotal,
}: ApplicationsTableProps) {
  const paths = useApplicationPaths();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [chosenAgencyId, setAgencyId] = useState(initialAgencyId);
  const agencyId = fixedAgencyId || chosenAgencyId;
  // No agent, course or intake filter controls; a link from the Agents list still opens with its agent selected.
  const agentId = initialAgentId;
  const courseCode: string = "";
  const intake: string = "";
  const [sort, setSort] = useState<SortKey>("updated");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const [previousAgency, setPreviousAgency] = useState(fixedAgencyId);
  if (previousAgency !== fixedAgencyId) { setPreviousAgency(fixedAgencyId); setPage(1); }
  const [remoteRows, setRemoteRows] = useState<ApplicationListRow[]>([]);
  const [remoteTotal, setRemoteTotal] = useState(0);
  const [remoteError, setRemoteError] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const rows = remote ? remoteRows : providedRows;
  const onTotalRef = useRef(onTotal);
  useEffect(() => { onTotalRef.current = onTotal; }, [onTotal]);
  // Rows of the previous agency are dropped at once, never shown under the next one while it loads.
  useEffect(() => { setRemoteRows([]); }, [fixedAgencyId]);
  useEffect(() => {
    if (!remote) return;
    let active = true;
    setRemoteLoading(true); setRemoteError("");
    const timer = window.setTimeout(() => { void queryApplications({search,status,agencyId,agentId,courseCode,intake,sort,direction:dir,limit:pageSize,offset:(page-1)*pageSize}).then(result => {
      if (active) { setRemoteRows(result.rows); setRemoteTotal(result.total); onTotalRef.current?.(result.total); }
    }).catch(e => { if (active) setRemoteError(e.message); }).finally(() => { if (active) setRemoteLoading(false); }); }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [remote, search, status, agencyId, agentId, courseCode, intake, sort, dir, page, pageSize, retry]);

  // The status filter, the badges and the Take action menus all come from the database's workflow.
  const workflow = useApplicationStatuses();
  const statusChoices = currentStatuses(workflow);
  // Staff take actions; inside the portal the signed-in role decides (CMS pages are SLIT administrators only; the database checks every action).
  const portal = useContext(PortalAuthContext);
  const isStaff = portal ? portal.role === "slit_admin" : true;
  const navigate = useNavigate();
  const toast = useToast();
  // Statuses changed here, shown at once and undone if the database refuses the change.
  const [statusOverride, setStatusOverride] = useState<Record<string, string>>({});

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

  const sortButton = (label: string, key: SortKey) => (
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="inline-flex max-w-full cursor-pointer items-center gap-1 text-foreground-700 transition-colors hover:text-primary-600"
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
  );

  const headerCell = (label: string, key: SortKey, extra = "") => (
    <th className={`px-2 py-2.5 font-semibold ${extra}`}>{sortButton(label, key)}</th>
  );

  if (loading && !remote) return <PortalLoading label="Loading applications\u2026" />;
  if (error) return <PortalError message={error} onRetry={onRetry} />;

  return (
    <div>
      {remoteLoading ? <p role="status">Loading applications...</p> : null}
      {remoteError ? <PortalError message={remoteError} onRetry={() => setRetry(value => value + 1)} /> : null}
      {showFilters ? (
        <div className="mb-4 rounded-card border border-background-200 bg-background-50 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              <option value="">{workflow.error ? "Statuses unavailable" : "All statuses"}</option>
              {statusChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
            {agencies && !fixedAgencyId ? (
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
          </div>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <PortalEmpty icon="ri-file-list-3-line" title={emptyTitle} message={emptyMessage} action={emptyAction} />
      ) : (
        <>
          <div className="rounded-card border border-background-200 bg-background-50">
            <ResponsiveTable>
              <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-700">
                <tr>
                  <th className="w-[24%] px-2 py-2.5"><div className="flex flex-wrap gap-x-2 gap-y-1">{sortButton("Student", "student")}{sortButton("Reference", "reference")}</div></th>
                  <th className="px-2 py-2.5 font-semibold">Course / Intake</th>
                  <th className="px-2 py-2.5"><div className="flex flex-wrap gap-x-2 gap-y-1">{!compact && agencies ? sortButton("Agency", "agency") : null}{sortButton("Agent", "agent")}</div></th>
                  {headerCell("Status", "status")}
                  {headerCell("Progress", "completion")}
                  <th className="w-[16%] px-2 py-2.5"><div className="flex flex-wrap gap-x-2 gap-y-1">{sortButton("Created", "created")}{sortButton("Updated", "updated")}</div></th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((source) => {
                  const row = statusOverride[source.id] ? { ...source, status: statusOverride[source.id] } : source;
                  const applicantAction = actionsFor(workflow, row.status, "applicant")[0];
                  return (
                    <tr key={row.id} className="border-t border-background-200 transition-colors hover:bg-background-100/60">
                      <td data-label="Student / Reference" className="px-2 py-3">
                        <Link to={paths.detail(row.id)} className="font-mono text-xs font-semibold text-foreground-900 underline-offset-2 hover:text-primary-700 hover:underline" data-testid="application-reference">
                          {row.reference || "\u2014"}
                        </Link>
                        {row.isTest ? (
                          <span className="ml-2 rounded-full bg-accent-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent-900">
                            Test
                          </span>
                        ) : null}

                        <p><Link to={paths.detail(row.id)} className="font-medium text-foreground-950 underline-offset-2 hover:text-primary-700 hover:underline" data-testid="application-open">{row.studentName || "Unnamed student"}</Link></p>
                        <p className="text-xs text-foreground-500">{row.studentEmail || "\u2014"}</p>
                      </td>
                      <td data-label="Course / Intake" className="px-3 py-3">
                        {row.courses.length === 0 ? (
                          <span className="text-xs text-foreground-400">Not selected</span>
                        ) : (
                          <span className="text-xs text-foreground-700">
                            {row.courses.map((c) => c.code).join(", ")}
                          </span>
                        )}
                        <p className="mt-1 text-xs text-foreground-500">Intake: {row.intake || "\u2014"}</p>
                      </td>
                      <td data-label="Agency / Agent" className="px-3 py-3 text-xs text-foreground-700">
                        {!compact && agencies ? <p className="mb-1 font-medium">{row.agencyName || "\u2014"}</p> : null}
                        {row.agentName || <span className="text-foreground-400">Unassigned</span>}
                      </td>
                      <td data-label="Status" className="px-3 py-3">
                        <StatusBadge status={row.status} />
                      </td>
                      <td data-label="Progress" className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <div className="h-1.5 w-full max-w-16 overflow-hidden rounded-full bg-background-200">
                            <div className="h-full rounded-full bg-primary-500" style={{ width: `${row.completion}%` }} />
                          </div>
                          <span className="text-xs text-foreground-600">{row.completion}%</span>
                        </div>
                      </td>
                      <td data-label="Dates" className="px-2 py-3 text-xs text-foreground-600">
                        <p>Created: {formatDate(row.createdAt)}</p>
                        {!compact ? <p className="mt-1">Submitted: {row.submittedAt ? formatDate(row.submittedAt) : "\u2014"}</p> : null}
                        <p className="mt-1">Updated: {formatDate(row.updatedAt)}</p>
                      </td>
                      <td data-label="Actions" className="whitespace-nowrap px-3 py-3 text-right">
                        {isStaff ? (
                          <TakeActionMenu
                            application={{ id: row.id, status: row.status, reference: row.reference, studentName: row.studentName, studentId: null,
                              course: row.courses[0] ? { title: row.courses[0].title, code: row.courses[0].code } : null, intake: row.intake }}
                            onStatus={(next) => setStatusOverride((prev) => ({ ...prev, [row.id]: next }))}
                            onResult={(message, _ok, action) => toast.show(message, action, action ? 5000 : undefined)}
                            variant="row"
                          />
                        ) : applicantAction ? (
                          <Link to={paths.detail(row.id)} className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-background-300 px-2.5 text-xs font-medium text-foreground-800 transition-colors hover:bg-background-100">
                            {applicantAction.kind === "submit" ? "Resume draft" : applicantAction.label}
                          </Link>
                        ) : (
                          <span className="px-2 text-sm text-foreground-400" title="No action available for your role" data-testid="no-action">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </ResponsiveTable>
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-foreground-500">
              Showing {paged.length} of {remote ? remoteTotal : filtered.length} application{filtered.length === 1 ? "" : "s"}
              {showFilters && !remote ? ` (of ${rows.length} total)` : ""}
            </p>
            {showPagination && totalPages > 1 ? (
              <div className="flex flex-wrap items-center gap-1">
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
      <Toast message={toast.message} onDismiss={toast.dismiss} />
    </div>
  );
}
