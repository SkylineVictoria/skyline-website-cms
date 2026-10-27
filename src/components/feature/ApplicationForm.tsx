import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AppField, AppSection } from "@/data/applicationForms";
import { ApplicationFieldControl } from "@/components/feature/applicationFieldKit";
import { isConditionMet, isFieldFilled, sectionHeading, sectionIcon } from "@/components/feature/applicationFieldHelpers";
import TermsDeclaration from "@/components/feature/TermsDeclaration";
import DocumentScanWidget from "@/components/feature/DocumentScanWidget";
import { applyFieldValues, type ScanType } from "@/lib/docScan";
import {
  applyFormValues,
  clearApplicationDraft,
  collectFormValues,
  loadApplicationDraft,
  saveApplicationDraft,
} from "@/lib/applicationDraft";

type ApplicationFormProps = {
  formId: string;
  submitAddr: string;
  title: string;
  description?: string;
  sections: AppSection[];
  submitLabel?: string;
  beforeSubmit?: ReactNode;
  /** Called after a successful submission (used by the student workspace to sync status). */
  onSubmitted?: () => void;
  /** Pre-fills matching named fields (e.g. email from the signed-in account). Users can still edit them. */
  defaultValues?: Record<string, string>;
  /** "wizard" = one numbered step per section; "accordion" = collapsible topic panels; "single" = everything at once. */
  variant?: "single" | "wizard" | "accordion";
  /** When set, the form saves a draft to the device as the applicant types and restores it on return. */
  draftKey?: string;
  /** Values read from documents attached in the pre-application popup, applied over the form on mount. */
  prefill?: Record<string, string>;
  /** Files chosen in the pre-application popup, carried into the matching upload fields. */
  prefillFiles?: Partial<Record<ScanType, File[]>>;
};

/** Which upload field each document-popup file should land in. */
const SCAN_FILE_FIELD: Record<ScanType, string | null> = {
  passport: "passport_copy",
  english: "english_upload",
  academic: "academic_upload",
  licence: null,
  visa: "visa_copy",
};

/** Copies files chosen in the pre-application popup into the matching live upload fields. */
function injectPrefillFiles(form: HTMLFormElement, files: Partial<Record<ScanType, File[]>>): void {
  for (const [type, list] of Object.entries(files) as Array<[ScanType, File[] | undefined]>) {
    const fieldName = SCAN_FILE_FIELD[type];
    if (!fieldName || !list || list.length === 0) continue;
    const input = form.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`);
    if (!input) continue;
    try {
      const transfer = new DataTransfer();
      list.forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      /* Browser without DataTransfer — the applicant can attach the file manually. */
    }
  }
}

export default function ApplicationForm({
  formId,
  submitAddr,
  title,
  description,
  sections,
  submitLabel = "Submit",
  beforeSubmit,
  onSubmitted,
  defaultValues,
  variant = "single",
  draftKey,
  prefill,
  prefillFiles,
}: ApplicationFormProps) {
  const isWizard = variant === "wizard";
  const isAccordion = variant === "accordion";
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [openSections, setOpenSections] = useState<number[]>([0]);
  const [completion, setCompletion] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const openSectionsRef = useRef<number[]>([0]);
  const draftTimerRef = useRef<number | null>(null);
  const draftRestoredRef = useRef(false);

  /** Sections that are available right now (respecting section conditions). */
  const activeSections = useMemo(
    () => sections.filter((section) => isConditionMet(section.showIf, values)),
    [sections, values],
  );
  const total = activeSections.length;
  const isLastStep = step >= total - 1;

  useEffect(() => {
    if (step > total - 1) setStep(Math.max(0, total - 1));
  }, [step, total]);

  // Mirror the open accordion panels so a draft save always captures the latest state.
  useEffect(() => {
    openSectionsRef.current = openSections;
  }, [openSections]);

  /** Snapshots the current form into a draft object. */
  const collectDraft = useCallback(() => {
    const form = formRef.current;
    if (!form) return null;
    return { values: collectFormValues(form), openSections: openSectionsRef.current, savedAt: Date.now() };
  }, []);

  /** Saves a draft shortly after the applicant stops typing. */
  const scheduleSave = useCallback(() => {
    const key = draftKey;
    if (!key) return;
    setDraftStatus("saving");
    if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
    draftTimerRef.current = window.setTimeout(() => {
      const draft = collectDraft();
      if (!draft) return;
      void saveApplicationDraft(key, draft).then(() => {
        setDraftSavedAt(draft.savedAt);
        setDraftStatus("saved");
      });
    }, 700);
  }, [draftKey, collectDraft]);

  // Stop any pending save once the form is unmounted.
  useEffect(
    () => () => {
      if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
    },
    [],
  );

  /** Recounts how many required fields are complete, ignoring hidden/conditional ones. */
  const computeCompletion = useCallback(() => {
    const form = formRef.current;
    const next = { done: 0, total: 0 };
    if (form) {
      for (const section of sections) {
        if (!isConditionMet(section.showIf, values)) continue;
        for (const field of section.fields) {
          if (!field.required) continue;
          if (field.type === "static" || field.type === "table" || field.type === "terms") continue;
          if (!isConditionMet(field.showIf, values)) continue;
          next.total += 1;
          if (isFieldFilled(form, field)) next.done += 1;
        }
      }
    }
    setCompletion((prev) => (prev.done === next.done && prev.total === next.total ? prev : next));
  }, [sections, values]);

  useEffect(() => {
    computeCompletion();
  }, [computeCompletion]);

  // Restore a saved draft once the form has mounted, then overlay any document-popup
  // results (values, then file attachments) so fresh uploads win over older drafts.
  useEffect(() => {
    const key = draftKey;
    if (draftRestoredRef.current) return undefined;
    draftRestoredRef.current = true;
    let cancelled = false;

    const applyPrefill = () => {
      if (cancelled) return;
      const form = formRef.current;
      if (!form) return;
      if (prefill && Object.keys(prefill).length > 0) applyFieldValues(form, prefill);
      if (prefillFiles && Object.keys(prefillFiles).length > 0) {
        window.setTimeout(() => injectPrefillFiles(form, prefillFiles), 120);
      }
    };

    if (!key) {
      applyPrefill();
      return undefined;
    }

    void (async () => {
      try {
        const draft = await loadApplicationDraft(key);
        const form = formRef.current;
        if (!cancelled && form && draft) {
          if (Array.isArray(draft.openSections) && draft.openSections.length) setOpenSections(draft.openSections);
          applyFormValues(form, draft.values);
        }
      } catch {
        /* Drafts are best-effort — never block the form. */
      }
      applyPrefill();
      if (!cancelled) computeCompletion();
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const goTo = (index: number) => {
    if (!isWizard) return;
    setStep(Math.min(Math.max(index, 0), Math.max(0, total - 1)));
    window.setTimeout(() => {
      const node = cardRef.current;
      if (node && node.getBoundingClientRect().top < 0) {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 0);
  };

  const toggleSection = (index: number) => {
    setOpenSections((prev) => (prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index]));
  };

  /** Opens a collapsed section (used when jumping to an invalid field) and scrolls it into view. */
  const revealSection = (index: number) => {
    setOpenSections((prev) => (prev.includes(index) ? prev : [...prev, index]));
    window.setTimeout(() => {
      sectionRefs.current[index]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  };

  /** Keeps track of radio/select answers so dependent fields can show or hide. */
  const handleFormChange = (event: FormEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (!target?.name) return;
    if (target.type === "radio" || target.type === "select-one") {
      setValues((prev) => ({ ...prev, [target.name]: target.value }));
    }
    computeCompletion();
    scheduleSave();
  };

  const findInvalid = (container: HTMLElement | null): HTMLElement | null => {
    if (!container) return null;
    const controls = container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input, select, textarea",
    );
    for (const control of Array.from(controls)) {
      if (control.disabled || control.type === "hidden") continue;
      if (!control.checkValidity()) return control;
    }
    return null;
  };

  const handleNext = () => {
    const invalid = findInvalid(sectionRefs.current[step] ?? null);
    if (invalid) {
      (invalid as HTMLInputElement).reportValidity();
      return;
    }
    goTo(step + 1);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;

    if (isWizard || isAccordion) {
      for (let index = 0; index < activeSections.length; index += 1) {
        const invalid = findInvalid(sectionRefs.current[index] ?? null);
        if (invalid) {
          if (isWizard) setStep(index);
          else revealSection(index);
          window.setTimeout(() => {
            (invalid as HTMLInputElement).reportValidity();
            invalid.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 90);
          return;
        }
      }
    }

    const formData = new FormData(form);

    const honeypot = String(formData.get("website_alt") ?? "").trim();
    if (honeypot) {
      setStatus("success");
      setMessage("Thank you. Your application has been received.");
      form.reset();
      setValues({});
      return;
    }

    const payload = new URLSearchParams();
    formData.forEach((value, key) => {
      if (key === "website_alt") return;
      if (value instanceof File) {
        if (value.name) payload.append(key, `[attachment] ${value.name}`);
        return;
      }
      const text = String(value ?? "").trim();
      if (!text) return;
      payload.append(key, text);
    });

    setStatus("submitting");
    setMessage("");

    try {
      const response = await fetch(submitAddr, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload.toString(),
      });

      const responseText = await response.text();
      let parsed: { code?: string; message?: string; meta?: { message?: string; detail?: string } } | null = null;
      try {
        parsed = responseText ? JSON.parse(responseText) : null;
      } catch {
        parsed = null;
      }

      const code = parsed?.code;
      const serverMsg = parsed?.meta?.message || parsed?.message || parsed?.meta?.detail || responseText || "";
      const spamLike = /spam/i.test(String(serverMsg));

      if (response.ok && code === "OK" && !spamLike) {
        setStatus("success");
        setMessage(String(parsed?.meta?.message || "Thank you. Your application has been received."));
        form.reset();
        setValues({});
        setStep(0);
        setOpenSections([0]);
        if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current);
        if (draftKey) void clearApplicationDraft(draftKey);
        setDraftStatus("idle");
        setDraftSavedAt(null);
        onSubmitted?.();
      } else {
        setStatus("error");
        setMessage(
          serverMsg && !spamLike
            ? String(serverMsg)
            : "We could not submit your application. Please check your details and try again.",
        );
      }
    } catch {
      setStatus("error");
      setMessage("Something went wrong while submitting. Please try again.");
    }
  };

  const progressPercent = total > 0 ? Math.round(((step + 1) / total) * 100) : 0;
  const completionPercent = completion.total > 0 ? Math.round((completion.done / completion.total) * 100) : 0;

  const renderField = (field: AppField) => {
    if (field.type === "static") {
      return (
        <div key={field.name} className="md:col-span-2">
          <ApplicationFieldControl field={field} formId={formId} />
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
    return (
      <div key={field.name} data-scan-field className={spanFull ? "md:col-span-2" : ""}>
        <label
          htmlFor={`${formId}-${field.name}`}
          className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-foreground-700"
        >
          {field.label}
          {field.required ? <span className="ml-1 text-primary-600">*</span> : null}
        </label>
        {field.description ? (
          <p className="mb-2 text-xs leading-relaxed text-foreground-500">{field.description}</p>
        ) : null}
        <ApplicationFieldControl field={field} formId={formId} value={defaultValues?.[field.name]} />
      </div>
    );
  };

  const renderSectionInner = (section: AppSection, visibleFields: AppField[]) => (
    <>
      {section.description ? (
        <p className="text-xs leading-relaxed text-foreground-500">{section.description}</p>
      ) : null}

      {section.scans?.length ? (
        <div className={`space-y-3 ${section.description ? "mt-4" : ""}`}>
          {section.scans.map((scan) => (
            <DocumentScanWidget
              key={scan.type}
              type={scan.type}
              source={scan.source}
              target={scan.target}
              onExtract={(extracted) => applyFieldValues(formRef.current, extracted)}
            />
          ))}
        </div>
      ) : null}

      {visibleFields.length > 0 ? (
        <div
          className={`grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-x-5 ${
            section.description || section.scans?.length ? "mt-4" : ""
          }`}
        >
          {visibleFields.map((field) => renderField(field))}
        </div>
      ) : null}
    </>
  );

  return (
    <div className="rounded-card border border-background-200 bg-background-50 p-6 md:p-8">
      <h3 className="font-heading text-xl font-semibold text-foreground-950 md:text-2xl">{title}</h3>
      {description ? (
        <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-foreground-600">{description}</p>
      ) : null}

      <form
        id={formId}
        ref={formRef}
        data-readdy-form
        noValidate={isWizard || isAccordion}
        onSubmit={handleSubmit}
        onChange={handleFormChange}
        className="mt-6 space-y-8"
      >
        <div className="field-antispam-website" aria-hidden="true">
          <label htmlFor={`${formId}-website_alt`}>Website</label>
          <input id={`${formId}-website_alt`} name="website_alt" type="text" tabIndex={-1} autoComplete="off" readOnly />
        </div>

        {!isWizard ? (
          <div className="sticky top-[4.75rem] z-20 rounded-lg border border-background-200 bg-background-100/95 px-4 py-3 backdrop-blur md:px-5">
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-foreground-700">
                <i className="ri-progress-4-line text-base text-accent-600" aria-hidden="true" />
                Application completion
              </p>
              <p className="text-sm font-bold text-foreground-950">{completionPercent}%</p>
            </div>
            <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-background-200">
              <div
                className="h-full rounded-full bg-accent-500 transition-all duration-500"
                style={{ width: `${completionPercent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-foreground-500">
              {completion.total > 0
                ? `${completion.done} of ${completion.total} required fields complete`
                : "Add your details to track your progress."}
            </p>
            {draftKey ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-foreground-500">
                <i
                  className={draftStatus === "saving" ? "ri-loader-4-line animate-spin" : "ri-save-3-line"}
                  aria-hidden="true"
                />
                {draftStatus === "saving"
                  ? "Saving draft…"
                  : draftSavedAt
                    ? `Draft saved at ${new Date(draftSavedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}`
                    : "Your progress saves automatically — close the tab anytime and pick up where you left off."}
              </p>
            ) : null}
          </div>
        ) : null}

        {isWizard ? (
          <div ref={cardRef} className="scroll-mt-24 rounded-lg border border-background-200 bg-background-100 p-4 md:p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground-700">
                Step {step + 1} of {total}
              </p>
              <p className="text-xs font-medium text-foreground-500">{progressPercent}% complete</p>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-background-200">
              <div
                className="h-full rounded-full bg-primary-500 transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {activeSections.map((section, index) => {
                const done = index < step;
                const active = index === step;
                return (
                  <button
                    key={section.title ?? `step-${index}`}
                    type="button"
                    title={section.title ?? `Step ${index + 1}`}
                    onClick={() => goTo(index)}
                    className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-xs font-semibold transition-colors ${
                      active
                        ? "bg-primary-500 text-background-50"
                        : done
                          ? "bg-primary-100 text-primary-700"
                          : "border border-background-200 bg-background-50 text-foreground-500 hover:border-primary-300 hover:text-primary-600"
                    }`}
                  >
                    {done ? <i className="ri-check-line" aria-hidden="true" /> : index + 1}
                  </button>
                );
              })}
            </div>
            {activeSections[step]?.title ? (
              <p className="mt-4 text-sm font-semibold text-foreground-950">{activeSections[step].title}</p>
            ) : null}
          </div>
        ) : null}

        {isWizard
          ? activeSections.map((section, index) => {
              const sectionHidden = index !== step;
              const visibleFields = section.fields.filter((field) => isConditionMet(field.showIf, values));
              const hasScans = Boolean(section.scans?.length);
              if (visibleFields.length === 0 && !hasScans) return null;
              return (
                <fieldset
                  key={section.title ?? `section-${index}`}
                  ref={(element) => {
                    sectionRefs.current[index] = element;
                  }}
                  className={`${index > 0 ? "border-t border-background-200 pt-6" : ""} ${sectionHidden ? "hidden" : ""}`}
                >
                  {section.title ? (
                    <h4 className="font-heading text-sm font-bold uppercase tracking-wide text-foreground-950">
                      {section.title}
                    </h4>
                  ) : null}
                  {renderSectionInner(section, visibleFields)}
                </fieldset>
              );
            })
          : null}

        {isAccordion ? (
          <div className="space-y-3">
            {activeSections.map((section, index) => {
              const visibleFields = section.fields.filter((field) => isConditionMet(field.showIf, values));
              const hasScans = Boolean(section.scans?.length);
              if (visibleFields.length === 0 && !hasScans) return null;
              const open = openSections.includes(index);
              const panelId = `${formId}-panel-${index}`;
              return (
                <div
                  key={section.title ?? `section-${index}`}
                  className={`scroll-mt-24 overflow-hidden rounded-lg border transition-colors ${
                    open ? "border-primary-200 bg-background-50" : "border-background-200 bg-background-50"
                  }`}
                >
                  <h4 className="m-0">
                    <button
                      type="button"
                      onClick={() => toggleSection(index)}
                      aria-expanded={open}
                      aria-controls={panelId}
                      className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-background-100 md:px-5"
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-base transition-colors ${
                          open ? "bg-primary-100 text-primary-700" : "bg-background-100 text-foreground-600"
                        }`}
                      >
                        <i className={sectionIcon(section.title)} aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1 font-heading text-sm font-semibold text-foreground-950">
                        {sectionHeading(section.title, index)}
                      </span>
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-base text-foreground-500 transition-transform duration-300 ${
                          open ? "rotate-180" : ""
                        }`}
                        aria-hidden="true"
                      >
                        <i className="ri-arrow-down-s-line" />
                      </span>
                    </button>
                  </h4>
                  <div
                    id={panelId}
                    ref={(element) => {
                      sectionRefs.current[index] = element;
                    }}
                    className={open ? "border-t border-background-200 px-4 py-4 md:px-5 md:py-5" : "hidden"}
                  >
                    {renderSectionInner(section, visibleFields)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {!isWizard && !isAccordion
          ? activeSections.map((section, index) => {
              const visibleFields = section.fields.filter((field) => isConditionMet(field.showIf, values));
              const hasScans = Boolean(section.scans?.length);
              if (visibleFields.length === 0 && !hasScans) return null;
              return (
                <fieldset
                  key={section.title ?? `section-${index}`}
                  ref={(element) => {
                    sectionRefs.current[index] = element;
                  }}
                  className={index > 0 ? "border-t border-background-200 pt-6" : ""}
                >
                  {section.title ? (
                    <h4 className="font-heading text-sm font-bold uppercase tracking-wide text-foreground-950">
                      {section.title}
                    </h4>
                  ) : null}
                  {renderSectionInner(section, visibleFields)}
                </fieldset>
              );
            })
          : null}

        {!isWizard || isLastStep ? beforeSubmit : null}

        {isWizard ? (
          <div className="flex flex-col gap-3 border-t border-background-200 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => goTo(step - 1)}
              disabled={step === 0}
              className="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-5 py-3 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <i className="ri-arrow-left-line" aria-hidden="true" />
              Back
            </button>
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-foreground-500">
                Step {step + 1} of {total}
              </span>
              {isLastStep ? (
                <button
                  type="submit"
                  disabled={status === "submitting"}
                  className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {status === "submitting" ? "Submitting..." : submitLabel}
                  <i className="ri-send-plane-line" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleNext}
                  className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
                >
                  Continue
                  <i className="ri-arrow-right-line" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        ) : null}

        {isAccordion ? (
          <div className="flex flex-col gap-4 border-t border-background-200 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() =>
                setOpenSections(openSections.length === activeSections.length ? [] : activeSections.map((_, i) => i))
              }
              className="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
            >
              <i className={openSections.length === activeSections.length ? "ri-collapse-diagonal-line" : "ri-expand-diagonal-line"} aria-hidden="true" />
              {openSections.length === activeSections.length ? "Collapse all" : "Expand all"}
            </button>
            <button
              type="submit"
              disabled={status === "submitting"}
              className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {status === "submitting" ? "Submitting..." : submitLabel}
              <i className="ri-send-plane-line" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {variant === "single" ? (
          <div>
            <button
              type="submit"
              disabled={status === "submitting"}
              className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {status === "submitting" ? "Submitting..." : submitLabel}
              <i className="ri-arrow-right-line" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </form>

      {status === "success" ? (
        <p className="mt-5 rounded-md border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-accent-900" role="status">
          {message}
        </p>
      ) : null}
      {status === "error" ? (
        <p className="mt-5 rounded-md border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
