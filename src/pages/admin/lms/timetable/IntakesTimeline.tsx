// Every intake as a bar across the months, its units inside, grouped by course: what runs at the same time and where intakes roll on.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/pages/admin/components/ui";
import { addDays, daysBetween, shortDate, todayIso } from "@/pages/admin/lib/rto";
import { courseBar, loadTimeline, type TimelineIntake } from "./calendarData";

const monthStart = (iso: string, plus = 0) => { const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + plus); return d.toISOString().slice(0, 10); };
const UNIT_SHADES = ["bg-white/35", "bg-black/10"];

export default function IntakesTimeline() {
  const [from, setFrom] = useState(monthStart(todayIso(), -3));
  const to = monthStart(from, 24);
  const [rows, setRows] = useState<TimelineIntake[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setRows(null); setError("");
    loadTimeline(from, addDays(to, -1)).then((r) => { if (live) setRows(r); })
      .catch((e) => { if (live) { setError(e instanceof Error ? e.message : "The intakes did not load."); setRows([]); } });
    return () => { live = false; };
  }, [from, to]);

  const total = daysBetween(from, to);
  const pct = (iso: string) => `${Math.min(100, Math.max(0, (daysBetween(from, iso) / total) * 100))}%`;
  const width = (a: string, b: string) => {
    const s = a < from ? from : a, e = b > to ? to : b;
    return `${Math.max(0.4, (daysBetween(s, addDays(e, 1)) / total) * 100)}%`;
  };
  const months = Array.from({ length: 24 }, (_, n) => monthStart(from, n));
  const groups = useMemo(() => {
    const m = new Map<string, { title: string; items: TimelineIntake[] }>();
    for (const i of rows ?? []) { const g = m.get(i.courseId) ?? { title: `${i.courseCode} · ${i.courseName}`, items: [] }; g.items.push(i); m.set(i.courseId, g); }
    return [...m.entries()];
  }, [rows]);
  const today = todayIso();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setFrom(monthStart(from, -6))} aria-label="Earlier"><i className="ri-arrow-left-s-line" aria-hidden="true" /></Button>
        <Button size="sm" variant="outline" onClick={() => setFrom(monthStart(todayIso(), -3))}>Now</Button>
        <Button size="sm" variant="outline" onClick={() => setFrom(monthStart(from, 6))} aria-label="Later"><i className="ri-arrow-right-s-line" aria-hidden="true" /></Button>
        <h3 className="ml-1 font-heading text-lg font-semibold">{shortDate(from)} – {shortDate(addDays(to, -1))}</h3>
        <span className="ml-auto text-sm text-foreground-500">Each bar is an intake; the stripes inside are its units (hover for the unit). Click an intake to open it.</span>
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      {!rows ? <p className="text-sm text-foreground-500">Loading…</p> : !rows.length ? <p className="rounded-lg border border-dashed border-background-300 p-8 text-center text-sm text-foreground-500">No intake in these months.</p> : (
        <div className="overflow-x-auto rounded-lg border border-background-200 bg-background-50">
          <div className="min-w-[1100px]">
            <div className="grid grid-cols-[260px_minmax(0,1fr)] border-b border-background-200 bg-background-100 text-xs text-foreground-600">
              <div className="px-3 py-2 font-semibold">Intake</div>
              <div className="relative h-10">
                {months.map((m) => <span key={m} className="absolute top-0 h-full border-l border-background-300 pl-1 pt-1 leading-tight" style={{ left: pct(m) }}>
                  {new Date(`${m}T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" }).slice(0, 3)}
                  {m.slice(5, 7) === "01" || m === from ? <span className="block text-2xs font-semibold text-foreground-800">{m.slice(0, 4)}</span> : null}</span>)}
              </div>
            </div>
            {groups.map(([courseId, g]) => (
              <div key={courseId}>
                <div className="border-b border-background-200 bg-background-100/60 px-3 py-1.5 text-sm font-semibold text-foreground-900">{g.title}</div>
                {g.items.map((i) => (
                  <div key={i.id} className="grid grid-cols-[260px_minmax(0,1fr)] border-b border-background-200">
                    <Link to={`/admin/lms/intakes#${i.id}`} className="px-3 py-2 text-sm hover:bg-background-100">
                      <b className="text-foreground-950">{shortDate(i.startDate)} – {shortDate(i.endDate)}</b>
                      <span className="block text-xs text-foreground-500">{[i.studyLoad?.toUpperCase(), i.autoCreated ? "automatic" : "made by staff", i.batches ? "classes set up" : "classes not set up", `${i.students} student${i.students === 1 ? "" : "s"}`, i.status === "closed" ? "closed" : ""].filter(Boolean).join(" · ")}</span>
                    </Link>
                    <div className="relative h-14">
                      {months.map((m) => <span key={m} className="absolute top-0 h-full border-l border-background-200" style={{ left: pct(m) }} />)}
                      {today >= from && today < to ? <span className="absolute top-0 z-10 h-full border-l-2 border-red-500" style={{ left: pct(today) }} title="Today" /> : null}
                      <Link to={`/admin/lms/intakes#${i.id}`} title={`${i.courseCode} ${shortDate(i.startDate)} – ${shortDate(i.endDate)}`}
                        className={`absolute top-3 flex h-8 overflow-hidden rounded ${courseBar(i.courseId)} ${i.status === "closed" ? "opacity-40" : ""}`}
                        style={{ left: pct(i.startDate < from ? from : i.startDate), width: width(i.startDate, i.endDate) }}>
                        {i.units.filter((u) => u.end >= from && u.start < to).map((u, n) => {
                          const span = Math.max(1, daysBetween(i.startDate < from ? from : i.startDate, addDays(i.endDate > to ? to : i.endDate, 1)));
                          const s = u.start < from ? from : u.start, e = u.end > to ? addDays(to, -1) : u.end;
                          return <span key={`${u.code}-${n}`} title={`${u.code} ${u.name}: ${shortDate(u.start)} – ${shortDate(u.end)}`}
                            className={`absolute top-0 h-full border-r border-white/60 ${UNIT_SHADES[n % 2]}`}
                            style={{ left: `${(daysBetween(i.startDate < from ? from : i.startDate, s) / span) * 100}%`, width: `${(Math.max(1, daysBetween(s, addDays(e, 1))) / span) * 100}%` }} />;
                        })}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
