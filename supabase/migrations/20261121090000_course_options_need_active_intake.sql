-- The application form lists only courses that have an active intake on offer (running now or the next one), whatever their status.
do $$
declare d text; a constant text := 'and (c.status = ''Published'' or (not public.rule_bool(''admissions.applications_require_published_course'', true) and public.course_has_open_intake(c.id)));';
begin
 d := pg_get_functiondef('public.portal_course_options()'::regprocedure);
 if position(a in d) = 0 then raise exception 'anchor not found in portal_course_options'; end if;
 execute replace(d, a, 'and (c.status = ''Published'' or not public.rule_bool(''admissions.applications_require_published_course'', true)) and public.course_has_open_intake(c.id);');
end $$;
