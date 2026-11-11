import EmergencyContactFields from "@/components/shared/wizard/EmergencyContactFields";
import { FieldError, WIZARD_INPUT as INPUT, WIZARD_LABEL as LABEL, WizardLabel as Label, WizardTextField } from "@/components/shared/wizard/fields";
import IntakeSelect from "@/pages/agency/components/IntakeSelect";
import { intakeKey, type OpenIntake } from "@/pages/agency/lib/intakes";
import { ENGLISH_ONLY, OTHER_LANGUAGE, type WizardQuestion } from "@/pages/agency/lib/wizardConfig";

/**
 * One answer screen. Inputs are plain form controls named after the application fields; the wizard reads them from the
 * surrounding form when Next is pressed, so the phone control keeps its own formatting and validation. The label, input,
 * error line and the emergency contact fields are the shared wizard components (also used by staff onboarding).
 */
export default function WizardQuestionStep({ question, answers, errors, courseOptions, courseIdOf, onChange, onIntake, onIntakesLoaded }: {
  question: WizardQuestion;
  answers: Record<string, string>;
  errors: Record<string, string>;
  /** Course labels ("CODE - Title") the student can apply for. */
  courseOptions: string[];
  /** The course id behind a label (the intakes are listed per course). */
  courseIdOf: (label: string) => string | null;
  onChange: (name: string, value: string) => void;
  /** The chosen intake (INT-01); the parent records its id and label. */
  onIntake: (intake: OpenIntake | null) => void;
  onIntakesLoaded: (intakes: OpenIntake[]) => void;
}) {
  const text = (name: string, label: string, props: { placeholder?: string; maxLength?: number; upper?: boolean } = {}) => (
    <WizardTextField id={`wizard-${name}`} name={name} label={label} value={answers[name] ?? ""} error={errors[name]} maxLength={props.maxLength ?? 200}
      placeholder={props.placeholder} upper={props.upper} onChange={(value) => onChange(name, value)} />
  );

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-heading text-base font-semibold text-foreground-950">{question.title}</h3>
        <p className="mt-1 text-sm text-foreground-600">{question.subtitle}</p>
      </div>

      {question.id === "language" ? (
        <div className="space-y-4">
          <fieldset>
            <legend className={LABEL}>Language spoken at home <span className="text-primary-600">*</span></legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {[[OTHER_LANGUAGE, "Yes, another language"], [ENGLISH_ONLY, "No, English only"]].map(([value, label]) => (
                <label key={value} className="flex items-center gap-2">
                  <input type="radio" name="language_home" value={value} checked={answers.language_home === value} onChange={() => onChange("language_home", value)} /> {label}
                </label>
              ))}
            </div>
            <FieldError text={errors.language_home} />
          </fieldset>
          {answers.language_home === OTHER_LANGUAGE ? text("language_other", "Which language does the student speak?", { placeholder: "e.g. Hindi", maxLength: 100 }) : null}
        </div>
      ) : null}

      {question.id === "usi" ? text("usi_number", "USI number", { placeholder: "10 characters, e.g. ABC234DEF5", maxLength: 10, upper: true }) : null}

      {question.id === "emergency" ? (
        <EmergencyContactFields idPrefix="wizard-" names={{ name: "ec_name", phone: "ec_phone", relationship: "ec_relationship" }} who="the student"
          values={{ name: answers.ec_name ?? "", phone: answers.ec_phone ?? "", relationship: answers.ec_relationship ?? "" }}
          errors={{ name: errors.ec_name, phone: errors.ec_phone, relationship: errors.ec_relationship }}
          onChange={(field, value) => onChange(field === "name" ? "ec_name" : "ec_relationship", value)} />
      ) : null}

      {question.id === "course" ? (
        <div className="grid grid-cols-1 gap-4">
          <div>
            <Label htmlFor="wizard-course">Course</Label>
            <select id="wizard-course" name="course" value={answers.course ?? ""} aria-invalid={Boolean(errors.course)} className={INPUT} onChange={(e) => onChange("course", e.target.value)}>
              <option value="">Select a course</option>
              {(answers.course && !courseOptions.includes(answers.course) ? [answers.course, ...courseOptions] : courseOptions).map((label) => <option key={label} value={label}>{label}</option>)}
            </select>
            <FieldError text={errors.course} />
          </div>
          <div>
            <Label htmlFor="wizard-preferred_intake">Intake</Label>
            <IntakeSelect id="wizard-preferred_intake" courseId={answers.course ? courseIdOf(answers.course) : null} value={intakeKey(answers.intake_id, answers.preferred_intake)} error={errors.preferred_intake}
              className={INPUT} onChange={onIntake} onLoaded={onIntakesLoaded} />
            <FieldError text={errors.preferred_intake} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
