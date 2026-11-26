import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/pages/admin/lib/supabase";

export class RejectedDocumentError extends Error {}

export function isRejectedDocumentStatus(status: number): boolean {
  return status === 413 || status === 415 || status === 422;
}

export async function uploadValidatedDocument(target: "enrollment" | "employee", ownerId: string, category: string, file: File, existingDocumentId?: string): Promise<string> {
  const body = new FormData();
  body.set("target", target);
  body.set("ownerId", ownerId);
  body.set("category", category);
  body.set("file", file);
  if (existingDocumentId) body.set("existingDocumentId", existingDocumentId);
  const { data, error } = await supabase.functions.invoke<{ path: string }>("validated-document-upload", { body });
  if (error instanceof FunctionsHttpError) {
    const result = await error.context.json().catch(() => null);
    if (isRejectedDocumentStatus(error.context.status)) {
      throw new RejectedDocumentError(typeof result?.error === "string" ? result.error : "This document was rejected.");
    }
    if (typeof result?.error === "string") throw new Error(result.error);
  }
  if (error || !data?.path) throw new Error("The document could not be uploaded. Please try again.");
  return data.path;
}

/**
 * DOCUMENT-CARRY (owner 2026-11-26): ask the server to copy the student's own documents (passport, visa, English, qualifications,
 * licence) from their earlier application into this draft. The database trigger already asks when the application is created; this
 * is the page's fallback. Returns how many documents were copied (0 when nothing was waiting or the request failed).
 */
export async function carryPreviousDocuments(applicationId: string): Promise<number> {
  const { data: pending, error: pendingError } = await supabase.rpc("application_document_carry_pending", { p_application: applicationId });
  if (pendingError || pending !== true) return 0;
  const { data, error } = await supabase.functions.invoke<{ copied?: unknown[] }>("validated-document-upload", {
    body: { action: "carry", applicationId },
  });
  if (error || !Array.isArray(data?.copied)) return 0;
  return data.copied.length;
}
