import { hasValidatedDocumentPath } from "../../../../supabase/functions/_shared/document-category";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, useLayoutEffect } from "react";
import AddressSearch from "@/components/shared/wizard/AddressSearch";
import { openDeclarationKey } from "@/pages/agency/lib/wizardConfig";
import CourseSearchField from "@/pages/agency/components/CourseSearchField";
import { validateUsi } from "../../../../supabase/functions/_shared/validation/identifiers";
import type { AppField, AppSection } from "@/data/applicationForms";
import { ApplicationFieldControl } from "@/components/feature/applicationFieldKit";
import { isConditionMet, isFieldFilled, sectionHeading } from "@/components/feature/applicationFieldHelpers";
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
  getApplication,
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
import { EXPIRY_FIELDS, expiryLabel, expiryTone, expiryTooltip, getDocumentExpiryStatus, type ExpiryDocument } from "@/pages/agency/lib/documentExpiry";
import { logAdminAccess } from "@/pages/agency/lib/applicationPdf";
import { qualificationDetail, qualificationTitle, readQualifications } from "@/pages/agency/lib/qualifications";
import { canSubmitApplicationStatus } from "@/pages/agency/lib/applicationAccess";
import ApplicationReview, { type ConsentState } from "@/pages/agency/components/ApplicationReview";
import ApplicationAttachmentField from "@/pages/agency/components/ApplicationAttachmentField";
import SchoolLevelField from "@/pages/agency/components/SchoolLevelField";
import WorkspaceIntakeField from "@/pages/agency/components/WorkspaceIntakeField";
import { baseFieldClass } from "@/components/feature/applicationFieldHelpers";
import { DEGREE_LEVELS, schoolLevelFor } from "@/pages/agency/lib/educationLevels";
import { PortalError } from "@/pages/agency/components/PortalUI";
import StepShell, { FooterMessage } from "@/components/shared/application-form/StepShell";
import type { NavStep } from "@/components/shared/application-form/StepDrawer";
import SectionCard from "@/components/shared/application-form/SectionCard";
import Field, { FieldMessage, FORM_LABEL } from "@/components/shared/application-form/Field";
import InfoTip from "@/components/shared/application-form/InfoTip";
import SegmentedControl from "@/components/shared/application-form/SegmentedControl";
import Toast from "@/components/shared/application-form/Toast";
import { useToast } from "@/components/shared/application-form/useToast";
import { stepTitle } from "@/components/shared/application-form/stepTitle";

const FORM_ID = "portal-application-form";
const STUDENT_CONTACT_FIELDS = new Set(["mobile", "email", "confirm_email", "email_note"]);
const AUSTRALIAN_ADDRESS: Record<string, string> = { address_type: "Australian Address", au_country: "Australia" };
// Answers the portal fixes (greyed out, not editable): an Australian address, and a USI is always required.
const FIXED_VALUES: Record<string, string> = { ...AUSTRALIAN_ADDRESS, has_usi: "Yes" };
const USI_CONSENT_TEXT = "I consent to SLIT using/providing my USI for enrolment, reporting and verification purposes where required.";
const AU_ADDRESS_FIELDS = ["au_street", "au_line2", "au_suburb", "au_state", "au_zip"] as const;
const LICENCE_CATEGORY = "Driving Licence";
const ADDRESS_SOURCES = ["search", "licence", "manual"];
const VISA_CATEGORY = "Visa";
const VISA_DETAIL_FIELDS = ["visa_subclass", "visa_grant_date", "visa_stay_until", "visa_grant_number"] as const;
const VISA_UPLOAD_FIELD: AppField = { name: "visa_upload", label: "Visa grant notice or VEVO record", type: "file" };
const ENGLISH_CATEGORY = "English Test";
// Student identifier answers that start with a default when empty (shown pre-filled, green, with Edit).
const IDENTIFIER_DEFAULTS: Record<string, string> = {
  atsi: "No",
  disability: "No",
  employment: "Unemployed - Seeking Part-Time Work - 07",
  language_home: "Yes, language other than English",
};
// Later-page answers that start with a default when empty (plain, editable).
const FORM_DEFAULTS: Record<string, string | string[]> = {
  study_reason: "For personal interest or self-development - 09",
  rpl: "No",
  oshc_require: "No",
  oshc_self_confirm: ["I understand I must arrange and maintain my own Overseas Student Health Cover for the full duration of my student visa and provide proof when requested."],
  hear_about: "Agent",
};
const PREFILL_LOCK_FIELDS = ["atsi", "employment", "language_home", "disability", "usi_consent"];
const EDUCATION_FIELDS = ["secondary_enrolled", "highest_education", "school_level", "prior_ed"] as const;

/**
 * A hidden answer the page sets itself (visa answer, address source). Its saved value is written once: given as
 * defaultValue, React puts it back on every re-render (a hidden input's value is its default value), undoing what the
 * page set and leaving required answers blank.
 */
function KeptValue({ name, value }: { name: string; value: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const saved = useRef(value);
  useLayoutEffect(() => { if (ref.current) ref.current.value = saved.current; }, []);
  return <input ref={ref} type="hidden" name={name} />;
}

/** Highest university level a qualification shows (PhD, Master's, Bachelor's); "" when it shows none. */
function degreeOf(text: string): string {
  const t = ` ${text.toLowerCase()} `;
  if (/(\bph\.?\s?d\b|doctor)/.test(t)) return "Doctorate (PhD)";
  if (/(master|\bmba\b|\bm\.\s?(e|tech|sc|com|a|phil)\b|\bm(tech|sc|com|phil)\b)/.test(t)) return "Master's degree";
  if (/(bachelor|degree|engineering|university|\bb\.\s?(e|tech|sc|com|a|ba|ca|pharm|arch)\b|\bb(tech|sc|com|ba|ca|pharm|arch)\b)/.test(t)) return "Bachelor's degree";
  return "";
}

/** Best reading of the highest school level a qualification shows; "" when it says nothing about school. */
function schoolLevelOf(text: string): string {
  const t = ` ${text.toLowerCase()} `;
  // Any university degree (bachelor's, master's, doctorate) means school was completed to Year 12.
  if (/(bachelor|degree|diploma|master|graduate|university|engineering|\bb\.?\s?(e|tech|sc|com|a|ba|ca|pharm|arch)\b|\bm\.?\s?(e|tech|sc|com|a|ba|ca|phil)\b|\bph\.?\s?d\b|doctor|year\s*12|\bxii\b|\b12th\b|higher secondary|senior secondary|\bhsc\b|intermediate|a[ -]level|class 12|grade 12)/.test(t)) return "Year 12 or equivalent - 12";
  if (/(year\s*11|\bxi\b|\b11th\b|class 11|grade 11)/.test(t)) return "Year 11 or equivalent - 11";
  if (/(year\s*10|\bx\b|\b10th\b|\bssc\b|secondary school certificate|matric|o[ -]level|class 10|grade 10)/.test(t)) return "Year 10 or equivalent - 10";
  return "";
}
const SCHOOL_RANK = ["Year 10 or equivalent - 10", "Year 11 or equivalent - 11", "Year 12 or equivalent - 12"];
const ACADEMIC_CATEGORY = "Academic";
const ACADEMIC_RECORD_FIELDS = ["academic_institution", "academic_qualification", "academic_year"] as const;
const ACADEMIC_FIELDS: readonly string[] = [...EDUCATION_FIELDS, ...ACADEMIC_RECORD_FIELDS];
const ENGLISH_DETAIL_FIELDS = ["english_type", "english_score", "english_date"] as const;
/**
 * The document each page reads, found by a field only that page has. A finished read that failed, was classified as a
 * different kind of document, or found none of the key answers means the wrong file was uploaded; the page cannot be
 * left forward (or the application submitted) until it is deleted, and not while a file is still being read.
 */
const PAGE_DOCUMENTS: ReadonlyArray<{ marker: string; category: string; noun: string; keys: readonly string[] }> = [
  { marker: "visa_subclass", category: VISA_CATEGORY, noun: "an Australian visa grant notice or VEVO record", keys: ["visa_subclass", "visa_grant_number"] },
  { marker: "english_type", category: ENGLISH_CATEGORY, noun: "an English test result (IELTS, PTE, TOEFL or Cambridge)", keys: ["english_type", "english_score"] },
  { marker: "academic_upload", category: ACADEMIC_CATEGORY, noun: "an academic transcript, certificate or degree", keys: [] },
];
const ENGLISH_UPLOAD_FIELD: AppField = { name: "english_results", label: "English test result", type: "file" };
const LICENCE_FIELD: AppField = { name: "licence_copy", label: "Driving licence", type: "file" };

/** What the toast calls a document of each category ("We filled 9 fields from your passport"). */
const DOCUMENT_NOUN: Record<string, string> = { Passport: "passport", Visa: "visa document", "English Test": "English test result", "Driving Licence": "driving licence", Academic: "academic documents" };
/**
 * Shows the fields a document (or an address pick) just filled one after another (40ms apart). Presentation only: the values
 * are already in the form; this adds a short animation to their wrappers. Nothing moves with reduced motion (CSS).
 */
function revealFields(form: HTMLFormElement | null, names: readonly string[]) {
  if (!form) return;
  let order = 0;
  for (const name of names) {
    const wrapper = form.querySelector<HTMLElement>(`[data-field="${CSS.escape(name)}"]`);
    if (!wrapper || wrapper.hidden) continue;
    wrapper.classList.remove("field-filled");
    void wrapper.offsetWidth; // restart the animation
    wrapper.style.animationDelay = `${order * 40}ms`;
    wrapper.classList.add("field-filled");
    order += 1;
  }
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
// A step description up to this length is shown as its one subtitle line; a longer one goes into the title's (i).
const SUBTITLE_MAX = 90;
/** "PLEASE NOTIFY SKYLINE OF ANY CHANGES." as a sentence ("Please notify Skyline of any changes."); other text unchanged. */
function sentenceCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  const lower = text.toLowerCase().replace(/\b(slit|usi|oshc|rpl|skyline institute of technology)\b/g, (word) => (word.startsWith("skyline") ? "Skyline Institute of Technology" : word.toUpperCase()));
  return lower.replace(/(^|[.!?]\s+)([a-z])/g, (_, start: string, letter: string) => start + letter.toUpperCase());
}
const DEBOUNCE_MS = 1200;
const DECLARATION_VERSION = "1.0";

interface WorkspaceProps {
  application: ApplicationDetail;
  agentName: string;
  agentEmail: string;
  agentPhone: string;
  agencyName: string;
  readOnly: boolean;
  /** Administrators: opening a document is written to the audit log. */
  auditAccess?: boolean;
  onSaved?: () => void;
  /** Called once the application is submitted (e.g. to go back to the list). */
  onSubmitted?: (reference: string, studentName: string) => void;
}

type SaveState = "idle" | "saving" | "saved" | "error";


export default function ApplicationWorkspace({
  application,
  agentName,
  agentEmail,
  agentPhone,
  agencyName,
  readOnly,
  auditAccess = false,
  onSaved,
  onSubmitted,
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

  // Fields the document wizard filled in; the badge goes away once the agent edits one.
  const recordedDocumentFields = useMemo(() => {
    const provenance = ((application.data ?? {}) as { fieldProvenance?: Record<string, { kind?: string; documentId?: string }> }).fieldProvenance ?? {};
    return new Map(Object.entries(provenance).filter(([name, entry]) => entry?.kind === "ai_unverified" && String(storedValues[name] ?? "").trim() !== "").map(([name, entry]) => [name, entry.documentId ?? ""]));
  }, [application.data, storedValues]);
  const [editedFields, setEditedFields] = useState<Set<string>>(() => new Set());
  // Values read from a document start greyed out and read-only, so they are clearly told apart from what still needs
  // filling in; Edit opens one for changes. Empty fields are never locked.
  const [unlockedFields, setUnlockedFields] = useState<Set<string>>(() => new Set());
  const unlockedFieldsRef = useRef(unlockedFields);
  useEffect(() => { unlockedFieldsRef.current = unlockedFields; }, [unlockedFields]);
  // Education answers worked out from the academic documents: shown as "From document", green, with Edit.
  const [derivedFields, setDerivedFields] = useState<Set<string>>(() => new Set());
  // Applications started with the contact step already hold the student's unique email and mobile.
  const [contactFixed] = useState(() => Boolean(String(storedValues.email ?? "").trim() && String(storedValues.mobile ?? "").trim()));
  // Current dates behind the expiry warnings, kept live as the form is edited.
  const [expiryDates, setExpiryDates] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.values(EXPIRY_FIELDS).map((name) => [name, String(storedValues[name] ?? "")])),
  );
  const expiryFieldType = useMemo(() => new Map(Object.entries(EXPIRY_FIELDS).map(([type, name]) => [name, type as ExpiryDocument])), []);

  // A saved value always wins; a seed only fills a field that is empty.
  const mergedInitial = useMemo<DraftValues>(() => {
    const out: DraftValues = { ...storedValues };
    for (const [name, value] of Object.entries(seed)) if (!String(out[name] ?? "").trim()) out[name] = value;
    // The student's address is always an Australian one (fixed and greyed out on the form).
    Object.assign(out, FIXED_VALUES);
    if (!Array.isArray(out.usi_consent) || !out.usi_consent.length) out.usi_consent = [USI_CONSENT_TEXT];
    for (const [name, value] of Object.entries(IDENTIFIER_DEFAULTS)) if (!String(out[name] ?? "").trim()) out[name] = value;
    for (const [name, value] of Object.entries(FORM_DEFAULTS)) if (!String(out[name] ?? "").trim()) out[name] = value;
    out.checklist = sections.flatMap((section) => section.fields).find((field) => field.name === "checklist")?.options ?? [];
    return out;
  }, [seed, storedValues, sections]);
  // Student identifier answers already filled (or defaulted) when the form opens: green, with Edit.
  const [prefilledFields] = useState<Set<string>>(() => new Set(PREFILL_LOCK_FIELDS.filter((name) => String(mergedInitial[name] ?? "").trim())));

  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    Object.entries(mergedInitial).forEach(([key, val]) => {
      if (typeof val === "string") out[key] = val;
    });
    return out;
  });

  // Straight after the document wizard the form opens on its Student declaration page.
  const [step, setStep] = useState(() => {
    try {
      if (!readOnly && window.sessionStorage.getItem(openDeclarationKey(application.id))) {
        const declaration = sections.findIndex((section) => section.fields.some((field) => field.name === "declaration"));
        if (declaration >= 0) return declaration;
      }
    } catch { /* session storage unavailable */ }
    return 0;
  });
  useEffect(() => {
    try { window.sessionStorage.removeItem(openDeclarationKey(application.id)); } catch { /* session storage unavailable */ }
  }, [application.id]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ overall: number; sections: Array<{ done: number; total: number }> }>({
    overall: 0,
    sections: sections.map(() => ({ done: 0, total: 0 })),
  });
  const [showErrors, setShowErrors] = useState(false);
  // The page whose Next was refused: its missing answers are marked even before a submit attempt.
  const [errorStep, setErrorStep] = useState<number | null>(null);
  const [reviewValues, setReviewValues] = useState<DraftValues | null>(null);
  const [consent, setConsent] = useState<ConsentState>({
    method: "electronic",
    confirmed: false,
    authorised: false,
    fileName: "",
    file: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submittedRef, setSubmittedRef] = useState<string | null>(null);
  const submittedDoneRef = useRef<(() => void) | null>(null);
  const [documentMessage, setDocumentMessage] = useState("");
  const [attachments, setAttachments] = useState<DocumentRow[]>([]);
  const [attachmentsLoaded, setAttachmentsLoaded] = useState(false);
  // A field only counts as "from document" while that document is still attached; once it is deleted the value
  // stays but becomes an ordinary, editable field.
  const documentFields = useMemo(() => {
    if (!attachmentsLoaded) return recordedDocumentFields;
    const attached = new Set(attachments.map((document) => document.id));
    return new Map([...recordedDocumentFields].filter(([, documentId]) => !documentId || attached.has(documentId)));
  }, [recordedDocumentFields, attachments, attachmentsLoaded]);
  const [documentBusy, setDocumentBusy] = useState("");
  const [qualifications, setQualifications] = useState(() => readQualifications(application.data));

  const formRef = useRef<HTMLFormElement>(null);
  // Presentation: which way the step card slides in, the "We filled N fields" toast, and what the last server sync filled in.
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const toast = useToast();
  const showToast = toast.show;
  const serverFillsRef = useRef<string[]>([]);
  const readingStatesRef = useRef(new Map<string, string>());
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

  /**
   * Reading or removing a document changes the application on the server, which raises its draft version; saving with
   * the old version is then refused. This takes the current version and copies in any value the server filled that is
   * still empty here, so the next save neither fails nor blanks it.
   */
  const syncWithServer = useCallback(async () => {
    const detail = await getApplication(application.id, true);
    const form = formRef.current;
    if (!detail || !form) return detail;
    const serverValues = ((detail.data ?? {}) as { values?: DraftValues }).values ?? {};
    const fills: DraftValues = {};
    for (const [name, value] of Object.entries(serverValues)) {
      if (typeof value !== "string" || !value.trim()) continue;
      const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${CSS.escape(name)}"]`));
      if (!controls.length) continue;
      const filled = controls.some((control) => (control instanceof HTMLInputElement && (control.type === "radio" || control.type === "checkbox") ? control.checked : control.value.trim() !== ""));
      if (!filled) fills[name] = value;
    }
    if (Object.keys(fills).length) applyFormValues(form, fills);
    serverFillsRef.current = Object.keys(fills);
    return detail;
  }, [application.id]);

  const refreshAttachments = useCallback(async () => {
    const [rows, detail] = await Promise.all([listApplicationDocuments(application.id), syncWithServer()]);
    setAttachments(rows.filter((document) => document.isCurrent));
    // A document whose reading just finished, and the empty fields the server filled from it: show them and say so.
    const finished = rows.filter((document) => {
      const before = readingStatesRef.current.get(document.id);
      return (before === "queued" || before === "processing") && !["queued", "processing"].includes(extractionStatus(document.metadata));
    });
    readingStatesRef.current = new Map(rows.map((document) => [document.id, extractionStatus(document.metadata)]));
    const filledNow = serverFillsRef.current;
    serverFillsRef.current = [];
    if (finished.length && filledNow.length) {
      window.requestAnimationFrame(() => revealFields(formRef.current, filledNow));
      showToast(`We filled ${plural(filledNow.length, "field")} from your ${DOCUMENT_NOUN[finished[0].category] ?? "document"}. Please review.`);
    }
    setAttachmentsLoaded(true);
    if (detail) setQualifications(readQualifications(detail.data));
  }, [application.id, syncWithServer, showToast]);

  useEffect(() => {
    void refreshAttachments().catch((error) => setDocumentMessage(error instanceof Error ? error.message : "We could not load saved documents."));
  }, [refreshAttachments]);

  useEffect(() => {
    if (!attachments.some((document) => ["queued", "processing"].includes(extractionStatus(document.metadata)))) return undefined;
    const interval = window.setInterval(() => { void refreshAttachments().catch(() => undefined); }, 5000);
    return () => window.clearInterval(interval);
  }, [attachments, refreshAttachments]);

  /* --------------------------------------------------------- progress */

  /** Filled, in a valid format, and (for the address) actually found by search or licence. */
  const answered = (form: HTMLFormElement, field: AppField): boolean => {
    if (!addressShownRef.current && (AU_ADDRESS_FIELDS as readonly string[]).includes(field.name)) return false;
    if (!isFieldFilled(form, field)) return false;
    const control = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${field.name}"]`);
    return !control || control.checkValidity();
  };

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
        if (category ? attachments.some((document) => document.category === category) : answered(form, field)) done += 1;
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
    // The submission still requires "Is the emergency contact in Australia?", which the page no longer asks:
    // it is answered from the contact's phone number (an Australian +61 number means Yes).
    const ecPhone = String(collected.ec_phone ?? "").replace(/\s/g, "");
    if (ecPhone) collected.ec_in_au = ecPhone.startsWith("+61") || /^0[1-9]\d{8}$/.test(ecPhone) ? "Yes" : "No";
    if (String(collected.academic_year ?? "").trim()) collected.year_completed = String(collected.academic_year);
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
      const save = () => saveApplicationDraft(application.id, {
        data: {
          // INT-01: the intake goes with the course row (the server checks it belongs to the course and writes its label).
          values: Object.fromEntries(Object.entries(snapshot.values).filter(([key]) => key !== "intake_id")),
          courses: snapshot.courses.map(resolveCourse).map((course, index) => index === 0 && String(snapshot.values.intake_id ?? "") ? { ...course, intakeId: String(snapshot.values.intake_id) } : course),
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
      try {
        await save();
      } catch (error) {
        // The server copy moved on (usually a document was read); catch up once and save again.
        if (!(error instanceof Error) || !/another session changed this application/i.test(error.message)) throw error;
        await syncWithServer();
        await save();
      }

      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      onSaved?.();
    } catch (error) {
      dirtyRef.current = true;
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : "We could not save your draft.");
      throw error;
    }
  }, [application.id, collectSnapshot, agentName, onSaved, resolveCourse, syncWithServer]);

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
    if (target?.name && expiryFieldType.has(target.name)) setExpiryDates((prev) => ({ ...prev, [target.name]: target.value }));
    if (target?.name && event.nativeEvent.isTrusted && documentFields.has(target.name)) {
      setEditedFields((prev) => (prev.has(target.name) ? prev : new Set(prev).add(target.name)));
    }
    // Fields are edited in place (there is no Edit button any more): a hand edit of a value filled from a document, worked out
    // from one, or pre-filled unlocks it exactly as Edit did, so nothing read later replaces it.
    const editedName = target?.name?.replace(/\[\]$/, "") ?? "";
    if (editedName && event.nativeEvent.isTrusted && !(editedName in FIXED_VALUES)
      && (documentFields.has(editedName) || derivedFields.has(editedName) || prefilledFields.has(editedName))) {
      setUnlockedFields((prev) => (prev.has(editedName) ? prev : new Set(prev).add(editedName)));
    }
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
    const tab = window.open("", "_blank"); // opened first, while the click still counts as a user action
    try {
      if (auditAccess) await logAdminAccess(application.id, "document_viewed", { documentId: document.id, filename: document.filename, category: document.category });
      const url = await getDocumentSignedUrl(document.storagePath);
      if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
    } catch (error) {
      tab?.close();
      throw error;
    } finally { setDocumentBusy(""); }
  }, [auditAccess, application.id]);

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

  /* ------------------------------------------------ Australian address */

  const [licenceNote, setLicenceNote] = useState("");
  const [addressMode, setAddressMode] = useState<"search" | "licence" | "manual">(() => (String(storedValues.address_source ?? "") === "manual" ? "manual" : "search"));
  // The address fields stay hidden until a search pick or a licence fills them (or an address is already saved).
  // An address only counts once it came from a search pick or a licence (or the manual fallback); the saved
  // address_source records which, so an address typed in before this step existed has to be found again.
  // A licence read in the document wizard counts too: its address fields carry document provenance and are shown
  // filled (green, with Edit) straight away.
  const addressFromWizardLicence = AU_ADDRESS_FIELDS.some((name) => documentFields.has(name));
  const [addressShown, setAddressShown] = useState(() => ADDRESS_SOURCES.includes(String(storedValues.address_source ?? "")) || addressFromWizardLicence || String(storedValues.au_street ?? "").trim() !== "");
  const addressShownRef = useRef(addressShown);
  useEffect(() => { addressShownRef.current = addressShown; }, [addressShown]);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const [licenceUnreadable, setLicenceUnreadable] = useState(false);
  const appliedLicencesRef = useRef<Set<string>>(new Set());
  const watchLicencesRef = useRef(false);

  /**
   * Writes Australian address values into the form. A search pick replaces the address; a licence only fills fields that
   * are still empty. Written fields lose any document lock so they show as ordinary, editable values.
   */
  const fillAustralianAddress = useCallback((picked: Record<string, string>, replace: boolean, source: "search" | "licence"): number => {
    const form = formRef.current;
    if (!form) return 0;
    const updates: Record<string, string> = {};
    // Until an address has been found here, whatever the hidden fields hold (an older typed address) is replaced.
    const overwrite = replace || !addressShownRef.current;
    for (const name of AU_ADDRESS_FIELDS) {
      const value = String(picked[name] ?? "").trim();
      const control = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (!control || (!value && !overwrite) || (!overwrite && control.value.trim())) continue;
      updates[name] = value;
    }
    const names = Object.keys(updates);
    if (!names.length) return 0;
    setAddressShown(true);
    setUnlockedFields((prev) => new Set([...prev, ...names]));
    setEditedFields((prev) => new Set([...prev, ...names]));
    applyFormValues(form, { ...updates, ...AUSTRALIAN_ADDRESS, address_source: source });
    window.requestAnimationFrame(() => revealFields(formRef.current, names));
    window.requestAnimationFrame(() => computeProgress());
    scheduleSave(true);
    return names.length;
  }, [computeProgress, scheduleSave]);

  const uploadLicence = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setDocumentBusy("upload");
    setLicenceNote("Uploading the licence…");
    try {
      for (const file of Array.from(files)) {
        await uploadApplicationDocument({ applicationId: application.id, category: LICENCE_CATEGORY, file, metadata: { kind: "licence" } });
      }
      watchLicencesRef.current = true;
      await refreshAttachments();
      onSaved?.();
      setLicenceNote("Reading the address from the licence…");
    } catch (error) {
      setLicenceNote(error instanceof Error ? error.message : "The licence could not be uploaded.");
    } finally { setDocumentBusy(""); }
  }, [application.id, onSaved, refreshAttachments]);

  // While a licence uploaded here is being read, check every few seconds; once it is read, copy its Australian address in.
  const licences = useMemo(() => attachments.filter((document) => document.category === LICENCE_CATEGORY), [attachments]);
  // A licence (from the wizard or uploaded here) whose address is overseas cannot fill this Australian-only address.
  const overseasLicence = useMemo(() => licences.find((document) => {
    const extracted = (document.metadata.extraction as { extracted?: Record<string, string> } | undefined)?.extracted ?? {};
    return extracted.address_type === "Overseas Address" || (!extracted.au_street && Boolean(extracted.ov_street));
  }), [licences]);
  const licenceReading = licences.some((document) => ["queued", "processing"].includes(extractionStatus(document.metadata)));
  useEffect(() => {
    if (!watchLicencesRef.current || !licenceReading) return undefined;
    const timer = window.setInterval(() => { void refreshAttachments().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [licenceReading, refreshAttachments]);
  useEffect(() => {
    if (!watchLicencesRef.current) return;
    for (const document of licences) {
      const status = extractionStatus(document.metadata);
      if (appliedLicencesRef.current.has(document.id) || ["queued", "processing", "Not requested"].includes(status)) continue;
      appliedLicencesRef.current.add(document.id);
      const extracted = ((document.metadata.extraction as { extracted?: Record<string, string> } | undefined)?.extracted) ?? {};
      if (status === "failed") { setLicenceUnreadable(true); setLicenceNote("The licence could not be read. Search for the address instead."); continue; }
      if (extracted.address_type === "Overseas Address" || (!extracted.au_street && extracted.ov_street)) {
        setLicenceUnreadable(true);
        setLicenceNote("The licence shows an overseas address. Only an Australian address can be used here; search for it instead.");
        continue;
      }
      const filled = fillAustralianAddress(extracted, false, "licence");
      if (filled) showToast(`We filled ${plural(filled, "address field")} from your driving licence. Please review.`);
      if (!filled) setLicenceUnreadable(true);
      setLicenceNote(filled ? `Filled ${filled} address field${filled === 1 ? "" : "s"} from ${document.filename}. Check them before continuing.` : `No new address details were found on ${document.filename}; fields already filled were left as they were.`);
    }
  }, [licences, fillAustralianAddress, showToast]);

  /* ------------------------------------------------------------- visa */

  // A visa already read from a document answers the visa question: its fields show filled (green, with Edit).
  const visaFromDocument = VISA_DETAIL_FIELDS.some((name) => documentFields.has(name));
  const [visaMode, setVisaMode] = useState<"" | "upload" | "manual" | "none">(() => {
    const holds = String(storedValues.holds_visa ?? "");
    if (visaFromDocument) return "upload";
    if (holds === "No") return "none";
    return holds === "Yes" && VISA_DETAIL_FIELDS.some((name) => String(storedValues[name] ?? "").trim()) ? "manual" : "";
  });
  const [visaRead, setVisaRead] = useState(visaFromDocument);
  const [visaNote, setVisaNote] = useState("");
  const watchVisasRef = useRef(false);
  const checkedVisasRef = useRef<Set<string>>(new Set());
  const visaShown = visaMode === "manual" || (visaMode === "upload" && visaRead);
  const visas = useMemo(() => attachments.filter((document) => document.category === VISA_CATEGORY), [attachments]);

  /** Sets the (hidden) visa answer; it also decides whether the visa fields exist in the form at all. */
  const setHoldsVisa = useCallback((answer: "" | "Yes" | "No") => {
    setValues((prev) => ({ ...prev, holds_visa: answer }));
    if (formRef.current) applyFormValues(formRef.current, { holds_visa: answer });
    scheduleSave(true);
  }, [scheduleSave]);

  const chooseVisaMode = (mode: "upload" | "manual" | "none") => {
    setVisaMode(mode);
    setVisaNote("");
    setHoldsVisa(mode === "none" ? "No" : mode === "manual" || visaRead ? "Yes" : "");
  };

  const uploadVisa = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setDocumentBusy("upload");
    setVisaNote("Uploading the visa document…");
    try {
      for (const file of Array.from(files)) {
        await uploadApplicationDocument({ applicationId: application.id, category: VISA_CATEGORY, file, metadata: { kind: "visa" } });
      }
      watchVisasRef.current = true;
      await refreshAttachments();
      onSaved?.();
      setVisaNote("Reading the visa details…");
    } catch (error) {
      setVisaNote(error instanceof Error ? error.message : "The visa document could not be uploaded.");
    } finally { setDocumentBusy(""); }
  }, [application.id, onSaved, refreshAttachments]);

  // While a visa uploaded here is being read, check every few seconds; then fill all four fields, or reject the document.
  const visaReading = visas.some((document) => ["queued", "processing"].includes(extractionStatus(document.metadata)));
  useEffect(() => {
    if (!watchVisasRef.current || !visaReading) return undefined;
    const timer = window.setInterval(() => { void refreshAttachments().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [visaReading, refreshAttachments]);
  useEffect(() => {
    if (!watchVisasRef.current) return;
    for (const document of visas) {
      const status = extractionStatus(document.metadata);
      if (checkedVisasRef.current.has(document.id) || ["queued", "processing", "Not requested"].includes(status)) continue;
      checkedVisasRef.current.add(document.id);
      const extraction = document.metadata.extraction as { extracted?: Record<string, string>; source?: { categoryMismatch?: boolean } } | undefined;
      const extracted = extraction?.extracted ?? {};
      const usable = status !== "failed" && !extraction?.source?.categoryMismatch && Boolean(extracted.visa_subclass || extracted.visa_grant_number);
      if (!usable) {
        if (hasValidatedDocumentPath(document.storagePath)) {
          setVisaMode("manual");
          setVisaNote("The visa document was saved. Enter any visa details that could not be read.");
          continue;
        }
        // Not an Australian visa grant notice or VEVO record that can be read: remove it and offer the choice again.
        void deleteApplicationDocument({ id: document.id, storagePath: document.storagePath })
          .catch(() => undefined)
          .then(() => refreshAttachments().catch(() => undefined));
        // A rejected replacement leaves an earlier, readable visa document and its details in place.
        if (!visas.some((other) => other.id !== document.id)) {
          setVisaRead(false);
          setHoldsVisa("");
        }
        setVisaNote(`${document.filename} was rejected: it could not be read as an Australian visa grant notice or VEVO record. Upload the correct document, or enter the visa details manually.`);
        continue;
      }
      const form = formRef.current;
      const updates = Object.fromEntries(VISA_DETAIL_FIELDS.map((name) => [name, String(extracted[name] ?? "").trim()]));
      setVisaRead(true);
      setHoldsVisa("Yes");
      setUnlockedFields((prev) => new Set([...prev, ...VISA_DETAIL_FIELDS]));
      if (form) applyFormValues(form, updates); // retried shortly if the fields are still being added
      const filled = Object.values(updates).filter(Boolean).length;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => revealFields(formRef.current, Object.keys(updates).filter((name) => updates[name]))));
      if (filled) showToast(`We filled ${plural(filled, "field")} from your visa document. Please review.`);
      setVisaNote(`Filled ${filled} visa field${filled === 1 ? "" : "s"} from ${document.filename}. Check them before continuing.`);
    }
  }, [visas, refreshAttachments, setHoldsVisa, showToast]);

  useEffect(() => {
    if (!attachmentsLoaded || visaMode !== "upload" || !visaRead || visas.length > 0) return;
    setVisaMode("manual");
    setVisaRead(false);
    setVisaNote("The visa document these details were read from is no longer attached. Check the details below, or upload the visa document again.");
  }, [attachmentsLoaded, visaMode, visaRead, visas.length]);

  // The visa choice is the page's required answer: a visa read from a document or entered by hand answers "Yes",
  // "No visa" answers "No". A draft whose details came from a document before this answer was kept would otherwise
  // show every visa field filled and still say required fields are missing.
  useEffect(() => {
    if (readOnly) return;
    const answer = visaShown ? "Yes" : visaMode === "none" ? "No" : "";
    if (!answer) return;
    const kept = formRef.current?.querySelector<HTMLInputElement>('input[name="holds_visa"]')?.value ?? "";
    if (values.holds_visa !== answer || kept !== answer) setHoldsVisa(answer);
  }, [readOnly, visaShown, visaMode, values.holds_visa, setHoldsVisa]);

  /* ------------------------------------------------- education answers */

  useEffect(() => {
    const form = formRef.current;
    if (!form || !attachmentsLoaded || readOnly) return;
    const attached = new Set(attachments.map((document) => document.id));
    const fromDocuments = qualifications.filter((item) => item.documentIds.some((id) => attached.has(id)));
    if (!fromDocuments.length) return;
    let level = "";
    let degree = "";
    for (const item of fromDocuments) {
      const text = `${item.qualification} ${item.program}`;
      const found = schoolLevelOf(text);
      if (found && SCHOOL_RANK.indexOf(found) >= SCHOOL_RANK.indexOf(level)) level = found;
      const foundDegree = degreeOf(text);
      // DEGREE_LEVELS runs highest first.
      if (foundDegree && (!degree || DEGREE_LEVELS.indexOf(foundDegree) < DEGREE_LEVELS.indexOf(degree))) degree = foundDegree;
    }
    const answers: Record<string, string> = { prior_ed: "Yes", secondary_enrolled: "No", school_level: level || (degree ? schoolLevelFor(degree) : ""), highest_education: degree || level };
    const updates: Record<string, string> = {};
    for (const name of EDUCATION_FIELDS) {
      const value = answers[name];
      if (!value) continue;
      const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`));
      let current = controls.some((control) => (control instanceof HTMLInputElement && control.type === "radio" ? control.checked : control.value.trim() !== ""));
      // A degree read from the documents replaces a plain school level shown before degrees could be chosen.
      if (name === "highest_education" && degree && !controls.some((control) => DEGREE_LEVELS.includes(control.value)) && !unlockedFieldsRef.current.has("school_level")) current = false;
      if (!current) updates[name] = value;
    }
    const names = Object.keys(updates);
    if (!names.length) return;
    applyFormValues(form, updates);
    // The dropdown shown is the school-level field, so it carries the "From document" mark.
    setDerivedFields((prev) => new Set([...prev, ...names, ...(names.includes("highest_education") ? ["school_level"] : [])]));
    window.requestAnimationFrame(() => computeProgress());
    scheduleSave(true);
  }, [attachments, attachmentsLoaded, qualifications, readOnly, computeProgress, scheduleSave]);

  /* ------------------------------------------ passport-derived answers */

  // Title follows the passport gender (Male: Mr, Female: Miss) and country of birth follows citizenship. Each is only
  // filled when empty or still holding the value worked out earlier, and is shown green with Edit.
  useEffect(() => {
    const form = formRef.current;
    if (!form || readOnly) return;
    const wanted: Record<string, string> = {
      title: values.gender === "Male" ? "Mr" : values.gender === "Female" ? "Miss" : "",
      birth_country: String(values.citizenship ?? "").trim(),
    };
    const updates: Record<string, string> = {};
    for (const [name, value] of Object.entries(wanted)) {
      if (!value || unlockedFieldsRef.current.has(name)) continue;
      const control = form.querySelector<HTMLSelectElement>(`[name="${name}"]`);
      if (!control || !Array.from(control.options).some((option) => option.value === value)) continue;
      const current = control.value.trim();
      if (current === value) continue;
      if (current && !derivedFieldsRef.current.has(name)) continue;
      updates[name] = value;
    }
    const names = Object.keys(updates);
    if (!names.length) return;
    applyFormValues(form, updates);
    setDerivedFields((prev) => new Set([...prev, ...names]));
    window.requestAnimationFrame(() => computeProgress());
    scheduleSave(true);
  }, [values.gender, values.citizenship, readOnly, computeProgress, scheduleSave]);

  /* -------------------------------------------------- academic choice */

  const academicDocuments = useMemo(() => attachments.filter((document) => document.category === ACADEMIC_CATEGORY), [attachments]);
  const academicReading = academicDocuments.some((document) => ["queued", "processing"].includes(extractionStatus(document.metadata)));
  // Nothing on the Academic page shows until the agent chooses: documents (read into the answers) or manual entry.
  const [academicMode, setAcademicMode] = useState<"" | "upload" | "manual">(() =>
    ACADEMIC_FIELDS.some((name) => String(storedValues[name] ?? "").trim()) ? "manual" : "");
  useEffect(() => {
    if (attachmentsLoaded && academicDocuments.length && academicMode !== "upload") setAcademicMode("upload");
    // Only when documents first appear; choosing "manual" later stays possible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentsLoaded, academicDocuments.length]);
  const academicShown = academicMode === "manual" || (academicMode === "upload" && academicDocuments.some((document) => !["queued", "processing"].includes(extractionStatus(document.metadata))));

  useEffect(() => {
    if (academicMode !== "upload" || !academicReading) return undefined;
    const timer = window.setInterval(() => { void refreshAttachments().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [academicMode, academicReading, refreshAttachments]);

  // Institution, qualification and year come from the newest attached document that has them. A value is replaced only
  // when it is empty or was itself read from another document; anything typed by hand (now or earlier) is kept.
  const appliedAcademicRef = useRef("");
  const recordedFieldsRef = useRef(recordedDocumentFields);
  const derivedFieldsRef = useRef(derivedFields);
  const editedFieldsRef = useRef(editedFields);
  useEffect(() => { recordedFieldsRef.current = recordedDocumentFields; derivedFieldsRef.current = derivedFields; editedFieldsRef.current = editedFields; }, [recordedDocumentFields, derivedFields, editedFields]);
  useEffect(() => {
    const form = formRef.current;
    if (!form || readOnly) return;
    const read = academicDocuments
      .filter((document) => !["queued", "processing", "Not requested", "failed"].includes(extractionStatus(document.metadata)))
      .map((document) => ({ id: document.id, at: document.createdAt, extracted: ((document.metadata.extraction as { extracted?: Record<string, string> } | undefined)?.extracted) ?? {} }))
      .filter((entry) => ACADEMIC_RECORD_FIELDS.some((name) => String(entry.extracted[name] ?? "").trim()));
    if (!read.length) return;
    const newest = read.reduce((latest, entry) => (entry.at > latest.at ? entry : latest));
    if (appliedAcademicRef.current === newest.id) return;
    // When the page opens only empty fields are filled; replacing starts with a document read while the page is open,
    // so a value corrected by hand in an earlier session is never overwritten on reload.
    const opening = appliedAcademicRef.current === "";
    appliedAcademicRef.current = newest.id;
    const asSaved = (name: string, value: string) => (name === "academic_year" ? (value.match(/\d{4}/)?.[0] ?? value) : value).trim();
    const updates: Record<string, string> = {};
    for (const name of ACADEMIC_RECORD_FIELDS) {
      const wanted = asSaved(name, String(newest.extracted[name] ?? ""));
      const control = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
      if (!wanted || !control || unlockedFieldsRef.current.has(name)) continue;
      const current = control.value.trim();
      const fromAnotherDocument = read.some((entry) => entry.id !== newest.id && asSaved(name, String(entry.extracted[name] ?? "")).toLowerCase() === current.toLowerCase());
      // Also replaceable: values the form knows came from a document (even one since deleted) and never edited by hand.
      const documentValue = (recordedFieldsRef.current.has(name) || derivedFieldsRef.current.has(name)) && !editedFieldsRef.current.has(name);
      if (current !== wanted && (!current || (!opening && (fromAnotherDocument || documentValue)))) updates[name] = wanted;
    }
    const names = Object.keys(updates);
    if (!names.length) return;
    applyFormValues(form, updates);
    setDerivedFields((prev) => new Set([...prev, ...names]));
    window.requestAnimationFrame(() => revealFields(formRef.current, names));
    showToast(`We filled ${plural(names.length, "field")} from your academic documents. Please review.`);
    window.requestAnimationFrame(() => computeProgress());
    scheduleSave(true);
  }, [academicDocuments, readOnly, computeProgress, scheduleSave, showToast]);

  /* ---------------------------------------------------------- English */

  const [englishNote, setEnglishNote] = useState("");
  const watchEnglishRef = useRef(false);
  const checkedEnglishRef = useRef<Set<string>>(new Set());
  const englishDocuments = useMemo(() => attachments.filter((document) => document.category === ENGLISH_CATEGORY), [attachments]);
  const englishReading = englishDocuments.some((document) => ["queued", "processing"].includes(extractionStatus(document.metadata)));

  const uploadEnglish = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setDocumentBusy("upload");
    setEnglishNote("Uploading the English test result…");
    try {
      for (const file of Array.from(files)) {
        await uploadApplicationDocument({ applicationId: application.id, category: ENGLISH_CATEGORY, file, metadata: { kind: "english" } });
      }
      watchEnglishRef.current = true;
      await refreshAttachments();
      onSaved?.();
      setEnglishNote("Reading the English test result…");
    } catch (error) {
      setEnglishNote(error instanceof Error ? error.message : "The English test result could not be uploaded.");
    } finally { setDocumentBusy(""); }
  }, [application.id, onSaved, refreshAttachments]);

  useEffect(() => {
    if (!watchEnglishRef.current || !englishReading) return undefined;
    const timer = window.setInterval(() => { void refreshAttachments().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [englishReading, refreshAttachments]);
  useEffect(() => {
    if (!watchEnglishRef.current) return;
    for (const document of englishDocuments) {
      const status = extractionStatus(document.metadata);
      if (checkedEnglishRef.current.has(document.id) || ["queued", "processing", "Not requested"].includes(status)) continue;
      checkedEnglishRef.current.add(document.id);
      const extraction = document.metadata.extraction as { extracted?: Record<string, string>; source?: { categoryMismatch?: boolean } } | undefined;
      const extracted = extraction?.extracted ?? {};
      const usable = status !== "failed" && !extraction?.source?.categoryMismatch && Boolean(extracted.english_type || extracted.english_score);
      if (!usable) {
        if (hasValidatedDocumentPath(document.storagePath)) {
          setEnglishNote("Your English-language evidence was saved. Enter any applicable details below.");
          continue;
        }
        // Not an English test result that can be read: remove it so the right document can be uploaded.
        void deleteApplicationDocument({ id: document.id, storagePath: document.storagePath })
          .catch(() => undefined)
          .then(() => refreshAttachments().catch(() => undefined));
        setEnglishNote(`${document.filename} was rejected: it could not be read as an English test result (IELTS, PTE, TOEFL or Cambridge). Upload the correct document, or fill in the details below.`);
        continue;
      }
      const updates = Object.fromEntries(ENGLISH_DETAIL_FIELDS.map((name) => [name, String(extracted[name] ?? "").trim()]).filter(([, value]) => value));
      setUnlockedFields((prev) => new Set([...prev, ...Object.keys(updates)]));
      setEditedFields((prev) => new Set([...prev, ...Object.keys(updates)]));
      if (formRef.current) applyFormValues(formRef.current, updates);
      window.requestAnimationFrame(() => computeProgress());
      scheduleSave(true);
      const filled = Object.keys(updates).length;
      window.requestAnimationFrame(() => revealFields(formRef.current, Object.keys(updates)));
      if (filled) showToast(`We filled ${plural(filled, "field")} from your English test result. Please review.`);
      setEnglishNote(`Filled ${filled} English field${filled === 1 ? "" : "s"} from ${document.filename}. Check them before continuing.`);
    }
  }, [englishDocuments, refreshAttachments, computeProgress, scheduleSave, showToast]);

  const deleteVisaRef = useRef<(document: DocumentRow) => Promise<void>>(async () => undefined);
  const deleteVisa = useCallback((document: DocumentRow) => deleteVisaRef.current(document), []);

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

  deleteVisaRef.current = async (document: DocumentRow) => {
    await deleteAttachment(document);
    if (visas.some((other) => other.id !== document.id)) return;
    const form = formRef.current;
    if (form) applyFormValues(form, Object.fromEntries(VISA_DETAIL_FIELDS.map((name) => [name, ""])));
    setVisaRead(false);
    setVisaMode("");
    setHoldsVisa("");
    setVisaNote(`${document.filename} was deleted. Choose how to add the visa.`);
  };

  const [usiError, setUsiError] = useState("");
  /** Required answers still missing on one form page. */
  const pageMissing = (index: number): boolean => {
    const section = sections[index];
    if (!section || !isConditionMet(section.showIf, values)) return false;
    return section.fields.some((field) =>
      // The agency/agent answers are set at the start and not shown, so they never hold a page back.
      field.required && !LOCKED_AGENT_FIELDS.has(field.name) && field.type !== "static" && field.type !== "table" && field.type !== "terms" && isConditionMet(field.showIf, values) && fieldMissing(field));
  };
  /** A wrong or still-unread document on one page, as the message to show; "" when its documents are fine. */
  const documentProblem = (index: number): string => {
    const section = sections[index];
    if (!section || !isConditionMet(section.showIf, values)) return "";
    for (const page of PAGE_DOCUMENTS) {
      if (!section.fields.some((field) => field.name === page.marker)) continue;
      for (const document of attachments) {
        if (document.category !== page.category || hasValidatedDocumentPath(document.storagePath)) continue;
        const status = extractionStatus(document.metadata);
        if (status === "Not requested") continue;
        if (["queued", "processing"].includes(status)) return `${document.filename} is still being read. Wait a moment, or delete it to continue.`;
        const extraction = document.metadata.extraction as { extracted?: Record<string, string>; source?: { categoryMismatch?: boolean } } | undefined;
        const extracted = extraction?.extracted ?? {};
        const wrong = status === "failed" || Boolean(extraction?.source?.categoryMismatch)
          || (page.keys.length > 0 && !page.keys.some((key) => String(extracted[key] ?? "").trim()));
        if (wrong) return `${document.filename} is not ${page.noun}. Delete it and upload the correct document.`;
      }
    }
    return "";
  };
  // Keep checking a file on the open page until it has been read, so its result (or rejection) shows without a reload.
  const stepReading = documentProblem(step).includes("is still being read");
  useEffect(() => {
    if (!stepReading) return undefined;
    const timer = window.setInterval(() => { void refreshAttachments().catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [stepReading, refreshAttachments]);
  /** Stops leaving the current page forward until its required answers are filled and its documents are right. */
  const blockedHere = (index: number): boolean => {
    if (readOnly || index <= step || step >= reviewIndex || (!pageMissing(step) && !documentProblem(step))) return false;
    setErrorStep(step);
    // Inline: scroll to the first missing answer on the step and put the cursor in it.
    window.requestAnimationFrame(() => {
      const marker = formRef.current?.querySelector<HTMLElement>('[data-current-step="true"] [data-field-missing="true"]')
        ?? formRef.current?.querySelector<HTMLElement>('[data-step-missing="true"]');
      marker?.scrollIntoView({ behavior: "smooth", block: "center" });
      const wrapper = marker?.closest<HTMLElement>("[data-field]") ?? marker?.parentElement;
      wrapper?.querySelector<HTMLElement>('input:not([type=hidden]):not([tabindex="-1"]), select, textarea, button, [role=radio]')?.focus({ preventScroll: true });
    });
    return true;
  };

  const goTo = (index: number) => {
    if (blockedHere(index)) return;
    if (index > step && sections[step]?.fields.some((field) => field.name === "usi_number") && !readOnly) {
      const usi = formRef.current?.querySelector<HTMLInputElement>('[name="usi_number"]')?.value ?? "";
      const problem = usi.trim() ? validateUsi(usi) : "Enter the student's USI to continue.";
      if (problem) {
        // A wrong USI already shows the field's own format message; this one only covers an empty field.
        setUsiError(usi.trim() ? "" : problem);
        formRef.current?.querySelector<HTMLInputElement>('[name="usi_number"]')?.focus();
        return;
      }
    }
    setUsiError("");
    void flushSave().catch(() => undefined);
    showStep(index);
  };

  /** Opens a step: its card slides in from the side it is reached from, and the form scrolls to its top. */
  function showStep(index: number) {
    setDirection(index < step ? "back" : "forward");
    setStep(index);
    window.requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const fieldMissing = useCallback((field: AppField): boolean => {
    const form = formRef.current;
    if (!form) return true;
    // A hidden, never-found address does not count: it must come from a search pick or a licence first.
    if (!addressShown && field.required && (AU_ADDRESS_FIELDS as readonly string[]).includes(field.name)) return true;
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
  }, [attachments, addressShown]);

  /** A filled optional field whose format is wrong (USI, phone); it never stops a draft being saved, only final submission. */
  const fieldInvalid = useCallback((field: AppField): boolean => {
    const control = formRef.current?.querySelector<HTMLInputElement>(`[name="${field.name}"]`);
    return Boolean(control && control.value.trim() !== "" && !control.checkValidity());
  }, []);

  /** Required field labels still missing, grouped by the section they live in. */
  const collectMissing = useCallback(() => {
    const missing: string[] = [];
    const firstBySection: Array<number | null> = sections.map(() => null);
    sections.forEach((section, index) => {
      if (!isConditionMet(section.showIf, values)) return;
      for (const field of section.fields) {
        if (field.type === "static" || field.type === "table" || field.type === "terms") continue;
        if (!field.required && !field.format) continue;
        if (!isConditionMet(field.showIf, values)) continue;
        if (field.required ? fieldMissing(field) : fieldInvalid(field)) {
          missing.push(`${sectionHeading(section.title, index)}: ${field.label}`);
          if (firstBySection[index] === null) firstBySection[index] = index;
        }
      }
    });
    const firstIndex = firstBySection.findIndex((v) => v !== null);
    return { missing, firstIndex };
  }, [sections, values, fieldMissing, fieldInvalid]);

  const openReview = () => {
    const form = formRef.current;
    if (!form || blockedHere(reviewIndex)) return;
    const collected = collectFormValues(form);
    setReviewValues(collected);
    showStep(reviewIndex);
  };

  const handleSubmit = async () => {
    if (readOnly || submitting) return;
    setSubmitError("");
    const { missing, firstIndex } = collectMissing();
    setShowErrors(true);
    if (missing.length > 0) {
      showStep(firstIndex >= 0 ? firstIndex : 0);
      return;
    }
    const wrongDocumentPage = sections.findIndex((_, index) => documentProblem(index));
    if (wrongDocumentPage >= 0) {
      showStep(wrongDocumentPage);
      setErrorStep(wrongDocumentPage);
      return;
    }
    if (!consent.method || !consent.confirmed || !consent.authorised) {
      setSubmitError("Please record the student consent method and both confirmations before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      // Always save once more: the server checks the saved draft, which must carry the derived answers (e.g. ec_in_au).
      dirtyRef.current = true;
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
      // The success screen (its check animation) shows for a moment before the caller moves on; Continue skips the wait.
      const done = () => onSubmitted?.(reference || application.reference, `${String(snapshot?.values.first_name ?? "")} ${String(snapshot?.values.last_name ?? "")}`.trim());
      submittedDoneRef.current = done;
      window.setTimeout(() => { if (submittedDoneRef.current === done) { submittedDoneRef.current = null; done(); } }, 1800);
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
      <div className="mx-auto w-full max-w-[960px] rounded-xl border border-background-200 bg-background-50 p-6 text-center sm:p-10" role="status">
        <span className="check-pop mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-background-50">
          <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path className="check-draw" d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        <h3 className="mt-4 font-heading text-lg font-semibold text-foreground-950">Application submitted</h3>
        <p className="mx-auto mt-2 max-w-lg text-sm text-foreground-600">
          We received the application for {String(values.first_name ?? "")} {String(values.last_name ?? "")}. SLIT admissions
          will review it and any status change will appear in your notifications.
        </p>
        <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-background-100 px-4 py-1.5 font-mono text-sm font-semibold text-foreground-900">
          <i className="ri-file-list-3-line text-base leading-none text-foreground-500" aria-hidden="true" />
          {submittedRef}
        </p>
        {onSubmitted ? (
          <div className="mt-5">
            <button type="button" onClick={() => { const done = submittedDoneRef.current; submittedDoneRef.current = null; done?.(); }}
              className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg border border-background-300 px-4 text-sm font-medium text-foreground-700 transition-colors hover:bg-background-100">
              Continue
              <i className="ri-arrow-right-line text-base leading-none" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const isReview = step === reviewIndex;
  const errorsShown = showErrors || errorStep === step;

  const saveIndicator = () => {
    if (readOnly) return null;
    if (saveState === "saving") {
      return (
        <span className="inline-flex items-center gap-1" aria-live="polite">
          <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
          Saving&hellip;
        </span>
      );
    }
    if (saveState === "saved" && lastSavedAt) {
      return <span aria-live="polite">Saved {new Date(lastSavedAt).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}</span>;
    }
    if (saveState === "error") {
      return (
        <span className="inline-flex items-center gap-1.5 text-red-700" role="alert">
          Draft not saved
          <button type="button" onClick={() => void enqueueSave()} className="cursor-pointer font-medium underline underline-offset-2">Retry</button>
        </span>
      );
    }
    return <span>Saves automatically</span>;
  };

  const renderExpiryWarning = (name: string) => {
    const type = expiryFieldType.get(name);
    if (!type) return null;
    const expiry = getDocumentExpiryStatus(type, { [name]: expiryDates[name] });
    if ((expiry.status !== "expired" && expiry.status !== "expiring_soon") || !expiry.date) return null;
    const source = documentFields.has(name) && !editedFields.has(name) ? attachments.find((document) => document.id === documentFields.get(name))?.filename : undefined;
    return (
      <span
        className={`text-[10px] font-semibold normal-case ${expiryTone(expiry.status)}`}
        title={`${expiryTooltip(expiry)}${type === "english" ? " (valid 2 years from the test date)" : ""}${source ? `. Source: ${source}` : ""}`}
      >
        {expiryLabel(expiry)}
      </span>
    );
  };

  /** A value read from a document (or worked out from one) that has not been edited since: it shows a small dot. */
  const isAutoFilled = (name: string) =>
    (documentFields.has(name) && !editedFields.has(name)) || (derivedFields.has(name) && !documentFields.has(name) && !unlockedFields.has(name));

  /** Out of sight until the page's own choice shows it (an address found, a visa added, academic details chosen). */
  const hiddenField = (name: string) =>
    (!addressShown && (name === "au_country" || (AU_ADDRESS_FIELDS as readonly string[]).includes(name)))
    || (!visaShown && (VISA_DETAIL_FIELDS as readonly string[]).includes(name))
    || (!academicShown && ACADEMIC_FIELDS.includes(name))
    || (name === "academic_upload" && academicMode !== "upload");

  /** Shown as a field on its page (not a value the form keeps out of sight, and not a note or reference table). */
  const visibleField = (field: AppField) =>
    !(contactFixed && STUDENT_CONTACT_FIELDS.has(field.name)) && !LOCKED_AGENT_FIELDS.has(field.name)
    && !["address_type", "holds_visa", "visa_copy", "english_upload", "checklist"].includes(field.name)
    && !["static", "table", "terms"].includes(field.type) && isConditionMet(field.showIf, values) && !hiddenField(field.name);

  const renderField = (field: AppField) => {
    // The student's email and mobile are set once, uniquely, when the application is started; they are kept with the
    // form (saved, counted as filled) but not shown or editable here.
    if (contactFixed && STUDENT_CONTACT_FIELDS.has(field.name)) {
      if (field.type === "static") return null;
      const saved = String(mergedInitial[field.name] ?? (field.name === "confirm_email" ? mergedInitial.email ?? "" : ""));
      return <input key={field.name} type="hidden" name={field.name} defaultValue={saved} />;
    }
    const fixedAustralia = field.name in FIXED_VALUES;
    const locked = readOnly || LOCKED_AGENT_FIELDS.has(field.name) || fixedAustralia;
    // Always "Australian Address": the ways to fill it (search, licence, by hand) are offered above the fields instead.
    if (field.name === "address_type") return <input key={field.name} type="hidden" name={field.name} defaultValue={AUSTRALIAN_ADDRESS.address_type} />;
    // Kept in the form (saved, fillable) but out of sight until the address has been found. Only visibility changes, never
    // the element tree: rebuilding the inputs would reset them to their saved values and undo a search pick.
    // The visa question is answered by the choice on the Visa page; the old file field is replaced by its upload.
    if (field.name === "holds_visa") return <KeptValue key={field.name} name={field.name} value={String(mergedInitial.holds_visa ?? "")} />;
    if (field.name === "visa_copy" || field.name === "english_upload") return null;
    // The Application checklist page is gone; its required answer is always ticked and kept out of sight.
    if (field.name === "checklist") {
      return (
        <span key={field.name} hidden>
          {(field.options ?? []).map((option) => (
            <input key={option} type="checkbox" name={`${field.name}[]`} value={option} defaultChecked tabIndex={-1} aria-hidden="true" />
          ))}
        </span>
      );
    }
    // The agency and agent are chosen when the application is started; their values are kept, the questions are not shown.
    if (LOCKED_AGENT_FIELDS.has(field.name)) {
      const kept = mergedInitial[field.name];
      return <input key={field.name} type="hidden" name={field.name} defaultValue={Array.isArray(kept) ? kept.join(", ") : String(kept ?? "")} />;
    }
    const autoFilled = !readOnly && !fixedAustralia && field.type !== "file" && isAutoFilled(field.name);
    return renderFieldBody(field, locked, autoFilled, fixedAustralia, hiddenField(field.name));
  };

  const renderFieldBody = (field: AppField, locked: boolean, autoFilled: boolean, fixedAustralia: boolean, hidden = false) => {
    // Notes from the step config are shown in the step title's (i), not as banners.
    if (field.type === "static") return null;
    if (field.type === "table") {
      return (
        <details key={field.name} hidden={hidden} className="group md:col-span-2">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-foreground-600 transition-colors hover:text-foreground-900">
            <i className="ri-arrow-right-s-line text-base leading-none transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
            {field.label}
          </summary>
          <div className="open-in mt-2">
            <ApplicationFieldControl field={field} formId={FORM_ID} />
          </div>
        </details>
      );
    }
    if (field.type === "terms") {
      return (
        <div key={field.name} className="md:col-span-2">
          <TermsDeclaration heading={field.label} terms={field.options ?? []} plain />
        </div>
      );
    }
    const spanFull = field.full || field.type === "textarea" || field.type === "checkbox";
    const missing = errorsShown && field.required && fieldMissing(field);
    const fixedNote = fixedAustralia ? (field.name === "has_usi" ? "A USI is always required." : "Only an Australian address is accepted.") : "";
    const help = [field.description, fixedNote].filter(Boolean).join(" ");
    return (
      <Field
        key={field.name}
        id={`${FORM_ID}-${field.name}`}
        name={field.name}
        label={field.label}
        required={field.required}
        help={help || undefined}
        adornment={renderExpiryWarning(field.name)}
        autoFilled={autoFilled}
        dotInset={field.type === "select" || field.type === "date" || field.format === "year"}
        full={spanFull}
        hidden={hidden}
        messages={
          <>
            {field.name === "usi_number" && usiError ? <FieldMessage>{usiError}</FieldMessage> : null}
            {missing ? <FieldMessage alert={false} missingMarker>This field is required.</FieldMessage> : null}
          </>
        }
      >
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
        ) : field.name === COURSE_FIELD ? (
          <CourseSearchField name={field.name} options={field.options ?? []} disabled={locked} single />
        ) : field.name === "preferred_intake" ? (
          <WorkspaceIntakeField formId={FORM_ID} courseField={COURSE_FIELD} disabled={locked} className={baseFieldClass}
            courseIdOf={(label) => { try { return resolveCourse(label).courseId || null; } catch { return null; } }}
            initialIntakeId={application.courses?.[0]?.intakeId ?? ""} initialLabel={String(mergedInitial.preferred_intake ?? "")} />
        ) : field.name === "school_level" ? (
          <SchoolLevelField field={field} id={`${FORM_ID}-${field.name}`} locked={locked}
            choice={String(mergedInitial.highest_education ?? "")} schoolLevel={String(mergedInitial.school_level ?? "")} />
        ) : (
          <ApplicationFieldControl field={field.name === "agent_agency" ? { ...field, options: [seed.agent_agency] } : field} formId={FORM_ID} value={mergedInitial[field.name] as string | undefined} locked={locked} compact />
        )}
      </Field>
    );
  };

  const statusLine = (text: ReactNode, busy = false) => (
    <p className="fade-in mt-1.5 flex items-center gap-1.5 text-xs text-foreground-600" role="status">
      {busy ? <i className="ri-loader-4-line animate-spin text-base leading-none" aria-hidden="true" /> : null}
      {text}
    </p>
  );

  // The existing manual fallback: offered once search is unavailable or the licence cannot be read (or it was chosen before).
  const manualAddressAllowed = searchUnavailable || licenceUnreadable || addressMode === "manual" || String(storedValues.address_source ?? "") === "manual";
  const enterAddressManually = () => {
    setAddressMode("manual");
    setAddressShown(true);
    if (formRef.current) applyFormValues(formRef.current, { address_source: "manual" });
    scheduleSave(true);
    window.requestAnimationFrame(() => {
      revealFields(formRef.current, AU_ADDRESS_FIELDS);
      formRef.current?.querySelector<HTMLInputElement>('[name="au_street"]')?.focus();
    });
  };

  const renderSectionBody = (section: AppSection) => {
    const hasVisa = section.fields.some((field) => field.name === "visa_subclass");
    const hasAcademic = section.fields.some((field) => field.name === "academic_upload");
    return (
      <>
        {section.scans?.some((scan) => scan.type === "licence") && !readOnly ? (
          <div className="mb-4">
            <KeptValue name="address_source" value={String(storedValues.address_source ?? "") || (addressFromWizardLicence ? "licence" : "")} />
            <p className={`${FORM_LABEL} mb-1`}>Fill the address by</p>
            <SegmentedControl<"search" | "licence" | "manual">
              label="How to fill the address"
              value={addressMode}
              onChange={(mode) => (mode === "manual" ? enterAddressManually() : setAddressMode(mode))}
              options={[
                { value: "search", label: "Search address", icon: "ri-search-line", hint: "Find the student's address and pick it" },
                { value: "licence", label: "Driving licence", icon: "ri-profile-line", hint: "The address is read from an Australian driving licence" },
                ...(manualAddressAllowed ? [{ value: "manual" as const, label: "Enter manually", icon: "ri-edit-line", hint: "Type the address yourself" }] : []),
              ]}
            />
            <div key={addressMode} className="fade-in mt-3">
              {addressMode === "search" ? (
                <AddressSearch
                  onUnavailable={() => setSearchUnavailable(true)}
                  onManual={manualAddressAllowed ? enterAddressManually : undefined}
                  onPick={(pick) => fillAustralianAddress({ au_street: pick.line, au_line2: pick.line2, au_suburb: pick.suburb, au_state: pick.state, au_zip: pick.postcode }, true, "search")}
                />
              ) : addressMode === "licence" ? (
                <ApplicationAttachmentField
                  field={LICENCE_FIELD}
                  documents={licences}
                  disabled={Boolean(documentBusy)}
                  busyDocumentId={documentBusy}
                  onUpload={uploadLicence}
                  onPreview={previewAttachment}
                  onExtract={extractAttachment}
                  onDelete={deleteAttachment}
                />
              ) : (
                <p className="text-xs text-foreground-600">Type the student&apos;s Australian address in the fields below.</p>
              )}
            </div>
            {addressMode === "licence" && licenceNote ? statusLine(licenceNote) : null}
            {overseasLicence && !(addressMode === "licence" && licenceNote) ? (
              <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-800" role="status">
                <i className="ri-error-warning-line text-base leading-none" aria-hidden="true" />
                The driving licence on file ({overseasLicence.filename}) has an overseas address, so it can&apos;t be used here. Search for the student&apos;s Australian address.
              </p>
            ) : null}
            {!addressShown && errorsShown ? <FieldMessage missingMarker>Search for the address or upload a driving licence to fill it.</FieldMessage> : null}
            {addressShown && addressMode === "search" ? (
              <button
                type="button"
                onClick={() => formRef.current?.querySelector<HTMLInputElement>('[name="au_street"]')?.focus()}
                className="mt-1 inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-foreground-600 underline-offset-2 transition-colors hover:text-foreground-900 hover:underline"
              >
                <i className="ri-edit-line text-base leading-none" aria-hidden="true" />
                Edit manually
              </button>
            ) : null}
          </div>
        ) : null}
        {hasAcademic && !readOnly ? (
          <div className="mb-4">
            <p className={`${FORM_LABEL} mb-1`}>Fill in the academic details by</p>
            <SegmentedControl<"upload" | "manual">
              label="How to fill in the academic details"
              value={academicMode}
              onChange={setAcademicMode}
              options={[
                { value: "upload", label: "Upload documents", icon: "ri-upload-2-line", hint: "Certificates or transcripts; the answers are read from them" },
                { value: "manual", label: "Enter manually", icon: "ri-edit-line", hint: "Answer the questions yourself" },
              ]}
            />
            {academicMode === "upload" && academicReading ? statusLine("Reading the academic documents…", true) : null}
            {academicMode === "upload" && !academicDocuments.length ? statusLine("Upload the documents below; the questions appear, filled in, once they are read.") : null}
            {errorsShown && !academicShown ? <FieldMessage missingMarker>Upload academic documents or choose Enter manually.</FieldMessage> : null}
          </div>
        ) : null}
        {section.fields.some((field) => field.name === "english_type") ? (
          <div className="mb-4">
            <div className="mb-1 flex items-center gap-1.5">
              <p className={FORM_LABEL}>English test result</p>
              <InfoTip text="An IELTS, PTE, TOEFL or Cambridge result, or other accepted proof of English proficiency. Details that can be read fill the fields below; fill in any that could not be read." />
            </div>
            <ApplicationAttachmentField
              field={ENGLISH_UPLOAD_FIELD}
              documents={englishDocuments}
              disabled={readOnly || Boolean(documentBusy) || englishReading}
              busyDocumentId={documentBusy}
              onUpload={uploadEnglish}
              onPreview={previewAttachment}
              onExtract={extractAttachment}
              onDelete={deleteAttachment}
            />
            {englishNote ? statusLine(englishNote) : null}
          </div>
        ) : null}
        {hasVisa && !readOnly && !(visaMode === "upload" && visaRead) ? (
          <div className="mb-4">
            <p className={`${FORM_LABEL} mb-1`}>Add the visa by</p>
            <SegmentedControl<"upload" | "manual" | "none">
              label="How to add the visa"
              value={visaMode}
              onChange={chooseVisaMode}
              options={[
                { value: "upload", label: "Upload document", icon: "ri-upload-2-line", hint: "Details are read from the grant notice or VEVO record" },
                { value: "manual", label: "Enter manually", icon: "ri-edit-line", hint: "Type the four visa details" },
                { value: "none", label: "No Australian visa", icon: "ri-close-circle-line", hint: "The student does not hold one" },
              ]}
            />
            {visaMode === "upload" && !visaRead ? (
              <div className="fade-in mt-3">
                <ApplicationAttachmentField
                  field={VISA_UPLOAD_FIELD}
                  documents={visas}
                  disabled={Boolean(documentBusy) || visaReading}
                  busyDocumentId={documentBusy}
                  onUpload={uploadVisa}
                  onPreview={previewAttachment}
                  onExtract={extractAttachment}
                  onDelete={deleteAttachment}
                />
              </div>
            ) : null}
            {visaNote ? statusLine(visaNote) : null}
            {errorsShown && !visaMode ? <FieldMessage missingMarker>Choose how to add the visa, or select No Australian visa.</FieldMessage> : null}
          </div>
        ) : null}
        {hasVisa && visaMode === "upload" && visaRead ? (
          <div className="mb-4">
            <p className={`${FORM_LABEL} mb-1`}>{VISA_UPLOAD_FIELD.label}</p>
            <ApplicationAttachmentField
              field={VISA_UPLOAD_FIELD}
              documents={visas}
              disabled={readOnly || Boolean(documentBusy) || visaReading}
              busyDocumentId={documentBusy}
              onUpload={uploadVisa}
              onPreview={previewAttachment}
              onExtract={extractAttachment}
              onDelete={deleteVisa}
            />
            {visaNote ? statusLine(visaNote) : null}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2">
          {section.fields
            .filter((field) => isConditionMet(field.showIf, values))
            .map((field) => renderField(field))}
        </div>
        {hasAcademic && qualifications.length > 0 ? (
          <div className="mt-4 border-t border-background-200 pt-3">
            <div className="mb-1 flex items-center gap-1.5">
              <p className={FORM_LABEL}>Qualifications read from documents</p>
              <InfoTip text="Removing an uploaded file removes only the qualifications read from it." />
            </div>
            <ul className="space-y-0.5">
              {qualifications.map((item, index) => (
                <li key={`${qualificationTitle(item)}-${index}`} className="truncate text-[13px] text-foreground-700">
                  <span className="font-medium text-foreground-900">{qualificationTitle(item)}</span>
                  {qualificationDetail(item) ? <span> &middot; {qualificationDetail(item)}</span> : null}
                  {item.documentIds.length > 0 ? (
                    <span className="text-foreground-500"> (from {item.documentIds.map((id) => attachments.find((document) => document.id === id)?.filename ?? "a document").join(", ")})</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </>
    );
  };

  /** The step's longer help: its description when too long for one line, plus the notes the step config holds. */
  const stepHelp = (section: AppSection): { subtitle: string; tip: string } => {
    const description = section.description?.trim() ?? "";
    const notes = section.fields
      .filter((field) => field.type === "static" && field.description && isConditionMet(field.showIf, values) && !(contactFixed && STUDENT_CONTACT_FIELDS.has(field.name)))
      .map((field) => sentenceCase(field.description ?? ""));
    const short = description.length > 0 && description.length <= SUBTITLE_MAX;
    return { subtitle: short ? description : "", tip: [short ? "" : description, ...notes].filter(Boolean).join(" ") };
  };

  const navSteps: NavStep[] = [
    ...sections.map((section, index): NavStep => {
      // The same check that holds a step back (required answers, documents), so the list agrees with Review & submit.
      const complete = !pageMissing(index) && !documentProblem(index);
      const issue = (showErrors || errorStep === index) && !complete;
      return { key: `step-${index}`, title: stepTitle(section.title, index), state: index === step ? "current" : complete ? "done" : issue ? "issue" : "pending" };
    }),
    { key: "review", title: "Review & submit", state: isReview ? "current" : "pending", final: true },
  ];

  const missingNow = isReview ? collectMissing().missing : [];
  const documentProblems = isReview ? sections.map((_, index) => documentProblem(index)) : [];
  const stepProblem = isReview ? "" : documentProblem(step);
  const footerMessage = stepProblem || (!isReview && errorStep === step && pageMissing(step) ? "Fill in the required fields marked on this page to continue." : "");
  const canSubmitHere = canSubmitApplicationStatus(application.status);
  const lastSection = step >= sections.length - 1;

  return (
    <form
      id={FORM_ID}
      ref={formRef}
      noValidate
      onChange={handleChange}
      className="form-compact mx-auto w-full max-w-[960px] scroll-mt-20"
    >
      <StepShell
        steps={navSteps}
        current={step}
        percent={progress.overall}
        status={saveIndicator()}
        onSelect={(index) => (index === reviewIndex ? (readOnly ? goTo(reviewIndex) : openReview()) : goTo(index))}
        onPrevious={() => goTo(Math.max(0, step - 1))}
        previousDisabled={step === 0}
        onSaveDraft={readOnly ? undefined : () => void flushSave().catch(() => undefined)}
        message={footerMessage ? <FooterMessage>{footerMessage}</FooterMessage> : null}
        primary={
          isReview
            ? !readOnly && canSubmitHere
              ? {
                label: "Submit application",
                icon: "ri-send-plane-line",
                onClick: () => void handleSubmit(),
                // The rule the submit always had (nothing missing, both confirmations), plus no wrong or unread document.
                disabled: missingNow.length > 0 || consent.method === "" || !consent.confirmed || !consent.authorised || documentProblems.some(Boolean),
                busy: submitting,
                busyLabel: "Submitting…",
                testId: "submit-application",
              }
              : null
            : {
              label: lastSection ? "Review" : "Next",
              icon: "ri-arrow-right-line",
              onClick: () => (lastSection ? openReview() : goTo(step + 1)),
            }
        }
      >
        {readOnly ? (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-foreground-600">
            <i className="ri-lock-line text-base leading-none" aria-hidden="true" />
            Submitted and read-only. Contact SLIT admissions if a correction is required.
          </p>
        ) : null}
        {documentMessage ? <p className="mb-3 text-xs text-foreground-500" role="status">{documentMessage}</p> : null}
        {saveState === "error" && saveError ? (
          <div className="mb-3">
            <PortalError message={saveError} onRetry={() => void enqueueSave()} />
          </div>
        ) : null}

        {isReview ? (
          <div className={direction === "back" ? "step-in-back" : "step-in-forward"}>
            <ApplicationReview
              values={reviewValues ?? storedValues}
              courses={
                (((reviewValues ?? storedValues)[COURSE_FIELD] as string[] | undefined) ?? [])
              }
              sections={sections}
              application={application}
              qualifications={qualifications}
              agentName={agentName}
              agencyName={agencyName}
              consent={consent}
              onConsentChange={(patch) => setConsent((prev) => ({ ...prev, ...patch }))}
              onEditSection={(index) => goTo(index)}
              missing={missingNow}
              documentProblems={documentProblems}
              submitError={submitError}
              readOnly={readOnly}
              canSubmit={canSubmitApplicationStatus(application.status)}
            />
          </div>
        ) : null}
        {/* Keep controls mounted across navigation/review so snapshots and
            validation include every section and never discard earlier input. */}
        {sections.map((section, index) => {
          const { subtitle, tip } = stepHelp(section);
          const open = index === step && !isReview;
          return (
            <SectionCard
              key={index}
              id={`${FORM_ID}-step-${index}`}
              title={stepTitle(section.title, index)}
              tip={tip || undefined}
              subtitle={subtitle || undefined}
              open={open}
              hidden={!isConditionMet(section.showIf, values)}
              direction={direction}
              note={!readOnly && section.fields.some((field) => visibleField(field) && field.type !== "file" && !(field.name in FIXED_VALUES) && isAutoFilled(field.name)) ? (
                <p className="flex items-center gap-1.5 text-xs text-foreground-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-foreground-400" aria-hidden="true" />
                  Auto-filled from your document. Click any field to edit.
                </p>
              ) : null}
            >
              {renderSectionBody(section)}
            </SectionCard>
          );
        })}
      </StepShell>

      <Toast message={toast.message} onDismiss={toast.dismiss} />
      <span
        ref={(element) => {
          sectionRefs.current[step] = element;
        }}
        className="hidden"
        aria-hidden="true"
      />
    </form>
  );
}

export function ApplicationWorkspaceSkeleton() {
  return <div className="rounded-card border border-background-200 bg-background-50 p-6 text-sm text-foreground-500">Loading form&hellip;</div>;
}
