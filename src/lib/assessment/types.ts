/**
 * Assessment Management: the data-driven form engine's contract (runtime-neutral, no React).
 *
 * A published version stores one `Definition` (tasks > sections > questions > children) as JSON in `asm_versions.definition`.
 * Responses are one object keyed by question id (`Responses`); a repeating group holds an array of such objects, a case study an
 * object keyed by its children's ids. Assessor-only data (model answers, answer keys, guidance) is NEVER part of a definition: it
 * lives in `asm_question_keys` (`QuestionKey`) and only reaches assessors. The database refuses a definition that carries any of the
 * keys in FORBIDDEN_DEFINITION_KEYS (migration 20261113430000, `asm_jsonb_forbidden_key`).
 */

export type MarkingMode = "none" | "auto" | "criteria" | "rubric" | "observation";
export type Outcome = "S" | "NYS";
export type UnitOutcome = "C" | "NYC";

export type ConditionOp = "eq" | "neq" | "in" | "notIn" | "gt" | "gte" | "lt" | "lte" | "contains" | "empty" | "notEmpty";
export type Condition =
  | { questionId: string; op: ConditionOp; value?: unknown }
  | { all: Condition[] }
  | { any: Condition[] };

/** The JSON-schema subset the database validates with (`asm_schema_check`). */
export interface ResponseSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  enum?: unknown[];
  items?: ResponseSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  minWords?: number;
  maxWords?: number;
  minimum?: number;
  maximum?: number;
  format?: "date" | "time" | "url" | "email";
  properties?: Record<string, ResponseSchema>;
  requiredKeys?: string[];
  minFiles?: number;
  maxFiles?: number;
}

export interface Criterion { id: string; text: string }
export interface RubricLevel { id: string; label: string; score: number; description?: string }
export interface Rubric { levels: RubricLevel[] }

export interface Question {
  id: string;
  type: string;
  label: string;
  helpText?: string;
  required?: boolean;
  /** Completed by the assessor, never by the student (observation checklist, third-party report). */
  assessorOnly?: boolean;
  markingMode?: MarkingMode;
  /** Type-specific settings (options, rows, columns, limits, scale…); see the registry's `defaultConfig`. */
  config?: Record<string, unknown>;
  responseSchema?: ResponseSchema;
  criteria?: Criterion[];
  rubric?: Rubric;
  showIf?: Condition;
  /** Case study and repeating group hold nested questions. */
  children?: Question[];
}

export interface Section { id: string; title: string; description?: string; showIf?: Condition; questions: Question[] }
export interface Task { id: string; title: string; instructions?: string; sections: Section[] }
export interface Definition { instructions?: string; tasks: Task[] }

export type Responses = Record<string, unknown>;

/** Assessor-only data for one question of one version. */
export interface QuestionKey {
  questionId: string;
  modelAnswer?: string | null;
  answerKey?: unknown;
  assessorGuidance?: string | null;
  rubricLevels?: unknown;
}

export interface UnitMapping { questionId: string; criterionId?: string | null; elementId: string }

export const FORBIDDEN_DEFINITION_KEYS = ["key", "answerKey", "modelAnswer", "assessorGuidance", "assessorNotes", "rubricAssessor"] as const;

export interface ValidationError { questionId: string; code: string; message: string }

/** Attempt and assignment shapes as the RPCs return them (camelCase). */
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
