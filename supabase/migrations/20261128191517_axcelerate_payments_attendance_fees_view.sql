-- AXCELERATE-PAYMENTS-ATTENDANCE + FEES-BY-STUDENT (owner 2026-11-28: "I don't see attendance of Himani; also create a proper invoice
-- view so it's easy to look at students' invoice status").
--   * axcelerate_import_invoice: aXcelerate's payment lines are {GUID, FRAGMENT_AMOUNT (dollars), TRANSACTIONDATE, TRANSACTIONPROVIDER}
--     (seen on Himani's 8 invoices): they are read as the payment's ID, amount, date and method (they were skipped as "no ID").
--   * axcelerate_import_attendance: a row's class date also comes from its aXcelerate class day (COMPLEXID -> the class imported for it),
--     more attendance fields are read, and the first row of a unit that still cannot be read is kept in the import's error list (with
--     its fields) so its shape can be mapped.
--   * finance_student_fees_list: Finance > Invoices "By student": one line per student with invoices, total, paid, owing, overdue,
--     next due and last payment, and a status (Overdue / Owing / Paid / Credit); filters by status and search, paged. Admins.
begin;

-- 1. Payment lines.
do $$
declare d text := pg_get_functiondef('public.axcelerate_import_invoice(uuid, uuid, uuid, uuid, jsonb)'::regprocedure); a text;
begin
  a := 'public.axcelerate_text(x, ''PAYMENTID'', ''TRANSACTIONID'', ''RECEIPTID'', ''ID'')';
  if position(a in d) = 0 then raise exception 'axcelerate_import_invoice: id anchor not found'; end if;
  d := replace(d, a, 'public.axcelerate_text(x, ''PAYMENTID'', ''TRANSACTIONID'', ''RECEIPTID'', ''GUID'', ''ID'')');
  a := 'public.axcelerate_text(x, ''AMOUNT'', ''AMOUNTPAID'', ''PAYMENTAMOUNT'', ''TOTAL'')';
  if position(a in d) = 0 then raise exception 'axcelerate_import_invoice: amount anchor not found'; end if;
  d := replace(d, a, 'public.axcelerate_text(x, ''AMOUNT'', ''AMOUNTPAID'', ''PAYMENTAMOUNT'', ''FRAGMENT_AMOUNT'', ''TOTAL'')');
  a := 'public.axcelerate_text(x, ''PAYMENTMETHOD'', ''METHOD'', ''PAYMENTTYPE'', ''TYPE'')';
  if position(a in d) = 0 then raise exception 'axcelerate_import_invoice: method anchor not found'; end if;
  d := replace(d, a, 'public.axcelerate_text(x, ''PAYMENTMETHOD'', ''METHOD'', ''PAYMENTTYPE'', ''TRANSACTIONPROVIDER'', ''TYPE'')');
  execute d;
end $$;

-- 2. Attendance rows.
do $$
declare d text := pg_get_functiondef('public.axcelerate_import_attendance(uuid, uuid, uuid, uuid, text, jsonb)'::regprocedure); a text;
begin
  a := 'v_date := public.axcelerate_date(public.axcelerate_text(x, ''DATE'', ''SESSIONDATE'', ''CLASSDATE'', ''STARTDATE'', ''ATTENDANCEDATE'', ''COMPLEXDATE''));';
  if position(a in d) = 0 then raise exception 'axcelerate_import_attendance: date anchor not found'; end if;
  d := replace(d, a, 'v_date := coalesce(public.axcelerate_date(public.axcelerate_text(x, ''DATE'', ''SESSIONDATE'', ''CLASSDATE'', ''STARTDATE'', ''ATTENDANCEDATE'', ''COMPLEXDATE'', ''STARTDATETIME'')),
      (select s.session_date from public.axcelerate_links cl join public.class_sessions s on s.id::text = cl.target_id
        where cl.connection_id = p_connection and cl.entity = ''class_day'' and cl.axcelerate_id = public.axcelerate_text(x, ''COMPLEXID'', ''COMPLEXDATEID'') limit 1));');
  a := 'public.axcelerate_text(x, ''ATTENDANCE'', ''ATTENDED'', ''STATUS'', ''PRESENT'', ''ATTENDANCESTATUS'', ''ATTENDEDSTATUS'', ''HOURSATTENDED'')';
  if position(a in d) = 0 then raise exception 'axcelerate_import_attendance: status anchor not found'; end if;
  d := replace(d, a, 'public.axcelerate_text(x, ''ATTENDANCE'', ''ATTENDED'', ''STATUS'', ''PRESENT'', ''ATTENDANCESTATUS'', ''ATTENDEDSTATUS'', ''ISATTENDED'',
      ''ATTENDANCETYPE'', ''ATTENDEDFLAG'', ''PERCENTAGEATTENDED'', ''PERCENTATTENDED'', ''HOURSATTENDED'', ''MINUTESATTENDED'')');
  a := 'if v_date is null or v_status is null then n_skipped := n_skipped + 1; continue; end if;';
  if position(a in d) = 0 then raise exception 'axcelerate_import_attendance: skip anchor not found'; end if;
  d := replace(d, a, 'if v_date is null or v_status is null then
      -- The first row of the unit that cannot be read is kept (with its fields) so its shape can be mapped.
      if n_skipped = 0 then
        perform public.axcelerate_import_error(p_run, ''attendance'', p_unit_code, ''Attendance '' || coalesce(p_unit_code, ''''),
          format(''Attendance row not read (%s): fields %s'', case when v_date is null then ''no class date'' else ''no attendance value'' end,
            (select string_agg(k, '', '' order by k) from jsonb_object_keys(x) k)), x);
      end if;
      n_skipped := n_skipped + 1; continue;
    end if;');
  execute d;
end $$;

-- 3. Fees by student.
/**
 * Finance > Invoices "By student" (admins): one line per student who has invoices: invoices, total, paid, owing, overdue (owing past
 * its due date), next due date and amount, last payment, courses, and a status: overdue (something past due), owing (balance not yet
 * due), paid (nothing owing), credit (paid more than invoiced). Filters: q (name, email, student number, invoice number, course code),
 * status; paged by pageSize (25, at most 200). Summary over the filtered students.
 */
create or replace function public.finance_student_fees_list(p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f jsonb := coalesce(p_filters, '{}'::jsonb); v_q text := lower(nullif(btrim(f->>'q'), '')); v_status text := nullif(f->>'status', '');
  v_page int := greatest(coalesce(nullif(f->>'page', '')::int, 1), 1); v_size int := least(greatest(coalesce(nullif(f->>'pageSize', '')::int, 25), 1), 200);
  v_today date := public.course_intake_today(); v_rows jsonb; v_total int; v_sum jsonb;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Admins only' using errcode = '42501'; end if;
  create temp table if not exists finance_student_rows (student_id uuid, status text, balance bigint, overdue bigint, name text, j jsonb) on commit drop;
  truncate finance_student_rows;
  insert into finance_student_rows
  select s.id, st, x.balance, x.overdue, s.full_name, jsonb_build_object(
      'studentId', s.id, 'studentName', s.full_name, 'studentNumber', s.student_number, 'email', s.email,
      'courses', x.courses, 'invoices', x.n, 'totalCents', x.total, 'paidCents', x.paid, 'balanceCents', x.balance, 'overdueCents', x.overdue,
      'overdueInvoices', x.overdue_n, 'nextDueDate', x.next_due, 'nextDueCents', nd.next_due_cents, 'lastPaymentAt', x.last_paid, 'status', st)
    from public.enrollment_students s
    cross join lateral (
      select count(*) as n, coalesce(sum(v.total_cents), 0)::bigint as total, coalesce(sum(v.paid_cents), 0)::bigint as paid,
             coalesce(sum(v.balance_cents), 0)::bigint as balance,
             coalesce(sum(v.balance_cents) filter (where v.balance_cents > 0 and v.due_date < v_today), 0)::bigint as overdue,
             count(*) filter (where v.balance_cents > 0 and v.due_date < v_today) as overdue_n,
             min(v.due_date) filter (where v.balance_cents > 0 and v.due_date >= v_today) as next_due,
             (select max(p.paid_at) from public.payments p where p.student_id = s.id and p.invoice_id is not null and p.status = 'paid') as last_paid,
             (select coalesce(jsonb_agg(distinct c.code), '[]'::jsonb) from public.student_invoices w join public.cms_courses c on c.id = w.course_id
               where w.student_id = s.id and not w.is_void) as courses
        from public.student_invoices v where v.student_id = s.id and not v.is_void) x
    cross join lateral (select sum(w.balance_cents)::bigint as next_due_cents from public.student_invoices w
                         where w.student_id = s.id and not w.is_void and w.balance_cents > 0 and w.due_date = x.next_due) nd
    cross join lateral (select case when x.overdue > 0 then 'overdue' when x.balance > 0 then 'owing' when x.balance < 0 then 'credit' else 'paid' end as st) z
   where x.n > 0
     and (v_q is null or lower(concat_ws(' ', s.full_name, s.email, s.student_number,
            (select string_agg(concat_ws(' ', w.invoice_number, c.code), ' ') from public.student_invoices w left join public.cms_courses c on c.id = w.course_id where w.student_id = s.id)))
          like '%' || v_q || '%');
  select count(*) into v_total from finance_student_rows where v_status is null or status = v_status;
  select jsonb_build_object('students', count(*), 'overdue', count(*) filter (where status = 'overdue'), 'owing', count(*) filter (where status = 'owing'),
      'paid', count(*) filter (where status = 'paid'), 'credit', count(*) filter (where status = 'credit'),
      'balanceCents', coalesce(sum(balance), 0), 'overdueCents', coalesce(sum(overdue), 0))
    into v_sum from finance_student_rows;
  select coalesce(jsonb_agg(j order by ord), '[]'::jsonb) into v_rows from (
    select j, row_number() over (order by case status when 'overdue' then 0 when 'owing' then 1 when 'credit' then 2 else 3 end, overdue desc, balance desc, name) as ord
      from finance_student_rows where v_status is null or status = v_status
     order by ord limit v_size offset (v_page - 1) * v_size) y;
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'page', v_page, 'pageSize', v_size, 'summary', v_sum);
end $$;
revoke all on function public.finance_student_fees_list(jsonb) from public, anon;
grant execute on function public.finance_student_fees_list(jsonb) to authenticated;

commit;
