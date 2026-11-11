import { enrolSections, type AppField, type AppSection } from "@/data/applicationForms";
import { courses } from "@/data/courses";

/**
 * The agency portal reuses the exact same international student application
 * sections (fields, conditions, validation) as the public website, so there is
 * a single source of truth. This module layers on the two portal-specific bits:
 *
 *   1. The course checklist is built from the shared course catalogue instead
 *      of a hand-maintained list, and domestic-only courses (BSB80120) are
 *      never offered to international applicants.
 *   2. The agency/agent block is auto-filled from the signed-in membership and
 *      locked, so an agent can never file the form as the student.
 */

/** Field name of the multi-select course checklist inside the shared sections. */
export const COURSE_FIELD = "courses_of_interest";

/** Fields the portal auto-fills from the authenticated agency/agent, then locks. */
export const LOCKED_AGENT_FIELDS = new Set([
  "via_agent",
  "agent_agency",
  "agent_contact_name",
  "agent_email",
  "agent_phone",
]);

/** Domestic-only qualification — never shown as an international application choice. */
const DOMESTIC_ONLY_CODES = new Set(["BSB80120"]);

/**
 * International course options, derived from the shared course catalogue.
 * Two variants of the same code (e.g. RII60520 at 52 and 104 weeks) stay
 * distinct because the option label carries the variant name.
 */
export const portalCourseOptions: string[] = (() => {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const course of courses) {
    if (!course.code || DOMESTIC_ONLY_CODES.has(course.code)) continue;
    const label = `${course.code} - ${course.name}`;
    if (seen.has(label)) continue;
    seen.add(label);
    options.push(label);
  }
  return options;
})();

export interface ResolvedCourse {
  courseId: string;
  code: string;
  title: string;
  variant: string;
}

/** Maps a selected checklist label back to concrete course catalogue fields. */
export function resolveCourseOption(label: string): ResolvedCourse {
  const matched = courses.find((course) => `${course.code} - ${course.name}` === label);
  if (matched) {
    return {
      courseId: matched.slug,
      code: matched.code ?? label.split(" - ")[0],
      title: matched.name,
      variant: matched.duration ?? "",
    };
  }
  const code = label.split(" - ")[0]?.trim() ?? label;
  return { courseId: label, code, title: label, variant: "" };
}

/**
 * Portal application sections — the shared sections with the course checklist
 * sourced from the live catalogue.
 *
 * NOTE (conflict flag): the reference English-score table embedded in section 3
 * ("Visa, English & Agent Details") lists IELTS 6.0 / PTE 50 / TOEFL 60, while
 * individual course entry summaries only state "Over 18 years". These are
 * surfaced for review as-is rather than overwritten with invented thresholds —
 * see the implementation report.
 */
/** Visa fields that get their own portal page (filled from an uploaded visa document or entered manually). */
export const VISA_FIELD_NAMES = new Set(["holds_visa", "visa_copy", "visa_subclass", "visa_grant_date", "visa_stay_until", "visa_grant_number"]);

/** In the portal the shared "Visa, English & Agent details" section is split into a Visa page and an English & agent page. */
function splitVisaSection(section: AppSection): AppSection[] {
  if (!section.fields.some((field) => field.name === "visa_subclass")) return [section];
  return [
    { title: "AUSTRALIAN VISA", fields: section.fields.filter((field) => VISA_FIELD_NAMES.has(field.name)) },
    { ...section, title: "ENGLISH TEST", fields: section.fields.filter((field) => !VISA_FIELD_NAMES.has(field.name)) },
  ];
}

/** Education questions that the portal asks on the Academic documents page instead of the Student identifier page. */
export const EDUCATION_FIELD_NAMES = new Set(["secondary_enrolled", "school_level", "year_completed", "prior_ed"]);

/** The language actually spoken, asked when "Yes, language other than English" is chosen. */
const LANGUAGE_OTHER_FIELD: AppField = {
  name: "language_other",
  label: "Which language?",
  type: "text",
  required: true,
  full: true,
  placeholder: "e.g. Hindi",
  showIf: { field: "language_home", equals: ["Yes, language other than English"] },
};

/** The portal's emergency contact is just a name, a phone number and the relationship, in that order. */
const EMERGENCY_CONTACT_FIELDS = ["ec_name", "ec_phone", "ec_relationship"];

function trimEmergencyContact(section: AppSection): AppSection {
  if (!section.fields.some((field) => field.name === "ec_name")) return section;
  const fields = EMERGENCY_CONTACT_FIELDS.map((name) => section.fields.find((field) => field.name === name)).filter((field): field is AppField => Boolean(field));
  return { ...section, fields: fields.map((field) => (field.name === "ec_phone" ? { ...field, label: "Phone Number" } : field)) };
}

/**
 * Later pages: the health-insurance upload moves below the questions, and the Application checklist page is dropped. Its
 * required answer is kept (always ticked, out of sight) with the Student declaration, so submission rules are unchanged.
 */
function reshapeLaterSections(list: AppSection[]): AppSection[] {
  const checklistSection = list.find((section) => section.fields.some((field) => field.name === "checklist"));
  const checklist = checklistSection?.fields.find((field) => field.name === "checklist");
  return list
    .filter((section) => section !== checklistSection)
    .map((section) => {
      if (section.fields.some((field) => field.name === "oshc_docs")) {
        return { ...section, fields: [...section.fields.filter((field) => field.name !== "oshc_docs"), ...section.fields.filter((field) => field.name === "oshc_docs")] };
      }
      if (checklist && section.fields.some((field) => field.name === "declaration")) return { ...section, fields: [...section.fields, checklist] };
      return section;
    });
}

/** Moves the education questions next to the academic documents they can be read from, and adds the language box. */
function regroupStudentSections(list: AppSection[]): AppSection[] {
  const identifier = list.find((section) => section.fields.some((field) => field.name === "employment"));
  // Year completed is asked once, with the qualification read from the documents, not again under the school level.
  const education = (identifier?.fields.filter((field) => EDUCATION_FIELD_NAMES.has(field.name) && field.name !== "year_completed") ?? []).map((field) =>
    field.name === "school_level" ? { ...field, label: "Highest completed education level", description: "Choose the highest level completed." } : field);
  return list.map((section) => {
    if (section === identifier) {
      const fields = section.fields.filter((field) => !EDUCATION_FIELD_NAMES.has(field.name));
      const at = fields.findIndex((field) => field.name === "language_home");
      return { ...section, fields: [...fields.slice(0, at + 1), LANGUAGE_OTHER_FIELD, ...fields.slice(at + 1)] };
    }
    if (section.fields.some((field) => field.name === "academic_upload")) {
      const at = section.fields.findIndex((field) => field.name === "academic_upload");
      return { ...section, fields: [...section.fields.slice(0, at + 1), ...education, ...section.fields.slice(at + 1)] };
    }
    return section;
  });
}

export const portalSections: AppSection[] = reshapeLaterSections(regroupStudentSections(enrolSections.flatMap(splitVisaSection)).map(trimEmergencyContact)).map((section) => ({
  ...section,
  fields: section.fields.map((field) => {
    if (field.name === COURSE_FIELD) {
      return { ...field, options: portalCourseOptions, description: "Search and pick one course. Only active courses open to international students are listed." };
    }
    if (field.name === "preferred_intake") {
      // INT-01: the intakes come from the database for the chosen course (IntakeSelect); none are listed here.
      return { ...field, label: "Intake", type: "select" as const, options: [], placeholder: "Choose the course first", description: "Only intakes of the chosen course that have not started yet are listed." };
    }
    return field;
  }),
}));

/** Human label for the whole application, used in review + confirmation screens. */
export function summarizeCourses(labels: string[]): string {
  if (labels.length === 0) return "No course selected";
  return labels.map((label) => label.split(" - ")[0]).join(", ");
}