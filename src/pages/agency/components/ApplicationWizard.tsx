import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteApplicationDocument,
  flushApplicationEdits,
  getApplication,
  listApplicationDocuments,
  queueDocumentExtraction,
  saveDocumentReview,
  uploadApplicationDocument,
  type DocumentRow,
} from "@/pages/agency/lib/portalApplications";
import {
  WIZARD_STEPS,
  wizardExtractionState,
  type PendingUpload,
  type WizardDoc,
  type WizardMeta,
  type WizardStep,
} from "@/pages/agency/lib/wizardConfig";
import { formatExtractionCandidates } from "@/pages/agency/lib/documentExtraction";
import WizardDocumentStep from "@/pages/agency/components/WizardDocumentStep";
import { PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";

import { portalScopeCacheKey } from "@/lib/portalScope";

interface Props {
  applicationId: string;
  agencyName: string;
  /** Called after the wizard has finished and the draft holds the extracted values. */
  onFinish: () => void;
  /** Called when the agent leaves the wizard (the draft is kept). */
  onCancel: () => void;
}

const WIZARD_CATEGORIES = new Set(WIZARD_STEPS.map((step) => step.category));
const LAST_STEP = WIZARD_STEPS.length - 1;

function wizardStepKey(applicationId: string): string {
  return `slit-portal-wizard-step:${portalScopeCacheKey()}:${applicationId}`;
}

function savedWizardStep(applicationId: string): number {
  try {
    const value = Number(window.sessionStorage.getItem(wizardStepKey(applicationId)));
    return Number.isInteger(value) && value >= 0 && value < WIZARD_STEPS.length ? value : 0;
  } catch {
    return 0;
  }
}

function toWizardDoc(row: DocumentRow): WizardDoc {
  const { state, error } = wizardExtractionState(row.metadata);
  const extracted = (row.metadata.extraction as { extracted?: Record<string, string> } | undefined)?.extracted;
  return { id: row.id, category: row.category, filename: row.filename, fileSize: row.fileSize, storagePath: row.storagePath, extraction: state, error, extracted: formatExtractionCandidates(extracted) };
}

function wizardDocs(rows: DocumentRow[]): WizardDoc[] {
  return rows.filter((row) => row.isCurrent && WIZARD_CATEGORIES.has(row.category)).map(toWizardDoc);
}

const isReading = (doc: WizardDoc) => doc.extraction === "queued" || doc.extraction === "processing";

export default function ApplicationWizard({ applicationId, agencyName, onFinish, onCancel }: Props) {
  const { profile } = usePortalAuth();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState(() => savedWizardStep(applicationId));
  const [documents, setDocuments] = useState<WizardDoc[]>([]);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState("");

  const documentsRef = useRef<WizardDoc[]>([]);
  const refreshSequenceRef = useRef(0);
  const completingRef = useRef(false);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    const flush = (event: Event) => (event as CustomEvent<{ waits: Promise<unknown>[] }>).detail.waits.push(flushApplicationEdits(applicationId));
    window.addEventListener("portal-before-scope-switch", flush);
    return () => window.removeEventListener("portal-before-scope-switch", flush);
  }, [applicationId]);

  const current = WIZARD_STEPS[step];
  useEffect(() => {
    try { window.sessionStorage.setItem(wizardStepKey(applicationId), String(step)); } catch { /* session storage unavailable */ }
  }, [applicationId, step]);

  // Lock background scrolling while the wizard is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /* --------------------------------------------------------------- load */

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const application = await getApplication(applicationId);
        if (!application) {
          if (active) setLoadError("This draft could not be found, or you do not have access to it.");
          return;
        }
        const stored = await listApplicationDocuments(applicationId);
        if (active) setDocuments(wizardDocs(stored));
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : "We could not load this draft.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [applicationId]);

  // Extraction is durable and asynchronous: poll only while a document is being
  // read. A sequence guard keeps an older response from replacing newer state.
  const hasLiveExtraction = documents.some(isReading);
  useEffect(() => {
    if (!hasLiveExtraction) return;
    let active = true;
    const interval = window.setInterval(() => {
      const sequence = ++refreshSequenceRef.current;
      void listApplicationDocuments(applicationId)
        .then((stored) => {
          if (active && sequence === refreshSequenceRef.current) setDocuments(wizardDocs(stored));
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [applicationId, hasLiveExtraction]);

  /* ------------------------------------------------------------ uploads */

  const startUpload = useCallback(
    async (item: PendingUpload) => {
      const target = WIZARD_STEPS.find((candidate) => candidate.category === item.category);
      if (!target) return;
      setPending((prev) => prev.map((entry) => (entry.key === item.key ? { ...entry, error: undefined } : entry)));
      const addStored = (stored: { id: string; path: string }) => {
        // The file is stored: from here the chip is driven by the extraction state.
        refreshSequenceRef.current += 1;
        setDocuments((prev) => [
          { id: stored.id, category: item.category, filename: item.file.name, fileSize: item.file.size, storagePath: stored.path, extraction: "queued" },
          ...prev.filter((doc) => doc.id !== stored.id),
        ]);
        setPending((prev) => prev.filter((entry) => entry.key !== item.key));
      };
      try {
        const stored = await uploadApplicationDocument({
          applicationId,
          category: item.category,
          file: item.file,
          uploadedBy: profile?.id ?? null,
          metadata: {
            kind: target.id,
            extraction: { extracted: {}, confirmed: {}, status: "queued", source: { engine: "openai-responses", parser: "document-extraction-v1", queuedAt: new Date().toISOString() } },
          },
          onStored: addStored,
        });
        addStored({ id: stored.id, path: stored.path });
        if (!target.multiple) {
          // A replacement supersedes the earlier file of this single-document step.
          const earlier = documentsRef.current.filter((doc) => doc.category === item.category && doc.id !== stored.id);
          await Promise.all(earlier.map((doc) => deleteApplicationDocument({ id: doc.id, storagePath: doc.storagePath }).then(
            () => setDocuments((prev) => prev.filter((entry) => entry.id !== doc.id)),
            () => undefined,
          )));
        }
      } catch (error) {
        setPending((prev) => prev.map((entry) => (entry.key === item.key ? { ...entry, error: error instanceof Error ? error.message : "Upload failed." } : entry)));
      }
    },
    [applicationId, profile?.id],
  );

  // The loader starts here, synchronously, before any hashing or network call.
  const handlePickFiles = (target: WizardStep, list: FileList | null) => {
    if (!list || list.length === 0) return;
    const items = Array.from(list).map((file) => ({ key: crypto.randomUUID(), category: target.category, file }));
    setPending((prev) => [...prev, ...items]);
    items.forEach((item) => void startUpload(item));
  };

  const handleRetryDoc = useCallback(async (doc: WizardDoc) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.delete(doc.id);
      return next;
    });
    setDocuments((prev) => prev.map((item) => (item.id === doc.id ? { ...item, extraction: "processing", error: undefined } : item)));
    try {
      await queueDocumentExtraction(doc.id, true);
    } catch (error) {
      setDocuments((prev) => prev.map((item) => (item.id === doc.id ? { ...item, extraction: "failed", error: error instanceof Error ? error.message : "We could not read this document." } : item)));
    }
  }, []);

  const handleRemoveDoc = useCallback(async (doc: WizardDoc) => {
    await deleteApplicationDocument({ id: doc.id, storagePath: doc.storagePath });
    setDocuments((prev) => prev.filter((item) => item.id !== doc.id));
  }, []);

  /* ------------------------------------------------------------- finish */

  // Extraction fills empty fields of the draft on the server and never replaces
  // an entered value, so finishing only waits for in-flight work, then records
  // the outstanding items and the student name and opens the full form.
  const complete = useCallback(async () => {
    if (completingRef.current) return;
    completingRef.current = true;
    setFinishError("");
    try {
      await flushApplicationEdits(applicationId);
      const application = await getApplication(applicationId);
      const values = (application?.data.values ?? {}) as Record<string, unknown>;
      const studentName = [values.first_name, values.last_name].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" ").trim();
      const meta: WizardMeta = {
        completedSteps: WIZARD_STEPS.map((item) => item.id),
        outstanding: documentsRef.current.some((doc) => doc.category === "Passport")
          ? []
          : ["Passport copy not provided — required before the student's identity can be verified."],
        updatedAt: new Date().toISOString(),
      };
      await saveDocumentReview({ applicationId, values: {}, provenance: {}, confirmed: [], wizard: meta as unknown as Record<string, unknown>, studentName: studentName || undefined });
      onFinish();
    } catch (error) {
      setFinishError(error instanceof Error ? error.message : "We could not open the application form.");
      setFinishing(false);
      completingRef.current = false;
    }
  }, [applicationId, onFinish]);

  const busy = pending.some((item) => !item.error) || documents.some((doc) => isReading(doc) && !dismissed.has(doc.id));
  useEffect(() => {
    if (finishing && !busy) void complete();
  }, [finishing, busy, complete]);

  /* ------------------------------------------------------------ navigate */

  const goTo = (index: number) => {
    setStep(Math.max(0, Math.min(index, LAST_STEP)));
  };

  const stepDocs = documents.filter((doc) => doc.category === current.category);
  const stepPending = pending.filter((item) => item.category === current.category);
  const hasFile = stepDocs.length > 0 || stepPending.length > 0;
  const isLast = step === LAST_STEP;
  const ready = !loading && !loadError;

  const stepBusy = (target: WizardStep) =>
    pending.some((item) => item.category === target.category && !item.error) ||
    documents.some((doc) => doc.category === target.category && isReading(doc) && !dismissed.has(doc.id));

  const primaryClass =
    "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60";

  /* --------------------------------------------------------------- render */

  const body = () => {
    if (loading) return <PortalLoading label="Loading the document wizard…" />;
    if (loadError) {
      return (
        <div className="space-y-4">
          <PortalError message={loadError} />
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border border-background-300 px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:bg-background-100"
          >
            Close
          </button>
        </div>
      );
    }
    return (
      <WizardDocumentStep
        step={current}
        docs={stepDocs}
        pending={stepPending}
        dismissed={dismissed}
        onPickFiles={(files) => handlePickFiles(current, files)}
        onRetryUpload={(item) => void startUpload(item)}
        onDropUpload={(item) => setPending((prev) => prev.filter((entry) => entry.key !== item.key))}
        onRetryDoc={(doc) => void handleRetryDoc(doc)}
        onDismissDoc={(doc) => setDismissed((prev) => new Set(prev).add(doc.id))}
        onRemoveDoc={handleRemoveDoc}
      />
    );
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-foreground-950/55 p-3 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-title"
    >
      <div className="relative my-auto w-full max-w-3xl rounded-xl border border-background-200 bg-background-50">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-background-200 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary-500 text-background-50">
              <i className="ri-magic-line text-xl" aria-hidden="true" />
            </span>
            <div>
              <h2 id="wizard-title" className="font-heading text-lg font-bold text-foreground-950">
                Add New Form &mdash; document wizard
              </h2>
              <p className="mt-0.5 text-sm leading-relaxed text-foreground-600">
                Upload documents to prefill the application, then continue to the full form. {agencyName}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel and close the wizard"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground-500 transition-colors hover:bg-background-100 hover:text-foreground-800"
          >
            <i className="ri-close-line text-lg" aria-hidden="true" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex flex-wrap gap-2 border-b border-background-200 px-5 py-3.5 md:px-6">
          {WIZARD_STEPS.map((item, index) => {
            const active = index === step;
            const done = index < step;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => goTo(index)}
                className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                  active
                    ? "border-primary-300 bg-primary-50 text-primary-700"
                    : done
                      ? "border-background-200 bg-background-100 text-foreground-600"
                      : "border-background-200 bg-background-50 text-foreground-400"
                }`}
              >
                {stepBusy(item) ? (
                  <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
                ) : (
                  <i className={done ? "ri-check-line" : item.icon} aria-hidden="true" />
                )}
                {item.short}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="max-h-[62vh] overflow-y-auto p-5 md:p-6">{body()}</div>

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-background-200 p-5 sm:flex-row sm:items-center sm:justify-between md:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm font-medium text-foreground-500 transition-colors hover:text-foreground-800"
            >
              <i className="ri-close-line" aria-hidden="true" />
              Cancel
            </button>
            {step > 0 && ready ? (
              <button
                type="button"
                onClick={() => goTo(step - 1)}
                disabled={finishing}
                className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 px-3.5 py-2 text-sm font-semibold text-foreground-700 transition-colors hover:bg-background-100 disabled:opacity-50"
              >
                <i className="ri-arrow-left-line" aria-hidden="true" />
                Back
              </button>
            ) : null}
          </div>

          {ready ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              {!isLast && !hasFile ? (
                <button
                  type="button"
                  onClick={() => goTo(step + 1)}
                  className="inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-700 transition-colors hover:border-primary-300 hover:text-primary-700"
                >
                  {current.skipLabel}
                </button>
              ) : null}
              {isLast ? (
                <>
                  {finishing ? (
                    <button type="button" onClick={() => void complete()} className="cursor-pointer text-xs font-semibold text-primary-700 underline">
                      Continue now
                    </button>
                  ) : null}
                  <button type="button" onClick={() => setFinishing(true)} disabled={finishing} className={primaryClass}>
                    {finishing ? (
                      <>
                        <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
                        Finishing&hellip;
                      </>
                    ) : (
                      <>
                        Finish
                        <i className="ri-arrow-right-circle-line" aria-hidden="true" />
                      </>
                    )}
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => goTo(step + 1)} disabled={!hasFile} className={primaryClass}>
                  Next
                  <i className="ri-arrow-right-line" aria-hidden="true" />
                </button>
              )}
            </div>
          ) : null}
        </div>

        {finishError ? (
          <div className="border-t border-background-200 px-5 py-3 md:px-6">
            <PortalError message={finishError} onRetry={() => setFinishing(true)} />
          </div>
        ) : null}

        {ready ? (
          <div className="border-t border-background-200 px-5 py-3 text-center md:px-6">
            <p className="text-[11px] text-foreground-400">
              Nothing is submitted from this wizard. Documents are stored privately against this draft; the student
              application is submitted only from the full form after review.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
