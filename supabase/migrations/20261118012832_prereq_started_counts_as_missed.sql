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