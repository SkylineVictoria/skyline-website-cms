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
