/**
 * UPLOAD-FIRST Add assessment (owner 2026-11-26): the workbook PDF chosen in the Add assessment dialog, handed to the new assessment's
 * PDF template tab, which uploads it, finds its fields and runs the unit check as if it had been chosen there. Kept in memory only
 * (one page session): after a reload the tab simply asks for the PDF again.
 */
const pending = new Map<string, File>();

export function setPendingWorkbook(assessmentId: string, file: File): void { pending.set(assessmentId, file); }

/** The workbook waiting for this assessment, taken once (null when none). */
export function takePendingWorkbook(assessmentId: string): File | null {
  const file = pending.get(assessmentId) ?? null;
  pending.delete(assessmentId);
  return file;
}
