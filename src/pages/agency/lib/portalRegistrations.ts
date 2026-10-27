import { supabase } from "@/pages/admin/lib/supabase";
import type { ExceptionKind, RegistrationState } from "@/pages/agency/lib/registrationWorkbench";

export interface WorkbenchRow {
  applicationId: string;
  reference: string;
  studentName: string;
  status: string;
  intake: string;
  warning: boolean;
  registration: { id: string; state: RegistrationState; coeNumber: string | null; lodgedAt: string | null; verifiedAt: string | null; cancelledAt: string | null; evidenceCount: number } | null;
}
export interface RegistrationDetail {
  application: { id: string; reference: string; studentName: string; status: string };
  registration: { id: string; state: RegistrationState; coeNumber: string | null; lodgedAt: string | null; verifiedAt: string | null; cancelledAt: string | null; cancelReason: string | null };
  evidence: { id: string; kind: string; description: string; documentId: string | null; recordedAt: string; recordedBy: string }[];
  history: { from: string | null; to: string; actor: string; note: string; at: string }[];
}

/** Server messages for these commands are fixed strings with no personal data, so they are safe to show. */
function fail(error: { code?: string; message?: string }): never {
  if (error.code === "42501") throw new Error("You do not have permission to do that.");
  if (error.code === "22023" || error.code === "23505" || error.code === "P0002") throw new Error(error.message || "That request was not accepted.");
  throw new Error("The change could not be saved. Please try again.");
}

export async function listWorkbench(): Promise<WorkbenchRow[]> {
  const { data, error } = await supabase.rpc("portal_registration_workbench");
  if (error) fail(error);
  return (data ?? []) as WorkbenchRow[];
}
export async function getRegistration(id: string): Promise<RegistrationDetail> {
  const { data, error } = await supabase.rpc("portal_registration_detail", { p_registration: id });
  if (error) fail(error);
  return data as RegistrationDetail;
}
export async function createRegistration(applicationId: string, note: string): Promise<string> {
  const { data, error } = await supabase.rpc("portal_registration_create", { p_application: applicationId, p_note: note });
  if (error) fail(error);
  return String(data);
}
export async function addEvidence(registrationId: string, kind: string, description: string): Promise<void> {
  const { error } = await supabase.rpc("portal_registration_add_evidence", { p_registration: registrationId, p_kind: kind, p_description: description });
  if (error) fail(error);
}
export async function transitionRegistration(registrationId: string, to: "lodged" | "verified" | "cancelled", coeNumber: string | null, note: string): Promise<void> {
  const { error } = await supabase.rpc("portal_registration_transition", { p_registration: registrationId, p_to: to, p_coe_number: coeNumber, p_note: note });
  if (error) fail(error);
}
export async function exportRegistrations(applicationIds: string[]): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase.rpc("portal_registration_export", { p_applications: applicationIds });
  if (error) fail(error);
  return (data ?? []) as Record<string, unknown>[];
}

export interface ExceptionRow {
  kind: ExceptionKind;
  applicationId: string;
  reference: string;
  studentName: string;
  status: string;
  registration: { id: string; state: RegistrationState; coeNumber: string | null; lodgedAt: string | null } | null;
  accepted: { by: string; at: string; note: string } | null;
}
export async function listExceptions(): Promise<ExceptionRow[]> {
  const { data, error } = await supabase.rpc("portal_registration_exceptions");
  if (error) fail(error);
  return (data ?? []) as ExceptionRow[];
}
export async function reviewException(applicationId: string, kind: ExceptionKind, decision: "accept" | "reopen", note: string): Promise<void> {
  const { error } = await supabase.rpc("portal_registration_review_exception", { p_application: applicationId, p_kind: kind, p_decision: decision, p_note: note });
  if (error) fail(error);
}
export async function correctCoeNumber(registrationId: string, newCoe: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("portal_registration_correct_coe", { p_registration: registrationId, p_new_coe: newCoe, p_reason: reason });
  if (error) fail(error);
}

export interface CoeDocumentInfo { id: string; kind: "coe" | "voe"; fileName: string; sizeBytes: number; sha256: string; uploadedAt: string; issuedAt: string | null }

export async function getCoeDocument(applicationId: string): Promise<CoeDocumentInfo | null> {
  const { data, error } = await supabase.rpc("portal_coe_document_list", { p_application: applicationId });
  if (error) fail(error);
  return data && typeof data === "object" ? (data as CoeDocumentInfo) : null;
}
export async function uploadCoeDocument(registrationId: string, kind: "coe" | "voe", fileName: string, contentBase64: string): Promise<void> {
  const { error } = await supabase.rpc("portal_coe_document_upload", { p_registration: registrationId, p_kind: kind, p_file_name: fileName, p_content: contentBase64 });
  if (error) fail(error);
}
export async function issueCoeVoe(applicationId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc("portal_coe_voe_issue", { p_application: applicationId, p_note: note });
  if (error) fail(error);
}
export async function readCoeDocumentContent(applicationId: string): Promise<{ kind: string; fileName: string; contentBase64: string } | null> {
  const { data, error } = await supabase.rpc("portal_coe_document_content", { p_application: applicationId });
  if (error) fail(error);
  return data && typeof data === "object" ? (data as { kind: string; fileName: string; contentBase64: string }) : null;
}
