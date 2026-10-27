import { supabase } from "@/pages/admin/lib/supabase";
import { currentTenantSite, resolveTenantSite } from "@/lib/tenantSite";

export const CMS_MEDIA_BUCKET = "cms-media";
export const TENANT_PUBLIC_MEDIA_BUCKET = "tenant-public-media";
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv"]);

export type StoredFile = {
  id: string;
  originalFileName: string;
  storageFileName: string;
  bucketName: string;
  storagePath: string;
  mimeType: string;
  fileSize: number;
  url: string;
};

function safeName(name: string) {
  return name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "file";
}

function extension(name: string) { return name.split(".").pop()?.toLowerCase() ?? ""; }

export function validateDocument(file: File) {
  const ext = extension(file.name);
  if (!DOCUMENT_EXTENSIONS.has(ext)) throw new Error("Allowed file types: PDF, Word, Excel, PowerPoint, text, RTF, or CSV.");
  if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) throw new Error("Files must be between 1 byte and 20 MB.");
}

/** Uploads without upsert, then verifies that the exact object exists. */
export async function uploadCmsDocument(file: File, module: "courses" | "forms" | "policies" | "pages", parentId: string, attachmentId?: string): Promise<StoredFile> {
  validateDocument(file);
  const tenant = await resolveTenantSite();
  if (tenant && (extension(file.name) !== "pdf" || file.type !== "application/pdf")) throw new Error("Tenant public documents must be PDF files. Private files belong in the private document workflow.");
  const id = attachmentId ?? crypto.randomUUID();
  const originalFileName = file.name;
  const storageFileName = `${id}-${safeName(originalFileName)}`;
  const relativePath = module === "courses" ? `courses/${parentId}/attachments/${storageFileName}` : `${module}/${parentId}/${storageFileName}`;
  const storagePath = tenant ? `${tenant.tenantId}/${relativePath}` : relativePath;
  const bucket = tenant ? TENANT_PUBLIC_MEDIA_BUCKET : CMS_MEDIA_BUCKET;
  const { error } = await supabase.storage.from(bucket).upload(storagePath, file, {
    upsert: false, contentType: file.type || "application/octet-stream", cacheControl: "31536000",
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  const { data: objects, error: verifyError } = await supabase.storage.from(bucket).list(storagePath.slice(0, storagePath.lastIndexOf("/")), { search: storageFileName });
  if (verifyError || !objects?.some((object) => object.name === storageFileName)) {
    if (!tenant) await supabase.storage.from(bucket).remove([storagePath]);
    throw new Error("Upload could not be verified in Storage.");
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return { id, originalFileName, storageFileName, bucketName: bucket, storagePath, mimeType: file.type || "application/octet-stream", fileSize: file.size, url: data.publicUrl };
}

export async function removeCmsObject(bucketName?: string, storagePath?: string) {
  if (!bucketName || !storagePath) return;
  if (bucketName === TENANT_PUBLIC_MEDIA_BUCKET) return; // Keep accepted public URLs stable.
  const { error } = await supabase.storage.from(bucketName).remove([storagePath]);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

export async function uploadCmsImage(file: File): Promise<string> {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  if (!allowed.has(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024) throw new Error("Choose a PNG, JPEG, WebP or GIF image up to 5 MB.");
  await resolveTenantSite();
  const tenant = currentTenantSite();
  const bucket = tenant ? TENANT_PUBLIC_MEDIA_BUCKET : CMS_MEDIA_BUCKET;
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[file.type];
  const storagePath = `${tenant ? tenant.tenantId + "/images/" : "cms/"}${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(storagePath, file, { upsert: false, contentType: file.type, cacheControl: "31536000" });
  if (error) throw new Error("Image upload failed. Your previous image is unchanged.");
  return supabase.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl;
}
