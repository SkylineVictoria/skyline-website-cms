import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import ResponsiveTable from "@/components/ui/ResponsiveTable";
import { Badge, Button, Card, PageHeader, StatusBadge } from "@/pages/admin/components/ui";
import { ListMessage, SearchBox } from "@/pages/admin/components/ListControls";
import { ChipFilter } from "@/pages/admin/components/rto/shared";
import { money, rto, shortDate, type RtoCourse } from "@/pages/admin/lib/rto";

/** Master Data › Courses: the one course list. A course's facts, units, fees, intakes, batches and website content open from here. */
export default function CourseFeesPage() {
  const [rows, setRows] = useState<RtoCourse[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [active, setActive] = useState<"" | "active" | "inactive">("");
  const [published, setPublished] = useState<"" | "Published" | "Draft">("");

  const load = useCallback(async () => {
    try { setRows(await rto<RtoCourse[]>("course_list")); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Courses did not load."); setRows([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const categories = useMemo(() => [...new Set((rows ?? []).map((r) => r.category).filter(Boolean))].sort().map((c) => ({ id: c, label: c })), [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => (!q || `${r.code} ${r.name} ${r.cricos} ${r.category}`.toLowerCase().includes(q))
      && (!category || r.category === category) && (!active || (active === "active") === r.isActive) && (!published || r.status === published));
  }, [rows, search, category, active, published]);

  return (
    <div data-testid="course-fees-page">
      <PageHeader title="Courses" description="One record per course: facts, units, fees, intakes, batches and website content. Offer letters and the enrolment form use these fees and intakes." />
      <div className="sticky top-0 z-10 -mx-1 mb-4 space-y-3 bg-background-100/95 px-1 py-2 backdrop-blur">
        <SearchBox label="Search courses" value={search} onSearch={setSearch} placeholder="Search code, name, CRICOS or category" />
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <ChipFilter label="Category" value={category} options={categories} onChange={setCategory} />
          <ChipFilter label="Status" value={active} options={[{ id: "active", label: "Active" }, { id: "inactive", label: "Inactive" }]} onChange={(v) => setActive(v as typeof active)} />
          <ChipFilter label="Website" value={published} options={[{ id: "Published", label: "Published" }, { id: "Draft", label: "Draft" }]} onChange={(v) => setPublished(v as typeof published)} />
        </div>
      </div>
      <Card>
        {error ? (
          <ListMessage icon="ri-error-warning-line" title="Courses did not load" text={error} action={<Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>} />
        ) : rows && shown.length === 0 ? (
          <ListMessage icon="ri-book-2-line" title={rows.length ? "No courses match" : "No courses yet"} text={rows.length ? "Clear a filter or check the spelling." : "Add a course in Website › Course Catalogue."} />
        ) : (
          <ResponsiveTable aria-busy={!rows}>
            <thead>
              <tr>
                <th className="w-[44%]">Course</th>
                <th className="w-[14%]">Units</th>
                <th className="w-[16%]">Next intake</th>
                <th className="w-[14%] text-right">Total fees</th>
                <th className="w-[12%] text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {!rows ? <tr><td colSpan={5} className="py-10 text-center text-foreground-500">Loading courses…</td></tr> : shown.map((r) => (
                <tr key={r.id} className="align-top" data-testid="course-fee-row">
                  <td>
                    <Link to={`/admin/course-fees/${encodeURIComponent(r.id)}`} className="font-medium text-foreground-900 hover:text-primary-600">{r.code ? `${r.code} ` : ""}{r.name}</Link>
                    <p className="text-xs text-foreground-500">{[r.category, r.cricos && `CRICOS ${r.cricos}`, r.duration].filter(Boolean).join(" · ")}</p>
                  </td>
                  <td className="text-sm tabular-nums text-foreground-700">{r.activeUnits}{r.units !== r.activeUnits ? <span className="text-foreground-400"> / {r.units}</span> : null}</td>
                  <td className="text-sm text-foreground-700">{r.nextIntake ? shortDate(r.nextIntake) : <span className="text-foreground-400">None open</span>}</td>
                  <td className="whitespace-nowrap text-right font-semibold tabular-nums">{r.totalCents ? money(r.totalCents) : "—"}</td>
                  <td className="text-right"><div className="flex flex-col items-end gap-1"><StatusBadge status={r.status} />{r.isActive ? null : <Badge>Inactive</Badge>}</div></td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
      </Card>
    </div>
  );
}
