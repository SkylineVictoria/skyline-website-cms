import { useEffect, useMemo, useRef, useState } from "react";
import {
  intakeStudents,
  type AllocationUnit,
  type IntakeStudent,
  type IntakeStudentScope,
} from "@/pages/admin/lib/intakeStudents";
import { rto, shortDate, todayIso, type IntakeDetail, type ScheduleRow } from "@/pages/admin/lib/rto";

import IntakeMonthCalendar from "./IntakeMonthCalendar";

const panel = "min-w-0 rounded-2xl border border-background-200 bg-background-50 p-3 shadow-sm";
const secondary = "rounded-lg border border-background-300 px-3 py-2 text-xs font-semibold hover:bg-background-100 disabled:opacity-50";
const primary = "rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50";

function StudentIdentity({ student }: { student: IntakeStudent }) {
  return <span className="min-w-0 flex-1">
    <span className="block break-words text-sm font-semibold text-foreground-950">{student.name}</span>
    {student.email && <span className="block break-all text-xs text-foreground-600">{student.email}</span>}
    <span className="block font-mono text-xs text-foreground-500" title={student.id}>{student.id.slice(0, 8)}</span>
  </span>;
}

export function IntakeStudentPicker({ courseId, intakeId, unit, close, saved }: {
  courseId: string;
  intakeId: string;
  unit: AllocationUnit | null;
  close: () => void;
  saved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [students, setStudents] = useState<IntakeStudent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [retry, setRetry] = useState(0);
  const unitId = unit?.id;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    searchField.current?.focus();
    return () => element?.close();
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      intakeStudents<IntakeStudent[]>("search", { courseId, intakeId, unitId }, { search })
        .then(rows => { if (active) setStudents(rows); })
        .catch((error: Error) => { if (active) setSearchError(error.message); })
        .finally(() => { if (active) setLoading(false); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [courseId, intakeId, unitId, search, retry]);

  const toggle = (id: string) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const add = async () => {
    if (busy || !selected.size) return;
    setBusy(true);
    setSaveError("");
    try {
      await intakeStudents("add", { courseId, intakeId, unitId }, { ids: Array.from(selected) });
      saved();
    } catch (error) {
      setSaveError((error as Error).message);
      setBusy(false);
    }
  };

  return <dialog ref={dialog} aria-labelledby="intake-student-picker-title"
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}
    className="m-auto w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-2xl bg-background-50 p-0 text-foreground-950 shadow-xl backdrop:bg-black/40">
    <form onSubmit={event => { event.preventDefault(); void add(); }} className="flex max-h-[85dvh] flex-col">
      <header className="border-b border-background-200 p-4">
        <h2 id="intake-student-picker-title" className="font-heading text-lg font-bold">
          {unit ? `Add students to ${unit.code}` : "Add students to intake"}
        </h2>
        {unit && <p className="mt-1 text-sm text-foreground-600">New students will also be enrolled in this intake.</p>}
      </header>
      <div className="px-4 pt-4">
        <label htmlFor="intake-student-search" className="mb-1 block text-sm font-medium">Search CRM students</label>
        <input ref={searchField} id="intake-student-search" className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm"
          placeholder="Name, email or student ID" value={search} maxLength={200} onChange={event => {
            setLoading(true); setSearchError(""); setSearch(event.target.value);
          }} />
      </div>
      <div className="min-h-24 flex-1 space-y-1 overflow-y-auto p-4" aria-busy={loading}>
        {loading ? <p className="text-sm text-foreground-600">Searching…</p>
          : searchError ? <p role="alert" className="text-sm text-red-700">{searchError} <button type="button" onClick={() => {
            setSearchError(""); setLoading(true); setRetry(value => value + 1);
          }} className="underline">Retry</button></p>
          : students.length ? students.map(student => <label key={student.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-background-100">
            <input type="checkbox" checked={selected.has(student.id)} disabled={busy || (selected.size >= 100 && !selected.has(student.id))}
              onChange={() => toggle(student.id)} className="h-4 w-4 shrink-0 accent-primary-600" />
            <StudentIdentity student={student} />
          </label>) : <p className="text-sm text-foreground-600">No available students match your search.</p>}
        {!loading && students.length === 50 && !searchError && <p className="px-2 text-xs text-foreground-500">Showing 50 results. Refine your search for more matches.</p>}
      </div>
      {saveError && <p role="alert" className="px-4 pb-2 text-sm text-red-700">{saveError}</p>}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-background-200 p-4">
        <span className="text-sm text-foreground-600" role="status">{selected.size} selected</span>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={close} className={secondary}>Cancel</button>
          <button type="submit" disabled={busy || !selected.size} className={primary}>{busy ? "Adding…" : "Add students"}</button>
        </div>
      </footer>
    </form>
  </dialog>;
}

function StudentRoster({ courseId, intakeId, unitId, revision, changed }: Required<Pick<IntakeStudentScope, "courseId" | "intakeId">> & {
  unitId?: string;
  revision: number;
  changed: () => void;
}) {
  const [students, setStudents] = useState<IntakeStudent[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    intakeStudents<IntakeStudent[]>("roster", { courseId, intakeId, unitId })
      .then(rows => { if (active) setStudents(rows); })
      .catch((error: Error) => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [courseId, intakeId, unitId, revision, retry]);

  const remove = async (student: IntakeStudent) => {
    if (removing || !window.confirm(`Remove ${student.name} from this unit?`)) return;
    setRemoving(student.id);
    setRemoveError("");
    try {
      await intakeStudents("remove_unit_student", { courseId, intakeId, unitId }, { ids: [student.id] });
      setStudents(current => current?.filter(row => row.id !== student.id) ?? null);
      changed();
    } catch (error) {
      setRemoveError((error as Error).message);
    } finally {
      setRemoving(null);
    }
  };

  if (loadError) return <p role="alert" className="mt-2 text-sm text-red-700">{loadError} <button type="button" onClick={() => {
    setLoadError(""); setRetry(value => value + 1);
  }} className="underline">Retry</button></p>;
  if (!students) return <p className="mt-2 text-sm text-foreground-600">Loading students…</p>;
  if (!students.length) return <p className="mt-2 text-sm text-foreground-600">
    {unitId ? "No students allocated to this unit." : "No students enrolled in this intake."}
  </p>;
  return <>
    {removeError && <p role="alert" className="mt-2 text-sm text-red-700">{removeError}</p>}
    <ul className="mt-2 max-h-[65vh] divide-y divide-background-200 overflow-y-auto">
      {students.map(student => <li key={student.id} className="flex items-start gap-2 py-2">
        <StudentIdentity student={student} />
        {unitId && <button type="button" disabled={removing !== null} onClick={() => void remove(student)}
          aria-label={`Remove ${student.name} from unit`} title="Remove from unit"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 disabled:opacity-50">
          <i className={removing === student.id ? "ri-loader-4-line animate-spin" : "ri-close-line text-lg"} aria-hidden="true" />
        </button>}
      </li>)}
    </ul>
  </>;
}

export default function IntakeStudentAllocation({ courseId, intakeId, changed, schedule, intakeRevision = 0, calendarRevision = 0, showMonthCalendar = false }: {
  courseId: string;
  intakeId: string;
  changed: () => void;
  schedule?: ScheduleRow[];
  intakeRevision?: number;
  calendarRevision?: number;
  showMonthCalendar?: boolean;
}) {
  const [units, setUnits] = useState<AllocationUnit[] | null>(null);
  const [unitId, setUnitId] = useState<string>();
  const [picker, setPicker] = useState<{ unit: AllocationUnit | null } | null>(null);
  const [unitRetry, setUnitRetry] = useState(0);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [loadedSchedule, setLoadedSchedule] = useState<ScheduleRow[] | null>(null);
  const [calendarError, setCalendarError] = useState("");
  const [calendarRetry, setCalendarRetry] = useState(0);
  const actualSchedule = schedule ?? loadedSchedule;
  const datesByUnit = useMemo(() => {
    const dates = new Map<string, ScheduleRow[]>();
    for (const row of [...(actualSchedule ?? [])].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
      const periods = dates.get(row.unitId) ?? [];
      periods.push(row);
      dates.set(row.unitId, periods);
    }
    return dates;
  }, [actualSchedule]);
  const orderedUnits = [...(units ?? [])].sort((a, b) =>
    (datesByUnit.get(a.id)?.[0].startDate ?? "9999").localeCompare(datesByUnit.get(b.id)?.[0].startDate ?? "9999"));
  const today = todayIso();
  const unit = units?.find(row => row.id === unitId);

  useEffect(() => {
    let active = true;
    intakeStudents<AllocationUnit[]>("units", { courseId, intakeId })
      .then(rows => { if (active) setUnits(rows); })
      .catch((error: Error) => { if (active) setProblem(error.message); });
    return () => { active = false; };
  }, [courseId, intakeId, intakeRevision, unitRetry]);

  useEffect(() => {
    if (schedule) return;
    let active = true;
    rto<IntakeDetail>("intake_get", { intakeId })
      .then(detail => { if (active) { setLoadedSchedule(detail.schedule); setCalendarError(""); } })
      .catch((error: Error) => { if (active) setCalendarError(error.message); });
    return () => { active = false; };
  }, [intakeId, schedule, calendarRetry, calendarRevision]);

  return <>
    <section className={panel} aria-label="Unit calendar">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-1 px-1">
        <h2 className="text-sm font-bold text-foreground-950">Unit calendar</h2>
        {showMonthCalendar && actualSchedule !== null && <a href="#intake-calendar" className="text-xs font-semibold text-primary-700 underline">Month view</a>}
      </div>
      {calendarError ? <p role="alert" className="mb-2 px-1 text-xs text-red-700">
        Could not load unit dates. <button type="button" className="underline" onClick={() => {
          setCalendarError(""); setCalendarRetry(value => value + 1);
        }}>Retry</button>
      </p> : actualSchedule === null && <p className="mb-2 px-1 text-xs text-foreground-600">Loading unit dates…</p>}
      {problem ? <p role="alert" className="px-1 text-sm text-red-700">{problem} <button type="button" onClick={() => { setProblem(""); setUnitRetry(value => value + 1); }} className="underline">Retry</button></p>
        : !units ? <p className="px-1 text-sm text-foreground-600">Loading units…</p>
        : !units.length ? <p className="px-1 text-sm text-foreground-600">This course has no units.</p>
        : <ul className="max-h-[65vh] space-y-1 overflow-y-auto p-1">
          {orderedUnits.map(row => {
            const dates = datesByUnit.get(row.id) ?? [];
            const running = dates.some(period => period.startDate <= today && today <= period.endDate);
            return <li key={row.id} className={`flex items-center rounded-lg border ${unitId === row.id ? "border-primary-300 bg-primary-50" : "border-transparent hover:bg-background-100"}`}>
            <button type="button" aria-pressed={unitId === row.id} onClick={() => { setUnitId(row.id); setNotice(""); }}
              className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left">
              <span className="flex flex-wrap items-center justify-between gap-1 text-xs font-bold text-foreground-950">
                <span className="break-all">{row.code}</span>
                <span aria-label={`${row.count} allocated students`} className="rounded-full bg-background-200 px-2 py-0.5">{row.count}</span>
              </span>
              <span className="block break-words text-xs text-foreground-600">{row.name}</span>
              {dates.map(period => <span key={period.id} className="mt-1 block text-xs text-foreground-700">
                <time dateTime={period.startDate}>{shortDate(period.startDate)}</time>
                {" – "}<time dateTime={period.endDate}>{shortDate(period.endDate)}</time>
              </span>)}
              {actualSchedule !== null && !dates.length && <span className="mt-1 block text-xs text-foreground-500">Unscheduled</span>}
              {running && <span className="mt-1 inline-block rounded-full bg-primary-100 px-2 py-0.5 text-xs font-semibold text-primary-800">In progress</span>}
            </button>
            <button type="button" aria-label={`Add students to ${row.code}`} title="Add students"
              onClick={() => { setUnitId(row.id); setNotice(""); setPicker({ unit: row }); }}
              className="mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg font-semibold text-primary-700 hover:bg-primary-100">+</button>
          </li>;
          })}
        </ul>}
    </section>
    <section className={panel} aria-label="Allocated students">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="px-1 text-sm font-bold text-foreground-950">{unit ? "Allocated students" : "Intake students"}</h2>
        {unit
          ? <button type="button" className={secondary} onClick={() => { setUnitId(undefined); setNotice(""); }}>Intake roster</button>
          : <button type="button" className={secondary} onClick={() => { setNotice(""); setPicker({ unit: null }); }}>+ Add to intake</button>}
      </div>
      {unit && <p className="mt-1 px-1 text-xs text-foreground-600">{unit.code} · {unit.name}</p>}
      {notice && <p role="status" className="mt-2 text-sm text-green-800">{notice}</p>}
      <StudentRoster key={unit?.id ?? "intake"} courseId={courseId} intakeId={intakeId} unitId={unit?.id}
        revision={intakeRevision} changed={() => { setNotice("Student removed from the unit."); changed(); }} />
    </section>
    {showMonthCalendar && actualSchedule !== null && units !== null && <IntakeMonthCalendar
      schedule={actualSchedule.filter(period => units.some(row => row.id === period.unitId))}
      onAdd={id => {
        const row = units.find(item => item.id === id);
        if (row) { setUnitId(row.id); setNotice(""); setPicker({ unit: row }); }
      }} />}
    {picker && <IntakeStudentPicker courseId={courseId} intakeId={intakeId} unit={picker.unit} close={() => setPicker(null)} saved={() => {
      setNotice(picker.unit ? "Students allocated to the unit." : "Students enrolled in the intake.");
      setPicker(null);
      changed();
    }} />}
  </>;
}
