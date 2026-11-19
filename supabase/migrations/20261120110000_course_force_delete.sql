-- COURSE-FORCE-DELETE (owner, 2026-11-20): a course and its intakes go together. After a typed confirmation in LMS › Courses
-- the RTO Manager deletes the course: each of its intakes is deleted first through rto_admin('intake_delete') (its own checks
-- still apply: permanently allocated students, certificates, set assessments or final attendance stop it), the course is
-- taken off every application that chose it (any status; each unlink of an application past draft is written to
-- portal_audit_log), then its units and the course go. Assessments and unit outcomes still block. Additive: a new two-argument
-- rto_course_delete(text, boolean); the one-argument function (applications past draft block) is unchanged.
-- Rollback (manual): drop function public.rto_course_delete(text, boolean).
begin;

create or replace function public.rto_course_delete(p_course_id text, p_force boolean)
returns void language plpgsql security definer set search_path to '' as $function$
declare v_blockers text[] := '{}'; v_count integer; v_app record; v_code text; v_intake uuid;
begin
  if not public.cms_is_rto_manager() then
    raise exception 'Only an RTO Manager can delete courses.' using errcode = '42501';
  end if;
  select code into v_code from public.cms_courses where id = p_course_id for update;
  if not found then raise exception 'Course not found.' using errcode = 'P0002'; end if;

  if not coalesce(p_force, false) then
    select count(*) into v_count from public.course_intakes where course_id = p_course_id;
    if v_count > 0 then v_blockers := v_blockers || (v_count || ' intake' || case when v_count = 1 then '' else 's' end || ' (delete them first in LMS › Intakes)'); end if;
    select count(distinct eac.application_id) into v_count from public.enrollment_application_courses eac
      join public.enrollment_applications a on a.id = eac.application_id
     where eac.course_id = p_course_id and a.status <> 'draft';
    if v_count > 0 then v_blockers := v_blockers || (v_count || ' application' || case when v_count = 1 then '' else 's' end || ' past the draft stage'); end if;
  end if;
  select count(*) into v_count from public.asm_assessments a
   where a.course_id = p_course_id or a.unit_id in (select u.id from public.cms_course_units u where u.course_id = p_course_id);
  if v_count > 0 then v_blockers := v_blockers || (v_count || ' assessment' || case when v_count = 1 then '' else 's' end); end if;
  select count(*) into v_count from public.asm_unit_outcomes o
   where o.unit_id in (select u.id from public.cms_course_units u where u.course_id = p_course_id);
  if v_count > 0 then v_blockers := v_blockers || (v_count || ' unit outcome' || case when v_count = 1 then '' else 's' end); end if;
  if cardinality(v_blockers) > 0 then
    raise exception 'This course has % and cannot be deleted. Make it inactive instead.', array_to_string(v_blockers, ', ')
      using errcode = '23503';
  end if;

  -- The intakes go first, each with the intake delete's own checks.
  for v_intake in select id from public.course_intakes where course_id = p_course_id loop
    perform public.rto_admin('intake_delete', jsonb_build_object('intakeId', v_intake));
  end loop;

  -- Every application loses the course (one draft command per application, as the portal's course guard requires);
  -- the ones past draft are recorded.
  for v_app in select distinct eac.application_id as id, a.status from public.enrollment_application_courses eac
                 join public.enrollment_applications a on a.id = eac.application_id where eac.course_id = p_course_id loop
    perform set_config('portal.draft_command', v_app.id::text, true);
    delete from public.enrollment_application_courses where application_id = v_app.id and course_id = p_course_id;
    if v_app.status <> 'draft' then
      insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
      values (auth.uid(), '', 'rto_manager', 'course_force_deleted', 'course', p_course_id, v_app.id,
              jsonb_build_object('courseCode', v_code, 'applicationStatus', v_app.status));
    end if;
  end loop;
  perform set_config('portal.draft_command', '', true);

  delete from public.cms_course_units where course_id = p_course_id;
  delete from public.cms_courses where id = p_course_id;
end;
$function$;
revoke all on function public.rto_course_delete(text, boolean) from public, anon;
grant execute on function public.rto_course_delete(text, boolean) to authenticated;

commit;
