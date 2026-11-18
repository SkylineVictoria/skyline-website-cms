-- COURSE-NEEDS-INTAKE (owner, 2026-11-19): a course cannot work without an intake. A course is made Published (website and
-- enrolment form) or Active (LMS) only when it has active units and at least one open intake (active, not closed or draft, not
-- ended). Changing an existing course to Published / Active without them is refused with what is missing; a course inserted as
-- Published / Active without them (an import) is stored as Draft and inactive instead, since a new course has no intake yet.
-- A course that is already Published / Active is not changed when its intakes later close. Applies to every path that saves
-- cms_courses (website editor cms_commit, LMS course save, imports). Additive: one function, one trigger.
-- Rollback (manual): drop trigger cms_courses_needs_intake on public.cms_courses; drop function public.cms_course_needs_intake().
begin;

create or replace function public.cms_course_ready_problem(p_course text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from public.cms_course_units u where u.course_id = p_course and u.is_active) then 'it has no units yet'
    when not exists (select 1 from public.course_intakes i where i.course_id = p_course and i.is_active
                       and coalesce(i.status, 'open') not in ('closed', 'draft')
                       and coalesce(i.end_date, i.start_date) >= public.course_intake_today()) then 'it has no open intake yet'
  end;
$$;

create or replace function public.cms_course_needs_intake() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_problem text;
begin
  if not (new.status = 'Published' and (tg_op = 'INSERT' or old.status is distinct from 'Published'))
     and not (new.is_active and (tg_op = 'INSERT' or not coalesce(old.is_active, false))) then
    return new;
  end if;
  v_problem := public.cms_course_ready_problem(new.id);
  if v_problem is null then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'Draft'; new.is_active := false;
    return new;
  end if;
  raise exception '% cannot be published or made active: % (add units and an intake first).', coalesce(nullif(new.code, ''), 'This course'), v_problem
    using errcode = '23514';
end;
$$;

drop trigger if exists cms_courses_needs_intake on public.cms_courses;
create trigger cms_courses_needs_intake before insert or update of status, is_active on public.cms_courses
  for each row execute function public.cms_course_needs_intake();

revoke all on function public.cms_course_ready_problem(text), public.cms_course_needs_intake() from public, anon;
grant execute on function public.cms_course_ready_problem(text) to authenticated;

commit;
