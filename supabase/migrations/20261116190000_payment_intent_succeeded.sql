-- STRIPE-WEBHOOK (owner brief 2026-11-16): the webhook endpoint is registered with checkout.session.completed, payment_intent.succeeded and
-- payment_intent.payment_failed (plus the session and charge events already handled). payment_intent.succeeded marks the payment paid when
-- the session event has not arrived first (metadata.payment_id is on the intent, set at checkout), so either event settles it; a second
-- one leaves it as it is. Restated from the hosted definition (pg_get_functiondef, 2026-11-16, md5 8a30ccad4b588f8d2b3c8822fa120ea6).
create or replace function public.payment_apply_stripe(p_connection uuid, p_type text, p_object jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $$
declare p public.payments; v_pid text; v_status text; v_paid boolean; v_intent text; v_receipt text; v_charge text;
begin
  -- A checkout session read back with payment_intent.latest_charge expanded carries the intent as an object and the charge's receipt.
  v_intent := case when jsonb_typeof(p_object->'payment_intent') = 'object' then p_object->'payment_intent'->>'id' else p_object->>'payment_intent' end;
  v_receipt := coalesce(p_object->'payment_intent'->'latest_charge'->>'receipt_url', case when p_type like 'charge.%' then p_object->>'receipt_url' end);
  v_charge := coalesce(p_object->'payment_intent'->'latest_charge'->>'id', case when p_type like 'charge.%' then p_object->>'id' end);
  if p_type like 'checkout.session.%' or p_type like 'payment_intent.%' then
    v_pid := p_object->'metadata'->>'payment_id';
    if v_pid is null or v_pid !~ '^[0-9a-f-]{36}$' then return jsonb_build_object('ignored', 'no_payment_id'); end if;
    select * into p from public.payments where id = v_pid::uuid and connection_id = p_connection for update;
  elsif p_type in ('charge.refunded', 'charge.succeeded', 'charge.updated') then
    v_pid := p_object->'metadata'->>'payment_id';
    select * into p from public.payments where connection_id = p_connection
      and ((v_pid ~ '^[0-9a-f-]{36}$' and id = v_pid::uuid) or (stripe_payment_intent_id is not null and stripe_payment_intent_id = p_object->>'payment_intent')) for update;
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
        stripe_payment_intent_id = coalesce(v_intent, stripe_payment_intent_id),
        receipt_url = coalesce(v_receipt, receipt_url), stripe_charge_id = coalesce(v_charge, stripe_charge_id),
        livemode = coalesce((p_object->>'livemode')::boolean, livemode), checkout_url = null, checkout_expires_at = null, failure_reason = null, updated_at = now()
      where id = p.id;
      if p.subject_type = 'sign_request' then
        perform hr.sign_event(p.subject_id, 'payment_received', null, null, jsonb_build_object('amount_cents', coalesce((p_object->>'amount_total')::integer, p.amount_cents),
          'currency', p.currency, 'session', p_object->>'id', 'livemode', (p_object->>'livemode')::boolean));
        perform public.offer_letter_deposit_paid(p.subject_id, p.id);
      end if;
    elsif not v_paid and p.status in ('pending','open') then
      update public.payments set status = 'processing', stripe_payment_intent_id = coalesce(v_intent, stripe_payment_intent_id), updated_at = now() where id = p.id;
    elsif p.status = 'paid' and (v_receipt is not null or v_charge is not null) then
      update public.payments set receipt_url = coalesce(receipt_url, v_receipt), stripe_charge_id = coalesce(stripe_charge_id, v_charge), updated_at = now() where id = p.id;
    end if;
  elsif p_type = 'payment_intent.succeeded' then
    -- STRIPE-WEBHOOK: the intent settled (the session event may follow or may have come first); the amount received is what was paid.
    if p.status <> 'paid' then
      update public.payments set status = 'paid', paid_at = now(), amount_paid_cents = coalesce((p_object->>'amount_received')::integer, amount_cents),
        stripe_payment_intent_id = coalesce(p_object->>'id', stripe_payment_intent_id),
        stripe_charge_id = coalesce(case when jsonb_typeof(p_object->'latest_charge') = 'object' then p_object->'latest_charge'->>'id' else p_object->>'latest_charge' end, stripe_charge_id),
        receipt_url = coalesce(p_object->'latest_charge'->>'receipt_url', receipt_url),
        livemode = coalesce((p_object->>'livemode')::boolean, livemode), checkout_url = null, checkout_expires_at = null, failure_reason = null, updated_at = now()
      where id = p.id;
      if p.subject_type = 'sign_request' then
        perform hr.sign_event(p.subject_id, 'payment_received', null, null, jsonb_build_object('amount_cents', coalesce((p_object->>'amount_received')::integer, p.amount_cents),
          'currency', p.currency, 'payment_intent', p_object->>'id', 'livemode', (p_object->>'livemode')::boolean));
        perform public.offer_letter_deposit_paid(p.subject_id, p.id);
      end if;
    else
      update public.payments set stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_object->>'id'),
        stripe_charge_id = coalesce(stripe_charge_id, case when jsonb_typeof(p_object->'latest_charge') = 'object' then p_object->'latest_charge'->>'id' else p_object->>'latest_charge' end),
        receipt_url = coalesce(receipt_url, p_object->'latest_charge'->>'receipt_url'), updated_at = now() where id = p.id;
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
  elsif p_type in ('charge.succeeded', 'charge.updated') then
    -- The receipt URL arrives on the charge (Stripe emails the receipt itself); the payment's own status comes from the session events.
    update public.payments set receipt_url = coalesce(p_object->>'receipt_url', receipt_url), stripe_charge_id = coalesce(p_object->>'id', stripe_charge_id),
      stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_object->>'payment_intent'), updated_at = now() where id = p.id;
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
