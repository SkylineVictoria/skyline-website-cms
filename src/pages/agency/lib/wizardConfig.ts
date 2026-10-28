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
}

export const WIZARD_STEPS: WizardStep[] = [
  {
    id: "passport",
    title: "Passport",
    short: "Passport",
    subtitle: "Upload the biodata page (PDF, JPG or PNG).",
    icon: "ri-id-card-line",
    category: "Passport",
    noun: "passport",
    skipLabel: "Continue without passport",
  },
  {
    id: "licence",
    title: "Driving licence",
    short: "Licence",
    subtitle: "Optional. Upload a driving licence or other address evidence.",
    icon: "ri-profile-line",
    category: "Driving Licence",
    noun: "licence",
    skipLabel: "Continue without licence",
  },
  {
    id: "visa",
    title: "Australian visa",
    short: "Visa",
    subtitle: "Optional. Upload a visa grant notice or VEVO record.",
    icon: "ri-passport-line",
    category: "Visa",
    noun: "visa",
    skipLabel: "Continue without visa",
  },
  {
    id: "english",
    title: "English language test",
    short: "English",
    subtitle: "Optional. Upload an IELTS, PTE, TOEFL or other accepted result.",
    icon: "ri-translate-2",
    category: "English Test",
    noun: "English test",
    skipLabel: "Continue without English test",
  },
  {
    id: "academic",
    title: "Academic results",
    short: "Academic",
    subtitle: "Optional. Upload transcripts, certificates or diplomas; several files are fine.",
    icon: "ri-file-paper-2-line",
    category: "Academic",
    noun: "academic transcript",
    skipLabel: "Continue without academic results",
    multiple: true,
  },
];

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
