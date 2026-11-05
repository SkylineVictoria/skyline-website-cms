import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Card, EmptyState, PageHeader, Select, TextInput } from "@/pages/admin/components/ui";
import { adminListStaff, type StaffListRow } from "@/lib/staffApi";
import { STAFF_STATUSES, STAFF_STATUS_LABEL, STAFF_STATUS_TONE } from "@/lib/staffStatus";

/** Agencies > Staff: staff applications and accounts, filtered by status, searchable by name, email or mobile. Admins only. */
export default function StaffPage() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ total: number; rows: StaffListRow[] } | null>(null);
  const [error, setError] = useState("");

  // Searching waits for a pause in typing.
  useEffect(() => { const t = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(t); }, [search]);

  const load = useCallback(async () => {
    setError("");
    try { setData(await adminListStaff(status, query)); }
    catch (e) { setData(null); setError(e instanceof Error ? e.message : "The staff list could not be loaded."); }
  }, [status, query]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <PageHeader title="Staff" description="People who applied for a staff account, and current staff. Open an application to see their details and documents, then approve with a role or reject with a note." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-64"><TextInput type="search" placeholder="Search name, email or mobile" aria-label="Search staff" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="w-full sm:w-48">
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STAFF_STATUSES.map((s) => <option key={s} value={s}>{STAFF_STATUS_LABEL[s]}</option>)}
          </Select>
        </div>
        {data ? <p className="text-xs text-foreground-500" role="status">{data.total} {data.total === 1 ? "person" : "people"}</p> : null}
      </div>
      {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {data && data.rows.length === 0 ? <EmptyState icon="ri-user-line" title="No staff yet" description="Staff applications appear here after someone applies from Enroll now > Staff." /> : null}
      {data && data.rows.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm" data-testid="staff-table">
            <thead className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
              <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Mobile</th><th className="px-4 py-3">Requested role</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Updated</th></tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id} className="border-b border-background-100 last:border-0 hover:bg-background-100">
                  <td className="px-4 py-3 font-medium"><Link to={`/admin/staff/${row.id}`} className="text-primary-700 hover:underline">{row.name || "(no name yet)"}</Link></td>
                  <td className="px-4 py-3 text-foreground-700">{row.email}</td>
                  <td className="px-4 py-3 text-foreground-700">{row.phone}</td>
                  <td className="px-4 py-3 capitalize text-foreground-700">{row.role ?? row.requestedRole ?? "—"}</td>
                  <td className="px-4 py-3"><Badge tone={STAFF_STATUS_TONE[row.status]}>{STAFF_STATUS_LABEL[row.status]}</Badge></td>
                  <td className="px-4 py-3 text-xs text-foreground-500">{new Date(row.updatedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
