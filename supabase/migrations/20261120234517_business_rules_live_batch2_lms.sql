-- BUSINESS-RULES-LIVE batch 2: LMS. Every LMS reference entry in Business Rules becomes a live setting at today's value.
-- Database rules are read with public.rule_* (batch 1); screen rules through src/lib/businessRules.ts.
-- Three entries described behaviour in words; they become choices (the first choice = today's behaviour):
--   lms.intake_name_format             a name pattern: {code} {dd} {Mon} {yyyy} {LOAD}
--   lms.elective_automatic_selection_order  pick electives automatically, or let staff tick them
--   lms.intake_manual_join_window      join date inside the intake's dates, or any date
begin;

-- go_live with a starting value for the entries whose words become a choice or pattern.
create or replace function public.business_rule_go_live_as(p_id text, p_limits jsonb, p_value jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.business_rules; v public.business_rule_versions;
begin
  select * into r from public.business_rules where scope_key = '' and identifier = p_id;
  if r.registration->>'handler' = 'setting' then return; end if;
  select * into v from public.business_rule_versions where rule_id = r.id and state = 'reference' order by version desc limit 1;
  if v.id is null then raise exception 'BUSINESS-RULES-LIVE: rule % has no reference version.', p_id; end if;
  update public.business_rule_versions set definition = definition || jsonb_build_object('value', p_value) where id = v.id;
  perform public.business_rule_go_live(p_id, p_limits);
end $$;
revoke all on function public.business_rule_go_live_as(text, jsonb, jsonb) from public, anon, authenticated, service_role;

-- A setting made of percentages can be required to add up to a total ("sum" in the registration).
select public.business_rule_patch_function('public.business_rule_validate(jsonb, jsonb)'::regprocedure,
$o$      if p_registration ? 'keys' and jsonb_typeof(d->'value') = 'object'$o$,
$n$      if p_registration ? 'sum' and jsonb_typeof(d->'value') = 'object'
         and (select coalesce(sum(x.value::numeric), 0) from jsonb_each_text(d->'value') x where x.value ~ '^-?[0-9.]+$') <> (p_registration->>'sum')::numeric then
        raise exception 'The parts must add up to %.', p_registration->>'sum' using errcode = '22023';
      end if;
      if p_registration ? 'keys' and jsonb_typeof(d->'value') = 'object'$n$);

-- 1. Attendance.
select public.business_rule_go_live('lms.attendance_alert_threshold');
select public.business_rule_go_live('lms.attendance_alert_min_marks', '{"min":1,"max":100}');
select public.business_rule_go_live_as('lms.attendance_mark_treatment', '{"keys":["countsAsPresent","excluded"]}',
  '{"countsAsPresent":["present","late"],"excluded":["excused"]}');
select public.business_rule_go_live('lms.attendance_mark_from_class_date');

create or replace function public.lms_attendance_counts_as(p_part text) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array(select jsonb_array_elements_text(public.rule_json('lms.attendance_mark_treatment',
    '{"countsAsPresent":["present","late"],"excluded":["excused"]}'::jsonb)->p_part)), '{}'::text[]);
$$;
grant execute on function public.lms_attendance_counts_as(text) to authenticated, service_role;

select public.business_rule_patch_function((select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_today'),
  $o$100.0 * count(*) filter (where m.status in ('present', 'late')) / nullif(count(*) filter (where m.status <> 'excused'), 0) rate$o$,
  $n$100.0 * count(*) filter (where m.status = any(public.lms_attendance_counts_as('countsAsPresent'))) / nullif(count(*) filter (where not m.status = any(public.lms_attendance_counts_as('excluded'))), 0) rate$n$);
select public.business_rule_patch_function((select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_today'),
  $o$count(*) filter (where m.status <> 'excused') counted$o$,
  $n$count(*) filter (where not m.status = any(public.lms_attendance_counts_as('excluded'))) counted$n$);
select public.business_rule_patch_function((select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'admin_today'),
  $o$where x.counted >= 3 and x.rate < 80$o$,
  $n$where x.counted >= public.rule_int('lms.attendance_alert_min_marks', 3) and x.rate < public.rule_num('lms.attendance_alert_threshold', 80)$n$);
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$if cs.session_date > public.course_intake_today() then$o$,
  $n$if public.rule_bool('lms.attendance_mark_from_class_date', true) and cs.session_date > public.course_intake_today() then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'trainer_session_attendance_save';

-- 2. Courses and units.
select public.business_rule_go_live('lms.unit_duration_weekly_hours', '{"min":1,"max":80}');
select public.business_rule_go_live('lms.unit_duration_rounding_weeks', '{"min":0.1,"max":4}');
select public.business_rule_go_live('lms.unit_default_duration_weeks', '{"min":1,"max":104}');
select public.business_rule_go_live('lms.unit_duration_ceiling', '{"min":1,"max":520}');
select public.business_rule_go_live('lms.unit_hours_split', '{"keys":["theoryPercent","practicalPercent","assessmentPercent"],"sum":100}');
select public.business_rule_go_live_as('lms.elective_automatic_selection_order',
  '{"allowed":["Pick automatically (units without prerequisites first)","Do not pick: staff tick every elective"]}',
  '"Pick automatically (units without prerequisites first)"');

alter table public.cms_course_units alter column default_weeks set default public.rule_int('lms.unit_default_duration_weeks', 4);
select public.business_rule_patch_function('public.course_unit_weeks_sync()'::regprocedure,
  $o$least(104,$o$, $n$least(public.rule_int('lms.unit_duration_ceiling', 104),$n$);
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$(x->>'weeks')::numeric > 104)$o$, $n$(x->>'weeks')::numeric > public.rule_int('lms.unit_duration_ceiling', 104))$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_master_timetable';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$raise exception 'Weeks must be between 0.5 and 104 for every unit.' using errcode = '22023';$o$,
  $n$raise exception 'Weeks must be between 0.5 and % for every unit.', public.rule_int('lms.unit_duration_ceiling', 104) using errcode = '22023';$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_master_timetable';

create or replace function public.lms_hours_share(p_part text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((public.rule_json('lms.unit_hours_split', '{"theoryPercent":40,"practicalPercent":40,"assessmentPercent":20}'::jsonb)->>p_part)::numeric, 40) / 100;
$$;
grant execute on function public.lms_hours_share(text) to authenticated, service_role;
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$coalesce(theory_hours, round(coalesce(nominal_hours, 0) * 0.4)) as th$o$,
  $n$coalesce(theory_hours, round(coalesce(nominal_hours, 0) * public.lms_hours_share('theoryPercent'))) as th$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_class_sessions_generate';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$coalesce(practical_hours, round(coalesce(nominal_hours, 0) * 0.4)) as pr$o$,
  $n$coalesce(practical_hours, round(coalesce(nominal_hours, 0) * public.lms_hours_share('practicalPercent'))) as pr$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_class_sessions_generate';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$coalesce(assessment_hours, coalesce(nominal_hours, 0) - 2 * round(coalesce(nominal_hours, 0) * 0.4)) as asm$o$,
  $n$coalesce(assessment_hours, coalesce(nominal_hours, 0) - round(coalesce(nominal_hours, 0) * public.lms_hours_share('theoryPercent')) - round(coalesce(nominal_hours, 0) * public.lms_hours_share('practicalPercent'))) as asm$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_class_sessions_generate';

-- 3. Intakes and scheduling.
select public.business_rule_go_live('lms.coe_weekly_study_hours', '{"min":1,"max":80}');
select public.business_rule_go_live('lms.voe_weekly_study_hours', '{"min":1,"max":80}');
select public.business_rule_go_live('lms.batch_hours_fit_tolerance', '{"min":1}');
select public.business_rule_go_live('lms.application_intake_fallback_months', '{"min":1,"max":36}');
select public.business_rule_go_live('lms.master_next_cycle_lead_months', '{"min":0,"max":24}');
select public.business_rule_go_live('lms.intake_trainer_before_unit_assignment');
select public.business_rule_go_live('lms.intake_manual_placement_reason');
select public.business_rule_go_live('lms.intake_suggested_start_day',
  '{"allowed":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]}');
select public.business_rule_go_live('lms.intake_suggested_notice_days', '{"min":0,"max":365}');
select public.business_rule_go_live('lms.class_suggested_day_cap', '{"min":1,"max":14}');
select public.business_rule_go_live_as('lms.class_setup_availability_fallback', '{"keys":["days","start","end"]}',
  '{"days":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],"start":"09:00","end":"22:00"}');
select public.business_rule_go_live_as('lms.intake_name_format', '{}', '"{code}_{dd}-{Mon}-{yyyy}_Intake_Batch_{LOAD}"');
select public.business_rule_go_live_as('lms.intake_manual_join_window',
  '{"allowed":["Between intake start and end, inclusive","Any date"]}', '"Between intake start and end, inclusive"');

select public.business_rule_patch_function(p.oid::regprocedure,
  $o$v_req * 0.95$o$, $n$v_req * public.rule_num('lms.batch_hours_fit_tolerance', 95) / 100.0$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_batches_hours_check';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$+ interval '12 months'$o$, $n$+ make_interval(months => public.rule_int('lms.application_intake_fallback_months', 12))$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'course_intake_fallback';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$(v_today + interval '3 months')$o$, $n$(v_today + make_interval(months => public.rule_int('lms.master_next_cycle_lead_months', 3)))$n$, 2)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_master_timetable';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$if not exists(select 1 from public.intake_trainers where intake_id=p_batch_id and staff_id=p_staff_id) then$o$,
  $n$if public.rule_bool('lms.intake_trainer_before_unit_assignment', true) and not exists(select 1 from public.intake_trainers where intake_id=p_batch_id and staff_id=p_staff_id) then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_batch_unit_trainer';

select public.business_rule_patch_function(p.oid::regprocedure,
  $o$ if coalesce(btrim(p_reason), '') = '' then$o$,
  $n$ if public.rule_bool('lms.intake_manual_placement_reason', true) and coalesce(btrim(p_reason), '') = '' then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('rto_staff_place', 'rto_staff_move', 'rto_staff_remove');
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$, btrim(p_reason)$o$, $n$, coalesce(nullif(btrim(p_reason), ''), 'No reason given')$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('rto_staff_place', 'rto_staff_move', 'rto_staff_remove');
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$ if v_on < i.start_date then$o$,
  $n$ if public.rule_text('lms.intake_manual_join_window', 'Between intake start and end, inclusive') <> 'Any date' and v_on < i.start_date then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_staff_place';
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$ if i.end_date is not null and v_on > i.end_date then$o$,
  $n$ if public.rule_text('lms.intake_manual_join_window', 'Between intake start and end, inclusive') <> 'Any date' and i.end_date is not null and v_on > i.end_date then$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rto_staff_place';

-- 4. Assessments set from the LMS.
select public.business_rule_go_live('lms.assessment_assignment_default_days', '{"min":0,"max":365}');
select public.business_rule_patch_function(p.oid::regprocedure,
  $o$now() + interval '7 days')$o$, $n$now() + make_interval(days => public.rule_int('lms.assessment_assignment_default_days', 7)))$n$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'asm_admin';

-- 5. Class rescheduling: the starting values for a new step (screen), the search step, the fallback end, and the
-- general defaults of a new rule set.
select public.business_rule_go_live('lms.reschedule_new_day_hours', '{"keys":["earliest","latest"]}');
select public.business_rule_go_live('lms.reschedule_new_day_search_days', '{"min":1,"max":90}');
select public.business_rule_go_live('lms.reschedule_new_day_weekdays',
  '{"allowed":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]}');
select public.business_rule_go_live('lms.reschedule_join_extra_seats', '{"min":1,"max":100}');
select public.business_rule_go_live('lms.reschedule_spread_limits', '{"keys":["addAt","classes","extraMinutes"]}');
select public.business_rule_go_live('lms.reschedule_fallback_end_days', '{"min":7,"max":730}');
select public.business_rule_go_live('lms.reschedule_search_time_increment', '{"min":5,"max":120}');
select public.business_rule_go_live('lms.reschedule_cancellation_default',
  '{"allowed":["No cancellation without a make-up","Cancellation allowed"]}');
select public.business_rule_go_live('lms.reschedule_waiting_blocks_completion',
  '{"allowed":["Wait for classes to be rescheduled before completing the course","Course can be completed with classes waiting"]}');

select public.business_rule_patch_function('public.class_reschedule_window(uuid)'::regprocedure,
  $o$s.session_date + 90$o$, $n$s.session_date + public.rule_int('lms.reschedule_fallback_end_days', 90)$n$, 2);
select public.business_rule_patch_function('public.class_reschedule_candidates(uuid, text, integer)'::regprocedure,
  $o$interval '30 minutes'$o$, $n$make_interval(mins => public.rule_int('lms.reschedule_search_time_increment', 30))$n$, 2);
select public.business_rule_patch_function('public.class_reschedule_default_rules()'::regprocedure, $o$ IMMUTABLE$o$, $n$ STABLE$n$);
select public.business_rule_patch_function('public.class_reschedule_default_rules()'::regprocedure,
  $o$'allowCancel', false$o$,
  $n$'allowCancel', public.rule_text('lms.reschedule_cancellation_default', 'No cancellation without a make-up') = 'Cancellation allowed'$n$);
select public.business_rule_patch_function('public.class_reschedule_default_rules()'::regprocedure,
  $o$'unitFinishWithWaiting', false$o$,
  $n$'unitFinishWithWaiting', public.rule_text('lms.reschedule_waiting_blocks_completion', 'Wait for classes to be rescheduled before completing the course') = 'Course can be completed with classes waiting'$n$);

-- Nothing must be left behind in LMS.
do $$ begin
  if exists (select 1 from public.business_rules where scope_key = '' and identifier like 'lms.%' and registration->>'handler' = 'inventory_only') then
    raise exception 'BUSINESS-RULES-LIVE: LMS reference entries remain: %',
      (select string_agg(identifier, ', ') from public.business_rules where scope_key = '' and identifier like 'lms.%' and registration->>'handler' = 'inventory_only');
  end if;
end $$;

commit;
