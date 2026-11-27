do $$
declare d text := pg_get_functiondef('public.rto_batch_assign(uuid,text,uuid,text,date)'::regprocedure);
begin
  if position(' v_batch := public.rto_batch_pick(v_intake, null, v_on);' in d) = 0 then raise exception 'anchor not found'; end if;
  execute replace(d, ' v_batch := public.rto_batch_pick(v_intake, null, v_on);', ' v_batch := public.rto_batch_pick(v_intake, null, v_on, v_penrol is not null);');
end $$;