-- Agency registration is by invitation only for now: the public sign-up and the post-sign-in agency form refuse agents.
-- Applied on hosted 2026-11-12 as version 20261112112500 (message code adjusted by 20261112112514).
do $mig$
declare d text; n text;
  msg constant text := 'Agency registration is by invitation only. Please contact Skyline to become a registered agent.';
begin
  d := pg_get_functiondef('public.portal_self_register(text,jsonb)'::regprocedure);
  n := replace(d,
    $o$if p_kind is null or p_kind not in ('student', 'agent') then raise exception 'Unknown enrolment type.' using errcode = '22023'; end if;$o$,
    $o$if p_kind is null or p_kind not in ('student', 'agent') then raise exception 'Unknown enrolment type.' using errcode = '22023'; end if;$o$
      || E'\r\n if p_kind = ''agent'' then raise exception ''' || msg || ''' using errcode = ''42501''; end if;');
  if n = d then raise exception 'portal_self_register: anchor not found, nothing changed'; end if;
  execute n;

  d := pg_get_functiondef('public.portal_self_register_agent_complete(jsonb)'::regprocedure);
  n := replace(d,
    $o$if v_uid is null then raise exception 'Sign in required' using errcode = '42501'; end if;$o$,
    $o$if v_uid is null then raise exception 'Sign in required' using errcode = '42501'; end if;$o$
      || E'\r\n raise exception ''' || msg || ''' using errcode = ''42501'';');
  if n = d then raise exception 'portal_self_register_agent_complete: anchor not found, nothing changed'; end if;
  execute n;
end $mig$;
