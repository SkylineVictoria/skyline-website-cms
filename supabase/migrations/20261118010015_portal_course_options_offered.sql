do $$
declare d text := pg_get_functiondef('public.portal_course_options'::regproc::oid);
 a text := 'and (c.status = ''Published'' or exists (select 1 from public.course_intakes i
     where i.course_id = c.id and i.is_active and i.start_date >= public.course_intake_today()));';
begin
 if position(a in d) = 0 then raise exception 'anchor not found'; end if;
 execute replace(d, a, 'and (c.status = ''Published'' or exists (select 1 from public.course_intake_offered(c.id)));');
end $$;