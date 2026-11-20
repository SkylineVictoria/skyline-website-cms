-- Email Management > Account directory (owner 2026-11-21): Block sign-in / Allow sign-in (student-office365 signin_set, PATCH accountEnabled)
-- is logged in email_account_audit like the licence actions. email_account_skyline_blocked lists the accounts whose latest successful sign-in
-- action in Skyline was a block, so the directory shows them as blocked people (Allow sign-in offered), never as shared mailboxes.
alter table public.email_account_audit drop constraint if exists email_account_audit_action_check;
alter table public.email_account_audit add constraint email_account_audit_action_check
  check (action in ('licence_assigned', 'licence_removed', 'signin_blocked', 'signin_allowed'));

create or replace function public.email_account_skyline_blocked()
 returns text[] language plpgsql stable security definer set search_path to pg_catalog, public
as $$
begin
 perform public.admin_business_require();
 return coalesce((select array_agg(l.upn) from (
   select distinct on (lower(a.account_upn)) lower(a.account_upn) as upn, a.action
   from public.email_account_audit a
   where a.result = 'ok' and a.action in ('signin_blocked', 'signin_allowed')
   order by lower(a.account_upn), a.at desc, a.id desc) l
  where l.action = 'signin_blocked'), array[]::text[]);
end $$;
revoke all on function public.email_account_skyline_blocked() from public, anon;
grant execute on function public.email_account_skyline_blocked() to authenticated;
