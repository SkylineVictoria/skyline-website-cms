-- ACTIVATE-IN-INTAKE fix (owner 2026-11-25): Activate in an intake (rto_activate_in_intake -> rto_readd_to_intake) failed with
-- "Use the versioned draft command for courses": the application's course row is replaced (pointed at the chosen intake) and the
-- guard portal_course_command_only refuses that unless portal.draft_command names the application, as rto_direct_application does.
-- Same function as 20261123211517 plus that setting around the course-row change.
-- Down: re-run rto_readd_to_intake from 20261123211517.
begin;

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
  -- The course rows of an application change only through the versioned draft command (portal_course_command_only):
  -- this staff placement is that command for this one application.
  perform set_config('portal.draft_command', a.id::text, true);
  delete from public.enrollment_application_courses c where c.application_id = a.id
    and (c.course_id = co.id or not exists (select 1 from public.cms_courses x where x.id = c.course_id));
  insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id, tenant_id)
  values (a.id, co.id, co.code, co.name, i.id, a.tenant_id);
  perform set_config('portal.draft_command', '', true);
  return public.rto_staff_place(i.id, p_student, case when coalesce(i.study_load, 'coe') = 'voe' then 'VoE' else 'CoE' end,
    v_on, btrim(p_reason));
end $function$;

grant execute on function public.rto_readd_to_intake(uuid, uuid, uuid, text, date) to authenticated, service_role;
revoke execute on function public.rto_readd_to_intake(uuid, uuid, uuid, text, date) from anon, public;

commit;
