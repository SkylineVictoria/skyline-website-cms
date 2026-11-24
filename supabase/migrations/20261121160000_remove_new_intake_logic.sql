-- NO NEW INTAKES BUT THE COURSE WIZARD (owner, 2026-11-21): a course has one CoE and one VoE intake, created when its wizard is finished. They never
-- end: they are extended through the master cycles. So nothing else may create an intake: the rolling next-intake job, the automatic next-intake
-- (rto_intake_auto_next), the next-month intake of course_intakes_open, the old course_intakes_admin insert, intake_duplicate and intake_save
-- without the wizard flag are all switched off. Existing intakes and students are untouched.
do $$ begin
 if exists (select 1 from pg_extension where extname = 'pg_cron') then
  perform cron.unschedule(jobid) from cron.job where jobname = 'rto-intake-rolling';
 end if;
end $$;

create or replace function public.rto_intake_rolling_sweep() returns integer language sql as $$ select 0 $$;
create or replace function public.rto_intake_auto_next(p_intake uuid) returns uuid language sql as $$ select null::uuid $$;

do $$
declare d text; a text;
begin
 -- course_intakes_open: no automatic next-month intake
 a := 'if not exists (select 1 from public.course_intakes where course_id = v_cid and start_date = v_start) then';
 d := pg_get_functiondef('public.course_intakes_open(text)'::regprocedure);
 if position(a in d) = 0 then raise exception 'anchor not found in course_intakes_open'; end if;
 execute replace(d, a, 'if false and not exists (select 1 from public.course_intakes where course_id = v_cid and start_date = v_start) then');
 -- course_intakes_admin and rto_course_flow (intake_duplicate): no insert
 foreach a in array array['public.course_intakes_admin(text,text,uuid,jsonb)', 'public.rto_course_flow(text,jsonb)'] loop
  d := pg_get_functiondef(a::regprocedure);
  if position('insert into public.course_intakes' in d) = 0 then raise exception 'anchor not found in %', a; end if;
  execute replace(d, 'insert into public.course_intakes', 'raise exception ''Intakes are created only by the course wizard.'' using errcode = ''42501''; insert into public.course_intakes');
 end loop;
 -- intake_save: only the course wizard creates an intake
 a := 'if coalesce((d->>''wizard'')::boolean, false) is not true and not public.course_wizard_finished(v_course) then';
 d := pg_get_functiondef('public.rto_admin(text,jsonb)'::regprocedure);
 if position(a in d) = 0 then raise exception 'anchor not found in rto_admin'; end if;
 execute replace(d, a, 'if coalesce((d->>''wizard'')::boolean, false) is not true then raise exception ''Intakes are created only when the course wizard is finished.'' using errcode = ''22023''; end if; if false then');
end $$;
