begin;
-- HRMS (Victoria): settings and timezone, public holidays, time & attendance (DST, state machine, append-only log, corrections,
-- period lock), pay schedules and periods (fortnightly / monthly), overtime maths, leave (balances, requests, approvals, accrual
-- on lock), timesheet approvals, the Xero export, and who may see what. Fixtures only; rolled back. Run: npx supabase test db
-- RPCs run as role authenticated with a JWT subject (pg_temp.as); table checks run as postgres again (pg_temp.su).
select plan(178);

-- ---------------------------------------------------------------- fixtures
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
 ('b0000000-0000-0000-0000-000000000001', 'hrms.admin@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('b0000000-0000-0000-0000-000000000002', 'hrms.manager@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('b0000000-0000-0000-0000-000000000003', 'hrms.emp1@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('b0000000-0000-0000-0000-000000000004', 'hrms.emp2@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('b0000000-0000-0000-0000-000000000005', 'hrms.outsider@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('b0000000-0000-0000-0000-000000000006', 'hrms.dst@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('b0000000-0000-0000-0000-000000000007', 'hrms.inactive@example.test', now(), '{}', 'authenticated', 'authenticated');
insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password) values
 ('hrms-test-admin', 'HRMS Admin', 'hrms.admin@example.test', 'Admin', 'Active', 'b0000000-0000-0000-0000-000000000001', false);

alter table hr.staff_profiles disable trigger staff_status_guard;
insert into hr.staff_profiles(id, auth_user_id, first_name, last_name, email, phone_e164, status) values
 ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'Mary', 'Manager', 'hrms.manager@example.test', '+61400000102', 'active'),
 ('c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000003', 'Eve', 'Fulltime', 'hrms.emp1@example.test', '+61400000103', 'active'),
 ('c0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000004', 'Pat', 'Parttime', 'hrms.emp2@example.test', '+61400000104', 'active'),
 ('c0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000005', 'Olly', 'Outsider', 'hrms.outsider@example.test', '+61400000105', 'active'),
 ('c0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000006', 'Dee', 'Daylight', 'hrms.dst@example.test', '+61400000106', 'active'),
 ('c0000000-0000-0000-0000-000000000007', 'b0000000-0000-0000-0000-000000000007', 'Ina', 'Inactive', 'hrms.inactive@example.test', '+61400000107', 'inactive');
alter table hr.staff_profiles enable trigger staff_status_guard;
insert into hr.employment(profile_id, department, job_title, employment_type, joining_date, manager_id) values
 ('c0000000-0000-0000-0000-000000000002', 'Training', 'Head trainer', 'full_time', date '2015-02-02', null),
 ('c0000000-0000-0000-0000-000000000003', 'Training', 'Trainer', 'full_time', date '2024-01-15', 'c0000000-0000-0000-0000-000000000002'),
 ('c0000000-0000-0000-0000-000000000004', 'Admin', 'Officer', 'part_time', date '2025-06-01', 'c0000000-0000-0000-0000-000000000002'),
 ('c0000000-0000-0000-0000-000000000005', 'Admin', 'Officer', 'full_time', date '2025-06-01', null),
 ('c0000000-0000-0000-0000-000000000006', 'Admin', 'Officer', 'full_time', date '2025-06-01', 'c0000000-0000-0000-0000-000000000002')
on conflict (profile_id) do update set manager_id = excluded.manager_id, joining_date = excluded.joining_date, employment_type = excluded.employment_type;

create temp table t(k text primary key, v text);
grant select, insert on t to public;
create function pg_temp.v(text) returns uuid language sql stable as $$ select v::uuid from t where k = $1 $$;
create function pg_temp.d(text) returns date language sql stable as $$ select v::date from t where k = $1 $$;
create function pg_temp.mel(text) returns timestamptz language sql immutable as $$ select $1::timestamp at time zone 'Australia/Melbourne' $$;
-- Run the next statements as a signed-in person / as postgres again.
create function pg_temp.as(p_uid text) returns void language plpgsql as $$ begin execute 'set local role authenticated'; perform set_config('request.jwt.claim.sub', p_uid, true); end $$;
create function pg_temp.su() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
-- A punch written straight into the log (fixtures for past periods; the RPC only punches "now"). Postgres only.
create function pg_temp.punch(p_profile uuid, p_kind text, p_at timestamptz) returns uuid language sql as $$
 insert into hr.time_events(profile_id, kind, at, source, recorded_by) values (p_profile, p_kind, p_at, 'web', 'b0000000-0000-0000-0000-000000000001') returning id $$;
create function pg_temp.shift(p_profile uuid, p_day date, p_from text, p_to text) returns void language sql as $$
 select pg_temp.punch(p_profile, 'punch_in', pg_temp.mel(p_day || ' ' || p_from)),
  pg_temp.punch(p_profile, 'punch_out', pg_temp.mel(case when position(' ' in p_to) > 0 then p_to else p_day || ' ' || p_to end)) $$;
create function pg_temp.summary(p_period text, p_profile uuid) returns jsonb language sql as $$ select hr.period_summary(pg_temp.v(p_period), p_profile) $$;

-- Test schedules whose periods cover today (the seeded ones start on 2026-11-16 / 2026-12-01).
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
insert into t select 'fn', (public.hr_admin_schedule_save(null, '{"name":"Test Fortnightly","frequency":"fortnightly","anchorDate":"2026-01-05","payDateOffsetDays":3}'))->>'id';
insert into t select 'mo', (public.hr_admin_schedule_save(null, '{"name":"Test Monthly","frequency":"monthly","anchorDate":"2026-01-01","payDateOffsetDays":0}'))->>'id';
select lives_ok($$select public.hr_admin_employee_pay_save('c0000000-0000-0000-0000-000000000003', jsonb_build_object('payScheduleId', pg_temp.v('fn'), 'payBasis', 'salary', 'rate', 100000, 'xeroEmployeeId', 'X-EVE'))$$, 'pay setup: full-time salary on the fortnightly schedule');
select lives_ok($$select public.hr_admin_employee_pay_save('c0000000-0000-0000-0000-000000000002', jsonb_build_object('payScheduleId', pg_temp.v('fn'), 'payBasis', 'salary', 'rate', 130000, 'xeroEmployeeId', 'X-MARY'))$$, 'pay setup: the manager is on the fortnightly schedule too');
select lives_ok($$select public.hr_admin_employee_pay_save('c0000000-0000-0000-0000-000000000004', jsonb_build_object('payScheduleId', pg_temp.v('mo'), 'payBasis', 'hourly', 'rate', 40, 'ordinaryHoursWeek', 19, 'usualWorkDays', '[1,2,3]'::jsonb, 'xeroEmployeeId', 'X-PAT'))$$, 'pay setup: part-time hourly, 19 h over Mon-Wed, on the monthly schedule');
select is((public.hr_admin_employee_pay('c0000000-0000-0000-0000-000000000004'))->>'dailyHours', '6.33', 'part-time daily hours = 19 / 3');
select is((public.hr_admin_employee_pay('c0000000-0000-0000-0000-000000000003'))->>'dailyHours', '7.60', 'full-time daily hours = 38 / 5');
select throws_ok($$select public.hr_admin_schedule_save(null, '{"name":"Bad","frequency":"fortnightly","anchorDate":"2026-01-06"}')$$, 'A fortnightly schedule starts on a Monday.', 'fortnightly anchor must be a Monday');
select throws_ok($$select public.hr_admin_schedule_save(null, '{"name":"Bad","frequency":"monthly","anchorDate":"2026-01-02"}')$$, 'A monthly schedule starts on the first of a month.', 'monthly anchor must be the first');
select pg_temp.su();

-- ---------------------------------------------------------------- settings and timezone
select is(hr.tz(), 'Australia/Melbourne', 'timezone comes from hr.settings');
select is(hr.local_date(pg_temp.mel('2026-10-03 23:30')), date '2026-10-03', 'local date of a late-evening instant is the local day');
select is(hr.local_midnight(date '2026-10-04'), pg_temp.mel('2026-10-04 00:00'), 'local midnight is DST-aware');
select pg_temp.as('b0000000-0000-0000-0000-000000000003');
select is((public.hr_settings())->>'timezone', 'Australia/Melbourne', 'any signed-in person reads the HR settings');
select throws_ok($$select public.hr_admin_settings_save('{"timezone":"Australia/Perth"}')$$, 'Only an administrator can do this.', 'only an admin changes the settings');
select pg_temp.su();
select is((select count(*) from cron.job where jobname = 'hr-pay-periods-topup' and not active), 1::bigint, 'the pay-period top-up cron job exists and is inactive');

-- ---------------------------------------------------------------- DST (Melbourne): hours worked = elapsed time, work date = start day
select pg_temp.shift('c0000000-0000-0000-0000-000000000006', date '2026-10-03', '22:00', '2026-10-04 06:00');
select pg_temp.shift('c0000000-0000-0000-0000-000000000006', date '2027-04-03', '22:00', '2027-04-04 06:00');
select is((select worked_minutes from hr.shifts('c0000000-0000-0000-0000-000000000006', '2026-10-03', '2026-10-03')), 420, 'DST start night 22:00 -> 06:00 Melbourne is 7.0 hours');
select is((select work_date from hr.shifts('c0000000-0000-0000-0000-000000000006', '2026-10-03', '2026-10-03')), date '2026-10-03', 'the DST-start night shift belongs to its start day');
select is((select worked_minutes from hr.shifts('c0000000-0000-0000-0000-000000000006', '2027-04-03', '2027-04-03')), 540, 'DST end night 22:00 -> 06:00 Melbourne is 9.0 hours');
select is((select work_date from hr.shifts('c0000000-0000-0000-0000-000000000006', '2027-04-03', '2027-04-03')), date '2027-04-03', 'the DST-end night shift belongs to its start day');
select is((select count(*) from hr.shifts('c0000000-0000-0000-0000-000000000006', '2026-10-04', '2026-10-04')), 0::bigint, 'the night shift is not also counted on the next day');
select is((select flags from hr.shifts('c0000000-0000-0000-0000-000000000006', '2026-10-03', '2026-10-03')), '{weekend}'::text[], 'a Saturday shift is flagged weekend');

-- ---------------------------------------------------------------- state machine (live punches by the employee)
select pg_temp.as('b0000000-0000-0000-0000-000000000003');
select is((public.hr_time_status())->>'state', 'none', 'no punches yet: state none');
select is((public.hr_time_status())->'nextKinds', '["punch_in"]'::jsonb, 'only punch in is offered');
select throws_ok($$select public.hr_time_punch('break_start')$$, 'That punch is not possible right now (current state: none).', 'a break before punching in is refused');
select throws_ok($$select public.hr_time_punch('punch_out')$$, 'That punch is not possible right now (current state: none).', 'punching out before punching in is refused');
select is((public.hr_time_punch('punch_in'))->>'state', 'punch_in', 'punch in');
select throws_ok($$select public.hr_time_punch('punch_in')$$, 'That punch is not possible right now (current state: punch in).', 'a second punch in is refused');
select is((public.hr_time_punch('break_start'))->>'state', 'break_start', 'break start');
select throws_ok($$select public.hr_time_punch('punch_out')$$, 'That punch is not possible right now (current state: break start).', 'punching out during a break is refused');
select is((public.hr_time_status())->'nextKinds', '["break_end"]'::jsonb, 'on a break only end break is offered');
select is((public.hr_time_punch('break_end'))->>'state', 'break_end', 'break end');
select is((public.hr_time_status())->'nextKinds', '["break_start","punch_out"]'::jsonb, 'after a break: another break or punch out');
select is((public.hr_time_status())->'openShift'->>'startedAt' is not null, true, 'the open shift is reported');
select is((public.hr_time_punch('punch_out'))->>'state', 'punch_out', 'punch out');
select is(jsonb_array_length((public.hr_time_status())->'todayShifts'), 1, 'today shows the closed shift');
select throws_ok($$select public.hr_time_punch('punch_in', 'desktop-agent')$$, 'Punches come from the web or the mobile web.', 'only web and mobile sources');
select throws_ok($$select public.hr_time_punch('teleport')$$, 'Unknown punch.', 'unknown kinds are refused');
select pg_temp.as('b0000000-0000-0000-0000-000000000007');
select throws_ok($$select public.hr_time_punch('punch_in')$$, 'Only an active employee can do this.', 'an inactive person cannot punch');
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select throws_ok($$select public.hr_time_punch('punch_in')$$, 'Only an active employee can do this.', 'an admin without a staff record cannot punch');
select pg_temp.su();

-- ---------------------------------------------------------------- append-only log
select throws_ok($$update hr.time_events set at = now() where profile_id = 'c0000000-0000-0000-0000-000000000006'$$, '0A000', null, 'time events cannot be updated');
select throws_ok($$delete from hr.time_events where profile_id = 'c0000000-0000-0000-0000-000000000006'$$, '0A000', null, 'time events cannot be deleted');
select throws_ok($$truncate hr.time_events$$, '0A000', null, 'time events cannot be truncated');
select throws_ok($$insert into hr.time_events(profile_id, kind, at, source, recorded_by) values ('c0000000-0000-0000-0000-000000000006', 'punch_in', now(), 'correction', 'b0000000-0000-0000-0000-000000000001')$$,
 '23514', null, 'a correction needs a reason');

-- ---------------------------------------------------------------- corrections (HR or the manager, never one's own; locked periods refuse)
insert into t select 'eve_out', id::text from hr.time_events where profile_id = 'c0000000-0000-0000-0000-000000000003' and kind = 'punch_out' order by at desc limit 1;
insert into t select 'eve_in_at', at::text from hr.time_events where profile_id = 'c0000000-0000-0000-0000-000000000003' and kind = 'punch_in' order by at desc limit 1;
select pg_temp.punch('c0000000-0000-0000-0000-000000000002', 'punch_in', now() - interval '3 hours');
select pg_temp.punch('c0000000-0000-0000-0000-000000000002', 'punch_out', now() - interval '1 hour');
insert into t select 'mary_out', id::text from hr.time_events where profile_id = 'c0000000-0000-0000-0000-000000000002' and kind = 'punch_out' order by at desc limit 1;
insert into t select 'dee_last', id::text from hr.time_events where profile_id = 'c0000000-0000-0000-0000-000000000006' order by at desc limit 1;
insert into t select 'fn_now', p.id::text from hr.pay_periods p where p.schedule_id = pg_temp.v('fn') and current_date between p.start_date and p.end_date;
select pg_temp.as('b0000000-0000-0000-0000-000000000005');
select throws_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000003', pg_temp.v('eve_out'), 'punch_out', now(), 'nope')$$, 'Only HR or the person''s manager can do this.', 'an unrelated employee cannot correct');
select pg_temp.as('b0000000-0000-0000-0000-000000000002');
select throws_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000003', pg_temp.v('eve_out'), 'punch_out', now(), '')$$, 'A reason is required for a correction.', 'a correction needs a reason (RPC)');
select throws_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000003', pg_temp.v('eve_out'), 'punch_out', (select v::timestamptz from t where k = 'eve_in_at') - interval '1 minute', 'typo')$$,
 'That correction would put the punches out of order (in, break, end break, out).', 'a punch-out before the punch-in is refused');
select lives_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000003', pg_temp.v('eve_out'), 'punch_out', now() + interval '1 minute', 'Forgot to punch out at the right time')$$, 'the manager corrects the punch-out');
select throws_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000003', pg_temp.v('eve_out'), 'punch_out', now(), 'again')$$, 'That punch was already corrected; correct the latest version.', 'the superseded row cannot be corrected twice');
select throws_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000002', pg_temp.v('mary_out'), 'void', null, 'mine')$$, 'You cannot approve your own record.', 'a manager cannot correct their own punches');
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select lives_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000002', pg_temp.v('mary_out'), 'punch_out', now() - interval '30 minutes', 'Left later')$$, 'HR corrects the manager''s punch');
select is((public.hr_admin_period_set_status(pg_temp.v('fn_now'), 'locked'))->>'status', 'locked', 'the current fortnightly period locks');
select throws_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000003', null, 'punch_in', now() - interval '10 hours', 'late entry')$$, 'That day is in a locked or exported pay period.', 'no correction inside a locked period');
select is((public.hr_admin_period_set_status(pg_temp.v('fn_now'), 'open'))->>'status', 'open', 'the period unlocks again');
select lives_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000006', pg_temp.v('dee_last'), 'void', null, 'Entered by mistake')$$, 'HR voids a punch');
select pg_temp.su();
select is((select count(*) from hr.time_events where supersedes = pg_temp.v('eve_out')), 1::bigint, 'the correction supersedes the original');
select is((select state from hr.time_state('c0000000-0000-0000-0000-000000000003')), 'punch_out', 'state follows the corrected punch');
select is((select count(*) from hr.shifts('c0000000-0000-0000-0000-000000000006', '2027-04-03', '2027-04-03') where not is_open), 0::bigint, 'the voided punch-out leaves that shift open');

-- ---------------------------------------------------------------- periods: fortnightly 14 days and contiguous, monthly month-exact
select is((select count(*) from hr.pay_periods where schedule_id = pg_temp.v('fn') and end_date - start_date <> 13), 0::bigint, 'every fortnightly period is 14 days');
select is((select count(*) from (select start_date, lag(end_date) over (order by start_date) prev from hr.pay_periods where schedule_id = pg_temp.v('fn')) x where prev is not null and start_date <> prev + 1), 0::bigint, 'fortnightly periods are contiguous');
select is((select count(*) from hr.pay_periods where schedule_id = pg_temp.v('fn') and start_date between '2026-01-01' and '2026-12-31'), 26::bigint, '26 fortnightly periods start in 2026');
select is((select count(*) from hr.pay_periods where schedule_id = pg_temp.v('fn') and extract(isodow from start_date) <> 1), 0::bigint, 'fortnightly periods start on a Monday');
select is((select count(*) from hr.pay_periods where schedule_id = pg_temp.v('fn') and pay_date <> end_date + 3), 0::bigint, 'pay date = end + offset');
select is((select count(*) from hr.pay_periods where schedule_id = pg_temp.v('mo') and (extract(day from start_date) <> 1 or end_date <> (start_date + interval '1 month - 1 day')::date)), 0::bigint, 'monthly periods cover each month exactly');
select is((select count(*) from (select start_date, lag(end_date) over (order by start_date) prev from hr.pay_periods where schedule_id = pg_temp.v('mo')) x where prev is not null and start_date <> prev + 1), 0::bigint, 'monthly periods are contiguous');
select is((select count(*) from hr.pay_periods where schedule_id = pg_temp.v('mo') and start_date between '2026-01-01' and '2026-12-31'), 12::bigint, '12 monthly periods in 2026');
select cmp_ok((select max(start_date) from hr.pay_periods where schedule_id = pg_temp.v('fn')), '>=', (current_date + interval '11 months')::date, 'periods exist about a year ahead');
select is((select count(*) from hr.pay_periods where schedule_id in (select id from hr.pay_schedules where name = 'Fortnightly') and start_date = '2026-11-16'), 1::bigint, 'the seeded Fortnightly schedule starts 2026-11-16');
select is((select count(*) from hr.pay_periods where schedule_id in (select id from hr.pay_schedules where name = 'Monthly') and start_date = '2026-12-01'), 1::bigint, 'the seeded Monthly schedule starts 2026-12-01');

-- ---------------------------------------------------------------- public holidays
select is((select count(distinct holiday_date) from hr.public_holidays where state = 'VIC' and holiday_date in ('2026-01-01','2026-01-26','2026-03-09','2026-04-03','2026-04-04','2026-04-05','2026-04-06','2026-04-25','2026-06-08','2026-11-03','2026-12-25','2026-12-26','2026-12-28')), 13::bigint, 'the 13 Victorian dates of 2026 are seeded');
select is((select count(distinct holiday_date) from hr.public_holidays where state = 'VIC' and holiday_date in ('2027-01-01','2027-01-26','2027-03-08','2027-03-26','2027-03-27','2027-03-28','2027-03-29','2027-04-25','2027-06-14','2027-11-02','2027-12-25','2027-12-26','2027-12-27','2027-12-28')), 14::bigint, 'the 14 Victorian dates of 2027 are seeded (Christmas and Boxing Day on the weekend)');
select is((select count(*) from hr.public_holidays where status <> 'review' and holiday_date in ('2026-01-01','2026-01-26','2026-03-09','2026-04-03','2026-04-04','2026-04-05','2026-04-06','2026-04-25','2026-06-08','2026-11-03','2026-12-25','2026-12-26','2026-12-28')), 0::bigint, 'every seeded 2026 holiday waits for HR to confirm it');
select is((select count(*) from hr.public_holidays where holiday_date in ('2026-04-27', '2027-04-26')), 0::bigint, 'ANZAC Day gets no substitute day in Victoria');
select is(hr.is_public_holiday('2026-12-25'), false, 'a holiday under review does not count yet');
insert into t select 'xmas', id::text from hr.public_holidays where holiday_date = '2026-12-25' and state = 'VIC';
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select is((public.hr_admin_holiday_save(pg_temp.v('xmas'), '{"status":"confirmed"}'))->>'status', 'confirmed', 'HR confirms Christmas Day');
select throws_ok($$select public.hr_admin_holiday_save(null, '{"date":"2026-12-25","name":"Christmas Day"}')$$, 'That holiday is already listed for this date.', 'duplicate holiday refused');
insert into t select 'gf', (public.hr_admin_holiday_save(null, '{"date":"2026-09-25","name":"Friday before the AFL Grand Final","status":"confirmed"}'))->>'id';
select is(jsonb_array_length(public.hr_public_holidays('2026-09-01', '2026-09-30')), 1, 'HR adds the Grand Final Friday by hand');
select is((public.hr_admin_holiday_delete(pg_temp.v('gf')))->>'id', pg_temp.v('gf')::text, 'HR deletes a holiday');
select pg_temp.su();
select is(hr.is_public_holiday('2026-12-25'), true, 'a confirmed holiday counts');

-- ---------------------------------------------------------------- overtime maths (fortnightly, full-time, salary)
-- Eve's period holding 2026-10-14 (test fortnightly schedule): 10 x 8 h Mon-Fri = 80 h against 76 ordinary hours.
insert into t select 'p_oct', p.id::text from hr.pay_periods p where p.schedule_id = pg_temp.v('fn') and date '2026-10-14' between p.start_date and p.end_date;
insert into t select 'p_oct_start', start_date::text from hr.pay_periods where id = pg_temp.v('p_oct');
insert into t select 'p_oct_end', end_date::text from hr.pay_periods where id = pg_temp.v('p_oct');
select pg_temp.shift('c0000000-0000-0000-0000-000000000003', d::date, '09:00', '17:00') from generate_series(pg_temp.d('p_oct_start'), pg_temp.d('p_oct_end'), interval '1 day') d where extract(isodow from d) between 1 and 5;
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'workedHours', '80.00', 'ten 8-hour days = 80 worked hours');
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'ordinaryHours', '76.00', 'fortnightly ordinary hours = 38 x 2');
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'overtimeHours', '4.00', 'overtime = 80 - 76');
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'estimatedGross', '3846.15', 'salary estimate = 100000 / 26');
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'approvable', 'true', 'no open shift or bad flag: approvable');
-- A confirmed holiday on a usual work day adds ordinary hours (paid), so overtime grows by 7.6.
insert into hr.public_holidays(holiday_date, name, state, status) values (pg_temp.d('p_oct_start') + 1, 'Test holiday', 'VIC', 'confirmed');
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'holidayHours', '7.60', 'a confirmed holiday on a work day pays 7.6 hours');
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'overtimeHours', '11.60', 'worked + holiday - ordinary = overtime');
select is((select flags from hr.shifts('c0000000-0000-0000-0000-000000000003', pg_temp.d('p_oct_start') + 1, pg_temp.d('p_oct_start') + 1)), '{public_holiday}'::text[], 'a shift on the holiday is flagged');

-- ---------------------------------------------------------------- overtime maths (monthly, part-time, hourly)
insert into t select 'p_sep', p.id::text from hr.pay_periods p where p.schedule_id = pg_temp.v('mo') and date '2026-09-15' between p.start_date and p.end_date;
select pg_temp.shift('c0000000-0000-0000-0000-000000000004', d::date, '09:00', '15:00') from generate_series(date '2026-09-01', date '2026-09-30', interval '1 day') d where extract(isodow from d) between 1 and 3;
select is(pg_temp.summary('p_sep', 'c0000000-0000-0000-0000-000000000004')->>'ordinaryHours', '82.33', 'monthly ordinary hours = 19 x 52 / 12');
select is(pg_temp.summary('p_sep', 'c0000000-0000-0000-0000-000000000004')->>'workedHours', '84.00', '14 x 6 h = 84 worked hours in September 2026');
select is(pg_temp.summary('p_sep', 'c0000000-0000-0000-0000-000000000004')->>'overtimeHours', '1.67', 'part-time overtime = 84 - 82.33');
select is(pg_temp.summary('p_sep', 'c0000000-0000-0000-0000-000000000004')->>'estimatedGross', '3360.00', 'hourly estimate = 84 x 40');

-- ---------------------------------------------------------------- leave: balances, requests, decisions
insert into t select 'annual', id::text from hr.leave_types where code = 'annual';
insert into t select 'personal', id::text from hr.leave_types where code = 'personal';
insert into t select 'lsl', id::text from hr.leave_types where code = 'long_service';
insert into t select 'compassionate', id::text from hr.leave_types where code = 'compassionate';
insert into t select 'unpaid', id::text from hr.leave_types where code = 'unpaid';
select is((select count(*) from hr.leave_types where is_active), 8::bigint, 'eight leave types seeded');
select is((hr.policy_for(pg_temp.v('annual'), current_date)).hours_per_year, 152::numeric, 'annual leave policy: 152 hours a year');
select pg_temp.as('b0000000-0000-0000-0000-000000000003');
select is((select (b->>'balanceHours')::numeric from jsonb_array_elements((public.hr_leave_my())->'balances') b where b->>'code' = 'annual'), 0::numeric, 'annual balance starts at zero');
select is((select (b->>'availableHours')::numeric from jsonb_array_elements((public.hr_leave_my())->'balances') b where b->>'code' = 'fdv'), 76::numeric, 'family and domestic violence leave: 10 days available in full');
select is((select (b->>'availableHours')::numeric from jsonb_array_elements((public.hr_leave_my())->'balances') b where b->>'code' = 'long_service'), 0::numeric, 'long service leave: nothing available before 7 years');
select throws_ok($$select public.hr_leave_request(jsonb_build_object('leaveTypeId', pg_temp.v('annual'), 'startDate', '2026-12-07', 'endDate', '2026-12-08', 'unit', 'days', 'quantity', 2))$$,
 'Not enough annual leave available (0 hours left).', 'paid leave needs a balance');
select throws_ok($$select public.hr_leave_request(jsonb_build_object('leaveTypeId', pg_temp.v('compassionate'), 'startDate', '2026-12-07', 'endDate', '2026-12-09', 'unit', 'days', 'quantity', 3))$$,
 'Compassionate leave allows up to 2.00 days per occasion.', 'compassionate leave: 2 days per occasion');
select throws_ok($$select public.hr_leave_request(jsonb_build_object('leaveTypeId', pg_temp.v('lsl'), 'startDate', '2026-12-07', 'unit', 'days', 'quantity', 1))$$,
 'Long service leave can be taken after 7.0 years of service.', 'long service leave waits for 7 years');
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select lives_ok($$select public.hr_admin_leave_adjust('c0000000-0000-0000-0000-000000000003', pg_temp.v('annual'), 40, 'Opening balance from the old HRMS', 'opening')$$, 'HR enters an opening balance');
select throws_ok($$select public.hr_admin_leave_adjust('c0000000-0000-0000-0000-000000000003', pg_temp.v('annual'), 5, '')$$, 'A reason is required.', 'an adjustment needs a reason');
select pg_temp.as('b0000000-0000-0000-0000-000000000003');
insert into t select 'lr1', (public.hr_leave_request(jsonb_build_object('leaveTypeId', pg_temp.v('annual'), 'startDate', '2026-12-07', 'endDate', '2026-12-08', 'unit', 'days', 'quantity', 2, 'note', 'Short break')))->>'id';
select is((select r->>'status' from jsonb_array_elements((public.hr_leave_my())->'requests') r where r->>'id' = pg_temp.v('lr1')::text), 'pending', 'an employee request is pending');
select is((select (r->>'hours')::numeric from jsonb_array_elements((public.hr_leave_my())->'requests') r where r->>'id' = pg_temp.v('lr1')::text), 15.20::numeric, '2 days = 15.2 hours at 7.6 a day');
select throws_ok($$select public.hr_leave_request(jsonb_build_object('leaveTypeId', pg_temp.v('unpaid'), 'startDate', '2026-12-08', 'unit', 'days', 'quantity', 1))$$,
 'There is already a leave request covering one of those days.', 'overlapping requests are refused');
select throws_ok($$select public.hr_leave_decide(pg_temp.v('lr1'), 'approved')$$, 'You cannot approve your own record.', 'the employee cannot approve their own request');
select pg_temp.as('b0000000-0000-0000-0000-000000000005');
select throws_ok($$select public.hr_leave_decide(pg_temp.v('lr1'), 'approved')$$, 'Only HR or the person''s manager can do this.', 'an unrelated employee cannot approve');
select throws_ok($$select public.hr_leave_list()$$, 'Only HR or a manager can see this.', 'an unrelated employee sees no team list');
select pg_temp.as('b0000000-0000-0000-0000-000000000002');
select is(jsonb_array_length((public.hr_leave_list('pending'))->'requests'), 1, 'the manager sees the pending request of a report');
select is((public.hr_leave_decide(pg_temp.v('lr1'), 'approved', 'Enjoy'))->>'status', 'approved', 'the manager approves');
select pg_temp.su();
select is(hr.leave_balance('c0000000-0000-0000-0000-000000000003', pg_temp.v('annual')), 24.80::numeric, 'approved leave is taken from the balance: 40 - 15.2');
select pg_temp.as('b0000000-0000-0000-0000-000000000003');
select is((public.hr_leave_cancel(pg_temp.v('lr1')))->>'status', 'cancelled', 'the employee cancels approved leave that has not started');
select pg_temp.su();
select is(hr.leave_balance('c0000000-0000-0000-0000-000000000003', pg_temp.v('annual')), 40.00::numeric, 'cancelling gives the hours back');
-- The manager's own leave: the manager cannot approve it; HR can.
select pg_temp.as('b0000000-0000-0000-0000-000000000002');
insert into t select 'lr2', (public.hr_leave_request(jsonb_build_object('leaveTypeId', pg_temp.v('unpaid'), 'startDate', '2026-12-14', 'unit', 'days', 'quantity', 1)))->>'id';
select throws_ok($$select public.hr_leave_decide(pg_temp.v('lr2'), 'approved')$$, 'You cannot approve your own record.', 'a manager cannot approve their own leave');
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select is((public.hr_leave_decide(pg_temp.v('lr2'), 'rejected', 'Busy week'))->>'status', 'rejected', 'HR rejects the manager''s request');
select is((public.hr_admin_leave_add('c0000000-0000-0000-0000-000000000004', jsonb_build_object('leaveTypeId', pg_temp.v('unpaid'), 'startDate', '2026-09-07', 'unit', 'days', 'quantity', 1)))->>'status', 'approved', 'an HR entry is approved at once');
select lives_ok($$select public.hr_admin_leave_add('c0000000-0000-0000-0000-000000000003', jsonb_build_object('leaveTypeId', pg_temp.v('annual'), 'startDate', pg_temp.d('p_oct_start') + 2, 'unit', 'days', 'quantity', 1))$$, 'HR records a day of annual leave inside the October period');
select pg_temp.su();
select is(pg_temp.summary('p_sep', 'c0000000-0000-0000-0000-000000000004')->>'unpaidLeaveHours', '6.33', 'the unpaid day shows on the monthly timesheet at the daily hours');
select is(pg_temp.summary('p_sep', 'c0000000-0000-0000-0000-000000000004')->>'overtimeHours', '1.67', 'unpaid leave does not count towards overtime');
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'paidLeaveHours', '7.60', 'the paid leave day shows on the timesheet');
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'countedHours', '95.20', 'counted = 80 worked + 7.6 leave + 7.6 holiday');
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->>'overtimeHours', '19.20', 'overtime = 95.2 - 76');
select is(hr.leave_balance('c0000000-0000-0000-0000-000000000003', pg_temp.v('annual')), 32.40::numeric, 'the HR entry is taken from the balance');

-- ---------------------------------------------------------------- approvals, lock, accrual, export
select pg_temp.as('b0000000-0000-0000-0000-000000000003');
select throws_ok($$select public.hr_timesheet_decide(pg_temp.v('p_oct'), 'c0000000-0000-0000-0000-000000000003', 'approved')$$, 'You cannot approve your own record.', 'no self-approval of a timesheet');
select throws_ok($$select public.hr_period_timesheets(pg_temp.v('p_oct'))$$, 'Only HR or a manager can see this.', 'an employee cannot list timesheets');
select pg_temp.as('b0000000-0000-0000-0000-000000000002');
select is(jsonb_array_length((public.hr_period_timesheets(pg_temp.v('p_oct')))->'employees'), 1, 'the manager sees only their reports on the fortnightly period (Eve, not themselves)');
select is((select e->>'canDecide' from jsonb_array_elements((public.hr_period_timesheets(pg_temp.v('p_oct')))->'employees') e), 'true', 'the manager may decide for a report');
select throws_ok($$select public.hr_timesheet_decide(pg_temp.v('p_oct'), 'c0000000-0000-0000-0000-000000000002', 'approved')$$, 'You cannot approve your own record.', 'a manager cannot approve their own timesheet');
select pg_temp.su();
-- An open shift blocks approval.
insert into t select 'eve_stray', pg_temp.punch('c0000000-0000-0000-0000-000000000003', 'punch_in', hr.local_midnight(pg_temp.d('p_oct_end')) + interval '9 hours')::text;
select is(pg_temp.summary('p_oct', 'c0000000-0000-0000-0000-000000000003')->'flags' ? 'missing_punch_out', true, 'the old open shift is flagged missing_punch_out');
select pg_temp.as('b0000000-0000-0000-0000-000000000002');
select throws_ok($$select public.hr_timesheet_decide(pg_temp.v('p_oct'), 'c0000000-0000-0000-0000-000000000003', 'approved')$$, 'The timesheet has an open shift; punch out or correct it first.', 'an open shift blocks approval');
select lives_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000003', pg_temp.v('eve_stray'), 'void', null, 'Did not work that day')$$, 'the manager voids the stray punch-in');
select is((public.hr_timesheet_decide(pg_temp.v('p_oct'), 'c0000000-0000-0000-0000-000000000003', 'approved', 'Looks right'))->'approval'->>'status', 'approved', 'the manager approves Eve''s October timesheet');
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select throws_ok($$select public.hr_admin_xero_export(pg_temp.v('p_oct'))$$, 'Lock the period before exporting it.', 'export needs a locked period');
select is((public.hr_admin_period_set_status(pg_temp.v('p_oct'), 'locked'))->>'status', 'locked', 'HR locks the October period');
select pg_temp.su();
-- Accrual on lock for the approved timesheet: counted hours capped at ordinary (76), never overtime.
select is((select hours from hr.leave_ledger where period_id = pg_temp.v('p_oct') and profile_id = 'c0000000-0000-0000-0000-000000000003' and leave_type_id = pg_temp.v('annual')), 5.85::numeric, 'annual accrual = 152 / 1976 x 76 (capped at ordinary hours, never on overtime)');
select is((select hours from hr.leave_ledger where period_id = pg_temp.v('p_oct') and profile_id = 'c0000000-0000-0000-0000-000000000003' and leave_type_id = pg_temp.v('personal')), 2.92::numeric, 'personal accrual = 76 / 1976 x 76');
select is((select hours from hr.leave_ledger where period_id = pg_temp.v('p_oct') and profile_id = 'c0000000-0000-0000-0000-000000000003' and leave_type_id = pg_temp.v('lsl')), 1.27::numeric, 'long service accrual = 1/60 x 76');
select is((select count(*) from hr.leave_ledger where period_id = pg_temp.v('p_oct') and profile_id = 'c0000000-0000-0000-0000-000000000002'), 0::bigint, 'no accrual for the unapproved manager');
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select throws_ok($$select public.hr_admin_time_correct('c0000000-0000-0000-0000-000000000003', null, 'punch_in', pg_temp.mel(pg_temp.d('p_oct_start') || ' 08:00'), 'late')$$, 'That day is in a locked or exported pay period.', 'corrections refused once locked');
select throws_ok($$select public.hr_admin_xero_export(pg_temp.v('p_oct'))$$, 'Not yet approved: Mary Manager.', 'export refused until everyone on the schedule is approved');
select is((public.hr_admin_period_set_status(pg_temp.v('p_oct'), 'open'))->>'status', 'open', 'HR unlocks the period');
select pg_temp.su();
select is((select count(*) from hr.leave_ledger where period_id = pg_temp.v('p_oct')), 0::bigint, 'unlocking removes the accruals');
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select is((public.hr_admin_period_set_status(pg_temp.v('p_oct'), 'locked'))->>'status', 'locked', 'HR locks it again');
select pg_temp.su();
select is((select count(*) from hr.leave_ledger where period_id = pg_temp.v('p_oct') and entry_kind = 'accrual'), 3::bigint, 're-locking accrues once (three types)');
-- Approving after the lock accrues too; export then needs every Xero id.
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select is((public.hr_timesheet_decide(pg_temp.v('p_oct'), 'c0000000-0000-0000-0000-000000000002', 'approved'))->'approval'->>'status', 'approved', 'HR approves the manager''s (empty) timesheet');
select lives_ok($$select public.hr_admin_employee_pay_save('c0000000-0000-0000-0000-000000000002', jsonb_build_object('payScheduleId', pg_temp.v('fn'), 'payBasis', 'salary', 'rate', 130000, 'xeroEmployeeId', ''))$$, 'the manager loses the Xero id for a moment');
select throws_ok($$select public.hr_admin_xero_export(pg_temp.v('p_oct'))$$, 'Missing Xero employee id: Mary Manager.', 'export refused without every Xero employee id');
select lives_ok($$select public.hr_admin_employee_pay_save('c0000000-0000-0000-0000-000000000002', jsonb_build_object('payScheduleId', pg_temp.v('fn'), 'payBasis', 'salary', 'rate', 130000, 'xeroEmployeeId', 'X-MARY'))$$, 'the Xero id is back');
insert into t select 'xero', (public.hr_admin_xero_export(pg_temp.v('p_oct')))->>'id';
select throws_ok($$select public.hr_admin_period_set_status(pg_temp.v('p_oct'), 'open')$$, 'This period was exported to Xero and is final.', 'an exported period is final');
select throws_ok($$select public.hr_admin_xero_export(pg_temp.v('p_oct'))$$, 'This period was already exported.', 'no second export');
select throws_ok($$select public.hr_timesheet_decide(pg_temp.v('p_oct'), 'c0000000-0000-0000-0000-000000000003', 'rejected')$$, 'This period was exported to Xero and is final.', 'no decision after export');
select is((select count(*) from jsonb_array_elements(public.hr_admin_xero_exports()) x where x->>'id' = pg_temp.v('xero')::text), 1::bigint, 'the export is listed');
select pg_temp.su();
select is((select status from hr.pay_periods where id = pg_temp.v('p_oct')), 'exported', 'the period is exported');
select is((select (x.lines->0)->>'employeeName' from hr.xero_exports x where x.id = pg_temp.v('xero')), 'Eve Fulltime', 'lines are ordered by employee');
select is((select sum((l->>'hours')::numeric) from hr.xero_exports x, jsonb_array_elements(x.lines) l where x.id = pg_temp.v('xero') and l->>'payItem' = 'Overtime'), 19.20::numeric, 'overtime lines total the period overtime');
select is((select sum((l->>'hours')::numeric) from hr.xero_exports x, jsonb_array_elements(x.lines) l where x.id = pg_temp.v('xero') and l->>'payItem' = 'Ordinary'), 60.80::numeric, 'ordinary lines = worked - overtime');
select is((select count(*) from hr.xero_exports x, jsonb_array_elements(x.lines) l where x.id = pg_temp.v('xero') and l->>'payItem' = 'Public Holiday'), 2::bigint, 'one public holiday line per employee on the schedule (Eve and Mary)');
select is((select count(*) from hr.xero_exports x, jsonb_array_elements(x.lines) l where x.id = pg_temp.v('xero') and l->>'payItem' = 'Annual leave'), 1::bigint, 'one annual leave line');
select is((select split_part(x.csv, chr(10), 1) from hr.xero_exports x where x.id = pg_temp.v('xero')), 'EmployeeId,EmployeeName,Date,PayItem,Hours,LeaveType', 'CSV header');
select is((select count(*) from hr.xero_exports x, jsonb_array_elements(x.lines) l where x.id = pg_temp.v('xero') and (l->>'date')::date not between pg_temp.d('p_oct_start') and pg_temp.d('p_oct_end')), 0::bigint, 'every line is dated inside the period');
-- Monthly export for Pat (approved by HR).
select pg_temp.as('b0000000-0000-0000-0000-000000000001');
select is((public.hr_timesheet_decide(pg_temp.v('p_sep'), 'c0000000-0000-0000-0000-000000000004', 'approved'))->'approval'->>'status', 'approved', 'HR approves the monthly timesheet');
select is((public.hr_admin_period_set_status(pg_temp.v('p_sep'), 'locked'))->>'status', 'locked', 'HR locks September');
select is((public.hr_admin_xero_export(pg_temp.v('p_sep')))->>'employeeCount', '1', 'the monthly export covers the one employee on the schedule');
select pg_temp.su();
select is((select hours from hr.leave_ledger where period_id = pg_temp.v('p_sep') and profile_id = 'c0000000-0000-0000-0000-000000000004' and leave_type_id = pg_temp.v('annual')), 6.33::numeric, 'part-time accrual pro-rated by ordinary hours: 152 / 1976 x 82.33');
select is((select sum((l->>'hours')::numeric) from hr.xero_exports x, jsonb_array_elements(x.lines) l where x.period_id = pg_temp.v('p_sep') and l->>'payItem' = 'Overtime'), 1.67::numeric, 'monthly overtime exported');

-- ---------------------------------------------------------------- the employee's own views and privileges
select pg_temp.as('b0000000-0000-0000-0000-000000000003');
select is((public.hr_my_timesheet(pg_temp.v('p_oct')))->'summary'->>'overtimeHours', '19.20', 'the employee sees their own period summary');
select is((public.hr_my_timesheet())->>'today', (now() at time zone 'Australia/Melbourne')::date::text, 'the default period is picked by today in the HR timezone, not UTC (20261113090000)');
select throws_ok($$select public.hr_my_timesheet(pg_temp.v('p_sep'))$$, 'Pay period not found.', 'another schedule''s period is not theirs');
select is(jsonb_array_length((public.hr_time_my_shifts(pg_temp.d('p_oct_start'), pg_temp.d('p_oct_end')))->'shifts'), 10, 'my shifts lists the ten October shifts');
select throws_ok($$select public.hr_admin_employee_punches('c0000000-0000-0000-0000-000000000004', '2026-09-01', '2026-09-30')$$, 'Only HR or the person''s manager can do this.', 'an employee cannot read a colleague''s punches');
select throws_ok($$select * from hr.time_events$$, '42501', null, 'no direct table access for authenticated');
select throws_ok($$select * from hr.leave_ledger$$, '42501', null, 'no direct ledger access for authenticated');
select throws_ok($$select * from hr.employee_pay$$, '42501', null, 'no direct pay access for authenticated');
select throws_ok($$select hr.leave_balance('c0000000-0000-0000-0000-000000000003', pg_temp.v('annual'))$$, '42501', null, 'no direct hr function access for authenticated');
select pg_temp.as('b0000000-0000-0000-0000-000000000002');
select is(jsonb_array_length((public.hr_admin_employee_punches('c0000000-0000-0000-0000-000000000004', '2026-09-01', '2026-09-30'))->'shifts'), 14, 'the manager reads a report''s punches');
select throws_ok($$select public.hr_admin_employee_punches('c0000000-0000-0000-0000-000000000005', '2026-09-01', '2026-09-30')$$, 'Only HR or the person''s manager can do this.', 'the manager cannot read a non-report');
select is(jsonb_array_length((public.hr_my_team())->'reports'), 3, 'the manager''s team has three reports');
select is((public.hr_my_team())->>'isManager', 'true', 'the manager is a manager');
select pg_temp.as('b0000000-0000-0000-0000-000000000003');
select is((public.hr_my_team())->>'isManager', 'false', 'an employee is not a manager');
select is(jsonb_array_length((public.hr_my_team())->'reports'), 0, 'an employee has no reports');
select throws_ok($$select public.hr_admin_schedules()$$, 'Only an administrator can do this.', 'schedules are admin only');
select pg_temp.su();

-- ---------------------------------------------------------------- admin sidebar rows
select is((select string_agg(id || ':' || route, ',' order by sort_order) from public.admin_menu_items where parent_id = 'staff' and is_enabled and sort_order >= 40),
 'staff_timesheets:/admin/staff/timesheets,staff_leave:/admin/staff/leave,staff_pay_schedules:/admin/staff/pay-schedules,staff_locations:/admin/staff/locations,staff_holidays:/admin/staff/holidays,staff_xero:/admin/staff/xero-export,staff_templates:/admin/staff/templates',
 'the HRMS menu rows in order (Templates added by 20261111100000, Locations by 20261113090000)');

select * from finish();
rollback;
