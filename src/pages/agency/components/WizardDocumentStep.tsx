import { useState } from "react";
import { expiryMessage, expiryTone, getDocumentExpiryStatus } from "@/pages/agency/lib/documentExpiry";
import { formatBytes, type PendingUpload, type WizardDoc, type WizardStep } from "@/pages/agency/lib/wizardConfig";

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
}

const CHIP = "rounded-md border border-background-200 bg-background-50 px-3 py-2 text-xs text-foreground-700";
const LINK_BUTTON = "cursor-pointer font-semibold text-primary-700 underline disabled:opacity-50";

/** Informational only: shown once a passport, visa or English result has been read. */
function expiryNote(step: WizardStep, doc: WizardDoc): { text: string; tone: string } | null {
  if ((step.id !== "passport" && step.id !== "visa" && step.id !== "english") || doc.extraction !== "done" || !doc.extracted) return null;
  const expiry = getDocumentExpiryStatus(step.id, doc.extracted);
  const text = expiryMessage(step.id, expiry);
  return text ? { text, tone: expiryTone(expiry.status) } : null;
}

function ErrorActions({ message, onRetry, onManual }: { message: string; onRetry: () => void; onManual: () => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-primary-900" role="alert">
      <span className="flex items-center gap-1.5">
        <i className="ri-alert-line" aria-hidden="true" />
        {message}
      </span>
      <button type="button" onClick={onRetry} className={LINK_BUTTON}>Retry</button>
      <button type="button" onClick={onManual} className={LINK_BUTTON}>Enter manually later</button>
    </div>
  );
}

export default function WizardDocumentStep({ step, docs, pending, dismissed, onPickFiles, onRetryUpload, onDropUpload, onRetryDoc, onDismissDoc, onRemoveDoc }: Props) {
  const [deleteCandidate, setDeleteCandidate] = useState<WizardDoc | null>(null);
  const [removing, setRemoving] = useState("");
  const [removeError, setRemoveError] = useState("");

  const uploading = pending.some((item) => !item.error);
  const hasFile = docs.length > 0 || pending.length > 0;

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

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-background-100 text-primary-600">
          <i className={`${step.icon} text-xl`} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="font-heading text-sm font-semibold text-foreground-950">{step.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground-600">{step.subtitle}</p>
        </div>
      </div>

      <div>
        <label className="flex w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-dashed border-primary-300 bg-background-50 px-4 py-6 text-sm font-semibold text-primary-700 transition-colors hover:bg-primary-50">
          <i className="ri-upload-cloud-2-line text-lg" aria-hidden="true" />
          {step.multiple ? (hasFile ? "Add more files" : "Upload files") : hasFile ? "Replace file" : "Upload file"}
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
            multiple={step.multiple}
            disabled={uploading}
            onChange={(event) => {
              onPickFiles(event.target.files);
              event.target.value = "";
            }}
            className="sr-only"
          />
        </label>
        <p className="mt-2 text-center text-[11px] text-foreground-400">
          PDF, JPG or PNG &middot; up to 10 MB each &middot; stored privately
        </p>
      </div>

      {hasFile ? (
        <ul className="space-y-1.5" aria-live="polite">
          {pending.map((item) => (
            <li key={item.key} className={CHIP}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <i className={item.error ? "ri-error-warning-line text-sm text-primary-700" : "ri-loader-4-line animate-spin text-sm text-primary-600"} aria-hidden="true" />
                  <span className="truncate">{item.file.name}</span>
                  <span className="shrink-0 text-foreground-400">{formatBytes(item.file.size)}</span>
                </span>
                {item.error ? null : <span className="shrink-0 text-foreground-500">Uploading&hellip;</span>}
              </div>
              {item.error ? <ErrorActions message={item.error} onRetry={() => onRetryUpload(item)} onManual={() => onDropUpload(item)} /> : null}
            </li>
          ))}
          {docs.map((doc) => {
            const reading = doc.extraction === "queued" || doc.extraction === "processing";
            const failed = doc.extraction === "failed" && !dismissed.has(doc.id);
            return (
              <li key={doc.id} className={CHIP}>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <i className={reading ? "ri-loader-4-line animate-spin text-sm text-primary-600" : failed ? "ri-error-warning-line text-sm text-primary-700" : "ri-file-shield-2-line text-sm text-accent-600"} aria-hidden="true" />
                    <span className="truncate">{doc.filename}</span>
                    {doc.fileSize ? <span className="shrink-0 text-foreground-400">{formatBytes(doc.fileSize)}</span> : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {failed ? null : (
                      <span className="text-foreground-500">
                        {reading
                          ? `Reading your ${step.noun}…`
                          : doc.extraction === "done"
                            ? "Done ✓"
                            : doc.extraction === "empty"
                              ? "Done ✓ nothing readable, add details in the form"
                              : "Add details in the form"}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setDeleteCandidate(doc)}
                      disabled={removing === doc.id}
                      aria-label={`Remove ${doc.filename}`}
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-foreground-500 transition-colors hover:bg-primary-50 hover:text-primary-700 disabled:opacity-50"
                    >
                      <i className={removing === doc.id ? "ri-loader-4-line animate-spin" : "ri-delete-bin-line"} aria-hidden="true" />
                    </button>
                  </span>
                </div>
                {expiryNote(step, doc) ? <p className={`mt-1.5 flex items-center gap-1.5 ${expiryNote(step, doc)!.tone}`}><i className="ri-time-line" aria-hidden="true" />{expiryNote(step, doc)!.text}</p> : null}
                {failed ? <ErrorActions message={doc.error ?? "We could not read this document."} onRetry={() => onRetryDoc(doc)} onManual={() => onDismissDoc(doc)} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {removeError ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-900">
          <i className="ri-alert-line mt-px" aria-hidden="true" />
          {removeError}
        </p>
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
