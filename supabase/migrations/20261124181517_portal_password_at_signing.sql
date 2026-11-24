-- PORTAL-PASSWORD-AT-SIGNING (owner, 2026-11-24: "while signing the application we must create his password so he can log in with the
-- same email and password with his workspace in future"): the agency admin chooses their agent portal password on the signing page; the
-- signing function (document-signing) makes their Auth account then. At approval the invitation is unlocked at once (the signing link,
-- emailed to that address, already proved the email), so signing in with the email and password opens the workspace; the email says
-- "sign in" instead of sending a set-password link. Service role only.
-- Rollback: drop function public.portal_invitation_preconfirm(uuid).
begin;

create or replace function public.portal_invitation_preconfirm(p_invitation uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.agency_invitations set link_confirmed_at = coalesce(link_confirmed_at, now())
   where id = p_invitation and status = 'pending';
  return found;
end $$;
revoke all on function public.portal_invitation_preconfirm(uuid) from public, anon, authenticated;
grant execute on function public.portal_invitation_preconfirm(uuid) to service_role;

commit;
