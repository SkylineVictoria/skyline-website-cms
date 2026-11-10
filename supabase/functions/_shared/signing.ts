import { escapeHtml } from "./hr-template.ts";
import { buildLetterPdf } from "./offer-letter-pdf.ts";
import type { PdfLib } from "./offer-pdf.ts";

export const SIGNING_CONSENT = "I have read this document and agree to its contents. I consent to use my typed full name as my electronic signature.";
const TOKEN = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g;
export function signingVariables(source: string): string[] {
  const keys = [...new Set([...source.matchAll(TOKEN)].map((m) => m[1]))];
  if (/\{\{|\}\}/.test(source.replace(TOKEN, ""))) throw new Error("Use variables like {{full_name}} with lowercase letters, numbers and underscores.");
  if (keys.length > 40) throw new Error("Use no more than 40 variables.");
  return keys;
}
/** Plain text templates: substitution happens once, values never become markup or new variables. */
export function fillSigningTemplate(source: string, values: Record<string, unknown>): string {
  if (!source.trim() || source.length > 40000) throw new Error("Enter document text up to 40,000 characters.");
  const keys = signingVariables(source);
  for (const key of keys) {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new Error(`Enter a value for {{${key}}} (up to 2,000 characters).`);
  }
  return source.replace(TOKEN, (_, key: string) => String(values[key]).trim());
}
export const signingHtml = (text: string) => text.split(/\n\s*\n/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
export const signingNameValid = (value: unknown): value is string => typeof value === "string" && value.trim().length >= 2 && value.trim().length <= 150 && !/[\x00-\x1f\x7f]/.test(value);

export async function signingReceipt(lib: PdfLib, original: Uint8Array, receipt: {
  id: string; title: string; recipientEmail: string; signerName: string; signedAt: string; sourceHash: string; consent: string;
}): Promise<Uint8Array> {
  const evidence = ["Electronic signature record", `Document: ${receipt.title}`, `Request ID: ${receipt.id}`,
    `Recipient email: ${receipt.recipientEmail}`, `Signed by (typed name): ${receipt.signerName}`, `Signed at (UTC): ${receipt.signedAt}`,
    `Original document SHA-256: ${receipt.sourceHash}`, `Agreement: ${receipt.consent}`,
    "Access method: personal signing link delivered by email. This records access to that link; it is not government identity verification."].join("\n\n");
  const appendix = await buildLetterPdf(lib, { title: "Electronic signature record", html: signingHtml(evidence), footer: "Skyline Institute of Technology" });
  const document = await lib.PDFDocument.load(original, { updateMetadata: false });
  const record = await lib.PDFDocument.load(appendix.bytes);
  for (const page of await document.copyPages(record, record.getPageIndices())) document.addPage(page);
  return document.save();
}
