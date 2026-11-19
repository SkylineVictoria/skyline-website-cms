-- BUSINESS-RULES-LIVE: HR. Every hrms.* reference entry in Business Rules (except hrms.pay_period_topup_schedule, which has its
-- own change) becomes a live setting at today's value, so nothing changes on the day. The database reads them through
-- public.rule_* (batch 1); the screens through src/lib/hrRules.ts; staff-register and staff-admin through
-- _shared/business-rules.ts.
-- Entries that described behaviour in words become real choices (the first value = today's behaviour):
--   hrms.staff_onboarding_workflow       one allowed move per line ("Applied → Invited"), checked against the list of possible
--                                          moves; moves to Active / Inactive stay with the activate / deactivate actions
--   hrms.staff_retention_eligibility     delete a rejected applicant's files after the retention period, or never
--   hrms.staff_multiple_academic_documents several academic records, or one (was Yes / No)
--   hrms.staff_weekly_hours_required     required except for contractors, required for everyone, or optional (was Yes / No)
-- hrms.default_ordinary_hours, hrms.open_shift_flag_hours, hrms.usual_workdays and hrms.breaks_paid_default are the starting
-- values of HRMS › Settings (column defaults of hr.settings); the values in use stay those saved on HRMS › Settings.
begin;

-- A Yes / No entry that becomes a choice of words: the value type changes with it (registration and reference version).
create or replace function pg_temp.hr_rule_as_text(p_id text) returns void language sql as $$
  update public.business_rules set registration = registration || '{"value_type":"text"}'::jsonb
   where scope_key = '' and identifier = p_id and registration->>'handler' = 'inventory_only';
  update public.business_rule_versions v set definition = v.definition || '{"value_type":"text"}'::jsonb
    from public.business_rules r
   where r.id = v.rule_id and r.scope_key = '' and r.identifier = p_id and v.state = 'reference' and r.registration->>'handler' = 'inventory_only';
$$;

-- 1. HRMS › Settings starting values (hr.settings column defaults; the table's checks: hours 0-80, open shift 1-48 h).
select public.business_rule_go_live('hrms.default_ordinary_hours', '{"min":1,"max":80}');
select public.business_rule_go_live('hrms.open_shift_flag_hours', '{"min":1,"max":48}');
select public.business_rule_go_live('hrms.breaks_paid_default');
select public.business_rule_go_live('hrms.usual_workdays', '{"allowed":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]}');

-- Weekday names -> ISO day numbers (Monday 1 ... Sunday 7) as hr.settings stores them; never empty.
create or replace function hr.rule_usual_work_days() returns smallint[]
language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select coalesce(nullif(array(
    select distinct (array_position(array['monday','tuesday','wednesday','thursday','friday','saturday','sunday'], lower(btrim(d))))::smallint
      from jsonb_array_elements_text(case when jsonb_typeof(v) = 'array' then v else '[]'::jsonb end) d
     where array_position(array['monday','tuesday','wednesday','thursday','friday','saturday','sunday'], lower(btrim(d))) is not null
     order by 1), '{}'::smallint[]), '{1,2,3,4,5}'::smallint[])
    from (select public.rule_json('hrms.usual_workdays', '["Monday","Tuesday","Wednesday","Thursday","Friday"]'::jsonb) v) x;
$$;
alter table hr.settings alter column ordinary_hours_week set default public.rule_num('hrms.default_ordinary_hours', 38);
alter table hr.settings alter column open_shift_flag_hours set default public.rule_int('hrms.open_shift_flag_hours', 14);
alter table hr.settings alter column breaks_paid set default public.rule_bool('hrms.breaks_paid_default', false);
alter table hr.settings alter column usual_work_days set default hr.rule_usual_work_days();

-- 2. Holidays and pay periods.
select public.business_rule_go_live('hrms.optional_holiday_unconfigured_allowance', '{"min":0,"max":30}');
select public.business_rule_patch_function('hr.optional_rule(integer)'::regprocedure,
  $o$where r.year = p_year), 0)$o$,
  $n$where r.year = p_year), public.rule_int('hrms.optional_holiday_unconfigured_allowance', 0))$n$);

select public.business_rule_go_live('hrms.pay_period_future_horizon_months', '{"min":1,"max":60}');
select public.business_rule_patch_function('hr.pay_periods_generate(uuid, date)'::regprocedure,
  $o$(current_date + interval '12 months')::date$o$,
  $n$(current_date + make_interval(months => public.rule_int('hrms.pay_period_future_horizon_months', 12)))::date$n$);

-- 3. Careers: cover letter text and attachments (the table checks allow at most 5000 characters and 5 MB, so only lower).
select public.business_rule_go_live('hrms.cover_letter_limit_chars', '{"min":100,"max":5000}');
select public.business_rule_go_live('hrms.job_attachment_limit_mib', '{"min":1,"max":5}');
select public.business_rule_patch_function('public.hr_svc_apply(text, text, text, text, uuid, text)'::regprocedure,
  $o$char_length(v_letter) > 5000$o$,
  $n$char_length(v_letter) > public.rule_int('hrms.cover_letter_limit_chars', 5000)$n$);
select public.business_rule_patch_function('public.hr_admin_candidate_save(uuid, uuid, jsonb, text, text)'::regprocedure,
  $o$left(btrim(coalesce(p_cover_letter, '')), 5000)$o$,
  $n$left(btrim(coalesce(p_cover_letter, '')), public.rule_int('hrms.cover_letter_limit_chars', 5000))$n$);
select public.business_rule_patch_function('public.hr_svc_apply_resume(uuid, text, text, text, integer)'::regprocedure,
  $o$p_size > 5242880 then raise exception 'The resume must be 5 MB or smaller.'$o$,
  $n$p_size > public.rule_int('hrms.job_attachment_limit_mib', 5) * 1048576 then raise exception 'The resume must be % MB or smaller.', public.rule_int('hrms.job_attachment_limit_mib', 5)$n$);
select public.business_rule_patch_function('public.hr_svc_job_cover_letter(uuid, text, text, text, integer)'::regprocedure,
  $o$p_size > 5242880 then raise exception 'The cover letter must be 5 MB or smaller.'$o$,
  $n$p_size > public.rule_int('hrms.job_attachment_limit_mib', 5) * 1048576 then raise exception 'The cover letter must be % MB or smaller.', public.rule_int('hrms.job_attachment_limit_mib', 5)$n$);
select public.business_rule_patch_function('public.hr_admin_candidate_file(uuid, text, text, text, text, integer)'::regprocedure,
  $o$p_size > 5242880 then raise exception 'The file must be 5 MB or smaller.'$o$,
  $n$p_size > public.rule_int('hrms.job_attachment_limit_mib', 5) * 1048576 then raise exception 'The file must be % MB or smaller.', public.rule_int('hrms.job_attachment_limit_mib', 5)$n$);

-- 4. Employee documents added by HR (staff-documents bucket: 10 MB at most).
select public.business_rule_go_live('hrms.employee_document_max_bytes', '{"min":1048576,"max":10485760}');
select public.business_rule_patch_function('public.hr_admin_emp_doc_add(uuid, text, text, text, text, integer)'::regprocedure,
  $o$p_size > 10485760 then raise exception 'The file must be 10 MB or smaller.'$o$,
  $n$p_size > public.rule_int('hrms.employee_document_max_bytes', 10485760) then raise exception 'The file must be % MB or smaller.', trim_scale(round(public.rule_int('hrms.employee_document_max_bytes', 10485760) / 1048576.0, 1))$n$);

-- 5. Onboarding documents: which types are required, which take an expiry date, several academic records.
select public.business_rule_go_live('hrms.applicant_document_checklist', '{"keys":["citizen","other"]}');
select public.business_rule_go_live('hrms.staff_document_expiry_rules', '{"keys":["required","optional","none"]}');
select pg_temp.hr_rule_as_text('hrms.staff_multiple_academic_documents');
select public.business_rule_go_live_as('hrms.staff_multiple_academic_documents',
  '{"allowed":["Several academic records allowed","One academic record only"]}', '"Several academic records allowed"');

-- A list read from a rule, used only when every entry is a known document type (otherwise the old list).
create or replace function hr.staff_doc_rule_list(p_rule text, p_part text, p_default text[]) returns text[]
language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select case when jsonb_typeof(v) = 'array'
      and not exists (select 1 from jsonb_array_elements(v) e
                       where jsonb_typeof(e) <> 'string' or (e #>> '{}') not in ('Passport','Visa','English','Academic','Driving Licence','Health Insurance'))
    then array(select e from jsonb_array_elements_text(v) with ordinality t(e, i) group by e order by min(i))
    else p_default end
    from (select public.rule_json(p_rule, '{}'::jsonb) -> p_part v) x;
$$;

create or replace function hr.staff_required_categories(p_citizen boolean)
 returns text[] language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select case when p_citizen is true
    then hr.staff_doc_rule_list('hrms.applicant_document_checklist', 'citizen', array['Passport','Academic','Health Insurance'])
    else hr.staff_doc_rule_list('hrms.applicant_document_checklist', 'other', array['Passport','Visa','English','Academic','Health Insurance']) end;
$$;
create or replace function hr.staff_doc_needs_expiry(p_category text)
 returns boolean language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select p_category = any(hr.staff_doc_rule_list('hrms.staff_document_expiry_rules', 'required', array['Passport','Visa','Driving Licence','Health Insurance']));
$$;
create or replace function hr.staff_doc_takes_expiry(p_category text)
 returns boolean language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select hr.staff_doc_needs_expiry(p_category)
      or p_category = any(hr.staff_doc_rule_list('hrms.staff_document_expiry_rules', 'optional', array['English']));
$$;
select public.business_rule_patch_function('hr.check_staff_expiry(text, date)'::regprocedure, $o$ IMMUTABLE$o$, $n$ STABLE$n$);

create or replace function hr.staff_doc_allows_many(p_category text)
 returns boolean language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select p_category = 'Academic'
     and public.rule_text('hrms.staff_multiple_academic_documents', 'Several academic records allowed') <> 'One academic record only';
$$;
select public.business_rule_patch_function('public.hr_svc_document_add(text, text, text, text, text, integer, date, uuid)'::regprocedure,
  $o$if p_category = 'Academic' then$o$, $n$if hr.staff_doc_allows_many(p_category) then$n$);
select public.business_rule_patch_function('public.hr_staff_document_add(text, text, text, text, integer, date, uuid)'::regprocedure,
  $o$if p_category = 'Academic' then$o$, $n$if hr.staff_doc_allows_many(p_category) then$n$);
select public.business_rule_patch_function('public.hr_svc_upload_target(text, text, uuid)'::regprocedure,
  $o$if p_category = 'Academic' and p_replaces is null then$o$, $n$if hr.staff_doc_allows_many(p_category) and p_replaces is null then$n$);

-- 6. Staff status moves. The rule lists one move per line; Business Rules accepts only lines from the list of possible moves,
-- and a list that cannot be read falls back to today's moves. Moving to Active or Inactive stays with the activate /
-- deactivate actions (they decide when), as before.
create or replace function hr.staff_workflow_default() returns jsonb
language sql immutable set search_path to 'pg_catalog', 'pg_temp' as $$
  select '["Applied → Invited","Applied → Rejected","Invited → Documents submitted","Invited → Rejected",
    "Documents submitted → Invited","Documents submitted → Offer sent","Documents submitted → Offer signed","Documents submitted → Rejected",
    "Offer sent → Offer signed","Offer sent → Documents submitted","Offer sent → Rejected","Offer signed → Rejected",
    "Rejected → Applied","Inactive → Applied"]'::jsonb;
$$;
create or replace function hr.staff_status_key(p_label text) returns text
language sql immutable set search_path to 'pg_catalog', 'pg_temp' as $$
  select case when k in ('applied','invited','documents_submitted','offer_sent','offer_signed','active','rejected','inactive') then k end
    from (select replace(lower(btrim(coalesce(p_label, ''))), ' ', '_') k) x;
$$;
create or replace function hr.staff_workflow_moves() returns table(from_status text, to_status text)
language plpgsql stable set search_path to 'pg_catalog', 'pg_temp' as $$
declare v jsonb := public.rule_json('hrms.staff_onboarding_workflow', hr.staff_workflow_default()); x jsonb; a text; b text;
begin
  if jsonb_typeof(v) is distinct from 'array' then v := hr.staff_workflow_default(); end if;
  for x in select e from jsonb_array_elements(v) e loop
    a := hr.staff_status_key(split_part(x #>> '{}', '→', 1)); b := hr.staff_status_key(split_part(x #>> '{}', '→', 2));
    if jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[^→]+→[^→]+$' or a is null or b is null or a = b or b in ('active', 'inactive') then
      v := hr.staff_workflow_default(); exit;
    end if;
  end loop;
  return query select hr.staff_status_key(split_part(e, '→', 1)), hr.staff_status_key(split_part(e, '→', 2)) from jsonb_array_elements_text(v) e;
end $$;
create or replace function hr.staff_transition_allowed(p_from text, p_to text)
 returns boolean language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select p_to in ('active', 'inactive') or exists (select 1 from hr.staff_workflow_moves() m where m.from_status = p_from and m.to_status = p_to);
$$;
select public.business_rule_go_live_as('hrms.staff_onboarding_workflow',
  jsonb_build_object('allowed', (select jsonb_agg(f || ' → ' || t order by fi, ti)
    from unnest(array['Applied','Invited','Documents submitted','Offer sent','Offer signed','Active','Rejected','Inactive']) with ordinality a(f, fi),
         unnest(array['Applied','Invited','Documents submitted','Offer sent','Offer signed','Rejected']) with ordinality b(t, ti)
   where f <> t)),
  hr.staff_workflow_default());

-- 7. Pay details (HR › onboarding) and the joining date on activation.
select public.business_rule_go_live('hrms.staff_pay_start_date_range', '{"keys":["pastDays","futureDays"]}');
select public.business_rule_go_live('hrms.staff_pay_validation_bounds', '{"keys":["maximumHourly","minimumAnnual"]}');
select public.business_rule_go_live('hrms.staff_weekly_hours_cap', '{"min":1,"max":80}');
select pg_temp.hr_rule_as_text('hrms.staff_weekly_hours_required');
select public.business_rule_go_live_as('hrms.staff_weekly_hours_required',
  '{"allowed":["Required except for contractors","Required for everyone","Optional for everyone"]}', '"Required except for contractors"');

create or replace function hr.staff_pay_start_days(p_part text) returns integer
language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select case when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric between 0 and 3650 then round((v #>> '{}')::numeric)::integer
    when p_part = 'pastDays' then 365 else 730 end
    from (select public.rule_json('hrms.staff_pay_start_date_range', '{"pastDays":365,"futureDays":730}'::jsonb) -> p_part v) x;
$$;
create or replace function hr.staff_pay_start_message() returns text
language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select case when hr.staff_pay_start_days('pastDays') = 365 and hr.staff_pay_start_days('futureDays') = 730
    then 'The start date must be within the last year or the next two years.'
    else format('The start date must be within the last %s days or the next %s days.', hr.staff_pay_start_days('pastDays'), hr.staff_pay_start_days('futureDays')) end;
$$;
create or replace function hr.staff_pay_bound(p_part text) returns numeric
language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select case when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric > 0 then (v #>> '{}')::numeric else 1000 end
    from (select public.rule_json('hrms.staff_pay_validation_bounds', '{"maximumHourly":1000,"minimumAnnual":1000}'::jsonb) -> p_part v) x;
$$;
create or replace function hr.staff_weekly_hours_required(p_type text) returns boolean
language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select case public.rule_text('hrms.staff_weekly_hours_required', 'Required except for contractors')
    when 'Required for everyone' then true when 'Optional for everyone' then false else p_type is distinct from 'contract' end;
$$;

select public.business_rule_patch_function('public.hr_admin_onboarding_pay_save(uuid, jsonb)'::regprocedure,
  $o$if v_start < current_date - 365 or v_start > current_date + 730 then raise exception 'The start date must be within the last year or the next two years.' using errcode = '22023'; end if;$o$,
  $n$if v_start < current_date - hr.staff_pay_start_days('pastDays') or v_start > current_date + hr.staff_pay_start_days('futureDays') then raise exception '%', hr.staff_pay_start_message() using errcode = '22023'; end if;$n$);
select public.business_rule_patch_function('public.hr_admin_onboarding_pay_save(uuid, jsonb)'::regprocedure,
  $o$if v_basis = 'hourly' and v_rate > 1000 then$o$, $n$if v_basis = 'hourly' and v_rate > hr.staff_pay_bound('maximumHourly') then$n$);
select public.business_rule_patch_function('public.hr_admin_onboarding_pay_save(uuid, jsonb)'::regprocedure,
  $o$if v_basis = 'salary' and v_rate < 1000 then$o$, $n$if v_basis = 'salary' and v_rate < hr.staff_pay_bound('minimumAnnual') then$n$);
select public.business_rule_patch_function('public.hr_admin_onboarding_pay_save(uuid, jsonb)'::regprocedure,
  $o$if v_type <> 'contract' then raise exception 'Enter the hours per week.'$o$,
  $n$if hr.staff_weekly_hours_required(v_type) then raise exception 'Enter the hours per week.'$n$);
select public.business_rule_patch_function('public.hr_admin_onboarding_pay_save(uuid, jsonb)'::regprocedure,
  $o$if v_hours <= 0 or v_hours > 80 then raise exception 'The hours per week must be between 1 and 80.' using errcode = '22023';$o$,
  $n$if v_hours <= 0 or v_hours > public.rule_num('hrms.staff_weekly_hours_cap', 80) then raise exception 'The hours per week must be between 1 and %.', public.rule_num('hrms.staff_weekly_hours_cap', 80) using errcode = '22023';$n$);
select public.business_rule_patch_function('hr.onboarding_pay_problem(uuid)'::regprocedure,
  $o$e.employment_type <> 'contract' and ep.ordinary_hours_week is null$o$,
  $n$hr.staff_weekly_hours_required(e.employment_type) and ep.ordinary_hours_week is null$n$);
select public.business_rule_patch_function('public.hr_admin_staff_activate_account(uuid, text, date, uuid, boolean)'::regprocedure,
  $o$p_joining_date < current_date - 365 or p_joining_date > current_date + 730$o$,
  $n$p_joining_date < current_date - hr.staff_pay_start_days('pastDays') or p_joining_date > current_date + hr.staff_pay_start_days('futureDays')$n$);

-- 8. Retention of a rejected applicant's files. The period is EF_HR_RETENTION_MONTHS when set on staff-admin, otherwise
-- hrms.onboarding_file_retention_fallback (read by staff-admin); whether files are deleted at all is the eligibility choice.
select public.business_rule_go_live('hrms.onboarding_file_retention_fallback', '{"min":1,"max":120}');
select public.business_rule_go_live('hrms.staff_retention_eligibility',
  '{"allowed":["Rejected application with files still present and rejection older than the configured retention period","Do not delete files automatically"]}');
create or replace function hr.staff_retention_purge_on() returns boolean
language sql stable set search_path to 'pg_catalog', 'pg_temp' as $$
  select public.rule_text('hrms.staff_retention_eligibility', 'Rejected application with files still present and rejection older than the configured retention period')
    <> 'Do not delete files automatically';
$$;
select public.business_rule_patch_function('public.hr_svc_retention_due(integer, integer)'::regprocedure,
  $o$p.status = 'rejected' and a.files_purged_at is null$o$, $n$p.status = 'rejected' and a.files_purged_at is null and hr.staff_retention_purge_on()$n$);
select public.business_rule_patch_function('public.hr_svc_retention_mark(uuid, integer)'::regprocedure,
  $o$p.status = 'rejected' and a.files_purged_at is null$o$, $n$p.status = 'rejected' and a.files_purged_at is null and hr.staff_retention_purge_on()$n$);

-- 9. HRMS › Settings follows Business Rules: the four values above are written to hr.settings when a version is published
-- and again at the start of the daily pay-period top-up (so a version with a later start date takes effect). A value that
-- the table refuses is skipped with a warning; publishing never fails because of it. Today the row already holds these
-- values (38, 14, false, Monday-Friday), so nothing changes.
create or replace function hr.settings_rules_sync() returns void
language plpgsql security definer set search_path = '' as $$
declare v jsonb; t text; d smallint[];
begin
  for v, t in select public.business_rule_evaluate('', x.id, '{}'::jsonb), x.id from unnest(array['hrms.default_ordinary_hours',
      'hrms.open_shift_flag_hours', 'hrms.breaks_paid_default', 'hrms.usual_workdays']) x(id) loop
    begin
      if v is null or v = 'null'::jsonb then continue; end if;   -- switched off: leave the row as it is
      if t = 'hrms.default_ordinary_hours' and jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric > 0 and (v #>> '{}')::numeric <= 80 then
        update hr.settings set ordinary_hours_week = (v #>> '{}')::numeric, updated_at = now() where ordinary_hours_week is distinct from (v #>> '{}')::numeric;
      elsif t = 'hrms.open_shift_flag_hours' and jsonb_typeof(v) = 'number' and round((v #>> '{}')::numeric) between 1 and 48 then
        update hr.settings set open_shift_flag_hours = round((v #>> '{}')::numeric)::integer, updated_at = now()
         where open_shift_flag_hours is distinct from round((v #>> '{}')::numeric)::integer;
      elsif t = 'hrms.breaks_paid_default' and jsonb_typeof(v) = 'boolean' then
        update hr.settings set breaks_paid = (v #>> '{}')::boolean, updated_at = now() where breaks_paid is distinct from (v #>> '{}')::boolean;
      elsif t = 'hrms.usual_workdays' and jsonb_typeof(v) = 'array' then
        d := hr.rule_usual_work_days();
        update hr.settings set usual_work_days = d, updated_at = now() where usual_work_days is distinct from d;
      elsif t <> 'hrms.usual_workdays' then
        raise warning 'Business rule % has a value HRMS settings cannot use; the setting was left unchanged.', t;
      end if;
    exception when others then
      raise warning 'Business rule % could not be written to the HRMS settings: %', t, sqlerrm;
    end;
  end loop;
exception when others then
  raise warning 'HRMS settings could not be synced from Business Rules: %', sqlerrm;
end $$;
revoke all on function hr.settings_rules_sync() from public, anon, authenticated, service_role;

create or replace function hr.business_rule_versions_settings_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.business_rules r where r.id = new.rule_id and r.scope_key = ''
             and r.identifier in ('hrms.default_ordinary_hours', 'hrms.open_shift_flag_hours', 'hrms.breaks_paid_default', 'hrms.usual_workdays')) then
    perform hr.settings_rules_sync();
  end if;
  return null;
exception when others then
  raise warning 'HRMS settings could not be synced from Business Rules: %', sqlerrm;
  return null;
end $$;
revoke all on function hr.business_rule_versions_settings_sync() from public, anon, authenticated, service_role;
drop trigger if exists business_rule_versions_hr_settings_sync on public.business_rule_versions;
create trigger business_rule_versions_hr_settings_sync after insert or update of state, definition on public.business_rule_versions
  for each row when (new.state = 'published') execute function hr.business_rule_versions_settings_sync();

-- The daily job: runs after the top-up schedule sync that 20261121000517 put at the start of hr_pay_periods_topup.
select public.business_rule_patch_function('public.hr_pay_periods_topup()'::regprocedure,
  $o$ perform public.business_rule_cron_daily_sync('hrms.pay_period_topup_schedule', 'hr-pay-periods-topup', '02:30 UTC');
$o$, $n$ perform public.business_rule_cron_daily_sync('hrms.pay_period_topup_schedule', 'hr-pay-periods-topup', '02:30 UTC');
 perform hr.settings_rules_sync();
$n$);
select hr.settings_rules_sync();

-- Nothing must be left behind in HR (the pay-period top-up schedule is made live separately).
do $$ begin
  if exists (select 1 from public.business_rules where scope_key = '' and identifier like 'hrms.%' and identifier <> 'hrms.pay_period_topup_schedule'
              and registration->>'handler' = 'inventory_only') then
    raise exception 'BUSINESS-RULES-LIVE: HR reference entries remain: %',
      (select string_agg(identifier, ', ') from public.business_rules where scope_key = '' and identifier like 'hrms.%'
          and identifier <> 'hrms.pay_period_topup_schedule' and registration->>'handler' = 'inventory_only');
  end if;
end $$;

commit;
