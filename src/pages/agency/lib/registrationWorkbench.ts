// Pure, browser-safe helpers for the manual registration workbench. The database is the authority for every rule here
// (it re-validates each command); these only keep the operator from sending requests that are certain to be refused.
// No part of this module talks to any government or external system.

export type RegistrationState = "draft" | "lodged" | "verified" | "cancelled";
export type RegistrationAction = "create" | "lodge" | "verify" | "cancel";

const COE_PATTERN = /^[A-Z0-9-]{6,20}$/;

export interface CoeCheck { ok: boolean; value?: string; error?: string }

export function normaliseCoeNumber(raw: string): CoeCheck {
  const value = raw.trim().toUpperCase();
  if (!COE_PATTERN.test(value)) return { ok: false, error: "Enter the CoE number as 6 to 20 letters, digits or hyphens." };
  return { ok: true, value };
}

/** coe_issued/enrolled without a verified registration is a warning for the operator, never a block. */
export function registrationWarning(applicationStatus: string, state: RegistrationState | null | undefined): boolean {
  return (applicationStatus === "coe_issued" || applicationStatus === "enrolled") && state !== "verified";
}

export function availableActions(state: RegistrationState | null | undefined): RegistrationAction[] {
  switch (state) {
    case "draft": return ["lodge", "cancel"];
    case "lodged": return ["verify", "cancel"];
    case "verified": return ["cancel"];
    default: return ["create"];
  }
}

export interface ChecklistInput { applicationStatus: string; state: RegistrationState | null | undefined; evidenceCount: number; coeNumber: string | null | undefined }
export interface ChecklistItem { key: string; label: string; done: boolean }

export function registrationChecklist(input: ChecklistInput): ChecklistItem[] {
  const progressed = input.state === "lodged" || input.state === "verified";
  return [
    { key: "status", label: "The offer is accepted or later (the application status; this is not a registration)", done: ["offer_accepted", "coe_issued", "enrolled"].includes(input.applicationStatus) },
    { key: "lodged", label: "Registered in the external system by hand and marked as lodged", done: progressed },
    { key: "evidence", label: "Evidence recorded (confirmation page, CoE document or correspondence)", done: input.evidenceCount > 0 },
    { key: "coe", label: "CoE number entered", done: Boolean(input.coeNumber) },
    { key: "verified", label: "Verified by an operator", done: input.state === "verified" },
  ];
}

/** Reasons verification would be refused; an empty list means the form may be submitted. */
export function verifyBlockers(input: ChecklistInput & { coeInput: string }): string[] {
  const blockers: string[] = [];
  if (input.state !== "lodged") blockers.push("Mark the registration as lodged first.");
  if (!["offer_accepted", "coe_issued", "enrolled"].includes(input.applicationStatus)) blockers.push("The offer must be accepted before registration can be verified.");
  if (input.evidenceCount < 1) blockers.push("Record at least one piece of evidence.");
  const coe = normaliseCoeNumber(input.coeInput);
  if (!coe.ok && coe.error) blockers.push(coe.error);
  return blockers;
}

// ---- export (minimized) --------------------------------------------------------------------------
export const EXPORT_COLUMNS = ["reference", "studentName", "intake", "courses", "applicationStatus", "registrationState", "coeNumber", "lodgedAt", "verifiedAt"] as const;
export const EXPORT_HEADERS: Record<(typeof EXPORT_COLUMNS)[number], string> = {
  reference: "Reference", studentName: "Student", intake: "Intake", courses: "Courses", applicationStatus: "Application status",
  registrationState: "Registration state", coeNumber: "CoE number", lodgedAt: "Lodged", verifiedAt: "Verified",
};

/** One CSV cell: quoted when needed, and neutralised against spreadsheet formula injection. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Only the fixed export columns are ever written; any extra field on a row is dropped. */
export function exportCsv(rows: Record<string, unknown>[]): string {
  const lines = [EXPORT_COLUMNS.map((c) => csvCell(EXPORT_HEADERS[c])).join(",")];
  for (const row of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

// ---- reconciliation (P08-03) ----------------------------------------------------------------------
export type ExceptionKind = "enrolled_without_verified" | "lodged_stale" | "verified_application_closed" | "possible_duplicate";

export const EXCEPTION_TEXT: Record<ExceptionKind, { label: string; explanation: string }> = {
  enrolled_without_verified: { label: "Enrolled without a verified registration", explanation: "The application reads enrolled, but no registration has been verified. Record the registration, or accept the exception with a note." },
  lodged_stale: { label: "Lodged but not verified", explanation: "The registration was marked as lodged more than 14 days ago and has not been verified. Check the external system, then verify or cancel it." },
  verified_application_closed: { label: "Verified registration on a closed application", explanation: "The application is withdrawn or rejected but still holds a verified registration. Cancel it once the external record has been cancelled by hand." },
  possible_duplicate: { label: "Possible duplicate student", explanation: "Another application with the same student name and date of birth also holds a verified registration. Review both before accepting." },
};

/** Reasons a CoE correction would be refused; the database re-checks all of them. */
export function validateCorrection(currentCoe: string | null | undefined, newInput: string, reason: string): string[] {
  const problems: string[] = [];
  const coe = normaliseCoeNumber(newInput);
  if (!coe.ok && coe.error) problems.push(coe.error);
  else if (coe.value && coe.value === currentCoe) problems.push("That is already the recorded CoE number.");
  if (!reason.trim()) problems.push("Give the reason for the correction.");
  return problems;
}
