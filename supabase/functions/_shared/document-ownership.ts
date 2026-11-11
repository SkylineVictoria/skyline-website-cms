import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { CheckDocumentCategory, DocumentCategoryProblem, DocumentToClassify } from "./document-extraction/classify.ts";

export type DocumentOwnership =
  | { ok: true; passportId: string | null }
  | ({ ok: false } & DocumentCategoryProblem);
export type CheckDocumentOwnership = (document: DocumentToClassify, ownerId: string) => Promise<DocumentOwnership>;

export function checkDocumentOwnership(
  admin: SupabaseClient,
  bucket: "enrollment-documents" | "staff-documents",
  checkCategory: CheckDocumentCategory,
): CheckDocumentOwnership {
  return async (document, ownerId) => {
    const { data: current, error } = await admin.rpc("current_upload_passport", { p_bucket: bucket, p_owner: ownerId });
    if (error) return { ok: false, status: 503, error: "Passport checking is temporarily unavailable. Please try again." };
    if (!current && document.category !== "Passport") {
      return { ok: false, status: 422, error: "Upload the passport identity page before uploading other documents." };
    }
    let passport;
    if (current) {
      const { data } = await admin.storage.from(bucket).download(current.storage_path);
      if (!data) return { ok: false, status: 422, error: "We couldn't read the current passport. Upload a clear passport identity page." };
      passport = { bytes: new Uint8Array(await data.arrayBuffer()), mime: current.mime_type ?? data.type, filename: current.filename };
    }
    const problem = await checkCategory({ ...document, verifyName: true, passport });
    return problem ? { ok: false, ...problem } : { ok: true, passportId: current?.id ?? null };
  };
}
