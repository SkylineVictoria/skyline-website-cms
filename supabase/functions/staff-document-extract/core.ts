// Reads one staff document and records the result. Runtime-neutral (no Deno globals) so the offline tests run it with the shared
// deterministic mock provider. It reuses the student flow's provider adapters and envelope (supabase/functions/_shared/
// document-extraction) but none of its job queue: a staff document is read once, in-process, and the outcome goes to
// hr.staff_documents through a port. portal-document-extract and its lease fencing are not involved.
import { buildExtractionEnvelope, isSupportedDocument, type DocumentExtractionProvider, type ExtractionCategory } from "../_shared/document-extraction/contract.ts";

/** hr.staff_documents.category -> the reader's document category. */
export const STAFF_READER_CATEGORY: Record<string, ExtractionCategory> = {
  Passport: "Passport", Visa: "Visa", "Driving Licence": "Driving Licence", PTE: "English Test", "English Certificate": "English Test",
};

export const STAFF_MAX_BYTES = 10 * 1024 * 1024;

export interface StaffDocument { id: string; category: string; filename: string; mimeType: string }
export type StaffExtractionStatus = "processing" | "done" | "no_fields" | "failed" | "unavailable";

export interface StaffExtractionPort {
  /** Records the outcome (hr_staff_document_apply_extraction). Only status "done" fills empty profile fields. */
  apply(status: StaffExtractionStatus, extracted: Record<string, string>, error?: string): Promise<void>;
  /** The private file's bytes, or null when it is no longer there. */
  download(): Promise<Uint8Array | null>;
}

export async function runStaffExtraction(doc: StaffDocument, provider: DocumentExtractionProvider | null, port: StaffExtractionPort, signal: AbortSignal = new AbortController().signal): Promise<StaffExtractionStatus> {
  const category = STAFF_READER_CATEGORY[doc.category];
  if (!category) { await port.apply("failed", {}, "This document type cannot be read automatically."); return "failed"; }
  if (!provider) { await port.apply("unavailable", {}, "Automatic reading is not switched on. Enter your details yourself."); return "unavailable"; }
  await port.apply("processing", {});
  const bytes = await port.download().catch(() => null);
  if (!bytes) { await port.apply("failed", {}, "The uploaded file could not be found. Upload it again."); return "failed"; }
  if (!bytes.length || bytes.length > STAFF_MAX_BYTES || !isSupportedDocument(bytes, doc.mimeType, doc.filename)) {
    await port.apply("failed", {}, "The document must be a valid PDF, JPG or PNG no larger than 10 MB."); return "failed";
  }
  const outcome = await provider.extract({ bytes, mimeType: doc.mimeType, filename: doc.filename, category, jobId: doc.id, attempt: 1, signal });
  if (!outcome.ok) { await port.apply("failed", {}, outcome.message); return "failed"; }
  // A wrong kind of document is kept as an outcome but never fills anything (the envelope empties it).
  const envelope = buildExtractionEnvelope(provider, outcome, new Date().toISOString());
  const status: StaffExtractionStatus = envelope.status === "unreviewed" ? "done" : "no_fields";
  await port.apply(status, envelope.extracted, envelope.source.categoryMismatch ? "This does not look like the document type you chose." : undefined);
  return status;
}
