import BulkDocumentUpload, { DocumentModeChoice } from "./BulkDocumentUpload";
import { classifyDocument } from "@/pages/agency/lib/bulkDocuments";
import { ruleBool, ruleNumber } from "@/lib/businessRules";
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
  saveWizardDraft,
  submitApplication,
  sendApplicationInvitation,
  avetmissCheckAnswers,
  isCheckViolation,
  uploadApplicationDocument,
  type ApplicationCourseRow,
  type DocumentRow,
} from "@/pages/agency/lib/portalApplications";
import { detailRequired, portalSections, staffCourseLabel } from "@/pages/agency/lib/portalSections";
import WizardQuestionStep from "@/pages/agency/components/WizardQuestionStep";
import { BORN_IN_PASSPORT_COUNTRY, PASSPORT_COUNTRY_LABEL } from "@/pages/agency/lib/birthCountry";
import WizardFinishSteps from "@/pages/agency/components/WizardFinishSteps";
import { ResidencyQuestions } from "@/pages/agency/components/WizardResidency";
import { PR_ANSWER, isDomesticPassport, notPermanentSubclass, residencyAnswered, studentKind, studyLoadFor, visaNeed, type VisaNeed } from "@/pages/agency/lib/residency";
import { carriedFromLabel } from "@/pages/agency/lib/documentAttachments";
import { AVETMISS_EXTRA_FIELDS, AVETMISS_FIELD_SCREEN, CHECKLIST_OPTIONS, FINISH_SCREEN_FIELDS, OSHC_SELF_CONFIRM, avetmissMissingField, avetmissMissingScreen, avetmissYear, optionsOf, type FinishSummary } from "@/pages/agency/lib/wizardFinish";
import { parseCodeList, parsePriorEducation, priorEducationProblem } from "@/pages/admin/components/avetmiss/avetmissValues";
import { syncApplicationAvetmiss } from "@/pages/admin/components/avetmiss/avetmissSync";
import { academicPrefill } from "@/pages/agency/lib/educationLevels";
import { addressProblems, emailProblem } from "../../../../supabase/functions/_shared/validation/person";
import { validateStoredPhone } from "../../../../supabase/functions/_shared/validation/identifiers";
import type { AddressPick } from "@/components/shared/wizard/AddressSearch";
import { NO_INTAKES_MESSAGE } from "@/pages/agency/components/IntakeSelect";
import { intakeKey, type OpenIntake } from "@/pages/agency/lib/intakes";
import { rto, type RtoCourse } from "@/pages/admin/lib/rto";
import { ENGLISH_LANGUAGE_CODE, OTHER_LANGUAGE, WIZARD_QUESTIONS, type WizardQuestion } from "@/pages/agency/lib/wizardConfig";
import { normalizeUsi, validateUsi } from "../../../../supabase/functions/_shared/validation/identifiers";
import { emergencyContactProblems } from "../../../../supabase/functions/_shared/validation/person";
import {
  WIZARD_STEPS,
  wizardExtractionState,
  type PendingUpload,
  type WizardDoc,
  type WizardStep,
} from "@/pages/agency/lib/wizardConfig";
import { formatExtractionCandidates } from "@/pages/agency/lib/documentExtraction";
import { formatExpiryDate, getDocumentExpiryStatus } from "@/pages/agency/lib/documentExpiry";
import WizardDocumentStep from "@/components/shared/wizard/WizardDocumentStep";
import WizardShell, { WIZARD_PRIMARY_CLASS, WizardBackButton, WizardLock, WizardNotice } from "@/components/shared/wizard/WizardShell";
import { ConfirmDialog } from "@/components/shared/application-status/ActionDrawer";
import WizardStages, { type WizardStage } from "@/components/shared/wizard/WizardStages";
import { englishAlternatives, usiRequired } from "@/pages/agency/lib/admissionsRules";
import EnglishAlternative, { ENGLISH_PATHWAY, EnglishNotMetDialog, type AusStudyAnswer, type CambridgeAnswer } from "@/pages/agency/components/EnglishAlternative";
import { PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { GuardianRequestForm, RequestChangeButton, SignPasswordFields, StudentHandoffNotice, type SignPassword } from "@/pages/agency/components/ApplicationHandoff";
import { useHandoff } from "@/pages/agency/lib/handoff";
import { declarationConsent, saveSignPassword } from "@/pages/agency/lib/handoff";
import DrawSignature from "@/pages/agency/components/DrawSignature";
import { logAdminAccess } from "@/pages/agency/lib/applicationPdf";

import { portalScopeCacheKey } from "@/lib/portalScope";

interface Props {
  applicationId: string;
  agencyName: string;
  /** Called after the wizard has finished and the draft holds the extracted values. */
  onFinish: () => void;
  /** Called when the agent leaves the wizard (the draft is kept). */
  onCancel: () => void;
  /** BULK-DOCUMENTS: after "Upload all at once", the application continues on the one page of cards (all roles). */
  onCards?: () => void;
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
/** The wizard's steps in order (documents, then questions) and their grouping into four stages; the last one submits the application. */
const ALL_STEPS = [...WIZARD_STEPS, ...WIZARD_QUESTIONS];
const STAGE_OF: Record<string, string> = {
  personal: "about", address: "about", language: "about", identifier: "about", usi: "about", emergency: "about", course: "course", study: "course", declare: "submit",
};
const STAGE_TITLES: Record<string, string> = { documents: "Documents", about: "About the student", course: "Course", submit: "Submit" };
const stageRanges = ["documents", "about", "course", "submit"].flatMap((id) => {
  const idx = ALL_STEPS.map((item, i) => ((STAGE_OF[item.id] ?? "documents") === id ? i : -1)).filter((i) => i >= 0);
  return idx.length ? [{ id, title: STAGE_TITLES[id], from: idx[0], to: idx[idx.length - 1] }] : [];
});

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
    carriedFrom: carriedFromLabel(row.metadata),
  };
}

function wizardDocs(rows: DocumentRow[]): WizardDoc[] {
  return rows.filter((row) => row.isCurrent && WIZARD_CATEGORIES.has(row.category)).map(toWizardDoc);
}

const isReading = (doc: WizardDoc) => doc.extraction === "queued" || doc.extraction === "processing";
const isExpiredPassport = (doc: WizardDoc) =>
  ruleBool("admissions.passport_reject_expired", true) &&
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
  if (doc.extraction === "empty") return (doc.category !== "Academic" || ruleBool("admissions.academic_reject_mismatched", true)) && (check.keys.length > 0 || Boolean(doc.mismatch));
  if (doc.extraction === "failed") return (doc.category !== "Academic" || ruleBool("admissions.academic_reject_mismatched", true)) && Boolean(doc.mismatch);
  if (doc.extraction !== "done") return false;
  return (doc.category === "Academic" ? ruleBool("admissions.academic_reject_mismatched", true) : true) && (Boolean(doc.mismatch) || (check.keys.length > 0 && !check.keys.some((key) => String(doc.extracted?.[key] ?? "").trim())));
};
// A file still being read after this long no longer locks the wizard; the step says so and Next waits for the result.
const SLOW_READ_MS = 90_000;

// Only an Australian licence is kept: its single purpose is the student's Australian address.
const isOverseasLicence = (doc: WizardDoc) =>
  doc.category === "Driving Licence" && doc.extraction === "done" && !!doc.extracted &&
  (doc.extracted.address_type === "Overseas Address" || (!doc.extracted.au_street && Boolean(doc.extracted.ov_street)));

/** WIZARD-FULL: the answers the new screens hold, and the ones the wizard fills itself on Submit (as the full form did). */
const FINISH_FIELDS = Object.values(FINISH_SCREEN_FIELDS).flat();
const SCREEN_OF_FIELD = new Map(Object.entries(FINISH_SCREEN_FIELDS).flatMap(([screen, names]) => names.map((name) => [name, screen] as const)));
const OTHER_SCREENS: Record<string, string> = {
  language_home: "language", language_other: "language", language_code: "language", has_usi: "usi", usi_number: "usi", ec_name: "emergency", ec_phone: "emergency", ec_in_au: "emergency",
  courses_of_interest: "course", preferred_intake: "course",
};
const USI_CONSENT_TEXT = "I consent to SLIT using/providing my USI for enrolment, reporting and verification purposes where required.";
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());

export default function ApplicationWizard({ applicationId, agencyName, onFinish, onCancel, onCards }: Props) {
  const { profile, role } = usePortalAuth();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [autoSave, setAutoSave] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [autoSaveError, setAutoSaveError] = useState("");
  const [inputVersion, setInputVersion] = useState(0);
  const pendingValues = useRef<Record<string, string>>({});
  const pendingWizard = useRef<Record<string, unknown>>({});
  const completedSteps = useRef(new Set<string>());
  const persistence = useRef<Promise<boolean> | null>(null);
  const markDirty = () => {
    setAutoSave("saving");
    setInputVersion((version) => version + 1);
  };
  const persist = useCallback(async (): Promise<boolean> => {
    if (persistence.current && !(await persistence.current)) return false;
    const values = pendingValues.current;
    const wizard = pendingWizard.current;
    if (!Object.keys(values).length && !Object.keys(wizard).length) return true;
    pendingValues.current = {};
    pendingWizard.current = {};
    setAutoSave("saving");
    setAutoSaveError("");
    const task = (async () => {
      try {
        await saveWizardDraft(applicationId, { values, wizard });
        const queued = Object.keys(pendingValues.current).length || Object.keys(pendingWizard.current).length;
        setAutoSave(queued ? "saving" : "saved");
        return true;
      } catch (error) {
        pendingValues.current = { ...values, ...pendingValues.current };
        pendingWizard.current = { ...wizard, ...pendingWizard.current };
        setAutoSave("failed");
        setAutoSaveError(error instanceof Error ? error.message : "Changes could not be saved.");
        return false;
      }
    })();
    persistence.current = task;
    try { return await task; }
    finally { if (persistence.current === task) persistence.current = null; }
  }, [applicationId]);
  const [step, setStep] = useState(() => savedWizardStep(applicationId));
  const [documents, setDocuments] = useState<WizardDoc[]>([]);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [uploadRejections, setUploadRejections] = useState<Record<string, string>>({});
  // A rejected upload is shown on its own step only until the step changes (owner 2026-11-27: no stale "does not match" message).
  useEffect(() => { setUploadRejections({}); }, [step]);
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
  const [draftIssuingCountry, setDraftIssuingCountry] = useState("");
  const [savingAnswers, setSavingAnswers] = useState(false);
  const [answerSaveError, setAnswerSaveError] = useState("");
  // AVETMISS-CHECK: fields the AVETMISS check refused on this screen (Next stays disabled until each is changed), and what other
  // screens still need (a summary with links: values refused elsewhere, and on Submit what the student record lacks).
  const [avetmissKeys, setAvetmissKeys] = useState<string[]>([]);
  const [checkSummary, setCheckSummary] = useState<{ label: string; screen: string }[]>([]);
  const [institutionCourses, setInstitutionCourses] = useState<ApplicationCourseRow[] | null>(null);
  // Staff: the courses of Learning Management (rto_admin course_list, every status) by their CMS id; RTO Managers may add an intake from here.
  const [staffCourses, setStaffCourses] = useState<RtoCourse[] | null>(null);
  const [rtoManager, setRtoManager] = useState(false);
  const [intakeReload, setIntakeReload] = useState(0);
  /** The intake just created from the wizard: chosen as soon as the re-read list holds it. */
  const pendingIntake = useRef<string | null>(null);
  const questionFormRef = useRef<HTMLFormElement>(null);
  // English step without an IELTS / PTE / TOEFL result: 2+ years of Australian study, or a Cambridge English course with Skyline.
  const [englishAlt, setEnglishAlt] = useState(false);
  const [ausStudy, setAusStudy] = useState<AusStudyAnswer>("");
  const [cambridge, setCambridge] = useState<CambridgeAnswer>("");
  const [englishNotMet, setEnglishNotMet] = useState(false);
  const [englishSaveError, setEnglishSaveError] = useState("");
  const [savingEnglish, setSavingEnglish] = useState(false);
  // WIZARD-FULL: answers typed on the new screens are never replaced by values read later from the draft.
  const touchedRef = useRef(new Set<string>());
  /** AVETMISS-UI: the application's student, for copying the AVETMISS answers to the student's tables. */
  const studentIdRef = useRef<string | null>(null);
  const [submittedRef, setSubmittedRef] = useState("");
  // APPLICATION-STUDENT-SIGNS (owner, 2026-11-25): agents send the application to the student; only the student signs, each
  // declaration ticked on its own (a parent / guardian too when the student is under 18).
  const { handoff, reload: reloadHandoff } = useHandoff(applicationId);
  const signsHere = role === "student";
  const studentLocked = signsHere && Boolean(handoff?.state);
  const declarationsRef = useRef<{ ticked: Record<string, string>; complete: boolean }>({ ticked: {}, complete: false });
  // A student who opened the application from the link alone creates the password at the signature (owner, 2026-11-26).
  const signPasswordRef = useRef<SignPassword>({ needed: false, password: "", valid: true });
  // APPLICATION-DRAWN-SIGNATURE: the student draws their signature on the last screen.
  const signatureRef = useRef<string | null>(null);
  const [sentToStudent, setSentToStudent] = useState(false);
  const [waitingGuardian, setWaitingGuardian] = useState(false);
  // Bumped when the new screens were filled from the draft (the phone box takes its starting value only when it mounts).
  const [hydrated, setHydrated] = useState(0);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  // STUDENT-CONFIRMS-ALL (owner, 2026-11-26): a student opening what their agent filled starts at the passport and confirms every
  // screen with Next, start to end, before signing; the stepper never jumps past the furthest screen they have confirmed. Their
  // progress is kept on this device per sending (a new sending after a change request starts again from the passport).
  const confirmMode = signsHere && handoff?.state === "with_student";
  const confirmKey = `slit-portal-wizard-confirmed:${portalScopeCacheKey()}:${applicationId}:${handoff?.sentAt ?? ""}`;
  const confirmedUpTo = useRef(0);
  const confirmOpened = useRef(false);
  useEffect(() => {
    if (confirmOpened.current || !confirmMode || loading) return;
    confirmOpened.current = true;
    let saved = 0;
    try { saved = Math.max(0, Math.min(LAST_STEP, Number(window.localStorage.getItem(confirmKey)) || 0)); } catch { /* storage unavailable */ }
    confirmedUpTo.current = saved;
    setStep(saved);
  }, [confirmMode, loading, confirmKey]);
  useEffect(() => {
    if (!confirmMode || !confirmOpened.current || step <= confirmedUpTo.current) return;
    confirmedUpTo.current = step;
    try { window.localStorage.setItem(confirmKey, String(step)); } catch { /* storage unavailable */ }
  }, [confirmMode, step, confirmKey]);

  useEffect(() => {
    if (!inputVersion) return;
    const timer = window.setTimeout(() => void persist(), 450);
    return () => window.clearTimeout(timer);
  }, [inputVersion, persist]);

  useEffect(() => {
    const dirty = () => persistence.current || Object.keys(pendingValues.current).length || Object.keys(pendingWizard.current).length;
    const unload = (event: BeforeUnloadEvent) => { if (dirty()) event.preventDefault(); };
    const hide = () => { if (document.visibilityState === "hidden" && dirty()) void persist(); };
    const flush = (event: Event) => (event as CustomEvent<{ waits: Promise<unknown>[] }>).detail.waits.push(
      persist().then((saved) => { if (!saved) throw new Error("Save the application before leaving."); }),
    );
    window.addEventListener("beforeunload", unload);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("portal-before-scope-switch", flush);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("portal-before-scope-switch", flush);
    };
  }, [persist]);

  const leaveDraft = async () => {
    // Save as draft keeps blank answers; only a filled-in invalid AVETMISS value stops it (shown under its field or in the summary).
    if (!loadError && Object.keys(answers).length) {
      const screen = step >= DOC_STEPS ? WIZARD_QUESTIONS[step - DOC_STEPS]?.id ?? "" : "";
      if (!(await avetmissGate(screen, {}, "draft"))) return;
    }
    if (await persist()) onCancel();
  };

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
        if (active) setDraftIssuingCountry(pick("issuing_country").trim() || pick("passport_issuing_country").trim());
        const courses = Array.isArray(values.courses_of_interest) ? (values.courses_of_interest as unknown[]).map(String) : [];
        if (active) {
          // DOCUMENT-FINDER: the student's name as the agent / admin entered it or the student gave it at sign-up.
          const recordName = [pick("first_name").trim(), pick("last_name").trim()].filter(Boolean).join(" ");
          setStudentFullName((pick("first_name").trim() && pick("last_name").trim() ? recordName : String(application.studentName ?? "")).trim().replace(/\s+/g, " "));
          const savedMode = (application.data.wizard as { docMode?: string } | undefined)?.docMode;
          if (savedMode === "bulk" || savedMode === "steps") setDocMode(savedMode);
          const saved = (application.data.wizard ?? {}) as { activeStep?: string; completedSteps?: string[]; courseChoice?: string; intakeChoice?: string; intakeLabel?: string; intakeJoin?: string; englishChoice?: string; studyChoice?: AusStudyAnswer; cambridgeChoice?: AusStudyAnswer };
          const last = ALL_STEPS.findIndex((item) => item.id === saved.activeStep);
          completedSteps.current = new Set(Array.isArray(saved.completedSteps) ? saved.completedSteps : []);
          if (last >= 0) {
            const docs = wizardDocs(stored);
            const scanned = pick("issuing_country").trim() || docs.filter((doc) => doc.category === "Passport").map((doc) => String(doc.extracted?.issuing_country ?? "").trim()).find(Boolean) || "";
            const savedNeed = visaNeed(scanned, pick(PR_ANSWER));
            const missing = WIZARD_STEPS.findIndex((item, index) => index < last && (item.id === "visa" ? savedNeed !== "none" : item.required) && !docs.some((doc) => doc.category === item.category));
            setStep(missing >= 0 ? missing : last);
          }
          const pathway = saved.englishChoice || pick("english_pathway");
          if (pathway === ENGLISH_PATHWAY.ausStudy) { setEnglishAlt(true); setAusStudy("Yes"); }
          else if (pathway === ENGLISH_PATHWAY.cambridge) { setEnglishAlt(true); setAusStudy("No"); setCambridge("Yes"); }
          if (saved.studyChoice) { setEnglishAlt(true); setAusStudy(saved.studyChoice); }
          if (saved.cambridgeChoice) setCambridge(saved.cambridgeChoice);
          setAnswers({
            // "Yes, another language" is selected unless an answer was already given.
            language_home: pick("language_home") || OTHER_LANGUAGE, language_other: pick("language_other"), language_code: pick("language_code"), usi_number: pick("usi_number"),
            ec_name: pick("ec_name"), ec_phone: pick("ec_phone"), ec_relationship: pick("ec_relationship"),
            // Residency after the passport (owner, 2026-11-25).
            [PR_ANSWER]: pick(PR_ANSWER),
            course: saved.courseChoice ?? courses[0] ?? "", preferred_intake: saved.intakeLabel ?? pick("preferred_intake"),
            // INT-01: the intake chosen on the course row (an intake typed before the dropdown is not kept: it is chosen again).
            intake_id: saved.intakeChoice ?? application.courses?.[0]?.intakeId ?? "", intake_join_date: saved.intakeJoin ?? pick("intake_join_date"),
          });
        }
        // A CMS user (staff) gets the Learning Management course list and, as an RTO Manager, may add an intake; anyone else is refused by rto_admin.
        const me = await rto<{ rtoManager: boolean; admin: boolean }>("me").catch(() => null);
        if (me) {
          // Only courses with an active intake on offer (the same list agents and students get).
          const offeredIds = new Set((await listInstitutionCourses().catch(() => [])).map((row) => row.courseId));
          const list = (await rto<RtoCourse[]>("course_list").catch(() => null))?.filter((c) => offeredIds.has(c.id)) ?? null;
          if (active) {
            setRtoManager(Boolean(me.rtoManager));
            if (list) setStaffCourses(list.filter((c) => c.code?.trim() && c.name?.trim()));
          }
        }
        // Agents and students: the courses open for applications (portal_course_options: Published, or with an open intake). No static list.
        if (!me) {
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
  }, [applicationId, loadAttempt]);

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

  /** Re-reads the draft's documents (sequence-guarded like the extraction poll: a newer local change always wins). */
  const [checkingAgain, setCheckingAgain] = useState(false);
  const refreshDocuments = useCallback(async (byHand = false) => {
    const sequence = ++refreshSequenceRef.current;
    if (byHand) setCheckingAgain(true);
    try {
      const stored = await listApplicationDocuments(applicationId);
      if (sequence === refreshSequenceRef.current) setDocuments(wizardDocs(stored));
    } catch { /* keep what is shown; the next focus / tick tries again */ }
    finally { if (byHand) setCheckingAgain(false); }
  }, [applicationId]);

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
          setUploadRejections((prev) => ({ ...prev, [item.category]: `${item.file.name}: ${error.message}` }));
        } else {
          setPending((prev) => prev.map((entry) => (entry.key === item.key ? { ...entry, error: error instanceof Error ? error.message : "Upload failed." } : entry)));
        }
      }
    },
    [applicationId, profile?.id],
  );

  // A single-document step that already has a file: a new upload replaces it and is read again, so it is asked first (2026-11-23).
  const [replaceAsk, setReplaceAsk] = useState<{ target: WizardStep; files: File[]; current: string } | null>(null);
  const handlePickFiles = (target: WizardStep, list: FileList | null) => {
    if (!list || list.length === 0) return;
    const existing = target.multiple ? undefined
      : documentsRef.current.find((doc) => doc.category === target.category && !dismissed.has(doc.id) && !isExpiredPassport(doc) && !isWrongDocument(doc));
    if (existing) { setReplaceAsk({ target, files: Array.from(list), current: existing.filename }); return; }
    uploadPicked(target, Array.from(list));
  };

  // The loader starts here, synchronously, before any hashing or network call.
  const uploadPicked = (target: WizardStep, list: File[]) => {
    if (list.length === 0) return;
    setUploadRejections((prev) => ({ ...prev, [target.category]: "" }));
    if (target.id === "passport") setExpiredPassport(null);
    if (target.id === "licence") setRejectedLicence(null);
    setRejectedDocs((prev) => { if (!prev[target.category]) return prev; const next = { ...prev }; delete next[target.category]; return next; });
    const items = list.map((file) => ({ key: crypto.randomUUID(), category: target.category, file }));
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
    documents.filter((doc) => ruleBool("admissions.passport_auto_delete_expired", true) && isExpiredPassport(doc) && !discardingRef.current.has(doc.id)).forEach((doc) => {
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
  // an entered value, so finishing only waits for in-flight work, records the
  // outstanding items and the student name, then submits the application
  // (WIZARD-FULL: the declaration and both confirmations were given on the last screen).
  // After Submit the success screen closes itself, or Continue closes it sooner: onFinish runs only once.
  const finishedRef = useRef(false);
  const leaveOnce = useRef(() => { if (!finishedRef.current) { finishedRef.current = true; onFinish(); } });
  useEffect(() => { leaveOnce.current = () => { if (!finishedRef.current) { finishedRef.current = true; onFinish(); } }; }, [onFinish]);
  const complete = useCallback(async () => {
    if (completingRef.current) return;
    completingRef.current = true;
    setFinishError("");
    try {
      await flushApplicationEdits(applicationId);
      const application = await getApplication(applicationId, false);
      if (!signsHere) {
        // Agents and staff never sign: the application goes to the student to review and sign.
        await sendApplicationInvitation(applicationId);
        try { window.localStorage.removeItem(wizardStepKey(applicationId)); } catch { /* storage unavailable */ }
        setSentToStudent(true);
        window.setTimeout(() => leaveOnce.current(), 2600);
        return;
      }
      await saveSignPassword(signPasswordRef.current);
      const receipt = await submitApplication(applicationId, declarationConsent(declarationsRef.current.ticked, signatureRef.current));
      try { window.localStorage.removeItem(wizardStepKey(applicationId)); } catch { /* storage unavailable */ }
      if (receipt.waitingGuardian) { setWaitingGuardian(true); void reloadHandoff(); return; }
      setSubmittedRef(receipt.reference || application?.reference || "Submitted");
      // A student reads the thank-you message and closes it; agents and staff move on by themselves.
      if (role !== "student") window.setTimeout(() => leaveOnce.current(), 2200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "We could not submit the application.";
      if (isCheckViolation(error)) { setFinishError(message); setFinishing(false); completingRef.current = false; return; }
      // "Required field missing: title" and the like: say which screen holds it, so the agent can go straight there.
      const field = message.match(/:\s*([a-z_]+)\s*$/)?.[1] ?? "";
      const screen = SCREEN_OF_FIELD.get(field) ?? OTHER_SCREENS[field] ?? "";
      const at = screen ? WIZARD_QUESTIONS.findIndex((item) => item.id === screen) : -1;
      setFinishError(at >= 0 ? `${message}. Fix it on "${WIZARD_QUESTIONS[at].title}", then submit again.` : message);
      if (at >= 0) setStep(DOC_STEPS + at);
      setFinishing(false);
      completingRef.current = false;
    }
  }, [applicationId, role, signsHere, reloadHandoff]);

  const busy = pending.some((item) => !item.error) || documents.some((doc) => isReading(doc) && !dismissed.has(doc.id) && !slowDocs.has(doc.id));
  useEffect(() => {
    if (finishing && !busy) void complete();
  }, [finishing, busy, complete]);

  /* ------------------------------------------------------------ navigate */

  // Passport requirement is controlled by the published admissions.application_required_documents rule.
  const passportExpired = expiredPassport !== null || documents.some(isExpiredPassport);
  const hasPassport = documents.some((doc) => doc.category === WIZARD_STEPS[PASSPORT_STEP]?.category && !isExpiredPassport(doc));
  const passportRequired = PASSPORT_STEP >= 0 && Boolean(WIZARD_STEPS[PASSPORT_STEP].required) && (passportExpired || !hasPassport);
  // Every required document must be uploaded before the agent can move past its step.
  const ausStudyDocs = AUS_STUDY_STEP ? documents.filter((doc) => doc.category === AUS_STUDY_STEP.category && !isWrongDocument(doc)) : [];
  /** The English requirement met without a test result: Australian study proof uploaded, or Yes to the Cambridge English course. */
  // Business Rules admissions.english_test_alternatives: only the ways SLIT accepts count.
  const alternatives = englishAlternatives();
  const englishAltMet = englishAlt && ((alternatives.ausStudy && ausStudy === "Yes" && ausStudyDocs.length > 0) || (alternatives.cambridge && ausStudy === "No" && cambridge === "Yes"));
  // Compare names extracted from the academic evidence and passport; preserve originals for review.
  // Missing OCR names are unknown, not mismatches. Never delete academic evidence for a name difference.
  const extractedName = (values?: Record<string, string>) => {
    if (!values) return "";
    const combined = ["full_name", "student_name", "name", "candidate_name", "holder_name"].map(key => values[key]).find(Boolean);
    return combined || [values.first_name || values.given_names || values.given_name, values.middle_name, values.last_name || values.surname || values.family_name].filter(Boolean).join(" ");
  };
  const nameTokens = (name: string) => name.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z\\s]/g, " ").split(/\\s+/).filter(Boolean);
  const passportName = documents.filter(doc => doc.category === "Passport" && doc.extraction === "done").map(doc => extractedName(doc.extracted)).find(Boolean) || "";
  const academicNameReviews = ruleBool("admissions.academic_passport_name_review", true) && passportName
    ? documents.filter(doc => doc.category === "Academic" && doc.extraction === "done").flatMap(doc => {
        const name = extractedName(doc.extracted);
        if (!name) return [];
        const a = nameTokens(name), p = nameTokens(passportName);
        if (!a.length || !p.length || (a.length === p.length && a.every(token => p.includes(token)))) return [];
        return [{ filename: doc.filename, name }];
      }) : [];
  const visaDocuments = documents.filter(doc => doc.category === "Visa" && !isWrongDocument(doc));
  const visaExpiry = (doc: WizardDoc) => {
    const v = doc.extracted ?? {};
    const raw = v.visa_expiry_date || v.visa_expiry || v.expiry_date || v.expiration_date || v.date_of_expiry || "";
    if (!raw) return { known: false, expired: false };
    const parsed = /^\\d{4}-\\d{2}-\\d{2}$/.test(raw) ? new Date(raw + "T23:59:59") : new Date(raw);
    return { known: !Number.isNaN(parsed.getTime()), expired: !Number.isNaN(parsed.getTime()) && parsed.getTime() < Date.now() };
  };
  const acceptableVisa = visaDocuments.filter(doc =>
    !(ruleBool("admissions.visa_reject_expired", true) && doc.extraction === "done" && visaExpiry(doc).expired) &&
    !(ruleBool("admissions.visa_require_expiry_date", false) && doc.extraction === "done" && !visaExpiry(doc).known) &&
    !(ruleBool("admissions.visa_require_subclass", false) && doc.extraction === "done" && !String(doc.extracted?.visa_subclass ?? "").trim())
  );
  const visaNamesForReview = ruleBool("admissions.visa_passport_name_review", true) && passportName
    ? visaDocuments.filter(doc => doc.extraction === "done").flatMap(doc => {
        const name = extractedName(doc.extracted);
        if (!name) return [];
        const a = nameTokens(name), p = nameTokens(passportName);
        return a.length && p.length && !(a.length === p.length && a.every(token => p.includes(token))) ? [{ filename: doc.filename, name }] : [];
      }) : [];
  const stepHasDoc = (item: WizardStep) => (item.id === "english" && englishAltMet)
    // PR evidence counts only when its subclass is not a known temporary visa (unreadable: SLIT verifies it).
    || (item.id === "visa" ? acceptableVisa.some((doc) => need !== "pr" || doc.extraction !== "done" || !notPermanentSubclass(String(doc.extracted?.visa_subclass ?? ""))) : documents.filter((doc) => doc.category === item.category && !isExpiredPassport(doc) && !isOverseasLicence(doc) && !isWrongDocument(doc)).length >= (item.id === "academic" ? Math.max(1, Math.floor(ruleNumber("admissions.academic_minimum_documents", 1))) : 1));
  // The passport's issuing country: the draft's value, else the scanned passport's (owner, 2026-11-25).
  const passportCountry = draftIssuingCountry || documents
    .filter((doc) => doc.category === WIZARD_STEPS[PASSPORT_STEP]?.category && doc.extraction === "done")
    .map((doc) => String(doc.extracted?.issuing_country || doc.extracted?.passport_issuing_country || "").trim())
    .find(Boolean) || "";
  // Residency (owner, 2026-11-25): the visa step asks for PR evidence (permanent resident) or the student's visa (not PR; required as
  // the Business Rule says), and is skipped for an Australian / New Zealand passport.
  const need: VisaNeed = visaNeed(passportCountry, answers[PR_ANSWER] ?? "");
  const residencyDone = residencyAnswered(passportCountry, answers[PR_ANSWER] ?? "");
  const kind = studentKind(passportCountry, answers[PR_ANSWER] ?? "");
  // The start-date calendar follows the passport, PR answer and visa read from the documents: the student never chooses it.
  const studyLoad = studyLoadFor(kind, acceptableVisa.filter((doc) => doc.extraction === "done").map((doc) => String(doc.extracted?.visa_subclass ?? "")));
  // PR evidence checked: a subclass read from the upload that is not a permanent visa is flagged.
  const temporaryPrVisa = need === "pr" ? acceptableVisa.find((doc) => doc.extraction === "done" && notPermanentSubclass(String(doc.extracted?.visa_subclass ?? ""))) : undefined;
  const skipStep = (item: WizardStep | WizardQuestion | undefined) => item?.id === "visa" && need === "none";
  const stepRequired = (item: WizardStep) => (item.id !== "visa" ? Boolean(item.required) : need === "pr" || (need === "visa" && Boolean(item.required)));
  /** The step as shown: the visa step reads as PR evidence for a permanent resident. */
  const shownStep = (item: WizardStep): WizardStep => (item.id !== "visa" || need !== "pr" ? item
    : { ...item, title: "Permanent residency evidence", short: "PR evidence", noun: "PR evidence", subtitle: "Required. Upload the permanent residency visa grant notice." });
  const firstMissingBefore = (target: number) => WIZARD_STEPS.findIndex((item, index) => index < target && stepRequired(item) && !skipStep(item) && (!stepHasDoc(item) || (item.id === "passport" && ruleBool("admissions.passport_require_expiry_date", false) && documents.some((doc) => doc.category === item.category && doc.extraction === "done" && !getDocumentExpiryStatus("passport", doc.extracted ?? {}).date))));
  // Forward navigation cannot bypass documents marked required by the published admissions rule.
  const goTo = async (index: number, completed = false) => {
    if (loading || loadError || finishing) return;
    // A student confirming the agent's work moves forward one screen at a time (Next), never past what they have confirmed.
    const bounded = Math.max(0, Math.min(index, LAST_STEP, confirmMode ? Math.max(confirmedUpTo.current, step + 1) : LAST_STEP));
    if (completed && ALL_STEPS[step]) completedSteps.current.add(ALL_STEPS[step].id);
    const missing = bounded > step ? firstMissingBefore(bounded) : -1;
    let next = missing >= 0 ? missing : bounded;
    // A step not needed (the visa step for a domestic or offshore student) is passed over in the direction of travel.
    if (skipStep(ALL_STEPS[next]) && next !== step) next = Math.max(0, Math.min(next + (next > step ? 1 : -1), LAST_STEP));
    pendingWizard.current = { ...pendingWizard.current, activeStep: ALL_STEPS[next]?.id, completedSteps: [...completedSteps.current] };
    if (await persist()) setStep(next);
  };

  /**
   * Next on a document step. After the passport: saves the residency answer (au_permanent_resident; blank for an Australian /
   * New Zealand passport) and holds_visa No when no visa is needed. After the visa screen: holds_visa Yes (PR evidence or a visa
   * uploaded) or No (skipped where the Business Rule allows it).
   */
  const [savingResidency, setSavingResidency] = useState(false);
  /* BULK-DOCUMENTS (owner 2026-11-28): all documents at once, or one at a time (the guided steps). The same wizard for every role. */
  const [docMode, setDocMode] = useState<"" | "bulk" | "steps">("");
  const [studentFullName, setStudentFullName] = useState("");
  const chooseMode = (mode: "bulk" | "steps", at?: string) => {
    setDocMode(mode);
    pendingWizard.current = { ...pendingWizard.current, docMode: mode };
    markDirty();
    void persist();
    if (mode === "steps" && at) { const index = WIZARD_STEPS.findIndex((item) => item.id === at); if (index >= 0) void goTo(index); }
  };
  // The other documents are checked against the stored passport: while the passport is still uploading they wait here.
  const bulkQueue = useRef<Array<{ stepId: string; files: File[] }>>([]);
  const passportStored = documents.some((doc) => doc.category === WIZARD_STEPS[PASSPORT_STEP]?.category && !isExpiredPassport(doc));
  const passportUploading = pending.some((item) => item.category === WIZARD_STEPS[PASSPORT_STEP]?.category && !item.error);
  useEffect(() => {
    if (!passportStored || !bulkQueue.current.length) return;
    const queued = bulkQueue.current;
    bulkQueue.current = [];
    queued.forEach((entry) => bulkPick(entry.stepId, entry.files));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flushed once the passport is stored
  }, [passportStored]);
  const bulkPick = (stepId: string, files: File[], passportComing = false) => {
    const target = WIZARD_STEPS.find((item) => item.id === stepId);
    if (!target || !files.length) return;
    if (stepId !== "passport" && !passportStored && (passportUploading || passportComing)) { bulkQueue.current.push({ stepId, files }); return; }
    const existing = target.multiple ? undefined
      : documentsRef.current.find((doc) => doc.category === target.category && !dismissed.has(doc.id) && !isExpiredPassport(doc) && !isWrongDocument(doc));
    if (existing) { setReplaceAsk({ target, files, current: existing.filename }); return; }
    uploadPicked(target, files);
  };
  // The visa stays on the list (optional) until the passport is read: then the residency answers decide whether it is needed.
  const bulkSteps = WIZARD_STEPS.filter((item) => !skipStep(item) || (item.id === "visa" && (!hasPassport || visaDocuments.length > 0))).map((item) => {
    const docs = documents.filter((doc) => doc.category === item.category && !dismissed.has(doc.id) && !isExpiredPassport(doc) && !isWrongDocument(doc));
    const rejected = rejectedDocs[item.category];
    const problem = uploadRejections[item.category]
      || (item.id === "passport" && expiredPassport ? `${expiredPassport.filename} has expired${expiredPassport.date ? ` (${formatExpiryDate(expiredPassport.date)})` : ""} and was not kept. Upload the current passport.` : "")
      || (item.id === "licence" && rejectedLicence ? `${rejectedLicence.filename} is not an Australian driving licence, so it was not kept.` : "")
      || (rejected ? `${rejected.filename} is not ${STEP_CHECKS[item.category]?.what ?? `the ${item.noun}`}, so it was not kept.` : "");
    return { step: shownStep(item), required: stepRequired(item) && !skipStep(item), docs, pending: pending.filter((entry) => entry.category === item.category), problem: problem || undefined,
      metOtherwise: item.id === "english" && englishAltMet ? "Met without a test result" : undefined };
  });
  const bulkBlockedNow = () => pending.some((item) => !item.error) || documents.some((doc) => isReading(doc) && !dismissed.has(doc.id) && !slowDocs.has(doc.id))
    || bulkSteps.some((entry) => entry.required && !stepHasDoc(WIZARD_STEPS.find((item) => item.id === entry.step.id)!)) || !hasPassport || !residencyDone;
  /** Saves what the document steps would have saved (residency, visa held, English by test result), then the card view. */
  const continueFromBulk = async () => {
    if (bulkBlockedNow()) return;
    const values: Record<string, unknown> = {};
    const domestic = isDomesticPassport(passportCountry);
    if (!domestic) values[PR_ANSWER] = answers[PR_ANSWER] ?? "";
    values.holds_visa = need === "none" ? "No" : need === "pr" ? "Yes" : visaDocuments.length > 0 ? "Yes" : "No";
    if (!englishAlt && documents.some((doc) => doc.category === WIZARD_STEPS.find((item) => item.id === "english")?.category)) {
      Object.assign(values, { english_pathway: ENGLISH_PATHWAY.test, aus_study_2yrs: "", cambridge_course: "" });
    }
    setSavingResidency(true);
    setReadSaveError("");
    try {
      WIZARD_STEPS.forEach((item) => completedSteps.current.add(item.id));
      pendingWizard.current = { ...pendingWizard.current, docMode: "bulk", bulkDone: true, completedSteps: [...completedSteps.current], activeStep: WIZARD_QUESTIONS[0]?.id };
      if (!(await persist())) return;
      await saveWizardDraft(applicationId, { values });
      if (onCards) onCards(); else setStep(DOC_STEPS);
    } catch (error) {
      setReadSaveError(error instanceof Error ? error.message : "We could not save these answers. Try again.");
    } finally {
      setSavingResidency(false);
    }
  };
  const nextFromDocument = async () => {
    const values: Record<string, unknown> = {};
    if (current.id === "passport" && hasPassport) {
      const domestic = isDomesticPassport(passportCountry);
      const pr = domestic ? "" : answers[PR_ANSWER] ?? "";
      values[PR_ANSWER] = pr;
      if (need === "none") values.holds_visa = "No";
    } else if (current.id === "visa" && need === "pr") {
      values.holds_visa = "Yes";
    } else if (current.id === "visa" && need === "visa") {
      values.holds_visa = visaDocuments.length > 0 ? "Yes" : "No";
    }
    if (!Object.keys(values).length) { await goTo(step + 1, true); return; }
    setSavingResidency(true);
    setReadSaveError("");
    try {
      if (!(await persist())) return;
      await saveWizardDraft(applicationId, { values });
      await goTo(step + 1, true);
    } catch (error) {
      setReadSaveError(error instanceof Error ? error.message : "We could not save these answers. Try again.");
    } finally {
      setSavingResidency(false);
    }
  };

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
      if (!(await persist())) return;
      await saveWizardDraft(applicationId, { values });
      await goTo(step + 1, true);
    } catch (error) {
      setEnglishSaveError(error instanceof Error ? error.message : "We could not save your English details. Try again.");
    } finally {
      setSavingEnglish(false);
    }
  };
  const chooseCambridge = (value: "Yes" | "No") => {
    setCambridge(value);
    pendingWizard.current.cambridgeChoice = value;
    markDirty();
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

  // null until the list has loaded; an empty list means no course is open for applications.
  const courseLabels: string[] | null = staffCourses ? staffCourses.map(staffCourseLabel) : institutionCourses ? institutionCourses.map((course) => `${course.code} - ${course.title}`) : null;
  // A course saved on the draft that is no longer on offer (or is listed under another label) is not kept silently: the same course is
  // matched by its code, otherwise the choice is cleared so the student picks again (instead of an error on Next).
  useEffect(() => {
    if (!courseLabels || !answers.course || courseLabels.includes(answers.course)) return;
    const code = answers.course.split(" - ")[0].trim().toUpperCase();
    const same = courseLabels.find((label) => label.split(" - ")[0].trim().toUpperCase() === code);
    setAnswers((prev) => ({ ...prev, course: same ?? "", ...(same ? {} : { preferred_intake: "", intake_id: "", intake_join_date: "" }) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the offered list or the chosen course changes
  }, [courseLabels?.join("|"), answers.course]);
  const institutionCourseOf = (label: string) => institutionCourses?.find((item) => `${item.code} - ${item.title}` === label) ?? null;
  const staffCourseOf = (label: string) => staffCourses?.find((c) => staffCourseLabel(c) === label) ?? null;
  const setAnswer = (name: string, value: string) => {
    touchedRef.current.add(name);
    // A new course clears the intake: intakes belong to one course.
    setAnswers((prev) => ({ ...prev, [name]: value, ...(name === "course" && value !== prev.course ? { intake_id: "", preferred_intake: "", intake_join_date: "" } : {}),
      // OSHC changed to No: the own-cover confirmation is ticked (owner 2026-11-25).
      ...(name === "oshc_require" && value === "No" ? { oshc_self_confirm: "Yes" } : {}) }));
    if (name === "course") {
      setIntakeList(null);
      Object.assign(pendingWizard.current, { courseChoice: value, intakeChoice: "", intakeLabel: "", intakeJoin: "" });
      markDirty();
    } else if (name !== "mobile" && name !== "ec_phone" || !value || !validateStoredPhone(value)) {
      const declaration = ["declaration_read", "consent_confirmed", "consent_authorised"];
      if (!declaration.includes(name) && (name !== "email" || (!emailProblem(value) && role !== "student"))) {
        pendingValues.current[name] = value;
        if (name === "email") pendingValues.current.confirm_email = value;
        markDirty();
      }
    }
    setAnswerErrors((prev) => (prev[name] ? { ...prev, [name]: "" } : prev));
  };
  /** A value read from a document, corrected on the document step: saved to the draft at once and used by the later screens. */
  const [readSaveError, setReadSaveError] = useState("");
  const correctReadValue = async (key: string, value: string) => {
    setAnswer(key, value);
    setReadSaveError("");
    try {
      await flushApplicationEdits(applicationId);
      if (!(await persist())) throw new Error("This correction could not be saved.");
    } catch (error) {
      setReadSaveError(error instanceof Error ? error.message : "We could not save that correction. Try again.");
    }
  };
  // The course's intakes as listed (real intakes, or the fallback months): the choice must be one of them.
  const [intakeList, setIntakeList] = useState<OpenIntake[] | null>(null);
  const courseIdOf = (label: string): string | null => {
    if (staffCourses) return staffCourseOf(label)?.id || null;
    return institutionCourseOf(label)?.courseId || null;
  };
  const setIntake = (intake: OpenIntake | null) => {
    Object.assign(pendingWizard.current, { intakeChoice: intake?.id ?? "", intakeLabel: intake?.display ?? "", intakeJoin: intake?.joinDate ?? "" });
    markDirty();
    setAnswers((prev) => ({ ...prev, intake_id: intake?.id ?? "", preferred_intake: intake?.display ?? "", intake_join_date: intake?.joinDate ?? "" }));
    setAnswerErrors((prev) => (prev.preferred_intake ? { ...prev, preferred_intake: "" } : prev));
  };
  const intakesLoaded = (list: OpenIntake[]) => {
    setIntakeList(list);
    const wanted = pendingIntake.current;
    if (!wanted) return;
    const created = list.find((i) => i.id === wanted);
    if (created) { setIntake(created); pendingIntake.current = null; }
  };
  const currentCourseId = answers.course ? courseIdOf(answers.course) : null;

  /**
   * WIZARD-FULL: the new screens start from the draft as it is now (the passport, licence and academic files were read into it
   * while the documents were uploaded), with the same starting answers the full form used; anything typed here is kept.
   */
  const hydrateFinish = useCallback(async () => {
    const application = await getApplication(applicationId, false).catch(() => null);
    if (!application) return;
    const values = (application.data.values ?? {}) as Record<string, unknown>;
    const stored = (name: string) => (typeof values[name] === "string" ? String(values[name]).trim() : Array.isArray(values[name]) && (values[name] as unknown[]).length ? "Yes" : "");
    setDraftIssuingCountry(stored("issuing_country") || stored("passport_issuing_country"));
    const hasAcademic = documentsRef.current.some((doc) => doc.category === "Academic");
    setAnswers((prev) => {
      const next = { ...prev };
      const fill = (name: string, value: string) => { if (!touchedRef.current.has(name)) next[name] = value; };
      for (const name of FINISH_FIELDS) fill(name, stored(name));
      // AVETMISS-UI: the extra AVETMISS answers are strings (codes, a comma list, JSON rows).
      for (const name of AVETMISS_EXTRA_FIELDS) fill(name, typeof values[name] === "string" ? String(values[name]) : "");
      if (!next.language_home && typeof values.language_home === "string") next.language_home = String(values.language_home);
      studentIdRef.current = application.studentId;
      // Nothing typed twice: what the student record already has (the name and email given when the student was added)
      // fills the boxes the passport did not.
      const fullName = application.studentName.trim().replace(/\s+/g, " ");
      if (fullName && !next.first_name && !next.last_name) {
        const parts = fullName.split(" ");
        fill("first_name", parts[0] ?? "");
        if (parts.length > 1) fill("last_name", parts[parts.length - 1]);
        if (parts.length > 2 && !next.middle_name) fill("middle_name", parts.slice(1, -1).join(" "));
      }
      if (!next.email && application.studentEmail) fill("email", application.studentEmail.trim());
      if (!next.confirm_email && next.email) fill("confirm_email", next.email);
      const gender = next.gender ?? "";
      if (!next.title) fill("title", gender === "Male" ? "Mr" : gender === "Female" ? "Miss" : "");
      if (!next.citizenship) fill("citizenship", next.nationality ?? "");
      // Owner 2026-11-25: the country of birth is no longer copied from the citizenship; the Personal details screen asks
      // "Were you born in {passport country}?" (BirthCountryField) or offers the country search.
      if (!next.au_country) fill("au_country", "Australia");
      // Owner 2026-11-25: the usual answers are chosen for the agent again (they can change them).
      if (!next.atsi) fill("atsi", "No");
      if (!next.disability) fill("disability", "No");
      if (!next.employment) fill("employment", "Unemployed - Seeking Part-Time Work - 07");
      if (!next.secondary_enrolled) fill("secondary_enrolled", "No");
      // Owner 2026-11-25: school level and prior qualifications from the academic files already uploaded; English Well by default.
      const academic = academicPrefill(documentsRef.current);
      if (!next.school_level && academic.schoolLevel) fill("school_level", academic.schoolLevel);
      if (!next.prior_ed && academic.priorRows.length) fill("prior_ed", "Yes");
      else if (!next.prior_ed && academic.readable > 0) fill("prior_ed", "No");
      else if (!next.prior_ed && hasAcademic) fill("prior_ed", "Yes");
      if (!parsePriorEducation(next.prior_education ?? "").length && academic.priorRows.length) fill("prior_education", JSON.stringify(academic.priorRows));
      if (!next.english_proficiency_code) fill("english_proficiency_code", "2");
      if (!next.study_reason) fill("study_reason", "For personal interest or self-development - 09");
      if (!next.rpl) fill("rpl", "No");
      if (!next.oshc_require) fill("oshc_require", "No");
      // Owner 2026-11-25: with OSHC arranged by the student (No), the "I understand I must arrange my own cover" box starts ticked.
      if (next.oshc_require === "No" && next.oshc_self_confirm !== "Yes") fill("oshc_self_confirm", "Yes");
      if (!next.hear_about) fill("hear_about", role === "student" ? "" : "Agent");
      if (!next.declaration_name) fill("declaration_name", [next.first_name, next.middle_name, next.last_name].filter(Boolean).join(" "));
      fill("declaration_date", todayIso());
      return next;
    });
    setHydrated((n) => n + 1);
  }, [applicationId, role]);
  const finishScreen = question && FINISH_SCREEN_FIELDS[question.id] ? question.id : "";
  const loaded = !loading && !loadError;
  useEffect(() => { if (loaded && finishScreen) void hydrateFinish(); }, [loaded, finishScreen, hydrateFinish]);
  const pickAddress = (pick: AddressPick) => {
    for (const [name, value] of [["au_street", pick.line], ["au_line2", pick.line2], ["au_suburb", pick.suburb], ["au_state", pick.state.toUpperCase()], ["au_zip", pick.postcode], ["au_country", "Australia"]] as const) setAnswer(name, value);
    touchedRef.current.add("address_source:search");
  };

  /** Checks the screen's answers and saves them to the draft; false when something is missing or the save failed. */
  /** Scrolls to and focuses a field by its form key. */
  const focusField = (key: string) => window.requestAnimationFrame(() => {
    const el = (document.getElementById(`wizard-${key}`) ?? document.querySelector(`[name="${key}"]`)) as HTMLElement | null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  });
  /** AVETMISS-CHECK: the answers on screen (with this screen's cleaned values) checked by the database. Errors on this screen go under
   * their fields; errors on other screens, and on Submit what the student record still lacks, go to the summary. True = may go on. */
  const avetmissGate = async (screen: string, values: Record<string, unknown>, mode: "next" | "draft" | "submit"): Promise<boolean> => {
    let check: Awaited<ReturnType<typeof avetmissCheckAnswers>> = null;
    try { check = await avetmissCheckAnswers({ ...answers, ...values }, studentIdRef.current); }
    catch { return true; } // the save itself still refuses a bad value (check_violation, shown as it is)
    if (!check) return true;
    const here: Record<string, string> = {};
    const elsewhere: { label: string; screen: string }[] = [];
    for (const [key, message] of Object.entries(check.fieldErrors)) {
      const at = AVETMISS_FIELD_SCREEN[key] ?? SCREEN_OF_FIELD.get(key) ?? OTHER_SCREENS[key] ?? "";
      if (at === screen) here[key] = message;
      else elsewhere.push({ label: message, screen: at });
    }
    if (mode === "submit") for (const item of check.missingForSubmit) elsewhere.push({ label: `Missing: ${item}`, screen: avetmissMissingScreen(item) });
    // AVETMISS-PAGE-CHECK (owner 2026-11-26): every page's Next also stops while an answer this page holds is still missing for AVETMISS
    // (the same list Submit checks), shown under its field, or in the summary when the field is not on this page.
    const missingHere: { label: string; screen: string }[] = [];
    if (mode === "next") for (const item of check.missingInAnswers) {
      if (avetmissMissingScreen(item) !== screen) continue;
      const key = avetmissMissingField(item);
      const message = `Required for AVETMISS reporting: ${item}.`;
      const shown = key && (document.getElementById(`wizard-${key}`) ?? document.querySelector(`[name="${key}"]`));
      if (shown && !here[key]) here[key] = message; else if (!shown) missingHere.push({ label: `Missing: ${item}`, screen });
    }
    const keys = Object.keys(here);
    setAvetmissKeys(keys);
    if (keys.length) {
      setAnswerErrors((prev) => ({ ...prev, ...here }));
      focusField(keys[0]);
    }
    // Other screens block only the final Submit and Save as draft (Next moves on; that screen's own Next checks it again).
    const blockingElsewhere = mode === "next" ? missingHere : elsewhere;
    setCheckSummary(blockingElsewhere);
    return !keys.length && !blockingElsewhere.length;
  };
  const avetmissPending = avetmissKeys.some((key) => answerErrors[key]);

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
      // AVETMISS language identifier (ASCL): the chosen code, 1201 for English only; blank when typed as text (no list yet).
      values.language_code = answers.language_home === OTHER_LANGUAGE ? filled("language_code") : ENGLISH_LANGUAGE_CODE;
    } else if (target.id === "usi") {
      const usi = normalizeUsi(answers.usi_number ?? "");
      // Business Rules admissions.usi_required: Required (today) needs a USI here; Optional lets it stay blank ("No USI yet").
      const problem = usi ? validateUsi(usi) : usiRequired() ? "Enter the student's USI." : "";
      if (problem) errors.usi_number = problem;
      values.has_usi = usi || usiRequired() ? "Yes" : "No";
      values.usi_number = usi;
    } else if (target.id === "emergency") {
      const phone = String(new FormData(questionFormRef.current ?? undefined).get("ec_phone") ?? "").trim();
      // The shared rule (also the staff onboarding wizard's): name, phone with its country code, relationship.
      const problems = emergencyContactProblems({ name: answers.ec_name ?? "", phone, relationship: answers.ec_relationship ?? "" }, "the student");
      // Business Rules (admissions.emergency_contact_required_details): a detail SLIT made optional may stay blank, but what is typed is checked.
      if (problems.name && (detailRequired("ec_name") || filled("ec_name"))) errors.ec_name = problems.name;
      if (problems.phone && (detailRequired("ec_phone") || phone)) errors.ec_phone = problems.phone;
      if (problems.relationship) errors.ec_relationship = problems.relationship;
      values.ec_name = filled("ec_name");
      values.ec_phone = phone;
      values.ec_relationship = filled("ec_relationship");
      // An Australian number means the contact is in Australia (the form no longer asks).
      values.ec_in_au = phone.startsWith("+61") ? "Yes" : "No";
      setAnswers((prev) => ({ ...prev, ec_phone: phone }));
    } else if (target.id === "personal") {
      const oneOf = (name: string, message: string) => { if (!optionsOf(name).includes(filled(name))) errors[name] = message; };
      oneOf("title", "Choose the title.");
      oneOf("gender", "Choose the gender.");
      if (!filled("first_name")) errors.first_name = "Enter the given name as on the passport.";
      if (!filled("last_name")) errors.last_name = "Enter the surname as on the passport.";
      if (!validDate(filled("dob")) || filled("dob") >= todayIso()) errors.dob = "Enter the date of birth.";
      const emailIssue = filled("email") ? emailProblem(filled("email")) : "Enter the student's email.";
      if (emailIssue) errors.email = emailIssue;
      oneOf("nationality", "Choose the nationality.");
      oneOf("citizenship", "Choose the country of citizenship.");
      // Owner 2026-11-25: country of birth = the passport country (Yes) or a country picked from the AVETMISS list (No / no passport country).
      const passportLabel = filled(PASSPORT_COUNTRY_LABEL);
      const born = filled(BORN_IN_PASSPORT_COUNTRY);
      if (passportLabel && born !== "Yes" && born !== "No") errors[BORN_IN_PASSPORT_COUNTRY] = "Choose Yes or No.";
      else if (!filled("birth_country")) errors.birth_country = "Choose the country of birth.";
      else if (passportLabel && born === "No" && filled("birth_country") === passportLabel) errors.birth_country = `You answered No, so choose a country other than ${passportLabel} (or answer Yes).`;
      if (!filled("passport_number")) errors.passport_number = "Enter the passport number.";
      if (!validDate(filled("passport_expiry"))) errors.passport_expiry = "Enter the passport expiry date.";
      for (const name of FINISH_SCREEN_FIELDS.personal) values[name] = filled(name);
      values.confirm_email = filled("email");
    } else if (target.id === "address") {
      const problems = addressProblems({ street: filled("au_street"), line2: filled("au_line2"), suburb: filled("au_suburb"), state: filled("au_state"), postcode: filled("au_zip"), country: "Australia" });
      if (problems.street) errors.au_street = problems.street;
      if (problems.line2) errors.au_line2 = problems.line2;
      if (problems.suburb && detailRequired("au_suburb")) errors.au_suburb = problems.suburb;
      if (problems.state && (detailRequired("au_state") || filled("au_state"))) errors.au_state = problems.state;
      if (problems.postcode && (detailRequired("au_zip") || filled("au_zip"))) errors.au_zip = problems.postcode;
      // The portal's address is always an Australian one (as the full form fixes it).
      Object.assign(values, { address_type: "Australian Address", au_street: filled("au_street"), au_line2: filled("au_line2"), au_suburb: filled("au_suburb"),
        au_state: filled("au_state").toUpperCase(), au_zip: filled("au_zip"), au_country: "Australia",
        address_source: touchedRef.current.has("address_source:search") ? "search" : "manual" });
    } else if (target.id === "identifier") {
      const labels: Record<string, string> = { atsi: "Choose an answer.", employment: "Choose the employment status.", disability: "Choose an answer.",
        secondary_enrolled: "Choose Yes or No.", school_level: "Choose the highest completed school level.", prior_ed: "Choose an answer." };
      for (const name of FINISH_SCREEN_FIELDS.identifier) {
        if (!optionsOf(name).includes(filled(name))) errors[name] = labels[name];
        values[name] = filled(name);
      }
      // AVETMISS-UI: English proficiency when another language is spoken at home, disability types, prior qualifications.
      const otherLanguage = String(answers.language_home ?? "") === OTHER_LANGUAGE;
      // Owner 2026-11-25: NCVER no longer receives English proficiency (AVETMISS 8.0), so it is optional: Well unless changed.
      if (filled("disability") === "Yes" && !parseCodeList(filled("disability_types")).length) errors.disability_types = "Choose at least one disability type.";

      const priorRows = parsePriorEducation(filled("prior_education")).filter((r) => r.code || r.recognition || r.name.trim());
      if (filled("prior_ed") === "Yes" && priorEducationProblem(priorRows)) errors.prior_education = priorEducationProblem(priorRows);
      values.english_proficiency_code = otherLanguage ? (filled("english_proficiency_code") || "2") : "";
      // AVETMISS-SUBMIT-FIX: the year the highest school level was completed (4 digits, after age 5, not in the future).
      const schoolLevel = filled("school_level");
      if (schoolLevel && !/ - 02$/.test(schoolLevel)) {
        const year = avetmissYear(filled("year_completed")) || filled("year_completed"); const born = Number(String(answers.dob ?? "").slice(0, 4)); const now = new Date().getFullYear();
        if (!/^\d{4}$/.test(year)) errors.year_completed = "Enter the year (4 digits).";
        else if (Number(year) > now || (born && Number(year) < born + 5)) errors.year_completed = `Enter a year between ${born ? born + 5 : 1900} and ${now}.`;
        values.year_completed = year;
      } else values.year_completed = "";
      values.disability_types = filled("disability") === "Yes" ? filled("disability_types") : "";
      values.prior_education = filled("prior_ed") === "Yes" ? JSON.stringify(priorRows) : "";
    } else if (target.id === "study") {
      for (const [name, message] of [["study_reason", "Choose the main reason."], ["rpl", "Choose Yes or No."], ["oshc_require", "Choose an answer."], ["hear_about", "Choose how the student heard about SLIT."]] as const) {
        if (!optionsOf(name).includes(filled(name))) errors[name] = message;
      }
      if (filled("oshc_require") === "No" && filled("oshc_self_confirm") !== "Yes") errors.oshc_self_confirm = "Confirm the student will arrange their own health cover.";
      for (const name of ["oshc_start_date", "oshc_expiry"]) if (filled(name) && !validDate(filled(name))) errors[name] = "Enter a valid date.";
      Object.assign(values, {
        study_reason: filled("study_reason"), rpl: filled("rpl"), oshc_require: filled("oshc_require"), hear_about: filled("hear_about"),
        oshc_start_date: filled("oshc_require") === "Yes" ? filled("oshc_start_date") : "",
        oshc_self_confirm: filled("oshc_require") === "No" && OSHC_SELF_CONFIRM ? [OSHC_SELF_CONFIRM] : [],
        oshc_provider: filled("oshc_require") === "Already Have" ? filled("oshc_provider") : "",
        oshc_policy_number: filled("oshc_require") === "Already Have" ? filled("oshc_policy_number") : "",
        oshc_expiry: filled("oshc_require") === "Already Have" ? filled("oshc_expiry") : "",
      });
    } else if (target.id === "declare") {
      const mobile = filled("mobile");
      const mobileProblem = mobile ? validateStoredPhone(mobile) : ruleBool("admissions.application_mobile_required", false) ? "Enter the student's mobile number." : "";
      if (mobileProblem) errors.mobile = mobileProblem;
      values.mobile = mobile;

      // One tick agrees and signs: the name is the student's own (from Personal details), never typed again.
      const signer = filled("declaration_name") || [filled("first_name"), filled("middle_name"), filled("last_name")].filter(Boolean).join(" ");
      if (signsHere && !declarationsRef.current.complete) errors.declaration_read = "Read and tick each declaration to sign.";
      else if (signsHere && !signatureRef.current) errors.declaration_read = "Draw your signature in the box to sign.";
      else if (signsHere && !signPasswordRef.current.valid) errors.declaration_read = "Create your password (at least the length shown, both the same) to sign.";
      else if (!signer) errors.declaration_read = "Add the student's name on Personal details first.";
      // What the full form used to fill itself: the checklist, USI consent, the agent block and the visa answer.
      const application = await getApplication(applicationId, false).catch(() => null);
      const stored = (application?.data.values ?? {}) as Record<string, unknown>;
      const empty = (name: string) => !String(stored[name] ?? "").trim();
      Object.assign(values, {
        declaration_name: signer, ...(signsHere ? { digital_signature: signer, declaration_date: todayIso(), usi_consent: [USI_CONSENT_TEXT] } : {}),
        checklist: CHECKLIST_OPTIONS, address_type: "Australian Address", au_country: "Australia",
        // The agency / agent block is the agent's: a student on an application their agent sent never writes it (view-only).
        ...(!studentLocked && empty("via_agent") ? { via_agent: "Yes" } : {}),
        ...(!studentLocked && empty("agent_agency") && (application?.agencyName || agencyName) ? { agent_agency: application?.agencyName || agencyName } : {}),
        // The agent's own details come from the application's assigned agent, else the signed-in agent: never typed.
        ...(() => {
          if (studentLocked) return {};
          const self = role === "agent" || role === "agency_admin";
          const agentName = application?.agentName || (self ? profile?.fullName ?? "" : "");
          const agentEmail = application?.agentEmail || (self ? profile?.email ?? "" : "");
          const agentPhone = application?.agentPhone || (self ? profile?.phone ?? "" : "");
          return {
            ...(empty("agent_contact_name") && agentName ? { agent_contact_name: agentName } : {}),
            ...(empty("agent_email") && agentEmail ? { agent_email: agentEmail } : {}),
            ...(empty("agent_phone") && agentPhone ? { agent_phone: agentPhone } : {}),
          };
        })(),
        ...(empty("holds_visa") ? { holds_visa: documentsRef.current.some((doc) => doc.category === "Visa") ? "Yes" : "No" } : {}),
      });
    } else {
      // STUDENT-CHANGES-COURSE (owner 2026-11-26): the student may change the course and intake the agent chose.
      if (!filled("course")) errors.course = "Choose the course.";
      const chosen = intakeKey(filled("intake_id"), filled("preferred_intake"), filled("intake_join_date"));
      if (filled("course") && intakeList?.length === 0) errors.preferred_intake = NO_INTAKES_MESSAGE;
      else if (!chosen || (intakeList && !intakeList.some((i) => intakeKey(i.id, i.display, i.joinDate) === chosen))) errors.preferred_intake = "Choose the intake.";
      // Australian / NZ citizens and permanent residents study on a VoE; everyone else may start on a CoE or a VoE, by their visa
      // (owner, 2026-11-26).
      else if (studyLoad && intakeList?.some((i) => intakeKey(i.id, i.display, i.joinDate) === chosen && i.studyLoad && i.studyLoad !== studyLoad))
        errors.preferred_intake = studyLoad === "voe"
          ? (kind === "domestic" ? "Australian and New Zealand citizens and permanent residents study on a VoE: choose a VoE start date." : "With this visa the student studies on a VoE: choose a VoE start date.")
          : "Student visa holders study on a CoE: choose a CoE start date.";
      if (filled("course")) {
        const staff = staffCourses ? staffCourseOf(answers.course) : null;
        const course: ApplicationCourseRow | null = staffCourses
          ? (staff ? { courseId: staff.id, code: staff.code, title: staff.name, variant: staff.variantLabel ?? staff.duration ?? "" } : null)
          : institutionCourseOf(answers.course);
        if (!course) errors.course = "This course is no longer offered. Choose another.";
        else patch.courses = [{ ...course, intakeId: filled("intake_id") || undefined }];
      }
      values.courses_of_interest = filled("course") ? [answers.course] : [];
      values.preferred_intake = filled("preferred_intake");
      // The start date picked (a unit start of the running class, or day one): placement starts the student there.
      values.intake_join_date = filled("intake_join_date");
    }
    setAnswerErrors(errors);
    if (Object.values(errors).some(Boolean)) return false;
    setSavingAnswers(true);
    const allowed = await avetmissGate(target.id, values, "next").finally(() => setSavingAnswers(false));
    if (!allowed) return false;
    setSavingAnswers(true);
    setAnswerSaveError("");
    try {
      await flushApplicationEdits(applicationId);
      if (!(await persist())) return false;
      await saveWizardDraft(applicationId, { values, ...patch });
      // AVETMISS-UI: copied to the student's AVETMISS tables when this user may write them (best effort; an agent's stays pending).
      if ((target.id === "identifier" || target.id === "language" || target.id === "personal") && studentIdRef.current) await syncApplicationAvetmiss(studentIdRef.current, values);
      return true;
    } catch (error) {
      // A check_violation (23514) carries the database's own message for the user.
      setAnswerSaveError(isCheckViolation(error) ? error.message : error instanceof Error ? error.message : "We could not save these answers. Try again.");
      return false;
    } finally {
      setSavingAnswers(false);
    }
  };

  const nextFromQuestion = async () => {
    if (!question || !(await saveAnswers(question))) return;
    // Submit: every AVETMISS value valid and nothing missing from the student record (summary with links otherwise).
    if (step === LAST_STEP && !(await avetmissGate(question.id, {}, "submit"))) return;
    if (step === LAST_STEP) setFinishing(true);
    else await goTo(step + 1, true);
  };

  const stepDocs = documents.filter((doc) => doc.category === current.category);
  const stepPending = pending.filter((item) => item.category === current.category);
  const hasFile = stepDocs.length > 0 || stepPending.length > 0;
  const isLast = step === LAST_STEP;
  const ready = !loading && !loadError;

  const stepBusy = (target: WizardStep) =>
    pending.some((item) => item.category === target.category && !item.error) ||
    documents.some((doc) => doc.category === target.category && isReading(doc) && !dismissed.has(doc.id) && !slowDocs.has(doc.id));
  const allSteps = ALL_STEPS;
  const bulkBusy = WIZARD_STEPS.some((item) => stepBusy(item));
  const bulkMissing = bulkSteps.filter((entry) => entry.required && !stepHasDoc(WIZARD_STEPS.find((item) => item.id === entry.step.id)!));
  const bulkBlocked = bulkBusy || bulkMissing.length > 0 || !hasPassport || !residencyDone;
  // A student confirming what the agent sent gets the same choice when documents are still missing (STUDENT-INVITE-DOCUMENTS).
  const bulkView = ready && docMode === "bulk" && !submittedRef && !sentToStudent && step < DOC_STEPS;
  const chooseView = ready && docMode === "" && !submittedRef && step === 0 && pending.length === 0 && (documents.length === 0 || confirmMode);
  const wizardStages: WizardStage[] = stageRanges.map((range) => ({ ...range, busy: WIZARD_STEPS.some((item, i) => i >= range.from && i <= range.to && stepBusy(item)) }));
  // While this step's file uploads or is read, the wizard is locked so nothing else can be clicked.
  const removingExpired = !expiredPassport?.error && stepDocs.some(isExpiredPassport);
  const removingWrong = !rejectedDocs[current.category]?.error && stepDocs.some(isWrongDocument);
  const locked = ready && !question && !bulkView && !chooseView && (stepBusy(current) || removingExpired || removingWrong);
  // A file read too slowly unlocks the wizard but still holds Next until its result is in (or it is deleted).
  const slowHere = stepDocs.filter((doc) => isReading(doc) && slowDocs.has(doc.id));
  const rejectedHere = rejectedDocs[current.category];
  const stepCheck = STEP_CHECKS[current.category];
  const blockedByPassport = passportRequired && step === PASSPORT_STEP;
  const passportMissingExpiry = current.id === "passport" && ruleBool("admissions.passport_require_expiry_date", false) && current.required && documents.some((doc) => doc.category === current.category && doc.extraction === "done" && !getDocumentExpiryStatus("passport", doc.extracted ?? {}).date);
  const blockedByRequiredDocument = !question && ((stepRequired(current) && !stepHasDoc(current)) || passportMissingExpiry);
  // The passport step also waits for the residency answers once the passport is in.
  const blockedByResidency = !question && current.id === "passport" && hasPassport && !residencyDone;
  // The document notices below belong to document screens only.
  const onDocStep = !question && !bulkView && !chooseView;

  // A document added somewhere else while the wizard is open (the full form, another tab or device, another person) must show here,
  // or the step keeps saying it is required and invites a second upload. Re-read the list when the window comes back into focus,
  // when the step changes, and every 12 seconds while a required document is holding Next (2026-11-23).
  const waitingForDocument = ready && onDocStep && (blockedByPassport || blockedByRequiredDocument) && !locked && stepPending.length === 0;
  useEffect(() => {
    if (!ready) return undefined;
    const refresh = () => { if (document.visibilityState === "visible") void refreshDocuments(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [ready, refreshDocuments]);
  useEffect(() => { if (ready) void refreshDocuments(); }, [ready, step, refreshDocuments]);
  useEffect(() => {
    if (!waitingForDocument) return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshDocuments(); }, 12_000);
    return () => window.clearInterval(timer);
  }, [waitingForDocument, refreshDocuments]);
  const checkAgain = waitingForDocument ? (
    <button type="button" onClick={() => void refreshDocuments(true)} disabled={checkingAgain} data-testid="wizard-check-again"
      className="ml-1 cursor-pointer font-semibold text-primary-700 underline-offset-2 hover:underline disabled:cursor-wait disabled:opacity-60">
      {checkingAgain ? "Checking…" : "Uploaded it somewhere else? Check again"}
    </button>
  ) : null;

  const primaryClass = WIZARD_PRIMARY_CLASS;

  /* --------------------------------------------------------------- render */

  const body = () => {
    if (loading) return <PortalLoading label="Loading the document wizard…" />;
    if (loadError) {
      return (
        <div className="space-y-4">
          <PortalError message={loadError} onRetry={() => setLoadAttempt((attempt) => attempt + 1)} />
          <button
            type="button"
            onClick={() => void leaveDraft()}
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border border-background-300 px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:bg-background-100"
          >
            Close
          </button>
        </div>
      );
    }
    if (sentToStudent) {
      return (
        <div className="py-8 text-center" role="status" data-testid="wizard-sent-to-student">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-sky-600 text-background-50"><i className="ri-mail-send-line text-3xl" aria-hidden="true" /></span>
          <h3 className="mt-4 font-heading text-lg font-semibold text-foreground-950">Sent to the student to review and sign</h3>
          <p className="mt-1 text-sm text-foreground-600">They get an email link, sign in with a password or Google, check the application and sign it. It is view-only for you until they sign or you take it back.</p>
          <button type="button" onClick={() => leaveOnce.current()} className={`${primaryClass} mt-5`}>Continue</button>
        </div>
      );
    }
    if (waitingGuardian || (signsHere && handoff?.state === "waiting_guardian")) {
      return <div className="py-4"><GuardianRequestForm applicationId={applicationId} handoff={handoff} onSent={() => void reloadHandoff()} /></div>;
    }
    if (signsHere && handoff?.state && handoff.state !== "with_student" && handoff.state !== "submitted") {
      return <div className="py-4"><StudentHandoffNotice applicationId={applicationId} handoff={handoff} onChanged={() => void reloadHandoff()} /></div>;
    }
    if (submittedRef) {
      return (
        <div className="py-8 text-center" role="status" data-testid="wizard-submitted">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-background-50"><i className="ri-check-line text-3xl" aria-hidden="true" /></span>
          {role === "student" ? <>
            <h3 className="mt-4 font-heading text-lg font-semibold text-foreground-950">Thank you for submitting your application</h3>
            <p className="mt-1 text-sm text-foreground-600">Skyline will review it and update you. Your reference is {submittedRef}.</p>
          </> : <>
            <h3 className="mt-4 font-heading text-lg font-semibold text-foreground-950">Application submitted</h3>
            <p className="mt-1 text-sm text-foreground-600">Reference {submittedRef}. It is now with SLIT admissions for review.</p>
          </>}
          <button type="button" onClick={() => leaveOnce.current()} className={`${primaryClass} mt-5`}>{role === "student" ? "OK" : "Continue"}</button>
        </div>
      );
    }
    if (chooseView) return <DocumentModeChoice onBulk={() => chooseMode("bulk")} onSteps={() => chooseMode("steps")} />;
    if (bulkView) {
      return (
        <>
          {readSaveError ? <WizardNotice tone="error">{readSaveError}</WizardNotice> : null}
          <BulkDocumentUpload steps={bulkSteps} onUpload={bulkPick} onRemove={handleRemoveDoc} locked={savingResidency}
            classify={(file, person) => classifyDocument(applicationId, file, person)}
            person={answers.first_name?.trim() && answers.last_name?.trim() ? { firstName: answers.first_name, lastName: answers.last_name }
              : { firstName: studentFullName.split(" ")[0] ?? "", lastName: studentFullName.split(" ").length > 1 ? studentFullName.split(" ").slice(-1)[0] : "" }}
            onOneByOne={(at) => chooseMode("steps", at)}
            residency={hasPassport ? <ResidencyQuestions issuingCountry={passportCountry} answers={answers} errors={answerErrors} onChange={(name, value) => { setAnswer(name, value); setAnswerErrors((prev) => ({ ...prev, [name]: "" })); }} /> : null} />
        </>
      );
    }
    if (question) {
      const summary: FinishSummary = {
        name: [answers.first_name, answers.middle_name, answers.last_name].filter(Boolean).join(" "),
        course: answers.course ?? "",
        intake: answers.preferred_intake ?? "",
        documents: [...new Set(documents.filter((doc) => !dismissed.has(doc.id)).map((doc) => doc.category))],
      };
      return (
        <>
          <form ref={questionFormRef} noValidate onSubmit={(event) => { event.preventDefault(); void nextFromQuestion(); }}>
            {finishScreen ? (
              <WizardFinishSteps question={question} answers={answers} errors={answerErrors} onChange={setAnswer} onAddress={pickAddress} summary={summary} version={hydrated} passportCountry={passportCountry}
                studentRole={role === "student"} onEdit={(id) => { const at = WIZARD_QUESTIONS.findIndex((item) => item.id === id); if (at >= 0) void goTo(DOC_STEPS + at); }}
                onDeclarations={(ticked, complete) => { declarationsRef.current = { ticked, complete }; if (complete) setAnswerErrors((prev) => ({ ...prev, declaration_read: "" })); }}
                signExtras={signsHere ? <>
                  <DrawSignature onChange={(png) => { signatureRef.current = png; if (png) setAnswerErrors((prev) => ({ ...prev, declaration_read: "" })); }} />
                  <SignPasswordFields applicationId={applicationId} onChange={(value) => { signPasswordRef.current = value; }} />
                </> : null}
                extraActions={studentLocked ? <RequestChangeButton applicationId={applicationId} onDone={() => void reloadHandoff()} label="Something your agent set is wrong? Request a change" /> : null} />
            ) : (
              <WizardQuestionStep question={question} answers={answers} errors={answerErrors} courseOptions={courseLabels} courseIdOf={courseIdOf} onChange={setAnswer}
                onIntake={setIntake} onIntakesLoaded={intakesLoaded} intakeReload={intakeReload} applicationId={applicationId}
                defaultLoad={studyLoad || (kind === "international" ? "coe" : undefined)}
                onlyLoad={studyLoad || undefined} />
            )}
            {answerSaveError ? <div className="mt-4"><PortalError message={answerSaveError} /></div> : null}
          </form>
        </>
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
          allowAusStudy={alternatives.ausStudy} allowCambridge={alternatives.cambridge}
          onAusStudy={(value) => {
            setAusStudy(value);
            pendingWizard.current.studyChoice = value;
            if (value === "Yes") { setCambridge(""); pendingWizard.current.cambridgeChoice = ""; }
            markDirty();
            if (value === "No" && !alternatives.cambridge) setEnglishNotMet(true);
          }}
          onCambridge={chooseCambridge}
          onBack={() => {
            setEnglishAlt(false); setAusStudy(""); setCambridge(""); setEnglishSaveError("");
            Object.assign(pendingWizard.current, { englishChoice: "", studyChoice: "", cambridgeChoice: "" });
            markDirty();
          }}
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
        {readSaveError ? <WizardNotice tone="error">{readSaveError}</WizardNotice> : null}
        {current.id === "english" && englishSaveError ? <WizardNotice tone="error">{englishSaveError}</WizardNotice> : null}
        {current.id === "visa" && temporaryPrVisa ? <WizardNotice tone="error">Subclass {String(temporaryPrVisa.extracted?.visa_subclass ?? "")} on {temporaryPrVisa.filename} is not a permanent visa. Upload the PR visa grant notice, or go back and answer No to permanent resident.</WizardNotice> : null}
        {current.id === "visa" && visaNamesForReview.length > 0 ? <WizardNotice tone="error">Visa name review needed: {visaNamesForReview.map(item => `${item.filename}: ${item.name}`).join("; ")} differs from passport name {passportName}. Ask SLIT to verify before approval.</WizardNotice> : null}
        {current.id === "visa" && visaDocuments.some(doc => doc.extraction === "done" && visaExpiry(doc).expired) && ruleBool("admissions.visa_reject_expired", true) ? <WizardNotice tone="error">Expired visa evidence cannot satisfy the visa requirement. Upload valid evidence or request SLIT review.</WizardNotice> : null}
        {current.id === "visa" && ruleBool("admissions.visa_vevo_review", false) ? <WizardNotice tone="info">SLIT staff must verify visa status through VEVO. This upload has not been verified with VEVO automatically.</WizardNotice> : null}
        {current.id === "academic" && academicNameReviews.length > 0 ? <WizardNotice tone="error">Name review needed: the academic document name differs from the passport ({academicNameReviews.map(item => `${item.filename}: ${item.name}`).join("; ")}). Passport name: {passportName}. Please have SLIT verify the documents before approval.</WizardNotice> : null}
        <WizardDocumentStep
          step={shownStep(current)}
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
          onEditValue={(key, value) => void correctReadValue(key, value)}
          editedValue={(key) => (touchedRef.current.has(key) ? answers[key] : undefined)}
          logView={
            role === "slit_admin"
              ? (doc) => logAdminAccess(applicationId, "document_viewed", { documentId: doc.id, filename: doc.filename, category: doc.category })
              : undefined
          }
        />
        {current.id === "passport" && hasPassport ? (
          <ResidencyQuestions issuingCountry={passportCountry} answers={answers} errors={answerErrors} onChange={(name, value) => { setAnswer(name, value); setAnswerErrors((prev) => ({ ...prev, [name]: "" })); }} />
        ) : null}
        {current.id === "english" && AUS_STUDY_STEP && !hasFile && (alternatives.ausStudy || alternatives.cambridge) ? (
          <div className="mt-5 rounded-lg border border-dashed border-background-300 bg-background-100/60 px-4 py-3 text-sm text-foreground-700">
            No IELTS, PTE or TOEFL result?{" "}
            <button type="button" onClick={() => { setEnglishAlt(true); setEnglishSaveError(""); if (!alternatives.ausStudy) setAusStudy("No"); }} data-testid="english-no-test"
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
      title={"New application"}
      subtitle={confirmMode ? `Your agent has filled this in. Check every screen from the passport to the end and press Next to confirm it, then sign. ${agencyName}` : `Upload the documents, answer a few questions and submit. ${agencyName}`}
      onClose={() => void leaveDraft()}
      closeLabel="Save and close the wizard"
      stepper={
        <WizardStages stages={wizardStages} current={step} total={WIZARD_STEPS.length + WIZARD_QUESTIONS.length} stepTitle={allSteps[step]?.title ?? ""} onSelect={(index) => { void goTo(index); }} />
      }
      footerStart={
        <>
          <span role="status" className="text-xs text-foreground-600">
            {autoSave === "saving" ? "Saving…" : autoSave === "saved" ? "Saved" : ""}
          </span>
          {autoSave === "failed" ? <button type="button" onClick={() => void persist()} title={autoSaveError}
            className="text-xs font-semibold text-red-800 underline">Save failed. Retry</button> : null}
          <button
            type="button"
            onClick={() => void leaveDraft()}
            className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm font-medium text-foreground-500 transition-colors hover:text-foreground-800"
          >
            <i className="ri-close-line" aria-hidden="true" />
            Save and close
          </button>
          {step > 0 && ready && !submittedRef ? <WizardBackButton onClick={() => void goTo(step - 1)} disabled={finishing} /> : null}
        </>
      }
      footerEnd={
        chooseView ? null : bulkView ? (
          <button type="button" onClick={() => void continueFromBulk()} disabled={savingResidency || bulkBusy || bulkMissing.length > 0 || !hasPassport || !residencyDone}
            title={bulkMissing.length ? `Still needed: ${bulkMissing.map((entry) => entry.step.short).join(", ")}` : !residencyDone && hasPassport ? "Answer the residency question first" : undefined}
            className={primaryClass} data-testid="bulk-continue">
            {savingResidency ? <><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Saving&hellip;</> : <>Continue to the details <i className="ri-arrow-right-line" aria-hidden="true" /></>}
          </button>
        ) : ready && !submittedRef ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            {onDocStep && !hasFile && !blockedByPassport && !stepRequired(current) ? (
              <button
                type="button"
                onClick={() => void nextFromDocument()}
                className="inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-700 transition-colors hover:border-primary-300 hover:text-primary-700"
              >
                {current.skipLabel}
              </button>
            ) : null}
            {question && !isLast ? (
              <button type="button" onClick={() => void nextFromQuestion()} disabled={savingAnswers || avetmissPending} title={avetmissPending ? "Fix the answers marked in red first" : undefined} className={primaryClass}>
                {savingAnswers ? <><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Saving&hellip;</> : <>Next <i className="ri-arrow-right-line" aria-hidden="true" /></>}
              </button>
            ) : isLast ? (
              <>
                {finishing ? (
                  <button type="button" onClick={() => void complete()} className="cursor-pointer text-xs font-semibold text-primary-700 underline">
                    {signsHere ? "Submit now" : "Send now"}
                  </button>
                ) : null}
                <button type="button" onClick={() => void nextFromQuestion()} disabled={finishing || savingAnswers || avetmissPending} title={avetmissPending ? "Fix the answers marked in red first" : undefined} className={primaryClass}>
                  {finishing ? (
                    <>
                      <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
                      {signsHere ? "Signing" : "Sending"}&hellip;
                    </>
                  ) : (
                    <>
                      {signsHere ? "Sign and submit" : "Send to student to review & sign"}
                      <i className={signsHere ? "ri-quill-pen-line" : "ri-send-plane-line"} aria-hidden="true" />
                    </>
                  )}
                </button>
              </>
            ) : (
              current.id === "english" ? (
                <button type="button" onClick={() => void nextFromEnglish()}
                  disabled={locked || blockedByRequiredDocument || savingEnglish || pending.some((item) => !item.error)} className={primaryClass}>
                  {savingEnglish ? <><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Saving&hellip;</> : <>Next <i className="ri-arrow-right-line" aria-hidden="true" /></>}
                </button>
              ) : (
                <button type="button" onClick={() => void nextFromDocument()} disabled={locked || blockedByRequiredDocument || blockedByResidency || savingResidency || pending.some((item) => !item.error)} className={primaryClass}>
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
            <WizardNotice tone="info">A current passport is required. Upload it to continue.{checkAgain}</WizardNotice>
          ) : null}

          {onDocStep && stepRequired(current) && step !== PASSPORT_STEP && !hasFile && !locked && !(current.id === "english" && englishAlt) ? (
            <WizardNotice tone="info">{shownStep(current).title} is required. Upload it to continue.{checkAgain}</WizardNotice>
          ) : null}

          {onDocStep && blockedByResidency && !locked ? (
            <WizardNotice tone="info">Answer the residency question{isDomesticPassport(passportCountry) ? "" : "s"} below the passport to continue.</WizardNotice>
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

          {checkSummary.length ? (
            <div role="alert" className="mx-5 my-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 md:mx-6">
              <p className="font-semibold">Fix these before you go on:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {checkSummary.map((item, i) => {
                  const at = WIZARD_QUESTIONS.findIndex((q) => q.id === item.screen);
                  return <li key={i}>{item.label}{at >= 0 ? <> · <button type="button" className="font-semibold underline" onClick={() => { setCheckSummary([]); void goTo(DOC_STEPS + at); }}>{WIZARD_QUESTIONS[at].title}</button></> : null}</li>;
                })}
              </ul>
            </div>
          ) : null}

          {finishError ? (
            <div className="border-t border-background-200 px-5 py-3 md:px-6">
              <PortalError message={finishError} onRetry={() => setFinishing(true)} />
            </div>
          ) : null}

          {ready ? (
            <div className="border-t border-background-200 px-5 py-3 text-center md:px-6">
              <p className="text-2xs text-foreground-400">
                Everything is saved to this draft as you go. The application is submitted only when you press Submit
                application on the last screen.
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
      {replaceAsk ? (
        <ConfirmDialog title={`A ${replaceAsk.target.noun} is already uploaded. Replace it?`} confirmLabel={`Replace ${replaceAsk.target.noun}`}
          body={`${replaceAsk.current} is already on this application. The new file is read again and replaces it.`}
          onClose={() => setReplaceAsk(null)}
          onConfirm={() => { const ask = replaceAsk; setReplaceAsk(null); uploadPicked(ask.target, ask.files); }} />
      ) : null}
    </WizardShell>
  );
}
