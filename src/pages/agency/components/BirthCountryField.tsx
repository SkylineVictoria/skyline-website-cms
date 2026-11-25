import { useEffect, useState } from "react";
import CountrySearch from "@/components/shared/CountrySearch";
import { searchCountries } from "@/lib/countrySearch";
import { BORN_IN_PASSPORT_COUNTRY, PASSPORT_COUNTRY_LABEL, pickPassportCountry } from "@/pages/agency/lib/birthCountry";
import { FieldError, WIZARD_LABEL as LABEL } from "@/components/shared/wizard/fields";

async function resolvePassportCountry(scanned: string): Promise<string> {
  return scanned.trim() ? pickPassportCountry(scanned, await searchCountries(scanned.trim(), 5)) : "";
}

/**
 * Country of birth on the wizard's Personal details screen (owner, 2026-11-25). When the passport scan gave the issuing country,
 * a required "Were you born in {country}?" question: Yes stores that country's AVETMISS label as birth_country, No shows the
 * searchable country picker (avetmiss_code_search), starting empty. Without a passport country, only the picker.
 */
export default function BirthCountryField({ passportCountry, answers, errors, onChange }: {
  /** The issuing country read from the passport, as scanned. */
  passportCountry: string;
  answers: Record<string, string>;
  errors: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  const label = answers[PASSPORT_COUNTRY_LABEL] ?? "";
  const born = answers[BORN_IN_PASSPORT_COUNTRY] ?? "";
  const value = answers.birth_country ?? "";
  const [resolving, setResolving] = useState(Boolean(passportCountry.trim()));

  useEffect(() => {
    let active = true;
    if (!passportCountry.trim()) { setResolving(false); if (label) onChange(PASSPORT_COUNTRY_LABEL, ""); return; }
    setResolving(true);
    resolvePassportCountry(passportCountry)
      .then((resolved) => { if (active && resolved !== label) onChange(PASSPORT_COUNTRY_LABEL, resolved); })
      .catch(() => { if (active && label) onChange(PASSPORT_COUNTRY_LABEL, ""); })
      .finally(() => { if (active) setResolving(false); });
    return () => { active = false; };
    // Resolved once per passport country.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passportCountry]);

  // A saved country of birth answers the question again when the screen is reopened.
  useEffect(() => {
    if (!label || born || !value) return;
    onChange(BORN_IN_PASSPORT_COUNTRY, value === label ? "Yes" : "No");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, value]);

  if (resolving) return <p className="text-sm text-foreground-600 sm:col-span-2">Checking the passport country…</p>;

  const pick = (answer: "Yes" | "No") => {
    onChange(BORN_IN_PASSPORT_COUNTRY, answer);
    // Yes: the passport country exactly as AVETMISS names it. No: start empty (never the passport country by default).
    if (answer === "Yes") onChange("birth_country", label);
    else if (value === label) onChange("birth_country", "");
  };

  return (
    <div className="space-y-4 sm:col-span-2">
      {label ? (
        <fieldset data-testid="wizard-born-in-passport-country">
          <legend className={LABEL}>Were you born in {label}? <span className="text-primary-600">*</span></legend>
          <div className="flex gap-5 text-sm">
            {(["Yes", "No"] as const).map((option) => (
              <label key={option} className="flex items-start gap-2">
                <input type="radio" name={BORN_IN_PASSPORT_COUNTRY} value={option} checked={born === option} onChange={() => pick(option)} className="mt-0.5" /> {option}
              </label>
            ))}
          </div>
          <FieldError text={errors[BORN_IN_PASSPORT_COUNTRY]} />
        </fieldset>
      ) : null}
      {!label || born === "No" ? (
        <CountrySearch id="wizard-birth_country" name="birth_country" label="Country of birth" value={value} error={errors.birth_country} onChange={(next) => onChange("birth_country", next)} />
      ) : null}
    </div>
  );
}
