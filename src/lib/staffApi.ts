import { supabase } from "@/pages/admin/lib/supabase";
import { publicSiteOrigin } from "@/lib/siteUrl";
import type { StaffRole, StaffStatus } from "@/lib/staffStatus";

/** Browser-side calls for staff self-registration. Every write is a SECURITY DEFINER function (the hr schema is not exposed). */

export interface StaffProfile {
  id: string; first_name: string; middle_name: string; last_name: string; date_of_birth: string | null; email: string; phone_e164: string;
  address_street: string; address_line2: string; address_suburb: string; address_state: string; address_postcode: string; address_country: string;
  emergency_name: string; emergency_relationship: string; emergency_phone_e164: string | null; status: StaffStatus; created_at: string; updated_at: string;
}
export interface StaffApplicationRow { id: string; requested_role: StaffRole | null; submitted_at: string | null; review_note: string; reviewed_at: string | null }
export type StaffDocCategory = "Passport" | "Visa" | "Driving Licence" | "PTE" | "English Certificate";
export interface StaffDocument {
  id: string; category: StaffDocCategory; filename: string; mimeType: string; fileSize: number; storagePath: string;
  extractionStatus: "pending" | "processing" | "done" | "no_fields" | "failed" | "unavailable"; extracted: Record<string, string>; extractionError?: string | null;
}
export interface StaffEvent { from: StaffStatus | null; to: StaffStatus; actorKind: string; note: string; at: string }
export interface StaffMe { profile: StaffProfile; application: StaffApplicationRow; documents: StaffDocument[]; role: StaffRole | null; events: StaffEvent[]; attachedToExistingAccount?: boolean }

function fail(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

/** Where the emailed link returns to: this deployment's /staff/apply page. */
export function staffApplyUrl(): string {
  const base = __BASE_PATH__.split("/").filter(Boolean).join("/");
  return `${publicSiteOrigin()}${base ? `/${base}` : ""}/staff/apply`;
}

/** Calls the public staff-register function and surfaces its own error text (the neutral conflict messages). */
async function register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
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
    throw Object.assign(new Error(message || "We could not reach the registration service. Please try again."), { field });
  }
  if (data?.error) throw new Error(String(data.error));
  return (data ?? {}) as Record<string, unknown>;
}

/** Checks the email and number without sending anything. Throws the neutral message on a conflict. */
export async function checkStaffContact(email: string, phone: string, agreed: boolean): Promise<void> {
  await register({ action: "check", email, phone, agreed });
}

/** Asks for the email code / link. Duplicates are refused before anything is sent. */
export async function requestStaffCode(email: string, phone: string, agreed: boolean, website = ""): Promise<void> {
  await register({ action: "send_code", email, phone, agreed, website, redirectTo: staffApplyUrl() });
}

export async function verifyStaffCode(email: string, code: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: "email" });
  if (error) throw new Error("That code is not right, or it has expired. Check it or request a new one.");
}

export async function setStaffPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password, data: { staff_password_set: true } });
  if (error) throw new Error(error.message);
}

export async function startStaffApplication(phone?: string): Promise<StaffMe> {
  const { data, error } = await supabase.rpc("hr_staff_start", { p_phone: phone ?? null, p_requested_role: null });
  if (error) fail(error, "We could not start your application.");
  return data as StaffMe;
}

export async function getMyStaffApplication(): Promise<StaffMe | null> {
  const { data, error } = await supabase.rpc("hr_staff_me");
  if (error) fail(error, "We could not load your application.");
  return (data ?? null) as StaffMe | null;
}

export async function saveStaffDraft(patch: Record<string, string | null>): Promise<StaffMe> {
  const { data, error } = await supabase.rpc("hr_staff_save", { p_patch: patch });
  if (error) fail(error, "Your changes could not be saved.");
  return data as StaffMe;
}

export async function submitStaffApplication(): Promise<StaffMe> {
  const { data, error } = await supabase.rpc("hr_staff_submit");
  if (error) fail(error, "Your application could not be submitted.");
  return data as StaffMe;
}

const EXTENSION: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };

/** Uploads to the private bucket, registers the document, removes the file it replaces, then asks for it to be read. */
export async function uploadStaffDocument(me: StaffMe, uid: string, category: StaffDocCategory, file: File): Promise<string> {
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!EXTENSION[mime]) throw new Error("Upload a PDF, JPG or PNG.");
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error("The file must be 10 MB or smaller.");
  const path = `${uid}/${me.application.id}/${category.toLowerCase().replace(/\s+/g, "-")}-${crypto.randomUUID()}.${EXTENSION[mime]}`;
  const up = await supabase.storage.from("staff-documents").upload(path, file, { contentType: mime, upsert: false });
  if (up.error) throw new Error("The upload failed. Please try again.");
  const { data, error } = await supabase.rpc("hr_staff_document_register", { p_category: category, p_path: path, p_filename: file.name.slice(0, 255), p_mime: mime, p_size: file.size });
  if (error) {
    await supabase.storage.from("staff-documents").remove([path]);
    fail(error, "The document could not be saved.");
  }
  const result = data as { id: string; replacedPaths: string[] };
  if (result.replacedPaths.length) await supabase.storage.from("staff-documents").remove(result.replacedPaths);
  void requestStaffExtraction(result.id);
  return result.id;
}

/** Best effort: a failure only means the details are typed in by hand. */
export async function requestStaffExtraction(documentId: string): Promise<void> {
  try { await supabase.functions.invoke("staff-document-extract", { body: { documentId } }); } catch { /* manual entry continues */ }
}

export async function removeStaffDocument(id: string): Promise<void> {
  const { data, error } = await supabase.rpc("hr_staff_document_remove", { p_id: id });
  if (error) fail(error, "The document could not be removed.");
  if (typeof data === "string" && data) await supabase.storage.from("staff-documents").remove([data]);
}

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

export interface StaffListRow { id: string; name: string; email: string; phone: string; status: StaffStatus; requestedRole: StaffRole | null; role: StaffRole | null; submittedAt: string | null; updatedAt: string }
export interface StaffDetail {
  profile: StaffProfile; application: StaffApplicationRow; documents: StaffDocument[];
  roles: Array<{ role: StaffRole; grantedAt: string; revokedAt: string | null }>; events: StaffEvent[]; hasCmsAccess: boolean;
}

export async function adminListStaff(status: string, search: string, limit = 50, offset = 0): Promise<{ total: number; rows: StaffListRow[] }> {
  const { data, error } = await supabase.rpc("hr_admin_staff_list", { p_status: status || null, p_search: search || null, p_limit: limit, p_offset: offset });
  if (error) fail(error, "The staff list could not be loaded.");
  return data as { total: number; rows: StaffListRow[] };
}

export async function adminStaffDetail(id: string): Promise<StaffDetail> {
  const { data, error } = await supabase.rpc("hr_admin_staff_detail", { p_id: id });
  if (error) fail(error, "The application could not be loaded.");
  return data as StaffDetail;
}

export type StaffDecision =
  | { action: "approve"; role: StaffRole; note: string; confirmAdmin: boolean }
  | { action: "reject"; note: string }
  | { action: "activate"; note: string }
  | { action: "deactivate"; note: string }
  | { action: "reopen"; note: string };

export async function adminDecideStaff(id: string, decision: StaffDecision): Promise<StaffDetail> {
  const call = decision.action === "approve" ? supabase.rpc("hr_admin_staff_approve", { p_id: id, p_role: decision.role, p_note: decision.note || null, p_confirm_admin: decision.confirmAdmin })
    : decision.action === "reject" ? supabase.rpc("hr_admin_staff_reject", { p_id: id, p_note: decision.note })
    : decision.action === "activate" ? supabase.rpc("hr_admin_staff_activate", { p_id: id, p_note: decision.note || null })
    : decision.action === "deactivate" ? supabase.rpc("hr_admin_staff_deactivate", { p_id: id, p_note: decision.note || null })
    : supabase.rpc("hr_staff_reopen", { p_id: id, p_note: decision.note });
  const { data, error } = await call;
  if (error) fail(error, "That could not be done.");
  return data as StaffDetail;
}
