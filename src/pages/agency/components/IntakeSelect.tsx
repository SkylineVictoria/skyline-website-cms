import { useEffect, useState } from "react";
import { openIntakes, type OpenIntake } from "@/pages/agency/lib/intakes";

export const NO_INTAKES_MESSAGE = "This course has no open intakes at the moment, so the application cannot be submitted for it yet. Contact admissions, or choose another course.";

/**
 * The intake dropdown of the enrolment form (INT-01): the open intakes of the chosen course, loaded from the database. Without a course
 * it is disabled; changing the course is the parent's job (it clears the value); a course without open intakes shows why the form cannot
 * be submitted. `onChange` gets the chosen intake (or null); `onLoaded` the list, so the parent can block submission when it is empty.
 */
export default function IntakeSelect({ id, name, courseId, value, onChange, onLoaded, error, disabled, className }: {
  id: string; name?: string; courseId: string | null; value: string; onChange: (intake: OpenIntake | null) => void;
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
  return (
    <div>
      <select id={id} name={name} value={intakes.some((i) => i.id === value) ? value : ""} disabled={disabled || !courseId || loading || none} aria-invalid={Boolean(error) || none}
        aria-describedby={`${id}-help`} className={className} data-testid="intake-select"
        onChange={(e) => onChange(intakes.find((i) => i.id === e.target.value) ?? null)}>
        <option value="">{!courseId ? "Choose the course first" : loading ? "Loading intakes…" : none ? "No open intakes" : "Select intake"}</option>
        {intakes.map((intake) => <option key={intake.id} value={intake.id}>{intake.display}</option>)}
      </select>
      <p id={`${id}-help`} className={`mt-1 text-xs ${none || state.failed ? "text-primary-700" : "text-foreground-500"}`} role={none || state.failed ? "alert" : undefined} data-testid="intake-help">
        {state.failed || (none ? NO_INTAKES_MESSAGE : courseId ? "Only intakes that have not started yet are listed." : "The intakes of the course you choose are listed here.")}
      </p>
    </div>
  );
}
