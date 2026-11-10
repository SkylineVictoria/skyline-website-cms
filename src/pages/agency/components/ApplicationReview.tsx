import { EditSectionButton, ReviewMissing } from "@/components/shared/wizard/ReviewParts";
import type { AppSection } from "@/data/applicationForms";
import { sectionHeading } from "@/components/feature/applicationFieldHelpers";
import type { DraftValues } from "@/lib/applicationDraft";
import type { ApplicationDetail } from "@/pages/agency/lib/portalApplications";
import { formatStoredValue } from "../../../../supabase/functions/_shared/validation/identifiers";
import { EXPIRY_FIELDS, expiryLabel, expiryTone, expiryTooltip, getDocumentExpiryStatus, type ExpiryDocument } from "@/pages/agency/lib/documentExpiry";
import { qualificationDetail, qualificationTitle, submittedQualifications, type Qualification } from "@/pages/agency/lib/qualifications";

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
  /** A field on the page that Edit opens. */
  edit: string;
  rows: Array<[label: string, key: string]>;
}

const GROUPS: Group[] = [
  {
    title: "Student details",
    icon: "ri-user-line",
    edit: "first_name",
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
    edit: "passport_number",
    rows: [
      ["Passport number", "passport_number"],
      ["Passport expiry", "passport_expiry"],
      ["Citizenship", "citizenship"],
      ["Nationality", "nationality"],
      ["Country of birth", "birth_country"],
    ],
  },
  {
    title: "Address",
    icon: "ri-map-pin-2-line",
    edit: "au_street",
    rows: [
      ["Address type", "address_type"],
      ["Street", "au_street"],
      ["Suburb", "au_suburb"],
      ["State", "au_state"],
      ["Postcode", "au_zip"],
    ],
  },
  {
    title: "Australian visa",
    icon: "ri-passport-line",
    edit: "visa_subclass",
    rows: [
      ["Holds a valid visa", "holds_visa"],
      ["Visa subclass", "visa_subclass"],
      ["Visa grant number", "visa_grant_number"],
      ["Visa stay-until / expiry", "visa_stay_until"],
    ],
  },
  {
    title: "English test",
    icon: "ri-translate-2",
    edit: "english_type",
    rows: [
      ["English assessment", "english_type"],
      ["English score", "english_score"],
      ["Date achieved", "english_date"],
    ],
  },
  {
    title: "Student identifiers",
    icon: "ri-fingerprint-line",
    edit: "employment",
    rows: [
      ["Employment", "employment"],
      ["Language at home", "language_home"],
      ["Which language", "language_other"],
      ["Aboriginal / Torres Strait Islander", "atsi"],
      ["Disability", "disability"],
    ],
  },
  {
    title: "Academic background",
    icon: "ri-file-text-line",
    edit: "school_level",
    rows: [
      ["Highest education", "highest_education"],
      ["School level (reported)", "school_level"],
      ["Prior education", "prior_ed"],
    ],
  },
  {
    title: "USI",
    icon: "ri-shield-user-line",
    edit: "usi_number",
    rows: [["USI", "usi_number"]],
  },
  {
    title: "Emergency contact",
    icon: "ri-phone-line",
    edit: "ec_name",
    rows: [
      ["Full name", "ec_name"],
      ["Phone number", "ec_phone"],
      ["Relationship", "ec_relationship"],
    ],
  },
  {
    title: "Course & intake",
    icon: "ri-graduation-cap-line",
    edit: "courses_of_interest",
    rows: [
      ["Course", "courses_of_interest"],
      ["Preferred intake", "preferred_intake"],
    ],
  },
  {
    title: "Study reason & course credit",
    icon: "ri-book-open-line",
    edit: "study_reason",
    rows: [
      ["Reason for study", "study_reason"],
      ["Recognition of prior learning", "rpl"],
    ],
  },
  {
    title: "Health cover & source",
    icon: "ri-heart-pulse-line",
    edit: "oshc_require",
    rows: [
      ["SLIT to arrange OSHC", "oshc_require"],
      ["OSHC start date", "oshc_start_date"],
      ["OSHC provider", "oshc_provider"],
      ["OSHC policy number", "oshc_policy_number"],
      ["How they heard about SLIT", "hear_about"],
    ],
  },
  {
    title: "Declaration",
    icon: "ri-quill-pen-line",
    edit: "declaration_name",
    rows: [
      ["Declarant name", "declaration_name"],
      ["Digital signature", "digital_signature"],
      ["Declaration date", "declaration_date"],
    ],
  },
];

export default function ApplicationReview({
  values,
  courses,
  sections,
  application,
  qualifications,
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
  qualifications: Qualification[];
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
    return Array.isArray(v) ? v.join(", ") : formatStoredValue(key, String(v));
  };

  /** Form page holding a field, or -1. */
  const pageOf = (key: string) => sections.findIndex((section) => section.fields.some((field) => field.name === key));
  /** Missing items read "SECTION: Field"; find the page by its heading. */
  const pageOfMissing = (item: string) => sections.findIndex((section, index) => item.startsWith(`${sectionHeading(section.title, index)}: `));
  const editButton = (page: number, label: string) =>
    readOnly || page < 0 ? null : <EditSectionButton label={label} onClick={() => onEditSection(page)} />;

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

      <ReviewMissing items={missing.map((item) => { const page = pageOfMissing(item); return { text: item, onOpen: readOnly || page < 0 ? undefined : () => onEditSection(page) }; })} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {GROUPS.map((group) => (
          <div key={group.title} className="rounded-card border border-background-200 bg-background-50 p-5">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-2 font-heading text-sm font-semibold text-foreground-950">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-100 text-primary-700">
                  <i className={group.icon} aria-hidden="true" />
                </span>
                {group.title}
              </p>
              {editButton(pageOf(group.edit), group.title)}
            </div>
            <dl className="mt-3 space-y-2">
              {[
                ...(group.title === "Academic background"
                  ? submittedQualifications(qualifications, values).map((item, index): [string, string, string] => [`Qualification ${index + 1}`, `academic-${index}`, [qualificationTitle(item), qualificationDetail(item)].filter(Boolean).join(" · ")])
                  : []),
                ...group.rows.map(([label, key]): [string, string, string] => [label, key, key === "courses_of_interest" ? courses.join("; ") : val(key)]),
              ].map(([label, key, value]) => {
                if (!value) return null;
                return (
                  <div key={key} className="flex items-start justify-between gap-3 text-xs">
                    <dt className="text-foreground-500">{label}{expiryNote(key, values)}</dt>
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
            Agency
          </p>
          <dl className="mt-3 space-y-2 text-xs">
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
          The student declaration above is a statement made by the <strong>student</strong>, not the agent. Confirm below that
          the student reviewed and authorised it.
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
        <p className="mt-4 flex items-center gap-2 text-sm text-foreground-700">
          <i className="ri-shield-check-line text-accent-700" aria-hidden="true" />
          Consent is recorded as the student&rsquo;s electronic declaration in the form above.
        </p>
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
            <div className="text-foreground-700">
              <p className="flex items-center gap-2 font-semibold text-primary-900">
                <i className="ri-information-line" aria-hidden="true" />
                Before you can submit:
              </p>
              <ul className="mt-1.5 space-y-1 pl-6 text-xs">
                {missing.map((item) => {
                  const page = pageOfMissing(item);
                  return (
                    <li key={item} className="list-disc">
                      {page < 0 ? item : (
                        <button type="button" onClick={() => onEditSection(page)} className="cursor-pointer text-left text-primary-700 underline underline-offset-2 hover:text-primary-900">
                          {item}
                        </button>
                      )}
                    </li>
                  );
                })}
                {!consent.confirmed ? <li className="list-disc">Tick that the student reviewed and authorised the application.</li> : null}
                {!consent.authorised ? <li className="list-disc">Tick that you are the agent authorised to submit it.</li> : null}
              </ul>
            </div>
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
const EXPIRY_TYPE_BY_FIELD = new Map(Object.entries(EXPIRY_FIELDS).map(([type, name]) => [name, type as ExpiryDocument]));

/** Small, non-blocking expiry warning beside a review row. */
function expiryNote(key: string, values: DraftValues) {
  const type = EXPIRY_TYPE_BY_FIELD.get(key);
  if (!type) return null;
  const expiry = getDocumentExpiryStatus(type, { [key]: values[key] });
  if ((expiry.status !== "expired" && expiry.status !== "expiring_soon") || !expiry.date) return null;
  return (
    <span className={`ml-2 text-[10px] font-semibold ${expiryTone(expiry.status)}`} title={expiryTooltip(expiry)}>
      {expiryLabel(expiry)}
    </span>
  );
}
