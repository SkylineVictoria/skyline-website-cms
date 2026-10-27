-- Migration 86: agency invitations and scoped agency user administration. Additive; local only until released.
-- Before this, only a SLIT (organization) admin could provision portal users (edge function gate + slit-only RLS writes),
-- and an invitation created the membership immediately, so "invited but not accepted" did not exist.
-- Rules live here; portal-admin-users calls the actor-parameterised functions with the service role after verifying the JWT.
-- Rollback (manual): drop the functions below and public.agency_invitations. No existing table is altered.
create table public.agency_invitations (
 id uuid primary key default gen_random_uuid(),
 agency_id uuid not null references public.agencies(id) on delete cascade,
 email text not null check (email = lower(btrim(email)) and email <> ''),
 full_name text not null default '',
 role text not null check (role in ('agency_admin','agent')),
 status text not null default 'pending' check (status in ('pending','accepted','revoked')),
 invited_by uuid,
 invited_by_name text not null default '',
 expires_at timestamptz not null default now() + interval '7 days',
 sent_count integer not null default 1,
 last_sent_at timestamptz not null default now(),
 accepted_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz not null default now()
);
create unique index agency_invitations_one_pending_per_email on public.agency_invitations(email) where status = 'pending';
create index agency_invitations_agency on public.agency_invitations(agency_id);
alter table public.agency_invitations enable row level security;
revoke all on public.agency_invitations from public, anon, authenticated;
grant select on public.agency_invitations to authenticated;
grant all on public.agency_invitations to service_role;
-- Reads only: every write goes through the functions below.
create policy agency_invitations_read on public.agency_invitations for select to authenticated
 using (public.portal_is_slit_admin() or (public.portal_is_agency_admin() and agency_id = public.portal_agency_id()));

-- Verified-JWT actor -> {slit, agency_id, role, name}. Nothing is read from a request body.
create function public.portal_actor_context(p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_slit boolean := false; v_name text; v_agency uuid; v_role text;
begin
 select true, c.name into v_slit, v_name from public.cms_users c
  where c.auth_user_id = p_actor and c.role = 'Admin' and c.status = 'Active' and not c.must_change_password limit 1;
 select m.agency_id, m.role, coalesce(v_name, p.full_name) into v_agency, v_role, v_name
  from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id
  join public.agencies a on a.id = m.agency_id and a.status = 'Active'
  where p.auth_user_id = p_actor and p.status = 'Active' and m.status = 'Active' limit 1;
 return jsonb_build_object('slit', coalesce(v_slit, false), 'agencyId', v_agency, 'role', v_role, 'name', coalesce(v_name, ''));
end; $$;

create function public.portal_user_audit(p_actor uuid, p_ctx jsonb, p_action text, p_target text, p_agency uuid, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, detail)
 values (p_actor, coalesce(p_ctx->>'name', ''), case when (p_ctx->>'slit')::boolean then 'slit_admin' else coalesce(p_ctx->>'role', '') end,
  p_action, 'portal_user', p_target, p_agency, coalesce(p_detail, '{}'::jsonb));
$$;

create function public.portal_invitation_create(p_actor uuid, p_agency uuid, p_email text, p_name text, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb := public.portal_actor_context(p_actor); v_agency uuid; v_email text := lower(btrim(coalesce(p_email, ''))); inv public.agency_invitations;
begin
 if not (c->>'slit')::boolean and c->>'role' is distinct from 'agency_admin' then
  raise exception 'Only organization or agency administrators can invite users.' using errcode = '42501'; end if;
 if p_role in ('slit_admin','org_admin','admin','Admin') then
  raise exception 'Organization administrators cannot be invited to an agency.' using errcode = '42501'; end if;
 if p_role is null or p_role not in ('agency_admin','agent') then
  raise exception 'Role must be agency administrator or agent.' using errcode = '22023'; end if;
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
 if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
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
 values (v_agency, v_email, btrim(coalesce(p_name, '')), p_role, p_actor, coalesce(c->>'name', '')) returning * into inv;
 perform public.portal_user_audit(p_actor, c, 'invite_user', inv.id::text, v_agency, jsonb_build_object('email', v_email, 'role', p_role));
 return jsonb_build_object('invitationId', inv.id, 'agencyId', v_agency, 'email', v_email, 'name', inv.full_name, 'role', p_role, 'expiresAt', inv.expires_at);
end; $$;

create function public.portal_invitation_resend(p_actor uuid, p_invitation uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb := public.portal_actor_context(p_actor); inv public.agency_invitations;
begin
 select * into inv from public.agency_invitations where id = p_invitation for update;
 if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
 if not ((c->>'slit')::boolean or (c->>'role' = 'agency_admin' and inv.invited_by = p_actor and inv.agency_id = (c->>'agencyId')::uuid)) then
  raise exception 'Only the inviting agency administrator or an organization administrator can resend this invitation.' using errcode = '42501'; end if;
 if inv.status <> 'pending' then raise exception 'Only pending invitations can be resent.' using errcode = '22023'; end if;
 update public.agency_invitations set expires_at = now() + interval '7 days', sent_count = sent_count + 1, last_sent_at = now() where id = inv.id returning * into inv;
 perform public.portal_user_audit(p_actor, c, 'resend_invitation', inv.id::text, inv.agency_id, jsonb_build_object('email', inv.email));
 return jsonb_build_object('invitationId', inv.id, 'agencyId', inv.agency_id, 'email', inv.email, 'name', inv.full_name, 'role', inv.role, 'expiresAt', inv.expires_at);
end; $$;

create function public.portal_invitation_revoke(p_actor uuid, p_invitation uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb := public.portal_actor_context(p_actor); inv public.agency_invitations;
begin
 select * into inv from public.agency_invitations where id = p_invitation for update;
 if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
 if not ((c->>'slit')::boolean or (c->>'role' = 'agency_admin' and inv.invited_by = p_actor and inv.agency_id = (c->>'agencyId')::uuid)) then
  raise exception 'Only the inviting agency administrator or an organization administrator can revoke this invitation.' using errcode = '42501'; end if;
 if inv.status <> 'pending' then raise exception 'Only pending invitations can be revoked.' using errcode = '22023'; end if;
 update public.agency_invitations set status = 'revoked', revoked_at = now() where id = inv.id;
 perform public.portal_user_audit(p_actor, c, 'revoke_invitation', inv.id::text, inv.agency_id, jsonb_build_object('email', inv.email));
 return jsonb_build_object('invitationId', inv.id, 'status', 'revoked');
end; $$;

-- Change role, status and (organization admin only) agency of an existing member, never leaving an agency without an active admin.
create function public.portal_member_update(p_actor uuid, p_profile uuid, p_role text, p_status text, p_agency uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb := public.portal_actor_context(p_actor); m public.agency_memberships; p public.portal_profiles;
 v_role text; v_status text; v_agency uuid; v_self boolean;
begin
 select * into m from public.agency_memberships where user_id = p_profile for update;
 if not found then raise exception 'Portal user not found.' using errcode = 'P0002'; end if;
 select * into p from public.portal_profiles where id = p_profile;
 v_self := p.auth_user_id = p_actor;
 if not (c->>'slit')::boolean then
  if c->>'role' is distinct from 'agency_admin' or m.agency_id is distinct from (c->>'agencyId')::uuid then
   raise exception 'You can only manage users in your own agency.' using errcode = '42501'; end if;
  if p_agency is not null and p_agency <> m.agency_id then raise exception 'Only an organization administrator can move a user between agencies.' using errcode = '42501'; end if;
  if m.role = 'agency_admin' and not v_self then
   raise exception 'Only an organization administrator can change another agency administrator.' using errcode = '42501'; end if;
 end if;
 if p_role is not null and p_role not in ('agency_admin','agent') then raise exception 'Role must be agency administrator or agent.' using errcode = '22023'; end if;
 if p_status is not null and p_status not in ('Active','Inactive') then raise exception 'Status must be Active or Inactive.' using errcode = '22023'; end if;
 v_role := coalesce(p_role, m.role); v_status := coalesce(p_status, m.status); v_agency := coalesce(p_agency, m.agency_id);
 if m.role = 'agency_admin' and m.status = 'Active' and (v_role <> 'agency_admin' or v_status <> 'Active' or v_agency <> m.agency_id)
  and not exists (select 1 from public.agency_memberships o join public.portal_profiles op on op.id = o.user_id
   where o.agency_id = m.agency_id and o.role = 'agency_admin' and o.status = 'Active' and op.status = 'Active' and o.user_id <> m.user_id) then
  raise exception 'This is the last active agency administrator. Add another administrator first.' using errcode = '23514'; end if;
 update public.agency_memberships set role = v_role, status = v_status, agency_id = v_agency, updated_at = now() where user_id = p_profile;
 update public.portal_profiles set status = v_status, updated_at = now() where id = p_profile and status <> v_status;
 perform public.portal_user_audit(p_actor, c, case when v_status <> m.status then (case when v_status = 'Inactive' then 'deactivate_user' else 'reactivate_user' end) else 'update_user_role' end,
  p_profile::text, v_agency, jsonb_build_object('role', v_role, 'status', v_status, 'previousRole', m.role, 'previousStatus', m.status));
 return jsonb_build_object('profileId', p_profile, 'role', v_role, 'status', v_status, 'agencyId', v_agency);
end; $$;

-- Agency and its first administrator invitation in one transaction: no agency without an admin invitation, no orphan invitation.
create function public.portal_agency_create_with_admin(p_actor uuid, p_agency jsonb, p_admin_email text, p_admin_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c jsonb := public.portal_actor_context(p_actor); a public.agencies; inv jsonb;
begin
 if not (c->>'slit')::boolean then raise exception 'Organization administrator access required.' using errcode = '42501'; end if;
 if btrim(coalesce(p_agency->>'name', '')) = '' or btrim(coalesce(p_agency->>'code', '')) = '' then
  raise exception 'Agency name and a unique agency code are required.' using errcode = '22023'; end if;
 if exists (select 1 from public.agencies where lower(code) = lower(btrim(p_agency->>'code'))) then
  raise exception 'An agency with this code already exists.' using errcode = '23505'; end if;
 insert into public.agencies(name, code, registration_number, business_email, phone, address, country, primary_contact, status)
 values (btrim(p_agency->>'name'), btrim(p_agency->>'code'), coalesce(p_agency->>'registration_number', ''), coalesce(p_agency->>'business_email', ''),
  coalesce(p_agency->>'phone', ''), coalesce(p_agency->>'address', ''), coalesce(p_agency->>'country', ''), coalesce(p_agency->>'primary_contact', ''), 'Active')
 returning * into a;
 inv := public.portal_invitation_create(p_actor, a.id, p_admin_email, p_admin_name, 'agency_admin');
 perform public.portal_user_audit(p_actor, c, 'create_agency', a.id::text, a.id, jsonb_build_object('code', a.code, 'adminEmail', inv->>'email'));
 return inv || jsonb_build_object('agencyName', a.name);
end; $$;

-- Called by the signed-in user before access is resolved: turns a valid pending invitation for the user's own confirmed
-- email into a membership, and reports why access is missing otherwise. Email comes from auth.users, never from the client.
create function public.portal_resolve_access() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; v_confirmed timestamptz; inv public.agency_invitations; p public.portal_profiles; m public.agency_memberships;
 v_accepted boolean := false; v_state text; v_agency_active boolean;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 if public.cms_is_admin() then return jsonb_build_object('state', 'org_admin', 'accepted', false); end if;
 select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
 select * into p from public.portal_profiles where auth_user_id = v_uid;
 select * into m from public.agency_memberships where user_id = p.id;
 if v_confirmed is not null then
  select * into inv from public.agency_invitations i where i.email = v_email and i.status = 'pending' for update;
  if found and inv.expires_at >= now() and exists (select 1 from public.agencies a where a.id = inv.agency_id and a.status = 'Active')
   and not coalesce(m.status = 'Active' and p.status = 'Active' and m.agency_id <> inv.agency_id, false) then
   if p.id is null then
    insert into public.portal_profiles(auth_user_id, email, full_name, status) values (v_uid, v_email, coalesce(nullif(inv.full_name, ''), split_part(v_email, '@', 1)), 'Active') returning * into p;
   else
    update public.portal_profiles set status = 'Active', updated_at = now() where id = p.id returning * into p;
   end if;
   insert into public.agency_memberships(user_id, agency_id, role, status) values (p.id, inv.agency_id, inv.role, 'Active')
   on conflict (user_id) do update set agency_id = excluded.agency_id, role = excluded.role, status = 'Active', updated_at = now() returning * into m;
   update public.agency_invitations set status = 'accepted', accepted_at = now() where id = inv.id;
   perform public.portal_user_audit(v_uid, jsonb_build_object('name', p.full_name, 'role', inv.role), 'accept_invitation', p.id::text, inv.agency_id, jsonb_build_object('email', v_email, 'role', inv.role));
   v_accepted := true;
  end if;
 end if;
 if m.user_id is null then
  v_state := case when exists (select 1 from public.agency_invitations i where i.email = v_email and i.status = 'pending' and i.expires_at < now()) then 'invite_expired' else 'no_access' end;
 else
  select a.status = 'Active' into v_agency_active from public.agencies a where a.id = m.agency_id;
  v_state := case when p.status <> 'Active' or m.status <> 'Active' then 'user_suspended' when not coalesce(v_agency_active, false) then 'agency_suspended' else 'active' end;
 end if;
 return jsonb_build_object('state', v_state, 'accepted', v_accepted);
end; $$;

revoke all on function public.portal_actor_context(uuid), public.portal_user_audit(uuid, jsonb, text, text, uuid, jsonb),
 public.portal_invitation_create(uuid, uuid, text, text, text), public.portal_invitation_resend(uuid, uuid), public.portal_invitation_revoke(uuid, uuid),
 public.portal_member_update(uuid, uuid, text, text, uuid), public.portal_agency_create_with_admin(uuid, jsonb, text, text),
 public.portal_resolve_access() from public, anon, authenticated, service_role;
-- The actor is a parameter, so these are service-role only (the edge function derives it from the verified JWT).
grant execute on function public.portal_actor_context(uuid), public.portal_invitation_create(uuid, uuid, text, text, text),
 public.portal_invitation_resend(uuid, uuid), public.portal_invitation_revoke(uuid, uuid), public.portal_member_update(uuid, uuid, text, text, uuid),
 public.portal_agency_create_with_admin(uuid, jsonb, text, text) to service_role;
grant execute on function public.portal_resolve_access() to authenticated;
