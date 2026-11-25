import { FieldError, WIZARD_LABEL as LABEL, WizardTextField } from "@/components/shared/wizard/fields";
import { IN_AUSTRALIA_ANSWER, PR_ANSWER, isDomesticPassport } from "@/pages/agency/lib/residency";

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
 * questions (Domestic); any other passport is asked about permanent residency, then (not PR) whether the student is in Australia.
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
  const inAu = answers[IN_AUSTRALIA_ANSWER] ?? "";
  return (
    <div className="mt-5 space-y-4 rounded-lg border border-background-200 bg-background-100/60 px-4 py-4" data-testid="wizard-residency">
      <YesNo name={PR_ANSWER} label="Are you an Australian permanent resident?" value={pr} error={errors[PR_ANSWER]}
        onChange={(value) => { onChange(PR_ANSWER, value); if (value === "Yes" && inAu) onChange(IN_AUSTRALIA_ANSWER, ""); }} />
      {pr === "Yes" ? <p className="text-xs text-foreground-600">Next, upload the permanent residency visa grant notice as evidence.</p> : null}
      {pr === "No" ? (
        <YesNo name={IN_AUSTRALIA_ANSWER} label="Are you currently in Australia?" value={inAu} error={errors[IN_AUSTRALIA_ANSWER]} onChange={(value) => onChange(IN_AUSTRALIA_ANSWER, value)} />
      ) : null}
      {pr === "No" && inAu === "Yes" ? <p className="text-xs text-foreground-600">Next, upload the current Australian visa and enter its details.</p> : null}
      {pr === "No" && inAu === "No" ? <p className="text-xs text-foreground-600">No visa is needed yet: the CoE is issued first, then the student applies for the visa.</p> : null}
    </div>
  );
}

/** The visa details asked when the student is in Australia on a visa (existing visa_* fields), prefilled from the visa read. */
export function VisaDetails({ answers, errors, onChange }: { answers: Record<string, string>; errors: Record<string, string>; onChange: (name: string, value: string) => void }) {
  return (
    <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="wizard-visa-details">
      <WizardTextField id="wizard-visa_subclass" name="visa_subclass" label="Visa subclass" value={answers.visa_subclass ?? ""} error={errors.visa_subclass} maxLength={3}
        placeholder="e.g. 500" inputMode="numeric" onChange={(value) => onChange("visa_subclass", value.replace(/\D/g, ""))} />
      <WizardTextField id="wizard-visa_grant_number" name="visa_grant_number" label="Visa grant number" value={answers.visa_grant_number ?? ""} error={errors.visa_grant_number} maxLength={40}
        upper onChange={(value) => onChange("visa_grant_number", value)} />
      <WizardTextField id="wizard-visa_stay_until" name="visa_stay_until" label="Visa expiry date" type="date" value={answers.visa_stay_until ?? ""} error={errors.visa_stay_until}
        onChange={(value) => onChange("visa_stay_until", value)} />
    </div>
  );
}
