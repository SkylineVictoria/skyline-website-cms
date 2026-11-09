-- HRMS part 3: leave (Victoria / NES). Every rate lives in a versioned, effective-dated policy row, never in code. Balances are
-- derived from an append-style ledger (opening, accrual, taken, adjustment). Requests are approved by the manager or HR, never by
-- the person themselves; HR entries are approved at once. Additive only.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------------------------ types and policies
create table if not exists hr.leave_types (
 id uuid primary key default gen_random_uuid(),
 code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
 name text not null check (char_length(btrim(name)) between 1 and 80),
 description text not null default '' check (char_length(description) <= 600),
 is_paid boolean not null default true,
 -- Paid leave that is drawn from a balance (annual, personal, long service). Entitlement / per-occasion / unpaid types are not.
 requires_balance boolean not null default false,
 -- progressive: hours_per_year at full-time ordinary hours, accrued on ordinary hours each locked period;
 -- long_service: accrual_fraction of ordinary hours (Victoria 1/60), usable after qualifying_years of service;
 -- entitlement: days_per_year available in full, measured over the trailing 12 months (family and domestic violence);
 -- per_occasion: up to days_per_occasion per request (compassionate; community service pays the first paid_days_per_occasion);
 -- none: no limit tracked (unpaid leave, unpaid parental leave).
 accrual_method text not null check (accrual_method in ('progressive', 'long_service', 'entitlement', 'per_occasion', 'none')),
 sort_order integer not null default 100,
 is_active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table hr.leave_types enable row level security;
revoke all on hr.leave_types from public, anon, authenticated;
drop trigger if exists leave_types_touch on hr.leave_types;
create trigger leave_types_touch before update on hr.leave_types for each row execute function hr.touch_updated_at();

create table if not exists hr.leave_policies (
 id uuid primary key default gen_random_uuid(),
 leave_type_id uuid not null references hr.leave_types(id) on delete restrict,
 effective_from date not null,
 effective_to date,
 -- progressive: hours per year at full-time ordinary hours (152 = 4 weeks x 38 h; 76 = 10 days x 7.6 h).
 hours_per_year numeric(7,2) check (hours_per_year is null or hours_per_year >= 0),
 -- entitlement: paid days available in full per 12 months (10 for family and domestic violence leave).
 days_per_year numeric(5,2) check (days_per_year is null or days_per_year >= 0),
 -- per_occasion: the most days one request may take (2 for compassionate leave).
 days_per_occasion numeric(5,2) check (days_per_occasion is null or days_per_occasion >= 0),
 -- per_occasion with partial pay: the first n days are paid (jury service: 10), the rest unpaid.
 paid_days_per_occasion numeric(5,2) check (paid_days_per_occasion is null or paid_days_per_occasion >= 0),
 -- long_service: 1/60 of ordinary hours; usable after qualifying_years of continuous service.
 accrual_fraction numeric(10,6) check (accrual_fraction is null or (accrual_fraction >= 0 and accrual_fraction < 1)),
 qualifying_years numeric(4,1) check (qualifying_years is null or qualifying_years >= 0),
 note text not null default '' check (char_length(note) <= 600),
 created_at timestamptz not null default now(),
 created_by uuid,
 unique (leave_type_id, effective_from),
 check (effective_to is null or effective_to >= effective_from)
);
alter table hr.leave_policies enable row level security;
revoke all on hr.leave_policies from public, anon, authenticated;

-- The policy of a type in force on a day (the latest effective_from that covers the day).
create or replace function hr.policy_for(p_type uuid, p_day date) returns hr.leave_policies
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select p.* from hr.leave_policies p where p.leave_type_id = p_type and p.effective_from <= p_day and (p.effective_to is null or p.effective_to >= p_day)
 order by p.effective_from desc limit 1;
$fn$;
revoke all on function hr.policy_for(uuid, date) from public, anon, authenticated;

insert into hr.leave_types(code, name, description, is_paid, requires_balance, accrual_method, sort_order) values
 ('annual', 'Annual leave', '4 weeks a year (152 hours at 38 hours a week), accrued progressively on ordinary hours.', true, true, 'progressive', 10),
 ('personal', 'Personal / carer''s leave', '10 days a year (76 hours at 38 hours a week), accrued progressively on ordinary hours.', true, true, 'progressive', 20),
 ('compassionate', 'Compassionate leave', '2 paid days per occasion.', true, false, 'per_occasion', 30),
 ('fdv', 'Family and domestic violence leave', '10 paid days per 12 months, available in full from day one (not accrued).', true, false, 'entitlement', 40),
 ('long_service', 'Long service leave', 'Victoria: 1/60 of continuous service, usable after 7 years.', true, true, 'long_service', 50),
 ('unpaid', 'Unpaid leave', 'Unpaid leave agreed with the manager.', false, false, 'none', 60),
 ('community_service', 'Community service leave', 'Jury service: make-up pay for the first 10 days per occasion; other community service is unpaid.', true, false, 'per_occasion', 70),
 ('parental_unpaid', 'Unpaid parental leave', 'Unpaid parental leave under the National Employment Standards.', false, false, 'none', 80)
on conflict (code) do nothing;

insert into hr.leave_policies(leave_type_id, effective_from, hours_per_year, days_per_year, days_per_occasion, paid_days_per_occasion, accrual_fraction, qualifying_years, note)
select t.id, date '2026-01-01', v.hours_per_year, v.days_per_year, v.days_per_occasion, v.paid_days_per_occasion, v.accrual_fraction, v.qualifying_years, v.note
from (values
 ('annual', 152::numeric, null::numeric, null::numeric, null::numeric, null::numeric, null::numeric, 'NES: 4 weeks per year of service'),
 ('personal', 76, null, null, null, null, null, 'NES: 10 days per year of service'),
 ('compassionate', null, null, 2, null, null, null, 'NES: 2 days per permissible occasion'),
 ('fdv', null, 10, null, null, null, null, 'NES: 10 days paid per 12-month period, not accrued'),
 ('long_service', null, null, null, null, 0.016667, 7, 'Long Service Leave Act 2018 (Vic): 1/60 of continuous service, after 7 years'),
 ('unpaid', null, null, null, null, null, null, ''),
 ('community_service', null, null, null, 10, null, null, 'Fair Work Act: make-up pay for the first 10 days of jury service'),
 ('parental_unpaid', null, null, null, null, null, null, 'NES: 12 months unpaid parental leave (extendable)')
) as v(code, hours_per_year, days_per_year, days_per_occasion, paid_days_per_occasion, accrual_fraction, qualifying_years, note)
join hr.leave_types t on t.code = v.code
on conflict (leave_type_id, effective_from) do nothing;

-- ------------------------------------------------------------------ ledger and requests
create table if not exists hr.leave_ledger (
 id bigint generated always as identity primary key,
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 leave_type_id uuid not null references hr.leave_types(id) on delete restrict,
 entry_kind text not null check (entry_kind in ('opening', 'accrual', 'taken', 'adjustment')),
 -- Signed hours: accruals and openings positive, taken negative, adjustments either way.
 hours numeric(9,2) not null check (hours <> 0),
 effective_date date not null,
 period_id uuid references hr.pay_periods(id) on delete restrict,
 request_id uuid,
 reason text not null default '' check (char_length(reason) <= 500),
 created_by uuid,
 created_at timestamptz not null default now()
);
create index if not exists leave_ledger_profile_type_idx on hr.leave_ledger(profile_id, leave_type_id, effective_date);
-- One accrual per person, type and period (re-locking a period never double-counts).
create unique index if not exists leave_ledger_one_accrual on hr.leave_ledger(period_id, profile_id, leave_type_id) where entry_kind = 'accrual';
alter table hr.leave_ledger enable row level security;
revoke all on hr.leave_ledger from public, anon, authenticated;

create table if not exists hr.leave_requests (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 leave_type_id uuid not null references hr.leave_types(id) on delete restrict,
 start_date date not null,
 end_date date not null,
 unit text not null check (unit in ('hours', 'days')),
 quantity numeric(7,2) not null check (quantity > 0),
 -- Total hours of leave (days x the person's daily hours when requested in days).
 hours numeric(8,2) not null check (hours > 0),
 note text not null default '' check (char_length(note) <= 1000),
 status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
 is_admin_entry boolean not null default false,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 decided_by uuid,
 decided_at timestamptz,
 decision_note text not null default '' check (char_length(decision_note) <= 1000),
 cancelled_at timestamptz,
 cancelled_by uuid,
 check (end_date >= start_date),
 check (end_date - start_date <= 400)
);
create index if not exists leave_requests_profile_idx on hr.leave_requests(profile_id, start_date desc);
create index if not exists leave_requests_status_idx on hr.leave_requests(status, start_date);
alter table hr.leave_requests enable row level security;
revoke all on hr.leave_requests from public, anon, authenticated;
alter table hr.leave_ledger drop constraint if exists leave_ledger_request_fk;
alter table hr.leave_ledger add constraint leave_ledger_request_fk foreign key (request_id) references hr.leave_requests(id) on delete restrict;

-- The calendar days a request covers: the person's usual work days in the range that are not confirmed public holidays
-- (the start date alone when none qualifies, e.g. a single-day request on a Saturday).
create or replace function hr.leave_dates(p_profile uuid, p_start date, p_end date) returns setof date
language sql stable security definer set search_path = hr, pg_temp as $fn$
 with d as (select g::date as day from generate_series(p_start, p_end, interval '1 day') g),
 w as (select day from d where extract(isodow from day)::smallint = any(hr.employee_work_days(p_profile)) and not hr.is_public_holiday(day))
 select day from w union all select p_start where not exists (select 1 from w) order by 1;
$fn$;
revoke all on function hr.leave_dates(uuid, date, date) from public, anon, authenticated;

-- A request's hours spread evenly over its days.
create or replace function hr.leave_day_hours(p_request uuid) returns table(day date, hours numeric)
language sql stable security definer set search_path = hr, pg_temp as $fn$
 with r as (select * from hr.leave_requests where id = p_request), d as (select hr.leave_dates(r.profile_id, r.start_date, r.end_date) as day from r)
 select d.day, round(r.hours / (select count(*) from d), 2) from d, r;
$fn$;
revoke all on function hr.leave_day_hours(uuid) from public, anon, authenticated;

create or replace function hr.leave_balance(p_profile uuid, p_type uuid) returns numeric
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce(sum(l.hours), 0) from hr.leave_ledger l where l.profile_id = p_profile and l.leave_type_id = p_type;
$fn$;
revoke all on function hr.leave_balance(uuid, uuid) from public, anon, authenticated;

-- Completed years of continuous service (joining date on hr.employment).
create or replace function hr.service_years(p_profile uuid, p_as_of date default current_date) returns numeric
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce((select round(extract(epoch from (p_as_of::timestamp - e.joining_date::timestamp)) / 31557600, 2) from hr.employment e where e.profile_id = p_profile and e.joining_date is not null), 0);
$fn$;
revoke all on function hr.service_years(uuid, date) from public, anon, authenticated;

-- Hours still available of a type for a person (null = not limited by a balance). Entitlement types count the trailing 12 months.
create or replace function hr.leave_available(p_profile uuid, p_type uuid, p_as_of date default current_date) returns numeric
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare t hr.leave_types; pol hr.leave_policies; v_daily numeric := hr.employee_daily_hours(p_profile); v_taken numeric;
begin
 select * into t from hr.leave_types where id = p_type;
 if not found then return null; end if;
 pol := hr.policy_for(p_type, p_as_of);
 if t.requires_balance then
  if t.accrual_method = 'long_service' and pol.qualifying_years is not null and hr.service_years(p_profile, p_as_of) < pol.qualifying_years then return 0; end if;
  return greatest(0, hr.leave_balance(p_profile, p_type));
 elsif t.accrual_method = 'entitlement' then
  select coalesce(sum(r.hours), 0) into v_taken from hr.leave_requests r where r.profile_id = p_profile and r.leave_type_id = p_type and r.status = 'approved'
   and r.start_date > p_as_of - 365 and r.start_date <= p_as_of;
  return greatest(0, round(coalesce(pol.days_per_year, 0) * v_daily - v_taken, 2));
 end if;
 return null;
end $fn$;
revoke all on function hr.leave_available(uuid, uuid, date) from public, anon, authenticated;

create or replace function hr.leave_type_json(t hr.leave_types) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('id', t.id, 'code', t.code, 'name', t.name, 'description', t.description, 'isPaid', t.is_paid, 'requiresBalance', t.requires_balance,
  'accrualMethod', t.accrual_method, 'sortOrder', t.sort_order, 'isActive', t.is_active,
  'policy', (select to_jsonb(x) from (select p.id, p.effective_from as "effectiveFrom", p.effective_to as "effectiveTo", p.hours_per_year as "hoursPerYear", p.days_per_year as "daysPerYear",
    p.days_per_occasion as "daysPerOccasion", p.paid_days_per_occasion as "paidDaysPerOccasion", p.accrual_fraction as "accrualFraction", p.qualifying_years as "qualifyingYears", p.note
    from hr.policy_for(t.id, current_date) p where p.id is not null) x));
$fn$;
revoke all on function hr.leave_type_json(hr.leave_types) from public, anon, authenticated;

create or replace function hr.leave_request_json(r hr.leave_requests) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('id', r.id, 'profileId', r.profile_id, 'personName', (select hr.staff_name(p) from hr.staff_profiles p where p.id = r.profile_id),
  'leaveTypeId', r.leave_type_id, 'leaveTypeCode', t.code, 'leaveTypeName', t.name, 'isPaid', t.is_paid,
  'startDate', r.start_date, 'endDate', r.end_date, 'unit', r.unit, 'quantity', r.quantity, 'hours', r.hours, 'note', r.note, 'status', r.status,
  'isAdminEntry', r.is_admin_entry, 'createdAt', r.created_at, 'decidedAt', r.decided_at, 'decisionNote', r.decision_note, 'cancelledAt', r.cancelled_at,
  'days', (select jsonb_agg(d order by d) from hr.leave_dates(r.profile_id, r.start_date, r.end_date) d))
 from hr.leave_types t where t.id = r.leave_type_id;
$fn$;
revoke all on function hr.leave_request_json(hr.leave_requests) from public, anon, authenticated;

create or replace function hr.leave_balances_json(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce(jsonb_agg(jsonb_build_object('leaveTypeId', t.id, 'code', t.code, 'name', t.name, 'isPaid', t.is_paid, 'requiresBalance', t.requires_balance,
  'accrualMethod', t.accrual_method, 'balanceHours', hr.leave_balance(p_profile, t.id), 'availableHours', hr.leave_available(p_profile, t.id, current_date),
  'pendingHours', coalesce((select sum(r.hours) from hr.leave_requests r where r.profile_id = p_profile and r.leave_type_id = t.id and r.status = 'pending'), 0),
  'serviceYears', case when t.accrual_method = 'long_service' then hr.service_years(p_profile, current_date) end,
  'qualifyingYears', case when t.accrual_method = 'long_service' then (hr.policy_for(t.id, current_date)).qualifying_years end) order by t.sort_order), '[]'::jsonb)
 from hr.leave_types t where t.is_active;
$fn$;
revoke all on function hr.leave_balances_json(uuid) from public, anon, authenticated;

-- Validates and stores a request (pending, or approved at once for an HR entry). Returns the request id.
create or replace function hr.leave_request_create(p_profile uuid, p_request jsonb, p_admin_entry boolean) returns uuid
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare t hr.leave_types; pol hr.leave_policies; v_start date := (p_request->>'startDate')::date; v_end date := coalesce(nullif(p_request->>'endDate', ''), p_request->>'startDate')::date;
 v_unit text := coalesce(nullif(p_request->>'unit', ''), 'days'); v_qty numeric := (p_request->>'quantity')::numeric; v_hours numeric; v_daily numeric := hr.employee_daily_hours(p_profile);
 v_avail numeric; v_id uuid; v_days integer;
begin
 select * into t from hr.leave_types where id = nullif(p_request->>'leaveTypeId', '')::uuid and is_active;
 if not found then raise exception 'Choose a leave type.' using errcode = '22023'; end if;
 if v_start is null then raise exception 'Choose the first day.' using errcode = '22023'; end if;
 if v_end < v_start then raise exception 'The last day is before the first day.' using errcode = '22023'; end if;
 if v_unit not in ('hours', 'days') then raise exception 'Request leave in hours or days.' using errcode = '22023'; end if;
 select count(*) into v_days from hr.leave_dates(p_profile, v_start, v_end);
 if v_qty is null then v_qty := case when v_unit = 'days' then v_days else v_days * v_daily end; end if;
 if v_qty <= 0 then raise exception 'Enter how much leave you are taking.' using errcode = '22023'; end if;
 v_hours := round(case when v_unit = 'days' then v_qty * v_daily else v_qty end, 2);
 if v_hours > v_days * 24 then raise exception 'That is more than the hours in the chosen days.' using errcode = '22023'; end if;
 if exists (select 1 from hr.leave_requests r where r.profile_id = p_profile and r.status in ('pending', 'approved') and r.start_date <= v_end and r.end_date >= v_start) then
  raise exception 'There is already a leave request covering one of those days.' using errcode = '23505'; end if;
 if exists (select 1 from hr.employee_pay ep join hr.pay_periods pp on pp.schedule_id = ep.pay_schedule_id where ep.profile_id = p_profile and pp.status <> 'open'
   and pp.start_date <= v_end and pp.end_date >= v_start) then
  raise exception 'Those days are in a locked or exported pay period.' using errcode = '22023'; end if;
 pol := hr.policy_for(t.id, v_start);
 if t.accrual_method = 'per_occasion' and pol.days_per_occasion is not null and v_hours > pol.days_per_occasion * v_daily + 0.01 then
  raise exception '% allows up to % days per occasion.', t.name, pol.days_per_occasion using errcode = '22023'; end if;
 if t.accrual_method = 'long_service' and pol.qualifying_years is not null and hr.service_years(p_profile, v_start) < pol.qualifying_years then
  raise exception 'Long service leave can be taken after % years of service.', pol.qualifying_years using errcode = '22023'; end if;
 v_avail := hr.leave_available(p_profile, t.id, v_start);
 if v_avail is not null and v_hours > v_avail + 0.01 then
  raise exception 'Not enough % available (% hours left).', lower(t.name), v_avail using errcode = '22023'; end if;
 insert into hr.leave_requests(profile_id, leave_type_id, start_date, end_date, unit, quantity, hours, note, status, is_admin_entry, created_by)
  values (p_profile, t.id, v_start, v_end, v_unit, v_qty, v_hours, left(btrim(coalesce(p_request->>'note', '')), 1000), 'pending', p_admin_entry, auth.uid())
  returning id into v_id;
 return v_id;
end $fn$;
revoke all on function hr.leave_request_create(uuid, jsonb, boolean) from public, anon, authenticated;

-- Approves a pending request: balance re-checked, 'taken' ledger entry written for balance-based types.
create or replace function hr.leave_approve(p_request uuid, p_note text) returns void
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare r hr.leave_requests; t hr.leave_types; v_avail numeric;
begin
 select * into r from hr.leave_requests where id = p_request for update;
 if r.status <> 'pending' then raise exception 'Only a pending request can be approved.' using errcode = '22023'; end if;
 select * into t from hr.leave_types where id = r.leave_type_id;
 v_avail := hr.leave_available(r.profile_id, r.leave_type_id, r.start_date);
 if v_avail is not null and r.hours > v_avail + 0.01 then raise exception 'Not enough % available (% hours left).', lower(t.name), v_avail using errcode = '22023'; end if;
 update hr.leave_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = left(btrim(coalesce(p_note, '')), 1000) where id = r.id;
 if t.requires_balance then
  insert into hr.leave_ledger(profile_id, leave_type_id, entry_kind, hours, effective_date, request_id, reason, created_by)
   values (r.profile_id, r.leave_type_id, 'taken', -r.hours, r.start_date, r.id, 'Approved leave ' || r.start_date || ' to ' || r.end_date, auth.uid());
 end if;
end $fn$;
revoke all on function hr.leave_approve(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ RPCs: the employee
create or replace function public.hr_leave_my() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.require_me();
begin
 return jsonb_build_object(
  'profileId', v_me,
  'dailyHours', hr.employee_daily_hours(v_me),
  'types', coalesce((select jsonb_agg(hr.leave_type_json(t) order by t.sort_order) from hr.leave_types t where t.is_active), '[]'::jsonb),
  'balances', hr.leave_balances_json(v_me),
  'requests', coalesce((select jsonb_agg(hr.leave_request_json(r) order by r.start_date desc, r.created_at desc) from hr.leave_requests r
    where r.profile_id = v_me and r.start_date >= current_date - 730), '[]'::jsonb),
  'canApprove', hr.is_admin() or exists (select 1 from hr.employment e where e.manager_id = v_me));
end $fn$;
revoke all on function public.hr_leave_my() from public, anon;
grant execute on function public.hr_leave_my() to authenticated;

create or replace function public.hr_leave_request(p_request jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.require_me(); v_id uuid;
begin
 v_id := hr.leave_request_create(v_me, p_request, false);
 return hr.leave_request_json((select r from hr.leave_requests r where r.id = v_id));
end $fn$;
revoke all on function public.hr_leave_request(jsonb) from public, anon;
grant execute on function public.hr_leave_request(jsonb) to authenticated;

-- The person cancels a pending request, or an approved one that has not started; HR can cancel any request outside a locked period.
create or replace function public.hr_leave_cancel(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare r hr.leave_requests; t hr.leave_types; v_mine boolean;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into r from hr.leave_requests where id = p_id for update;
 if not found then raise exception 'Leave request not found.' using errcode = 'P0002'; end if;
 v_mine := r.profile_id = hr.me_profile();
 if not (v_mine or hr.is_admin() or hr.manages(r.profile_id)) then raise exception 'Only the person, their manager or HR can cancel this.' using errcode = '42501'; end if;
 if r.status not in ('pending', 'approved') then raise exception 'This request is already %.', r.status using errcode = '22023'; end if;
 if r.status = 'approved' and v_mine and not hr.is_admin() and r.start_date <= hr.local_date(now()) then
  raise exception 'Leave that has started can only be cancelled by HR.' using errcode = '22023'; end if;
 if exists (select 1 from hr.employee_pay ep join hr.pay_periods pp on pp.schedule_id = ep.pay_schedule_id where ep.profile_id = r.profile_id and pp.status <> 'open'
   and pp.start_date <= r.end_date and pp.end_date >= r.start_date) then
  raise exception 'Those days are in a locked or exported pay period.' using errcode = '22023'; end if;
 select * into t from hr.leave_types where id = r.leave_type_id;
 if r.status = 'approved' and t.requires_balance then
  insert into hr.leave_ledger(profile_id, leave_type_id, entry_kind, hours, effective_date, request_id, reason, created_by)
   values (r.profile_id, r.leave_type_id, 'adjustment', r.hours, r.start_date, r.id, 'Cancelled leave ' || r.start_date || ' to ' || r.end_date, auth.uid());
 end if;
 update hr.leave_requests set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
  decision_note = case when p_note is null then decision_note else left(btrim(p_note), 1000) end where id = r.id returning * into r;
 return hr.leave_request_json(r);
end $fn$;
revoke all on function public.hr_leave_cancel(uuid, text) from public, anon;
grant execute on function public.hr_leave_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ RPCs: manager / HR
create or replace function public.hr_leave_decide(p_id uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare r hr.leave_requests;
begin
 select * into r from hr.leave_requests where id = p_id for update;
 if not found then raise exception 'Leave request not found.' using errcode = 'P0002'; end if;
 perform hr.require_decider(r.profile_id);
 if p_decision = 'approved' then
  perform hr.leave_approve(r.id, p_note);
 elsif p_decision = 'rejected' then
  if r.status <> 'pending' then raise exception 'Only a pending request can be rejected.' using errcode = '22023'; end if;
  update hr.leave_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = left(btrim(coalesce(p_note, '')), 1000) where id = r.id;
 else
  raise exception 'Decision must be approved or rejected.' using errcode = '22023';
 end if;
 select * into r from hr.leave_requests where id = p_id;
 return hr.leave_request_json(r);
end $fn$;
revoke all on function public.hr_leave_decide(uuid, text, text) from public, anon;
grant execute on function public.hr_leave_decide(uuid, text, text) to authenticated;

-- Team (manager: direct reports) or company (HR) leave requests.
create or replace function public.hr_leave_list(p_status text default null, p_profile uuid default null, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.me_profile(); v_admin boolean := hr.is_admin();
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if not v_admin and not exists (select 1 from hr.employment e where e.manager_id = v_me) then raise exception 'Only HR or a manager can see this.' using errcode = '42501'; end if;
 return jsonb_build_object('scope', case when v_admin then 'company' else 'team' end,
  'requests', coalesce((select jsonb_agg(hr.leave_request_json(r) order by case r.status when 'pending' then 0 else 1 end, r.start_date desc, r.created_at desc)
   from hr.leave_requests r
   where (v_admin or exists (select 1 from hr.employment e where e.profile_id = r.profile_id and e.manager_id = v_me))
    and (p_status is null or r.status = p_status) and (p_profile is null or r.profile_id = p_profile)
    and (p_from is null or r.end_date >= p_from) and (p_to is null or r.start_date <= p_to)
    and (p_from is not null or r.start_date >= current_date - 730)), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_leave_list(text, uuid, date, date) from public, anon;
grant execute on function public.hr_leave_list(text, uuid, date, date) to authenticated;

-- HR enters leave for a person (approved at once; never for HR's own record).
create or replace function public.hr_admin_leave_add(p_profile uuid, p_request jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_id uuid;
begin
 perform hr.require_admin();
 if hr.me_profile() is not null and hr.me_profile() = p_profile then raise exception 'Enter your own leave as a request for your manager to approve.' using errcode = '42501'; end if;
 if not exists (select 1 from hr.staff_profiles p where p.id = p_profile and p.status = 'active') then raise exception 'Choose an active employee.' using errcode = '22023'; end if;
 v_id := hr.leave_request_create(p_profile, p_request, true);
 perform hr.leave_approve(v_id, coalesce(p_request->>'decisionNote', 'Entered by HR'));
 return hr.leave_request_json((select r from hr.leave_requests r where r.id = v_id));
end $fn$;
revoke all on function public.hr_admin_leave_add(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_leave_add(uuid, jsonb) to authenticated;

-- Balances and the ledger of one person (HR, the manager, or the person).
create or replace function public.hr_leave_balances(p_profile uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if not (hr.is_admin() or hr.manages(p_profile) or hr.me_profile() = p_profile) then raise exception 'Only HR, the manager or the person can see this.' using errcode = '42501'; end if;
 return jsonb_build_object('profileId', p_profile, 'dailyHours', hr.employee_daily_hours(p_profile), 'balances', hr.leave_balances_json(p_profile),
  'ledger', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'leaveTypeId', l.leave_type_id, 'leaveTypeName', t.name, 'entryKind', l.entry_kind, 'hours', l.hours,
    'effectiveDate', l.effective_date, 'periodId', l.period_id, 'requestId', l.request_id, 'reason', l.reason, 'createdAt', l.created_at) order by l.effective_date desc, l.id desc)
    from hr.leave_ledger l join hr.leave_types t on t.id = l.leave_type_id where l.profile_id = p_profile), '[]'::jsonb),
  'requests', coalesce((select jsonb_agg(hr.leave_request_json(r) order by r.start_date desc) from hr.leave_requests r where r.profile_id = p_profile and r.start_date >= current_date - 730), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_leave_balances(uuid) from public, anon;
grant execute on function public.hr_leave_balances(uuid) to authenticated;

-- A manual balance entry (opening balance or adjustment) with a reason.
create or replace function public.hr_admin_leave_adjust(p_profile uuid, p_type uuid, p_hours numeric, p_reason text, p_kind text default 'adjustment') returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 if p_kind not in ('opening', 'adjustment') then raise exception 'Entry kind must be opening or adjustment.' using errcode = '22023'; end if;
 if p_hours is null or p_hours = 0 or abs(p_hours) > 5000 then raise exception 'Enter the hours to add (negative to deduct).' using errcode = '22023'; end if;
 if char_length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'A reason is required.' using errcode = '22023'; end if;
 if not exists (select 1 from hr.leave_types t where t.id = p_type and t.requires_balance) then raise exception 'That leave type has no balance.' using errcode = '22023'; end if;
 if not exists (select 1 from hr.staff_profiles p where p.id = p_profile) then raise exception 'Staff record not found.' using errcode = 'P0002'; end if;
 insert into hr.leave_ledger(profile_id, leave_type_id, entry_kind, hours, effective_date, reason, created_by)
  values (p_profile, p_type, p_kind, round(p_hours, 2), current_date, left(btrim(p_reason), 500), auth.uid());
 return public.hr_leave_balances(p_profile);
end $fn$;
revoke all on function public.hr_admin_leave_adjust(uuid, uuid, numeric, text, text) from public, anon;
grant execute on function public.hr_admin_leave_adjust(uuid, uuid, numeric, text, text) to authenticated;

-- ------------------------------------------------------------------ RPCs: type and policy administration
create or replace function public.hr_admin_leave_types() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(hr.leave_type_json(t) || jsonb_build_object('policies', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'effectiveFrom', p.effective_from,
   'effectiveTo', p.effective_to, 'hoursPerYear', p.hours_per_year, 'daysPerYear', p.days_per_year, 'daysPerOccasion', p.days_per_occasion, 'paidDaysPerOccasion', p.paid_days_per_occasion,
   'accrualFraction', p.accrual_fraction, 'qualifyingYears', p.qualifying_years, 'note', p.note, 'createdAt', p.created_at) order by p.effective_from desc)
   from hr.leave_policies p where p.leave_type_id = t.id), '[]'::jsonb)) order by t.sort_order, t.name) from hr.leave_types t), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_admin_leave_types() from public, anon;
grant execute on function public.hr_admin_leave_types() to authenticated;

create or replace function public.hr_admin_leave_type_save(p_id uuid, p_type jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare t hr.leave_types; v_code text := lower(btrim(coalesce(p_type->>'code', ''))); v_name text := left(btrim(coalesce(p_type->>'name', '')), 80);
begin
 perform hr.require_admin();
 if p_id is null then
  if v_name = '' then raise exception 'Give the leave type a name.' using errcode = '22023'; end if;
  if v_code = '' then v_code := regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g'); end if;
  insert into hr.leave_types(code, name, description, is_paid, requires_balance, accrual_method, sort_order, is_active)
   values (v_code, v_name, left(coalesce(p_type->>'description', ''), 600), coalesce((p_type->>'isPaid')::boolean, true), coalesce((p_type->>'requiresBalance')::boolean, false),
    coalesce(nullif(p_type->>'accrualMethod', ''), 'none'), coalesce((p_type->>'sortOrder')::integer, 100), coalesce((p_type->>'isActive')::boolean, true)) returning * into t;
 else
  update hr.leave_types set name = coalesce(nullif(v_name, ''), name), description = coalesce(left(p_type->>'description', 600), description),
   is_paid = coalesce((p_type->>'isPaid')::boolean, is_paid), requires_balance = coalesce((p_type->>'requiresBalance')::boolean, requires_balance),
   accrual_method = coalesce(nullif(p_type->>'accrualMethod', ''), accrual_method), sort_order = coalesce((p_type->>'sortOrder')::integer, sort_order),
   is_active = coalesce((p_type->>'isActive')::boolean, is_active) where id = p_id returning * into t;
  if not found then raise exception 'Leave type not found.' using errcode = 'P0002'; end if;
 end if;
 return hr.leave_type_json(t);
exception when unique_violation then
 raise exception 'A leave type with that code already exists.' using errcode = '23505';
end $fn$;
revoke all on function public.hr_admin_leave_type_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_leave_type_save(uuid, jsonb) to authenticated;

-- A new policy version from a date: the open previous version ends the day before. Existing versions are never edited.
create or replace function public.hr_admin_leave_policy_save(p_type uuid, p_policy jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_from date := coalesce(nullif(p_policy->>'effectiveFrom', '')::date, current_date); pol hr.leave_policies;
begin
 perform hr.require_admin();
 if not exists (select 1 from hr.leave_types t where t.id = p_type) then raise exception 'Leave type not found.' using errcode = 'P0002'; end if;
 if exists (select 1 from hr.leave_policies p where p.leave_type_id = p_type and p.effective_from >= v_from) then
  raise exception 'A policy version already starts on or after that date.' using errcode = '22023'; end if;
 update hr.leave_policies set effective_to = v_from - 1 where leave_type_id = p_type and effective_to is null and effective_from < v_from;
 insert into hr.leave_policies(leave_type_id, effective_from, hours_per_year, days_per_year, days_per_occasion, paid_days_per_occasion, accrual_fraction, qualifying_years, note, created_by)
  values (p_type, v_from, nullif(p_policy->>'hoursPerYear', '')::numeric, nullif(p_policy->>'daysPerYear', '')::numeric, nullif(p_policy->>'daysPerOccasion', '')::numeric,
   nullif(p_policy->>'paidDaysPerOccasion', '')::numeric, nullif(p_policy->>'accrualFraction', '')::numeric, nullif(p_policy->>'qualifyingYears', '')::numeric,
   left(coalesce(p_policy->>'note', ''), 600), auth.uid()) returning * into pol;
 return hr.leave_type_json((select t from hr.leave_types t where t.id = p_type));
end $fn$;
revoke all on function public.hr_admin_leave_policy_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_leave_policy_save(uuid, jsonb) to authenticated;
