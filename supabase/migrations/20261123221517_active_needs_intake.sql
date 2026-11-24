-- ACTIVE-NEEDS-INTAKE (owner, 2026-11-23): an application becomes Active only when its student is placed in an intake of the
-- application's course. The Take action menu opens "Activate in an intake" (intake + join date: day one or a unit start), which
-- places the student (rto_activate_in_intake -> rto_readd_to_intake) and then moves the status; without a placement the
-- database refuses Active (trigger a0_application_active_guard, any writer). Applications already Active are left alone.

create or replace function public.application_active_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') and not exists (
      select 1 from public.intake_enrolments e join public.course_intakes ci on ci.id = e.intake_id
       where e.student_id = new.student_id and e.status in ('active', 'deferred')
         and ci.course_id in (select c.course_id from public.enrollment_application_courses c where c.application_id = new.id)) then
    raise exception 'Choose an intake and a start date first: a student is Active only once placed in an intake of this course.' using errcode = '22023';
  end if;
  return new;
end $function$;

drop trigger if exists a0_application_active_guard on public.enrollment_applications;
create trigger a0_application_active_guard before insert or update of status on public.enrollment_applications
  for each row execute function public.application_active_guard();

-- What the Activate dialog offers: the application's student and course codes, and the open intakes with their join dates.
create or replace function public.rto_activate_options(p_application uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare a public.enrollment_applications;
begin
  if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then
    raise exception 'Only an Admin or an RTO Manager can activate a student in an intake.' using errcode = '42501';
  end if;
  select * into a from public.enrollment_applications where id = p_application;
  if a.id is null or a.student_id is null then raise exception 'This application has no student yet.' using errcode = '22023'; end if;
  return public.rto_readd_options(a.student_id) || jsonb_build_object('studentId', a.student_id,
    'courseCodes', coalesce((select jsonb_agg(distinct co.code) from public.enrollment_application_courses c
      join public.cms_courses co on co.id = c.course_id where c.application_id = a.id), '[]'::jsonb));
end $function$;

-- Places the application's student in the chosen intake from the chosen join date (the status is moved by the caller after).
create or replace function public.rto_activate_in_intake(p_application uuid, p_intake uuid, p_on date, p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare a public.enrollment_applications;
begin
  select * into a from public.enrollment_applications where id = p_application;
  if a.id is null or a.student_id is null then raise exception 'This application has no student yet.' using errcode = '22023'; end if;
  return public.rto_readd_to_intake(a.student_id, a.id, p_intake, coalesce(nullif(btrim(p_reason), ''), 'Activated in an intake'), p_on);
end $function$;

revoke execute on function public.rto_activate_options(uuid) from anon, public;
revoke execute on function public.rto_activate_in_intake(uuid, uuid, date, text) from anon, public;
grant execute on function public.rto_activate_options(uuid) to authenticated, service_role;
grant execute on function public.rto_activate_in_intake(uuid, uuid, date, text) to authenticated, service_role;
