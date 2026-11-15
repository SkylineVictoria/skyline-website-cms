-- COURSE-DELETE: an RTO Manager can delete a course that nothing depends on yet (e.g. a test import).
-- A course with intakes, applications or assessments is refused; it should be made inactive instead.
-- Its units go with it (cms_course_units has no cascading course FK); sections, links, attachments, fees,
-- timing templates and sign template units cascade; catalogue and question bank links are set null.

create or replace function public.rto_course_delete(p_course_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_blockers text[] := '{}'; v_count integer;
begin
  if not public.cms_is_rto_manager() then
    raise exception 'Only an RTO Manager can delete courses.' using errcode = '42501';
  end if;
  perform 1 from public.cms_courses where id = p_course_id for update;
  if not found then raise exception 'Course not found.' using errcode = 'P0002'; end if;

  select count(*) into v_count from public.course_intakes where course_id = p_course_id;
  if v_count > 0 then v_blockers := v_blockers || (v_count || ' intake' || case when v_count = 1 then '' else 's' end); end if;
  select count(*) into v_count from public.enrollment_application_courses where course_id = p_course_id;
  if v_count > 0 then v_blockers := v_blockers || (v_count || ' application' || case when v_count = 1 then '' else 's' end); end if;
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

  delete from public.cms_course_units where course_id = p_course_id;
  delete from public.cms_courses where id = p_course_id;
end;
$$;
revoke all on function public.rto_course_delete(text) from public, anon;
grant execute on function public.rto_course_delete(text) to authenticated;
