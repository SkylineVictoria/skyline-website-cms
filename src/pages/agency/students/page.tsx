import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { listMyStudents, type MyStudentRow } from "@/pages/agency/lib/portalApplications";
import { formatDate } from "@/pages/agency/lib/portalData";
import { PageHeading, PortalEmpty, PortalError, PortalLoading, StatusBadge } from "@/pages/agency/components/PortalUI";
import ResponsiveTable from "@/components/ui/ResponsiveTable";

const PAGE = 25;

/**
 * PORTAL-MY-STUDENTS (owner 2026-11-27): the business admin agent sees "Our <business> Students" (every student of the business);
 * an agent sees "My students" (the students they look after, and students whose applications they can open). The database decides
 * who is listed (portal_my_students); the page only shows it.
 */
export default function PortalStudentsPage() {
  const { role, agency } = usePortalAuth();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<MyStudentRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(0); }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let live = true;
    setError("");
    listMyStudents(query, PAGE, page * PAGE)
      .then((result) => { if (live) { setRows(result.rows); setTotal(result.total); } })
      .catch((e: unknown) => { if (live) { setRows([]); setError(e instanceof Error ? e.message : "The students could not be loaded."); } });
    return () => { live = false; };
  }, [query, page, retry]);

  if (role === "student") return <Navigate to="/agency/applications" replace />;
  const isAdmin = role === "agency_admin" || role === "slit_admin";
  const title = role === "agency_admin" ? (agency?.name ? `${agency.name} Students` : "Students") : role === "slit_admin" ? "Students" : "My students";
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div>
      <PageHeading
        eyebrow="Students"
        title={title}
        description={role === "agency_admin"
          ? `Every student of ${agency?.name ?? "your business"}, with their agent and their latest application.`
          : "The students you look after and their latest application. You never see another agent's students."}
        action={
          <Link to="/agency/applications/new"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600">
            <i className="ri-add-line" aria-hidden="true" /> New application
          </Link>
        }
      />

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block w-full sm:max-w-md">
          <span className="sr-only">Search students</span>
          <i className="ri-search-line pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, student ID or mobile" data-testid="students-search"
            className="w-full rounded-md border border-background-300 bg-background-50 py-2 pl-9 pr-3 text-sm focus:border-primary-500 focus:outline-none" />
        </label>
        <p className="text-sm text-foreground-600">{rows ? `${total} student${total === 1 ? "" : "s"}` : ""}</p>
      </div>

      <div className="mt-4">
        {error ? <PortalError message={error} onRetry={() => setRetry((v) => v + 1)} />
          : !rows ? <PortalLoading label="Loading students…" />
          : rows.length === 0 ? (
            <PortalEmpty icon="ri-user-3-line" title={query ? "No students match" : "No students yet"}
              message={query ? "Try another name, email or student ID." : "Students appear here once you add them with a new application."} />
          ) : (
            <div className="overflow-hidden rounded-card border border-background-200 bg-background-50">
              <ResponsiveTable className="w-full text-left text-sm">
                <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-700">
                  <tr>
                    <th className="px-3 py-2.5 font-semibold">Student</th>
                    <th className="px-3 py-2.5 font-semibold">Mobile</th>
                    {isAdmin ? <th className="px-3 py-2.5 font-semibold">Agent</th> : null}
                    <th className="px-3 py-2.5 font-semibold">Applications</th>
                    <th className="px-3 py-2.5 font-semibold">Latest application</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-t border-background-200" data-testid="student-row">
                      <td data-label="Student" className="px-3 py-3">
                        <p className="font-medium text-foreground-950">{row.name || "Unnamed student"}</p>
                        <p className="text-xs text-foreground-500">{row.email || "—"}{row.studentNumber ? ` · ${row.studentNumber}` : ""}</p>
                      </td>
                      <td data-label="Mobile" className="px-3 py-3 text-xs text-foreground-700">{row.phone || "—"}</td>
                      {isAdmin ? <td data-label="Agent" className="px-3 py-3 text-xs text-foreground-700">{row.agentName || <span className="text-foreground-400">Unassigned</span>}</td> : null}
                      <td data-label="Applications" className="px-3 py-3 text-xs text-foreground-700">{row.applications}</td>
                      <td data-label="Latest application" className="px-3 py-3">
                        {row.latest ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Link to={`/agency/applications/${row.latest.id}`} className="font-mono text-xs font-semibold text-foreground-900 hover:text-primary-700 hover:underline">
                              {row.latest.reference || "Application"}
                            </Link>
                            <StatusBadge status={row.latest.status} />
                            <span className="text-2xs text-foreground-500">{formatDate(row.latest.updatedAt)}</span>
                          </div>
                        ) : <span className="text-xs text-foreground-400">No application yet</span>}
                      </td>
                      <td data-label="Actions" className="whitespace-nowrap px-3 py-3 text-right">
                        {row.latest ? (
                          <Link to={`/agency/applications/${row.latest.id}`}
                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-background-300 px-2.5 text-xs font-medium text-foreground-800 hover:bg-background-100">Open</Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTable>
            </div>
          )}
      </div>

      {rows && pages > 1 ? (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}
            className="rounded-md border border-background-300 px-3 py-1.5 font-semibold disabled:opacity-50">Previous</button>
          <span>Page {page + 1} of {pages}</span>
          <button type="button" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-background-300 px-3 py-1.5 font-semibold disabled:opacity-50">Next</button>
        </div>
      ) : null}
    </div>
  );
}
