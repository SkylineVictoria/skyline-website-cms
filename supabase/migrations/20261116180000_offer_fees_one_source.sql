-- OFFER-FEES (owner brief 2026-11-16): the letter's fees are one editable section and fees.deposit is the one payment amount.
--  1. portal_offer_letter_issue_template refuses a Stripe payment whose amount differs from the letter's initial deposit (the value the
--     letter prints: the hand-filled one, else the course's), so the drawer cannot send two different numbers.
--  2. portal_letter_save_to_source writes a fee to the course's fee lines (LMS › Courses › Fees, course_fee_items) when the course has
--     fee lines, the intake's own lines when that intake overrides them; a course without lines keeps the older fee setup row.
-- Both functions restated from hosted 2026-11-16 with these changes. Additive.

create or replace function public.portal_letter_save_to_source(p_application uuid, p_key text, p_value text) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.letter_variables; a public.enrollment_applications; ac public.enrollment_application_courses; v text := btrim(coalesce(p_value, '')); v_fee jsonb;
 v_row public.course_fee_setups; v_course text; v_field text; v_type text; v_scope uuid; v_item public.course_fee_items;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 select * into r from public.letter_variables where key = split_part(p_key, '#', 1);
 if not found then raise exception 'Unknown variable %', p_key using errcode = '22023'; end if;
 if not r.editable_source then raise exception '% cannot be saved to its source from here; change it in %', r.label, r.source_label using errcode = '42501'; end if;
 if v = '' then raise exception 'Enter a value for %', r.label using errcode = '22023'; end if;
 if char_length(v) > 2000 then raise exception '% is too long', r.label using errcode = '22023'; end if;
 if r.input_type = 'date' then
  if v !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Enter % as a date', r.label using errcode = '22023'; end if;
  perform v::date;
 end if;
 if r.input_type = 'money' then
  v := regexp_replace(v, '^(AUD)?\$?\s*|,', '', 'g');
  if v !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then raise exception 'Enter % as an amount, for example 14500.00', r.label using errcode = '22023'; end if;
 end if;
 if r.source_kind = 'application' then
  if not public.application_student_active(a.id) then raise exception 'This student is disabled, so their applications are locked' using errcode = '42501'; end if;
  update public.enrollment_applications set data = jsonb_set(coalesce(data, '{}'::jsonb), array['values', r.source_ref], to_jsonb(v), true) where id = a.id;
  update public.enrollment_students s set details = jsonb_set(coalesce(s.details, '{}'::jsonb), array[r.source_ref], to_jsonb(v), true)
   where s.id = a.student_id and coalesce(s.details, '{}'::jsonb) ? r.source_ref;
 else
  if not public.cms_is_admin() then raise exception 'Only an administrator can change % in %', r.label, r.source_label using errcode = '42501'; end if;
  -- A course variable of the n-th course (key#n, packaged offers) saves to that course's setup.
  select * into ac from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id
   offset coalesce(nullif(split_part(p_key, '#', 2), '')::integer, 0) limit 1;
  if r.source_kind = 'institute' then
   if r.source_ref not in ('name', 'short_name', 'address', 'phone', 'email', 'admissions_email', 'rto', 'cricos', 'abn', 'website', 'legal_name') then raise exception 'Not editable' using errcode = '42501'; end if;
   execute format('update public.cms_settings set %I = $1, updated_at = now() where id = (select s.id from public.cms_settings s where s.tenant_id is not distinct from $2 order by s.id limit 1)', r.source_ref) using v, a.tenant_id;
  elsif r.source_kind = 'course' then
   if r.source_ref not in ('cricos', 'duration', 'mode') then raise exception 'Not editable' using errcode = '42501'; end if;
   v_course := public.letter_course_id(ac.course_id, ac.course_code);
   if v_course is null then raise exception 'The application has no course from the course list' using errcode = '22023'; end if;
   execute format('update public.cms_courses set %I = $1, updated_at = now() where id = $2', r.source_ref) using v, v_course;
  elsif r.source_kind = 'fee' then
   v_course := public.letter_course_id(ac.course_id, ac.course_code);
   if v_course is null then raise exception 'The application has no course from the course list' using errcode = '22023'; end if;
   -- OFFER-FEES: a course with fee lines (LMS › Courses › Fees) gets the amount on the matching line: the intake's own lines when it overrides the course's.
   v_type := case r.source_ref when 'tuition_fee' then 'tuition' when 'enrolment_fee' then 'enrolment' when 'material_fee' then 'material' when 'oshc_fee' then 'oshc' when 'deposit' then 'initial_deposit' end;
   if v_type is not null and exists (select 1 from public.course_fee_items x where x.course_id = v_course) then
    v_scope := case when ac.intake_id is not null and exists (select 1 from public.course_fee_items x where x.intake_id = ac.intake_id) then ac.intake_id end;
    select * into v_item from public.course_fee_items x where x.course_id = v_course and x.intake_id is not distinct from v_scope and x.item_type = v_type order by x.sort, x.id limit 1;
    if found then
     update public.course_fee_items set amount_cents = round(v::numeric * 100)::bigint, updated_at = now(), updated_by = auth.uid() where id = v_item.id;
    else
     insert into public.course_fee_items(course_id, intake_id, item_type, label, amount_cents, sort, included_in_total, refundable)
     values (v_course, v_scope, v_type, '', round(v::numeric * 100)::bigint, public.course_fee_type_rank(v_type) * 100 + 99, v_type not in ('initial_deposit', 'oshc'), v_type not in ('application', 'registration', 'enrolment'));
    end if;
   else
    select * into v_row from public.course_fee_setups x where x.course_id = v_course and x.intake_id = ac.intake_id;
    if not found then select * into v_row from public.course_fee_setups x where x.course_id = v_course and x.intake_id is null; end if;
    v_fee := jsonb_build_object('tuition', v_row.tuition_fee, 'enrolment', v_row.enrolment_fee, 'material', v_row.material_fee, 'oshc', v_row.oshc_fee, 'deposit', v_row.deposit,
      'paymentPlan', v_row.payment_plan, 'campus', v_row.campus, 'orientation', v_row.orientation, 'orientationDate', v_row.orientation_date, 'hoursPerWeek', v_row.hours_per_week);
    v_field := case r.source_ref when 'tuition_fee' then 'tuition' when 'enrolment_fee' then 'enrolment' when 'material_fee' then 'material' when 'oshc_fee' then 'oshc'
      when 'deposit' then 'deposit' when 'payment_plan' then 'paymentPlan' when 'campus' then 'campus' when 'orientation' then 'orientationDate' when 'hours_per_week' then 'hoursPerWeek' end;
    if v_field is null then raise exception 'Not editable' using errcode = '42501'; end if;
    perform public.cms_course_fee_save(v_course, case when v_row.id is null then null else v_row.intake_id end, jsonb_strip_nulls(v_fee || jsonb_build_object(v_field, v)));
   end if;
  else
   raise exception '% cannot be saved to its source from here', r.label using errcode = '42501';
  end if;
 end if;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(auth.jwt()->>'email', 'Authorized reviewer'), 'slit_admin', 'letter_value_saved_to_source', 'application', a.id::text, a.id,
   jsonb_build_object('key', p_key, 'source', r.source_label, 'value', left(v, 500)));
 return public.application_letter_values(a.id);
end $$;

create or replace function public.portal_offer_letter_issue_template(p_application uuid, p_template uuid, p_template_version integer, p_file_name text, p_content_base64 text,
  p_manual jsonb default '[]'::jsonb, p_conditions text default '', p_message text default '', p_override_note text default '', p_payment jsonb default null) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare a public.enrollment_applications; t hr.sign_templates; v_unmapped text[]; v_keys text[]; v_vals jsonb; k text; r public.letter_variables; m jsonb;
 v_missing text[] := '{}'; v_manual jsonb := '[]'::jsonb; v_used jsonb := '{}'::jsonb; v_bytes bytea; v_route jsonb; v_id uuid; v_name text; v_mismatch boolean;
 v_notes text[] := '{}'; v_conditions text; v_pay jsonb; v_pay_note text; v_deposit_cents integer; v_letter_deposit text; v_letter_deposit_cents integer; v_pay_line text;
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
 -- OFFER-FEES: its amount must be the letter's own initial deposit: the value printed (hand-filled or saved), else the course's.
 if p_payment is not null and jsonb_typeof(p_payment) = 'object' then
  v_pay := hr.sign_payment_input(p_payment || jsonb_build_object('timing', 'after_sign'), 'Initial deposit');
  v_pay_note := left(nullif(btrim(coalesce(p_payment->>'note', '')), ''), 500);
  v_deposit_cents := case when (v_vals -> 'fees.deposit' ->> 'raw') ~ '^-?[0-9]+(\.[0-9]+)?$' then round((v_vals -> 'fees.deposit' ->> 'raw')::numeric * 100)::integer end;
  v_letter_deposit := coalesce(v_used->>'fees.deposit',
    (select x->>'value' from jsonb_array_elements(coalesce(p_manual, '[]'::jsonb)) x where x->>'key' = 'fees.deposit' and x->>'mode' in ('letter', 'source') and nullif(btrim(coalesce(x->>'value', '')), '') is not null limit 1),
    v_vals -> 'fees.deposit' ->> 'value');
  v_letter_deposit_cents := case when regexp_replace(coalesce(v_letter_deposit, ''), '[^0-9.]', '', 'g') ~ '^[0-9]+(\.[0-9]+)?$'
    then round(regexp_replace(v_letter_deposit, '[^0-9.]', '', 'g')::numeric * 100)::integer end;
  if v_letter_deposit_cents is null or v_letter_deposit_cents <> (v_pay->>'amount_cents')::integer then
   raise exception 'The payment amount (%) must equal the letter''s initial deposit (%). Set the initial deposit in the Fees section',
    to_char((v_pay->>'amount_cents')::integer / 100.0, 'FM999,999,990.00'), coalesce(v_letter_deposit, 'not set') using errcode = '22023';
  end if;
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
