-- Records may now share an email across roles, but a portal login (one auth user -> one membership)
-- still holds a single role, and accepting an invite overwrites the membership role.
-- Stop a pending invite from silently turning an active agent login into a student login (or the reverse).
create or replace function public.portal_invite_login_role_guard()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare v_email text := lower(btrim(coalesce(new.email, ''))); v_role text;
begin
  if new.status <> 'pending' or v_email = '' then return new; end if;
  select m.role into v_role
  from auth.users u
  join public.portal_profiles p on p.auth_user_id = u.id
  join public.agency_memberships m on m.user_id = p.id
  where lower(u.email) = v_email and m.status = 'Active' and p.status = 'Active'
  limit 1;
  if v_role is not null
     and (case when v_role = 'student' then 'student' else 'agent' end)
      <> (case when new.role = 'student' then 'student' else 'agent' end) then
    raise exception 'This email already signs in to the portal as %. One login can have only one portal role, so use a different email for this invite.',
      case when v_role = 'student' then 'a student' else 'an agent' end
      using errcode = '23505', hint = 'login_role_conflict';
  end if;
  return new;
end $$;
revoke all on function public.portal_invite_login_role_guard() from public, anon, authenticated;

drop trigger if exists portal_invite_login_role_guard on public.agency_invitations;
create trigger portal_invite_login_role_guard before insert or update of email, status, role on public.agency_invitations
  for each row execute function public.portal_invite_login_role_guard();
