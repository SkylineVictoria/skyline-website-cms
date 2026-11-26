-- SMS-DELIVERY-REPORTS (owner 2026-11-26: "add delivery reports"): a text ClickSend accepted is not a text the phone received
-- (Indian mobiles drop unregistered bulk senders). The application timeline now shows Delivered / Not delivered from ClickSend's
-- delivery reports.
-- * public.sms_messages: one row per text ClickSend accepted for an application (ClickSend message id, who, last three digits,
--   status accepted -> delivered / undelivered, ClickSend's status code and text, when). No phone number or message body.
-- * sms_message_sent (service role): student-application-invite records the message id right after ClickSend accepts the text.
-- * Delivery report link: ClickSend posts each report to integrations-webhook?connection=<ClickSend connection>&key=<key>. The key
--   is made by sms_receipt_key_rotate (admins; shown once, only its SHA-256 is kept in skyline_private.sms_receipt_keys) and is
--   checked by sms_receipt_apply. The ClickSend API key / connection status are not touched (integration_credential_write would
--   mark the connection not connected).
-- * sms_receipt_apply (service role): wrong key = refused; unknown message id = ignored; a final status writes one timeline entry
--   (handoff sms_delivered / sms_undelivered with the last three digits and ClickSend's reason) once.
-- * sms_receipt_status (admins): whether the link is set up, when, and the last report received.
-- Down: drop the four functions, public.sms_messages and skyline_private.sms_receipt_keys.
begin;

create table if not exists public.sms_messages (
  message_id text primary key check (message_id ~ '^[A-Za-z0-9-]{8,64}$'),
  application_id uuid references public.enrollment_applications(id) on delete cascade,
  recipient text not null check (recipient in ('student', 'guardian')),
  last_digits text check (last_digits ~ '^[0-9]{0,3}$'),
  status text not null default 'accepted' check (status in ('accepted', 'delivered', 'undelivered')),
  status_code text, status_text text,
  sent_at timestamptz not null default now(),
  reported_at timestamptz
);
create index if not exists sms_messages_application_idx on public.sms_messages(application_id);
alter table public.sms_messages enable row level security;
revoke all on public.sms_messages from public, anon, authenticated;
grant select, insert, update, delete on public.sms_messages to service_role;

create table if not exists skyline_private.sms_receipt_keys (
  id smallint primary key default 1 check (id = 1),
  key_hash text not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  last_report_at timestamptz
);
revoke all on skyline_private.sms_receipt_keys from public, anon, authenticated;

create or replace function public.sms_message_sent(p_message_id text, p_application uuid, p_who text, p_last_digits text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_message_id is null or p_message_id !~ '^[A-Za-z0-9-]{8,64}$' or p_who not in ('student', 'guardian') then return; end if;
  insert into public.sms_messages(message_id, application_id, recipient, last_digits)
  values (p_message_id, p_application, p_who, nullif(right(regexp_replace(coalesce(p_last_digits, ''), '[^0-9]', '', 'g'), 3), ''))
  on conflict (message_id) do nothing;
end $$;
revoke all on function public.sms_message_sent(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.sms_message_sent(text, uuid, text, text) to service_role;

-- A new delivery report key (the old one stops working). Returned once; the browser builds the link.
create or replace function public.sms_receipt_key_rotate() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_key text := encode(extensions.gen_random_bytes(24), 'hex'); v_conn uuid;
begin
  perform public.admin_business_require();
  select id into v_conn from public.integration_connections where connector_id = 'clicksend' and tenant_id is null;
  if v_conn is null then raise exception 'Connect ClickSend first.' using errcode = 'P0002'; end if;
  insert into skyline_private.sms_receipt_keys(id, key_hash, created_by)
  values (1, encode(extensions.digest(v_key, 'sha256'), 'hex'), auth.uid())
  on conflict (id) do update set key_hash = excluded.key_hash, created_at = now(), created_by = excluded.created_by;
  return jsonb_build_object('connectionId', v_conn, 'key', v_key);
end $$;
revoke all on function public.sms_receipt_key_rotate() from public, anon;
grant execute on function public.sms_receipt_key_rotate() to authenticated;

create or replace function public.sms_receipt_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare k skyline_private.sms_receipt_keys;
begin
  perform public.admin_business_require();
  select * into k from skyline_private.sms_receipt_keys where id = 1;
  return jsonb_build_object('configured', k.id is not null, 'createdAt', k.created_at, 'lastReportAt', k.last_report_at,
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.sms_messages group by 1) x));
end $$;
revoke all on function public.sms_receipt_status() from public, anon;
grant execute on function public.sms_receipt_status() to authenticated;

-- One delivery report from ClickSend. Returns 'refused' (wrong key), 'ignored' (not our message / not final / already final) or 'applied'.
create or replace function public.sms_receipt_apply(p_key text, p_message_id text, p_status text, p_code text, p_text text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare m public.sms_messages; v_status text; v_text text := left(nullif(btrim(coalesce(p_text, '')), ''), 160);
begin
  if p_key is null or not exists (select 1 from skyline_private.sms_receipt_keys
      where id = 1 and key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')) then return 'refused'; end if;
  update skyline_private.sms_receipt_keys set last_report_at = now() where id = 1;
  select * into m from public.sms_messages where message_id = p_message_id for update;
  if not found or m.status <> 'accepted' then return 'ignored'; end if;
  -- ClickSend: status "Delivered" (status code 201) = on the handset; Undelivered / Failed / Expired / Rejected / Cancelled = final failure.
  v_status := case when coalesce(p_code, '') = '201' or p_status ~* '^\s*delivered' then 'delivered'
                   when p_status ~* '(undeliver|fail|expire|reject|cancel|invalid|blocked)' then 'undelivered' end;
  if v_status is null then return 'ignored'; end if;
  update public.sms_messages set status = v_status, status_code = left(p_code, 20), status_text = v_text, reported_at = now()
   where message_id = m.message_id;
  if m.application_id is not null then
    perform skyline_private.handoff_log(m.application_id, 'sms_' || v_status,
      jsonb_strip_nulls(jsonb_build_object('to', m.recipient, 'endsWith', m.last_digits, 'reason', case when v_status = 'undelivered' then v_text end)),
      'system', 'Text message');
  end if;
  return 'applied';
end $$;
revoke all on function public.sms_receipt_apply(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.sms_receipt_apply(text, text, text, text, text) to service_role;

commit;
