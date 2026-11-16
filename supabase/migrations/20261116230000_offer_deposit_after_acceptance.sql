-- OFFER-DEPOSIT (owner brief 2026-11-16, replaces OFFER-PAY-GATE 20261116220000): signing the offer letter accepts the offer at once,
-- with or without an initial deposit (today's behaviour). The deposit is tracked separately on the letter and its Stripe payment:
-- Offer accepted = Yes, Deposit = Pending until Stripe verifies it (webhook or the session read back by the payments function,
-- both through payment_apply_stripe -> offer_letter_deposit_paid, idempotent, amount and currency equal to the letter's). A verified
-- deposit sets deposit_paid_at, adds one "Initial deposit paid AUD$x" row to the application history (action_key deposit_paid; the
-- status stays offer_accepted: the workflow has no status between Offer accepted and CoE / VoE issued) and queues the confirmation
-- email to the student and the CC'd agent ("Your CoE / VoE will be issued soon", VoE when the chosen intake's study load is voe).
-- Reminders: payments.reminder_count / last_reminder_at; offer_deposit_reminder_send (staff, or the application's agent) emails the
-- student their personal link (the same signing link, which now opens the payment page once signed), one per 24 hours unless forced;
-- enrollment_offer_letters.deposit_auto_remind (default off) sends one every 3 days, at most 3, from support_mail_dispatch (every
-- minute). The signing link stays valid after signing until the deposit is paid or cancelled (signing_service `open` already admits a
-- completed request without an expiry check); fresh tokens for reminder and completion emails come from hr.sign_payment_token.
-- Nothing a student or agent calls sets paid or accepted: the functions here are service-role only except the two staff / agent RPCs.
-- Functions restated from hosted 2026-11-16 (pg_get_functiondef); signing_service is patched in place on one anchor line.

/* ------------------------------------------------------------------ 1. columns */
alter table public.payments add column if not exists reminder_count integer not null default 0, add column if not exists last_reminder_at timestamptz;
alter table public.enrollment_offer_letters add column if not exists deposit_auto_remind boolean not null default false;

/* ------------------------------------------------------------------ 2. helpers */
-- "AUD$1,500.00", as the letter and the emails print money.
create or replace function public.offer_money_label(p_cents integer, p_currency text) returns text language sql immutable as $$
  select upper(coalesce(nullif(btrim(p_currency), ''), 'aud')) || '$' || to_char(coalesce(p_cents, 0) / 100.0, 'FM999,999,990.00');
$$;
-- CoE, or VoE when the application's chosen intake has study load voe.
create or replace function public.application_coe_label(p_application uuid) returns text language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from public.enrollment_application_courses x join public.course_intakes i on i.id = x.intake_id
    where x.application_id = p_application and lower(coalesce(i.study_load, '')) = 'voe') then 'VoE' else 'CoE' end;
$$;
revoke all on function public.application_coe_label(uuid) from public, anon, authenticated;
-- True while the letter printed a deposit, a live (not cancelled) Stripe payment exists for its signing request and Stripe has not verified it.
create or replace function public.offer_letter_payment_required(l public.enrollment_offer_letters) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(l.payment_amount_cents, 0) > 0 and l.deposit_paid_at is null and l.signing_request_id is not null
    and exists (select 1 from public.payments p where p.subject_type = 'sign_request' and p.subject_id = l.signing_request_id and p.status <> 'canceled');
$$;
-- A fresh personal link token for the request's signer (reminder and completion emails). The hash is stored; the token goes into one email.
create or replace function hr.sign_payment_token(p_request uuid) returns text language plpgsql security definer set search_path = pg_catalog, hr, public as $$
declare c hr.sign_recipients; v_token text;
begin
  select k.* into c from hr.sign_recipients k where k.request_id = p_request and k.required order by k.signing_order, k.id limit 1;
  if not found then return null; end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into hr.sign_tokens(token_hash, recipient_id) values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), c.id);
  return v_token;
end $$;
revoke all on function hr.sign_payment_token(uuid) from public, anon, authenticated;

/* ------------------------------------------------------------------ 3. the payment as the admin screens and the letter JSON see it */
create or replace function hr.sign_payment_json(p_request uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object('id', p.id, 'amount_cents', p.amount_cents, 'currency', p.currency, 'description', p.description, 'timing', p.timing,
    'status', p.status, 'payer_email', p.payer_email, 'paid_at', p.paid_at, 'amount_paid_cents', p.amount_paid_cents,
    'amount_refunded_cents', p.amount_refunded_cents, 'livemode', p.livemode, 'failure_reason', p.failure_reason,
    'checkout_open', p.checkout_url is not null and p.checkout_expires_at > now(), 'updated_at', p.updated_at,
    'receipt_url', p.receipt_url, 'stripe_payment_intent_id', p.stripe_payment_intent_id,
    'reminder_count', p.reminder_count, 'last_reminder_at', p.last_reminder_at)
  from public.payments p where p.subject_type = 'sign_request' and p.subject_id = p_request and p.status <> 'canceled';
$$;
create or replace function public.offer_letter_payment_json(l public.enrollment_offer_letters) returns jsonb language sql stable security definer set search_path = public, hr as $$
  select case when l.payment_amount_cents is null and l.signing_request_id is null then null else
    coalesce(hr.sign_payment_json(l.signing_request_id), '{}'::jsonb)
    || jsonb_build_object('requestedAmountCents', l.payment_amount_cents, 'requestedCurrency', coalesce(l.payment_currency, 'aud'), 'requestedDescription', l.payment_description,
         'note', l.payment_note, 'depositPaidAt', l.deposit_paid_at, 'autoRemind', l.deposit_auto_remind) end;
$$;

/* ------------------------------------------------------------------ 4. signing accepts the offer at once */
create or replace function public.offer_letter_accept_signed(p_letter uuid, p_request uuid, p_signer text, p_signed bytea, p_signed_hash text, p_certificate bytea, p_certificate_hash text, p_choice text, p_ip text) returns void
language plpgsql security definer set search_path = public as $$
declare l public.enrollment_offer_letters; a public.enrollment_applications; v_pay public.payments;
begin
 select * into l from public.enrollment_offer_letters where id = p_letter for update;
 select * into a from public.enrollment_applications where id = l.application_id for update;
 if l.accepted_at is not null then raise exception 'This offer was already accepted'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'applicant' and x.from_status = a.status and x.kind = 'accept_offer')
  or l.id <> (select q.id from public.enrollment_offer_letters q where q.application_id = a.id order by q.issued_at desc limit 1) then
  raise exception 'This offer can no longer be accepted online. Please contact admissions';
 end if;
 if not public.application_student_active(a.id) then raise exception 'This offer can no longer be accepted online. Please contact admissions'; end if;
 update public.enrollment_offer_letters set signed_at = now(), signed_content = p_signed, signed_sha256 = p_signed_hash, certificate_content = p_certificate,
  certificate_sha256 = p_certificate_hash, prepaid_more = p_choice, signing_request_id = p_request where id = l.id;
 select * into v_pay from public.payments p where p.subject_type = 'sign_request' and p.subject_id = p_request and p.status <> 'canceled';
 -- OFFER-DEPOSIT: the deposit (when the letter asks for one) is tracked on its own; it never holds the acceptance back.
 if not public.offer_letter_accept_apply(l.id, p_signer, 'signing', 'Offer accepted: the student signed the offer letter online',
   jsonb_build_object('request', p_request, 'ip', left(p_ip, 64), 'prepaid_more', p_choice)
   || case when v_pay.id is not null then jsonb_build_object('payment', v_pay.id, 'deposit', case when v_pay.status = 'paid' or l.deposit_paid_at is not null then 'paid' else 'pending' end,
        'amount_cents', v_pay.amount_cents, 'currency', v_pay.currency) else '{}'::jsonb end) then
  raise exception 'This offer can no longer be accepted online. Please contact admissions';
 end if;
end $$;
revoke all on function public.offer_letter_accept_signed(uuid, uuid, text, bytea, text, bytea, text, text, text) from public, anon, authenticated;

/* ------------------------------------------------------------------ 5. the deposit emails (queued on notification_deliveries, sent by email-sender) */
-- 'paid': the confirmation to the student and the CC'd agent. 'reminder': the student's reminder (its personal link is added by email-sender,
-- notification_delivery_deposit_reminder, so no token sits in the queue) and a copy without the link to the agent.
create or replace function public.offer_deposit_mail(p_letter uuid, p_kind text, p_actor uuid) returns integer
language plpgsql security definer set search_path = public, hr as $$
declare l public.enrollment_offer_letters; a public.enrollment_applications; p public.payments; v_contact jsonb; v_agent portal_profiles; v_subject text; v_body text; v_agent_body text;
 v_label text; v_coe text; v_ref text; v_name text; v_student text; v_n integer := 0;
begin
  select * into l from public.enrollment_offer_letters where id = p_letter;
  if not found then return 0; end if;
  select * into a from public.enrollment_applications where id = l.application_id;
  select * into p from public.payments q where q.subject_type = 'sign_request' and q.subject_id = l.signing_request_id and q.status <> 'canceled';
  v_contact := public.application_student_contact(a.id);
  v_student := coalesce(nullif(v_contact->>'name', ''), 'Student');
  v_ref := coalesce(nullif(a.reference, ''), left(a.id::text, 8));
  v_label := public.offer_money_label(coalesce(p.amount_paid_cents, p.amount_cents, l.payment_amount_cents), coalesce(p.currency, l.payment_currency, 'aud'));
  select coalesce(nullif(btrim(s.name), ''), 'Skyline Institute of Technology') into v_name from public.cms_settings s where s.tenant_id is not distinct from a.tenant_id order by s.id limit 1;
  v_name := coalesce(v_name, 'Skyline Institute of Technology');
  v_coe := public.application_coe_label(a.id);
  if a.assigned_agent_id is not null then select * into v_agent from public.portal_profiles x where x.id = a.assigned_agent_id and x.status = 'Active' and coalesce(btrim(x.email), '') <> ''; end if;
  if p_kind = 'paid' then
    v_subject := 'Payment received: initial deposit for application ' || v_ref;
    v_body := 'Hello ' || v_student || E',\n\nPayment received, thank you. Your initial deposit of ' || v_label || ' for application ' || v_ref || ' has been received.'
      || E'\n\nYour ' || v_coe || ' will be issued soon. We will email you when it is ready.'
      || case when p.receipt_url is not null then E'\n\nYou can keep the Stripe receipt for your records. View your payment receipt: ' || p.receipt_url else '' end
      || E'\n\n' || v_name;
    v_agent_body := 'Hello ' || coalesce(nullif(v_agent.full_name, ''), 'there') || E',\n\nThe initial deposit of ' || v_label || ' for ' || v_student || ' (application ' || v_ref || ') has been received.'
      || E'\n\nThe ' || v_coe || E' will be issued soon.\n\n' || v_name;
  elsif p_kind = 'reminder' then
    v_subject := 'Reminder: your initial deposit of ' || v_label || ' for application ' || v_ref;
    v_body := 'Hello ' || v_student || E',\n\nThank you for accepting your offer (application ' || v_ref || '). Your initial deposit of ' || v_label || ' is still outstanding.'
      || E'\n\nYou can pay it by card in a few minutes on your personal page; no sign-in is needed.';
    v_agent_body := 'Hello ' || coalesce(nullif(v_agent.full_name, ''), 'there') || E',\n\nA reminder about the initial deposit of ' || v_label || ' (application ' || v_ref || ', ' || v_student || ') was emailed to the student today.'
      || E'\n\nThe student pays by card from the link in their email.\n\n' || v_name;
  else
    raise exception 'Unknown deposit email' using errcode = '22023';
  end if;
  if coalesce(v_contact->>'email', '') <> '' then
    insert into public.notification_deliveries(tenant_id, application_id, recipient_email, event, template_source, subject, body, html_body, signing)
    values (a.tenant_id, a.id, v_contact->>'email', 'offer_deposit_' || p_kind, 'default', v_subject, v_body, public.email_html_wrap(a.tenant_id, v_subject, v_body), p_kind = 'reminder');
    v_n := v_n + 1;
  end if;
  if v_agent.email is not null and lower(btrim(v_agent.email)) <> lower(coalesce(v_contact->>'email', '')) then
    insert into public.notification_deliveries(tenant_id, application_id, recipient_email, event, template_source, subject, body, html_body, signing)
    values (a.tenant_id, a.id, lower(btrim(v_agent.email)), 'offer_deposit_' || p_kind, 'default', v_subject, v_agent_body, public.email_html_wrap(a.tenant_id, v_subject, v_agent_body), false);
    v_n := v_n + 1;
  end if;
  return v_n;
end $$;
revoke all on function public.offer_deposit_mail(uuid, text, uuid) from public, anon, authenticated;

-- email-sender (service role) adds the student's personal link to a queued reminder while it holds the delivery lease: the token is minted
-- here and returned once, never stored. closed: nothing left to pay (the email is dropped).
create or replace function public.notification_delivery_deposit_reminder(p_id uuid, p_lease uuid, p_site text) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare x public.notification_deliveries; l public.enrollment_offer_letters; v_token text; v_text text;
begin
  select * into x from public.notification_deliveries y where y.id = p_id and y.lease_token = p_lease and y.state = 'sending' and y.event = 'offer_deposit_reminder' and y.signing;
  if not found then return null; end if;
  select * into l from public.enrollment_offer_letters q where q.application_id = x.application_id order by q.issued_at desc limit 1;
  if not found or not public.offer_letter_payment_required(l) then return jsonb_build_object('closed', true); end if;
  if coalesce(p_site, '') !~ '^https?://[^\s/"<>]+(/[^\s"<>]*)?$' then return null; end if;
  v_token := hr.sign_payment_token(l.signing_request_id);
  if v_token is null then return jsonb_build_object('closed', true); end if;
  perform hr.sign_event(l.signing_request_id, 'payment_link_emailed', null, null, jsonb_build_object('delivery', x.id, 'to', x.recipient_email));
  v_text := x.body || E'\n\nPay your initial deposit: ' || rtrim(p_site, '/') || '/sign#t=' || v_token
    || E'\n\nThis link is personal to you; please do not forward it.';
  return jsonb_build_object('text', v_text, 'html', public.email_html_wrap(x.tenant_id, x.subject, v_text));
end $$;
revoke all on function public.notification_delivery_deposit_reminder(uuid, uuid, text) from public, anon, authenticated;

/* ------------------------------------------------------------------ 6. the verified deposit: paid, history, confirmation email */
create or replace function public.offer_letter_deposit_paid(p_request uuid, p_payment uuid) returns void
language plpgsql security definer set search_path = public, hr as $$
declare r hr.sign_requests; l public.enrollment_offer_letters; a public.enrollment_applications; p public.payments; v_signer text; v_mismatch text; v_label text;
begin
  select * into r from hr.sign_requests where id = p_request;
  if not found or r.offer_letter_id is null then return; end if;
  select * into p from public.payments where id = p_payment;
  if p.id is null or p.status <> 'paid' or p.subject_type <> 'sign_request' or p.subject_id <> p_request then return; end if;
  select * into l from public.enrollment_offer_letters where id = r.offer_letter_id for update;
  if not found then return; end if;
  select * into a from public.enrollment_applications where id = l.application_id;
  v_signer := coalesce(nullif(r.signer_name, ''), nullif(r.recipient_name, ''), 'Student');
  -- Stripe's amount and currency must be the letter's: anything else is flagged for staff and never counts as the deposit.
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
  if l.deposit_paid_at is not null then return; end if; -- a retried event: already recorded
  update public.enrollment_offer_letters set deposit_paid_at = coalesce(p.paid_at, now()) where id = l.id;
  v_label := public.offer_money_label(coalesce(p.amount_paid_cents, p.amount_cents), p.currency);
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
  values (null, v_signer, 'student', 'offer_deposit_paid', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
    jsonb_build_object('letter', l.id, 'request', r.id, 'payment', p.id, 'amount_cents', coalesce(p.amount_paid_cents, p.amount_cents), 'currency', p.currency,
      'status', a.status, 'livemode', p.livemode, 'receipt_url', p.receipt_url));
  -- One history entry; the status stays (the workflow has no status between Offer accepted and CoE / VoE issued).
  insert into public.enrollment_application_status_history(application_id, previous_status, new_status, actor, actor_name, actor_role, note, action_key, payload)
  values (a.id, a.status, a.status, null, v_signer, 'student', 'Initial deposit paid ' || v_label, 'deposit_paid',
    jsonb_build_object('letter', l.id, 'request', r.id, 'payment', p.id, 'amount_cents', coalesce(p.amount_paid_cents, p.amount_cents), 'currency', p.currency, 'receipt_url', p.receipt_url, 'livemode', p.livemode));
  perform public.offer_deposit_mail(l.id, 'paid', null);
end $$;
revoke all on function public.offer_letter_deposit_paid(uuid, uuid) from public, anon, authenticated;

/* ------------------------------------------------------------------ 7. reminders: by staff or the agent, and automatic */
create or replace function public.offer_deposit_reminder_send(p_application uuid, p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare a public.enrollment_applications; l public.enrollment_offer_letters; p public.payments; v_staff boolean; v_name text;
begin
  v_staff := public.cms_is_staff();
  if not v_staff and (public.portal_student_id() is not null or not public.portal_can_access_application(p_application)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select * into a from public.enrollment_applications where id = p_application;
  if not found then raise exception 'Application not found' using errcode = '42501'; end if;
  select * into l from public.enrollment_offer_letters where application_id = a.id order by issued_at desc limit 1;
  if not found or not public.offer_letter_payment_required(l) then raise exception 'There is no outstanding deposit on this offer' using errcode = '22023'; end if;
  select * into p from public.payments q where q.subject_type = 'sign_request' and q.subject_id = l.signing_request_id and q.status <> 'canceled' for update;
  if not p_force and p.last_reminder_at > now() - interval '24 hours' then
    raise exception 'A reminder was sent less than 24 hours ago' using errcode = 'P0024';
  end if;
  perform public.offer_deposit_mail(l.id, 'reminder', auth.uid());
  update public.payments set reminder_count = reminder_count + 1, last_reminder_at = now(), updated_at = now() where id = p.id returning * into p;
  v_name := coalesce((select u.name from public.cms_users u where u.auth_user_id = auth.uid()), (select x.full_name from public.portal_profiles x where x.auth_user_id = auth.uid() limit 1), 'Staff');
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
  values (auth.uid(), left(v_name, 150), case when v_staff then 'staff' else 'agent' end, 'offer_deposit_reminder', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
    jsonb_build_object('letter', l.id, 'payment', p.id, 'count', p.reminder_count, 'forced', p_force));
  perform hr.sign_event(l.signing_request_id, 'payment_reminder', null, auth.uid(), jsonb_build_object('count', p.reminder_count, 'by', v_name));
  return jsonb_build_object('reminderCount', p.reminder_count, 'lastReminderAt', p.last_reminder_at);
end $$;
revoke all on function public.offer_deposit_reminder_send(uuid, boolean) from public, anon;
grant execute on function public.offer_deposit_reminder_send(uuid, boolean) to authenticated;

create or replace function public.offer_deposit_set_auto_remind(p_application uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l public.enrollment_offer_letters;
begin
  if not public.cms_is_staff() then raise exception 'Staff access required' using errcode = '42501'; end if;
  select * into l from public.enrollment_offer_letters where application_id = p_application order by issued_at desc limit 1 for update;
  if not found then raise exception 'There is no offer letter' using errcode = '22023'; end if;
  update public.enrollment_offer_letters set deposit_auto_remind = coalesce(p_on, false) where id = l.id;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
  values (auth.uid(), coalesce((select u.name from public.cms_users u where u.auth_user_id = auth.uid()), 'Staff'), 'staff', 'offer_deposit_auto_remind', 'application', l.application_id::text, l.application_id,
    jsonb_build_object('letter', l.id, 'on', coalesce(p_on, false)));
  return jsonb_build_object('autoRemind', coalesce(p_on, false));
end $$;
revoke all on function public.offer_deposit_set_auto_remind(uuid, boolean) from public, anon;
grant execute on function public.offer_deposit_set_auto_remind(uuid, boolean) to authenticated;

-- Automatic reminders: every 3 days, at most 3, for accepted offers whose deposit is pending and whose letter has the switch on.
create or replace function public.offer_deposit_reminders_tick() returns integer
language plpgsql security definer set search_path = public, hr as $$
declare l public.enrollment_offer_letters; p public.payments; a public.enrollment_applications; v_n integer := 0;
begin
  for l in select q.* from public.enrollment_offer_letters q where q.deposit_auto_remind and q.accepted_at is not null and q.deposit_paid_at is null and q.signing_request_id is not null
    and q.id = (select z.id from public.enrollment_offer_letters z where z.application_id = q.application_id order by z.issued_at desc limit 1) loop
    select * into a from public.enrollment_applications where id = l.application_id;
    if a.status <> 'offer_accepted' then continue; end if;
    select * into p from public.payments q where q.subject_type = 'sign_request' and q.subject_id = l.signing_request_id and q.status in ('pending', 'open', 'failed') for update skip locked;
    if p.id is null or p.reminder_count >= 3 or coalesce(p.last_reminder_at, l.accepted_at) > now() - interval '3 days' then continue; end if;
    perform public.offer_deposit_mail(l.id, 'reminder', null);
    update public.payments set reminder_count = reminder_count + 1, last_reminder_at = now(), updated_at = now() where id = p.id returning * into p;
    insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
    values (null, 'Automatic reminder', 'system', 'offer_deposit_reminder', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
      jsonb_build_object('letter', l.id, 'payment', p.id, 'count', p.reminder_count, 'auto', true));
    perform hr.sign_event(l.signing_request_id, 'payment_reminder', null, null, jsonb_build_object('count', p.reminder_count, 'auto', true));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.offer_deposit_reminders_tick() from public, anon, authenticated;

-- The every-minute mail dispatcher (restated from hosted) runs the automatic reminders first, so their emails leave in the same minute.
create or replace function public.support_mail_dispatch() returns bigint
language plpgsql security definer set search_path = public, vault, net as $$
declare v_key text; v_last public.support_mail_dispatch_state; v_id bigint;
begin
  if not pg_try_advisory_xact_lock(9342, 20261112) then return null; end if;
  begin perform public.offer_deposit_reminders_tick(); exception when others then null; end;
  if not exists (select 1 from public.notification_deliveries where state = 'pending' and next_attempt_at <= now() and event <> 'application_submitted') then return null; end if;
  select * into v_last from public.support_mail_dispatch_state;
  if v_last.last_request_id is not null and v_last.last_dispatched_at > now() - interval '5 minutes'
     and not exists (select 1 from net._http_response r where r.id = v_last.last_request_id) then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'notification_service_role_key' limit 1;
  if nullif(v_key, '') is null then return null; end if;
  v_id := net.http_post(
    url := 'https://xcpydisstlvtvcsqnjob.supabase.co/functions/v1/email-sender',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
  insert into public.support_mail_dispatch_state(id, last_request_id, last_dispatched_at) values (true, v_id, now())
  on conflict (id) do update set last_request_id = excluded.last_request_id, last_dispatched_at = excluded.last_dispatched_at;
  return v_id;
end $$;

/* ------------------------------------------------------------------ 8. the completion email carries the deposit link */
-- notify_claim (signing_service) adds 'deposit' to each job: for the signer's completion email of an offer letter whose deposit is pending,
-- the amount and a fresh token; the document-signing function turns it into the "Pay your initial deposit" link. Null otherwise.
create or replace function public.offer_deposit_mail_json(p_request uuid, p_kind text, p_audience text) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare l public.enrollment_offer_letters;
begin
  if p_kind <> 'completed' or p_audience <> 'recipient' then return null; end if;
  select q.* into l from public.enrollment_offer_letters q join hr.sign_requests r on r.offer_letter_id = q.id where r.id = p_request;
  if not found or not public.offer_letter_payment_required(l) then return null; end if;
  return jsonb_build_object('label', public.offer_money_label(l.payment_amount_cents, coalesce(l.payment_currency, 'aud')), 'amount_cents', l.payment_amount_cents,
    'currency', coalesce(l.payment_currency, 'aud'), 'token', hr.sign_payment_token(l.signing_request_id));
end $$;
revoke all on function public.offer_deposit_mail_json(uuid, text, text) from public, anon, authenticated;
do $patch$
declare v_def text; v_anchor text; v_count integer;
begin
  v_anchor := $a$'signers', (select jsonb_agg(jsonb_build_object('name', k.name, 'role', k.role_label, 'state', k.state) order by k.signing_order, k.id) from hr.sign_recipients k where k.request_id = r.id));$a$;
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'signing_service';
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'signing_service notify_claim anchor found % times, expected 1', v_count; end if;
  execute replace(v_def, v_anchor, $a$'deposit', public.offer_deposit_mail_json(r.id, n.kind, n.audience), $a$ || v_anchor);
end $patch$;

/* ------------------------------------------------------------------ 9. the portal's Accept offer button: back to its hosted form (no deposit gate) */
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

/* ------------------------------------------------------------------ 10. what the signing page may know (through the payments function) */
create or replace function public.offer_signing_state(p_request uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, hr as $$
  select jsonb_build_object('institution', (select jsonb_build_object('name', s.name, 'logo', s.logo) from public.cms_settings s order by s.id limit 1))
    || coalesce((select jsonb_build_object('offer', true, 'letterId', l.id, 'signedAt', l.signed_at, 'acceptedAt', l.accepted_at, 'acceptedVia', l.accepted_via,
         'depositPaidAt', l.deposit_paid_at, 'paymentAmountCents', l.payment_amount_cents, 'paymentCurrency', coalesce(l.payment_currency, 'aud'),
         'paymentRequired', public.offer_letter_payment_required(l),
         'hasPayment', exists (select 1 from public.payments p where p.subject_type = 'sign_request' and p.subject_id = r.id and p.status <> 'canceled'),
         'mismatch', exists (select 1 from public.portal_audit_log g where g.application_id = l.application_id and g.action = 'offer_deposit_mismatch' and g.detail->>'letter' = l.id::text),
         'applicationStatus', a.status, 'coeLabel', public.application_coe_label(a.id))
       from hr.sign_requests r join public.enrollment_offer_letters l on l.id = r.offer_letter_id join public.enrollment_applications a on a.id = l.application_id
       where r.id = p_request), jsonb_build_object('offer', false));
$$;
revoke all on function public.offer_signing_state(uuid) from public, anon, authenticated;
grant execute on function public.offer_signing_state(uuid) to service_role;

/* ------------------------------------------------------------------ 11. Finance › Payments: reminders on the rows */
-- finance_payment_rows() keeps its shape (a return type change would need DROP, which hosted refuses to run unattended); the list reads
-- finance_payment_rows_v2(), the same rows plus reminder_count, last_reminder_at and deposit_auto_remind.
create or replace function public.finance_payment_rows_v2() returns table(id uuid, created_at timestamptz, paid_at timestamptz, paid_or_created timestamptz, status text, amount_cents integer,
  amount_paid_cents integer, amount_refunded_cents integer, currency text, description text, livemode boolean, stripe_payment_intent_id text, stripe_checkout_session_id text,
  stripe_charge_id text, receipt_url text, payer_email text, failure_reason text, subject_type text, subject_id uuid, request_reference text, request_title text, request_state text,
  application_id uuid, application_reference text, application_status text, student_name text, student_email text, course_id text, course_code text, course_title text,
  agency_id uuid, agency_name text, offer_letter_id uuid, offer_accepted_at timestamptz, deposit_paid_at timestamptz, tenant_id uuid,
  reminder_count integer, last_reminder_at timestamptz, deposit_auto_remind boolean)
language sql stable security definer set search_path = public, hr as $$
  select x.id, x.created_at, x.paid_at, x.paid_or_created, x.status, x.amount_cents, x.amount_paid_cents, x.amount_refunded_cents, x.currency, x.description, x.livemode,
    x.stripe_payment_intent_id, x.stripe_checkout_session_id, x.stripe_charge_id, x.receipt_url, x.payer_email, x.failure_reason, x.subject_type, x.subject_id, x.request_reference,
    x.request_title, x.request_state, x.application_id, x.application_reference, x.application_status, x.student_name, x.student_email, x.course_id, x.course_code, x.course_title,
    x.agency_id, x.agency_name, x.offer_letter_id, x.offer_accepted_at, x.deposit_paid_at, x.tenant_id, p.reminder_count, p.last_reminder_at, coalesce(l.deposit_auto_remind, false)
  from public.finance_payment_rows() x
  join public.payments p on p.id = x.id
  left join public.enrollment_offer_letters l on l.id = x.offer_letter_id;
$$;
revoke all on function public.finance_payment_rows_v2() from public, anon, authenticated;
-- Restated from hosted 2026-11-16 (20261116170000) with finance_payment_rows_v2().
create or replace function public.finance_payments_list(p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
declare v_from timestamptz; v_to timestamptz; v_status text; v_course text; v_agency uuid; v_q text; v_sort text; v_dir text; v_page integer; v_size integer;
 v_total integer; v_rows jsonb; v_summary jsonb; v_where text; v_order text;
begin
 if not public.cms_is_staff() then raise exception 'Staff access required' using errcode = '42501'; end if;
 v_from := nullif(btrim(coalesce(p_filters->>'from', '')), '')::timestamptz;
 v_to := nullif(btrim(coalesce(p_filters->>'to', '')), '')::timestamptz;
 v_status := nullif(btrim(coalesce(p_filters->>'status', '')), '');
 v_course := nullif(btrim(coalesce(p_filters->>'courseId', '')), '');
 v_agency := nullif(btrim(coalesce(p_filters->>'agencyId', '')), '')::uuid;
 v_q := nullif(lower(btrim(coalesce(p_filters->>'q', ''))), '');
 v_sort := case p_filters->>'sort' when 'amount' then 'amount' when 'student' then 'student' when 'status' then 'status' else 'date' end;
 v_dir := case when lower(coalesce(p_filters->>'dir', 'desc')) = 'asc' then 'asc' else 'desc' end;
 v_page := greatest(1, coalesce(nullif(p_filters->>'page', '')::integer, 1));
 v_size := least(500, greatest(1, coalesce(nullif(p_filters->>'pageSize', '')::integer, 25)));
 v_where := ' where ($1::timestamptz is null or x.paid_or_created >= $1) and ($2::timestamptz is null or x.paid_or_created < $2)'
  || ' and ($3::text is null or case $3::text when ''pending'' then x.status in (''pending'', ''open'', ''processing'') else x.status = $3::text end)'
  || ' and ($4::text is null or x.course_id = $4::text) and ($5::uuid is null or x.agency_id = $5::uuid)'
  || ' and ($6::text is null or lower(concat_ws('' '', x.student_name, x.student_email, x.application_reference, x.request_reference, x.payer_email, x.stripe_payment_intent_id)) like ''%'' || $6::text || ''%'')';
 v_order := case v_sort when 'amount' then 'x.amount_cents' when 'student' then 'lower(x.student_name)' when 'status' then 'x.status' else 'x.paid_or_created' end
  || ' ' || v_dir || ' nulls last, x.paid_or_created desc, x.id';
 execute 'select count(*) from public.finance_payment_rows_v2() x' || v_where into v_total using v_from, v_to, v_status, v_course, v_agency, v_q;
 execute 'select jsonb_build_object(''collectedCents'', coalesce(sum(coalesce(x.amount_paid_cents, x.amount_cents)) filter (where x.status = ''paid''), 0),'
  || ' ''refundedCents'', coalesce(sum(x.amount_refunded_cents) filter (where x.status in (''paid'', ''refunded'')), 0),'
  || ' ''paid'', count(*) filter (where x.status = ''paid''), ''pending'', count(*) filter (where x.status in (''pending'', ''open'', ''processing'')),'
  || ' ''failed'', count(*) filter (where x.status = ''failed''), ''refunded'', count(*) filter (where x.status = ''refunded''), ''total'', count(*))'
  || ' from public.finance_payment_rows_v2() x' || v_where into v_summary using v_from, v_to, v_status, v_course, v_agency, v_q;
 execute 'select coalesce(jsonb_agg(to_jsonb(r) - ''n'' order by r.n), ''[]''::jsonb) from (select row_number() over (order by ' || v_order || ') as n, x.*'
  || ' from public.finance_payment_rows_v2() x' || v_where || ' order by n limit $7 offset $8) r'
  into v_rows using v_from, v_to, v_status, v_course, v_agency, v_q, v_size, (v_page - 1) * v_size;
 return jsonb_build_object('rows', v_rows, 'total', v_total, 'page', v_page, 'pageSize', v_size, 'summary', v_summary);
end $$;
revoke all on function public.finance_payments_list(jsonb) from public, anon;
grant execute on function public.finance_payments_list(jsonb) to authenticated;
