-- HRMS part 4: timesheets per pay period (worked, breaks, leave, holidays, ordinary, overtime, estimated gross), approvals by the
-- manager or HR (never one's own), period lock/unlock with leave accrual, the Xero Payroll AU export, and the admin sidebar rows.
-- Additive only. Payroll is calculated in Xero; the estimated gross here is display only.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------------------------ approvals
create table if not exists hr.timesheet_approvals (
 id uuid primary key default gen_random_uuid(),
 period_id uuid not null references hr.pay_periods(id) on delete restrict,
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 status text not null check (status in ('approved', 'rejected')),
 decided_by uuid not null,
 decided_at timestamptz not null default now(),
 note text not null default '' check (char_length(note) <= 1000),
 unique (period_id, profile_id)
);
alter table hr.timesheet_approvals enable row level security;
revoke all on hr.timesheet_approvals from public, anon, authenticated;

create table if not exists hr.xero_exports (
 id uuid primary key default gen_random_uuid(),
 period_id uuid not null references hr.pay_periods(id) on delete restrict,
 exported_by uuid not null,
 exported_at timestamptz not null default now(),
 employee_count integer not null,
 line_count integer not null,
 lines jsonb not null,
 csv text not null
);
create index if not exists xero_exports_period_idx on hr.xero_exports(period_id, exported_at desc);
alter table hr.xero_exports enable row level security;
revoke all on hr.xero_exports from public, anon, authenticated;

create or replace function hr.period_in_use(p_period uuid) returns boolean
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select exists (select 1 from hr.timesheet_approvals a where a.period_id = p_period)
  or exists (select 1 from hr.leave_ledger l where l.period_id = p_period)
  or exists (select 1 from hr.xero_exports x where x.period_id = p_period);
$fn$;
revoke all on function hr.period_in_use(uuid) from public, anon, authenticated;

-- The employees on a period's schedule (active staff with that pay schedule).
create or replace function hr.period_employees(p_period uuid) returns setof uuid
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select ep.profile_id from hr.employee_pay ep join hr.pay_periods p on p.schedule_id = ep.pay_schedule_id join hr.staff_profiles sp on sp.id = ep.profile_id
 where p.id = p_period and sp.status = 'active';
$fn$;
revoke all on function hr.period_employees(uuid) from public, anon, authenticated;

-- Approved leave of a person by day inside a period, with the type.
create or replace function hr.period_leave_days(p_period uuid, p_profile uuid)
returns table(day date, hours numeric, leave_type_id uuid, code text, name text, is_paid boolean, request_id uuid)
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select d.day, d.hours, t.id, t.code, t.name, t.is_paid, r.id
 from hr.pay_periods p join hr.leave_requests r on r.profile_id = p_profile and r.status = 'approved' and r.start_date <= p.end_date and r.end_date >= p.start_date
 join hr.leave_types t on t.id = r.leave_type_id
 cross join lateral hr.leave_day_hours(r.id) d
 where p.id = p_period and d.day between p.start_date and p.end_date
 order by d.day;
$fn$;
revoke all on function hr.period_leave_days(uuid, uuid) from public, anon, authenticated;

-- Confirmed public holidays inside a period that fall on the person's usual work days: paid at the daily ordinary hours.
create or replace function hr.period_holidays(p_period uuid, p_profile uuid) returns table(day date, name text, hours numeric)
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select h.holiday_date, h.name, hr.employee_daily_hours(p_profile)
 from hr.pay_periods p join hr.settings s on s.id
 join hr.public_holidays h on h.state = s.state and h.status = 'confirmed' and not h.is_optional and h.holiday_date between p.start_date and p.end_date
 where p.id = p_period and extract(isodow from h.holiday_date)::smallint = any(hr.employee_work_days(p_profile))
  and exists (select 1 from hr.employment e where e.profile_id = p_profile and (e.joining_date is null or e.joining_date <= h.holiday_date))
 order by h.holiday_date;
$fn$;
revoke all on function hr.period_holidays(uuid, uuid) from public, anon, authenticated;

-- Everything a timesheet row needs for one person in one period.
create or replace function hr.period_summary(p_period uuid, p_profile uuid) returns jsonb
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare p hr.pay_periods; ep hr.employee_pay; v_worked numeric := 0; v_break integer := 0; v_open integer := 0; v_flags text[] := '{}'; v_shifts jsonb;
 v_paid_leave numeric := 0; v_unpaid_leave numeric := 0; v_holiday numeric := 0; v_ordinary numeric; v_counted numeric; v_overtime numeric; v_gross numeric;
 v_leave jsonb; v_holidays jsonb; a hr.timesheet_approvals;
begin
 select * into p from hr.pay_periods where id = p_period;
 if not found then raise exception 'Pay period not found.' using errcode = 'P0002'; end if;
 select * into ep from hr.employee_pay where profile_id = p_profile;
 select coalesce(sum(case when not s.is_open then s.worked_minutes else 0 end), 0) / 60.0, coalesce(sum(case when not s.is_open then s.break_minutes else 0 end), 0),
  count(*) filter (where s.is_open), coalesce(array_agg(distinct f) filter (where f is not null), '{}'),
  coalesce(jsonb_agg(jsonb_build_object('workDate', s.work_date, 'startedAt', s.started_at, 'endedAt', s.ended_at, 'breakMinutes', s.break_minutes, 'workedMinutes', s.worked_minutes,
   'isOpen', s.is_open, 'flags', to_jsonb(s.flags), 'eventIds', to_jsonb(s.event_ids)) order by s.started_at), '[]'::jsonb)
  into v_worked, v_break, v_open, v_flags, v_shifts
  from hr.shifts(p_profile, p.start_date, p.end_date) s left join lateral unnest(s.flags) f on true;
 select coalesce(sum(case when l.is_paid then l.hours else 0 end), 0), coalesce(sum(case when not l.is_paid then l.hours else 0 end), 0),
  coalesce(jsonb_agg(jsonb_build_object('day', l.day, 'hours', l.hours, 'leaveTypeId', l.leave_type_id, 'code', l.code, 'name', l.name, 'isPaid', l.is_paid, 'requestId', l.request_id) order by l.day), '[]'::jsonb)
  into v_paid_leave, v_unpaid_leave, v_leave from hr.period_leave_days(p_period, p_profile) l;
 select coalesce(sum(h.hours), 0), coalesce(jsonb_agg(jsonb_build_object('day', h.day, 'name', h.name, 'hours', h.hours) order by h.day), '[]'::jsonb)
  into v_holiday, v_holidays from hr.period_holidays(p_period, p_profile) h;
 v_ordinary := hr.period_ordinary_hours(p_period, p_profile);
 v_worked := round(v_worked, 2);
 v_counted := round(v_worked + v_paid_leave + v_holiday, 2);
 v_overtime := greatest(0, round(v_counted - v_ordinary, 2));
 v_gross := case ep.pay_basis
  when 'salary' then round(ep.rate / (select case s.frequency when 'fortnightly' then 26 else 12 end from hr.pay_schedules s where s.id = p.schedule_id), 2)
  when 'hourly' then round(v_counted * ep.rate, 2) end;
 select * into a from hr.timesheet_approvals where period_id = p_period and profile_id = p_profile;
 return jsonb_build_object(
  'periodId', p_period, 'profileId', p_profile,
  'workedHours', v_worked, 'breakMinutes', v_break, 'openShifts', v_open, 'flags', to_jsonb(v_flags),
  'paidLeaveHours', round(v_paid_leave, 2), 'unpaidLeaveHours', round(v_unpaid_leave, 2), 'holidayHours', round(v_holiday, 2),
  'ordinaryHours', v_ordinary, 'countedHours', v_counted, 'overtimeHours', v_overtime,
  'payBasis', ep.pay_basis, 'rate', ep.rate, 'estimatedGross', v_gross, 'xeroEmployeeId', coalesce(ep.xero_employee_id, ''),
  'hasPaySetup', ep.profile_id is not null and ep.pay_schedule_id is not null,
  'shifts', v_shifts, 'leave', v_leave, 'holidays', v_holidays,
  'approval', case when a.id is null then null else jsonb_build_object('status', a.status, 'decidedAt', a.decided_at, 'note', a.note,
   'decidedByName', coalesce((select hr.staff_name(sp) from hr.staff_profiles sp where sp.auth_user_id = a.decided_by), (select u.name from public.cms_users u where u.auth_user_id = a.decided_by))) end,
  'approvable', v_open = 0 and not (v_flags && array['missing_punch_out', 'unclosed_break']::text[]));
end $fn$;
revoke all on function hr.period_summary(uuid, uuid) from public, anon, authenticated;

-- One line per local date per pay item for the export: Ordinary and Overtime (overtime taken from the last worked days backwards),
-- Public Holiday, and each leave type by name.
create or replace function hr.period_day_lines(p_period uuid, p_profile uuid) returns table(day date, pay_item text, hours numeric, leave_type_code text)
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare p hr.pay_periods; v_summary jsonb; v_overtime numeric; r record; v_take numeric;
begin
 select * into p from hr.pay_periods where id = p_period;
 v_summary := hr.period_summary(p_period, p_profile);
 v_overtime := (v_summary->>'overtimeHours')::numeric;
 -- Worked hours by local date (closed shifts only), latest day first so overtime comes off the end of the period.
 for r in select s.work_date as d, round(sum(s.worked_minutes) / 60.0, 2) as h from hr.shifts(p_profile, p.start_date, p.end_date) s where not s.is_open group by s.work_date order by s.work_date desc loop
  v_take := least(v_overtime, r.h);
  if v_take > 0 then day := r.d; pay_item := 'Overtime'; hours := v_take; leave_type_code := null; return next; v_overtime := v_overtime - v_take; end if;
  if r.h - v_take > 0 then day := r.d; pay_item := 'Ordinary'; hours := round(r.h - v_take, 2); leave_type_code := null; return next; end if;
 end loop;
 for r in select h.day as d, h.hours as h from hr.period_holidays(p_period, p_profile) h loop
  day := r.d; pay_item := 'Public Holiday'; hours := r.h; leave_type_code := null; return next;
 end loop;
 for r in select l.day as d, sum(l.hours) as h, l.name, l.code from hr.period_leave_days(p_period, p_profile) l group by l.day, l.name, l.code order by l.day loop
  day := r.d; pay_item := r.name; hours := round(r.h, 2); leave_type_code := r.code; return next;
 end loop;
 return;
end $fn$;
revoke all on function hr.period_day_lines(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ accrual (runs when a period is locked, for approved timesheets)
-- Accrues on ordinary hours INCLUDING paid leave and paid public holidays, never on overtime (counted hours are capped at the
-- period's ordinary hours, which also pro-rates part-time staff). One accrual row per person, type and period.
create or replace function hr.accrue_period(p_period uuid, p_profile uuid) returns integer
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare p hr.pay_periods; v_summary jsonb; v_counted numeric; v_ft numeric := (select s.ordinary_hours_week from hr.settings s where s.id); t record; pol hr.leave_policies; v_hours numeric; v_n integer := 0;
begin
 select * into p from hr.pay_periods where id = p_period;
 v_summary := hr.period_summary(p_period, p_profile);
 v_counted := least((v_summary->>'countedHours')::numeric, (v_summary->>'ordinaryHours')::numeric);
 if v_counted <= 0 then return 0; end if;
 for t in select * from hr.leave_types where is_active and accrual_method in ('progressive', 'long_service') loop
  pol := hr.policy_for(t.id, p.end_date);
  if pol.id is null then continue; end if;
  v_hours := case t.accrual_method
   when 'progressive' then round(coalesce(pol.hours_per_year, 0) / (v_ft * 52) * v_counted, 2)
   when 'long_service' then round(coalesce(pol.accrual_fraction, 0) * v_counted, 2) end;
  if coalesce(v_hours, 0) <= 0 then continue; end if;
  insert into hr.leave_ledger(profile_id, leave_type_id, entry_kind, hours, effective_date, period_id, reason, created_by)
   values (p_profile, t.id, 'accrual', v_hours, p.end_date, p.id, 'Accrual for ' || p.start_date || ' to ' || p.end_date || ' on ' || v_counted || ' ordinary hours', auth.uid())
   on conflict do nothing;
  if found then v_n := v_n + 1; end if;
 end loop;
 return v_n;
end $fn$;
revoke all on function hr.accrue_period(uuid, uuid) from public, anon, authenticated;

-- A time correction or a leave change inside an OPEN period reopens that person's approval (the timesheet changed).
create or replace function hr.reset_approval(p_profile uuid, p_from date, p_to date) returns void
language sql security definer set search_path = hr, pg_temp as $fn$
 delete from hr.timesheet_approvals a using hr.pay_periods p, hr.employee_pay ep
 where a.id is not null and p.id = a.period_id and ep.profile_id = a.profile_id and p.schedule_id = ep.pay_schedule_id
  and a.profile_id = p_profile and p.status = 'open' and p.start_date <= p_to and p.end_date >= p_from;
$fn$;
revoke all on function hr.reset_approval(uuid, date, date) from public, anon, authenticated;

create or replace function hr.time_events_reset_approval() returns trigger
language plpgsql security definer set search_path = hr, pg_temp as $fn$
begin
 if new.source = 'correction' then perform hr.reset_approval(new.profile_id, hr.local_date(new.at) - 1, hr.local_date(new.at) + 1); end if;
 return new;
end $fn$;
drop trigger if exists time_events_reset_approval on hr.time_events;
create trigger time_events_reset_approval after insert on hr.time_events for each row execute function hr.time_events_reset_approval();

create or replace function hr.leave_requests_reset_approval() returns trigger
language plpgsql security definer set search_path = hr, pg_temp as $fn$
begin
 if tg_op = 'UPDATE' and new.status is distinct from old.status and (new.status = 'approved' or old.status = 'approved') then
  perform hr.reset_approval(new.profile_id, new.start_date, new.end_date);
 end if;
 return new;
end $fn$;
drop trigger if exists leave_requests_reset_approval on hr.leave_requests;
create trigger leave_requests_reset_approval after update on hr.leave_requests for each row execute function hr.leave_requests_reset_approval();

-- ------------------------------------------------------------------ RPCs: timesheets
create or replace function public.hr_period_timesheets(p_period uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.pay_periods; v_me uuid := hr.me_profile(); v_admin boolean := hr.is_admin();
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.pay_periods where id = p_period;
 if not found then raise exception 'Pay period not found.' using errcode = 'P0002'; end if;
 if not v_admin and not exists (select 1 from hr.employment e where e.manager_id = v_me) then raise exception 'Only HR or a manager can see this.' using errcode = '42501'; end if;
 return jsonb_build_object('period', hr.period_json(p), 'scope', case when v_admin then 'company' else 'team' end, 'timezone', hr.tz(),
  'employees', coalesce((select jsonb_agg(hr.period_summary(p.id, e.profile_id) || jsonb_build_object('name', hr.staff_name(sp), 'jobTitle', em.job_title, 'employmentType', em.employment_type,
    'managerName', (select hr.staff_name(m) from hr.staff_profiles m where m.id = em.manager_id), 'canDecide', (v_admin or em.manager_id = v_me) and e.profile_id is distinct from v_me)
    order by hr.staff_name(sp))
   from hr.period_employees(p.id) e(profile_id) join hr.staff_profiles sp on sp.id = e.profile_id join hr.employment em on em.profile_id = e.profile_id
   where v_admin or em.manager_id = v_me), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_period_timesheets(uuid) from public, anon;
grant execute on function public.hr_period_timesheets(uuid) to authenticated;

create or replace function public.hr_timesheet_decide(p_period uuid, p_profile uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.pay_periods; v_summary jsonb;
begin
 perform hr.require_decider(p_profile);
 select * into p from hr.pay_periods where id = p_period for update;
 if not found then raise exception 'Pay period not found.' using errcode = 'P0002'; end if;
 if p.status = 'exported' then raise exception 'This period was exported to Xero and is final.' using errcode = '22023'; end if;
 if not exists (select 1 from hr.period_employees(p.id) e(profile_id) where e.profile_id = p_profile) then raise exception 'This person is not on the period''s pay schedule.' using errcode = '22023'; end if;
 if p_decision not in ('approved', 'rejected') then raise exception 'Decision must be approved or rejected.' using errcode = '22023'; end if;
 if p_decision = 'approved' then
  v_summary := hr.period_summary(p.id, p_profile);
  if (v_summary->>'openShifts')::integer > 0 then raise exception 'The timesheet has an open shift; punch out or correct it first.' using errcode = '22023'; end if;
  if not (v_summary->>'approvable')::boolean then raise exception 'The timesheet has a missing punch-out or an unclosed break; correct it first.' using errcode = '22023'; end if;
 end if;
 insert into hr.timesheet_approvals(period_id, profile_id, status, decided_by, decided_at, note) values (p.id, p_profile, p_decision, auth.uid(), now(), left(btrim(coalesce(p_note, '')), 1000))
 on conflict (period_id, profile_id) do update set status = excluded.status, decided_by = excluded.decided_by, decided_at = excluded.decided_at, note = excluded.note;
 if p_decision = 'approved' and p.status = 'locked' then perform hr.accrue_period(p.id, p_profile); end if;
 return hr.period_summary(p.id, p_profile);
end $fn$;
revoke all on function public.hr_timesheet_decide(uuid, uuid, text, text) from public, anon;
grant execute on function public.hr_timesheet_decide(uuid, uuid, text, text) to authenticated;

-- open <-> locked (exported is final). Locking accrues leave for every approved timesheet; unlocking removes those accruals again.
create or replace function public.hr_admin_period_set_status(p_period uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.pay_periods; e record;
begin
 perform hr.require_admin();
 select * into p from hr.pay_periods where id = p_period for update;
 if not found then raise exception 'Pay period not found.' using errcode = 'P0002'; end if;
 if p.status = 'exported' then raise exception 'This period was exported to Xero and is final.' using errcode = '22023'; end if;
 if p_status not in ('open', 'locked') then raise exception 'Status must be open or locked.' using errcode = '22023'; end if;
 if p_status = 'locked' and p.status = 'open' then
  update hr.pay_periods set status = 'locked', locked_at = now(), locked_by = auth.uid() where id = p.id;
  for e in select a.profile_id from hr.timesheet_approvals a where a.period_id = p.id and a.status = 'approved' loop
   perform hr.accrue_period(p.id, e.profile_id);
  end loop;
 elsif p_status = 'open' and p.status = 'locked' then
  delete from hr.leave_ledger where period_id = p.id and entry_kind = 'accrual';
  update hr.pay_periods set status = 'open', locked_at = null, locked_by = null where id = p.id;
 end if;
 select * into p from hr.pay_periods where id = p_period;
 return hr.period_json(p);
end $fn$;
revoke all on function public.hr_admin_period_set_status(uuid, text) from public, anon;
grant execute on function public.hr_admin_period_set_status(uuid, text) to authenticated;

-- The employee's own timesheet: their schedule's periods (6 months back, 1 ahead) and one period in detail.
create or replace function public.hr_my_timesheet(p_period uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.require_me(); ep hr.employee_pay; p hr.pay_periods;
begin
 select * into ep from hr.employee_pay where profile_id = v_me;
 if ep.pay_schedule_id is null then return jsonb_build_object('profileId', v_me, 'hasPaySetup', false, 'periods', '[]'::jsonb, 'period', null, 'summary', null, 'timezone', hr.tz()); end if;
 if p_period is not null then
  select * into p from hr.pay_periods where id = p_period and schedule_id = ep.pay_schedule_id;
  if not found then raise exception 'Pay period not found.' using errcode = 'P0002'; end if;
 else select * into p from hr.pay_periods where schedule_id = ep.pay_schedule_id and current_date between start_date and end_date; end if;
 if p.id is null then select * into p from hr.pay_periods where schedule_id = ep.pay_schedule_id and start_date <= current_date order by start_date desc limit 1; end if;
 return jsonb_build_object('profileId', v_me, 'hasPaySetup', true, 'timezone', hr.tz(),
  'periods', coalesce((select jsonb_agg(hr.period_json(x) order by x.start_date desc) from hr.pay_periods x where x.schedule_id = ep.pay_schedule_id
    and x.end_date >= current_date - 190 and x.start_date <= current_date + 35), '[]'::jsonb),
  'period', case when p.id is null then null else hr.period_json(p) end,
  'summary', case when p.id is null then null else hr.period_summary(p.id, v_me) end);
end $fn$;
revoke all on function public.hr_my_timesheet(uuid) from public, anon;
grant execute on function public.hr_my_timesheet(uuid) to authenticated;

-- Who the signed-in person may oversee, and the schedules/periods to pick from (manager or HR).
create or replace function public.hr_my_team() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.me_profile(); v_admin boolean := hr.is_admin();
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 return jsonb_build_object('isAdmin', v_admin, 'profileId', v_me,
  'isManager', exists (select 1 from hr.employment e where e.manager_id = v_me),
  'reports', coalesce((select jsonb_agg(jsonb_build_object('profileId', e.profile_id, 'name', hr.staff_name(sp), 'jobTitle', e.job_title, 'status', sp.status,
    'payScheduleId', (select ep.pay_schedule_id from hr.employee_pay ep where ep.profile_id = e.profile_id)) order by hr.staff_name(sp))
    from hr.employment e join hr.staff_profiles sp on sp.id = e.profile_id where (v_admin and sp.status = 'active') or e.manager_id = v_me), '[]'::jsonb),
  'schedules', coalesce((select jsonb_agg(hr.schedule_json(s) || jsonb_build_object('periods', coalesce((select jsonb_agg(hr.period_json(p) order by p.start_date desc)
    from hr.pay_periods p where p.schedule_id = s.id and p.end_date >= current_date - 190 and p.start_date <= current_date + 35), '[]'::jsonb)) order by s.name)
    from hr.pay_schedules s where s.is_active), '[]'::jsonb),
  'pendingLeave', (select count(*) from hr.leave_requests r where r.status = 'pending' and (v_admin or exists (select 1 from hr.employment e where e.profile_id = r.profile_id and e.manager_id = v_me))));
end $fn$;
revoke all on function public.hr_my_team() from public, anon;
grant execute on function public.hr_my_team() to authenticated;

-- ------------------------------------------------------------------ Xero export
create or replace function hr.xero_csv(p_lines jsonb) returns text
language sql immutable as $fn$
 select 'EmployeeId,EmployeeName,Date,PayItem,Hours,LeaveType' || chr(10) || coalesce(string_agg(
  format('%s,%s,%s,%s,%s,%s', '"' || replace(l->>'xeroEmployeeId', '"', '""') || '"', '"' || replace(l->>'employeeName', '"', '""') || '"', l->>'date',
   '"' || replace(l->>'payItem', '"', '""') || '"', l->>'hours', coalesce(l->>'leaveTypeCode', '')), chr(10) order by l->>'employeeName', l->>'date', l->>'payItem'), '')
 from jsonb_array_elements(p_lines) l;
$fn$;
revoke all on function hr.xero_csv(jsonb) from public, anon, authenticated;

create or replace function hr.xero_export_json(x hr.xero_exports, p_with_lines boolean) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('id', x.id, 'periodId', x.period_id, 'exportedAt', x.exported_at, 'employeeCount', x.employee_count, 'lineCount', x.line_count,
  'exportedByName', (select u.name from public.cms_users u where u.auth_user_id = x.exported_by),
  'period', (select hr.period_json(p) from hr.pay_periods p where p.id = x.period_id))
  || case when p_with_lines then jsonb_build_object('lines', x.lines, 'csv', x.csv) else '{}'::jsonb end;
$fn$;
revoke all on function hr.xero_export_json(hr.xero_exports, boolean) from public, anon, authenticated;

-- Readiness of a period for export: locked, every employee approved, every Xero employee id present.
create or replace function public.hr_admin_xero_readiness(p_period uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.pay_periods;
begin
 perform hr.require_admin();
 select * into p from hr.pay_periods where id = p_period;
 if not found then raise exception 'Pay period not found.' using errcode = 'P0002'; end if;
 return jsonb_build_object('period', hr.period_json(p),
  'employees', coalesce((select jsonb_agg(jsonb_build_object('profileId', e.profile_id, 'name', hr.staff_name(sp), 'xeroEmployeeId', ep.xero_employee_id,
    'approved', exists (select 1 from hr.timesheet_approvals a where a.period_id = p.id and a.profile_id = e.profile_id and a.status = 'approved')) order by hr.staff_name(sp))
    from hr.period_employees(p.id) e(profile_id) join hr.staff_profiles sp on sp.id = e.profile_id join hr.employee_pay ep on ep.profile_id = e.profile_id), '[]'::jsonb),
  'exports', coalesce((select jsonb_agg(hr.xero_export_json(x, false) order by x.exported_at desc) from hr.xero_exports x where x.period_id = p.id), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_admin_xero_readiness(uuid) from public, anon;
grant execute on function public.hr_admin_xero_readiness(uuid) to authenticated;

create or replace function public.hr_admin_xero_export(p_period uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.pay_periods; v_lines jsonb; v_employees integer; x hr.xero_exports; v_missing text;
begin
 perform hr.require_admin();
 select * into p from hr.pay_periods where id = p_period for update;
 if not found then raise exception 'Pay period not found.' using errcode = 'P0002'; end if;
 if p.status = 'exported' then raise exception 'This period was already exported.' using errcode = '22023'; end if;
 if p.status <> 'locked' then raise exception 'Lock the period before exporting it.' using errcode = '22023'; end if;
 select count(*) into v_employees from hr.period_employees(p.id);
 if v_employees = 0 then raise exception 'No employee is on this pay schedule.' using errcode = '22023'; end if;
 select string_agg(hr.staff_name(sp), ', ' order by hr.staff_name(sp)) into v_missing from hr.period_employees(p.id) e(profile_id) join hr.staff_profiles sp on sp.id = e.profile_id
  where not exists (select 1 from hr.timesheet_approvals a where a.period_id = p.id and a.profile_id = e.profile_id and a.status = 'approved');
 if v_missing is not null then raise exception 'Not yet approved: %.', v_missing using errcode = '22023'; end if;
 select string_agg(hr.staff_name(sp), ', ' order by hr.staff_name(sp)) into v_missing from hr.period_employees(p.id) e(profile_id) join hr.staff_profiles sp on sp.id = e.profile_id
  join hr.employee_pay ep on ep.profile_id = e.profile_id where btrim(ep.xero_employee_id) = '';
 if v_missing is not null then raise exception 'Missing Xero employee id: %.', v_missing using errcode = '22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('profileId', e.profile_id, 'xeroEmployeeId', ep.xero_employee_id, 'employeeName', hr.staff_name(sp), 'date', d.day, 'payItem', d.pay_item,
   'hours', d.hours, 'leaveTypeCode', d.leave_type_code) order by hr.staff_name(sp), d.day, d.pay_item), '[]'::jsonb)
  into v_lines
  from hr.period_employees(p.id) e(profile_id) join hr.staff_profiles sp on sp.id = e.profile_id join hr.employee_pay ep on ep.profile_id = e.profile_id
  cross join lateral hr.period_day_lines(p.id, e.profile_id) d;
 insert into hr.xero_exports(period_id, exported_by, employee_count, line_count, lines, csv)
  values (p.id, auth.uid(), v_employees, jsonb_array_length(v_lines), v_lines, hr.xero_csv(v_lines)) returning * into x;
 update hr.pay_periods set status = 'exported', exported_at = now() where id = p.id;
 return hr.xero_export_json(x, true);
end $fn$;
revoke all on function public.hr_admin_xero_export(uuid) from public, anon;
grant execute on function public.hr_admin_xero_export(uuid) to authenticated;

create or replace function public.hr_admin_xero_exports(p_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 if p_id is not null then return (select hr.xero_export_json(x, true) from hr.xero_exports x where x.id = p_id); end if;
 return coalesce((select jsonb_agg(hr.xero_export_json(x, false) order by x.exported_at desc) from hr.xero_exports x), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_admin_xero_exports(uuid) from public, anon;
grant execute on function public.hr_admin_xero_exports(uuid) to authenticated;

-- ------------------------------------------------------------------ admin sidebar: Staff > Timesheets, Leave, Pay Schedules, Public Holidays, Xero Export
do $menu$
declare v_item public.admin_menu_items;
begin
 select * into v_item from public.admin_menu_items where id = 'agency_staff';
 if v_item.id is null then select * into v_item from public.admin_menu_items where id = 'staff_candidates'; end if;
 alter table public.admin_menu_items disable trigger protect_admin_menu;
 insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, is_enabled, permission_key, permission_scope, is_system) values
  ('staff_timesheets', 'staff', 'Timesheets', '/admin/staff/timesheets', 'time', 40, true, coalesce(v_item.permission_key, 'cms.admin'), coalesce(v_item.permission_scope, 'current'), true),
  ('staff_leave', 'staff', 'Leave', '/admin/staff/leave', 'leave', 50, true, coalesce(v_item.permission_key, 'cms.admin'), coalesce(v_item.permission_scope, 'current'), true),
  ('staff_pay_schedules', 'staff', 'Pay Schedules', '/admin/staff/pay-schedules', 'pay', 60, true, coalesce(v_item.permission_key, 'cms.admin'), coalesce(v_item.permission_scope, 'current'), true),
  ('staff_holidays', 'staff', 'Public Holidays', '/admin/staff/holidays', 'calendar', 70, true, coalesce(v_item.permission_key, 'cms.admin'), coalesce(v_item.permission_scope, 'current'), true),
  ('staff_xero', 'staff', 'Xero Export', '/admin/staff/xero-export', 'export', 80, true, coalesce(v_item.permission_key, 'cms.admin'), coalesce(v_item.permission_scope, 'current'), true)
 on conflict (id) do update set parent_id = 'staff', label = excluded.label, route = excluded.route, icon_key = excluded.icon_key, sort_order = excluded.sort_order, is_enabled = true;
 alter table public.admin_menu_items enable trigger protect_admin_menu;
end $menu$;
