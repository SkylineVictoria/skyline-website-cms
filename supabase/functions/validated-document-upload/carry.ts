// DOCUMENT-CARRY (owner 2026-11-26): copy a student's own documents from their earlier application into a new one.
// The database chooses what to copy (application_document_carry_plan: latest valid version per category, never expired, rejected
// or application-specific documents); each file is copied to a NEW object in the new application's folder and recorded as a NEW row
// of that application (application_document_carry_record). The passport comes first: the other checked documents are recorded
// against the new application's own passport. Idempotent: a document already copied is never copied twice.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface CarryItem { documentId: string; category: string; bucket: string; path: string; filename: string; fromReference: string }
export interface CarryResult { ok: boolean; copied: Array<{ category: string; filename: string; fromReference: string; id: string }>; skipped: number; error?: string }

export function carryTargetPath(applicationId: string, sourcePath: string, id: string): string {
  const name = sourcePath.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, "") : "";
  return `${applicationId}/validated-${id}${ext}`;
}

export async function carryPreviousDocuments(admin: SupabaseClient, applicationId: string): Promise<CarryResult> {
  const result: CarryResult = { ok: true, copied: [], skipped: 0 };
  const plan = await admin.rpc("application_document_carry_plan", { p_application: applicationId });
  if (plan.error) return { ...result, ok: false, error: "The documents could not be read." };
  for (const item of (plan.data ?? []) as CarryItem[]) {
    const target = carryTargetPath(applicationId, item.path, crypto.randomUUID());
    const bucket = admin.storage.from(item.bucket);
    const { error: copyError } = await bucket.copy(item.path, target);
    if (copyError) { result.skipped++; continue; }
    const { data, error } = await admin.rpc("application_document_carry_record", {
      p_application: applicationId, p_source: item.documentId, p_path: target,
    });
    if (error || !data) {
      await bucket.remove([target]);
      result.skipped++;
      continue;
    }
    result.copied.push({ category: item.category, filename: item.filename, fromReference: item.fromReference, id: String(data) });
  }
  return result;
}
