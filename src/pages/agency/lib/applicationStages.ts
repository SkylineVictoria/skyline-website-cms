import type { AppSection } from "@/data/applicationForms";
import { stepTitle } from "../../../components/shared/application-form/stepTitle";

/**
 * How the application form's steps are grouped into stages: one page per stage, each step a card on it. The UI reads only this
 * config. Steps are named by the key of their title (see sectionKey); a step the config does not name (a new one) joins the
 * stage of the step before it, so it is never lost.
 */
export interface StageConfig {
  id: string;
  title: string;
  sections: readonly string[];
}

export const APPLICATION_STAGES: readonly StageConfig[] = [
  { id: "about", title: "About you", sections: ["personal-details-passport", "address", "emergency-contact"] },
  { id: "visa", title: "Visa & identity", sections: ["australian-visa", "student-identifier-avetmiss", "unique-student-identifier-usi"] },
  { id: "education", title: "Education & course", sections: ["english-test", "academic-documents", "course-information", "course-credit", "study-reason"] },
  { id: "finish", title: "Finish", sections: ["oshc-health-insurance", "how-did-you-hear-about-slit", "student-declaration"] },
];

/**
 * What a completed step's one-line summary shows: groups of fields joined by a space ("Priya Sharma"), groups joined by ", ".
 * A step not listed shows its first two answers.
 */
export const SECTION_SUMMARY: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  "personal-details-passport": [["first_name", "last_name"], ["dob"]],
  address: [["au_street"], ["au_suburb", "au_state", "au_zip"]],
  "emergency-contact": [["ec_name"], ["ec_relationship"]],
  "australian-visa": [["visa_subclass"], ["visa_stay_until"]],
  "unique-student-identifier-usi": [["usi_number"]],
  "english-test": [["english_type"], ["english_score"]],
  "course-information": [["courses_of_interest"], ["preferred_intake"]],
  "student-declaration": [["declaration_name"], ["declaration_date"]],
};

/** A step's key: its title in lower case with dashes ("Unique Student Identifier (USI)" → "unique-student-identifier-usi"). */
export function sectionKey(section: AppSection, index: number): string {
  return stepTitle(section.title, index).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface Stage { id: string; title: string; sections: number[] }

/** The stages with the form's step indices, in the config's order; every step lands in exactly one stage. */
export function groupSections(sections: readonly AppSection[], config: readonly StageConfig[] = APPLICATION_STAGES): Stage[] {
  const keys = sections.map((section, index) => sectionKey(section, index));
  const stages: Stage[] = config.map((stage) => ({ id: stage.id, title: stage.title, sections: stage.sections.map((key) => keys.indexOf(key)).filter((index) => index >= 0) }));
  const placed = new Set(stages.flatMap((stage) => stage.sections));
  keys.forEach((_, index) => {
    if (placed.has(index)) return;
    // Next to the step before it (or in the first stage).
    const before = stages.findIndex((stage) => stage.sections.includes(index - 1));
    const target = stages[before >= 0 ? before : 0] ?? stages[0];
    if (!target) return;
    const at = target.sections.indexOf(index - 1);
    target.sections.splice(at >= 0 ? at + 1 : target.sections.length, 0, index);
    placed.add(index);
  });
  return stages.filter((stage) => stage.sections.length > 0);
}
