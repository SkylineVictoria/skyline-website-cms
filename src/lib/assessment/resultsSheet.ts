/**
 * ASM-WORKBOOK item 6: the workbook's "Assessment Task N – Results Sheet" built from the attempts (runtime-neutral, no React).
 * One row per task, one column per attempt (the attempts allowed, at least three, more when an administrator opened extra ones):
 * Satisfactory / Not Satisfactory, the date it was decided, the assessor and the feedback. Used by the marking page, the student's
 * page, the admin attempt drawer and "Export as workbook PDF".
 */
import type { Attempt, AttemptState, Definition, Outcome } from "./types";

export interface HistoryTask { taskId: string; outcome: Outcome | null; feedback: string; signedAt: string | null; assessor: string | null }
export interface HistoryAttempt {
  id: string; attemptNo: number; state: AttemptState;
  submittedAt: string | null; returnedAt: string | null; finalisedAt: string | null;
  receiptNo?: string | null; declarationName?: string | null;
  outcome: Outcome | null; overallFeedback: string; assessor: string | null; tasks: HistoryTask[];
}
export interface AttemptHistory {
  /** ref: what the forms print as Student ID: the student number when Skyline has one (number), else the first 8 characters of the record. */
  student: { id: string; ref: string; number?: string | null; name: string; email?: string | null } | null;
  trainers: string[];
  assessment: { title: string; code?: string | null; versionNo?: number | null; unit?: { code: string; name: string } | null; qualification?: { code: string; name: string } | null } | null;
  attempts: HistoryAttempt[];
  /** false: built from the attempt(s) on screen only (asm_attempt_history not released yet): no assessor names, maybe no earlier attempts. */
  complete: boolean;
}

/** S / NS as the workbook prints them. */
export type SheetResult = "S" | "NS";
export interface SheetCell {
  attemptNo: number;
  /** Set when the attempt has one for this task. */
  result: SheetResult | null;
  /** The attempt was returned or finalised: the result is the assessor's decision (else marks in progress, or nothing yet). */
  decided: boolean;
  date: string | null;
  assessor: string | null;
  feedback: string;
  /** No such attempt (yet). */
  empty: boolean;
}
export interface SheetRow { taskId: string; number: number; title: string; cells: SheetCell[] }
export interface ResultsSheet { rows: SheetRow[]; overall: SheetCell[]; attemptsShown: number }

const DECIDED: AttemptState[] = ["returned", "final"];
const toResult = (o: Outcome | null | undefined): SheetResult | null => (o === "S" ? "S" : o === "NYS" ? "NS" : null);

export function buildResultsSheet(definition: Definition, history: AttemptHistory, maxAttempts = 3): ResultsSheet {
  const attempts = history.attempts.filter((a) => a.state !== "void").slice().sort((a, b) => a.attemptNo - b.attemptNo);
  const attemptsShown = Math.max(3, maxAttempts, ...attempts.map((a) => a.attemptNo));
  const byNo = new Map(attempts.map((a) => [a.attemptNo, a]));
  const cell = (no: number, pick: (a: HistoryAttempt) => { outcome: Outcome | null; feedback: string; signedAt: string | null; assessor: string | null } | null): SheetCell => {
    const a = byNo.get(no);
    if (!a) return { attemptNo: no, result: null, decided: false, date: null, assessor: null, feedback: "", empty: true };
    const p = pick(a);
    const decided = DECIDED.includes(a.state);
    return {
      attemptNo: no, result: toResult(p?.outcome), decided,
      date: decided ? a.returnedAt ?? a.finalisedAt ?? p?.signedAt ?? null : p?.signedAt ?? null,
      assessor: p?.assessor ?? a.assessor ?? null, feedback: p?.feedback ?? "", empty: false,
    };
  };
  const nums = Array.from({ length: attemptsShown }, (_, i) => i + 1);
  const rows = definition.tasks.map((t, ti) => ({
    taskId: t.id, number: ti + 1, title: t.title,
    cells: nums.map((no) => cell(no, (a) => { const r = a.tasks.find((x) => x.taskId === t.id); return r ? { outcome: r.outcome, feedback: r.feedback, signedAt: r.signedAt, assessor: r.assessor } : null; })),
  }));
  const overall = nums.map((no) => cell(no, (a) => ({ outcome: a.outcome, feedback: a.overallFeedback, signedAt: a.returnedAt ?? a.finalisedAt, assessor: a.assessor })));
  return { rows, overall, attemptsShown };
}

/** A history from the attempts already loaded on the page (before asm_attempt_history is released): no names, no cover details. */
export function historyFromAttempts(attempts: Attempt[], extra: { studentName?: string | null } = {}): AttemptHistory {
  return {
    student: attempts[0] ? { id: attempts[0].studentId, ref: attempts[0].studentId.slice(0, 8).toUpperCase(), name: extra.studentName ?? "" } : null,
    trainers: [], assessment: null, complete: false,
    attempts: attempts.map((a) => ({
      id: a.id, attemptNo: a.attemptNo, state: a.state, submittedAt: a.submittedAt, returnedAt: a.returnedAt, finalisedAt: a.finalisedAt,
      receiptNo: a.receiptNo, declarationName: typeof a.declaration?.signature === "string" ? a.declaration.signature : null,
      outcome: a.outcome, overallFeedback: a.overallFeedback ?? "", assessor: null,
      tasks: (a.taskResults ?? []).map((t) => ({ taskId: t.taskId, outcome: t.outcome, feedback: t.feedback, signedAt: t.signedAt, assessor: null })),
    })),
  };
}

export const SHEET_LABEL: Record<SheetResult, string> = { S: "Satisfactory", NS: "Not Satisfactory" };
