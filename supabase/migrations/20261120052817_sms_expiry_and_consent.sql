-- SMS: never send a text queued more than 24 hours ago; consent text without the "Reply STOP" promise (owner 2026-11-20).
--
--   * A queued text older than 24 hours is never sent: it becomes state 'expired' with state_reason 'older_than_24h'. The claim expires
--     such rows before it picks one (so their phone number is never read), and returns created_at so the worker can refuse one that
--     crossed the 24-hour line between claim and send (notification_record_sms_attempt outcome 'expired', fenced by the lease).
--     SMS is still off on hosted (no EF_NOTIFICATION_SMS_ENABLED / EF_CLICKSEND_* secrets); this stops a backlog queued while it is off from
--     going out the day it is turned on.
--   * The consent recorded with a mobile number no longer says "Reply STOP": no inbound ClickSend replies are processed yet. It says SMS
--     can be turned off on the Notifications page (the portal shows the same words). No number was saved on hosted when this was written,
--     so no stored consent text needed changing.
-- notification_claim_sms_delivery changes its result columns, so it is dropped and created again (the deployed v25 worker never calls it).
set local lock_timeout = '5s';

alter table public.notification_sms_deliveries drop constraint if exists notification_sms_deliveries_state_check;
alter table public.notification_sms_deliveries add constraint notification_sms_deliveries_state_check
 check (state in ('pending', 'suppressed', 'sending', 'sent', 'failed', 'unknown', 'expired'));

drop function if exists public.notification_claim_sms_delivery();
/** Claims the next ready SMS (same tenant and activation gates as email). Opted-out rows are suppressed and texts queued over 24 hours ago expire. */
create function public.notification_claim_sms_delivery() returns table(id uuid, lease_token uuid, phone text, body text, attempt_count integer, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare d public.notification_sms_deliveries; v_phone text; v_name text;
begin
  update public.notification_sms_deliveries x set state = 'unknown', last_error_code = 'lease_expired', lease_token = null, lease_expires_at = null, updated_at = now()
  where x.state = 'sending' and x.lease_expires_at <= clock_timestamp();
  -- Never sent: a text queued more than 24 hours ago (a backlog from while SMS was off, or a long provider outage).
  update public.notification_sms_deliveries x set state = 'expired', state_reason = 'older_than_24h', updated_at = now()
  where x.state = 'pending' and x.created_at < now() - interval '24 hours';
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
    id := d.id; lease_token := d.lease_token; phone := v_phone; attempt_count := d.attempt_count; created_at := d.created_at;
    body := left(coalesce(v_name || ': ', '') || d.subject, 600);
    return next;
    return;
  end loop;
end;
$$;
revoke all on function public.notification_claim_sms_delivery() from public, anon, authenticated, service_role;
grant execute on function public.notification_claim_sms_delivery() to service_role;

/** Records a send attempt (fenced by the lease). 'expired': the worker refused a text queued over 24 hours ago, nothing was sent. */
create or replace function public.notification_record_sms_attempt(p_id uuid, p_lease uuid, p_outcome text, p_message_id text, p_error text, p_retry boolean, p_delay integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare d public.notification_sms_deliveries;
begin
  if p_outcome not in ('accepted', 'failed', 'unknown', 'expired') then raise exception 'Unknown outcome' using errcode = '22023'; end if;
  select * into d from public.notification_sms_deliveries where id = p_id for update;
  if not found or d.state <> 'sending' or p_lease is null or d.lease_token is distinct from p_lease or d.lease_expires_at <= clock_timestamp() then return false; end if;
  if p_outcome = 'accepted' then
    if nullif(btrim(coalesce(p_message_id, '')), '') is null then raise exception 'Accepted needs a provider message id' using errcode = '22023'; end if;
    update public.notification_sms_deliveries set state = 'sent', provider_message_id = left(p_message_id, 64), sent_at = now(), lease_token = null, lease_expires_at = null, last_error_code = null, updated_at = now() where id = d.id;
  elsif p_outcome = 'expired' then
    update public.notification_sms_deliveries set state = 'expired', state_reason = 'older_than_24h', lease_token = null, lease_expires_at = null, updated_at = now() where id = d.id;
  elsif p_outcome = 'failed' and coalesce(p_retry, false) and d.attempt_count < 3 then
    update public.notification_sms_deliveries set state = 'pending', next_attempt_at = now() + make_interval(secs => greatest(1, least(coalesce(p_delay, 60), 900))),
      lease_token = null, lease_expires_at = null, last_error_code = left(p_error, 60), updated_at = now() where id = d.id;
  else
    update public.notification_sms_deliveries set state = p_outcome, lease_token = null, lease_expires_at = null, last_error_code = left(p_error, 60), updated_at = now() where id = d.id;
  end if;
  return true;
end;
$$;

create or replace function public.portal_set_sms_contact(p_phone text) returns text
language plpgsql security definer set search_path = public as $$
declare v_phone text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  v_phone := public.notification_normalize_phone(p_phone);
  if v_phone is null then raise exception 'Enter a valid mobile number' using errcode = '22023'; end if;
  -- TODO(sms-stop): restore "Reply STOP to stop" once ClickSend inbound replies (STOP) are received and turn SMS off here.
  insert into public.notification_sms_contacts(auth_user_id, phone_e164, consent_text)
  values (auth.uid(), v_phone, 'I agree to receive text messages about my applications at this number. I can turn them off on the Notifications page at any time.')
  on conflict (auth_user_id) do update set phone_e164 = excluded.phone_e164, consent_text = excluded.consent_text, consented_at = now(), updated_at = now();
  return v_phone;
end;
$$;
