-- The list alias "r" clashed with the loop variable r in support_ticket_email_after_message.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.support_ticket_email_after_message()'::regprocedure);
  n := replace(d,
    $o$select r.email, true from public.support_notification_recipients r$o$,
    $o$select nr.email, true from public.support_notification_recipients nr$o$);
  if n = d then raise exception 'alias not found, nothing changed'; end if;
  execute n;
end $mig$;
