-- STUDENT-PROGRESS (2026-11-18): how much of the course a student has finished and what is left, for the CMS student page and the student's own
-- My learning page, plus the student's dated classes for the CMS. Read only. Additive.
-- Units are every unit of the intakes the student is placed in. Status of each: competent (latest result C), not yet competent (a later result
-- other than C and no new place for it), awaiting result (taught, no result yet), in progress / upcoming (this student takes it, by date), or
-- owed (not in any placement yet; the rolling carry-over places it in the next intake).
create function public.student_progress_core(p_student uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 with en as (
  select e.id, b.name as batch, public.course_intake_name(ci) as intake, ci.course_id, ci.id as intake_id
  from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
  where e.student_id = p_student and e.status in ('active', 'deferred', 'completed')),
 needed as (select distinct en.course_id, iu.unit_id from en join public.intake_units iu on iu.intake_id = en.intake_id),
 taken as (select en.course_id, u.unit_id, u.start_date, u.end_date, en.batch, en.intake from en cross join lateral public.rto_enrolment_units(en.id) u),
 rows as (
  select n.course_id, cu.id as unit_id, cu.code, cu.name, coalesce(cu.nominal_hours, 0) as hours, o.signed_on, t.start_date, t.end_date, t.batch, t.intake,
   case when o.outcome = 'C' then 'competent'
        when t.unit_id is not null and t.start_date > public.course_intake_today() then 'upcoming'
        when t.unit_id is not null and t.end_date >= public.course_intake_today() then 'in_progress'
        when o.outcome is not null then 'not_yet_competent'
        when t.unit_id is not null then 'awaiting_result'
        else 'owed' end as status
  from needed n join public.cms_course_units cu on cu.id = n.unit_id
  left join lateral public.rto_unit_outcome(p_student, n.unit_id) o on true
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

create function public.admin_student_progress(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 return public.student_progress_core(p_student);
end $$;

create function public.student_my_progress() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_student uuid := public.portal_student_id();
begin
 if v_student is null then raise exception 'Student access required' using errcode = '42501'; end if;
 return public.student_progress_core(v_student);
end $$;

-- The student's dated classes (as the student sees them in My timetable), for staff.
create function public.admin_student_schedule(p_student uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Choose up to a year' using errcode = '22023'; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object('date', cs.session_date, 'start', to_char(cs.start_time, 'HH24:MI'), 'end', to_char(cs.end_time, 'HH24:MI'), 'type', cs.session_type,
    'status', cs.status, 'batch', b.name, 'courseCode', c.code, 'unitCode', u.code, 'unitName', u.name, 'room', r.name) order by cs.session_date, cs.start_time)
  from public.class_sessions cs join public.batches b on b.id = cs.batch_id join public.course_intakes ci on ci.id = b.intake_id
  join public.cms_courses c on c.id = ci.course_id left join public.cms_course_units u on u.id = cs.unit_id left join public.classrooms r on r.id = cs.room_id
  where cs.session_date between p_from and p_to
   and exists (select 1 from public.batch_enrolments e where e.batch_id = b.id and e.student_id = p_student and e.status in ('active', 'deferred')
    and (cs.unit_id is null or exists (select 1 from public.rto_enrolment_units(e.id) eu where eu.unit_id = cs.unit_id)))), '[]'::jsonb);
end $$;

revoke all on function public.student_progress_core(uuid) from public, anon, authenticated;
revoke all on function public.admin_student_progress(uuid), public.student_my_progress(), public.admin_student_schedule(uuid, date, date) from public, anon;
grant execute on function public.admin_student_progress(uuid), public.student_my_progress(), public.admin_student_schedule(uuid, date, date) to authenticated;
