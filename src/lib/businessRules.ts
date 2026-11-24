// Live Business Rules values for the screens (BUSINESS-RULES-LIVE). SLIT sets them on Administration › Business Rules;
// the screens read them through these getters, which fall back to the old fixed value until the values have loaded
// (or when a rule is switched off). Loaded once at start-up (main.tsx) and again when Business Rules are saved.
import { supabase } from "@/pages/admin/lib/supabase";

/** Every rule a screen reads. Add an identifier here when a screen starts reading a new rule. */
export const SCREEN_RULES = [
  "finance.course_fee_deposit_cap",
  "finance.course_fee_nonrefundable_defaults",
  "finance.course_fee_suggestions",
  "finance.course_total_excluded_default",
  "support.ticket_attachment_limit_mib",
  "lms.attendance_alert_threshold",
  "lms.attendance_alert_min_marks",
  "lms.attendance_mark_treatment",
  "lms.unit_duration_weekly_hours",
  "lms.unit_duration_rounding_weeks",
  "lms.unit_duration_ceiling",
  "lms.unit_hours_split",
  "lms.coe_weekly_study_hours",
  "lms.voe_weekly_study_hours",
  "lms.intake_name_format",
  "lms.intake_suggested_start_day",
  "lms.intake_suggested_notice_days",
  "lms.class_suggested_day_cap",
  "lms.class_setup_availability_fallback",
  "lms.elective_automatic_selection_order",
  "lms.reschedule_new_day_hours",
  "lms.reschedule_new_day_search_days",
  "lms.reschedule_new_day_weekdays",
  "lms.reschedule_join_extra_seats",
  "lms.reschedule_spread_limits",
  "cms.cms_document_limit_mib",
  "cms.footer_label_char_cap",
  "cms.footer_links_per_column",
  "cms.homepage_course_cap",
  "cms.navigation_child_cap",
  "cms.navigation_label_char_cap",
  "cms.navigation_top_level_cap",
  "assessment.attempts_allowed_range",
  "assessment.attempts_default",
  "assessment.reassessment_window_default",
  "assessment.short_response_default_word_cap",
  "assessment.repeat_group_entry_limits",
  "assessment.evidence_question_defaults",
  "hrms.applicant_document_checklist",
  "hrms.staff_document_expiry_rules",
  "hrms.staff_multiple_academic_documents",
  "hrms.staff_onboarding_workflow",
  "hrms.staff_pay_start_date_range",
  "hrms.staff_pay_validation_bounds",
  "hrms.staff_weekly_hours_cap",
  "hrms.staff_weekly_hours_required",
  "hrms.cover_letter_limit_chars",
  "hrms.job_attachment_limit_mib",
  "hrms.employee_document_max_bytes",
  "admissions.application_mobile_required",
  "admissions.application_document_limit_mib",
  "admissions.application_document_types",
  "admissions.australian_address_required_fields",
  "admissions.overseas_address_required_fields",
  "admissions.emergency_contact_required_details",
  "admissions.registration_verification_prerequisites",
  "admissions.registration_stale_lodgement_days",
  "admissions.registration_coe_voe_pdf_mib",
  "agents.agent_application_yes_no_fallback",
  "agents.agent_application_attachment_cap_mib",
  "lms.voe_threshold_weekly_hours",
  "lms.class_suggestion_preferred_days",
  "lms.class_suggestion_hours",
  "lms.class_block_hours",
  "lms.class_preferred_start_times",
  "lms.manual_placement_default_type",
  "lms.assessment_assignment_default_days",
  "agents.agreement_term_years",
  "agents.agency_witness_on_agreement",
  "agents.referee_emails_must_differ",
  "agents.business_approval_waits_for_referees",
  "agents.slit_witness_on_agreement",
  "agents.cancelled_abn_business",
  "agents.signed_copy_upload_max_mb",
  "admissions.document_expiry_warning_months",
  "admissions.english_result_valid_years",
  "admissions.english_test_alternatives",
  "admissions.english_minimum_scores",
  "admissions.application_required_documents",
  "admissions.passport_reject_expired",
  "admissions.passport_auto_delete_expired",
  "admissions.passport_require_expiry_date",
  "admissions.academic_minimum_documents",
  "admissions.academic_reject_mismatched",
  "admissions.academic_passport_name_review",
  "admissions.visa_passport_name_review",
  "admissions.visa_require_expiry_date",
  "admissions.visa_reject_expired",
  "admissions.visa_require_subclass",
  "admissions.visa_vevo_review",
  "admissions.usi_required",
  "admissions.offer_accept_in_portal",
  "admissions.offer_accept_portal_roles",
  "admissions.applicant_age_range",
  "admissions.offer_letter_upload_mib",
  "admissions.offer_unanswered_days",
  "finance.offer_discount_range",
  "finance.deposit_automatic_reminder_interval",
  "finance.deposit_automatic_reminder_cap",
  "finance.deposit_manual_reminder_cooldown",
  "agents.commission_range",
  "agents.commission_suggested",
  "hrms.employment_types",
  "hrms.new_job_defaults",
  "hrms.pay_frequencies",
  "hrms.pay_date_window",
  "hrms.staff_offer_link_days",
  "hrms.staff_document_link_days",
  "hrms.staff_account_link_days",
  "hrms.document_expiring_soon_days",
  "hrms.staff_minimum_age",
  "auth.password_min_staff",
  "auth.password_min_students_agents",
  "comms.notification_extra_recipients_max",
  "admin.view_as_hours",
  "support.ticket_categories",
  "support.ticket_priority_default",
  "support.requester_can_close",
  "office365.agent_mailbox",
  "lms.day_part_times",
  "lms.day_part_cutoffs",
  "lms.voe_max_units_together",
  "lms.master_plan_max_years",
  "lms.master_plan_alert_months",
  "lms.master_plan_lock_months",
  "lms.reschedule_spread_step_minutes",
  "booking.type_choices",
  "booking.history_days",
  "admissions.offer_accepted_or_later_states",
  "agents.activation_reference_minimum",
  "signing.default_signer_order",
  "signing.request_expiry_default",
  "signing.request_reminder_default",
  "admissions.offer_validity_days",
  "agents.onboarding_reason_min_chars",
  "finance.gst_rate_percent",
  "signing.code_digits",
  "signing.pdf_upload_max_mib",
  "signing.word_template_max_mib",
  "comms.submission_pdf_attach_mib",
  "comms.notification_overview_days",
  "hrms.signed_copy_upload_max_mib",
  "hrms.holiday_range_max_days",
  "hrms.holiday_import_max_mib",
  "hrms.holidays_list_days_ahead",
  "cms.image_upload_limit_mib",
  "cms.letter_picture_limit_mib",
  "cms.word_import_limit_mib",
  "general.time_zone",
] as const;

let values: Record<string, unknown> = {};
let loading: Promise<void> | null = null;
let loaded = false;
const listeners: (() => void)[] = [];

/** Runs now (with the fixed values or the loaded ones) and again whenever the values load: modules keep their
 * exported settings in step with Business Rules this way. */
export function onRules(fn: () => void) {
  listeners.push(fn);
  fn();
}

export function loadBusinessRules(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const { data, error } = await supabase.rpc("business_rule_values", { p_ids: [...SCREEN_RULES] });
      if (!error && data && typeof data === "object") values = data as Record<string, unknown>;
    } catch { /* keep the fixed values */ }
    loaded = true;
    listeners.forEach((fn) => { try { fn(); } catch { /* one bad listener must not stop the others */ } });
  })();
  return loading;
}

export function ruleNumber(id: string, fallback: number): number {
  const v = values[id];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
export const rulesLoaded = () => loaded;
export function ruleBool(id: string, fallback: boolean): boolean {
  const v = values[id];
  return typeof v === "boolean" ? v : fallback;
}
export function ruleText(id: string, fallback: string): string {
  const v = values[id];
  return typeof v === "string" && v.trim() ? v : fallback;
}
export function ruleList(id: string, fallback: string[]): string[] {
  const v = values[id];
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fallback;
}
export function ruleObject<T extends Record<string, unknown>>(id: string, fallback: T): T {
  const v = values[id];
  return v && typeof v === "object" && !Array.isArray(v) ? { ...fallback, ...(v as Partial<T>) } : fallback;
}
/** "Initial deposit" → "initial_deposit": how list rules name fee types. */
export const ruleKey = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "Monday" → 1 (Sunday = 0), -1 when unknown. */
export const weekdayIndex = (name: string) => WEEKDAYS.findIndex((d) => d.toLowerCase() === name.trim().toLowerCase());
