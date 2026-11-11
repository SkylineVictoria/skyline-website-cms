-- Additive integration control plane. No provider calls, cron, or payment activation.
set local lock_timeout = '5s';
create schema if not exists integration_private;
revoke all on schema integration_private from public, anon, authenticated;
create table if not exists public.integration_definitions (
 id text primary key, name text not null, auth_type text not null,
 availability text not null, description text not null
);
insert into public.integration_definitions values
 ('stripe','Stripe','api_key','available','Read-only account connectivity. Payment processing remains separate.'),
 ('xero','Xero','oauth2','adapter_pending','Existing payroll CSV exports remain available. OAuth adapter setup required.'),
 ('docusign','DocuSign','oauth2','adapter_pending','Optional external signing provider. Existing internal Sign remains available.'),
 ('microsoft365','Microsoft 365','oauth2','adapter_pending','Requires Microsoft Entra application registration and consent.'),
 ('usi','USI','approved_api','requires_approval','Requires approved organization access and provider credentials.'),
 ('vevo','VEVO','approved_api','requires_approval','Requires approved access; no government endpoint is assumed.'),
 ('datazoo','DataZoo','approved_api','requires_approval','Requires a contracted API environment and approved adapter.'),
 ('prisms','PRISMS','approved_api','requires_approval','Manual workflow remains available; approved API access required.'),
 ('calendly','Calendly','api_key','available','Uses the existing Calendly connection service and credential store.')
on conflict(id) do nothing;
create table if not exists public.integration_connections (
 id uuid primary key default gen_random_uuid(), tenant_id uuid references public.tenants(id),
 connector_id text not null references public.integration_definitions(id),
 status text not null default 'not_connected' check(status in ('not_connected','connected','error','disabled')),
 credential_configured boolean not null default false, webhook_configured boolean not null default false,
 last_success_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists integration_scope_connector on public.integration_connections(connector_id,coalesce(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists integration_connections_tenant on public.integration_connections(tenant_id);
create table if not exists public.integration_settings (
 id uuid primary key default gen_random_uuid(), tenant_id uuid references public.tenants(id),
 timeout_seconds integer not null default 10 check(timeout_seconds between 3 and 30),
 max_retries integer not null default 1 check(max_retries between 0 and 3), alerts_enabled boolean not null default true,
 updated_at timestamptz not null default now()
);
create unique index if not exists integration_settings_scope on public.integration_settings(coalesce(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid));
create table if not exists public.integration_sync_jobs (
 id uuid primary key default gen_random_uuid(), connection_id uuid not null references public.integration_connections(id),
 operation text not null check(operation='connection_test'), status text not null check(status in ('running','succeeded','failed')),
 created_at timestamptz not null default now(), completed_at timestamptz,
 success_count integer not null default 0 check(success_count>=0), failure_count integer not null default 0 check(failure_count>=0),
 attempts integer not null default 1 check(attempts>0), correlation_id uuid not null default gen_random_uuid()
);
create index if not exists integration_jobs_connection on public.integration_sync_jobs(connection_id,created_at desc);
create table if not exists public.integration_logs (
 id uuid primary key default gen_random_uuid(), connection_id uuid not null references public.integration_connections(id),
 connector_id text not null references public.integration_definitions(id), severity text not null check(severity in ('info','warn','error')),
 code text not null check(code ~ '^[a-z_]{1,60}$'), correlation_id uuid not null default gen_random_uuid(), created_at timestamptz not null default now()
);
create index if not exists integration_logs_connection on public.integration_logs(connection_id,created_at desc);
create index if not exists integration_logs_correlation on public.integration_logs(correlation_id);
create table if not exists public.integration_webhook_events (
 id uuid primary key default gen_random_uuid(), connection_id uuid not null references public.integration_connections(id),
 provider_event_id text not null, event_type text not null, status text not null check(status in ('received','processed','failed')),
 attempts integer not null default 0, created_at timestamptz not null default now(), unique(connection_id,provider_event_id)
);
create table if not exists integration_private.credentials (
 connection_id uuid not null references public.integration_connections(id), kind text not null check(kind in ('api_key','webhook_secret')),
 vault_id uuid not null references vault.secrets(id), updated_at timestamptz not null default now(), primary key(connection_id,kind)
);
alter table integration_private.credentials enable row level security;
revoke all on integration_private.credentials from public,anon,authenticated;
-- Uses the existing verified-domain scope and live membership helpers.
create or replace function public.integration_can_manage(p_tenant uuid) returns boolean
language sql stable security invoker set search_path=public as $$
 select auth.uid() is not null and public.tenant_scope(p_tenant) and public.cms_integration_can_manage(p_tenant);
$$;
revoke all on function public.integration_can_manage(uuid) from public,anon;
grant execute on function public.integration_can_manage(uuid) to authenticated,service_role;
alter table public.integration_definitions enable row level security;
revoke all on public.integration_definitions from public,anon,authenticated;
grant select on public.integration_definitions to authenticated;
grant all on public.integration_definitions to service_role;
drop policy if exists integration_catalog_read on public.integration_definitions;
create policy integration_catalog_read on public.integration_definitions for select to authenticated using(public.admin_menu_authorized('cms.admin','current'));
do $$ declare t text; begin
 foreach t in array array['integration_connections','integration_settings'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('drop policy if exists integration_read on public.%I',t);
  execute format('create policy integration_read on public.%I for select to authenticated using(public.integration_can_manage(tenant_id))',t);
 end loop;
 foreach t in array array['integration_sync_jobs','integration_logs','integration_webhook_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('drop policy if exists integration_read on public.%I',t);
  execute format('create policy integration_read on public.%I for select to authenticated using(exists(select 1 from public.integration_connections c where c.id=connection_id and public.integration_can_manage(c.tenant_id)))',t);
 end loop;
end $$;
-- Service-only Vault gateway. Never grant these functions to authenticated or anon.
create or replace function public.integration_credential_write(p_connection uuid,p_kind text,p_secret text,p_version timestamptz default null) returns void
language plpgsql security definer set search_path=public,integration_private,vault as $$
declare v uuid; begin
 if p_kind not in ('api_key','webhook_secret') or length(p_secret)>8000 then raise exception 'Invalid credential'; end if;
 perform 1 from public.integration_connections where id=p_connection for update;
 if not found then raise exception 'Unknown connection'; end if;
 if p_version is not null and not exists(select 1 from public.integration_connections where id=p_connection and updated_at=p_version and status<>'disabled') then raise exception 'Connection changed';end if;
 select vault_id into v from integration_private.credentials where connection_id=p_connection and kind=p_kind;
 if p_secret='' then
  delete from integration_private.credentials where connection_id=p_connection and kind=p_kind;
  if v is not null then delete from vault.secrets where id=v; end if;
 elsif v is null then
  select vault.create_secret(p_secret) into v;
  insert into integration_private.credentials(connection_id,kind,vault_id) values(p_connection,p_kind,v);
 else
  perform vault.update_secret(v,p_secret);
  update integration_private.credentials set updated_at=now() where connection_id=p_connection and kind=p_kind;
 end if;
 update public.integration_connections set
 credential_configured=case when p_kind='api_key' then p_secret<>'' else credential_configured end,
 webhook_configured=case when p_kind='webhook_secret' then p_secret<>'' else webhook_configured end,
 status=case when status='disabled' then status else 'not_connected' end,updated_at=now() where id=p_connection;
end $$;
create or replace function public.integration_credential_read(p_connection uuid,p_kind text) returns text
language sql stable security definer set search_path=public,integration_private,vault as $$
 select s.decrypted_secret from integration_private.credentials c join vault.decrypted_secrets s on s.id=c.vault_id where c.connection_id=p_connection and c.kind=p_kind;
$$;
revoke all on function public.integration_credential_write(uuid,text,text,timestamptz),public.integration_credential_read(uuid,text) from public,anon,authenticated;
grant execute on function public.integration_credential_write(uuid,text,text,timestamptz),public.integration_credential_read(uuid,text) to service_role;
insert into public.admin_menu_items(id,parent_id,label,route,icon_key,sort_order,permission_key,permission_scope,is_system)
values ('external_integrations',null,'External Integrations',null,'plug',coalesce((select sort_order+1 from public.admin_menu_items where parent_id is null and label='Payments & Billing' limit 1),86),'cms.admin','current',true)
on conflict(id) do nothing;
insert into public.admin_menu_items(id,parent_id,label,route,icon_key,sort_order,permission_key,permission_scope,is_system)
select 'integration_'||replace(path,'-','_'),'external_integrations',label,'/admin/integrations/'||path,'plug',ordinality::integer*10,'cms.admin','current',true
from unnest(array['overview','applications','add','credentials','webhooks','sync-history','logs','settings'],array['Overview','Connected Applications','Add Connection','Credentials & Secrets','Webhooks & Events','Sync History','Integration Logs','Settings']) with ordinality as x(path,label,ordinality)
on conflict(id) do nothing;

create table if not exists integration_private.oauth_states (
 state_hash text primary key, connection_id uuid not null references public.integration_connections(id),
 user_id uuid not null, connection_version timestamptz not null, expires_at timestamptz not null default now()+interval '10 minutes'
);
alter table integration_private.oauth_states enable row level security;
revoke all on integration_private.oauth_states from public,anon,authenticated;
create or replace function public.integration_oauth_state(p_hash text,p_connection uuid,p_user uuid,p_consume boolean) returns boolean
language plpgsql security definer set search_path=public,integration_private as $$
declare v timestamptz;begin
 if p_consume then
  delete from integration_private.oauth_states s using public.integration_connections c
   where s.state_hash=p_hash and s.connection_id=p_connection and s.user_id=p_user and s.expires_at>now()
   and c.id=s.connection_id and c.updated_at=s.connection_version and c.status<>'disabled' returning s.connection_version into v;
  return found;
 end if;
 delete from integration_private.oauth_states where expires_at<now() or (connection_id=p_connection and user_id=p_user);
 select updated_at into v from public.integration_connections where id=p_connection and status<>'disabled';
 if not found then return false;end if;
 insert into integration_private.oauth_states(state_hash,connection_id,user_id,connection_version) values(p_hash,p_connection,p_user,v);
 return true;
end $$;
revoke all on function public.integration_oauth_state(text,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.integration_oauth_state(text,uuid,uuid,boolean) to service_role;
update public.integration_definitions set availability='requires_app_registration' where auth_type='oauth2';
create table if not exists public.integration_webhook_registrations (
 id uuid primary key default gen_random_uuid(), connection_id uuid not null unique references public.integration_connections(id),
 provider_id text not null, endpoint_url text not null, event_types text[] not null, created_at timestamptz not null default now()
);
alter table public.integration_webhook_registrations enable row level security;
revoke all on public.integration_webhook_registrations from public,anon,authenticated;
grant select on public.integration_webhook_registrations to authenticated;
grant all on public.integration_webhook_registrations to service_role;
drop policy if exists integration_read on public.integration_webhook_registrations;
create policy integration_read on public.integration_webhook_registrations for select to authenticated using(exists(select 1 from public.integration_connections c where c.id=connection_id and public.integration_can_manage(c.tenant_id)));
create or replace function public.integration_receive_event(p_connection uuid,p_id text,p_type text) returns void
language sql security invoker set search_path=public as $$
 insert into public.integration_webhook_events(connection_id,provider_event_id,event_type,status,attempts)
 values(p_connection,p_id,p_type,'received',1)
 on conflict(connection_id,provider_event_id) do update set attempts=integration_webhook_events.attempts+1;
$$;
revoke all on function public.integration_receive_event(uuid,text,text) from public,anon,authenticated;
grant execute on function public.integration_receive_event(uuid,text,text) to service_role;
