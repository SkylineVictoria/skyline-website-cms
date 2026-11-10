import { supabase } from "@/pages/admin/lib/supabase";
export interface SigningTemplate { id: string; name: string; title: string; body: string }
export interface SigningRequest { id: string; title: string; recipient_name: string; recipient_email: string; state: string; created_at: string; expires_at: string | null; signed_at: string | null; delivery_error: string | null; profile_id?: string | null; edited?: boolean }
/** document-signing `preview`: the PDF as it will be sent (base64), the filled text, the template's own render and the variables the template uses. */
export interface SigningPreview { pdfBase64: string; title: string; text: string; templateText: string; edited: boolean; recipientName: string; recipientEmail: string; variables: string[]; templateName: string }
export interface SigningContext { templates: SigningTemplate[]; requests: SigningRequest[] }
export interface SigningView { id: string; title: string; recipientName: string; state: string; signedAt: string | null; consent: string; documentHash: string; url: string }
export async function signingAdmin<T>(action: string, id: string | null = null, data: Record<string, unknown> = {}): Promise<T> {
  const result = await supabase.rpc("signing_admin", { p_action: action, p_id: id, p_data: data });
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
