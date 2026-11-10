import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkedDocumentCategory } from "./document-category.ts";

export async function recordDocumentCategory(admin: SupabaseClient, bucket: string, path: string, category: string): Promise<boolean> {
  if (!checkedDocumentCategory(category)) return true;
  const { data, error } = await admin.rpc("record_validated_document_category", {
    p_bucket: bucket, p_path: path, p_category: category,
  });
  return !error && data === true;
}
