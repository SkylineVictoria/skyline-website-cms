-- SUBMITTED-NEEDS-SIGNATURE (owner 2026-11-27, live bug: a SLIT admin could "Set to Submitted" with no student signature): only a
-- student-signed application becomes Submitted (under 18: the student and their parent or guardian).
--  * skyline_private.application_finalize is the only signed path: it runs after the student signs (skyline_private.student_sign, adults)
--    or after the guardian signs (public.portal_guardian_sign, under 18) and now marks its own update (portal.signed_submit).
--  * trigger a0_application_submitted_signed: an application becomes Submitted from Draft or Action required (or is inserted as
--    Submitted) only through that path. From any other status (an admin's "Set to" undoing a later move) only when its last signed
--    submission is newer than its last return to Draft or Action required, i.e. what is Submitted is what the student signed.
-- Any writer, any role. Earlier rows are never re-checked. Down: drop the trigger and function, restore application_finalize from
-- 20261125190517 (remove the two set_config('portal.signed_submit', ...) lines).

do $$
declare d text;
  a1 constant text := $a$perform set_config('portal.status_command',a.id::text,true);$a$;
  a2 constant text := $a$perform set_config('portal.status_command', a.id::text, true);$a$;
begin
  d := pg_get_functiondef('skyline_private.application_finalize(uuid,uuid,text,text,text,jsonb,text)'::regprocedure);
  if (length(d) - length(replace(d, a1, ''))) / length(a1) <> 1 then raise exception 'anchor (submit) not found once in application_finalize'; end if;
  if (length(d) - length(replace(d, a2, ''))) / length(a2) <> 1 then raise exception 'anchor (resubmit) not found once in application_finalize'; end if;
  d := replace(d, a1, a1 || $b$ perform set_config('portal.signed_submit', a.id::text, true);$b$);
  d := replace(d, a2, a2 || $b$ perform set_config('portal.signed_submit', a.id::text, true);$b$);
  execute d;
end $$;

create or replace function public.application_submitted_needs_signature() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_signed timestamptz; v_back timestamptz;
begin
  if new.status is distinct from 'submitted' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'submitted' then return new; end if;
  -- the signed path (the student's signature, and the guardian's for an under-18 student)
  if current_setting('portal.signed_submit', true) = new.id::text then return new; end if;
  if tg_op = 'UPDATE' and old.status not in ('draft', 'action_required') then
    -- back to Submitted from a later status: only what the student last signed
    select max(created_at) into v_signed from public.enrollment_application_versions where application_id = new.id;
    select max(created_at) into v_back from public.enrollment_application_status_history where application_id = new.id and new_status in ('draft', 'action_required');
    if v_signed is not null and (v_back is null or v_signed >= v_back) then return new; end if;
  end if;
  raise exception 'Only the student can submit this application, by signing it (under 18: with their parent or guardian). Send it to the student to sign.'
    using errcode = '42501';
end $$;
revoke all on function public.application_submitted_needs_signature() from public, anon, authenticated;

create trigger a0_application_submitted_signed
  before insert or update of status on public.enrollment_applications
  for each row execute function public.application_submitted_needs_signature();
