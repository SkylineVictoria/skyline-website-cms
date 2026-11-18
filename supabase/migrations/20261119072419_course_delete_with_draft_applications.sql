-- COURSE-DELETE-APPLICATIONS (owner, 2026-11-19): a course chosen on applications can be deleted while those applications are still
-- drafts: the course is taken off each draft (the applicant chooses a course again), then the course and its units are deleted.
-- Still refused when an application with the course is past draft (offer accepted onwards), the course has intakes (delete them
-- first), or assessments / unit outcomes exist. Additive (function replaced in place).
-- Rollback (manual): restore rto_course_delete from pg_get_functiondef before this migration (applications blocked deletion).
begin;

create or replace function public.rto_course_delete(p_course_id text)
returns void language plpgsql security definer set search_path to '' as $function$
declare v_blockers text[] := '{}'; v_count integer; v_app uuid;
begin
  if not public.cms_is_rto_manager() then
    raise exception 'Only an RTO Manager can delete courses.' using errcode = '42501';
  end if;
  perform 1 from public.cms_courses where id = p_course_id for update;
  if not found then raise exception 'Course not found.' using errcode = 'P0002'; end if;

  select count(*) into v_count from public.course_intakes where course_id = p_course_id;
  if v_count > 0 then v_blockers := v_blockers || (v_count || ' intake' || case when v_count = 1 then '' else 's' end || ' (delete them first in LMS › Intakes)'); end if;
  select count(distinct eac.application_id) into v_count from public.enrollment_application_courses eac
    join public.enrollment_applications a on a.id = eac.application_id
   where eac.course_id = p_course_id and a.status <> 'draft';
  if v_count > 0 then v_blockers := v_blockers || (v_count || ' application' || case when v_count = 1 then '' else 's' end || ' past the draft stage'); end if;
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

  -- Draft applications lose the course (one draft command per application, as the portal's course guard requires).
  for v_app in select distinct application_id from public.enrollment_application_courses where course_id = p_course_id loop
    perform set_config('portal.draft_command', v_app::text, true);
    delete from public.enrollment_application_courses where application_id = v_app and course_id = p_course_id;
  end loop;
  perform set_config('portal.draft_command', '', true);

  delete from public.cms_course_units where course_id = p_course_id;
  delete from public.cms_courses where id = p_course_id;
end;
$function$;

commit;
