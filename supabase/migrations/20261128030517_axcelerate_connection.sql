-- AXCELERATE-CONNECTION (owner, 2026-11-28: "in external connection I don't see Accelerate CRM API ... allow user to add credential
-- of it and use all API of it", to import data from it). aXcelerate (the Australian RTO student management / CRM system) becomes
-- an entry in Integrations > Connections:
--   * connector 'axcelerate' (api_key). Its details are one JSON document in Vault through integration_credential_write
--     (kind 'api_key', {version:1, fields:{environment, subdomain, apiToken, wsToken}}), saved by integration_axcelerate_save
--     and removed by integration_axcelerate_clear (administrators of the connection's organization scope only).
--   * aXcelerate needs two tokens on every request (headers apitoken / wstoken, developer.axcelerate.com Guides > Authentication)
--     and a per-college address: https://{subdomain}.app.axcelerate.com/api (production) or https://{subdomain}.stg.axcelerate.com/api
--     (staging). The tokens never come back to a browser: integration_axcelerate_summary shows the environment, the subdomain
--     and the last four characters of each token.
--   * Calls go through the Edge Function integrations-admin (actions test / axcelerate_call, administrators only); each call is
--     written to public.axcelerate_api_calls (who, method, path, HTTP status, no data) for the record.
-- New functions only; the shared integration_comm_* functions are not changed. Additive.
-- Rollback (manual): drop the three functions and public.axcelerate_api_calls, delete the axcelerate connection(s) (and their
-- credentials, integration_logs rows) and the integration_definitions row.
begin;

insert into public.integration_definitions(id, name, auth_type, availability, description) values
  ('axcelerate', 'aXcelerate (Accelerate CRM)', 'api_key', 'available',
   'Read and import contacts, courses, enrolments and reports from aXcelerate with its API token and web service token.')
on conflict (id) do nothing;

/** Every aXcelerate API call made from Skyline: who, what, the answer's HTTP status (never the data or the tokens). */
create table if not exists public.axcelerate_api_calls (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  user_id uuid,
  method text not null check (method in ('GET', 'POST', 'PUT', 'DELETE')),
  path text not null check (path ~ '^/[A-Za-z0-9/_.-]{1,160}$'),
  http_status integer,
  created_at timestamptz not null default now()
);
create index if not exists axcelerate_api_calls_connection on public.axcelerate_api_calls(connection_id, created_at desc);
alter table public.axcelerate_api_calls enable row level security;
revoke all on public.axcelerate_api_calls from public, anon, authenticated;
grant select on public.axcelerate_api_calls to authenticated;
create policy axcelerate_api_calls_admin_read on public.axcelerate_api_calls for select to authenticated
  using (exists (select 1 from public.integration_connections c where c.id = connection_id and coalesce(public.integration_can_manage(c.tenant_id), false)));

/** Saves the aXcelerate details of a connection (Integrations > Connections > aXcelerate). Values never come back. */
create or replace function public.integration_axcelerate_save(p_connection uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare c record; f jsonb := coalesce(p_fields, '{}'::jsonb); v_env text; v_sub text; v_api text; v_ws text;
begin
  select id, tenant_id, connector_id, status into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id <> 'axcelerate' then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
  if c.status = 'disabled' then raise exception 'Enable the connection first' using errcode = '55000'; end if;
  v_env := lower(btrim(coalesce(f->>'environment', '')));
  -- The subdomain may be typed as the whole address: keep only the college part.
  v_sub := lower(btrim(coalesce(f->>'subdomain', '')));
  v_sub := regexp_replace(v_sub, '^https?://', '');
  v_sub := regexp_replace(v_sub, '\.(app|stg)\.axcelerate\.com.*$', '');
  v_api := btrim(coalesce(f->>'apiToken', '')); v_ws := btrim(coalesce(f->>'wsToken', ''));
  if v_env not in ('production', 'staging') then raise exception 'Choose Live (production) or Staging' using errcode = '22023'; end if;
  if v_sub !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' then
    raise exception 'Enter your aXcelerate subdomain: the first part of your aXcelerate address (yourcollege in yourcollege.app.axcelerate.com)' using errcode = '22023';
  end if;
  if v_api !~ '^[A-Za-z0-9._-]+$' or length(v_api) not between 8 and 500 then raise exception 'Enter the aXcelerate API token (from aXcelerate support)' using errcode = '22023'; end if;
  if v_ws !~ '^[A-Za-z0-9._-]+$' or length(v_ws) not between 8 and 500 then raise exception 'Enter the aXcelerate web service token' using errcode = '22023'; end if;
  perform public.integration_credential_write(c.id, 'api_key',
    jsonb_build_object('version', 1, 'fields', jsonb_build_object('environment', v_env, 'subdomain', v_sub, 'apiToken', v_api, 'wsToken', v_ws))::text);
  -- Saved, not yet checked: the status stays not_connected until Check connection gets an answer from aXcelerate.
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id) values (c.id, c.connector_id, 'info', 'credential_rotated', gen_random_uuid());
end;
$$;

/** Removes the saved aXcelerate details (Disconnect). */
create or replace function public.integration_axcelerate_clear(p_connection uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select id, tenant_id, connector_id into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id <> 'axcelerate' then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
  perform public.integration_credential_write(c.id, 'api_key', '');
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id) values (c.id, c.connector_id, 'info', 'credentials_revoked', gen_random_uuid());
end;
$$;

/** What is saved, without the tokens: environment, subdomain, address and the last four characters of each token. */
create or replace function public.integration_axcelerate_summary(p_connection uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c record; v text; f jsonb;
begin
  select id, tenant_id, connector_id into c from public.integration_connections where id = p_connection;
  if not found or c.connector_id <> 'axcelerate' then return null; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) then raise exception 'Administrator access required' using errcode = '42501'; end if;
  v := public.integration_credential_read(c.id, 'api_key');
  if v is null or v = '' then return jsonb_build_object('saved', false); end if;
  f := (v::jsonb)->'fields';
  return jsonb_build_object('saved', true, 'environment', f->>'environment', 'subdomain', f->>'subdomain',
    'baseUrl', 'https://' || (f->>'subdomain') || case when f->>'environment' = 'staging' then '.stg' else '.app' end || '.axcelerate.com/api',
    'apiTokenEnd', '…' || right(f->>'apiToken', 4), 'wsTokenEnd', '…' || right(f->>'wsToken', 4));
end;
$$;

revoke all on function public.integration_axcelerate_save(uuid, jsonb), public.integration_axcelerate_clear(uuid), public.integration_axcelerate_summary(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.integration_axcelerate_save(uuid, jsonb), public.integration_axcelerate_clear(uuid), public.integration_axcelerate_summary(uuid)
  to authenticated;

commit;
