// A Word document (.docx) as the body of a document template (TPL-02). mammoth converts headings, paragraphs, bold / italic / underline,
// lists, tables and pictures; the result goes through the template allow-list (rich-html.ts), so nothing outside it survives. [Tokens]
// that Word split across formatting runs are joined back together, so they stay variables. Paragraph alignment, colours and table
// borders are not read from Word: tables come out bordered (the template default) and staff adjust the rest in the editor.
// Relative imports only: the offline tests load this file outside Vite.
import { joinSplitTokens, MAX_IMAGE_CHARS, sanitizeRichHtml } from "../../supabase/functions/_shared/rich-html";

export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "u => u",
  "strike => s",
];

export interface DocxImport { html: string; warnings: string[]; droppedImages: number }

/** Converts the bytes of a .docx file; throws a readable error for a file that is not one. */
export async function docxToTemplateHtml(bytes: ArrayBuffer | Uint8Array): Promise<DocxImport> {
  if (bytes.byteLength > MAX_DOCX_BYTES) throw new Error("Choose a Word document of 10 MB or smaller.");
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data[0] !== 0x50 || data[1] !== 0x4b) throw new Error("This file is not a Word .docx document.");
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  let dropped = 0;
  const convertImage = mammoth.images.imgElement(async (image: { contentType: string; read(encoding: "base64"): Promise<string> }) => {
    if (!/^image\/(png|jpeg)$/.test(image.contentType)) { dropped++; return { src: "" }; }
    const base64 = await image.read("base64");
    const src = `data:${image.contentType};base64,${base64}`;
    if (src.length > MAX_IMAGE_CHARS) { dropped++; return { src: "" }; }
    return { src };
  });
  // The browser build reads `arrayBuffer`, the Node build `buffer` (the offline tests).
  const input = { arrayBuffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), buffer: data } as never;
  let result: { value: string; messages: Array<{ type: string; message: string }> };
  try { result = await mammoth.convertToHtml(input, { styleMap: STYLE_MAP, convertImage, ignoreEmptyParagraphs: false }); }
  catch { throw new Error("This Word document could not be read. Save it again as .docx and retry."); }
  const html = sanitizeRichHtml(joinSplitTokens(result.value));
  if (!html.replace(/<[^>]*>|\s|&nbsp;/g, "")) throw new Error("No text was found in this Word document.");
  if (html.length > 400000) throw new Error("This Word document is longer than a template allows. Split it, or remove large pictures.");
  const warnings = [...new Set(result.messages.filter((m) => m.type === "warning").map((m) => m.message))].slice(0, 5);
  return { html, warnings, droppedImages: dropped };
}
