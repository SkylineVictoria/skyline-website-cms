import { useEffect, useState } from "react";
import { intakeKey, openIntakes, type OpenIntake } from "@/pages/agency/lib/intakes";
import { supabase } from "@/pages/admin/lib/supabase";
import SearchableSelect from "@/components/ui/SearchableSelect";

export const NO_INTAKES_MESSAGE = "This course has no open intakes at the moment, so the application cannot be submitted for it yet. Contact admissions, or choose another course.";
export const FALLBACK_MESSAGE = "No intake dates are published for this course yet: choose the month you would like to start. Admissions will confirm the date.";
/** The dropdown value of "+ Add new intake…" (RTO Managers only); never a stored answer. */
export const ADD_INTAKE_VALUE = "__add_intake__";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** What the dropdown shows: the intake's start and end dates ("19 Jan 2027 – 9 Nov 2029"); a fallback month keeps its month name. */
const intakeDates = (i: OpenIntake) => (i.fallback || !i.startDate ? i.display : i.endDate ? `${day(i.startDate)} – ${day(i.endDate)}` : `Starts ${day(i.startDate)}`);

interface WeekSlot { weekday: number; start: string; end: string; type: string | null }
const DAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const monthLabel = (k: string) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
const plusMonths = (k: string, n: number) => { const [y, m] = k.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

/**
 * The start-date calendar (replaces the intake dropdown once CoE or VoE is chosen): the coming year month by month. Each month lists the dates the student
 * can start, with the unit that starts, and below them the weekly timetable (days and times) so the student can check the timing suits them. The only
 * choice is the start date. Intake names are never shown.
 */
function StartCalendar({ options, value, onPick, disabled, keyOf }: { options: OpenIntake[]; value: string; onPick: (o: OpenIntake) => void; disabled?: boolean; keyOf: (o: OpenIntake) => string }) {
  const [patterns, setPatterns] = useState<Record<string, WeekSlot[]> | null>(null);
  const ids = [...new Set(options.map((o) => o.id).filter((x): x is string => !!x))];
  const idsKey = ids.join(",");
  useEffect(() => {
    if (!ids.length) { setPatterns({}); return; }
    let live = true;
    void supabase.rpc("intake_week_pattern", { p_intakes: ids }).then(({ data }) => { if (live) setPatterns((data ?? {}) as Record<string, WeekSlot[]>); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the set of intakes changes
  }, [idsKey]);
  const dated = options.filter((o) => o.joinDate || o.startDate).map((o) => ({ o, date: (o.joinDate ?? o.startDate) as string })).sort((x, y) => x.date.localeCompare(y.date));
  if (dated.length === 0) return <p className="text-sm text-foreground-500">No start dates are published for this study type yet.</p>;
  const first = dated[0].date.slice(0, 7);
  const months = Array.from({ length: 12 }, (_, i) => plusMonths(first, i));
  return (
    <div className="max-h-[32rem] space-y-4 overflow-y-auto rounded-lg border border-background-200 bg-background-50 p-3" data-testid="intake-calendar">
      {months.map((m) => {
        const starts = dated.filter((d) => d.date.slice(0, 7) === m);
        // One weekly table per distinct pattern in the month, with the start dates it applies to.
        const groups = new Map<string, { slots: WeekSlot[]; dates: string[] }>();
        for (const { o, date } of starts) {
          const slots = (o.id && patterns?.[o.id]) || [];
          const k = JSON.stringify(slots.map((x) => [x.weekday, x.start, x.end]));
          const g = groups.get(k) ?? { slots, dates: [] };
          g.dates.push(day(date)); groups.set(k, g);
        }
        return (
          <section key={m} aria-label={monthLabel(m)}>
            <h4 className="mb-1.5 text-sm font-semibold text-foreground-800">{monthLabel(m)}</h4>
            {starts.length === 0 ? <p className="text-xs text-foreground-400">No start dates this month.</p> : (
              <>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={`Start dates in ${monthLabel(m)}`}>
                  {starts.map(({ o, date }) => {
                    const on = keyOf(o) === value;
                    return (
                      <button key={keyOf(o)} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onPick(o)}
                        className={`rounded-lg border-2 px-3 py-2 text-left text-sm ${on ? "border-primary-600 bg-primary-50 text-primary-900" : "border-background-300 bg-background-50 hover:border-primary-400"}`}>
                        <span className="block font-semibold">{day(date)}</span>
                        <span className="block text-xs text-foreground-600">{o.firstDay ? "Day one of the course" : [o.unitCode, o.unitName].filter(Boolean).join(" ") || "Next unit"}{o.prereqFirst ? " · missed prerequisites first" : ""}</span>
                      </button>
                    );
                  })}
                </div>
                {[...groups.values()].map((g, i) => g.slots.length === 0 ? null : (
                  <div key={i} className="mt-2 overflow-x-auto">
                    <p className="mb-1 text-xs text-foreground-500">Weekly timetable{groups.size > 1 ? ` for the start on ${g.dates.join(", ")}` : ""}</p>
                    <table className="w-full min-w-[18rem] border-collapse text-left text-xs">
                      <thead><tr className="text-foreground-500"><th className="border-b border-background-200 py-1 pr-3 font-medium">Day</th><th className="border-b border-background-200 py-1 pr-3 font-medium">Time</th><th className="border-b border-background-200 py-1 font-medium">Class</th></tr></thead>
                      <tbody>
                        {g.slots.map((x, j) => (
                          <tr key={j} className="text-foreground-700"><td className="border-b border-background-100 py-1 pr-3">{DAY[x.weekday] ?? ""}</td><td className="border-b border-background-100 py-1 pr-3">{x.start} – {x.end}</td><td className="border-b border-background-100 py-1 capitalize">{x.type ?? ""}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

const UPCOMING_STARTS = 3;
const fallbackOnly = (list: OpenIntake[]) => list.length > 0 && list.every((i) => i.fallback);
const LOAD_LABEL = { coe: "CoE", voe: "VoE" } as const;

/**
 * The intake dropdown of the enrolment form (INT-01): the open intakes of the chosen course, loaded from the database, or, for a
 * course without published intakes, the start months the database offers instead (so enrolment never stops). Without a course it is
 * disabled; changing the course is the parent's job (it clears the value). `value` is `intakeKey(intakeId, label)`; `onChange` gets the
 * chosen entry (or null); `onLoaded` the list, so the parent can block the step when it is empty. An RTO Manager (`canAdd`) also gets
 * "+ Add new intake…" at the foot of the list and in the no-intakes message (`onAdd`); `reloadToken` re-reads the list after one is added.
 */
export default function IntakeSelect({ id, courseId, value, onChange, onLoaded, error, disabled, className, canAdd = false, onAdd, reloadToken = 0, defaultLoad, onlyLoad }: {
  id: string; courseId: string | null; value: string; onChange: (intake: OpenIntake | null) => void;
  onLoaded?: (intakes: OpenIntake[]) => void; error?: string; disabled?: boolean; className: string;
  canAdd?: boolean; onAdd?: () => void; reloadToken?: number;
  /** CoE or VoE chosen to start with (an international student: CoE, owner 2026-11-25); still changeable. */
  defaultLoad?: "coe" | "voe";
  /** The only kind this student can take (owner, 2026-11-26): international = CoE, domestic = VoE; the other is greyed out. */
  onlyLoad?: "coe" | "voe";
}) {
  const [pickedLoad, setPickedLoad] = useState<"coe" | "voe" | null>(null);
  const [state, setState] = useState<{ course: string; intakes: OpenIntake[] | null; failed: string }>({ course: "", intakes: null, failed: "" });
  useEffect(() => {
    if (!courseId) { setState({ course: "", intakes: null, failed: "" }); return; }
    let live = true;
    setPickedLoad(null);
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
  // Course first, then CoE or VoE (only asked when the course has both), then the next three starts of that kind.
  const loadsOffered = (["coe", "voe"] as const).filter((l) => intakes.some((i) => !i.fallback && i.studyLoad === l));
  const selected = intakes.find((i) => keyOf(i) === value);
  // CoE or VoE is asked (chosen to start with only for an international student: CoE); a kind with no intake is shown but cannot be picked.
  const load = onlyLoad ? (loadsOffered.includes(onlyLoad) ? onlyLoad : null)
    : pickedLoad ?? selected?.studyLoad ?? (defaultLoad && loadsOffered.includes(defaultLoad) ? defaultLoad : null);
  // A start of the other kind saved earlier (before the residency answer) is cleared.
  useEffect(() => {
    if (onlyLoad && selected?.studyLoad && selected.studyLoad !== onlyLoad) onChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the kind or the chosen start changes
  }, [onlyLoad, selected?.studyLoad]);
  const needsLoad = loadsOffered.length > 0 && !load;
  const shown = (() => {
    if (fallbackOnly(intakes) || loadsOffered.length === 0) return intakes;
    if (!load) return [];
    const ofLoad = intakes.filter((i) => i.studyLoad === load).sort((a, b) => (a.joinDate ?? a.startDate).localeCompare(b.joinDate ?? b.startDate));
    // The next three starts of EACH intake of that kind (a course can have several running at once).
    const perIntake = new Map<string, number>();
    const top = ofLoad.filter((i) => { const k = i.id ?? i.name; const n = perIntake.get(k) ?? 0; perIntake.set(k, n + 1); return n < UPCOMING_STARTS; });
    return selected && ofLoad.includes(selected) && !top.includes(selected) ? [...top, selected] : top;
  })();
  // With CoE or VoE chosen the start date is picked on the calendar (month by month, with the weekly timetable) instead of a dropdown.
  const calendarMode = loadsOffered.length > 0 && !fallbackOnly(intakes);
  const addable = canAdd && Boolean(courseId) && !loading && !state.failed && Boolean(onAdd);
  const onlyMissing = Boolean(onlyLoad && loadsOffered.length > 0 && !loadsOffered.includes(onlyLoad!));
  const help = state.failed || (onlyMissing ? `No ${LOAD_LABEL[onlyLoad!]} intake is open for this course for ${onlyLoad === "coe" ? "international" : "domestic"} students. Contact admissions.` : none ? NO_INTAKES_MESSAGE : fallback ? FALLBACK_MESSAGE : calendarMode ? (needsLoad ? "Choose CoE or VoE to see the start dates." : "Pick the date you want to start. Check the weekly timetable under each month to make sure the times suit you.") : courseId ? "The next three start dates of each intake are shown; each is when the student can start: the next units of the class running now, or day one of the next intake. Any prerequisite units missed are done first." : "The start dates of the course you choose are listed here.");
  return (
    <div>
      {loadsOffered.length > 0 && !fallbackOnly(intakes) ? (
        <div className="mb-2" role="radiogroup" aria-label="CoE or VoE" data-testid="intake-load">
          <p className="mb-1 text-xs font-medium text-foreground-700">How will the student study?</p>
          <div className="grid grid-cols-2 gap-2">
            {(["coe", "voe"] as const).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={load === l} disabled={disabled || !loadsOffered.includes(l) || (onlyLoad !== undefined && l !== onlyLoad)}
                title={onlyLoad && l !== onlyLoad ? (onlyLoad === "coe" ? "International students study on a CoE" : "Domestic students study on a VoE") : loadsOffered.includes(l) ? undefined : `No ${LOAD_LABEL[l]} intake is open for this course`}
                onClick={() => { setPickedLoad(l); if (selected && selected.studyLoad !== l) onChange(null); }}
                className={`rounded-lg border-2 px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${load === l ? "border-primary-600 bg-primary-50 font-semibold text-primary-900" : "border-background-300 hover:border-primary-400"}`}>
                {LOAD_LABEL[l]}{onlyLoad && l !== onlyLoad ? (onlyLoad === "coe" ? " · domestic only" : " · international only") : loadsOffered.includes(l) ? "" : " · no intake open"}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {calendarMode ? (needsLoad ? null : load ? <StartCalendar options={intakes.filter((i) => i.studyLoad === load)} value={value} disabled={disabled} keyOf={keyOf} onPick={(o) => onChange(o)} /> : null) : <SearchableSelect id={id} value={shown.some((i) => keyOf(i) === value) ? value : ""} disabled={disabled || !courseId || loading || needsLoad || (none && !addable)} aria-invalid={Boolean(error) || none}
        aria-describedby={`${id}-help`} className={className} data-testid="intake-select"
        onChange={(e) => { if (e.target.value === ADD_INTAKE_VALUE) { onAdd?.(); return; } onChange(intakes.find((i) => keyOf(i) === e.target.value) ?? null); }}>
        <option value="">{!courseId ? "Choose the course first" : loading ? "Loading intakes…" : none ? "No open intakes" : needsLoad ? "Choose CoE or VoE first" : fallback ? "Select a start month" : "Select a start date"}</option>
        {(() => {
          const optionOf = (intake: OpenIntake) => <option key={keyOf(intake)} value={keyOf(intake)}>{intake.option ?? `${intakeDates(intake)}${intake.running ? " (running now)" : ""}`}</option>;
          const groups = [...new Set(shown.map((i) => i.id ?? i.name))];
          if (groups.length < 2) return shown.map(optionOf);
          return groups.map((g) => { const list = shown.filter((i) => (i.id ?? i.name) === g); return <optgroup key={g} label={list[0].name}>{list.map(optionOf)}</optgroup>; });
        })()}
        {addable ? <option value={ADD_INTAKE_VALUE} data-testid="intake-add-option">+ Add new intake…</option> : null}
      </SearchableSelect>}
      <p id={`${id}-help`} className={`mt-1 text-xs ${none || state.failed ? "text-primary-700" : "text-foreground-500"}`} role={none || state.failed ? "alert" : undefined} data-testid="intake-help">
        {help}
        {none && addable ? <> <button type="button" onClick={onAdd} className="font-semibold text-primary-700 underline underline-offset-2" data-testid="intake-add-button">Add new intake</button></> : null}
      </p>
    </div>
  );
}
