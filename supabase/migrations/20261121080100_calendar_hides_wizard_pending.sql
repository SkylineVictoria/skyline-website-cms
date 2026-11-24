-- The admin calendar does not show classes of an intake the course wizard has not finished.
do $$ declare d text; a text := E'join public.course_intakes ci on ci.id = cs.intake_id\n      where cs.session_date between'; begin
 d := pg_get_functiondef('public.admin_class_calendar(date,date,jsonb)'::regprocedure);
 if position(a in d)=0 then raise exception 'anchor not found in admin_class_calendar'; end if;
 execute replace(d, a, E'join public.course_intakes ci on ci.id = cs.intake_id and not ci.wizard_pending\n      where cs.session_date between');
end $$;
