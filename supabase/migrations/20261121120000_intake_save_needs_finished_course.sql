-- A new intake is refused for a course whose wizard is not finished (weekly and daily calendars, CoE and VoE); the course wizard itself
-- creates its intakes with wizard = true (they stay hidden until the wizard ends).
do $$
declare d text; a constant text := 'if nullif(d->>''startDate'', '''') is null then raise exception ''Choose a start date.'' using errcode = ''22023''; end if;';
begin
 d := pg_get_functiondef('public.rto_admin(text,jsonb)'::regprocedure);
 if position(a in d) = 0 then raise exception 'anchor not found in rto_admin'; end if;
 execute replace(d, a, a || E'\n   if coalesce((d->>''wizard'')::boolean, false) is not true and not public.course_wizard_finished(v_course) then raise exception ''Finish this course''''s wizard first (CoE and VoE weekly calendars and daily timetables), then add intakes.'' using errcode = ''22023''; end if;');
end $$;
