/**
 * ASM-PDF-TEMPLATE phase 3: what prints in each field of the workbook for one attempt, from the locked snapshot of the student's
 * submission and the trainer's marks (pure; the stamping is stamp.ts).
 *
 *  - the student's answers, declarations and record values: from the attempt's snapshot (never from the live draft);
 *  - each question's Satisfactory Yes / No and the Performance Outcome rows: the question's mark;
 *  - the written evidence rows: Yes when the student answered the question, unless the trainer changed it;
 *  - the results sheet and the summary sheet: each attempt column from that attempt (task results, date, feedback, the outcome,
 *    the assessor's sign-off and the student's acknowledgement);
 *  - every other trainer field (Evidence Outcome rows, Appendix A, office use…): what the trainer filled in.
 */
import type { PdfTemplate, TemplateField } from "./model";
import { isFilled, reviewName } from "./student";

export interface PdfSig { signerName: string; signaturePng: string | null; signedAt: string; statement?: string }
export interface Snapshot { answers: { pdf?: Record<string, string>; pdfChoice?: Record<string, string> }; signatures: Record<string, PdfSig>; record: SnapshotRecord; hash: string; createdAt?: string }
export interface SnapshotRecord { studentName?: string; studentRef?: string; studentEmail?: string; trainers?: string[]; unitCode?: string; unitName?: string; qualificationCode?: string; qualificationName?: string; attemptNo?: number; startedAt?: string; submittedAt?: string }
export interface BundleResult { questionId: string; criterionId?: string | null; outcome: "S" | "NYS" | null; feedback?: string }
export interface BundleTask { taskId: string; outcome: "S" | "NYS" | null; feedback?: string; signedAt?: string | null }
export interface BundleAttempt {
  id: string; attemptNo: number; state: string; submittedAt?: string | null; returnedAt?: string | null; finalisedAt?: string | null;
  outcome?: "S" | "NYS" | null; overallFeedback?: string; rowVersion?: number;
  results: BundleResult[]; taskResults: BundleTask[]; assessorResponses?: { pdf?: Record<string, string>; pdfChoice?: Record<string, string>; [k: string]: unknown };
  snapshot: Snapshot | null; signoff: PdfSig | null; acknowledgement: PdfSig | null; output: { path: string; pdfSha256: string; snapshotHash: string; createdAt: string } | null;
}
export interface PdfBundle { attemptId: string; attemptNo: number; role: "trainer" | "student"; canAssess: boolean; template: PdfTemplate; attempts: BundleAttempt[] }

export type StampValue = { kind: "text"; text: string; by: "student" | "trainer" | "record" } | { kind: "tick"; by: "student" | "trainer" | "record" } | { kind: "png"; png: string; name: string; by: "student" | "trainer" };

export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Australia/Melbourne" });
};

const resultOf = (a: BundleAttempt | undefined, key: string | null | undefined) => key ? a?.results.find((r) => r.questionId === key && !r.criterionId)?.outcome ?? null : null;
const taskOf = (a: BundleAttempt | undefined, task: number | null | undefined) => task == null ? undefined : a?.taskResults.find((t) => t.taskId === String(task));
const tick = (by: "student" | "trainer" | "record"): StampValue => ({ kind: "tick", by });
const text = (t: string | null | undefined, by: "student" | "trainer" | "record"): StampValue | null => (t && t.trim() ? { kind: "text", text: t, by } : null);

/**
 * What must be answered before an attempt's result is released (the same rules and words as public.asm_template_marking_missing):
 * every question marked Yes or No (the Performance Outcome rows of the marking checklists follow these marks), and every checklist
 * row the trainer ticks (Evidence Outcome rows; Performance rows that name activities rather than questions). Each attempt on its own.
 */
export function markingMissing(t: PdfTemplate, results: { questionId: string; outcome: "S" | "NYS" | null }[], choice: Record<string, string>): string[] {
  const out: string[] = [];
  for (const q of t.questions) if (!results.find((r) => r.questionId === q.key)?.outcome) out.push(`${reviewName(t, q)} is not marked yet.`);
  const seen = new Set<string>();
  for (const f of [...t.fields].sort((a, b) => a.page - b.page || a.y - b.y)) {
    if (f.role !== "trainer" || f.kind !== "yes_no" || !f.group || seen.has(f.group)) continue;
    const ticked = f.checklist === "evidence" || (f.checklist === "performance" && !f.questionKey);
    if (!ticked) continue;
    seen.add(f.group);
    if (!choice[f.group]) out.push(`Marking checklist, page ${f.page}: "${f.label}" has no Yes / No.`);
  }
  return out;
}

/** Did the student answer this question in the snapshot (any of their fields filled)? */
export function answered(t: PdfTemplate, snap: Snapshot | null, key: string): boolean {
  if (!snap) return false;
  return t.fields.some((f) => f.role === "student" && f.questionKey === key && (f.group && (f.kind === "yes_no" || f.kind === "rating") ? snap.answers.pdfChoice?.[f.group] === f.option : isFilled(snap.answers.pdf?.[f.id])));
}

/**
 * The value of every field for attempt `attemptNo` (default: the bundle's attempt). trainer: false leaves out the trainer's marks
 * (an attempt submitted but not released to the student).
 */
export function stampValues(b: PdfBundle, opts: { attemptNo?: number; trainer?: boolean } = {}): Map<string, StampValue> {
  const t = b.template;
  const n = opts.attemptNo ?? b.attemptNo;
  const withTrainer = opts.trainer ?? true;
  const byNo = (k: number | null | undefined) => b.attempts.find((a) => a.attemptNo === (k ?? n));
  const cur = byNo(n);
  const snap = cur?.snapshot ?? null;
  const rec = snap?.record ?? {};
  const out = new Map<string, StampValue>();
  const kindOf = (page: number) => t.pages[page - 1]?.kind;
  const decided = [...b.attempts].filter((a) => a.attemptNo <= n && (a.state === "returned" || a.state === "final")).pop();
  const sigOf = (slot: string | null | undefined, attempt: number | null | undefined): PdfSig | null => {
    if (!slot) return null;
    if (slot === "ack") return byNo(attempt)?.acknowledgement ?? null;
    if (slot === "signoff") return withTrainer ? byNo(attempt)?.signoff ?? null : null;
    return snap?.signatures?.[slot] ?? null;
  };
  for (const f of t.fields) {
    let v: StampValue | null = null;
    if (f.kind === "signature") {
      // every signature line shows its own signature: the student's declaration / pack / acknowledgement, the assessor's sign-off
      const by = f.role === "student" ? "student" : "trainer";
      const s = sigOf(f.slot ?? (by === "student" ? "pack" : "signoff"), f.attempt);
      v = s ? (s.signaturePng ? { kind: "png", png: s.signaturePng, name: s.signerName, by } : text(s.signerName, by)) : null;
    } else if (f.role === "student") {
      if (f.step === "acknowledge") v = null;
      else if ((f.kind === "yes_no" || f.kind === "rating") && f.group) v = snap?.answers.pdfChoice?.[f.group] === f.option ? tick("student") : null;
      else if (f.kind === "checkbox") v = snap?.answers.pdf?.[f.id] === "true" ? tick("student") : null;
      else v = text(snap?.answers.pdf?.[f.id], "student");
    } else if (f.role === "auto") {
      v = autoValue(f, rec, cur, sigOf);
    } else if (withTrainer) {
      v = trainerValue(t, f, cur, byNo, decided, snap, kindOf(f.page));
    }
    if (v) out.set(f.id, v);
  }
  return out;
}

function autoValue(f: TemplateField, rec: SnapshotRecord, cur: BundleAttempt | undefined, sigOf: (slot: string | null | undefined, attempt: number | null | undefined) => PdfSig | null): StampValue | null {
  switch (f.dataKey) {
    case "student_name": return text(rec.studentName, "record");
    case "student_id": return text(rec.studentRef, "record");
    case "student_email": return text(rec.studentEmail, "record");
    case "trainer_name": return text(cur?.signoff?.signerName ?? (rec.trainers ?? []).join(", "), "record");
    case "unit_code": return text(rec.unitCode, "record");
    case "unit_name": return text(rec.unitName, "record");
    case "unit_code_name": return text(`${rec.unitCode ?? ""} ${rec.unitName ?? ""}`.trim(), "record");
    case "qualification_code": return text(rec.qualificationCode, "record");
    case "qualification_name": return text(rec.qualificationName, "record");
    case "start_date": return text(fmtDate(rec.startedAt), "record");
    case "end_date": case "submission_date": return text(fmtDate(rec.submittedAt), "record");
    case "signoff_date": return text(fmtDate(cur?.signoff?.signedAt), "record");
    case "acknowledged_date": return text(fmtDate(cur?.acknowledgement?.signedAt), "record");
    case "signed_date": return text(fmtDate(sigOf(f.slot, f.attempt)?.signedAt), "record");
    case "today": return text(fmtDate(new Date().toISOString()), "record");
    case "submission_method": return f.option === "lms" ? tick("record") : null;
    default: return null;
  }
}

function trainerValue(t: PdfTemplate, f: TemplateField, cur: BundleAttempt | undefined, byNo: (k: number | null | undefined) => BundleAttempt | undefined,
  decided: BundleAttempt | undefined, snap: Snapshot | null, pageKind: string | undefined): StampValue | null {
  const choice = cur?.assessorResponses?.pdfChoice ?? {};
  const own = cur?.assessorResponses?.pdf ?? {};
  const pick = (yes: boolean | null) => (yes === null ? null : (f.option === "yes") === yes ? tick("trainer") : null);
  const sOf = (o: "S" | "NYS" | null | undefined) => (o == null ? null : o === "S");
  const page = t.pages[f.page - 1];
  // the question's own Satisfactory Yes / No and its Performance Outcome row
  if (f.kind === "yes_no" && f.group?.startsWith("q.")) return pick(sOf(resultOf(cur, f.questionKey ?? f.group.slice(2))));
  if (f.checklist === "performance" && f.questionKey) return pick(sOf(resultOf(cur, f.questionKey)));
  if (f.checklist === "written" && f.questionKey && f.group) return choice[f.group] ? (choice[f.group] === f.option ? tick("trainer") : null) : pick(answered(t, snap, f.questionKey));
  if (pageKind === "results_sheet") {
    const r = taskOf(byNo(f.attempt), page?.task);
    if (f.kind === "yes_no") return pick(sOf(r?.outcome));
    if (f.kind === "date") return text(fmtDate(r?.signedAt), "trainer");
    if (f.kind === "text") return text(r?.feedback, "trainer");
  }
  if (pageKind === "summary") {
    const a = byNo(f.attempt);
    const task = /Task\s*-?\s*(\d+)/i.exec(f.label)?.[1];
    if (f.kind === "yes_no") return task ? pick(sOf(taskOf(a, Number(task))?.outcome)) : /final|competent|result/i.test(f.label) ? pick(sOf(a && (a.state === "returned" || a.state === "final") ? a.outcome : null)) : null;
    if (f.kind === "date" && task) return text(fmtDate(taskOf(a, Number(task))?.signedAt), "trainer");
    if (f.kind === "text" && f.attempt == null && /feedback/i.test(f.label)) return text(decided?.overallFeedback, "trainer");
  }
  if ((f.kind === "yes_no" || f.kind === "rating") && f.group) return choice[f.group] === f.option ? tick("trainer") : null;
  if (f.kind === "checkbox") return own[f.id] === "true" ? tick("trainer") : null;
  return text(own[f.id], "trainer");
}
