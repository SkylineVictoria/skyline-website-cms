-- portal-self-register shows the database message only for 22023-type errors; use that code for the agent refusal.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.portal_self_register(text,jsonb)'::regprocedure);
  n := replace(d, $o$Please contact Skyline to become a registered agent.' using errcode = '42501'$o$, $o$Please contact Skyline to become a registered agent.' using errcode = '22023'$o$);
  if n = d then raise exception 'anchor not found'; end if;
  execute n;
end $mig$;
