-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116075140),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
-- Automatic fields: placed like any field (for the signer), but the system fills them when the person signs.
--   "Offer accepted" (checkbox)      ticked
--   "Payment made" (checkbox)        ticked when the request's Stripe payment is paid
--   "Payment not made" (checkbox)    ticked when it is not paid
--   "Payment date" (text)            the paid date (DD/MM/YYYY, Melbourne), empty when unpaid
--   "Amount paid" (text)             e.g. AUD 250.00, empty when unpaid
create or replace function hr.sign_auto_key(p_label text) returns text language sql immutable set search_path to 'pg_catalog' as $$
  select case lower(regexp_replace(btrim(coalesce(p_label, '')), '\s+', ' ', 'g'))
    when 'offer accepted' then 'offer_accepted'
    when 'payment made' then 'payment_made'
    when 'payment not made' then 'payment_not_made'
    when 'payment date' then 'payment_date'
    when 'amount paid' then 'amount_paid'
  end;
$$;
create or replace function hr.sign_is_auto(p_label text) returns boolean language sql immutable set search_path to 'pg_catalog','hr' as $$
  select hr.sign_auto_key(p_label) is not null;
$$;
create or replace function hr.sign_auto_value(p_request uuid, p_label text, p_type text, p_given text) returns text
language plpgsql stable security definer set search_path to 'pg_catalog','public','hr' as $$
declare k text := hr.sign_auto_key(p_label); p public.payments;
begin
  if k is null then return p_given; end if;
  select * into p from public.payments where subject_type = 'sign_request' and subject_id = p_request and status <> 'canceled';
  return case k
    when 'offer_accepted' then case when p_type = 'checkbox' then 'true' else 'Accepted' end
    when 'payment_made' then case when p.status = 'paid' then (case when p_type = 'checkbox' then 'true' else 'Yes' end) else (case when p_type = 'checkbox' then 'false' else '' end) end
    when 'payment_not_made' then case when p.status = 'paid' then (case when p_type = 'checkbox' then 'false' else '' end) else (case when p_type = 'checkbox' then 'true' else 'No' end) end
    when 'payment_date' then case when p.status = 'paid' then to_char(p.paid_at at time zone 'Australia/Melbourne', 'DD/MM/YYYY') else '' end
    when 'amount_paid' then case when p.status = 'paid' then upper(p.currency) || ' ' || to_char(coalesce(p.amount_paid_cents, p.amount_cents) / 100.0, 'FM999,999,990.00') else '' end
  end;
end $$;
revoke all on function hr.sign_auto_value(uuid, text, text, text) from public, anon, authenticated;

-- Wire them into the signing service: the stamped PDF (sign_plan), the stored values (sign), and the required-field check.
do $$
declare d text := pg_get_functiondef('public.signing_service(text,text,uuid,jsonb)'::regprocedure);
  a1 text := $x$'value', case when q.recipient_id = c.id then case q.type when 'text'$x$;
  a2 text := $x$else '' end else q.value end$x$;
  b1 text := $x$update hr.sign_fields q set filled_at = v_now, value = case q.type when 'text'$x$;
  b2 text := $x$else 'signed' end where q.request_id = r.id and q.recipient_id = c.id;$x$;
  c1 text := $x$if f.required and ((f.type = 'text'$x$;
  n int;
begin
  foreach n in array array[
    (length(d) - length(replace(d, a1, ''))) / length(a1), (length(d) - length(replace(d, a2, ''))) / length(a2),
    (length(d) - length(replace(d, b1, ''))) / length(b1), (length(d) - length(replace(d, b2, ''))) / length(b2),
    (length(d) - length(replace(d, c1, ''))) / length(c1)] loop
    if n <> 1 then raise exception 'signing_service has changed shape; patch not applied (anchor count %)', n; end if;
  end loop;
  d := replace(d, a1, $x$'value', case when q.recipient_id = c.id then hr.sign_auto_value(r.id, q.label, q.type, case q.type when 'text'$x$);
  d := replace(d, a2, $x$else '' end) else q.value end$x$);
  d := replace(d, b1, $x$update hr.sign_fields q set filled_at = v_now, value = hr.sign_auto_value(r.id, q.label, q.type, case q.type when 'text'$x$);
  d := replace(d, b2, $x$else 'signed' end) where q.request_id = r.id and q.recipient_id = c.id;$x$);
  d := replace(d, c1, $x$if f.required and not hr.sign_is_auto(f.label) and ((f.type = 'text'$x$);
  execute d;
end $$;
