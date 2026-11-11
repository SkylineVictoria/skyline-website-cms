import { supabase } from "@/pages/admin/lib/supabase";

/**
 * Browser-side calls for the HRMS (time & attendance, pay schedules, leave, public holidays, Xero export). Every call is a
 * SECURITY DEFINER function in public (the hr schema is not exposed); the server decides who may see or change what.
 */

function fail(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}
async function rpc<T>(name: string, args: Record<string, unknown> | undefined, fallback: string): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) fail(error, fallback);
  return data as T;
}

/* ------------------------------------------------------------------ settings */
export interface HrSettings {
  timezone: string; state: string; ordinaryHoursWeek: number; openShiftFlagHours: number; usualWorkDays: number[]; breaksPaid: boolean; updatedAt: string; serverNow: string;
}
export const getHrSettings = () => rpc<HrSettings>("hr_settings", undefined, "The HR settings could not be loaded.");
export const saveHrSettings = (settings: Partial<HrSettings>) => rpc<HrSettings>("hr_admin_settings_save", { p_settings: settings }, "The HR settings could not be saved.");

/* ------------------------------------------------------------------ public holidays */
export type HolidaySourceKind = "seed" | "api" | "manual" | "import";
export type HolidaySyncSource = "data.gov.au" | "nager";
export interface Holiday {
  id: string; date: string; name: string; isOptional: boolean; type: "public" | "optional"; state: string; status: "review" | "confirmed"; note: string;
  source: HolidaySourceKind; syncSource: HolidaySyncSource | null; syncedAt: string | null; updatedAt: string;
}
export const listHolidays = (from?: string, to?: string) => rpc<Holiday[]>("hr_public_holidays", { p_from: from ?? null, p_to: to ?? null }, "The public holidays could not be loaded.");
/** Several holidays in one go (20261113150000): each a single date or a range (one row per day), public or optional; all or nothing. */
export interface NewHolidayInput { name: string; startDate: string; endDate?: string; isOptional: boolean; note?: string; status?: "review" | "confirmed" }
export const addHolidays = (rows: NewHolidayInput[]) => rpc<{ inserted: number; updated: number; holidays: Holiday[] }>("hr_admin_holidays_add", { p_rows: rows }, "The holidays could not be added.");

/* ------------------------------------------------------------------ public holiday sync (holiday-sync Edge Function + weekly cron) */
export interface HolidaySyncRun {
  id: number; trigger: "cron" | "manual"; status: "running" | "ok" | "failed"; startedAt: string; finishedAt: string | null; years: number[];
  sources: Record<string, HolidaySyncSource>; inserted: number; updated: number; demoted: number; keptManual: number; unchanged: number; error: string; errors: Record<string, string>;
  detail: { skipped?: string[] } & Record<string, unknown>;
}
export interface HolidaySyncStatus { lastRun: HolidaySyncRun | null; lastOk: HolidaySyncRun | null; runs: HolidaySyncRun[]; cronActive: boolean; cronSchedule: string | null; dispatchReady: boolean; serverNow: string }
export const holidaySyncStatus = () => rpc<HolidaySyncStatus>("hr_admin_holiday_sync_status", undefined, "The sync status could not be loaded.");
/** "Sync now": the function fetches this year and next from data.gov.au / Nager.Date and records a run; the database applies the lists. */
export async function syncHolidaysNow(): Promise<HolidaySyncRun> {
  const { data, error } = await supabase.functions.invoke("holiday-sync", { body: { action: "sync", trigger: "manual" } });
  if (error) {
    let message = error.message;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) { try { const parsed = (await context.clone().json()) as { error?: string }; if (parsed?.error) message = parsed.error; } catch { /* keep the generic message */ } }
    throw new Error(message || "The holidays could not be synced.");
  }
  return (data as { run: HolidaySyncRun }).run;
}
/** The warning the holidays page shows, or null when the last sync is fine and recent. */
export function holidaySyncWarning(s: HolidaySyncStatus | null): string | null {
  if (!s) return null;
  const run = s.lastRun;
  if (!run) return "The holidays have never been synced. Press Sync now, or wait for the weekly job.";
  if (run.status === "failed") return `The last sync (${run.trigger === "cron" ? "weekly job" : "Sync now"}) failed: ${run.error || "the holiday sources could not be read"}. Existing holidays were left as they were.`;
  const errors = Object.entries(run.errors ?? {});
  if (errors.length) return `The last sync could not read ${errors.map(([y, e]) => `${y} (${e})`).join("; ")}. The other year was updated.`;
  const age = (Date.parse(s.serverNow) - Date.parse(run.startedAt)) / 86400000;
  if (age > 10) return `The last successful sync was ${Math.floor(age)} days ago; the weekly job may not be running.`;
  if (!s.cronActive) return "The weekly sync job is paused; holidays update only when someone presses Sync now.";
  if (!s.dispatchReady) return "The weekly sync job cannot run until its Vault secrets are set (see docs/SUPABASE.md); press Sync now meanwhile.";
  return null;
}

/* ------------------------------------------------------------------ optional holidays (employees pick up to a yearly allowance; approved like leave) */
export type OptionalStatus = "pending" | "approved" | "rejected" | "cancelled";
export interface OptionalRule { year: number; allowance: number; isPaid: boolean; isSet?: boolean; updatedAt: string | null; optionalHolidays?: number; picked?: number }
export interface OptionalRequest {
  id: string; profileId: string; personName: string; holidayId: string; date: string; name: string; year: number; holidayStatus: "review" | "confirmed"; isPaid: boolean; hours: number;
  status: OptionalStatus; note: string; isAdminEntry: boolean; createdAt: string; decidedAt: string | null; decisionNote: string; cancelledAt: string | null;
}
export interface MyOptionalHolidays { profileId: string; year: number; allowance: number; isPaid: boolean; used: number; remaining: number; today: string; holidays: (Holiday & { request: OptionalRequest | null })[]; requests: OptionalRequest[] }
export const myOptionalHolidays = (year?: number) => rpc<MyOptionalHolidays>("hr_optional_holidays_my", { p_year: year ?? null }, "Your optional holidays could not be loaded.");
export const pickOptionalHoliday = (holidayId: string, note?: string) => rpc<OptionalRequest>("hr_optional_holiday_pick", { p_holiday: holidayId, p_note: note ?? null }, "The optional holiday could not be picked.");
export const cancelOptionalHoliday = (id: string, note?: string) => rpc<OptionalRequest>("hr_optional_holiday_cancel", { p_id: id, p_note: note ?? null }, "The request could not be cancelled.");
export const decideOptionalHoliday = (id: string, decision: "approved" | "rejected", note?: string) =>
  rpc<OptionalRequest>("hr_optional_holiday_decide", { p_id: id, p_decision: decision, p_note: note ?? null }, "The decision could not be saved.");
export const listOptionalHolidayRequests = (filter: { status?: OptionalStatus | null; profileId?: string | null; year?: number | null } = {}) =>
  rpc<{ scope: "company" | "team"; requests: OptionalRequest[] }>("hr_optional_holiday_list", { p_status: filter.status ?? null, p_profile: filter.profileId ?? null, p_year: filter.year ?? null }, "The optional holiday requests could not be loaded.");
export const adminAddOptionalHoliday = (profileId: string, holidayId: string, note?: string) =>
  rpc<OptionalRequest>("hr_admin_optional_holiday_add", { p_profile: profileId, p_holiday: holidayId, p_note: note ?? null }, "The optional holiday could not be entered.");
export const listOptionalRules = () => rpc<OptionalRule[]>("hr_admin_optional_rules", undefined, "The optional holiday settings could not be loaded.");
export const saveOptionalRule = (year: number, rule: { allowance: number; isPaid: boolean }) => rpc<OptionalRule>("hr_admin_optional_rule_save", { p_year: year, p_rule: rule }, "The optional holiday setting could not be saved.");
export const saveHoliday = (id: string | null, holiday: Partial<Pick<Holiday, "date" | "name" | "isOptional" | "state" | "status" | "note">>) =>
  rpc<Holiday>("hr_admin_holiday_save", { p_id: id, p_holiday: holiday }, "The holiday could not be saved.");
export const deleteHoliday = (id: string) => rpc<Holiday>("hr_admin_holiday_delete", { p_id: id }, "The holiday could not be deleted.");
/** Many holidays at once (20261110220000): all or nothing; the same date + name + state updates the existing row. */
export const importHolidays = (rows: Array<{ date: string; name: string; isOptional: boolean; state?: string; note?: string }>, status: "review" | "confirmed") =>
  rpc<{ inserted: number; updated: number }>("hr_admin_holidays_import", { p_rows: rows, p_status: status }, "The holidays could not be imported.");

/* ------------------------------------------------------------------ time & attendance */
export type PunchKind = "punch_in" | "break_start" | "break_end" | "punch_out";
export type ShiftFlag = "missing_punch_out" | "unclosed_break" | "weekend" | "public_holiday";
export interface Shift { workDate: string; startedAt: string; endedAt: string | null; breakMinutes: number; workedMinutes: number; isOpen: boolean; flags: ShiftFlag[]; eventIds: string[] }
export interface TimeStatus {
  profileId: string; state: PunchKind | "none"; since: string | null; nextKinds: PunchKind[];
  openShift: { startedAt: string; breakMinutes: number; workedMinutes: number; flags: ShiftFlag[] } | null;
  today: string; todayShifts: Shift[]; serverNow: string; timezone: string;
}
export interface TimeEvent {
  id: string; kind: PunchKind | "void"; at: string; source: "web" | "mobile" | "correction"; supersedes: string | null; reason: string;
  recordedAt: string; recordedBy: string; supersededBy: string | null; workDate: string;
}
export interface EmployeePunches { profileId: string; from: string; to: string; timezone: string; name: string; state: { state: string; since: string | null; last_id: string | null }; events: TimeEvent[]; shifts: Shift[] }

export const getTimeStatus = () => rpc<TimeStatus>("hr_time_status", undefined, "Your punch status could not be loaded.");
export const punch = (kind: PunchKind, source: "web" | "mobile" = "web") => rpc<TimeStatus>("hr_time_punch", { p_kind: kind, p_source: source }, "The punch could not be recorded.");
export const myShifts = (from: string, to: string) => rpc<{ from: string; to: string; timezone: string; shifts: Shift[] }>("hr_time_my_shifts", { p_from: from, p_to: to }, "Your shifts could not be loaded.");
export const employeePunches = (profileId: string, from: string, to: string) =>
  rpc<EmployeePunches>("hr_admin_employee_punches", { p_profile: profileId, p_from: from, p_to: to }, "The punches could not be loaded.");
export const correctTime = (profileId: string, supersedes: string | null, kind: PunchKind | "void", at: string | null, reason: string) =>
  rpc<EmployeePunches & { correctionId: string }>("hr_admin_time_correct", { p_profile: profileId, p_supersedes: supersedes, p_kind: kind, p_at: at, p_reason: reason }, "The correction could not be saved.");

/* ------------------------------------------------------------------ pay schedules and periods */
export type PeriodStatus = "open" | "locked" | "exported";
export interface PayPeriod { id: string; scheduleId: string; startDate: string; endDate: string; payDate: string; status: PeriodStatus; lockedAt: string | null; exportedAt: string | null; scheduleName: string; frequency: "fortnightly" | "monthly" }
export interface PaySchedule { id: string; name: string; frequency: "fortnightly" | "monthly"; anchorDate: string; payDateOffsetDays: number; isActive: boolean; updatedAt: string; employeeCount?: number; periods?: PayPeriod[] }
export interface EmployeePay {
  profileId: string; payScheduleId: string | null; payScheduleName: string | null; payBasis: "salary" | "hourly" | null; rate: number | null; ordinaryHoursWeek: number | null;
  usualWorkDays: number[] | null; award: string; xeroEmployeeId: string; updatedAt: string | null; effectiveOrdinaryHoursWeek: number; effectiveUsualWorkDays: number[]; dailyHours: number; schedules?: PaySchedule[];
}
export interface EmployeePayForm { payScheduleId: string; payBasis: "" | "salary" | "hourly"; rate: string; ordinaryHoursWeek: string; usualWorkDays: number[]; award: string; xeroEmployeeId: string }

/* ------------------------------------------------------------------ locations (HRMS > Locations) */
export interface HrLocation { id: string; name: string; address: string; isActive: boolean; updatedAt: string; employeeCount?: number }
export const listLocations = () => rpc<HrLocation[]>("hr_admin_locations", undefined, "The locations could not be loaded.");
export const saveLocation = (id: string | null, location: { name?: string; address?: string; isActive?: boolean }) =>
  rpc<HrLocation>("hr_admin_location_save", { p_id: id, p_location: location }, "The location could not be saved.");

export const listSchedules = () => rpc<PaySchedule[]>("hr_admin_schedules", undefined, "The pay schedules could not be loaded.");
export const saveSchedule = (id: string | null, schedule: { name?: string; frequency?: string; anchorDate?: string; payDateOffsetDays?: number; isActive?: boolean }) =>
  rpc<PaySchedule>("hr_admin_schedule_save", { p_id: id, p_schedule: schedule }, "The pay schedule could not be saved.");
export const getEmployeePay = (profileId: string) => rpc<EmployeePay>("hr_admin_employee_pay", { p_profile: profileId }, "The pay setup could not be loaded.");
export const saveEmployeePay = (profileId: string, form: EmployeePayForm) =>
  rpc<EmployeePay>("hr_admin_employee_pay_save", { p_profile: profileId, p_pay: { ...form, rate: form.rate || null, ordinaryHoursWeek: form.ordinaryHoursWeek || null, payBasis: form.payBasis || null } }, "The pay setup could not be saved.");
export const setPeriodStatus = (periodId: string, status: "open" | "locked") => rpc<PayPeriod>("hr_admin_period_set_status", { p_period: periodId, p_status: status }, "The period could not be updated.");

/* ------------------------------------------------------------------ leave */
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";
export interface LeavePolicy {
  id: string; effectiveFrom: string; effectiveTo: string | null; hoursPerYear: number | null; daysPerYear: number | null; daysPerOccasion: number | null;
  paidDaysPerOccasion: number | null; accrualFraction: number | null; qualifyingYears: number | null; note: string; createdAt?: string;
}
export interface LeaveType {
  id: string; code: string; name: string; description: string; isPaid: boolean; requiresBalance: boolean; accrualMethod: "progressive" | "long_service" | "entitlement" | "per_occasion" | "none";
  sortOrder: number; isActive: boolean; policy: LeavePolicy | null; policies?: LeavePolicy[];
}
export interface LeaveBalance {
  leaveTypeId: string; code: string; name: string; isPaid: boolean; requiresBalance: boolean; accrualMethod: LeaveType["accrualMethod"];
  balanceHours: number; availableHours: number | null; pendingHours: number; serviceYears: number | null; qualifyingYears: number | null;
}
export interface LeaveRequest {
  id: string; profileId: string; personName: string; leaveTypeId: string; leaveTypeCode: string; leaveTypeName: string; isPaid: boolean; startDate: string; endDate: string;
  unit: "hours" | "days"; quantity: number; hours: number; note: string; status: LeaveStatus; isAdminEntry: boolean; createdAt: string; decidedAt: string | null; decisionNote: string;
  cancelledAt: string | null; days: string[];
}
export interface LeaveRequestInput { leaveTypeId: string; startDate: string; endDate: string; unit: "hours" | "days"; quantity?: number | null; note?: string; decisionNote?: string }
export interface MyLeave { profileId: string; dailyHours: number; types: LeaveType[]; balances: LeaveBalance[]; requests: LeaveRequest[]; canApprove: boolean }
export interface LedgerEntry { id: number; leaveTypeId: string; leaveTypeName: string; entryKind: "opening" | "accrual" | "taken" | "adjustment"; hours: number; effectiveDate: string; periodId: string | null; requestId: string | null; reason: string; createdAt: string }
export interface LeaveBalances { profileId: string; dailyHours: number; balances: LeaveBalance[]; ledger: LedgerEntry[]; requests: LeaveRequest[] }

export const myLeave = () => rpc<MyLeave>("hr_leave_my", undefined, "Your leave could not be loaded.");
export const requestLeave = (input: LeaveRequestInput) => rpc<LeaveRequest>("hr_leave_request", { p_request: input }, "The leave request could not be sent.");
export const cancelLeave = (id: string, note?: string) => rpc<LeaveRequest>("hr_leave_cancel", { p_id: id, p_note: note ?? null }, "The leave request could not be cancelled.");
export const decideLeave = (id: string, decision: "approved" | "rejected", note?: string) => rpc<LeaveRequest>("hr_leave_decide", { p_id: id, p_decision: decision, p_note: note ?? null }, "The decision could not be saved.");
export const listLeave = (filter: { status?: LeaveStatus | null; profileId?: string | null; from?: string | null; to?: string | null } = {}) =>
  rpc<{ scope: "company" | "team"; requests: LeaveRequest[] }>("hr_leave_list", { p_status: filter.status ?? null, p_profile: filter.profileId ?? null, p_from: filter.from ?? null, p_to: filter.to ?? null }, "The leave requests could not be loaded.");
export const adminAddLeave = (profileId: string, input: LeaveRequestInput) => rpc<LeaveRequest>("hr_admin_leave_add", { p_profile: profileId, p_request: input }, "The leave could not be entered.");
export const leaveBalances = (profileId: string) => rpc<LeaveBalances>("hr_leave_balances", { p_profile: profileId }, "The leave balances could not be loaded.");
export const adjustLeave = (profileId: string, leaveTypeId: string, hours: number, reason: string, kind: "opening" | "adjustment" = "adjustment") =>
  rpc<LeaveBalances>("hr_admin_leave_adjust", { p_profile: profileId, p_type: leaveTypeId, p_hours: hours, p_reason: reason, p_kind: kind }, "The balance could not be adjusted.");
export const listLeaveTypes = () => rpc<LeaveType[]>("hr_admin_leave_types", undefined, "The leave types could not be loaded.");
export const saveLeaveType = (id: string | null, type: Partial<Pick<LeaveType, "code" | "name" | "description" | "isPaid" | "requiresBalance" | "accrualMethod" | "sortOrder" | "isActive">>) =>
  rpc<LeaveType>("hr_admin_leave_type_save", { p_id: id, p_type: type }, "The leave type could not be saved.");
export const saveLeavePolicy = (leaveTypeId: string, policy: Partial<Omit<LeavePolicy, "id" | "effectiveTo" | "createdAt">>) =>
  rpc<LeaveType>("hr_admin_leave_policy_save", { p_type: leaveTypeId, p_policy: policy }, "The policy could not be saved.");

/* ------------------------------------------------------------------ timesheets and approvals */
export interface LeaveDay { day: string; hours: number; leaveTypeId: string; code: string; name: string; isPaid: boolean; requestId: string }
export interface HolidayDay { day: string; name: string; hours: number; isOptional: boolean; isPaid: boolean; requestId: string | null }
export interface PeriodSummary {
  periodId: string; profileId: string; workedHours: number; breakMinutes: number; openShifts: number; flags: ShiftFlag[]; paidLeaveHours: number; unpaidLeaveHours: number; holidayHours: number; unpaidHolidayHours: number;
  ordinaryHours: number; countedHours: number; overtimeHours: number; payBasis: "salary" | "hourly" | null; rate: number | null; estimatedGross: number | null; xeroEmployeeId: string;
  hasPaySetup: boolean; shifts: Shift[]; leave: LeaveDay[]; holidays: HolidayDay[];
  approval: { status: "approved" | "rejected"; decidedAt: string; note: string; decidedByName: string | null } | null; approvable: boolean;
}
export interface TimesheetRow extends PeriodSummary { name: string; jobTitle: string; employmentType: "full_time" | "part_time" | null; managerName: string | null; canDecide: boolean }
export interface PeriodTimesheets { period: PayPeriod; scope: "company" | "team"; timezone: string; employees: TimesheetRow[] }
export interface MyTimesheet { profileId: string; hasPaySetup: boolean; timezone: string; periods: PayPeriod[]; period: PayPeriod | null; summary: PeriodSummary | null }
export interface TeamReport { profileId: string; name: string; jobTitle: string; status: string; payScheduleId: string | null }
export interface MyTeam { isAdmin: boolean; profileId: string | null; isManager: boolean; reports: TeamReport[]; schedules: (PaySchedule & { periods: PayPeriod[] })[]; pendingLeave: number; pendingOptional: number }

export const periodTimesheets = (periodId: string) => rpc<PeriodTimesheets>("hr_period_timesheets", { p_period: periodId }, "The timesheets could not be loaded.");
export const decideTimesheet = (periodId: string, profileId: string, decision: "approved" | "rejected", note?: string) =>
  rpc<PeriodSummary>("hr_timesheet_decide", { p_period: periodId, p_profile: profileId, p_decision: decision, p_note: note ?? null }, "The decision could not be saved.");
export const myTimesheet = (periodId?: string | null) => rpc<MyTimesheet>("hr_my_timesheet", { p_period: periodId ?? null }, "Your timesheet could not be loaded.");
export const myTeam = () => rpc<MyTeam>("hr_my_team", undefined, "Your team could not be loaded.");

/* ------------------------------------------------------------------ Xero export */
export interface XeroLine { profileId: string; xeroEmployeeId: string; employeeName: string; date: string; payItem: string; hours: number; leaveTypeCode: string | null }
export interface XeroExport { id: string; periodId: string; exportedAt: string; employeeCount: number; lineCount: number; exportedByName: string | null; period: PayPeriod; lines?: XeroLine[]; csv?: string }
export interface XeroReadiness { period: PayPeriod; employees: { profileId: string; name: string; xeroEmployeeId: string; approved: boolean }[]; exports: XeroExport[] }

export const xeroReadiness = (periodId: string) => rpc<XeroReadiness>("hr_admin_xero_readiness", { p_period: periodId }, "The export readiness could not be loaded.");
export const xeroExport = (periodId: string) => rpc<XeroExport>("hr_admin_xero_export", { p_period: periodId }, "The export could not be produced.");
export const xeroExports = (id?: string | null) => rpc<XeroExport[] | XeroExport>("hr_admin_xero_exports", { p_id: id ?? null }, "The exports could not be loaded.");

/** Offers a text file for download (the Xero CSV). */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
