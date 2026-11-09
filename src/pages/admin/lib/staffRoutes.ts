/**
 * Admin addresses under the top-level Staff menu group (menu rows with parent_id = 'staff' in public.admin_menu_items):
 * Candidates, Employees and Jobs (/admin/jobs). A new Staff page adds its path here, a route in src/router/config.tsx, the path
 * in the menu allow-list (src/pages/admin/lib/adminMenu.ts) and a menu row under 'staff' in a migration.
 */
export const STAFF_EMPLOYEES_PATH = "/admin/staff/employees";
export const STAFF_CANDIDATES_PATH = "/admin/staff/candidates";
export const staffEmployeePath = (id: string) => `${STAFF_EMPLOYEES_PATH}/${encodeURIComponent(id)}`;
export const staffCandidatePath = (id: string) => `${STAFF_CANDIDATES_PATH}/${encodeURIComponent(id)}`;
export const STAFF_ORG_CHART_PATH = "/admin/staff/employees/org-chart";
