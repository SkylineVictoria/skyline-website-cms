import { useMemo, useState } from "react";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Badge, Card, EmptyState, PageHeader, Select, StatCard, TextInput } from "@/pages/admin/components/ui";

export default function ActivityPage() {
  const { data } = useAdminData();
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("All");

  const areas = useMemo(() => ["All", ...Array.from(new Set(data.activity.map((a) => a.area)))], [data.activity]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.activity.filter((a) => {
      const matchesQ = !q || a.item.toLowerCase().includes(q) || a.user.toLowerCase().includes(q) || a.action.toLowerCase().includes(q);
      const matchesArea = area === "All" || a.area === area;
      return matchesQ && matchesArea;
    });
  }, [data.activity, query, area]);

  const todayCount = data.activity.filter((a) => a.at.startsWith("2026-10-12")).length;
  const adminCount = data.activity.filter((a) => a.user === "IT Administrator").length;
  const editorCount = data.activity.filter((a) => a.user === "Marketing Editor").length;

  return (
    <div>
      <PageHeader
        title="Activity / Audit Log"
        description="A record of who changed what, and when — across the whole CMS."
        breadcrumb="Governance"
      />

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Changes today" value={todayCount} icon="ri-history-line" />
        <StatCard label="By IT Administrator" value={adminCount} icon="ri-user-star-line" />
        <StatCard label="By Marketing Editor" value={editorCount} icon="ri-user-line" />
      </div>

      <Card className="mb-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
            <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by user, action or item…" className="pl-9" />
          </div>
          <Select value={area} onChange={(e) => setArea(e.target.value)} className="sm:w-44">
            {areas.map((a) => (
              <option key={a} value={a}>
                {a === "All" ? "All areas" : a}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card>
        {filtered.length === 0 ? (
          <EmptyState icon="ri-history-line" title="No activity found" description="Try a different search or area." />
        ) : (
          <ul className="divide-y divide-background-200">
            {filtered.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3.5 text-[13px]">
                <Badge tone="secondary">{a.area}</Badge>
                <span className="font-medium text-foreground-900">{a.user}</span>
                <span className="text-foreground-600">{a.action}</span>
                <span className="min-w-0 flex-1 truncate text-foreground-700">{a.item}</span>
                <span className="text-xs text-foreground-400">{a.at}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}