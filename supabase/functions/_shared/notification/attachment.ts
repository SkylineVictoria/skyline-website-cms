// Email attachment helpers with no PDF engine behind them, so the mail code can import them at boot; submission-pdf.ts re-exports them.

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const attachmentFileName = (reference: string) => `application-${reference.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "submitted"}.pdf`;
/** {reference}-{surname}.pdf for the admin download. */
export const adminPdfFileName = (reference: string, surname: string) => `${[reference, surname].map((p) => String(p ?? "").normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 40)).filter(Boolean).join("-") || "application"}.pdf`;
