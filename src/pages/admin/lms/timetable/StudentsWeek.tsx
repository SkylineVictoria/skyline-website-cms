// Student availability (owner, 2026-11-20): like the trainers' week, one row per placed student and one column per weekday,
// showing the classes each student has that week (their own intake's and late joiners' classes), double bookings in red and
// students with no class. Each student's week is read with the calendar's student filter.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, TextInput } from "@/pages/admin/components/ui";
import { addDays, mondayOf, shortDate, timeRange, todayIso } from "@/pages/admin/lib/rto";
import { courseColour, loadCalendar, overlaps, type CalClass, type CalPeople } from "./calendarData";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export default function StudentsWeek({ people }: { people: CalPeople | null }) {
  const [week, setWeek] = useState(mondayOf(todayIso()));
  const [query, setQuery] = useState("");
  const [byStudent, setByStudent] = useState<Record<string, CalClass[]> | null>(null);
  const [error, setError] = useState("");
  const students = useMemo(() => people?.students ?? [], [people]);
  const ids = students.map((s) => s.id).join(",");

  useEffect(() => {
    if (!people) return;
    let live = true;
    setByStudent(null); setError("");
    void Promise.all(students.map((s) => loadCalendar(week, addDays(week, 6), { studentId: s.id }).then((list) => [s.id, list] as const)))
      .then((pairs) => { if (live) setByStudent(Object.fromEntries(pairs)); })
      .catch((e) => { if (live) { setError(e instanceof Error ? e.message : "The students' classes did not load."); setByStudent({}); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the week and the students
  }, [week, ids, !!people]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return students.filter((s) => !q || `${s.name} ${s.email ?? ""}`.toLowerCase().includes(q)).map((s) => {
      const mine = byStudent?.[s.id] ?? [];
      const double = new Set(mine.filter((a) => mine.some((b) => overlaps(a, b))).map((c) => c.id));
      const hours = mine.reduce((h, c) => h + (minutes(c.end) - minutes(c.start)) / 60, 0);
      return { ...s, mine, double, hours };
    }).sort((a, b) => b.mine.length - a.mine.length || a.name.localeCompare(b.name));
  }, [students, byStudent, query]);
  const days = Array.from({ length: 7 }, (_, n) => addDays(week, n));
  const chip = (c: CalClass, red: boolean) => (
    <div key={c.id} title={`${c.unitCode ?? ""} ${c.unitName ?? ""} · ${c.room ?? "No room"}`}
      className={`rounded border px-1.5 py-0.5 text-xs ${courseColour(c.courseId)} ${red ? "ring-2 ring-red-500" : ""}`}>
      <b>{timeRange(c.start, c.end)}</b> {c.courseCode}<span className="block truncate">{c.unitCode} · {c.room ?? "No room"}</span>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><i className="ri-arrow-left-s-line" aria-hidden="true" /></Button>
        <Button size="sm" variant="outline" onClick={() => setWeek(mondayOf(todayIso()))}>This week</Button>
        <Button size="sm" variant="outline" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><i className="ri-arrow-right-s-line" aria-hidden="true" /></Button>
        <h3 className="ml-1 font-heading text-lg font-semibold">{shortDate(week)} – {shortDate(addDays(week, 6))}</h3>
        <TextInput className="!w-56" aria-label="Search students" placeholder="Search name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="ml-auto text-sm text-foreground-500">Red outline: the student has two classes at the same time.</span>
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      {!people || !byStudent ? <p className="text-sm text-foreground-500">Loading…</p> : !students.length ? (
        <p className="rounded-lg border border-dashed border-background-300 p-8 text-center text-sm text-foreground-500">No student is placed in an intake yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[1000px] table-fixed text-left">
            <thead><tr className="bg-background-100 text-xs text-foreground-600">
              <th className="w-52 px-2 py-2">Student</th>
              {days.map((d, n) => <th key={d} className={`px-2 py-2 ${d === todayIso() ? "text-primary-700" : ""}`}>{DAY_NAMES[n]} {Number(d.slice(8))}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-background-200 align-top">
                  <td className="px-2 py-2 text-sm">
                    <Link to={`/admin/students/${r.id}`} className="font-bold text-foreground-950 hover:underline">{r.name}</Link>
                    <span className="block text-xs text-foreground-500">{r.mine.length ? `${r.mine.length} class${r.mine.length === 1 ? "" : "es"} · ${Math.round(r.hours * 10) / 10} h` : "Free all week"}</span>
                    {r.double.size ? <span className="block text-xs font-semibold text-red-700">Double booked</span> : null}
                  </td>
                  {days.map((d) => <td key={d} className="space-y-1 px-1 py-1.5">{r.mine.filter((c) => c.date === d).map((c) => chip(c, r.double.has(c.id)))}</td>)}
                </tr>
              ))}
              {!rows.length ? <tr><td colSpan={8} className="p-6 text-center text-sm text-foreground-500">No student matches.</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
