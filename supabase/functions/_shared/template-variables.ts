// The one registry of [Variable Name] template variables (TPL-02). Runtime-neutral; the editor's picker, the save checks, the Edge
// Function's renderer and the tests all read this list, so a name means the same thing everywhere.
//
// A variable resolves in one of three ways:
//   value   from the record (hr.sign_subject: student.*, course.*, employee.*, agent.*) or what the sender typed, tried in `keys` order;
//   render  filled while the PDF is laid out: [Page Number], [Total Pages];
//   field   filled by the signer when they sign: [Student Initial] (their initials, on every page it appears).
// Any [token] that is not here becomes a text field the signer fills in on the signing screen before signing (label = the token).
// To add one (for example [USI] later): add an entry with the record key that holds it; nothing else changes.
import { BRACKET_TOKEN, bracketTokens, isTokenName, tokenName } from "./rich-html.ts";

export type VariableGroup = "Document" | "Student" | "Course" | "Agent" | "Employee" | "Recipient" | "Signer";
export interface TemplateVariable {
  name: string;
  group: VariableGroup;
  description: string;
  keys?: readonly string[];
  render?: "page" | "total";
  field?: "initials";
  sample: string;
}

export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { name: "Page Number", group: "Document", description: "The number of the page it is printed on", render: "page", sample: "1" },
  { name: "Total Pages", group: "Document", description: "How many pages the document has", render: "total", sample: "3" },
  { name: "Date", group: "Document", description: "Today's date (Melbourne) when the document is made", keys: ["current_date"], sample: "11 November 2026" },
  { name: "Student Name", group: "Student", description: "Full name", keys: ["student.full_name"], sample: "Asha Patel" },
  { name: "Student First Name", group: "Student", description: "First name", keys: ["student.first_name"], sample: "Asha" },
  { name: "Student Last Name", group: "Student", description: "Last name", keys: ["student.last_name"], sample: "Patel" },
  { name: "Student ID", group: "Student", description: "The application reference", keys: ["student.id"], sample: "APP-2026-000123" },
  { name: "Student Email", group: "Student", description: "Email address", keys: ["student.email"], sample: "asha.patel@example.com" },
  { name: "Student Phone", group: "Student", description: "Mobile number", keys: ["student.phone"], sample: "+61 412 345 678" },
  { name: "Student Address", group: "Student", description: "Home address", keys: ["student.address"], sample: "1 Example Street, Melbourne VIC 3000" },
  { name: "Date of Birth", group: "Student", description: "Date of birth", keys: ["student.date_of_birth"], sample: "2001-04-12" },
  { name: "Passport Number", group: "Student", description: "Passport number", keys: ["student.passport_number"], sample: "N1234567" },
  { name: "Nationality", group: "Student", description: "Nationality", keys: ["student.nationality"], sample: "India" },
  { name: "Course Name", group: "Course", description: "The course applied for", keys: ["course.name"], sample: "Diploma of Business" },
  { name: "Course Code", group: "Course", description: "National course code", keys: ["course.code"], sample: "BSB50120" },
  { name: "CRICOS Code", group: "Course", description: "CRICOS course code", keys: ["course.cricos"], sample: "0101234" },
  { name: "Course Fees", group: "Course", description: "Fees from the course page", keys: ["course.fees"], sample: "AUD 14,000" },
  { name: "Course Duration", group: "Course", description: "Duration from the course page", keys: ["course.duration"], sample: "52 weeks" },
  { name: "Intake", group: "Course", description: "The intake chosen on the enrolment form", keys: ["course.intake"], sample: "February 2027" },
  { name: "Start Date", group: "Course", description: "Start date of the chosen intake (an employee's start date on staff documents)", keys: ["course.start_date", "employee.start_date"], sample: "3 February 2027" },
  { name: "End Date", group: "Course", description: "End date of the chosen intake, when staff recorded one", keys: ["course.end_date"], sample: "2 February 2028" },
  { name: "Agent Name", group: "Agent", description: "The student's agent (or the agent the document is for)", keys: ["agent.name"], sample: "Ravi Kumar" },
  { name: "Agency Name", group: "Agent", description: "The agent's business", keys: ["agency.name"], sample: "Example Education Services" },
  { name: "Agent Email", group: "Agent", description: "The agent's email", keys: ["agent.email"], sample: "ravi@example.com" },
  { name: "MARN", group: "Agent", description: "The agent's MARN", keys: ["agent.marn"], sample: "1234567" },
  { name: "Employee Name", group: "Employee", description: "Full name", keys: ["employee.name"], sample: "Sam Lee" },
  { name: "Employee Email", group: "Employee", description: "Email address", keys: ["employee.email"], sample: "sam.lee@example.com" },
  { name: "Position", group: "Employee", description: "Job title", keys: ["employee.position"], sample: "Trainer" },
  { name: "Department", group: "Employee", description: "Department", keys: ["employee.department"], sample: "Trades" },
  { name: "Employment Type", group: "Employee", description: "Full time, part time or contract", keys: ["employee.employment_type"], sample: "full time" },
  { name: "Work Location", group: "Employee", description: "Work location", keys: ["employee.work_location"], sample: "Melbourne" },
  { name: "Recipient Name", group: "Recipient", description: "Name of the first person who signs", keys: ["full_name"], sample: "Asha Patel" },
  { name: "Recipient Email", group: "Recipient", description: "Email of the first person who signs", keys: ["email"], sample: "asha.patel@example.com" },
  { name: "Student Initial", group: "Signer", description: "The signer's initials, added on every page when they sign", field: "initials", sample: "AP" },
];

const BY_NAME = new Map(TEMPLATE_VARIABLES.map((v) => [v.name.toLowerCase(), v]));
/** The registry entry for a token (case and spacing do not matter), or undefined when the token is a field for the signer. */
export const lookupVariable = (name: string): TemplateVariable | undefined => BY_NAME.get(tokenName(name).toLowerCase());

export type TokenResolution =
  | { kind: "value"; text: string }
  | { kind: "missing"; name: string }
  | { kind: "page" | "total" }
  | { kind: "field"; field: "text" | "initials"; label: string }
  | { kind: "literal" };

/** How the renderer treats one token, for a set of record values. `sample` shows [Name] instead of refusing a missing value. */
export function resolveToken(raw: string, values: Record<string, unknown>, sample = false): TokenResolution {
  if (!isTokenName(raw)) return { kind: "literal" };
  const spec = lookupVariable(raw);
  if (!spec) return { kind: "field", field: "text", label: tokenName(raw) };
  if (spec.render) return { kind: spec.render };
  if (spec.field) return { kind: "field", field: spec.field, label: spec.name };
  for (const key of spec.keys ?? []) {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (typeof value === "string" && value.trim()) return { kind: "value", text: value.trim().slice(0, 2000) };
  }
  return sample ? { kind: "value", text: `[${spec.name}]` } : { kind: "missing", name: spec.name };
}

export interface TokenReport {
  /** Registry variables used (filled from the record or typed by the sender). */
  known: string[];
  /** Tokens the signer fills in on the signing screen (one input each). */
  fields: string[];
  /** [Page Number], [Total Pages], [Student Initial]: filled while the PDF is made or when the person signs. */
  automatic: string[];
}
/** What the template's text asks for, by kind; the editor shows this before saving. */
export function tokenReport(texts: readonly string[]): TokenReport {
  const report: TokenReport = { known: [], fields: [], automatic: [] };
  for (const name of bracketTokens(texts.join("\n"))) {
    const spec = lookupVariable(name);
    const list = !spec ? report.fields : spec.render || spec.field ? report.automatic : report.known;
    const shown = spec?.name ?? name;
    if (!list.includes(shown)) list.push(shown);
  }
  return report;
}

/** The record keys a template's registry variables read (for the sender's "values" form). */
export function variableKeys(texts: readonly string[]): Array<{ name: string; key: string }> {
  return tokenReport(texts).known.map((name) => ({ name, key: lookupVariable(name)!.keys![0] }));
}

/** Label of a signer field made from a token (kept in brackets so the signing page and the function know it came from a token). */
export const tokenFieldLabel = (name: string) => `[${tokenName(name)}]`;
export const isTokenFieldLabel = (label: string | null | undefined) => /^\[[^[\]]{1,80}\]$/.test(String(label ?? ""));
export const tokenFieldName = (label: string) => label.replace(/^\[|\]$/g, "");
export { BRACKET_TOKEN };
