// One student's timetable: pick a placed student, see their study (intake, batch, units, progress) and their own classes.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TextInput } from "@/pages/admin/components/ui";
import StudentStudyPanel from "@/pages/admin/components/StudentStudyPanel";
import ClassCalendar from "./ClassCalendar";
import type { CalPeople } from "./calendarData";

export default function StudentsView({ people }: { people: CalPeople | null }) {
  const [query, setQuery] = useState("");
  const [studentId, setStudentId] = useState("");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people?.students ?? []).filter((s) => !q || `${s.name} ${s.email ?? ""}`.toLowerCase().includes(q));
  }, [people, query]);
  const chosen = (people?.students ?? []).find((s) => s.id === studentId) ?? null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <section className="rounded-card border border-background-200 bg-background-50" aria-label="Students">
        <div className="border-b border-background-200 p-2"><TextInput aria-label="Search students" placeholder="Search name or email" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="max-h-[70vh] space-y-1 overflow-y-auto p-2">
          {list.map((s) => (
            <button key={s.id} type="button" aria-pressed={s.id === studentId} onClick={() => setStudentId(s.id)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${s.id === studentId ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100"}`}>
              <b className="block truncate text-foreground-950">{s.name}</b><span className="block truncate text-xs text-foreground-500">{s.email}</span>
            </button>
          ))}
          {people && !list.length ? <p className="p-3 text-sm text-foreground-500">{query ? "No student matches." : "No student is placed in a batch yet."}</p> : null}
          {!people ? <p className="p-3 text-sm text-foreground-500">Loading…</p> : null}
        </div>
      </section>
      <div className="min-w-0 space-y-4">
        {chosen ? <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-heading text-xl font-bold text-foreground-950">{chosen.name}</h3>
            <Link to={`/admin/students/${chosen.id}`} className="text-sm font-semibold text-primary-700 hover:underline">Open student page</Link>
          </div>
          <StudentStudyPanel key={chosen.id} studentId={chosen.id} />
          <ClassCalendar key={`cal-${chosen.id}`} people={people} fixed={{ studentId: chosen.id }} showFilters={false} initialView="month" />
        </> : <p className="rounded-lg border border-dashed border-background-300 p-10 text-center text-sm text-foreground-500">Choose a student to see their units and classes.</p>}
      </div>
    </div>
  );
}
