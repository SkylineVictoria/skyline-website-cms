import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, PageHeader, Select, TextInput } from "@/pages/admin/components/ui";
import { formatDate, queryAgencies, type AgencySummary } from "@/pages/agency/lib/portalData";

const PAGE_SIZE = 10;

/** Agencies (administrators only): the agency list with counts, search, status filter and paging, all done by the query. */
export default function AgenciesPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AgencySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      queryAgencies({ search, status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
        .then((result) => { if (active) { setRows(result.rows); setTotal(result.total); } })
        .catch((e) => { if (active) setError(e instanceof Error ? e.message : "We could not load agencies."); })
        .finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, status, page, retry]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(search.trim() || status);

  return (
    <div>
      <PageHeader
        breadcrumb="Agencies"
        title="Agencies"
        description="The education agencies that submit student applications. Open an agency to manage its details, agents and applications."
        actions={<Link to="/admin/agencies/new"><Button icon="ri-add-line">Add agency</Button></Link>}
      />

      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <TextInput type="search" aria-label="Search agencies" placeholder="Search by name, code or email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <Select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="sm:w-44">
            <option value="">All statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </Select>
        </div>
      </Card>

      <Card>
        {error ? (
          <div role="alert" className="p-6 text-sm text-red-700">
            {error} <button type="button" className="font-semibold underline" onClick={() => setRetry((n) => n + 1)}>Try again</button>
          </div>
        ) : !loading && rows.length === 0 ? (
          <EmptyState
            icon="ri-building-line"
            title={filtered ? "No agencies match" : "No agencies yet"}
            description={filtered ? "Try a different search or status." : "No agencies yet. Add your first agency."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm" aria-busy={loading}>
              <thead>
                <tr className="border-b border-background-200 text-xs uppercase text-foreground-500">
                  <th className="p-4">Agency</th>
                  <th className="p-4">Agents</th>
                  <th className="p-4">Applications</th>
                  <th className="p-4">Status</th>
                  <th className="p-4">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-background-200">
                {rows.map((agency) => (
                  <tr key={agency.id}>
                    <td className="p-4">
                      <Link to={`/admin/agencies/${agency.id}`} className="font-semibold text-foreground-900 hover:text-primary-700">{agency.name}</Link>
                      <div className="text-xs text-foreground-500">{agency.code}</div>
                    </td>
                    <td className="p-4">{agency.agentCount}</td>
                    <td className="p-4">{agency.applicationCount}</td>
                    <td className="p-4"><Badge tone={agency.status === "Active" ? "success" : "muted"}>{agency.status}</Badge></td>
                    <td className="p-4 text-xs text-foreground-600">{formatDate(agency.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between border-t border-background-200 p-4 text-xs text-foreground-600">
            <span>Page {Math.min(page, pages)} of {pages} · {total} agencies</span>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </span>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
