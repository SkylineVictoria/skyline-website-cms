/** Assessment Management in the CMS: shapes the `asm_admin` RPC returns (camelCase) and small helpers. */
import { asmAdmin } from "@/lib/assessment/api";
import type { Definition, QuestionKey, UnitMapping } from "@/lib/assessment/types";

export { asmAdmin };

export interface AssessmentRow {
  id: string; courseId: string; courseName: string; unitId: string | null; unitCode: string | null; unitName: string | null; code: string | null; title: string; description: string;
  isTemplate: boolean; archivedAt: string | null; updatedAt: string; currentVersionNo: number | null; currentVersionStatus: string | null; hasDraft: boolean; assignments: number;
}
export interface UnitElement { id: string; kind: string; parentId: string | null; code: string; text: string; sort: number; isActive?: boolean }
export interface VersionSummary { id: string; versionNo: number; status: "draft" | "published" | "retired"; publishedAt: string | null; checksum: string | null; createdAt: string; assignments: number; attempts: number }
export interface AssignmentRow {
  id: string; assessmentId: string; versionId: string; batchId: string; batchName: string; intakeId: string; intake: string; courseId: string; courseName: string; assessmentTitle: string; assessmentCode: string | null;
  unitId: string | null; unitCode: string | null; unitName: string | null; versionNo: number; availableFrom: string; dueAt: string; lateUntil: string | null; status: "open" | "closed" | "cancelled";
  reassignRule: "follow_batch" | "keep"; notes: string; trainers: { staffId: string; name: string; source: "batch" | "assignment" }[];
  events: { id: string; kind: string; title: string; startsAt: string; endsAt: string | null; roomId: string | null; trainerStaffId: string | null; notes: string }[]; eligibleCount: number;
  toMark?: number; submitted?: number; final?: number;
}
export interface AssessmentDetail {
  id: string; courseId: string; unitId: string | null; code: string | null; title: string; description: string; isTemplate: boolean; settingsOverride: Record<string, unknown>; archivedAt: string | null;
  currentVersionId: string | null; updatedAt: string; effectiveSettings: Record<string, unknown>;
  editing: { versionId: string; versionNo: number; status: string; definition: Definition; updatedAt: string; keys: QuestionKey[]; mappings: UnitMapping[] } | null;
  versions: VersionSummary[]; elements: UnitElement[]; assignments: AssignmentRow[];
}
export interface AttemptChip { id: string; attemptNo: number; state: string; outcome: string | null; submittedAt: string | null; dueAt: string | null; receiptNo?: string | null }
export interface AssignmentStudent { studentId: string; name: string; email: string; dueAt: string; excluded: boolean; addedManually: boolean; note: string; attempts: AttemptChip[] }
export interface PendingRow { attemptId: string; assignmentId: string; studentId: string; studentName: string; attemptNo: number; state: string; submittedAt: string; assessmentTitle: string; batchName: string; unitCode?: string | null; receiptNo?: string | null; dueAt?: string | null }
export interface Overview { assignments: number; eligible: number; notStarted: number; draft: number; submitted: number; returned: number; final: number; overdue: number; reassessmentsOpen: number; pendingMarking: PendingRow[] }
export interface StaffOption { id: string; name: string; email: string; isTrainer: boolean }
export interface BatchOption { id: string; name: string; intakeId: string; intake: string; courseId: string; courseName: string; students: number; isActive: boolean }
export interface Settings {
  id: string; tenant_id: string | null; max_attempts: number; reassessment_days: number; late_submission: "allow" | "block"; rollup_rule: "all_satisfactory" | "assessor_only"; due_soon_days: number;
  declaration_text: string; instructions: string; evidence_max_mb: number; evidence_allowed_types: string[]; require_trainer_role: boolean;
}
export interface OutcomeRow { id: string; studentId: string; studentName: string; unitId: string; unitCode: string; unitName: string; assessmentId: string | null; batchId: string | null; outcome: "C" | "NYC"; signedName: string; signedRole: string; signedAt: string; notes: string; supersedesId: string | null; current: boolean }
export interface AuditRow { id: number; actor: string | null; role: string; action: string; targetType: string; targetId: string; detail: Record<string, unknown>; at: string }
export interface BankRow { id: string; title: string; tags: string[]; type: string; unitId: string | null; courseId: string | null; versionNo: number; updatedAt: string }
export interface Coverage { versionId: string; unitId: string | null; elements: (UnitElement & { mapped: { questionId: string; criterionId: string | null }[] })[]; gaps: UnitElement[]; unmappedQuestions: string[] }

export const ELEMENT_KINDS: { id: string; label: string; short: string }[] = [
  { id: "element", label: "Element", short: "E" }, { id: "performance_criterion", label: "Performance criterion", short: "PC" },
  { id: "performance_evidence", label: "Performance evidence", short: "PE" }, { id: "knowledge_evidence", label: "Knowledge evidence", short: "KE" },
  { id: "assessment_condition", label: "Assessment condition", short: "AC" }, { id: "foundation_skill", label: "Foundation skill", short: "FS" },
];
export const kindShort = (k: string) => ELEMENT_KINDS.find((x) => x.id === k)?.short ?? k;

/** Rows to a CSV download (the reports tab). */
export function downloadCsv(name: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
export function downloadJson(name: string, value: unknown) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
