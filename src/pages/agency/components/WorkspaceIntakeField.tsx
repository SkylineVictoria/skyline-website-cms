import { useEffect, useRef, useState } from "react";
import IntakeSelect from "@/pages/agency/components/IntakeSelect";
import { intakeKey, type OpenIntake } from "@/pages/agency/lib/intakes";

/**
 * The intake on the full application form (INT-01). That form is read from its controls by name, so this posts two hidden values:
 * `intake_id` (the chosen intake row; empty for a fallback month) and `preferred_intake` (the intake's own label, or the month). It
 * follows the course checkboxes of the same form: a new course clears the intake and lists that course's intakes.
 */
export default function WorkspaceIntakeField({ formId, courseField, courseIdOf, initialIntakeId, initialLabel, initialJoinDate = "", disabled, className, onPicked }: {
  formId: string; courseField: string; courseIdOf: (label: string) => string | null; initialIntakeId: string; initialLabel: string; initialJoinDate?: string; disabled?: boolean; className: string;
  /** Called once the hidden values hold a new start (picked, or cleared by a course change): the form re-checks and saves. Picking a
   * date on the calendar fires no input event on the form, so without this the start was neither counted nor saved (owner 2026-11-27). */
  onPicked?: () => void;
}) {
  const [course, setCourse] = useState<string | null>(null);
  const [intake, setIntake] = useState<{ id: string; label: string; joinDate: string }>({ id: initialIntakeId, label: initialLabel, joinDate: initialJoinDate });
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!form) return undefined;
    const read = () => {
      const box = form.querySelector<HTMLInputElement>(`input[name="${courseField}[]"]:checked`);
      const next = box?.value ?? null;
      setCourse((previous) => {
        if (previous !== null && previous !== next) setIntake({ id: "", label: "", joinDate: "" });
        return next;
      });
    };
    const frame = requestAnimationFrame(read);
    form.addEventListener("change", read);
    form.addEventListener("input", read);
    return () => { cancelAnimationFrame(frame); form.removeEventListener("change", read); form.removeEventListener("input", read); };
  }, [formId, courseField]);
  const firstRef = useRef(true);
  const pickedRef = useRef(onPicked);
  pickedRef.current = onPicked;
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    pickedRef.current?.();
  }, [intake.id, intake.label, intake.joinDate]);
  const choose = (picked: OpenIntake | null) => setIntake({ id: picked?.id ?? "", label: picked?.display ?? "", joinDate: picked?.joinDate ?? "" });
  return (
    <div>
      <IntakeSelect id={`${formId}-preferred_intake`} courseId={course ? courseIdOf(course) : null} value={intakeKey(intake.id, intake.label, intake.joinDate)} onChange={choose} disabled={disabled} className={className} />
      <input type="hidden" name="intake_id" value={intake.id} readOnly />
      <input type="hidden" name="preferred_intake" value={intake.label} readOnly />
      <input type="hidden" name="intake_join_date" value={intake.joinDate} readOnly />
    </div>
  );
}
