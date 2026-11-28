import { ruleBool } from "@/lib/businessRules";
import { useEffect, useState, type ReactNode } from "react";
import { PhoneInput } from "@/components/feature/applicationInputs";
import AddressFields from "@/components/shared/wizard/AddressFields";
import AddressSearch, { type AddressPick } from "@/components/shared/wizard/AddressSearch";
import { FieldError, WIZARD_INPUT as INPUT, WIZARD_LABEL as LABEL, WizardLabel as Label, WizardTextField } from "@/components/shared/wizard/fields";
import { OSHC_SELF_CONFIRM, optionsOf, type FinishSummary } from "@/pages/agency/lib/wizardFinish";
import type { WizardQuestion } from "@/pages/agency/lib/wizardConfig";
import SearchableSelect from "@/components/ui/SearchableSelect";
import BirthCountryField from "@/pages/agency/components/BirthCountryField";
import { avetmissOptions, useAvetmissCodes } from "@/lib/avetmissCodes";
import { OTHER_LANGUAGE } from "@/pages/agency/lib/wizardConfig";
import { PriorEducationInput } from "@/pages/admin/components/avetmiss/AvetmissInputs";
import { parseCodeList, parsePriorEducation, serializeCodeList, serializePriorEducation } from "@/pages/admin/components/avetmiss/avetmissValues";
import { DeclarationTicks } from "@/pages/agency/components/ApplicationHandoff";
import { formatMobile } from "@/lib/employeeRules";
import { textableMobile } from "@/lib/textableMobile";

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
export default function WizardFinishSteps({ question, answers, errors, onChange, onAddress, summary, studentRole, onEdit, version = 0, passportCountry = "", onDeclarations, extraActions, signExtras }: {
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
  /** The issuing country read from the passport scan ("" when the scan gave none). */
  passportCountry?: string;
  /** APPLICATION-STUDENT-SIGNS: the student's ticked declarations ({ key: hash of the text shown }, complete when all ticked). */
  onDeclarations?: (ticked: Record<string, string>, complete: boolean) => void;
  /** Shown under the summary (the student's Request a change). */
  extraActions?: ReactNode;
  /** Shown under the declarations (a guest student's Create your password). */
  signExtras?: ReactNode;
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
  // The mobile taken on the first screen (or earlier) is not asked again: it shows in the summary with Change (owner 2026-11-26).
  const [mobileKnown, setMobileKnown] = useState(false);
  useEffect(() => {
    setMobileKnown(textableMobile(String(answers.mobile ?? "")));
    // Captured when the screen opens or the draft is refilled, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, question.id]);
  const ask = (name: string) => !prefilled.has(name) || Boolean(errors[name]) || !String(answers[name] ?? "").trim();
  const text = (name: string, label: string, props: { required?: boolean; placeholder?: string; maxLength?: number; upper?: boolean; type?: string } = {}) => (
    <WizardTextField id={`wizard-${name}`} name={name} label={label} value={v(name)} error={errors[name]} required={props.required ?? true} maxLength={props.maxLength ?? 200}
      placeholder={props.placeholder} upper={props.upper} type={props.type} onChange={(value) => onChange(name, value)} />
  );
  const select = (name: string, label: string, options: string[] = optionsOf(name), required = true) => (
    <div>
      <Label htmlFor={`wizard-${name}`} required={required}>{label}</Label>
      <SearchableSelect id={`wizard-${name}`} name={name} value={v(name)} aria-invalid={Boolean(errors[name])} className={INPUT} onChange={(e) => onChange(name, e.target.value)}>
        <option value="">Select</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </SearchableSelect>
      <FieldError text={errors[name]} />
    </div>
  );
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

      {question.id === "personal" ? (
        <div className="space-y-4">
          {/* Only what is missing is asked; what the passport and the student record filled is not shown again. */}
          {PERSONAL_FIELDS.every((name) => !ask(name) || name === "middle_name" || name === "place_of_birth" || name === "birth_country") ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-900" data-testid="wizard-personal-done">
              <i className="ri-checkbox-circle-line" aria-hidden="true" /> Nothing else is needed here. Press Next.
            </p>
          ) : null}
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
            {ask("place_of_birth") && !prefilled.size ? text("place_of_birth", "Town / city of birth", { required: false, placeholder: "As on the passport" }) : null}
            {ask("passport_number") ? text("passport_number", "Passport number", { upper: true, maxLength: 20 }) : null}
            {ask("passport_expiry") ? text("passport_expiry", "Passport expiry date", { type: "date" }) : null}
            {/* Owner 2026-11-25: always asked; "Were you born in {passport country}?" when the passport gave its issuing country. */}
            <BirthCountryField passportCountry={passportCountry} answers={answers} errors={errors} onChange={onChange} />
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
            <div>
              {/* Owner 2026-11-25: AVETMISS needs at least one disability type when the answer is Yes; every type from the
                  AVETMISS list (avetmiss_codes disability_type), more than one may be picked. */}
              <Label htmlFor="wizard-disability_types" required>Which types of disability? (choose all that apply)</Label>
              {codesError ? <p className="text-sm text-red-700">The disability list did not load: {codesError}</p> : (
                <SearchableSelect id="wizard-disability_types" name="disability_types" multiple value={parseCodeList(v("disability_types"))}
                  aria-invalid={Boolean(errors.disability_types)} className={INPUT}
                  onChange={(e) => onChange("disability_types", serializeCodeList(Array.from(e.target.selectedOptions, (o) => o.value).filter(Boolean)))}>
                  {avetmissOptions(codes, "disability_type").map((o) => <option key={o.code} value={o.code}>{`${o.label} - ${o.code}`}</option>)}
                </SearchableSelect>
              )}
              <FieldError text={errors.disability_types} />
            </div>
          ) : null}
          {radios("secondary_enrolled", "Is the student still enrolled in secondary (high) school?")}
          {select("school_level", "Highest completed school level")}
          {/* AVETMISS-SUBMIT-FIX (owner 2026-11-26): NCVER needs the year the highest school level was completed (not for "did not go to school"). */}
          {v("school_level") && !/ - 02$/.test(v("school_level")) ? (
            <div>
              <Label htmlFor="wizard-year_completed" required>Year that school level was completed</Label>
              <input id="wizard-year_completed" name="year_completed" inputMode="numeric" maxLength={4} placeholder="e.g. 2015" value={v("year_completed")}
                aria-invalid={Boolean(errors.year_completed)} className={INPUT} onChange={(e) => onChange("year_completed", e.target.value.replace(/\D/g, "").slice(0, 4))} />
              <FieldError text={errors.year_completed} />
            </div>
          ) : null}
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
          {select("study_reason", "Main reason for doing this course")}
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
          {/* STUDENT-PHONE-OPTIONAL (owner 2026-11-28): the mobile is asked only when SLIT publishes the rule requiring it. */}
          {(mobileKnown && !errors.mobile) || (!ruleBool("admissions.application_mobile_required", false) && !errors.mobile) ? null : <div>
            <Label htmlFor="wizard-mobile" required={ruleBool("admissions.application_mobile_required", false)}>Mobile</Label>
            <PhoneInput key={`mobile-${version}`} id="wizard-mobile" name="mobile" value={v("mobile")} required={ruleBool("admissions.application_mobile_required", false)} placeholder="041 234 5678" onValueChange={(value) => onChange("mobile", value)} />
            <FieldError text={errors.mobile} />
          </div>}
          <div className="rounded-lg border border-background-200 bg-background-100/60 p-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-foreground-500">Student</dt><dd className="font-medium text-foreground-900">{summary.name || "—"}</dd>
              <dt className="text-foreground-500">Course</dt><dd className="font-medium text-foreground-900">{summary.course || "—"}</dd>
              <dt className="text-foreground-500">Intake</dt><dd className="font-medium text-foreground-900">{summary.intake || "—"}</dd>
              {mobileKnown && !errors.mobile && ruleBool("admissions.application_mobile_required", false) ? <><dt className="text-foreground-500">Mobile</dt><dd className="font-medium text-foreground-900">{formatMobile(v("mobile"))}
                <button type="button" onClick={() => setMobileKnown(false)} className="ml-2 cursor-pointer text-xs font-semibold text-primary-700 hover:underline" data-testid="wizard-mobile-change">Change</button></dd></> : null}
              <dt className="text-foreground-500">Documents</dt><dd className="text-foreground-800">{summary.documents.length ? summary.documents.join(", ") : "—"}</dd>
            </dl>
            <div className="mt-3 flex flex-wrap gap-3 text-xs font-semibold text-primary-700">
              {[["personal", "Personal details"], ["address", "Address"], ["course", "Course"], ["study", "Study details"]].map(([id, label]) => (
                <button key={id} type="button" onClick={() => onEdit(id)} className="cursor-pointer hover:underline"><i className="ri-edit-line" aria-hidden="true" /> {label}</button>
              ))}
            </div>
          </div>
          {extraActions ? <div>{extraActions}</div> : null}
          {/* APPLICATION-STUDENT-SIGNS (owner, 2026-11-25): only the student signs, each declaration ticked on its own; the text
              shown comes from the server and its hash is recorded with the signature. */}
          {studentRole ? (
            <div className="space-y-2">
              <p className={LABEL}>Read and sign</p>
              <DeclarationTicks who="student" onChange={(ticked, complete) => onDeclarations?.(ticked, complete)} />
              {signExtras}
              <p className="text-xs text-foreground-600">Signed electronically as <strong className="font-medium text-foreground-900">{v("declaration_name") || summary.name || "you"}</strong> on {v("declaration_date") || new Date().toISOString().slice(0, 10)}.
                If you are under 18, a parent or guardian signs next.</p>
              <FieldError text={errors.declaration_read || errors.consent} />
            </div>
          ) : (
            <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-4 text-sm text-sky-950" data-testid="wizard-student-signs">
              <i className="ri-quill-pen-line" aria-hidden="true" /> Only the student can sign: next, the application is sent to them to review, change what is theirs
              to change, and read and sign the declarations (with a parent or guardian if they are under 18). It is view-only for you while they have it.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
