// Offer letters (HR-02e): checking an uploaded offer PDF and adding the signature page when it is signed. The signature page is drawn with
// the shared Skyline PDF styling (notification/pdf-layout.ts), the same as the offer letter and the submitted application PDF. Runtime-neutral:
// pdf-lib comes from the function's import map (Deno) or node_modules (offline tests). The PDFs exist only in memory here; nothing is logged.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PdfWriter, type Row } from "./notification/pdf-layout.ts";
import { formatDateTime } from "./notification/submission-pdf.ts";
import { institutionTimeZone } from "./time-zone.ts";
import { paletteOf } from "./offer-letter-pdf.ts";
import { DEFAULT_INSTITUTION, type Letterhead } from "./letterhead.ts";
import { MAX_OFFER_BYTES, OFFER_ENCRYPTED, OFFER_UNREADABLE, type Signature } from "./offer-rules.ts";

// The limits, messages and the signature record live in offer-rules.ts (no PDF engine), so the functions import them at boot and load
// this module only when a request makes or signs a PDF.
export { MAX_OFFER_BYTES, OFFER_CONSENT, OFFER_ENCRYPTED, OFFER_UNREADABLE, type Signature } from "./offer-rules.ts";

const isPdf = (bytes: Uint8Array) => bytes.length > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";

/**
 * Checks an uploaded offer before it is stored: a real PDF by content, not encrypted or protected, and one pdf-lib can load
 * AND modify (a page is added and the result saved, in memory only), so signing it later cannot fail on the file.
 */
export async function inspectOfferPdf(bytes: Uint8Array, maxBytes: number = MAX_OFFER_BYTES): Promise<{ ok: true; pages: number } | { ok: false; error: string }> {
  // maxBytes: Business Rules signing.pdf_upload_max_mib for documents sent for signing; 7 MB otherwise. Never above what the request reader takes.
  const max = Math.min(MAX_OFFER_BYTES, maxBytes > 0 ? maxBytes : MAX_OFFER_BYTES);
  if (bytes.length < 1 || bytes.length > max) return { ok: false, error: `The offer letter must be a PDF of ${Math.round(max / 1048576 * 10) / 10} MB or smaller.` };
  if (!isPdf(bytes)) return { ok: false, error: "Upload the offer letter as a PDF." };
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    return { ok: false, error: /encrypt/i.test(String((error as Error)?.message ?? error)) ? OFFER_ENCRYPTED : OFFER_UNREADABLE };
  }
  if (doc.isEncrypted) return { ok: false, error: OFFER_ENCRYPTED };
  let pages = 0;
  try { pages = doc.getPageCount(); } catch { return { ok: false, error: OFFER_UNREADABLE }; }
  if (pages < 1) return { ok: false, error: OFFER_UNREADABLE };
  try {
    const page = doc.addPage();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("check", { x: 50, y: 50, size: 10, font });
    await doc.save();
  } catch {
    return { ok: false, error: "This PDF cannot be changed (it may be protected), so it cannot be signed. Export an unprotected copy and upload that." };
  }
  return { ok: true, pages };
}

/** Accents folded and anything else printable-ASCII-unsafe replaced, for PDF metadata (the page text itself uses the embedded font). */
const metaSafe = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "?");

/**
 * The original offer with one signature page added at the end, on the shared letterhead and styling. Every original page is kept unchanged;
 * the page is numbered after them ("Page 3 of 3").
 */
export async function stampSignedOffer(original: Uint8Array, sig: Signature, letterhead?: Letterhead | null): Promise<Uint8Array> {
  const institution = letterhead?.institution?.trim() || DEFAULT_INSTITUTION;
  const writer = await PdfWriter.open(original, paletteOf(letterhead?.primary));
  let logo = letterhead?.logo ?? null;
  if (logo) { try { await writer.prepareImage(logo); } catch { logo = null; } }
  const signed = formatDateTime(sig.signedAt) || sig.signedAt;
  let drawn: { bytes: Uint8Array; type: "png" } | null = sig.image?.length ? { bytes: sig.image, type: "png" } : null;
  if (drawn) { try { await writer.prepareImage(drawn); } catch { drawn = null; } }
  writer.header({ institution, logo, title: "Electronic signature", meta: ["Signature page", `Signed ${signed}`] });
  writer.block([{ spans: [{ text: `This page was added when the offer letter above was signed through a personal link sent by ${institution}.`, tone: "muted" }] }], 10);
  const rows: Row[] = [
    // OFFER-SIGNATURES (owner 2026-11-24): the employee's own signature and the date, as on a signed paper letter.
    ...(drawn ? [{ label: "Employee signature", paras: [{ spans: [], image: drawn }] }] : []),
    { label: "Signed by (typed name)", paras: [{ spans: [{ text: sig.signerName }], bold: true }] },
    { label: "Date signed", paras: [{ spans: [{ text: (formatDateTime(sig.signedAt) || sig.signedAt).split(" ")[0] }] }] },
    { label: "Signed at", paras: [{ spans: [{ text: `${signed} (${institutionTimeZone()})` }] }, { spans: [{ text: `${sig.signedAt} UTC`, tone: "muted" }] }] },
    // No IP address, browser or file hash on the signed copy (owner 2026-11-20): they are kept in the database (hr_svc_offer_sign) as evidence.
    { label: "Offer letter", paras: [{ spans: [{ text: sig.offerFilename }] }] },
    { label: "Agreement", paras: [{ spans: [{ text: sig.consent }], check: true }] },
  ];
  writer.section("Signature details", rows);
  writer.footers(institution, "Signed offer letter");
  writer.pdf.setSubject(metaSafe(`Offer letter signed by ${sig.signerName}`).slice(0, 200));
  return await writer.save();
}
