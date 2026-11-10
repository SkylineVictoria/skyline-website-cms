/**
 * Admin addresses under the top-level Staff menu group (menu rows with parent_id = 'staff' in public.admin_menu_items):
 * Candidates, Employees and Jobs (/admin/jobs). A new Staff page adds its path here, a route in src/router/config.tsx, the path
 * in the menu allow-list (src/pages/admin/lib/adminMenu.ts) and a menu row under 'staff' in a migration.
 */
export const STAFF_EMPLOYEES_PATH = "/admin/staff/employees";
export const STAFF_CANDIDATES_PATH = "/admin/staff/candidates";
// HRMS (time & attendance, leave, pay schedules, public holidays, Xero export).
export const STAFF_TIMESHEETS_PATH = "/admin/staff/timesheets";
export const STAFF_LEAVE_PATH = "/admin/staff/leave";
export const STAFF_PAY_SCHEDULES_PATH = "/admin/staff/pay-schedules";
export const STAFF_HOLIDAYS_PATH = "/admin/staff/holidays";
export const STAFF_XERO_PATH = "/admin/staff/xero-export";
// HRMS > Templates (offer letters and onboarding emails; menu row 'staff_templates' of 20261111100000).
export const STAFF_TEMPLATES_PATH = "/admin/staff/templates";
export const staffEmployeePath = (id: string) => `${STAFF_EMPLOYEES_PATH}/${encodeURIComponent(id)}`;
export const staffCandidatePath = (id: string) => `${STAFF_CANDIDATES_PATH}/${encodeURIComponent(id)}`;
