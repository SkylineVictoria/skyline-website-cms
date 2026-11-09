-- HRMS part 2: pay schedules (fortnightly + monthly), pay periods, each employee's pay setup, and time corrections (which
-- need the period lock). Additive only. Payroll itself (PAYG, super, STP, payslips) happens in Xero; Skyline keeps approved
-- hours, leave and holidays per period and exports them (part 4).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------------------------ pay schedules and periods
create table if not exists hr.pay_schedules (
 id uuid primary key default gen_random_uuid(),
 name text not null check (char_length(btrim(name)) between 1 and 80),
 frequency text not null check (frequency in ('fortnightly', 'monthly')),
 -- Fortnightly: a Monday (periods run Monday..Sunday). Monthly: the first of a month.
 anchor_date date not null,
 pay_date_offset_days integer not null default 0 check (pay_date_offset_days between -14 and 31),
 is_active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid,
 check (frequency <> 'fortnightly' or extract(isodow from anchor_date) = 1),
 check (frequency <> 'monthly' or extract(day from anchor_date) = 1)
);
create unique index if not exists pay_schedules_name_key on hr.pay_schedules(lower(btrim(name)));
alter table hr.pay_schedules enable row level security;
revoke all on hr.pay_schedules from public, anon, authenticated;
drop trigger if exists pay_schedules_touch on hr.pay_schedules;
create trigger pay_schedules_touch before update on hr.pay_schedules for each row execute function hr.touch_updated_at();

create table if not exists hr.pay_periods (
 id uuid primary key default gen_random_uuid(),
 schedule_id uuid not null references hr.pay_schedules(id) on delete restrict,
 start_date date not null,
 end_date date not null,
 pay_date date not null,
 -- open <-> locked is reversible; exported is final.
 status text not null default 'open' check (status in ('open', 'locked', 'exported')),
 locked_at timestamptz,
 locked_by uuid,
 exported_at timestamptz,
 created_at timestamptz not null default now(),
 unique (schedule_id, start_date),
 check (end_date >= start_date)
);
create index if not exists pay_periods_schedule_dates_idx on hr.pay_periods(schedule_id, start_date, end_date);
alter table hr.pay_periods enable row level security;
revoke all on hr.pay_periods from public, anon, authenticated;

-- Each employee's pay setup. ordinary_hours_week / usual_work_days fall back to hr.settings when null.
create table if not exists hr.employee_pay (
 profile_id uuid primary key references hr.employment(profile_id) on delete restrict,
 pay_schedule_id uuid references hr.pay_schedules(id) on delete restrict,
 pay_basis text check (pay_basis in ('salary', 'hourly')),
 -- Annual salary (AUD) for salary, hourly rate (AUD) for hourly. Display only: Xero is the source of truth.
 rate numeric(12,2) check (rate is null or rate >= 0),
 ordinary_hours_week numeric(5,2) check (ordinary_hours_week is null or (ordinary_hours_week > 0 and ordinary_hours_week <= 80)),
 usual_work_days smallint[] check (usual_work_days is null or (cardinality(usual_work_days) between 1 and 7 and usual_work_days <@ '{1,2,3,4,5,6,7}'::smallint[])),
 award text not null default '' check (char_length(award) <= 150),
 xero_employee_id text not null default '' check (char_length(xero_employee_id) <= 80),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid
);
create index if not exists employee_pay_schedule_idx on hr.employee_pay(pay_schedule_id);
alter table hr.employee_pay enable row level security;
revoke all on hr.employee_pay from public, anon, authenticated;
drop trigger if exists employee_pay_touch on hr.employee_pay;
create trigger employee_pay_touch before update on hr.employee_pay for each row execute function hr.touch_updated_at();

-- Generates the periods of a schedule from its anchor up to p_until (default: a year ahead). Existing rows are left alone.
create or replace function hr.pay_periods_generate(p_schedule uuid, p_until date default null) returns integer
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare s hr.pay_schedules; v_until date := coalesce(p_until, (current_date + interval '12 months')::date); v_start date; v_end date; v_n integer := 0; k integer := 0;
begin
 select * into s from hr.pay_schedules where id = p_schedule;
 if not found then return 0; end if;
 loop
  if s.frequency = 'fortnightly' then v_start := s.anchor_date + 14 * k; v_end := v_start + 13;
  else v_start := (s.anchor_date + make_interval(months => k))::date; v_end := (v_start + interval '1 month - 1 day')::date; end if;
  exit when v_start > v_until;
  insert into hr.pay_periods(schedule_id, start_date, end_date, pay_date) values (s.id, v_start, v_end, v_end + s.pay_date_offset_days)
   on conflict (schedule_id, start_date) do nothing;
  if found then v_n := v_n + 1; end if;
  k := k + 1;
  exit when k > 2000;
 end loop;
 return v_n;
end $fn$;
revoke all on function hr.pay_periods_generate(uuid, date) from public, anon, authenticated;

-- Daily top-up (pg_cron, created INACTIVE below; the owner activates it at release): every active schedule keeps 12 months of periods.
create or replace function public.hr_pay_periods_topup() returns integer
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare r record; v_n integer := 0;
begin
 for r in select id from hr.pay_schedules where is_active loop
  v_n := v_n + hr.pay_periods_generate(r.id, null);
 end loop;
 return v_n;
end $fn$;
revoke all on function public.hr_pay_periods_topup() from public, anon, authenticated, service_role;
grant execute on function public.hr_pay_periods_topup() to postgres;

do $job$
declare v_job bigint;
begin
 select jobid into v_job from cron.job where jobname = 'hr-pay-periods-topup' order by jobid limit 1;
 if v_job is null then
  v_job := cron.schedule('hr-pay-periods-topup', '30 2 * * *', 'select public.hr_pay_periods_topup();');
  perform cron.alter_job(v_job, active := false);
 end if;
end $job$;

-- The period of a schedule that holds a local date.
create or replace function hr.period_for(p_schedule uuid, p_day date) returns hr.pay_periods
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select p.* from hr.pay_periods p where p.schedule_id = p_schedule and p_day between p.start_date and p.end_date limit 1;
$fn$;
revoke all on function hr.period_for(uuid, date) from public, anon, authenticated;

-- True when the instant falls in a locked or exported period of the person's schedule (no schedule = never locked).
create or replace function hr.period_locked_for(p_profile uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select exists (select 1 from hr.employee_pay ep join hr.pay_periods p on p.schedule_id = ep.pay_schedule_id
  where ep.profile_id = p_profile and hr.local_date(p_at) between p.start_date and p.end_date and p.status in ('locked', 'exported'));
$fn$;
revoke all on function hr.period_locked_for(uuid, timestamptz) from public, anon, authenticated;

create or replace function hr.employee_ordinary_hours_week(p_profile uuid) returns numeric
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce((select ep.ordinary_hours_week from hr.employee_pay ep where ep.profile_id = p_profile), (select s.ordinary_hours_week from hr.settings s where s.id), 38);
$fn$;
revoke all on function hr.employee_ordinary_hours_week(uuid) from public, anon, authenticated;

create or replace function hr.employee_work_days(p_profile uuid) returns smallint[]
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce((select ep.usual_work_days from hr.employee_pay ep where ep.profile_id = p_profile), (select s.usual_work_days from hr.settings s where s.id), '{1,2,3,4,5}'::smallint[]);
$fn$;
revoke all on function hr.employee_work_days(uuid) from public, anon, authenticated;

-- Hours of one usual work day for a person (38 h over Mon-Fri = 7.6 h).
create or replace function hr.employee_daily_hours(p_profile uuid) returns numeric
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select round(hr.employee_ordinary_hours_week(p_profile) / greatest(1, cardinality(hr.employee_work_days(p_profile))), 2);
$fn$;
revoke all on function hr.employee_daily_hours(uuid) from public, anon, authenticated;

-- Ordinary hours of a period for a person: weekly x 2 (fortnightly), weekly x 52 / 12 (monthly).
create or replace function hr.period_ordinary_hours(p_period uuid, p_profile uuid) returns numeric
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select round(case s.frequency when 'fortnightly' then hr.employee_ordinary_hours_week(p_profile) * 2 else hr.employee_ordinary_hours_week(p_profile) * 52 / 12 end, 2)
 from hr.pay_periods p join hr.pay_schedules s on s.id = p.schedule_id where p.id = p_period;
$fn$;
revoke all on function hr.period_ordinary_hours(uuid, uuid) from public, anon, authenticated;

create or replace function hr.schedule_json(s hr.pay_schedules) returns jsonb
language sql immutable as $fn$
 select jsonb_build_object('id', s.id, 'name', s.name, 'frequency', s.frequency, 'anchorDate', s.anchor_date, 'payDateOffsetDays', s.pay_date_offset_days,
  'isActive', s.is_active, 'updatedAt', s.updated_at);
$fn$;
revoke all on function hr.schedule_json(hr.pay_schedules) from public, anon, authenticated;

create or replace function hr.period_json(p hr.pay_periods) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('id', p.id, 'scheduleId', p.schedule_id, 'startDate', p.start_date, 'endDate', p.end_date, 'payDate', p.pay_date, 'status', p.status,
  'lockedAt', p.locked_at, 'exportedAt', p.exported_at,
  'scheduleName', (select s.name from hr.pay_schedules s where s.id = p.schedule_id), 'frequency', (select s.frequency from hr.pay_schedules s where s.id = p.schedule_id));
$fn$;
revoke all on function hr.period_json(hr.pay_periods) from public, anon, authenticated;

create or replace function hr.employee_pay_json(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('profileId', p_profile, 'payScheduleId', ep.pay_schedule_id, 'payScheduleName', (select s.name from hr.pay_schedules s where s.id = ep.pay_schedule_id),
  'payBasis', ep.pay_basis, 'rate', ep.rate, 'ordinaryHoursWeek', ep.ordinary_hours_week, 'usualWorkDays', to_jsonb(ep.usual_work_days), 'award', ep.award,
  'xeroEmployeeId', ep.xero_employee_id, 'updatedAt', ep.updated_at,
  'effectiveOrdinaryHoursWeek', hr.employee_ordinary_hours_week(p_profile), 'effectiveUsualWorkDays', to_jsonb(hr.employee_work_days(p_profile)),
  'dailyHours', hr.employee_daily_hours(p_profile))
 from (select 1) x left join hr.employee_pay ep on ep.profile_id = p_profile;
$fn$;
revoke all on function hr.employee_pay_json(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ RPCs
-- Every schedule with its periods from three months ago to a year ahead (admin), or only the schedules (managers/staff do not need this).
create or replace function public.hr_admin_schedules() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(hr.schedule_json(s) || jsonb_build_object(
   'employeeCount', (select count(*) from hr.employee_pay ep where ep.pay_schedule_id = s.id),
   'periods', coalesce((select jsonb_agg(hr.period_json(p) order by p.start_date) from hr.pay_periods p
     where p.schedule_id = s.id and p.end_date >= current_date - 100 and p.start_date <= current_date + 370), '[]'::jsonb))
  order by s.is_active desc, s.name) from hr.pay_schedules s), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_admin_schedules() from public, anon;
grant execute on function public.hr_admin_schedules() to authenticated;

create or replace function public.hr_admin_schedule_save(p_id uuid, p_schedule jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare s hr.pay_schedules; v_name text := left(btrim(coalesce(p_schedule->>'name', '')), 80); v_freq text := p_schedule->>'frequency';
 v_anchor date := (p_schedule->>'anchorDate')::date; v_offset integer := coalesce((p_schedule->>'payDateOffsetDays')::integer, 0);
begin
 perform hr.require_admin();
 if p_id is null then
  if v_name = '' then raise exception 'Give the schedule a name.' using errcode = '22023'; end if;
  if v_freq not in ('fortnightly', 'monthly') then raise exception 'Frequency must be fortnightly or monthly.' using errcode = '22023'; end if;
  if v_anchor is null then raise exception 'Choose the first period''s start date.' using errcode = '22023'; end if;
  if v_freq = 'fortnightly' and extract(isodow from v_anchor) <> 1 then raise exception 'A fortnightly schedule starts on a Monday.' using errcode = '22023'; end if;
  if v_freq = 'monthly' and extract(day from v_anchor) <> 1 then raise exception 'A monthly schedule starts on the first of a month.' using errcode = '22023'; end if;
  insert into hr.pay_schedules(name, frequency, anchor_date, pay_date_offset_days, is_active, updated_by)
   values (v_name, v_freq, v_anchor, v_offset, coalesce((p_schedule->>'isActive')::boolean, true), auth.uid()) returning * into s;
 else
  select * into s from hr.pay_schedules where id = p_id for update;
  if not found then raise exception 'Schedule not found.' using errcode = 'P0002'; end if;
  -- Frequency and anchor are fixed once a period of this schedule is locked or exported (the periods already paid must stand).
  if (v_freq is not null and v_freq <> s.frequency) or (v_anchor is not null and v_anchor <> s.anchor_date) then
   if exists (select 1 from hr.pay_periods p where p.schedule_id = s.id and p.status <> 'open') then
    raise exception 'The frequency and start date cannot change once a period of this schedule is locked or exported.' using errcode = '22023'; end if;
   if coalesce(v_freq, s.frequency) = 'fortnightly' and extract(isodow from coalesce(v_anchor, s.anchor_date)) <> 1 then raise exception 'A fortnightly schedule starts on a Monday.' using errcode = '22023'; end if;
   if coalesce(v_freq, s.frequency) = 'monthly' and extract(day from coalesce(v_anchor, s.anchor_date)) <> 1 then raise exception 'A monthly schedule starts on the first of a month.' using errcode = '22023'; end if;
   -- Open periods are regenerated from the new anchor.
   delete from hr.pay_periods p where p.schedule_id = s.id and p.status = 'open' and not hr.period_in_use(p.id);
  end if;
  update hr.pay_schedules set name = coalesce(nullif(v_name, ''), name), frequency = coalesce(v_freq, frequency), anchor_date = coalesce(v_anchor, anchor_date),
   pay_date_offset_days = coalesce((p_schedule->>'payDateOffsetDays')::integer, pay_date_offset_days),
   is_active = coalesce((p_schedule->>'isActive')::boolean, is_active), updated_by = auth.uid()
   where id = p_id returning * into s;
  -- A changed pay-date offset moves the pay date of every open period.
  update hr.pay_periods set pay_date = end_date + s.pay_date_offset_days where schedule_id = s.id and status = 'open' and pay_date <> end_date + s.pay_date_offset_days;
 end if;
 perform hr.pay_periods_generate(s.id, null);
 return hr.schedule_json(s) || jsonb_build_object('periods', coalesce((select jsonb_agg(hr.period_json(p) order by p.start_date) from hr.pay_periods p
  where p.schedule_id = s.id and p.end_date >= current_date - 100 and p.start_date <= current_date + 370), '[]'::jsonb));
exception when unique_violation then
 raise exception 'A schedule with that name already exists.' using errcode = '23505';
end $fn$;
revoke all on function public.hr_admin_schedule_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_schedule_save(uuid, jsonb) to authenticated;

-- True when something refers to the period (approvals, leave accruals, exports). Part 4 replaces this stub with the real check.
create or replace function hr.period_in_use(p_period uuid) returns boolean
language sql stable security definer set search_path = hr, pg_temp as $fn$ select false; $fn$;
revoke all on function hr.period_in_use(uuid) from public, anon, authenticated;

create or replace function public.hr_admin_employee_pay(p_profile uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return hr.employee_pay_json(p_profile) || jsonb_build_object('schedules', coalesce((select jsonb_agg(hr.schedule_json(s) order by s.name) from hr.pay_schedules s where s.is_active), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_admin_employee_pay(uuid) from public, anon;
grant execute on function public.hr_admin_employee_pay(uuid) to authenticated;

create or replace function public.hr_admin_employee_pay_save(p_profile uuid, p_pay jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_schedule uuid := nullif(p_pay->>'payScheduleId', '')::uuid; v_basis text := nullif(p_pay->>'payBasis', ''); v_days smallint[];
begin
 perform hr.require_admin();
 if not exists (select 1 from hr.employment e where e.profile_id = p_profile) then raise exception 'Set the employment details first.' using errcode = '22023'; end if;
 if v_basis is not null and v_basis not in ('salary', 'hourly') then raise exception 'Pay basis must be salary or hourly.' using errcode = '22023'; end if;
 if v_schedule is not null and not exists (select 1 from hr.pay_schedules s where s.id = v_schedule) then raise exception 'Schedule not found.' using errcode = 'P0002'; end if;
 if p_pay ? 'usualWorkDays' and jsonb_typeof(p_pay->'usualWorkDays') = 'array' then
  select array_agg(distinct x::smallint order by x::smallint) into v_days from jsonb_array_elements_text(p_pay->'usualWorkDays') x;
 end if;
 insert into hr.employee_pay(profile_id, pay_schedule_id, pay_basis, rate, ordinary_hours_week, usual_work_days, award, xero_employee_id, updated_by)
  values (p_profile, v_schedule, v_basis, nullif(p_pay->>'rate', '')::numeric, nullif(p_pay->>'ordinaryHoursWeek', '')::numeric, v_days,
   left(btrim(coalesce(p_pay->>'award', '')), 150), left(btrim(coalesce(p_pay->>'xeroEmployeeId', '')), 80), auth.uid())
 on conflict (profile_id) do update set pay_schedule_id = excluded.pay_schedule_id, pay_basis = excluded.pay_basis, rate = excluded.rate,
  ordinary_hours_week = excluded.ordinary_hours_week, usual_work_days = excluded.usual_work_days, award = excluded.award,
  xero_employee_id = excluded.xero_employee_id, updated_by = excluded.updated_by;
 return hr.employee_pay_json(p_profile);
end $fn$;
revoke all on function public.hr_admin_employee_pay_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_employee_pay_save(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ time corrections (HR or the manager, never one's own)
-- A correction is a new row that supersedes a punch (or 'void' removes it). Refused inside a locked or exported period, and
-- when the resulting sequence of punches would be out of order.
create or replace function public.hr_admin_time_correct(p_profile uuid, p_supersedes uuid, p_kind text, p_at timestamptz, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare o hr.time_events; v_at timestamptz := p_at; v_reason text := left(btrim(coalesce(p_reason, '')), 500); v_lo timestamptz; v_hi timestamptz; v_new uuid;
begin
 perform hr.require_decider(p_profile);
 if p_kind not in ('punch_in', 'break_start', 'break_end', 'punch_out', 'void') then raise exception 'Unknown punch kind.' using errcode = '22023'; end if;
 if v_reason = '' then raise exception 'A reason is required for a correction.' using errcode = '22023'; end if;
 if p_supersedes is not null then
  select * into o from hr.time_events where id = p_supersedes for update;
  if not found or o.profile_id <> p_profile then raise exception 'That punch does not belong to this person.' using errcode = 'P0002'; end if;
  if o.kind = 'void' then raise exception 'A void cannot be corrected.' using errcode = '22023'; end if;
  if exists (select 1 from hr.time_events s where s.supersedes = o.id) then raise exception 'That punch was already corrected; correct the latest version.' using errcode = '22023'; end if;
  if hr.period_locked_for(p_profile, o.at) then raise exception 'That day is in a locked or exported pay period.' using errcode = '22023'; end if;
  if p_kind = 'void' then v_at := o.at; end if;
 elsif p_kind = 'void' then
  raise exception 'Choose the punch to void.' using errcode = '22023';
 end if;
 if v_at is null then raise exception 'Give the corrected time.' using errcode = '22023'; end if;
 if p_kind <> 'void' and v_at > now() + interval '5 minutes' then raise exception 'A punch cannot be in the future.' using errcode = '22023'; end if;
 if hr.period_locked_for(p_profile, v_at) then raise exception 'That day is in a locked or exported pay period.' using errcode = '22023'; end if;
 perform pg_advisory_xact_lock(hashtext('hr.time_events'), hashtext(p_profile::text));
 insert into hr.time_events(profile_id, kind, at, source, supersedes, reason, recorded_by)
  values (p_profile, p_kind, v_at, 'correction', p_supersedes, v_reason, auth.uid()) returning id into v_new;
 v_lo := least(v_at, coalesce(o.at, v_at)) - interval '2 days'; v_hi := greatest(v_at, coalesce(o.at, v_at)) + interval '2 days';
 if not hr.time_sequence_valid(p_profile, v_lo, v_hi) then
  raise exception 'That correction would put the punches out of order (in, break, end break, out).' using errcode = '22023';
 end if;
 return public.hr_admin_employee_punches(p_profile, hr.local_date(least(v_at, coalesce(o.at, v_at))), hr.local_date(greatest(v_at, coalesce(o.at, v_at))))
  || jsonb_build_object('correctionId', v_new);
end $fn$;
revoke all on function public.hr_admin_time_correct(uuid, uuid, text, timestamptz, text) from public, anon;
grant execute on function public.hr_admin_time_correct(uuid, uuid, text, timestamptz, text) to authenticated;

-- ------------------------------------------------------------------ seed schedules (owner's decision; editable in the UI)
insert into hr.pay_schedules(name, frequency, anchor_date, pay_date_offset_days, is_active)
 values ('Fortnightly', 'fortnightly', date '2026-11-16', 3, true), ('Monthly', 'monthly', date '2026-12-01', 0, true)
on conflict do nothing;
select hr.pay_periods_generate(s.id, null) from hr.pay_schedules s;
