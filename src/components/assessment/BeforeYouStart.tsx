/**
 * ASM-WORKBOOK item 1: the information (compliance) pages the student reads before starting: submission, plagiarism and collusion,
 * outcomes, reassessment, appeals and the declaration. The student's assessment page shows it with its start button; the wizard's
 * Student view shows the same panel, so the admin reviews exactly what the student reads.
 */
import type { ReactNode } from "react";
import { AssessmentInfo } from "./AssessmentRenderer";

export default function BeforeYouStart({ instructions, action }: { instructions: string; action: ReactNode }) {
  return (
    <div className="mt-5 space-y-4" data-testid="before-you-start">
      <h2 className="font-heading text-lg font-bold text-foreground-950">Before you start</h2>
      <p className="text-sm text-foreground-700">Read how this assessment works: submission, plagiarism and collusion, outcomes, reassessment, appeals and the declaration you will sign.</p>
      <AssessmentInfo text={instructions} />
      {action}
    </div>
  );
}
