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
export type Version = { id: string; rule_id: string; version: number; state: "draft" | "published" | "superseded"; definition: Definition; created_at: string; origin: string; approved_by: string | null };
export type Category = { id: string; name: string };
export type Rule = { id: string; identifier: string; registration: { scope: string; entity: string; value_type: string } | null; versions: Version[] };
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
