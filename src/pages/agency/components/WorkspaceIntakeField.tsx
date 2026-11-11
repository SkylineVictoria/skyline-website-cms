import { useEffect, useState } from "react";
import IntakeSelect from "@/pages/agency/components/IntakeSelect";
import type { OpenIntake } from "@/pages/agency/lib/intakes";

/**
 * The intake on the full application form (INT-01). That form is read from its controls by name, so this posts two: `intake_id` (the
 * select) and `preferred_intake` (the intake's own label, hidden). It follows the course checkboxes of the same form: a new course
 * clears the intake and lists that course's intakes.
 */
export default function WorkspaceIntakeField({ formId, courseField, courseIdOf, initialIntakeId, initialLabel, disabled, className }: {
  formId: string; courseField: string; courseIdOf: (label: string) => string | null; initialIntakeId: string; initialLabel: string; disabled?: boolean; className: string;
}) {
  const [course, setCourse] = useState<string | null>(null);
  const [intake, setIntake] = useState<{ id: string; label: string }>({ id: initialIntakeId, label: initialIntakeId ? initialLabel : "" });
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!form) return undefined;
    const read = () => {
      const box = form.querySelector<HTMLInputElement>(`input[name="${courseField}[]"]:checked`);
      const next = box?.value ?? null;
      setCourse((previous) => {
        if (previous !== null && previous !== next) setIntake({ id: "", label: "" });
        return next;
      });
    };
    const frame = requestAnimationFrame(read);
    form.addEventListener("change", read);
    form.addEventListener("input", read);
    return () => { cancelAnimationFrame(frame); form.removeEventListener("change", read); form.removeEventListener("input", read); };
  }, [formId, courseField]);
  const choose = (picked: OpenIntake | null) => setIntake({ id: picked?.id ?? "", label: picked?.display ?? "" });
  return (
    <div>
      <IntakeSelect id={`${formId}-preferred_intake`} name="intake_id" courseId={course ? courseIdOf(course) : null} value={intake.id} onChange={choose} disabled={disabled} className={className} />
      <input type="hidden" name="preferred_intake" value={intake.label} readOnly />
    </div>
  );
}
