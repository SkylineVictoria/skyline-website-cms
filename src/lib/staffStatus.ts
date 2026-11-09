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

/** Same table as hr.staff_transition_allowed() (migration 20261109100000). Resending or revoking a link changes no status. */
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
  | "upload_offer" | "send_offer" | "resend_offer" | "withdraw_offer"
  | "activate" | "resend_activation" | "reject" | "deactivate" | "reactivate" | "reopen";
export interface EmployeeContext {
  status: StaffStatus;
  liveDocumentLink: boolean;
  rejectedDocuments: number;
  allApproved: boolean;
  /** The open (not withdrawn, not signed) offer: uploaded only, or sent. */
  offer: { sent: boolean } | null;
  activationInvited: boolean;
}
export function employeeActions(c: EmployeeContext): EmployeeAction[] {
  switch (c.status) {
    case "applied": return ["send_documents_link", "reject"];
    case "invited": return [...(c.liveDocumentLink ? ["resend_documents_link", "revoke_link"] as const : ["resend_documents_link"] as const), "reject"];
    case "documents_submitted": {
      const out: EmployeeAction[] = [];
      if (c.rejectedDocuments > 0) out.push("send_reupload_link");
      if (c.allApproved) out.push("upload_offer");
      if (c.allApproved && c.offer && !c.offer.sent) out.push("send_offer");
      return [...out, "reject"];
    }
    case "offer_sent": return ["resend_offer", "withdraw_offer", "reject"];
    case "offer_signed": return [c.activationInvited ? "resend_activation" : "activate", "reject"];
    case "active": return ["deactivate"];
    case "inactive": return ["reactivate"];
    case "rejected": return ["reopen"];
    default: return [];
  }
}
/** The status an action leads to (null = the status does not change). */
export const EMPLOYEE_ACTION_TARGET: Record<EmployeeAction, StaffStatus | null> = {
  send_documents_link: "invited", resend_documents_link: null, revoke_link: null, send_reupload_link: "invited",
  upload_offer: null, send_offer: "offer_sent", resend_offer: null, withdraw_offer: "documents_submitted",
  activate: "active", resend_activation: null, reject: "rejected", deactivate: "inactive", reactivate: "active", reopen: "applied",
};
export interface EmployeeActionSpec { label: string; confirm: string; danger?: boolean; note?: "required" | "optional"; explain: string }
export const EMPLOYEE_ACTION: Record<EmployeeAction, EmployeeActionSpec> = {
  send_documents_link: { label: "Send document link", confirm: "Send the link", explain: "Emails a private link (valid 14 days) to add personal details and documents. No account is needed." },
  resend_documents_link: { label: "Send the link again", confirm: "Send a new link", explain: "Emails a new private link. The earlier link stops working at once." },
  revoke_link: { label: "Revoke link", confirm: "Revoke the link", danger: true, explain: "The current link stops working. The status does not change; you can send a new link later." },
  send_reupload_link: { label: "Ask for documents again", confirm: "Send the re-upload link", explain: "Emails a link to replace only the rejected documents (with your notes). The application goes back to Invited until they send them." },
  upload_offer: { label: "Upload offer letter", confirm: "Upload", explain: "PDF, 7 MB or smaller, not password-protected. It is checked before it is stored. An unsent offer is replaced." },
  send_offer: { label: "Send offer", confirm: "Send the offer", explain: "Emails a private link (valid 30 days) to read and sign the offer letter on the page." },
  resend_offer: { label: "Send the offer link again", confirm: "Send a new link", explain: "Emails a new offer link. The earlier link stops working at once." },
  withdraw_offer: { label: "Withdraw offer", confirm: "Withdraw the offer", danger: true, note: "required", explain: "The offer link stops working and the application goes back to Documents submitted." },
  activate: { label: "Activate account", confirm: "Activate", explain: "Grants the role from the joining date. A person who already has a confirmed login is active at once (and emailed); everyone else gets an email to set a password." },
  resend_activation: { label: "Resend activation email", confirm: "Send it again", explain: "Sends a new set-a-password email (for example when the link expired), with the role and joining date already recorded." },
  reject: { label: "Reject", confirm: "Reject", danger: true, note: "required", explain: "Ends this application. Any link stops working and an unsigned offer is withdrawn. The note is for the record; it is not sent." },
  deactivate: { label: "Deactivate", confirm: "Deactivate", danger: true, note: "optional", explain: "Switches off their admin console access (if any) and marks them Inactive. My HR closes for them." },
  reactivate: { label: "Reactivate", confirm: "Reactivate", note: "optional", explain: "Gives back the role they had and marks them Active." },
  reopen: { label: "Reopen", confirm: "Reopen", note: "required", explain: "Moves the application back to Applications so you can send a new document link." },
};

/** Outbox and link emails as the admin sees them. */
export const EMAIL_KIND_LABEL: Record<string, string> = {
  application_received: "Application received", already_applied: "Already applied", admin_new_application: "New application (to HR)",
  document_invite: "Document link", reupload_invite: "Re-upload link", admin_documents_submitted: "Documents uploaded (to HR)",
  offer: "Offer link", signed_offer: "Signed offer copy", admin_offer_signed: "Offer signed (to HR)", rejected: "Rejection", access_ready: "Staff access ready",
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

/** Everything the applicant needs before Submit, in the order the wizard shows it. Mirrors hr_svc_onboarding_submit. */
export interface StaffSubmitInput {
  firstName: string; lastName: string; dateOfBirth: string | null; addressStreet: string; addressCountry: string;
  emergencyName: string; emergencyRelationship: string; emergencyPhone: string | null;
  isAustralianCitizen: boolean | null; documents: Array<{ category: string; expiryDate: string | null }>;
}
const MISSING: Partial<Record<StaffDocCategory, string>> = {
  Passport: "Upload your passport.", Visa: "Upload your visa.", English: "Upload your English test result.", Academic: "Upload your academic results.", "Health Insurance": "Upload your health insurance.",
};
export function submitProblems(input: StaffSubmitInput, today = todayIso()): string[] {
  const problems: string[] = [];
  if (!input.firstName.trim() || !input.lastName.trim()) problems.push("Enter your first and last name.");
  if (!input.dateOfBirth) problems.push("Enter your date of birth.");
  if (!input.addressStreet.trim() || !input.addressCountry.trim()) problems.push("Enter your address.");
  if (!input.emergencyName.trim() || !input.emergencyRelationship.trim() || !input.emergencyPhone) problems.push("Enter an emergency contact: name, relationship and phone.");
  if (input.isAustralianCitizen === null) problems.push("Tell us whether you are an Australian citizen.");
  for (const category of requiredStaffCategories(input.isAustralianCitizen)) {
    const mine = input.documents.filter((d) => d.category === category);
    if (!mine.length) problems.push(MISSING[category] ?? `Upload your ${STAFF_DOC_LABEL[category].toLowerCase()}.`);
    else if (mine.some((d) => (!d.expiryDate && staffDocNeedsExpiry(category)) || expiryState(d.expiryDate, today) === "expired")) {
      problems.push(`Enter a current expiry date for your ${category === "English" ? "English test result" : category.toLowerCase()}.`);
    }
  }
  return problems;
}

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
