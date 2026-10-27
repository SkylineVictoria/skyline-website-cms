-- Migration 89: server-side input rules for agency invitations. Same signature and behaviour as migration 86's
-- portal_invitation_create, plus: the name is required, 2-100 characters and free of control characters; the email is
-- trimmed, lower-cased, at most 254 characters and free of control characters. portal_agency_create_with_admin calls this
-- function, so the first-admin invitation is covered too. Additive (create or replace); local only until released.
-- Rollback: re-create portal_invitation_create from 20261027000000_agency_invitations_and_scoped_user_admin.sql.
begin;

create or replace function public.portal_invitation_create(p_actor uuid, p_agency uuid, p_email text, p_name text, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb := public.portal_actor_context(p_actor); v_agency uuid; v_email text := lower(btrim(coalesce(p_email, ''))); v_name text := btrim(coalesce(p_name, '')); inv public.agency_invitations;
begin
 if not (c->>'slit')::boolean and c->>'role' is distinct from 'agency_admin' then
  raise exception 'Only organization or agency administrators can invite users.' using errcode = '42501'; end if;
 if p_role in ('slit_admin','org_admin','admin','Admin') then
  raise exception 'Organization administrators cannot be invited to an agency.' using errcode = '42501'; end if;
 if p_role is null or p_role not in ('agency_admin','agent') then
  raise exception 'Role must be agency administrator or agent.' using errcode = '22023'; end if;
 if v_name = '' then raise exception 'Full name is required.' using errcode = '22023'; end if;
 if coalesce(p_name, '') ~ '[[:cntrl:]]' then raise exception 'The name contains characters that are not allowed.' using errcode = '22023'; end if;
 if char_length(v_name) not between 2 and 100 then raise exception 'The name must be 2 to 100 characters.' using errcode = '22023'; end if;
 if (c->>'slit')::boolean then
  v_agency := p_agency;
  if v_agency is null then raise exception 'An agency must be selected.' using errcode = '22023'; end if;
 else
  -- The agency comes from the caller's own membership; a body value may only repeat it.
  v_agency := (c->>'agencyId')::uuid;
  if p_agency is not null and p_agency <> v_agency then
   raise exception 'You can only invite users into your own agency.' using errcode = '42501'; end if;
 end if;
 if not exists (select 1 from public.agencies a where a.id = v_agency and a.status = 'Active') then
  raise exception 'The agency is not active.' using errcode = '22023'; end if;
 if v_email ~ '[[:cntrl:]]' or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
  raise exception 'Enter a valid email address (254 characters at most).' using errcode = '22023'; end if;
 if exists (select 1 from public.cms_users u where lower(u.email) = v_email and u.role = 'Admin') then
  raise exception 'Organization administrators cannot be invited to an agency.' using errcode = '42501'; end if;
 if exists (select 1 from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id
  where lower(p.email) = v_email and m.status = 'Active' and p.status = 'Active') then
  raise exception 'This email already belongs to an active portal user.' using errcode = '23505'; end if;
 select * into inv from public.agency_invitations i where i.email = v_email and i.status = 'pending';
 if found then
  if inv.expires_at < now() then raise exception 'An earlier invitation for this email has expired. Resend it instead of creating a new one.' using errcode = '23505'; end if;
  raise exception 'This email has already been invited. Resend or revoke the pending invitation.' using errcode = '23505'; end if;
 insert into public.agency_invitations(agency_id, email, full_name, role, invited_by, invited_by_name)
 values (v_agency, v_email, v_name, p_role, p_actor, coalesce(c->>'name', '')) returning * into inv;
 perform public.portal_user_audit(p_actor, c, 'invite_user', inv.id::text, v_agency, jsonb_build_object('email', v_email, 'role', p_role));
 return jsonb_build_object('invitationId', inv.id, 'agencyId', v_agency, 'email', v_email, 'name', inv.full_name, 'role', p_role, 'expiresAt', inv.expires_at);
end; $$;

commit;
