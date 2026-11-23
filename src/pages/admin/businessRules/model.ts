import { emailSections } from "@/pages/admin/lib/emailMenu";
import { LMS_MENU } from "@/pages/admin/lms/lmsConfig";
import type { AdminMenuItem } from "@/pages/admin/lib/adminMenu";

export const rulesRoute = "/admin/business-rules";
export const timetableRulesScope = "lms/timetable-settings";
export const reschedulingEditor = "rescheduling";
export const timetableRulesRoute = `${rulesRoute}?${new URLSearchParams({ menu: timetableRulesScope })}`;
export const reschedulingRulesRoute = `${timetableRulesRoute}&${new URLSearchParams({ editor: reschedulingEditor })}`;
export const valueTypes = ["number", "percentage", "text", "boolean", "date", "time", "days", "hours", "weeks", "currency", "dropdown", "multiple selection", "list", "json"] as const;
export const operators = ["equals", "not equals", "greater than", "less than", "contains", "does not contain", "between", "is empty", "is not empty", "before", "after"] as const;
export type Condition = { field: string; operator: string; operand: unknown };
export type Group = { match: "all" | "any"; conditions: Condition[] };
export type Definition = {
  name: string; identifier: string; category_id: string; scope: string; entity: string; description: string;
  value_type: string; value: unknown; options: string[]; groups: Group[]; match: "all" | "any";
  then_action: string; else_action: string; priority: number; starts_on: string; ends_on: string;
  enabled: boolean; approval_required: boolean; source_url: string; notes: string;
};
// rule-policy: technical version-shape Reflects stored version states and publication timestamps.
export type Version = { id: string; rule_id: string; version: number; state: "draft" | "published" | "superseded" | "reference"; published_at?: string | null; definition: Definition; created_at: string; origin: string; approved_by: string | null };
export type Category = { id: string; name: string };
export type Rule = { id: string; identifier: string; registration: { scope: string; entity: string; value_type: string; handler?: string } | null; versions: Version[] };
export type RegistryField = { key: string; label: string; value_type: string; scope: string };
export type Audit = { id: string; rule_id: string; action: string; actor: string; reason: string; created_at: string; before_data: Definition | null; after_data: Definition | null };
export type Snapshot = { categories: Category[]; rules: Rule[]; fields: RegistryField[]; history: Audit[] };
export type RuleLocation = { id: string; label: string; route: string | null; parent: string | null };

export const newDefinition = (scope: string, category_id: string): Definition => ({
  name: "", identifier: "", category_id, scope, entity: "", description: "", value_type: "number",
  value: null, options: [], groups: [], match: "all", then_action: "use_value", else_action: "none",
  priority: 0, starts_on: "", ends_on: "", enabled: true, approval_required: false, source_url: "", notes: "",
});

export function ruleLocations(rows: AdminMenuItem[]): RuleLocation[] {
  const locations = rows.filter(row => row.is_enabled && row.route !== "/" && row.route !== rulesRoute)
    .map(row => ({ id: row.id, label: row.label, route: row.route, parent: row.parent_id }));
  locations.push({ id: "lms", label: "Learning Management", parent: null, route: null },
    { id: "lms/timetable", label: "Timetable", parent: "lms", route: null });
  for (const item of LMS_MENU) {
    locations.push({ id: `lms/${item.id}`, label: item.label, route: item.route, parent: item.parent ? `lms/${item.parent}` : "lms" });
  }
  locations.push({ id: "email_management", label: "Email Management", parent: null, route: null });
  for (const section of emailSections) {
    locations.push({ id: `email_management/${section.id}`, label: section.label, parent: "email_management", route: `/admin/email-management?section=${section.id}` });
  }
  const communication = locations.find(item => item.id === "communications");
  if (communication && !locations.some(item => item.route === "/admin/communication")) {
    locations.push({ id: "communication_hub", label: "Communication Hub", parent: communication.id, route: "/admin/communication" });
  }
  return locations;
}

export function locationLabel(locations: RuleLocation[], id: string): string {
  const labels: string[] = [];
  const seen = new Set<string>();
  let node = locations.find(item => item.id === id);
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    labels.unshift(node.label);
    node = locations.find(item => item.id === node?.parent);
  }
  return labels.join(" → ") || id;
}

export function appliesTo(locations: RuleLocation[], scope: string, selected: string): boolean {
  const seen = new Set<string>();
  let current: string | null = scope;
  while (current && !seen.has(current)) {
    if (current === selected) return true;
    seen.add(current);
    current = locations.find(item => item.id === current)?.parent ?? null;
  }
  return false;
}

export function valueSummary(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export const awaitingIntegration = (rule?: Rule) => rule?.registration?.handler === "inventory_only";

export function definitionSummary(definition: Definition) {
  const value = valueSummary(definition.value);
  if (definition.value_type === "percentage") return value + "%";
  // rule-policy: technical display-units Formats the stored type for display without changing the value.
  if (["days", "hours", "weeks"].includes(definition.value_type)) return `${value} ${definition.value_type}`;
  return value;
}

/*
 * Owner (2026-11-22): the Advanced tab lists only real business choices. Every other rule is a system detail (file sizes, formats,
 * workflow steps, defaults the screens already set, offer-letter wording, rescheduling steps that have their own screen); it keeps
 * its value and still works, and shows only after "Show system rules".
 */
// rule-policy: technical rule-visibility Which existing rules the Advanced tab shows by default; no value changes.
export const BUSINESS_RULE_IDS = new Set([
  "admissions.application_required_documents", "admissions.english_minimum_scores", "admissions.english_result_valid_years",
  "admissions.english_test_alternatives", "admissions.document_expiry_warning_months", "admissions.offer_letter_recipient",
  "admissions.offer_unanswered_days", "admissions.offer_accept_in_portal", "admissions.usi_required", "admissions.withdrawal_class_removal",
  "admissions.guest_link_required_documents",
  "agents.activation_reference_minimum", "agents.agreement_term_years", "agents.commission_suggested", "agents.business_approval_waits_for_referees",
  "agents.cancelled_abn_business", "agents.agency_witness_on_agreement", "agents.slit_witness_on_agreement", "agents.referee_emails_must_differ",
  "agents.review_email_recipients",
  "assessment.attempts_default", "assessment.due_soon_days", "assessment.late_submission_default",
  "auth.password_min_staff", "auth.password_min_students_agents",
  "booking.reminder_hours", "booking.new_type_duration", "booking.new_type_min_notice",
  "finance.deposit_reminder_default_enabled", "finance.deposit_automatic_reminder_interval", "finance.deposit_automatic_reminder_cap",
  "finance.course_fee_deposit_cap", "finance.course_fee_suggestions",
  "hrms.applicant_document_checklist", "hrms.breaks_paid_default", "hrms.default_ordinary_hours", "hrms.usual_workdays",
  "hrms.document_expiring_soon_days", "hrms.staff_document_link_days", "hrms.staff_offer_link_days", "hrms.pay_frequencies",
  "hrms.rejected_reapply_days", "hrms.staff_minimum_age",
  "lms.attendance_alert_threshold", "lms.attendance_alert_min_marks", "lms.coe_weekly_study_hours", "lms.voe_weekly_study_hours",
  "lms.course_working_days", "lms.join_dates", "lms.optional_holidays_stop_classes", "lms.auto_intake_create", "lms.course_auto_go_live",
  "lms.intake_manual_placement_reason",
  "support.ticket_categories", "support.ticket_priority_default", "support.requester_can_close",
  "website.assistant_daily_answers",
]);
export const isSystemRule = (rule: Rule) => !rule.identifier.startsWith("lms.bulk_") && !BUSINESS_RULE_IDS.has(rule.identifier);
