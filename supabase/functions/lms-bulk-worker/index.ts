import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isServiceCaller } from "../_shared/service-role.ts";
import { extractEntry, readArchive } from "./archive.ts";
import { checkSignature, classify, MIME, ProcessingError, type Settings } from "./classify.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const numberSetting = (name: string) => {
  const value = Deno.env.get(name)?.trim();
  return value && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
};
const ai = {
  apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
  model: Deno.env.get("OPENAI_DOCUMENT_MODEL") ?? "",
  transcriptionModel: Deno.env.get("EF_LMS_BULK_TRANSCRIPTION_MODEL") ?? "",
  inputPrice: numberSetting("EF_LMS_BULK_INPUT_USD_PER_MILLION"),
  outputPrice: numberSetting("EF_LMS_BULK_OUTPUT_USD_PER_MILLION"),
};
type FileLease = { id: string; import_id: string; extension: string; name: string; object_path: string; source_path: string;
  tenant: string | null; parent_id: string | null; bytes: number; lease: string; attempts: number };
const extensionOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? "";

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!url || !key) return new Response(null, { status: 503 });
  if (!isServiceCaller(request.headers.get("Authorization"), key, url)) return new Response(null, { status: 403 });
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const storage = supabase.storage.from("lms-bulk-resources");
  const claim = await supabase.rpc("lms_bulk_claim");
  if (claim.error) return new Response(null, { status: 500 });
  const file = claim.data as FileLease | null;
  if (!file) return new Response(null, { status: 204 });
  const finish = (result: unknown) => supabase.rpc("lms_bulk_finish", { p_id: file.id, p_lease: file.lease, p_result: result });
  const staged: string[] = [];
  let finalizing = false;
  try {
    const { data, error } = await supabase.rpc("lms_bulk_policy", { p_tenant: file.tenant });
    if (error) throw new ProcessingError(error.code === "22023" ? error.message : "Upload policy could not be loaded.");
    const settings = data as Settings;
    const maxBytes = Math.min(25, Math.floor(settings.max_mib)) * 1048576;
    if (!settings.formats.includes(file.extension) || !Object.hasOwn(MIME, file.extension)) throw new ProcessingError("File type is disabled or unsupported.");
    if (file.bytes > maxBytes) throw new ProcessingError("File exceeds the configured size limit.");
    const download = await storage.download(file.object_path);
    if (download.error || !download.data) throw new ProcessingError("Uploaded file could not be read.", true);
    if (download.data.size !== file.bytes) throw new ProcessingError("Uploaded file size does not match its reservation.");
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    checkSignature(bytes, file.extension);
    let result;
    if (file.extension === "zip") {
      if (file.parent_id) throw new ProcessingError("Upload nested ZIP archives separately.");
      const children = [];
      const entries = readArchive(bytes, maxBytes, Math.floor(settings.max_files));
      for (const [index, entry] of entries.entries()) {
        const extension = extensionOf(entry.path);
        const content = extractEntry(bytes, entry);
        const name = entry.path.split("/").at(-1)!;
        const path = file.source_path + "/" + entry.path;
        if (path.length > 1024) throw new ProcessingError("Archive contains a path longer than the import can retain.");
        const objectPath = `${file.import_id}/${file.id}/${file.lease}-${index}`;
        const upload = await storage.upload(objectPath, content, { contentType: "application/octet-stream", upsert: false });
        if (upload.error) throw new ProcessingError("An extracted file could not be saved.", true);
        staged.push(objectPath);
        children.push({ name, bytes: content.byteLength, extension, path, objectPath });
      }
      result = { children };
    } else {
      const officeManifest: Record<string, string> = {
        docx: "word/document.xml", pptx: "ppt/presentation.xml", xlsx: "xl/workbook.xml",
      };
      if (officeManifest[file.extension]) {
        const entries = readArchive(bytes, maxBytes, 3000);
        if (!entries.some(entry => entry.path === "[Content_Types].xml")
          || !entries.some(entry => entry.path === officeManifest[file.extension])
          || entries.some(entry => /(?:^|\/)(vbaProject\.bin|embeddings\/)/i.test(entry.path))) {
          throw new ProcessingError("Office package is invalid or contains unsupported active content.");
        }
      }
      const digest = await sha256(bytes);
      const outcome = await classify(bytes, file.extension, file.name, file.source_path, settings, ai);
      result = { ...outcome, sha256: digest };
    }
    finalizing = true;
    const saved = await finish(result);
    if (saved.error) {
      const message = saved.error.code === "P0001" ? saved.error.message : "Processing finished but its result could not be saved.";
      if (saved.error.code === "P0001") finalizing = false;
      throw new ProcessingError(message, saved.error.code !== "P0001");
    }
    if (saved.data === false && staged.length) await storage.remove(staged);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (!finalizing && staged.length) await storage.remove(staged);
    const failure = error instanceof ProcessingError ? error.message
      : file.extension === "zip" ? "Invalid, corrupt or unsafe ZIP archive." : "The document could not be processed.";
    const saved = await finish({ failure, retry: error instanceof ProcessingError && error.retry });
    return new Response(null, { status: saved.error ? 500 : 204 });
  }
});
