-- BUSINESS-RULES-LIVE: Assessments, Students (placement and study plans) and the pay-period top-up schedule.
-- Every reference entry becomes a live setting at today's value (nothing changes on the day); the code reads it through
-- public.rule_* (batch 1), the screens through src/lib/businessRules.ts. Entries that described behaviour in words
-- become choices (the first choice = today's behaviour):
--   assessment.due_sweep_unsubmitted_only   which attempts stop the due / overdue reminders
--   assessment.due_sweep_schedule           the daily time of the reminder sweep (cron job asm-due-sweep)
--   hrms.pay_period_topup_schedule          the daily time of the pay-period top-up (cron job hr-pay-periods-topup)
--   students.study_plan_late_join           a late joiner takes current units ending, or starting, on / after the join day
--   students.study_plan_future_repetition   missed units go to a repetition with the same study load, or any study load
-- The two schedules are applied to pg_cron when a version is published (trigger below) and again at the start of every
-- run of the job (so a version published with a later start date takes effect at the next run).
begin;

-- 1. Assessment settings: the defaults of a new settings row and the fallbacks used when no row exists.
select public.business_rule_go_live('assessment.attempts_default', '{"min":1,"max":10}');
select public.business_rule_go_live('assessment.reassessment_window_default', '{"min":1,"max":90}');
select public.business_rule_go_live('assessment.due_soon_days', '{"min":1,"max":30}');
select public.business_rule_go_live('assessment.evidence_default_mib', '{"min":1,"max":200}');
select public.business_rule_go_live('assessment.late_submission_default', '{"allowed":["Allow","Block"]}');
select public.business_rule_go_live('assessment.result_rollup_default', '{"allowed":["All satisfactory","Assessor only"]}');
select public.business_rule_go_live('assessment.attempts_allowed_range', '{"keys":["minimum","maximum"]}');

alter table public.asm_settings alter column max_attempts set default public.rule_int('assessment.attempts_default', 3);
alter table public.asm_settings alter column reassessment_days set default public.rule_int('assessment.reassessment_window_default', 5);
alter table public.asm_settings alter column due_soon_days set default public.rule_int('assessment.due_soon_days', 3);
alter table public.asm_settings alter column evidence_max_mb set default public.rule_int('assessment.evidence_default_mib', 25);
alter table public.asm_settings alter column late_submission set default lower(public.rule_text('assessment.late_submission_default', 'Allow'));
alter table public.asm_settings alter column rollup_rule set default replace(lower(public.rule_text('assessment.result_rollup_default', 'All satisfactory')), ' ', '_');

select public.business_rule_patch_function('public.asm_max_attempts(uuid)'::regprocedure,
  $o$->>'max_attempts')::integer, 3)$o$, $n$->>'max_attempts')::integer, public.rule_int('assessment.attempts_default', 3))$n$);
select public.business_rule_patch_function('public.asm_trainer(text, jsonb)'::regprocedure,
  $o$v_max := coalesce((v_set->>'max_attempts')::integer, 3);$o$,
  $n$v_max := coalesce((v_set->>'max_attempts')::integer, public.rule_int('assessment.attempts_default', 3));$n$);
select public.business_rule_patch_function('public.asm_trainer(text, jsonb)'::regprocedure,
  $o$(v_set->>'reassessment_days')::integer, 5)$o$,
  $n$(v_set->>'reassessment_days')::integer, public.rule_int('assessment.reassessment_window_default', 5))$n$, 2);
select public.business_rule_patch_function('public.asm_admin(text, jsonb)'::regprocedure,
  $o$->>'reassessment_days')::integer, 5)$o$,
  $n$->>'reassessment_days')::integer, public.rule_int('assessment.reassessment_window_default', 5))$n$);
select public.business_rule_patch_function('public.asm_rollup(uuid)'::regprocedure,
  $o$s), 'all_satisfactory');$o$,
  $n$s), replace(lower(public.rule_text('assessment.result_rollup_default', 'All satisfactory')), ' ', '_'));$n$);

-- The range an administrator may enter for the maximum attempts (inside the table's own 1 to 10 limit).
create or replace function public.asm_attempts_range(out lo integer, out hi integer)
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.rule_json('assessment.attempts_allowed_range', '{"minimum":1,"maximum":10}'::jsonb);
begin
  lo := case when jsonb_typeof(v->'minimum') = 'number' then round((v->>'minimum')::numeric)::integer else 1 end;
  hi := case when jsonb_typeof(v->'maximum') = 'number' then round((v->>'maximum')::numeric)::integer else 10 end;
  lo := greatest(1, least(10, lo));
  hi := greatest(lo, least(10, hi));
end $$;
grant execute on function public.asm_attempts_range() to authenticated, service_role;

create or replace function public.asm_settings_attempts_range() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  select * into r from public.asm_attempts_range();
  if tg_op = 'INSERT' then
    new.max_attempts := greatest(r.lo, least(r.hi, new.max_attempts));
  elsif new.max_attempts is distinct from old.max_attempts and new.max_attempts not between r.lo and r.hi then
    raise exception 'Maximum attempts must be between % and %.', r.lo, r.hi using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function public.asm_settings_attempts_range() from public, anon, authenticated;
drop trigger if exists asm_settings_attempts_range on public.asm_settings;
create trigger asm_settings_attempts_range before insert or update of max_attempts on public.asm_settings
  for each row execute function public.asm_settings_attempts_range();

create or replace function public.asm_assessment_attempts_range() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if jsonb_typeof(new.settings_override->'max_attempts') = 'number'
     and (tg_op = 'INSERT' or new.settings_override->'max_attempts' is distinct from old.settings_override->'max_attempts') then
    select * into r from public.asm_attempts_range();
    if (new.settings_override->>'max_attempts')::numeric not between r.lo and r.hi then
      raise exception 'Maximum attempts must be between % and %.', r.lo, r.hi using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.asm_assessment_attempts_range() from public, anon, authenticated;
drop trigger if exists asm_assessment_attempts_range on public.asm_assessments;
create trigger asm_assessment_attempts_range before insert or update of settings_override on public.asm_assessments
  for each row execute function public.asm_assessment_attempts_range();

-- Business Rules is where SLIT sets these six values: a published version (or one whose start date has come, picked up
-- at the start of every asm_due_sweep run) is written to every asm_settings row. Labels map to the stored values, the
-- table's checks and the attempts range are respected, and a failure is logged, never raised to the publish.
create or replace function public.asm_settings_rules_sync() returns void
language plpgsql security definer set search_path = '' as $$
declare v jsonb; r record; n integer; t text;
begin
  select * into r from public.asm_attempts_range();
  for v, t in select public.business_rule_evaluate('', x.id, '{}'::jsonb), x.id from unnest(array['assessment.attempts_default',
      'assessment.reassessment_window_default', 'assessment.due_soon_days', 'assessment.evidence_default_mib',
      'assessment.late_submission_default', 'assessment.result_rollup_default']) x(id) loop
    begin
      if v is null or v = 'null'::jsonb then continue; end if;   -- switched off: leave the rows as they are
      if t in ('assessment.late_submission_default', 'assessment.result_rollup_default') then
        if jsonb_typeof(v) <> 'string' then continue; end if;
      elsif jsonb_typeof(v) <> 'number' then continue;
      else n := round((v #>> '{}')::numeric)::integer;
      end if;
      if t = 'assessment.attempts_default' then
        update public.asm_settings set max_attempts = greatest(r.lo, least(r.hi, n)) where max_attempts is distinct from greatest(r.lo, least(r.hi, n));
      elsif t = 'assessment.reassessment_window_default' then
        update public.asm_settings set reassessment_days = greatest(1, least(90, n)) where reassessment_days is distinct from greatest(1, least(90, n));
      elsif t = 'assessment.due_soon_days' then
        update public.asm_settings set due_soon_days = greatest(1, least(30, n)) where due_soon_days is distinct from greatest(1, least(30, n));
      elsif t = 'assessment.evidence_default_mib' then
        update public.asm_settings set evidence_max_mb = greatest(1, least(200, n)) where evidence_max_mb is distinct from greatest(1, least(200, n));
      elsif t = 'assessment.late_submission_default' and lower(v #>> '{}') in ('allow', 'block') then
        update public.asm_settings set late_submission = lower(v #>> '{}') where late_submission is distinct from lower(v #>> '{}');
      elsif t = 'assessment.result_rollup_default' and replace(lower(v #>> '{}'), ' ', '_') in ('all_satisfactory', 'assessor_only') then
        update public.asm_settings set rollup_rule = replace(lower(v #>> '{}'), ' ', '_') where rollup_rule is distinct from replace(lower(v #>> '{}'), ' ', '_');
      end if;
    exception when others then
      raise warning 'Business rule % could not be written to the assessment settings: %', t, sqlerrm;
    end;
  end loop;
exception when others then
  raise warning 'Assessment settings could not be synced from Business Rules: %', sqlerrm;
end $$;
revoke all on function public.asm_settings_rules_sync() from public, anon, authenticated, service_role;

create or replace function public.business_rule_versions_asm_settings_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.business_rules r where r.id = new.rule_id and r.scope_key = ''
             and r.identifier in ('assessment.attempts_default', 'assessment.reassessment_window_default', 'assessment.due_soon_days',
               'assessment.evidence_default_mib', 'assessment.late_submission_default', 'assessment.result_rollup_default',
               'assessment.attempts_allowed_range')) then
    perform public.asm_settings_rules_sync();
  end if;
  return null;
end $$;
revoke all on function public.business_rule_versions_asm_settings_sync() from public, anon, authenticated, service_role;
drop trigger if exists business_rule_versions_asm_settings_sync on public.business_rule_versions;
create trigger business_rule_versions_asm_settings_sync after insert or update of state, definition on public.business_rule_versions
  for each row when (new.state = 'published') execute function public.business_rule_versions_asm_settings_sync();

-- 2. Question defaults in the assessment builder (read by the screen).
select public.business_rule_go_live('assessment.short_response_default_word_cap', '{"min":1,"max":10000}');
select public.business_rule_go_live('assessment.repeat_group_entry_limits', '{"keys":["minEntries","maxEntries"]}');
select public.business_rule_go_live('assessment.evidence_question_defaults', '{"keys":["minFiles","maxFiles","maxMiB","accepted"]}');

-- 3. The daily due-soon / overdue reminder sweep.
select public.business_rule_go_live('assessment.due_sweep_duplicate_notifications');
select public.business_rule_go_live_as('assessment.due_sweep_unsubmitted_only',
  '{"allowed":["Open assignment with no attempt outside Draft or Void","Open assignment with no attempt outside Draft, Void or Returned"]}',
  '"Open assignment with no attempt outside Draft or Void"');

create or replace function public.asm_reminder_ignored_states() returns text[]
language sql stable security definer set search_path = '' as $$
  select case when public.rule_text('assessment.due_sweep_unsubmitted_only', 'Open assignment with no attempt outside Draft or Void')
    = 'Open assignment with no attempt outside Draft, Void or Returned' then array['draft', 'void', 'returned'] else array['draft', 'void'] end;
$$;
revoke all on function public.asm_reminder_ignored_states() from public, anon;
grant execute on function public.asm_reminder_ignored_states() to authenticated, service_role;

select public.business_rule_patch_function('public.asm_due_sweep()'::regprocedure,
  $o$and not exists (select 1 from public.asm_notifications x$o$,
  $n$and (not public.rule_bool('assessment.due_sweep_duplicate_notifications', true) or not exists (select 1 from public.asm_notifications x$n$, 2);
select public.business_rule_patch_function('public.asm_due_sweep()'::regprocedure, $o$x.event = 'overdue')$o$, $n$x.event = 'overdue'))$n$);
select public.business_rule_patch_function('public.asm_due_sweep()'::regprocedure, $o$x.event = 'due_soon')$o$, $n$x.event = 'due_soon'))$n$);
select public.business_rule_patch_function('public.asm_due_sweep()'::regprocedure,
  $o$t.state not in ('draft', 'void')) loop$o$, $n$not t.state = any(public.asm_reminder_ignored_states())) loop$n$);
select public.business_rule_patch_function('public.asm_due_sweep()'::regprocedure,
  $o$->>'due_soon_days')::integer, 3);$o$, $n$->>'due_soon_days')::integer, public.rule_int('assessment.due_soon_days', 3));$n$);

-- 4. Daily cron times: "HH:MM UTC" every quarter hour.
select public.business_rule_go_live_as('assessment.due_sweep_schedule',
  jsonb_build_object('allowed', (select jsonb_agg(to_char(t, 'HH24:MI') || ' UTC' order by t) from generate_series('2000-01-01 00:00'::timestamp, '2000-01-01 23:45'::timestamp, interval '15 minutes') t)),
  '"21:00 UTC"');
select public.business_rule_go_live_as('hrms.pay_period_topup_schedule',
  jsonb_build_object('allowed', (select jsonb_agg(to_char(t, 'HH24:MI') || ' UTC' order by t) from generate_series('2000-01-01 00:00'::timestamp, '2000-01-01 23:45'::timestamp, interval '15 minutes') t)),
  '"02:30 UTC"');

-- Puts the published time of a daily schedule rule on its cron job. Never fails the caller.
create or replace function public.business_rule_cron_daily_sync(p_rule text, p_job text, p_default text) returns void
language plpgsql security definer set search_path = '' as $$
declare v text; s text; j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then return; end if;
  begin v := public.business_rule_evaluate('', p_rule, '{}'::jsonb) #>> '{}'; exception when others then v := null; end;
  if v is null or v !~ '^([01][0-9]|2[0-3]):[0-5][0-9] UTC$' then v := p_default; end if;
  s := substr(v, 4, 2)::integer || ' ' || substr(v, 1, 2)::integer || ' * * *';
  select jobid, schedule into j from cron.job where jobname = p_job;
  if j.jobid is null or j.schedule = s then return; end if;
  perform cron.alter_job(job_id := j.jobid, schedule := s);
exception when others then
  raise warning 'Business rule % could not set the schedule of cron job %: %', p_rule, p_job, sqlerrm;
end $$;
revoke all on function public.business_rule_cron_daily_sync(text, text, text) from public, anon, authenticated, service_role;

create or replace function public.business_rule_cron_daily_sync_all() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.business_rule_cron_daily_sync('assessment.due_sweep_schedule', 'asm-due-sweep', '21:00 UTC');
  perform public.business_rule_cron_daily_sync('hrms.pay_period_topup_schedule', 'hr-pay-periods-topup', '02:30 UTC');
end $$;
revoke all on function public.business_rule_cron_daily_sync_all() from public, anon, authenticated, service_role;

create or replace function public.business_rule_versions_cron_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.business_rules r where r.id = new.rule_id and r.scope_key = ''
             and r.identifier in ('assessment.due_sweep_schedule', 'hrms.pay_period_topup_schedule')) then
    perform public.business_rule_cron_daily_sync_all();
  end if;
  return null;
end $$;
revoke all on function public.business_rule_versions_cron_sync() from public, anon, authenticated, service_role;
drop trigger if exists business_rule_versions_cron_sync on public.business_rule_versions;
create trigger business_rule_versions_cron_sync after insert or update of state, definition on public.business_rule_versions
  for each row when (new.state = 'published') execute function public.business_rule_versions_cron_sync();

select public.business_rule_patch_function('public.asm_due_sweep()'::regprocedure,
  $o$declare r record; n integer := 0; v_days integer;
begin
$o$, $n$declare r record; n integer := 0; v_days integer;
begin
 perform public.business_rule_cron_daily_sync('assessment.due_sweep_schedule', 'asm-due-sweep', '21:00 UTC');
 perform public.asm_settings_rules_sync();
$n$);
select public.business_rule_patch_function('public.hr_pay_periods_topup()'::regprocedure,
  $o$declare r record; v_n integer := 0;
begin
$o$, $n$declare r record; v_n integer := 0;
begin
 perform public.business_rule_cron_daily_sync('hrms.pay_period_topup_schedule', 'hr-pay-periods-topup', '02:30 UTC');
$n$);

-- 5. Students: automatic placement.
select public.business_rule_go_live('students.auto_placement_application_states',
  '{"allowed":["Offer issued","Offer accepted","CoE issued","Enrolled"]}');
select public.business_rule_go_live('students.auto_placement_existing_enrolments',
  '{"allowed":["Active","Deferred","Completed","Withdrawn"]}');
select public.business_rule_go_live('students.auto_placement_manual_removal_override');

-- A list rule of labels as stored keys: "CoE issued" -> coe_issued.
create or replace function public.students_rule_keys(p_id text, p_default text[]) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when jsonb_typeof(s.v) = 'array'
    then array(select regexp_replace(lower(btrim(x)), '[^a-z0-9]+', '_', 'g') from jsonb_array_elements_text(s.v) x)
    else p_default end
  from (select public.rule_value(p_id, null) v) s;
$$;
revoke all on function public.students_rule_keys(text, text[]) from public, anon;
grant execute on function public.students_rule_keys(text, text[]) to authenticated, service_role;

select public.business_rule_patch_function('public.rto_auto_place_one(uuid)'::regprocedure,
  $o$a.status not in ('offer_accepted', 'coe_issued', 'enrolled')$o$,
  $n$not a.status = any(public.students_rule_keys('students.auto_placement_application_states', array['offer_accepted', 'coe_issued', 'enrolled']))$n$);
select public.business_rule_patch_function('public.rto_auto_place_one(uuid)'::regprocedure,
  $o$e.status in ('active', 'deferred', 'completed')) then continue;$o$,
  $n$e.status = any(public.students_rule_keys('students.auto_placement_existing_enrolments', array['active', 'deferred', 'completed']))) then continue;$n$);
select public.business_rule_patch_function('public.rto_auto_place_one(uuid)'::regprocedure,
  $o$  if exists (select 1 from public.rto_placement_overrides o where$o$,
  $n$  if public.rule_bool('students.auto_placement_manual_removal_override', true) and exists (select 1 from public.rto_placement_overrides o where$n$);
select public.business_rule_patch_function('public.rto_application_placement()'::regprocedure,
  $o$new.status in ('offer_accepted', 'coe_issued', 'enrolled')$o$,
  $n$new.status = any(public.students_rule_keys('students.auto_placement_application_states', array['offer_accepted', 'coe_issued', 'enrolled']))$n$);
select public.business_rule_patch_function('public.rto_application_placement()'::regprocedure,
  $o$old.status in ('offer_accepted', 'coe_issued', 'enrolled')$o$,
  $n$old.status = any(public.students_rule_keys('students.auto_placement_application_states', array['offer_accepted', 'coe_issued', 'enrolled']))$n$);
select public.business_rule_patch_function('public.rto_auto_place_sweep()'::regprocedure,
  $o$where status in ('offer_accepted', 'coe_issued', 'enrolled') and student_id$o$,
  $n$where status = any(public.students_rule_keys('students.auto_placement_application_states', array['offer_accepted', 'coe_issued', 'enrolled'])) and student_id$n$);

-- 6. Students: the permanent study plan of an intake (lms_allocation_private.plan_student).
select public.business_rule_go_live('students.study_plan_exclude_completed');
select public.business_rule_go_live('students.study_plan_require_dates');
select public.business_rule_go_live_as('students.study_plan_late_join',
  '{"allowed":["Current units ending on or after the join date, then missed units in a future repetition","Current units starting on or after the join date, then missed units in a future repetition"]}',
  '"Current units ending on or after the join date, then missed units in a future repetition"');
select public.business_rule_go_live_as('students.study_plan_future_repetition',
  '{"allowed":["Complete open repetition of the same course and study load, after the current intake","Complete open repetition of the same course in any study load, after the current intake"]}',
  '"Complete open repetition of the same course and study load, after the current intake"');

select public.business_rule_patch_function('lms_allocation_private.plan_student(uuid, uuid)'::regprocedure,
  $o$not lms_allocation_private.unit_completed(p_student,t.unit_id)$o$,
  $n$(not public.rule_bool('students.study_plan_exclude_completed', true) or not lms_allocation_private.unit_completed(p_student,t.unit_id))$n$);
select public.business_rule_patch_function('lms_allocation_private.plan_student(uuid, uuid)'::regprocedure,
  $o$not lms_allocation_private.unit_completed(p_student,u.id)$o$,
  $n$(not public.rule_bool('students.study_plan_exclude_completed', true) or not lms_allocation_private.unit_completed(p_student,u.id))$n$);
select public.business_rule_patch_function('lms_allocation_private.plan_student(uuid, uuid)'::regprocedure,
  $o$  if not exists(select 1 from public.intake_units where intake_id=p_intake)$o$,
  $n$  if public.rule_bool('students.study_plan_require_dates', true) and (not exists(select 1 from public.intake_units where intake_id=p_intake)$n$);
select public.business_rule_patch_function('lms_allocation_private.plan_student(uuid, uuid)'::regprocedure,
  $o$t.unit_id=u.id)) then$o$, $n$t.unit_id=u.id))) then$n$);
select public.business_rule_patch_function('lms_allocation_private.plan_student(uuid, uuid)'::regprocedure,
  $o$having max(t.end_date)>=joined$o$,
  $n$having case when public.rule_text('students.study_plan_late_join', 'Current units ending on or after the join date, then missed units in a future repetition')
      = 'Current units starting on or after the join date, then missed units in a future repetition' then min(t.start_date)>=joined else max(t.end_date)>=joined end$n$);
select public.business_rule_patch_function('lms_allocation_private.plan_student(uuid, uuid)'::regprocedure,
  $o$where i.course_id=intake.course_id and i.study_load=intake.study_load$o$,
  $n$where i.course_id=intake.course_id and (i.study_load=intake.study_load
      or public.rule_text('students.study_plan_future_repetition', 'Complete open repetition of the same course and study load, after the current intake')
         = 'Complete open repetition of the same course in any study load, after the current intake')$n$);

-- Nothing must be left behind in Assessments and Students, nor the pay-period schedule.
do $$ begin
  if exists (select 1 from public.business_rules where scope_key = '' and registration->>'handler' = 'inventory_only'
             and (identifier like 'assessment.%' or identifier like 'students.%' or identifier = 'hrms.pay_period_topup_schedule')) then
    raise exception 'BUSINESS-RULES-LIVE: reference entries remain: %',
      (select string_agg(identifier, ', ') from public.business_rules where scope_key = '' and registration->>'handler' = 'inventory_only'
         and (identifier like 'assessment.%' or identifier like 'students.%' or identifier = 'hrms.pay_period_topup_schedule'));
  end if;
end $$;

commit;
