import { useEffect, useMemo, useRef, useState } from "react";
import { isReadableFile } from "@/lib/ocrFile";
import type { ScanType } from "@/lib/docScan";
import { MAX_DOCUMENT_BYTES } from "@/pages/agency/lib/portalApplications";
import {
  formatBytes,
  isSpecVisible,
  type WizardConflict,
  type WizardDoc,
  type DocumentExtraction,
  hasLegacyExtractionOnly,
  needsOcrRetry,
  type WizardFieldSpec,
  type WizardStep,
} from "@/pages/agency/lib/wizardConfig";

interface Props {
  step: WizardStep;
  /** The current confirmed values on the draft (drives the editable panel). */
  values: Record<string, string>;
  /** Documents already stored against this application for this category. */
  existingDocs: WizardDoc[];
  /** Conflicts whose field belongs to this step. */
  conflicts: WizardConflict[];
  onExtracted: (fields: Record<string, string>, sourceLabel: string) => void;
  onUpload: (file: File, category: string, meta: Record<string, unknown>) => Promise<WizardDoc>;
  onReviewDocument: (doc: WizardDoc, confirmed: Record<string, string>, status: "confirmed" | "rejected") => Promise<void>;
  onReprocessDocument: (doc: WizardDoc, scanType: NonNullable<WizardStep["type"]>) => Promise<void>;
  onRemoveDoc: (doc: WizardDoc) => Promise<void>;
  onManualChange: (field: string, value: string) => void;
  onResolveConflict: (field: string, choice: "existing" | "extracted") => void;
}

type Status = { kind: "idle" | "warn" | "error"; text?: string };

function persistedExtractionStatus(doc: WizardDoc): string {
  const extraction = doc.metadata.extraction as { status?: unknown; error?: { message?: unknown } } | undefined;
  if (extraction?.status === "queued" || extraction?.status === "processing") return "Reading document with AI…";
  if (extraction?.status === "unreviewed") return "Ready for review";
  if (extraction?.status === "failed") return typeof extraction.error?.message === "string" ? `Extraction failed: ${extraction.error.message}` : "Extraction failed — retry available";
  if (extraction?.status === "no_fields") return "No fields found";
  return "Extraction not requested";
}

const INPUT_CLASS =
  "w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-950 placeholder:text-foreground-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";

function SpecControl({
  spec,
  value,
  name,
  onChange,
}: {
  spec: WizardFieldSpec;
  value: string;
  name: string;
  onChange: (value: string) => void;
}) {
  if (spec.type === "radio") {
    return (
      <div className="flex flex-wrap gap-2">
        {(spec.options ?? []).map((option) => {
          const active = value.toLowerCase() === option.toLowerCase();
          return (
            <label
              key={option}
              className={`flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border px-3 py-1.5 text-xs transition-colors ${
                active
                  ? "border-primary-400 bg-primary-50 text-primary-900"
                  : "border-background-300 text-foreground-600 hover:border-primary-300"
              }`}
            >
              <input
                type="radio"
                name={name}
                value={option}
                checked={active}
                onChange={() => onChange(option)}
                className="h-3.5 w-3.5 accent-primary-500"
              />
              <span className="font-medium">{option}</span>
            </label>
          );
        })}
      </div>
    );
  }

  if (spec.type === "select") {
    const options = spec.options ?? [];
    const matchingOption = options.find((option) => option.toLowerCase() === value.toLowerCase());
    const known = Boolean(matchingOption);
    return (
      <select
        id={name}
        name={name}
        value={matchingOption ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT_CLASS}
      >
        <option value="">Select&hellip;</option>
        {!known && value ? <option value={value}>{value}</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  // Native date controls discard non-ISO candidates without displaying them.
  // Render such a candidate as text so the agent can see and correct it.
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const inputType = spec.type === "date" && value && !validDate ? "text" : spec.type;

  return (
    <input
      id={name}
      name={name}
      type={inputType}
      value={value}
      placeholder={spec.placeholder ?? "Optional"}
      onChange={(event) => onChange(event.target.value)}
      className={INPUT_CLASS}
    />
  );
}

export default function WizardDocumentStep({
  step,
  values,
  existingDocs,
  conflicts,
  onExtracted,
  onUpload,
  onReviewDocument,
  onReprocessDocument,
  onRemoveDoc,
  onManualChange,
  onResolveConflict,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [removing, setRemoving] = useState("");
  const [reprocessing, setReprocessing] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<WizardDoc | null>(null);

  const readable = useMemo(() => Boolean(step.type), [step.type]);
  const visibleSpecs = useMemo(() => step.specs.filter((spec) => isSpecVisible(spec, values)), [step.specs, values]);

  const runFiles = async (list: FileList | null) => {
    if (!list || list.length === 0 || !step.type) return;
    const chosen = Array.from(list);

    const tooBig = chosen.find((file) => file.size > MAX_DOCUMENT_BYTES);
    if (tooBig) {
      setStatus({ kind: "error", text: `${tooBig.name} is larger than 10 MB. Please attach a smaller file.` });
      return;
    }
    const usable = chosen.filter(isReadableFile);
    if (usable.length === 0) {
      setStatus({ kind: "error", text: "Auto-read works on photos (JPG / PNG) and PDFs. Please attach one of those." });
      return;
    }

    setBusy(true);
    setStatus({ kind: "idle" });

    let savedCount = 0;
    let failedUpload = "";

    for (let index = 0; index < usable.length; index += 1) {
      const file = usable[index];
      try {
        await onUpload(file, step.category, {
          kind: step.type,
          extraction: { extracted: {}, confirmed: {}, status: "queued", source: { engine: "openai-responses", parser: "document-extraction-v1", queuedAt: new Date().toISOString() } },
        });
        savedCount += 1;
      } catch (error) {
        failedUpload = error instanceof Error ? error.message : "Upload failed.";
      }
    }

    setBusy(false);

    if (failedUpload && savedCount === 0) {
      setStatus({ kind: "error", text: failedUpload });
    } else if (failedUpload) {
      setStatus({ kind: "warn", text: `Saved ${savedCount} file(s), but one failed: ${failedUpload}` });
    } else if (savedCount) {
      setStatus({ kind: "idle" });
    } else {
      setStatus({
        kind: "warn",
        text: step.type === "passport"
          ? `Document saved. Passport MRZ could not be verified and no supported visual fields were recognized. You can retry OCR or enter values manually.`
          : `Document saved. Text was detected, but no supported ${step.title.toLowerCase()} fields were recognized. You can retry OCR or enter values manually.`,
      });
    }
  };

  const handleRemove = async (doc: WizardDoc) => {
    setRemoving(doc.id);
    try {
      await onRemoveDoc(doc);
      setDeleteCandidate(null);
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : "Document deletion failed." });
    } finally {
      setRemoving("");
    }
  };

  const handleReprocess = async (doc: WizardDoc) => {
    if (!step.type) return;
    setReprocessing(doc.id);
    setStatus({ kind: "idle" });
    try {
      await onReprocessDocument(doc, step.type);
      setStatus({ kind: "idle" });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : "Document reprocessing failed." });
    } finally { setReprocessing(""); }
  };

  // Compute the group order so headings appear once, in first-seen order.
  const groups = useMemo(() => {
    const order: string[] = [];
    for (const spec of visibleSpecs) {
      const key = spec.group ?? "";
      if (!order.includes(key)) order.push(key);
    }
    return order;
  }, [visibleSpecs]);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-background-200 bg-background-100/60 p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-background-50 text-primary-600">
          <i className={`${step.icon} text-xl`} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="font-heading text-sm font-semibold text-foreground-950">{step.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-foreground-600">{step.subtitle}</p>
        </div>
      </div>

      {readable ? (
        <div>
          <label className="flex w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-dashed border-primary-300 bg-background-50 px-4 py-3.5 text-sm font-semibold text-primary-700 transition-colors hover:bg-primary-50">
            <i className={busy ? "ri-loader-4-line animate-spin" : "ri-upload-cloud-2-line"} aria-hidden="true" />
            {busy
              ? "Working\u2026"
              : step.multiple
                ? existingDocs.length > 0
                  ? "Add more files"
                  : "Upload files"
                : existingDocs.length > 0
                  ? "Replace / add file"
                  : "Upload file"}
            <input
              ref={inputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.gif,.webp,.tif,.tiff,.pdf,image/*"
              multiple={step.multiple}
              disabled={busy}
              onChange={(event) => {
                void runFiles(event.target.files);
                event.target.value = "";
              }}
              className="sr-only"
            />
          </label>
          <p className="mt-2 text-center text-[11px] text-foreground-400">
            PDF, JPG or PNG &middot; up to 10 MB each &middot; stored privately and extracted securely in the background
          </p>
        </div>
      ) : null}

      {existingDocs.length > 0 ? (
        <ul className="space-y-1.5">
          {existingDocs.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center justify-between gap-3 rounded-md border border-background-200 bg-background-50 px-3 py-2 text-xs text-foreground-700"
            >
              <span className="flex min-w-0 items-center gap-2">
                <i className={doc.extraction?.status === "queued" || doc.extraction?.status === "processing" ? "ri-loader-4-line animate-spin text-sm text-primary-600" : "ri-file-shield-2-line text-sm text-accent-600"} aria-hidden="true" />
                <span className="truncate">{doc.filename}</span>
                {doc.fileSize ? <span className="shrink-0 text-foreground-400">{formatBytes(doc.fileSize)}</span> : null}
                <span className="shrink-0 text-foreground-500">{persistedExtractionStatus(doc)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
              {needsOcrRetry(doc.metadata) ? <button
                type="button"
                onClick={() => void handleReprocess(doc)}
                disabled={Boolean(reprocessing) || busy}
                className="rounded border border-primary-300 px-2 py-1 text-[11px] font-semibold text-primary-800 disabled:opacity-50"
              >{reprocessing === doc.id ? "Reprocessing…" : hasLegacyExtractionOnly(doc.metadata) ? "Extraction values unavailable — Reprocess document" : "Retry OCR"}</button> : null}
              <button
                type="button"
                onClick={() => setDeleteCandidate(doc)}
                disabled={removing === doc.id || busy}
                aria-label={`Remove ${doc.filename}`}
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-500 transition-colors hover:bg-primary-50 hover:text-primary-700 disabled:opacity-50"
              >
                <i className={removing === doc.id ? "ri-loader-4-line animate-spin" : "ri-delete-bin-line"} aria-hidden="true" />
              </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {step.type === "academic" && existingDocs.some((doc) => ["unreviewed", "confirmed", "rejected", "no_fields"].includes(doc.extraction?.status ?? "")) ? (
        <div className="space-y-3 rounded-lg border border-background-200 bg-background-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-700">Qualification review by document</p>
          <p className="text-[11px] text-foreground-500">OCR is unverified until you confirm this individual document. Each saved qualification stays linked to its source file.</p>
          {existingDocs.filter((doc) => ["unreviewed", "confirmed", "rejected", "no_fields"].includes(doc.extraction?.status ?? "")).map((doc) => (
            <AcademicDocumentReview key={doc.id} doc={doc} specs={step.specs} onSave={onReviewDocument} />
          ))}
        </div>
      ) : null}

      {step.type !== "academic" && existingDocs.filter((doc) => doc.extraction && ["unreviewed", "confirmed", "rejected", "no_fields"].includes(doc.extraction.status)).map((doc) => (
        <DocumentExtractionReview key={doc.id} doc={doc} specs={step.specs} onSave={onReviewDocument} />
      ))}

      {import.meta.env.DEV && existingDocs.map((doc) => {
        const diagnostics = (doc.extraction?.source as { diagnostics?: Record<string, unknown> } | undefined)?.diagnostics;
        if (!diagnostics) return null;
        return <div key={`${doc.id}-diagnostics`} className="rounded-md border border-background-200 bg-background-100 p-3 text-[11px] text-foreground-600"><p className="font-semibold uppercase tracking-wide">OCR diagnostic (development only)</p><dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">{Object.entries(diagnostics).map(([key, value]) => <><dt key={`${key}-label`}>{key}</dt><dd key={`${key}-value`} className="font-medium text-foreground-800">{String(value)}</dd></>)}</dl></div>;
      })}

      {status.kind !== "idle" ? (
        <p
          role="status"
          className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
            status.kind === "error"
                ? "border border-primary-200 bg-primary-50 text-primary-900"
                : "border border-background-200 bg-background-100 text-foreground-700"
          }`}
        >
          <i
            className={
              status.kind === "error"
                  ? "ri-alert-line mt-px"
                  : "ri-information-line mt-px"
            }
            aria-hidden="true"
          />
          <span>{status.text}</span>
        </p>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50 p-4">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary-900">
            <i className="ri-error-warning-line" aria-hidden="true" />
            Conflicting details — please confirm
          </p>
          {conflicts.map((conflict) => (
            <div key={conflict.field} className="rounded-md border border-primary-200 bg-background-50 p-3">
              <p className="text-xs font-semibold text-foreground-900">
                {conflict.label}
                <span className="ml-2 font-normal text-foreground-500">({conflict.source})</span>
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(["existing", "extracted"] as const).map((option) => {
                  const value = option === "existing" ? conflict.existing : conflict.extracted;
                  return (
                    <label
                      key={option}
                      className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${
                        conflict.choice === option
                          ? "border-primary-400 bg-primary-100 text-primary-900"
                          : "border-background-200 text-foreground-600"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`conflict-${conflict.field}`}
                        checked={conflict.choice === option}
                        onChange={() => onResolveConflict(conflict.field, option)}
                        className="h-3.5 w-3.5 accent-primary-500"
                      />
                      <span className="font-semibold">{option === "existing" ? "Keep" : "Use"}:</span>
                      <span>{value || "\u2014"}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {visibleSpecs.length > 0 && step.type !== "academic" ? (
        <div className="rounded-lg border border-background-200 bg-background-50 p-4">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-foreground-700">
            <i className="ri-pencil-line text-base text-primary-600" aria-hidden="true" />
            Details on this application (editable)
          </p>
          <p className="mt-1 text-[11px] text-foreground-500">
            Anything not read from a document can be typed here. Empty fields stay blank for the full form.
          </p>

          <div className="mt-4 space-y-5">
            {groups.map((group) => (
              <div key={group || "default"} className="space-y-3">
                {group ? (
                  <p className="border-b border-background-200 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-500">
                    {group}
                  </p>
                ) : null}
                <div className="space-y-3">
                  {visibleSpecs
                    .filter((spec) => (spec.group ?? "") === group)
                    .map((spec) => {
                      const fieldId = `wiz-${step.id}-${spec.name}`;
                      const isWide = spec.type === "radio";
                      return (
                        <div key={spec.name} className={isWide ? "" : "grid gap-1"}>
                          <label
                            htmlFor={fieldId}
                            className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-foreground-500"
                          >
                            {spec.label}
                          </label>
                          <SpecControl
                            spec={spec}
                            value={values[spec.name] ?? ""}
                            name={fieldId}
                            onChange={(value) => onManualChange(spec.name, value)}
                          />
                          {spec.hint ? <p className="mt-1 text-[11px] text-foreground-400">{spec.hint}</p> : null}
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {deleteCandidate ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-foreground-950/50 p-4" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-lg bg-background-50 p-5 shadow-xl"><h3 className="font-heading font-bold text-foreground-950">Delete document?</h3><p className="mt-2 text-sm text-foreground-600">Delete <strong>{deleteCandidate.filename}</strong> permanently from this editable draft? Retained/submitted documents cannot be deleted.</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setDeleteCandidate(null)} className="rounded-md border border-background-300 px-3 py-2 text-sm font-semibold">Cancel</button><button type="button" disabled={removing === deleteCandidate.id} onClick={() => void handleRemove(deleteCandidate)} className="rounded-md bg-primary-600 px-3 py-2 text-sm font-semibold text-background-50 disabled:opacity-50">{removing === deleteCandidate.id ? "Deleting…" : "Delete permanently"}</button></div></div></div> : null}
    </div>
  );
}

function AcademicDocumentReview({ doc, specs, onSave }: { doc: WizardDoc; specs: WizardFieldSpec[]; onSave: Props["onReviewDocument"] }) {
  const extraction = doc.extraction as DocumentExtraction | undefined;
  const candidateFingerprint = JSON.stringify({ extracted: extraction?.extracted ?? {}, confirmed: extraction?.confirmed ?? {}, status: extraction?.status });
  const reviewFields = useMemo(() => { const candidate = JSON.parse(candidateFingerprint); return { ...candidate.extracted, ...candidate.confirmed }; }, [candidateFingerprint]);
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...(extraction?.extracted ?? {}), ...(extraction?.confirmed ?? {}) }));
  const [saving, setSaving] = useState(false);
  const status = extraction?.status ?? "unreviewed";
  useEffect(() => { setFields(reviewFields); }, [doc.id, reviewFields]);
  const save = async (next: "confirmed" | "rejected") => {
    setSaving(true);
    try { await onSave(doc, fields, next); } finally { setSaving(false); }
  };
  return <div className="rounded-md border border-background-200 bg-background-50 p-3">
    <div className="flex items-center justify-between gap-3"><span className="truncate text-xs font-semibold text-foreground-800">{doc.filename}</span><span className="text-[11px] font-medium text-foreground-500">{status}</span></div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">{specs.map((spec) => <label key={spec.name} className={`grid gap-1 rounded-md p-1 text-[11px] font-medium uppercase tracking-wide text-foreground-500 ${fields[spec.name] ? "bg-secondary-100" : ""}`}>{spec.label}<SpecControl spec={spec} name={`academic-${doc.id}-${spec.name}`} value={fields[spec.name] ?? ""} onChange={(value) => setFields((current) => ({ ...current, [spec.name]: value }))} /></label>)}</div>
    <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={saving} onClick={() => void save("confirmed")} className="rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-background-50 disabled:opacity-50">Confirm qualification</button><button type="button" disabled={saving} onClick={() => void save("rejected")} className="rounded-md border border-primary-300 px-3 py-1.5 text-xs font-semibold text-primary-800 disabled:opacity-50">Reject extraction</button></div>
  </div>;
}

function DocumentExtractionReview({ doc, specs, onSave }: { doc: WizardDoc; specs: WizardFieldSpec[]; onSave: Props["onReviewDocument"] }) {
  const extraction = doc.extraction as DocumentExtraction;
  const candidateFingerprint = JSON.stringify({ extracted: extraction.extracted, confirmed: extraction.confirmed, status: extraction.status });
  const reviewFields = useMemo(() => { const candidate = JSON.parse(candidateFingerprint); return { ...candidate.extracted, ...candidate.confirmed }; }, [candidateFingerprint]);
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...extraction.extracted, ...extraction.confirmed }));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setFields(reviewFields); }, [doc.id, reviewFields]);
  const save = async (status: "confirmed" | "rejected") => { setSaving(true); try { await onSave(doc, fields, status); } finally { setSaving(false); } };
  return <div className="rounded-lg border border-background-200 bg-background-50 p-4">
    <p className="text-xs font-semibold text-foreground-900">Review extraction: {doc.filename}</p>
    <p className="mt-1 text-[11px] text-foreground-500">Values remain unverified until confirmed. Confirmation saves the reviewed values to the application.</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">{specs.map((spec) => <label key={spec.name} className={`grid gap-1 rounded-md p-1 text-[11px] font-medium uppercase tracking-wide text-foreground-500 ${fields[spec.name] ? "bg-secondary-100" : ""}`}>{spec.label}<SpecControl spec={spec} name={`review-${doc.id}-${spec.name}`} value={fields[spec.name] ?? ""} onChange={(value) => setFields((current) => ({ ...current, [spec.name]: value }))} /></label>)}</div>
    <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={saving} onClick={() => void save("confirmed")} className="rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-background-50 disabled:opacity-50">Confirm values</button><button type="button" disabled={saving} onClick={() => void save("rejected")} className="rounded-md border border-primary-300 px-3 py-1.5 text-xs font-semibold text-primary-800 disabled:opacity-50">Reject extraction</button></div>
  </div>;
}
