// The offer letter's limits, messages and the signature record: a small module with no PDF engine behind it, so the functions can
// import these at boot and load the PDF code (offer-pdf.ts, offer-letter-pdf.ts, which carry pdf-lib and the embedded fonts) only when a
// request actually makes or signs a PDF.

/** Offers are emailed back signed, so they must stay under Postmark's 10 MB message limit after base64 (x1.37) and the page. */
export const MAX_OFFER_BYTES = 7 * 1024 * 1024;
export const OFFER_ENCRYPTED = "This PDF is password-protected or encrypted, so it cannot be signed. Save or export an unprotected copy and upload that.";
export const OFFER_UNREADABLE = "This file could not be read as a PDF. Export the offer letter as a PDF again and upload that.";
/** The consent the applicant agrees to. Fixed here (never taken from the browser) and stored with the signature. */
export const OFFER_CONSENT = "I have read this offer letter and accept it. I agree that typing my full name and selecting Sign is my electronic signature.";

export interface Signature { signerName: string; signedAt: string; ip: string | null; userAgent: string | null; consent: string; offerFilename: string; offerSha256: string }

/** A safe PDF file name for a letter: "Offer of employment - Asha Patel.pdf". */
export function letterFileName(title: string, person: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from a file name
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  const base = [clean(title).slice(0, 100), clean(person).slice(0, 80)].filter(Boolean).join(" - ") || "Offer letter";
  return `${base}.pdf`;
}
