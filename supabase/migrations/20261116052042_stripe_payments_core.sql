-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116052042),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
-- 1. Payments: one row per thing that is paid for (a signing request today; other subjects later).
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  connection_id uuid references public.integration_connections(id),
  subject_type text not null check (subject_type in ('sign_request','other')),
  subject_id uuid not null,
  description text not null check (char_length(description) between 1 and 250),
  amount_cents integer not null check (amount_cents between 50 and 99999999),
  currency text not null default 'aud' check (currency ~ '^[a-z]{3}$'),
  timing text not null default 'before_sign' check (timing in ('before_sign','after_sign','independent')),
  status text not null default 'pending' check (status in ('pending','open','processing','paid','failed','refunded','canceled')),
  payer_email text,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  checkout_url text,
  checkout_expires_at timestamptz,
  checkout_count integer not null default 0,
  livemode boolean,
  amount_paid_cents integer,
  amount_refunded_cents integer not null default 0,
  paid_at timestamptz,
  refunded_at timestamptz,
  failure_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subject_type, subject_id)
);
create index if not exists payments_intent_idx on public.payments(stripe_payment_intent_id);
alter table public.payments enable row level security;
drop policy if exists payments_admin_read on public.payments;
create policy payments_admin_read on public.payments for select to authenticated using (public.cms_is_admin());
revoke all on public.payments from anon;
grant select on public.payments to authenticated;

-- 2. Payment settings on document templates (copied onto each request at creation).
alter table hr.sign_templates
  add column if not exists payment_enabled boolean not null default false,
  add column if not exists payment_amount_cents integer check (payment_amount_cents is null or payment_amount_cents between 50 and 99999999),
  add column if not exists payment_currency text not null default 'aud' check (payment_currency ~ '^[a-z]{3}$'),
  add column if not exists payment_description text check (payment_description is null or char_length(payment_description) <= 250),
  add column if not exists payment_timing text not null default 'before_sign' check (payment_timing in ('before_sign','after_sign'));

-- 3. Helpers.
create or replace function hr.sign_payment_input(p jsonb, p_title text)
returns jsonb language plpgsql immutable set search_path to 'pg_catalog' as $$
declare v_cents integer; v_currency text; v_timing text; v_desc text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  begin
    v_cents := coalesce((p->>'amount_cents')::integer, round((p->>'amount')::numeric * 100)::integer);
  exception when others then raise exception 'Enter the payment amount as a number' using errcode = '22023'; end;
  if v_cents is null or v_cents < 50 or v_cents > 99999999 then raise exception 'The payment amount must be between 0.50 and 999,999.99' using errcode = '22023'; end if;
  v_currency := lower(coalesce(nullif(btrim(p->>'currency'), ''), 'aud'));
  if v_currency !~ '^[a-z]{3}$' then raise exception 'Use a 3-letter currency code such as AUD' using errcode = '22023'; end if;
  v_timing := coalesce(nullif(p->>'timing', ''), 'before_sign');
  if v_timing not in ('before_sign','after_sign') then raise exception 'Choose whether payment is due before or after signing' using errcode = '22023'; end if;
  v_desc := left(coalesce(nullif(btrim(p->>'description'), ''), nullif(btrim(p_title), ''), 'Payment'), 250);
  return jsonb_build_object('amount_cents', v_cents, 'currency', v_currency, 'timing', v_timing, 'description', v_desc,
    'payer_email', nullif(lower(btrim(coalesce(p->>'payer_email', ''))), ''));
end $$;

create or replace function hr.sign_payment_json(p_request uuid)
returns jsonb language sql stable security definer set search_path to 'pg_catalog','public' as $$
  select jsonb_build_object('id', p.id, 'amount_cents', p.amount_cents, 'currency', p.currency, 'description', p.description, 'timing', p.timing,
    'status', p.status, 'payer_email', p.payer_email, 'paid_at', p.paid_at, 'amount_paid_cents', p.amount_paid_cents,
    'amount_refunded_cents', p.amount_refunded_cents, 'livemode', p.livemode, 'failure_reason', p.failure_reason,
    'checkout_open', p.checkout_url is not null and p.checkout_expires_at > now(), 'updated_at', p.updated_at)
  from public.payments p where p.subject_type = 'sign_request' and p.subject_id = p_request and p.status <> 'canceled';
$$;

create or replace function hr.sign_payment_set(p_request uuid, p_pay jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','hr','public','pg_temp' as $$
declare r hr.sign_requests; p public.payments; v jsonb;
begin
  select * into r from hr.sign_requests where id = p_request for update;
  if not found then raise exception 'Signing request not found'; end if;
  select * into p from public.payments where subject_type = 'sign_request' and subject_id = p_request for update;
  if p.id is not null and p.status = 'paid' then raise exception 'This request is already paid. Refund it in Stripe if it must change' using errcode = '22023'; end if;
  if p_pay is null then
    if p.id is not null and p.status <> 'canceled' then
      update public.payments set status = 'canceled', checkout_url = null, checkout_expires_at = null, updated_at = now() where id = p.id;
      perform hr.sign_event(r.id, 'payment_removed', null, p_actor, '{}'::jsonb);
    end if;
    return null;
  end if;
  if r.state not in ('draft','sent','viewed','partial') then raise exception 'Payment can only be changed while the request is open' using errcode = '22023'; end if;
  v := hr.sign_payment_input(p_pay, r.title);
  insert into public.payments(tenant_id, subject_type, subject_id, description, amount_cents, currency, timing, status, payer_email, created_by)
  values (r.tenant_id, 'sign_request', r.id, v->>'description', (v->>'amount_cents')::integer, v->>'currency', v->>'timing', 'pending',
    coalesce(v->>'payer_email', (select k.email from hr.sign_recipients k where k.request_id = r.id and k.required order by k.signing_order, k.id limit 1), r.recipient_email), p_actor)
  on conflict (subject_type, subject_id) do update set description = excluded.description, amount_cents = excluded.amount_cents, currency = excluded.currency,
    timing = excluded.timing, status = 'pending', payer_email = excluded.payer_email, checkout_url = null, checkout_expires_at = null,
    failure_reason = null, updated_at = now();
  perform hr.sign_event(r.id, 'payment_requested', null, p_actor, jsonb_build_object('amount_cents', (v->>'amount_cents')::integer, 'currency', v->>'currency', 'timing', v->>'timing'));
  return hr.sign_payment_json(r.id);
end $$;
revoke all on function hr.sign_payment_set(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function hr.sign_payment_json(uuid) from public, anon, authenticated;

-- 4. Gate: when payment is due before signing, nobody can sign until it is paid.
create or replace function hr.sign_payment_gate()
returns trigger language plpgsql security definer set search_path to 'pg_catalog','public' as $$
begin
  if new.state = 'signed' and old.state is distinct from 'signed' and exists (
    select 1 from public.payments p where p.subject_type = 'sign_request' and p.subject_id = new.request_id
      and p.timing = 'before_sign' and p.status not in ('paid','canceled')) then
    raise exception 'Payment is required before you can sign this document. Select Pay now, then sign.' using errcode = 'SG402';
  end if;
  return new;
end $$;
drop trigger if exists sign_payment_gate on hr.sign_recipients;
create trigger sign_payment_gate before update of state on hr.sign_recipients for each row execute function hr.sign_payment_gate();

-- 5. Apply a Stripe object (from a verified webhook, or a session fetched from Stripe). Service role only.
create or replace function public.payment_apply_stripe(p_connection uuid, p_type text, p_object jsonb)
returns jsonb language plpgsql security definer set search_path to 'pg_catalog','hr','public','pg_temp' as $$
declare p public.payments; v_pid text; v_status text; v_paid boolean;
begin
  if p_type like 'checkout.session.%' or p_type like 'payment_intent.%' then
    v_pid := p_object->'metadata'->>'payment_id';
    if v_pid is null or v_pid !~ '^[0-9a-f-]{36}$' then return jsonb_build_object('ignored', 'no_payment_id'); end if;
    select * into p from public.payments where id = v_pid::uuid and connection_id = p_connection for update;
  elsif p_type = 'charge.refunded' then
    select * into p from public.payments where stripe_payment_intent_id = p_object->>'payment_intent' and connection_id = p_connection for update;
  else
    return jsonb_build_object('ignored', 'event_type');
  end if;
  if p.id is null then return jsonb_build_object('ignored', 'unknown_payment'); end if;

  v_paid := p_object->>'payment_status' = 'paid';
  if p_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded')
     or (p_type = 'checkout.session.retrieved' and p_object->>'status' = 'complete') then
    if (v_paid or p_type = 'checkout.session.async_payment_succeeded') and p.status <> 'paid' then
      update public.payments set status = 'paid', paid_at = now(), amount_paid_cents = coalesce((p_object->>'amount_total')::integer, amount_cents),
        stripe_checkout_session_id = coalesce(p_object->>'id', stripe_checkout_session_id),
        stripe_payment_intent_id = coalesce(p_object->>'payment_intent', stripe_payment_intent_id),
        livemode = coalesce((p_object->>'livemode')::boolean, livemode), checkout_url = null, checkout_expires_at = null, failure_reason = null, updated_at = now()
      where id = p.id;
      if p.subject_type = 'sign_request' then
        perform hr.sign_event(p.subject_id, 'payment_received', null, null, jsonb_build_object('amount_cents', coalesce((p_object->>'amount_total')::integer, p.amount_cents),
          'currency', p.currency, 'session', p_object->>'id', 'livemode', (p_object->>'livemode')::boolean));
      end if;
    elsif not v_paid and p.status in ('pending','open') then
      update public.payments set status = 'processing', stripe_payment_intent_id = coalesce(p_object->>'payment_intent', stripe_payment_intent_id), updated_at = now() where id = p.id;
    end if;
  elsif p_type = 'checkout.session.async_payment_failed' then
    if p.status <> 'paid' then
      update public.payments set status = 'failed', failure_reason = 'The payment did not go through. Try again.', checkout_url = null, updated_at = now() where id = p.id;
    end if;
  elsif p_type = 'checkout.session.expired' or (p_type = 'checkout.session.retrieved' and p_object->>'status' = 'expired') then
    if p.status in ('open','processing') and p.stripe_checkout_session_id is not distinct from p_object->>'id' then
      update public.payments set status = 'pending', checkout_url = null, checkout_expires_at = null, updated_at = now() where id = p.id;
    end if;
  elsif p_type = 'payment_intent.payment_failed' then
    if p.status <> 'paid' then
      update public.payments set failure_reason = left(coalesce(p_object->'last_payment_error'->>'message', 'The card was declined.'), 300), updated_at = now() where id = p.id;
    end if;
  elsif p_type = 'charge.refunded' then
    update public.payments set amount_refunded_cents = coalesce((p_object->>'amount_refunded')::integer, amount_refunded_cents),
      status = case when coalesce((p_object->>'refunded')::boolean, false) then 'refunded' else status end,
      refunded_at = case when coalesce((p_object->>'refunded')::boolean, false) then now() else refunded_at end, updated_at = now()
    where id = p.id;
    if p.subject_type = 'sign_request' then
      perform hr.sign_event(p.subject_id, 'payment_refunded', null, null, jsonb_build_object('amount_refunded_cents', (p_object->>'amount_refunded')::integer));
    end if;
  end if;
  select status into v_status from public.payments where id = p.id;
  return jsonb_build_object('applied', true, 'payment_id', p.id, 'status', v_status);
end $$;
revoke all on function public.payment_apply_stripe(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.payment_apply_stripe(uuid, text, jsonb) to service_role;

-- 6. Bug fix: storing a webhook signing secret must not knock a verified connection back to "not connected".
create or replace function public.integration_credential_write(p_connection uuid, p_kind text, p_secret text, p_version timestamp with time zone default null)
returns void language plpgsql security definer set search_path to 'public', 'integration_private', 'vault' as $function$
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
 status=case when status='disabled' then status when p_kind='api_key' then 'not_connected' else status end,updated_at=now() where id=p_connection;
end $function$;
