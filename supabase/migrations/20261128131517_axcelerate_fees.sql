-- AXCELERATE-FEES (owner 2026-11-28: "bring payments also from aXcelerate and insert a fees module in SLIT which matches aXcelerate and
-- can bring all data"; decisions: invoices + payments; course and class fees from aXcelerate's costs only where Skyline has none).
-- One way only, aXcelerate -> Skyline (axcelerate-import reads /accounting/invoice for the contact and /accounting/invoice/:id; read only).
--   * student_invoices / student_invoice_items: a student's invoices (number, date, due date, items, total, paid, credited, balance, status)
--     with the payments linked to them (payments.invoice_id). Source axcelerate (read only in Skyline: the import keeps them equal to
--     aXcelerate) or manual (for later use). Admins read them (as payments).
--   * payments.source gains 'axcelerate': each aXcelerate payment of an invoice is a paid payment (Finance > Payments), keyed by its
--     aXcelerate payment id (external_reference "aXcelerate payment <id>"); an invoice paid in aXcelerate without payment lines gets one
--     payment of the amount paid ("aXcelerate invoice <id> paid"), replaced by the real lines when aXcelerate sends them.
--   * axcelerate_import_invoice: one aXcelerate invoice (list row merged with its detail) -> invoice, items, payments. Field names read
--     with fallbacks (aXcelerate's invoice fields are confirmed on the first real import; the raw answer is kept on the import record).
--   * axcelerate_course_fees: the course's fee (aXcelerate course COST) and the class's fee (class COST) as tuition fee items, only where
--     Skyline has no fee items for that course / class (fees an admin entered are never changed).
--   * student_invoices_list / finance_invoices_list: the student's Fees tab and Finance > Invoices (admins).
begin;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Tables
create table if not exists public.student_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  student_id uuid not null references public.enrollment_students(id) on delete restrict,
  intake_enrolment_id uuid references public.intake_enrolments(id) on delete set null,
  course_id text references public.cms_courses(id) on delete set null,
  invoice_number text check (invoice_number is null or char_length(invoice_number) <= 60),
  invoice_date date,
  due_date date,
  currency text not null default 'aud' check (currency ~ '^[a-z]{3}$'),
  total_cents bigint not null default 0 check (total_cents >= 0 and total_cents <= 10000000000),
  paid_cents bigint not null default 0 check (paid_cents >= 0),
  credited_cents bigint not null default 0 check (credited_cents >= 0),
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  is_void boolean not null default false,
  description text check (description is null or char_length(description) <= 300),
  source text not null default 'manual' check (source in ('axcelerate', 'manual')),
  external_id text check (external_id is null or char_length(external_id) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists student_invoices_student_idx on public.student_invoices(student_id, invoice_date desc);
create table if not exists public.student_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.student_invoices(id) on delete cascade,
  description text not null check (char_length(description) between 1 and 300),
  fee_type text not null default 'other' check (fee_type in ('tuition', 'enrolment', 'materials', 'oshc', 'other')),
  quantity numeric(10,2) not null default 1,
  unit_cents bigint,
  total_cents bigint not null default 0,
  gst_cents bigint not null default 0,
  sort integer not null default 0
);
create index if not exists student_invoice_items_invoice_idx on public.student_invoice_items(invoice_id, sort);
alter table public.student_invoices enable row level security;
alter table public.student_invoice_items enable row level security;
revoke all on public.student_invoices, public.student_invoice_items from anon;
revoke insert, update, delete on public.student_invoices, public.student_invoice_items from authenticated;
drop policy if exists student_invoices_admin_read on public.student_invoices;
create policy student_invoices_admin_read on public.student_invoices for select to authenticated using (public.cms_is_admin());
drop policy if exists student_invoice_items_admin_read on public.student_invoice_items;
create policy student_invoice_items_admin_read on public.student_invoice_items for select to authenticated using (public.cms_is_admin());

alter table public.payments add column if not exists invoice_id uuid references public.student_invoices(id) on delete set null;
alter table public.payments drop constraint if exists payments_source_check;
alter table public.payments add constraint payments_source_check check (source = any (array['stripe', 'xero', 'manual', 'axcelerate']));

alter table public.axcelerate_links drop constraint if exists axcelerate_links_entity_check;
alter table public.axcelerate_links add constraint axcelerate_links_entity_check
  check (entity in ('location', 'course', 'unit', 'trainer', 'class', 'class_unit', 'break', 'student', 'agent', 'agency', 'qualification',
                    'master', 'unit_result', 'batch', 'invoice', 'course_fee'));

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Helpers
/** Dollars (aXcelerate's money fields: 10500, "10,500.00", "$1,234.5") -> cents; null when not a number. */
create or replace function public.axcelerate_cents(p_value text) returns bigint
language sql immutable set search_path = public as $$
  select case when regexp_replace(coalesce(p_value, ''), '[$,\s]', '', 'g') ~ '^-?[0-9]+(\.[0-9]+)?$'
              then round(regexp_replace(p_value, '[$,\s]', '', 'g')::numeric * 100)::bigint end;
$$;

/** The fee type of an invoice line from its description (and the course code: a line naming the course is tuition). */
create or replace function public.axcelerate_fee_type(p_description text, p_course_code text default null) returns text
language sql immutable set search_path = public as $$
  select case
    when p_description ~* '(oshc|overseas student health|health cover)' then 'oshc'
    when p_description ~* '(enrol|application fee|admin(istration)? fee|registration)' then 'enrolment'
    when p_description ~* '(material|resource|book|kit|uniform)' then 'materials'
    when p_description ~* '(tuition|course fee|unit fee)' or (nullif(p_course_code, '') is not null and position(upper(p_course_code) in upper(coalesce(p_description, ''))) > 0) then 'tuition'
    else 'other' end;
$$;

/** The first array among the keys given (aXcelerate names lists differently per endpoint). */
create or replace function public.axcelerate_array(p_rec jsonb, variadic p_keys text[]) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce((select p_rec->k from unnest(p_keys) k where jsonb_typeof(p_rec->k) = 'array' limit 1), '[]'::jsonb);
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. One aXcelerate invoice -> invoice, items, payments
create or replace function public.axcelerate_import_invoice(p_connection uuid, p_run uuid, p_actor uuid, p_student uuid, p_rec jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb := coalesce(p_rec, '{}'::jsonb);
  v_ax text := public.axcelerate_text(r, 'INVOICEID', 'INVOICE_ID', 'ID');
  v_number text := left(public.axcelerate_text(r, 'INVOICENR', 'INVOICENUMBER', 'INVOICENO', 'INVOICE_NUMBER', 'REFERENCE'), 60);
  v_date date := public.axcelerate_date(public.axcelerate_text(r, 'INVOICEDATE', 'DATE', 'CREATEDDATE', 'DATECREATED'));
  v_due date := public.axcelerate_date(public.axcelerate_text(r, 'DUEDATE', 'DATEDUE', 'DUE_DATE'));
  v_total bigint := public.axcelerate_cents(public.axcelerate_text(r, 'PRICEGROSS', 'TOTALGROSS', 'GROSS', 'TOTAL', 'TOTALAMOUNT', 'AMOUNT'));
  v_paid bigint := public.axcelerate_cents(public.axcelerate_text(r, 'AMOUNTPAID', 'PAID', 'PAIDAMOUNT', 'TOTALPAID'));
  v_balance bigint := public.axcelerate_cents(public.axcelerate_text(r, 'BALANCE', 'OWING', 'AMOUNTOWING', 'BALANCEDUE', 'OUTSTANDING'));
  v_credit bigint := coalesce(public.axcelerate_cents(public.axcelerate_text(r, 'CREDITED', 'CREDITAMOUNT', 'TOTALCREDITED')), 0);
  v_void boolean := lower(coalesce(public.axcelerate_text(r, 'ISVOID', 'VOID', 'VOIDED'), '')) in ('true', '1', 'yes')
                    or lower(coalesce(public.axcelerate_text(r, 'STATUS'), '')) like '%void%';
  s public.enrollment_students; v_enrol uuid; v_course text; v_code text; v_id uuid; l public.axcelerate_links; x jsonb; n int := 0;
  v_items jsonb; v_pays jsonb; v_pay_total bigint := 0; v_main text; v_pid text; v_amt bigint; v_when timestamptz; v_pay_n int := 0; v_warn jsonb := '[]'::jsonb;
  v_action text;
begin
  if v_ax is null then raise exception 'The invoice has no aXcelerate ID' using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'invoice', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  select * into s from public.enrollment_students where id = p_student;
  if s.id is null then raise exception 'Student not found' using errcode = 'P0002'; end if;
  -- The student's Qualification the invoice belongs to: the one whose course code the invoice names, else the latest.
  select e.id, i.course_id, c.code into v_enrol, v_course, v_code
    from public.intake_enrolments e join public.course_intakes i on i.id = e.intake_id join public.cms_courses c on c.id = i.course_id
   where e.student_id = s.id
   order by (position(upper(c.code) in upper(r::text)) > 0) desc, e.enrolled_on desc nulls last limit 1;
  v_items := public.axcelerate_array(r, 'ITEMS', 'INVOICEITEMS', 'LINES', 'LINEITEMS');
  v_pays := public.axcelerate_array(r, 'PAYMENTS', 'TRANSACTIONS', 'RECEIPTS', 'PAYMENTHISTORY');
  if v_total is null then
    select sum(coalesce(public.axcelerate_cents(public.axcelerate_text(li.value, 'TOTALGROSS', 'PRICEGROSS', 'TOTAL', 'LINETOTAL', 'AMOUNT')), 0)) into v_total
      from jsonb_array_elements(v_items) li;
  end if;
  v_total := greatest(coalesce(v_total, 0), 0);
  select coalesce(sum(coalesce(public.axcelerate_cents(public.axcelerate_text(pl.value, 'AMOUNT', 'AMOUNTPAID', 'PAYMENTAMOUNT', 'TOTAL')), 0)), 0) into v_pay_total
    from jsonb_array_elements(v_pays) pl;
  if v_paid is null then v_paid := case when v_balance is not null then greatest(v_total - v_balance - v_credit, 0) else v_pay_total end; end if;
  if v_balance is null then v_balance := greatest(v_total - v_paid - v_credit, 0); end if;
  v_paid := greatest(v_paid, 0); v_balance := greatest(v_balance, 0);

  l := public.axcelerate_link_find(p_connection, 'invoice', v_ax);
  if l.id is not null and exists (select 1 from public.student_invoices where id = l.target_id::uuid) then v_id := l.target_id::uuid; end if;
  if v_id is null then select id into v_id from public.student_invoices where source = 'axcelerate' and external_id = v_ax; end if;
  v_action := case when v_id is null then 'created' else 'updated' end;
  if v_id is null then
    insert into public.student_invoices(tenant_id, student_id, intake_enrolment_id, course_id, invoice_number, invoice_date, due_date, total_cents, paid_cents,
      credited_cents, balance_cents, is_void, description, source, external_id)
    values (s.tenant_id, s.id, v_enrol, v_course, v_number, v_date, v_due, v_total, v_paid, v_credit, v_balance, v_void,
      left(public.axcelerate_text(r, 'DESCRIPTION', 'SUMMARY', 'NAME'), 300), 'axcelerate', v_ax)
    returning id into v_id;
  else
    if exists (select 1 from public.student_invoices where id = v_id and invoice_number is not distinct from v_number and invoice_date is not distinct from v_date
                 and due_date is not distinct from v_due and total_cents = v_total and paid_cents = v_paid and credited_cents = v_credit and balance_cents = v_balance
                 and is_void = v_void) then v_action := 'unchanged'; end if;
    update public.student_invoices set student_id = s.id, intake_enrolment_id = coalesce(v_enrol, intake_enrolment_id), course_id = coalesce(v_course, course_id),
           invoice_number = v_number, invoice_date = v_date, due_date = v_due, total_cents = v_total, paid_cents = v_paid, credited_cents = v_credit,
           balance_cents = v_balance, is_void = v_void, updated_at = now()
     where id = v_id;
  end if;
  -- Items: as aXcelerate has them (the invoice is aXcelerate's).
  delete from public.student_invoice_items where invoice_id = v_id;
  for x in select * from jsonb_array_elements(v_items) loop
    n := n + 1;
    insert into public.student_invoice_items(invoice_id, description, fee_type, quantity, unit_cents, total_cents, gst_cents, sort)
    values (v_id, left(coalesce(public.axcelerate_text(x, 'DESCRIPTION', 'ITEMNAME', 'NAME', 'ITEM'), 'Item'), 300),
            public.axcelerate_fee_type(public.axcelerate_text(x, 'DESCRIPTION', 'ITEMNAME', 'NAME', 'ITEM'), v_code),
            coalesce(nullif(regexp_replace(coalesce(public.axcelerate_text(x, 'QTY', 'QUANTITY'), ''), '[^0-9.]', '', 'g'), '')::numeric, 1),
            public.axcelerate_cents(public.axcelerate_text(x, 'UNITPRICEGROSS', 'UNITPRICE', 'PRICE', 'UNITAMOUNT')),
            coalesce(public.axcelerate_cents(public.axcelerate_text(x, 'TOTALGROSS', 'PRICEGROSS', 'TOTAL', 'LINETOTAL', 'AMOUNT')), 0),
            coalesce(public.axcelerate_cents(public.axcelerate_text(x, 'GST', 'TAX', 'TAXAMOUNT')), 0), n);
  end loop;
  -- The invoice's main fee type (its largest line), for its payments.
  select fee_type into v_main from public.student_invoice_items where invoice_id = v_id order by total_cents desc, sort limit 1;
  v_main := coalesce(v_main, public.axcelerate_fee_type(coalesce(public.axcelerate_text(r, 'DESCRIPTION'), '') || ' ' || coalesce(v_code, ''), v_code));

  -- Payments: each aXcelerate payment line; else one payment of the amount paid.
  if jsonb_array_length(v_pays) > 0 then
    delete from public.payments where source = 'axcelerate' and invoice_id = v_id and external_reference = 'aXcelerate invoice ' || v_ax || ' paid';
    for x in select * from jsonb_array_elements(v_pays) loop
      v_pid := public.axcelerate_text(x, 'PAYMENTID', 'TRANSACTIONID', 'RECEIPTID', 'ID');
      v_amt := public.axcelerate_cents(public.axcelerate_text(x, 'AMOUNT', 'AMOUNTPAID', 'PAYMENTAMOUNT', 'TOTAL'));
      v_when := coalesce(public.axcelerate_date(public.axcelerate_text(x, 'PAYMENTDATE', 'TRANSACTIONDATE', 'DATEPAID', 'DATE')), v_date, current_date)::timestamptz;
      if v_pid is null or coalesce(v_amt, 0) < 50 then
        v_warn := v_warn || to_jsonb(format('A payment line of invoice %s has no ID or an amount under $0.50: not imported.', coalesce(v_number, v_ax)));
        continue;
      end if;
      perform public.axcelerate_invoice_payment(s, v_id, v_enrol, v_course, v_main, 'aXcelerate payment ' || v_pid, v_amt, v_when,
        left(format('aXcelerate payment for invoice %s%s', coalesce(v_number, v_ax),
          coalesce(' (' || nullif(public.axcelerate_text(x, 'PAYMENTMETHOD', 'METHOD', 'PAYMENTTYPE', 'TYPE'), '') || ')', '')), 250), p_actor);
      v_pay_n := v_pay_n + 1;
    end loop;
  elsif v_paid >= 50 then
    perform public.axcelerate_invoice_payment(s, v_id, v_enrol, v_course, v_main, 'aXcelerate invoice ' || v_ax || ' paid', v_paid::bigint,
      coalesce(public.axcelerate_date(public.axcelerate_text(r, 'LASTPAYMENTDATE', 'DATEPAID', 'PAIDDATE')), v_date, current_date)::timestamptz,
      left(format('Paid in aXcelerate for invoice %s (no payment details from aXcelerate)', coalesce(v_number, v_ax)), 250), p_actor);
    v_pay_n := 1;
  end if;
  if v_paid > v_total and v_total > 0 then v_warn := v_warn || to_jsonb(format('Invoice %s: aXcelerate shows more paid than its total.', coalesce(v_number, v_ax))); end if;

  perform public.axcelerate_link_save(p_connection, p_run, 'invoice', v_ax, 'public.student_invoices', v_id::text, r);
  return public.axcelerate_outcome(v_action, v_id::text, jsonb_build_object('number', v_number, 'totalCents', v_total, 'paidCents', v_paid,
    'balanceCents', v_balance, 'void', v_void, 'items', n, 'payments', v_pay_n, 'warnings', v_warn));
end $$;

/** One payment of an invoice (upserted by its reference). */
create or replace function public.axcelerate_invoice_payment(s public.enrollment_students, p_invoice uuid, p_enrol uuid, p_course text, p_fee text,
  p_ref text, p_amount bigint, p_when timestamptz, p_description text, p_actor uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.payments where source = 'axcelerate' and external_reference = p_ref;
  if v_id is null then
    insert into public.payments(subject_type, subject_id, description, amount_cents, currency, timing, status, amount_paid_cents, paid_at, fee_type, student_id,
      course_id, intake_enrolment_id, source, external_reference, created_by, tenant_id, payer_email, invoice_id)
    values ('other', gen_random_uuid(), p_description, least(p_amount, 99999999)::integer, 'aud', 'independent', 'paid', least(p_amount, 99999999)::integer, p_when, p_fee, s.id,
      p_course, p_enrol, 'axcelerate', p_ref, p_actor, s.tenant_id, s.email, p_invoice)
    returning id into v_id;
  else
    update public.payments set description = p_description, amount_cents = least(p_amount, 99999999)::integer, amount_paid_cents = least(p_amount, 99999999)::integer,
           paid_at = p_when, fee_type = coalesce(fee_type, p_fee), student_id = s.id, course_id = coalesce(p_course, course_id),
           intake_enrolment_id = coalesce(p_enrol, intake_enrolment_id), invoice_id = p_invoice, status = 'paid', updated_at = now()
     where id = v_id;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. Course and class fees from aXcelerate's costs (only where Skyline has none)
create or replace function public.axcelerate_course_fees(p_connection uuid, p_run uuid, p_actor uuid, p_course text, p_intake uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_course_cost bigint; v_class_cost bigint; v_done text[] := '{}';
begin
  perform public.axcelerate_importing(p_actor);
  select public.axcelerate_cents(raw->>'COST') into v_course_cost from public.axcelerate_links
   where connection_id = p_connection and entity = 'course' and target_id = p_course order by last_imported_at desc limit 1;
  if p_intake is not null then
    select public.axcelerate_cents(raw->>'COST') into v_class_cost from public.axcelerate_links
     where connection_id = p_connection and entity = 'class' and target_id = p_intake::text order by last_imported_at desc limit 1;
  end if;
  if coalesce(v_course_cost, 0) > 0 and not exists (select 1 from public.course_fee_items where course_id = p_course and intake_id is null)
     and not exists (select 1 from public.course_fee_setups where course_id = p_course and intake_id is null and coalesce(tuition_fee, 0) > 0) then
    insert into public.course_fee_items(course_id, intake_id, item_type, label, amount_cents, sort, included_in_total, refundable, gst_treatment, updated_by)
    values (p_course, null, 'tuition', 'Tuition fee (aXcelerate course cost)', v_course_cost, 1, true, false, 'gst_free', p_actor);
    v_done := array_append(v_done, 'course');
  end if;
  if p_intake is not null and coalesce(v_class_cost, 0) > 0 and not exists (select 1 from public.course_fee_items where course_id = p_course and intake_id = p_intake)
     and not exists (select 1 from public.course_fee_setups where course_id = p_course and intake_id = p_intake and coalesce(tuition_fee, 0) > 0) then
    insert into public.course_fee_items(course_id, intake_id, item_type, label, amount_cents, sort, included_in_total, refundable, gst_treatment, updated_by)
    values (p_course, p_intake, 'tuition', 'Tuition fee (aXcelerate class cost)', v_class_cost, 1, true, false, 'gst_free', p_actor);
    v_done := array_append(v_done, 'class');
  end if;
  if cardinality(v_done) > 0 then
    perform public.axcelerate_link_save(p_connection, p_run, 'course_fee', p_course || ':' || coalesce(p_intake::text, '-'), 'public.course_fee_items',
      p_course, jsonb_build_object('courseCost', v_course_cost, 'classCost', v_class_cost, 'set', to_jsonb(v_done)));
  end if;
  return array_to_string(v_done, ',');
exception when others then
  return 'fees not set: ' || sqlerrm;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Lists for the pages (admins)
/** An invoice as the pages show it, with its status (Void / Paid / Part paid / Overdue / Unpaid), items and payments. */
create or replace function public.student_invoice_json(p_invoice uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', v.id, 'studentId', v.student_id, 'studentName', s.full_name, 'studentNumber', s.student_number,
    'courseId', v.course_id, 'courseCode', c.code, 'courseTitle', c.name, 'number', v.invoice_number, 'date', v.invoice_date, 'dueDate', v.due_date,
    'totalCents', v.total_cents, 'paidCents', v.paid_cents, 'creditedCents', v.credited_cents, 'balanceCents', v.balance_cents, 'source', v.source,
    'description', v.description,
    'status', case when v.is_void then 'void' when v.balance_cents = 0 and v.total_cents > 0 then 'paid'
                   when v.due_date is not null and v.due_date < public.course_intake_today() then 'overdue'
                   when v.paid_cents > 0 then 'part_paid' else 'unpaid' end,
    'items', coalesce((select jsonb_agg(jsonb_build_object('description', i.description, 'feeType', i.fee_type, 'quantity', i.quantity,
               'unitCents', i.unit_cents, 'totalCents', i.total_cents, 'gstCents', i.gst_cents) order by i.sort) from public.student_invoice_items i where i.invoice_id = v.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'paidAt', p.paid_at, 'amountCents', coalesce(p.amount_paid_cents, p.amount_cents),
               'refundedCents', p.amount_refunded_cents, 'description', p.description, 'reference', p.external_reference, 'source', p.source) order by p.paid_at)
               from public.payments p where p.invoice_id = v.id), '[]'::jsonb))
  from public.student_invoices v join public.enrollment_students s on s.id = v.student_id left join public.cms_courses c on c.id = v.course_id
  where v.id = p_invoice;
$$;

create or replace function public.student_invoices_list(p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Admins only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'invoices', coalesce((select jsonb_agg(public.student_invoice_json(v.id) order by v.invoice_date desc nulls last, v.invoice_number desc)
                 from public.student_invoices v where v.student_id = p_student), '[]'::jsonb),
    'totals', (select jsonb_build_object('totalCents', coalesce(sum(total_cents) filter (where not is_void), 0), 'paidCents', coalesce(sum(paid_cents) filter (where not is_void), 0),
                 'balanceCents', coalesce(sum(balance_cents) filter (where not is_void), 0),
                 'overdueCents', coalesce(sum(balance_cents) filter (where not is_void and due_date < public.course_intake_today()), 0))
               from public.student_invoices where student_id = p_student));
end $$;

/** Finance > Invoices: filters {q, status, courseId, from, to, page, pageSize}. */
create or replace function public.finance_invoices_list(p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f jsonb := coalesce(p_filters, '{}'::jsonb); v_q text := lower(nullif(btrim(f->>'q'), '')); v_status text := nullif(f->>'status', '');
  v_course text := nullif(f->>'courseId', ''); v_from date; v_to date; v_page int := greatest(coalesce(nullif(f->>'page', '')::int, 1), 1);
  v_size int := least(greatest(coalesce(nullif(f->>'pageSize', '')::int, 25), 1), 200); v_rows jsonb; v_total int; v_sum jsonb;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Admins only' using errcode = '42501'; end if;
  begin v_from := nullif(f->>'from', '')::date; exception when others then v_from := null; end;
  begin v_to := nullif(f->>'to', '')::date; exception when others then v_to := null; end;
  create temp table if not exists finance_invoice_rows (id uuid, d date, status text, j jsonb) on commit drop;
  truncate finance_invoice_rows;
  insert into finance_invoice_rows
  select v.id, v.invoice_date, j->>'status', j from public.student_invoices v
    join public.enrollment_students s on s.id = v.student_id
    cross join lateral public.student_invoice_json(v.id) j
   where (v_q is null or lower(concat_ws(' ', v.invoice_number, s.full_name, s.email, s.student_number, j->>'courseCode')) like '%' || v_q || '%')
     and (v_course is null or v.course_id = v_course)
     and (v_from is null or v.invoice_date >= v_from) and (v_to is null or v.invoice_date < v_to);
  select count(*) into v_total from finance_invoice_rows where v_status is null or status = v_status;
  select jsonb_build_object('totalCents', coalesce(sum((j->>'totalCents')::bigint) filter (where status <> 'void'), 0),
      'paidCents', coalesce(sum((j->>'paidCents')::bigint) filter (where status <> 'void'), 0),
      'balanceCents', coalesce(sum((j->>'balanceCents')::bigint) filter (where status <> 'void'), 0),
      'overdue', count(*) filter (where status = 'overdue'), 'invoices', count(*) filter (where status <> 'void'))
    into v_sum from finance_invoice_rows;
  select coalesce(jsonb_agg(j order by d desc nulls last), '[]'::jsonb) into v_rows from (
    select j, d from finance_invoice_rows where v_status is null or status = v_status order by d desc nulls last limit v_size offset (v_page - 1) * v_size) x;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'page', v_page, 'pageSize', v_size, 'summary', v_sum);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Finance menu: Invoices (next to Payments)
insert into public.admin_menu_items(id, label, route, icon_key, is_system, parent_id, is_enabled, sort_order, permission_key, open_in_new_tab, permission_scope)
values ('finance_invoices', 'Invoices', '/admin/finance/invoices', 'payments', true, 'finance', true, 20, 'cms.read', false, 'current')
on conflict (id) do nothing;

revoke all on function public.axcelerate_import_invoice(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.axcelerate_invoice_payment(public.enrollment_students, uuid, uuid, text, text, text, bigint, timestamptz, text, uuid) from public, anon, authenticated;
revoke all on function public.axcelerate_course_fees(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.student_invoice_json(uuid) from public, anon, authenticated;
revoke all on function public.student_invoices_list(uuid) from public, anon;
revoke all on function public.finance_invoices_list(jsonb) from public, anon;
grant execute on function public.axcelerate_import_invoice(uuid, uuid, uuid, uuid, jsonb), public.axcelerate_course_fees(uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function public.student_invoices_list(uuid), public.finance_invoices_list(jsonb) to authenticated;

commit;
