-- COMM-INBOX: Communication Hub conversations. One conversation per person (student, agent, staff member, job applicant, agency or
-- anyone else); every message staff send from the hub is recorded in it, whatever the channel. Email is sent for real through the
-- existing email queue (a notification_deliveries row with event 'hub_message', sent by email-sender, which claims every event except
-- application_submitted). SMS and WhatsApp are recorded as 'not_connected' until those channels are set up; an internal note is
-- recorded only. The thread also shows the automatic emails the system already sent to the person's address (notification_deliveries
-- and hr.staff_emails), read-only. Replies: comm_record_inbound (service_role only) adds an incoming message to the right conversation
-- once an inbound email / SMS / WhatsApp hook is connected. Admin only (cms_is_admin), like the hub. Additive.
-- Rollback (manual): drop the comm_* functions and tables; alter table public.notification_deliveries drop column hub_message_id;
-- restore notification_deliveries_subject_ref from 20261113430000.
begin;

create table public.comm_conversations(
  id uuid primary key default gen_random_uuid(),
  person_kind text not null check (person_kind in ('student', 'agent', 'staff', 'applicant', 'agency', 'other')),
  person_ref uuid,
  display_name text not null check (length(btrim(display_name)) between 1 and 200),
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (phone is null or length(phone) <= 32),
  last_message_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index comm_conversations_person on public.comm_conversations(person_kind, person_ref) where person_ref is not null;
create index comm_conversations_recent on public.comm_conversations(last_message_at desc nulls last, created_at desc);
create index comm_conversations_email on public.comm_conversations(lower(email)) where email is not null;

create table public.comm_messages(
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.comm_conversations(id) on delete cascade,
  direction text not null check (direction in ('out', 'in')),
  channel text not null check (channel in ('email', 'sms', 'whatsapp', 'note')),
  subject text not null default '' check (length(subject) <= 200),
  body text not null check (length(btrim(body)) between 1 and 4000),
  template_key text,
  to_address text,
  status text not null check (status in ('queued', 'not_connected', 'recorded', 'received')),
  email_delivery_id uuid unique references public.notification_deliveries(id),
  provider_message_id text,
  sent_by uuid,
  sent_by_name text,
  created_at timestamptz not null default now()
);
create index comm_messages_conversation on public.comm_messages(conversation_id, created_at);

alter table public.comm_conversations enable row level security;
alter table public.comm_messages enable row level security;
revoke all on public.comm_conversations, public.comm_messages from public, anon, authenticated, service_role;
grant select on public.comm_conversations, public.comm_messages to service_role;

-- Hub emails ride on the existing queue; a hub message is a valid subject for a delivery row.
alter table public.notification_deliveries add column hub_message_id uuid references public.comm_messages(id);
alter table public.notification_deliveries drop constraint if exists notification_deliveries_subject_ref;
alter table public.notification_deliveries add constraint notification_deliveries_subject_ref
 check (application_id is not null or support_ticket_id is not null or booking_id is not null or assessment_event_id is not null or event like 'support_ticket%' or hub_message_id is not null) not valid;

create function public.comm_require_admin() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can use the Communication Hub' using errcode = '42501'; end if;
end;
$$;

/** People staff can talk to, with any existing conversation. Search matches name, email or phone. */
create function public.comm_people(p_search text default '', p_kind text default '', p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
declare q text := lower(btrim(coalesce(p_search, ''))); v jsonb;
begin
  perform public.comm_require_admin();
  with people as (
    select 'student'::text kind, s.id ref, s.full_name name, s.email, s.phone, coalesce(s.status, '') detail from public.enrollment_students s
    union all
    select 'agent', p.id, p.full_name, p.email, p.phone, coalesce(a.name, '') from public.portal_profiles p
      join public.agency_memberships m on m.user_id = p.id and m.role <> 'student' left join public.agencies a on a.id = m.agency_id
      where coalesce(p.is_test, false) = false
    union all
    select case when sp.status in ('active', 'inactive') then 'staff' else 'applicant' end, sp.id,
      btrim(concat_ws(' ', sp.first_name, sp.last_name)), sp.email, sp.phone_e164, sp.status from hr.staff_profiles sp
    union all
    select 'agency', ag.id, ag.name, ag.business_email, ag.phone, coalesce(ag.primary_contact, '') from public.agencies ag
  ), found as (
    select distinct on (pp.kind, pp.ref) pp.*, c.id conversation_id, c.last_message_at from people pp
    left join public.comm_conversations c on c.person_kind = pp.kind and c.person_ref = pp.ref
    where (coalesce(p_kind, '') = '' or pp.kind = p_kind)
      and (q = '' or lower(coalesce(pp.name, '')) like '%' || q || '%' or lower(coalesce(pp.email, '')) like '%' || q || '%' or coalesce(pp.phone, '') like '%' || q || '%')
      and coalesce(btrim(pp.name), '') <> ''
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'ref', ref, 'name', name, 'email', email, 'phone', phone, 'detail', detail,
    'conversationId', conversation_id, 'lastMessageAt', last_message_at) order by last_message_at desc nulls last, lower(name)), '[]'::jsonb)
  into v from (select * from found order by last_message_at desc nulls last, lower(name) limit greatest(1, least(coalesce(p_limit, 50), 200))) x;
  return v;
end;
$$;

/** Opens (or creates) the conversation for a person. For 'other', give a name and an email or phone. Contact details are refreshed. */
create function public.comm_open_conversation(p_kind text, p_ref uuid, p_name text default null, p_email text default null, p_phone text default null) returns uuid
language plpgsql security definer set search_path = public, hr as $$
declare v_name text; v_email text; v_phone text; v_id uuid;
begin
  perform public.comm_require_admin();
  if p_kind = 'student' then select full_name, email, phone into v_name, v_email, v_phone from public.enrollment_students where id = p_ref;
  elsif p_kind = 'agent' then select full_name, email, phone into v_name, v_email, v_phone from public.portal_profiles where id = p_ref;
  elsif p_kind in ('staff', 'applicant') then select btrim(concat_ws(' ', first_name, last_name)), email, phone_e164 into v_name, v_email, v_phone from hr.staff_profiles where id = p_ref;
  elsif p_kind = 'agency' then select name, business_email, phone into v_name, v_email, v_phone from public.agencies where id = p_ref;
  elsif p_kind = 'other' then v_name := btrim(coalesce(p_name, '')); v_email := nullif(btrim(coalesce(p_email, '')), ''); v_phone := nullif(btrim(coalesce(p_phone, '')), '');
    if v_name = '' or (v_email is null and v_phone is null) then raise exception 'Give a name and an email or phone number' using errcode = '22023'; end if;
  else raise exception 'Unknown person type' using errcode = '22023';
  end if;
  if coalesce(btrim(v_name), '') = '' then raise exception 'Person not found' using errcode = 'P0002'; end if;
  v_email := nullif(btrim(coalesce(v_email, '')), '');
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;
  v_phone := nullif(btrim(coalesce(v_phone, '')), '');
  if p_kind <> 'other' then
    select id into v_id from public.comm_conversations where person_kind = p_kind and person_ref = p_ref;
  end if;
  if v_id is null then
    insert into public.comm_conversations(person_kind, person_ref, display_name, email, phone)
    values (p_kind, case when p_kind = 'other' then null else p_ref end, left(v_name, 200), v_email, left(v_phone, 32)) returning id into v_id;
  else
    update public.comm_conversations set display_name = left(v_name, 200), email = v_email, phone = left(v_phone, 32), updated_at = now() where id = v_id;
  end if;
  return v_id;
end;
$$;

/** Conversations with their latest message, most recent first. */
create function public.comm_conversations_list(p_search text default '', p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q text := lower(btrim(coalesce(p_search, ''))); v jsonb;
begin
  perform public.comm_require_admin();
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x."lastMessageAt" desc nulls last, x."createdAt" desc), '[]'::jsonb) into v from (
    select c.id, c.person_kind "kind", c.person_ref "ref", c.display_name "name", c.email, c.phone, c.last_message_at "lastMessageAt", c.created_at "createdAt",
      (select jsonb_build_object('channel', m.channel, 'direction', m.direction, 'text', left(coalesce(nullif(m.subject, ''), m.body), 120), 'at', m.created_at)
         from public.comm_messages m where m.conversation_id = c.id order by m.created_at desc limit 1) "last"
    from public.comm_conversations c
    where q = '' or lower(c.display_name) like '%' || q || '%' or lower(coalesce(c.email, '')) like '%' || q || '%' or coalesce(c.phone, '') like '%' || q || '%'
    order by c.last_message_at desc nulls last, c.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) x;
  return v;
end;
$$;

/** Everything recorded for a conversation: hub messages plus automatic emails already sent to the person's address, oldest first. */
create function public.comm_thread(p_conversation uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
declare c public.comm_conversations; v jsonb;
begin
  perform public.comm_require_admin();
  select * into c from public.comm_conversations where id = p_conversation;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  with items as (
    select m.id::text id, 'hub'::text source, m.direction, m.channel, m.subject, m.body, m.to_address "to", m.sent_by_name "by", m.template_key "template", m.created_at "at",
      case when m.status = 'queued' then case
          when d.state in ('sent', 'delivered') then 'sent' when d.state in ('failed', 'bounced', 'complained', 'unknown') then 'failed'
          when d.state = 'suppressed' then 'not_sent' else 'sending' end
        else m.status end status
    from public.comm_messages m left join public.notification_deliveries d on d.id = m.email_delivery_id
    where m.conversation_id = c.id
    union all
    select d.id::text, 'automatic', 'out', 'email', d.subject, d.body, d.recipient_email, 'System', d.event, d.created_at,
      case when d.state in ('sent', 'delivered') then 'sent' when d.state in ('failed', 'bounced', 'complained', 'unknown') then 'failed'
        when d.state = 'suppressed' then 'not_sent' else 'sending' end
    from public.notification_deliveries d
    where c.email is not null and lower(d.recipient_email) = lower(c.email) and d.hub_message_id is null
    union all
    select 'hr-' || e.id::text, 'automatic', 'out', 'email', replace(initcap(replace(e.kind, '_', ' ')), 'Hr ', 'HR '), '', e.to_email, 'System', e.kind, e.created_at,
      case when e.state = 'sent' then 'sent' when e.state = 'failed' then 'failed' else 'sending' end
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

/** Sends (email) or records (SMS / WhatsApp until connected, internal note) a message to the conversation's person. */
create function public.comm_send(p_conversation uuid, p_channel text, p_subject text, p_body text, p_template_key text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare c public.comm_conversations; v_id uuid; v_delivery uuid; v_name text; v_subject text := btrim(coalesce(p_subject, '')); v_body text := btrim(coalesce(p_body, ''));
begin
  perform public.comm_require_admin();
  select * into c from public.comm_conversations where id = p_conversation for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  if p_channel not in ('email', 'sms', 'whatsapp', 'note') then raise exception 'Unknown channel' using errcode = '22023'; end if;
  if v_body = '' or length(v_body) > 4000 then raise exception 'Write a message (up to 4000 characters)' using errcode = '22023'; end if;
  if length(v_subject) > 200 then raise exception 'The subject is too long' using errcode = '22023'; end if;
  if p_channel = 'email' and c.email is null then raise exception 'This person has no email address' using errcode = '22023'; end if;
  if p_channel = 'email' and v_subject = '' then raise exception 'Email needs a subject' using errcode = '22023'; end if;
  if p_channel in ('sms', 'whatsapp') and c.phone is null then raise exception 'This person has no phone number' using errcode = '22023'; end if;
  select name into v_name from public.cms_users where auth_user_id = auth.uid();
  insert into public.comm_messages(conversation_id, direction, channel, subject, body, template_key, to_address, status, sent_by, sent_by_name)
  values (c.id, 'out', p_channel, case when p_channel = 'email' then v_subject else '' end, v_body, nullif(btrim(coalesce(p_template_key, '')), ''),
    case p_channel when 'email' then c.email when 'note' then null else c.phone end,
    case p_channel when 'email' then 'queued' when 'note' then 'recorded' else 'not_connected' end, auth.uid(), v_name)
  returning id into v_id;
  if p_channel = 'email' then
    insert into public.notification_deliveries(tenant_id, recipient_email, event, template_source, subject, body, hub_message_id)
    values (null, c.email, 'hub_message', 'default', v_subject, v_body, v_id) returning id into v_delivery;
    update public.comm_messages set email_delivery_id = v_delivery where id = v_id;
  end if;
  update public.comm_conversations set last_message_at = now(), updated_at = now() where id = c.id;
  return v_id;
end;
$$;

/** For a future inbound hook (service_role only): records a reply in the matching conversation, or opens one for an unknown sender. */
create function public.comm_record_inbound(p_channel text, p_from text, p_name text, p_subject text, p_body text, p_provider_message_id text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_conv uuid; v_id uuid; v_from text := btrim(coalesce(p_from, ''));
begin
  if p_channel not in ('email', 'sms', 'whatsapp') or v_from = '' or btrim(coalesce(p_body, '')) = '' then raise exception 'Invalid inbound message' using errcode = '22023'; end if;
  if p_provider_message_id is not null and exists (select 1 from public.comm_messages where provider_message_id = p_provider_message_id and direction = 'in') then
    select id into v_id from public.comm_messages where provider_message_id = p_provider_message_id and direction = 'in'; return v_id;
  end if;
  if p_channel = 'email' then
    select id into v_conv from public.comm_conversations where lower(email) = lower(v_from) order by last_message_at desc nulls last limit 1;
  else
    select id into v_conv from public.comm_conversations
    where coalesce(public.notification_normalize_phone(phone), regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g')) = coalesce(public.notification_normalize_phone(v_from), regexp_replace(v_from, '[^0-9+]', '', 'g'))
      and phone is not null order by last_message_at desc nulls last limit 1;
  end if;
  if v_conv is null then
    insert into public.comm_conversations(person_kind, display_name, email, phone)
    values ('other', left(coalesce(nullif(btrim(p_name), ''), v_from), 200), case when p_channel = 'email' and v_from ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_from end,
      case when p_channel <> 'email' then left(v_from, 32) end) returning id into v_conv;
  end if;
  insert into public.comm_messages(conversation_id, direction, channel, subject, body, to_address, status, provider_message_id)
  values (v_conv, 'in', p_channel, left(coalesce(p_subject, ''), 200), left(btrim(p_body), 4000), v_from, 'received', left(p_provider_message_id, 200)) returning id into v_id;
  update public.comm_conversations set last_message_at = now(), updated_at = now() where id = v_conv;
  return v_id;
end;
$$;

revoke all on function public.comm_require_admin(), public.comm_people(text, text, integer), public.comm_open_conversation(text, uuid, text, text, text),
  public.comm_conversations_list(text, integer), public.comm_thread(uuid), public.comm_send(uuid, text, text, text, text),
  public.comm_record_inbound(text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.comm_people(text, text, integer), public.comm_open_conversation(text, uuid, text, text, text),
  public.comm_conversations_list(text, integer), public.comm_thread(uuid), public.comm_send(uuid, text, text, text, text) to authenticated;
grant execute on function public.comm_record_inbound(text, text, text, text, text, text) to service_role;

commit;
