import type { AppField, AppSection } from "@/data/applicationForms";
import { isConditionMet, sectionHeading } from "@/components/feature/applicationFieldHelpers";
import { stepTitle } from "@/components/shared/application-form/stepTitle";
import ReviewSummary, { type ReviewIssue, type ReviewStep } from "@/components/shared/application-form/ReviewSummary";
import type { Stage } from "@/pages/agency/lib/applicationStages";
import type { DraftValues } from "@/lib/applicationDraft";
import type { ApplicationDetail } from "@/pages/agency/lib/portalApplications";
import { formatStoredValue } from "../../../../supabase/functions/_shared/validation/identifiers";
import { EXPIRY_FIELDS, expiryLabel, expiryTone, expiryTooltip, getDocumentExpiryStatus, type ExpiryDocument } from "@/pages/agency/lib/documentExpiry";
import "@/pages/agency/lib/admissionsRules"; // Business Rules: expiry warning months, English result validity
import { DeclarationTicks, SignPasswordFields, type SignPassword } from "@/pages/agency/components/ApplicationHandoff";
import DrawSignature from "@/pages/agency/components/DrawSignature";
import { qualificationDetail, qualificationTitle, submittedQualifications, type Qualification } from "@/pages/agency/lib/qualifications";

/** APPLICATION-STUDENT-SIGNS: the student's ticked declarations ({ key: hash of the exact text shown }); complete when all ticked. */
export interface ConsentState {
  declarations: Record<string, string>;
  complete: boolean;
  /** A guest student's new password, created at the signature (needed false when the account already has one). */
  password: SignPassword;
  /** The drawn signature (PNG data URL), required to sign (APPLICATION-DRAWN-SIGNATURE). */
  signature?: string | null;
}

// Field types and answers that are not shown as values: notes, tables, terms, files, and answers the form keeps itself.
const NOT_SHOWN_TYPES = new Set<AppField["type"]>(["static", "table", "terms", "file"]);
const NOT_SHOWN_FIELDS = new Set(["checklist", "address_source", "via_agent", "agent_agency", "agent_contact_name", "agent_email", "agent_phone"]);

/**
 * Review & submit: every missing or invalid item first, each a link to its exact field; then one row per step (from the step
 * config), grouped by stage, with ✓ or ⚠ and Edit, collapsed until clicked (an open row shows the step's answers as label / value
 * pairs). The two confirmations sit at the bottom; the Submit button is the form's footer button.
 */
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
  onJumpToField,
  stages,
  missing,
  documentProblems = [],
  fieldProblems = [],
  submitError,
  readOnly = false,
  canSubmit = true,
  resubmit = false,
  studentSigns = false,
  onePage = false,
  tiles = false,
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
  /** Opens the step and puts the cursor in the field (no field: the step's first answer). */
  onJumpToField: (index: number, field?: string) => void;
  /** The stages the steps are grouped by. */
  stages: readonly Stage[];
  missing: string[];
  /** Per step: a wrong or unread document, as its message ("" when fine). */
  documentProblems?: string[];
  /** Per step: problems across fields (the declarant name and signature differ), each with the field to fix. */
  fieldProblems?: Array<Array<{ field: string; text: string }>>;
  submitError: string;
  readOnly?: boolean;
  /** Only a draft is submitted by agents; after that SLIT administration moves the application on. */
  canSubmit?: boolean;
  /** Action required: corrected, the application is resubmitted with the button below (the declaration is confirmed again). */
  resubmit?: boolean;
  /** APPLICATION-STUDENT-SIGNS: the signed-in person is the student (only they sign; agents send it to them). */
  studentSigns?: boolean;
  /** ONE-PAGE: the answers are edited on the page above; only what is missing and the signature are shown. */
  onePage?: boolean;
  /** ONE-PAGE cards: every step as a square card (two across) with its answers and Edit; the signature is on the next page. */
  tiles?: boolean;
}) {
  const flat: Record<string, string> = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value ?? "")]));
  const val = (key: string): string => {
    const v = values[key];
    if (v === undefined || v === null) return "";
    return Array.isArray(v) ? v.join(", ") : formatStoredValue(key, String(v));
  };

  /** Missing items read "SECTION: Field"; each goes to the step whose heading it starts with. */
  const issuesOf = (index: number): string[] => {
    const prefix = `${sectionHeading(sections[index]?.title, index)}: `;
    const fields = missing.filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length));
    const cross = (fieldProblems[index] ?? []).map((problem) => problem.text);
    return [...fields, ...cross, ...(documentProblems[index] ? [documentProblems[index]] : [])];
  };

  const rowsOf = (section: AppSection): ReviewStep["rows"] => {
    const rows: ReviewStep["rows"] = [];
    if (section.fields.some((field) => field.name === "academic_upload")) {
      submittedQualifications(qualifications, values).forEach((item, index) =>
        rows.push({ key: `academic-${index}`, label: `Qualification ${index + 1}`, value: [qualificationTitle(item), qualificationDetail(item)].filter(Boolean).join(" · ") }));
    }
    for (const field of section.fields) {
      if (NOT_SHOWN_TYPES.has(field.type) || NOT_SHOWN_FIELDS.has(field.name) || !isConditionMet(field.showIf, flat)) continue;
      const value = field.name === "courses_of_interest" ? courses.join("; ") : val(field.name);
      if (value) rows.push({ key: field.name, label: field.label, value, note: expiryNote(field.name, values) });
    }
    return rows;
  };

  const stepOf = (index: number): ReviewStep => ({ index, title: stepTitle(sections[index].title, index), issues: issuesOf(index), rows: rowsOf(sections[index]) });
  const groups = stages
    .map((stage) => ({ key: stage.id, title: stage.title, steps: stage.sections.filter((index) => isConditionMet(sections[index]?.showIf, flat)).map(stepOf) }))
    .filter((group) => group.steps.length > 0);
  // Every missing or invalid item in form order of the stages, each pointing at its field (found by its label on that step).
  const issues: ReviewIssue[] = groups.flatMap((group) => group.steps.flatMap((step) => step.issues.map((text, n) => {
    const field = sections[step.index].fields.find((candidate) => candidate.label === text) ?? (fieldProblems[step.index] ?? []).filter((problem) => problem.text === text).map((problem) => ({ name: problem.field }))[0];
    const documentField = sections[step.index].fields.find((candidate) => candidate.type === "file")?.name;
    return { key: `${step.index}-${n}`, step: step.title, text, onJump: () => onJumpToField(step.index, field?.name ?? documentField) };
  })));

  if (tiles) {
    const steps = groups.flatMap((group) => group.steps);
    const done = steps.filter((step) => step.issues.length === 0).length;
    return (
      <div>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm text-foreground-600">Check each part. Press Edit on a card to change it.</p>
          <p className="text-sm text-foreground-600"><b className="font-semibold text-foreground-950">{done} of {steps.length}</b> complete</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2" data-testid="application-cards">
          {steps.map((step) => {
            const ok = step.issues.length === 0;
            return (
              <section key={step.index} className={`flex min-w-0 flex-col rounded-xl border bg-background-50 p-4 ${ok ? "border-background-200" : "border-amber-300"}`} data-testid="application-card">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="flex min-w-0 items-center gap-1.5 font-heading text-sm font-semibold text-foreground-950">
                    {ok ? <i className="ri-checkbox-circle-fill text-base text-emerald-600" aria-label="complete" />
                      : <i className="ri-error-warning-fill text-base text-amber-500" aria-label="needs details" />}
                    <span className="truncate">{step.title}</span>
                  </h3>
                  {readOnly ? null : (
                    <button type="button" onClick={() => onEditSection(step.index)} className="inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-background-300 px-2.5 text-xs font-semibold text-foreground-700 hover:border-primary-300 hover:text-primary-700">
                      <i className="ri-pencil-line" aria-hidden="true" />Edit
                    </button>
                  )}
                </div>
                {step.rows.length ? (
                  <dl className="mt-3 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5 text-xs">
                    {step.rows.map((row) => (
                      <div key={row.key} className="contents">
                        <dt className="truncate text-foreground-500" title={row.label}>{row.label}</dt>
                        <dd className="break-words font-medium text-foreground-900">{row.value}{row.note}</dd>
                      </div>
                    ))}
                  </dl>
                ) : <p className="mt-3 text-xs text-foreground-500">Nothing entered yet.</p>}
                {step.issues.length ? (
                  <ul className="mt-3 space-y-0.5 border-t border-amber-100 pt-2">
                    {step.issues.map((text) => (
                      <li key={text}>
                        <button type="button" onClick={() => onJumpToField(step.index, sections[step.index].fields.find((f) => f.label === text)?.name)}
                          className="cursor-pointer text-left text-xs text-amber-900 underline-offset-2 hover:underline">{text}</button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <ReviewSummary groups={groups} issues={issues} meta={[application.reference || "Draft", agencyName, agentName].filter(Boolean).join(" · ")} readOnly={readOnly} onEdit={onEditSection}
      hideSteps={onePage} title={onePage ? (canSubmit ? (studentSigns ? "Check, sign and submit" : "Check and send to the student") : "Your changes save by themselves") : undefined}>

      {readOnly ? (
        <div className="mt-4 text-xs text-foreground-600">
          {application.consents.length === 0 ? (
            <p>No consent record stored.</p>
          ) : (
            <ul className="space-y-1">
              {application.consents.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <i className="ri-shield-check-line text-base leading-none text-foreground-500" aria-hidden="true" />
                  Consent: <strong className="font-medium text-foreground-900">{c.method || "—"}</strong>
                  {c.signedDocumentRef ? <span>&middot; Document: {c.signedDocumentRef}</span> : null}
                  <span>&middot; Recorded by {c.recordedByName || "—"}</span>
                  <span>&middot; v{c.declarationVersion || "1.0"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : canSubmit && studentSigns ? (
        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm font-semibold text-foreground-900">Read and sign</legend>
          <DeclarationTicks who="student" onChange={(declarations, complete) => onConsentChange({ declarations, complete })} />
          <DrawSignature onChange={(signature) => onConsentChange({ signature })} />
          <SignPasswordFields applicationId={application.id} onChange={(password) => onConsentChange({ password })} />
          <p className="text-xs text-foreground-500">Your signature is recorded with the exact text above, the date and time, and this device. If you are under 18, a parent or guardian signs next.</p>
        </fieldset>
      ) : canSubmit ? (
        <p className="mt-4 rounded-lg border border-sky-200 bg-sky-50/60 p-3 text-sm text-sky-950" data-testid="review-student-signs">
          <i className="ri-quill-pen-line" aria-hidden="true" /> Only the student can sign{resubmit ? " and resubmit" : ""}: send it to them to review and sign
          (with a parent or guardian if they are under 18). It is view-only for you while they have it.
        </p>
      ) : resubmit ? (
        <p className="mt-4 text-xs text-foreground-600" data-testid="resubmit-hint">
          Fix what was asked, then press Resubmit application: it goes back to Submitted and SLIT admissions reviews it again.
        </p>
      ) : (
        <p className="mt-4 text-xs text-foreground-600">
          {onePage ? "Your changes are saved on this application as you type; each change after submission is recorded with your name."
            : "Your corrections are saved on this application. SLIT administration reviews them and moves the application on."}
        </p>
      )}

      {submitError ? <p className="mt-3 text-sm text-red-700" role="alert">{submitError}</p> : null}
    </ReviewSummary>
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
    <span className={`ml-1.5 text-2xs font-semibold ${expiryTone(expiry.status)}`} title={expiryTooltip(expiry)}>
      {expiryLabel(expiry)}
    </span>
  );
}
