-- READD-JOIN-DATES (owner, 2026-11-23): Re-add to intake lets staff pick the join date from the intake's day one and
-- every unit start date (today onwards, within the intake), as the application form does (course_join_options).
-- rto_readd_options returns joinDates per intake; rto_readd_to_intake takes an optional p_on (null = today or day one).

create or replace function public.rto_readd_options(p_student uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_today date := public.course_intake_today();
begin
  if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then
    raise exception 'Only an Admin or an RTO Manager can re-add a student to an intake.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'applications', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'reference', a.reference, 'status', a.status,
        'courseCode', (select c.course_code from public.enrollment_application_courses c join public.cms_courses co on co.id = c.course_id
                       where c.application_id = a.id order by c.created_at limit 1)) order by a.created_at desc)
      from public.enrollment_applications a where a.student_id = p_student and a.status not in ('draft', 'withdrawn', 'rejected')), '[]'::jsonb),
    'intakes', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', public.intake_group_name(i.id), 'courseCode', co.code,
        'courseName', co.name, 'startDate', i.start_date, 'endDate', i.end_date, 'load', coalesce(i.study_load, 'coe'),
        'joinDates', coalesce((
          select jsonb_agg(jsonb_build_object('date', s.d, 'firstDay', s.d = i.start_date, 'unitCode', cu.code, 'unitName', cu.name) order by s.d)
          from (select distinct z.d from (select i.start_date d union all select u.start_date from public.intake_units u where u.intake_id = i.id) z
                 where z.d is not null and z.d >= v_today and (i.end_date is null or z.d <= i.end_date)) s
          left join lateral (select u.unit_id from public.intake_units u where u.intake_id = i.id and u.start_date = s.d order by u.sort, u.id limit 1) fu on true
          left join public.cms_course_units cu on cu.id = fu.unit_id), '[]'::jsonb)) order by co.code, i.start_date)
      from public.course_intakes i join public.cms_courses co on co.id = i.course_id
      where i.status in ('open', 'full') and (i.end_date is null or i.end_date >= v_today)), '[]'::jsonb));
end $function$;

drop function if exists public.rto_readd_to_intake(uuid, uuid, uuid, text);

create or replace function public.rto_readd_to_intake(p_student uuid, p_application uuid, p_intake uuid, p_reason text, p_on date default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare a public.enrollment_applications; i public.course_intakes; co public.cms_courses; v_on date;
begin
  if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then
    raise exception 'Only an Admin or an RTO Manager can re-add a student to an intake.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are re-adding this student.' using errcode = '22023'; end if;
  select * into a from public.enrollment_applications where id = p_application and student_id = p_student;
  if a.id is null then raise exception 'Choose one of this student''s applications.' using errcode = '22023'; end if;
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null then raise exception 'Choose an intake.' using errcode = '22023'; end if;
  v_on := coalesce(p_on, greatest(public.course_intake_today(), i.start_date));
  if v_on < public.course_intake_today() then raise exception 'Choose a join date from today onwards.' using errcode = '22023'; end if;
  if v_on < i.start_date or (i.end_date is not null and v_on > i.end_date) then
    raise exception 'Choose a join date inside the intake (% – %).', i.start_date, coalesce(i.end_date::text, 'open') using errcode = '22023';
  end if;
  select * into co from public.cms_courses where id = i.course_id;
  -- The application points at this course and intake again: its rows for courses that no longer exist (or this course) are replaced.
  delete from public.enrollment_application_courses c where c.application_id = a.id
    and (c.course_id = co.id or not exists (select 1 from public.cms_courses x where x.id = c.course_id));
  insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id, tenant_id)
  values (a.id, co.id, co.code, co.name, i.id, a.tenant_id);
  return public.rto_staff_place(i.id, p_student, case when coalesce(i.study_load, 'coe') = 'voe' then 'VoE' else 'CoE' end,
    v_on, btrim(p_reason));
end $function$;

grant execute on function public.rto_readd_to_intake(uuid, uuid, uuid, text, date) to authenticated, service_role;
revoke execute on function public.rto_readd_to_intake(uuid, uuid, uuid, text, date) from anon, public;
