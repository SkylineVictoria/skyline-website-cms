// Student availability (owner, 2026-11-20): like the trainers' and rooms' availability, pick a course, an intake and a student
// (or all of them), then see one row per student and one column per weekday with the classes each student has that week
// (their own intake's and late joiners' classes), double bookings in red and students with no class. Each student's week is
// read with the calendar's student filter; who is in which intake comes from the intakes' batches.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Select, TextInput } from "@/pages/admin/components/ui";
import { addDays, mondayOf, rto, shortDate, timeRange, todayIso, type IntakeDetail } from "@/pages/admin/lib/rto";
import { courseColour, loadCalendar, overlaps, type CalClass, type CalPeople } from "./calendarData";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Where a student is placed: intake, its course, and the intake's name. */
type Place = { intakeId: string; courseId: string; intake: string; type: string };

export default function StudentsWeek({ people }: { people: CalPeople | null }) {
  const [week, setWeek] = useState(mondayOf(todayIso()));
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Record<string, Place[]> | null>(null);
  const [intakeNames, setIntakeNames] = useState<Record<string, string>>({});
  const [byStudent, setByStudent] = useState<Record<string, CalClass[]> | null>(null);
  const [error, setError] = useState("");
  const students = useMemo(() => people?.students ?? [], [people]);

  // Who is in which intake: each intake's batches and their students.
  useEffect(() => {
    if (!people) return;
    let live = true;
    void Promise.all(people.intakes.map((i) => rto<IntakeDetail>("intake_get", { intakeId: i.id }).catch(() => null))).then((details) => {
      if (!live) return;
      const map: Record<string, Place[]> = {}, names: Record<string, string> = {};
      for (const d of details) {
        if (!d) continue;
        const name = d.intake.customName || d.intake.name;
        names[d.intake.id] = name;
        for (const b of d.batches) for (const s of b.students) (map[s.id] ??= []).push({ intakeId: d.intake.id, courseId: d.intake.courseId, intake: name, type: s.type });
      }
      setPlaces(map); setIntakeNames(names);
    });
    return () => { live = false; };
  }, [people]);

  const courses = people?.courses ?? [];
  const intakes = (people?.intakes ?? []).filter((i) => !courseId || i.courseId === courseId);
  const inScope = useMemo(() => students.filter((s) => {
    const mine = places?.[s.id] ?? [];
    if (courseId && !mine.some((p) => p.courseId === courseId)) return false;
    if (intakeId && !mine.some((p) => p.intakeId === intakeId)) return false;
    return true;
  }), [students, places, courseId, intakeId]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inScope.filter((s) => (!studentId || s.id === studentId) && (!q || `${s.name} ${s.email ?? ""}`.toLowerCase().includes(q)));
  }, [inScope, studentId, query]);
  const ids = shown.map((s) => s.id).join(",");

  // Only the students shown are read (one calendar read each).
  useEffect(() => {
    if (!people || !places) return;
    let live = true;
    setByStudent(null); setError("");
    void Promise.all(shown.map((s) => loadCalendar(week, addDays(week, 6), { studentId: s.id }).then((list) => [s.id, list] as const)))
      .then((pairs) => { if (live) setByStudent(Object.fromEntries(pairs)); })
      .catch((e) => { if (live) { setError(e instanceof Error ? e.message : "The students' classes did not load."); setByStudent({}); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the week and the students shown
  }, [week, ids, !!people, !!places]);

  const rows = useMemo(() => shown.map((s) => {
    const mine = byStudent?.[s.id] ?? [];
    const double = new Set(mine.filter((a) => mine.some((b) => overlaps(a, b))).map((c) => c.id));
    const hours = mine.reduce((h, c) => h + (minutes(c.end) - minutes(c.start)) / 60, 0);
    return { ...s, mine, double, hours, place: places?.[s.id] ?? [] };
  }).sort((a, b) => b.mine.length - a.mine.length || a.name.localeCompare(b.name)), [shown, byStudent, places]);
  const days = Array.from({ length: 7 }, (_, n) => addDays(week, n));
  const courseCode = (id: string) => courses.find((c) => c.id === id)?.code ?? "";
  const intakeLabel = (i: { id: string; courseId: string; startDate: string }) => intakeNames[i.id] ?? `${courseCode(i.courseId)} · ${shortDate(i.startDate)}`;
  const chip = (c: CalClass, red: boolean) => (
    <div key={c.id} title={`${c.unitCode ?? ""} ${c.unitName ?? ""} · ${c.room ?? "No room"}${c.trainers.length ? ` · ${c.trainers.map((t) => t.name).join(", ")}` : ""}`}
      className={`rounded border px-1.5 py-0.5 text-xs ${courseColour(c.courseId)} ${red ? "ring-2 ring-red-500" : ""}`}>
      <b>{timeRange(c.start, c.end)}</b> {c.courseCode}<span className="block truncate">{c.unitCode} · {c.room ?? "No room"}</span>
    </div>
  );
  const one = studentId ? rows[0] : null;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-semibold text-foreground-900">Course
          <Select className="mt-1" value={courseId} onChange={(e) => { setCourseId(e.target.value); setIntakeId(""); setStudentId(""); }}>
            <option value="">All courses</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </Select></label>
        <label className="text-sm font-semibold text-foreground-900">Intake
          <Select className="mt-1" value={intakeId} onChange={(e) => { setIntakeId(e.target.value); setStudentId(""); }}>
            <option value="">All intakes</option>{intakes.map((i) => <option key={i.id} value={i.id}>{intakeLabel(i)}</option>)}
          </Select></label>
        <label className="text-sm font-semibold text-foreground-900">Student
          <Select className="mt-1" value={studentId} onChange={(e) => setStudentId(e.target.value)} disabled={!places}>
            <option value="">{places ? `All students (${inScope.length})` : "Loading students…"}</option>
            {inScope.map((s) => <option key={s.id} value={s.id}>{s.name}{s.email ? ` · ${s.email}` : ""}</option>)}
          </Select></label>
        {!studentId ? <label className="text-sm font-semibold text-foreground-900">Search
          <TextInput className="mt-1" aria-label="Search students" placeholder="Name or email" value={query} onChange={(e) => setQuery(e.target.value)} /></label> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><i className="ri-arrow-left-s-line" aria-hidden="true" /></Button>
        <Button size="sm" variant="outline" onClick={() => setWeek(mondayOf(todayIso()))}>This week</Button>
        <Button size="sm" variant="outline" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><i className="ri-arrow-right-s-line" aria-hidden="true" /></Button>
        <h3 className="ml-1 font-heading text-lg font-semibold">{shortDate(week)} – {shortDate(addDays(week, 6))}</h3>
        <span className="ml-auto text-sm text-foreground-500">Red outline: two classes at the same time.</span>
      </div>

      {one ? <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-background-200 bg-background-100 px-3 py-2 text-sm">
        <Link to={`/admin/students/${one.id}`} className="font-bold text-foreground-950 hover:underline">{one.name}</Link>
        {one.place.map((p) => <span key={p.intakeId} className="text-foreground-700">{courseCode(p.courseId)} · {p.intake} · {p.type}</span>)}
        <span className="text-foreground-700">{byStudent ? (one.mine.length ? `${one.mine.length} class${one.mine.length === 1 ? "" : "es"} · ${Math.round(one.hours * 10) / 10} h this week` : "Free all week") : "…"}</span>
      </div> : null}

      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      {!people || !places || !byStudent ? <p className="text-sm text-foreground-500">Loading…</p> : !students.length ? (
        <p className="rounded-lg border border-dashed border-background-300 p-8 text-center text-sm text-foreground-500">No student is placed in an intake yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full min-w-[1000px] table-fixed text-left">
            <thead><tr className="bg-background-100 text-xs text-foreground-600">
              <th className="w-56 px-2 py-2">Student</th>
              {days.map((d, n) => <th key={d} className={`px-2 py-2 ${d === todayIso() ? "text-primary-700" : ""}`}>{DAY_NAMES[n]} {Number(d.slice(8))}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-background-200 align-top">
                  <td className="px-2 py-2 text-sm">
                    <Link to={`/admin/students/${r.id}`} className="font-bold text-foreground-950 hover:underline">{r.name}</Link>
                    {r.place.length ? <span className="block truncate text-xs text-foreground-600" title={r.place.map((p) => p.intake).join(", ")}>{r.place.map((p) => `${courseCode(p.courseId)} · ${p.intake}`).join("; ")}</span> : null}
                    <span className="block text-xs text-foreground-500">{r.mine.length ? `${r.mine.length} class${r.mine.length === 1 ? "" : "es"} · ${Math.round(r.hours * 10) / 10} h` : "Free all week"}</span>
                    {r.double.size ? <span className="block text-xs font-semibold text-red-700">Double booked</span> : null}
                  </td>
                  {days.map((d) => <td key={d} className="space-y-1 px-1 py-1.5">{r.mine.filter((c) => c.date === d).map((c) => chip(c, r.double.has(c.id)))}</td>)}
                </tr>
              ))}
              {!rows.length ? <tr><td colSpan={8} className="p-6 text-center text-sm text-foreground-500">No student in this course or intake.</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
