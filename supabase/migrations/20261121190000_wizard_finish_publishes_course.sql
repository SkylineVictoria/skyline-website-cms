-- Finishing the course wizard makes the course go live (owner rule lms.course_auto_go_live): the classes were made while the intakes were still
-- hidden, so the go-live trigger on class_sessions found the course incomplete and never published it, and the application form listed no course.
-- `finish` now publishes the course once its setup is complete, and any course already complete is published now.
do $$
declare d text; a constant text := E'where course_id = v_course and wizard_pending;\n  return jsonb_build_object(''ok'', true);';
begin
 d := pg_get_functiondef('public.rto_intake_wizard(text,jsonb)'::regprocedure);
 if position(a in d) = 0 then raise exception 'anchor not found in rto_intake_wizard'; end if;
 execute replace(d, a, E'where course_id = v_course and wizard_pending;\n  update public.cms_courses c set status = ''Published'', is_active = true where c.id = v_course and (c.status is distinct from ''Published'' or not c.is_active)\n   and public.course_setup_complete(c.id) and public.rule_bool(''lms.course_auto_go_live'', true);\n  return jsonb_build_object(''ok'', true);');
end $$;

update public.cms_courses c set status = 'Published', is_active = true
 where (c.status is distinct from 'Published' or not c.is_active) and public.course_setup_complete(c.id) and public.rule_bool('lms.course_auto_go_live', true);
