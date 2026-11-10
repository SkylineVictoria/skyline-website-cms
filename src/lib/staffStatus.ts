// Staff application statuses and the allowed moves. Pure and browser-free so it is tested offline (scripts/test-staff-registration.ts).
// The database is the authority: hr.staff_transition_allowed() / the hr.staff_status_guard trigger enforce the same table, and
// every change is logged in hr.staff_status_events. This copy only decides which buttons to offer.

import { checklist, expiryState, todayIso, type ChecklistItem, type DocLike, type DocumentKind, type ExpiryRule, type ReviewState } from "@/lib/documentChecklist";

export type StaffStatus = "applied" | "invited" | "documents_submitted" | "offer_sent" | "offer_signed" | "active" | "rejected" | "inactive";
export type StaffRole = "admin" | "trainer";

export const STAFF_STATUSES: readonly StaffStatus[] = ["applied", "invited", "documents_submitted", "offer_sent", "offer_signed", "active", "rejected", "inactive"];
export const STAFF_ROLES: readonly StaffRole[] = ["admin", "trainer"];

/** No login exists before "active": the person works through emailed links (documents, re-upload, offer). */
export const STAFF_STATUS_LABEL: Record<StaffStatus, string> = {
  applied: "Applied", invited: "Invited", documents_submitted: "Documents submitted", offer_sent: "Offer sent", offer_signed: "Offer signed",
  active: "Active", rejected: "Rejected", inactive: "Inactive",
};

/** Same table as hr.staff_transition_allowed() (migration 20261110090000). Resending or revoking a link changes no status. */
const MOVES: ReadonlyArray<readonly [StaffStatus, StaffStatus]> = [
  ["applied", "invited"], ["applied", "rejected"],
  ["invited", "documents_submitted"], ["invited", "rejected"],
  ["documents_submitted", "invited"], ["documents_submitted", "offer_sent"], ["documents_submitted", "rejected"],
  ["offer_sent", "offer_signed"], ["offer_sent", "documents_submitted"], ["offer_sent", "rejected"],
  ["offer_signed", "active"], ["offer_signed", "rejected"],
  ["active", "inactive"], ["inactive", "active"], ["rejected", "applied"], ["inactive", "applied"],
];

export function canTransition(from: StaffStatus, to: StaffStatus): boolean {
  return MOVES.some(([a, b]) => a === from && b === to);
}

/**
 * Staff > Employees actions (HR-02g). Which ones are offered depends on the status AND on what exists (a live link, a rejected
 * document, an uploaded or sent offer, a pending activation invite). The database re-checks every one of them; this only decides
 * which buttons are shown, in order. Each has a confirmation dialog (EMPLOYEE_ACTION).
 */
export type EmployeeAction =
  | "send_documents_link" | "resend_documents_link" | "revoke_link" | "send_reupload_link"
  | "add_pay_details" | "edit_pay_details" | "send_offer" | "resend_offer" | "resend_login" | "withdraw_offer"
  | "activate" | "resend_activation" | "reject" | "deactivate" | "reactivate" | "reopen";
export interface EmployeeContext {
  status: StaffStatus;
  liveDocumentLink: boolean;
  rejectedDocuments: number;
  allApproved: boolean;
  /** The open (not withdrawn, not signed) offer: uploaded only, or sent. */
  offer: { sent: boolean } | null;
  activationInvited: boolean;
  /** An open job application (a Careers applicant or manual candidate): sending the document link also hires them for that job. */
  openJobApplication?: boolean;
  /** Onboarding flow: the pay details are complete (the database refuses an offer without them). */
  payComplete?: boolean;
  /** The login that went out with the offer: it exists, and the person has chosen their password. */
  hasLogin?: boolean;
  passwordSet?: boolean;
}
export function employeeActions(c: EmployeeContext): EmployeeAction[] {
  switch (c.status) {
    case "applied": return ["send_documents_link", "reject"];
    case "invited": return [...(c.liveDocumentLink ? ["resend_documents_link", "revoke_link"] as const : ["resend_documents_link"] as const), "reject"];
    case "documents_submitted": {
      const out: EmployeeAction[] = [];
      if (c.rejectedDocuments > 0) out.push("send_reupload_link");
      // Documents approved > pay details > offer: only the step that is next is offered.
      if (c.allApproved && !c.payComplete) out.push("add_pay_details");
      if (c.allApproved && c.payComplete) out.push("send_offer", "edit_pay_details");
      return [...out, "reject"];
    }
    case "offer_sent": return ["resend_offer", ...(c.hasLogin && !c.passwordSet ? ["resend_login"] as const : []), "withdraw_offer", "reject"];
    case "offer_signed": return [c.activationInvited ? "resend_activation" : "activate", ...(c.hasLogin && !c.passwordSet ? ["resend_login"] as const : []), "reject"];
    case "active": return ["deactivate"];
    case "inactive": return ["reactivate"];
    case "rejected": return ["reopen"];
    default: return [];
  }
}
/** The status an action leads to (null = the status does not change). */
export const EMPLOYEE_ACTION_TARGET: Record<EmployeeAction, StaffStatus | null> = {
  send_documents_link: "invited", resend_documents_link: null, revoke_link: null, send_reupload_link: "invited",
  add_pay_details: null, edit_pay_details: null, send_offer: "offer_sent", resend_offer: null, resend_login: null, withdraw_offer: "documents_submitted",
  activate: "active", resend_activation: null, reject: "rejected", deactivate: "inactive", reactivate: "active", reopen: "applied",
};
export interface EmployeeActionSpec { label: string; confirm: string; danger?: boolean; note?: "required" | "optional"; explain: string }
export const EMPLOYEE_ACTION: Record<EmployeeAction, EmployeeActionSpec> = {
  send_documents_link: { label: "Send document link", confirm: "Send the link", explain: "Emails a private link (valid 14 days) to add personal details and documents. No account is needed." },
  add_pay_details: { label: "Add pay details", confirm: "Save pay details", explain: "Position, employment type, start date, pay and schedule. They fill the offer letter and set up payroll." },
  edit_pay_details: { label: "Edit pay details", confirm: "Save pay details", explain: "Change the pay details before the offer goes out." },
  resend_documents_link: { label: "Resend link", confirm: "Send a new link", explain: "Emails a new private link. The earlier link stops working at once." },
  revoke_link: { label: "Revoke link", confirm: "Revoke the link", danger: true, explain: "The current link stops working. The status does not change; you can send a new link later." },
  send_reupload_link: { label: "Ask for documents again", confirm: "Send the re-upload link", explain: "Emails a link to replace only the rejected documents (with your notes). The application goes back to Invited until they send them." },
  send_offer: { label: "Send offer letter", confirm: "Send the offer", explain: "Makes the offer letter from a template and emails it with the person's sign-in link (valid 7 days). They choose their own password, then read and sign the letter." },
  resend_offer: { label: "Send the offer email again", confirm: "Send it again", explain: "Emails the offer again with a new sign-in link. An earlier link stops working at once." },
  resend_login: { label: "Resend login", confirm: "Send a new link", explain: "Emails a new one-time link to choose a password (valid 7 days). The earlier link stops working at once." },
  withdraw_offer: { label: "Withdraw offer", confirm: "Withdraw the offer", danger: true, note: "required", explain: "The offer link stops working and the application goes back to Documents submitted." },
  activate: { label: "Activate employee", confirm: "Activate", explain: "Makes them a current employee from the joining date, with the role you choose. They appear under Active and in Timesheets, Leave, Pay Schedules and the Xero export, and are emailed that their staff access is ready." },
  resend_activation: { label: "Resend activation email", confirm: "Send it again", explain: "Sends a new set-a-password email (for example when the link expired), with the role and joining date already recorded." },
  reject: { label: "Withdraw / reject", confirm: "Withdraw", danger: true, note: "required", explain: "Ends this application at any stage. Any link stops working and an unsigned offer is withdrawn. The reason is for the record; it is not sent." },
  deactivate: { label: "Mark inactive", confirm: "Mark inactive", danger: true, note: "required", explain: "Switches off their admin console access (if any) and marks them Inactive. My HR closes for them." },
  reactivate: { label: "Reactivate", confirm: "Reactivate", note: "optional", explain: "Gives back the role they had and marks them Active." },
  reopen: { label: "Reopen", confirm: "Reopen", note: "required", explain: "Moves the application back to Applications so you can send a new document link." },
};

/** Outbox and link emails as the admin sees them. */
export const EMAIL_KIND_LABEL: Record<string, string> = {
  application_received: "Application received", already_applied: "Already applied", admin_new_application: "New application (to HR)",
  document_invite: "Document link", reupload_invite: "Re-upload link", admin_documents_submitted: "Documents uploaded (to HR)",
  offer: "Offer and sign-in link", login_link: "Sign-in link", signed_offer: "Signed offer copy", admin_offer_signed: "Offer signed (to HR)", rejected: "Rejection", access_ready: "Staff access ready",
};

export const isStaffStatus = (value: unknown): value is StaffStatus => typeof value === "string" && (STAFF_STATUSES as readonly string[]).includes(value);

/** The one text a visitor sees when an email or number cannot be used. It never says whether a student, agent or admin holds it. */
export const NEUTRAL_EMAIL_MESSAGE = "This email can't be used. Sign in or contact the administrator.";
export const NEUTRAL_PHONE_MESSAGE = "This number can't be used. Sign in or contact the administrator.";

export interface StaffPrecheck { ok?: boolean; emailConflict?: boolean; phoneConflict?: boolean; reason?: string }

/** Turns the database precheck into what to show: null when the details may be used. */
export function conflictMessage(check: StaffPrecheck): { field: "email" | "phone" | "form"; message: string } | null {
  if (check.ok === true) return null;
  if (check.emailConflict) return { field: "email", message: NEUTRAL_EMAIL_MESSAGE };
  if (check.phoneConflict) return { field: "phone", message: NEUTRAL_PHONE_MESSAGE };
  if (check.reason === "invalid_phone") return { field: "phone", message: "Enter your mobile number with its country code." };
  if (check.reason === "invalid_email") return { field: "email", message: "Enter a valid email address." };
  return { field: "form", message: "Check your email address and mobile number." };
}

/* ------------------------------------------------------------------ documents (mirrors hr.staff_required_categories / hr_staff_submit) */

export { EXPIRING_SOON_DAYS, daysUntil, expiryState, todayIso, type ExpiryState } from "@/lib/documentChecklist";

export type StaffDocCategory = "Passport" | "Visa" | "English" | "Academic" | "Driving Licence" | "Health Insurance";
export type StaffDocReview = ReviewState;
/** Wizard order. */
export const STAFF_DOC_CATEGORIES: readonly StaffDocCategory[] = ["Passport", "Visa", "English", "Academic", "Driving Licence", "Health Insurance"];
export const STAFF_DOC_LABEL: Record<StaffDocCategory, string> = {
  Passport: "Passport", Visa: "Visa", English: "English test result", Academic: "Academic results", "Driving Licence": "Driving licence", "Health Insurance": "Health insurance",
};
/** Expiry date per type (hr.staff_doc_needs_expiry / hr.staff_doc_takes_expiry). */
export const STAFF_DOC_EXPIRY: Record<StaffDocCategory, ExpiryRule> = {
  Passport: "required", Visa: "required", English: "optional", Academic: "none", "Driving Licence": "required", "Health Insurance": "required",
};
/** Folder under {uid}/ in the staff-documents bucket; the database checks the same slug (hr.staff_doc_slug). */
export const staffDocSlug = (category: string): string => category.trim().toLowerCase().replace(/ /g, "-");
export const staffDocNeedsExpiry = (category: string): boolean => STAFF_DOC_EXPIRY[category as StaffDocCategory] === "required";
export const staffDocTakesExpiry = (category: string): boolean => (STAFF_DOC_EXPIRY[category as StaffDocCategory] ?? "none") !== "none";
export const staffDocAllowsMany = (category: string): boolean => category === "Academic";
/** REQUIRED types (x/N). Visa and English only for non-citizens (or while unanswered); Driving Licence is always optional. */
export function requiredStaffCategories(isAustralianCitizen: boolean | null): StaffDocCategory[] {
  return isAustralianCitizen === true ? ["Passport", "Academic", "Health Insurance"] : ["Passport", "Visa", "English", "Academic", "Health Insurance"];
}

/**
 * The document kinds shown to a person, in wizard order: every required type, the optional Driving Licence, and any other type
 * they already uploaded (e.g. a visa a citizen added before answering the citizenship question).
 */
export function staffDocKinds(isAustralianCitizen: boolean | null, uploaded: readonly { category: string }[] = []): DocumentKind[] {
  const required = requiredStaffCategories(isAustralianCitizen);
  return STAFF_DOC_CATEGORIES.filter((c) => required.includes(c) || c === "Driving Licence" || uploaded.some((d) => d.category === c))
    .map((c) => ({ category: c, label: STAFF_DOC_LABEL[c], required: required.includes(c), expiry: STAFF_DOC_EXPIRY[c], multiple: staffDocAllowsMany(c) }));
}

export type { ChecklistItem } from "@/lib/documentChecklist";
export function staffChecklist(docs: DocLike[], isAustralianCitizen: boolean | null, today = todayIso()): ChecklistItem[] {
  return checklist(staffDocKinds(isAustralianCitizen, docs), docs, today);
}

// What the applicant still needs before Submit is in src/lib/staffOnboardingWizard.ts (wizardProblems), which mirrors hr_svc_onboarding_submit.

/** Badge tone per status (admin lists). */
export const STAFF_STATUS_TONE: Record<StaffStatus, "muted" | "warn" | "secondary" | "success" | "primary" | "accent"> = {
  applied: "warn", invited: "secondary", documents_submitted: "warn", offer_sent: "secondary", offer_signed: "primary",
  active: "success", rejected: "muted", inactive: "muted",
};

/* ------------------------------------------------------------------ admin Staff > Employees tabs (hr_admin_staff_list p_statuses) */

export type EmployeeTabId = "applications" | "invited" | "documents" | "offers" | "active" | "closed";
export interface EmployeeTab { id: EmployeeTabId; label: string; statuses: readonly StaffStatus[]; countBadge: boolean }
/** Every status is in exactly one tab; a count badge marks the tabs that wait for an administrator. */
export const EMPLOYEE_TABS: readonly EmployeeTab[] = [
  { id: "applications", label: "Applications", statuses: ["applied"], countBadge: true },
  { id: "invited", label: "Invited", statuses: ["invited"], countBadge: false },
  { id: "documents", label: "Documents submitted", statuses: ["documents_submitted"], countBadge: true },
  { id: "offers", label: "Offers", statuses: ["offer_sent", "offer_signed"], countBadge: true },
  { id: "active", label: "Active", statuses: ["active"], countBadge: false },
  { id: "closed", label: "Rejected/Inactive", statuses: ["rejected", "inactive"], countBadge: false },
];
export const employeeTab = (id: string | null | undefined): EmployeeTab => EMPLOYEE_TABS.find((t) => t.id === id) ?? EMPLOYEE_TABS[0];

/* ------------------------------------------------------------------ onboarding stages (hr.onboarding_stage) */

export type OnboardingStage = "applied" | "shortlisted" | "documents_requested" | "documents_submitted" | "documents_approved" | "pay_details" | "offer_sent" | "offer_signed" | "active";
export const ONBOARDING_STAGES: readonly OnboardingStage[] = ["applied", "shortlisted", "documents_requested", "documents_submitted", "documents_approved", "pay_details", "offer_sent", "offer_signed", "active"];
export const ONBOARDING_STAGE_LABEL: Record<OnboardingStage, string> = {
  applied: "Applied", shortlisted: "Shortlisted", documents_requested: "Documents requested", documents_submitted: "Documents submitted",
  documents_approved: "Documents approved", pay_details: "Pay details added", offer_sent: "Offer sent", offer_signed: "Offer signed", active: "Active",
};
/** The banner under the stepper: what the stage means and what happens next. */
export const ONBOARDING_STAGE_HINT: Record<OnboardingStage, string> = {
  applied: "New application. Send the document link when you are ready to continue.",
  shortlisted: "Shortlisted. Send the document link to start onboarding.",
  documents_requested: "The document link is out. Waiting for the person to add their details and documents.",
  documents_submitted: "The documents are in. Approve or reject each one.",
  documents_approved: "Every required document is approved. Add the pay details next.",
  pay_details: "The pay details are in. Send the offer letter next.",
  offer_sent: "The offer is out with the person's sign-in link. Waiting for them to sign.",
  offer_signed: "The offer is signed. Activate them to make them a current employee.",
  active: "Current employee.",
};

/** Problems with the pay details form, by field (the database checks the same rules in hr_admin_onboarding_pay_save). */
export interface PayDetailsInput {
  jobTitle: string; employmentType: string; startDate: string; payBasis: string; rate: string; payScheduleId: string; hoursPerWeek: string;
}
export function payDetailsProblems(input: PayDetailsInput, today = todayIso()): Partial<Record<keyof PayDetailsInput, string>> {
  const problems: Partial<Record<keyof PayDetailsInput, string>> = {};
  if (!input.jobTitle.trim()) problems.jobTitle = "Enter the position (job title).";
  else if (input.jobTitle.trim().length > 150) problems.jobTitle = "Keep the position under 150 characters.";
  if (!["full_time", "part_time", "casual"].includes(input.employmentType)) problems.employmentType = "Choose the employment type.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || Number.isNaN(Date.parse(`${input.startDate}T00:00:00Z`))) problems.startDate = "Enter the start date.";
  else {
    const days = Math.round((Date.parse(`${input.startDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (days < -365 || days > 730) problems.startDate = "The start date must be within the last year or the next two years.";
  }
  if (input.payBasis !== "hourly" && input.payBasis !== "salary") problems.payBasis = "Choose hourly or annual.";
  const rate = Number(input.rate);
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(input.rate.trim()) || !(rate > 0)) problems.rate = "Enter the pay rate as a number, for example 38.50.";
  else if (input.payBasis === "hourly" && rate > 1000) problems.rate = "That hourly rate looks too high. Check the pay basis.";
  else if (input.payBasis === "salary" && rate < 1000) problems.rate = "That annual salary looks too low. Check the pay basis.";
  if (!input.payScheduleId) problems.payScheduleId = "Choose the pay schedule.";
  const hours = Number(input.hoursPerWeek);
  if (!input.hoursPerWeek.trim()) { if (input.employmentType !== "casual") problems.hoursPerWeek = "Enter the hours per week."; }
  else if (!/^\d{1,2}(\.\d{1,2})?$/.test(input.hoursPerWeek.trim()) || !(hours > 0) || hours > 80) problems.hoursPerWeek = "The hours per week must be between 1 and 80.";
  return problems;
}

/** HRMS > Employees > Onboarding table: the document link a row can send: the first one (Applied) or a new one replacing the current link (Invited). */
export const linkActionFor = (status: StaffStatus): "send" | "resend" | null =>
  status === "applied" ? "send" : status === "invited" ? "resend" : null;
