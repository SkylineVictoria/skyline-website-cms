import { supabase } from "@/pages/admin/lib/supabase";

/**
 * QUALIFICATION (owner, 2026-11-27): a student's course enrolment record (public.intake_enrolments) is shown everywhere as the
 * "Qualification". The database keeps the status values; screens show these labels (same as public.qualification_label).
 */
export type QualificationStatus = "tentative" | "active" | "deferred" | "suspended" | "withdrawn" | "completed";

export const QUALIFICATION_LABELS: Record<QualificationStatus, string> = {
  tentative: "Tentative",
  active: "In Progress",
  deferred: "Deferred",
  suspended: "Suspended",
  withdrawn: "Cancelled",
  completed: "Completed",
};
export const QUALIFICATION_STATUSES = Object.keys(QUALIFICATION_LABELS) as QualificationStatus[];

export const qualificationLabel = (status: string) => QUALIFICATION_LABELS[status as QualificationStatus] ?? status;

const TONES: Record<QualificationStatus, string> = {
  tentative: "border-background-300 bg-background-100 text-foreground-700",
  active: "border-primary-200 bg-primary-50 text-primary-800",
  deferred: "border-amber-200 bg-amber-50 text-amber-800",
  suspended: "border-amber-300 bg-amber-100 text-amber-900",
  withdrawn: "border-red-200 bg-red-50 text-red-800",
  completed: "border-green-200 bg-green-50 text-green-800",
};
export const qualificationTone = (status: string) => TONES[status as QualificationStatus] ?? TONES.tentative;

export interface QualificationRow {
  id: string;
  status: QualificationStatus;
  label: string;
  type: string;
  studentId: string;
  studentName: string | null;
  studentNumber: string | null;
  courseId: string;
  courseCode: string | null;
  courseName: string | null;
  intakeId: string;
  intakeName: string | null;
  startDate: string | null;
  endDate: string | null;
  enrolledOn: string | null;
  resumeDate: string | null;
  withdrawnOn: string | null;
  statusChangedAt: string | null;
  archived: boolean;
  applicationId: string | null;
  applicationReference: string | null;
  coeNumber: string | null;
  voeNumber: string | null;
  openTasks: number;
}

export interface QualificationDocument {
  id: string;
  kind: string;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
  copyState: "copied" | "pending" | "failed";
  sourceBucket: string | null;
  sourcePath: string | null;
  studentVisible: boolean;
  createdAt: string;
}

export interface QualificationTask {
  id: string;
  kind: "place_manually" | "prisms_report" | "refund_check" | "resume_check";
  event: string | null;
  title: string;
  detail: string | null;
  dueOn: string | null;
  status: "open" | "done";
  prismsReference: string | null;
  closedNote: string | null;
  closedAt: string | null;
}

export interface QualificationDetail extends QualificationRow {
  reason: string | null;
  note: string | null;
  studyReason: string | null;
  fundingSource: string | null;
  canChange: boolean;
  canUndo: boolean;
  moves: { status: QualificationStatus; label: string }[];
  reasons: { id: string; status: string; label: string; isOther: boolean }[];
  units: { unitId: string; code: string; name: string; startDate: string | null; endDate: string | null; assessment: string | null; assessmentOn: string | null; avetmissOutcome: string | null; hasResult: boolean }[];
  documents: QualificationDocument[];
  history: { id: string; from: string | null; fromLabel: string; to: string; toLabel: string; reason: string | null; note: string | null; evidenceId: string | null; effectiveOn: string; by: string | null; at: string }[];
  tasks: QualificationTask[];
}

/** What a student or agent sees on an application: status, dates and their documents (no reasons or internal notes). */
export interface PortalQualification {
  id: string;
  status: QualificationStatus;
  label: string;
  courseCode: string | null;
  courseName: string | null;
  intakeName: string | null;
  startDate: string | null;
  endDate: string | null;
  resumeDate: string | null;
  documents: { id: string; kind: string; title: string; fileName: string | null }[];
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const listQualifications = (filter: { status?: string[]; search?: string; studentId?: string; applicationId?: string } = {}) =>
  rpc<QualificationRow[]>("qualification_list", {
    p_status: filter.status?.length ? filter.status : null,
    p_search: filter.search?.trim() || null,
    p_student: filter.studentId ?? null,
    p_application: filter.applicationId ?? null,
  });

export const getQualification = (id: string) => rpc<QualificationDetail>("qualification_get", { p_enrolment: id });

export const setQualificationStatus = (input: { id: string; status: string; reason?: string; note?: string; effectiveOn?: string; resumeDate?: string; evidenceId?: string }) =>
  rpc<QualificationRow>("qualification_set_status", {
    p_enrolment: input.id, p_status: input.status, p_reason: input.reason || null, p_note: input.note || null,
    p_effective_on: input.effectiveOn || null, p_resume_date: input.resumeDate || null, p_evidence: input.evidenceId || null,
  });

export const undoQualification = (id: string, reason: string) => rpc<QualificationRow>("qualification_undo", { p_enrolment: id, p_reason: reason });

export const closeQualificationTask = (id: string, reference: string, note: string) =>
  rpc<void>("qualification_task_close", { p_task: id, p_reference: reference || null, p_note: note || null });

export const portalQualifications = (applicationId: string) => rpc<PortalQualification[]>("portal_qualifications", { p_application: applicationId });

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export async function addQualificationDocument(input: { id: string; kind: string; title: string; file: File; studentVisible: boolean }) {
  const content = toBase64(new Uint8Array(await input.file.arrayBuffer()));
  return rpc<string>("qualification_document_add", {
    p_enrolment: input.id, p_kind: input.kind, p_title: input.title, p_file_name: input.file.name,
    p_mime: input.file.type || "application/octet-stream", p_content: content, p_student_visible: input.studentVisible,
  });
}

/** Opens (downloads) a Qualification document; the database checks who may read it. */
export async function openQualificationDocument(documentId: string) {
  const doc = await rpc<{ fileName: string; mimeType: string; content: string }>("qualification_document_get", { p_document: documentId });
  const bytes = Uint8Array.from(atob(doc.content), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: doc.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = doc.fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The application's uploaded files are copied onto the Qualification (a new copy, never a shared file): the database lists them as
 * pending, a staff screen reads each from storage and stores the copy. Returns how many were copied.
 */
export async function copyPendingDocuments(documents: QualificationDocument[]): Promise<number> {
  let copied = 0;
  for (const doc of documents) {
    if (doc.copyState !== "pending" || !doc.sourceBucket || !doc.sourcePath) continue;
    let content = "";
    try {
      const { data, error } = await supabase.storage.from(doc.sourceBucket).createSignedUrl(doc.sourcePath, 120);
      if (!error && data?.signedUrl) {
        const res = await fetch(data.signedUrl);
        if (res.ok) content = toBase64(new Uint8Array(await res.arrayBuffer()));
      }
    } catch {
      content = "";
    }
    await rpc<void>("qualification_document_store_copy", { p_document: doc.id, p_content: content });
    if (content) copied++;
  }
  return copied;
}

/** After "Mark as enrolled": copy the application's files onto the new Qualification(s). */
export async function copyApplicationDocumentsToQualifications(applicationId: string) {
  const rows = await listQualifications({ applicationId });
  for (const row of rows) {
    const detail = await getQualification(row.id);
    await copyPendingDocuments(detail.documents);
  }
}

export const DOCUMENT_KIND_LABELS: Record<string, string> = {
  coe: "CoE", voe: "VoE", signed_offer: "Signed offer", application_document: "From the application", evidence: "Evidence", certificate: "Certificate", other: "Other",
};

export const TASK_KIND_LABELS: Record<QualificationTask["kind"], string> = {
  place_manually: "Place student manually", prisms_report: "Report in PRISMS", refund_check: "Check for a refund", resume_check: "Resume or extend",
};

export const formatQualificationDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" }) : "";
