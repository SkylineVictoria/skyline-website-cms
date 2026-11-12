import type { AppField, AppSection } from "@/data/applicationForms";
import { isConditionMet, sectionHeading } from "@/components/feature/applicationFieldHelpers";
import { stepTitle } from "@/components/shared/application-form/stepTitle";
import ReviewSummary, { type ReviewIssue, type ReviewStep } from "@/components/shared/application-form/ReviewSummary";
import type { Stage } from "@/pages/agency/lib/applicationStages";
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
  file: null | File;
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


  return (
    <ReviewSummary groups={groups} issues={issues} meta={[application.reference || "Draft", agencyName, agentName].filter(Boolean).join(" · ")} readOnly={readOnly} onEdit={onEditSection}>

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
      ) : canSubmit ? (
        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">Declaration</legend>
          <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground-700">
            <input type="checkbox" checked={consent.confirmed} onChange={(event) => onConsentChange({ confirmed: event.target.checked })} className="mt-0.5 h-4 w-4 accent-primary-500" />
            <span className="leading-snug">I confirm the student has reviewed this application and authorised its submission. The student&rsquo;s own declaration and signature are recorded in the form.</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground-700">
            <input type="checkbox" checked={consent.authorised} onChange={(event) => onConsentChange({ authorised: event.target.checked })} className="mt-0.5 h-4 w-4 accent-primary-500" />
            <span className="leading-snug">I confirm I am the agent handling this application and am authorised to submit it on the student&rsquo;s behalf.</span>
          </label>
          <p className="text-xs text-foreground-500">Prepared by {agentName || "the agency"} &middot; Declaration version 1.0 &middot; Consent recorded against your account.</p>
        </fieldset>
      ) : resubmit ? (
        <p className="mt-4 text-xs text-foreground-600" data-testid="resubmit-hint">
          Fix what was asked, then press Resubmit application: it goes back to Submitted and SLIT admissions reviews it again.
        </p>
      ) : (
        <p className="mt-4 text-xs text-foreground-600">
          Your corrections are saved on this application. SLIT administration reviews them and moves the application on.
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
    <span className={`ml-1.5 text-[10px] font-semibold ${expiryTone(expiry.status)}`} title={expiryTooltip(expiry)}>
      {expiryLabel(expiry)}
    </span>
  );
}
