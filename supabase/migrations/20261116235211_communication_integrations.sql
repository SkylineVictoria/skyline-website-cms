-- COMM-INTEGRATIONS: every external account used by the Communication Hub lives in Integrations > Connections, like Stripe.
-- New connectors: clicksend (SMS), whatsapp (WhatsApp Business, Meta Cloud API) and microsoft_teams (named Microsoft Teams channel
-- links). Their details are saved with integration_credential_write (Vault, integration_private.credentials, kind 'api_key', one JSON
-- document {version:1, fields:{...}}) through integration_comm_credentials_save, which checks integration_can_manage for the
-- connection's organization exactly like the integrations-admin function. Details are never returned; integration_comm_summary gives
-- a non-secret description (masked username, sender, channel names).
-- The hub stops keeping its own copies: comm_channel_accounts (empty when this was written) and its connect / disconnect / store
-- functions are dropped; comm_team_microsoft now names one of the Microsoft Teams connection's channels instead of holding a link.
-- The hub uses the organization-wide (tenant_id null) connection of each connector, as Stripe does. Additive otherwise.
-- Rollback (manual): delete the three integration_definitions rows (and their connections / credentials); re-create the objects
-- from 20261116224113 and 20261116231907.
begin;

insert into public.integration_definitions(id, name, auth_type, availability, description) values
  ('clicksend', 'ClickSend (SMS)', 'api_key', 'available', 'Send text messages from the Communication Hub.'),
  ('whatsapp', 'WhatsApp Business', 'api_key', 'available', 'Send WhatsApp messages from the Communication Hub (Meta WhatsApp Cloud API).'),
  ('microsoft_teams', 'Microsoft Teams channels', 'api_key', 'available', 'Copy Communication Hub team chats into Microsoft Teams channels.')
on conflict (id) do nothing;

/** The saved fields of a hub connector's organization-wide connection (definer-only; never granted). */
create function public.integration_comm_fields(p_connector text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid; v text;
begin
  select id into v_id from public.integration_connections
  where connector_id = p_connector and tenant_id is null and status = 'connected' and credential_configured limit 1;
  if v_id is null then return null; end if;
  v := public.integration_credential_read(v_id, 'api_key');
  if v is null or v = '' then return null; end if;
  return (v::jsonb)->'fields';
exception when others then return null;
end;
$$;

/** Saves the details of a ClickSend / WhatsApp / Microsoft Teams connection (Integrations > Connections > Manage). */
create function public.integration_comm_credentials_save(p_connection uuid, p_fields jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare c record; f jsonb := coalesce(p_fields, '{}'::jsonb); v_fields jsonb; ch jsonb; v_names text[] := '{}'; v_name text; v_url text;
begin
  select id, tenant_id, connector_id, status into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id not in ('clicksend', 'whatsapp', 'microsoft_teams') then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
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
$$;

create function public.integration_comm_credentials_clear(p_connection uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select id, tenant_id, connector_id into c from public.integration_connections where id = p_connection;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not coalesce(public.integration_can_manage(c.tenant_id), false) or not coalesce(public.integration_module_access(), false) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if c.connector_id not in ('clicksend', 'whatsapp', 'microsoft_teams') then raise exception 'This application is set up elsewhere' using errcode = '22023'; end if;
  perform public.integration_credential_write(c.id, 'api_key', '');
  update public.integration_connections set status = case when status = 'disabled' then status else 'not_connected' end, updated_at = now() where id = c.id;
  insert into public.integration_logs(connection_id, connector_id, severity, code, correlation_id) values (c.id, c.connector_id, 'info', 'credentials_revoked', gen_random_uuid());
end;
$$;

/** Non-secret description of a hub connection's saved details. */
create function public.integration_comm_summary(p_connection uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
    else '{}'::jsonb end;
end;
$$;

-- ---- the hub reads its accounts from Integrations --------------------------------------------------------------------------------
drop function public.comm_channel_connect_sms(text, text, text);
drop function public.comm_channel_connect_whatsapp(text, text, text);
drop function public.comm_channel_disconnect(text);
drop function public.comm_channel_store(text, jsonb, text);
drop table public.comm_channel_accounts;

create or replace function public.comm_channel_secret(p_channel text) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.integration_comm_fields(case p_channel when 'sms' then 'clicksend' when 'whatsapp' then 'whatsapp' end);
$$;

create or replace function public.comm_channels_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_sms jsonb := public.integration_comm_fields('clicksend'); v_wa jsonb := public.integration_comm_fields('whatsapp');
  v_ms jsonb := public.integration_comm_fields('microsoft_teams'); v_teams int;
begin
  perform public.comm_require_admin();
  select count(*) into v_teams from public.comm_team_microsoft m join public.comm_teams t on t.id = m.team_id where t.archived_at is null;
  return jsonb_build_array(
    jsonb_build_object('channel', 'email', 'connected', true, 'label', 'Your email service', 'managed', true),
    jsonb_build_object('channel', 'sms', 'connected', v_sms is not null, 'label', case when v_sms is null then '' else 'ClickSend' || coalesce(' · sender ' || (v_sms->>'from'), '') end),
    jsonb_build_object('channel', 'whatsapp', 'connected', v_wa is not null, 'label', case when v_wa is null then '' else 'WhatsApp Business' || coalesce(' · ' || nullif(v_wa->>'displayNumber', ''), '') end),
    jsonb_build_object('channel', 'teams', 'connected', v_ms is not null, 'label', case when v_ms is null then '' else
      jsonb_array_length(v_ms->'channels') || ' channel' || case when jsonb_array_length(v_ms->'channels') = 1 then '' else 's' end || ', ' || v_teams || ' team' || case when v_teams = 1 then '' else 's' end || ' linked' end));
end;
$$;

create or replace function public.comm_send(p_conversation uuid, p_channel text, p_subject text, p_body text, p_template_key text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare c public.comm_conversations; v_id uuid; v_delivery uuid; v_name text; v_req bigint;
  v_subject text := btrim(coalesce(p_subject, '')); v_body text := btrim(coalesce(p_body, ''));
begin
  perform public.comm_require_admin();
  select * into c from public.comm_conversations where id = p_conversation for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  if p_channel not in ('email', 'sms', 'whatsapp', 'note') then raise exception 'Unknown channel' using errcode = '22023'; end if;
  if v_body = '' or length(v_body) > 4000 then raise exception 'Write a message (up to 4000 characters)' using errcode = '22023'; end if;
  if length(v_subject) > 200 then raise exception 'The subject is too long' using errcode = '22023'; end if;
  if p_channel = 'email' and c.email is null then raise exception 'This person has no email address' using errcode = '22023'; end if;
  if p_channel = 'email' and v_subject = '' then raise exception 'Email needs a subject' using errcode = '22023'; end if;
  if p_channel in ('sms', 'whatsapp') then
    if public.comm_channel_secret(p_channel) is null then
      raise exception '% is not connected. Connect it in Integrations > Connections.', case p_channel when 'sms' then 'SMS (ClickSend)' else 'WhatsApp Business' end using errcode = '22023';
    end if;
    if c.phone is null then raise exception 'This person has no phone number' using errcode = '22023'; end if;
  end if;
  select name into v_name from public.cms_users where auth_user_id = auth.uid();
  insert into public.comm_messages(conversation_id, direction, channel, subject, body, template_key, to_address, status, sent_by, sent_by_name)
  values (c.id, 'out', p_channel, case when p_channel = 'email' then v_subject else '' end, v_body, nullif(btrim(coalesce(p_template_key, '')), ''),
    case p_channel when 'email' then c.email when 'note' then null else c.phone end,
    case p_channel when 'note' then 'recorded' else 'queued' end, auth.uid(), v_name)
  returning id into v_id;
  if p_channel = 'email' then
    insert into public.notification_deliveries(tenant_id, recipient_email, event, template_source, subject, body, hub_message_id)
    values (null, c.email, 'hub_message', 'default', v_subject, v_body, v_id) returning id into v_delivery;
    update public.comm_messages set email_delivery_id = v_delivery where id = v_id;
  elsif p_channel in ('sms', 'whatsapp') then
    v_req := public.comm_channel_post(p_channel, c.phone, v_body, v_id::text);
    update public.comm_messages set provider_request_id = v_req where id = v_id;
  end if;
  update public.comm_conversations set last_message_at = now(), updated_at = now() where id = c.id;
  return v_id;
end;
$$;

-- ---- staff teams pick one of the Microsoft Teams connection's channels by name ------------------------------------------------
alter table public.comm_team_microsoft drop column webhook_url;
alter table public.comm_team_microsoft add column channel_name text not null check (length(btrim(channel_name)) between 1 and 60);

/** The webhook link of a named channel of the Microsoft Teams connection (definer-only). */
create function public.comm_team_microsoft_url(p_channel_name text) returns text
language sql stable security definer set search_path = public as $$
  select x->>'url' from jsonb_array_elements(coalesce(public.integration_comm_fields('microsoft_teams')->'channels', '[]'::jsonb)) x
  where lower(x->>'name') = lower(btrim(p_channel_name)) limit 1;
$$;

/** Channel names an admin can link a team to (no links). */
create function public.comm_team_microsoft_channels() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can manage teams' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x->>'name') from jsonb_array_elements(coalesce(public.integration_comm_fields('microsoft_teams')->'channels', '[]'::jsonb)) x), '[]'::jsonb);
end;
$$;

drop function public.comm_team_microsoft_set(uuid, text);
create function public.comm_team_microsoft_set(p_team uuid, p_channel_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v text := btrim(coalesce(p_channel_name, ''));
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can manage teams' using errcode = '42501'; end if;
  if not exists (select 1 from public.comm_teams where id = p_team) then raise exception 'Team not found' using errcode = 'P0002'; end if;
  if v = '' then delete from public.comm_team_microsoft where team_id = p_team; return; end if;
  if public.comm_team_microsoft_url(v) is null then
    raise exception 'Add this channel in Integrations > Connections > Microsoft Teams channels first' using errcode = '22023';
  end if;
  insert into public.comm_team_microsoft(team_id, channel_name) values (p_team, v)
  on conflict (team_id) do update set channel_name = excluded.channel_name, connected_by = auth.uid(), connected_at = now();
end;
$$;

create or replace function public.comm_team_microsoft_test(p_team uuid) returns bigint
language plpgsql security definer set search_path = public, net as $$
declare v_url text; v_name text;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can manage teams' using errcode = '42501'; end if;
  select public.comm_team_microsoft_url(m.channel_name), t.name into v_url, v_name from public.comm_team_microsoft m join public.comm_teams t on t.id = m.team_id where m.team_id = p_team;
  if v_url is null or not public.comm_team_microsoft_host_ok(v_url) then raise exception 'This team is not linked to a Microsoft Teams channel' using errcode = '22023'; end if;
  return net.http_post(url := v_url, body := public.comm_team_microsoft_card(v_name, 'Skyline Communication Hub',
    'This channel is now connected. Messages posted in the ' || v_name || ' team will appear here.'),
    headers := jsonb_build_object('Content-Type', 'application/json'), timeout_milliseconds := 10000);
end;
$$;

create or replace function public.comm_team_to_microsoft() returns trigger
language plpgsql security definer set search_path = public, net as $$
declare v_url text; v_name text; v_id bigint;
begin
  select public.comm_team_microsoft_url(m.channel_name), t.name into v_url, v_name from public.comm_team_microsoft m join public.comm_teams t on t.id = m.team_id
  where m.team_id = new.team_id and t.archived_at is null;
  if v_url is null or not public.comm_team_microsoft_host_ok(v_url) then return null; end if;
  begin
    v_id := net.http_post(url := v_url, body := public.comm_team_microsoft_card(v_name, new.author_name, new.body),
      headers := jsonb_build_object('Content-Type', 'application/json'), timeout_milliseconds := 10000);
    update public.comm_team_messages set microsoft_request_id = v_id where id = new.id;
  exception when others then
    null; -- the hub message stays saved; the Teams copy is best-effort
  end;
  return null;
end;
$$;

create or replace function public.comm_team_thread(p_team uuid) returns jsonb
language plpgsql security definer set search_path = public, net as $$
declare v_me text; t public.comm_teams; v jsonb; v_channel text;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can use the Communication Hub' using errcode = '42501'; end if;
  v_me := public.comm_me();
  select * into t from public.comm_teams where id = p_team;
  if not found then raise exception 'Team not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.comm_team_members where team_id = p_team and cms_user_id = v_me) then
    raise exception 'Only members can read this team''s messages' using errcode = '42501';
  end if;
  update public.comm_team_members set last_read_at = now() where team_id = p_team and cms_user_id = v_me;
  select channel_name into v_channel from public.comm_team_microsoft where team_id = p_team;
  select jsonb_build_object(
    'team', jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'archived', t.archived_at is not null,
      'microsoft', v_channel is not null, 'microsoftHost', v_channel),
    'me', v_me,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email) order by lower(u.name))
      from public.comm_team_members m join public.cms_users u on u.id = m.cms_user_id where m.team_id = p_team), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'authorId', x.author_cms_user_id, 'author', x.author_name, 'body', x.body, 'at', x.created_at,
        'microsoft', case when x.microsoft_request_id is null then null
          when r.status_code between 200 and 299 then 'sent' when r.status_code is not null or r.error_msg is not null then 'failed' else 'sending' end) order by x.created_at)
      from (select * from public.comm_team_messages where team_id = p_team order by created_at desc limit 500) x
      left join net._http_response r on r.id = x.microsoft_request_id), '[]'::jsonb))
  into v;
  return v;
end;
$$;

revoke all on function public.integration_comm_fields(text), public.integration_comm_credentials_save(uuid, jsonb), public.integration_comm_credentials_clear(uuid),
  public.integration_comm_summary(uuid), public.comm_channel_secret(text), public.comm_channels_status(), public.comm_send(uuid, text, text, text, text),
  public.comm_team_microsoft_url(text), public.comm_team_microsoft_channels(), public.comm_team_microsoft_set(uuid, text), public.comm_team_microsoft_test(uuid),
  public.comm_team_to_microsoft(), public.comm_team_thread(uuid) from public, anon, authenticated, service_role;
grant execute on function public.integration_comm_credentials_save(uuid, jsonb), public.integration_comm_credentials_clear(uuid), public.integration_comm_summary(uuid),
  public.comm_channels_status(), public.comm_send(uuid, text, text, text, text), public.comm_team_microsoft_channels(), public.comm_team_microsoft_set(uuid, text),
  public.comm_team_microsoft_test(uuid), public.comm_team_thread(uuid) to authenticated;

commit;
