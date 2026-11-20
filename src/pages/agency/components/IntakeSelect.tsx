import { useEffect, useState } from "react";
import { intakeKey, openIntakes, type OpenIntake } from "@/pages/agency/lib/intakes";
import { supabase } from "@/pages/admin/lib/supabase";

export const NO_INTAKES_MESSAGE = "This course has no open intakes at the moment, so the application cannot be submitted for it yet. Contact admissions, or choose another course.";
export const FALLBACK_MESSAGE = "No intake dates are published for this course yet: choose the month you would like to start. Admissions will confirm the date.";
/** The dropdown value of "+ Add new intake…" (RTO Managers only); never a stored answer. */
export const ADD_INTAKE_VALUE = "__add_intake__";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** What the dropdown shows: the intake's start and end dates ("19 Jan 2027 – 9 Nov 2029"); a fallback month keeps its month name. */
const intakeDates = (i: OpenIntake) => (i.fallback || !i.startDate ? i.display : i.endDate ? `${day(i.startDate)} – ${day(i.endDate)}` : `Starts ${day(i.startDate)}`);

interface CalendarUnit { unitCode: string; unitName: string; unitType: string | null; startDate: string; endDate: string | null; hours: number | null }

/** Read-only calendar of the chosen intake: every unit with its dates, month by month; the date the student joins is marked. */
function IntakeCalendar({ intakeId, joinDate }: { intakeId: string; joinDate?: string }) {
  const [open, setOpen] = useState(false);
  const [units, setUnits] = useState<CalendarUnit[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setUnits(null); setFailed(false); setOpen(false); }, [intakeId]);
  useEffect(() => {
    if (!open || units) return;
    let live = true;
    void supabase.rpc("intake_unit_calendar", { p_intake: intakeId }).then(({ data, error }) => {
      if (!live) return;
      if (error) setFailed(true); else setUnits((data ?? []) as CalendarUnit[]);
    });
    return () => { live = false; };
  }, [open, units, intakeId]);
  const months = new Map<string, CalendarUnit[]>();
  for (const u of units ?? []) { const k = u.startDate.slice(0, 7); months.set(k, [...(months.get(k) ?? []), u]); }
  const monthName = (k: string) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen(o => !o)} className="text-xs font-semibold text-primary-700 underline underline-offset-2" data-testid="intake-calendar-toggle">
        {open ? "Hide the full calendar" : "View the full calendar"}
      </button>
      {open ? (
        <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-background-200 bg-background-50 p-3 text-sm" data-testid="intake-calendar">
          {failed ? <p className="text-primary-700">The calendar could not be loaded.</p> : !units ? <p className="text-foreground-500">Loading…</p>
            : units.length === 0 ? <p className="text-foreground-500">No unit dates are published for this intake yet.</p>
            : [...months].map(([k, list]) => (
              <div key={k} className="mb-3 last:mb-0">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-500">{monthName(k)}</p>
                <ul className="space-y-1">
                  {list.map(u => (
                    <li key={`${u.unitCode}-${u.startDate}`} className={`flex flex-wrap justify-between gap-x-3 rounded px-2 py-1 ${joinDate === u.startDate ? "bg-primary-50 font-medium text-primary-800" : "text-foreground-700"}`}>
                      <span>{u.unitCode} {u.unitName}{joinDate === u.startDate ? " · you start here" : ""}</span>
                      <span className="text-foreground-500">{day(u.startDate)}{u.endDate ? ` – ${day(u.endDate)}` : ""}{u.hours ? ` · ${u.hours} h` : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The intake dropdown of the enrolment form (INT-01): the open intakes of the chosen course, loaded from the database, or, for a
 * course without published intakes, the start months the database offers instead (so enrolment never stops). Without a course it is
 * disabled; changing the course is the parent's job (it clears the value). `value` is `intakeKey(intakeId, label)`; `onChange` gets the
 * chosen entry (or null); `onLoaded` the list, so the parent can block the step when it is empty. An RTO Manager (`canAdd`) also gets
 * "+ Add new intake…" at the foot of the list and in the no-intakes message (`onAdd`); `reloadToken` re-reads the list after one is added.
 */
export default function IntakeSelect({ id, courseId, value, onChange, onLoaded, error, disabled, className, canAdd = false, onAdd, reloadToken = 0 }: {
  id: string; courseId: string | null; value: string; onChange: (intake: OpenIntake | null) => void;
  onLoaded?: (intakes: OpenIntake[]) => void; error?: string; disabled?: boolean; className: string;
  canAdd?: boolean; onAdd?: () => void; reloadToken?: number;
}) {
  const [state, setState] = useState<{ course: string; intakes: OpenIntake[] | null; failed: string }>({ course: "", intakes: null, failed: "" });
  useEffect(() => {
    if (!courseId) { setState({ course: "", intakes: null, failed: "" }); return; }
    let live = true;
    setState({ course: courseId, intakes: null, failed: "" });
    openIntakes(courseId).then((list) => { if (live) { setState({ course: courseId, intakes: list, failed: "" }); onLoaded?.(list); } })
      .catch((e: Error) => { if (live) setState({ course: courseId, intakes: null, failed: e.message }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the course changes or an intake was added
  }, [courseId, reloadToken]);
  const intakes = state.intakes ?? [];
  const loading = Boolean(courseId) && state.intakes === null && !state.failed;
  const none = Boolean(courseId) && state.intakes !== null && intakes.length === 0;
  const fallback = intakes.length > 0 && intakes.every((i) => i.fallback);
  const keyOf = (i: OpenIntake) => intakeKey(i.id, i.display, i.joinDate);
  const addable = canAdd && Boolean(courseId) && !loading && !state.failed && Boolean(onAdd);
  const help = state.failed || (none ? NO_INTAKES_MESSAGE : fallback ? FALLBACK_MESSAGE : courseId ? "Each date is when the student can start: the next units of the class running now, or day one of the next intake. Any prerequisite units missed are done first." : "The start dates of the course you choose are listed here.");
  return (
    <div>
      <select id={id} value={intakes.some((i) => keyOf(i) === value) ? value : ""} disabled={disabled || !courseId || loading || (none && !addable)} aria-invalid={Boolean(error) || none}
        aria-describedby={`${id}-help`} className={className} data-testid="intake-select"
        onChange={(e) => { if (e.target.value === ADD_INTAKE_VALUE) { onAdd?.(); return; } onChange(intakes.find((i) => keyOf(i) === e.target.value) ?? null); }}>
        <option value="">{!courseId ? "Choose the course first" : loading ? "Loading intakes…" : none ? "No open intakes" : fallback ? "Select a start month" : "Select a start date"}</option>
        {intakes.map((intake) => <option key={keyOf(intake)} value={keyOf(intake)}>{intake.option ?? `${intakeDates(intake)}${intake.running ? " (running now)" : ""}`}</option>)}
        {addable ? <option value={ADD_INTAKE_VALUE} data-testid="intake-add-option">+ Add new intake…</option> : null}
      </select>
      <p id={`${id}-help`} className={`mt-1 text-xs ${none || state.failed ? "text-primary-700" : "text-foreground-500"}`} role={none || state.failed ? "alert" : undefined} data-testid="intake-help">
        {help}
        {none && addable ? <> <button type="button" onClick={onAdd} className="font-semibold text-primary-700 underline underline-offset-2" data-testid="intake-add-button">Add new intake</button></> : null}
      </p>
      {(() => { const chosen = intakes.find((i) => keyOf(i) === value); return chosen?.id ? <IntakeCalendar intakeId={chosen.id} joinDate={chosen.joinDate} /> : null; })()}
    </div>
  );
}
