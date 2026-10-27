-- Explicit agency employment and institution authority are separate relations.
alter table public.agency_memberships add constraint agency_membership_identity unique(user_id,agency_id);
create table public.agency_tenant_agents(
 tenant_id uuid not null,
 agency_id uuid not null,
 profile_id uuid not null,
 active boolean not null default true,
 updated_at timestamptz not null default now(),
 primary key(tenant_id,agency_id,profile_id),
 foreign key(agency_id,tenant_id) references public.agency_tenants(agency_id,tenant_id),
 foreign key(profile_id,agency_id) references public.agency_memberships(user_id,agency_id)
);
create index agency_tenant_agents_actor on public.agency_tenant_agents(profile_id,tenant_id) where active;
alter table public.agency_tenant_agents enable row level security;
revoke all on public.agency_tenant_agents from public,anon,authenticated,service_role;
grant select on public.agency_tenant_agents to authenticated,service_role;

create or replace function public.tenant_agency_access(p_tenant uuid,p_agency uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.tenants t join public.agency_tenants at on at.tenant_id=t.id
 join public.agencies a on a.id=at.agency_id join public.agency_memberships m on m.agency_id=a.id
 join public.portal_profiles p on p.id=m.user_id
 where t.id=p_tenant and a.id=p_agency and t.status='active' and at.active and a.status='Active'
 and m.status='Active' and p.status='Active' and p.auth_user_id=auth.uid() and
 (m.role='agency_admin' or exists(select 1 from public.agency_tenant_agents g where g.tenant_id=t.id and g.agency_id=a.id and g.profile_id=p.id and g.active)));
$$;

create function public.portal_set_agent_scope(p_tenant uuid,p_agency uuid,p_profile uuid,p_active boolean) returns void
language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or p_tenant is distinct from public.tenant_current() or not exists(
  select 1 from public.agency_tenants at join public.agencies a on a.id=at.agency_id join public.tenants t on t.id=at.tenant_id
  where at.agency_id=p_agency and at.tenant_id=p_tenant and at.active and a.status='Active' and t.status='active') then
  raise exception 'Institution scope not authorized' using errcode='42501'; end if;
 if not (public.tenant_has_role(p_tenant,array['tenant_admin']) or
  public.tenant_agency_access(p_tenant,p_agency) and public.portal_is_agency_admin() and p_agency=public.portal_agency_id()) then
  raise exception 'Agency administration required' using errcode='42501'; end if;
 if not exists(select 1 from public.agency_memberships m join public.portal_profiles p on p.id=m.user_id
  where m.user_id=p_profile and m.agency_id=p_agency and m.status='Active' and p.status='Active') then
  raise exception 'Active agent in this agency required' using errcode='23503'; end if;
 insert into public.agency_tenant_agents(tenant_id,agency_id,profile_id,active) values(p_tenant,p_agency,p_profile,p_active)
 on conflict(tenant_id,agency_id,profile_id) do update set active=excluded.active,updated_at=clock_timestamp();
 insert into public.tenant_access_audit(tenant_id,actor,action,target,details) values(p_tenant,auth.uid(),'agency_agent_scope',p_profile,jsonb_build_object('agency_id',p_agency,'active',p_active));
end; $$;
revoke all on function public.portal_set_agent_scope(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.portal_set_agent_scope(uuid,uuid,uuid,boolean) to authenticated;

create function public.portal_scope_options() returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare choices jsonb; legacy boolean;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 legacy:=(public.cms_is_admin() or public.portal_agency_id() is not null) and
  not exists(select 1 from public.tenant_memberships where auth_user_id=auth.uid());
 select coalesce(jsonb_agg(jsonb_build_object('tenantId',t.id,'name',t.name,'domain',d.hostname) order by t.name),'[]') into choices
 from public.tenants t join lateral(select min(hostname) hostname from public.tenant_domains where tenant_id=t.id and verified_at is not null) d on d.hostname is not null
 where t.status='active' and (public.tenant_has_role(t.id,array['tenant_admin','staff']) or
 exists(select 1 from public.agency_tenants at where at.tenant_id=t.id and public.tenant_agency_access(t.id,at.agency_id)));
 return jsonb_build_object('legacyAllowed',legacy,'choices',choices);
end; $$;
revoke all on function public.portal_scope_options() from public,anon,authenticated,service_role;
grant execute on function public.portal_scope_options() to authenticated;

create or replace function public.portal_is_slit_admin() returns boolean
language sql stable security definer set search_path=public as $$
 select case when public.tenant_request_domain() is null then public.cms_is_admin() and public.tenant_scope(null)
 else public.tenant_has_role(public.tenant_current(),array['tenant_admin','staff']) end;
$$;
create or replace function public.portal_identity() returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare role text;
begin
 if public.tenant_request_domain() is not null then
  if public.tenant_current() is null then raise exception 'Unknown or inactive institution' using errcode='42501'; end if;
  if public.portal_is_slit_admin() then role:='slit_admin';
  elsif public.tenant_agency_access(public.tenant_current(),public.portal_agency_id()) then
   role:=case when public.portal_is_agency_admin() then 'agency_admin' else 'agent' end;
  end if;
 else
  if not public.tenant_scope(null) then raise exception 'Legacy scope not authorized' using errcode='42501'; end if;
  role:=case when public.portal_is_slit_admin() then 'slit_admin' when public.portal_is_agency_admin() then 'agency_admin' when public.portal_is_agent() then 'agent' end;
 end if;
 return jsonb_build_object('is_slit_admin',role='slit_admin','profile_id',public.portal_profile_id(),'agency_id',public.portal_agency_id(),'role',role,'tenant_id',public.tenant_current());
end; $$;
revoke all on function public.portal_identity() from public,anon,authenticated,service_role;
grant execute on function public.portal_identity() to authenticated,service_role;

create function public.portal_profile_in_scope(p_profile uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.portal_profiles p join public.agency_memberships m on m.user_id=p.id
 join public.agency_tenants at on at.agency_id=m.agency_id join public.agencies a on a.id=m.agency_id
 where p.id=p_profile and p.status='Active' and m.status='Active' and a.status='Active' and at.active
 and at.tenant_id=public.tenant_current() and (m.role='agency_admin' or exists(select 1 from public.agency_tenant_agents g where g.tenant_id=at.tenant_id and g.agency_id=m.agency_id and g.profile_id=p.id and g.active))
 and (public.tenant_has_role(at.tenant_id,array['tenant_admin','staff']) or m.agency_id=public.portal_agency_id() and public.tenant_agency_access(at.tenant_id,m.agency_id)));
$$;
revoke all on function public.portal_profile_in_scope(uuid) from public,anon,authenticated,service_role;
grant execute on function public.portal_profile_in_scope(uuid) to authenticated;
create policy portal_selected_agency on public.agencies as restrictive for select to authenticated using(
 public.tenant_request_domain() is null or exists(select 1 from public.agency_tenants at where at.agency_id=id and at.tenant_id=public.tenant_current() and at.active and
 (public.tenant_has_role(at.tenant_id,array['tenant_admin','staff']) or id=public.portal_agency_id() and public.tenant_agency_access(at.tenant_id,id))));
create policy portal_selected_profile on public.portal_profiles as restrictive for select to authenticated using(public.tenant_request_domain() is null or auth_user_id=auth.uid() or public.portal_profile_in_scope(id));
create policy portal_selected_membership on public.agency_memberships as restrictive for select to authenticated using(public.tenant_request_domain() is null or public.portal_profile_in_scope(user_id) or user_id=public.portal_profile_id());
-- Institution staff must not mutate shared employment/identity across RTOs.
do $$ declare tab text; begin
 foreach tab in array array['agencies','agency_memberships','portal_profiles'] loop
  execute format('create policy portal_shared_insert on public.%I as restrictive for insert to authenticated with check(public.tenant_request_domain() is null)',tab);
  execute format('create policy portal_shared_delete on public.%I as restrictive for delete to authenticated using(public.tenant_request_domain() is null)',tab);
  if tab='portal_profiles' then
   execute 'create policy portal_shared_update on public.portal_profiles as restrictive for update to authenticated using(public.tenant_request_domain() is null or auth_user_id=auth.uid()) with check(public.tenant_request_domain() is null or auth_user_id=auth.uid())';
  else execute format('create policy portal_shared_update on public.%I as restrictive for update to authenticated using(public.tenant_request_domain() is null) with check(public.tenant_request_domain() is null)',tab); end if;
 end loop;
end; $$;
create policy agency_agent_scope_read on public.agency_tenant_agents for select to authenticated using(
 public.tenant_scope(tenant_id) and (profile_id=public.portal_profile_id() or public.tenant_has_role(tenant_id,array['tenant_admin','staff']) or
 agency_id=public.portal_agency_id() and public.portal_is_agency_admin() and public.tenant_agency_access(tenant_id,agency_id)));
