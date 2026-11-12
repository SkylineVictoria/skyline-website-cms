import { useEffect, useRef, useState, type DragEvent } from "react";
import { expiryMessage, expiryTone, getDocumentExpiryStatus } from "@/pages/agency/lib/documentExpiry";
import type { PendingUpload, WizardDoc, WizardStep } from "@/pages/agency/lib/wizardConfig";
import { DOCUMENT_ACCEPT } from "../../../../supabase/functions/_shared/validation/person";
import DocumentReadingState from "@/components/shared/application-form/DocumentReadingState";
import { DocumentRow, Dropzone, ReadFailure } from "@/components/shared/application-form/DocumentUpload";
import Toast from "@/components/shared/application-form/Toast";
import { useToast } from "@/components/shared/application-form/useToast";

/**
 * One document screen of a wizard: the upload area, then, per file, the shared reading panel (DocumentReadingState, as on the
 * application form) while it uploads and is read, and a compact row once it is (status pill, View, Replace, Delete; a failure
 * offers Try again and Fill manually). Used by the student "Add New Form" wizard and by staff onboarding.
 * Opt-in extras (staff onboarding switches them on; without them the screen is exactly the student one):
 *   dropzone: files can be dragged onto the screen;  camera: a "Take a photo" button on phones and tablets;
 *   a PendingUpload with `progress` (0 to 1) shows a progress bar while it uploads.
 */

interface Props {
  step: WizardStep;
  docs: WizardDoc[];
  /** Files picked on this step that are uploading, or whose upload failed. */
  pending: PendingUpload[];
  /** Documents whose failed reading the agent chose to enter manually later. */
  dismissed: Set<string>;
  onPickFiles: (files: FileList | null) => void;
  onRetryUpload: (upload: PendingUpload) => void;
  onDropUpload: (upload: PendingUpload) => void;
  onRetryDoc: (doc: WizardDoc) => void;
  onDismissDoc: (doc: WizardDoc) => void;
  onRemoveDoc: (doc: WizardDoc) => Promise<void>;
  /** Records the view first where access is audited (SLIT staff); a failure blocks opening the file. */
  logView?: (doc: WizardDoc) => Promise<void>;
  /** A short-lived link to open a stored file (each caller knows its own private bucket). */
  signedUrl: (doc: WizardDoc) => Promise<string>;
  /** Files can be dragged onto this screen. */
  dropzone?: boolean;
  /** Offers "Take a photo" on phones and tablets (the device camera, saved as a JPG). */
  camera?: boolean;
  /** The form's label for a value read from the document; given, the values read are listed under the file. */
  fieldLabel?: (key: string) => string | undefined;
}


/** Informational only: shown once a passport, visa or English result has been read. */
function expiryNote(step: WizardStep, doc: WizardDoc): { text: string; tone: string } | null {
  if ((step.id !== "passport" && step.id !== "visa" && step.id !== "english") || doc.extraction !== "done" || !doc.extracted) return null;
  const expiry = getDocumentExpiryStatus(step.id, doc.extracted);
  const text = expiryMessage(step.id, expiry);
  return text ? { text, tone: expiryTone(expiry.status) } : null;
}

export default function WizardDocumentStep({ step, docs, pending, dismissed, onPickFiles, onRetryUpload, onDropUpload, onRetryDoc, onDismissDoc, onRemoveDoc, logView, signedUrl, dropzone, camera, fieldLabel }: Props) {
  const [dragging, setDragging] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<WizardDoc | null>(null);
  const [removing, setRemoving] = useState("");
  const [removeError, setRemoveError] = useState("");
  const toast = useToast();
  const showToast = toast.show;

  const uploading = pending.some((item) => !item.error);
  const hasFile = docs.length > 0 || pending.length > 0;

  const [viewing, setViewing] = useState("");
  const [preview, setPreview] = useState<{ doc: WizardDoc; url: string; isPdf: boolean } | null>(null);

  // The files picked here, by name, so the reading panel can show an image while the stored copy is read.
  const pickedRef = useRef(new Map<string, File>());
  for (const item of pending) pickedRef.current.set(item.file.name, item.file);
  // A document whose reading just finished: say how much was read (a document already read when the step opened says nothing).
  const statesRef = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const before = statesRef.current;
    statesRef.current = new Map(docs.map((doc) => [doc.id, doc.extraction]));
    if (!before) return;
    const finished = docs.find((doc) => doc.extraction === "done" && (before.get(doc.id) === "queued" || before.get(doc.id) === "processing"));
    if (!finished) return;
    const count = Object.values(finished.extracted ?? {}).filter((value) => String(value ?? "").trim()).length;
    if (count) showToast(`We filled ${count} field${count === 1 ? "" : "s"} from your ${step.noun}. Please review.`);
  }, [docs, step.noun, showToast]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  const handleView = async (doc: WizardDoc) => {
    setViewing(doc.id);
    setRemoveError("");
    try {
      if (logView) await logView(doc);
      const url = await signedUrl(doc);
      const isPdf = /\.pdf$/i.test(doc.filename);
      // View only: hide the browser PDF viewer's download and print toolbar.
      setPreview({ doc, url: isPdf ? `${url}#toolbar=0&navpanes=0` : url, isPdf });
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : "The document could not be opened.");
    } finally {
      setViewing("");
    }
  };

  const handleRemove = async (doc: WizardDoc) => {
    setRemoving(doc.id);
    setRemoveError("");
    try {
      await onRemoveDoc(doc);
      setDeleteCandidate(null);
    } catch (error) {
      setDeleteCandidate(null);
      setRemoveError(error instanceof Error ? error.message : "Document deletion failed.");
    } finally {
      setRemoving("");
    }
  };

  const drop = dropzone ? {
    onDragOver: (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); if (!dragging) setDragging(true); },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); if (!uploading && event.dataTransfer.files.length) onPickFiles(event.dataTransfer.files); },
  } : {};
  const cameraButton = camera ? (
    <label className="mt-2 hidden h-10 w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-background-300 bg-background-50 px-4 text-sm font-medium text-foreground-700 transition-colors hover:border-foreground-400 hover:text-foreground-900 [@media(pointer:coarse)]:flex">
      <i className="ri-camera-line text-base" aria-hidden="true" />
      Take a photo
      <input type="file" accept="image/jpeg,image/png" capture="environment" disabled={uploading} data-testid="wizard-camera"
        onChange={(event) => { onPickFiles(event.target.files); event.target.value = ""; }} className="sr-only" />
    </label>
  ) : null;

  // One file at a time on a single-document step: Replace picks the new one (the wizard supersedes the earlier file itself).
  const replaceButton = (doc: WizardDoc) => (
    <label title="Replace" className={`flex h-8 w-8 items-center justify-center rounded-md text-foreground-600 transition-colors duration-150 hover:bg-background-100 hover:text-foreground-900 ${uploading ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
      <i className="ri-upload-2-line text-base leading-none" aria-hidden="true" />
      <span className="sr-only">Replace {doc.filename}</span>
      <input type="file" accept={DOCUMENT_ACCEPT} disabled={uploading} onChange={(event) => { onPickFiles(event.target.files); event.target.value = ""; }} className="sr-only" />
    </label>
  );

  const readValues = (doc: WizardDoc) => fieldLabel && doc.extraction === "done"
    ? Object.entries(doc.extracted ?? {}).filter(([key, value]) => String(value ?? "").trim() && fieldLabel(key)).map(([key, value]) => [fieldLabel(key) as string, String(value)] as const)
    : [];

  return (
    <div className={dragging ? "space-y-3 rounded-lg ring-2 ring-primary-400 ring-offset-4" : "space-y-3"} {...drop}>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background-100 text-foreground-600">
          <i className={`${step.icon} text-xl`} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="font-heading text-sm font-semibold text-foreground-950">{step.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground-600">{step.subtitle}</p>
        </div>
      </div>

      {docs.length === 0 && !uploading ? (
        <div>
          <Dropzone
            label={step.multiple ? "Upload files" : "Upload file"}
            hint={`PDF, JPG or PNG · up to 10 MB${step.multiple ? " each" : ""} · stored privately`}
            multiple={step.multiple}
            disabled={uploading}
            accept={DOCUMENT_ACCEPT}
            onFiles={onPickFiles}
          />
          {cameraButton}
        </div>
      ) : null}

      {hasFile ? (
        <div className="space-y-1.5" aria-live="polite">
          {pending.map((item) => item.error ? (
            <DocumentRow key={item.key} filename={item.file.name} pill={{ text: "Not uploaded", tone: "failed" }} actions={null}>
              <ReadFailure message={item.error} onRetry={() => onRetryUpload(item)} onManual={() => onDropUpload(item)} />
            </DocumentRow>
          ) : (
            <DocumentReadingState key={item.key} filename={item.file.name} file={item.file} phase="uploading" uploadProgress={item.progress} />
          ))}
          {docs.map((doc) => {
            const reading = doc.extraction === "queued" || doc.extraction === "processing";
            if (reading) return <DocumentReadingState key={doc.id} filename={doc.filename} file={pickedRef.current.get(doc.filename)} phase={doc.extraction as "queued" | "processing"} />;
            const failed = doc.extraction === "failed" && !dismissed.has(doc.id);
            const values = readValues(doc);
            const expiry = expiryNote(step, doc);
            return (
              <DocumentRow
                key={doc.id}
                filename={doc.filename}
                pill={doc.extraction === "done" ? { text: "Ready for review", tone: "ready" }
                  : doc.extraction === "empty" ? { text: "No details found", tone: "warn", title: "Nothing readable; add the details in the form" }
                    : failed ? { text: "Couldn’t read", tone: "failed" } : { text: "Add details in the form", tone: "neutral" }}
                actions={
                  <>
                    <button type="button" onClick={() => void handleView(doc)} disabled={viewing === doc.id || !doc.storagePath} aria-label={`View ${doc.filename}`} title="View"
                      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-600 transition-colors duration-150 hover:bg-background-100 hover:text-foreground-900 disabled:opacity-50">
                      <i className={`${viewing === doc.id ? "ri-loader-4-line animate-spin" : "ri-eye-line"} text-base leading-none`} aria-hidden="true" />
                    </button>
                    {step.multiple ? null : replaceButton(doc)}
                    <button type="button" onClick={() => setDeleteCandidate(doc)} disabled={removing === doc.id} aria-label={`Remove ${doc.filename}`} title="Delete"
                      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-600 transition-colors duration-150 hover:bg-background-100 hover:text-foreground-900 disabled:opacity-50">
                      <i className={`${removing === doc.id ? "ri-loader-4-line animate-spin" : "ri-delete-bin-line"} text-base leading-none`} aria-hidden="true" />
                    </button>
                  </>
                }
              >
                {expiry ? <p className={`mt-1.5 flex items-center gap-1.5 text-xs ${expiry.tone}`}><i className="ri-time-line" aria-hidden="true" />{expiry.text}</p> : null}
                {failed ? <ReadFailure message={doc.error ?? "We couldn’t read this document."} onRetry={() => onRetryDoc(doc)} onManual={() => onDismissDoc(doc)} /> : null}
                {doc.extraction === "empty" ? <p className="mt-1.5 text-xs text-foreground-600">Nothing readable on this one; add the details in the form.</p> : null}
                {values.length ? (
                  <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-0.5 px-1 sm:grid-cols-2">
                    {values.map(([label, value], index) => (
                      <div key={label} className="field-filled grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 text-xs leading-5" style={{ animationDelay: `${index * 40}ms` }}>
                        <dt className="truncate text-foreground-500" title={label}>{label}</dt>
                        <dd className="truncate text-foreground-900" title={value}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </DocumentRow>
            );
          })}
          {step.multiple ? (
            <label className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium text-foreground-600 transition-colors hover:bg-background-100 hover:text-foreground-900 ${uploading ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
              <i className="ri-add-line text-base leading-none" aria-hidden="true" />
              Add more files
              <input type="file" accept={DOCUMENT_ACCEPT} multiple disabled={uploading} onChange={(event) => { onPickFiles(event.target.files); event.target.value = ""; }} className="sr-only" />
            </label>
          ) : null}
        </div>
      ) : null}

      {removeError ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <i className="ri-alert-line mt-px" aria-hidden="true" />
          {removeError}
        </p>
      ) : null}

      <Toast message={toast.message} onDismiss={toast.dismiss} />

      {preview ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-foreground-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Viewing ${preview.doc.filename}`}
          onClick={() => setPreview(null)}
        >
          <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-background-50 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-background-200 px-4 py-3">
              <p className="truncate font-heading text-sm font-semibold text-foreground-950">{preview.doc.filename}</p>
              <button
                type="button"
                onClick={() => setPreview(null)}
                aria-label="Close preview"
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-500 transition-colors hover:bg-background-100 hover:text-foreground-900"
              >
                <i className="ri-close-line text-lg" aria-hidden="true" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center bg-background-100" onContextMenu={(event) => event.preventDefault()}>
              {preview.isPdf ? (
                <iframe src={preview.url} title={preview.doc.filename} className="h-full w-full border-0" />
              ) : (
                <img src={preview.url} alt={preview.doc.filename} draggable={false} className="max-h-full max-w-full select-none object-contain" />
              )}
            </div>
          </div>
        </div>
      ) : null}

      {deleteCandidate ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-foreground-950/50 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg bg-background-50 p-5 shadow-xl">
            <h3 className="font-heading font-bold text-foreground-950">Delete document?</h3>
            <p className="mt-2 text-sm text-foreground-600">
              Delete <strong>{deleteCandidate.filename}</strong> permanently from this editable draft? Retained/submitted documents cannot be deleted.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteCandidate(null)} className="rounded-md border border-background-300 px-3 py-2 text-sm font-semibold">Cancel</button>
              <button
                type="button"
                disabled={removing === deleteCandidate.id}
                onClick={() => void handleRemove(deleteCandidate)}
                className="rounded-md bg-primary-600 px-3 py-2 text-sm font-semibold text-background-50 disabled:opacity-50"
              >
                {removing === deleteCandidate.id ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
