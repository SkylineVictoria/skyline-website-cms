-- COURSE-LIST-OFFERED (2026-11-19): the application wizard's course list (portal_course_options) offers a course that is published on
-- the website or has an intake the form would offer (course_intake_offered: running today or the next one), the same rule as the
-- intake dropdown (20261118214419). Before, a course whose only intake was already running was left out. Patched in place.
-- Rollback (manual): put back "exists (select 1 from course_intakes i where i.course_id = c.id and i.is_active and
-- i.start_date >= course_intake_today())".
do $$
declare d text := pg_get_functiondef('public.portal_course_options'::regproc::oid);
 a text := 'and (c.status = ''Published'' or exists (select 1 from public.course_intakes i
     where i.course_id = c.id and i.is_active and i.start_date >= public.course_intake_today()));';
begin
 if position('course_intake_offered' in d) > 0 then return; end if;
 if position(a in d) = 0 then raise exception 'anchor not found'; end if;
 execute replace(d, a, 'and (c.status = ''Published'' or exists (select 1 from public.course_intake_offered(c.id)));');
end $$;
