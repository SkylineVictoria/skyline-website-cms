-- OFFER-PAY-GATE (owner brief 2026-11-16): an offer letter that asks for an initial deposit is accepted only once Stripe has verified
-- the deposit. Signing stores the signed letter and its certificate (signed_at) and leaves accepted_at null with the application at
-- Offer letter issued ("Signed · Payment pending"). The verified payment (the Stripe webhook, or the Checkout session read back from
-- Stripe by the payments function, both through payment_apply_stripe with payments.status = 'paid' and the letter's own amount and
-- currency) sets deposit_paid_at and accepted_at, accepted_via = 'signing_and_payment', and moves the application to Offer accepted
-- through the status workflow (one accept_offer history row). An amount or currency that differs is flagged (audit
-- offer_deposit_mismatch, signing event payment_mismatch) and never accepts. Offers without a payment keep today's behaviour.
-- Nothing a student or agent can call sets paid or accepted: every function here is service-role only, payments has no write policy,
-- and portal_offer_accept refuses an offer whose deposit is still unpaid. Functions restated from hosted 2026-11-16 (pg_get_functiondef).

/* ------------------------------------------------------------------ 1. accepted_via gains the paid path */
alter table public.enrollment_offer_letters drop constraint if exists enrollment_offer_letters_accepted_via_check;
alter table public.enrollment_offer_letters add constraint enrollment_offer_letters_accepted_via_check
  check (accepted_via = any (array['portal'::text, 'staff'::text, 'signing'::text, 'signing_and_payment'::text]));

/* ------------------------------------------------------------------ 2. does this letter still wait for its deposit? */
-- True while the letter printed a deposit, a live (not cancelled) Stripe payment exists for its signing request and Stripe has not verified it.
create or replace function public.offer_letter_payment_required(l public.enrollment_offer_letters) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(l.payment_amount_cents, 0) > 0 and l.deposit_paid_at is null and l.signing_request_id is not null
    and exists (select 1 from public.payments p where p.subject_type = 'sign_request' and p.subject_id = l.signing_request_id and p.status <> 'canceled');
$$;
revoke all on function public.offer_letter_payment_required(public.enrollment_offer_letters) from public, anon, authenticated;

/* ------------------------------------------------------------------ 3. the one place an online acceptance is recorded */
-- Marks the latest letter accepted and moves the application through the workflow (history accept_offer, audit, outbox). Returns false,
-- changing nothing, when the application is no longer at a status the applicant may accept from, the letter is not the latest one, the
-- student is disabled or the letter is already accepted.
create or replace function public.offer_letter_accept_apply(p_letter uuid, p_signer text, p_via text, p_note text, p_detail jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare l public.enrollment_offer_letters; a public.enrollment_applications; h uuid; v_name text := left(coalesce(nullif(btrim(p_signer), ''), 'Student'), 150);
begin
 select * into l from public.enrollment_offer_letters where id = p_letter for update;
 if not found or l.accepted_at is not null then return false; end if;
 select * into a from public.enrollment_applications where id = l.application_id for update;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'applicant' and x.from_status = a.status and x.kind = 'accept_offer')
  or l.id <> (select q.id from public.enrollment_offer_letters q where q.application_id = a.id order by q.issued_at desc limit 1)
  or not public.application_student_active(a.id) then return false; end if;
 update public.enrollment_offer_letters set accepted_at = now(), accepted_by = null, accepted_by_name = v_name, accepted_via = p_via,
  accept_note = case when p_via = 'signing_and_payment' then 'Signed online and paid the initial deposit' else 'Signed online' end where id = l.id;
 perform set_config('portal.status_command', a.id::text, true);
 perform set_config('portal.status_note', p_note, true);
 update public.enrollment_applications set status = 'offer_accepted' where id = a.id;
 perform set_config('portal.status_command', '', true);
 select x.id into h from public.enrollment_application_status_history x where x.application_id = a.id and x.new_status = 'offer_accepted' order by x.created_at desc limit 1;
 update public.enrollment_application_status_history set action_key = 'accept_offer', actor_name = v_name || ' (signed online)', actor_role = 'student',
  payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('via', p_via, 'letter', l.id) || coalesce(p_detail, '{}'::jsonb) where id = h;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
 values (null, v_name, 'student', 'offer_accepted', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
  jsonb_build_object('letter', l.id, 'from', a.status, 'to', 'offer_accepted', 'via', p_via) || coalesce(p_detail, '{}'::jsonb));
 insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
 values (a.id, a.tenant_id, 'offer_accepted', jsonb_build_object('from', a.status, 'to', 'offer_accepted', 'actor', null, 'via', p_via));
 return true;
end $$;
revoke all on function public.offer_letter_accept_apply(uuid, text, text, text, jsonb) from public, anon, authenticated;

/* ------------------------------------------------------------------ 4. signing: accept now, or wait for the deposit */
create or replace function public.offer_letter_accept_signed(p_letter uuid, p_request uuid, p_signer text, p_signed bytea, p_signed_hash text, p_certificate bytea, p_certificate_hash text, p_choice text, p_ip text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.enrollment_offer_letters; a public.enrollment_applications; v_pay public.payments; v_required boolean; v_paid boolean;
begin
 select * into l from public.enrollment_offer_letters where id = p_letter for update;
 select * into a from public.enrollment_applications where id = l.application_id for update;
 if l.accepted_at is not null then raise exception 'This offer was already accepted'; end if;
 if l.signed_at is not null then raise exception 'This offer letter was already signed'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'applicant' and x.from_status = a.status and x.kind = 'accept_offer')
  or l.id <> (select q.id from public.enrollment_offer_letters q where q.application_id = a.id order by q.issued_at desc limit 1) then
  raise exception 'This offer can no longer be accepted online. Please contact admissions';
 end if;
 if not public.application_student_active(a.id) then raise exception 'This offer can no longer be accepted online. Please contact admissions'; end if;
 select * into v_pay from public.payments p where p.subject_type = 'sign_request' and p.subject_id = p_request and p.status <> 'canceled';
 -- A letter that asks for a deposit is accepted only once Stripe has verified it (deposit_paid_at, set by offer_letter_deposit_paid).
 v_paid := v_pay.id is not null and l.deposit_paid_at is not null;
 v_required := coalesce(l.payment_amount_cents, 0) > 0 and v_pay.id is not null and not v_paid;
 update public.enrollment_offer_letters set signed_at = now(), signed_content = p_signed, signed_sha256 = p_signed_hash, certificate_content = p_certificate,
  certificate_sha256 = p_certificate_hash, prepaid_more = p_choice, signing_request_id = p_request where id = l.id;
 if v_required then
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
  values (null, left(coalesce(nullif(btrim(p_signer), ''), 'Student'), 150), 'student', 'offer_signed', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
   jsonb_build_object('letter', l.id, 'request', p_request, 'ip', left(p_ip, 64), 'prepaid_more', p_choice, 'awaiting_payment', true,
    'amount_cents', l.payment_amount_cents, 'currency', coalesce(l.payment_currency, 'aud'), 'payment', v_pay.id, 'payment_status', v_pay.status));
  perform hr.sign_event(p_request, 'offer_signed_awaiting_payment', null, null,
   jsonb_build_object('letter', l.id, 'amount_cents', l.payment_amount_cents, 'currency', coalesce(l.payment_currency, 'aud'), 'payment', v_pay.id));
  return;
 end if;
 if not public.offer_letter_accept_apply(l.id, p_signer, case when v_paid then 'signing_and_payment' else 'signing' end,
   case when v_paid then 'Offer accepted: the student signed the offer letter online and paid the initial deposit' else 'Offer accepted: the student signed the offer letter online' end,
   jsonb_build_object('request', p_request, 'ip', left(p_ip, 64), 'prepaid_more', p_choice) || case when v_paid then jsonb_build_object('payment', v_pay.id) else '{}'::jsonb end) then
  raise exception 'This offer can no longer be accepted online. Please contact admissions';
 end if;
end $$;
revoke all on function public.offer_letter_accept_signed(uuid, uuid, text, bytea, text, bytea, text, text, text) from public, anon, authenticated;

/* ------------------------------------------------------------------ 5. the verified deposit accepts a signed letter */
-- Called by payment_apply_stripe for every Stripe event that leaves the payment paid (idempotent: a second call changes nothing).
create or replace function public.offer_letter_deposit_paid(p_request uuid, p_payment uuid) returns void
language plpgsql security definer set search_path = public, hr as $$
declare r hr.sign_requests; l public.enrollment_offer_letters; a public.enrollment_applications; p public.payments; v_signer text; v_mismatch text;
begin
  select * into r from hr.sign_requests where id = p_request;
  if not found or r.offer_letter_id is null then return; end if;
  select * into p from public.payments where id = p_payment;
  if p.id is null or p.status <> 'paid' or p.subject_type <> 'sign_request' or p.subject_id <> p_request then return; end if;
  select * into l from public.enrollment_offer_letters where id = r.offer_letter_id for update;
  if not found then return; end if;
  select * into a from public.enrollment_applications where id = l.application_id;
  v_signer := coalesce(nullif(r.signer_name, ''), nullif(r.recipient_name, ''), 'Student');
  -- Stripe's amount and currency must be the letter's: anything else is flagged for staff and never accepts the offer.
  v_mismatch := case when l.payment_amount_cents is null then null
    when p.amount_cents <> l.payment_amount_cents or coalesce(p.amount_paid_cents, p.amount_cents) < l.payment_amount_cents then 'amount'
    when lower(p.currency) <> lower(coalesce(l.payment_currency, 'aud')) then 'currency' end;
  if v_mismatch is not null then
    if not exists (select 1 from public.portal_audit_log g where g.application_id = a.id and g.action = 'offer_deposit_mismatch' and g.detail->>'payment' = p.id::text) then
      insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
      values (null, v_signer, 'student', 'offer_deposit_mismatch', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
        jsonb_build_object('letter', l.id, 'request', r.id, 'payment', p.id, 'reason', v_mismatch, 'expected_cents', l.payment_amount_cents, 'expected_currency', coalesce(l.payment_currency, 'aud'),
          'paid_cents', coalesce(p.amount_paid_cents, p.amount_cents), 'amount_cents', p.amount_cents, 'currency', p.currency, 'livemode', p.livemode, 'receipt_url', p.receipt_url));
      perform hr.sign_event(r.id, 'payment_mismatch', null, null, jsonb_build_object('payment', p.id, 'reason', v_mismatch, 'expected_cents', l.payment_amount_cents,
        'expected_currency', coalesce(l.payment_currency, 'aud'), 'paid_cents', coalesce(p.amount_paid_cents, p.amount_cents), 'currency', p.currency));
    end if;
    return;
  end if;
  if l.deposit_paid_at is null then
    update public.enrollment_offer_letters set deposit_paid_at = coalesce(p.paid_at, now()) where id = l.id returning * into l;
    insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
    values (null, v_signer, 'student', 'offer_deposit_paid', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
      jsonb_build_object('letter', l.id, 'request', r.id, 'payment', p.id, 'amount_cents', coalesce(p.amount_paid_cents, p.amount_cents), 'currency', p.currency,
        'status', a.status, 'livemode', p.livemode, 'receipt_url', p.receipt_url));
  end if;
  -- Signed already: the verified deposit completes the acceptance. Not signed yet: signing will (offer_letter_accept_signed sees deposit_paid_at).
  if l.signed_at is not null and l.accepted_at is null then
    if not public.offer_letter_accept_apply(l.id, v_signer, 'signing_and_payment', 'Offer accepted: the student signed the offer letter online and paid the initial deposit',
      jsonb_build_object('request', r.id, 'payment', p.id, 'amount_cents', coalesce(p.amount_paid_cents, p.amount_cents), 'currency', p.currency, 'prepaid_more', l.prepaid_more, 'receipt_url', p.receipt_url)) then
      insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
      values (null, v_signer, 'student', 'offer_deposit_paid_not_accepted', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
        jsonb_build_object('letter', l.id, 'request', r.id, 'payment', p.id, 'status', a.status, 'reason', 'The application is no longer at Offer letter issued, the letter is not the latest one, or the student is disabled'));
    end if;
  end if;
end $$;
revoke all on function public.offer_letter_deposit_paid(uuid, uuid) from public, anon, authenticated;

/* ------------------------------------------------------------------ 6. every Stripe event that leaves the payment paid reaches the letter */
-- Restated from hosted 2026-11-16 (20261116190000): the two inline deposit calls become one at the end, so a retried webhook or a later
-- charge event also completes an acceptance that could not run earlier.
create or replace function public.payment_apply_stripe(p_connection uuid, p_type text, p_object jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $$
declare p public.payments; v_pid text; v_status text; v_paid boolean; v_intent text; v_receipt text; v_charge text;
begin
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
      end if;
    elsif not v_paid and p.status in ('pending','open') then
      update public.payments set status = 'processing', stripe_payment_intent_id = coalesce(v_intent, stripe_payment_intent_id), updated_at = now() where id = p.id;
    elsif p.status = 'paid' and (v_receipt is not null or v_charge is not null) then
      update public.payments set receipt_url = coalesce(receipt_url, v_receipt), stripe_charge_id = coalesce(stripe_charge_id, v_charge), updated_at = now() where id = p.id;
    end if;
  elsif p_type = 'payment_intent.succeeded' then
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
  -- A paid deposit reaches the offer letter after every event (verified amount and currency; idempotent).
  if p.subject_type = 'sign_request' and v_status = 'paid' then perform public.offer_letter_deposit_paid(p.subject_id, p.id); end if;
  return jsonb_build_object('applied', true, 'payment_id', p.id, 'status', v_status);
end $$;
revoke all on function public.payment_apply_stripe(uuid, text, jsonb) from public, anon, authenticated;

/* ------------------------------------------------------------------ 7. the portal's own Accept offer refuses an unpaid deposit */
create or replace function public.portal_offer_accept(p_application uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; l public.enrollment_offer_letters; v_name text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_can_access_application(a.id) then raise exception 'Application not found' using errcode = '42501'; end if;
 if public.portal_is_slit_admin() then raise exception 'Only the student or agent the letter went to accepts an offer' using errcode = '42501'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'applicant' and x.from_status = a.status and x.kind = 'accept_offer') then
  raise exception 'There is no offer to accept on this application' using errcode = '22023';
 end if;
 if not public.application_student_active(a.id) then raise exception 'This student is disabled, so their applications are locked' using errcode = '42501'; end if;
 select * into l from public.enrollment_offer_letters where application_id = a.id order by issued_at desc limit 1 for update;
 if not found then raise exception 'There is no offer letter to accept' using errcode = '22023'; end if;
 -- OFFER-PAY-GATE: a letter with a deposit is accepted by the verified payment on the signing page, never by this button.
 if public.offer_letter_payment_required(l) then
  raise exception 'The initial deposit must be paid before this offer is accepted. Open the offer email and pay on the signing page' using errcode = '22023';
 end if;
 select coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', '') into v_name;
 update public.enrollment_offer_letters set accepted_at = now(), accepted_by = auth.uid(), accepted_by_name = coalesce(v_name, ''), accepted_via = 'portal' where id = l.id;
 perform set_config('portal.status_command', a.id::text, true);
 perform set_config('portal.status_note', 'Offer accepted in the portal', true);
 update public.enrollment_applications set status = 'offer_accepted' where id = a.id;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(v_name, 'Applicant'), case when public.portal_student_id() is not null then 'student' when public.portal_is_agency_admin() then 'agency_admin' else 'agent' end,
   'offer_accepted', 'application', a.id::text, a.id, jsonb_build_object('letter', l.id, 'from', a.status, 'to', 'offer_accepted'));
 insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
 values (a.id, a.tenant_id, 'offer_accepted', jsonb_build_object('from', a.status, 'to', 'offer_accepted', 'actor', auth.uid(), 'via', 'portal'));
end $$;

/* ------------------------------------------------------------------ 8. what the signing page may know about the offer (through the payments function) */
-- Service role only: the payments function answers a link holder who proved the signing token. Nothing of the application beyond the
-- letter's own signing and payment state, plus the institution's name and logo for the page header.
create or replace function public.offer_signing_state(p_request uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, hr as $$
  select jsonb_build_object('institution', (select jsonb_build_object('name', s.name, 'logo', s.logo) from public.cms_settings s order by s.id limit 1))
    || coalesce((select jsonb_build_object('offer', true, 'letterId', l.id, 'signedAt', l.signed_at, 'acceptedAt', l.accepted_at, 'acceptedVia', l.accepted_via,
         'depositPaidAt', l.deposit_paid_at, 'paymentAmountCents', l.payment_amount_cents, 'paymentCurrency', coalesce(l.payment_currency, 'aud'),
         'paymentRequired', public.offer_letter_payment_required(l),
         'hasPayment', exists (select 1 from public.payments p where p.subject_type = 'sign_request' and p.subject_id = r.id and p.status <> 'canceled'),
         'mismatch', exists (select 1 from public.portal_audit_log g where g.application_id = l.application_id and g.action = 'offer_deposit_mismatch' and g.detail->>'letter' = l.id::text),
         'applicationStatus', a.status)
       from hr.sign_requests r join public.enrollment_offer_letters l on l.id = r.offer_letter_id join public.enrollment_applications a on a.id = l.application_id
       where r.id = p_request), jsonb_build_object('offer', false));
$$;
revoke all on function public.offer_signing_state(uuid) from public, anon, authenticated;
grant execute on function public.offer_signing_state(uuid) to service_role;
