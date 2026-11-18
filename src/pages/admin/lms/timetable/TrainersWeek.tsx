// One row per trainer, one column per weekday: what each trainer teaches this week, double bookings in red, trainers with no class.
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/pages/admin/components/ui";
import { addDays, mondayOf, shortDate, timeRange, todayIso } from "@/pages/admin/lib/rto";
import { courseColour, loadCalendar, overlaps, type CalClass, type CalPeople } from "./calendarData";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function TrainersWeek({ people }: { people: CalPeople | null }) {
  const [week, setWeek] = useState(mondayOf(todayIso()));
  const [classes, setClasses] = useState<CalClass[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setClasses(null); setError("");
    loadCalendar(week, addDays(week, 6)).then((r) => { if (live) setClasses(r); })
      .catch((e) => { if (live) { setError(e instanceof Error ? e.message : "The classes did not load."); setClasses([]); } });
    return () => { live = false; };
  }, [week]);

  const rows = useMemo(() => {
    const list = classes ?? [];
    const named = new Map<string, string>((people?.trainers ?? []).map((t) => [t.id, t.name]));
    for (const c of list) for (const t of c.trainers) named.set(t.id, t.name);
    const out = [...named.entries()].map(([id, name]) => {
      const mine = list.filter((c) => c.trainers.some((t) => t.id === id));
      const double = new Set(mine.filter((a) => mine.some((b) => overlaps(a, b))).map((c) => c.id));
      const hours = mine.reduce((h, c) => h + (Number(c.end.slice(0, 2)) * 60 + Number(c.end.slice(3)) - Number(c.start.slice(0, 2)) * 60 - Number(c.start.slice(3))) / 60, 0);
      return { id, name, mine, double, hours };
    }).sort((a, b) => b.mine.length - a.mine.length || a.name.localeCompare(b.name));
    const none = list.filter((c) => !c.trainers.length);
    return { out, none };
  }, [classes, people]);
  const days = Array.from({ length: 7 }, (_, n) => addDays(week, n));
  const chip = (c: CalClass, red: boolean) => (
    <div key={c.id} title={`${c.unitCode ?? ""} ${c.unitName ?? ""} · ${c.room ?? "No room"}`}
      className={`rounded border px-1.5 py-0.5 text-xs ${courseColour(c.courseId)} ${red ? "ring-2 ring-red-500" : ""}`}>
      <b>{timeRange(c.start, c.end)}</b> {c.courseCode} {c.batch}<span className="block truncate">{c.unitCode} · {c.room ?? "No room"}</span>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><i className="ri-arrow-left-s-line" aria-hidden="true" /></Button>
        <Button size="sm" variant="outline" onClick={() => setWeek(mondayOf(todayIso()))}>This week</Button>
        <Button size="sm" variant="outline" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><i className="ri-arrow-right-s-line" aria-hidden="true" /></Button>
        <h3 className="ml-1 font-heading text-lg font-semibold">{shortDate(week)} – {shortDate(addDays(week, 6))}</h3>
        <span className="ml-auto text-sm text-foreground-500">Red outline: the trainer has two classes at the same time.</span>
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      {!classes ? <p className="text-sm text-foreground-500">Loading…</p> : (
        <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[1000px] table-fixed text-left">
            <thead><tr className="bg-background-100 text-xs text-foreground-600">
              <th className="w-48 px-2 py-2">Trainer</th>
              {days.map((d, n) => <th key={d} className={`px-2 py-2 ${d === todayIso() ? "text-primary-700" : ""}`}>{DAY_NAMES[n]} {Number(d.slice(8))}</th>)}
            </tr></thead>
            <tbody>
              {rows.out.map((r) => (
                <tr key={r.id} className="border-t border-background-200 align-top">
                  <td className="px-2 py-2 text-sm">
                    <b className="text-foreground-950">{r.name}</b>
                    <span className="block text-xs text-foreground-500">{r.mine.length ? `${r.mine.length} class${r.mine.length === 1 ? "" : "es"} · ${Math.round(r.hours * 10) / 10} h` : "No classes this week"}</span>
                    {r.double.size ? <span className="block text-xs font-semibold text-red-700">Double booked</span> : null}
                  </td>
                  {days.map((d) => <td key={d} className="space-y-1 px-1 py-1.5">{r.mine.filter((c) => c.date === d).map((c) => chip(c, r.double.has(c.id)))}</td>)}
                </tr>
              ))}
              {rows.none.length ? (
                <tr className="border-t border-background-200 bg-amber-50 align-top">
                  <td className="px-2 py-2 text-sm"><b className="text-amber-900">No trainer set</b><span className="block text-xs text-amber-800">{rows.none.length} class{rows.none.length === 1 ? "" : "es"}: set a trainer on the intake</span></td>
                  {days.map((d) => <td key={d} className="space-y-1 px-1 py-1.5">{rows.none.filter((c) => c.date === d).map((c) => chip(c, false))}</td>)}
                </tr>
              ) : null}
              {!rows.out.length && !rows.none.length ? <tr><td colSpan={8} className="p-6 text-center text-sm text-foreground-500">No classes this week.</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
