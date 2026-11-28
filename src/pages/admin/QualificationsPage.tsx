import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card, PageHeader } from "@/pages/admin/components/ui";
import { ListMessage } from "@/pages/admin/components/ListControls";
import QualificationsTable from "@/pages/admin/components/QualificationsTable";
import { formatQualificationDate, listQualifications, openQualificationTasks, QUALIFICATION_LABELS, QUALIFICATION_STATUSES, type OpenQualificationTask, type QualificationRow } from "@/lib/qualification";
import AxcelerateRecordImport from "@/components/axcelerate/AxcelerateRecordImport";

/** QUALIFICATION-FILTERS (owner 2026-11-27): "Needs placement" and "PRISMS to report", from the open tasks (?task=place|prisms). */
type TaskFilter = "place" | "prisms";
const TASK_KIND = { place: "place_manually", prisms: "prisms_report" } as const;

/** Admissions › Qualifications: every student's Qualification, filtered by status (?status=active,deferred) and searched. */
export default function QualificationsPage() {
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") ?? "").split(",").filter(Boolean);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [rows, setRows] = useState<QualificationRow[] | null>(null);
  const [error, setError] = useState("");
  const statusKey = status.join(",");
  const query = params.get("q") ?? "";
  const task = (["place", "prisms"] as const).find((t) => t === params.get("task")) ?? null;
  const [tasks, setTasks] = useState<Record<TaskFilter, OpenQualificationTask[] | null>>({ place: null, prisms: null });
  useEffect(() => {
    let live = true;
    for (const k of ["place", "prisms"] as const) void openQualificationTasks(TASK_KIND[k]).then((x) => { if (live) setTasks((t) => ({ ...t, [k]: x })); }, () => { if (live) setTasks((t) => ({ ...t, [k]: [] })); });
    return () => { live = false; };
  }, []);
  const taskIds = task ? new Set((tasks[task] ?? []).map((x) => x.enrolmentId).filter(Boolean)) : null;
  const shown = rows && taskIds ? rows.filter((r) => taskIds.has(r.id)) : rows;
  // rule-policy: technical qualification-filters Display only: the list filters read the open tasks the database raised; no rule is decided here.
  const waiting = task === "place" ? (tasks.place ?? []).filter((x) => !x.enrolmentId) : [];
  const setTask = (t: TaskFilter) => { const p = new URLSearchParams(params); if (task === t) p.delete("task"); else p.set("task", t); setParams(p, { replace: true }); };

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
      <PageHeader title="Qualifications" description="Every student's Qualification: the course they are enrolled in, its intake, status and dates."
        actions={<AxcelerateRecordImport kind="students" label="Import from aXcelerate" />} />
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="qualification-filters">
        <button type="button" onClick={() => setParams(new URLSearchParams(query ? { q: query } : {}), { replace: true })}
          className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${status.length ? "border-background-300 bg-background-50 text-foreground-700" : "border-primary-500 bg-primary-500 text-background-50"}`}>All</button>
        {QUALIFICATION_STATUSES.map((s) => (
          <button key={s} type="button" onClick={() => toggle(s)} aria-pressed={status.includes(s)}
            className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${status.includes(s) ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-700 hover:bg-background-100"}`}>
            {QUALIFICATION_LABELS[s]}
          </button>
        ))}
        {([["place", "Needs placement"], ["prisms", "PRISMS to report"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTask(k)} aria-pressed={task === k} data-testid={`filter-${k}`}
            className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${task === k ? "border-amber-600 bg-amber-600 text-white" : "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"}`}>
            {label} <span className="tabular-nums opacity-80">{tasks[k] === null ? "–" : tasks[k]!.length}</span>
          </button>
        ))}
        <form onSubmit={submit} className="ml-auto flex gap-2">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Student, number, course or CoE"
            className="h-9 w-64 rounded-md border border-background-300 bg-background-50 px-3 text-sm" aria-label="Search Qualifications" />
        </form>
      </div>
      {waiting.length ? <Card className="mb-4">
        <div className="border-b border-background-200 px-4 py-3"><h2 className="font-heading text-base font-semibold text-foreground-900">Waiting for placement <span className="font-normal text-foreground-500">{waiting.length}</span></h2>
          {/* // rule-policy: technical qualification-filters Display only: the list filters read the open tasks the database raised; no rule is decided here. */}
          <p className="text-xs text-foreground-600">Enrolled, but the placement in the intake did not go through, so there is no Qualification yet. Place the student by hand from their page.</p></div>
        <ul className="divide-y divide-background-100" data-testid="waiting-placement">{waiting.map((x) => <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm" data-testid="waiting-placement-item">
          <span className="min-w-0">{x.studentId ? <Link className="font-medium text-foreground-900 hover:text-primary-700" to={`/admin/students/${x.studentId}`}>{x.studentName ?? "Student"}</Link> : <span className="font-medium">{x.studentName ?? "Student"}</span>}
            {x.applicationId ? <> · <Link className="text-primary-700 hover:underline" to={`/admin/applications/${x.applicationId}`}>{x.applicationReference ?? "Application"}</Link></> : null}
            {x.detail ? <span className="block text-xs text-foreground-600">{x.detail}</span> : null}</span>
          {/* // rule-policy: technical qualification-filters Display only: the list filters read the open tasks the database raised; no rule is decided here. */}
          {x.dueOn ? <span className="text-xs text-foreground-500">Due {formatQualificationDate(x.dueOn)}</span> : null}</li>)}</ul>
      </Card> : null}
      <Card>
        {error ? <p className="p-4 text-sm text-red-700" role="alert">{error}</p>
          : shown === null || (task && tasks[task] === null) ? <p className="p-4 text-sm text-foreground-500">Loading…</p>
          : shown.length ? <QualificationsTable rows={shown} />
          : <ListMessage icon="ri-graduation-cap-line" title="No Qualifications" text={task === "place" ? "No Qualification is waiting for placement." : task === "prisms" ? "Nothing to report in PRISMS." : "No Qualification matches these filters."} />}
      </Card>
    </div>
  );
}
