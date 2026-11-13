import { RejectedDocumentError } from "@/lib/validatedDocumentUpload";
import { hasValidatedDocumentPath } from "../../../../supabase/functions/_shared/document-category";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteApplicationDocument,
  flushApplicationEdits,
  getApplication,
  getDocumentSignedUrl,
  listApplicationDocuments,
  listInstitutionCourses,
  queueDocumentExtraction,
  saveApplicationDraft,
  saveDocumentReview,
  uploadApplicationDocument,
  type ApplicationCourseRow,
  type DocumentRow,
} from "@/pages/agency/lib/portalApplications";
import { portalCourseOptions, portalSections, resolveCourseOption } from "@/pages/agency/lib/portalSections";
import WizardQuestionStep from "@/pages/agency/components/WizardQuestionStep";
import { NO_INTAKES_MESSAGE } from "@/pages/agency/components/IntakeSelect";
import { intakeKey, type OpenIntake } from "@/pages/agency/lib/intakes";
import { OTHER_LANGUAGE, WIZARD_QUESTIONS, openDeclarationKey, type WizardQuestion } from "@/pages/agency/lib/wizardConfig";
import { normalizeUsi, validateUsi } from "../../../../supabase/functions/_shared/validation/identifiers";
import { emergencyContactProblems } from "../../../../supabase/functions/_shared/validation/person";
import {
  WIZARD_STEPS,
  wizardExtractionState,
  type PendingUpload,
  type WizardDoc,
  type WizardMeta,
  type WizardStep,
} from "@/pages/agency/lib/wizardConfig";
import { formatExtractionCandidates } from "@/pages/agency/lib/documentExtraction";
import { formatExpiryDate, getDocumentExpiryStatus } from "@/pages/agency/lib/documentExpiry";
import WizardDocumentStep from "@/components/shared/wizard/WizardDocumentStep";
import WizardShell, { WIZARD_PRIMARY_CLASS, WizardBackButton, WizardLock, WizardNotice } from "@/components/shared/wizard/WizardShell";
import WizardStepper from "@/components/shared/wizard/WizardStepper";
import EnglishAlternative, { ENGLISH_PATHWAY, EnglishNotMetDialog, type AusStudyAnswer, type CambridgeAnswer } from "@/pages/agency/components/EnglishAlternative";
import { PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { logAdminAccess } from "@/pages/agency/lib/applicationPdf";

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
// The form's label for each value a document can fill, to list what was read under the file.
const FIELD_LABELS = new Map(portalSections.flatMap((section) => section.fields).filter((field) => field.label).map((field) => [field.name, field.label]));
const fieldLabel = (key: string) => FIELD_LABELS.get(key);
// Document screens first, then the answer screens (language, USI, emergency contact, course).
const DOC_STEPS = WIZARD_STEPS.length;
const ACADEMIC_WIZARD_STEP = WIZARD_STEPS.find((item) => item.id === "academic");
/** Proof of 2+ years of study in Australia, offered on the English step instead of a test result; stored as an academic record. */
const AUS_STUDY_STEP: WizardStep | null = ACADEMIC_WIZARD_STEP
  ? { ...ACADEMIC_WIZARD_STEP, title: "Proof of study in Australia", subtitle: "Completion letter, certificate or transcripts showing at least 2 years of study in Australia.", noun: "study record", required: false }
  : null;
const LAST_STEP = DOC_STEPS + WIZARD_QUESTIONS.length - 1;
const PASSPORT_STEP = WIZARD_STEPS.findIndex((step) => step.id === "passport");

function wizardStepKey(applicationId: string): string {
  return `slit-portal-wizard-step:${portalScopeCacheKey()}:${applicationId}`;
}

function savedWizardStep(applicationId: string): number {
  try {
    const value = Number(window.localStorage.getItem(wizardStepKey(applicationId)));
    return Number.isInteger(value) && value >= 0 && value <= LAST_STEP ? value : 0;
  } catch {
    return 0;
  }
}

function toWizardDoc(row: DocumentRow): WizardDoc {
  const { state, error } = wizardExtractionState(row.metadata);
  const extraction = row.metadata.extraction as { extracted?: Record<string, string>; source?: { categoryMismatch?: boolean } } | undefined;
  return {
    id: row.id, category: row.category, filename: row.filename, fileSize: row.fileSize, storagePath: row.storagePath, extraction: state, error,
    extracted: formatExtractionCandidates(extraction?.extracted), mismatch: Boolean(extraction?.source?.categoryMismatch),
  };
}

function wizardDocs(rows: DocumentRow[]): WizardDoc[] {
  return rows.filter((row) => row.isCurrent && WIZARD_CATEGORIES.has(row.category)).map(toWizardDoc);
}

const isReading = (doc: WizardDoc) => doc.extraction === "queued" || doc.extraction === "processing";
const isExpiredPassport = (doc: WizardDoc) =>
  doc.category === WIZARD_STEPS[PASSPORT_STEP]?.category && doc.extraction === "done" && !!doc.extracted &&
  getDocumentExpiryStatus("passport", doc.extracted).status === "expired";

/**
 * Visa, English test and academic files must be that kind of document. Once read, a file classified as something else,
 * or with none of the step's key details, is the wrong document: it is removed and the agent asked for the proper one.
 */
const STEP_CHECKS: Record<string, { what: string; keys: readonly string[] }> = {
  Visa: { what: "an Australian visa grant notice or VEVO record", keys: ["visa_subclass", "visa_grant_number"] },
  "English Test": { what: "an English test result (IELTS, PTE, TOEFL or Cambridge)", keys: ["english_type", "english_score"] },
  Academic: { what: "an academic transcript, certificate or degree", keys: [] },
};
const isWrongDocument = (doc: WizardDoc) => {
  if (hasValidatedDocumentPath(doc.storagePath)) return false;
  const check = STEP_CHECKS[doc.category];
  if (!check) return false;
  // An academic file with nothing to read (a marksheet page, say) is kept; only one read as another kind is wrong.
  if (doc.extraction === "empty") return check.keys.length > 0 || Boolean(doc.mismatch);
  if (doc.extraction === "failed") return Boolean(doc.mismatch);
  if (doc.extraction !== "done") return false;
  return Boolean(doc.mismatch) || (check.keys.length > 0 && !check.keys.some((key) => String(doc.extracted?.[key] ?? "").trim()));
};
// A file still being read after this long no longer locks the wizard; the step says so and Next waits for the result.
const SLOW_READ_MS = 90_000;

// Only an Australian licence is kept: its single purpose is the student's Australian address.
const isOverseasLicence = (doc: WizardDoc) =>
  doc.category === "Driving Licence" && doc.extraction === "done" && !!doc.extracted &&
  (doc.extracted.address_type === "Overseas Address" || (!doc.extracted.au_street && Boolean(doc.extracted.ov_street)));

export default function ApplicationWizard({ applicationId, agencyName, onFinish, onCancel }: Props) {
  const { profile, role } = usePortalAuth();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState(() => savedWizardStep(applicationId));
  const [documents, setDocuments] = useState<WizardDoc[]>([]);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [uploadRejections, setUploadRejections] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState("");
  // Set when an uploaded passport was read as expired and removed; cleared by the next passport upload.
  const [expiredPassport, setExpiredPassport] = useState<{ filename: string; date: string; error?: string } | null>(null);
  const [rejectedLicence, setRejectedLicence] = useState<{ filename: string; error?: string } | null>(null);
  // The wrong document last removed from each step (by category); cleared by the next upload on that step.
  const [rejectedDocs, setRejectedDocs] = useState<Record<string, { filename: string; error?: string }>>({});
  // When each file was first seen being read here, and the ones that have taken longer than SLOW_READ_MS.
  const readingSinceRef = useRef(new Map<string, number>());
  const [slowDocs, setSlowDocs] = useState<Set<string>>(new Set());
  const discardingRef = useRef(new Set<string>());

  const documentsRef = useRef<WizardDoc[]>([]);
  const refreshSequenceRef = useRef(0);
  const completingRef = useRef(false);
  // Answer screens: the current answers, their messages, the courses on offer, and the form holding the phone control.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  const [savingAnswers, setSavingAnswers] = useState(false);
  const [answerSaveError, setAnswerSaveError] = useState("");
  const [institutionCourses, setInstitutionCourses] = useState<ApplicationCourseRow[] | null>(null);
  const questionFormRef = useRef<HTMLFormElement>(null);
  // English step without an IELTS / PTE / TOEFL result: 2+ years of Australian study, or a Cambridge English course with Skyline.
  const [englishAlt, setEnglishAlt] = useState(false);
  const [ausStudy, setAusStudy] = useState<AusStudyAnswer>("");
  const [cambridge, setCambridge] = useState<CambridgeAnswer>("");
  const [englishNotMet, setEnglishNotMet] = useState(false);
  const [englishSaveError, setEnglishSaveError] = useState("");
  const [savingEnglish, setSavingEnglish] = useState(false);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    const flush = (event: Event) => (event as CustomEvent<{ waits: Promise<unknown>[] }>).detail.waits.push(flushApplicationEdits(applicationId));
    window.addEventListener("portal-before-scope-switch", flush);
    return () => window.removeEventListener("portal-before-scope-switch", flush);
  }, [applicationId]);

  // On an answer screen the document logic below keeps working on the last document step and stays out of the way.
  const question: WizardQuestion | null = step >= DOC_STEPS ? WIZARD_QUESTIONS[step - DOC_STEPS] ?? null : null;
  const current = WIZARD_STEPS[Math.min(step, DOC_STEPS - 1)];
  useEffect(() => {
    // localStorage, not sessionStorage: on a phone the browser can be closed to free memory while the camera or file picker is open,
    // and the wizard must reopen on the same step when the page comes back.
    try { window.localStorage.setItem(wizardStepKey(applicationId), String(step)); } catch { /* storage unavailable */ }
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
        // What the answer screens start from: answers already given (on this application or the student's record).
        const values = (application.data.values ?? {}) as Record<string, unknown>;
        const pick = (name: string) => (typeof values[name] === "string" ? String(values[name]) : "");
        const courses = Array.isArray(values.courses_of_interest) ? (values.courses_of_interest as unknown[]).map(String) : [];
        if (active) {
          const pathway = pick("english_pathway");
          if (pathway === ENGLISH_PATHWAY.ausStudy) { setEnglishAlt(true); setAusStudy("Yes"); }
          else if (pathway === ENGLISH_PATHWAY.cambridge) { setEnglishAlt(true); setAusStudy("No"); setCambridge("Yes"); }
          setAnswers({
            // "Yes, another language" is selected unless an answer was already given.
            language_home: pick("language_home") || OTHER_LANGUAGE, language_other: pick("language_other"), usi_number: pick("usi_number"),
            ec_name: pick("ec_name"), ec_phone: pick("ec_phone"), ec_relationship: pick("ec_relationship"),
            course: courses[0] ?? "", preferred_intake: pick("preferred_intake"),
            // INT-01: the intake chosen on the course row (an intake typed before the dropdown is not kept: it is chosen again).
            intake_id: application.courses?.[0]?.intakeId ?? "",
          });
        }
        if (application.tenantId) {
          const offered = await listInstitutionCourses().catch(() => []);
          if (active) setInstitutionCourses(offered);
        }
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
        if (error instanceof RejectedDocumentError) {
          setPending((prev) => prev.filter((entry) => entry.key !== item.key));
          setUploadRejections((prev) => ({ ...prev, [item.category]: error.message }));
        } else {
          setPending((prev) => prev.map((entry) => (entry.key === item.key ? { ...entry, error: error instanceof Error ? error.message : "Upload failed." } : entry)));
        }
      }
    },
    [applicationId, profile?.id],
  );

  // The loader starts here, synchronously, before any hashing or network call.
  const handlePickFiles = (target: WizardStep, list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploadRejections((prev) => ({ ...prev, [target.category]: "" }));
    if (target.id === "passport") setExpiredPassport(null);
    if (target.id === "licence") setRejectedLicence(null);
    setRejectedDocs((prev) => { if (!prev[target.category]) return prev; const next = { ...prev }; delete next[target.category]; return next; });
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

  // An expired passport is not kept: once it is read as expired the file is deleted straight away, no confirmation.
  useEffect(() => {
    documents.filter((doc) => isExpiredPassport(doc) && !discardingRef.current.has(doc.id)).forEach((doc) => {
      discardingRef.current.add(doc.id);
      const date = getDocumentExpiryStatus("passport", doc.extracted ?? {}).date ?? "";
      setExpiredPassport({ filename: doc.filename, date });
      void deleteApplicationDocument({ id: doc.id, storagePath: doc.storagePath }).then(
        () => setDocuments((prev) => prev.filter((item) => item.id !== doc.id)),
        (error) => setExpiredPassport({ filename: doc.filename, date, error: error instanceof Error ? error.message : "The expired passport could not be removed." }),
      );
    });
  }, [documents]);

  // A wrong visa, English test or academic file is removed as soon as it is read, like an overseas licence.
  useEffect(() => {
    documents.filter((doc) => isWrongDocument(doc) && !discardingRef.current.has(doc.id)).forEach((doc) => {
      discardingRef.current.add(doc.id);
      setRejectedDocs((prev) => ({ ...prev, [doc.category]: { filename: doc.filename } }));
      void deleteApplicationDocument({ id: doc.id, storagePath: doc.storagePath }).then(
        () => setDocuments((prev) => prev.filter((item) => item.id !== doc.id)),
        (error) => setRejectedDocs((prev) => ({ ...prev, [doc.category]: { filename: doc.filename, error: error instanceof Error ? error.message : "The file could not be removed." } })),
      );
    });
  }, [documents]);

  // Notice files that stay in reading too long, so the wizard does not spin without end.
  const readingIds = documents.filter(isReading).map((doc) => doc.id).join(",");
  useEffect(() => {
    if (!readingIds) return undefined;
    const ids = readingIds.split(",");
    const now = Date.now();
    for (const id of ids) if (!readingSinceRef.current.has(id)) readingSinceRef.current.set(id, now);
    const check = () => {
      const late = ids.filter((id) => Date.now() - (readingSinceRef.current.get(id) ?? Date.now()) >= SLOW_READ_MS);
      if (late.length) setSlowDocs((prev) => (late.every((id) => prev.has(id)) ? prev : new Set([...prev, ...late])));
    };
    check();
    const timer = window.setInterval(check, 5000);
    return () => window.clearInterval(timer);
  }, [readingIds]);

  // An overseas licence is removed as soon as it is read, like an expired passport.
  useEffect(() => {
    documents.filter((doc) => isOverseasLicence(doc) && !discardingRef.current.has(doc.id)).forEach((doc) => {
      discardingRef.current.add(doc.id);
      setRejectedLicence({ filename: doc.filename });
      void deleteApplicationDocument({ id: doc.id, storagePath: doc.storagePath }).then(
        () => setDocuments((prev) => prev.filter((item) => item.id !== doc.id)),
        (error) => setRejectedLicence({ filename: doc.filename, error: error instanceof Error ? error.message : "The licence could not be removed." }),
      );
    });
  }, [documents]);

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
        outstanding: WIZARD_STEPS.filter((item) => item.required && !documentsRef.current.some((doc) => doc.category === item.category))
          .map((item) => `${item.title} not provided. It is required.`),
        updatedAt: new Date().toISOString(),
      };
      await saveDocumentReview({ applicationId, values: {}, provenance: {}, confirmed: [], wizard: meta as unknown as Record<string, unknown>, studentName: studentName || undefined });
      // The full form opens on its Student declaration page (step 14).
      try { window.sessionStorage.setItem(openDeclarationKey(applicationId), "1"); } catch { /* session storage unavailable */ }
      onFinish();
    } catch (error) {
      setFinishError(error instanceof Error ? error.message : "We could not open the application form.");
      setFinishing(false);
      completingRef.current = false;
    }
  }, [applicationId, onFinish]);

  const busy = pending.some((item) => !item.error) || documents.some((doc) => isReading(doc) && !dismissed.has(doc.id) && !slowDocs.has(doc.id));
  useEffect(() => {
    if (finishing && !busy) void complete();
  }, [finishing, busy, complete]);

  /* ------------------------------------------------------------ navigate */

  // The passport is mandatory: the agent stays on the passport step until a current one is uploaded.
  const passportExpired = expiredPassport !== null || documents.some(isExpiredPassport);
  const hasPassport = documents.some((doc) => doc.category === WIZARD_STEPS[PASSPORT_STEP]?.category && !isExpiredPassport(doc));
  const passportRequired = PASSPORT_STEP >= 0 && (passportExpired || !hasPassport);
  // Every required document must be uploaded before the agent can move past its step.
  const ausStudyDocs = AUS_STUDY_STEP ? documents.filter((doc) => doc.category === AUS_STUDY_STEP.category && !isWrongDocument(doc)) : [];
  /** The English requirement met without a test result: Australian study proof uploaded, or Yes to the Cambridge English course. */
  const englishAltMet = englishAlt && ((ausStudy === "Yes" && ausStudyDocs.length > 0) || (ausStudy === "No" && cambridge === "Yes"));
  const stepHasDoc = (item: WizardStep) => (item.id === "english" && englishAltMet)
    || documents.some((doc) => doc.category === item.category && !isExpiredPassport(doc) && !isOverseasLicence(doc) && !isWrongDocument(doc));
  const firstMissingBefore = (target: number) => WIZARD_STEPS.findIndex((item, index) => index < target && item.required && !stepHasDoc(item));
  const goTo = (index: number) => {
    const target = Math.max(0, Math.min(index, LAST_STEP));
    if (passportRequired && target > PASSPORT_STEP) { setStep(PASSPORT_STEP); return; }
    const missing = firstMissingBefore(target);
    setStep(missing >= 0 ? missing : target);
  };
  useEffect(() => {
    if (loading) return;
    if (passportRequired && step > PASSPORT_STEP) { setStep(PASSPORT_STEP); return; }
    const missing = WIZARD_STEPS.findIndex((item, index) => index < step && item.required && !(item.id === "english" && englishAltMet) && !documents.some((doc) => doc.category === item.category));
    if (missing >= 0) setStep(missing);
  }, [loading, passportRequired, step, documents, englishAltMet]);

  /** Saves how the English requirement is met, then moves on from the English step. */
  const nextFromEnglish = async () => {
    setEnglishSaveError("");
    const pathway = englishAlt ? (ausStudy === "Yes" ? ENGLISH_PATHWAY.ausStudy : ENGLISH_PATHWAY.cambridge) : ENGLISH_PATHWAY.test;
    const values: Record<string, unknown> = {
      english_pathway: pathway,
      aus_study_2yrs: englishAlt ? ausStudy : "",
      cambridge_course: englishAlt && ausStudy === "No" ? cambridge : "",
    };
    if (englishAlt && pathway === ENGLISH_PATHWAY.cambridge) values.english_type = "Cambridge English";
    setSavingEnglish(true);
    try {
      await flushApplicationEdits(applicationId);
      await getApplication(applicationId, true);
      await saveApplicationDraft(applicationId, { data: { values }, studentName: "", studentEmail: "", intake: "", completion: 0 });
      goTo(step + 1);
    } catch (error) {
      setEnglishSaveError(error instanceof Error ? error.message : "We could not save your English details. Try again.");
    } finally {
      setSavingEnglish(false);
    }
  };
  const chooseCambridge = (value: "Yes" | "No") => {
    setCambridge(value);
    if (value === "No") setEnglishNotMet(true);
  };
  /** From the "requirement not met" dialog back to the start of the English step. */
  const backToEnglishOptions = () => {
    setEnglishNotMet(false);
    setCambridge("");
    setAusStudy("");
    setEnglishAlt(false);
  };

  /* ------------------------------------------------------- answer screens */

  const courseLabels = institutionCourses ? institutionCourses.map((course) => `${course.code} - ${course.title}`) : portalCourseOptions;
  const setAnswer = (name: string, value: string) => {
    // A new course clears the intake: intakes belong to one course.
    setAnswers((prev) => ({ ...prev, [name]: value, ...(name === "course" && value !== prev.course ? { intake_id: "", preferred_intake: "" } : {}) }));
    if (name === "course") setIntakeList(null);
    setAnswerErrors((prev) => (prev[name] ? { ...prev, [name]: "" } : prev));
  };
  // The course's intakes as listed (real intakes, or the fallback months): the choice must be one of them.
  const [intakeList, setIntakeList] = useState<OpenIntake[] | null>(null);
  const courseIdOf = (label: string): string | null => {
    const course = institutionCourses ? institutionCourses.find((item) => `${item.code} - ${item.title}` === label) : resolveCourseOption(label);
    return course?.courseId || null;
  };
  const setIntake = (intake: OpenIntake | null) => {
    setAnswers((prev) => ({ ...prev, intake_id: intake?.id ?? "", preferred_intake: intake?.display ?? "" }));
    setAnswerErrors((prev) => (prev.preferred_intake ? { ...prev, preferred_intake: "" } : prev));
  };

  /** Checks the screen's answers and saves them to the draft; false when something is missing or the save failed. */
  const saveAnswers = async (target: WizardQuestion): Promise<boolean> => {
    const errors: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const patch: Record<string, unknown> = {};
    const filled = (name: string) => String(answers[name] ?? "").trim();
    if (target.id === "language") {
      if (!filled("language_home")) errors.language_home = "Choose Yes or No.";
      else if (answers.language_home === OTHER_LANGUAGE && !filled("language_other")) errors.language_other = "Enter the language the student speaks.";
      values.language_home = answers.language_home;
      values.language_other = answers.language_home === OTHER_LANGUAGE ? filled("language_other") : "";
    } else if (target.id === "usi") {
      const usi = normalizeUsi(answers.usi_number ?? "");
      const problem = usi ? validateUsi(usi) : "Enter the student's USI.";
      if (problem) errors.usi_number = problem;
      values.has_usi = "Yes";
      values.usi_number = usi;
    } else if (target.id === "emergency") {
      const phone = String(new FormData(questionFormRef.current ?? undefined).get("ec_phone") ?? "").trim();
      // The shared rule (also the staff onboarding wizard's): name, phone with its country code, relationship.
      const problems = emergencyContactProblems({ name: answers.ec_name ?? "", phone, relationship: answers.ec_relationship ?? "" }, "the student");
      if (problems.name) errors.ec_name = problems.name;
      if (problems.phone) errors.ec_phone = problems.phone;
      if (problems.relationship) errors.ec_relationship = problems.relationship;
      values.ec_name = filled("ec_name");
      values.ec_phone = phone;
      values.ec_relationship = filled("ec_relationship");
      // An Australian number means the contact is in Australia (the form no longer asks).
      values.ec_in_au = phone.startsWith("+61") ? "Yes" : "No";
      setAnswers((prev) => ({ ...prev, ec_phone: phone }));
    } else {
      if (!filled("course")) errors.course = "Choose the course.";
      const chosen = intakeKey(filled("intake_id"), filled("preferred_intake"));
      if (filled("course") && intakeList?.length === 0) errors.preferred_intake = NO_INTAKES_MESSAGE;
      else if (!chosen || (intakeList && !intakeList.some((i) => intakeKey(i.id, i.display) === chosen))) errors.preferred_intake = "Choose the intake.";
      if (filled("course")) {
        const course = institutionCourses ? institutionCourses.find((item) => `${item.code} - ${item.title}` === answers.course) : resolveCourseOption(answers.course);
        if (!course) errors.course = "This course is no longer offered. Choose another.";
        else patch.courses = [{ ...course, intakeId: filled("intake_id") || undefined }];
      }
      values.courses_of_interest = filled("course") ? [answers.course] : [];
      values.preferred_intake = filled("preferred_intake");
    }
    setAnswerErrors(errors);
    if (Object.values(errors).some(Boolean)) return false;
    setSavingAnswers(true);
    setAnswerSaveError("");
    try {
      await flushApplicationEdits(applicationId);
      // Reading documents moves the draft on; take its current version before saving.
      await getApplication(applicationId, true);
      await saveApplicationDraft(applicationId, { data: { values, ...patch }, studentName: "", studentEmail: "", intake: "", completion: 0 });
      return true;
    } catch (error) {
      setAnswerSaveError(error instanceof Error ? error.message : "We could not save these answers. Try again.");
      return false;
    } finally {
      setSavingAnswers(false);
    }
  };

  const nextFromQuestion = async () => {
    if (!question || !(await saveAnswers(question))) return;
    if (step === LAST_STEP) setFinishing(true);
    else goTo(step + 1);
  };

  const stepDocs = documents.filter((doc) => doc.category === current.category);
  const stepPending = pending.filter((item) => item.category === current.category);
  const hasFile = stepDocs.length > 0 || stepPending.length > 0;
  const isLast = step === LAST_STEP;
  const ready = !loading && !loadError;

  const stepBusy = (target: WizardStep) =>
    pending.some((item) => item.category === target.category && !item.error) ||
    documents.some((doc) => doc.category === target.category && isReading(doc) && !dismissed.has(doc.id) && !slowDocs.has(doc.id));
  // While this step's file uploads or is read, the wizard is locked so nothing else can be clicked.
  const removingExpired = !expiredPassport?.error && stepDocs.some(isExpiredPassport);
  const removingWrong = !rejectedDocs[current.category]?.error && stepDocs.some(isWrongDocument);
  const locked = ready && !question && (stepBusy(current) || removingExpired || removingWrong);
  // A file read too slowly unlocks the wizard but still holds Next until its result is in (or it is deleted).
  const slowHere = stepDocs.filter((doc) => isReading(doc) && slowDocs.has(doc.id));
  const rejectedHere = rejectedDocs[current.category];
  const stepCheck = STEP_CHECKS[current.category];
  const blockedByPassport = passportRequired && step === PASSPORT_STEP;
  // The document notices below belong to document screens only.
  const onDocStep = !question;

  const primaryClass = WIZARD_PRIMARY_CLASS;

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
    if (question) {
      return (
        <form ref={questionFormRef} noValidate onSubmit={(event) => { event.preventDefault(); void nextFromQuestion(); }}>
          <WizardQuestionStep question={question} answers={answers} errors={answerErrors} courseOptions={courseLabels} courseIdOf={courseIdOf} onChange={setAnswer}
            onIntake={setIntake} onIntakesLoaded={setIntakeList} />
          {answerSaveError ? <div className="mt-4"><PortalError message={answerSaveError} /></div> : null}
        </form>
      );
    }
    const documentStepProps = {
      dismissed,
      onRetryUpload: (item: PendingUpload) => void startUpload(item),
      onDropUpload: (item: PendingUpload) => setPending((prev) => prev.filter((entry) => entry.key !== item.key)),
      onRetryDoc: (doc: WizardDoc) => void handleRetryDoc(doc),
      onDismissDoc: (doc: WizardDoc) => setDismissed((prev) => new Set(prev).add(doc.id)),
      onRemoveDoc: handleRemoveDoc,
      signedUrl: (doc: WizardDoc) => getDocumentSignedUrl(doc.storagePath, 300),
      logView: role === "slit_admin"
        ? (doc: WizardDoc) => logAdminAccess(applicationId, "document_viewed", { documentId: doc.id, filename: doc.filename, category: doc.category })
        : undefined,
    };
    if (current.id === "english" && englishAlt && AUS_STUDY_STEP) {
      return (
        <EnglishAlternative
          ausStudy={ausStudy}
          cambridge={cambridge}
          onAusStudy={(value) => { setAusStudy(value); if (value === "Yes") setCambridge(""); }}
          onCambridge={chooseCambridge}
          onBack={() => { setEnglishAlt(false); setAusStudy(""); setCambridge(""); setEnglishSaveError(""); }}
          error={englishSaveError || uploadRejections[AUS_STUDY_STEP.category] || ""}
          upload={
            <WizardDocumentStep
              {...documentStepProps}
              step={AUS_STUDY_STEP}
              docs={documents.filter((doc) => doc.category === AUS_STUDY_STEP.category)}
              pending={pending.filter((item) => item.category === AUS_STUDY_STEP.category)}
              onPickFiles={(files) => handlePickFiles(AUS_STUDY_STEP, files)}
            />
          }
        />
      );
    }
    return (
      <>
        {uploadRejections[current.category] ? <WizardNotice tone="error">{uploadRejections[current.category]}</WizardNotice> : null}
        {current.id === "english" && englishSaveError ? <WizardNotice tone="error">{englishSaveError}</WizardNotice> : null}
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
          signedUrl={(doc) => getDocumentSignedUrl(doc.storagePath, 300)}
          fieldLabel={fieldLabel}
          logView={
            role === "slit_admin"
              ? (doc) => logAdminAccess(applicationId, "document_viewed", { documentId: doc.id, filename: doc.filename, category: doc.category })
              : undefined
          }
        />
        {current.id === "english" && AUS_STUDY_STEP && !hasFile ? (
          <div className="mt-5 rounded-lg border border-dashed border-background-300 bg-background-100/60 px-4 py-3 text-sm text-foreground-700">
            No IELTS, PTE or TOEFL result?{" "}
            <button type="button" onClick={() => { setEnglishAlt(true); setEnglishSaveError(""); }} data-testid="english-no-test"
              className="cursor-pointer font-semibold text-primary-700 underline-offset-2 hover:underline">
              See other ways to meet the English requirement
            </button>
          </div>
        ) : null}
      </>
    );
  };

  return (
    <WizardShell
      title={"Add New Form \u2014 document wizard"}
      subtitle={`Upload documents to prefill the application, then continue to the full form. ${agencyName}`}
      onClose={onCancel}
      closeLabel="Cancel and close the wizard"
      stepper={
        <WizardStepper
          items={[...WIZARD_STEPS, ...WIZARD_QUESTIONS].map((item) => ({ id: item.id, short: item.short, icon: item.icon, busy: "category" in item && stepBusy(item) }))}
          current={step}
          onSelect={goTo}
        />
      }
      footerStart={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm font-medium text-foreground-500 transition-colors hover:text-foreground-800"
          >
            <i className="ri-close-line" aria-hidden="true" />
            Cancel
          </button>
          {step > 0 && ready ? <WizardBackButton onClick={() => goTo(step - 1)} disabled={finishing} /> : null}
        </>
      }
      footerEnd={
        ready ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            {onDocStep && !hasFile && !blockedByPassport && !current.required ? (
              <button
                type="button"
                onClick={() => goTo(step + 1)}
                className="inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-700 transition-colors hover:border-primary-300 hover:text-primary-700"
              >
                {current.skipLabel}
              </button>
            ) : null}
            {question && !isLast ? (
              <button type="button" onClick={() => void nextFromQuestion()} disabled={savingAnswers} className={primaryClass}>
                {savingAnswers ? <><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Saving&hellip;</> : <>Next <i className="ri-arrow-right-line" aria-hidden="true" /></>}
              </button>
            ) : isLast ? (
              <>
                {finishing ? (
                  <button type="button" onClick={() => void complete()} className="cursor-pointer text-xs font-semibold text-primary-700 underline">
                    Continue now
                  </button>
                ) : null}
                <button type="button" onClick={() => void nextFromQuestion()} disabled={finishing || savingAnswers} className={primaryClass}>
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
              current.id === "english" ? (
                <button type="button" onClick={() => void nextFromEnglish()}
                  disabled={(englishAlt ? !englishAltMet : !hasFile) || locked || slowHere.length > 0 || savingEnglish || pending.some((item) => !item.error)} className={primaryClass}>
                  {savingEnglish ? <><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Saving&hellip;</> : <>Next <i className="ri-arrow-right-line" aria-hidden="true" /></>}
                </button>
              ) : (
                <button type="button" onClick={() => goTo(step + 1)} disabled={!hasFile || locked || blockedByPassport || slowHere.length > 0} className={primaryClass}>
                  Next
                  <i className="ri-arrow-right-line" aria-hidden="true" />
                </button>
              )
            )}
          </div>
        ) : null
      }
      notices={
        <>
          {onDocStep && blockedByPassport && !passportExpired && !locked ? (
            <WizardNotice tone="info">A current passport is required. Upload it to continue.</WizardNotice>
          ) : null}

          {onDocStep && current.required && step !== PASSPORT_STEP && !hasFile && !locked && !(current.id === "english" && englishAlt) ? (
            <WizardNotice tone="info">{current.title} is required. Upload it to continue.</WizardNotice>
          ) : null}

          {onDocStep && rejectedHere && stepCheck ? (
            <WizardNotice tone="error">
              {rejectedHere.error
                ? `${rejectedHere.filename} is not ${stepCheck.what} but could not be removed (${rejectedHere.error}). Delete it, then upload the proper document.`
                : `${rejectedHere.filename} is not ${stepCheck.what}, so it was not kept. Please upload the proper document.`}
            </WizardNotice>
          ) : null}

          {onDocStep && slowHere.length > 0 && !locked ? (
            <WizardNotice tone="warn">
              {`${slowHere[0].filename} is taking longer than usual to read. If it is not ${stepCheck?.what ?? `your ${current.noun}`}, delete it and upload the proper document; otherwise wait, and Next unlocks once it is read.`}
            </WizardNotice>
          ) : null}

          {onDocStep && current.id === "licence" && rejectedLicence ? (
            <WizardNotice tone="error">
              {rejectedLicence.error
                ? `${rejectedLicence.filename} is not an Australian licence but could not be removed (${rejectedLicence.error}). Delete it.`
                : `${rejectedLicence.filename} is not an Australian driving licence, so it was not kept. Only an Australian licence is accepted; or finish without one and search the address on the form.`}
            </WizardNotice>
          ) : null}

          {onDocStep && blockedByPassport && passportExpired && !locked ? (
            <WizardNotice tone="error">
              {expiredPassport?.error
                ? `${expiredPassport.filename} has expired but could not be removed (${expiredPassport.error}). Delete it, then upload the student\u2019s current passport.`
                : `${expiredPassport?.filename ?? "This passport"} expired${expiredPassport?.date ? ` on ${formatExpiryDate(expiredPassport.date)}` : ""} and was not saved. Upload the student\u2019s current passport to continue.`}
            </WizardNotice>
          ) : null}

          {finishError ? (
            <div className="border-t border-background-200 px-5 py-3 md:px-6">
              <PortalError message={finishError} onRetry={() => setFinishing(true)} />
            </div>
          ) : null}

          {ready ? (
            <div className="border-t border-background-200 px-5 py-3 text-center md:px-6">
              <p className="text-2xs text-foreground-400">
                Nothing is submitted from this wizard. Documents are stored privately against this draft; the student
                application is submitted only from the full form after review.
              </p>
            </div>
          ) : null}
        </>
      }
      overlay={
        locked ? (
          <WizardLock quiet={!removingExpired && !removingWrong}>
            {stepPending.some((item) => !item.error) ? `Uploading your ${current.noun}\u2026` : removingExpired ? "Passport expired, removing it\u2026" : removingWrong ? `This is not ${stepCheck?.what ?? `your ${current.noun}`}, removing it\u2026` : `Reading your ${current.noun}\u2026`}
          </WizardLock>
        ) : null
      }
    >
      {body()}
      <EnglishNotMetDialog open={englishNotMet} onBack={backToEnglishOptions} />
    </WizardShell>
  );
}
