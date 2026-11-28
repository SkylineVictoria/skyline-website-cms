-- STUDY-PROGRESS-OWN-UNITS (owner 2026-11-28: "progress bar is not showing proper update"). The student's study progress (CMS student page
-- and My learning) showed Himani at 0 of 8 with every unit "coming up" in 2027: student_progress_core took each unit's dates from the
-- intake's units (a rolling intake follows its calendar's current cycle) and counted a unit finished only from a trainer's sign-off.
-- Now a unit the student is allocated to (lms_unit_students) shows the student's own dates and batch, and its AVETMISS outcome counts:
-- 20 / 51 / 60 = finished (as a trainer's C), 30 = not yet competent, 70 = studying / waiting for the result by its dates, 85 = coming up.
-- A unit without an allocation keeps the intake's dates as before. Read-only function; no data changes.
begin;

create or replace function public.student_progress_core(p_student uuid)
returns jsonb language sql stable security definer set search_path = public as $$
 with en as (
  select e.id, public.intake_group_name(ci.id) as batch, public.course_intake_name(ci) as intake, ci.course_id, ci.id as intake_id
  from public.intake_enrolments e join public.course_intakes ci on ci.id = e.intake_id
  where e.student_id = p_student and e.status in ('active', 'deferred', 'suspended', 'completed')),
 needed as (select distinct en.course_id, iu.unit_id from en join public.intake_units iu on iu.intake_id = en.intake_id),
 taken as (select en.course_id, u.unit_id, u.start_date, u.end_date, en.batch, en.intake from en cross join lateral public.rto_enrolment_units(en.id) u),
 -- The student's own allocation of each unit (latest first): dates, batch and AVETMISS outcome.
 mine as (
  select distinct on (a.course_id, a.unit_id) a.course_id, a.unit_id, a.assigned_start_date as start_date, a.assigned_end_date as end_date,
         a.outcome_code, a.actual_end_date, coalesce(b.code, public.intake_group_name(a.intake_id)) as batch, public.course_intake_name(ci) as intake
    from public.lms_unit_students a
    join public.course_intakes ci on ci.id = a.intake_id
    left join public.intake_batches b on b.id = a.batch_id
   where a.student_id = p_student
   order by a.course_id, a.unit_id, a.assigned_start_date desc nulls last),
 rows as (
  select n.course_id, cu.id as unit_id, cu.code, cu.name, coalesce(cu.nominal_hours, 0) as hours,
   coalesce(o.signed_on, case when m.outcome_code in ('20', '51', '60') then m.actual_end_date end) as signed_on,
   coalesce(m.start_date, t.start_date) as start_date, coalesce(m.end_date, t.end_date) as end_date,
   coalesce(m.batch, t.batch) as batch, coalesce(m.intake, t.intake) as intake,
   -- rule-policy: technical study-progress 2026-11-28 owner (STUDY-PROGRESS-OWN-UNITS): AVETMISS outcomes 20 / 51 / 60 count as finished, 30 as not yet competent; fixed NCVER codes, no configurable value.
   case when o.outcome = 'C' or m.outcome_code in ('20', '51', '60') then 'competent'
        when m.outcome_code = '30' then 'not_yet_competent'
        when coalesce(m.start_date, t.start_date) > public.course_intake_today() then 'upcoming'
        when coalesce(m.end_date, t.end_date) >= public.course_intake_today() then 'in_progress'
        when o.outcome is not null then 'not_yet_competent'
        when m.unit_id is not null or t.unit_id is not null then 'awaiting_result'
        else 'owed' end as status
  from needed n join public.cms_course_units cu on cu.id = n.unit_id
  left join lateral public.rto_unit_outcome(p_student, n.unit_id) o on true
  left join mine m on m.course_id = n.course_id and m.unit_id = n.unit_id
  left join lateral (select t2.* from taken t2 where t2.course_id = n.course_id and t2.unit_id = n.unit_id order by t2.start_date desc limit 1) t on true)
 select coalesce(jsonb_agg(jsonb_build_object(
   'courseId', c.id, 'courseCode', c.code, 'courseName', c.name,
   'total', x.total, 'competent', x.competent, 'inProgress', x.in_progress, 'upcoming', x.upcoming, 'owed', x.owed, 'notYet', x.not_yet, 'awaiting', x.awaiting,
   'hoursTotal', x.hours_total, 'hoursDone', x.hours_done, 'percent', case when x.total = 0 then 0 else round(100.0 * x.competent / x.total) end,
   'units', x.units) order by c.code), '[]'::jsonb)
 from public.cms_courses c
 join lateral (select count(*) total, count(*) filter (where status = 'competent') competent, count(*) filter (where status = 'in_progress') in_progress,
   count(*) filter (where status = 'upcoming') upcoming, count(*) filter (where status = 'owed') owed, count(*) filter (where status = 'not_yet_competent') not_yet,
   count(*) filter (where status = 'awaiting_result') awaiting, sum(hours) hours_total, coalesce(sum(hours) filter (where status = 'competent'), 0) hours_done,
   jsonb_agg(jsonb_build_object('code', code, 'name', name, 'status', status, 'start', start_date, 'end', end_date, 'batch', batch, 'intake', intake, 'signedOn', signed_on, 'hours', hours)
    order by (status = 'competent'), start_date nulls last, code) units
   from rows where rows.course_id = c.id) x on x.total > 0;
$$;

commit;
