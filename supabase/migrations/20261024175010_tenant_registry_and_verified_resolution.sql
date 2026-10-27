-- Additive foundation. No legacy ownership, accounts or domains are inferred.
create table public.tenants(id uuid primary key default gen_random_uuid(),slug text not null unique check(slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),name text not null check(length(name) between 1 and 200),status text not null default 'active' check(status in ('active','inactive')),created_at timestamptz not null default now());
create table public.tenant_domains(hostname text primary key check(hostname=lower(hostname) and hostname ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' and length(hostname)<=253),tenant_id uuid not null references public.tenants(id),verified_at timestamptz,verification_evidence text,unique(tenant_id,hostname),check(verified_at is null or length(verification_evidence)>0));
create table public.platform_admins(auth_user_id uuid primary key references auth.users(id) on delete cascade,active boolean not null default true,created_at timestamptz not null default now());
create table public.tenant_memberships(tenant_id uuid not null references public.tenants(id),auth_user_id uuid not null references auth.users(id) on delete cascade,role text not null check(role in ('tenant_admin','editor','staff','viewer')),active boolean not null default true,primary key(tenant_id,auth_user_id));
create index tenant_memberships_actor on public.tenant_memberships(auth_user_id,tenant_id) where active;
create table public.agency_tenants(agency_id uuid not null references public.agencies(id),tenant_id uuid not null references public.tenants(id),active boolean not null default true,primary key(agency_id,tenant_id));
create index agency_tenants_tenant on public.agency_tenants(tenant_id,agency_id) where active;
create table public.tenant_access_audit(id bigint generated always as identity primary key,tenant_id uuid references public.tenants(id),actor uuid,action text not null,target uuid,details jsonb not null default '{}',created_at timestamptz not null default clock_timestamp());
alter table public.tenants enable row level security;
alter table public.tenant_domains enable row level security;
alter table public.platform_admins enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.agency_tenants enable row level security;
alter table public.tenant_access_audit enable row level security;
revoke all on public.tenants,public.tenant_domains,public.platform_admins,public.tenant_memberships,public.agency_tenants,public.tenant_access_audit from public,anon,authenticated,service_role;
grant select on public.tenants,public.tenant_domains,public.platform_admins,public.tenant_memberships,public.agency_tenants,public.tenant_access_audit to authenticated,service_role;

create function public.tenant_is_platform_admin() returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and exists(select 1 from public.platform_admins where auth_user_id=auth.uid() and active)
 and not exists(select 1 from public.cms_users where auth_user_id=auth.uid() and must_change_password);
$$;
create function public.tenant_has_role(p_tenant uuid,p_roles text[] default array['tenant_admin','editor','staff','viewer']) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.tenants where id=p_tenant and status='active') and
 (public.tenant_is_platform_admin() or exists(select 1 from public.tenant_memberships where tenant_id=p_tenant and auth_user_id=auth.uid() and active and role=any(p_roles)));
$$;
create function public.tenant_agency_access(p_tenant uuid,p_agency uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.tenants t join public.agency_tenants at on at.tenant_id=t.id join public.agencies a on a.id=at.agency_id
 join public.agency_memberships m on m.agency_id=a.id join public.portal_profiles p on p.id=m.user_id
 where t.id=p_tenant and a.id=p_agency and t.status='active' and at.active and a.status='Active' and m.status='Active' and p.status='Active' and p.auth_user_id=auth.uid());
$$;
create function public.tenant_can_access(p_tenant uuid) returns boolean language sql stable security definer set search_path=public as $$
 select public.tenant_has_role(p_tenant) or exists(select 1 from public.agency_tenants where tenant_id=p_tenant and public.tenant_agency_access(p_tenant,agency_id));
$$;
create function public.tenant_resolve(p_hostname text) returns uuid language sql stable security definer set search_path=public as $$
 select d.tenant_id from public.tenant_domains d join public.tenants t on t.id=d.tenant_id
 where d.hostname=lower(trim(p_hostname)) and d.verified_at is not null and t.status='active';
$$;
create function public.tenant_request_domain() returns text language sql stable set search_path=public as $$
 select nullif(coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}')->>'x-tenant-domain','');
$$;
create function public.tenant_current() returns uuid language sql stable security definer set search_path=public as $$
 select public.tenant_resolve(public.tenant_request_domain());
$$;
create policy tenants_read on public.tenants for select to authenticated using(public.tenant_can_access(id));
create policy tenant_domains_read on public.tenant_domains for select to authenticated using(public.tenant_has_role(tenant_id,array['tenant_admin']));
create policy platform_admins_read on public.platform_admins for select to authenticated using(auth_user_id=auth.uid());
create policy tenant_memberships_read on public.tenant_memberships for select to authenticated using(auth_user_id=auth.uid() or public.tenant_has_role(tenant_id,array['tenant_admin']));
create policy agency_tenants_read on public.agency_tenants for select to authenticated using(public.tenant_has_role(tenant_id,array['tenant_admin']) or public.tenant_agency_access(tenant_id,agency_id));
create policy tenant_access_audit_read on public.tenant_access_audit for select to authenticated using(public.tenant_has_role(tenant_id,array['tenant_admin']));

create function public.tenant_create(p_slug text,p_name text) returns uuid language plpgsql security definer set search_path=public as $$
declare result uuid;
begin
 if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode='42501'; end if;
 insert into public.tenants(slug,name) values(p_slug,p_name) returning id into result;
 insert into public.tenant_access_audit(tenant_id,actor,action) values(result,auth.uid(),'create');return result;
end; $$;
create function public.tenant_set_membership(p_tenant uuid,p_user uuid,p_role text,p_active boolean) returns void language plpgsql security definer set search_path=public as $$
begin
 perform id from public.tenants where id=p_tenant for update;
 if not public.tenant_has_role(p_tenant,array['tenant_admin']) then raise exception 'Tenant administration required' using errcode='42501'; end if;
 if exists(select 1 from public.tenant_memberships where tenant_id=p_tenant and auth_user_id=p_user and role='tenant_admin' and active)
 and (not p_active or p_role<>'tenant_admin') and not exists(select 1 from public.tenant_memberships where tenant_id=p_tenant and auth_user_id<>p_user and role='tenant_admin' and active)
 and not public.tenant_is_platform_admin() then raise exception 'Last tenant administrator' using errcode='23514'; end if;
 insert into public.tenant_memberships(tenant_id,auth_user_id,role,active) values(p_tenant,p_user,p_role,p_active)
 on conflict(tenant_id,auth_user_id) do update set role=excluded.role,active=excluded.active;
 insert into public.tenant_access_audit(tenant_id,actor,action,target,details) values(p_tenant,auth.uid(),'membership',p_user,jsonb_build_object('role',p_role,'active',p_active));
end; $$;
create function public.tenant_set_domain(p_tenant uuid,p_hostname text,p_evidence text) returns void language plpgsql security definer set search_path=public as $$
begin
 if not public.tenant_is_platform_admin() or not public.tenant_has_role(p_tenant) then raise exception 'Platform authorization required' using errcode='42501'; end if;
 if nullif(trim(p_evidence),'') is null then raise exception 'Verification evidence required' using errcode='22023'; end if;
 insert into public.tenant_domains(hostname,tenant_id,verified_at,verification_evidence) values(lower(trim(p_hostname)),p_tenant,clock_timestamp(),p_evidence);
 insert into public.tenant_access_audit(tenant_id,actor,action,details) values(p_tenant,auth.uid(),'domain',jsonb_build_object('host',lower(trim(p_hostname))));
end; $$;
create function public.tenant_set_agency(p_tenant uuid,p_agency uuid,p_active boolean) returns void language plpgsql security definer set search_path=public as $$
begin
 if not public.tenant_is_platform_admin() or not public.tenant_has_role(p_tenant) then raise exception 'Platform authorization required' using errcode='42501'; end if;
 insert into public.agency_tenants(tenant_id,agency_id,active) values(p_tenant,p_agency,p_active) on conflict(agency_id,tenant_id) do update set active=excluded.active;
 insert into public.tenant_access_audit(tenant_id,actor,action,target,details) values(p_tenant,auth.uid(),'agency',p_agency,jsonb_build_object('active',p_active));
end; $$;
revoke all on function public.tenant_is_platform_admin(),public.tenant_has_role(uuid,text[]),public.tenant_agency_access(uuid,uuid),public.tenant_can_access(uuid),public.tenant_resolve(text),public.tenant_request_domain(),public.tenant_current(),public.tenant_create(text,text),public.tenant_set_membership(uuid,uuid,text,boolean),public.tenant_set_domain(uuid,text,text),public.tenant_set_agency(uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.tenant_is_platform_admin(),public.tenant_has_role(uuid,text[]),public.tenant_agency_access(uuid,uuid),public.tenant_can_access(uuid),public.tenant_resolve(text),public.tenant_request_domain(),public.tenant_current() to authenticated,service_role;
grant execute on function public.tenant_resolve(text),public.tenant_request_domain(),public.tenant_current() to anon;
grant execute on function public.tenant_create(text,text),public.tenant_set_membership(uuid,uuid,text,boolean),public.tenant_set_domain(uuid,text,text),public.tenant_set_agency(uuid,uuid,boolean) to authenticated;
