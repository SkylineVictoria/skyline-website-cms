import { supabase } from "@/pages/admin/lib/supabase";
import { docxXmlToText } from "../../supabase/functions/_shared/signing";

export type SignFieldType = "signature" | "initials" | "date" | "name" | "text" | "checkbox";
export interface SigningRole { key: string; label: string; order: number; required: boolean }
/** A field placed on a template: `role` is a signer role, or "sender" for text the sender prints (a variable on a PDF template). */
export interface TemplateField { type: SignFieldType; role: string; page: number; x: number; y: number; w: number; h: number; required?: boolean; label?: string; value?: string }
export interface SigningTemplate {
  id: string; name: string; title: string; body: string | null; kind: "text" | "pdf"; audience: "any" | "student" | "employee" | "agent"; category: string; status: "active" | "archived";
  version: number; roles: SigningRole[]; fields: TemplateField[]; signing_mode: "sequential" | "parallel"; expiry_days: number; reminder_days: number; source_pages: number | null; updated_at: string;
}
export interface SigningRecipient {
  id: string; role_key: string; role_label: string; name: string; email: string; signing_order: number; required: boolean; state: "pending" | "sent" | "viewed" | "signed" | "declined" | "skipped";
  sent_at: string | null; viewed_at: string | null; signed_at: string | null; declined_at: string | null; decline_reason: string | null; signer_name: string | null; signature_kind: string | null;
  ip: string | null; user_agent: string | null; delivery_error: string | null; reminder_count: number;
}
export interface SigningRequest {
  id: string; reference: string; title: string; state: string; status: string; category: string; signing_mode: "sequential" | "parallel"; subject_type: "student" | "employee" | "agent" | null; subject_id: string | null;
  created_at: string; sent_at: string | null; expires_at: string | null; signed_at: string | null; completed_at: string | null; closed_reason: string | null; message: string | null;
  expiry_days: number; reminder_days: number; original_hash: string; signed_hash: string | null; certificate_hash: string | null; recipients: SigningRecipient[];
}
export interface RequestField { id?: string; recipient_id: string; type: SignFieldType; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string; value?: string | null }
export interface SigningEvent { id: number; event: string; at: string; recipient_id: string | null; recipient_name: string | null; detail: Record<string, unknown>; hash: string }
export interface SigningDetail extends SigningRequest {
  fields: RequestField[]; events: SigningEvent[]; chain_ok: boolean;
  notifications: Array<{ id: number; kind: string; audience: string; state: string; recipient_id: string | null; created_at: string; sent_at: string | null; error: string | null }>;
}
export interface SigningContext { templates: SigningTemplate[]; requests: SigningRequest[] }
export interface SigningSubject { name: string; email: string; values: Record<string, string> }
/** What a link holder gets: their own fields only, and who else is signing. */
export interface SigningView {
  id: string; reference: string; title: string; state: string; message: string | null; expiresAt: string | null; signedAt: string | null; consent: string; documentHash: string; url: string; certificateUrl: string | null;
  recipient: { id: string; name: string; email: string; role: string; state: string; signed_at: string | null };
  fields: Array<{ id: string; type: SignFieldType; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string; value: string | null }>;
  signers: Array<{ name: string; role: string; state: string; order: number; required: boolean; me: boolean }>;
}
export interface MySigningDocument { recipient_id: string; reference: string; title: string; status: string; my_state: string; role: string; sent_at: string | null; signed_at: string | null; expires_at: string | null; completed_at: string | null }

/** The eight statuses of the dashboard, from the stored state (`signed` is a completed request, `partial` one that some have signed). */
export const SIGNING_STATUS: Record<string, { label: string; tone: "primary" | "secondary" | "success" | "muted" | "warn" }> = {
  draft: { label: "Draft", tone: "muted" }, sent: { label: "Pending", tone: "warn" }, viewed: { label: "Viewed", tone: "secondary" }, partial: { label: "Partially signed", tone: "secondary" },
  signed: { label: "Completed", tone: "success" }, declined: { label: "Declined", tone: "primary" }, expired: { label: "Expired", tone: "muted" }, void: { label: "Voided", tone: "muted" },
};
export const RECIPIENT_STATE: Record<string, string> = { pending: "Waiting for their turn", sent: "Invited", viewed: "Opened", signed: "Signed", declined: "Declined", skipped: "Not needed" };
export const signingStatus = (status: string) => SIGNING_STATUS[status] ?? { label: status.replaceAll("_", " "), tone: "muted" as const };
export const signedCount = (request: SigningRequest) => `${request.recipients.filter((r) => r.state === "signed").length} of ${request.recipients.filter((r) => r.required).length || request.recipients.length} signed`;

export async function signingAdmin<T>(action: string, id: string | null = null, data: Record<string, unknown> = {}): Promise<T> {
  const result = await supabase.rpc("signing_admin", { p_action: action, p_id: id, p_data: data });
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}
export async function signingMine<T>(action: "list" | "token", id: string | null = null): Promise<T> {
  const result = await supabase.rpc("signing_mine", { p_action: action, p_id: id });
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}
export async function signingAction<T>(body: Record<string, unknown>, file?: File): Promise<T> {
  const form = file ? new FormData() : null;
  if (form && file) { form.set("data", JSON.stringify(body)); form.set("file", file); }
  const { data, error } = await supabase.functions.invoke("document-signing", { body: form ?? body });
  if (error) {
    let message = "The signing request could not be completed.";
    try { const response = await error.context?.json(); if (typeof response?.error === "string") message = response.error; } catch { /* safe fallback */ }
    throw new Error(message);
  }
  return data as T;
}
export const pdfBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
/** The text of a .docx file, for a text template (formatting is not kept). */
export async function docxText(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose a Word document of 5 MB or smaller.");
  const { unzipSync, strFromU8 } = await import("fflate");
  let xml: Uint8Array | undefined;
  try { xml = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (entry) => entry.name === "word/document.xml" && entry.originalSize <= 8 * 1024 * 1024 })["word/document.xml"]; }
  catch { throw new Error("This file is not a Word .docx document."); }
  if (!xml) throw new Error("This file is not a Word .docx document.");
  return docxXmlToText(strFromU8(xml));
}
