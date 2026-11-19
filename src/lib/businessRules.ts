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
