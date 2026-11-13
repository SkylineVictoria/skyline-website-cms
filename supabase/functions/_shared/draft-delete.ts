// Deleting draft applications: the database steps and the storage step are coordinated here so a failed storage removal never leaves files
// without their application, or an application without its files. Pure; the Edge Function supplies the port.

export const MAX_BULK_DELETE = 50;

export type StoredObject = { bucket: string; path: string; filename?: string };
export type Prepared = { reference: string; count: number; documents: StoredObject[] };

/** A step failed with text that is safe to show (a rule such as "withdraw instead") or a generic one. */
export class DeleteStepError extends Error {}

export interface DeletePort {
  /** Checks the rules, revokes guest links, cancels extraction jobs and lists the objects. Deletes nothing. */
  prepare(applicationId: string): Promise<Prepared>;
  /** Removes the objects with the service role. Objects that are already gone count as removed. On failure, says which paths could not be removed. */
  removeObjects(bucket: string, paths: string[]): Promise<{ ok: true } | { ok: false; failed: string[] }>;
  /** Re-checks the document set, removes the rows, writes the audit row. */
  finalize(applicationId: string, expectedDocuments: number): Promise<{ reference: string; documents: number }>;
}

export type DeleteOutcome =
  | { id: string; ok: true; reference: string; documents: number }
  | { id: string; ok: false; error: string; failedFiles?: string[] };

/** Only objects under <applicationId>/ in the documents bucket may be removed through this flow. */
export function validStoragePath(applicationId: string, object: StoredObject): boolean {
  const segments = object.path.split("/");
  // eslint-disable-next-line no-control-regex -- storage paths must not contain control characters
  return object.bucket === "enrollment-documents" && segments.length >= 2 && segments[0] === applicationId && !segments.some((s) => !s || s === "." || s === "..") && !/[\\%\u0000-\u001f]/.test(object.path);
}

export async function deleteDraft(port: DeletePort, applicationId: string): Promise<DeleteOutcome> {
  let prepared: Prepared;
  try { prepared = await port.prepare(applicationId); } catch (error) {
    return { id: applicationId, ok: false, error: error instanceof DeleteStepError ? error.message : "This draft can't be deleted." };
  }
  if (prepared.documents.some((object) => !validStoragePath(applicationId, object))) return { id: applicationId, ok: false, error: "A document has an unexpected storage location, so the draft was kept." };
  const names = new Map(prepared.documents.map((object) => [object.path, object.filename || "a document"]));
  const byBucket = new Map<string, string[]>();
  for (const object of prepared.documents) byBucket.set(object.bucket, [...(byBucket.get(object.bucket) ?? []), object.path]);
  for (const [bucket, paths] of byBucket) {
    // If any removal fails the application row is kept, so nothing is orphaned; the owner can try again.
    const removed = await port.removeObjects(bucket, paths);
    if (removed.ok === false) {
      const failedFiles = (removed.failed.length ? removed.failed : paths).map((path) => names.get(path) ?? "a document");
      return { id: applicationId, ok: false, error: "Some files could not be removed, so the draft was kept. Please try again.", failedFiles };
    }
  }
  try {
    const done = await port.finalize(applicationId, prepared.count);
    return { id: applicationId, ok: true, reference: done.reference, documents: done.documents };
  } catch (error) {
    return { id: applicationId, ok: false, error: error instanceof DeleteStepError ? error.message : "The files were removed but the draft could not be deleted. Please try again." };
  }
}

export async function deleteDrafts(port: DeletePort, ids: unknown): Promise<DeleteOutcome[] | { error: string }> {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) return { error: "Choose the drafts to delete." };
  const unique = Array.from(new Set(ids as string[]));
  if (unique.length > MAX_BULK_DELETE) return { error: `Choose at most ${MAX_BULK_DELETE} drafts at a time.` };
  const outcomes: DeleteOutcome[] = [];
  for (const id of unique) outcomes.push(await deleteDraft(port, id));
  return outcomes;
}
