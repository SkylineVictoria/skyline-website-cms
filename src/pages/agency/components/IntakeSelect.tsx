import { useEffect, useState } from "react";
import { intakeKey, openIntakes, type OpenIntake } from "@/pages/agency/lib/intakes";

export const NO_INTAKES_MESSAGE = "This course has no open intakes at the moment, so the application cannot be submitted for it yet. Contact admissions, or choose another course.";
export const FALLBACK_MESSAGE = "No intake dates are published for this course yet: choose the month you would like to start. Admissions will confirm the date.";

/**
 * The intake dropdown of the enrolment form (INT-01): the open intakes of the chosen course, loaded from the database, or, for a
 * course without published intakes, the start months the database offers instead (so enrolment never stops). Without a course it is
 * disabled; changing the course is the parent's job (it clears the value). `value` is `intakeKey(intakeId, label)`; `onChange` gets the
 * chosen entry (or null); `onLoaded` the list, so the parent can block the step when it is empty.
 */
export default function IntakeSelect({ id, courseId, value, onChange, onLoaded, error, disabled, className }: {
  id: string; courseId: string | null; value: string; onChange: (intake: OpenIntake | null) => void;
  onLoaded?: (intakes: OpenIntake[]) => void; error?: string; disabled?: boolean; className: string;
}) {
  const [state, setState] = useState<{ course: string; intakes: OpenIntake[] | null; failed: string }>({ course: "", intakes: null, failed: "" });
  useEffect(() => {
    if (!courseId) { setState({ course: "", intakes: null, failed: "" }); return; }
    let live = true;
    setState({ course: courseId, intakes: null, failed: "" });
    openIntakes(courseId).then((list) => { if (live) { setState({ course: courseId, intakes: list, failed: "" }); onLoaded?.(list); } })
      .catch((e: Error) => { if (live) setState({ course: courseId, intakes: null, failed: e.message }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the course changes
  }, [courseId]);
  const intakes = state.intakes ?? [];
  const loading = Boolean(courseId) && state.intakes === null && !state.failed;
  const none = Boolean(courseId) && state.intakes !== null && intakes.length === 0;
  const fallback = intakes.length > 0 && intakes.every((i) => i.fallback);
  const keyOf = (i: OpenIntake) => intakeKey(i.id, i.display);
  const help = state.failed || (none ? NO_INTAKES_MESSAGE : fallback ? FALLBACK_MESSAGE : courseId ? "Only intakes that have not started yet are listed." : "The intakes of the course you choose are listed here.");
  return (
    <div>
      <select id={id} value={intakes.some((i) => keyOf(i) === value) ? value : ""} disabled={disabled || !courseId || loading || none} aria-invalid={Boolean(error) || none}
        aria-describedby={`${id}-help`} className={className} data-testid="intake-select"
        onChange={(e) => onChange(intakes.find((i) => keyOf(i) === e.target.value) ?? null)}>
        <option value="">{!courseId ? "Choose the course first" : loading ? "Loading intakes…" : none ? "No open intakes" : fallback ? "Select a start month" : "Select intake"}</option>
        {intakes.map((intake) => <option key={keyOf(intake)} value={keyOf(intake)}>{intake.display}</option>)}
      </select>
      <p id={`${id}-help`} className={`mt-1 text-xs ${none || state.failed ? "text-primary-700" : "text-foreground-500"}`} role={none || state.failed ? "alert" : undefined} data-testid="intake-help">{help}</p>
    </div>
  );
}
