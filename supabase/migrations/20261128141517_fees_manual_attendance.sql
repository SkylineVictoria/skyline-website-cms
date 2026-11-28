-- FEES-MANUAL + AXCELERATE-ATTENDANCE (owner 2026-11-28: "bring attendance also; make sure we can add data also").
--   * Fees module, added in Skyline: admins create and edit invoices (student, course, items, dates; numbered INV-<year>-<n> unless a
--     number is given), void them, and record payments against them (manual payments linked to the invoice). Paid and balance follow the
--     invoice's payments (less refunds) automatically. Invoices from aXcelerate stay read only (the import keeps them equal to aXcelerate):
--     their payments are recorded in aXcelerate and come with the next import.
--   * axcelerate_import_attendance: aXcelerate's attendance of one unit workshop (/course/instance/attendance, type w; read only) for one
--     student -> Skyline's attendance register of the class (batch, the class's unit, the day) and the student's mark (present / absent /
--     late / excused). A register already there keeps its state; a mark recorded in Skyline (by the trainer) after the last import is kept.
--     Field names are read with fallbacks; the raw rows are kept on the import record.
begin;

alter table public.axcelerate_links drop constraint if exists axcelerate_links_entity_check;
alter table public.axcelerate_links add constraint axcelerate_links_entity_check
  check (entity in ('location', 'course', 'unit', 'trainer', 'class', 'class_unit', 'break', 'student', 'agent', 'agency', 'qualification',
                    'master', 'unit_result', 'batch', 'invoice', 'course_fee', 'attendance'));

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Fees added in Skyline
create sequence if not exists public.student_invoice_number_seq;

/** A Skyline invoice's total, paid and balance from its items and payments (aXcelerate invoices keep aXcelerate's figures). */
create or replace function public.student_invoice_recalc(p_invoice uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_total bigint; v_paid bigint;
begin
  if not exists (select 1 from public.student_invoices where id = p_invoice and source = 'manual') then return; end if;
  select coalesce(sum(total_cents), 0) into v_total from public.student_invoice_items where invoice_id = p_invoice;
  select coalesce(sum(greatest(coalesce(amount_paid_cents, amount_cents) - coalesce(amount_refunded_cents, 0), 0)), 0) into v_paid
    from public.payments where invoice_id = p_invoice and status in ('paid', 'refunded');
  update public.student_invoices set total_cents = v_total, paid_cents = v_paid,
         balance_cents = greatest(v_total - v_paid - credited_cents, 0), updated_at = now()
   where id = p_invoice;
end $$;

create or replace function public.payments_invoice_recalc() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.invoice_id is not null then perform public.student_invoice_recalc(old.invoice_id); end if;
  if tg_op in ('INSERT', 'UPDATE') and new.invoice_id is not null and (tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id
     or new.amount_paid_cents is distinct from old.amount_paid_cents or new.amount_refunded_cents is distinct from old.amount_refunded_cents
     or new.status is distinct from old.status) then
    perform public.student_invoice_recalc(new.invoice_id);
  end if;
  return null;
end $$;
drop trigger if exists payments_invoice_recalc on public.payments;
create trigger payments_invoice_recalc after insert or update or delete on public.payments for each row execute function public.payments_invoice_recalc();

/**
 * Create or edit a Skyline invoice (admins). p_data: {id?, studentId, courseId?, number?, date, dueDate?, description?, void?,
 * items: [{description, feeType, quantity, unitCents}]}. Returns the invoice id.
 */
create or replace function public.finance_invoice_save(p_data jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_id uuid := nullif(d->>'id', '')::uuid; v public.student_invoices; s public.enrollment_students;
  v_course text := nullif(d->>'courseId', ''); v_date date; v_due date; v_number text := nullif(btrim(coalesce(d->>'number', '')), ''); x jsonb; n int := 0;
  v_qty numeric; v_unit bigint; v_enrol uuid;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Admins only' using errcode = '42501'; end if;
  if v_id is not null then
    select * into v from public.student_invoices where id = v_id for update;
    if v.id is null then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
    if v.source <> 'manual' then raise exception 'This invoice comes from aXcelerate: change it in aXcelerate; the next import brings the change.' using errcode = '42501'; end if;
  end if;
  -- Void only.
  if v_id is not null and d ? 'void' and not (d ? 'items') then
    update public.student_invoices set is_void = coalesce((d->>'void')::boolean, false), updated_at = now() where id = v_id;
    return v_id;
  end if;
  select * into s from public.enrollment_students where id = coalesce(nullif(d->>'studentId', '')::uuid, v.student_id);
  if s.id is null then raise exception 'Choose the student.' using errcode = '22023'; end if;
  begin v_date := coalesce(nullif(d->>'date', '')::date, public.course_intake_today()); exception when others then raise exception 'Enter the invoice date.' using errcode = '22023'; end;
  begin v_due := nullif(d->>'dueDate', '')::date; exception when others then raise exception 'Enter the due date as a date.' using errcode = '22023'; end;
  if v_due is not null and v_due < v_date then raise exception 'The due date cannot be before the invoice date.' using errcode = '22023'; end if;
  if v_course is not null and not exists (select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found.' using errcode = '22023'; end if;
  if jsonb_typeof(d->'items') <> 'array' or jsonb_array_length(d->'items') = 0 then raise exception 'Add at least one item.' using errcode = '22023'; end if;
  if v_number is not null and char_length(v_number) > 60 then raise exception 'The invoice number is too long.' using errcode = '22023'; end if;
  if v_number is not null and exists (select 1 from public.student_invoices where invoice_number = v_number and id is distinct from v_id) then
    raise exception 'Invoice number % is already used.', v_number using errcode = '23505';
  end if;
  select e.id into v_enrol from public.intake_enrolments e join public.course_intakes i on i.id = e.intake_id
   where e.student_id = s.id and (v_course is null or i.course_id = v_course) order by e.enrolled_on desc nulls last limit 1;
  if v_id is null then
    v_number := coalesce(v_number, 'INV-' || to_char(v_date, 'YYYY') || '-' || lpad(nextval('public.student_invoice_number_seq')::text, 5, '0'));
    insert into public.student_invoices(tenant_id, student_id, intake_enrolment_id, course_id, invoice_number, invoice_date, due_date, description, source)
    values (s.tenant_id, s.id, v_enrol, v_course, v_number, v_date, v_due, left(nullif(btrim(coalesce(d->>'description', '')), ''), 300), 'manual')
    returning id into v_id;
  else
    update public.student_invoices set student_id = s.id, intake_enrolment_id = v_enrol, course_id = v_course, invoice_number = coalesce(v_number, invoice_number),
           invoice_date = v_date, due_date = v_due, description = left(nullif(btrim(coalesce(d->>'description', '')), ''), 300), updated_at = now()
     where id = v_id;
  end if;
  delete from public.student_invoice_items where invoice_id = v_id;
  for x in select value from jsonb_array_elements(d->'items') loop
    n := n + 1;
    if btrim(coalesce(x->>'description', '')) = '' then raise exception 'Item % has no description.', n using errcode = '22023'; end if;
    v_qty := coalesce(nullif(x->>'quantity', '')::numeric, 1);
    v_unit := round(coalesce(nullif(x->>'unitCents', '')::numeric, 0));
    if v_qty <= 0 or v_unit < 0 then raise exception 'Item % needs a quantity above 0 and an amount of 0 or more.', n using errcode = '22023'; end if;
    insert into public.student_invoice_items(invoice_id, description, fee_type, quantity, unit_cents, total_cents, sort)
    values (v_id, left(btrim(x->>'description'), 300),
            case when x->>'feeType' in ('tuition', 'enrolment', 'materials', 'oshc', 'other') then x->>'feeType' else 'other' end,
            v_qty, v_unit, round(v_qty * v_unit), n);
  end loop;
  perform public.student_invoice_recalc(v_id);
  return v_id;
end $$;

/** Record a payment against a Skyline invoice (admins): a manual payment linked to it. p_data: {amountCents, paidAt, method?, reference?}. */
create or replace function public.finance_invoice_payment(p_invoice uuid, p_data jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v public.student_invoices; d jsonb := coalesce(p_data, '{}'::jsonb); v_amount bigint; v_paid timestamptz; v_fee text; v_id uuid; s public.enrollment_students;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Admins only' using errcode = '42501'; end if;
  select * into v from public.student_invoices where id = p_invoice;
  if v.id is null then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  if v.source <> 'manual' then raise exception 'This invoice comes from aXcelerate: record the payment in aXcelerate; the next import brings it.' using errcode = '42501'; end if;
  if v.is_void then raise exception 'This invoice is void.' using errcode = '22023'; end if;
  v_amount := round(coalesce(nullif(d->>'amountCents', '')::numeric, 0));
  if v_amount < 50 then raise exception 'Enter the amount paid (at least $0.50).' using errcode = '22023'; end if;
  if v_amount > v.balance_cents then raise exception 'The payment is more than the balance (%).', to_char(v.balance_cents / 100.0, 'FM999999990.00') using errcode = '22023'; end if;
  begin v_paid := nullif(d->>'paidAt', '')::timestamptz; exception when others then v_paid := null; end;
  if v_paid is null then raise exception 'Enter the date it was paid.' using errcode = '22023'; end if;
  select * into s from public.enrollment_students where id = v.student_id;
  select fee_type into v_fee from public.student_invoice_items where invoice_id = v.id order by total_cents desc, sort limit 1;
  insert into public.payments(subject_type, subject_id, description, amount_cents, currency, timing, status, amount_paid_cents, paid_at, fee_type, student_id,
    course_id, intake_enrolment_id, source, external_reference, created_by, tenant_id, payer_email, invoice_id)
  values ('other', gen_random_uuid(), left(format('Payment for invoice %s%s', coalesce(v.invoice_number, ''), coalesce(' (' || nullif(btrim(d->>'method'), '') || ')', '')), 250),
    v_amount::integer, 'aud', 'independent', 'paid', v_amount::integer, v_paid, v_fee, v.student_id, v.course_id, v.intake_enrolment_id, 'manual',
    left(nullif(btrim(coalesce(d->>'reference', '')), ''), 200), auth.uid(), v.tenant_id, s.email, v.id)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Attendance from aXcelerate
/** aXcelerate's attendance value -> Skyline's mark (null when it says nothing). */
create or replace function public.axcelerate_attendance_status(p_value text) returns text
language sql immutable set search_path = public as $$
  select case
    when p_value is null or btrim(p_value) = '' then null
    when lower(p_value) ~ '(late|partial)' then 'late'
    when lower(p_value) ~ '(excus|apolog|leave|medical)' then 'excused'
    when lower(p_value) ~ '^(absent|a|false|0|no|n|did not attend|not attended)$' or lower(p_value) ~ 'absent' then 'absent'
    when lower(p_value) ~ '^(present|p|true|1|yes|y|attended|attend)$' or lower(p_value) ~ '(present|attended)' then 'present'
    when p_value ~ '^[0-9]+(\.[0-9]+)?$' and p_value::numeric >= 1 then 'present'
    else null end;
$$;

/**
 * aXcelerate's attendance of one unit (its workshop's sessions) for the student of a Qualification -> the class's registers and marks.
 * p_rows: the student's attendance rows (each with a date and an attendance value). Returns {sessions, marked, kept, skipped, warnings}.
 */
create or replace function public.axcelerate_import_attendance(p_connection uuid, p_run uuid, p_actor uuid, p_enrolment uuid, p_unit_code text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.intake_enrolments; i public.course_intakes; v_unit text; v_iu uuid; v_batch uuid; x jsonb; v_date date; v_status text; v_reg uuid;
  v_key text; l public.axcelerate_links; v_old text; n_sessions int := 0; n_marked int := 0; n_kept int := 0; n_skipped int := 0; v_warn jsonb := '[]'::jsonb;
begin
  perform public.axcelerate_importing(p_actor);
  select * into e from public.intake_enrolments where id = p_enrolment;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  select * into i from public.course_intakes where id = e.intake_id;
  select id into v_unit from public.cms_course_units where course_id = i.course_id and upper(code) = upper(btrim(coalesce(p_unit_code, ''))) limit 1;
  select id into v_iu from public.intake_units where intake_id = i.id and unit_id = v_unit limit 1;
  if v_iu is null then
    return jsonb_build_object('sessions', 0, 'marked', 0, 'kept', 0, 'skipped', jsonb_array_length(coalesce(p_rows, '[]'::jsonb)),
      'warnings', jsonb_build_array(format('%s is not a unit of the class in Skyline: its attendance was not imported.', p_unit_code)));
  end if;
  select batch_id into v_batch from public.lms_unit_students where intake_id = i.id and unit_id = v_unit and student_id = e.student_id;
  v_batch := coalesce(v_batch, public.intake_default_batch(i.id));
  for x in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_date := public.axcelerate_date(public.axcelerate_text(x, 'DATE', 'SESSIONDATE', 'CLASSDATE', 'STARTDATE', 'ATTENDANCEDATE', 'COMPLEXDATE'));
    v_status := public.axcelerate_attendance_status(public.axcelerate_text(x, 'ATTENDANCE', 'ATTENDED', 'STATUS', 'PRESENT', 'ATTENDANCESTATUS', 'ATTENDEDSTATUS', 'HOURSATTENDED'));
    if v_date is null or v_status is null then n_skipped := n_skipped + 1; continue; end if;
    n_sessions := n_sessions + 1;
    insert into public.lms_attendance_register(batch_id, intake_id, intake_unit_id, class_date, state, updated_by)
    values (v_batch, i.id, v_iu, v_date, 'final', p_actor)
    on conflict (batch_id, intake_unit_id, class_date) do nothing;
    select id into v_reg from public.lms_attendance_register where batch_id = v_batch and intake_unit_id = v_iu and class_date = v_date;
    v_key := e.id::text || ':' || v_iu::text || ':' || v_date::text;
    l := public.axcelerate_link_find(p_connection, 'attendance', v_key);
    select status into v_old from public.lms_attendance_marks where register_id = v_reg and enrolment_id = e.id;
    -- A mark made in Skyline (no import link, or a different mark than the import left) is kept.
    if v_old is not null and v_old <> v_status and (l.id is null or coalesce(l.raw->>'status', '') <> v_old) then
      n_kept := n_kept + 1; continue;
    end if;
    insert into public.lms_attendance_marks(register_id, enrolment_id, status) values (v_reg, e.id, v_status)
    on conflict (register_id, enrolment_id) do update set status = excluded.status;
    perform public.axcelerate_link_save(p_connection, p_run, 'attendance', v_key, 'public.lms_attendance_marks', v_reg::text,
      jsonb_build_object('status', v_status, 'unit', p_unit_code, 'date', v_date, 'raw', x));
    n_marked := n_marked + 1;
  end loop;
  if n_skipped > 0 then v_warn := v_warn || to_jsonb(format('%s: %s attendance row(s) without a date or a recognisable attendance value were not imported.', p_unit_code, n_skipped)); end if;
  return jsonb_build_object('sessions', n_sessions, 'marked', n_marked, 'kept', n_kept, 'skipped', n_skipped, 'warnings', v_warn);
end $$;

revoke all on function public.student_invoice_recalc(uuid) from public, anon, authenticated;
revoke all on function public.finance_invoice_save(jsonb) from public, anon;
revoke all on function public.finance_invoice_payment(uuid, jsonb) from public, anon;
revoke all on function public.axcelerate_import_attendance(uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.finance_invoice_save(jsonb), public.finance_invoice_payment(uuid, jsonb) to authenticated;
grant execute on function public.axcelerate_import_attendance(uuid, uuid, uuid, uuid, text, jsonb) to service_role;

commit;
