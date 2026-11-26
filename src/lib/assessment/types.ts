/**
 * Assessment Management: the attempt, its results and the unit mapping as the RPCs return them (runtime-neutral, no React).
 * Since ASM-PDF-TEMPLATE phase 4 (2026-11-26) an assessment is its workbook PDF template (src/lib/assessment/pdfTemplate/model.ts):
 * responses are { pdf: { fieldId: text }, pdfChoice: { group: option } }, questions are keyed by their printed numbers (task.number).
 */

export type Outcome = "S" | "NYS";
export type UnitOutcome = "C" | "NYC";
export type Responses = Record<string, unknown>;
/** One mapping row: a workbook question (its printed number, task.number) gives evidence for a unit element / criterion. */
export interface UnitMapping { questionId: string; criterionId?: string | null; elementId: string }
/** A submit or release refusal: what is missing, named as printed (questionKey: the workbook question it concerns). */
export interface ValidationError { questionId?: string; questionKey?: string; code: string; message: string }

export type AttemptState = "draft" | "submitted" | "marking" | "returned" | "final" | "void";
export interface EvidenceFile { id: string; questionId: string; groupIndex: number | null; byAssessor: boolean; path: string; fileName: string; mime: string; bytes: number; createdAt: string }
export interface ResultRow { questionId: string; criterionId: string | null; suggestedOutcome: Outcome | null; outcome: Outcome | null; score: number | null; rubricLevelId: string | null; feedback: string; markedAt: string | null }
export interface TaskResultRow { taskId: string; rollupSuggested: Outcome | null; outcome: Outcome | null; feedback: string; signedAt: string | null }
export interface FeedbackRow { id: string; questionId: string | null; role: "admin" | "trainer" | "student"; body: string; createdAt: string }
export interface ReassessmentRow { id: string; role: string; reason: string; state: "requested" | "opened" | "declined"; newDueAt: string | null; nextAttemptId: string | null; createdAt: string }
export interface Attempt {
  id: string; assignmentId: string; versionId: string; studentId: string; attemptNo: number; state: AttemptState;
  responses: Responses; assessorResponses: Responses; responsesHash: string | null; declaration: Record<string, unknown> | null; receiptNo: string | null;
  dueAt: string | null; outcome: Outcome | null; overallFeedback: string; startedAt: string; submittedAt: string | null; returnedAt: string | null; finalisedAt: string | null; acknowledgedAt?: string | null; rowVersion: number;
  evidence: EvidenceFile[]; results: ResultRow[]; taskResults: TaskResultRow[]; feedback: FeedbackRow[]; reassessments: ReassessmentRow[];
}
