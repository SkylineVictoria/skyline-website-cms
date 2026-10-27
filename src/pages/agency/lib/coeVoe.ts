/** Pure rules for the CoE / VoE upload and issue step (the database enforces the same; this only avoids pointless round trips). */

export const MAX_COE_BYTES = 3 * 1024 * 1024;
export const COE_KINDS = [{ value: "coe", label: "CoE" }, { value: "voe", label: "VoE" }] as const;
export type CoeKind = (typeof COE_KINDS)[number]["value"];

export function validatePdfFile(file: { name: string; size: number }): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,110}\.pdf$/i.test(file.name.trim())) return "Choose a .pdf file with a plain name (letters, digits, spaces, dots, dashes or brackets).";
  if (file.size < 8) return "That file is empty.";
  if (file.size > MAX_COE_BYTES) return "The PDF must be 3 MB or smaller.";
  return null;
}

/** Content check on the first and last bytes, so a renamed non-PDF is caught before upload. */
export function validatePdfBytes(bytes: Uint8Array): string | null {
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head !== "%PDF-") return "That file is not a PDF.";
  const tail = String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 1024)));
  if (!tail.includes("%%EOF")) return "That PDF looks incomplete (no end-of-file marker).";
  return null;
}

/** Why "Approve and issue" is unavailable; an empty list means it can be pressed. */
export function issueBlockers(input: { applicationStatus: string; registrationState: string | null | undefined; hasDocument: boolean; issued: boolean }): string[] {
  const blockers: string[] = [];
  if (input.issued) return ["The CoE / VoE has already been issued."];
  if (input.applicationStatus !== "offer_accepted") blockers.push("The offer must be accepted before the CoE / VoE is issued.");
  if (input.registrationState !== "verified") blockers.push("Verify the registration first.");
  if (!input.hasDocument) blockers.push("Upload the CoE or VoE PDF first.");
  return blockers;
}

export function coeErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  if (error?.code === "42501") return "You do not have permission to do that.";
  if (error?.code === "22023" || error?.code === "P0002") return error.message || "That request was not accepted.";
  return "The change could not be saved. Please try again.";
}
