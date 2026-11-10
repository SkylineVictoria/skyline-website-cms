import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdmin, resetRateLimits, setHrMailMode, signInAsAdmin, signInThroughTheForm, signOutEverywhere, signedInClient, sql, staffAt } from "./support";

/**
 * HRMS (time & attendance, leave, public holidays, pay periods, Xero export) in the browser, against the LOCAL lab only.
 * The seeded schedules start in the future (Nov/Dec 2026), so the suite creates its own schedules anchored in January 2026
 * and puts the test employees on them: the period that holds "today" exists for both. The manager and the employee are two
 * people (a decision on one's own record is refused), and the admin is a CMS admin without a staff record.
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(() => { resetRateLimits(); });
test.afterEach(async () => { await setHrMailMode("ok"); });

const RUN = Date.now();
const FORTNIGHTLY = `E2E Fortnightly ${RUN}`;
const MONTHLY = `E2E Monthly ${RUN}`;
let admin: { email: string }; let adminClient: SupabaseClient;
let manager: { id: string; email: string }; let employee: { id: string; email: string }; let monthlyEmployee: { id: string; email: string };
let fortnightlyId = ""; let monthlyId = ""; let currentPeriodId = ""; let monthlyPeriodId = ""; let leaveRequestId = "";
const today = (): string => sql("select hr.local_date(now())");

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as Record<string, unknown>;
}
async function openMyHr(page: Page, email: string): Promise<void> {
  await signOutEverywhere(page);
  await signInThroughTheForm(page, email);
  // The sign-in page sends staff to their portal itself; leaving before that cancels the sign-in request.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.goto("/staff");
  await expect(page.getByTestId("my-hr-punch")).toBeVisible();
}

test.beforeAll(async () => {
  admin = await createAdmin("hrms-admin");
  adminClient = await signedInClient(admin.email);
  manager = await staffAt(adminClient, "hrms-mgr", "active");
  employee = await staffAt(adminClient, "hrms-emp", "active");
  monthlyEmployee = await staffAt(adminClient, "hrms-monthly", "active");
  const fortnightly = await rpc(adminClient, "hr_admin_schedule_save", { p_id: null, p_schedule: { name: FORTNIGHTLY, frequency: "fortnightly", anchorDate: "2026-01-05", payDateOffsetDays: 3 } });
  const monthly = await rpc(adminClient, "hr_admin_schedule_save", { p_id: null, p_schedule: { name: MONTHLY, frequency: "monthly", anchorDate: "2026-01-01", payDateOffsetDays: 0 } });
  fortnightlyId = fortnightly.id as string; monthlyId = monthly.id as string;
  // The manager runs the team; everyone joined at the start of the year so holidays and service count.
  sql(`update hr.employment set manager_id = '${manager.id}', joining_date = date '2026-01-05' where profile_id in ('${employee.id}', '${monthlyEmployee.id}')`);
  sql(`update hr.employment set joining_date = date '2026-01-05' where profile_id = '${manager.id}'`);
  await rpc(adminClient, "hr_admin_employee_pay_save", { p_profile: employee.id, p_pay: { payScheduleId: fortnightlyId, payBasis: "hourly", rate: 40, xeroEmployeeId: `XERO-EMP-${RUN}` } });
  await rpc(adminClient, "hr_admin_employee_pay_save", { p_profile: monthlyEmployee.id, p_pay: { payScheduleId: monthlyId, payBasis: "salary", rate: 78000, xeroEmployeeId: `XERO-MON-${RUN}` } });
  currentPeriodId = sql(`select id from hr.pay_periods where schedule_id = '${fortnightlyId}' and current_date between start_date and end_date`);
  monthlyPeriodId = sql(`select id from hr.pay_periods where schedule_id = '${monthlyId}' and current_date between start_date and end_date`);
  expect(currentPeriodId).toMatch(/^[0-9a-f-]{36}$/);
  expect(monthlyPeriodId).toMatch(/^[0-9a-f-]{36}$/);
  // An opening annual leave balance so a request can be approved.
  await rpc(adminClient, "hr_admin_leave_adjust", { p_profile: employee.id, p_type: sql("select id from hr.leave_types where code = 'annual'"), p_hours: 38, p_reason: "E2E opening balance", p_kind: "opening" });
});

test("the admin sidebar's HRMS group lists Timesheets, Leave, Pay Schedules, Public Holidays and Xero Export, and each page loads", async ({ page }) => {
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff/timesheets");
  const sidebar = page.locator("aside").filter({ has: page.getByRole("button", { name: "HRMS" }) }).first();
  for (const [href, label] of [["/admin/staff/timesheets", "Timesheets"], ["/admin/staff/leave", "Leave"], ["/admin/staff/pay-schedules", "Pay Schedules"], ["/admin/staff/holidays", "Public Holidays"], ["/admin/staff/xero-export", "Xero Export"]]) {
    await expect(sidebar.locator(`a[href="${href}"]`)).toHaveText(label);
  }
  expect(sql(`select string_agg(id, ',' order by sort_order) from public.admin_menu_items where parent_id = 'staff' and is_enabled`)).toBe("staff_candidates,agency_staff,staff_timesheets,staff_leave,staff_pay_schedules,staff_holidays,staff_xero");
  await expect(page.getByTestId("timesheet-table")).toBeVisible();
  await page.goto("/admin/staff/leave");
  await expect(page.getByTestId("leave-approvals")).toBeVisible();
  await page.goto("/admin/staff/pay-schedules");
  await expect(page.getByTestId(`schedule-${fortnightlyId}`)).toBeVisible();
  await expect(page.getByTestId("hr-settings")).toBeVisible();
  await page.goto("/admin/staff/holidays");
  await expect(page.getByTestId("holiday-table")).toBeVisible();
  await expect(page.getByTestId("holiday-2026-11-03")).toContainText("Melbourne Cup Day");
  await page.goto("/admin/staff/xero-export");
  await expect(page.getByTestId("xero-history")).toBeVisible();
  // Pay setup and leave balances on the employee's page.
  await page.goto(`/admin/staff/employees/${employee.id}`);
  await expect(page.getByTestId("staff-pay-setup")).toContainText(FORTNIGHTLY);
  await expect(page.getByTestId("staff-pay-setup")).toContainText(`XERO-EMP-${RUN}`);
  await expect(page.getByTestId("leave-balance-annual")).toContainText("38.00 h");
});

test("an active employee sees the new My HR sections and punches in, takes a break and punches out with only the valid button offered", async ({ page }) => {
  await openMyHr(page, employee.email);
  for (const id of ["my-hr-timesheet", "my-hr-leave", "my-hr-holidays", "my-hr-role", "my-hr-documents"]) await expect(page.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId("my-hr-team-links")).toHaveCount(0);
  await expect(page.getByTestId("punch-state")).toHaveText("Off the clock");
  await expect(page.getByTestId("punch-punch_in")).toBeVisible();
  await expect(page.getByTestId("punch-punch_out")).toHaveCount(0);
  await page.getByTestId("punch-punch_in").click();
  await expect(page.getByTestId("punch-state")).toHaveText("Working");
  await expect(page.getByTestId("punch-timer")).toBeVisible();
  await expect(page.getByTestId("punch-break_start")).toBeVisible();
  await expect(page.getByTestId("punch-punch_out")).toBeVisible();
  await expect(page.getByTestId("punch-punch_in")).toHaveCount(0);
  await page.getByTestId("punch-break_start").click();
  await expect(page.getByTestId("punch-state")).toHaveText("On a break");
  await expect(page.getByTestId("punch-break_end")).toBeVisible();
  await expect(page.getByTestId("punch-punch_out")).toHaveCount(0);
  await page.getByTestId("punch-break_end").click();
  await expect(page.getByTestId("punch-state")).toHaveText("Working");
  await page.getByTestId("punch-punch_out").click();
  await expect(page.getByTestId("punch-state")).toHaveText("Off the clock");
  await expect(page.getByTestId("punch-punch_in")).toBeVisible();
  await expect(page.getByTestId("punch-today").locator("li")).toHaveCount(1);
  expect(sql(`select string_agg(kind, ',' order by at) from hr.time_events where profile_id = '${employee.id}'`)).toBe("punch_in,break_start,break_end,punch_out");
  // The shift is on the employee's own timesheet for the current period.
  await expect(page.getByTestId("my-timesheet-shifts").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("my-timesheet-approval")).toContainText("Not yet approved");
});

test("a leave request goes to the manager, who approves it from Leave approvals; the leave then shows on the employee's timesheet", async ({ page }) => {
  // Next Monday that is still inside the current fortnight (the period runs Monday to Sunday from 2026-01-05).
  const periodEnd = sql(`select end_date from hr.pay_periods where id = '${currentPeriodId}'`);
  const leaveDay = sql(`select min(d)::date::text from generate_series(hr.local_date(now()) + 1, date '${periodEnd}', interval '1 day') d where extract(isodow from d) between 1 and 5 and not hr.is_public_holiday(d::date)`);
  expect(leaveDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await openMyHr(page, employee.email);
  await expect(page.getByTestId("my-leave-balance-annual")).toContainText("38.00 h");
  await page.getByTestId("my-leave-type").selectOption({ label: "Annual leave" });
  await page.getByTestId("my-leave-start").fill(leaveDay);
  await page.getByTestId("my-leave-note").fill("E2E day off");
  await page.getByTestId("my-leave-send").click();
  await expect(page.getByTestId("my-leave-notice")).toContainText("7.60 h");
  leaveRequestId = sql(`select id from hr.leave_requests where profile_id = '${employee.id}' and status = 'pending'`);
  await expect(page.getByTestId(`my-leave-status-${leaveRequestId}`)).toHaveText("Pending");
  // The manager sees the team links and approves it.
  await openMyHr(page, manager.email);
  await expect(page.getByTestId("my-hr-team-links")).toContainText("1 pending");
  await page.goto("/staff/team/leave");
  await expect(page.getByTestId(`leave-row-${leaveRequestId}`)).toContainText("Annual leave");
  await page.getByTestId(`leave-approve-${leaveRequestId}`).click();
  await page.getByTestId("leave-decision-note").fill("Enjoy");
  await page.getByTestId("leave-decision-confirm").click();
  await expect(page.getByTestId("leave-notice")).toContainText("approved");
  expect(sql(`select status from hr.leave_requests where id = '${leaveRequestId}'`)).toBe("approved");
  expect(sql(`select hr.leave_balance('${employee.id}', (select id from hr.leave_types where code = 'annual'))::text`)).toBe("30.40");
  await openMyHr(page, employee.email);
  await expect(page.getByTestId(`my-leave-status-${leaveRequestId}`)).toHaveText("Approved");
  await expect(page.getByTestId("my-leave-balance-annual")).toContainText("30.40 h");
  await expect(page.getByTestId("my-timesheet-leave")).toHaveText("7.60 h");
  await expect(page.getByTestId("my-timesheet-leave-days")).toContainText("Annual leave 7.60 h");
});

test("a confirmed public holiday appears in My HR and on the timesheet; a 'review' holiday is listed but not counted", async ({ page }) => {
  const periodEnd = sql(`select end_date from hr.pay_periods where id = '${currentPeriodId}'`);
  const holiday = sql(`select max(d)::date::text from generate_series(hr.local_date(now()) + 1, date '${periodEnd}', interval '1 day') d where extract(isodow from d) between 1 and 5
    and not exists (select 1 from hr.leave_requests r where r.profile_id = '${employee.id}' and r.status = 'approved' and d::date between r.start_date and r.end_date)`);
  expect(holiday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  sql(`delete from hr.public_holidays where name like 'E2E Review Day %'`); // rows left by an earlier run of this suite on the same lab
  sql(`insert into hr.public_holidays(holiday_date, name, status) values ('${holiday}', 'E2E Review Day ${RUN}', 'review')`);
  await openMyHr(page, employee.email);
  await expect(page.getByTestId(`my-holiday-${holiday}`)).toContainText("To be confirmed");
  await expect(page.getByTestId("my-timesheet-holidays")).toHaveText("0.00 h");
  // HR confirms it on Public Holidays.
  await signOutEverywhere(page);
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff/holidays");
  await page.getByTestId("holiday-year").selectOption(holiday.slice(0, 4));
  await page.getByTestId(`holiday-confirm-${holiday}`).click();
  await expect(page.getByTestId("holiday-notice")).toContainText("confirmed");
  await expect(page.getByTestId(`holiday-${holiday}`)).toContainText("Confirmed");
  await openMyHr(page, employee.email);
  await expect(page.getByTestId(`my-holiday-${holiday}`)).toContainText("Confirmed");
  await expect(page.getByTestId("my-timesheet-holidays")).toHaveText("7.60 h");
  await expect(page.getByTestId("my-timesheet-holiday-days")).toContainText(`E2E Review Day ${RUN}`);
});

test("the manager approves the fortnightly timesheet from Team timesheets; self-approval is not offered", async ({ page }) => {
  // A full shift earlier in the period (the live punches above were seconds apart), so the export has an Ordinary line.
  const uid = sql(`select auth_user_id from hr.staff_profiles where id = '${employee.id}'`);
  sql(`insert into hr.time_events(profile_id, kind, at, source, recorded_by) values ('${employee.id}', 'punch_in', now() - interval '30 hours', 'web', '${uid}'), ('${employee.id}', 'punch_out', now() - interval '22 hours', 'web', '${uid}')`);
  await openMyHr(page, manager.email);
  await page.goto("/staff/team/timesheets");
  await page.getByTestId("timesheet-schedule").selectOption({ label: `${FORTNIGHTLY} (fortnightly)` });
  await expect(page.getByTestId(`timesheet-row-${employee.id}`)).toBeVisible();
  await expect(page.getByTestId(`timesheet-row-${manager.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`timesheet-leave-${employee.id}`)).toContainText("7.60 h");
  await expect(page.getByTestId(`timesheet-holiday-${employee.id}`)).toContainText("7.60 h");
  await expect(page.getByTestId("timesheet-lock")).toHaveCount(0);
  await page.getByTestId(`timesheet-expand-${employee.id}`).click();
  await expect(page.getByTestId("punch-list").locator("li")).toHaveCount(6);
  await expect(page.getByTestId(`timesheet-worked-${employee.id}`)).toContainText("8.0");
  await page.getByTestId(`timesheet-approve-${employee.id}`).click();
  await page.getByTestId("decision-confirm").click();
  await expect(page.getByTestId(`timesheet-approval-${employee.id}`)).toContainText("Approved");
  expect(sql(`select status from hr.timesheet_approvals where period_id = '${currentPeriodId}' and profile_id = '${employee.id}'`)).toBe("approved");
});

test("HR locks the fortnightly period (leave accrues) and exports it to Xero; the CSV has Ordinary, Public Holiday and Annual leave lines", async ({ page }) => {
  await signOutEverywhere(page);
  await signInAsAdmin(page, admin.email);
  await page.goto(`/admin/staff/timesheets?period=${currentPeriodId}`);
  await expect(page.getByTestId(`timesheet-row-${employee.id}`)).toBeVisible();
  await page.getByTestId("timesheet-lock").click();
  await expect(page.getByTestId("timesheet-period-status")).toContainText("Locked");
  expect(sql(`select status from hr.pay_periods where id = '${currentPeriodId}'`)).toBe("locked");
  expect(sql(`select count(*) from hr.leave_ledger where period_id = '${currentPeriodId}' and profile_id = '${employee.id}' and entry_kind = 'accrual'`)).toBe("3");
  // Correction refused once locked.
  const { error } = await adminClient.rpc("hr_admin_time_correct", { p_profile: employee.id, p_supersedes: null, p_kind: "punch_in", p_at: new Date().toISOString(), p_reason: "late" });
  expect(error?.message).toContain("locked");
  await page.goto("/admin/staff/xero-export");
  await page.getByTestId("xero-schedule").selectOption({ label: `${FORTNIGHTLY} (fortnightly)` });
  await page.getByTestId("xero-period").selectOption(currentPeriodId);
  await expect(page.getByTestId(`xero-employee-${employee.id}`)).toContainText("approved");
  await page.getByTestId("xero-export").click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByTestId("xero-result")).toBeVisible();
  await expect(page.getByTestId("xero-result")).toContainText("Public Holiday");
  await expect(page.getByTestId("xero-result")).toContainText("Annual leave");
  await expect(page.getByTestId("xero-result")).toContainText("Ordinary");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("xero-download").click()]);
  expect(download.suggestedFilename()).toMatch(/^xero-payroll-.*\.csv$/);
  expect(sql(`select status from hr.pay_periods where id = '${currentPeriodId}'`)).toBe("exported");
  expect(sql(`select csv from hr.xero_exports where period_id = '${currentPeriodId}'`).split("\n")[0]).toBe("EmployeeId,EmployeeName,Date,PayItem,Hours,LeaveType");
});

test("a monthly period with an 8-hour shift is approved, locked and exported too", async ({ page }) => {
  const [inAt, outAt] = sql(`select (now() - interval '9 hours')::text || '|' || (now() - interval '1 hour')::text`).split("|");
  sql(`insert into hr.time_events(profile_id, kind, at, source, recorded_by) values ('${monthlyEmployee.id}', 'punch_in', '${inAt}', 'web', (select auth_user_id from hr.staff_profiles where id = '${monthlyEmployee.id}')), ('${monthlyEmployee.id}', 'punch_out', '${outAt}', 'web', (select auth_user_id from hr.staff_profiles where id = '${monthlyEmployee.id}'))`);
  await rpc(adminClient, "hr_timesheet_decide", { p_period: monthlyPeriodId, p_profile: monthlyEmployee.id, p_decision: "approved", p_note: null });
  await rpc(adminClient, "hr_admin_period_set_status", { p_period: monthlyPeriodId, p_status: "locked" });
  await signOutEverywhere(page);
  await signInAsAdmin(page, admin.email);
  await page.goto("/admin/staff/xero-export");
  await page.getByTestId("xero-schedule").selectOption({ label: `${MONTHLY} (monthly)` });
  await page.getByTestId("xero-period").selectOption(monthlyPeriodId);
  await expect(page.getByTestId(`xero-employee-${monthlyEmployee.id}`)).toContainText("approved");
  await page.getByTestId("xero-export").click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByTestId("xero-result")).toContainText("8.00 h");
  expect(sql(`select status from hr.pay_periods where id = '${monthlyPeriodId}'`)).toBe("exported");
  expect(sql(`select count(*) from hr.xero_exports x join hr.pay_periods p on p.id = x.period_id where p.schedule_id in ('${fortnightlyId}', '${monthlyId}')`)).toBe("2");
  expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
