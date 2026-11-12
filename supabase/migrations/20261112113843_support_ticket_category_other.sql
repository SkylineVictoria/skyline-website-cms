-- TKT-01: add an "Other" category for support tickets. Applied on hosted 2026-11-12 as version 20261112113843.
alter table public.support_tickets drop constraint support_tickets_category_check;
alter table public.support_tickets add constraint support_tickets_category_check
  check (category in ('enrolment_documents','fees_payments','course_training','other'));

do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.support_ticket_create(text,text,text,text,jsonb,uuid)'::regprocedure);
  n := replace(d, $o$if p_category not in ('enrolment_documents','fees_payments','course_training') then$o$,
                  $o$if p_category not in ('enrolment_documents','fees_payments','course_training','other') then$o$);
  if n = d then raise exception 'support_ticket_create: category check not found, nothing changed'; end if;
  execute n;
end $mig$;
