import { FieldError, WIZARD_LABEL as LABEL } from "@/components/shared/wizard/fields";
import { PR_ANSWER, isDomesticPassport } from "@/pages/agency/lib/residency";

function YesNo({ name, label, value, error, onChange }: { name: string; label: string; value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <fieldset data-testid={`wizard-${name}`}>
      <legend className={LABEL}>{label} <span className="text-primary-600">*</span></legend>
      <div className="flex gap-5 text-sm">
        {(["Yes", "No"] as const).map((option) => (
          <label key={option} className="flex items-start gap-2">
            <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} className="mt-0.5" /> {option}
          </label>
        ))}
      </div>
      <FieldError text={error} />
    </fieldset>
  );
}

/**
 * Shown under the passport once it is uploaded (owner, 2026-11-25): an Australian / New Zealand passport needs no residency
 * question (Domestic); any other passport is asked about permanent residency (Yes: PR evidence next; No: no visa upload).
 */
export function ResidencyQuestions({ issuingCountry, answers, errors, onChange }: {
  issuingCountry: string;
  answers: Record<string, string>;
  errors: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  if (isDomesticPassport(issuingCountry)) {
    return (
      <p className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-900" data-testid="wizard-domestic">
        <i className="ri-checkbox-circle-line" aria-hidden="true" /> {issuingCountry.trim()} passport: a domestic student. No visa is needed.
      </p>
    );
  }
  const pr = answers[PR_ANSWER] ?? "";
  return (
    <div className="mt-5 space-y-4 rounded-lg border border-background-200 bg-background-100/60 px-4 py-4" data-testid="wizard-residency">
      <YesNo name={PR_ANSWER} label="Are you an Australian permanent resident?" value={pr} error={errors[PR_ANSWER]} onChange={(value) => onChange(PR_ANSWER, value)} />
      {pr === "Yes" ? <p className="text-xs text-foreground-600">Next, upload the permanent residency visa grant notice as evidence.</p> : null}
      {pr === "No" ? <p className="text-xs text-foreground-600">No visa upload is needed.</p> : null}
    </div>
  );
}
