import type { ScanType } from "@/lib/docScan";

/**
 * Configuration for the Add New Form document-upload wizard.
 *
 * The wizard only collects documents. Extraction runs in the backend and fills
 * empty fields of the draft; everything else is entered in the full form.
 */

export type WizardStepId = ScanType;

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
    id: "english",
    title: "English language test",
    short: "English",
    subtitle: "Required. Upload the IELTS, PTE, TOEFL or other accepted result.",
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
 * Staff document screens (staff self-registration). Only the passport is required; the rest are optional. `category` is the
 * hr.staff_documents category; PTE and English certificates share the "english" reader but are kept as separate documents.
 */
export const STAFF_WIZARD_STEPS: WizardStep[] = [
  { id: "passport", title: "Passport", short: "Passport", subtitle: "Required. Upload the biodata page (PDF, JPG or PNG). We read it to fill in your name and date of birth.", icon: "ri-id-card-line", category: "Passport", noun: "passport", skipLabel: "", required: true },
  { id: "visa", title: "Visa", short: "Visa", subtitle: "Optional. Upload your visa grant notice or VEVO record.", icon: "ri-passport-line", category: "Visa", noun: "visa", skipLabel: "" },
  { id: "licence", title: "Driver licence", short: "Driver licence", subtitle: "Optional. Upload your driver licence; an Australian licence fills in your address.", icon: "ri-profile-line", category: "Driving Licence", noun: "licence", skipLabel: "" },
  { id: "english", title: "PTE result", short: "PTE", subtitle: "Optional. Upload your PTE score report.", icon: "ri-translate-2", category: "PTE", noun: "PTE result", skipLabel: "" },
  { id: "english", title: "English certificate", short: "English certificate", subtitle: "Optional. Upload another English language certificate (IELTS, TOEFL or similar).", icon: "ri-award-line", category: "English Certificate", noun: "English certificate", skipLabel: "" },
];

export const wizardStepsFor = (registrant: Registrant): WizardStep[] => (registrant === "staff" ? STAFF_WIZARD_STEPS : WIZARD_STEPS);
