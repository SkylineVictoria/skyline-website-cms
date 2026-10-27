-- P06-03: organization lifecycle (onboarding, suspension, reactivation), invitation-based membership and audit.
-- Invitations: adding a member by email only records an invitation and always answers the same way, so a
-- tenant administrator cannot learn whether an account exists. The account holder receives the role the
-- next time they sign in to that institution (tenant_accept_pending_invites), and only when the Auth user
-- has a confirmed email equal to the invited address. Existing members are changed by user id
-- (tenant_set_membership, unchanged); deactivating keeps the row and audit history.
-- Suspension (tenants.status = 'inactive') is platform-only and non-destructive: no row is deleted, tenant_has_role,
-- tenant_resolve, agency access and tenant_bind_row already deny an inactive tenant, and reactivation restores access.
-- Platform administrators keep an overview and an audit view that work for suspended institutions.
-- Every command writes tenant_access_audit with the acting user and the tenant.
--
-- Rollback / compensation (additive; run manually):
--   drop function if exists public.tenant_platform_audit(uuid), public.tenant_platform_overview(), public.tenant_onboard(text, text, text),
--     public.tenant_set_status(uuid, text, text), public.tenant_accept_pending_invites();
--   re-create public.tenant_grant_membership and public.tenant_admin_overview as in 20261026140000;
--   drop table if exists public.tenant_member_invites;   -- discards pending invitations
-- Memberships created from invitations are ordinary tenant_memberships rows and are reverted with tenant_set_membership.
-- Never applied to the hosted project without release approval.
begin;

create table public.tenant_member_invites(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  email text not null check (email = lower(email) and length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('tenant_admin', 'editor', 'staff', 'viewer')),
  invited_by uuid,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid
);
create unique index tenant_member_invites_pending on public.tenant_member_invites(tenant_id, email) where accepted_at is null;
alter table public.tenant_member_invites enable row level security;
revoke all on public.tenant_member_invites from public, anon, authenticated, service_role;
grant select on public.tenant_member_invites to authenticated, service_role;
create policy tenant_member_invites_read on public.tenant_member_invites for select to authenticated
  using (public.tenant_has_role(tenant_id, array['tenant_admin']));

create or replace function public.tenant_admin_overview(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'tenant', (select jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'status', t.status) from public.tenants t where t.id = p_tenant),
    'isPlatformAdmin', public.tenant_is_platform_admin(),
    'members', coalesce((select jsonb_agg(jsonb_build_object('userId', m.auth_user_id, 'email', u.email, 'role', m.role, 'active', m.active) order by u.email)
      from public.tenant_memberships m join auth.users u on u.id = m.auth_user_id where m.tenant_id = p_tenant), '[]'::jsonb),
    'domains', coalesce((select jsonb_agg(jsonb_build_object('hostname', d.hostname, 'verified', d.verified_at is not null, 'verifiedAt', d.verified_at) order by d.hostname)
      from public.tenant_domains d where d.tenant_id = p_tenant), '[]'::jsonb),
    'agencies', coalesce((select jsonb_agg(jsonb_build_object('agencyId', a.id, 'name', a.name, 'active', l.active) order by a.name)
      from public.agency_tenants l join public.agencies a on a.id = l.agency_id where l.tenant_id = p_tenant), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('email', i.email, 'role', i.role, 'invitedAt', i.created_at) order by i.email)
      from public.tenant_member_invites i where i.tenant_id = p_tenant and i.accepted_at is null), '[]'::jsonb),
    'audit', coalesce((select jsonb_agg(s.entry order by s.id desc) from (
      select id, jsonb_build_object('at', created_at, 'action', action, 'actor', (select email from auth.users where id = actor), 'details', details) as entry
      from public.tenant_access_audit where tenant_id = p_tenant order by id desc limit 25) s), '[]'::jsonb));
end;
$$;

create or replace function public.tenant_grant_membership(p_tenant uuid, p_email text, p_role text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('tenant_admin', 'editor', 'staff', 'viewer') then raise exception 'Unknown role' using errcode = '22023'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
  if coalesce(p_active, true) then
    insert into public.tenant_member_invites(tenant_id, email, role, invited_by) values (p_tenant, v_email, p_role, auth.uid())
    on conflict (tenant_id, email) where accepted_at is null do update set role = excluded.role, invited_by = excluded.invited_by, created_at = now();
    insert into public.tenant_access_audit(tenant_id, actor, action, details) values (p_tenant, auth.uid(), 'member_invite', jsonb_build_object('email', v_email, 'role', p_role));
  else
    delete from public.tenant_member_invites where tenant_id = p_tenant and email = v_email and accepted_at is null;
    insert into public.tenant_access_audit(tenant_id, actor, action, details) values (p_tenant, auth.uid(), 'member_invite_cancel', jsonb_build_object('email', v_email));
  end if;
end;
$$;

create function public.tenant_accept_pending_invites() returns integer
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.tenant_current(); v_email text; v_count integer := 0; r public.tenant_member_invites;
begin
  if auth.uid() is null or v_tenant is null then return 0; end if;
  select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if v_email is null then return 0; end if;
  if not exists (select 1 from public.tenants where id = v_tenant and status = 'active') then return 0; end if;
  for r in select * from public.tenant_member_invites where tenant_id = v_tenant and email = v_email and accepted_at is null for update loop
    insert into public.tenant_memberships(tenant_id, auth_user_id, role, active) values (v_tenant, auth.uid(), r.role, true)
    on conflict (tenant_id, auth_user_id) do update set role = excluded.role, active = true;
    update public.tenant_member_invites set accepted_at = now(), accepted_by = auth.uid() where id = r.id;
    insert into public.tenant_access_audit(tenant_id, actor, action, target, details) values (v_tenant, auth.uid(), 'member_accept', auth.uid(), jsonb_build_object('role', r.role, 'invitedBy', r.invited_by));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create function public.tenant_set_status(p_tenant uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('active', 'inactive') then raise exception 'Unknown status' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Reason required' using errcode = '22023'; end if;
  select status into v_old from public.tenants where id = p_tenant for update;
  if not found then raise exception 'Institution not found' using errcode = 'P0002'; end if;
  if v_old = p_status then return; end if;
  update public.tenants set status = p_status where id = p_tenant;
  insert into public.tenant_access_audit(tenant_id, actor, action, details)
  values (p_tenant, auth.uid(), case when p_status = 'inactive' then 'suspend' else 'reactivate' end, jsonb_build_object('from', v_old, 'to', p_status, 'reason', left(trim(p_reason), 300)));
end;
$$;

create function public.tenant_onboard(p_slug text, p_name text, p_admin_email text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_email text := lower(trim(coalesce(p_admin_email, '')));
begin
  if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
  v_tenant := public.tenant_create(p_slug, trim(p_name));
  insert into public.tenant_member_invites(tenant_id, email, role, invited_by) values (v_tenant, v_email, 'tenant_admin', auth.uid());
  insert into public.tenant_access_audit(tenant_id, actor, action, details) values (v_tenant, auth.uid(), 'member_invite', jsonb_build_object('email', v_email, 'role', 'tenant_admin', 'onboarding', true));
  return v_tenant;
end;
$$;

create function public.tenant_platform_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name, 'status', t.status,
    'members', (select count(*) from public.tenant_memberships m where m.tenant_id = t.id and m.active),
    'domains', (select count(*) from public.tenant_domains d where d.tenant_id = t.id and d.verified_at is not null),
    'pendingInvites', (select count(*) from public.tenant_member_invites i where i.tenant_id = t.id and i.accepted_at is null)) order by t.name) from public.tenants t), '[]'::jsonb);
end;
$$;

create function public.tenant_platform_audit(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(s.entry order by s.id desc) from (
    select id, jsonb_build_object('at', created_at, 'action', action, 'actor', (select email from auth.users where id = actor), 'details', details) as entry
    from public.tenant_access_audit where tenant_id = p_tenant order by id desc limit 50) s), '[]'::jsonb);
end;
$$;

revoke all on function public.tenant_accept_pending_invites(), public.tenant_set_status(uuid, text, text), public.tenant_onboard(text, text, text),
  public.tenant_platform_overview(), public.tenant_platform_audit(uuid) from public, anon, authenticated, service_role;
grant execute on function public.tenant_accept_pending_invites(), public.tenant_set_status(uuid, text, text), public.tenant_onboard(text, text, text),
  public.tenant_platform_overview(), public.tenant_platform_audit(uuid) to authenticated;

commit;
