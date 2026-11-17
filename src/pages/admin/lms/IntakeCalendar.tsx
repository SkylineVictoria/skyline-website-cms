// An intake's calendar: its units in date order on a timeline, each with the students who take it there. A student who
// joined late, or is carried over from an earlier intake, is listed only on the units they take in this intake
// (BatchStudent.path.unitIds); without that information every student of the batch is listed.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { shortDate, todayIso, type BatchStudent, type IntakeDetail } from "@/pages/admin/lib/rto";

interface Person { student: BatchStudent; batch: string }
const day = (iso: string) => Date.parse(iso + "T00:00:00Z") / 86400000;

export default function IntakeCalendar({ detail }: { detail: IntakeDetail }) {
  const [studentId, setStudentId] = useState("");
  const today = todayIso();
  const manyBatches = detail.batches.length > 1;

  const people = useMemo<Person[]>(() => detail.batches.flatMap(batch => batch.students
    .filter(student => student.status !== "withdrawn").map(student => ({ student, batch: batch.name }))), [detail]);
  const roster = useMemo(() => [...new Map(people.map(person => [person.student.id, person.student.name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1])), [people]);
  const takes = (person: Person, unitId: string) => !person.student.path || person.student.path.unitIds.includes(unitId);

  const units = detail.schedule;
  const first = units.length ? Math.min(...units.map(unit => day(unit.startDate))) : 0;
  const last = units.length ? Math.max(...units.map(unit => day(unit.endDate))) : 0;
  const span = Math.max(1, last - first + 1);
  const nowAt = today >= (units[0]?.startDate ?? "") && day(today) <= last ? ((day(today) - first + 0.5) / span) * 100 : null;
  const current = units.filter(unit => unit.startDate <= today && today <= unit.endDate);

  if (!units.length) return <p className="rounded-lg border border-background-200 p-3 text-sm text-foreground-500">This intake has no unit timeline yet.</p>;
  return <section aria-label="Intake calendar" className="space-y-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground-950">Calendar: units and students</h3>
        <p className="text-xs text-foreground-600">{people.length} student{people.length === 1 ? "" : "s"} in {detail.batches.length} batch{detail.batches.length === 1 ? "" : "es"}.
          {current.length ? ` Now: ${current.map(unit => unit.code).join(", ")}.` : today < units[0].startDate ? " Not started yet." : " Finished."}</p>
      </div>
      {roster.length ? <label className="text-xs text-foreground-600">Show one student
        <select value={studentId} onChange={event => setStudentId(event.target.value)} className="ml-2 rounded-lg border border-background-300 bg-background-50 px-2 py-1.5 text-sm text-foreground-900">
          <option value="">All students</option>
          {roster.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label> : null}
    </div>
    <ol className="divide-y divide-background-200 rounded-lg border border-background-200">
      {units.map(unit => {
        const here = people.filter(person => takes(person, unit.id));
        const shown = studentId ? here.filter(person => person.student.id === studentId) : here;
        const state = unit.endDate < today ? "done" : unit.startDate <= today ? "now" : "next";
        const dim = studentId !== "" && shown.length === 0;
        return <li key={unit.id} className={"grid gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] " + (state === "now" ? "bg-primary-50 " : "") + (dim ? "opacity-40" : "")}>
          <div className="min-w-0">
            <p className="text-sm"><span className="font-semibold text-foreground-950">{unit.code}</span>
              {state === "now" ? <span className="ml-2 rounded-full bg-primary-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">Now</span>
                : state === "done" ? <span className="ml-2 text-[11px] font-semibold text-foreground-500">Finished</span> : null}</p>
            <p className="truncate text-xs text-foreground-700" title={unit.name}>{unit.name}</p>
            <p className="text-xs text-foreground-500">{shortDate(unit.startDate)} – {shortDate(unit.endDate)}</p>
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="relative h-2 rounded-full bg-background-200" role="img" aria-label={`${unit.code} runs ${shortDate(unit.startDate)} to ${shortDate(unit.endDate)}`}>
              <span className={"absolute inset-y-0 rounded-full " + (state === "done" ? "bg-foreground-400" : state === "now" ? "bg-primary-600" : "bg-primary-300")}
                style={{ left: `${((day(unit.startDate) - first) / span) * 100}%`, width: `${Math.max(1.5, ((day(unit.endDate) - day(unit.startDate) + 1) / span) * 100)}%` }} />
              {nowAt !== null ? <span className="absolute -inset-y-1 w-px bg-red-500" style={{ left: `${nowAt}%` }} aria-hidden="true" /> : null}
            </div>
            {shown.length ? <ul className="flex flex-wrap gap-1">
              {shown.map(person => <li key={person.student.enrolmentId}>
                <Link to={`/admin/students/${person.student.id}`} title={[person.student.path?.carryOver ? "Carried over from an earlier intake" : "", person.student.status !== "active" ? person.student.status : ""].filter(Boolean).join(" · ") || undefined}
                  className={"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:underline " + (person.student.path?.carryOver ? "border-amber-300 bg-amber-50 text-amber-900" : "border-background-300 bg-background-50 text-foreground-900")}>
                  {person.student.name}{manyBatches ? <span className="text-foreground-500">· {person.batch}</span> : null}
                  {person.student.path?.carryOver ? <span className="font-semibold">· carried over</span> : null}
                </Link></li>)}
            </ul> : <p className="text-xs text-foreground-500">{studentId ? "Not taken by this student in this intake." : "No students on this unit."}</p>}
            {!studentId && here.length ? <p className="text-[11px] text-foreground-500">{here.length} student{here.length === 1 ? "" : "s"}</p> : null}
          </div>
        </li>;
      })}
    </ol>
    <p className="text-xs text-foreground-500">Dates are the intake's unit dates; a batch with its own unit dates may differ. Amber = a student carried over from an earlier intake, listed only on the units they still need. The red line is today.</p>
  </section>;
}
