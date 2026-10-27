import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScanType } from "@/lib/docScan";
import {
  deleteApplicationDocument,
  flushApplicationEdits,
  getApplication,
  getDocumentSignedUrl,
  listApplicationDocuments,
  patchApplicationData,
  queueDocumentExtraction,
  listDocumentFieldReviews,
  saveDocumentReview,
  uploadApplicationDocument,
  updateDocumentExtraction,
} from "@/pages/agency/lib/portalApplications";
import {
  fieldLabel,
  WIZARD_STEPS,
  type WizardConflict,
  type WizardDoc,
  type DocumentExtraction,
  type WizardMeta,
  type WizardStepId,
} from "@/pages/agency/lib/wizardConfig";
import WizardDocumentStep from "@/pages/agency/components/WizardDocumentStep";
import WizardReviewStep from "@/pages/agency/components/WizardReviewStep";
import { PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { formatDocumentExtraction } from "@/pages/agency/lib/documentExtraction";

import { portalScopeCacheKey } from "@/lib/portalScope";

interface Props {
  applicationId: string;
  agencyName: string;
  /** Called after the confirmed values are persisted to the draft. */
  onFinish: () => void;
  /** Called when the agent leaves the wizard (the draft is kept). */
  onCancel: () => void;
}

/** Fields compared across documents (passport vs driving licence). */
const CROSS_DOC_FIELDS = new Set(["first_name", "middle_name", "last_name", "dob"]);
const WIZARD_CATEGORIES = new Set(["Passport", "Visa", "Driving Licence", "English Test", "Academic"]);

function stringValues(data: Record<string, unknown>): Record<string, string> {
  const raw = (data.values ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

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

export default function ApplicationWizard({ applicationId, agencyName, onFinish, onCancel }: Props) {
  const { profile } = usePortalAuth();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState(() => savedWizardStep(applicationId));
  const [values, setValues] = useState<Record<string, string>>({});
  const [provenance, setProvenance] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<WizardConflict[]>([]);
  const [documents, setDocuments] = useState<WizardDoc[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [viewingPath, setViewingPath] = useState("");
  const [viewError, setViewError] = useState("");

  const valuesRef = useRef<Record<string, string>>({});
  const provenanceRef = useRef<Record<string, string>>({});
  const confirmedRef = useRef<Set<string>>(new Set());
  const conflictsRef = useRef<WizardConflict[]>([]);
  const manualKeysRef = useRef<Set<string>>(new Set());
  const visitedRef = useRef<Set<WizardStepId>>(new Set());
  const stepIdRef = useRef<ScanType | null>(null);
  const refreshSequenceRef = useRef(0);

  useEffect(() => {
    valuesRef.current = values;
  }, [values]);
  useEffect(() => {
    provenanceRef.current = provenance;
  }, [provenance]);
  useEffect(() => {
    confirmedRef.current = new Set(confirmed);
  }, [confirmed]);
  useEffect(() => {
    conflictsRef.current = conflicts;
  }, [conflicts]);

  useEffect(() => {
    const flush = (event: Event) => (event as CustomEvent<{ waits: Promise<unknown>[] }>).detail.waits.push(flushApplicationEdits(applicationId));
    window.addEventListener("portal-before-scope-switch", flush);
    return () => window.removeEventListener("portal-before-scope-switch", flush);
  }, [applicationId]);

  const current = WIZARD_STEPS[step];
  useEffect(() => {
    stepIdRef.current = current.type ?? null;
  }, [current]);
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
        if (!active) return;
        const initial = stringValues(application.data);
        valuesRef.current = initial;
        setValues(initial);
        manualKeysRef.current = new Set(Object.keys(initial).filter((key) => (initial[key] ?? "").trim() !== ""));

        // Restore the previously saved review provenance + confirmations.
        const meta = (application.data.wizard ?? {}) as WizardMeta;
        if (meta.provenance) {
          provenanceRef.current = meta.provenance;
          setProvenance(meta.provenance);
        }
        if (Array.isArray(meta.confirmed)) {
          confirmedRef.current = new Set(meta.confirmed);
          setConfirmed(meta.confirmed);
        }

        const stored = await listApplicationDocuments(applicationId);
        if (!active) return;
        setDocuments(
          stored
            .filter((doc) => doc.isCurrent && WIZARD_CATEGORIES.has(doc.category))
            .map((doc) => ({
              id: doc.id,
              category: doc.category,
              filename: doc.filename,
              fileSize: doc.fileSize,
              mimeType: doc.mimeType,
              stored: true,
              storagePath: doc.storagePath,
              extractedFields: Array.isArray((doc.metadata as { extractedFields?: unknown }).extractedFields)
                ? ((doc.metadata as { extractedFields: string[] }).extractedFields)
                : [],
              extraction: formatDocumentExtraction((doc.metadata as { extraction?: DocumentExtraction }).extraction),
              metadata: doc.metadata,
            })),
        );
        const reviews = await listDocumentFieldReviews(applicationId);
        if (!active) return;
        // Rows arrive newest-first. A later agent decision supersedes an older
        // worker candidate, so reload faithfully restores unresolved conflicts.
        const latest = new Map<string, typeof reviews[number]>();
        for (const review of reviews) if (!latest.has(review.field)) latest.set(review.field, review);
        const restoredConflicts: WizardConflict[] = [];
        const restoredProvenance = { ...provenanceRef.current };
        const restoredConfirmed = new Set(confirmedRef.current);
        for (const review of latest.values()) {
          if (review.state === "conflict") restoredConflicts.push({ field: review.field, label: fieldLabel(review.field), existing: review.existingValue || initial[review.field] || "", extracted: review.candidateValue, source: "Persisted document candidate", choice: "existing" });
          if (review.state === "auto_applied" && !restoredProvenance[review.field]) restoredProvenance[review.field] = "Document extraction";
          if (review.state === "confirmed" || review.state === "corrected") restoredConfirmed.add(review.field);
        }
        provenanceRef.current = restoredProvenance;
        confirmedRef.current = restoredConfirmed;
        setProvenance(restoredProvenance);
        setConfirmed(Array.from(restoredConfirmed));
        setConflicts(restoredConflicts);
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

  // Extraction is durable and asynchronous. Poll only live states, then stop
  // at a terminal result. A sequence guard prevents an older response from
  // replacing newer persisted candidates or an agent's saved review.
  useEffect(() => {
    const hasLiveExtraction = documents.some((doc) => {
      const state = doc.extraction?.status ?? (doc.metadata.extraction as { status?: string } | undefined)?.status;
      return state === "queued" || state === "processing";
    });
    if (!hasLiveExtraction) return;
    let active = true;
    const refreshDocuments = async () => {
      const sequence = ++refreshSequenceRef.current;
      const stored = await listApplicationDocuments(applicationId);
      if (!active || sequence !== refreshSequenceRef.current) return;
      setDocuments(stored.filter((doc) => doc.isCurrent && WIZARD_CATEGORIES.has(doc.category)).map((doc) => ({
        id: doc.id, category: doc.category, filename: doc.filename, fileSize: doc.fileSize,
        mimeType: doc.mimeType, stored: true, storagePath: doc.storagePath,
        extractedFields: Array.isArray((doc.metadata as { extractedFields?: unknown }).extractedFields)
          ? ((doc.metadata as { extractedFields: string[] }).extractedFields) : [],
        extraction: formatDocumentExtraction((doc.metadata as { extraction?: DocumentExtraction }).extraction),
        metadata: doc.metadata,
      })));
      // Candidates and conflicts are database rows, not client-only OCR state.
      // Reload them with the documents, but never merge them into values here:
      // a visible agent decision is still required for anything non-empty.
      const reviews = await listDocumentFieldReviews(applicationId);
      if (!active || sequence !== refreshSequenceRef.current) return;
      const latest = new Map<string, typeof reviews[number]>();
      for (const review of reviews) if (!latest.has(review.field)) latest.set(review.field, review);
      setConflicts([...latest.values()]
        .filter((review) => review.state === "conflict")
        .map((review) => ({
          field: review.field,
          label: fieldLabel(review.field),
          existing: review.existingValue || valuesRef.current[review.field] || "",
          extracted: review.candidateValue,
          source: "Persisted document candidate",
          choice: "existing" as const,
        })));
    };
    const interval = window.setInterval(() => { void refreshDocuments().catch(() => undefined); }, 5000);
    return () => { active = false; window.clearInterval(interval); };
  }, [applicationId, documents]);

  /* ------------------------------------------------------------ helpers */

  const updateValue = useCallback((field: string, value: string) => {
    const next = { ...valuesRef.current, [field]: value };
    valuesRef.current = next;
    setValues(next);
  }, []);

  const setProvenanceFor = useCallback((fields: string[], source: string) => {
    if (fields.length === 0) return;
    const next = { ...provenanceRef.current };
    for (const field of fields) next[field] = source;
    provenanceRef.current = next;
    setProvenance(next);
  }, []);

  /** Merges extracted fields — never silently overwriting a confirmed value. */
  const mergeExtraction = useCallback(
    (fields: Record<string, string>, source: string) => {
      const manual = manualKeysRef.current;
      const next = { ...valuesRef.current };
      const added: WizardConflict[] = [];
      const applied: string[] = [];

      for (const [field, raw] of Object.entries(fields)) {
        const value = String(raw ?? "").trim();
        if (!value) continue;
        const existing = (next[field] ?? "").trim();
        if (!existing) {
          next[field] = value;
          applied.push(field);
          continue;
        }
        if (existing.toLowerCase() === value.toLowerCase()) continue;

        // Passport-vs-licence, agent-confirmed, and academic (multi-doc) values are
        // never overwritten automatically — they become an explicit conflict.
        const crossDoc = stepIdRef.current === "licence" && CROSS_DOC_FIELDS.has(field);
        const keepExisting = manual.has(field) || crossDoc || stepIdRef.current === "academic";
        if (keepExisting) {
          added.push({
            field,
            label: fieldLabel(field),
            existing,
            extracted: value,
            source: crossDoc && !manual.has(field) ? "Passport vs driving licence" : source,
            choice: "existing",
          });
        } else {
          next[field] = value;
          applied.push(field);
        }
      }

      valuesRef.current = next;
      setValues(next);
      if (applied.length > 0) setProvenanceFor(applied, source);
      if (added.length > 0) {
        setConflicts((prev) => [...prev.filter((c) => !added.some((a) => a.field === c.field)), ...added]);
      }
    },
    [setProvenanceFor],
  );

  const handleExtracted = useCallback(
    (fields: Record<string, string>, source: string) => {
      // Fold component scores into the single "Score (Individual & Overall)" field.
      if (stepIdRef.current === "english" && fields.english_score && fields.english_components) {
        fields = {
          ...fields,
          english_score: `${fields.english_score} (Overall) \u00b7 ${fields.english_components}`,
        };
      }
      mergeExtraction(fields, source);
    },
    [mergeExtraction],
  );

  const handleManualChange = useCallback(
    (field: string, value: string) => {
      manualKeysRef.current.add(field);
      updateValue(field, value);
      setProvenanceFor([field], "Manual entry");
      if (!confirmedRef.current.has(field)) {
        confirmedRef.current.add(field);
        setConfirmed(Array.from(confirmedRef.current));
      }
      setConflicts((prev) => prev.filter((c) => c.field !== field));
      void saveDocumentReview({ applicationId, values: { [field]: value }, provenance: { [field]: "Manual entry" }, confirmed: Array.from(confirmedRef.current), resolutions: [{ field, state: "corrected" }] }).catch(error => setSaveError(error.message));
    },
    [applicationId, updateValue, setProvenanceFor],
  );

  const handleConfirm = useCallback((field: string) => {
    manualKeysRef.current.add(field);
    confirmedRef.current.add(field);
    setConfirmed(Array.from(confirmedRef.current));
    void saveDocumentReview({ applicationId, values: { [field]: valuesRef.current[field] ?? "" }, provenance: { [field]: provenanceRef.current[field] ?? "Document extraction" }, confirmed: Array.from(confirmedRef.current), resolutions: [{ field, state: "confirmed" }] }).catch(error => setSaveError(error.message));
  }, [applicationId]);

  const handleResolveConflict = useCallback(
    (field: string, choice: "existing" | "extracted") => {
      const conflict = conflictsRef.current.find((c) => c.field === field);
      manualKeysRef.current.add(field);
      if (conflict) updateValue(field, choice === "extracted" ? conflict.extracted : conflict.existing);
      setProvenanceFor([field], choice === "extracted" ? conflict?.source ?? "Document" : "Manual entry");
      handleConfirm(field);
      setConflicts((prev) => prev.map((c) => (c.field === field ? { ...c, choice } : c)));
      void saveDocumentReview({ applicationId, values: { [field]: choice === "extracted" ? conflict?.extracted ?? "" : conflict?.existing ?? "" }, provenance: { [field]: choice === "extracted" ? conflict?.source ?? "Document extraction" : "Manual entry" }, confirmed: Array.from(confirmedRef.current), resolutions: [{ field, candidateValue: conflict?.extracted, state: choice === "extracted" ? "confirmed" : "corrected" }] }).catch(error => setSaveError(error.message));
    },
    [applicationId, updateValue, setProvenanceFor, handleConfirm],
  );

  const handleUpload = useCallback(
    async (file: File, category: string, meta: Record<string, unknown>) => {
      const stored = await uploadApplicationDocument({
        applicationId,
        category,
        file,
        uploadedBy: profile?.id ?? null,
        metadata: meta,
      });
      const doc: WizardDoc = {
        id: stored.id,
        category,
        filename: file.name,
        fileSize: file.size,
        mimeType: file.type,
        stored: true,
        storagePath: stored.path,
        extractedFields: Array.isArray(meta.extractedFields) ? (meta.extractedFields as string[]) : [],
        metadata: meta,
      };
      setDocuments((prev) => [doc, ...prev]);
      return doc;
    },
    [applicationId, profile?.id],
  );

  /** Confirm/reject an extraction on its source document, never in shared OCR state. */
  const handleReviewDocument = useCallback(async (doc: WizardDoc, confirmedValues: Record<string, string>, status: "confirmed" | "rejected") => {
    const extracted = doc.extraction?.extracted ?? {};
    const safeValues = Object.fromEntries(Object.entries(confirmedValues).filter(([field, value]) => {
      if (status !== "confirmed" || !String(value ?? "").trim()) return false;
      const existing = (valuesRef.current[field] ?? "").trim();
      const candidate = (extracted[field] ?? "").trim();
      return !existing || existing.toLocaleLowerCase() === candidate.toLocaleLowerCase() || provenanceRef.current[field] === "Document extraction";
    }));
    const confirmedFields = Object.keys(safeValues);
    const nextConfirmed = new Set(confirmedRef.current);
    if (status === "confirmed") for (const field of confirmedFields) nextConfirmed.add(field);
    const provenance = Object.fromEntries(confirmedFields.map((field) => [field, `${doc.filename} (document review)`]));
    // The locked, authorised RPC is the only path that writes confirmed form
    // values. Existing manual/verified values that differ remain untouched.
    await saveDocumentReview({
      applicationId,
      values: safeValues,
      provenance,
      confirmed: Array.from(nextConfirmed),
      resolutions: Object.keys(extracted).map((field) => ({
        field,
        documentId: doc.id,
        candidateValue: extracted[field],
        state: status === "confirmed" && field in safeValues ? "confirmed" : "rejected",
      })),
    });
    const extraction: DocumentExtraction = {
      extracted,
      confirmed: status === "confirmed" ? confirmedValues : {},
      status,
      source: doc.extraction?.source ?? { engine: "tesseract.js", parser: "parseDocument", extractedAt: new Date().toISOString() },
    };
    const nextDoc = { ...doc, extraction };
    const metadata = { ...(doc.metadata ?? {}), extraction, extractedFields: Object.keys(extracted) };
    await updateDocumentExtraction(doc.id, metadata, status === "confirmed" ? "Accepted" : "Rejected");
    setDocuments((previous) => previous.map((item) => item.id === doc.id ? nextDoc : item));
    confirmedRef.current = nextConfirmed;
    setConfirmed(Array.from(nextConfirmed));
    if (status === "confirmed" && confirmedFields.length > 0) {
      const next = { ...valuesRef.current, ...safeValues };
      valuesRef.current = next;
      setValues(next);
      setProvenanceFor(confirmedFields, `${doc.filename} (document review)`);
    }

    // This is deliberately derived only from accepted document reviews. The
    // individual record remains the source of truth and supports many awards.
    const nextDocuments = documents.map((item) => item.id === doc.id ? nextDoc : item);
    const qualifications = nextDocuments
      .filter((item) => item.category === "Academic" && item.extraction?.status === "confirmed")
      .map((item) => ({ documentId: item.id, filename: item.filename, ...item.extraction!.confirmed }));
    const latest = qualifications.at(-1) ?? {};
    const summary: Record<string, string> = {};
    for (const [key, value] of Object.entries(latest)) {
      if (key.startsWith("academic_") && typeof value === "string") summary[key] = value;
    }
    await patchApplicationData(applicationId, { values: summary, academicQualifications: qualifications });
    if (status === "confirmed") {
      const next = { ...valuesRef.current, ...summary };
      valuesRef.current = next;
      setValues(next);
    }
  }, [applicationId, documents, setProvenanceFor]);

  const handleReprocessDocument = useCallback(async (doc: WizardDoc, _scanType: ScanType): Promise<void> => {
    await queueDocumentExtraction(doc.id, true);
    setDocuments((previous) => previous.map((item) => item.id === doc.id
      ? { ...item, metadata: { ...(item.metadata ?? {}), extraction: { ...(item.extraction ?? {}), status: "processing" } } }
      : item));
  }, []);

  const handleRemoveDoc = useCallback(async (doc: WizardDoc) => {
    await deleteApplicationDocument({ id: doc.id, storagePath: doc.storagePath });
    setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
  }, []);

  const handleViewDocument = useCallback(async (doc: WizardDoc) => {
    setViewError("");
    setViewingPath(doc.storagePath);
    try {
      const url = await getDocumentSignedUrl(doc.storagePath);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setViewError(error instanceof Error ? error.message : "We could not open that document.");
    } finally {
      setViewingPath("");
    }
  }, []);

  /* -------------------------------------------------------------- derived */

  const outstanding = useMemo(() => {
    const list: string[] = [];
    if (!documents.some((doc) => doc.category === "Passport")) {
      list.push("Passport copy not provided — required before the student's identity can be verified.");
    }
    if (values.has_usi === "Not sure") {
      list.push("USI to be confirmed later — the student must confirm whether they already hold a USI.");
    }
    if (values.has_usi === "Yes" && !(values.usi_number ?? "").trim()) {
      list.push("USI number still required — the student indicated they already have one.");
    }
    if (!(values.ec_name ?? "").trim()) {
      list.push("Emergency contact not captured — add it on the Additional student details step.");
    }
    return list;
  }, [documents, values]);

  const missing = useMemo(() => {
    const list: string[] = [];
    if (!(values.first_name ?? "").trim() || !(values.last_name ?? "").trim()) {
      list.push("Student name (given name and surname)");
    }
    if (!(values.dob ?? "").trim()) list.push("Date of birth");
    if (!(values.passport_number ?? "").trim() && !documents.some((doc) => doc.category === "Passport")) {
      list.push("Passport details");
    }
    if (!(values.address_type ?? "").trim()) list.push("Australian or overseas address");
    return list;
  }, [values, documents]);

  /* ------------------------------------------------------------ navigate */

  const scrollTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  const goTo = (index: number) => {
    setStep(Math.max(0, Math.min(index, WIZARD_STEPS.length - 1)));
    scrollTop();
  };

  const goNext = () => {
    if (current.id !== "review") visitedRef.current.add(current.id);
    goTo(step + 1);
  };

  const goBack = () => goTo(step - 1);

  const handleContinue = async () => {
    setSaving(true);
    setSaveError("");
    try {
      await flushApplicationEdits(applicationId);
      const clean: Record<string, string> = {};
      Object.entries(valuesRef.current).forEach(([key, value]) => {
        if (value && value.trim() !== "") clean[key] = value;
      });
      // "Not sure" is a wizard-only answer — never write it to the form, which only
      // accepts Yes / No for has_usi. Leaving it blank keeps the form question open.
      if (clean.has_usi === "Not sure") delete clean.has_usi;
      const studentName = [clean.first_name, clean.last_name].filter(Boolean).join(" ").trim();
      const meta: WizardMeta = {
        completedSteps: Array.from(visitedRef.current),
        outstanding,
        updatedAt: new Date().toISOString(),
        provenance: provenanceRef.current,
        confirmed: Array.from(confirmedRef.current),
      };
      await saveDocumentReview({ applicationId, values: clean, provenance: provenanceRef.current, confirmed: Array.from(confirmedRef.current), wizard: meta as unknown as Record<string, unknown>, studentName });
      onFinish();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "We could not save the extracted details.");
    } finally {
      setSaving(false);
    }
  };

  /* --------------------------------------------------------------- render */

  const body = () => {
    if (loading) return <PortalLoading label="Loading the document wizard\u2026" />;
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

    if (current.id === "review") {
      return (
        <WizardReviewStep
          values={values}
          provenance={provenance}
          confirmed={confirmed}
          documents={documents}
          conflicts={conflicts}
          outstanding={outstanding}
          missing={missing}
          steps={WIZARD_STEPS}
          onManualChange={handleManualChange}
          onConfirm={handleConfirm}
          onResolveConflict={handleResolveConflict}
          onEditStep={goTo}
          onViewDocument={(doc) => void handleViewDocument(doc)}
          viewingPath={viewingPath}
        />
      );
    }

    return (
      <WizardDocumentStep
        step={current}
        values={values}
        existingDocs={documents.filter((doc) => current.category && doc.category === current.category)}
        conflicts={conflicts.filter((c) => current.fields.includes(c.field))}
        onExtracted={handleExtracted}
        onUpload={handleUpload}
        onReviewDocument={handleReviewDocument}
        onReprocessDocument={handleReprocessDocument}
        onRemoveDoc={handleRemoveDoc}
        onManualChange={handleManualChange}
        onResolveConflict={handleResolveConflict}
      />
    );
  };

  const isReview = current.id === "review";
  const skipLabel = current.id === "passport" ? "Continue without passport" : "Skip";
  const activeExtraction = documents.find((doc) => doc.extraction?.status === "queued" || doc.extraction?.status === "processing");

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
                Prefill the student application from documents, then continue to the full form. {agencyName}
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
                <i className={done ? "ri-check-line" : item.icon} aria-hidden="true" />
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
            {step > 0 && !loading && !loadError ? (
              <button
                type="button"
                onClick={goBack}
                className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 px-3.5 py-2 text-sm font-semibold text-foreground-700 transition-colors hover:bg-background-100"
              >
                <i className="ri-arrow-left-line" aria-hidden="true" />
                Back
              </button>
            ) : null}
          </div>

          {!loading && !loadError ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              {!isReview ? (
                <button
                  type="button"
                  onClick={goNext}
                  className="inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-700 transition-colors hover:border-primary-300 hover:text-primary-700"
                >
                  {skipLabel}
                </button>
              ) : null}
              {isReview ? (
                <button
                  type="button"
                  onClick={() => void handleContinue()}
                  disabled={saving}
                  className="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? (
                    <>
                      <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
                      Saving&hellip;
                    </>
                  ) : (
                    <>
                      Continue to application form
                      <i className="ri-arrow-right-circle-line" aria-hidden="true" />
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={goNext}
                  className="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
                >
                  Next
                  <i className="ri-arrow-right-line" aria-hidden="true" />
                </button>
              )}
            </div>
          ) : null}
        </div>

        {viewError ? (
          <div className="border-t border-background-200 px-5 py-3 md:px-6">
            <PortalError message={viewError} />
          </div>
        ) : null}

        {saveError ? (
          <div className="border-t border-background-200 px-5 py-3 md:px-6">
            <PortalError message={saveError} onRetry={() => void handleContinue()} />
          </div>
        ) : null}

        {!loading && !loadError ? (
          <div className="border-t border-background-200 px-5 py-3 text-center md:px-6">
            <p className="text-[11px] text-foreground-400">
              Nothing is submitted from this wizard. Documents are stored privately against this draft; the student
              application is submitted only from the full form after review.
            </p>
          </div>
        ) : null}

        {activeExtraction ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-background-50/95 p-6 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-label="Document extraction in progress">
            <div className="max-w-sm text-center">
              <i className="ri-loader-4-line mx-auto block animate-spin text-4xl text-primary-600" aria-hidden="true" />
              <p className="mt-4 break-words text-sm font-semibold text-foreground-950">{activeExtraction.filename}</p>
              <p className="mt-2 text-sm text-foreground-600">Reading document with AI…</p>
              <p className="mt-1 text-xs text-foreground-500">Your document is stored securely. This window will update automatically when review values are ready.</p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
