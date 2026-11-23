/**
 * ASM-WORKBOOK item 3: the workbook's "1. Student and trainer details" and "2. Qualification and unit of competency", filled in by
 * the system on the student's assessment page (never typed by the student). The rows and the rule for where each value comes from
 * are the shared layout's (workbookDetails / detailRows / qualificationRows), so the page, the wizard's Review step and "Export as
 * workbook PDF" show the same. From asm_attempt_history when the database has it, else from what the page knows (the workbook's
 * qualification / unit, the assignment's unit).
 */
import type { AttemptHistory } from "@/lib/assessment/resultsSheet";
import type { Definition } from "@/lib/assessment/types";
import { workbookDetails } from "@/lib/assessment/workbookLayout";
import { DetailsTables } from "./WorkbookTables";

export default function AssessmentDetails({ history, definition, unit, preview = false }: {
  history: AttemptHistory | null;
  definition: Definition;
  /** The assignment's unit (assessment_open), when the history has none. */
  unit?: { code: string | null; name: string | null } | null;
  /** The wizard's Student view: no student yet, so the empty values say they are filled in for each student. */
  preview?: boolean;
}) {
  const details = workbookDetails({ history, definition, unit });
  return (
    <section className="mt-4 rounded-card border border-background-200 bg-background-50 p-4" aria-labelledby="asm-details-title" data-testid="assessment-details">
      <h2 id="asm-details-title" className="mb-3 font-heading text-base font-semibold text-foreground-950">Student, trainer and unit details</h2>
      <DetailsTables details={details} placeholder={preview ? "Filled in for each student" : "—"} />
      <p className="mt-2 text-xs text-foreground-500">{preview ? "Filled in by Skyline from the student's enrolment and the intake's trainers; the student cannot change them." : "Filled in from your enrolment. Tell your trainer if anything is wrong."}</p>
    </section>
  );
}
