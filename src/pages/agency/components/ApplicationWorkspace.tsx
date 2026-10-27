import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AppField, AppSection } from "@/data/applicationForms";
import { ApplicationFieldControl } from "@/components/feature/applicationFieldKit";
import { isConditionMet, isFieldFilled, sectionHeading, sectionIcon } from "@/components/feature/applicationFieldHelpers";
import TermsDeclaration from "@/components/feature/TermsDeclaration";
import { applyFormValues, collectFormValues, type DraftValues } from "@/lib/applicationDraft";
import {
  COURSE_FIELD,
  LOCKED_AGENT_FIELDS,
  portalSections,
  resolveCourseOption,
} from "@/pages/agency/lib/portalSections";
import {
  listInstitutionCourses,
  flushApplicationEdits,
  type ApplicationCourseRow,
  saveApplicationDraft,
  submitApplication,
  deleteApplicationDocument,
  getDocumentSignedUrl,
  listApplicationDocuments,
  queueDocumentExtraction,
  uploadApplicationDocument,
  uploadConsentDocument,
  type ApplicationDetail,
  type DocumentRow,
} from "@/pages/agency/lib/portalApplications";
import { documentCategoryForField, extractionStatus } from "@/pages/agency/lib/documentAttachments";
import { canSubmitApplicationStatus } from "@/pages/agency/lib/applicationAccess";
import ApplicationReview, { type ConsentState } from "@/pages/agency/components/ApplicationReview";
import ApplicationAttachmentField from "@/pages/agency/components/ApplicationAttachmentField";
import { PortalError } from "@/pages/agency/components/PortalUI";

const FORM_ID = "portal-application-form";
const DEBOUNCE_MS = 1200;
const DECLARATION_VERSION = "1.0";

interface WorkspaceProps {
  application: ApplicationDetail;
  agentName: string;
  agentEmail: string;
  agentPhone: string;
  agencyName: string;
  readOnly: boolean;
  onSaved?: () => void;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export default function ApplicationWorkspace({
  application,
  agentName,
  agentEmail,
  agentPhone,
  agencyName,
  readOnly,
  onSaved,
}: WorkspaceProps) {
  const [courseOptions, setCourseOptions] = useState<ApplicationCourseRow[]>([]);
  const sections = useMemo(() => application.tenantId ? portalSections.map(section => ({ ...section, fields: section.fields.map(field => field.name === COURSE_FIELD ? { ...field, options: courseOptions.map(course => course.code + " - " + course.title) } : field) })) : portalSections, [application.tenantId, courseOptions]);
  useEffect(() => { if (application.tenantId) void listInstitutionCourses().then(setCourseOptions).catch(e => setSaveError(e.message)); }, [application.tenantId]);
  const resolveCourse = useCallback((label: string) => {
    if (!application.tenantId) return resolveCourseOption(label);
    const course = courseOptions.find(item => item.code + " - " + item.title === label);
    if (!course) throw new Error("This course is no longer available. Reload the application.");
    return course;
  }, [application.tenantId, courseOptions]);
  const reviewIndex = sections.length;

  const storedValues = useMemo<DraftValues>(() => {
    const data = (application.data ?? {}) as { values?: DraftValues };
    return data.values ?? {};
  }, [application.data]);

  // Only agency/agent fields are pre-filled — student details always start blank.
  const seed = useMemo<Record<string, string>>(
    () => ({
      via_agent: "Yes",
      agent_agency: agencyName,
      agent_contact_name: agentName,
      agent_email: agentEmail,
      agent_phone: agentPhone,
    }),
    [agencyName, agentName, agentEmail, agentPhone],
  );

  const mergedInitial = useMemo<DraftValues>(() => ({ ...seed, ...storedValues }), [seed, storedValues]);

  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    Object.entries(mergedInitial).forEach(([key, val]) => {
      if (typeof val === "string") out[key] = val;
    });
    return out;
  });

  const [step, setStep] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ overall: number; sections: Array<{ done: number; total: number }> }>({
    overall: 0,
    sections: sections.map(() => ({ done: 0, total: 0 })),
  });
  const [showErrors, setShowErrors] = useState(false);
  const [reviewValues, setReviewValues] = useState<DraftValues | null>(null);
  const [consent, setConsent] = useState<ConsentState>({
    method: "",
    confirmed: false,
    authorised: false,
    fileName: "",
    file: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submittedRef, setSubmittedRef] = useState<string | null>(null);
  const [documentMessage, setDocumentMessage] = useState("");
  const [attachments, setAttachments] = useState<DocumentRow[]>([]);
  const [documentBusy, setDocumentBusy] = useState("");

  const formRef = useRef<HTMLFormElement>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const timerRef = useRef<number | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(false);
  const dirtyRef = useRef(false);
  const hydratingRef = useRef(true);
  const progressRef = useRef(progress);
  const initialCoursesRef = useRef(storedValues[COURSE_FIELD] ?? []);

  useEffect(() => {
    if (!courseOptions.length || !formRef.current) return;
    applyFormValues(formRef.current, { [COURSE_FIELD]: initialCoursesRef.current });
  }, [courseOptions]);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const refreshAttachments = useCallback(async () => {
    const rows = await listApplicationDocuments(application.id);
    setAttachments(rows.filter((document) => document.isCurrent));
  }, [application.id]);

  useEffect(() => {
    void refreshAttachments().catch((error) => setDocumentMessage(error instanceof Error ? error.message : "We could not load saved documents."));
  }, [refreshAttachments]);

  useEffect(() => {
    if (!attachments.some((document) => ["queued", "processing"].includes(extractionStatus(document.metadata)))) return undefined;
    const interval = window.setInterval(() => { void refreshAttachments().catch(() => undefined); }, 5000);
    return () => window.clearInterval(interval);
  }, [attachments, refreshAttachments]);

  /* --------------------------------------------------------- progress */

  const computeProgress = useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    let doneAll = 0;
    let totalAll = 0;
    const per = sections.map((section) => {
      if (!isConditionMet(section.showIf, values)) return { done: 0, total: 0 };
      let done = 0;
      let total = 0;
      for (const field of section.fields) {
        if (!field.required) continue;
        if (field.type === "static" || field.type === "table" || field.type === "terms") continue;
        if (!isConditionMet(field.showIf, values)) continue;
        total += 1;
        const category = field.type === "file" ? documentCategoryForField(field.name) : null;
        if (category ? attachments.some((document) => document.category === category) : isFieldFilled(form, field)) done += 1;
      }
      doneAll += done;
      totalAll += total;
      return { done, total };
    });
    setProgress({
      overall: totalAll > 0 ? Math.round((doneAll / totalAll) * 100) : 0,
      sections: per,
    });
  }, [sections, values, attachments]);

  useEffect(() => {
    computeProgress();
  }, [computeProgress]);

  /* ------------------------------------------------------------- save */

  const collectSnapshot = useCallback(() => {
    const form = formRef.current;
    if (!form) return null;
    const collected = collectFormValues(form);
    for (const element of Array.from(form.elements)) {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) || !element.name || element instanceof HTMLInputElement && ["file","button","submit"].includes(element.type)) continue;
      const key = element.name.replace(/\[\]$/, "");
      if (!(key in collected)) collected[key] = element instanceof HTMLInputElement && element.type === "checkbox" ? [] : "";
    }
    const coursesRaw = (collected[COURSE_FIELD] as string[] | undefined) ?? [];
    return { values: collected, courses: coursesRaw };
  }, []);

  const runSave = useCallback(async () => {
    const snapshot = collectSnapshot();
    if (!snapshot) return;
    dirtyRef.current = false;
    setSaveState("saving");
    setSaveError("");
    try {
      await saveApplicationDraft(application.id, {
        data: {
          values: snapshot.values,
          courses: snapshot.courses.map(resolveCourse),
          progress: progressRef.current,
          savedAt: new Date().toISOString(),
          preparedBy: agentName,
        },
        studentName: [String(snapshot.values.first_name ?? ""), String(snapshot.values.last_name ?? "")]
          .filter(Boolean)
          .join(" ")
          .trim(),
        studentEmail: String(snapshot.values.email ?? ""),
        intake: String(snapshot.values.preferred_intake ?? ""),
        completion: progressRef.current.overall,
      });

      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      onSaved?.();
    } catch (error) {
      dirtyRef.current = true;
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "We could not save your draft.");
      throw error;
    }
  }, [application.id, collectSnapshot, agentName, onSaved, resolveCourse]);

  /** Serialises saves so an older save can never overwrite a newer change. */
  const enqueueSave = useCallback(() => {
    pendingRef.current = true;
    queueRef.current = queueRef.current.catch(() => undefined).then(async () => {
      if (!pendingRef.current) return;
      pendingRef.current = false;
      await runSave();
    });
    return queueRef.current;
  }, [runSave]);

  const scheduleSave = useCallback((userInput = false) => {
    // Restoration dispatches synthetic changes. Suppress those, but preserve a
    // real user's edit made during the short conditional-field hydration window.
    if (readOnly || (hydratingRef.current && !userInput)) return;
    dirtyRef.current = true;
    setSaveState("saving");
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void enqueueSave().catch(() => undefined);
    }, DEBOUNCE_MS);
  }, [readOnly, enqueueSave]);

  const flushSave = useCallback(async () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (dirtyRef.current) await enqueueSave();
    await queueRef.current;
    await flushApplicationEdits(application.id);
  }, [enqueueSave, application.id]);

  useEffect(() => {
    const flush = (event: Event) => (event as CustomEvent<{ waits: Promise<unknown>[] }>).detail.waits.push(flushSave());
    window.addEventListener("portal-before-scope-switch", flush);
    return () => window.removeEventListener("portal-before-scope-switch", flush);
  }, [flushSave]);

  /* --------------------------------------------------------- hydrate */

  useEffect(() => {
    hydratingRef.current = true;
    const form = formRef.current;
    if (!form) return undefined;
    // Restore the last successfully saved values (including radios + checkboxes).
    applyFormValues(form, mergedInitial);
    const handle = window.setTimeout(() => {
      hydratingRef.current = false;
      computeProgress();
    }, 160);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application.id]);

  // Flush any pending save when leaving the workspace.
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (dirtyRef.current) void enqueueSave().catch(() => undefined);
    },
    [enqueueSave],
  );

  /* --------------------------------------------------------- events */

  const handleChange = (event: FormEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    // Persisted portal attachments are managed by ApplicationAttachmentField;
    // never let the native file event create a second upload request.
    if (target?.type === "file") return;
    if (target?.name && (target.type === "radio" || target.type === "select-one")) {
      setValues((prev) => ({ ...prev, [target.name]: target.value }));
    }
    window.requestAnimationFrame(() => computeProgress());
    scheduleSave(event.nativeEvent.isTrusted);
  };

  const uploadAttachment = useCallback(async (field: AppField, files: FileList | null) => {
    const category = documentCategoryForField(field.name);
    if (!category || !files?.length) return;
    setDocumentBusy("upload");
    setDocumentMessage("Uploading document securely…");
    try {
      for (const file of Array.from(files)) {
        await uploadApplicationDocument({ applicationId: application.id, category, file, metadata: { kind: category === "English Test" ? "english" : category.toLowerCase() } });
      }
      await refreshAttachments();
      onSaved?.();
      setDocumentMessage(`Starting AI extraction for ${files.length} document${files.length === 1 ? "" : "s"}… You can continue editing while it reads the document.`);
    } finally { setDocumentBusy(""); }
  }, [application.id, onSaved, refreshAttachments]);

  const previewAttachment = useCallback(async (document: DocumentRow) => {
    setDocumentBusy(document.id);
    try {
      const url = await getDocumentSignedUrl(document.storagePath);
      window.open(url, "_blank", "noopener,noreferrer");
    } finally { setDocumentBusy(""); }
  }, []);

  const extractAttachment = useCallback(async (document: DocumentRow) => {
    setDocumentBusy(document.id);
    setDocumentMessage("");
    try {
      const status = extractionStatus(document.metadata);
      await queueDocumentExtraction(document.id, status !== "Not requested");
      await refreshAttachments();
      onSaved?.();
      setDocumentMessage(`Extraction ${status === "Not requested" ? "queued" : "requeued"}. Review suggested values before confirming them.`);
    } finally { setDocumentBusy(""); }
  }, [onSaved, refreshAttachments]);

  const deleteAttachment = useCallback(async (document: DocumentRow) => {
    setDocumentBusy(document.id);
    setDocumentMessage("");
    try {
      await deleteApplicationDocument({ id: document.id, storagePath: document.storagePath });
      await refreshAttachments();
      onSaved?.();
      setDocumentMessage(`${document.filename} was deleted.`);
    } finally { setDocumentBusy(""); }
  }, [onSaved, refreshAttachments]);

  const goTo = (index: number) => {
    void flushSave().catch(() => undefined);
    setStep(index);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const fieldMissing = useCallback((field: AppField): boolean => {
    const form = formRef.current;
    if (!form) return true;
    const documentCategory = field.type === "file" ? documentCategoryForField(field.name) : null;
    if (documentCategory) {
      return !attachments.some((document) => document.category === documentCategory);
    }
    if (!isFieldFilled(form, field)) return true;
    const control = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      `[name="${field.name}"]`,
    );
    if (control && !control.checkValidity()) return true;
    return false;
  }, [attachments]);

  /** Required field labels still missing, grouped by the section they live in. */
  const collectMissing = useCallback(() => {
    const missing: string[] = [];
    const firstBySection: Array<number | null> = sections.map(() => null);
    sections.forEach((section, index) => {
      if (!isConditionMet(section.showIf, values)) return;
      for (const field of section.fields) {
        if (!field.required) continue;
        if (field.type === "static" || field.type === "table" || field.type === "terms") continue;
        if (!isConditionMet(field.showIf, values)) continue;
        if (fieldMissing(field)) {
          missing.push(`${sectionHeading(section.title, index)}: ${field.label}`);
          if (firstBySection[index] === null) firstBySection[index] = index;
        }
      }
    });
    const firstIndex = firstBySection.findIndex((v) => v !== null);
    return { missing, firstIndex };
  }, [sections, values, fieldMissing]);

  const openReview = () => {
    const form = formRef.current;
    if (!form) return;
    const collected = collectFormValues(form);
    setReviewValues(collected);
    setStep(reviewIndex);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSubmit = async () => {
    if (readOnly || submitting) return;
    setSubmitError("");
    const { missing, firstIndex } = collectMissing();
    setShowErrors(true);
    if (missing.length > 0) {
      setStep(firstIndex >= 0 ? firstIndex : 0);
      return;
    }
    if (!consent.method || !consent.confirmed || !consent.authorised) {
      setSubmitError("Please record the student consent method and both confirmations before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      await flushSave();
      const signedDocumentRef = consent.file ? await uploadConsentDocument(application.id, consent.file) : "";
      const snapshot = collectSnapshot();
      const reference = await submitApplication(application.id, {
        consent: { method: consent.method, confirmed: consent.confirmed, authorised: consent.authorised, declarationVersion: DECLARATION_VERSION, signedDocumentRef },
        values: snapshot?.values ?? {},
        courses: snapshot?.courses ?? [],
        meta: {
          preparedBy: agentName,
          agency: agencyName,
          consentMethod: consent.method,
          submittedThrough: "agency_portal",
        },
      });
      setSubmittedRef(reference || application.reference);
      onSaved?.();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  /* -------------------------------------------------------- render */

  if (submittedRef) {
    return (
      <div className="rounded-card border border-accent-200 bg-accent-50 p-6 text-center md:p-10">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent-500 text-2xl text-background-50">
          <i className="ri-check-line" aria-hidden="true" />
        </span>
        <h3 className="mt-4 font-heading text-xl font-bold text-foreground-950">Application submitted</h3>
        <p className="mx-auto mt-2 max-w-lg text-sm text-foreground-600">
          We received the application for {String(values.first_name ?? "")} {String(values.last_name ?? "")}. SLIT admissions
          will review it and any status change will appear in your notifications.
        </p>
        <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-background-50 px-4 py-2 font-mono text-sm font-semibold text-foreground-900">
          <i className="ri-file-list-3-line text-primary-600" aria-hidden="true" />
          {submittedRef}
        </p>
      </div>
    );
  }

  const isReview = step === reviewIndex;

  const saveIndicator = () => {
    if (readOnly) return null;
    if (saveState === "saving") {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground-600" aria-live="polite">
          <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
          Saving&hellip;
        </span>
      );
    }
    if (saveState === "saved" && lastSavedAt) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-700" aria-live="polite">
          <i className="ri-cloud-line" aria-hidden="true" />
          Saved {new Date(lastSavedAt).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
        </span>
      );
    }
    if (saveState === "error") {
      return (
        <span className="inline-flex items-center gap-2 text-xs font-medium text-primary-800" role="alert">
          <i className="ri-error-warning-line" aria-hidden="true" />
          Draft not saved
          <button
            type="button"
            onClick={() => void enqueueSave()}
            className="cursor-pointer rounded-md border border-primary-300 bg-background-50 px-2 py-0.5 font-semibold text-primary-700 hover:bg-primary-100"
          >
            Retry
          </button>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground-500">
        <i className="ri-save-3-line" aria-hidden="true" />
        Draft saved automatically
      </span>
    );
  };

  const renderField = (field: AppField) => {
    const locked = readOnly || LOCKED_AGENT_FIELDS.has(field.name);
    if (field.type === "static") {
      return (
        <div key={field.name} className="md:col-span-2">
          <ApplicationFieldControl field={field} formId={FORM_ID} />
        </div>
      );
    }
    if (field.type === "terms") {
      return (
        <div key={field.name} className="md:col-span-2">
          <TermsDeclaration heading={field.label} terms={field.options ?? []} />
        </div>
      );
    }
    const spanFull = field.full || field.type === "textarea" || field.type === "checkbox";
    const missing = showErrors && field.required && fieldMissing(field);
    return (
      <div key={field.name} data-scan-field className={spanFull ? "md:col-span-2" : ""}>
        <label
          htmlFor={`${FORM_ID}-${field.name}`}
          className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-700"
        >
          {field.label}
          {field.required ? <span className="text-primary-600">*</span> : null}
          {locked && LOCKED_AGENT_FIELDS.has(field.name) ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary-100 px-2 py-0.5 text-[10px] font-semibold normal-case text-secondary-900">
              <i className="ri-lock-line" aria-hidden="true" />
              Auto-filled
            </span>
          ) : null}
        </label>
        {field.description ? (
          <p className="mb-2 text-xs leading-relaxed text-foreground-500">{field.description}</p>
        ) : null}
        {field.type === "file" && documentCategoryForField(field.name) ? (
          <ApplicationAttachmentField
            field={field}
            documents={attachments.filter((document) => document.category === documentCategoryForField(field.name))}
            disabled={readOnly || Boolean(documentBusy)}
            busyDocumentId={documentBusy}
            onUpload={(files) => uploadAttachment(field, files)}
            onPreview={previewAttachment}
            onExtract={extractAttachment}
            onDelete={deleteAttachment}
          />
        ) : <ApplicationFieldControl field={field.name === "agent_agency" ? { ...field, options: [seed.agent_agency] } : field} formId={FORM_ID} value={(storedValues[field.name] as string) ?? seed[field.name]} locked={locked} />}
        {missing ? (
          <p className="mt-1.5 flex items-center gap-1 text-xs text-primary-700">
            <i className="ri-error-warning-line" aria-hidden="true" />
            This field is required.
          </p>
        ) : null}
      </div>
    );
  };

  const renderSectionBody = (section: AppSection) => (
    <>
      {section.description ? (
        <p className="text-xs leading-relaxed text-foreground-500">{section.description}</p>
      ) : null}
      {section.scans?.length ? <p className={`rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-xs text-secondary-900 ${section.description ? "mt-4" : ""}`}>Attached identity documents are securely processed in the background. Use the Documents tab to review suggestions before relying on them.</p> : null}
      <div
        className={`grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-x-5 ${
          section.description || section.scans?.length ? "mt-4" : ""
        }`}
      >
        {section.fields
          .filter((field) => isConditionMet(field.showIf, values))
          .map((field) => renderField(field))}
      </div>
    </>
  );

  return (
    <form
      id={FORM_ID}
      ref={formRef}
      noValidate
      onChange={handleChange}
      className="grid grid-cols-1 gap-5 lg:grid-cols-[264px_1fr]"
    >
      {documentMessage ? <p className="lg:col-span-2 rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-xs text-secondary-900" role="status">{documentMessage}</p> : null}
      {/* Section navigation */}
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-card border border-background-200 bg-background-50 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-foreground-700">Progress</p>
            <p className="text-sm font-bold text-foreground-950">{progress.overall}%</p>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-background-200">
            <div
              className="h-full rounded-full bg-accent-500 transition-all duration-500"
              style={{ width: `${progress.overall}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-foreground-500">{saveIndicator()}</p>
        </div>

        <nav className="mt-3 max-h-[calc(100vh-16rem)] overflow-y-auto rounded-card border border-background-200 bg-background-50 p-2">
          {sections.map((section, index) => {
            const stat = progress.sections[index];
            const complete = stat && stat.total > 0 && stat.done === stat.total;
            const touched = stat && stat.done > 0;
            const active = step === index;
            return (
              <button
                key={section.title ?? index}
                type="button"
                onClick={() => goTo(index)}
                className={`mb-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors ${
                  active ? "bg-primary-500 text-background-50" : "text-foreground-700 hover:bg-background-100"
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    active
                      ? "bg-background-50/25 text-background-50"
                      : complete
                        ? "bg-accent-100 text-accent-900"
                        : showErrors && touched
                          ? "bg-primary-100 text-primary-800"
                          : "bg-background-100 text-foreground-600"
                  }`}
                >
                  {complete ? <i className="ri-check-line" aria-hidden="true" /> : index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{sectionHeading(section.title, index)}</span>
                <i className={`${sectionIcon(section.title)} shrink-0 text-sm opacity-70`} aria-hidden="true" />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => (readOnly ? goTo(reviewIndex) : openReview())}
            className={`mt-1 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors ${
              isReview ? "bg-primary-500 text-background-50" : "text-foreground-700 hover:bg-background-100"
            }`}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] ${
                isReview ? "bg-background-50/25 text-background-50" : "bg-accent-100 text-accent-900"
              }`}
            >
              <i className="ri-clipboard-line" aria-hidden="true" />
            </span>
            <span className="flex-1 truncate">Review & submit</span>
          </button>
        </nav>

        {!readOnly ? (
          <button
            type="button"
            onClick={() => void flushSave().catch(() => undefined)}
            className="mt-3 inline-flex w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
          >
            <i className="ri-save-3-line" aria-hidden="true" />
            Save draft
          </button>
        ) : null}
      </aside>

      {/* Main panel */}
      <div className="min-w-0">
        {readOnly ? (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-secondary-200 bg-secondary-50 px-4 py-3 text-sm text-secondary-900">
            <i className="ri-lock-line" aria-hidden="true" />
            This application has been submitted and is read-only. Contact SLIT admissions if a correction is required.
          </div>
        ) : null}

        {saveState === "error" && saveError ? (
          <div className="mb-4">
            <PortalError message={saveError} onRetry={() => void enqueueSave()} />
          </div>
        ) : null}

        {isReview ? (
          <ApplicationReview
            values={reviewValues ?? storedValues}
            courses={
              (((reviewValues ?? storedValues)[COURSE_FIELD] as string[] | undefined) ?? [])
            }
            sections={sections}
            application={application}
            agentName={agentName}
            agencyName={agencyName}
            consent={consent}
            onConsentChange={(patch) => setConsent((prev) => ({ ...prev, ...patch }))}
            onEditSection={(index) => goTo(index)}
            missing={collectMissing().missing}
            submitting={submitting}
            submitError={submitError}
            readOnly={readOnly}
            canSubmit={canSubmitApplicationStatus(application.status)}
            onSubmit={() => void handleSubmit()}
          />
        ) : null}
        {/* Keep controls mounted across navigation/review so snapshots and
            validation include every section and never discard earlier input. */}
        {sections.map((section, index) => (
          <div key={index} hidden={isReview || index !== step || !isConditionMet(section.showIf, values)} className="rounded-card border border-background-200 bg-background-50 p-5 md:p-6">
            <h3 className="font-heading text-lg font-bold text-foreground-950">
              {sectionHeading(section.title, index)}
            </h3>
            <div className="mt-4">{renderSectionBody(section)}</div>

            <div className="mt-6 flex flex-col gap-3 border-t border-background-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => goTo(Math.max(0, step - 1))}
                disabled={step === 0}
                className="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-5 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <i className="ri-arrow-left-line" aria-hidden="true" />
                Previous
              </button>
              <span className="flex items-center gap-2 text-xs text-foreground-500">
                Section {step + 1} of {sections.length}
              </span>
              <button
                type="button"
                onClick={() => (step >= sections.length - 1 ? openReview() : goTo(step + 1))}
                className="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
              >
                {step >= sections.length - 1 ? "Review application" : "Next"}
                <i className="ri-arrow-right-line" aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}

        <span
          ref={(element) => {
            sectionRefs.current[step] = element;
          }}
          className="hidden"
          aria-hidden="true"
        />
      </div>
    </form>
  );
}

export function ApplicationWorkspaceSkeleton() {
  return <div className="rounded-card border border-background-200 bg-background-50 p-6 text-sm text-foreground-500">Loading form&hellip;</div>;
}
