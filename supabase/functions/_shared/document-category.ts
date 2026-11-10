// Keep these persisted labels aligned with the document receipt trigger.
export const DOCUMENT_CATEGORIES = {
  Passport: "Passport",
  Academic: "Academic",
  "Driving Licence": "Driving Licence",
  Visa: "Visa",
  English: "English Evidence",
  "English Test": "English Evidence",
  "English Certificate": "English Evidence",
  PTE: "PTE",
  "Health Insurance": "Health Insurance",
} as const;

export function checkedDocumentCategory(category: string): boolean {
  return Object.hasOwn(DOCUMENT_CATEGORIES, category);
}

/** The migration reserves this filename prefix for uploads from trusted functions. */
export function hasValidatedDocumentPath(path: string): boolean {
  return path.split("/").at(-1)?.startsWith("validated-") ?? false;
}
