-- GOOGLE-MAPS-CONNECTOR: the Google Maps key (Places API (New) Text Search, used by the business auto-fill in document-signing:
-- _shared/google-places.ts) is entered by an administrator in Integrations > Connections, like ClickSend / WhatsApp: connector
-- 'google_maps', one field apiKey, saved by integration_comm_credentials_save -> integration_credential_write (Vault,
-- integration_private.credentials, kind 'api_key', {version:1, fields:{apiKey}}). The key is never returned to a browser:
-- integration_comm_summary shows only its last four characters; Edge Functions read it with the service-role-only
-- public.integration_google_maps_key(). The secret EF_GOOGLE_MAPS_KEY stays as a fallback only (used when no connection is saved).
-- Disconnect = integration_comm_credentials_clear (as the other connectors). document-signing "integration_google_maps_check" makes
-- one Text Search with the saved key and logs the outcome with integration_google_maps_check_record (service role only).
-- Every changed function is the LIVE definition (pg_get_functiondef on xcpydisstlvtvcsqnjob, 2026-11-24) plus the google_maps branch.
-- Additive. Rollback (manual): re-create the three functions from 20261116235211, drop the two new functions, delete the
-- google_maps connection(s) (and their credentials) and the integration_definitions row.
begin;

insert into public.integration_definitions(id, name, auth_type, availability, description) values
  ('google_maps', 'Google Maps', 'api_key', 'available', 'Fill a business''s office address, website and phone when it is added.')
on conflict (id) do nothing;

create or replace function public.integration_comm_credentials_save(p_connection uuid, p_fields jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare c record; f jsonb := coalesce(p_fields, '{}'::jsonb); v_fields jsonb; ch jsonb; v_names text[] := '{}'; v_name text; v_url text;
begin
  select id, tenant_id, connector_id, status into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id not in ('clicksend', 'whatsapp', 'microsoft_teams', 'google_maps') then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
  if c.status = 'disabled' then raise exception 'Enable the connection first' using errcode = '55000'; end if;
  if c.connector_id = 'clicksend' then
    if btrim(coalesce(f->>'username', '')) = '' or length(f->>'username') > 200 or length(btrim(coalesce(f->>'apiKey', ''))) < 8 or length(f->>'apiKey') > 200 then
      raise exception 'Enter the ClickSend API username and API key' using errcode = '22023';
    end if;
    if nullif(btrim(coalesce(f->>'from', '')), '') is not null and btrim(f->>'from') !~ '^([A-Za-z][A-Za-z0-9 ]{0,10}|\+[1-9][0-9]{7,14})$' then
      raise exception 'The sender must be up to 11 letters or numbers starting with a letter, or a number like +61412345678' using errcode = '22023';
    end if;
    v_fields := jsonb_build_object('username', btrim(f->>'username'), 'apiKey', btrim(f->>'apiKey'), 'from', nullif(btrim(coalesce(f->>'from', '')), ''));
  elsif c.connector_id = 'whatsapp' then
    if btrim(coalesce(f->>'phoneNumberId', '')) !~ '^[0-9]{5,30}$' then raise exception 'Enter the WhatsApp phone number ID (numbers only, from Meta)' using errcode = '22023'; end if;
    if length(btrim(coalesce(f->>'token', ''))) < 20 or length(f->>'token') > 1000 or btrim(f->>'token') ~ '\s' then raise exception 'Enter the WhatsApp access token' using errcode = '22023'; end if;
    v_fields := jsonb_build_object('phoneNumberId', btrim(f->>'phoneNumberId'), 'token', btrim(f->>'token'), 'displayNumber', left(btrim(coalesce(f->>'displayNumber', '')), 40));
  elsif c.connector_id = 'google_maps' then
    -- Google API keys are "AIza" + 35 characters; checked loosely (no length ceiling below 200) in case Google lengthens them.
    if btrim(coalesce(f->>'apiKey', '')) !~ '^AIza[0-9A-Za-z_-]{30,}$' or length(btrim(f->>'apiKey')) > 200 then
      raise exception 'Enter the Google Maps API key (it starts with AIza)' using errcode = '22023';
    end if;
    v_fields := jsonb_build_object('apiKey', btrim(f->>'apiKey'));
  else
    if jsonb_typeof(f->'channels') <> 'array' or jsonb_array_length(f->'channels') not between 1 and 20 then
      raise exception 'Add between 1 and 20 Microsoft Teams channels' using errcode = '22023';
    end if;
    for ch in select * from jsonb_array_elements(f->'channels') loop
      v_name := btrim(coalesce(ch->>'name', '')); v_url := btrim(coalesce(ch->>'url', ''));
      if v_name = '' or length(v_name) > 60 then raise exception 'Give every channel a name (up to 60 characters)' using errcode = '22023'; end if;
      if lower(v_name) = any(v_names) then raise exception 'Channel names must be different' using errcode = '22023'; end if;
      if not public.comm_team_microsoft_host_ok(v_url) then raise exception 'The link for "%" is not a Microsoft Teams channel link', v_name using errcode = '22023'; end if;
      v_names := v_names || lower(v_name);
    end loop;
    v_fields := jsonb_build_object('channels', (select jsonb_agg(jsonb_build_object('name', btrim(x->>'name'), 'url', btrim(x->>'url'))) from jsonb_array_elements(f->'channels') x));
  end if;
  perform public.integration_credential_write(c.id, 'api_key', jsonb_build_object('version', 1, 'fields', v_fields)::text);
  update public.integration_connections set status = 'connected', last_success_at = now(), updated_at = now() where id = c.id;
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id) values (c.id, c.connector_id, 'info', 'credential_rotated', gen_random_uuid());
end;
$function$;

create or replace function public.integration_comm_credentials_clear(p_connection uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare c record;
begin
  select id, tenant_id, connector_id into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id not in ('clicksend', 'whatsapp', 'microsoft_teams', 'google_maps') then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
  perform public.integration_credential_write(c.id, 'api_key', '');
  update public.integration_connections set status = case when status = 'disabled' then status else 'not_connected' end, updated_at = now() where id = c.id;
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id) values (c.id, c.connector_id, 'info', 'credentials_revoked', gen_random_uuid());
end;
$function$;

create or replace function public.integration_comm_summary(p_connection uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare c record; v text; f jsonb;
begin
  select id, tenant_id, connector_id into c from public.integration_connections where id = p_connection;
  if not found then return null; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) then raise exception 'Administrator access required' using errcode = '42501'; end if;
  v := public.integration_credential_read(c.id, 'api_key');
  if v is null or v = '' then return jsonb_build_object('saved', false); end if;
  f := (v::jsonb)->'fields';
  return jsonb_build_object('saved', true) || case c.connector_id
    when 'clicksend' then jsonb_build_object('username', left(f->>'username', 2) || '…' || coalesce(substring(f->>'username' from '(@.*)$'), ''), 'from', f->>'from')
    when 'whatsapp' then jsonb_build_object('phoneNumberId', '…' || right(f->>'phoneNumberId', 4), 'displayNumber', nullif(f->>'displayNumber', ''))
    when 'microsoft_teams' then jsonb_build_object('channels', (select jsonb_agg(x->>'name') from jsonb_array_elements(f->'channels') x))
    -- Only the last four characters of the key, never the key.
    when 'google_maps' then jsonb_build_object('keyEnd', '…' || right(f->>'apiKey', 4))
    else '{}'::jsonb end;
end;
$function$;

/** The Google Maps key of the organization-wide connection (null when none is saved or it is disconnected / disabled). Service role only. */
create function public.integration_google_maps_key() returns text
language sql stable security definer set search_path = public as $$
  select nullif(btrim(coalesce(public.integration_comm_fields('google_maps')->>'apiKey', '')), '');
$$;

/** document-signing's "Check connection" outcome: logged on the organization-wide connection; a success also sets last_success_at. Service role only. */
create function public.integration_google_maps_check_record(p_ok boolean, p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text := left(lower(regexp_replace(coalesce(p_code, ''), '[^A-Za-z_]', '_', 'g')), 30);
begin
  select id into v_id from public.integration_connections where connector_id = 'google_maps' and tenant_id is null limit 1;
  if v_id is null then return; end if;
  if p_ok then update public.integration_connections set last_success_at = now(), updated_at = now() where id = v_id; end if;
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id)
  values (v_id, 'google_maps', case when p_ok then 'info' else 'warn' end,
    case when p_ok then 'connection_test_succeeded' else 'connection_test_failed' || case when v_code <> '' then '_' || v_code else '' end end, gen_random_uuid());
end;
$$;

revoke all on function public.integration_comm_credentials_save(uuid, jsonb), public.integration_comm_credentials_clear(uuid), public.integration_comm_summary(uuid),
  public.integration_google_maps_key(), public.integration_google_maps_check_record(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.integration_comm_credentials_save(uuid, jsonb), public.integration_comm_credentials_clear(uuid), public.integration_comm_summary(uuid) to authenticated;
grant execute on function public.integration_google_maps_key(), public.integration_google_maps_check_record(boolean, text) to service_role;

commit;
