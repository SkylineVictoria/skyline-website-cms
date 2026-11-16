-- COMM-CHANNELS: only connected accounts can be used in the Communication Hub, and every message is recorded there.
-- Channels: email (the existing email service, always connected), SMS (ClickSend), WhatsApp (WhatsApp Business Cloud API) and
-- Microsoft Teams (connected when at least one staff team is linked to a channel, see 20261116224113). An administrator enters the
-- ClickSend / WhatsApp account details in Communication Hub > Channels; they are stored as one Vault secret per channel and never
-- returned (the hub only sees connected / not connected and a non-secret label). Sending SMS / WhatsApp from a conversation now
-- posts to the provider with pg_net from the database (no Edge Function) and is recorded in the conversation with the result read
-- back from pg_net while it keeps responses. A channel that is not connected cannot be used at all (comm_send refuses it).
-- WhatsApp: Meta only delivers free text within 24 hours of the person's last message; otherwise it refuses (shown as not delivered).
-- Additive. Rollback (manual): drop the comm_channel* functions and table public.comm_channel_accounts (and their Vault secrets);
-- alter table public.comm_messages drop column provider_request_id; re-create comm_send / comm_thread from 20261116210000.
begin;

create table public.comm_channel_accounts(
  channel text primary key check (channel in ('sms', 'whatsapp')),
  secret_id uuid not null,
  label text not null default '' check (length(label) <= 120),
  connected_by uuid default auth.uid(),
  connected_at timestamptz not null default now()
);
alter table public.comm_channel_accounts enable row level security;
revoke all on public.comm_channel_accounts from public, anon, authenticated, service_role;

alter table public.comm_messages add column provider_request_id bigint;

/** The decrypted account details of a channel (definer-only helper; never granted). */
create function public.comm_channel_secret(p_channel text) returns jsonb
language sql stable security definer set search_path = public, vault as $$
  select s.decrypted_secret::jsonb from public.comm_channel_accounts a join vault.decrypted_secrets s on s.id = a.secret_id where a.channel = p_channel;
$$;

/** Status of every channel for the hub (no secrets). */
create function public.comm_channels_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_teams int;
begin
  perform public.comm_require_admin();
  select count(*) into v_teams from public.comm_team_microsoft m join public.comm_teams t on t.id = m.team_id where t.archived_at is null;
  return jsonb_build_array(
    jsonb_build_object('channel', 'email', 'connected', true, 'label', 'Your email service', 'managed', true),
    (select jsonb_build_object('channel', 'sms', 'connected', a.channel is not null, 'label', coalesce(a.label, ''), 'connectedAt', a.connected_at)
       from (select 1) x left join public.comm_channel_accounts a on a.channel = 'sms'),
    (select jsonb_build_object('channel', 'whatsapp', 'connected', a.channel is not null, 'label', coalesce(a.label, ''), 'connectedAt', a.connected_at)
       from (select 1) x left join public.comm_channel_accounts a on a.channel = 'whatsapp'),
    jsonb_build_object('channel', 'teams', 'connected', v_teams > 0, 'label', v_teams || ' team' || case when v_teams = 1 then '' else 's' end || ' linked', 'managed', true));
end;
$$;

create function public.comm_channel_store(p_channel text, p_secret jsonb, p_label text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  select secret_id into v_id from public.comm_channel_accounts where channel = p_channel;
  if v_id is null then
    v_id := vault.create_secret(p_secret::text, 'comm_channel_' || p_channel || '_' || replace(gen_random_uuid()::text, '-', ''), 'Communication Hub ' || p_channel || ' account');
    insert into public.comm_channel_accounts(channel, secret_id, label) values (p_channel, v_id, left(p_label, 120));
  else
    perform vault.update_secret(v_id, p_secret::text);
    update public.comm_channel_accounts set label = left(p_label, 120), connected_by = auth.uid(), connected_at = now() where channel = p_channel;
  end if;
end;
$$;

/** ClickSend: API username, API key and an optional sender (an alphanumeric ID of up to 11 characters, or a number). */
create function public.comm_channel_connect_sms(p_username text, p_api_key text, p_sender text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_user text := btrim(coalesce(p_username, '')); v_key text := btrim(coalesce(p_api_key, '')); v_from text := nullif(btrim(coalesce(p_sender, '')), '');
begin
  perform public.comm_require_admin();
  if v_user = '' or length(v_user) > 200 or v_key = '' or length(v_key) < 8 or length(v_key) > 200 then
    raise exception 'Enter the ClickSend API username and API key' using errcode = '22023';
  end if;
  if v_from is not null and v_from !~ '^([A-Za-z][A-Za-z0-9 ]{0,10}|\+[1-9][0-9]{7,14})$' then
    raise exception 'The sender must be up to 11 letters or numbers starting with a letter, or a phone number like +61412345678' using errcode = '22023';
  end if;
  perform public.comm_channel_store('sms', jsonb_build_object('username', v_user, 'apiKey', v_key, 'from', v_from),
    'ClickSend ' || regexp_replace(v_user, '^(.{2}).*(@.*)?$', '\1…\2') || coalesce(' · sender ' || v_from, ''));
end;
$$;

/** WhatsApp Business Cloud API: the phone number ID and a permanent access token from Meta, plus the business number for display. */
create function public.comm_channel_connect_whatsapp(p_phone_number_id text, p_access_token text, p_display_number text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_id text := btrim(coalesce(p_phone_number_id, '')); v_token text := btrim(coalesce(p_access_token, '')); v_show text := btrim(coalesce(p_display_number, ''));
begin
  perform public.comm_require_admin();
  if v_id !~ '^[0-9]{5,30}$' then raise exception 'Enter the WhatsApp phone number ID (numbers only, from Meta)' using errcode = '22023'; end if;
  if length(v_token) < 20 or length(v_token) > 1000 or v_token ~ '\s' then raise exception 'Enter the WhatsApp access token' using errcode = '22023'; end if;
  perform public.comm_channel_store('whatsapp', jsonb_build_object('phoneNumberId', v_id, 'token', v_token),
    'WhatsApp Business' || case when v_show <> '' then ' · ' || left(v_show, 40) else '' end);
end;
$$;

create function public.comm_channel_disconnect(p_channel text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  perform public.comm_require_admin();
  if p_channel not in ('sms', 'whatsapp') then raise exception 'This channel is managed elsewhere' using errcode = '22023'; end if;
  delete from public.comm_channel_accounts where channel = p_channel returning secret_id into v_id;
  if v_id is not null then delete from vault.secrets where id = v_id; end if;
end;
$$;

/** Posts one message to the provider (definer-only helper). Returns the pg_net request id; raises when not connected or the number is invalid. */
create function public.comm_channel_post(p_channel text, p_phone text, p_body text, p_ref text) returns bigint
language plpgsql security definer set search_path = public, net as $$
declare s jsonb := public.comm_channel_secret(p_channel); v_to text := public.notification_normalize_phone(p_phone); v_body text := left(btrim(coalesce(p_body, '')), 1600);
begin
  if s is null then raise exception '% is not connected', case p_channel when 'sms' then 'SMS' else 'WhatsApp' end using errcode = '22023'; end if;
  if v_to is null then raise exception 'This phone number is not a valid mobile number' using errcode = '22023'; end if;
  if v_body = '' then raise exception 'Write a message' using errcode = '22023'; end if;
  if p_channel = 'sms' then
    return net.http_post(url := 'https://rest.clicksend.com/v3/sms/send',
      body := jsonb_build_object('messages', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('source', 'skyline', 'to', v_to, 'body', v_body, 'from', s->>'from', 'custom_string', left(p_ref, 60))))),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Basic ' || encode(convert_to((s->>'username') || ':' || (s->>'apiKey'), 'UTF8'), 'base64')),
      timeout_milliseconds := 15000);
  else
    return net.http_post(url := 'https://graph.facebook.com/v21.0/' || (s->>'phoneNumberId') || '/messages',
      body := jsonb_build_object('messaging_product', 'whatsapp', 'recipient_type', 'individual', 'to', substr(v_to, 2), 'type', 'text', 'text', jsonb_build_object('preview_url', false, 'body', v_body)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (s->>'token')),
      timeout_milliseconds := 15000);
  end if;
end;
$$;

/** Result of a provider request: sent / failed / sending, with a short reason when it failed. */
create function public.comm_provider_result(p_channel text, p_request bigint) returns jsonb
language plpgsql stable security definer set search_path = public, net as $$
declare r record; b jsonb; v_status text;
begin
  if p_request is null then return null; end if;
  select status_code, content, error_msg, timed_out into r from net._http_response where id = p_request;
  if not found then return jsonb_build_object('status', 'sending'); end if;
  if r.error_msg is not null or coalesce(r.timed_out, false) then return jsonb_build_object('status', 'failed', 'reason', 'Could not reach the provider'); end if;
  begin b := r.content::jsonb; exception when others then b := null; end;
  if p_channel = 'sms' then
    v_status := b->'data'->'messages'->0->>'status';
    if r.status_code between 200 and 299 and v_status in ('SUCCESS', 'QUEUED') then return jsonb_build_object('status', 'sent'); end if;
    return jsonb_build_object('status', 'failed', 'reason', coalesce(initcap(replace(lower(v_status), '_', ' ')), b->>'response_msg', 'ClickSend refused the message (' || r.status_code || ')'));
  end if;
  if r.status_code between 200 and 299 and b->'messages'->0->>'id' is not null then return jsonb_build_object('status', 'sent'); end if;
  return jsonb_build_object('status', 'failed', 'reason', coalesce(left(b->'error'->>'message', 200), 'WhatsApp refused the message (' || r.status_code || ')'));
end;
$$;

/** Sends a test message to a phone number through a connected channel; the result is read with comm_channel_test_result. */
create function public.comm_channel_test(p_channel text, p_phone text) returns bigint
language plpgsql security definer set search_path = public as $$
begin
  perform public.comm_require_admin();
  if p_channel not in ('sms', 'whatsapp') then raise exception 'Unknown channel' using errcode = '22023'; end if;
  return public.comm_channel_post(p_channel, p_phone, 'Test from the Skyline Communication Hub. If you received this, ' || case p_channel when 'sms' then 'SMS' else 'WhatsApp' end || ' is connected.', 'test');
end;
$$;

create function public.comm_channel_test_result(p_channel text, p_request bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.comm_require_admin();
  return public.comm_provider_result(p_channel, p_request);
end;
$$;

/** Sends email (existing queue) or SMS / WhatsApp (connected account only), or records an internal note; always recorded in the conversation. */
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
    if not exists (select 1 from public.comm_channel_accounts where channel = p_channel) then
      raise exception '% is not connected. Connect it in Communication Hub > Channels.', case p_channel when 'sms' then 'SMS' else 'WhatsApp' end using errcode = '22023';
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

create or replace function public.comm_thread(p_conversation uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
declare c public.comm_conversations; v jsonb;
begin
  perform public.comm_require_admin();
  select * into c from public.comm_conversations where id = p_conversation;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  with items as (
    select m.id::text id, 'hub'::text source, m.direction, m.channel, m.subject, m.body, m.to_address "to", m.sent_by_name "by", m.template_key "template", m.created_at "at",
      case when m.status = 'queued' and m.channel = 'email' then case
          when d.state in ('sent', 'delivered') then 'sent' when d.state in ('failed', 'bounced', 'complained', 'unknown') then 'failed'
          when d.state = 'suppressed' then 'not_sent' else 'sending' end
        when m.status = 'queued' and m.channel in ('sms', 'whatsapp') then
          case when m.provider_request_id is null then 'failed' else coalesce(public.comm_provider_result(m.channel, m.provider_request_id)->>'status', 'sending') end
        else m.status end status,
      case when m.status = 'queued' and m.channel in ('sms', 'whatsapp') and m.provider_request_id is not null
        then public.comm_provider_result(m.channel, m.provider_request_id)->>'reason' end reason
    from public.comm_messages m left join public.notification_deliveries d on d.id = m.email_delivery_id
    where m.conversation_id = c.id
    union all
    select d.id::text, 'automatic', 'out', 'email', d.subject, d.body, d.recipient_email, 'System', d.event, d.created_at,
      case when d.state in ('sent', 'delivered') then 'sent' when d.state in ('failed', 'bounced', 'complained', 'unknown') then 'failed'
        when d.state = 'suppressed' then 'not_sent' else 'sending' end, null
    from public.notification_deliveries d
    where c.email is not null and lower(d.recipient_email) = lower(c.email) and d.hub_message_id is null
    union all
    select 'hr-' || e.id::text, 'automatic', 'out', 'email', replace(initcap(replace(e.kind, '_', ' ')), 'Hr ', 'HR '), '', e.to_email, 'System', e.kind, e.created_at,
      case when e.state = 'sent' then 'sent' when e.state = 'failed' then 'failed' else 'sending' end, null
    from hr.staff_emails e
    where c.email is not null and lower(e.to_email) = lower(c.email)
  )
  select jsonb_build_object(
    'conversation', jsonb_build_object('id', c.id, 'kind', c.person_kind, 'ref', c.person_ref, 'name', c.display_name, 'email', c.email, 'phone', c.phone),
    'items', coalesce((select jsonb_agg(row_to_json(i)::jsonb order by i."at") from (select * from items order by "at" desc limit 300) i), '[]'::jsonb))
  into v;
  return v;
end;
$$;

revoke all on function public.comm_channel_secret(text), public.comm_channels_status(), public.comm_channel_store(text, jsonb, text),
  public.comm_channel_connect_sms(text, text, text), public.comm_channel_connect_whatsapp(text, text, text), public.comm_channel_disconnect(text),
  public.comm_channel_post(text, text, text, text), public.comm_provider_result(text, bigint), public.comm_channel_test(text, text),
  public.comm_channel_test_result(text, bigint) from public, anon, authenticated, service_role;
grant execute on function public.comm_channels_status(), public.comm_channel_connect_sms(text, text, text), public.comm_channel_connect_whatsapp(text, text, text),
  public.comm_channel_disconnect(text), public.comm_channel_test(text, text), public.comm_channel_test_result(text, bigint) to authenticated;
revoke all on function public.comm_send(uuid, text, text, text, text), public.comm_thread(uuid) from public, anon, service_role;
grant execute on function public.comm_send(uuid, text, text, text, text), public.comm_thread(uuid) to authenticated;

commit;
