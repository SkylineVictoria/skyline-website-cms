begin;

-- Employment record (2026-11-11): work locations from a managed list, the job type (Full time | Part time | Contract; we employ
-- no casual staff), the pay type as the pay schedule's frequency (fortnightly | monthly, never stored twice), the same three as
-- letter variables, a sign-in link for EXISTING employees (added as Active, never onboarded), and the employee timesheet's
-- "today" in the HR timezone. Additive: no column, table or row is dropped; a legacy 'casual' row stays valid but cannot be
-- saved again.

-- ------------------------------------------------------------------ 1. locations (HRMS > Locations)
create table if not exists hr.locations (
 id uuid primary key default gen_random_uuid(),
 name text not null check (char_length(btrim(name)) between 1 and 120),
 address text not null default '' check (char_length(address) <= 300),
 is_active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid
);
create unique index if not exists locations_name_key on hr.locations(lower(btrim(name)));
alter table hr.locations enable row level security;
revoke all on hr.locations from public, anon, authenticated;
drop trigger if exists locations_touch on hr.locations;
create trigger locations_touch before update on hr.locations for each row execute function hr.touch_updated_at();

-- The free-text locations already in use become the first entries of the list (no row is changed).
insert into hr.locations(name)
 select distinct on (lower(btrim(x.name))) btrim(x.name) from (
  select e.work_location as name from hr.employment e union all select j.location from hr.jobs j) x
 where btrim(coalesce(x.name, '')) <> '' order by lower(btrim(x.name)), btrim(x.name)
 on conflict do nothing;

alter table hr.employment add column if not exists location_id uuid references hr.locations(id);
update hr.employment e set location_id = l.id from hr.locations l
 where e.location_id is null and btrim(e.work_location) <> '' and lower(btrim(l.name)) = lower(btrim(e.work_location));

create or replace function hr.location_json(l hr.locations) returns jsonb
language sql immutable as $fn$
 select jsonb_build_object('id', l.id, 'name', l.name, 'address', l.address, 'isActive', l.is_active, 'updatedAt', l.updated_at);
$fn$;
revoke all on function hr.location_json(hr.locations) from public, anon, authenticated;

create or replace function hr.locations_json(p_active_only boolean default true) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select coalesce((select jsonb_agg(hr.location_json(l) order by l.is_active desc, lower(l.name)) from hr.locations l where l.is_active or not p_active_only), '[]'::jsonb);
$fn$;
revoke all on function hr.locations_json(boolean) from public, anon, authenticated;

create or replace function public.hr_admin_locations() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(hr.location_json(l) || jsonb_build_object('employeeCount', (select count(*) from hr.employment e where e.location_id = l.id))
  order by l.is_active desc, lower(l.name)) from hr.locations l), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_admin_locations() from public, anon;
grant execute on function public.hr_admin_locations() to authenticated;

create or replace function public.hr_admin_location_save(p_id uuid, p_location jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare l hr.locations; v_name text := left(btrim(coalesce(p_location->>'name', '')), 120); v_address text := left(btrim(coalesce(p_location->>'address', '')), 300);
begin
 perform hr.require_admin();
 if p_id is null then
  if v_name = '' then raise exception 'Give the location a name.' using errcode = '22023'; end if;
  insert into hr.locations(name, address, is_active, updated_by) values (v_name, v_address, coalesce((p_location->>'isActive')::boolean, true), auth.uid()) returning * into l;
 else
  select * into l from hr.locations where id = p_id for update;
  if not found then raise exception 'Location not found.' using errcode = 'P0002'; end if;
  update hr.locations set name = coalesce(nullif(v_name, ''), name), address = case when p_location ? 'address' then v_address else address end,
   is_active = coalesce((p_location->>'isActive')::boolean, is_active), updated_by = auth.uid() where id = p_id returning * into l;
  -- A renamed location renames the text copy every employment record keeps for letters and exports.
  update hr.employment set work_location = l.name where location_id = l.id and work_location is distinct from l.name;
 end if;
 return hr.location_json(l);
exception when unique_violation then
 raise exception 'A location with that name already exists.' using errcode = '23505';
end $fn$;
revoke all on function public.hr_admin_location_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_location_save(uuid, jsonb) to authenticated;

-- The location an employment form names: by id, or by the exact name of an active location (older callers); '' = none.
create or replace function hr.location_resolve(p_id text, p_name text) returns hr.locations
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare l hr.locations;
begin
 if coalesce(btrim(p_id), '') <> '' then
  if p_id !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Choose the work location from the list.' using errcode = '22023'; end if;
  select * into l from hr.locations where id = p_id::uuid;
  if not found or not l.is_active then raise exception 'Choose an active work location from the list.' using errcode = '22023'; end if;
  return l;
 end if;
 if coalesce(btrim(p_name), '') = '' then return null; end if;
 select * into l from hr.locations where lower(btrim(name)) = lower(btrim(p_name)) and is_active;
 if not found then raise exception 'Choose the work location from the list (HRMS > Locations).' using errcode = '22023'; end if;
 return l;
end $fn$;
revoke all on function hr.location_resolve(text, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ 2. job type: Full time | Part time | Contract
-- The check keeps 'casual' only so a row written before this change stays valid; hr_admin_staff_employment_save and
-- hr_admin_onboarding_pay_save no longer accept it.
alter table hr.employment drop constraint if exists employment_employment_type_check;
alter table hr.employment add constraint employment_employment_type_check check (employment_type in ('full_time', 'part_time', 'contract', 'casual'));

create or replace function public.hr_admin_staff_employment_save(p_id uuid, p_employment jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; v_manager uuid := nullif(p_employment->>'managerId', '')::uuid; l hr.locations;
 v_title text := left(btrim(coalesce(p_employment->>'jobTitle', '')), 150); v_type text := nullif(p_employment->>'employmentType', '');
 v_department text := left(btrim(coalesce(p_employment->>'department', '')), 120);
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff record not found.' using errcode = 'P0002'; end if;
 if v_type is not null and v_type not in ('full_time', 'part_time', 'contract') then raise exception 'Choose Full time, Part time or Contract.' using errcode = '22023'; end if;
 l := hr.location_resolve(p_employment->>'locationId', p_employment->>'workLocation');
 if v_manager is not null then
  if v_manager = p.id then raise exception 'A person cannot be their own manager.' using errcode = '23514'; end if;
  if not exists (select 1 from hr.employment e join hr.staff_profiles m on m.id = e.profile_id where e.profile_id = v_manager and m.status = 'active') then
   raise exception 'Choose an active employee as the manager.' using errcode = '22023'; end if;
  if exists (with recursive chain as (select e.profile_id, e.manager_id from hr.employment e where e.profile_id = v_manager
    union select e.profile_id, e.manager_id from hr.employment e join chain c on e.profile_id = c.manager_id) select 1 from chain where profile_id = p.id) then
   raise exception 'The manager assignment would create a reporting cycle.' using errcode = '23514'; end if;
 end if;
 insert into hr.employment(profile_id, department, job_title, employment_type, manager_id, work_location, location_id)
  values (p.id, v_department, v_title, v_type, v_manager, coalesce(l.name, ''), l.id)
 on conflict (profile_id) do update set department = excluded.department, job_title = excluded.job_title, employment_type = excluded.employment_type,
  manager_id = excluded.manager_id, work_location = excluded.work_location, location_id = excluded.location_id;
 return public.hr_admin_staff_detail(p.id);
end $fn$;

create or replace function hr.onboarding_pay_problem(p_profile uuid) returns text
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare e hr.employment; ep hr.employee_pay;
begin
 select * into e from hr.employment where profile_id = p_profile;
 if not found or e.pay_details_at is null then return 'Add the pay details first.'; end if;
 select * into ep from hr.employee_pay where profile_id = p_profile;
 if btrim(e.job_title) = '' then return 'The pay details need a position (job title).'; end if;
 if e.employment_type is null then return 'The pay details need an employment type.'; end if;
 if e.location_id is null then return 'The pay details need a work location.'; end if;
 if e.joining_date is null then return 'The pay details need a start date.'; end if;
 if ep.profile_id is null or ep.pay_basis is null then return 'The pay details need a pay basis (hourly or annual).'; end if;
 if ep.rate is null or ep.rate <= 0 then return 'The pay details need a pay rate.'; end if;
 if ep.pay_schedule_id is null then return 'The pay details need a pay schedule.'; end if;
 if e.employment_type <> 'contract' and ep.ordinary_hours_week is null then return 'The pay details need the hours per week.'; end if;
 return null;
end $fn$;

create or replace function public.hr_admin_onboarding_pay_save(p_id uuid, p_details jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; v_problem text;
 v_title text := btrim(coalesce(p_details->>'jobTitle', '')); v_type text := nullif(p_details->>'employmentType', '');
 v_start_raw text := btrim(coalesce(p_details->>'startDate', '')); v_start date;
 v_basis text := nullif(p_details->>'payBasis', ''); v_rate_raw text := btrim(coalesce(p_details->>'rate', '')); v_rate numeric;
 v_hours_raw text := btrim(coalesce(p_details->>'hoursPerWeek', '')); v_hours numeric;
 v_schedule_raw text := btrim(coalesce(p_details->>'payScheduleId', '')); v_schedule uuid;
 v_location_raw text := btrim(coalesce(p_details->>'locationId', ''));
begin
 if jsonb_typeof(p_details) is distinct from 'object' then raise exception 'Enter the pay details.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status in ('offer_sent', 'offer_signed') then raise exception 'The offer has already gone out with these pay details. Withdraw the offer to change them.' using errcode = '23514'; end if;
 if p.status <> 'documents_submitted' then raise exception 'Pay details are added once the documents are submitted and approved.' using errcode = '23514'; end if;
 v_problem := hr.staff_documents_problem(p.id);
 if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;

 if v_title = '' or char_length(v_title) > 150 then raise exception 'Enter the position (job title).' using errcode = '22023'; end if;
 if v_type is null or v_type not in ('full_time', 'part_time', 'contract') then raise exception 'Choose the employment type.' using errcode = '22023'; end if;
 if v_location_raw = '' and btrim(coalesce(p_details->>'workLocation', '')) = '' then raise exception 'Choose the work location.' using errcode = '22023'; end if;
 if v_start_raw !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Enter the start date.' using errcode = '22023'; end if;
 begin v_start := v_start_raw::date; exception when others then raise exception 'Enter a valid start date.' using errcode = '22023'; end;
 if v_start < current_date - 365 or v_start > current_date + 730 then raise exception 'The start date must be within the last year or the next two years.' using errcode = '22023'; end if;
 if v_basis is null or v_basis not in ('hourly', 'salary') then raise exception 'Choose the pay basis (hourly or annual).' using errcode = '22023'; end if;
 if v_rate_raw !~ '^\d{1,9}(\.\d{1,2})?$' then raise exception 'Enter the pay rate as a number, for example 38.50.' using errcode = '22023'; end if;
 v_rate := v_rate_raw::numeric;
 if v_rate <= 0 then raise exception 'The pay rate must be more than zero.' using errcode = '22023'; end if;
 if v_basis = 'hourly' and v_rate > 1000 then raise exception 'That hourly rate looks too high. Check the pay basis.' using errcode = '22023'; end if;
 if v_basis = 'salary' and v_rate < 1000 then raise exception 'That annual salary looks too low. Check the pay basis.' using errcode = '22023'; end if;
 if v_schedule_raw !~ '^[0-9a-fA-F-]{36}$' then raise exception 'Choose the pay schedule.' using errcode = '22023'; end if;
 v_schedule := v_schedule_raw::uuid;
 if not exists (select 1 from hr.pay_schedules s where s.id = v_schedule and s.is_active) then raise exception 'Choose an active pay schedule.' using errcode = '22023'; end if;
 if v_hours_raw = '' then
  if v_type <> 'contract' then raise exception 'Enter the hours per week.' using errcode = '22023'; end if;
 else
  if v_hours_raw !~ '^\d{1,2}(\.\d{1,2})?$' then raise exception 'Enter the hours per week as a number, for example 38.' using errcode = '22023'; end if;
  v_hours := v_hours_raw::numeric;
  if v_hours <= 0 or v_hours > 80 then raise exception 'The hours per week must be between 1 and 80.' using errcode = '22023'; end if;
 end if;

 -- The employment record and the pay setup are written by their own functions (location, manager and schedule rules live there).
 perform public.hr_admin_staff_employment_save(p.id, jsonb_build_object('jobTitle', v_title, 'employmentType', v_type, 'department', coalesce(p_details->>'department', ''),
  'locationId', v_location_raw, 'workLocation', coalesce(p_details->>'workLocation', ''), 'managerId', coalesce(p_details->>'managerId', '')));
 update hr.employment set joining_date = v_start, pay_details_at = now(), pay_details_by = v_admin where profile_id = p.id;
 perform public.hr_admin_employee_pay_save(p.id, jsonb_build_object('payScheduleId', v_schedule, 'payBasis', v_basis, 'rate', v_rate,
  'ordinaryHoursWeek', coalesce(v_hours::text, ''), 'award', coalesce(p_details->>'award', ''), 'xeroEmployeeId', coalesce(p_details->>'xeroEmployeeId', ''))
  || case when jsonb_typeof(p_details->'usualWorkDays') = 'array' and jsonb_array_length(p_details->'usualWorkDays') > 0 then jsonb_build_object('usualWorkDays', p_details->'usualWorkDays') else '{}'::jsonb end);
 perform hr.audit_log(p.id, 'pay_details_added', jsonb_build_object('jobTitle', v_title, 'employmentType', v_type, 'startDate', v_start, 'payBasis', v_basis));
 return public.hr_admin_onboarding(p.id);
end $fn$;

-- ------------------------------------------------------------------ 3. what the record shows: location id, pay type (the schedule's frequency)
create or replace function hr.employment_json(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('department', e.department, 'jobTitle', e.job_title, 'employmentType', e.employment_type, 'joiningDate', e.joining_date,
  'managerId', e.manager_id, 'managerName', (select hr.staff_name(m) from hr.staff_profiles m where m.id = e.manager_id), 'workLocation', e.work_location,
  'locationId', e.location_id, 'payType', (select s.frequency from hr.employee_pay ep join hr.pay_schedules s on s.id = ep.pay_schedule_id where ep.profile_id = e.profile_id),
  'candidateId', e.application_id, 'since', e.created_at)
 from hr.employment e where e.profile_id = p_profile;
$fn$;

create or replace function hr.onboarding_pay_json(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select jsonb_build_object('employment', hr.employment_json(p_profile), 'pay', hr.employee_pay_json(p_profile),
  'completedAt', (select e.pay_details_at from hr.employment e where e.profile_id = p_profile),
  'schedules', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'frequency', s.frequency) order by s.name) from hr.pay_schedules s where s.is_active), '[]'::jsonb),
  'locations', hr.locations_json(true));
$fn$;

-- The wizard shows the person their role as HR recorded it (read-only there).
create or replace function hr.staff_applicant_view(i hr.staff_invites) returns jsonb
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare p hr.staff_profiles;
begin
 select * into p from hr.staff_profiles where id = i.profile_id;
 return jsonb_build_object(
  'profile', to_jsonb(p) - 'auth_user_id' - 'id' - 'status_changed_at' - 'created_at' - 'updated_at',
  'status', p.status,
  'mode', i.purpose,
  'readOnly', i.used_at is not null or p.status <> 'invited',
  'expiresAt', i.expires_at,
  'documents', coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.category, d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'requiredCategories', to_jsonb(hr.staff_required_categories(p.is_australian_citizen)),
  'summary', hr.staff_doc_summary(p.id),
  'bank', hr.bank_view(p.id, false),
  'employment', (select jsonb_build_object('jobTitle', e.job_title, 'workLocation', e.work_location, 'employmentType', e.employment_type, 'joiningDate', e.joining_date,
    'payType', (select s.frequency from hr.employee_pay ep join hr.pay_schedules s on s.id = ep.pay_schedule_id where ep.profile_id = e.profile_id))
    from hr.employment e where e.profile_id = p.id));
end $fn$;

-- Staff > Employees (active / inactive people): the login state and the employment record beside the person.
create or replace function hr.emp_json(p hr.staff_profiles) returns jsonb
language sql stable security definer set search_path = '' as $fn$
 select jsonb_build_object('id', p.id, 'firstName', p.first_name, 'lastName', p.last_name, 'email', p.email, 'phone', p.phone_e164,
  'status', p.status, 'createdAt', p.created_at, 'statusChangedAt', p.status_changed_at, 'hasLogin', p.auth_user_id is not null,
  'passwordSet', exists (select 1 from auth.users u where u.id = p.auth_user_id and u.email_confirmed_at is not null),
  'documents', (select count(*) from hr.staff_documents d where d.profile_id = p.id and d.is_current),
  'employment', hr.employment_json(p.id));
$fn$;

-- ------------------------------------------------------------------ 4. letter variables
-- The names the owner asked for beside the existing ones: {{employee_full_name}} {{employee_email}} {{job_title}} {{job_location}}
-- {{job_type}} {{pay_type}} {{today_date}} (the renderer maps them from the same person values; pay_type is the schedule's frequency).
create or replace function hr.template_placeholders(p_type text) returns text[]
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select array['first_name','last_name','full_name','email','position','department','employment_type','start_date','pay_rate','pay_basis',
  'pay_schedule','hours_per_week','manager_name','work_location','company_name','today','login_url',
  'employee_full_name','employee_email','job_title','job_location','job_type','pay_type','today_date']
  || case when p_type in ('offer_email', 'welcome_login') then array['signing_link', 'link_expiry'] else array[]::text[] end
  || case when p_type in ('document_request', 'document_reupload') then array['document_link', 'link_expiry'] else array[]::text[] end
  || case when p_type = 'document_reupload' then array['rejected_documents'] else array[]::text[] end;
$fn$;

create or replace function hr.template_values(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, public, pg_temp as $fn$
 select jsonb_build_object('firstName', p.first_name, 'lastName', p.last_name, 'fullName', btrim(concat_ws(' ', p.first_name, p.last_name)), 'email', p.email,
  'position', e.job_title, 'department', e.department, 'employmentType', e.employment_type, 'startDate', e.joining_date,
  'payRate', ep.rate, 'payBasis', ep.pay_basis, 'paySchedule', (select s.name from hr.pay_schedules s where s.id = ep.pay_schedule_id),
  'payType', (select s.frequency from hr.pay_schedules s where s.id = ep.pay_schedule_id),
  'hoursPerWeek', case when e.profile_id is not null then hr.employee_ordinary_hours_week(p.id) end,
  'managerName', (select hr.staff_name(m) from hr.staff_profiles m where m.id = e.manager_id), 'workLocation', e.work_location,
  'companyName', coalesce((select nullif(btrim(c.name), '') from public.cms_settings c limit 1), 'Skyline Institute of Technology'),
  'today', (now() at time zone coalesce((select s.timezone from hr.settings s limit 1), 'Australia/Melbourne'))::date)
 from hr.staff_profiles p left join hr.employment e on e.profile_id = p.id left join hr.employee_pay ep on ep.profile_id = p.id
 where p.id = p_profile;
$fn$;

-- ------------------------------------------------------------------ 5. a sign-in link for an existing (Active) employee
-- Staff > Employees > "Send sign-in link": the login for the person's email (found or just created by staff-admin, unconfirmed and
-- without a password anyone knows) is linked to the Active profile and, when it was never set up, a one-time set-password link
-- (hash only, 7 days) is recorded; staff-admin mails it. Then My HR (punch in / out, timesheet, leave) opens for them.
create or replace function public.hr_admin_emp_login_invite(p_id uuid, p_auth_user_id uuid, p_account_hash text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; u auth.users; i hr.staff_invites; v_needs boolean;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
 if p.status <> 'active' then raise exception 'A sign-in link is for an active employee. People being onboarded get theirs with the offer.' using errcode = '23514'; end if;
 if p_auth_user_id is null then raise exception 'A login is needed before the link can be sent.' using errcode = '22023'; end if;
 if p_auth_user_id = v_admin then raise exception 'You cannot send yourself a sign-in link.' using errcode = '42501'; end if;
 select * into u from auth.users where id = p_auth_user_id;
 if not found or lower(btrim(coalesce(u.email, ''))) <> p.email then raise exception 'That login does not belong to this person.' using errcode = '42501'; end if;
 if p.auth_user_id is not null and p.auth_user_id <> p_auth_user_id then raise exception 'This person is already linked to a different login.' using errcode = '23505'; end if;
 if exists (select 1 from hr.staff_profiles s where s.auth_user_id = p_auth_user_id and s.id <> p.id) then raise exception 'That login already belongs to another staff member.' using errcode = '23505'; end if;
 v_needs := u.email_confirmed_at is null;
 if v_needs and (p_account_hash is null or p_account_hash !~ '^[0-9a-f]{64}$') then raise exception 'A sign-in link is needed for this person.' using errcode = '22023'; end if;
 update hr.staff_profiles set auth_user_id = p_auth_user_id where id = p.id and auth_user_id is distinct from p_auth_user_id;
 if v_needs then i := hr.account_invite_create(p.id, p_account_hash, v_admin); end if;
 perform hr.audit_log(p.id, 'login_invited', jsonb_build_object('needsPassword', v_needs));
 return jsonb_build_object('profileId', p.id, 'email', p.email, 'name', hr.staff_name(p), 'needsPassword', v_needs,
  'invite', case when v_needs then hr.invite_json(i) end, 'expiresAt', case when v_needs then i.expires_at end);
end $fn$;
revoke all on function public.hr_admin_emp_login_invite(uuid, uuid, text) from public, anon;
grant execute on function public.hr_admin_emp_login_invite(uuid, uuid, text) to authenticated;

-- The set-password link and "Resend login" now serve an Active person too.
create or replace function public.hr_admin_onboarding_login_resend(p_id uuid, p_account_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; u auth.users; i hr.staff_invites;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('offer_sent', 'offer_signed', 'active') or p.auth_user_id is null then raise exception 'A sign-in link is sent with the offer letter.' using errcode = '23514'; end if;
 select * into u from auth.users where id = p.auth_user_id;
 if not found then raise exception 'The login for this person no longer exists. Withdraw the offer and send it again.' using errcode = 'P0002'; end if;
 if u.email_confirmed_at is not null then
  raise exception 'This person has already chosen a password. They can use "Forgot password" on the login page.' using errcode = '23514'; end if;
 i := hr.account_invite_create(p.id, p_account_hash, v_admin);
 return jsonb_build_object('profileId', p.id, 'email', p.email, 'name', hr.staff_name(p), 'invite', hr.invite_json(i), 'expiresAt', i.expires_at);
end $fn$;

create or replace function public.hr_svc_account_open(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles;
begin
 i := hr.invite_resolve(p_token_hash, array['account']);
 select * into p from hr.staff_profiles where id = i.profile_id;
 if i.used_at is not null or p.auth_user_id is null or p.status not in ('offer_sent', 'offer_signed', 'active') then
  raise exception 'This link is not valid any more. Ask us for a new one.' using errcode = '28000'; end if;
 return jsonb_build_object('name', hr.staff_name(p), 'firstName', p.first_name, 'email', p.email, 'expiresAt', i.expires_at, 'authUserId', p.auth_user_id, 'status', p.status);
end $fn$;

create or replace function public.hr_svc_account_done(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles;
begin
 i := hr.invite_resolve(p_token_hash, array['account']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 if i.used_at is not null or p.auth_user_id is null or p.status not in ('offer_sent', 'offer_signed', 'active') then
  raise exception 'This link is not valid any more. Ask us for a new one.' using errcode = '28000'; end if;
 perform set_config('hr.actor', p.auth_user_id::text, true); perform set_config('hr.actor_kind', 'applicant', true);
 update hr.staff_invites set used_at = now() where id = i.id;
 return jsonb_build_object('ok', true, 'email', p.email, 'status', p.status);
end $fn$;

-- ------------------------------------------------------------------ 6. the employee's "today" is the HR timezone's, not UTC's
create or replace function public.hr_my_timesheet(p_period uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.require_me(); ep hr.employee_pay; p hr.pay_periods; v_today date := hr.local_date(now());
begin
 select * into ep from hr.employee_pay where profile_id = v_me;
 if ep.pay_schedule_id is null then return jsonb_build_object('profileId', v_me, 'hasPaySetup', false, 'periods', '[]'::jsonb, 'period', null, 'summary', null, 'timezone', hr.tz()); end if;
 if p_period is not null then
  select * into p from hr.pay_periods where id = p_period and schedule_id = ep.pay_schedule_id;
  if not found then raise exception 'Pay period not found.' using errcode = 'P0002'; end if;
 else select * into p from hr.pay_periods where schedule_id = ep.pay_schedule_id and v_today between start_date and end_date; end if;
 if p.id is null then select * into p from hr.pay_periods where schedule_id = ep.pay_schedule_id and start_date <= v_today order by start_date desc limit 1; end if;
 return jsonb_build_object('profileId', v_me, 'hasPaySetup', true, 'timezone', hr.tz(), 'today', v_today,
  'periods', coalesce((select jsonb_agg(hr.period_json(x) order by x.start_date desc) from hr.pay_periods x where x.schedule_id = ep.pay_schedule_id
    and x.end_date >= v_today - 190 and x.start_date <= v_today + 35), '[]'::jsonb),
  'period', case when p.id is null then null else hr.period_json(p) end,
  'summary', case when p.id is null then null else hr.period_summary(p.id, v_me) end);
end $fn$;

create or replace function public.hr_my_team() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_me uuid := hr.me_profile(); v_admin boolean := hr.is_admin(); v_today date := hr.local_date(now());
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 return jsonb_build_object('isAdmin', v_admin, 'profileId', v_me, 'today', v_today,
  'isManager', exists (select 1 from hr.employment e where e.manager_id = v_me),
  'reports', coalesce((select jsonb_agg(jsonb_build_object('profileId', e.profile_id, 'name', hr.staff_name(sp), 'jobTitle', e.job_title, 'status', sp.status,
    'payScheduleId', (select ep.pay_schedule_id from hr.employee_pay ep where ep.profile_id = e.profile_id)) order by hr.staff_name(sp))
    from hr.employment e join hr.staff_profiles sp on sp.id = e.profile_id where (v_admin and sp.status = 'active') or e.manager_id = v_me), '[]'::jsonb),
  'schedules', coalesce((select jsonb_agg(hr.schedule_json(s) || jsonb_build_object('periods', coalesce((select jsonb_agg(hr.period_json(p) order by p.start_date desc)
    from hr.pay_periods p where p.schedule_id = s.id and p.end_date >= v_today - 190 and p.start_date <= v_today + 35), '[]'::jsonb)) order by s.name)
    from hr.pay_schedules s where s.is_active), '[]'::jsonb),
  'pendingLeave', (select count(*) from hr.leave_requests r where r.status = 'pending' and (v_admin or exists (select 1 from hr.employment e where e.profile_id = r.profile_id and e.manager_id = v_me))));
end $fn$;

-- ------------------------------------------------------------------ 7. menu: HRMS > Locations
do $menu$
declare v_item public.admin_menu_items;
begin
 select * into v_item from public.admin_menu_items where id = 'staff_pay_schedules';
 alter table public.admin_menu_items disable trigger protect_admin_menu;
 insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, is_enabled, permission_key, permission_scope, is_system) values
  ('staff_locations', 'staff', 'Locations', '/admin/staff/locations', 'institution', 65, true, coalesce(v_item.permission_key, 'cms.admin'), coalesce(v_item.permission_scope, 'current'), true)
 on conflict (id) do update set parent_id = 'staff', label = excluded.label, route = excluded.route, icon_key = excluded.icon_key, sort_order = excluded.sort_order, is_enabled = true;
 alter table public.admin_menu_items enable trigger protect_admin_menu;
end $menu$;

commit;
