-- Public holidays: automatic sync (holiday-sync Edge Function + weekly pg_cron), optional holidays that employees pick up to a yearly
-- allowance (approved like leave), and several holidays / date ranges in one go. Owner's brief 2026-11-11. Additive only.
--
-- 1. hr.public_holidays gets source (seed | api | manual | import), sync_source (data.gov.au | nager) and synced_at. The 27 rows seeded
--    by 20261110120000 are marked 'seed'; the first sync adopts them (source 'api', the official name) when the source lists the same
--    date. Anything HR adds, imports or edits by hand is 'manual' / 'import': the sync never changes or deletes it.
-- 2. hr.holiday_sync_runs: one row per sync (cron | manual, years, source per year, counts, error). The holiday-sync function calls
--    hr_holiday_sync_begin / hr_holiday_sync_finish with the caller's token: an administrator (Sync now) or the service role (the
--    pg_cron job hr-holiday-sync, Mondays 03:20 UTC, through public.hr_holiday_sync_dispatch with the Vault secrets of the retention
--    job). Rules: match on state + date; an api/seed row adopts the official name (and the note when the source gives one); a manual or
--    import row on that date is kept and nothing is inserted; new dates are inserted CONFIRMED (a tentative date at 'review'); api rows
--    of a synced year that the same source no longer lists go to 'review' with a note (never deleted); a failed fetch changes nothing
--    and is recorded. Optional holidays are never touched by the sync.
-- 3. Optional holidays: hr.optional_holiday_rules (per year: how many each employee may take, paid or unpaid) and
--    hr.optional_holiday_requests (an employee picks a confirmed optional holiday; the manager or HR approves; HR can enter one).
--    An approved paid day counts like a public holiday on the timesheet, in accrual and in the Xero export (pay item "Optional
--    Holiday"); an unpaid one is listed and exported as "Optional Holiday (unpaid)" and counts towards nothing paid. Unpicked optional
--    days are ordinary work days. A leave request never covers an approved optional holiday.
-- 4. hr_admin_holidays_add(p_rows): several holidays at once, each a single date or a range (one row per day), public or optional.
--
-- Rollback (manual): cron.unschedule('hr-holiday-sync'); drop the new functions and tables; the three new columns can stay.
set local statement_timeout = '120s';

-- ------------------------------------------------------------------ 1. where a holiday came from
alter table hr.public_holidays add column if not exists source text not null default 'manual';
alter table hr.public_holidays drop constraint if exists public_holidays_source_check;
alter table hr.public_holidays add constraint public_holidays_source_check check (source in ('seed', 'api', 'manual', 'import'));
alter table hr.public_holidays add column if not exists sync_source text;
alter table hr.public_holidays drop constraint if exists public_holidays_sync_source_check;
alter table hr.public_holidays add constraint public_holidays_sync_source_check check (sync_source is null or sync_source in ('data.gov.au', 'nager'));
alter table hr.public_holidays add column if not exists synced_at timestamptz;
create index if not exists public_holidays_source_idx on hr.public_holidays(state, source, holiday_date);

-- The rows 20261110120000 seeded (same date and name) are 'seed' so the first sync may adopt them; anything else stays 'manual'.
update hr.public_holidays h set source = 'seed'
 where h.state = 'VIC' and h.source = 'manual' and not h.is_optional and (h.holiday_date, h.name) in (
  (date '2026-01-01', 'New Year''s Day'), (date '2026-01-26', 'Australia Day'), (date '2026-03-09', 'Labour Day'), (date '2026-04-03', 'Good Friday'),
  (date '2026-04-04', 'Saturday before Easter Sunday'), (date '2026-04-05', 'Easter Sunday'), (date '2026-04-06', 'Easter Monday'), (date '2026-04-25', 'ANZAC Day'),
  (date '2026-06-08', 'King''s Birthday'), (date '2026-11-03', 'Melbourne Cup Day'), (date '2026-12-25', 'Christmas Day'), (date '2026-12-26', 'Boxing Day'),
  (date '2026-12-28', 'Boxing Day (additional day)'),
  (date '2027-01-01', 'New Year''s Day'), (date '2027-01-26', 'Australia Day'), (date '2027-03-08', 'Labour Day'), (date '2027-03-26', 'Good Friday'),
  (date '2027-03-27', 'Saturday before Easter Sunday'), (date '2027-03-28', 'Easter Sunday'), (date '2027-03-29', 'Easter Monday'), (date '2027-04-25', 'ANZAC Day'),
  (date '2027-06-14', 'King''s Birthday'), (date '2027-11-02', 'Melbourne Cup Day'), (date '2027-12-25', 'Christmas Day'), (date '2027-12-26', 'Boxing Day'),
  (date '2027-12-27', 'Christmas Day (additional day)'), (date '2027-12-28', 'Boxing Day (additional day)'));

create or replace function hr.holiday_json(h hr.public_holidays) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('id', h.id, 'date', h.holiday_date, 'name', h.name, 'isOptional', h.is_optional,
  'type', case when h.is_optional then 'optional' else 'public' end, 'state', h.state, 'status', h.status, 'note', h.note,
  'source', h.source, 'syncSource', h.sync_source, 'syncedAt', h.synced_at, 'updatedAt', h.updated_at);
$fn$;
revoke all on function hr.holiday_json(hr.public_holidays) from public, anon, authenticated;

-- ------------------------------------------------------------------ 2. sync runs
create table if not exists hr.holiday_sync_runs (
 id bigint generated always as identity primary key,
 triggered_by text not null check (triggered_by in ('cron', 'manual')),
 status text not null default 'running' check (status in ('running', 'ok', 'failed')),
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 started_by uuid,
 years integer[] not null,
 sources jsonb not null default '{}'::jsonb,
 inserted integer not null default 0,
 updated integer not null default 0,
 demoted integer not null default 0,
 kept_manual integer not null default 0,
 unchanged integer not null default 0,
 error text not null default '' check (char_length(error) <= 2000),
 detail jsonb not null default '{}'::jsonb
);
create index if not exists holiday_sync_runs_started_idx on hr.holiday_sync_runs(started_at desc);
alter table hr.holiday_sync_runs enable row level security;
revoke all on hr.holiday_sync_runs from public, anon, authenticated;

create or replace function hr.sync_run_json(r hr.holiday_sync_runs) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('id', r.id, 'trigger', r.triggered_by, 'status', r.status, 'startedAt', r.started_at, 'finishedAt', r.finished_at,
  'years', to_jsonb(r.years), 'sources', r.sources, 'inserted', r.inserted, 'updated', r.updated, 'demoted', r.demoted, 'keptManual', r.kept_manual,
  'unchanged', r.unchanged, 'error', r.error, 'errors', coalesce(r.detail->'errors', '{}'::jsonb), 'detail', r.detail);
$fn$;
revoke all on function hr.sync_run_json(hr.holiday_sync_runs) from public, anon, authenticated;

-- Who may run a sync: the project's service role (the cron job through the holiday-sync function) or an administrator (Sync now).
create or replace function hr.require_sync_caller() returns text
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 if coalesce(auth.role(), '') = 'service_role' then return 'cron'; end if;
 perform hr.require_admin();
 return 'manual';
end $fn$;
revoke all on function hr.require_sync_caller() from public, anon, authenticated;

create or replace function public.hr_holiday_sync_begin() returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_caller text := hr.require_sync_caller(); v_year integer := extract(year from (now() at time zone hr.tz()))::integer; r hr.holiday_sync_runs;
begin
 if exists (select 1 from hr.holiday_sync_runs x where x.status = 'running' and x.started_at > now() - interval '10 minutes') then
  raise exception 'A holiday sync is already running. Try again in a few minutes.' using errcode = '55P03'; end if;
 update hr.holiday_sync_runs set status = 'failed', finished_at = now(), error = 'The sync did not finish (timed out).' where status = 'running';
 insert into hr.holiday_sync_runs(triggered_by, started_by, years) values (v_caller, auth.uid(), array[v_year, v_year + 1]) returning * into r;
 return hr.sync_run_json(r) || jsonb_build_object('state', (select s.state from hr.settings s where s.id), 'timezone', hr.tz());
end $fn$;
revoke all on function public.hr_holiday_sync_begin() from public, anon;
grant execute on function public.hr_holiday_sync_begin() to authenticated, service_role;

-- p_result: {ok: boolean, error?: text, detail?: {...}, years: {"2026": {source: 'data.gov.au' | 'nager', holidays: [{date, name, note?, tentative?}]} | {error: text}}}
create or replace function public.hr_holiday_sync_finish(p_run bigint, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare r hr.holiday_sync_runs; v_state text; y record; row_ jsonb; h hr.public_holidays; v_date date; v_name text; v_note text; v_tent boolean; v_status text;
 v_src text; v_matched uuid[]; n_ins integer := 0; n_upd integer := 0; n_dem integer := 0; n_kept integer := 0; n_same integer := 0; n integer;
 v_sources jsonb := '{}'::jsonb; v_errors jsonb := '{}'::jsonb; v_ok boolean := coalesce((p_result->>'ok')::boolean, false); v_changed boolean; v_today text;
begin
 perform hr.require_sync_caller();
 select * into r from hr.holiday_sync_runs where id = p_run for update;
 if not found or r.status <> 'running' then raise exception 'Sync run not found or already finished.' using errcode = 'P0002'; end if;
 if not v_ok then
  update hr.holiday_sync_runs set status = 'failed', finished_at = now(), error = left(coalesce(nullif(p_result->>'error', ''), 'The holiday sources could not be read.'), 2000),
   detail = coalesce(p_result->'detail', '{}'::jsonb) where id = p_run returning * into r;
  return hr.sync_run_json(r);
 end if;
 select upper(s.state) into v_state from hr.settings s where s.id;
 v_today := to_char(now() at time zone hr.tz(), 'YYYY-MM-DD');
 for y in select key, value from jsonb_each(coalesce(p_result->'years', '{}'::jsonb)) where key ~ '^\d{4}$' loop
  if y.value->>'error' is not null then v_errors := v_errors || jsonb_build_object(y.key, left(y.value->>'error', 500)); continue; end if;
  v_src := y.value->>'source';
  if v_src is null or v_src not in ('data.gov.au', 'nager') or jsonb_typeof(y.value->'holidays') is distinct from 'array' then
   v_errors := v_errors || jsonb_build_object(y.key, 'Unknown source or no holiday list.'); continue; end if;
  v_sources := v_sources || jsonb_build_object(y.key, v_src);
  v_matched := '{}';
  for row_ in select * from jsonb_array_elements(y.value->'holidays') loop
   begin v_date := (row_->>'date')::date; exception when others then v_date := null; end;
   v_name := left(btrim(coalesce(row_->>'name', '')), 120);
   v_note := left(btrim(coalesce(row_->>'note', '')), 500);
   v_tent := coalesce((row_->>'tentative')::boolean, false);
   if v_date is null or v_name = '' or extract(year from v_date)::integer <> y.key::integer then continue; end if;
   v_status := case when v_tent then 'review' else 'confirmed' end;
   if v_tent and v_note = '' then v_note := 'Tentative date from the source: it is confirmed automatically once Victoria declares the day.'; end if;
   -- An api or seed row on that date adopts the source's name and note (same name preferred when a date has two holidays).
   select * into h from hr.public_holidays p where p.state = v_state and p.holiday_date = v_date and not p.is_optional and p.source in ('api', 'seed')
    and not (p.id = any(v_matched)) order by (p.name = v_name) desc, p.created_at limit 1;
   if found then
    v_matched := v_matched || h.id;
    v_changed := h.name <> v_name or h.status <> v_status or h.source <> 'api' or h.sync_source is distinct from v_src or (v_note <> '' and h.note <> v_note)
     or (not v_tent and h.note like 'Tentative date%');
    begin
     -- The source's note wins; a "tentative" note is cleared once the day is declared; otherwise the note stays.
     update hr.public_holidays set name = v_name, status = v_status, source = 'api', sync_source = v_src, synced_at = now(),
      note = case when v_note <> '' then v_note when not v_tent and note like 'Tentative date%' then '' else note end
      where id = h.id;
     if v_changed then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    exception when unique_violation then
     -- A hand-entered row already carries the official name on that date: keep it, the old api row stays as it is.
     n_kept := n_kept + 1;
    end;
   elsif exists (select 1 from hr.public_holidays p where p.state = v_state and p.holiday_date = v_date and not p.is_optional) then
    n_kept := n_kept + 1;
   else
    insert into hr.public_holidays(holiday_date, name, is_optional, state, status, note, source, sync_source, synced_at)
     values (v_date, v_name, false, v_state, v_status, v_note, 'api', v_src, now()) returning * into h;
    v_matched := v_matched || h.id; n_ins := n_ins + 1;
   end if;
  end loop;
  -- Confirmed api rows of this year from the same source that it no longer lists: never deleted, put back to review with a note.
  update hr.public_holidays p set status = 'review', synced_at = now(),
   note = left('Not in the ' || v_src || ' list on ' || v_today || '. Check it, then confirm or delete it.', 500)
   where p.state = v_state and not p.is_optional and p.source = 'api' and p.sync_source = v_src and extract(year from p.holiday_date)::integer = y.key::integer
    and p.status = 'confirmed' and not (p.id = any(v_matched));
  get diagnostics n = row_count;
  n_dem := n_dem + n;
 end loop;
 update hr.holiday_sync_runs set status = case when v_sources = '{}'::jsonb then 'failed' else 'ok' end, finished_at = now(), sources = v_sources,
  inserted = n_ins, updated = n_upd, demoted = n_dem, kept_manual = n_kept, unchanged = n_same,
  error = case when v_sources = '{}'::jsonb then left(coalesce(nullif(p_result->>'error', ''), 'No year could be read.'), 2000) else '' end,
  detail = coalesce(p_result->'detail', '{}'::jsonb) || jsonb_build_object('errors', v_errors)
  where id = p_run returning * into r;
 return hr.sync_run_json(r);
end $fn$;
revoke all on function public.hr_holiday_sync_finish(bigint, jsonb) from public, anon;
grant execute on function public.hr_holiday_sync_finish(bigint, jsonb) to authenticated, service_role;

create or replace function public.hr_admin_holiday_sync_status() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return jsonb_build_object(
  'lastRun', (select hr.sync_run_json(x) from hr.holiday_sync_runs x order by x.started_at desc, x.id desc limit 1),
  'lastOk', (select hr.sync_run_json(x) from hr.holiday_sync_runs x where x.status = 'ok' order by x.started_at desc, x.id desc limit 1),
  'runs', coalesce((select jsonb_agg(hr.sync_run_json(x) order by x.started_at desc, x.id desc) from (select * from hr.holiday_sync_runs order by started_at desc, id desc limit 10) x), '[]'::jsonb),
  'cronActive', exists (select 1 from cron.job j where j.jobname = 'hr-holiday-sync' and j.active),
  'cronSchedule', (select j.schedule from cron.job j where j.jobname = 'hr-holiday-sync' limit 1),
  'dispatchReady', (select count(*) = 2 from vault.decrypted_secrets v where v.name in ('hr_retention_service_role_key', 'hr_retention_function_url') and nullif(v.decrypted_secret, '') is not null),
  'serverNow', now());
end $fn$;
revoke all on function public.hr_admin_holiday_sync_status() from public, anon;
grant execute on function public.hr_admin_holiday_sync_status() to authenticated;

-- ------------------------------------------------------------------ 3. optional holidays
create table if not exists hr.optional_holiday_rules (
 year integer primary key check (year between 2000 and 2100),
 allowance integer not null default 0 check (allowance between 0 and 30),
 is_paid boolean not null default true,
 updated_at timestamptz not null default now(),
 updated_by uuid
);
alter table hr.optional_holiday_rules enable row level security;
revoke all on hr.optional_holiday_rules from public, anon, authenticated;

create table if not exists hr.optional_holiday_requests (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 holiday_id uuid not null references hr.public_holidays(id) on delete restrict,
 status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
 note text not null default '' check (char_length(note) <= 500),
 is_admin_entry boolean not null default false,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 decided_by uuid,
 decided_at timestamptz,
 decision_note text not null default '' check (char_length(decision_note) <= 1000),
 cancelled_at timestamptz,
 cancelled_by uuid
);
create unique index if not exists optional_holiday_requests_one_live on hr.optional_holiday_requests(profile_id, holiday_id) where status in ('pending', 'approved');
create index if not exists optional_holiday_requests_holiday_idx on hr.optional_holiday_requests(holiday_id);
create index if not exists optional_holiday_requests_profile_idx on hr.optional_holiday_requests(profile_id, status);
alter table hr.optional_holiday_requests enable row level security;
revoke all on hr.optional_holiday_requests from public, anon, authenticated;

-- The rule of a year (allowance 0 and paid when HR has not set one).
create or replace function hr.optional_rule(p_year integer) returns table(allowance integer, is_paid boolean)
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce((select r.allowance from hr.optional_holiday_rules r where r.year = p_year), 0), coalesce((select r.is_paid from hr.optional_holiday_rules r where r.year = p_year), true);
$fn$;
revoke all on function hr.optional_rule(integer) from public, anon, authenticated;

create or replace function hr.optional_rule_json(r hr.optional_holiday_rules) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('year', r.year, 'allowance', r.allowance, 'isPaid', r.is_paid, 'updatedAt', r.updated_at);
$fn$;
revoke all on function hr.optional_rule_json(hr.optional_holiday_rules) from public, anon, authenticated;

-- Picked (pending or approved) optional holidays of a person in a year.
create or replace function hr.optional_used(p_profile uuid, p_year integer) returns integer
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select count(*)::integer from hr.optional_holiday_requests r join hr.public_holidays h on h.id = r.holiday_id
 where r.profile_id = p_profile and r.status in ('pending', 'approved') and extract(year from h.holiday_date)::integer = p_year;
$fn$;
revoke all on function hr.optional_used(uuid, integer) from public, anon, authenticated;

create or replace function hr.day_locked(p_profile uuid, p_day date) returns boolean
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select exists (select 1 from hr.employee_pay ep join hr.pay_periods pp on pp.schedule_id = ep.pay_schedule_id
  where ep.profile_id = p_profile and pp.status <> 'open' and p_day between pp.start_date and pp.end_date);
$fn$;
revoke all on function hr.day_locked(uuid, date) from public, anon, authenticated;

create or replace function hr.optional_request_json(r hr.optional_holiday_requests) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('id', r.id, 'profileId', r.profile_id, 'personName', hr.staff_name(sp), 'holidayId', r.holiday_id, 'date', h.holiday_date, 'name', h.name,
  'year', extract(year from h.holiday_date)::integer, 'holidayStatus', h.status, 'isPaid', (select o.is_paid from hr.optional_rule(extract(year from h.holiday_date)::integer) o),
  'hours', hr.employee_daily_hours(r.profile_id), 'status', r.status, 'note', r.note, 'isAdminEntry', r.is_admin_entry, 'createdAt', r.created_at,
  'decidedAt', r.decided_at, 'decisionNote', r.decision_note, 'cancelledAt', r.cancelled_at)
 from hr.public_holidays h, hr.staff_profiles sp where h.id = r.holiday_id and sp.id = r.profile_id;
$fn$;
revoke all on function hr.optional_request_json(hr.optional_holiday_requests) from public, anon, authenticated;

-- Validates and stores a pick (pending, or approved at once for an HR entry). Returns the request id.
create or replace function hr.optional_request_create(p_profile uuid, p_holiday uuid, p_note text, p_admin_entry boolean) returns uuid
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare h hr.public_holidays; v_year integer; o record; v_used integer; v_id uuid; v_state text := (select s.state from hr.settings s where s.id);
begin
 select * into h from hr.public_holidays where id = p_holiday;
 if not found then raise exception 'Holiday not found.' using errcode = 'P0002'; end if;
 if not h.is_optional then raise exception 'That is a public holiday for everyone, not an optional one.' using errcode = '22023'; end if;
 if h.status <> 'confirmed' then raise exception 'That optional holiday is not confirmed yet.' using errcode = '22023'; end if;
 if h.state <> v_state then raise exception 'That holiday is not for %.', v_state using errcode = '22023'; end if;
 if not p_admin_entry and h.holiday_date < hr.local_date(now()) then raise exception 'That day has passed.' using errcode = '22023'; end if;
 if hr.day_locked(p_profile, h.holiday_date) then raise exception 'That day is in a locked or exported pay period.' using errcode = '22023'; end if;
 v_year := extract(year from h.holiday_date)::integer;
 select * into o from hr.optional_rule(v_year);
 if o.allowance = 0 then raise exception 'HR has not set an optional holiday allowance for %.', v_year using errcode = '22023'; end if;
 v_used := hr.optional_used(p_profile, v_year);
 if v_used >= o.allowance then
  raise exception '% optional holiday% for % already picked, the most allowed.', v_used, case when v_used = 1 then '' else 's' end, v_year using errcode = '22023'; end if;
 insert into hr.optional_holiday_requests(profile_id, holiday_id, status, note, is_admin_entry, created_by, decided_by, decided_at, decision_note)
  values (p_profile, p_holiday, case when p_admin_entry then 'approved' else 'pending' end, left(btrim(coalesce(p_note, '')), 500), p_admin_entry, auth.uid(),
   case when p_admin_entry then auth.uid() end, case when p_admin_entry then now() end, case when p_admin_entry then 'Entered by HR' else '' end)
  returning id into v_id;
 return v_id;
exception when unique_violation then
 raise exception 'That optional holiday is already picked.' using errcode = '23505';
end $fn$;
revoke all on function hr.optional_request_create(uuid, uuid, text, boolean) from public, anon, authenticated;

create or replace function hr.optional_approve(p_request uuid, p_note text) returns void
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare r hr.optional_holiday_requests; h hr.public_holidays; o record; v_approved integer;
begin
 select * into r from hr.optional_holiday_requests where id = p_request for update;
 if r.status <> 'pending' then raise exception 'Only a pending request can be approved.' using errcode = '22023'; end if;
 select * into h from hr.public_holidays where id = r.holiday_id;
 if h.status <> 'confirmed' or not h.is_optional then raise exception 'That optional holiday is no longer confirmed.' using errcode = '22023'; end if;
 if hr.day_locked(r.profile_id, h.holiday_date) then raise exception 'That day is in a locked or exported pay period.' using errcode = '22023'; end if;
 select * into o from hr.optional_rule(extract(year from h.holiday_date)::integer);
 select count(*) into v_approved from hr.optional_holiday_requests x join hr.public_holidays hh on hh.id = x.holiday_id
  where x.profile_id = r.profile_id and x.status = 'approved' and extract(year from hh.holiday_date) = extract(year from h.holiday_date);
 if v_approved >= o.allowance then raise exception 'This person already has % approved optional holiday% for %, the most allowed.', v_approved, case when v_approved = 1 then '' else 's' end, extract(year from h.holiday_date)::integer using errcode = '22023'; end if;
 update hr.optional_holiday_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = left(btrim(coalesce(p_note, '')), 1000) where id = r.id;
end $fn$;
revoke all on function hr.optional_approve(uuid, text) from public, anon, authenticated;

-- An approval or cancellation inside an OPEN period reopens that person's timesheet approval (as a leave change does).
create or replace function hr.optional_requests_reset_approval() returns trigger
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare v_day date;
begin
 if tg_op = 'UPDATE' and new.status is distinct from old.status and (new.status = 'approved' or old.status = 'approved') then
  select h.holiday_date into v_day from hr.public_holidays h where h.id = new.holiday_id;
  perform hr.reset_approval(new.profile_id, v_day, v_day);
 end if;
 return new;
end $fn$;
drop trigger if exists optional_requests_reset_approval on hr.optional_holiday_requests;
create trigger optional_requests_reset_approval after update on hr.optional_holiday_requests for each row execute function hr.optional_requests_reset_approval();

-- RPCs: the employee
create or replace function public.hr_optional_holidays_my(p_year integer default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.require_me(); v_year integer := coalesce(p_year, extract(year from (now() at time zone hr.tz()))::integer); o record; v_used integer;
begin
 select * into o from hr.optional_rule(v_year);
 v_used := hr.optional_used(v_me, v_year);
 return jsonb_build_object('profileId', v_me, 'year', v_year, 'allowance', o.allowance, 'isPaid', o.is_paid, 'used', v_used, 'remaining', greatest(0, o.allowance - v_used),
  'today', hr.local_date(now()),
  'holidays', coalesce((select jsonb_agg(hr.holiday_json(h) || jsonb_build_object('request',
     (select hr.optional_request_json(r) from hr.optional_holiday_requests r where r.holiday_id = h.id and r.profile_id = v_me and r.status in ('pending', 'approved') limit 1)) order by h.holiday_date, h.name)
    from hr.public_holidays h join hr.settings s on s.id where h.state = s.state and h.is_optional and h.status = 'confirmed' and extract(year from h.holiday_date)::integer = v_year), '[]'::jsonb),
  'requests', coalesce((select jsonb_agg(hr.optional_request_json(r) order by h.holiday_date desc, r.created_at desc) from hr.optional_holiday_requests r join hr.public_holidays h on h.id = r.holiday_id
    where r.profile_id = v_me and extract(year from h.holiday_date)::integer = v_year), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_optional_holidays_my(integer) from public, anon;
grant execute on function public.hr_optional_holidays_my(integer) to authenticated;

create or replace function public.hr_optional_holiday_pick(p_holiday uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.require_me(); v_id uuid;
begin
 v_id := hr.optional_request_create(v_me, p_holiday, p_note, false);
 return hr.optional_request_json((select r from hr.optional_holiday_requests r where r.id = v_id));
end $fn$;
revoke all on function public.hr_optional_holiday_pick(uuid, text) from public, anon;
grant execute on function public.hr_optional_holiday_pick(uuid, text) to authenticated;

-- The person cancels a pending pick, or an approved one before the day; HR or the manager can cancel any outside a locked period.
create or replace function public.hr_optional_holiday_cancel(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare r hr.optional_holiday_requests; h hr.public_holidays; v_mine boolean;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into r from hr.optional_holiday_requests where id = p_id for update;
 if not found then raise exception 'Request not found.' using errcode = 'P0002'; end if;
 select * into h from hr.public_holidays where id = r.holiday_id;
 v_mine := r.profile_id = hr.me_profile();
 if not (v_mine or hr.is_admin() or hr.manages(r.profile_id)) then raise exception 'Only the person, their manager or HR can cancel this.' using errcode = '42501'; end if;
 if r.status not in ('pending', 'approved') then raise exception 'This request is already %.', r.status using errcode = '22023'; end if;
 if r.status = 'approved' and v_mine and not hr.is_admin() and h.holiday_date <= hr.local_date(now()) then
  raise exception 'An optional holiday that has started can only be cancelled by HR.' using errcode = '22023'; end if;
 if hr.day_locked(r.profile_id, h.holiday_date) then raise exception 'That day is in a locked or exported pay period.' using errcode = '22023'; end if;
 update hr.optional_holiday_requests set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
  decision_note = case when p_note is null then decision_note else left(btrim(p_note), 1000) end where id = r.id returning * into r;
 return hr.optional_request_json(r);
end $fn$;
revoke all on function public.hr_optional_holiday_cancel(uuid, text) from public, anon;
grant execute on function public.hr_optional_holiday_cancel(uuid, text) to authenticated;

-- RPCs: manager / HR
create or replace function public.hr_optional_holiday_decide(p_id uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare r hr.optional_holiday_requests;
begin
 select * into r from hr.optional_holiday_requests where id = p_id for update;
 if not found then raise exception 'Request not found.' using errcode = 'P0002'; end if;
 perform hr.require_decider(r.profile_id);
 if p_decision = 'approved' then
  perform hr.optional_approve(r.id, p_note);
 elsif p_decision = 'rejected' then
  if r.status <> 'pending' then raise exception 'Only a pending request can be rejected.' using errcode = '22023'; end if;
  update hr.optional_holiday_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = left(btrim(coalesce(p_note, '')), 1000) where id = r.id;
 else
  raise exception 'Decision must be approved or rejected.' using errcode = '22023';
 end if;
 select * into r from hr.optional_holiday_requests where id = p_id;
 return hr.optional_request_json(r);
end $fn$;
revoke all on function public.hr_optional_holiday_decide(uuid, text, text) from public, anon;
grant execute on function public.hr_optional_holiday_decide(uuid, text, text) to authenticated;

create or replace function public.hr_optional_holiday_list(p_status text default null, p_profile uuid default null, p_year integer default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.me_profile(); v_admin boolean := hr.is_admin();
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if not v_admin and not exists (select 1 from hr.employment e where e.manager_id = v_me) then raise exception 'Only HR or a manager can see this.' using errcode = '42501'; end if;
 return jsonb_build_object('scope', case when v_admin then 'company' else 'team' end,
  'requests', coalesce((select jsonb_agg(hr.optional_request_json(r) order by case r.status when 'pending' then 0 else 1 end, h.holiday_date desc, r.created_at desc)
   from hr.optional_holiday_requests r join hr.public_holidays h on h.id = r.holiday_id
   where (v_admin or exists (select 1 from hr.employment e where e.profile_id = r.profile_id and e.manager_id = v_me))
    and (p_status is null or r.status = p_status) and (p_profile is null or r.profile_id = p_profile)
    and (p_year is null or extract(year from h.holiday_date)::integer = p_year)
    and (p_year is not null or h.holiday_date >= current_date - 730)), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_optional_holiday_list(text, uuid, integer) from public, anon;
grant execute on function public.hr_optional_holiday_list(text, uuid, integer) to authenticated;

-- HR gives a person an optional holiday (approved at once; never HR's own record).
create or replace function public.hr_admin_optional_holiday_add(p_profile uuid, p_holiday uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_id uuid;
begin
 perform hr.require_admin();
 if hr.me_profile() is not null and hr.me_profile() = p_profile then raise exception 'Pick your own optional holiday from My HR for your manager to approve.' using errcode = '42501'; end if;
 if not exists (select 1 from hr.staff_profiles p where p.id = p_profile and p.status = 'active') then raise exception 'Choose an active employee.' using errcode = '22023'; end if;
 v_id := hr.optional_request_create(p_profile, p_holiday, p_note, true);
 return hr.optional_request_json((select r from hr.optional_holiday_requests r where r.id = v_id));
end $fn$;
revoke all on function public.hr_admin_optional_holiday_add(uuid, uuid, text) from public, anon;
grant execute on function public.hr_admin_optional_holiday_add(uuid, uuid, text) to authenticated;

-- RPCs: the yearly rule
create or replace function public.hr_admin_optional_rules() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_year integer := extract(year from (now() at time zone hr.tz()))::integer;
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(jsonb_build_object('year', y, 'allowance', o.allowance, 'isPaid', o.is_paid, 'isSet', r.year is not null, 'updatedAt', r.updated_at,
   'optionalHolidays', (select count(*) from hr.public_holidays h join hr.settings s on s.id where h.state = s.state and h.is_optional and extract(year from h.holiday_date)::integer = y),
   'picked', (select count(*) from hr.optional_holiday_requests q join hr.public_holidays h on h.id = q.holiday_id where q.status in ('pending', 'approved') and extract(year from h.holiday_date)::integer = y)) order by y)
  from (select distinct y from (select generate_series(v_year - 1, v_year + 2) as y union select year from hr.optional_holiday_rules) years) ys
  cross join lateral hr.optional_rule(ys.y) o left join hr.optional_holiday_rules r on r.year = ys.y), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_admin_optional_rules() from public, anon;
grant execute on function public.hr_admin_optional_rules() to authenticated;

create or replace function public.hr_admin_optional_rule_save(p_year integer, p_rule jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare r hr.optional_holiday_rules; v_allowance integer := (p_rule->>'allowance')::integer; v_paid boolean := (p_rule->>'isPaid')::boolean;
begin
 perform hr.require_admin();
 if p_year is null or p_year not between 2000 and 2100 then raise exception 'Choose a year.' using errcode = '22023'; end if;
 if v_allowance is null or v_allowance not between 0 and 30 then raise exception 'The allowance is how many optional holidays each employee may take in the year (0 to 30).' using errcode = '22023'; end if;
 insert into hr.optional_holiday_rules(year, allowance, is_paid, updated_at, updated_by) values (p_year, v_allowance, coalesce(v_paid, true), now(), auth.uid())
  on conflict (year) do update set allowance = excluded.allowance, is_paid = coalesce(v_paid, hr.optional_holiday_rules.is_paid), updated_at = now(), updated_by = auth.uid()
  returning * into r;
 return hr.optional_rule_json(r);
end $fn$;
revoke all on function public.hr_admin_optional_rule_save(integer, jsonb) from public, anon;
grant execute on function public.hr_admin_optional_rule_save(integer, jsonb) to authenticated;

-- ------------------------------------------------------------------ timesheets, leave days, Xero: approved optional holidays count
-- (drop + create: the row type gains is_optional, is_paid and request_id; period_summary and period_day_lines below are the only callers)
drop function if exists hr.period_holidays(uuid, uuid);
create function hr.period_holidays(p_period uuid, p_profile uuid) returns table(day date, name text, hours numeric, is_optional boolean, is_paid boolean, request_id uuid)
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select h.holiday_date, h.name, hr.employee_daily_hours(p_profile), false, true, null::uuid
 from hr.pay_periods p join hr.settings s on s.id
 join hr.public_holidays h on h.state = s.state and h.status = 'confirmed' and not h.is_optional and h.holiday_date between p.start_date and p.end_date
 where p.id = p_period and extract(isodow from h.holiday_date)::smallint = any(hr.employee_work_days(p_profile))
  and exists (select 1 from hr.employment e where e.profile_id = p_profile and (e.joining_date is null or e.joining_date <= h.holiday_date))
 union all
 select h.holiday_date, h.name, hr.employee_daily_hours(p_profile), true, (select o.is_paid from hr.optional_rule(extract(year from h.holiday_date)::integer) o), r.id
 from hr.pay_periods p join hr.settings s on s.id
 join hr.optional_holiday_requests r on r.profile_id = p_profile and r.status = 'approved'
 join hr.public_holidays h on h.id = r.holiday_id and h.state = s.state and h.status = 'confirmed' and h.is_optional and h.holiday_date between p.start_date and p.end_date
 where p.id = p_period and extract(isodow from h.holiday_date)::smallint = any(hr.employee_work_days(p_profile))
  and exists (select 1 from hr.employment e where e.profile_id = p_profile and (e.joining_date is null or e.joining_date <= h.holiday_date))
 order by 1, 4;
$fn$;
revoke all on function hr.period_holidays(uuid, uuid) from public, anon, authenticated;

create or replace function hr.period_summary(p_period uuid, p_profile uuid) returns jsonb
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare p hr.pay_periods; ep hr.employee_pay; v_worked numeric := 0; v_break integer := 0; v_open integer := 0; v_flags text[] := '{}'; v_shifts jsonb;
 v_paid_leave numeric := 0; v_unpaid_leave numeric := 0; v_holiday numeric := 0; v_unpaid_holiday numeric := 0; v_ordinary numeric; v_counted numeric; v_overtime numeric; v_gross numeric;
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
 select coalesce(sum(h.hours) filter (where h.is_paid), 0), coalesce(sum(h.hours) filter (where not h.is_paid), 0),
  coalesce(jsonb_agg(jsonb_build_object('day', h.day, 'name', h.name, 'hours', h.hours, 'isOptional', h.is_optional, 'isPaid', h.is_paid, 'requestId', h.request_id) order by h.day, h.is_optional), '[]'::jsonb)
  into v_holiday, v_unpaid_holiday, v_holidays from hr.period_holidays(p_period, p_profile) h;
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
  'paidLeaveHours', round(v_paid_leave, 2), 'unpaidLeaveHours', round(v_unpaid_leave, 2), 'holidayHours', round(v_holiday, 2), 'unpaidHolidayHours', round(v_unpaid_holiday, 2),
  'ordinaryHours', v_ordinary, 'countedHours', v_counted, 'overtimeHours', v_overtime,
  'payBasis', ep.pay_basis, 'rate', ep.rate, 'estimatedGross', v_gross, 'xeroEmployeeId', coalesce(ep.xero_employee_id, ''),
  'hasPaySetup', ep.profile_id is not null and ep.pay_schedule_id is not null,
  'shifts', v_shifts, 'leave', v_leave, 'holidays', v_holidays,
  'approval', case when a.id is null then null else jsonb_build_object('status', a.status, 'decidedAt', a.decided_at, 'note', a.note,
   'decidedByName', coalesce((select hr.staff_name(sp) from hr.staff_profiles sp where sp.auth_user_id = a.decided_by), (select u.name from public.cms_users u where u.auth_user_id = a.decided_by))) end,
  'approvable', v_open = 0 and not (v_flags && array['missing_punch_out', 'unclosed_break']::text[]));
end $fn$;
revoke all on function hr.period_summary(uuid, uuid) from public, anon, authenticated;

-- Pay items for the export: Ordinary, Overtime, Public Holiday, Optional Holiday, Optional Holiday (unpaid), each leave type.
create or replace function hr.period_day_lines(p_period uuid, p_profile uuid) returns table(day date, pay_item text, hours numeric, leave_type_code text)
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare p hr.pay_periods; v_summary jsonb; v_overtime numeric; r record; v_take numeric;
begin
 select * into p from hr.pay_periods where id = p_period;
 v_summary := hr.period_summary(p_period, p_profile);
 v_overtime := (v_summary->>'overtimeHours')::numeric;
 for r in select s.work_date as d, round(sum(s.worked_minutes) / 60.0, 2) as h from hr.shifts(p_profile, p.start_date, p.end_date) s where not s.is_open group by s.work_date order by s.work_date desc loop
  v_take := least(v_overtime, r.h);
  if v_take > 0 then day := r.d; pay_item := 'Overtime'; hours := v_take; leave_type_code := null; return next; v_overtime := v_overtime - v_take; end if;
  if r.h - v_take > 0 then day := r.d; pay_item := 'Ordinary'; hours := round(r.h - v_take, 2); leave_type_code := null; return next; end if;
 end loop;
 for r in select h.day as d, h.hours as h, h.is_optional, h.is_paid from hr.period_holidays(p_period, p_profile) h loop
  day := r.d; pay_item := case when not r.is_optional then 'Public Holiday' when r.is_paid then 'Optional Holiday' else 'Optional Holiday (unpaid)' end; hours := r.h; leave_type_code := null; return next;
 end loop;
 for r in select l.day as d, sum(l.hours) as h, l.name, l.code from hr.period_leave_days(p_period, p_profile) l group by l.day, l.name, l.code order by l.day loop
  day := r.d; pay_item := r.name; hours := round(r.h, 2); leave_type_code := r.code; return next;
 end loop;
 return;
end $fn$;
revoke all on function hr.period_day_lines(uuid, uuid) from public, anon, authenticated;

-- Leave days skip confirmed public holidays and the person's approved optional holidays.
create or replace function hr.leave_dates(p_profile uuid, p_start date, p_end date) returns setof date
language sql stable security definer set search_path = hr, pg_temp as $fn$
 with d as (select g::date as day from generate_series(p_start, p_end, interval '1 day') g),
 w as (select day from d where extract(isodow from day)::smallint = any(hr.employee_work_days(p_profile)) and not hr.is_public_holiday(day)
   and not exists (select 1 from hr.optional_holiday_requests r join hr.public_holidays h on h.id = r.holiday_id where r.profile_id = p_profile and r.status = 'approved' and h.holiday_date = d.day))
 select day from w union all select p_start where not exists (select 1 from w) order by 1;
$fn$;
revoke all on function hr.leave_dates(uuid, date, date) from public, anon, authenticated;

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
  'pendingLeave', (select count(*) from hr.leave_requests r where r.status = 'pending' and (v_admin or exists (select 1 from hr.employment e where e.profile_id = r.profile_id and e.manager_id = v_me))),
  'pendingOptional', (select count(*) from hr.optional_holiday_requests r where r.status = 'pending' and (v_admin or exists (select 1 from hr.employment e where e.profile_id = r.profile_id and e.manager_id = v_me))));
end $fn$;
revoke all on function public.hr_my_team() from public, anon;
grant execute on function public.hr_my_team() to authenticated;

-- ------------------------------------------------------------------ 4. holidays by hand: edited rows become manual; several at once; ranges
create or replace function public.hr_admin_holiday_save(p_id uuid, p_holiday jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare h hr.public_holidays; v_date date := (p_holiday->>'date')::date; v_name text := left(btrim(coalesce(p_holiday->>'name', '')), 120);
 v_status text := coalesce(nullif(p_holiday->>'status', ''), 'review'); v_state text := upper(coalesce(nullif(btrim(p_holiday->>'state'), ''), (select state from hr.settings where id)));
begin
 perform hr.require_admin();
 if v_status not in ('review', 'confirmed') then raise exception 'Status must be review or confirmed.' using errcode = '22023'; end if;
 if p_id is null then
  if v_date is null or v_name = '' then raise exception 'A date and a name are required.' using errcode = '22023'; end if;
  insert into hr.public_holidays(holiday_date, name, is_optional, state, status, note, source, updated_by)
   values (v_date, v_name, coalesce((p_holiday->>'isOptional')::boolean, false), v_state, v_status, left(coalesce(p_holiday->>'note', ''), 500), 'manual', auth.uid())
   returning * into h;
 else
  select * into h from hr.public_holidays where id = p_id for update;
  if not found then raise exception 'Holiday not found.' using errcode = 'P0002'; end if;
  if h.is_optional and coalesce((p_holiday->>'isOptional')::boolean, true) = false
   and exists (select 1 from hr.optional_holiday_requests r where r.holiday_id = h.id and r.status in ('pending', 'approved')) then
   raise exception 'Employees have picked this optional holiday. Cancel those requests before making it a public holiday.' using errcode = '22023'; end if;
  -- Edited by hand: the sync leaves it alone from now on.
  update hr.public_holidays set holiday_date = coalesce(v_date, holiday_date), name = coalesce(nullif(v_name, ''), name),
   is_optional = coalesce((p_holiday->>'isOptional')::boolean, is_optional), status = v_status,
   note = coalesce(left(p_holiday->>'note', 500), note), source = 'manual', updated_by = auth.uid()
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
declare h hr.public_holidays; v_live integer;
begin
 perform hr.require_admin();
 select count(*) into v_live from hr.optional_holiday_requests r where r.holiday_id = p_id and r.status in ('pending', 'approved');
 if v_live > 0 then raise exception '% employee% picked this optional holiday. Cancel those requests first.', v_live, case when v_live = 1 then '' else 's' end using errcode = '22023'; end if;
 delete from hr.optional_holiday_requests where holiday_id = p_id;
 delete from hr.public_holidays where id = p_id returning * into h;
 if not found then raise exception 'Holiday not found.' using errcode = 'P0002'; end if;
 return hr.holiday_json(h);
end $fn$;
revoke all on function public.hr_admin_holiday_delete(uuid) from public, anon;
grant execute on function public.hr_admin_holiday_delete(uuid) to authenticated;

-- The Excel / CSV import (20261110220000) marks its rows 'import' (kept by the sync); the same date + name + state updates the row.
create or replace function public.hr_admin_holidays_import(p_rows jsonb, p_status text default 'review') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; i int := 0; v_date date; v_name text; v_state text; v_default_state text; problems text[] := '{}';
 v_inserted int := 0; v_updated int := 0; v_status text := coalesce(nullif(p_status, ''), 'review'); v_new boolean;
begin
 perform hr.require_admin();
 if v_status not in ('review', 'confirmed') then raise exception 'Status must be review or confirmed.' using errcode = '22023'; end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'The file has no holidays.' using errcode = '22023'; end if;
 if jsonb_array_length(p_rows) > 500 then raise exception 'Import up to 500 holidays at a time.' using errcode = '22023'; end if;
 select upper(coalesce(nullif(btrim(s.state), ''), 'VIC')) into v_default_state from hr.settings s limit 1;
 v_default_state := coalesce(v_default_state, 'VIC');
 for r in select * from jsonb_array_elements(p_rows) loop
  i := i + 1;
  begin v_date := (r->>'date')::date; exception when others then v_date := null; end;
  v_name := btrim(coalesce(r->>'name', ''));
  v_state := upper(coalesce(nullif(btrim(r->>'state'), ''), v_default_state));
  if v_date is null then problems := problems || format('row %s: the date is missing or not a date', i + 1);
  elsif v_date < date '2000-01-01' or v_date > date '2100-12-31' then problems := problems || format('row %s: the date is out of range', i + 1); end if;
  if v_name = '' or char_length(v_name) > 120 then problems := problems || format('row %s: the name is missing or longer than 120 characters', i + 1); end if;
  if v_state !~ '^[A-Z]{2,3}$' then problems := problems || format('row %s: the state must be like VIC', i + 1); end if;
 end loop;
 if cardinality(problems) > 0 then
  raise exception 'Nothing was imported. Fix these rows and try again: %', array_to_string(problems[1:20], '; ') using errcode = '22023';
 end if;
 for r in select * from jsonb_array_elements(p_rows) loop
  v_date := (r->>'date')::date; v_name := btrim(r->>'name');
  v_state := upper(coalesce(nullif(btrim(r->>'state'), ''), v_default_state));
  insert into hr.public_holidays (holiday_date, name, is_optional, state, status, note, source, updated_by)
  values (v_date, v_name, coalesce((r->>'isOptional')::boolean, false), v_state, v_status, left(coalesce(r->>'note', ''), 500), 'import', auth.uid())
  on conflict (state, holiday_date, name) do update set is_optional = excluded.is_optional, status = excluded.status,
   note = case when excluded.note <> '' then excluded.note else hr.public_holidays.note end, source = 'import', updated_by = auth.uid(), updated_at = now()
  returning (xmax = 0) into v_new;
  if v_new then v_inserted := v_inserted + 1; else v_updated := v_updated + 1; end if;
 end loop;
 return jsonb_build_object('inserted', v_inserted, 'updated', v_updated);
end $$;
revoke all on function public.hr_admin_holidays_import(jsonb, text) from public, anon;
grant execute on function public.hr_admin_holidays_import(jsonb, text) to authenticated;

-- p_rows: [{name, startDate, endDate?, isOptional?, note?, status?}] (up to 50 entries, a range of up to 31 days each, 200 days in all).
-- One row per day; all or nothing; the same date + name updates the existing row. Everything is 'manual' and CONFIRMED unless status says review.
create or replace function public.hr_admin_holidays_add(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare r jsonb; i integer := 0; v_start date; v_end date; v_name text; v_status text; problems text[] := '{}'; v_days integer := 0;
 v_state text := upper(coalesce((select s.state from hr.settings s where s.id), 'VIC')); v_inserted integer := 0; v_updated integer := 0; v_new boolean; v_day date; v_ids uuid[] := '{}'; v_id uuid;
begin
 perform hr.require_admin();
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Add at least one holiday.' using errcode = '22023'; end if;
 if jsonb_array_length(p_rows) > 50 then raise exception 'Add up to 50 holidays at a time.' using errcode = '22023'; end if;
 for r in select * from jsonb_array_elements(p_rows) loop
  i := i + 1;
  begin v_start := (r->>'startDate')::date; exception when others then v_start := null; end;
  begin v_end := coalesce(nullif(r->>'endDate', ''), r->>'startDate')::date; exception when others then v_end := null; end;
  v_name := btrim(coalesce(r->>'name', ''));
  v_status := coalesce(nullif(r->>'status', ''), 'confirmed');
  if v_start is null then problems := problems || format('holiday %s: the first day is missing or not a date', i);
  elsif v_start < date '2000-01-01' or v_start > date '2100-12-31' then problems := problems || format('holiday %s: the date is out of range', i);
  elsif v_end is null or v_end < v_start then problems := problems || format('holiday %s: the last day is before the first day', i);
  elsif v_end - v_start > 30 then problems := problems || format('holiday %s: a range can cover up to 31 days', i);
  else v_days := v_days + (v_end - v_start + 1); end if;
  if v_name = '' or char_length(v_name) > 120 then problems := problems || format('holiday %s: the name is missing or longer than 120 characters', i); end if;
  if v_status not in ('review', 'confirmed') then problems := problems || format('holiday %s: status must be review or confirmed', i); end if;
 end loop;
 if v_days > 200 then problems := problems || 'that is more than 200 days in one go'; end if;
 if cardinality(problems) > 0 then raise exception 'Nothing was added. Fix these and try again: %', array_to_string(problems[1:20], '; ') using errcode = '22023'; end if;
 for r in select * from jsonb_array_elements(p_rows) loop
  v_start := (r->>'startDate')::date; v_end := coalesce(nullif(r->>'endDate', ''), r->>'startDate')::date; v_name := btrim(r->>'name');
  v_status := coalesce(nullif(r->>'status', ''), 'confirmed');
  for v_day in select g::date from generate_series(v_start, v_end, interval '1 day') g loop
   insert into hr.public_holidays(holiday_date, name, is_optional, state, status, note, source, updated_by)
    values (v_day, v_name, coalesce((r->>'isOptional')::boolean, false), v_state, v_status, left(coalesce(r->>'note', ''), 500), 'manual', auth.uid())
   on conflict (state, holiday_date, name) do update set is_optional = excluded.is_optional, status = excluded.status,
    note = case when excluded.note <> '' then excluded.note else hr.public_holidays.note end, source = 'manual', updated_by = auth.uid(), updated_at = now()
   returning (xmax = 0), id into v_new, v_id;
   v_ids := v_ids || v_id;
   if v_new then v_inserted := v_inserted + 1; else v_updated := v_updated + 1; end if;
  end loop;
 end loop;
 return jsonb_build_object('inserted', v_inserted, 'updated', v_updated,
  'holidays', coalesce((select jsonb_agg(hr.holiday_json(x) order by x.holiday_date, x.name) from hr.public_holidays x where x.id = any(v_ids)), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_admin_holidays_add(jsonb) from public, anon;
grant execute on function public.hr_admin_holidays_add(jsonb) to authenticated;

-- ------------------------------------------------------------------ 5. the weekly job: pg_cron -> pg_net -> holiday-sync (service role from Vault)
-- Mondays 03:20 UTC (14:20 Melbourne in summer). Reuses the retention job's Vault secrets: the function URL is the retention URL with
-- staff-admin replaced by holiday-sync (a dedicated secret hr_holiday_sync_function_url wins when present). Without the secrets the job
-- does nothing. Pause: cron.alter_job(..., active := false). Remove: cron.unschedule('hr-holiday-sync'). HR can also press Sync now.
create extension if not exists pg_net;
create extension if not exists pg_cron;
create or replace function public.hr_holiday_sync_dispatch() returns bigint
language plpgsql security definer set search_path = public, vault, net, pg_temp as $fn$
declare v_key text; v_url text;
begin
 if not pg_try_advisory_xact_lock(9342, 20261113) then return null; end if;
 select decrypted_secret into v_key from vault.decrypted_secrets where name = 'hr_retention_service_role_key' limit 1;
 select decrypted_secret into v_url from vault.decrypted_secrets where name = 'hr_holiday_sync_function_url' limit 1;
 if nullif(v_url, '') is null then
  select regexp_replace(decrypted_secret, '/staff-admin$', '/holiday-sync') into v_url from vault.decrypted_secrets where name = 'hr_retention_function_url' limit 1;
 end if;
 if nullif(v_key, '') is null or nullif(v_url, '') is null or v_url !~ '^https?://[^/]+/functions/v1/holiday-sync$' then return null; end if;
 return net.http_post(url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
  body := '{"action":"sync","trigger":"cron"}'::jsonb, timeout_milliseconds := 55000);
end $fn$;
revoke all on function public.hr_holiday_sync_dispatch() from public, anon, authenticated, service_role;
grant execute on function public.hr_holiday_sync_dispatch() to postgres;
do $job$
begin
 if not exists (select 1 from cron.job where jobname = 'hr-holiday-sync') then
  perform cron.schedule('hr-holiday-sync', '20 3 * * 1', 'select public.hr_holiday_sync_dispatch();');
 end if;
end $job$;
