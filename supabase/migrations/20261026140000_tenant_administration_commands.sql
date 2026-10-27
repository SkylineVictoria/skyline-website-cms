-- P06-01: scoped commands for institution administration (details, members, domains).
-- Builds on tenant_set_membership / tenant_set_agency from 20261024175010; those stay unchanged.
-- Every command re-checks live authority from auth.uid(): a tenant administrator of tenant A has
-- no authority over tenant B, and no command here can create or alter platform_admins (that table
-- has no write path for browser roles). Platform-only: verifying a domain and linking agencies
-- (tenant_set_agency). Linking never alters the shared agency itself, only its agency_tenants row.
-- Every change writes tenant_access_audit with the acting user.
--
-- Rollback / compensation (additive; nothing else depends on these functions):
--   drop function if exists public.tenant_admin_overview(uuid);
--   drop function if exists public.tenant_update_details(uuid, text);
--   drop function if exists public.tenant_grant_membership(uuid, text, text, boolean);
--   drop function if exists public.tenant_claim_domain(uuid, text);
--   drop function if exists public.tenant_verify_domain(uuid, text, text);
--   drop function if exists public.tenant_revoke_domain(uuid, text, text);
-- Data written by these commands (members, domains, audit rows) is ordinary registry data and is
-- reverted with the same commands, never by removing RLS. Never applied to the hosted project
-- without release approval.
begin;

create function public.tenant_admin_overview(p_tenant uuid) returns jsonb
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
    'audit', coalesce((select jsonb_agg(s.entry order by s.id desc) from (
      select id, jsonb_build_object('at', created_at, 'action', action, 'actor', (select email from auth.users where id = actor), 'details', details) as entry
      from public.tenant_access_audit where tenant_id = p_tenant order by id desc limit 25) s), '[]'::jsonb));
end;
$$;

create function public.tenant_update_details(p_tenant uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_old text; v_name text := trim(coalesce(p_name, ''));
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  if length(v_name) not between 1 and 200 then raise exception 'Institution name must be 1-200 characters' using errcode = '22023'; end if;
  select name into v_old from public.tenants where id = p_tenant for update;
  update public.tenants set name = v_name where id = p_tenant;
  insert into public.tenant_access_audit(tenant_id, actor, action, details) values (p_tenant, auth.uid(), 'details', jsonb_build_object('from', v_old, 'to', v_name));
end;
$$;

-- Adds or changes a member by email. Authority is checked before the account lookup so a caller
-- without tenant administration learns nothing about which accounts exist.
create function public.tenant_grant_membership(p_tenant uuid, p_email text, p_role text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('tenant_admin', 'editor', 'staff', 'viewer') then raise exception 'Unknown role' using errcode = '22023'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(coalesce(p_email, ''))) limit 1;
  if v_user is null then raise exception 'Account not found' using errcode = '22023'; end if;
  perform public.tenant_set_membership(p_tenant, v_user, p_role, coalesce(p_active, true));
end;
$$;

-- A tenant administrator may only ask for a hostname; it resolves nothing until a platform
-- administrator verifies it with evidence (tenant_resolve requires verified_at).
create function public.tenant_claim_domain(p_tenant uuid, p_hostname text) returns void
language plpgsql security definer set search_path = public as $$
declare v_host text := lower(trim(coalesce(p_hostname, '')));
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  if v_host !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' or length(v_host) > 253 or position('.' in v_host) = 0 then raise exception 'Invalid hostname' using errcode = '22023'; end if;
  if exists (select 1 from public.tenant_domains where hostname = v_host and tenant_id <> p_tenant) then raise exception 'Hostname unavailable' using errcode = '23505'; end if;
  insert into public.tenant_domains(hostname, tenant_id) values (v_host, p_tenant) on conflict (hostname) do nothing;
  insert into public.tenant_access_audit(tenant_id, actor, action, details) values (p_tenant, auth.uid(), 'domain_claim', jsonb_build_object('host', v_host));
end;
$$;

create function public.tenant_verify_domain(p_tenant uuid, p_hostname text, p_evidence text) returns void
language plpgsql security definer set search_path = public as $$
declare v_host text := lower(trim(coalesce(p_hostname, ''))); v_row public.tenant_domains;
begin
  if not public.tenant_is_platform_admin() or not public.tenant_has_role(p_tenant) then raise exception 'Platform authorization required' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_evidence, '')), '') is null then raise exception 'Verification evidence required' using errcode = '22023'; end if;
  select * into v_row from public.tenant_domains where hostname = v_host for update;
  if not found then raise exception 'Domain not claimed' using errcode = '22023'; end if;
  if v_row.tenant_id <> p_tenant then raise exception 'Hostname belongs to another institution' using errcode = '23505'; end if;
  if v_row.verified_at is not null then raise exception 'Domain already verified' using errcode = '22023'; end if;
  update public.tenant_domains set verified_at = clock_timestamp(), verification_evidence = trim(p_evidence) where hostname = v_host;
  insert into public.tenant_access_audit(tenant_id, actor, action, details) values (p_tenant, auth.uid(), 'domain_verify', jsonb_build_object('host', v_host));
end;
$$;

-- Revocation takes effect immediately (tenant_resolve stops matching). A tenant administrator
-- cannot remove the only verified hostname, which would lock the institution out of its own CMS.
create function public.tenant_revoke_domain(p_tenant uuid, p_hostname text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_host text := lower(trim(coalesce(p_hostname, ''))); v_row public.tenant_domains;
begin
  if not public.tenant_has_role(p_tenant, array['tenant_admin']) then raise exception 'Tenant administration required' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Reason required' using errcode = '22023'; end if;
  select * into v_row from public.tenant_domains where hostname = v_host and tenant_id = p_tenant for update;
  if not found then raise exception 'Domain not found' using errcode = 'P0002'; end if;
  if v_row.verified_at is not null and not public.tenant_is_platform_admin()
    and not exists (select 1 from public.tenant_domains where tenant_id = p_tenant and hostname <> v_host and verified_at is not null) then
    raise exception 'Last verified domain' using errcode = '23514';
  end if;
  delete from public.tenant_domains where hostname = v_host and tenant_id = p_tenant;
  insert into public.tenant_access_audit(tenant_id, actor, action, details)
  values (p_tenant, auth.uid(), 'domain_revoke', jsonb_build_object('host', v_host, 'wasVerified', v_row.verified_at is not null, 'reason', left(trim(p_reason), 300)));
end;
$$;

revoke all on function public.tenant_admin_overview(uuid), public.tenant_update_details(uuid, text), public.tenant_grant_membership(uuid, text, text, boolean),
  public.tenant_claim_domain(uuid, text), public.tenant_verify_domain(uuid, text, text), public.tenant_revoke_domain(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.tenant_admin_overview(uuid), public.tenant_update_details(uuid, text), public.tenant_grant_membership(uuid, text, text, boolean),
  public.tenant_claim_domain(uuid, text), public.tenant_verify_domain(uuid, text, text), public.tenant_revoke_domain(uuid, text, text) to authenticated;

commit;
