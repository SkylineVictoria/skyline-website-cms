import { portalSections } from "@/pages/agency/lib/portalSections";

/** WIZARD-FULL (owner, 2026-11-23): shared answers and field lists of the wizard screens that finish the application. */
const FIELDS = new Map(portalSections.flatMap((section) => section.fields).map((field) => [field.name, field]));
export const optionsOf = (name: string): string[] => FIELDS.get(name)?.options ?? [];
export const DECLARATION_TERMS = optionsOf("declaration");
export const CHECKLIST_OPTIONS = optionsOf("checklist");
export const OSHC_SELF_CONFIRM = optionsOf("oshc_self_confirm")[0] ?? "";

/** The fields each new screen saves (used to send the agent back to the right screen when the server finds something missing). */
export const FINISH_SCREEN_FIELDS: Record<string, string[]> = {
  personal: ["title", "first_name", "middle_name", "last_name", "dob", "gender", "email", "confirm_email", "citizenship", "nationality", "birth_country", "place_of_birth", "passport_number", "passport_expiry"],
  address: ["address_type", "au_street", "au_line2", "au_suburb", "au_state", "au_zip", "au_country"],
  identifier: ["atsi", "employment", "secondary_enrolled", "school_level", "prior_ed", "disability"],
  study: ["study_reason", "rpl", "oshc_require", "oshc_start_date", "oshc_self_confirm", "oshc_provider", "oshc_policy_number", "oshc_expiry", "hear_about"],
  declare: ["mobile", "declaration_name", "digital_signature", "declaration_date", "checklist"],
};

/** Reporting details stored as draft answers and applied on submission. */
export const AVETMISS_EXTRA_FIELDS = ["english_proficiency_code", "disability_types", "prior_education"] as const;

export interface FinishSummary {
  name: string;
  course: string;
  intake: string;
  documents: string[];
}

