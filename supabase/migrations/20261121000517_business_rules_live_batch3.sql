-- BUSINESS-RULES-LIVE batch 3 (owner, 2026-11-20: make every Business Rules entry changeable, one paste):
-- assessment + student placement, admissions + agents + Office 365, HR, bookings + website + offer-letter terms.
-- Every rule goes live at today's value; each section ends with a check that nothing of its area is left as reference.
begin;

-- ===== business_rules_live_assessment_students =====
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


-- ===== business_rules_live_admissions_agents =====
-- BUSINESS-RULES-LIVE batch: Admissions, Agents and Microsoft 365. Every admissions.*, agents.* and office365.* reference entry in
-- Business Rules becomes a live setting at today's value (nothing changes on the day); SLIT changes it on Administration › Business Rules.
-- Database rules are read with public.rule_* (batch 1); screens through src/lib/businessRules.ts; Edge Functions through
-- supabase/functions/_shared/business-rules.ts (validated-document-upload, guest-documents, document-signing, student-office365).
-- Entries that described behaviour in words become choices (the first choice = today's behaviour) or lists:
--   admissions.application_delete_only_unsubmitted    drafts only, or no deletion at all
--   admissions.applications_choose_open_intake       intake needed when one is open, or always (no start-month fallback)
--   admissions.registration_coe_voe_issue_prerequisites  the three structural steps stay required; "Initial deposit paid" may be added
--   admissions.registration_verification_prerequisites   "Valid CoE number" stays required (a verified registration carries one)
--   agents.agent_application_yes_no_fallback         unanswered Yes / No questions start at No, or stay blank
--   office365.*_license_fallback                     a licence with a mailbox of the matching kind (faculty / students)
-- Ceilings kept (they are storage or table limits): application documents 10 MB and PDF / JPG / PNG, CoE / VoE PDF 3 MB
-- (enrollment_coe_documents check), F04 attachments 5 MB (agency_onboarding_attachments check).

-- A list setting can keep some entries fixed ("required" in the registration): they cannot be taken out.
select public.business_rule_patch_function('public.business_rule_validate(jsonb, jsonb)'::regprocedure,
  $o$      if p_registration ? 'keys' and jsonb_typeof(d->'value') = 'object'$o$,
  $n$      if p_registration ? 'required' and jsonb_typeof(d->'value') = 'array' and not (d->'value') @> (p_registration->'required') then
        raise exception 'Keep these in the list: %.', (select string_agg(x, ', ') from jsonb_array_elements_text(p_registration->'required') x) using errcode = '22023';
      end if;
      if p_registration ? 'keys' and jsonb_typeof(d->'value') = 'object'$n$);

-- 1. Applications: deleting, courses and intakes.
select public.business_rule_go_live('admissions.application_delete_only_unsubmitted',
  '{"allowed":["Delete an unsubmitted draft only","No deletion: keep every application"]}');
select public.business_rule_go_live('admissions.applications_require_published_course');
select public.business_rule_go_live('admissions.applications_choose_open_intake',
  '{"allowed":["Select an intake when the course has an open intake","Always select an intake (no start-month fallback)"]}');

select public.business_rule_patch_function('public.portal_delete_draft_prepare(uuid)'::regprocedure,
  $o$if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then$o$,
  $n$if public.rule_text('admissions.application_delete_only_unsubmitted', 'Delete an unsubmitted draft only') = 'No deletion: keep every application' then
    raise exception 'Applications cannot be deleted: every application is kept as a record.' using errcode = '55000'; end if;
  if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then$n$);
select public.business_rule_patch_function('public.portal_delete_draft_application(uuid, integer)'::regprocedure,
  $o$if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then$o$,
  $n$if public.rule_text('admissions.application_delete_only_unsubmitted', 'Delete an unsubmitted draft only') = 'No deletion: keep every application' then
    raise exception 'Applications cannot be deleted: every application is kept as a record.' using errcode = '55000'; end if;
  if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then$n$);
select public.business_rule_patch_function('public.application_intake_problem(uuid)'::regprocedure,
  $o$if not exists (select 1 from public.cms_courses x where x.id = k.course_id and x.status = 'Published') then$o$,
  $n$if not exists (select 1 from public.cms_courses x where x.id = k.course_id and x.status = 'Published')
     and (public.rule_bool('admissions.applications_require_published_course', true) or not public.course_has_open_intake(k.course_id)) then$n$);
select public.business_rule_patch_function('public.application_intake_problem(uuid)'::regprocedure,
  $o$if public.course_has_open_intake(k.course_id) then return 'Choose an intake for the course'; end if;$o$,
  $n$if public.course_has_open_intake(k.course_id) or public.rule_text('admissions.applications_choose_open_intake', 'Select an intake when the course has an open intake') = 'Always select an intake (no start-month fallback)' then return 'Choose an intake for the course'; end if;$n$);
select public.business_rule_patch_function('public.portal_course_options()'::regprocedure,
  $o$and c.status = 'Published';$o$,
  $n$and (c.status = 'Published' or (not public.rule_bool('admissions.applications_require_published_course', true) and public.course_has_open_intake(c.id)));$n$);

-- 2. Application form: which address and emergency contact details are required (a detail left out becomes optional);
-- application documents: size and types (never above the 10 MB, PDF / JPG / PNG ceiling the uploads and extraction take).
select public.business_rule_go_live('admissions.australian_address_required_fields', '{"allowed":["Suburb","State","ZIP / Postal Code"]}');
select public.business_rule_go_live('admissions.overseas_address_required_fields', '{"allowed":["Suburb","State / Territory","ZIP / Postal Code"]}');
select public.business_rule_go_live('admissions.emergency_contact_required_details',
  '{"allowed":["Full Name","Contact Number","Whether the contact is in Australia"]}');
select public.business_rule_go_live('admissions.application_document_limit_mib', '{"min":1,"max":10}');
select public.business_rule_go_live('admissions.application_document_types', '{"allowed":["JPEG","PNG","PDF"]}');

create or replace function public.admissions_field_optional(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_name in ('au_suburb', 'au_state', 'au_zip') then not coalesce(public.rule_json('admissions.australian_address_required_fields',
      '["Suburb","State","ZIP / Postal Code"]'::jsonb) ? (case p_name when 'au_suburb' then 'Suburb' when 'au_state' then 'State' else 'ZIP / Postal Code' end), true)
    when p_name in ('ov_suburb', 'ov_state', 'ov_zip') then not coalesce(public.rule_json('admissions.overseas_address_required_fields',
      '["Suburb","State / Territory","ZIP / Postal Code"]'::jsonb) ? (case p_name when 'ov_suburb' then 'Suburb' when 'ov_state' then 'State / Territory' else 'ZIP / Postal Code' end), true)
    when p_name in ('ec_name', 'ec_phone', 'ec_in_au') then not coalesce(public.rule_json('admissions.emergency_contact_required_details',
      '["Full Name","Contact Number","Whether the contact is in Australia"]'::jsonb) ? (case p_name when 'ec_name' then 'Full Name' when 'ec_phone' then 'Contact Number' else 'Whether the contact is in Australia' end), true)
    else false end;
$$;
revoke all on function public.admissions_field_optional(text) from public;
grant execute on function public.admissions_field_optional(text) to authenticated, service_role;

select public.business_rule_patch_function('public.portal_validate_submission(uuid)'::regprocedure,
  $o$cc.status='Published'$o$,
  $n$(cc.status='Published' or not public.rule_bool('admissions.applications_require_published_course', true))$n$);
select public.business_rule_patch_function('public.portal_validate_submission(uuid)'::regprocedure,
  $o$if not public.portal_condition_met(f->'showIf',vals) then continue; end if;$o$,
  $n$if not public.portal_condition_met(f->'showIf',vals) or public.admissions_field_optional(f->>'name') then continue; end if;$n$);
select public.business_rule_patch_function('public.application_completion(uuid)'::regprocedure,
  $o$if not public.portal_condition_met(f->'showIf', vals) then continue; end if;$o$,
  $n$if not public.portal_condition_met(f->'showIf', vals) or public.admissions_field_optional(f->>'name') then continue; end if;$n$);

-- 3. Registrations: the unverified alert, what verification needs, the CoE / VoE PDF size and what issuing needs.
select public.business_rule_go_live('admissions.registration_stale_lodgement_days', '{"min":1,"max":365}');
select public.business_rule_go_live('admissions.registration_verification_prerequisites',
  '{"allowed":["Registration lodged","Offer accepted or later","At least one evidence item","Valid CoE number"],"required":["Valid CoE number"]}');
select public.business_rule_go_live('admissions.registration_coe_voe_pdf_mib', '{"min":1,"max":3}');
select public.business_rule_go_live('admissions.registration_coe_voe_issue_prerequisites',
  '{"allowed":["Offer accepted","Verified registration","Uploaded PDF","Initial deposit paid"],"required":["Offer accepted","Verified registration","Uploaded PDF"]}');

create or replace function public.admissions_verification_requires(p_item text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.rule_json('admissions.registration_verification_prerequisites',
    '["Registration lodged","Offer accepted or later","At least one evidence item","Valid CoE number"]'::jsonb) ? p_item, true);
$$;
revoke all on function public.admissions_verification_requires(text) from public;
grant execute on function public.admissions_verification_requires(text) to authenticated, service_role;

select public.business_rule_patch_function('public.portal_registration_exception_kinds(uuid)'::regprocedure,
  $o$l.lodged_at < now() - interval '14 days'$o$,
  $n$l.lodged_at < now() - make_interval(days => public.rule_int('admissions.registration_stale_lodgement_days', 14))$n$);
select public.business_rule_patch_function('public.portal_registration_transition(uuid, text, text, text)'::regprocedure,
  $o$if not ((r.state, p_to) in (('draft', 'lodged'), ('lodged', 'verified'), ('draft', 'cancelled'), ('lodged', 'cancelled'), ('verified', 'cancelled'))) then$o$,
  $n$if not ((r.state, p_to) in (('draft', 'lodged'), ('lodged', 'verified'), ('draft', 'cancelled'), ('lodged', 'cancelled'), ('verified', 'cancelled'))
          or (r.state = 'draft' and p_to = 'verified' and not public.admissions_verification_requires('Registration lodged'))) then$n$);
select public.business_rule_patch_function('public.portal_registration_transition(uuid, text, text, text)'::regprocedure,
  $o$if a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then raise exception 'The offer must be accepted before registration can be verified'$o$,
  $n$if public.admissions_verification_requires('Offer accepted or later') and a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then raise exception 'The offer must be accepted before registration can be verified'$n$);
select public.business_rule_patch_function('public.portal_registration_transition(uuid, text, text, text)'::regprocedure,
  $o$if not exists (select 1 from public.enrollment_registration_evidence e where e.registration_id = r.id) then raise exception 'Evidence is required before verification'$o$,
  $n$if public.admissions_verification_requires('At least one evidence item') and not exists (select 1 from public.enrollment_registration_evidence e where e.registration_id = r.id) then raise exception 'Evidence is required before verification'$n$);
select public.business_rule_patch_function('public.portal_registration_transition(uuid, text, text, text)'::regprocedure,
  $o$update public.enrollment_registrations set state = 'verified', coe_number = v_coe,$o$,
  $n$update public.enrollment_registrations set state = 'verified', lodged_at = coalesce(lodged_at, now()), lodged_by = coalesce(lodged_by, auth.uid()), coe_number = v_coe,$n$);
select public.business_rule_patch_function('public.portal_coe_document_upload(uuid, text, text, text)'::regprocedure,
  $o$length(p_content) > 4300000 then raise exception 'The PDF is too large (3 MB at most)'$o$,
  $n$length(p_content) > 4300000 * public.rule_num('admissions.registration_coe_voe_pdf_mib', 3) / 3 then raise exception 'The PDF is too large (% MB at most)', public.rule_num('admissions.registration_coe_voe_pdf_mib', 3)$n$);
select public.business_rule_patch_function('public.portal_coe_document_upload(uuid, text, text, text)'::regprocedure,
  $o$if length(v_bytes) not between 8 and 3145728 then raise exception 'The PDF must be between 8 bytes and 3 MB'$o$,
  $n$if length(v_bytes) not between 8 and (public.rule_num('admissions.registration_coe_voe_pdf_mib', 3) * 1048576)::bigint then raise exception 'The PDF must be between 8 bytes and % MB', public.rule_num('admissions.registration_coe_voe_pdf_mib', 3)$n$);
select public.business_rule_patch_function('public.portal_coe_voe_issue(uuid, text)'::regprocedure,
  $o$if not found then raise exception 'Upload the CoE / VoE PDF before issuing it' using errcode = '22023'; end if;$o$,
  $n$if not found then raise exception 'Upload the CoE / VoE PDF before issuing it' using errcode = '22023'; end if;
  if public.rule_json('admissions.registration_coe_voe_issue_prerequisites', '["Offer accepted","Verified registration","Uploaded PDF"]'::jsonb) ? 'Initial deposit paid'
     and coalesce((select o.deposit_paid_at is null and coalesce(o.payment_amount_cents, 0) > 0 from public.enrollment_offer_letters o
                    where o.application_id = a.id and o.accepted_at is not null order by o.accepted_at desc limit 1), false) then
    raise exception 'The initial deposit must be paid before the CoE / VoE is issued' using errcode = '22023'; end if;$n$);

-- 4. Agents: the F04 attachment cap (never above the 5 MB the table stores), and the onboarding values read by document-signing:
-- the template expiry / reminder fallbacks, the Yes / No starting answer and the questions that must be answered.
select public.business_rule_go_live('agents.agent_application_attachment_cap_mib', '{"min":1,"max":5}');
select public.business_rule_go_live('agents.onboarding_document_expiry_default', '{"min":1,"max":365}');
select public.business_rule_go_live('agents.onboarding_document_reminder_default', '{"min":0,"max":60}');
select public.business_rule_go_live('agents.agent_application_yes_no_fallback', '{"allowed":["No","Leave blank (the agent answers)"]}');
select public.business_rule_go_live('agents.onboarding_required_answer_groups', '{"allowed":["Litigation involved","EATC completed"]}');

select public.business_rule_patch_function('public.agency_onboarding_attachment_save(uuid, uuid, text, jsonb)'::regprocedure,
  $o$if length(v_bytes) = 0 or length(v_bytes) > 5242880 then raise exception 'The file must be smaller than 5 MB.' using errcode = '22023'; end if;$o$,
  $n$if length(v_bytes) = 0 or length(v_bytes) > least(5242880, (public.rule_num('agents.agent_application_attachment_cap_mib', 5) * 1048576)::bigint) then
  raise exception 'The file must be smaller than % MB.', least(5, public.rule_num('agents.agent_application_attachment_cap_mib', 5)) using errcode = '22023'; end if;$n$);

-- 5. Microsoft 365: the licence used when EF_MICROSOFT365_STAFF_SKU / EF_MICROSOFT365_STUDENT_SKU is not set (student-office365).
select public.business_rule_go_live('office365.staff_license_fallback',
  '{"allowed":["Office 365 A1 for faculty","Office 365 A1 Plus for faculty","Office 365 A3 for faculty","Office 365 A5 for faculty","Microsoft 365 A3 for faculty","Microsoft 365 A5 for faculty"]}');
select public.business_rule_go_live('office365.student_license_fallback',
  '{"allowed":["Office 365 A1 for students","Office 365 A1 Plus for students","Office 365 A3 for students","Office 365 A5 for students","Microsoft 365 A3 for students","Microsoft 365 A5 for students"]}');

-- Nothing must be left behind in Admissions, Agents or Microsoft 365.
do $$ begin
  if exists (select 1 from public.business_rules where scope_key = '' and (identifier like 'admissions.%' or identifier like 'agents.%' or identifier like 'office365.%')
              and registration->>'handler' = 'inventory_only') then
    raise exception 'BUSINESS-RULES-LIVE: Admissions / Agents / Microsoft 365 reference entries remain: %',
      (select string_agg(identifier, ', ') from public.business_rules where scope_key = '' and (identifier like 'admissions.%' or identifier like 'agents.%' or identifier like 'office365.%')
        and registration->>'handler' = 'inventory_only');
  end if;
end $$;


-- ===== business_rules_live_hr =====
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


-- ===== business_rules_live_bookings_cms_letters =====
-- BUSINESS-RULES-LIVE batch: Bookings, website (CMS) limits and the offer-letter terms. Every reference entry below becomes a
-- live setting at today's value (nothing changes on the day); SLIT then changes it on Administration › Business Rules.
--  * booking.*  : read by the booking functions (rule_*) and by the Bookings screen through booking_me() ('newType', 'initialHours').
--                 booking.initial_host_availability ("Monday to Friday", 09:00-17:00) becomes a real setting: a list of weekdays + times.
--  * cms.*      : website editor limits held by the screens (src/config/cmsLimits.ts, src/pages/admin/lib/storage.ts); the database
--                 has no validator for them. The upload limit cannot go above the tenant-public-media bucket limit (20 MiB).
--  * finance.offer_* : words of the Student Offer Letter. The live template gets {{offer.*}} variables filled from the rules by
--                 application_letter_values (SQL), so the rendered letter reads exactly as today. No Edge Function change.

/* ------------------------------------------------------------------ 1. Bookings */
select public.business_rule_go_live('booking.new_type_duration', '{"min":5,"max":480}');
select public.business_rule_go_live('booking.new_type_buffer', '{"min":0,"max":120}');
select public.business_rule_go_live('booking.new_type_min_notice', '{"min":0,"max":720}');
select public.business_rule_go_live('booking.new_type_max_days_ahead', '{"min":1,"max":365}');
select public.business_rule_go_live('booking.new_type_requires_login');
select public.business_rule_go_live('booking.reminder_hours', '{"min":1,"max":168}');
select public.business_rule_go_live('booking.reschedule_cap', '{"min":0,"max":50}');
select public.business_rule_go_live('booking.upcoming_per_host_cap', '{"min":1,"max":50}');
select public.business_rule_go_live_as('booking.initial_host_availability', '{"keys":["days","start","end"]}',
  '{"days":["Monday","Tuesday","Wednesday","Thursday","Friday"],"start":"09:00","end":"17:00"}');

-- New meeting types: the column defaults and the values booking_type_save uses when the screen sends none.
alter table public.booking_types alter column buffer_min set default public.rule_int('booking.new_type_buffer', 0);
alter table public.booking_types alter column min_notice_hours set default public.rule_int('booking.new_type_min_notice', 4);
alter table public.booking_types alter column max_days_ahead set default public.rule_int('booking.new_type_max_days_ahead', 60);
alter table public.booking_types alter column requires_login set default public.rule_bool('booking.new_type_requires_login', false);

create or replace function public.booking_new_type_defaults() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'duration', least(480, greatest(5, public.rule_int('booking.new_type_duration', 30))),
    'buffer', least(120, greatest(0, public.rule_int('booking.new_type_buffer', 0))),
    'minNoticeHours', least(720, greatest(0, public.rule_int('booking.new_type_min_notice', 4))),
    'maxDaysAhead', least(365, greatest(1, public.rule_int('booking.new_type_max_days_ahead', 60))),
    'requiresLogin', public.rule_bool('booking.new_type_requires_login', false));
$$;

-- The hours a new booking page starts with: [{weekday (Sunday = 0), start, end}]. A value that cannot be read gives today's hours.
create or replace function public.booking_initial_hours() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb := public.rule_json('booking.initial_host_availability', '{"days":["Monday","Tuesday","Wednesday","Thursday","Friday"],"start":"09:00","end":"17:00"}'::jsonb);
  wd text[] := array['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  v_start text := v->>'start'; v_end text := v->>'end'; v_out jsonb;
begin
  if jsonb_typeof(v->'days') <> 'array' or coalesce(v_start, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(v_end, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or v_start >= v_end then
    v := '{"days":["Monday","Tuesday","Wednesday","Thursday","Friday"],"start":"09:00","end":"17:00"}'::jsonb; v_start := '09:00'; v_end := '17:00';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('weekday', d.n, 'start', v_start, 'end', v_end) order by d.n), '[]'::jsonb) into v_out
    from (select distinct array_position(wd, lower(btrim(x))) - 1 n from jsonb_array_elements_text(v->'days') x) d where d.n is not null;
  return v_out;
end $$;

-- "A reminder of your booking tomorrow." keeps its words at 24 hours; another lead time says when.
create or replace function public.booking_reminder_when() returns text
language sql stable security definer set search_path = '' as $$
  select case when h = 24 then 'tomorrow' when h = 1 then 'in 1 hour' when h % 24 = 0 then 'in ' || (h / 24) || ' days' else 'in ' || h || ' hours' end
    from (select greatest(1, public.rule_int('booking.reminder_hours', 24)) h) x;
$$;

do $$ declare f text; begin
  foreach f in array array['booking_new_type_defaults()', 'booking_initial_hours()', 'booking_reminder_when()'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

select public.business_rule_patch_function('public.booking_me()'::regprocedure,
  $o$return jsonb_build_object('identity', v_id, 'origin', public.support_site_origin(),$o$,
  $n$return jsonb_build_object('identity', v_id, 'origin', public.support_site_origin(), 'newType', public.booking_new_type_defaults(), 'initialHours', public.booking_initial_hours(),$n$);

select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'duration')::integer, 30)$o$, $n$coalesce((p->>'duration')::integer, (public.booking_new_type_defaults()->>'duration')::integer)$n$);
select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'buffer')::integer, 0)$o$, $n$coalesce((p->>'buffer')::integer, (public.booking_new_type_defaults()->>'buffer')::integer)$n$);
select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'minNoticeHours')::integer, 4)$o$, $n$coalesce((p->>'minNoticeHours')::integer, (public.booking_new_type_defaults()->>'minNoticeHours')::integer)$n$);
select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'maxDaysAhead')::integer, 60)$o$, $n$coalesce((p->>'maxDaysAhead')::integer, (public.booking_new_type_defaults()->>'maxDaysAhead')::integer)$n$);
select public.business_rule_patch_function('public.booking_type_save(jsonb)'::regprocedure,
  $o$coalesce((p->>'requiresLogin')::boolean, false)$o$, $n$coalesce((p->>'requiresLogin')::boolean, public.rule_bool('booking.new_type_requires_login', false))$n$);

select public.business_rule_patch_function(p.oid::regprocedure,
  $o$x.starts_at > now()) >= 3 then$o$, $n$x.starts_at > now()) >= public.rule_int('booking.upcoming_per_host_cap', 3) then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_create';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$'You already have 3 upcoming bookings with %. Cancel one to book another.', h.display_name$o$,
  $n$'You already have % upcoming bookings with %. Cancel one to book another.', public.rule_int('booking.upcoming_per_host_cap', 3), h.display_name$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_create';

select public.business_rule_patch_function(p.oid::regprocedure,
  $o$if b.reschedule_count >= 5 then$o$, $n$if b.reschedule_count >= public.rule_int('booking.reschedule_cap', 5) then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_reschedule';

select public.business_rule_patch_function(p.oid::regprocedure,
  $o$interval '25 hours'$o$, $n$make_interval(hours => greatest(1, public.rule_int('booking.reminder_hours', 24)) + 1)$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_notify';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$interval '24 hours'$o$, $n$make_interval(hours => greatest(1, public.rule_int('booking.reminder_hours', 24)))$n$, 2)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_notify';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$your booking tomorrow.$o$, $n$your booking ' || public.booking_reminder_when() || E'.$n$, 2)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'booking_notify';

/* ------------------------------------------------------------------ 2. Website (CMS) limits, read by the screens */
select public.business_rule_go_live('cms.cms_document_limit_mib', '{"min":1,"max":20}');
select public.business_rule_go_live('cms.footer_label_char_cap', '{"min":5,"max":60}');
select public.business_rule_go_live('cms.footer_links_per_column', '{"min":1,"max":20}');
select public.business_rule_go_live('cms.homepage_course_cap', '{"min":1,"max":50}');
select public.business_rule_go_live('cms.navigation_child_cap', '{"min":1,"max":12}');
select public.business_rule_go_live('cms.navigation_label_char_cap', '{"min":5,"max":40}');
select public.business_rule_go_live('cms.navigation_top_level_cap', '{"min":1,"max":12}');

/* ------------------------------------------------------------------ 3. Offer letter terms */
select public.business_rule_go_live('finance.offer_late_fee_template_amount', '{"min":0,"max":10000}');
select public.business_rule_go_live('finance.offer_overdue_notice_template_days', '{"min":1,"max":365}');
select public.business_rule_go_live('finance.offer_refund_template_processing_days', '{"min":1,"max":365}');
-- The catalogue summarised the clause as "Chief Executive approval"; the letter prints these exact words.
select public.business_rule_go_live_as('finance.offer_refund_request_approval', '{}',
  '"the Chief Executive Officer or the Finance Manager"');
select public.business_rule_go_live('finance.offer_refund_offshore_withdrawal', '{"keys":["cutoffWeeks","lessThanCutoffPercent","moreThanCutoffPercent"]}');

-- "four (4)" as the letter writes a number of weeks.
create or replace function public.letter_number_words(p_n integer) returns text
language sql immutable set search_path = '' as $$
  select case when p_n between 1 and 20 then (array['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen',
    'fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'])[p_n] || ' (' || p_n || ')' else p_n::text end;
$$;

-- The words of the letter that come from Business Rules: { variable key: printed text }.
create or replace function public.offer_letter_terms() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_fee numeric := greatest(0, public.rule_num('finance.offer_late_fee_template_amount', 100));
  w jsonb := public.rule_json('finance.offer_refund_offshore_withdrawal', '{"cutoffWeeks":4,"lessThanCutoffPercent":50,"moreThanCutoffPercent":80}'::jsonb);
  pct numeric; v_weeks integer; v_more numeric; v_less numeric;
begin
  v_weeks := case when jsonb_typeof(w->'cutoffWeeks') = 'number' and (w->>'cutoffWeeks')::numeric between 1 and 52 then round((w->>'cutoffWeeks')::numeric)::integer else 4 end;
  v_more := case when jsonb_typeof(w->'moreThanCutoffPercent') = 'number' and (w->>'moreThanCutoffPercent')::numeric between 0 and 100 then (w->>'moreThanCutoffPercent')::numeric else 80 end;
  v_less := case when jsonb_typeof(w->'lessThanCutoffPercent') = 'number' and (w->>'lessThanCutoffPercent')::numeric between 0 and 100 then (w->>'lessThanCutoffPercent')::numeric else 50 end;
  return jsonb_build_object(
    'offer.late_fee', case when v_fee = trunc(v_fee) then trunc(v_fee)::text else to_char(v_fee, 'FM9999999990.00') end,
    'offer.overdue_notice_days', greatest(1, public.rule_int('finance.offer_overdue_notice_template_days', 14))::text,
    'offer.refund_processing_days', greatest(1, public.rule_int('finance.offer_refund_template_processing_days', 28))::text,
    'offer.refund_approver', coalesce(nullif(btrim(public.rule_text('finance.offer_refund_request_approval', 'the Chief Executive Officer or the Finance Manager')), ''),
      'the Chief Executive Officer or the Finance Manager'),
    'offer.offshore_cutoff_weeks', public.letter_number_words(v_weeks),
    'offer.offshore_refund_more', trim_scale(v_more)::text || '%',
    'offer.offshore_refund_less', trim_scale(v_less)::text || '%');
end $$;
revoke all on function public.offer_letter_terms() from public;
grant execute on function public.offer_letter_terms() to authenticated, service_role;

insert into public.letter_variables(key, grp, label, description, source_kind, source_ref, source_label, format, input_type, required, editable_source, aliases, sample, sort) values
 ('offer.late_fee', 'Application', 'Late payment fee per week', 'Amount without the currency sign, e.g. 100', 'computed', 'business_rule',
  'Business Rules › Offer template late fee wording', 'text', 'text', false, false, '{}', '100', 545),
 ('offer.overdue_notice_days', 'Application', 'Overdue notice days', 'Days fees may stay overdue before the student is told about a report to DHA', 'computed', 'business_rule',
  'Business Rules › Offer template overdue notice wording', 'text', 'text', false, false, '{}', '14', 546),
 ('offer.refund_processing_days', 'Application', 'Refund processing days', 'Days within which a refund is honoured', 'computed', 'business_rule',
  'Business Rules › Offer template refund processing wording', 'text', 'text', false, false, '{}', '28', 547),
 ('offer.refund_approver', 'Application', 'Refund approver', 'Who authorises refund applications', 'computed', 'business_rule',
  'Business Rules › Offer template refund approval wording', 'text', 'text', false, false, '{}', 'the Chief Executive Officer or the Finance Manager', 548),
 ('offer.offshore_cutoff_weeks', 'Application', 'Off-shore withdrawal cut-off (weeks)', 'Written as in the letter, e.g. four (4)', 'computed', 'business_rule',
  'Business Rules › Offer template offshore withdrawal wording', 'text', 'text', false, false, '{}', 'four (4)', 549),
 ('offer.offshore_refund_more', 'Application', 'Off-shore refund before the cut-off', 'Percentage refunded when withdrawing more than the cut-off before the CoE start date', 'computed', 'business_rule',
  'Business Rules › Offer template offshore withdrawal wording', 'text', 'text', false, false, '{}', '80%', 550),
 ('offer.offshore_refund_less', 'Application', 'Off-shore refund after the cut-off', 'Percentage refunded when withdrawing less than the cut-off before the CoE start date', 'computed', 'business_rule',
  'Business Rules › Offer template offshore withdrawal wording', 'text', 'text', false, false, '{}', '50%', 551)
on conflict (key) do nothing;

select public.business_rule_patch_function('public.application_letter_values(uuid)'::regprocedure,
  $o$    elsif r.key = 'fees.combined_total' then$o$,
  $n$    elsif r.source_ref = 'business_rule' and public.offer_letter_terms() ? r.key then raw := public.offer_letter_terms() ->> r.key;
    elsif r.key = 'fees.combined_total' then$n$);

-- The live offer letter template: the seven terms become variables (body_html and its plain-text copy). Every piece must be found exactly
-- once in each text of the default template, so a template SLIT changed in the meantime is never rewritten blindly.
do $$
declare
  t record; pair text[]; n_html integer; n_body integer; v_html text; v_body text; v_default_done boolean := false;
  pairs text[][] := array[
    array['AUD$100 per week in fines', 'AUD${{offer.late_fee}} per week in fines'],
    array['A late payment fee of $100 will be applied', 'A late payment fee of ${{offer.late_fee}} will be applied'],
    array['overdue for more than 14 days SLIT', 'overdue for more than {{offer.overdue_notice_days}} days SLIT'],
    array['honoured by SLIT within 28 days of the request', 'honoured by SLIT within {{offer.refund_processing_days}} days of the request'],
    array['authorised by the Chief Executive Officer or the Finance Manager.', 'authorised by {{offer.refund_approver}}.'],
    array['more than four (4) weeks before the CoE start date, 80% of the tuition', 'more than {{offer.offshore_cutoff_weeks}} weeks before the CoE start date, {{offer.offshore_refund_more}} of the tuition'],
    array['less than four (4) weeks before the CoE start date, 50% of the tuition', 'less than {{offer.offshore_cutoff_weeks}} weeks before the CoE start date, {{offer.offshore_refund_less}} of the tuition']];
begin
  for t in select id, body_html, body, is_default and status = 'active' as live from hr.sign_templates
            where category = 'student_offer_letter' and deleted_at is null and body_html like '%A late payment fee of $100 will be applied%' for update loop
    v_html := t.body_html; v_body := coalesce(t.body, '');
    foreach pair slice 1 in array pairs loop
      n_html := (length(v_html) - length(replace(v_html, pair[1], ''))) / length(pair[1]);
      n_body := (length(v_body) - length(replace(v_body, pair[1], ''))) / length(pair[1]);
      if n_html <> 1 or n_body not in (0, 1) then
        raise exception 'BUSINESS-RULES-LIVE: offer letter template % has "%" % time(s) (plain text %), expected once.', t.id, pair[1], n_html, n_body;
      end if;
      v_html := replace(v_html, pair[1], pair[2]);
      v_body := replace(v_body, pair[1], pair[2]);
    end loop;
    update hr.sign_templates set body_html = v_html, body = case when t.body is null then null else v_body end, updated_at = now() where id = t.id;
    if t.live then v_default_done := true; end if;
  end loop;
  if not v_default_done and exists (select 1 from hr.sign_templates where category = 'student_offer_letter' and deleted_at is null and is_default and status = 'active') then
    raise exception 'BUSINESS-RULES-LIVE: the default offer letter template does not hold the expected late fee wording; check it before making the letter terms live.';
  end if;
end $$;

-- Nothing must be left behind in this area.
do $$ begin
  if exists (select 1 from public.business_rules where scope_key = '' and registration->>'handler' = 'inventory_only'
              and (identifier like 'booking.%' or identifier like 'cms.%' or identifier in ('finance.offer_late_fee_template_amount',
                'finance.offer_overdue_notice_template_days', 'finance.offer_refund_offshore_withdrawal', 'finance.offer_refund_request_approval',
                'finance.offer_refund_template_processing_days'))) then
    raise exception 'BUSINESS-RULES-LIVE: reference entries remain: %',
      (select string_agg(identifier, ', ') from public.business_rules where scope_key = '' and registration->>'handler' = 'inventory_only'
        and (identifier like 'booking.%' or identifier like 'cms.%' or identifier like 'finance.offer\_%'));
  end if;
end $$;


-- Nothing left as reference anywhere.
do $$ begin
  if exists (select 1 from public.business_rules where scope_key = '' and registration->>'handler' = 'inventory_only') then
    raise exception 'BUSINESS-RULES-LIVE: reference entries remain: %', (select string_agg(identifier, ', ') from public.business_rules where scope_key = '' and registration->>'handler' = 'inventory_only');
  end if;
end $$;

commit;
