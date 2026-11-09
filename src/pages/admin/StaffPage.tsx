import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge, Card, EmptyState, PageHeader, TextInput } from "@/pages/admin/components/ui";
import { adminListStaff, type StaffListRow } from "@/lib/staffApi";
import { EMPLOYEE_TABS, STAFF_STATUS_LABEL, STAFF_STATUS_TONE, employeeTab, expiryState } from "@/lib/staffStatus";
import { staffEmployeePath } from "@/pages/admin/lib/staffRoutes";

const APPLICATIONS = EMPLOYEE_TABS.find((t) => t.countBadge) ?? EMPLOYEE_TABS[0];

/** Staff > Employees: tabs by status (hr_admin_staff_list p_statuses), searchable by name, email or mobile. Admins only. */
export default function StaffPage() {
  const [params, setParams] = useSearchParams();
  const tab = employeeTab(params.get("tab"));
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ total: number; rows: StaffListRow[] } | null>(null);
  const [error, setError] = useState("");

  // Searching waits for a pause in typing.
  useEffect(() => { const t = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(t); }, [search]);

  const load = useCallback(async () => {
    setError("");
    try {
      // The Applications badge counts every application waiting for a decision, whatever tab or search is shown.
      const [list, waiting] = await Promise.all([adminListStaff(tab.statuses, query), adminListStaff(APPLICATIONS.statuses, "", 1, 0)]);
      setData(list); setPendingCount(waiting.total);
    } catch (e) { setData(null); setError(e instanceof Error ? e.message : "The staff list could not be loaded."); }
  }, [tab, query]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <PageHeader breadcrumb="Staff" title="Employees" description="People who applied for a staff account, and current staff. Open one to preview and approve or reject each document, then activate the account with a role or reject it with a note. Expiring soon means a passport, visa or health insurance expires within 30 days." />
      <div role="tablist" aria-label="Employees by status" className="mb-4 flex flex-wrap gap-1 border-b border-background-200">
        {EMPLOYEE_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === tab.id} data-testid={`employees-tab-${t.id}`}
            onClick={() => setParams((p) => { const next = new URLSearchParams(p); next.set("tab", t.id); return next; }, { replace: true })}
            className={`-mb-px flex cursor-pointer items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold ${t.id === tab.id ? "border-primary-500 text-primary-800" : "border-transparent text-foreground-600 hover:text-foreground-900"}`}>
            {t.label}
            {t.countBadge && pendingCount !== null ? <span data-testid={`employees-tab-${t.id}-count`} className="rounded-full bg-primary-100 px-2 py-0.5 text-xs font-semibold text-primary-900">{pendingCount}</span> : null}
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-64"><TextInput type="search" placeholder="Search name, email or mobile" aria-label="Search staff" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        {data ? <p className="text-xs text-foreground-500" role="status">{data.total} {data.total === 1 ? "person" : "people"}</p> : null}
      </div>
      {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {data && data.rows.length === 0 ? <EmptyState icon="ri-user-line" title={tab.id === "applications" ? "No applications waiting" : tab.id === "active" ? "No active staff" : "No inactive or rejected staff"} description="Staff applications appear under Applications once someone applies from Enroll now > Staff and submits." /> : null}
      {data && data.rows.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm" data-testid="staff-table">
            <thead className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
              <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Docs approved</th><th className="px-4 py-3">Expiry</th><th className="px-4 py-3">Updated</th></tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id} className="border-b border-background-100 last:border-0 hover:bg-background-100">
                  <td className="px-4 py-3 font-medium"><Link to={staffEmployeePath(row.id)} className="text-primary-700 hover:underline">{row.name || "(no name yet)"}</Link><span className="block text-xs font-normal text-foreground-500">{row.email}</span></td>
                  <td className="px-4 py-3 capitalize text-foreground-700">{row.role ?? row.requestedRole ?? "—"}{!row.role && row.requestedRole ? <span className="block text-xs normal-case text-foreground-500">requested</span> : null}</td>
                  <td className="px-4 py-3"><Badge tone={STAFF_STATUS_TONE[row.status]}>{STAFF_STATUS_LABEL[row.status]}</Badge></td>
                  <td className="px-4 py-3 text-foreground-700" data-testid="staff-docs-count" title={`${row.docs.uploaded} of ${row.docs.required} uploaded${row.docs.rejected ? `, ${row.docs.rejected} rejected` : ""}`}>
                    {row.docs.approved}/{row.docs.required}{row.docs.rejected ? <span className="ml-1.5 text-xs text-primary-800">({row.docs.rejected} rejected)</span> : null}
                  </td>
                  <td className="px-4 py-3">{row.docs.expiringSoon ? <span data-testid="staff-expiring"><Badge tone="warn">{expiryState(row.docs.nextExpiry) === "expired" ? "Expired" : "Expiring soon"}</Badge></span> : <span className="text-xs text-foreground-500">—</span>}</td>
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
