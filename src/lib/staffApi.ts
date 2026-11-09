import { supabase } from "@/pages/admin/lib/supabase";
import type { StaffDocCategory, StaffDocReview, StaffRole, StaffStatus } from "@/lib/staffStatus";

export type { StaffDocCategory } from "@/lib/staffStatus";

/** Browser-side calls for staff self-registration. Every write is a SECURITY DEFINER function (the hr schema is not exposed). */

export interface StaffProfile {
  id: string; first_name: string; middle_name: string; last_name: string; date_of_birth: string | null; email: string; phone_e164: string;
  address_street: string; address_line2: string; address_suburb: string; address_state: string; address_postcode: string; address_country: string;
  emergency_name: string; emergency_relationship: string; emergency_phone_e164: string | null; is_australian_citizen: boolean | null;
  status: StaffStatus; created_at: string; updated_at: string;
}
export interface StaffApplicationRow { id: string; requested_role: StaffRole | null; submitted_at: string | null; review_note: string; reviewed_at: string | null }
export interface StaffDocument {
  id: string; category: string; filename: string; mimeType: string; fileSize: number; storagePath: string;
  extractionStatus: "pending" | "processing" | "done" | "no_fields" | "failed" | "unavailable"; extracted: Record<string, string>; extractionError?: string | null;
  createdAt: string; expiryDate: string | null; status: StaffDocReview; reviewNote: string; reviewedAt: string | null;
}
/** hr.staff_doc_summary: required document types, how many have a file, how many are fully approved, any expiring within 30 days. */
export interface StaffDocSummary { required: number; uploaded: number; approved: number; rejected: number; expiringSoon: boolean; nextExpiry: string | null }
export interface StaffEvent { from: StaffStatus | null; to: StaffStatus; actorKind: string; note: string; at: string }
/** hr_staff_me: the signed-in person's own staff record (documents and the signed offer once they are active). */
export interface MyStaff {
  profile: StaffProfile; status: StaffStatus; role: StaffRole | null; joiningDate: string | null; documents: StaffDocument[];
  signedOffer: { id: string; signedAt: string; signedPath: string; filename: string } | null;
}

function fail(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export interface StaffApplyInput { firstName: string; lastName: string; email: string; phone: string; resume: File; agreed: boolean; captchaToken: string; website?: string }

/**
 * Sends the public staff application (multipart: details, resume, CAPTCHA token) to the staff-register function. No login is
 * created. A clash with an existing application gets the same thank-you as a success. Errors carry the field to highlight.
 */
export async function applyAsStaff(input: StaffApplyInput): Promise<void> {
  const body = new FormData();
  body.set("action", "apply");
  body.set("firstName", input.firstName);
  body.set("lastName", input.lastName);
  body.set("email", input.email);
  body.set("phone", input.phone);
  body.set("agreed", input.agreed ? "true" : "false");
  body.set("captchaToken", input.captchaToken);
  body.set("website", input.website ?? "");
  body.set("resume", input.resume, input.resume.name);
  const { data, error } = await supabase.functions.invoke("staff-register", { body });
  if (error) {
    let message = error.message;
    let field: string | undefined;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const parsed = (await context.clone().json()) as { error?: string; field?: string };
        if (parsed?.error) message = parsed.error;
        field = parsed?.field;
      } catch { /* keep the generic message */ }
    }
    throw Object.assign(new Error(message || "We could not send your application. Please try again."), { field });
  }
  if (data?.error) throw new Error(String(data.error));
}

export async function getMyStaff(): Promise<MyStaff | null> {
  const { data, error } = await supabase.rpc("hr_staff_me");
  if (error) fail(error, "We could not load your staff record.");
  return (data ?? null) as MyStaff | null;
}

/** A short-lived signed link: the bucket is private, so files are never public URLs. */
export async function staffDocumentUrl(storagePath: string, seconds = 300): Promise<string> {
  const { data, error } = await supabase.storage.from("staff-documents").createSignedUrl(storagePath, seconds);
  if (error || !data?.signedUrl) throw new Error("The document could not be opened.");
  return data.signedUrl;
}

/** hr_staff_access: where the signed-in user stands ("none" when they have no staff application). */
export async function staffAccessState(): Promise<StaffStatus | "none"> {
  const { data, error } = await supabase.rpc("hr_staff_access");
  if (error) return "none";
  return (typeof data === "string" ? data : "none") as StaffStatus | "none";
}

/* ------------------------------------------------------------------ admin */

export interface StaffListRow {
  id: string; name: string; email: string; phone: string; status: StaffStatus; requestedRole: StaffRole | null; role: StaffRole | null;
  submittedAt: string | null; updatedAt: string; docs: StaffDocSummary;
}
export interface StaffDetail {
  profile: StaffProfile; application: StaffApplicationRow; documents: StaffDocument[]; requiredCategories: StaffDocCategory[]; summary: StaffDocSummary;
  roles: Array<{ role: StaffRole; grantedAt: string; revokedAt: string | null }>; events: StaffEvent[]; hasCmsAccess: boolean;
}

/** One or more statuses (p_statuses); an empty list means every status. */
export async function adminListStaff(statuses: readonly StaffStatus[], search: string, limit = 50, offset = 0): Promise<{ total: number; rows: StaffListRow[] }> {
  const { data, error } = await supabase.rpc("hr_admin_staff_list", { p_statuses: statuses.length ? statuses : null, p_search: search || null, p_limit: limit, p_offset: offset });
  if (error) fail(error, "The staff list could not be loaded.");
  return data as { total: number; rows: StaffListRow[] };
}

export async function adminStaffDetail(id: string): Promise<StaffDetail> {
  const { data, error } = await supabase.rpc("hr_admin_staff_detail", { p_id: id });
  if (error) fail(error, "The application could not be loaded.");
  return data as StaffDetail;
}

export async function adminReviewStaffDocument(documentId: string, decision: "approved" | "rejected", note: string): Promise<StaffDetail> {
  const { data, error } = await supabase.rpc("hr_admin_staff_document_review", { p_doc: documentId, p_decision: decision, p_note: note || null });
  if (error) fail(error, "The review could not be saved.");
  return data as StaffDetail;
}

export type StaffDecision =
  | { action: "approve"; role: StaffRole; note: string; confirmAdmin: boolean }
  | { action: "activate"; role: StaffRole; note: string; confirmAdmin: boolean }
  | { action: "reject"; note: string }
  | { action: "reactivate"; note: string }
  | { action: "deactivate"; note: string }
  | { action: "reopen"; note: string };

export async function adminDecideStaff(id: string, decision: StaffDecision): Promise<StaffDetail> {
  const call = decision.action === "approve" ? supabase.rpc("hr_admin_staff_approve", { p_id: id, p_role: decision.role, p_note: decision.note || null, p_confirm_admin: decision.confirmAdmin })
    : decision.action === "activate" ? supabase.rpc("hr_admin_staff_activate_account", { p_id: id, p_role: decision.role, p_note: decision.note || null, p_confirm_admin: decision.confirmAdmin })
    : decision.action === "reject" ? supabase.rpc("hr_admin_staff_reject", { p_id: id, p_note: decision.note })
    : decision.action === "reactivate" ? supabase.rpc("hr_admin_staff_activate", { p_id: id, p_note: decision.note || null })
    : decision.action === "deactivate" ? supabase.rpc("hr_admin_staff_deactivate", { p_id: id, p_note: decision.note || null })
    : supabase.rpc("hr_staff_reopen", { p_id: id, p_note: decision.note });
  const { data, error } = await call;
  if (error) fail(error, "That could not be done.");
  return data as StaffDetail;
}
