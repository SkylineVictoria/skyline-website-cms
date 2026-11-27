import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, PageHeader } from "@/pages/admin/components/ui";
import { ListMessage } from "@/pages/admin/components/ListControls";
import QualificationsTable from "@/pages/admin/components/QualificationsTable";
import { listQualifications, QUALIFICATION_LABELS, QUALIFICATION_STATUSES, type QualificationRow } from "@/lib/qualification";

/** Admissions › Qualifications: every student's Qualification, filtered by status (?status=active,deferred) and searched. */
export default function QualificationsPage() {
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") ?? "").split(",").filter(Boolean);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [rows, setRows] = useState<QualificationRow[] | null>(null);
  const [error, setError] = useState("");
  const statusKey = status.join(",");
  const query = params.get("q") ?? "";

  useEffect(() => {
    let live = true;
    setRows(null);
    listQualifications({ status: statusKey ? statusKey.split(",") : [], search: query })
      .then((data) => { if (live) { setRows(data); setError(""); } }, (e) => { if (live) { setRows([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [statusKey, query]);

  const toggle = (value: string) => {
    const next = status.includes(value) ? status.filter((s) => s !== value) : [...status, value];
    const p = new URLSearchParams(params);
    if (next.length) p.set("status", next.join(",")); else p.delete("status");
    setParams(p, { replace: true });
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams(params);
    if (search.trim()) p.set("q", search.trim()); else p.delete("q");
    setParams(p, { replace: true });
  };

  return (
    <div>
      <PageHeader title="Qualifications" description="Every student's Qualification: the course they are enrolled in, its intake, status and dates." />
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="qualification-filters">
        <button type="button" onClick={() => setParams(new URLSearchParams(query ? { q: query } : {}), { replace: true })}
          className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${status.length ? "border-background-300 bg-background-50 text-foreground-700" : "border-primary-500 bg-primary-500 text-background-50"}`}>All</button>
        {QUALIFICATION_STATUSES.map((s) => (
          <button key={s} type="button" onClick={() => toggle(s)} aria-pressed={status.includes(s)}
            className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${status.includes(s) ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-700 hover:bg-background-100"}`}>
            {QUALIFICATION_LABELS[s]}
          </button>
        ))}
        <form onSubmit={submit} className="ml-auto flex gap-2">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Student, number, course or CoE"
            className="h-9 w-64 rounded-md border border-background-300 bg-background-50 px-3 text-sm" aria-label="Search Qualifications" />
        </form>
      </div>
      <Card>
        {error ? <p className="p-4 text-sm text-red-700" role="alert">{error}</p>
          : rows === null ? <p className="p-4 text-sm text-foreground-500">Loading…</p>
          : rows.length ? <QualificationsTable rows={rows} />
          : <ListMessage icon="ri-graduation-cap-line" title="No Qualifications" text="No Qualification matches these filters." />}
      </Card>
    </div>
  );
}
