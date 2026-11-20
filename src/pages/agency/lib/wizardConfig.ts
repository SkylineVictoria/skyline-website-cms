import type { ScanType } from "@/lib/docScan";

/**
 * Configuration for the Add New Form document-upload wizard.
 *
 * The wizard only collects documents. Extraction runs in the backend and fills
 * empty fields of the draft; everything else is entered in the full form.
 */

/** "health" is a staff-only screen (health insurance); it is never read automatically. */
export type WizardStepId = ScanType | "health";

export interface WizardStep {
  id: WizardStepId;
  title: string;
  short: string;
  /** One line shown under the title. */
  subtitle: string;
  icon: string;
  /** Storage category written to enrollment_application_documents.category. */
  category: string;
  /** Document noun used in loader text ("Reading your passport…"). */
  noun: string;
  /** Label of the button that skips this step. */
  skipLabel: string;
  multiple?: boolean;
  /** The agent cannot move past this step without uploading the document. */
  required?: boolean;
}

export const WIZARD_STEPS: WizardStep[] = [
  {
    id: "passport",
    title: "Passport",
    short: "Passport",
    subtitle: "Required. Upload the biodata page (PDF, JPG or PNG).",
    icon: "ri-id-card-line",
    category: "Passport",
    noun: "passport",
    skipLabel: "Continue without passport",
    required: true,
  },
  {
    id: "english",
    title: "English-language evidence",
    short: "English",
    subtitle: "Required. Upload an IELTS, PTE, TOEFL or other accepted proof of English proficiency.",
    icon: "ri-translate-2",
    category: "English Test",
    noun: "English test",
    skipLabel: "Continue without English test",
    required: true,
  },
  {
    id: "academic",
    title: "Academic results",
    short: "Academic",
    subtitle: "Required. Upload transcripts, certificates or diplomas; several files are fine.",
    icon: "ri-file-paper-2-line",
    category: "Academic",
    noun: "academic transcript",
    skipLabel: "Continue without academic results",
    multiple: true,
    required: true,
  },
  {
    id: "visa",
    title: "Australian visa",
    short: "Visa",
    subtitle: "Required. Upload the visa grant notice or VEVO record.",
    icon: "ri-passport-line",
    category: "Visa",
    noun: "visa",
    skipLabel: "Continue without visa",
    required: true,
  },
  {
    id: "licence",
    title: "Australian driving licence",
    short: "Driving Licence",
    subtitle: "Optional. Upload an Australian driving licence to fill in the student's address. Overseas licences are not accepted.",
    icon: "ri-profile-line",
    category: "Driving Licence",
    noun: "licence",
    skipLabel: "Continue without licence",
  },
];

/** The answer screens that follow the document screens of the wizard. */
export type WizardQuestionId = "language" | "usi" | "emergency" | "course";

export interface WizardQuestion {
  id: WizardQuestionId;
  title: string;
  short: string;
  subtitle: string;
  icon: string;
}

export const WIZARD_QUESTIONS: WizardQuestion[] = [
  { id: "language", title: "Language spoken at home", short: "Language", subtitle: "Does the student speak a language other than English at home?", icon: "ri-chat-3-line" },
  { id: "usi", title: "Unique Student Identifier (USI)", short: "USI", subtitle: "Required. The student's 10-character USI from usi.gov.au.", icon: "ri-fingerprint-line" },
  { id: "emergency", title: "Emergency contact", short: "Emergency", subtitle: "Required. Who to contact in an emergency.", icon: "ri-phone-line" },
  { id: "course", title: "Course and intake", short: "Course", subtitle: "Required. The course the student is applying for and when they want to start.", icon: "ri-book-open-line" },
];

export const ENGLISH_ONLY = "No, English only - 1201";
export const OTHER_LANGUAGE = "Yes, language other than English";

/** Set when the wizard finishes: the full form then opens on its Student declaration page. */
export const openDeclarationKey = (applicationId: string) => `slit-open-declaration:${applicationId}`;

export type WizardExtractionState = "queued" | "processing" | "done" | "empty" | "failed";

/** One stored document as shown on a wizard step. */
export interface WizardDoc {
  id: string;
  category: string;
  filename: string;
  fileSize: number;
  storagePath: string;
  extraction: WizardExtractionState;
  error?: string;
  /** Values read from the document, for the expiry warning. */
  extracted?: Record<string, string>;
  /** The reader classified the file as a different kind of document than this step asks for. */
  mismatch?: boolean;
}

/** A file that has been picked but is not yet a stored document, or failed to upload. */
export interface PendingUpload {
  key: string;
  category: string;
  file: File;
  error?: string;
  /** 0 to 1 while the file uploads, when the uploader reports it (staff onboarding); the row then shows a progress bar. */
  progress?: number;
}

export interface WizardMeta {
  completedSteps: WizardStepId[];
  outstanding: string[];
  updatedAt: string;
}

/** Maps the persisted extraction metadata to the state the wizard shows. */
export function wizardExtractionState(metadata: Record<string, unknown> | undefined): { state: WizardExtractionState; error?: string } {
  const extraction = metadata?.extraction as { status?: unknown; error?: { message?: unknown } } | undefined;
  switch (extraction?.status) {
    case "queued":
      return { state: "queued" };
    case "processing":
      return { state: "processing" };
    case "no_fields":
      return { state: "empty" };
    case "unreviewed":
    case "confirmed":
    case "rejected":
      return { state: "done" };
    case "failed":
      return { state: "failed", error: typeof extraction.error?.message === "string" ? extraction.error.message : undefined };
    default:
      return { state: "failed", error: "This document has not been read yet." };
  }
}

/** Human-friendly file size for the file chip. */
export function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Who the wizard collects documents for. Students keep WIZARD_STEPS exactly as above; staff use STAFF_WIZARD_STEPS. */
export type Registrant = "student" | "staff";

/**
 * Staff document screens (the onboarding wizard's "Upload your documents"), in order. `category` is the hr.staff_documents
 * category; which are required and which carry an expiry date comes from src/lib/staffStatus.ts (staffDocKinds), mirroring the
 * database. Visa and English are required only for non-citizens; Driving Licence is optional; Academic takes several files.
 * The page puts "Required." in front of a required type's line. Expiry dates are read from the document or typed on the next step.
 */
export const STAFF_WIZARD_STEPS: WizardStep[] = [
  { id: "passport", title: "Passport", short: "Passport", subtitle: "Upload the photo page (PDF, JPG or PNG). We read your name, date of birth, nationality, passport number and its expiry date from it.", icon: "ri-id-card-line", category: "Passport", noun: "passport", skipLabel: "", required: true },
  { id: "visa", title: "Visa", short: "Visa", subtitle: "Upload your visa grant notice or VEVO record. We read the visa subclass and its expiry date from it.", icon: "ri-passport-line", category: "Visa", noun: "visa", skipLabel: "", required: true },
  { id: "english", title: "English test result", short: "English", subtitle: "Upload your IELTS, PTE, TOEFL or other accepted proof of English proficiency.", icon: "ri-translate-2", category: "English", noun: "English test result", skipLabel: "", required: true },
  { id: "academic", title: "Academic results", short: "Academic", subtitle: "Upload transcripts, certificates or diplomas; several files are fine.", icon: "ri-file-paper-2-line", category: "Academic", noun: "academic result", skipLabel: "", multiple: true, required: true },
  { id: "licence", title: "Driving licence", short: "Driving licence", subtitle: "Upload your driving licence; an Australian licence fills in your address.", icon: "ri-profile-line", category: "Driving Licence", noun: "licence", skipLabel: "" },
  { id: "health", title: "Health insurance", short: "Health insurance", subtitle: "Upload your health insurance certificate or policy.", icon: "ri-heart-pulse-line", category: "Health Insurance", noun: "health insurance", skipLabel: "", required: true },
];

export const wizardStepsFor = (registrant: Registrant): WizardStep[] => (registrant === "staff" ? STAFF_WIZARD_STEPS : WIZARD_STEPS);
