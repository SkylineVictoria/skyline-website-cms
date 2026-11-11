-- Connection operations only: no billing, student or payment workflow changes.
set local lock_timeout='5s';
create table if not exists integration_private.refresh_leases (
 connection_id uuid primary key references public.integration_connections(id),
 lease_id uuid not null, connection_version timestamptz not null, expires_at timestamptz not null
);
alter table integration_private.refresh_leases enable row level security;
revoke all on integration_private.refresh_leases from public,anon,authenticated;
create or replace function public.integration_refresh_claim(p_connection uuid,p_version timestamptz) returns uuid
language plpgsql security definer set search_path=public,integration_private as $$
declare token uuid:=gen_random_uuid();begin
 perform 1 from public.integration_connections where id=p_connection and updated_at=p_version and status<>'disabled' for update;
 if not found then return null;end if;
 insert into integration_private.refresh_leases values(p_connection,token,p_version,now()+interval '90 seconds')
 on conflict(connection_id) do update set lease_id=excluded.lease_id,connection_version=excluded.connection_version,expires_at=excluded.expires_at
 where integration_private.refresh_leases.expires_at<now();
 if not found then return null;end if;
 return token;
end $$;
create or replace function public.integration_refresh_finish(p_connection uuid,p_lease uuid,p_secret text) returns timestamptz
language plpgsql security definer set search_path=public,integration_private,vault as $$
declare expected timestamptz;v uuid;stamp timestamptz:=clock_timestamp();begin
 perform 1 from public.integration_connections where id=p_connection for update;
 delete from integration_private.refresh_leases where connection_id=p_connection and lease_id=p_lease and expires_at>now() returning connection_version into expected;
 if not found then return null;end if;
 if p_secret is null then return null;end if;
 if length(p_secret)>8000 or not exists(select 1 from public.integration_connections where id=p_connection and updated_at=expected and status<>'disabled') then return null;end if;
 select vault_id into v from integration_private.credentials where connection_id=p_connection and kind='api_key';
 if v is null then return null;end if;
 perform vault.update_secret(v,p_secret);
 update integration_private.credentials set updated_at=stamp where connection_id=p_connection and kind='api_key';
 update public.integration_connections set updated_at=stamp where id=p_connection;
 return stamp;
end $$;
revoke all on function public.integration_refresh_claim(uuid,timestamptz),public.integration_refresh_finish(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.integration_refresh_claim(uuid,timestamptz),public.integration_refresh_finish(uuid,uuid,text) to service_role;

create table if not exists public.integration_permissions (
 connection_id uuid not null references public.integration_connections(id),user_id uuid not null references auth.users(id),
 role text not null check(role in ('viewer','operator')),created_at timestamptz not null default now(),primary key(connection_id,user_id)
);
create index if not exists integration_permissions_user on public.integration_permissions(user_id,connection_id);
alter table public.integration_permissions enable row level security;
revoke all on public.integration_permissions from public,anon,authenticated;
grant select on public.integration_permissions to authenticated;
grant all on public.integration_permissions to service_role;
-- This private helper avoids recursive RLS lookups. Existing tenant scope and active membership remain mandatory.
create or replace function integration_private.access(p_connection uuid,p_operate boolean default false) returns boolean
language sql stable security definer set search_path=public,integration_private as $$
 select coalesce(exists(select 1 from public.integration_connections c where c.id=p_connection and auth.uid() is not null and public.tenant_scope(c.tenant_id) and (
 public.cms_integration_can_manage(c.tenant_id) or (
 case when c.tenant_id is null then public.cms_is_staff() else public.tenant_has_role(c.tenant_id,array['tenant_admin','editor','staff','viewer']) end
 and exists(select 1 from public.integration_permissions p where p.connection_id=c.id and p.user_id=auth.uid() and (not p_operate or p.role='operator'))))),false);
$$;
grant usage on schema integration_private to authenticated;
revoke all on function integration_private.access(uuid,boolean) from public,anon;
grant execute on function integration_private.access(uuid,boolean) to authenticated;
create or replace function public.integration_access(p_connection uuid,p_operate boolean default false) returns boolean
language sql stable security invoker set search_path=public as $$select integration_private.access(p_connection,p_operate)$$;
revoke all on function public.integration_access(uuid,boolean) from public,anon;
grant execute on function public.integration_access(uuid,boolean) to authenticated;
create or replace function public.integration_module_access() returns boolean language sql stable security invoker set search_path=public as $$
 select public.admin_menu_authorized('cms.admin','current') or exists(select 1 from public.integration_connections c where integration_private.access(c.id,false));
$$;
revoke all on function public.integration_module_access() from public,anon;
grant execute on function public.integration_module_access() to authenticated;
drop policy if exists integration_read on public.integration_connections;
create policy integration_read on public.integration_connections for select to authenticated using(integration_private.access(id,false));
drop policy if exists integration_catalog_read on public.integration_definitions;
create policy integration_catalog_read on public.integration_definitions for select to authenticated using(public.integration_module_access());
drop policy if exists integration_permission_read on public.integration_permissions;
create policy integration_permission_read on public.integration_permissions for select to authenticated using(user_id=auth.uid() or exists(select 1 from public.integration_connections c where c.id=connection_id and public.integration_can_manage(c.tenant_id)));
do $$declare t text;begin
 foreach t in array array['integration_sync_jobs','integration_logs','integration_webhook_events','integration_webhook_registrations'] loop
 execute format('drop policy if exists integration_read on public.%I',t);
 execute format('create policy integration_read on public.%I for select to authenticated using(integration_private.access(connection_id,false))',t);
 end loop;
end $$;
drop policy if exists integration_delegated_menu on public.admin_menu_items;
create policy integration_delegated_menu on public.admin_menu_items for select to authenticated using(
 is_enabled and id in ('external_integrations','integration_overview','integration_applications','integration_webhooks','integration_sync_history','integration_logs') and public.integration_module_access());
create or replace function public.integration_permission_set(p_connection uuid,p_user uuid,p_role text) returns void
language plpgsql security definer set search_path=public as $$
declare tenant uuid;begin
 select tenant_id into tenant from public.integration_connections where id=p_connection;
 if not found or not public.integration_can_manage(tenant) then raise exception 'Administrator access required' using errcode='42501';end if;
 if p_role not in ('viewer','operator','revoke') then raise exception 'Invalid permission';end if;
 if p_role='revoke' then delete from public.integration_permissions where connection_id=p_connection and user_id=p_user;return;end if;
 if tenant is null then
  if not exists(select 1 from public.cms_users where auth_user_id=p_user and status='Active' and not must_change_password) then raise exception 'Active CMS user required';end if;
 else
  if not exists(select 1 from public.tenant_memberships where tenant_id=tenant and auth_user_id=p_user and active) then raise exception 'Active organization member required';end if;
 end if;
 insert into public.integration_permissions(connection_id,user_id,role) values(p_connection,p_user,p_role)
 on conflict(connection_id,user_id) do update set role=excluded.role;
 insert into public.integration_logs(connection_id,connector_id,severity,code) select id,connector_id,'info','permission_changed' from public.integration_connections where id=p_connection;
end $$;
revoke all on function public.integration_permission_set(uuid,uuid,text) from public,anon;
grant execute on function public.integration_permission_set(uuid,uuid,text) to authenticated;
create or replace function public.integration_eligible_users(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path=public as $$begin
 if not public.integration_can_manage(p_tenant) then raise exception 'Administrator access required' using errcode='42501';end if;
 if p_tenant is null then return coalesce((select jsonb_agg(jsonb_build_object('id',auth_user_id,'label',name)) from public.cms_users where status='Active' and auth_user_id is not null and not must_change_password),'[]'::jsonb);end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',auth_user_id,'label',auth_user_id::text)) from public.tenant_memberships where tenant_id=p_tenant and active),'[]'::jsonb);
end $$;
revoke all on function public.integration_eligible_users(uuid) from public,anon;
grant execute on function public.integration_eligible_users(uuid) to authenticated;
-- A recheck verifies an existing provider event without executing billing/business workflows.
alter table public.integration_webhook_events add column if not exists verified_at timestamptz;
alter table public.integration_webhook_events add column if not exists retry_count integer not null default 0;
create table if not exists public.integration_event_attempts (
 id uuid primary key default gen_random_uuid(),connection_id uuid not null references public.integration_connections(id),
 event_id uuid not null references public.integration_webhook_events(id),status text not null check(status in ('verified','failed')),
 code text not null check(code ~ '^[a-z_]{1,60}$'),created_at timestamptz not null default now(),correlation_id uuid not null
);
create index if not exists integration_event_attempts_event on public.integration_event_attempts(event_id,created_at desc);
create index if not exists integration_event_attempts_connection on public.integration_event_attempts(connection_id);
alter table public.integration_event_attempts enable row level security;
revoke all on public.integration_event_attempts from public,anon,authenticated;
grant select on public.integration_event_attempts to authenticated;
grant all on public.integration_event_attempts to service_role;
drop policy if exists integration_read on public.integration_event_attempts;
create policy integration_read on public.integration_event_attempts for select to authenticated using(integration_private.access(connection_id,false));
create or replace function public.integration_event_recheck(p_event uuid,p_ok boolean,p_code text,p_correlation uuid) returns void
language plpgsql security invoker set search_path=public as $$declare c uuid;begin
 update public.integration_webhook_events set status=case when p_ok then 'received' else 'failed' end,verified_at=case when p_ok then now() else verified_at end,retry_count=retry_count+1 where id=p_event returning connection_id into c;
 if not found then raise exception 'Event not found';end if;
 insert into public.integration_event_attempts(connection_id,event_id,status,code,correlation_id) values(c,p_event,case when p_ok then 'verified' else 'failed' end,p_code,p_correlation);
end $$;
revoke all on function public.integration_event_recheck(uuid,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.integration_event_recheck(uuid,boolean,text,uuid) to service_role;
