-- HRMS part 1 (Victoria): HR settings (timezone, ordinary hours), Victorian public holidays and time & attendance.
-- Everything is ADDITIVE: new hr tables (RLS on, no grants to anon/authenticated; all access through SECURITY DEFINER
-- RPCs in public), new functions, no change to existing rows or columns.
-- Fixed decisions (owner, 2026-11-10): timezone 'Australia/Melbourne' stored in hr.settings (never an offset in code);
-- every instant is timestamptz; hours worked = elapsed time; work date = local date of the punch-in; breaks unpaid by
-- default; weekend and public-holiday shifts allowed but flagged; punches from desktop/mobile web only.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------------------------ settings (one row)
create table if not exists hr.settings (
 id boolean primary key default true check (id),
 timezone text not null default 'Australia/Melbourne' check (char_length(timezone) between 1 and 64),
 state text not null default 'VIC' check (state ~ '^[A-Z]{2,3}$'),
 ordinary_hours_week numeric(5,2) not null default 38 check (ordinary_hours_week > 0 and ordinary_hours_week <= 80),
 open_shift_flag_hours integer not null default 14 check (open_shift_flag_hours between 1 and 48),
 usual_work_days smallint[] not null default '{1,2,3,4,5}' check (cardinality(usual_work_days) between 1 and 7 and usual_work_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
 breaks_paid boolean not null default false,
 updated_at timestamptz not null default now(),
 updated_by uuid
);
alter table hr.settings enable row level security;
revoke all on hr.settings from public, anon, authenticated;
insert into hr.settings default values on conflict (id) do nothing;

create or replace function hr.tz() returns text
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce((select s.timezone from hr.settings s where s.id), 'Australia/Melbourne');
$fn$;
revoke all on function hr.tz() from public, anon, authenticated;

-- Local (Melbourne) calendar date of an instant, and local midnight of a date as an instant (DST-aware through the tz database).
create or replace function hr.local_date(p_at timestamptz) returns date
language sql stable security definer set search_path = hr, pg_temp as $fn$ select (p_at at time zone hr.tz())::date; $fn$;
revoke all on function hr.local_date(timestamptz) from public, anon, authenticated;

create or replace function hr.local_midnight(p_day date) returns timestamptz
language sql stable security definer set search_path = hr, pg_temp as $fn$ select (p_day::timestamp at time zone hr.tz()); $fn$;
revoke all on function hr.local_midnight(date) from public, anon, authenticated;

create or replace function hr.settings_json() returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('timezone', s.timezone, 'state', s.state, 'ordinaryHoursWeek', s.ordinary_hours_week,
  'openShiftFlagHours', s.open_shift_flag_hours, 'usualWorkDays', to_jsonb(s.usual_work_days), 'breaksPaid', s.breaks_paid,
  'updatedAt', s.updated_at, 'serverNow', now())
 from hr.settings s where s.id;
$fn$;
revoke all on function hr.settings_json() from public, anon, authenticated;

-- ------------------------------------------------------------------ identity helpers
-- The signed-in person's ACTIVE staff record (null when they are not an active employee).
create or replace function hr.me_profile() returns uuid
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select p.id from hr.staff_profiles p where p.auth_user_id = auth.uid() and p.status = 'active';
$fn$;
revoke all on function hr.me_profile() from public, anon, authenticated;

create or replace function hr.require_me() returns uuid
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v uuid := hr.me_profile();
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if v is null then raise exception 'Only an active employee can do this.' using errcode = '42501'; end if;
 return v;
end $fn$;
revoke all on function hr.require_me() from public, anon, authenticated;

create or replace function hr.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $fn$
 select auth.uid() is not null and public.cms_is_admin();
$fn$;
revoke all on function hr.is_admin() from public, anon, authenticated;

-- True when the signed-in employee is the manager of p_profile (hr.employment.manager_id).
create or replace function hr.manages(p_profile uuid) returns boolean
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select exists (select 1 from hr.employment e where e.profile_id = p_profile and e.manager_id is not null and e.manager_id = hr.me_profile());
$fn$;
revoke all on function hr.manages(uuid) from public, anon, authenticated;

-- HR admin or the person's manager may look at and correct their time; never anyone else.
create or replace function hr.require_oversight(p_profile uuid) returns uuid
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if not (hr.is_admin() or hr.manages(p_profile)) then raise exception 'Only HR or the person''s manager can do this.' using errcode = '42501'; end if;
 return auth.uid();
end $fn$;
revoke all on function hr.require_oversight(uuid) from public, anon, authenticated;

-- A decision on someone's time or leave: HR admin or their manager, and never on one's own record.
create or replace function hr.require_decider(p_profile uuid) returns uuid
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if hr.me_profile() is not null and hr.me_profile() = p_profile then raise exception 'You cannot approve your own record.' using errcode = '42501'; end if;
 perform hr.require_oversight(p_profile);
 return auth.uid();
end $fn$;
revoke all on function hr.require_decider(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ settings RPCs
create or replace function public.hr_settings() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 return hr.settings_json();
end $fn$;
revoke all on function public.hr_settings() from public, anon;
grant execute on function public.hr_settings() to authenticated;

create or replace function public.hr_admin_settings_save(p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_tz text := nullif(btrim(coalesce(p_settings->>'timezone', '')), ''); v_days smallint[];
begin
 perform hr.require_admin();
 if v_tz is not null and not exists (select 1 from pg_timezone_names where name = v_tz) then raise exception 'Unknown timezone.' using errcode = '22023'; end if;
 if p_settings ? 'usualWorkDays' then
  select array_agg(x::smallint order by x) into v_days from jsonb_array_elements_text(p_settings->'usualWorkDays') x;
 end if;
 update hr.settings set
  timezone = coalesce(v_tz, timezone),
  ordinary_hours_week = coalesce((p_settings->>'ordinaryHoursWeek')::numeric, ordinary_hours_week),
  open_shift_flag_hours = coalesce((p_settings->>'openShiftFlagHours')::integer, open_shift_flag_hours),
  usual_work_days = coalesce(v_days, usual_work_days),
  breaks_paid = coalesce((p_settings->>'breaksPaid')::boolean, breaks_paid),
  updated_at = now(), updated_by = auth.uid()
 where id;
 return hr.settings_json();
end $fn$;
revoke all on function public.hr_admin_settings_save(jsonb) from public, anon;
grant execute on function public.hr_admin_settings_save(jsonb) to authenticated;

-- ------------------------------------------------------------------ public holidays (Victoria)
create table if not exists hr.public_holidays (
 id uuid primary key default gen_random_uuid(),
 holiday_date date not null,
 name text not null check (char_length(btrim(name)) between 1 and 120),
 is_optional boolean not null default false,
 state text not null default 'VIC' check (state ~ '^[A-Z]{2,3}$'),
 status text not null default 'review' check (status in ('review', 'confirmed')),
 note text not null default '' check (char_length(note) <= 500),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid,
 unique (state, holiday_date, name)
);
create index if not exists public_holidays_date_idx on hr.public_holidays(state, holiday_date);
alter table hr.public_holidays enable row level security;
revoke all on hr.public_holidays from public, anon, authenticated;
drop trigger if exists public_holidays_touch on hr.public_holidays;
create trigger public_holidays_touch before update on hr.public_holidays for each row execute function hr.touch_updated_at();

-- A paid public holiday is a CONFIRMED, non-optional row for the configured state.
create or replace function hr.is_public_holiday(p_day date) returns boolean
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select exists (select 1 from hr.public_holidays h join hr.settings s on s.id where h.holiday_date = p_day and h.state = s.state and h.status = 'confirmed' and not h.is_optional);
$fn$;
revoke all on function hr.is_public_holiday(date) from public, anon, authenticated;

create or replace function hr.holiday_json(h hr.public_holidays) returns jsonb
language sql immutable as $fn$
 select jsonb_build_object('id', h.id, 'date', h.holiday_date, 'name', h.name, 'isOptional', h.is_optional, 'state', h.state,
  'status', h.status, 'note', h.note, 'updatedAt', h.updated_at);
$fn$;
revoke all on function hr.holiday_json(hr.public_holidays) from public, anon, authenticated;

-- Victoria 2026 and 2027 (Public Holidays Act 1993 (Vic) rules: ANZAC Day has NO substitute when it falls on a weekend;
-- Christmas Day / Boxing Day / New Year's Day on a weekend get an additional weekday holiday; the Friday before the AFL
-- Grand Final is declared each year and is entered by HR by hand). Every row starts at 'review' for HR to confirm.
insert into hr.public_holidays(holiday_date, name, is_optional, state, status, note) values
 ('2026-01-01', 'New Year''s Day', false, 'VIC', 'review', ''),
 ('2026-01-26', 'Australia Day', false, 'VIC', 'review', ''),
 ('2026-03-09', 'Labour Day', false, 'VIC', 'review', 'Second Monday in March'),
 ('2026-04-03', 'Good Friday', false, 'VIC', 'review', ''),
 ('2026-04-04', 'Saturday before Easter Sunday', false, 'VIC', 'review', ''),
 ('2026-04-05', 'Easter Sunday', false, 'VIC', 'review', ''),
 ('2026-04-06', 'Easter Monday', false, 'VIC', 'review', ''),
 ('2026-04-25', 'ANZAC Day', false, 'VIC', 'review', 'Falls on a Saturday; no substitute day in Victoria'),
 ('2026-06-08', 'King''s Birthday', false, 'VIC', 'review', 'Second Monday in June'),
 ('2026-11-03', 'Melbourne Cup Day', false, 'VIC', 'review', 'First Tuesday in November; metropolitan Melbourne'),
 ('2026-12-25', 'Christmas Day', false, 'VIC', 'review', ''),
 ('2026-12-26', 'Boxing Day', false, 'VIC', 'review', 'Falls on a Saturday'),
 ('2026-12-28', 'Boxing Day (additional day)', false, 'VIC', 'review', 'Additional public holiday for Boxing Day falling on a Saturday'),
 ('2027-01-01', 'New Year''s Day', false, 'VIC', 'review', ''),
 ('2027-01-26', 'Australia Day', false, 'VIC', 'review', ''),
 ('2027-03-08', 'Labour Day', false, 'VIC', 'review', 'Second Monday in March'),
 ('2027-03-26', 'Good Friday', false, 'VIC', 'review', ''),
 ('2027-03-27', 'Saturday before Easter Sunday', false, 'VIC', 'review', ''),
 ('2027-03-28', 'Easter Sunday', false, 'VIC', 'review', ''),
 ('2027-03-29', 'Easter Monday', false, 'VIC', 'review', ''),
 ('2027-04-25', 'ANZAC Day', false, 'VIC', 'review', 'Falls on a Sunday; no substitute day in Victoria'),
 ('2027-06-14', 'King''s Birthday', false, 'VIC', 'review', 'Second Monday in June'),
 ('2027-11-02', 'Melbourne Cup Day', false, 'VIC', 'review', 'First Tuesday in November; metropolitan Melbourne'),
 ('2027-12-25', 'Christmas Day', false, 'VIC', 'review', 'Falls on a Saturday'),
 ('2027-12-26', 'Boxing Day', false, 'VIC', 'review', 'Falls on a Sunday'),
 ('2027-12-27', 'Christmas Day (additional day)', false, 'VIC', 'review', 'Additional public holiday for Christmas Day falling on a Saturday'),
 ('2027-12-28', 'Boxing Day (additional day)', false, 'VIC', 'review', 'Additional public holiday for Boxing Day falling on a Sunday')
on conflict (state, holiday_date, name) do nothing;

create or replace function public.hr_public_holidays(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_from date := coalesce(p_from, date_trunc('year', current_date)::date); v_to date := coalesce(p_to, (date_trunc('year', current_date) + interval '2 years - 1 day')::date);
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if v_to < v_from or v_to - v_from > 1100 then raise exception 'Choose a range of up to three years.' using errcode = '22023'; end if;
 return coalesce((select jsonb_agg(hr.holiday_json(h) order by h.holiday_date, h.name) from hr.public_holidays h join hr.settings s on s.id
  where h.state = s.state and h.holiday_date between v_from and v_to), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_public_holidays(date, date) from public, anon;
grant execute on function public.hr_public_holidays(date, date) to authenticated;

create or replace function public.hr_admin_holiday_save(p_id uuid, p_holiday jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare h hr.public_holidays; v_date date := (p_holiday->>'date')::date; v_name text := left(btrim(coalesce(p_holiday->>'name', '')), 120);
 v_status text := coalesce(nullif(p_holiday->>'status', ''), 'review'); v_state text := upper(coalesce(nullif(btrim(p_holiday->>'state'), ''), (select state from hr.settings where id)));
begin
 perform hr.require_admin();
 if v_status not in ('review', 'confirmed') then raise exception 'Status must be review or confirmed.' using errcode = '22023'; end if;
 if p_id is null then
  if v_date is null or v_name = '' then raise exception 'A date and a name are required.' using errcode = '22023'; end if;
  insert into hr.public_holidays(holiday_date, name, is_optional, state, status, note, updated_by)
   values (v_date, v_name, coalesce((p_holiday->>'isOptional')::boolean, false), v_state, v_status, left(coalesce(p_holiday->>'note', ''), 500), auth.uid())
   returning * into h;
 else
  select * into h from hr.public_holidays where id = p_id for update;
  if not found then raise exception 'Holiday not found.' using errcode = 'P0002'; end if;
  update hr.public_holidays set holiday_date = coalesce(v_date, holiday_date), name = coalesce(nullif(v_name, ''), name),
   is_optional = coalesce((p_holiday->>'isOptional')::boolean, is_optional), status = v_status,
   note = coalesce(left(p_holiday->>'note', 500), note), updated_by = auth.uid()
   where id = p_id returning * into h;
 end if;
 return hr.holiday_json(h);
exception when unique_violation then
 raise exception 'That holiday is already listed for this date.' using errcode = '23505';
end $fn$;
revoke all on function public.hr_admin_holiday_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_holiday_save(uuid, jsonb) to authenticated;

create or replace function public.hr_admin_holiday_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare h hr.public_holidays;
begin
 perform hr.require_admin();
 delete from hr.public_holidays where id = p_id returning * into h;
 if not found then raise exception 'Holiday not found.' using errcode = 'P0002'; end if;
 return hr.holiday_json(h);
end $fn$;
revoke all on function public.hr_admin_holiday_delete(uuid) from public, anon;
grant execute on function public.hr_admin_holiday_delete(uuid) to authenticated;

-- ------------------------------------------------------------------ time events (append-only)
-- Every punch is a row. A correction is a NEW row (source 'correction', reason required) that supersedes the original; a
-- 'void' row supersedes a punch and contributes nothing. Rows are never updated or deleted (trigger below).
create table if not exists hr.time_events (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 kind text not null check (kind in ('punch_in', 'break_start', 'break_end', 'punch_out', 'void')),
 at timestamptz not null,
 source text not null check (source in ('web', 'mobile', 'correction')),
 supersedes uuid references hr.time_events(id),
 reason text not null default '' check (char_length(reason) <= 500),
 recorded_by uuid not null,
 recorded_at timestamptz not null default now(),
 check (source <> 'correction' or char_length(btrim(reason)) > 0),
 check (kind <> 'void' or supersedes is not null),
 check (supersedes is null or source = 'correction'),
 check (supersedes is null or supersedes <> id)
);
create index if not exists time_events_profile_at_idx on hr.time_events(profile_id, at, recorded_at);
-- A row is superseded at most once (a correction of a correction supersedes the correction row).
create unique index if not exists time_events_supersedes_once on hr.time_events(supersedes) where supersedes is not null;
alter table hr.time_events enable row level security;
revoke all on hr.time_events from public, anon, authenticated;

create or replace function hr.time_events_append_only() returns trigger
language plpgsql as $fn$
begin
 raise exception 'hr.time_events is append-only: record a correction or a void instead.' using errcode = '0A000';
end $fn$;
drop trigger if exists time_events_no_update on hr.time_events;
create trigger time_events_no_update before update or delete on hr.time_events for each row execute function hr.time_events_append_only();
drop trigger if exists time_events_no_truncate on hr.time_events;
create trigger time_events_no_truncate before truncate on hr.time_events for each statement execute function hr.time_events_append_only();

-- The punches that count: not void and not superseded by a later row.
create or replace function hr.time_effective(p_profile uuid, p_from timestamptz default null, p_to timestamptz default null) returns setof hr.time_events
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select e.* from hr.time_events e
 where e.profile_id = p_profile and e.kind <> 'void'
  and (p_from is null or e.at >= p_from) and (p_to is null or e.at <= p_to)
  and not exists (select 1 from hr.time_events s where s.supersedes = e.id)
 order by e.at, e.recorded_at, e.id;
$fn$;
revoke all on function hr.time_effective(uuid, timestamptz, timestamptz) from public, anon, authenticated;

create or replace function hr.time_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable as $fn$
 select case coalesce(p_from, 'none')
  when 'none' then p_to = 'punch_in'
  when 'punch_out' then p_to = 'punch_in'
  when 'punch_in' then p_to in ('break_start', 'punch_out')
  when 'break_end' then p_to in ('break_start', 'punch_out')
  when 'break_start' then p_to = 'break_end'
  else false end;
$fn$;
revoke all on function hr.time_transition_allowed(text, text) from public, anon, authenticated;

-- The current state of a person: the kind of their last effective punch ('none' before the first one).
create or replace function hr.time_state(p_profile uuid) returns table(state text, since timestamptz, last_id uuid)
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce(e.kind, 'none'), e.at, e.id
 from (select 1) x left join lateral (select * from hr.time_effective(p_profile) order by at desc, recorded_at desc limit 1) e on true;
$fn$;
revoke all on function hr.time_state(uuid) from public, anon, authenticated;

-- True when the effective punches of a person in a window form a valid sequence (used after a correction).
create or replace function hr.time_sequence_valid(p_profile uuid, p_from timestamptz, p_to timestamptz) returns boolean
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare r record; v_state text;
begin
 -- Start from the state just before the window: the last effective punch before p_from ('none' when there is none).
 select coalesce(e.kind, 'none') into v_state from (select 1) x
  left join lateral (select * from hr.time_effective(p_profile, null, p_from - interval '1 microsecond') order by at desc, recorded_at desc limit 1) e on true;
 for r in select * from hr.time_effective(p_profile, p_from, p_to) loop
  if not hr.time_transition_allowed(v_state, r.kind) then return false; end if;
  v_state := r.kind;
 end loop;
 return true;
end $fn$;
revoke all on function hr.time_sequence_valid(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- ------------------------------------------------------------------ shifts
-- Builds shifts from the effective punches: punch_in .. punch_out with its breaks. work_date = local date of the punch-in
-- (night shifts belong to their start day). worked_minutes = elapsed time minus unpaid breaks (an open shift counts to now()).
-- Flags: missing_punch_out (open longer than settings.open_shift_flag_hours), unclosed_break (break still open at punch-out),
-- weekend, public_holiday (a confirmed holiday on the work date).
create or replace function hr.shifts(p_profile uuid, p_from date, p_to date)
returns table(work_date date, started_at timestamptz, ended_at timestamptz, break_minutes integer, worked_minutes integer, is_open boolean, flags text[], event_ids uuid[])
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare r record; s hr.settings; v_start timestamptz; v_break_start timestamptz; v_break interval := interval '0'; v_unclosed boolean := false;
 v_ids uuid[] := '{}'; v_win_from timestamptz; v_win_to timestamptz;
begin
 select * into s from hr.settings where id;
 v_win_from := hr.local_midnight(p_from) - interval '1 day';
 v_win_to := hr.local_midnight(p_to + 1) + interval '2 days';
 for r in select * from hr.time_effective(p_profile, v_win_from, v_win_to) loop
  if r.kind = 'punch_in' then
   if v_start is not null then
    -- A punch-in while a shift is still open (only possible after corrections): report the earlier shift as open.
    work_date := hr.local_date(v_start); started_at := v_start; ended_at := null;
    break_minutes := floor(extract(epoch from v_break) / 60)::integer;
    worked_minutes := greatest(0, floor(extract(epoch from (r.at - v_start - case when s.breaks_paid then interval '0' else v_break end)) / 60))::integer;
    is_open := true; flags := array['missing_punch_out']::text[]; event_ids := v_ids;
    if extract(isodow from work_date) in (6, 7) then flags := flags || 'weekend'::text; end if;
    if hr.is_public_holiday(work_date) then flags := flags || 'public_holiday'::text; end if;
    if work_date between p_from and p_to then return next; end if;
   end if;
   v_start := r.at; v_break_start := null; v_break := interval '0'; v_unclosed := false; v_ids := array[r.id];
  elsif r.kind = 'break_start' then
   if v_start is not null and v_break_start is null then v_break_start := r.at; v_ids := v_ids || r.id; end if;
  elsif r.kind = 'break_end' then
   if v_start is not null and v_break_start is not null then v_break := v_break + (r.at - v_break_start); v_break_start := null; v_ids := v_ids || r.id; end if;
  elsif r.kind = 'punch_out' then
   if v_start is not null then
    if v_break_start is not null then v_break := v_break + (r.at - v_break_start); v_break_start := null; v_unclosed := true; end if;
    v_ids := v_ids || r.id;
    work_date := hr.local_date(v_start); started_at := v_start; ended_at := r.at;
    break_minutes := floor(extract(epoch from v_break) / 60)::integer;
    worked_minutes := greatest(0, floor(extract(epoch from (r.at - v_start - case when s.breaks_paid then interval '0' else v_break end)) / 60))::integer;
    is_open := false; flags := '{}'::text[]; event_ids := v_ids;
    if v_unclosed then flags := flags || 'unclosed_break'::text; end if;
    if extract(isodow from work_date) in (6, 7) then flags := flags || 'weekend'::text; end if;
    if hr.is_public_holiday(work_date) then flags := flags || 'public_holiday'::text; end if;
    if work_date between p_from and p_to then return next; end if;
    v_start := null; v_break := interval '0'; v_unclosed := false; v_ids := '{}';
   end if;
  end if;
 end loop;
 if v_start is not null then
  -- Still open: worked so far (an open break counts up to now as a break).
  work_date := hr.local_date(v_start); started_at := v_start; ended_at := null;
  break_minutes := floor(extract(epoch from (v_break + case when v_break_start is not null then now() - v_break_start else interval '0' end)) / 60)::integer;
  worked_minutes := greatest(0, floor(extract(epoch from (now() - v_start - case when s.breaks_paid then interval '0' else (v_break + case when v_break_start is not null then now() - v_break_start else interval '0' end) end)) / 60))::integer;
  is_open := true; flags := '{}'::text[]; event_ids := v_ids;
  if now() - v_start > make_interval(hours => s.open_shift_flag_hours) then flags := flags || 'missing_punch_out'::text; end if;
  if extract(isodow from work_date) in (6, 7) then flags := flags || 'weekend'::text; end if;
  if hr.is_public_holiday(work_date) then flags := flags || 'public_holiday'::text; end if;
  if work_date between p_from and p_to then return next; end if;
 end if;
 return;
end $fn$;
revoke all on function hr.shifts(uuid, date, date) from public, anon, authenticated;

create or replace function hr.shifts_json(p_profile uuid, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce(jsonb_agg(jsonb_build_object('workDate', s.work_date, 'startedAt', s.started_at, 'endedAt', s.ended_at, 'breakMinutes', s.break_minutes,
  'workedMinutes', s.worked_minutes, 'isOpen', s.is_open, 'flags', to_jsonb(s.flags), 'eventIds', to_jsonb(s.event_ids)) order by s.started_at), '[]'::jsonb)
 from hr.shifts(p_profile, p_from, p_to) s;
$fn$;
revoke all on function hr.shifts_json(uuid, date, date) from public, anon, authenticated;

create or replace function hr.time_event_json(e hr.time_events) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('id', e.id, 'kind', e.kind, 'at', e.at, 'source', e.source, 'supersedes', e.supersedes, 'reason', e.reason,
  'recordedAt', e.recorded_at, 'recordedBy', e.recorded_by,
  'supersededBy', (select s.id from hr.time_events s where s.supersedes = e.id),
  'workDate', hr.local_date(e.at));
$fn$;
revoke all on function hr.time_event_json(hr.time_events) from public, anon, authenticated;

-- ------------------------------------------------------------------ time RPCs
-- The signed-in employee's punch state, their open shift and today's shifts (local day).
create or replace function public.hr_time_status() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.require_me(); st record; v_today date := hr.local_date(now()); v_open jsonb;
begin
 select * into st from hr.time_state(v_me);
 select to_jsonb(x) into v_open from (select s.started_at as "startedAt", s.break_minutes as "breakMinutes", s.worked_minutes as "workedMinutes", s.flags
  from hr.shifts(v_me, v_today - 2, v_today) s where s.is_open order by s.started_at desc limit 1) x;
 return jsonb_build_object(
  'profileId', v_me,
  'state', st.state,
  'since', st.since,
  'nextKinds', case st.state when 'none' then '["punch_in"]'::jsonb when 'punch_out' then '["punch_in"]'::jsonb
   when 'punch_in' then '["break_start","punch_out"]'::jsonb when 'break_end' then '["break_start","punch_out"]'::jsonb
   when 'break_start' then '["break_end"]'::jsonb else '[]'::jsonb end,
  'openShift', v_open,
  'today', v_today,
  'todayShifts', hr.shifts_json(v_me, v_today, v_today),
  'serverNow', now(),
  'timezone', hr.tz());
end $fn$;
revoke all on function public.hr_time_status() from public, anon;
grant execute on function public.hr_time_status() to authenticated;

-- A live punch from the web (desktop or mobile). The state machine is checked under a per-employee lock.
create or replace function public.hr_time_punch(p_kind text, p_source text default 'web') returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.require_me(); st record;
begin
 if p_kind not in ('punch_in', 'break_start', 'break_end', 'punch_out') then raise exception 'Unknown punch.' using errcode = '22023'; end if;
 if coalesce(p_source, 'web') not in ('web', 'mobile') then raise exception 'Punches come from the web or the mobile web.' using errcode = '22023'; end if;
 perform pg_advisory_xact_lock(hashtext('hr.time_events'), hashtext(v_me::text));
 select * into st from hr.time_state(v_me);
 if not hr.time_transition_allowed(st.state, p_kind) then
  raise exception 'That punch is not possible right now (current state: %).' , replace(st.state, '_', ' ') using errcode = '22023';
 end if;
 if st.since is not null and st.since >= clock_timestamp() then raise exception 'The previous punch is not before now; ask HR to correct it.' using errcode = '22023'; end if;
 insert into hr.time_events(profile_id, kind, at, source, recorded_by) values (v_me, p_kind, clock_timestamp(), coalesce(p_source, 'web'), auth.uid());
 return public.hr_time_status();
end $fn$;
revoke all on function public.hr_time_punch(text, text) from public, anon;
grant execute on function public.hr_time_punch(text, text) to authenticated;

create or replace function public.hr_time_my_shifts(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.require_me();
begin
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then raise exception 'Choose a range of up to two months.' using errcode = '22023'; end if;
 return jsonb_build_object('from', p_from, 'to', p_to, 'timezone', hr.tz(), 'shifts', hr.shifts_json(v_me, p_from, p_to));
end $fn$;
revoke all on function public.hr_time_my_shifts(date, date) from public, anon;
grant execute on function public.hr_time_my_shifts(date, date) to authenticated;

-- HR or the manager: every punch of a person in a range (effective, superseded and void rows alike) plus the shifts built from them.
create or replace function public.hr_admin_employee_punches(p_profile uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_oversight(p_profile);
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then raise exception 'Choose a range of up to two months.' using errcode = '22023'; end if;
 return jsonb_build_object('profileId', p_profile, 'from', p_from, 'to', p_to, 'timezone', hr.tz(),
  'name', (select hr.staff_name(p) from hr.staff_profiles p where p.id = p_profile),
  'state', (select to_jsonb(x) from hr.time_state(p_profile) x),
  'events', coalesce((select jsonb_agg(hr.time_event_json(e) order by e.at, e.recorded_at) from hr.time_events e
    where e.profile_id = p_profile and e.at >= hr.local_midnight(p_from) - interval '1 day' and e.at < hr.local_midnight(p_to + 1) + interval '1 day'), '[]'::jsonb),
  'shifts', hr.shifts_json(p_profile, p_from, p_to));
end $fn$;
revoke all on function public.hr_admin_employee_punches(uuid, date, date) from public, anon;
grant execute on function public.hr_admin_employee_punches(uuid, date, date) to authenticated;
