import { useEffect, useRef, useState } from "react";
import type { AppField } from "@/data/applicationForms";
import { MAX_DOCUMENT_BYTES, type DocumentRow as StoredDocument } from "@/pages/agency/lib/portalApplications";
import { extractionStatus } from "@/pages/agency/lib/documentAttachments";
import DocumentReadingState from "@/components/shared/application-form/DocumentReadingState";
import { DocumentRow, Dropzone, ReadFailure, RowAction, type Pill } from "@/components/shared/application-form/DocumentUpload";

interface Props {
  field: AppField;
  documents: StoredDocument[];
  disabled: boolean;
  busyDocumentId: string;
  onUpload: (files: FileList | null) => Promise<void>;
  onPreview: (document: StoredDocument) => Promise<void>;
  onExtract: (document: StoredDocument) => Promise<void>;
  onDelete: (document: StoredDocument) => Promise<void>;
}

/** The status pill for a stored file: what the document reader has done with it. */
function pillFor(document: StoredDocument, state: string): Pill {
  const extraction = document.metadata.extraction as { error?: { message?: unknown } } | undefined;
  if (state === "unreviewed" || state === "done" || state === "confirmed") return { text: "Ready for review", tone: "ready" };
  if (state === "no_fields") return { text: "No details found", tone: "warn" };
  if (state === "failed") return { text: "Couldn’t read", tone: "failed", title: typeof extraction?.error?.message === "string" ? extraction.error.message : undefined };
  if (state === "cancelled") return { text: "Cancelled", tone: "neutral" };
  if (state === "Not requested") return { text: "Uploaded", tone: "neutral" };
  return { text: state, tone: "neutral" };
}

const ACCEPT = ".pdf,.jpg,.jpeg,.png";
const isReading = (state: string) => state === "queued" || state === "processing";

/**
 * A document on the form: a compact dropzone; while a file uploads and is read, DocumentReadingState; then one compact row (name,
 * status pill, view / read again / replace / delete). A failed reading offers Try again and Fill manually and never blocks the form.
 */
export default function ApplicationAttachmentField({ field, documents, disabled, busyDocumentId, onUpload, onPreview, onExtract, onDelete }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<StoredDocument | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<StoredDocument | null>(null);
  const [error, setError] = useState("");
  // Files picked here (for the thumbnail while they are read) and those still uploading.
  const [picked, setPicked] = useState<Map<string, File>>(() => new Map());
  const [uploading, setUploading] = useState<File[]>([]);
  // Failed readings the agent chose to fill in by hand: the row stays, the failure line goes.
  const [manual, setManual] = useState<Set<string>>(() => new Set());
  const allowAdditional = Boolean(field.multiple);
  const maxMb = Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024);

  /** The same upload as always; the files are only remembered here for the reading panel. */
  const send = async (files: FileList | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length) {
      setPicked((prev) => new Map([...prev, ...list.map((file) => [file.name, file] as const)]));
      setUploading(list);
    }
    try { await onUpload(files); } finally { setUploading([]); }
  };

  const upload = async (files: FileList | null) => {
    setError("");
    try { await send(files); if (inputRef.current) inputRef.current.value = ""; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Document upload failed."); }
  };

  // The documents as last rendered: Replace checks that the new file really arrived before it removes the old one.
  const documentsRef = useRef(documents);
  useEffect(() => { documentsRef.current = documents; }, [documents]);

  // Replace: the new file is uploaded first; the old one is deleted only once a new document is listed (the same upload and delete
  // as always). Some callers report a refused upload as a note instead of an error, so a missing new document means "keep the old one".
  const replace = async (files: FileList | null) => {
    const old = replacing;
    setReplacing(null);
    if (!old || !files?.length) return;
    setError("");
    const before = new Set(documentsRef.current.map((document) => document.id));
    try {
      await send(files);
      // Let the page take in the new document before the old one goes, so the step never looks empty in between.
      await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      const arrived = documentsRef.current.some((document) => !before.has(document.id));
      if (arrived && documentsRef.current.some((document) => document.id === old.id)) await onDelete(old);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The document could not be replaced."); }
    finally { if (replaceRef.current) replaceRef.current.value = ""; }
  };

  const deleteDocument = async () => {
    if (!deleteCandidate) return;
    setError("");
    try { await onDelete(deleteCandidate); setDeleteCandidate(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Document deletion failed."); }
  };

  const preview = async (document: StoredDocument) => {
    setError("");
    try { await onPreview(document); } catch (cause) { setError(cause instanceof Error ? cause.message : "Document preview failed."); }
  };

  const extract = async (document: StoredDocument) => {
    setError("");
    setManual((prev) => { const next = new Set(prev); next.delete(document.id); return next; });
    try { await onExtract(document); } catch (cause) { setError(cause instanceof Error ? cause.message : "Extraction request failed."); }
  };

  const fillManually = (document: StoredDocument) => {
    setManual((prev) => new Set(prev).add(document.id));
    // Straight to the first empty answer on this step.
    window.requestAnimationFrame(() => {
      const empty = Array.from(globalThis.document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-current-step="true"] [data-field] :is(input:not([type=hidden]):not([type=file]):not(.sr-only), select)'))
        .find((control) => !control.disabled && !control.value.trim());
      empty?.focus();
    });
  };

  return (
    <div className="space-y-1.5">
      {uploading.map((file) => <DocumentReadingState key={`up-${file.name}`} filename={file.name} file={file} phase="uploading" />)}
      {documents.map((document) => {
        const state = extractionStatus(document.metadata);
        if (isReading(state)) return <DocumentReadingState key={document.id} filename={document.filename} file={picked.get(document.filename)} phase={state as "queued" | "processing"} />;
        const working = busyDocumentId === document.id;
        const failed = (state === "failed" || state === "no_fields") && !manual.has(document.id);
        return (
          <DocumentRow
            key={document.id}
            filename={document.filename}
            pill={pillFor(document, state)}
            actions={
              <>
                <RowAction title="View" icon="ri-eye-line" label={`Preview ${document.filename}`} disabled={working} onClick={() => void preview(document)} />
                <RowAction title="Read again" icon="ri-refresh-line" label={`Extract or retry ${document.filename}`} busy={working} disabled={disabled || working} onClick={() => void extract(document)} />
                <RowAction title="Replace" icon="ri-upload-2-line" label={`Replace ${document.filename}`} disabled={disabled || working} onClick={() => { setReplacing(document); replaceRef.current?.click(); }} />
                <RowAction title="Delete" icon="ri-delete-bin-line" label={`Delete ${document.filename}`} disabled={disabled || working} onClick={() => setDeleteCandidate(document)} />
              </>
            }
          >
            {failed ? (
              <ReadFailure
                message={state === "no_fields" ? "We couldn’t find any details on this one." : "We couldn’t read this one."}
                onRetry={disabled ? undefined : () => void extract(document)}
                onManual={() => fillManually(document)}
              />
            ) : null}
          </DocumentRow>
        );
      })}

      {documents.length > 0 && allowAdditional ? (
        <label className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground-600 transition-colors hover:bg-background-100 hover:text-foreground-900">
          <i className="ri-add-line text-base leading-none" aria-hidden="true" />
          Add more files
          <input ref={inputRef} name={field.name} type="file" accept={ACCEPT} multiple disabled={disabled} onChange={(event) => void upload(event.target.files)} className="sr-only" />
        </label>
      ) : null}

      {documents.length === 0 && uploading.length === 0 ? (
        <Dropzone
          id={`portal-file-${field.name}`}
          name={field.name}
          label={field.multiple ? "Choose files or drop them here" : "Choose a file or drop it here"}
          hint={`PDF, JPG or PNG · max ${maxMb} MB`}
          multiple={field.multiple}
          disabled={disabled}
          accept={ACCEPT}
          inputRef={inputRef}
          onFiles={(files) => void upload(files)}
        />
      ) : null}

      <input ref={replaceRef} type="file" accept={ACCEPT} disabled={disabled} tabIndex={-1} aria-hidden="true" onChange={(event) => void replace(event.target.files)} className="sr-only" />
      {error ? <p className="text-xs text-red-700" role="alert">{error}</p> : null}
      {deleteCandidate ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-foreground-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="delete-attachment-title"><div className="w-full max-w-md rounded-lg bg-background-50 p-5 shadow-xl"><h3 id="delete-attachment-title" className="font-heading font-bold text-foreground-950">Delete document?</h3><p className="mt-2 text-sm text-foreground-600">Delete <strong>{deleteCandidate.filename}</strong> from this editable application? Retained or submitted documents cannot be deleted.</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setDeleteCandidate(null)} className="rounded-md border border-background-300 px-3 py-2 text-sm font-semibold">Cancel</button><button type="button" disabled={busyDocumentId === deleteCandidate.id} onClick={() => void deleteDocument()} className="rounded-md bg-primary-600 px-3 py-2 text-sm font-semibold text-background-50 disabled:opacity-50">{busyDocumentId === deleteCandidate.id ? "Deleting…" : "Delete permanently"}</button></div></div></div> : null}
    </div>
  );
}
