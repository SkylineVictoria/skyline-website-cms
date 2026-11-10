import type { DocumentToClassify } from "./document-extraction/classify.ts";
import type { DocumentOwnership } from "./document-ownership.ts";
// One upload from one guest step: the step's category is stored as is and extraction is queued immediately as that type.
// Pure orchestration over a port, so the rules (category from the step, replace, limits, queue, dispatch) are tested without a database.
import { isGuestCategory, MAX_GUEST_DOCUMENTS, MULTIPLE_CATEGORIES } from "./guest-link.ts";

export interface UploadPort {
  checkOwnership(document: DocumentToClassify): Promise<DocumentOwnership>;
  /** Documents of this link already in the category: [{ id, sha256 }]. */
  existing(category: string): Promise<Array<{ id: string; sha256: string }>>;
  countAll(): Promise<number>;
  store(path: string, bytes: Uint8Array, mime: string): Promise<boolean>;
  /** Inserts the document row with the extraction metadata (status queued); returns its id. */
  insert(row: { category: string; storagePath: string; filename: string; mime: string; size: number; sha256: string; passportId: string | null }): Promise<string | null>;
  discardObject(path: string): Promise<void>;
  /** Queues extraction for the document; returns the job to dispatch. */
  enqueue(documentId: string): Promise<{ id?: string; tenant_id?: string | null } | null>;
  dispatch(job: { id?: string; tenant_id?: string | null }): void;
  /** Cancels jobs, removes the object and the row. */
  remove(documentId: string): Promise<void>;
}

export type UploadInput = { category: unknown; replaceId?: string | null; name: string; mime: string; bytes: Uint8Array; sha256: string; storagePath: string };
export type UploadOutcome = { ok: true; documentId: string; queued: boolean } | { ok: false; status: number; error: string };

export async function runGuestUpload(port: UploadPort, input: UploadInput): Promise<UploadOutcome> {
  // The step decides the category. There is no "Other" and no guessing from the file name.
  if (!isGuestCategory(input.category)) return { ok: false, status: 400, error: "Request not understood." };
  const category = input.category;
  const ownership = await port.checkOwnership({ category, bytes: input.bytes, mime: input.mime, filename: input.name, australianVisaOnly: true });
  if (!ownership.ok) return ownership;
  const same = await port.existing(category);
  const duplicate = same.find((doc) => doc.sha256 === input.sha256);
  if (duplicate) return { ok: true, documentId: duplicate.id, queued: false };
  if ((await port.countAll()) >= MAX_GUEST_DOCUMENTS) return { ok: false, status: 429, error: "Upload limit reached. Please contact your agent." };
  if (!(await port.store(input.storagePath, input.bytes, input.mime))) return { ok: false, status: 503, error: "The upload didn't finish. Please try again." };
  const documentId = await port.insert({ category, storagePath: input.storagePath, filename: input.name, mime: input.mime, size: input.bytes.length, sha256: input.sha256, passportId: ownership.passportId });
  if (!documentId) { await port.discardObject(input.storagePath); return { ok: false, status: 503, error: "The upload didn't finish. Please try again." }; }
  const job = await port.enqueue(documentId);
  if (job) port.dispatch(job);
  // Replace rules: a single-file step keeps only the new file; the Academic step replaces just the file the student chose to replace.
  const replace = MULTIPLE_CATEGORIES.includes(category) ? same.filter((doc) => doc.id === input.replaceId) : same;
  for (const old of replace) await port.remove(old.id);
  return { ok: true, documentId, queued: Boolean(job) };
}
