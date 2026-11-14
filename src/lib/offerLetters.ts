import { supabase } from "@/pages/admin/lib/supabase";
import { resolveTenantSite } from "@/lib/tenantSite";
import { isTemplateAsset } from "../../supabase/functions/_shared/rich-html";
import { expandLetterBlocks, letterKeys, letterResolver, withChargeValues, withCourseValues, type LetterValue, type LetterVariable, type ManualFill } from "../../supabase/functions/_shared/letter-variables";

/**
 * Offer letters (LOO): the variable registry, an application's values, student offer letter templates, pictures in the template-assets
 * bucket, and the PDF made in the browser from the same builder the Edge Functions use (so the preview is the letter that is sent).
 */

export const LETTER_CATEGORY = "student_offer_letter";
export const TEMPLATE_ASSETS_BUCKET = "template-assets";
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

let registryCache: Promise<LetterVariable[]> | null = null;
/** The registry (cached for the page's life; it changes only with a migration). */
export function loadLetterRegistry(): Promise<LetterVariable[]> {
  registryCache ??= rpc<LetterVariable[]>("letter_variable_registry").catch((e) => { registryCache = null; throw e; });
  return registryCache;
}

/** values: every variable (course and fee ones from the first course); courses: the course and fee variables of each course (packaged offers). */
export interface LetterValues {
  values: Record<string, LetterValue>; courses?: Array<Record<string, LetterValue>>;
  /** Settings › Other fees and charges, one entry per row ({{#each other_fees}}). */
  charges?: Array<Record<string, LetterValue>>;
  context: { courseId: string | null; intakeId: string | null; feeSetup: string | null; courseTitle: string | null; dateFormat: string; courseCount?: number; gst?: boolean };
}
/**
 * The template as printed for these values: {{#each courses}} once per course, {{#if multiple_courses}} for several, {{#each other_fees}} once
 * per row of Settings › Other fees and charges (one sample row when not known), {{#if gst}} when a fee line is taxable.
 */
export const expandFor = (html: string | null | undefined, courses: LetterValues["courses"], charges?: LetterValues["charges"], gst = false) =>
  expandLetterBlocks(html ?? "", courses?.length ?? 1, { charges: charges ? charges.length : 1, gst });
/** The issue drawer: an application's values (staff reviewers). */
export const letterValues = (applicationId: string) => rpc<LetterValues>("portal_letter_values", { p_application: applicationId });
/** Template editor, "Test with application" (CMS admins). */
export const testLetterValues = (applicationId: string) => rpc<LetterValues>("letter_test_values", { p_application: applicationId });
export const testApplications = (search = "") =>
  rpc<Array<{ id: string; reference: string; studentName: string; status: string; updatedAt: string }>>("letter_test_applications", { p_search: search });
/** Fill and save to source: writes the value where the variable comes from; returns the application's values again. */
export const saveLetterValueToSource = (applicationId: string, key: string, value: string) =>
  rpc<LetterValues>("portal_letter_save_to_source", { p_application: applicationId, p_key: key, p_value: value });

export interface LetterTemplate {
  id: string; name: string; title: string; version: number; updatedAt: string; active: boolean;
  headerHtml: string | null; bodyHtml: string | null; footerHtml: string | null; unmapped: string[];
}
export const loadLetterTemplates = () => rpc<LetterTemplate[]>("letter_templates");
export const setLetterTemplateActive = (id: string, active: boolean) => rpc<{ id: string; active: boolean }>("letter_template_set_active", { p_id: id, p_active: active });

export const issueTemplateLetter = (input: {
  applicationId: string; templateId: string; templateVersion: number; fileName: string; contentBase64: string; manual: ManualFill[]; conditions: string; message: string; overrideNote: string;
}) => rpc<{ id: string }>("portal_offer_letter_issue_template", {
  p_application: input.applicationId, p_template: input.templateId, p_template_version: input.templateVersion, p_file_name: input.fileName, p_content_base64: input.contentBase64,
  p_manual: input.manual, p_conditions: input.conditions, p_message: input.message, p_override_note: input.overrideNote,
});

/* ------------------------------------------------------------------ pictures */
/** A picture as PNG or JPEG bytes: PNG / JPEG as they are, anything else a browser can draw (GIF, WebP, SVG, BMP) redrawn as PNG. */
async function asPngOrJpeg(blob: Blob): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (png) return blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });
  if (jpeg) return blob.type === "image/jpeg" ? blob : new Blob([blob], { type: "image/jpeg" });
  if (!/^image\//.test(blob.type) && blob.type !== "") throw new Error("That is not a picture.");
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.min(3000, img.naturalWidth || 600));
    canvas.height = Math.max(1, Math.min(3000, img.naturalHeight || 200));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be converted."))), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}

/** Uploads a picture to template-assets (default/ or the tenant's folder) and returns its public URL. Pictures are never replaced. */
export async function uploadTemplateAsset(blob: Blob): Promise<string> {
  const picture = await asPngOrJpeg(blob);
  if (picture.size > MAX_ASSET_BYTES) throw new Error("The picture is larger than 2 MB. Use a smaller one (a logo about 600 pixels wide is plenty).");
  const tenant = await resolveTenantSite().catch(() => null);
  const path = `${tenant?.tenantId ?? "default"}/${crypto.randomUUID()}.${picture.type === "image/png" ? "png" : "jpg"}`;
  const { error } = await supabase.storage.from(TEMPLATE_ASSETS_BUCKET).upload(path, picture, { upsert: false, contentType: picture.type, cacheControl: "31536000" });
  if (error) throw new Error(`The picture could not be uploaded: ${error.message}`);
  return supabase.storage.from(TEMPLATE_ASSETS_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Re-hosts one picture source (data: URI, another site's URL, a blob:) in template-assets. file:/// and cid: cannot be read by a page. */
export async function rehostImage(src: string): Promise<string> {
  if (isTemplateAsset(src)) return src;
  if (/^(file|cid|ms-|webkit-fake-url):/i.test(src)) throw new Error("The picture is on your computer, not in the copied content. Use Insert image.");
  const response = await fetch(src, { mode: "cors", credentials: "omit" }).catch(() => null);
  if (!response?.ok) throw new Error("The picture's website does not allow copying it. Save it and use Insert image.");
  return uploadTemplateAsset(await response.blob());
}

/**
 * Every picture in pasted / loaded HTML that is not already in template-assets is uploaded there and its src replaced; width, height and
 * alignment stay (they are on the img and its paragraph). Pictures that cannot be fetched are removed and counted, so staff are told.
 */
export async function rehostImagesIn(html: string, pastedFiles: readonly File[] = []): Promise<{ html: string; failed: number; uploaded: number }> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const images = [...doc.querySelectorAll("img")];
  let failed = 0, uploaded = 0;
  const files = [...pastedFiles];
  for (const img of images) {
    const src = img.getAttribute("src") ?? "";
    if (isTemplateAsset(src)) continue;
    try {
      // Word puts the picture itself on the clipboard next to the HTML that links it from the computer.
      const local = /^(file|cid):/i.test(src) && files.length ? files.shift()! : null;
      img.setAttribute("src", local ? await uploadTemplateAsset(local) : await rehostImage(src));
      for (const attr of ["width", "height"]) { const v = img.getAttribute(attr); if (v && /^\d+$/.test(v)) img.style.setProperty(attr, `${v}px`); }
      uploaded++;
    } catch { img.remove(); failed++; }
  }
  return { html: doc.body.innerHTML, failed, uploaded };
}

/* ------------------------------------------------------------------ the PDF */
const imageCache = new Map<string, Promise<Uint8Array | null>>();
const loadImage = (url: string) => {
  if (!imageCache.has(url)) imageCache.set(url, fetch(url).then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null), () => null));
  return imageCache.get(url)!;
};

export interface LetterPdfInput {
  template: Pick<LetterTemplate, "title" | "headerHtml" | "bodyHtml" | "footerHtml">;
  registry: readonly LetterVariable[];
  values: Record<string, LetterValue>;
  manual?: readonly ManualFill[];
  conditions?: string;
  /** Preview with sample values: every variable prints its registry sample. */
  sample?: boolean;
  /** Packaged offers: the course and fee variables of each course. */
  courses?: LetterValues["courses"];
  /** Settings › Other fees and charges rows; whether a fee line is taxable ({{#if gst}}). */
  charges?: LetterValues["charges"];
  gst?: boolean;
}
/** The letter as a PDF (A4, header / footer on every page, page numbers), with where each missing variable printed. */
export async function buildLetterPdf(input: LetterPdfInput) {
  const { buildDocumentPdf, linkedImages } = await import("../../supabase/functions/_shared/document-pdf");
  const expand = (html: string | null | undefined) => expandFor(html, input.courses, input.charges, Boolean(input.gst));
  const headerHtml = expand(input.template.headerHtml), bodyHtml = expand(input.template.bodyHtml), footerHtml = expand(input.template.footerHtml);
  const values = withChargeValues(withCourseValues(input.values, input.courses), input.charges);
  const images: Record<string, Uint8Array> = {};
  // Pictures in the HTML (template-assets) and picture variables ({{institute.logo}}: the URL from Settings).
  const used = new Set(letterKeys(`${headerHtml ?? ""}\n${bodyHtml ?? ""}\n${footerHtml ?? ""}`));
  const pictureValues = input.registry.filter((v) => v.format === "image" && used.has(v.key)).map((v) => values[v.key]?.value).filter((url): url is string => Boolean(url && /^https?:\/\//.test(url)));
  await Promise.all([...new Set([...linkedImages(headerHtml, bodyHtml, footerHtml), ...pictureValues])].map(async (url) => { const bytes = await loadImage(url); if (bytes) images[url] = bytes; }));
  return buildDocumentPdf({
    title: input.template.title || "Offer letter", header: headerHtml, body: bodyHtml || "<p></p>", footer: footerHtml, values: {}, brackets: false, images,
    curly: letterResolver(input.registry, values, input.manual ?? [], input.conditions ?? "", Boolean(input.sample)),
  });
}

/** Sample values for "Preview with sample application": every variable its registry sample. */
export const sampleValues = (registry: readonly LetterVariable[]): Record<string, LetterValue> =>
  Object.fromEntries(registry.map((v) => [v.key, { value: v.sample, raw: v.sample, source: "Sample", missing: false }]));

export const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
