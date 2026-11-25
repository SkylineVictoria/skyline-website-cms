import { ruleBool } from "@/lib/businessRules";
import { useEffect, useState } from "react";
import { PhoneInput } from "@/components/feature/applicationInputs";
import AddressFields from "@/components/shared/wizard/AddressFields";
import AddressSearch, { type AddressPick } from "@/components/shared/wizard/AddressSearch";
import { FieldError, WIZARD_INPUT as INPUT, WIZARD_LABEL as LABEL, WizardLabel as Label, WizardTextField } from "@/components/shared/wizard/fields";
import { DECLARATION_TERMS, OSHC_SELF_CONFIRM, optionsOf, type FinishSummary } from "@/pages/agency/lib/wizardFinish";
import type { WizardQuestion } from "@/pages/agency/lib/wizardConfig";
import SearchableSelect from "@/components/ui/SearchableSelect";
import { activeAvetmissCode, avetmissOptions, useAvetmissCodes, type AvetmissCodeSet } from "@/lib/avetmissCodes";
import { OTHER_LANGUAGE } from "@/pages/agency/lib/wizardConfig";
import { DisabilityTypesInput, PriorEducationInput } from "@/pages/admin/components/avetmiss/AvetmissInputs";
import { parseCodeList, parsePriorEducation, serializeCodeList, serializePriorEducation } from "@/pages/admin/components/avetmiss/avetmissValues";

const PERSONAL_LABELS: Record<string, string> = {
  title: "Title", gender: "Gender", first_name: "Given name", middle_name: "Middle name", last_name: "Surname", dob: "Date of birth",
  email: "Email", nationality: "Nationality", citizenship: "Citizenship", birth_country: "Country of birth",
  place_of_birth: "Town / city of birth", passport_number: "Passport number", passport_expiry: "Passport expiry",
};
const PERSONAL_FIELDS = Object.keys(PERSONAL_LABELS);

/**
 * WIZARD-FULL (owner, 2026-11-23): the answer screens that finish the whole application inside the wizard: Personal details, Address,
 * About the student (AVETMISS), Study details and Declaration and submit. Options come from the application form's own fields
 * (portalSections), so the wizard and the form always offer the same answers and the database's submission check accepts them.
 */
export default function WizardFinishSteps({ question, answers, errors, onChange, onAddress, summary, studentRole, onEdit, version = 0 }: {
  question: WizardQuestion;
  answers: Record<string, string>;
  errors: Record<string, string>;
  onChange: (name: string, value: string) => void;
  /** A picked address search result fills the address fields. */
  onAddress: (pick: AddressPick) => void;
  summary: FinishSummary;
  /** The student files their own application (the consent lines say "I" instead of "the student"). */
  studentRole: boolean;
  /** Goes back to an earlier screen by its id. */
  onEdit: (screen: string) => void;
  /** Changes when the answers were refilled from the draft (the phone box remounts to show the stored number). */
  version?: number;
}) {
  const v = (name: string) => answers[name] ?? "";
  const { codes, error: codesError } = useAvetmissCodes();
  // One page, one time (owner, 2026-11-23): what the passport (or the student record) already filled was shown on the document
  // step, so Personal details asks only for what is still missing and does not show the rest again.
  const [prefilled, setPrefilled] = useState<Set<string>>(new Set());
  useEffect(() => {
    setPrefilled(new Set(PERSONAL_FIELDS.filter((name) => String(answers[name] ?? "").trim())));
    // Captured when the screen opens or the answers are refilled from the draft, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, question.id]);
  const ask = (name: string) => !prefilled.has(name) || Boolean(errors[name]) || !String(answers[name] ?? "").trim();
  const text = (name: string, label: string, props: { required?: boolean; placeholder?: string; maxLength?: number; upper?: boolean; type?: string } = {}) => (
    <WizardTextField id={`wizard-${name}`} name={name} label={label} value={v(name)} error={errors[name]} required={props.required ?? true} maxLength={props.maxLength ?? 200}
      placeholder={props.placeholder} upper={props.upper} type={props.type} onChange={(value) => onChange(name, value)} />
  );
  // rule-policy: technical application-select Render existing required field metadata.
  const select = (name: string, label: string, options: string[] = optionsOf(name), required = true, selected = v(name)) => (
    <div>
      <Label htmlFor={`wizard-${name}`} required={required}>{label}</Label>
      <SearchableSelect id={`wizard-${name}`} name={name} value={selected} aria-invalid={Boolean(errors[name])} className={INPUT} onChange={(e) => onChange(name, e.target.value)}>
        <option value="">Select</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </SearchableSelect>
      <FieldError text={errors[name]} />
    </div>
  );
  const governmentSelect = (name: string, label: string, codeSet: AvetmissCodeSet) => {
    const options = avetmissOptions(codes, codeSet);
    const current = options.find((option) => option.code === activeAvetmissCode(codes, codeSet, v(name)));
    // rule-policy: technical existing-field-schema Render existing mandatory fields using their current reference options.
    return select(name, label, options.map((option) => option.label), true, current?.label ?? "");
  };
  const radios = (name: string, label: string, options: string[] = optionsOf(name)) => (
    <fieldset>
      <legend className={LABEL}>{label} <span className="text-primary-600">*</span></legend>
      <div className="flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-x-5">
        {options.map((option) => (
          <label key={option} className="flex items-start gap-2">
            <input type="radio" name={name} value={option} checked={v(name) === option} onChange={() => onChange(name, option)} className="mt-0.5" /> {option}
          </label>
        ))}
      </div>
      <FieldError text={errors[name]} />
    </fieldset>
  );

  const tick = (name: string, label: string) => (
    <label className="flex items-start gap-2 text-sm text-foreground-800">
      <input type="checkbox" name={name} checked={v(name) === "Yes"} onChange={(e) => onChange(name, e.target.checked ? "Yes" : "")} className="mt-0.5 h-4 w-4 accent-primary-500" />
      <span className="leading-snug">{label}</span>
    </label>
  );

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-heading text-base font-semibold text-foreground-950">{question.title}</h3>
        <p className="mt-1 text-sm text-foreground-600">{question.subtitle}</p>
      </div>

      {codesError && ["personal", "identifier", "study"].includes(question.id) ? (
        <p role="alert">The AVETMISS reference lists could not be loaded. Reopen the wizard to retry.</p>
      ) : null}

      {question.id === "personal" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {ask("title") ? select("title", "Title") : null}
            {ask("gender") ? radios("gender", "Gender") : null}
            {ask("first_name") ? text("first_name", "Given name") : null}
            {ask("middle_name") && !prefilled.size ? text("middle_name", "Middle name", { required: false }) : null}
            {ask("last_name") ? text("last_name", "Surname") : null}
            {ask("dob") ? text("dob", "Date of birth", { type: "date" }) : null}
            {ask("email") ? text("email", "Email", { type: "email" }) : null}
            {ask("nationality") ? select("nationality", "Nationality") : null}
            {ask("citizenship") ? select("citizenship", "Country of citizenship") : null}
            {governmentSelect("birth_country", "Country of birth", "country")}
            {ask("place_of_birth") && !prefilled.size ? text("place_of_birth", "Town / city of birth", { required: false, placeholder: "As on the passport" }) : null}
            {ask("passport_number") ? text("passport_number", "Passport number", { upper: true, maxLength: 20 }) : null}
            {ask("passport_expiry") ? text("passport_expiry", "Passport expiry date", { type: "date" }) : null}
          </div>
        </div>
      ) : null}

      {question.id === "address" ? (
        <div className="space-y-4">
          <AddressSearch inputId="wizard-address-search" label="Search the address" onPick={onAddress} />
          <AddressFields idPrefix="wizard-address-" value={{ street: v("au_street"), line2: v("au_line2"), suburb: v("au_suburb"), state: v("au_state"), postcode: v("au_zip"), country: v("au_country") || "Australia" }}
            errors={{ street: errors.au_street, line2: errors.au_line2, suburb: errors.au_suburb, state: errors.au_state, postcode: errors.au_zip, country: errors.au_country }}
            onChange={(field, value) => onChange({ street: "au_street", line2: "au_line2", suburb: "au_suburb", state: "au_state", postcode: "au_zip", country: "au_country" }[field], value)} />
        </div>
      ) : null}

      {question.id === "identifier" ? (
        <div className="space-y-5">
          {radios("atsi", "Is the student of Aboriginal or Torres Strait Islander origin?")}
          {select("employment", "Employment status")}
          {v("language_home") === OTHER_LANGUAGE ? (
            <div>
              <Label htmlFor="wizard-english_proficiency_code">How well does the student speak English? (Optional)</Label>
              <SearchableSelect id="wizard-english_proficiency_code" name="english_proficiency_code" value={v("english_proficiency_code")} aria-invalid={Boolean(errors.english_proficiency_code)} className={INPUT}
                onChange={(e) => onChange("english_proficiency_code", e.target.value)}>
                <option value="">Select</option>
                {avetmissOptions(codes, "english_proficiency", v("english_proficiency_code")).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
              </SearchableSelect>
              <FieldError text={errors.english_proficiency_code} />
            </div>
          ) : null}
          {radios("disability", "Do you consider yourself to have a disability, impairment or long-term condition?")}
          {v("disability") === "Yes" ? (
            <fieldset>
              <legend className={LABEL}>Which types of disability? (Optional)</legend>
              <p className="mb-2 text-xs text-foreground-600">
                You may leave the categories blank.{" "}
                <a className="underline" href="https://www.ncver.edu.au/sites/default/files/ncver-documents/AVETMISS-Data-element-definitions-2_3-Nov-2022.pdf#page=70" target="_blank" rel="noreferrer">
                  NCVER disability category definitions
                </a>
              </p>
              <DisabilityTypesInput allowUnspecified={false} codes={codes} value={parseCodeList(v("disability_types"))} idPrefix="wizard-disability" onChange={(next) => onChange("disability_types", serializeCodeList(next))} />
              <FieldError text={errors.disability_types} />
            </fieldset>
          ) : null}
          {radios("secondary_enrolled", "Is the student still enrolled in secondary (high) school?")}
          {select("school_level", "Highest completed school level")}
          {radios("prior_ed", "Has the student successfully completed any prior education?")}
          {v("prior_ed") === "Yes" ? (
            <fieldset>
              <legend className={LABEL}>Prior qualifications completed <span className="text-primary-600">*</span></legend>
              <PriorEducationInput codes={codes} rows={(() => { const rows = parsePriorEducation(v("prior_education")); return rows.length ? rows : [{ code: "", recognition: "", name: "" }]; })()}
                onChange={(next) => onChange("prior_education", serializePriorEducation(next))} />
              <FieldError text={errors.prior_education} />
            </fieldset>
          ) : null}
        </div>
      ) : null}

      {question.id === "study" ? (
        <div className="space-y-5">
          {governmentSelect("study_reason", "Main reason for doing this course", "study_reason")}
          {radios("rpl", "Apply for Recognition of Prior Learning (RPL) or Credit Transfer?")}
          {v("rpl") === "Yes" ? <p className="text-xs text-foreground-600">SLIT will ask for the supporting documents (prior qualifications, transcripts) after the application is submitted.</p> : null}
          {select("oshc_require", "Should SLIT arrange Overseas Student Health Cover (OSHC)?")}
          {v("oshc_require") === "Yes" ? text("oshc_start_date", "Preferred cover start date", { type: "date", required: false }) : null}
          {v("oshc_require") === "No" ? <div>{tick("oshc_self_confirm", OSHC_SELF_CONFIRM)}<FieldError text={errors.oshc_self_confirm} /></div> : null}
          {v("oshc_require") === "Already Have" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {text("oshc_provider", "Provider", { required: false })}
              {text("oshc_policy_number", "Policy number", { required: false })}
              {text("oshc_expiry", "Policy expiry", { type: "date", required: false })}
            </div>
          ) : null}
          {select("hear_about", "How did the student hear about SLIT?")}
        </div>
      ) : null}

      {question.id === "declare" ? (
        <div className="space-y-5">
          <div>
            <Label htmlFor="wizard-mobile" required={ruleBool("admissions.application_mobile_required", true)}>Mobile</Label>
            <PhoneInput key={`mobile-${version}`} id="wizard-mobile" name="mobile" value={v("mobile")} required={ruleBool("admissions.application_mobile_required", true)} placeholder="041 234 5678" onValueChange={(value) => onChange("mobile", value)} />
            <FieldError text={errors.mobile} />
          </div>
          <div className="rounded-lg border border-background-200 bg-background-100/60 p-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-foreground-500">Student</dt><dd className="font-medium text-foreground-900">{summary.name || "—"}</dd>
              <dt className="text-foreground-500">Course</dt><dd className="font-medium text-foreground-900">{summary.course || "—"}</dd>
              <dt className="text-foreground-500">Intake</dt><dd className="font-medium text-foreground-900">{summary.intake || "—"}</dd>
              <dt className="text-foreground-500">Documents</dt><dd className="text-foreground-800">{summary.documents.length ? summary.documents.join(", ") : "—"}</dd>
            </dl>
            <div className="mt-3 flex flex-wrap gap-3 text-xs font-semibold text-primary-700">
              {[["personal", "Personal details"], ["address", "Address"], ["course", "Course"], ["study", "Study details"]].map(([id, label]) => (
                <button key={id} type="button" onClick={() => onEdit(id)} className="cursor-pointer hover:underline"><i className="ri-edit-line" aria-hidden="true" /> {label}</button>
              ))}
            </div>
          </div>
          <div>
            <p className={LABEL}>Student declaration</p>
            <ul className="max-h-48 list-disc space-y-1.5 overflow-y-auto rounded-lg border border-background-200 bg-background-50 py-3 pl-8 pr-4 text-xs leading-relaxed text-foreground-700">
              {DECLARATION_TERMS.map((term) => <li key={term}>{term}</li>)}
            </ul>
          </div>
          {/* One tick agrees, confirms and signs (owner, 2026-11-23: no name typed again, no second or third tick). */}
          {(() => {
            const signer = v("declaration_name") || summary.name;
            const agreed = v("declaration_read") === "Yes" && v("consent_confirmed") === "Yes" && v("consent_authorised") === "Yes";
            const set = (on: boolean) => {
              const yes = on ? "Yes" : "";
              onChange("declaration_read", yes); onChange("consent_confirmed", yes); onChange("consent_authorised", yes);
              onChange("declaration_name", signer); onChange("digital_signature", on ? signer : "");
            };
            return <div className="rounded-lg border border-primary-200 bg-primary-50/50 p-4">
              <label className="flex items-start gap-3 text-sm text-foreground-900">
                <input type="checkbox" name="declaration_read" checked={agreed} onChange={(e) => set(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-primary-500" data-testid="wizard-agree" />
                <span className="leading-snug">{studentRole
                  ? "I have read and agree to the declaration, and the information and documents in this application are my own and true."
                  : "The student has read and agrees to the declaration, the information and documents are theirs and true, and I am authorised to submit this application for them."}</span>
              </label>
              <p className="mt-2 pl-8 text-xs text-foreground-600">Signed electronically as <strong className="font-medium text-foreground-900">{signer || "the student"}</strong> on {v("declaration_date")}.</p>
              <FieldError text={errors.declaration_read || errors.consent} />
            </div>;
          })()}
        </div>
      ) : null}
    </div>
  );
}
