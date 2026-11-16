-- OFFER-DEPOSIT + FINANCE (owner brief 2026-11-16).
--  A. The initial deposit is paid through Stripe as part of signing the offer letter: the letter stores the deposit asked for (prefilled
--     from fees.deposit, overridable per letter, recorded), the signing request created for the letter gets that payment
--     (hr.sign_payment_set, due after signing), and when Stripe reports the payment the letter is marked deposit-paid. The application
--     status stays the workflow's own 'offer_accepted' (set when the student signs): no new status is invented; the payment is
--     written to the audit log and the signing history.
--  B. public.payments keeps Stripe's receipt URL and charge id (charge.succeeded / charge.updated events, or the expanded session).
--  C. Finance › Payments: an expandable Finance group in the CMS menu and staff-only RPCs that list payments joined to the student,
--     application, course, agency and offer, with filters, sorting, paging, a summary and option lists.
-- Additive: new columns, new menu rows, new functions; the existing functions are restated from hosted 2026-11-16 with these changes.

/* ------------------------------------------------------------------ A1. columns */
alter table public.payments add column if not exists receipt_url text, add column if not exists stripe_charge_id text;
alter table public.enrollment_offer_letters
  add column if not exists payment_amount_cents integer check (payment_amount_cents is null or payment_amount_cents between 50 and 99999999),
  add column if not exists payment_currency text,
  add column if not exists payment_description text,
  add column if not exists payment_note text,
  add column if not exists deposit_paid_at timestamptz;

/* ------------------------------------------------------------------ A2. the payment of a request, with its receipt */
create or replace function hr.sign_payment_json(p_request uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object('id', p.id, 'amount_cents', p.amount_cents, 'currency', p.currency, 'description', p.description, 'timing', p.timing,
    'status', p.status, 'payer_email', p.payer_email, 'paid_at', p.paid_at, 'amount_paid_cents', p.amount_paid_cents,
    'amount_refunded_cents', p.amount_refunded_cents, 'livemode', p.livemode, 'failure_reason', p.failure_reason,
    'checkout_open', p.checkout_url is not null and p.checkout_expires_at > now(), 'updated_at', p.updated_at,
    'receipt_url', p.receipt_url, 'stripe_payment_intent_id', p.stripe_payment_intent_id)
  from public.payments p where p.subject_type = 'sign_request' and p.subject_id = p_request and p.status <> 'canceled';
$$;

/* ------------------------------------------------------------------ A3. a paid deposit completes the offer */
create or replace function public.offer_letter_deposit_paid(p_request uuid, p_payment uuid) returns void language plpgsql security definer set search_path = public, hr as $$
declare r hr.sign_requests; l public.enrollment_offer_letters; a public.enrollment_applications; p public.payments;
begin
  select * into r from hr.sign_requests where id = p_request;
  if not found or r.offer_letter_id is null then return; end if;
  select * into p from public.payments where id = p_payment;
  select * into l from public.enrollment_offer_letters where id = r.offer_letter_id for update;
  if not found or l.deposit_paid_at is not null then return; end if;
  update public.enrollment_offer_letters set deposit_paid_at = coalesce(p.paid_at, now()) where id = l.id;
  select * into a from public.enrollment_applications where id = l.application_id;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
  values (null, coalesce(nullif(r.signer_name, ''), nullif(r.recipient_name, ''), 'Student'), 'student', 'offer_deposit_paid', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
    jsonb_build_object('letter', l.id, 'request', r.id, 'payment', p.id, 'amount_cents', coalesce(p.amount_paid_cents, p.amount_cents), 'currency', p.currency,
      'status', a.status, 'livemode', p.livemode, 'receipt_url', p.receipt_url));
end $$;
revoke all on function public.offer_letter_deposit_paid(uuid, uuid) from public, anon, authenticated;

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

/* ------------------------------------------------------------------ A4. issuing: the deposit asked for with the letter */
drop function if exists public.portal_offer_letter_issue_template(uuid, uuid, integer, text, text, jsonb, text, text, text);
create or replace function public.portal_offer_letter_issue_template(p_application uuid, p_template uuid, p_template_version integer, p_file_name text, p_content_base64 text,
  p_manual jsonb default '[]'::jsonb, p_conditions text default '', p_message text default '', p_override_note text default '', p_payment jsonb default null) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare a public.enrollment_applications; t hr.sign_templates; v_unmapped text[]; v_keys text[]; v_vals jsonb; k text; r public.letter_variables; m jsonb;
 v_missing text[] := '{}'; v_manual jsonb := '[]'::jsonb; v_used jsonb := '{}'::jsonb; v_bytes bytea; v_route jsonb; v_id uuid; v_name text; v_mismatch boolean;
 v_notes text[] := '{}'; v_conditions text; v_pay jsonb; v_pay_note text; v_deposit_cents integer; v_pay_line text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'staff' and x.from_status = a.status and x.kind = 'offer_letter') then
  raise exception 'An offer letter cannot be issued while the application is %', public.portal_status_label(a.status) using errcode = '22023';
 end if;
 select * into t from hr.sign_templates where id = p_template and category = 'student_offer_letter' and deleted_at is null;
 if not found then raise exception 'Choose an offer letter template' using errcode = '22023'; end if;
 if t.status <> 'active' then raise exception 'The template "%" is inactive', t.name using errcode = '22023'; end if;
 if t.version is distinct from p_template_version then raise exception 'The template "%" changed since the preview was made. Refresh the preview', t.name using errcode = '40001'; end if;
 v_unmapped := public.letter_template_unmapped(concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html));
 if cardinality(v_unmapped) > 0 then raise exception 'The template has unmapped variables: %', array_to_string(v_unmapped, ', ') using errcode = '22023'; end if;

 v_keys := public.letter_template_keys(case when (select count(*) from public.enrollment_application_courses x where x.application_id = a.id) > 1
   then concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html)
   else regexp_replace(concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html), '\{\{\s*#if multiple_courses\s*\}\}.*?\{\{\s*/if\s*\}\}', '', 'g') end);
 v_vals := public.application_letter_values(a.id) -> 'values';
 if not exists (select 1 from public.enrollment_application_courses x where x.application_id = a.id and coalesce(x.discount_percent, 0) > 0) then
  v_keys := array(select k2 from unnest(v_keys) k2 where k2 not in ('fees.discount_percent', 'fees.discount_amount', 'fees.tuition_after_discount'));
 end if;
 v_conditions := coalesce(nullif(btrim(coalesce(p_conditions, '')), ''), 'Nil');
 foreach k in array v_keys loop
  select * into r from public.letter_variables where key = k;
  if r.source_kind = 'render' then continue; end if;
  if r.source_kind = 'entered' then v_used := v_used || jsonb_build_object(k, v_conditions); continue; end if;
  select x into m from jsonb_array_elements(coalesce(p_manual, '[]'::jsonb)) x where x->>'key' = k limit 1;
  if not coalesce((v_vals -> k ->> 'missing')::boolean, true) and coalesce(m->>'mode', '') <> 'letter' then
   v_used := v_used || jsonb_build_object(k, v_vals -> k ->> 'value');
   if m->>'mode' = 'source' then
    v_manual := v_manual || jsonb_build_array(jsonb_build_object('key', k, 'label', r.label, 'value', left(v_vals -> k ->> 'value', 500), 'mode', 'source', 'by', auth.uid(), 'at', now()));
    v_notes := v_notes || (r.label || ' (saved to ' || r.source_label || ')');
   end if;
   continue;
  end if;
  if m is not null and m->>'mode' in ('letter', 'source') and nullif(btrim(coalesce(m->>'value', '')), '') is not null then
   v_used := v_used || jsonb_build_object(k, left(btrim(m->>'value'), 2000));
   v_manual := v_manual || jsonb_build_array(jsonb_build_object('key', k, 'label', r.label, 'value', left(btrim(m->>'value'), 500), 'mode', 'letter', 'by', auth.uid(), 'at', now()));
   v_notes := v_notes || (r.label || ' (this letter only)');
  elsif m is not null and m->>'mode' = 'blank' and not r.required then
   v_used := v_used || jsonb_build_object(k, '');
   v_manual := v_manual || jsonb_build_array(jsonb_build_object('key', k, 'label', r.label, 'value', '', 'mode', 'blank', 'by', auth.uid(), 'at', now()));
   v_notes := v_notes || (r.label || ' (left blank)');
  else
   v_missing := v_missing || r.label;
  end if;
 end loop;
 if cardinality(v_missing) > 0 then
  raise exception '% detail(s) missing: %', cardinality(v_missing), array_to_string(v_missing, ', ') using errcode = '22023';
 end if;

 -- OFFER-DEPOSIT: the initial deposit the student pays through Stripe after signing (null: no payment with this letter).
 if p_payment is not null and jsonb_typeof(p_payment) = 'object' then
  v_pay := hr.sign_payment_input(p_payment || jsonb_build_object('timing', 'after_sign'), 'Initial deposit');
  v_pay_note := left(nullif(btrim(coalesce(p_payment->>'note', '')), ''), 500);
  v_deposit_cents := case when (v_vals -> 'fees.deposit' ->> 'raw') ~ '^-?[0-9]+(\.[0-9]+)?$' then round((v_vals -> 'fees.deposit' ->> 'raw')::numeric * 100)::integer end;
  v_pay_line := 'Initial deposit ' || upper(v_pay->>'currency') || ' ' || to_char((v_pay->>'amount_cents')::integer / 100.0, 'FM999,999,990.00') || ' payable through Stripe after signing'
   || case when v_deposit_cents is distinct from (v_pay->>'amount_cents')::integer then ' (differs from the course fee' || case when v_deposit_cents is null then ', none set' else ' ' || to_char(v_deposit_cents / 100.0, 'FM999,999,990.00') end || coalesce(': ' || v_pay_note, '') || ')' else '' end;
  v_notes := v_notes || v_pay_line;
 end if;

 begin v_bytes := decode(coalesce(p_content_base64, ''), 'base64'); exception when others then raise exception 'The letter is not a PDF' using errcode = '22023'; end;
 if v_bytes is null or length(v_bytes) < 5 or substring(v_bytes from 1 for 5) <> '\x255044462d'::bytea then raise exception 'The letter is not a PDF' using errcode = '22023'; end if;
 if length(v_bytes) > 3145728 then raise exception 'The letter is larger than 3 MB' using errcode = '22023'; end if;
 v_mismatch := public.application_declaration_mismatch(a.id);
 if v_mismatch and nullif(btrim(coalesce(p_override_note, '')), '') is null then
  raise exception 'The declarant name and digital signature do not match. Add a note to issue the offer letter anyway' using errcode = '22023';
 end if;
 v_route := public.application_offer_recipient(a.id);
 if coalesce(v_route->>'email', '') = '' then raise exception 'There is no email address to send the offer letter to' using errcode = '22023'; end if;
 select coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', '') into v_name;
 insert into public.enrollment_offer_letters(application_id, tenant_id, source, template_id, file_name, size_bytes, sha256, content, message, override_note,
   recipient_kind, recipient_name, recipient_email, issued_by, issued_by_name, template_name, template_version, variable_values, manual_values,
   payment_amount_cents, payment_currency, payment_description, payment_note)
 values (a.id, a.tenant_id, 'template', t.id, left(coalesce(nullif(btrim(p_file_name), ''), 'Offer letter.pdf'), 200), length(v_bytes), encode(extensions.digest(v_bytes, 'sha256'), 'hex'), v_bytes,
   left(coalesce(p_message, ''), 2000), left(coalesce(p_override_note, ''), 500), v_route->>'kind', coalesce(v_route->>'name', ''), v_route->>'email', auth.uid(), coalesce(v_name, ''),
   t.name, t.version, v_used, v_manual,
   (v_pay->>'amount_cents')::integer, v_pay->>'currency', v_pay->>'description', v_pay_note)
 returning id into v_id;
 perform set_config('portal.offer_command', a.id::text, true);
 perform public.portal_set_application_status(a.id, 'offer_issued',
   left(concat_ws(' · ', 'Offer letter sent to ' || (v_route->>'kind') || ' ' || (v_route->>'email') || ' (template "' || t.name || '" v' || t.version || ')', nullif(btrim(p_message), ''),
     case when cardinality(v_notes) > 0 then 'Filled by hand: ' || array_to_string(v_notes, '; ') end,
     case when v_mismatch then 'Declaration mismatch accepted: ' || btrim(p_override_note) end), 1000));
 perform set_config('portal.offer_command', '', true);
 return jsonb_build_object('id', v_id, 'recipient', v_route, 'manual', v_manual, 'payment', v_pay);
end $$;
revoke all on function public.portal_offer_letter_issue_template(uuid, uuid, integer, text, text, jsonb, text, text, text, jsonb) from public, anon;
grant execute on function public.portal_offer_letter_issue_template(uuid, uuid, integer, text, text, jsonb, text, text, text, jsonb) to authenticated;

/* ------------------------------------------------------------------ A5. the signing request of the letter carries the deposit */
create or replace function public.notification_delivery_offer_signing(p_id uuid, p_lease uuid, p_pages integer default null, p_original_stored boolean default false, p_site text default null) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare x public.notification_deliveries; o public.admission_event_outbox; l public.enrollment_offer_letters; a public.enrollment_applications; r hr.sign_requests; c hr.sign_recipients;
 v_text text;
 st public.cms_settings; v_days integer; v_contact jsonb; v_layout jsonb; f jsonb; v_id uuid; v_token text; v_resend boolean;
begin
 select * into x from public.notification_deliveries y where y.id = p_id and y.lease_token = p_lease and y.state = 'sending' and y.event = 'offer_letter_issued' and y.signing;
 if not found then return null; end if;
 select * into o from public.admission_event_outbox b where b.id = x.outbox_id;
 select * into l from public.enrollment_offer_letters z where z.id = coalesce((o.payload->>'letter')::uuid,
   (select q.id from public.enrollment_offer_letters q where q.application_id = x.application_id order by q.issued_at desc limit 1)) for update;
 if not found then return null; end if;
 select * into a from public.enrollment_applications where id = l.application_id;
 if l.accepted_at is not null or a.status <> 'offer_issued' or l.id <> (select q.id from public.enrollment_offer_letters q where q.application_id = a.id order by q.issued_at desc limit 1) then
  return jsonb_build_object('closed', true);
 end if;
 v_resend := coalesce((o.payload->>'resend')::boolean, false);
 select * into st from public.cms_settings s where s.tenant_id is not distinct from a.tenant_id order by s.id limit 1;
 if not found then select * into st from public.cms_settings s order by s.id limit 1; end if;
 v_days := least(greatest(coalesce(st.offer_validity_days, 30), 1), 365);
 v_contact := public.application_student_contact(a.id);
 select * into r from hr.sign_requests q where q.offer_letter_id = l.id and q.state in ('draft', 'sent', 'viewed', 'partial') order by q.created_at desc limit 1 for update;
 if found and r.state <> 'draft' and r.expires_at <= now() then
  update hr.sign_requests set state = 'expired', expired_at = now() where id = r.id;
  perform hr.sign_stop(r.id, true);
  perform hr.sign_event(r.id, 'expired');
  r := null;
 end if;
 if r.id is null then
  if l.sign_layout is null and o.created_at > now() - interval '3 minutes' then return jsonb_build_object('wait', true); end if;
  v_layout := coalesce(l.sign_layout, public.offer_letter_default_layout(coalesce(p_pages, 1)));
  v_id := gen_random_uuid();
  insert into hr.sign_requests(id, title, recipient_name, recipient_email, original_path, original_hash, state, created_by, reference, signing_mode, subject_type, subject_id, tenant_id,
    category, expiry_days, reminder_days, offer_letter_id, require_code)
  values (v_id, left(coalesce(nullif(btrim(l.template_name), ''), 'Letter of Offer'), 200), left(v_contact->>'name', 150), v_contact->>'email', v_id::text || '/original.pdf', l.sha256, 'draft',
    coalesce(l.issued_by, '00000000-0000-0000-0000-000000000000'::uuid), 'SLIT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('hr.sign_reference_seq')::text, 6, '0'), 'sequential',
    case when a.student_id is not null then 'student' end, a.student_id, a.tenant_id, 'student_offer_letter', v_days, 0, l.id, true)
  returning * into r;
  insert into hr.sign_recipients(request_id, role_key, role_label, name, email, signing_order, required, state)
  values (r.id, 'student', 'Student', left(v_contact->>'name', 150), v_contact->>'email', 1, true, 'pending') returning * into c;
  for f in select * from jsonb_array_elements(v_layout) loop
   if p_pages is not null and (f->>'page')::integer > p_pages then continue; end if;
   insert into hr.sign_fields(request_id, recipient_id, type, page, x, y, w, h, required, label)
   values (r.id, c.id, f->>'type', (f->>'page')::integer, (f->>'x')::numeric, (f->>'y')::numeric, (f->>'w')::numeric, (f->>'h')::numeric, true, left(coalesce(f->>'label', ''), 120));
  end loop;
  update public.enrollment_offer_letters set signing_request_id = r.id where id = l.id;
  perform hr.sign_event(r.id, 'created', null, null, jsonb_build_object('offer_letter', l.id, 'application', a.reference, 'layout', case when l.sign_layout is null then 'default' else 'letter' end));
  -- OFFER-DEPOSIT: the initial deposit asked for with the letter is paid through Stripe once the student has signed.
  if l.payment_amount_cents is not null then
   perform hr.sign_payment_set(r.id, jsonb_build_object('amount_cents', l.payment_amount_cents, 'currency', coalesce(l.payment_currency, 'aud'), 'timing', 'after_sign',
     'description', coalesce(nullif(btrim(l.payment_description), ''), 'Initial deposit'), 'payer_email', v_contact->>'email'), l.issued_by);
  end if;
 end if;
 if r.state = 'draft' then
  if not p_original_stored then return jsonb_build_object('needs_original', true, 'request_id', r.id, 'path', r.original_path, 'hash', r.original_hash); end if;
  update hr.sign_requests set state = 'sent', sent_at = now(),
   expires_at = greatest(l.issued_at + make_interval(days => v_days), now() + interval '1 day') where id = r.id returning * into r;
  update hr.sign_recipients set state = 'sent', sent_at = now(), last_notified_at = now() where request_id = r.id and state = 'pending';
  perform hr.sign_event(r.id, 'sent');
 elsif v_resend and r.expires_at < now() + interval '1 day' then
  update hr.sign_requests set expires_at = now() + make_interval(days => v_days) where id = r.id returning * into r;
 end if;
 select * into c from hr.sign_recipients where request_id = r.id order by signing_order, id limit 1;
 delete from hr.sign_tokens where recipient_id = c.id; -- one live link per offer: the newest email's
 v_token := encode(extensions.gen_random_bytes(32), 'hex');
 insert into hr.sign_tokens(token_hash, recipient_id) values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), c.id);
 update hr.sign_recipients set last_notified_at = now() where id = c.id;
 perform hr.sign_event(r.id, case when v_resend then 'resent' else 'link_emailed' end, c.id, null, jsonb_build_object('delivery', x.id, 'to', c.email));
 if coalesce(p_site, '') ~ '^https?://[^\s/"<>]+(/[^\s"<>]*)?$' then
  v_text := x.body || E'\n\nReview and sign your offer (no sign-in needed): ' || rtrim(p_site, '/') || '/sign#t=' || v_token
   || E'\n\nThis link is personal to you; please do not forward it. It works until '
   || to_char(r.expires_at at time zone 'Australia/Melbourne', 'FMDD FMMonth YYYY') || '. A copy of the letter is attached.'
   || case when l.payment_amount_cents is not null then E'\n\nAfter signing, the initial deposit of ' || upper(coalesce(l.payment_currency, 'aud')) || ' ' || to_char(l.payment_amount_cents / 100.0, 'FM999,999,990.00') || ' can be paid by card on the same page.' else '' end;
 end if;
 return jsonb_build_object('token', v_token, 'expiresAt', r.expires_at, 'title', r.title, 'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)), 'studentName', c.name,
  'institution', coalesce((select t.name from public.tenants t where t.id = a.tenant_id), 'Skyline Institute of Technology'),
  'text', v_text, 'html', case when v_text is not null then public.email_html_wrap(x.tenant_id, x.subject, v_text) end);
end $$;

/* ------------------------------------------------------------------ A6. what staff and agents see on the application */
create or replace function public.offer_letter_payment_json(l public.enrollment_offer_letters) returns jsonb language sql stable security definer set search_path = public, hr as $$
  select case when l.payment_amount_cents is null and l.signing_request_id is null then null else
    coalesce(hr.sign_payment_json(l.signing_request_id), '{}'::jsonb)
    || jsonb_build_object('requestedAmountCents', l.payment_amount_cents, 'requestedCurrency', coalesce(l.payment_currency, 'aud'), 'requestedDescription', l.payment_description,
         'note', l.payment_note, 'depositPaidAt', l.deposit_paid_at) end;
$$;
revoke all on function public.offer_letter_payment_json(public.enrollment_offer_letters) from public, anon, authenticated;

create or replace function public.portal_offer_letter_list(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public, hr as $$
begin
 if not public.portal_can_access_application(p_application) then raise exception 'Application not found' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'fileName', l.file_name, 'sizeBytes', l.size_bytes, 'issuedAt', l.issued_at, 'acceptedAt', l.accepted_at,
   'recipientKind', l.recipient_kind, 'recipientEmail', l.recipient_email, 'templateName', l.template_name, 'templateVersion', l.template_version,
   'acceptedVia', l.accepted_via, 'signedAt', l.signed_at, 'hasSigned', l.signed_content is not null, 'hasCertificate', l.certificate_content is not null, 'prepaidMore', l.prepaid_more,
   'payment', public.offer_letter_payment_json(l),
   'signing', (select jsonb_build_object('status', hr.sign_status(q), 'expiresAt', q.expires_at, 'viewedAt', q.viewed_at, 'reference', q.reference)
     from hr.sign_requests q where q.offer_letter_id = l.id order by q.created_at desc limit 1)) order by l.issued_at desc)
   from public.enrollment_offer_letters l where l.application_id = p_application), '[]'::jsonb);
end $$;

create or replace function public.portal_offer_letter_current(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public, hr as $$
declare l public.enrollment_offer_letters;
begin
 if not public.portal_can_access_application(p_application) then raise exception 'Application not found' using errcode = '42501'; end if;
 select * into l from public.enrollment_offer_letters where application_id = p_application order by issued_at desc limit 1;
 if not found then return null; end if;
 return jsonb_build_object('id', l.id, 'fileName', l.file_name, 'sizeBytes', l.size_bytes, 'source', l.source, 'message', l.message, 'recipientKind', l.recipient_kind,
   'recipientName', l.recipient_name, 'recipientEmail', l.recipient_email, 'issuedAt', l.issued_at, 'issuedByName', l.issued_by_name, 'resentAt', l.resent_at,
   'acceptedAt', l.accepted_at, 'acceptedByName', l.accepted_by_name, 'acceptedVia', l.accepted_via, 'templateName', l.template_name, 'templateVersion', l.template_version,
   'payment', public.offer_letter_payment_json(l))
   || case when public.portal_is_slit_admin() then jsonb_build_object('manualValues', l.manual_values) else '{}'::jsonb end;
end $$;

/* ------------------------------------------------------------------ C1. Finance in the CMS menu */
insert into public.admin_menu_items (id, parent_id, label, route, icon_key, sort_order, is_enabled, permission_key, permission_scope, is_system, open_in_new_tab)
values ('finance', null, 'Finance', null, 'finance', 47, true, 'cms.read', 'current', true, false),
       ('finance_payments', 'finance', 'Payments', '/admin/finance/payments', 'payments', 10, true, 'cms.read', 'current', true, false)
on conflict (id) do update set parent_id = excluded.parent_id, label = excluded.label, route = excluded.route, icon_key = excluded.icon_key, is_enabled = true;

/* ------------------------------------------------------------------ C2. Finance › Payments: the rows, filtered and paged on the server */
create or replace function public.finance_payment_rows() returns table (
  id uuid, created_at timestamptz, paid_at timestamptz, paid_or_created timestamptz, status text, amount_cents integer, amount_paid_cents integer, amount_refunded_cents integer,
  currency text, description text, livemode boolean, stripe_payment_intent_id text, stripe_checkout_session_id text, stripe_charge_id text, receipt_url text, payer_email text,
  failure_reason text, subject_type text, subject_id uuid, request_reference text, request_title text, request_state text,
  application_id uuid, application_reference text, application_status text, student_name text, student_email text,
  course_id text, course_code text, course_title text, agency_id uuid, agency_name text, offer_letter_id uuid, offer_accepted_at timestamptz, deposit_paid_at timestamptz, tenant_id uuid
) language sql stable security definer set search_path = public, hr as $$
  select p.id, p.created_at, p.paid_at, coalesce(p.paid_at, p.created_at), p.status, p.amount_cents, p.amount_paid_cents, p.amount_refunded_cents,
    p.currency, p.description, p.livemode, p.stripe_payment_intent_id, p.stripe_checkout_session_id, p.stripe_charge_id, p.receipt_url, p.payer_email,
    p.failure_reason, p.subject_type, p.subject_id, r.reference, r.title, r.state,
    a.id, a.reference, a.status, coalesce(nullif(a.student_name, ''), nullif(r.recipient_name, ''), ''), coalesce(nullif(a.student_email, ''), r.recipient_email, p.payer_email, ''),
    c.course_id, c.course_code, c.course_title, a.agency_id, g.name, l.id, l.accepted_at, l.deposit_paid_at, p.tenant_id
  from public.payments p
  left join hr.sign_requests r on p.subject_type = 'sign_request' and r.id = p.subject_id
  left join public.enrollment_offer_letters l on l.id = r.offer_letter_id
  left join public.enrollment_applications a on a.id = l.application_id
  left join lateral (select x.course_id, x.course_code, x.course_title from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id limit 1) c on true
  left join public.agencies g on g.id = a.agency_id
  where p.status <> 'canceled';
$$;
revoke all on function public.finance_payment_rows() from public, anon, authenticated;

create or replace function public.finance_payments_list(p_filters jsonb default '{}'::jsonb) returns jsonb language plpgsql stable security definer set search_path = public, hr as $$
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
 -- The filters are parameters of one dynamic query ($1..$6); the sort column and direction come from the allow-lists above only.
 v_where := ' where ($1::timestamptz is null or x.paid_or_created >= $1) and ($2::timestamptz is null or x.paid_or_created < $2)'
  || ' and ($3::text is null or case $3::text when ''pending'' then x.status in (''pending'', ''open'', ''processing'') else x.status = $3::text end)'
  || ' and ($4::text is null or x.course_id = $4::text) and ($5::uuid is null or x.agency_id = $5::uuid)'
  || ' and ($6::text is null or lower(concat_ws('' '', x.student_name, x.student_email, x.application_reference, x.request_reference, x.payer_email, x.stripe_payment_intent_id)) like ''%'' || $6::text || ''%'')';
 v_order := case v_sort when 'amount' then 'x.amount_cents' when 'student' then 'lower(x.student_name)' when 'status' then 'x.status' else 'x.paid_or_created' end
  || ' ' || v_dir || ' nulls last, x.paid_or_created desc, x.id';
 execute 'select count(*) from public.finance_payment_rows() x' || v_where into v_total using v_from, v_to, v_status, v_course, v_agency, v_q;
 execute 'select jsonb_build_object(''collectedCents'', coalesce(sum(coalesce(x.amount_paid_cents, x.amount_cents)) filter (where x.status = ''paid''), 0),'
  || ' ''refundedCents'', coalesce(sum(x.amount_refunded_cents) filter (where x.status in (''paid'', ''refunded'')), 0),'
  || ' ''paid'', count(*) filter (where x.status = ''paid''), ''pending'', count(*) filter (where x.status in (''pending'', ''open'', ''processing'')),'
  || ' ''failed'', count(*) filter (where x.status = ''failed''), ''refunded'', count(*) filter (where x.status = ''refunded''), ''total'', count(*))'
  || ' from public.finance_payment_rows() x' || v_where into v_summary using v_from, v_to, v_status, v_course, v_agency, v_q;
 execute 'select coalesce(jsonb_agg(to_jsonb(r) - ''n'' order by r.n), ''[]''::jsonb) from (select row_number() over (order by ' || v_order || ') as n, x.*'
  || ' from public.finance_payment_rows() x' || v_where || ' order by n limit $7 offset $8) r'
  into v_rows using v_from, v_to, v_status, v_course, v_agency, v_q, v_size, (v_page - 1) * v_size;
 return jsonb_build_object('rows', v_rows, 'total', v_total, 'page', v_page, 'pageSize', v_size, 'summary', v_summary);
end $$;
revoke all on function public.finance_payments_list(jsonb) from public, anon;
grant execute on function public.finance_payments_list(jsonb) to authenticated;

create or replace function public.finance_payments_options() returns jsonb language plpgsql stable security definer set search_path = public, hr as $$
begin
 if not public.cms_is_staff() then raise exception 'Staff access required' using errcode = '42501'; end if;
 return jsonb_build_object(
  'courses', coalesce((select jsonb_agg(jsonb_build_object('id', c.course_id, 'code', c.course_code, 'title', c.course_title) order by c.course_code)
    from (select distinct x.course_id, x.course_code, x.course_title from public.finance_payment_rows() x where x.course_id is not null) c), '[]'::jsonb),
  'agencies', coalesce((select jsonb_agg(jsonb_build_object('id', g.agency_id, 'name', g.agency_name) order by g.agency_name)
    from (select distinct x.agency_id, x.agency_name from public.finance_payment_rows() x where x.agency_id is not null) g), '[]'::jsonb),
  'statuses', jsonb_build_array('paid', 'pending', 'failed', 'refunded'));
end $$;
revoke all on function public.finance_payments_options() from public, anon;
grant execute on function public.finance_payments_options() to authenticated;
