-- READD-TO-INTAKE (owner, 2026-11-23: "Re-add to intake button will solve everything"): when a course was deleted and created
-- again, its students lost their course link and their intake place. On the CMS student page an Admin or RTO Manager picks one of
-- the student's applications and an open intake; the application is linked to that intake's course and intake again (its stale
-- course rows are replaced) and the student is placed by hand through rto_staff_place (reason kept in rto_placement_overrides),
-- joining today or on the intake's first day. Linking the existing application first stops rto_staff_place from creating a
-- second application.
-- Rollback: drop function public.rto_readd_options(uuid), public.rto_readd_to_intake(uuid, uuid, uuid, text);
begin;

-- What the button offers: the student's applications (with the course they still point at, if any) and every open intake.
create or replace function public.rto_readd_options(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
        'courseName', co.name, 'startDate', i.start_date, 'endDate', i.end_date, 'load', coalesce(i.study_load, 'coe')) order by co.code, i.start_date)
      from public.course_intakes i join public.cms_courses co on co.id = i.course_id
      where i.status in ('open', 'full') and (i.end_date is null or i.end_date >= public.course_intake_today())), '[]'::jsonb));
end $$;
revoke all on function public.rto_readd_options(uuid) from public, anon;
grant execute on function public.rto_readd_options(uuid) to authenticated;

create or replace function public.rto_readd_to_intake(p_student uuid, p_application uuid, p_intake uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; i public.course_intakes; co public.cms_courses;
begin
  if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then
    raise exception 'Only an Admin or an RTO Manager can re-add a student to an intake.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are re-adding this student.' using errcode = '22023'; end if;
  select * into a from public.enrollment_applications where id = p_application and student_id = p_student;
  if a.id is null then raise exception 'Choose one of this student''s applications.' using errcode = '22023'; end if;
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null then raise exception 'Choose an intake.' using errcode = '22023'; end if;
  select * into co from public.cms_courses where id = i.course_id;
  -- The application points at this course and intake again: its rows for courses that no longer exist (or this course) are replaced.
  delete from public.enrollment_application_courses c where c.application_id = a.id
    and (c.course_id = co.id or not exists (select 1 from public.cms_courses x where x.id = c.course_id));
  insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id, tenant_id)
  values (a.id, co.id, co.code, co.name, i.id, a.tenant_id);
  return public.rto_staff_place(i.id, p_student, case when coalesce(i.study_load, 'coe') = 'voe' then 'VoE' else 'CoE' end,
    greatest(public.course_intake_today(), i.start_date), btrim(p_reason));
end $$;
revoke all on function public.rto_readd_to_intake(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.rto_readd_to_intake(uuid, uuid, uuid, text) to authenticated;

commit;
