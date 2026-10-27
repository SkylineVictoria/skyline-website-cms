-- P07-02: delivery lifecycle for the notification outbox (mock-first Postmark, authenticated and deduplicated callbacks).
-- Sending: a worker claims one pending delivery under a lease (notification_claim_delivery), calls the provider, and records
-- the outcome with the lease token (notification_record_attempt). Only a definitive "not accepted" (429, 5xx) is retried, up to
-- 3 attempts, then the delivery is 'failed' (dead letter). A request whose outcome is unknown (timeout, network failure, or a worker
-- that died while 'sending') is NEVER resent automatically: Postmark has no idempotency key, so it becomes 'unknown' for review.
-- A delivery whose recipient opted out since creation, or whose institution is suspended, is not sent.
-- Callbacks: Postmark signs nothing, so the Edge Function authenticates with HTTP Basic credentials; this layer deduplicates by
-- event key (RecordType:MessageID:ID) and moves a delivery forward only (sent/unknown -> delivered -> bounced -> complained);
-- an event that arrives before its message id is recorded is kept and applied when the id is recorded.
-- Also fixes notification_render to substitute placeholders in a single pass, so a value that itself looks like {{placeholder}}
-- is never expanded.
--
-- Rollback / compensation (additive; run manually):
--   drop function if exists public.notification_claim_delivery(), public.notification_record_attempt(uuid, uuid, text, text, text, boolean, integer),
--     public.notification_apply_provider_event(text, text, text, jsonb), public.notification_transition(uuid, text, jsonb);
--   drop table if exists public.notification_provider_events, public.notification_delivery_attempts;
--   re-create public.notification_render from 20261026180000, and (only if no delivery has left pending/suppressed) restore the
--   original state check and drop the added notification_deliveries columns.
-- Never applied to the hosted project without release approval.
begin;

create or replace function public.notification_render(p_text text, p_vars jsonb) returns text
language plpgsql immutable set search_path = public as $$
declare r text := p_text; k text; v text; i integer := 0; vals text[] := '{}';
begin
  for k, v in select key, value from jsonb_each_text(p_vars) loop
    i := i + 1;
    r := replace(r, '{{' || k || '}}', chr(1) || i || chr(2));
    vals[i] := left(regexp_replace(translate(coalesce(v, ''), chr(1) || chr(2), ''), '[\r\n\t]+', ' ', 'g'), 200);
  end loop;
  for j in 1..i loop r := replace(r, chr(1) || j || chr(2), vals[j]); end loop;
  return r;
end;
$$;

alter table public.notification_deliveries drop constraint notification_deliveries_state_check;
alter table public.notification_deliveries add constraint notification_deliveries_state_check
  check (state in ('pending', 'suppressed', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'unknown'));
alter table public.notification_deliveries
  add column attempt_count integer not null default 0,
  add column next_attempt_at timestamptz not null default now(),
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column provider_message_id text,
  add column last_error_code text,
  add column sent_at timestamptz,
  add column updated_at timestamptz not null default now();
create unique index notification_deliveries_provider_message on public.notification_deliveries(provider_message_id) where provider_message_id is not null;
drop index public.notification_deliveries_pending;
create index notification_deliveries_ready on public.notification_deliveries(next_attempt_at, seq) where state = 'pending';

create table public.notification_delivery_attempts(
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.notification_deliveries(id),
  attempt_number integer not null,
  outcome text not null check (outcome in ('accepted', 'failed', 'unknown')),
  error_code text,
  provider_message_id text,
  created_at timestamptz not null default clock_timestamp(),
  unique (delivery_id, attempt_number)
);
create table public.notification_provider_events(
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  record_type text not null check (record_type in ('Delivery', 'Bounce', 'SpamComplaint')),
  provider_message_id text not null,
  delivery_id uuid references public.notification_deliveries(id),
  detail jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default clock_timestamp()
);
create index notification_provider_events_message on public.notification_provider_events(provider_message_id);
alter table public.notification_delivery_attempts enable row level security;
alter table public.notification_provider_events enable row level security;
revoke all on public.notification_delivery_attempts, public.notification_provider_events from public, anon, authenticated, service_role;
grant select on public.notification_delivery_attempts, public.notification_provider_events to service_role;

create function public.notification_claim_delivery() returns setof public.notification_deliveries
language plpgsql security definer set search_path = public as $$
declare d public.notification_deliveries;
begin
  update public.notification_deliveries set state = 'unknown', last_error_code = 'lease_expired', lease_token = null, lease_expires_at = null, updated_at = now()
  where state = 'sending' and lease_expires_at < clock_timestamp();
  select * into d from public.notification_deliveries x
  where x.state = 'pending' and x.next_attempt_at <= now()
    and (x.tenant_id is null or exists (select 1 from public.tenants t where t.id = x.tenant_id and t.status = 'active'))
  order by x.seq for update skip locked limit 1;
  if not found then return; end if;
  if exists (select 1 from public.notification_preferences p where p.auth_user_id = d.recipient_user and p.event = d.event and not p.email_enabled) then
    update public.notification_deliveries set state = 'suppressed', state_reason = 'recipient_opted_out', updated_at = now() where id = d.id;
    return;
  end if;
  update public.notification_deliveries set state = 'sending', attempt_count = attempt_count + 1, lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '3 minutes', updated_at = now() where id = d.id returning * into d;
  return next d;
end;
$$;

create function public.notification_transition(p_delivery uuid, p_record_type text, p_detail jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_record_type = 'Delivery' then
    update public.notification_deliveries set state = 'delivered', updated_at = now() where id = p_delivery and state in ('sent', 'unknown');
  elsif p_record_type = 'Bounce' then
    update public.notification_deliveries set state = 'bounced', last_error_code = left(coalesce(p_detail->>'type', 'bounce'), 60), updated_at = now()
    where id = p_delivery and state in ('sent', 'unknown', 'delivered');
  elsif p_record_type = 'SpamComplaint' then
    update public.notification_deliveries set state = 'complained', updated_at = now() where id = p_delivery and state in ('sent', 'unknown', 'delivered', 'bounced');
  end if;
end;
$$;

create function public.notification_record_attempt(p_id uuid, p_lease uuid, p_outcome text, p_message_id text, p_error text, p_retry boolean, p_delay integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare d public.notification_deliveries; e record;
begin
  if p_outcome not in ('accepted', 'failed', 'unknown') then raise exception 'Unknown outcome' using errcode = '22023'; end if;
  select * into d from public.notification_deliveries where id = p_id for update;
  if not found or d.state <> 'sending' or p_lease is null or d.lease_token is distinct from p_lease or d.lease_expires_at <= clock_timestamp() then return false; end if;
  if p_outcome = 'accepted' then
    if nullif(trim(coalesce(p_message_id, '')), '') is null then raise exception 'Accepted needs a provider message id' using errcode = '22023'; end if;
    update public.notification_deliveries set state = 'sent', provider_message_id = p_message_id, sent_at = now(), lease_token = null, lease_expires_at = null, last_error_code = null, updated_at = now() where id = d.id;
  elsif p_outcome = 'failed' then
    if coalesce(p_retry, false) and d.attempt_count < 3 then
      update public.notification_deliveries set state = 'pending', next_attempt_at = now() + make_interval(secs => greatest(1, least(coalesce(p_delay, 60), 900))),
        lease_token = null, lease_expires_at = null, last_error_code = left(p_error, 60), updated_at = now() where id = d.id;
    else
      update public.notification_deliveries set state = 'failed', lease_token = null, lease_expires_at = null, last_error_code = left(p_error, 60), updated_at = now() where id = d.id;
    end if;
  else
    update public.notification_deliveries set state = 'unknown', lease_token = null, lease_expires_at = null, last_error_code = left(p_error, 60), updated_at = now() where id = d.id;
  end if;
  insert into public.notification_delivery_attempts(delivery_id, attempt_number, outcome, error_code, provider_message_id)
  values (d.id, d.attempt_count, p_outcome, left(p_error, 60), case when p_outcome = 'accepted' then p_message_id end);
  if p_outcome = 'accepted' then
    for e in select id, record_type, detail from public.notification_provider_events where provider_message_id = p_message_id and delivery_id is null order by received_at, id loop
      update public.notification_provider_events set delivery_id = d.id where id = e.id;
      perform public.notification_transition(d.id, e.record_type, e.detail);
    end loop;
  end if;
  return true;
end;
$$;

create function public.notification_apply_provider_event(p_event_key text, p_record_type text, p_message_id text, p_detail jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare v_delivery uuid; v_id uuid;
begin
  if p_record_type is null or p_record_type not in ('Delivery', 'Bounce', 'SpamComplaint') then raise exception 'Unsupported event' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_event_key, '')), '') is null or nullif(trim(coalesce(p_message_id, '')), '') is null then raise exception 'Event key and message id required' using errcode = '22023'; end if;
  select id into v_delivery from public.notification_deliveries where provider_message_id = p_message_id;
  insert into public.notification_provider_events(event_key, record_type, provider_message_id, delivery_id, detail)
  values (left(p_event_key, 300), p_record_type, left(p_message_id, 200), v_delivery, coalesce(p_detail, '{}'::jsonb))
  on conflict (event_key) do nothing returning id into v_id;
  if v_id is null then return 'duplicate'; end if;
  if v_delivery is null then return 'unmatched'; end if;
  perform public.notification_transition(v_delivery, p_record_type, coalesce(p_detail, '{}'::jsonb));
  return 'applied';
end;
$$;

revoke all on function public.notification_claim_delivery(), public.notification_transition(uuid, text, jsonb),
  public.notification_record_attempt(uuid, uuid, text, text, text, boolean, integer), public.notification_apply_provider_event(text, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.notification_claim_delivery(), public.notification_record_attempt(uuid, uuid, text, text, text, boolean, integer),
  public.notification_apply_provider_event(text, text, text, jsonb) to service_role;

commit;
