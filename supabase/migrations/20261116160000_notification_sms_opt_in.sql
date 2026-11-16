-- ClickSend SMS for portal users who opt in. Additive; local only until released.
-- A portal user saves a mobile number (with recorded consent) and turns SMS on per event. Whenever an email delivery is queued for that
-- user (state 'pending', so the migration 92 recipient rules, opt-outs and suppression already applied), a matching SMS delivery is queued.
-- Students and internal addresses without a portal account never receive SMS: they have no way to opt in.
-- Claiming re-checks the institution activation and the tenant status exactly like email, and re-checks the opt-in and the number, so
-- removing the number or turning SMS off stops anything still queued. Expired leases become 'unknown' and are never resent automatically.
-- Sending also needs EF_NOTIFICATION_SMS_ENABLED=true and the ClickSend credentials in the Edge Function.
-- Rollback (manual): drop trigger notification_deliveries_queue_sms on public.notification_deliveries; drop the functions and the tables
-- notification_sms_deliveries, notification_sms_contacts created here; alter table public.notification_preferences drop column sms_enabled.
begin;

create table public.notification_sms_contacts(
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  consent_text text not null,
  consented_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.notification_sms_contacts enable row level security;
revoke all on public.notification_sms_contacts from public, anon, authenticated, service_role;
grant select on public.notification_sms_contacts to authenticated, service_role;
create policy notification_sms_contacts_own on public.notification_sms_contacts for select to authenticated using (auth_user_id = auth.uid());

alter table public.notification_preferences add column sms_enabled boolean not null default false;

create table public.notification_sms_deliveries(
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  email_delivery_id uuid not null unique references public.notification_deliveries(id),
  tenant_id uuid,
  recipient_user uuid not null,
  event text not null,
  subject text not null,
  state text not null default 'pending' check (state in ('pending', 'suppressed', 'sending', 'sent', 'failed', 'unknown')),
  state_reason text,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_message_id text,
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notification_sms_deliveries_ready on public.notification_sms_deliveries(next_attempt_at, seq) where state = 'pending';
create index notification_sms_deliveries_recipient on public.notification_sms_deliveries(recipient_user) where state = 'pending';
alter table public.notification_sms_deliveries enable row level security;
revoke all on public.notification_sms_deliveries from public, anon, authenticated, service_role;
grant select on public.notification_sms_deliveries to service_role;

/** E.164, or null. Mirrors normalizePhoneNumber in supabase/functions/_shared/notification/sms.ts: without a leading + the number is read as Australian. */
create function public.notification_normalize_phone(p_phone text) returns text language plpgsql immutable set search_path = public as $$
declare v text := btrim(coalesce(p_phone, ''));
begin
  if v = '' or length(v) > 32 or v ~ '[^0-9 +().-]' then return null; end if;
  v := regexp_replace(v, '[ ().-]', '', 'g');
  if left(v, 1) = '+' then null;
  elsif left(v, 2) = '00' then v := '+' || substr(v, 3);
  elsif v ~ '^04[0-9]{8}$' then v := '+61' || substr(v, 2);
  elsif v ~ '^4[0-9]{8}$' then v := '+61' || v;
  elsif v ~ '^61[0-9]{9}$' then v := '+' || v;
  else return null;
  end if;
  return case when v ~ '^\+[1-9][0-9]{7,14}$' then v end;
end;
$$;

create function public.portal_set_sms_contact(p_phone text) returns text
language plpgsql security definer set search_path = public as $$
declare v_phone text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  v_phone := public.notification_normalize_phone(p_phone);
  if v_phone is null then raise exception 'Enter a valid mobile number' using errcode = '22023'; end if;
  insert into public.notification_sms_contacts(auth_user_id, phone_e164, consent_text)
  values (auth.uid(), v_phone, 'I agree to receive text messages about my applications at this number. Reply STOP or turn SMS off here to stop.')
  on conflict (auth_user_id) do update set phone_e164 = excluded.phone_e164, consent_text = excluded.consent_text, consented_at = now(), updated_at = now();
  return v_phone;
end;
$$;

/** Removes the number, turns SMS off for every event and suppresses anything still queued for this user. */
create function public.portal_remove_sms_contact() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  delete from public.notification_sms_contacts where auth_user_id = auth.uid();
  update public.notification_preferences set sms_enabled = false, updated_at = now() where auth_user_id = auth.uid() and sms_enabled;
  update public.notification_sms_deliveries set state = 'suppressed', state_reason = 'recipient_opted_out', updated_at = now()
  where recipient_user = auth.uid() and state = 'pending';
end;
$$;

create function public.portal_set_sms_preference(p_event text, p_sms_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_event is null or p_event not in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued') or p_sms_enabled is null then
    raise exception 'Unknown notification event' using errcode = '22023';
  end if;
  if p_sms_enabled and not exists (select 1 from public.notification_sms_contacts where auth_user_id = auth.uid()) then
    raise exception 'Add a mobile number first' using errcode = '22023';
  end if;
  -- A new row keeps email on (the default for an event without a row).
  insert into public.notification_preferences(auth_user_id, event, email_enabled, sms_enabled) values (auth.uid(), p_event, true, p_sms_enabled)
  on conflict (auth_user_id, event) do update set sms_enabled = excluded.sms_enabled, updated_at = now();
  if not p_sms_enabled then
    update public.notification_sms_deliveries set state = 'suppressed', state_reason = 'recipient_opted_out', updated_at = now()
    where recipient_user = auth.uid() and event = p_event and state = 'pending';
  end if;
end;
$$;

/** Queues an SMS next to each pending email delivery for a portal user who has a number and SMS on for that event. */
create function public.notification_queue_sms() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.recipient_user is not null and new.state = 'pending'
     and exists (select 1 from public.notification_sms_contacts c where c.auth_user_id = new.recipient_user)
     and exists (select 1 from public.notification_preferences p where p.auth_user_id = new.recipient_user and p.event = new.event and p.sms_enabled) then
    insert into public.notification_sms_deliveries(email_delivery_id, tenant_id, recipient_user, event, subject)
    values (new.id, new.tenant_id, new.recipient_user, new.event, left(new.subject, 300))
    on conflict (email_delivery_id) do nothing;
  end if;
  return null;
end;
$$;
create trigger notification_deliveries_queue_sms after insert on public.notification_deliveries
  for each row execute function public.notification_queue_sms();

/** Claims the next ready SMS (same tenant and activation gates as email). Rows whose recipient opted out meanwhile are suppressed and skipped. */
create function public.notification_claim_sms_delivery() returns table(id uuid, lease_token uuid, phone text, body text, attempt_count integer)
language plpgsql security definer set search_path = public as $$
declare d public.notification_sms_deliveries; v_phone text; v_name text;
begin
  update public.notification_sms_deliveries x set state = 'unknown', last_error_code = 'lease_expired', lease_token = null, lease_expires_at = null, updated_at = now()
  where x.state = 'sending' and x.lease_expires_at <= clock_timestamp();
  loop
    select * into d from public.notification_sms_deliveries x
    where x.state = 'pending' and x.next_attempt_at <= now()
      and (x.tenant_id is null or exists (select 1 from public.tenants t where t.id = x.tenant_id and t.status = 'active'))
      and exists (select 1 from public.notification_activation a where a.revoked_at is null and a.tenant_id is not distinct from x.tenant_id and x.created_at >= a.approved_at)
    order by x.seq for update skip locked limit 1;
    if not found then return; end if;
    select c.phone_e164 into v_phone from public.notification_sms_contacts c where c.auth_user_id = d.recipient_user;
    if v_phone is null or not exists (select 1 from public.notification_preferences p where p.auth_user_id = d.recipient_user and p.event = d.event and p.sms_enabled) then
      update public.notification_sms_deliveries x set state = 'suppressed', state_reason = 'recipient_opted_out', updated_at = now() where x.id = d.id;
      continue;
    end if;
    v_name := nullif(btrim(coalesce(public.notification_resolve_sender(d.tenant_id) ->> 'name', '')), '');
    update public.notification_sms_deliveries x set state = 'sending', attempt_count = x.attempt_count + 1, lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + interval '3 minutes', updated_at = now()
    where x.id = d.id returning * into d;
    id := d.id; lease_token := d.lease_token; phone := v_phone; attempt_count := d.attempt_count;
    body := left(coalesce(v_name || ': ', '') || d.subject, 600);
    return next;
    return;
  end loop;
end;
$$;

create function public.notification_record_sms_attempt(p_id uuid, p_lease uuid, p_outcome text, p_message_id text, p_error text, p_retry boolean, p_delay integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare d public.notification_sms_deliveries;
begin
  if p_outcome not in ('accepted', 'failed', 'unknown') then raise exception 'Unknown outcome' using errcode = '22023'; end if;
  select * into d from public.notification_sms_deliveries where id = p_id for update;
  if not found or d.state <> 'sending' or p_lease is null or d.lease_token is distinct from p_lease or d.lease_expires_at <= clock_timestamp() then return false; end if;
  if p_outcome = 'accepted' then
    if nullif(btrim(coalesce(p_message_id, '')), '') is null then raise exception 'Accepted needs a provider message id' using errcode = '22023'; end if;
    update public.notification_sms_deliveries set state = 'sent', provider_message_id = left(p_message_id, 64), sent_at = now(), lease_token = null, lease_expires_at = null, last_error_code = null, updated_at = now() where id = d.id;
  elsif p_outcome = 'failed' and coalesce(p_retry, false) and d.attempt_count < 3 then
    update public.notification_sms_deliveries set state = 'pending', next_attempt_at = now() + make_interval(secs => greatest(1, least(coalesce(p_delay, 60), 900))),
      lease_token = null, lease_expires_at = null, last_error_code = left(p_error, 60), updated_at = now() where id = d.id;
  else
    update public.notification_sms_deliveries set state = p_outcome, lease_token = null, lease_expires_at = null, last_error_code = left(p_error, 60), updated_at = now() where id = d.id;
  end if;
  return true;
end;
$$;

revoke all on function public.notification_normalize_phone(text), public.portal_set_sms_contact(text), public.portal_remove_sms_contact(),
  public.portal_set_sms_preference(text, boolean), public.notification_queue_sms(), public.notification_claim_sms_delivery(),
  public.notification_record_sms_attempt(uuid, uuid, text, text, text, boolean, integer) from public, anon, authenticated, service_role;
grant execute on function public.portal_set_sms_contact(text), public.portal_remove_sms_contact(), public.portal_set_sms_preference(text, boolean) to authenticated;
grant execute on function public.notification_claim_sms_delivery(), public.notification_record_sms_attempt(uuid, uuid, text, text, text, boolean, integer) to service_role;

commit;
