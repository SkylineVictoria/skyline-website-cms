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
] as const;

let values: Record<string, unknown> = {};
let loading: Promise<void> | null = null;

export function loadBusinessRules(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const { data, error } = await supabase.rpc("business_rule_values", { p_ids: [...SCREEN_RULES] });
      if (!error && data && typeof data === "object") values = data as Record<string, unknown>;
    } catch { /* keep the fixed values */ }
  })();
  return loading;
}

export function ruleNumber(id: string, fallback: number): number {
  const v = values[id];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
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
