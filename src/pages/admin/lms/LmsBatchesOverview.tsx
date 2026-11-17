import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, PageHeader } from "@/pages/admin/components/ui";
import { ListMessage, SearchBox } from "@/pages/admin/components/ListControls";
import { Empty, SkeletonCards } from "@/pages/admin/components/rto/overlay";
import HoursNote from "@/pages/admin/components/rto/HoursNote";
import { monthYear, rto, rtoHoursCheck, shortDate, sortIntakes, type HoursCheck, type RtoIntake } from "@/pages/admin/lib/rto";

/** Every batch (class group) at a glance: students against seats, class days and its intake. A batch opens its own page; new batches are
 *  opened from an intake, or by the system when a batch is full. */
export default function LmsBatchesOverview() {
  const [rows, setRows] = useState<RtoIntake[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [hours, setHours] = useState<Record<string, HoursCheck>>({});
  useEffect(() => {
    rto<RtoIntake[]>("intake_list").then((r) => setRows(r)).catch((e) => { setError(e instanceof Error ? e.message : "Batches did not load."); setRows([]); });
  }, []);
  useEffect(() => {
    let live = true;
    void rtoHoursCheck((rows ?? []).flatMap((i) => (i.batchList ?? []).filter((b) => b.isActive).map((b) => b.id))).then((r) => { if (live) setHours(r); });
    return () => { live = false; };
  }, [rows]);
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byCourse = new Map<string, { title: string; items: { intake: RtoIntake; batch: NonNullable<RtoIntake["batchList"]>[number] }[] }>();
    for (const intake of sortIntakes(rows ?? [])) {
      for (const batch of intake.batchList ?? []) {
        if (!batch.isActive) continue;
        if (q && !`${batch.name} ${intake.courseCode} ${intake.courseName} ${monthYear(intake.startDate)}`.toLowerCase().includes(q)) continue;
        const g = byCourse.get(intake.courseId) ?? { title: `${intake.courseCode ? intake.courseCode + " · " : ""}${intake.courseName}`, items: [] };
        g.items.push({ intake, batch }); byCourse.set(intake.courseId, g);
      }
    }
    return [...byCourse.values()];
  }, [rows, search]);
  return (
    <div>
      <PageHeader title="Batches" description="A batch is one class group in one room. Students are placed in a batch with a free seat; a new batch opens by itself when one is full." />
      <div className="mb-4"><SearchBox label="Search batches" value={search} onSearch={setSearch} placeholder="Search batch, course or intake" /></div>
      {error ? <Card><ListMessage icon="ri-error-warning-line" title="Batches did not load" text={error} /></Card> : null}
      {rows === null ? <SkeletonCards /> : groups.length === 0 && !error ? (
        <Empty icon="ri-group-line" title={search ? "No batches match" : "No batches yet"} text={search ? "Check the spelling or clear the search." : "Batches open when you add students to an intake, or you can add one inside an intake."}
          action={<Link to="/admin/lms/intakes" className="rounded-md bg-primary-500 px-4 py-2 text-sm font-semibold text-background-50">Go to intakes</Link>} />
      ) : groups.map((g) => (
        <section key={g.title} className="mb-6">
          <h2 className="mb-2 font-heading text-lg font-semibold text-foreground-900">{g.title}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map(({ intake, batch }) => {
              const full = !!batch.capacity && batch.enrolled >= batch.capacity;
              return (
                <Link key={batch.id} to={`/admin/batches/${batch.id}`} className="block rounded-card border border-background-200 bg-background-50 p-4 hover:border-primary-300 hover:shadow-md">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="font-heading text-xl font-bold text-foreground-950">{batch.name}</p>
                    <span className={`text-sm tabular-nums ${full ? "font-semibold text-primary-700" : "text-foreground-600"}`}>
                      {batch.capacity ? `${batch.enrolled} of ${batch.capacity} seats${full ? " · full" : ""}` : `${batch.enrolled} student${batch.enrolled === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-foreground-700">{batch.days.length ? batch.days.join(", ") : "No class days set"}</p>
                  <p className="mt-1 text-xs text-foreground-500">Intake {monthYear(intake.startDate)} · starts {shortDate(intake.startDate)}</p>
                  <HoursNote check={hours[batch.id]} compact />
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
