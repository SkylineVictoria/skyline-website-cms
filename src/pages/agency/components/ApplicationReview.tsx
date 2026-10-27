import type { AppSection } from "@/data/applicationForms";
import type { DraftValues } from "@/lib/applicationDraft";
import type { ApplicationDetail } from "@/pages/agency/lib/portalApplications";

export interface ConsentState {
  method: string;
  confirmed: boolean;
  authorised: boolean;
  fileName: string;
  file: File | null;
}

interface Group {
  title: string;
  icon: string;
  rows: Array<[label: string, key: string]>;
}

const GROUPS: Group[] = [
  {
    title: "Student details",
    icon: "ri-user-line",
    rows: [
      ["Title", "title"],
      ["Given name", "first_name"],
      ["Middle name", "middle_name"],
      ["Surname", "last_name"],
      ["Date of birth", "dob"],
      ["Gender", "gender"],
      ["Mobile", "mobile"],
      ["Email", "email"],
    ],
  },
  {
    title: "Passport & nationality",
    icon: "ri-id-card-line",
    rows: [
      ["Passport number", "passport_number"],
      ["Passport expiry", "passport_expiry"],
      ["Citizenship", "citizenship"],
      ["Nationality", "nationality"],
      ["Country of birth", "birth_country"],
    ],
  },
  {
    title: "Address & contact",
    icon: "ri-map-pin-2-line",
    rows: [
      ["Address type", "address_type"],
      ["Street", "au_street"],
      ["Suburb", "au_suburb"],
      ["State", "au_state"],
      ["Postcode", "au_zip"],
      ["Overseas address", "ov_street"],
      ["Overseas suburb", "ov_suburb"],
      ["Overseas country", "ov_country"],
    ],
  },
  {
    title: "Visa, English & identifiers",
    icon: "ri-translate-2",
    rows: [
      ["Holds a valid visa", "holds_visa"],
      ["English assessment", "english_type"],
      ["English score", "english_score"],
      ["Date achieved", "english_date"],
      ["USI", "usi_number"],
      ["Employment", "employment"],
      ["Prior education", "prior_ed"],
    ],
  },
  {
    title: "Academic background",
    icon: "ri-file-text-line",
    rows: [
      ["Institution", "academic_institution"],
      ["Qualification", "academic_qualification"],
      ["Year completed", "academic_year"],
    ],
  },
  {
    title: "Emergency contact",
    icon: "ri-phone-line",
    rows: [
      ["Full name", "ec_name"],
      ["Relationship", "ec_relationship"],
      ["Email", "ec_email"],
      ["Phone", "ec_phone"],
    ],
  },
  {
    title: "Course, study reason & welfare",
    icon: "ri-graduation-cap-line",
    rows: [
      ["Preferred intake", "preferred_intake"],
      ["Reason for study", "study_reason"],
      ["Recognition of prior learning", "rpl"],
      ["OSHC arrangement", "oshc_require"],
      ["OSHC provider", "oshc_provider"],
      ["OSHC policy number", "oshc_policy_number"],
    ],
  },
  {
    title: "Declaration",
    icon: "ri-quill-pen-line",
    rows: [
      ["Declarant name", "declaration_name"],
      ["Digital signature", "digital_signature"],
      ["Declaration date", "declaration_date"],
      ["Checklist acknowledged", "checklist"],
    ],
  },
];

export default function ApplicationReview({
  values,
  courses,
  sections,
  application,
  agentName,
  agencyName,
  consent,
  onConsentChange,
  onEditSection,
  missing,
  submitting,
  submitError,
  readOnly = false,
  canSubmit = true,
  onSubmit,
}: {
  values: DraftValues;
  courses: string[];
  sections: AppSection[];
  application: ApplicationDetail;
  agentName: string;
  agencyName: string;
  consent: ConsentState;
  onConsentChange: (patch: Partial<ConsentState>) => void;
  onEditSection: (index: number) => void;
  missing: string[];
  submitting: boolean;
  submitError: string;
  readOnly?: boolean;
  /** Only a draft is submitted by agents; after that SLIT administration moves the application on. */
  canSubmit?: boolean;
  onSubmit: () => void;
}) {
  const val = (key: string): string => {
    const v = values[key];
    if (v === undefined || v === null) return "";
    return Array.isArray(v) ? v.join(", ") : String(v);
  };

  const readyToSubmit = missing.length === 0 && consent.method !== "" && consent.confirmed && consent.authorised;
  const declarationName = val("declaration_name");
  const signature = val("digital_signature");

  const studentSignatureMatches =
    declarationName.trim() !== "" &&
    signature.trim() !== "" &&
    declarationName.trim().toLowerCase() === signature.trim().toLowerCase();

  return (
    <div className="space-y-5">
      <div className="rounded-card border border-background-200 bg-background-50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-heading text-lg font-bold text-foreground-950">Review application</h3>
            <p className="mt-1 text-sm text-foreground-600">
              Check every section below. Missing required items are listed at the top so you can jump straight back to fix them.
            </p>
          </div>
          <span className="rounded-full bg-secondary-100 px-3 py-1 text-xs font-semibold text-secondary-900">
            {application.reference || "Draft"}
          </span>
        </div>
      </div>

      {missing.length > 0 ? (
        <div className="rounded-card border border-primary-200 bg-primary-50 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-primary-900">
            <i className="ri-error-warning-line" aria-hidden="true" />
            {missing.length} required item{missing.length === 1 ? "" : "s"} still need attention
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {missing.map((item) => (
              <li key={item} className="flex items-start gap-2 text-xs text-primary-900">
                <i className="ri-arrow-right-s-line mt-px" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-card border border-accent-200 bg-accent-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-accent-900">
            <i className="ri-checkbox-circle-line" aria-hidden="true" />
            All required fields are complete.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {GROUPS.map((group) => (
          <div key={group.title} className="rounded-card border border-background-200 bg-background-50 p-5">
            <p className="flex items-center gap-2 font-heading text-sm font-semibold text-foreground-950">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-100 text-primary-700">
                <i className={group.icon} aria-hidden="true" />
              </span>
              {group.title}
            </p>
            <dl className="mt-3 space-y-2">
              {group.rows.map(([label, key]) => {
                const value = val(key);
                if (!value) return null;
                return (
                  <div key={key} className="flex items-start justify-between gap-3 text-xs">
                    <dt className="text-foreground-500">{label}</dt>
                    <dd className="max-w-[60%] break-words text-right font-medium text-foreground-900">{value}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}

        <div className="rounded-card border border-background-200 bg-background-50 p-5">
          <p className="flex items-center gap-2 font-heading text-sm font-semibold text-foreground-950">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-100 text-accent-900">
              <i className="ri-graduation-cap-line" aria-hidden="true" />
            </span>
            Courses & agency
          </p>
          <dl className="mt-3 space-y-2 text-xs">
            <div className="flex items-start justify-between gap-3">
              <dt className="text-foreground-500">Selected courses</dt>
              <dd className="max-w-[60%] text-right font-medium text-foreground-900">
                {courses.length === 0 ? "\u2014" : courses.join("; ")}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-foreground-500">Agency</dt>
              <dd className="text-right font-medium text-foreground-900">{agencyName || "\u2014"}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-foreground-500">Submitted through agent</dt>
              <dd className="text-right font-medium text-foreground-900">{val("via_agent") || "Yes"}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-foreground-500">Agent</dt>
              <dd className="text-right font-medium text-foreground-900">{agentName || "\u2014"}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="rounded-card border border-background-200 bg-background-50 p-5">
        <h4 className="font-heading text-sm font-bold uppercase tracking-wide text-foreground-950">
          Student declaration & consent
        </h4>
        <p className="mt-2 text-xs leading-relaxed text-foreground-600">
          The student declaration above is a statement made by the <strong>student</strong>, not the agent. Record how the
          student&rsquo;s consent was collected, and upload the signed form if one was used.
        </p>
        {!studentSignatureMatches && (declarationName || signature) ? (
          <p className="mt-3 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-900">
            The declarant name and digital signature do not match. The student declaration must be signed with the
            student&rsquo;s own name.
          </p>
        ) : null}

        {readOnly ? (
          <div className="mt-4 rounded-md border border-background-200 bg-background-100 px-4 py-3 text-xs text-foreground-700">
            {application.consents.length === 0 ? (
              <p>No consent record stored.</p>
            ) : (
              <ul className="space-y-1.5">
                {application.consents.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <i className="ri-shield-check-line text-accent-700" aria-hidden="true" />
                    Method: <strong>{c.method || "\u2014"}</strong>
                    {c.signedDocumentRef ? <span>&middot; Document: {c.signedDocumentRef}</span> : null}
                    <span>&middot; Recorded by {c.recordedByName || "\u2014"}</span>
                    <span>&middot; v{c.declarationVersion || "1.0"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-700">
              Consent collection method <span className="text-primary-600">*</span>
            </p>
            <div className="space-y-2">
              {[
                { value: "electronic", label: "Electronic declaration completed by the student" },
                { value: "document", label: "Signed declaration document uploaded" },
              ].map((option) => (
                <label key={option.value} className="flex cursor-pointer items-start gap-2 text-sm text-foreground-700">
                  <input
                    type="radio"
                    name="consent_method"
                    checked={consent.method === option.value}
                    onChange={() => onConsentChange({ method: option.value })}
                    className="mt-0.5 h-4 w-4 accent-primary-500"
                  />
                  <span className="leading-snug">{option.label}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-700">
              Signed declaration document (optional)
            </p>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                onConsentChange({ file, fileName: file?.name ?? "" });
              }}
              className="w-full cursor-pointer rounded-md border border-dashed border-background-300 bg-background-50 px-3.5 py-2.5 text-xs text-foreground-700 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary-700"
            />
            {consent.fileName ? (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-foreground-600">
                <i className="ri-attachment-2" aria-hidden="true" />
                {consent.fileName}
              </p>
            ) : (
              <p className="mt-2 text-xs text-foreground-400">
                Stored privately against this application. Only your agency and SLIT can access it.
              </p>
            )}
          </div>
        </div>
        )}

        {!readOnly ? (
        <div className="mt-4 space-y-2 border-t border-background-200 pt-4">
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground-700">
            <input
              type="checkbox"
              checked={consent.confirmed}
              onChange={(event) => onConsentChange({ confirmed: event.target.checked })}
              className="mt-0.5 h-4 w-4 accent-primary-500"
            />
            <span className="leading-snug">
              I confirm the student has reviewed this application and authorised its submission. The student&rsquo;s own
              declaration and signature are recorded in the form above.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground-700">
            <input
              type="checkbox"
              checked={consent.authorised}
              onChange={(event) => onConsentChange({ authorised: event.target.checked })}
              className="mt-0.5 h-4 w-4 accent-primary-500"
            />
            <span className="leading-snug">
              I confirm I am the agent handling this application and am authorised to submit it on the student&rsquo;s
              behalf.
            </span>
          </label>
        </div>
        ) : null}

        <p className="mt-4 rounded-md bg-background-100 px-3 py-2 text-xs text-foreground-500">
          Prepared by {agentName || "the agency"} &middot; Declaration version 1.0 &middot; Consent recorded against
          your account.
        </p>
      </div>

      {submitError ? (
        <p className="rounded-md border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900" role="alert">
          {submitError}
        </p>
      ) : null}

      {!readOnly && !canSubmit ? (
        <p className="rounded-card border border-background-200 bg-background-50 p-5 text-sm text-foreground-700">
          Your corrections are saved on this application. SLIT administration reviews them and moves the application on; it cannot be resubmitted from here.
        </p>
      ) : null}

      {!readOnly && canSubmit ? (
      <div className="flex flex-col gap-3 rounded-card border border-background-200 bg-background-50 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm">
          {readyToSubmit ? (
            <p className="flex items-center gap-2 font-semibold text-accent-900">
              <i className="ri-checkbox-circle-line" aria-hidden="true" />
              Ready to submit
            </p>
          ) : (
            <p className="flex items-center gap-2 text-foreground-600">
              <i className="ri-information-line" aria-hidden="true" />
              Complete the missing items and consent confirmations to submit.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => onEditSection(sections.length - 1)}
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border border-background-300 px-4 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:bg-background-100"
          >
            <i className="ri-arrow-left-line" aria-hidden="true" />
            Back to form
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!readyToSubmit || submitting}
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
                Submitting&hellip;
              </>
            ) : (
              <>
                Submit application
                <i className="ri-send-plane-line" aria-hidden="true" />
              </>
            )}
          </button>
        </div>
      </div>
      ) : null}
    </div>
  );
}