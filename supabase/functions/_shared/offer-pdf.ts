// Offer letters (HR-02e): checking an uploaded offer PDF and adding the signature page when it is signed. Runtime-neutral:
// pdf-lib 1.17.1 is passed in (Edge Functions: npm:pdf-lib@1.17.1; offline tests: the pinned devDependency), so both run the
// same code. The PDFs exist only in memory here; nothing is logged.
import { pdfSafe } from "./notification/submission-pdf.ts";

// deno-lint-ignore no-explicit-any
export type PdfLib = { PDFDocument: any; StandardFonts: any; rgb: (r: number, g: number, b: number) => unknown };

/** Offers are emailed back signed, so they must stay under Postmark's 10 MB message limit after base64 (x1.37) and the page. */
export const MAX_OFFER_BYTES = 7 * 1024 * 1024;
export const OFFER_ENCRYPTED = "This PDF is password-protected or encrypted, so it cannot be signed. Save or export an unprotected copy and upload that.";
export const OFFER_UNREADABLE = "This file could not be read as a PDF. Export the offer letter as a PDF again and upload that.";
/** The consent the applicant agrees to. Fixed here (never taken from the browser) and stored with the signature. */
export const OFFER_CONSENT = "I have read this offer letter and accept it. I agree that typing my full name and selecting Sign is my electronic signature.";

const isPdf = (bytes: Uint8Array) => bytes.length > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";

/**
 * Checks an uploaded offer before it is stored: a real PDF by content, not encrypted or protected, and one pdf-lib can load
 * AND modify (a page is added and the result saved, in memory only), so signing it later cannot fail on the file.
 */
export async function inspectOfferPdf(lib: PdfLib, bytes: Uint8Array): Promise<{ ok: true; pages: number } | { ok: false; error: string }> {
  if (bytes.length < 1 || bytes.length > MAX_OFFER_BYTES) return { ok: false, error: "The offer letter must be a PDF of 7 MB or smaller." };
  if (!isPdf(bytes)) return { ok: false, error: "Upload the offer letter as a PDF." };
  // deno-lint-ignore no-explicit-any
  let doc: any;
  try {
    doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    return { ok: false, error: /encrypt/i.test(String((error as Error)?.message ?? error)) ? OFFER_ENCRYPTED : OFFER_UNREADABLE };
  }
  if (doc.isEncrypted) return { ok: false, error: OFFER_ENCRYPTED };
  let pages = 0;
  try { pages = doc.getPageCount(); } catch { return { ok: false, error: OFFER_UNREADABLE }; }
  if (pages < 1) return { ok: false, error: OFFER_UNREADABLE };
  try {
    const page = doc.addPage();
    const font = await doc.embedFont(lib.StandardFonts.Helvetica);
    page.drawText("check", { x: 50, y: 50, size: 10, font });
    await doc.save();
  } catch {
    return { ok: false, error: "This PDF cannot be changed (it may be protected), so it cannot be signed. Export an unprotected copy and upload that." };
  }
  return { ok: true, pages };
}

export interface Signature { signerName: string; signedAt: string; ip: string | null; userAgent: string | null; consent: string; offerFilename: string; offerSha256: string }

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (let word of pdfSafe(text).split(" ")) {
    while (word.length > max) { if (line) { out.push(line); line = ""; } out.push(word.slice(0, max)); word = word.slice(max); }
    if (!line) line = word;
    else if ((line + " " + word).length <= max) line += " " + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

/** The original offer with one signature page added at the end. Every original page is kept unchanged. */
export async function stampSignedOffer(lib: PdfLib, original: Uint8Array, sig: Signature): Promise<Uint8Array> {
  const doc = await lib.PDFDocument.load(original, { updateMetadata: false });
  const page = doc.addPage([595.28, 841.89]);
  const regular = await doc.embedFont(lib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(lib.StandardFonts.HelveticaBold);
  const ink = lib.rgb(0.1, 0.1, 0.1), muted = lib.rgb(0.35, 0.35, 0.35);
  let y = 780;
  const write = (text: string, opts: { size?: number; font?: unknown; color?: unknown; gap?: number } = {}) => {
    const size = opts.size ?? 10;
    for (const part of wrap(text, Math.floor(495 / (size * 0.5)))) {
      page.drawText(part, { x: 50, y, size, font: opts.font ?? regular, color: opts.color ?? ink });
      y -= size * 1.45;
    }
    y -= opts.gap ?? 4;
  };
  write("Electronic signature", { size: 16, font: bold, gap: 10 });
  write("This page was added when the offer letter above was signed through a personal link sent by Skyline Institute of Technology.", { color: muted, gap: 12 });
  const rows: Array<[string, string]> = [
    ["Signed by (typed name)", sig.signerName],
    ["Signed at (UTC)", sig.signedAt],
    ["IP address", sig.ip ?? "not available"],
    ["Browser", sig.userAgent ?? "not available"],
    ["Offer letter", sig.offerFilename],
    ["Offer letter SHA-256", sig.offerSha256],
  ];
  for (const [label, value] of rows) { write(label, { size: 9, font: bold, color: muted, gap: 0 }); write(value, { gap: 8 }); }
  write("Agreement", { size: 9, font: bold, color: muted, gap: 0 });
  write(sig.consent, { gap: 8 });
  doc.setSubject(pdfSafe(`Offer letter signed by ${sig.signerName}`).slice(0, 200));
  return await doc.save();
}
