import { PhoneInput } from "@/components/feature/applicationInputs";
import { FieldError, WizardLabel, WizardTextField } from "@/components/shared/wizard/fields";
import { EMERGENCY_NAME_MAX, EMERGENCY_RELATIONSHIP_MAX, type EmergencyContactProblems } from "../../../../supabase/functions/_shared/validation/person";

/**
 * Emergency contact: full name, phone (the shared country-code field, +61 first) and relationship. The phone keeps its value
 * (E.164) in a hidden input named `names.phone`; the screen reads it from the surrounding form or from its input event.
 * The rules are emergencyContactProblems() in the shared validation module.
 */
export default function EmergencyContactFields({ idPrefix, names, values, errors, who, onChange, testIdPrefix }: {
  idPrefix: string;
  names: { name: string; phone: string; relationship: string };
  values: { name: string; phone: string; relationship: string };
  errors: EmergencyContactProblems;
  /** Who the contact is for, as the label says it: "the student" or "you". */
  who: string;
  onChange: (field: "name" | "relationship", value: string) => void;
  testIdPrefix?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <WizardTextField id={`${idPrefix}${names.name}`} name={names.name} label="Full name" value={values.name} error={errors.name} maxLength={EMERGENCY_NAME_MAX}
          testId={testIdPrefix ? `${testIdPrefix}${names.name}` : undefined} onChange={(value) => onChange("name", value)} />
      </div>
      <div>
        <WizardLabel htmlFor={`${idPrefix}${names.phone}`}>Phone number</WizardLabel>
        <PhoneInput id={`${idPrefix}${names.phone}`} name={names.phone} value={values.phone} required placeholder="041 234 5678" />
        <FieldError text={errors.phone} />
      </div>
      <WizardTextField id={`${idPrefix}${names.relationship}`} name={names.relationship} label={`Relationship to ${who}`} value={values.relationship} error={errors.relationship}
        placeholder="e.g. Father" maxLength={EMERGENCY_RELATIONSHIP_MAX} testId={testIdPrefix ? `${testIdPrefix}${names.relationship}` : undefined}
        onChange={(value) => onChange("relationship", value)} />
    </div>
  );
}
