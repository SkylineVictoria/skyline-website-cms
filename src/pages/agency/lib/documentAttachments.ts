/** The persisted document category for each file input in the agency form. */
export const DOCUMENT_FIELD_CATEGORIES: Record<string, string> = {
  passport_copy: "Passport",
  visa_copy: "Visa",
  english_upload: "English Test",
  academic_upload: "Academic",
};

export function documentCategoryForField(fieldName: string): string | null {
  return DOCUMENT_FIELD_CATEGORIES[fieldName] ?? null;
}

/** DOCUMENT-CARRY: "From your previous application (SLIT-2026-0126)" for a document copied from the student's earlier application. */
export function carriedFromLabel(metadata: Record<string, unknown> | undefined): string | null {
  const carried = metadata?.carriedFrom as { reference?: unknown; documentId?: unknown } | undefined;
  if (!carried || typeof carried !== "object" || !carried.documentId) return null;
  const reference = typeof carried.reference === "string" && carried.reference.trim() ? ` (${carried.reference.trim()})` : "";
  return `From your previous application${reference}`;
}

export function extractionStatus(metadata: Record<string, unknown>): string {
  const extraction = metadata.extraction as { status?: unknown } | undefined;
  return typeof extraction?.status === "string" && extraction.status ? extraction.status : "Not requested";
}
