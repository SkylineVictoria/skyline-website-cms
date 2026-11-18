-- PREREQ-STARTED (owner, 2026-11-19): every student finishes all prerequisite units before studying anything else, whenever they join.
-- A prerequisite unit that has already STARTED when the student joins (not only one that has ended) counts as missed: the student
-- does the prerequisites first, from their start, in a later intake that teaches them, then returns to the running intake
-- (20261118234157). A student who joins on the intake's first day is unchanged (prerequisites are taught first). A prerequisite the
-- student is Competent in never counts. Patched in place: rto_prereq_missed, rto_enrolment_units (late-join and per-unit checks),
-- rto_batch_assign (which prerequisites to take first). Rollback (manual): replace "start_date <" back with "end_date <" in those spots.
do $$
declare d text;
begin
 d := pg_get_functiondef('public.rto_prereq_missed(uuid,uuid,date)'::regprocedure);
 if position('p.end_date < p_on' in d) > 0 then execute replace(d, 'p.end_date < p_on', 'p.start_date < p_on'); end if;
 d := pg_get_functiondef('public.rto_enrolment_units(uuid)'::regprocedure);
 if position('p.end_date < e.enrolled_on' in d) > 0 then execute replace(d, 'p.end_date < e.enrolled_on', 'p.start_date < e.enrolled_on'); end if;
 d := pg_get_functiondef('public.rto_batch_assign(uuid,text,uuid,text,date)'::regprocedure);
 if position('p.end_date < v_on' in d) > 0 or position('p.end_date < v_return' in d) > 0 then
  execute replace(replace(d, 'p.end_date < v_on', 'p.start_date < v_on'), 'p.end_date < v_return', 'p.start_date < v_return');
 end if;
end $$;
