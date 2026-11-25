-- AVETMISS-UI (2026-11-25, owner: "Build all AVETMISS screens"; owner chose "Allow RPCs only"). Additive: security-definer
-- functions only. No table, column, trigger or RLS change. lms_unit_students has RLS with no policies and payments has an admin
-- read policy only, so the browser reads / writes them through these functions:
--   avetmiss_unit_result_options()        intakes with their units (students, outcomes recorded) for LMS > Results
--   avetmiss_unit_results(intake, unit)   one unit's students with their AVETMISS outcome fields
--   avetmiss_unit_results_save(rows)      one or many rows; only the keys sent are changed; outcome_recorded_at / _by set
--   finance_payments_list_v2(filters)     finance_payments_list + fee_type / source filters and the payment's own fields
--   finance_payment_save(data)            manual payment add, edit (fee type, student, course, reference), manual refund
--   finance_payment_students()            the student picker (name, student number)
begin;

create or replace function public.avetmiss_unit_result_options()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
begin
 if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
  raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object('intakeId', i.id, 'intakeName', coalesce(nullif(btrim(i.name), ''), i.label, to_char(i.start_date, 'DD Mon YYYY')),
    'startDate', i.start_date, 'endDate', i.end_date, 'courseId', c.id, 'courseCode', c.code, 'courseName', c.name, 'units', u.units)
    order by c.code, i.start_date desc)
  from public.course_intakes i
  join public.cms_courses c on c.id = i.course_id
  join lateral (
   select jsonb_agg(jsonb_build_object('unitId', cu.id, 'code', cu.code, 'name', cu.name, 'students', s.n, 'recorded', s.recorded) order by cu.sort, cu.code) units
   from (select l.unit_id, count(*) n, count(l.outcome_code) recorded from public.lms_unit_students l where l.intake_id = i.id group by l.unit_id) s
   join public.cms_course_units cu on cu.id = s.unit_id) u on u.units is not null), '[]'::jsonb);
end $function$;

create or replace function public.avetmiss_unit_results(p_intake uuid, p_unit text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
begin
 if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
  raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object('intakeId', l.intake_id, 'unitId', l.unit_id, 'studentId', l.student_id, 'name', s.full_name, 'email', s.email,
    'studentNumber', s.student_number, 'assignedStart', l.assigned_start_date, 'assignedEnd', l.assigned_end_date,
    'actualStart', l.actual_start_date, 'actualEnd', l.actual_end_date, 'outcome', l.outcome_code,
    'deliveryMode', l.predominant_delivery_mode, 'deliveryIdentifier', l.delivery_mode_identifier, 'locationId', l.location_id,
    'evidenceNote', l.outcome_evidence_note, 'evidencePath', l.outcome_evidence_path, 'recordedAt', l.outcome_recorded_at,
    'recordedBy', (select u.name from public.cms_users u where u.auth_user_id = l.outcome_recorded_by limit 1))
    order by lower(s.full_name))
  from public.lms_unit_students l join public.enrollment_students s on s.id = l.student_id
  where l.intake_id = p_intake and l.unit_id = p_unit), '[]'::jsonb);
end $function$;

create or replace function public.avetmiss_unit_results_save(p_rows jsonb)
 returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare r jsonb; v_n integer := 0; v_changed boolean;
begin
 if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
  raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
 if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Nothing to save.' using errcode = '22023'; end if;
 if jsonb_array_length(p_rows) > 500 then raise exception 'Save at most 500 rows at a time.' using errcode = '22023'; end if;
 for r in select * from jsonb_array_elements(p_rows) loop
  v_changed := r ? 'outcome';
  update public.lms_unit_students l set
   outcome_code = case when r ? 'outcome' then nullif(r->>'outcome', '') else l.outcome_code end,
   actual_start_date = case when r ? 'actualStart' then nullif(r->>'actualStart', '')::date else l.actual_start_date end,
   actual_end_date = case when r ? 'actualEnd' then nullif(r->>'actualEnd', '')::date else l.actual_end_date end,
   predominant_delivery_mode = case when r ? 'deliveryMode' then nullif(r->>'deliveryMode', '') else l.predominant_delivery_mode end,
   delivery_mode_identifier = case when r ? 'deliveryIdentifier' then nullif(upper(r->>'deliveryIdentifier'), '') else l.delivery_mode_identifier end,
   location_id = case when r ? 'locationId' then nullif(r->>'locationId', '')::uuid else l.location_id end,
   outcome_evidence_note = case when r ? 'evidenceNote' then nullif(btrim(r->>'evidenceNote'), '') else l.outcome_evidence_note end,
   outcome_evidence_path = case when r ? 'evidencePath' then nullif(r->>'evidencePath', '') else l.outcome_evidence_path end,
   outcome_recorded_at = case when v_changed then now() else l.outcome_recorded_at end,
   outcome_recorded_by = case when v_changed then auth.uid() else l.outcome_recorded_by end
  where l.intake_id = (r->>'intakeId')::uuid and l.unit_id = r->>'unitId' and l.student_id = (r->>'studentId')::uuid;
  if found then v_n := v_n + 1; end if;
 end loop;
 return v_n;
end $function$;

create or replace function public.finance_payments_list_v2(p_filters jsonb default '{}'::jsonb)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'hr'
as $function$
declare v_from timestamptz; v_to timestamptz; v_status text; v_course text; v_agency uuid; v_q text; v_fee text; v_source text; v_sort text; v_dir text;
 v_page integer; v_size integer; v_total integer; v_rows jsonb; v_summary jsonb; v_where text; v_order text; v_src text;
begin
 if not public.cms_is_staff() then raise exception 'Staff access required' using errcode = '42501'; end if;
 v_from := nullif(btrim(coalesce(p_filters->>'from', '')), '')::timestamptz;
 v_to := nullif(btrim(coalesce(p_filters->>'to', '')), '')::timestamptz;
 v_status := nullif(btrim(coalesce(p_filters->>'status', '')), '');
 v_course := nullif(btrim(coalesce(p_filters->>'courseId', '')), '');
 v_agency := nullif(btrim(coalesce(p_filters->>'agencyId', '')), '')::uuid;
 v_q := nullif(lower(btrim(coalesce(p_filters->>'q', ''))), '');
 v_fee := nullif(btrim(coalesce(p_filters->>'feeType', '')), '');
 v_source := nullif(btrim(coalesce(p_filters->>'source', '')), '');
 v_sort := case p_filters->>'sort' when 'amount' then 'amount' when 'student' then 'student' when 'status' then 'status' else 'date' end;
 v_dir := case when lower(coalesce(p_filters->>'dir', 'desc')) = 'asc' then 'asc' else 'desc' end;
 v_page := greatest(1, coalesce(nullif(p_filters->>'page', '')::integer, 1));
 v_size := least(500, greatest(1, coalesce(nullif(p_filters->>'pageSize', '')::integer, 25)));
 -- The rows of finance_payment_rows_v2 with the payment's own fee type, source, student, course and refund; a manual payment's
 -- student and course come from its own columns (it has no signing request or application).
 v_src := ' from (select x.id, x.created_at, x.paid_at, x.paid_or_created, x.status, x.amount_cents, x.amount_paid_cents, x.amount_refunded_cents, x.currency,'
  || ' x.description, x.livemode, x.stripe_payment_intent_id, x.stripe_checkout_session_id, x.stripe_charge_id, x.receipt_url, x.payer_email, x.failure_reason,'
  || ' x.subject_type, x.subject_id, x.request_reference, x.request_title, x.request_state, x.application_id, x.application_reference, x.application_status,'
  || ' coalesce(nullif(x.student_name, ''''), s.full_name, '''') as student_name, coalesce(nullif(x.student_email, ''''), s.email, '''') as student_email,'
  || ' coalesce(x.course_id, p.course_id) as course_id, coalesce(x.course_code, c.code) as course_code, coalesce(x.course_title, c.name) as course_title,'
  || ' x.agency_id, x.agency_name, x.offer_letter_id, x.offer_accepted_at, x.deposit_paid_at, x.tenant_id, x.reminder_count, x.last_reminder_at, x.deposit_auto_remind,'
  || ' p.fee_type, p.source, p.student_id, p.intake_enrolment_id, p.external_reference, p.refunded_at, s.student_number'
  || ' from public.finance_payment_rows_v2() x join public.payments p on p.id = x.id'
  || ' left join public.enrollment_students s on s.id = p.student_id left join public.cms_courses c on c.id = p.course_id) x';
 v_where := ' where ($1::timestamptz is null or x.paid_or_created >= $1) and ($2::timestamptz is null or x.paid_or_created < $2)'
  || ' and ($3::text is null or case $3::text when ''pending'' then x.status in (''pending'', ''open'', ''processing'') else x.status = $3::text end)'
  || ' and ($4::text is null or x.course_id = $4::text) and ($5::uuid is null or x.agency_id = $5::uuid)'
  || ' and ($6::text is null or lower(concat_ws('' '', x.student_name, x.student_email, x.application_reference, x.request_reference, x.payer_email, x.stripe_payment_intent_id, x.external_reference, x.student_number)) like ''%'' || $6::text || ''%'')'
  || ' and ($7::text is null or case $7::text when ''none'' then x.fee_type is null else x.fee_type = $7::text end) and ($8::text is null or x.source = $8::text)';
 v_order := case v_sort when 'amount' then 'x.amount_cents' when 'student' then 'lower(x.student_name)' when 'status' then 'x.status' else 'x.paid_or_created' end
  || ' ' || v_dir || ' nulls last, x.paid_or_created desc, x.id';
 execute 'select count(*)' || v_src || v_where into v_total using v_from, v_to, v_status, v_course, v_agency, v_q, v_fee, v_source;
 execute 'select jsonb_build_object(''collectedCents'', coalesce(sum(coalesce(x.amount_paid_cents, x.amount_cents)) filter (where x.status in (''paid'', ''refunded'')), 0),'
  || ' ''refundedCents'', coalesce(sum(x.amount_refunded_cents) filter (where x.status in (''paid'', ''refunded'')), 0),'
  || ' ''paid'', count(*) filter (where x.status = ''paid''), ''pending'', count(*) filter (where x.status in (''pending'', ''open'', ''processing'')),'
  || ' ''failed'', count(*) filter (where x.status = ''failed''), ''refunded'', count(*) filter (where x.status = ''refunded''), ''total'', count(*))'
  || v_src || v_where into v_summary using v_from, v_to, v_status, v_course, v_agency, v_q, v_fee, v_source;
 execute 'select coalesce(jsonb_agg(to_jsonb(r) - ''n'' order by r.n), ''[]''::jsonb) from (select row_number() over (order by ' || v_order || ') as n, x.*'
  || v_src || v_where || ' order by n limit $9 offset $10) r'
  into v_rows using v_from, v_to, v_status, v_course, v_agency, v_q, v_fee, v_source, v_size, (v_page - 1) * v_size;
 return jsonb_build_object('rows', v_rows, 'total', v_total, 'page', v_page, 'pageSize', v_size, 'summary', v_summary);
end $function$;

create or replace function public.finance_payment_save(p_data jsonb)
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare p public.payments; v_id uuid := nullif(p_data->>'id', '')::uuid; v_fee text := nullif(p_data->>'feeType', ''); v_refund integer; v_amount integer;
begin
 if not public.cms_is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
 if v_id is null then
  -- A payment taken outside Stripe (bank transfer, cash, card at the desk): recorded as paid, source manual.
  v_amount := round(coalesce(nullif(p_data->>'amountCents', '')::numeric, 0));
  if v_amount < 50 then raise exception 'Enter the amount paid (at least $0.50).' using errcode = '22023'; end if;
  if btrim(coalesce(p_data->>'description', '')) = '' then raise exception 'Enter what the payment is for.' using errcode = '22023'; end if;
  if nullif(p_data->>'paidAt', '') is null then raise exception 'Enter the date it was paid.' using errcode = '22023'; end if;
  insert into public.payments(subject_type, subject_id, description, amount_cents, currency, timing, status, amount_paid_cents, paid_at, fee_type, student_id,
   course_id, intake_enrolment_id, source, external_reference, created_by, tenant_id, payer_email)
  values ('other', gen_random_uuid(), left(btrim(p_data->>'description'), 250), v_amount, 'aud', 'independent', 'paid', v_amount, (p_data->>'paidAt')::timestamptz,
   v_fee, nullif(p_data->>'studentId', '')::uuid, nullif(p_data->>'courseId', ''), nullif(p_data->>'intakeEnrolmentId', '')::uuid, 'manual',
   nullif(btrim(coalesce(p_data->>'externalReference', '')), ''), auth.uid(), public.tenant_current(),
   (select s.email from public.enrollment_students s where s.id = nullif(p_data->>'studentId', '')::uuid))
  returning id into v_id;
  return v_id;
 end if;
 select * into p from public.payments where id = v_id for update;
 if not found then raise exception 'Payment not found.' using errcode = 'P0002'; end if;
 update public.payments set
  fee_type = case when p_data ? 'feeType' then v_fee else fee_type end,
  student_id = case when p_data ? 'studentId' then nullif(p_data->>'studentId', '')::uuid else student_id end,
  course_id = case when p_data ? 'courseId' then nullif(p_data->>'courseId', '') else course_id end,
  external_reference = case when p_data ? 'externalReference' then nullif(btrim(p_data->>'externalReference'), '') else external_reference end,
  description = case when p.source = 'manual' and p_data ? 'description' and btrim(p_data->>'description') <> '' then left(btrim(p_data->>'description'), 250) else description end,
  updated_at = now()
 where id = v_id;
 -- A refund is recorded here only for a manual payment (Stripe refunds arrive from Stripe).
 if p_data ? 'refundCents' then
  if p.source <> 'manual' then raise exception 'Refunds of Stripe payments are made in Stripe and recorded automatically.' using errcode = '22023'; end if;
  v_refund := round(coalesce(nullif(p_data->>'refundCents', '')::numeric, 0));
  if v_refund < 0 or v_refund > coalesce(p.amount_paid_cents, p.amount_cents) then raise exception 'The refund cannot be more than the amount paid.' using errcode = '22023'; end if;
  if v_refund > 0 and nullif(p_data->>'refundedAt', '') is null then raise exception 'Enter the refund date.' using errcode = '22023'; end if;
  update public.payments set amount_refunded_cents = v_refund,
   refunded_at = case when v_refund > 0 then (p_data->>'refundedAt')::timestamptz end,
   status = case when v_refund > 0 and v_refund >= coalesce(p.amount_paid_cents, p.amount_cents) then 'refunded' else 'paid' end, updated_at = now()
  where id = v_id;
 end if;
 return v_id;
end $function$;

create or replace function public.finance_payment_students()
 returns jsonb language sql stable security definer set search_path to 'public'
as $function$
 select case when public.cms_is_admin() then coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.full_name, 'email', s.email, 'studentNumber', s.student_number)
  order by lower(s.full_name)) from public.enrollment_students s), '[]'::jsonb) else '[]'::jsonb end;
$function$;

revoke all on function public.avetmiss_unit_result_options() from public, anon;
revoke all on function public.avetmiss_unit_results(uuid, text) from public, anon;
revoke all on function public.avetmiss_unit_results_save(jsonb) from public, anon;
revoke all on function public.finance_payments_list_v2(jsonb) from public, anon;
revoke all on function public.finance_payment_save(jsonb) from public, anon;
revoke all on function public.finance_payment_students() from public, anon;
grant execute on function public.avetmiss_unit_result_options() to authenticated;
grant execute on function public.avetmiss_unit_results(uuid, text) to authenticated;
grant execute on function public.avetmiss_unit_results_save(jsonb) to authenticated;
grant execute on function public.finance_payments_list_v2(jsonb) to authenticated;
grant execute on function public.finance_payment_save(jsonb) to authenticated;
grant execute on function public.finance_payment_students() to authenticated;
commit;
