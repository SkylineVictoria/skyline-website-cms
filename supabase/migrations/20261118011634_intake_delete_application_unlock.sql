do $$
declare d text := pg_get_functiondef('public.rto_admin(text,jsonb)'::regprocedure);
 a text := '  update public.enrollment_application_courses set intake_id = null where intake_id = v_id;';
 b text := '  for x in select distinct to_jsonb(ac.application_id) as v from public.enrollment_application_courses ac where ac.intake_id = v_id loop
   perform set_config(''portal.draft_command'', x #>> ''{}'', true);
   update public.enrollment_application_courses set intake_id = null where intake_id = v_id and application_id = (x #>> ''{}'')::uuid;
  end loop;
  perform set_config(''portal.draft_command'', '''', true);';
begin
 if position('portal.draft_command'', x' in d) > 0 then return; end if;
 if position(a in d) = 0 then raise exception 'rto_admin intake_delete application line not found'; end if;
 execute replace(d, a, b);
end $$;