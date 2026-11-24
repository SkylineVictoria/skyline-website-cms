-- course_join_options also says whether each start date belongs to a CoE or a VoE intake (studyLoad), so the application form can ask
-- CoE or VoE first and then show the next three unit starts.
do $$
declare d text; a constant text := '''unitCode'', cu.code,';
begin
 d := pg_get_functiondef('public.course_join_options(text)'::regprocedure);
 if position(a in d) = 0 then raise exception 'anchor not found in course_join_options'; end if;
 execute replace(d, a, '''studyLoad'', i.study_load, ' || a);
end $$;
