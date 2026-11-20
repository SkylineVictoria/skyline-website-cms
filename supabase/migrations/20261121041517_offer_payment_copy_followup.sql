-- OFFER-COPY-FOLLOWUP (2026-11-21, owner): when the student's "Payment received" email had to go without the payment-confirmed copy
-- (third attempt, 20261121031517), the copy is emailed once on its own when it is stored: "Your payment-confirmed offer letter".
--
--   * Race-safe: the email worker's last attempt and the copy's store both lock the letter row. The worker marks the email as sent
--     without it (payment_copy_mail_missed_at) only while the copy is still absent under that lock; the store sets
--     payment_copy_followup_at with one conditional update (missed and not yet followed up) under the same lock. Either the copy is
--     there for the payment email, or the follow-up is queued exactly once: never two emails with the PDF, never none.
--   * Student only (the delivery goes to the application's student contact), once per letter.
--   * Daily health check: cron_http_health_check now also flags letters paid more than 30 minutes ago with no copy (kind offer_copy,
--     dashboard Needs action today > Scheduled jobs or Edge Functions failing, and the daily email) and asks document-signing again.
-- Additive: two columns, two new functions; notification_delivery_offer_payment_copy and offer_letter_payment_copy_store replaced
-- (both from 20261121031517), cron_health_flags kind check widened, cron_http_health_check patched in place (single-line anchors).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

alter table public.enrollment_offer_letters
 add column if not exists payment_copy_mail_missed_at timestamptz,
 add column if not exists payment_copy_followup_at timestamptz;
comment on column public.enrollment_offer_letters.payment_copy_mail_missed_at is 'The student''s Payment received email went without the payment-confirmed copy (its last attempt found none).';
comment on column public.enrollment_offer_letters.payment_copy_followup_at is 'The follow-up email with the payment-confirmed copy was queued (once per letter).';

/* ------------------------------------------------------------------ 1. the email worker's attachment (and the follow-up's) */
create or replace function public.notification_delivery_offer_payment_copy(p_id uuid, p_lease uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare x public.notification_deliveries; l public.enrollment_offer_letters; v_src jsonb;
begin
 select * into x from public.notification_deliveries y where y.id = p_id and y.lease_token = p_lease and y.state = 'sending'
  and y.event in ('offer_deposit_paid', 'offer_payment_copy_followup');
 if not found then return null; end if;
 if lower(btrim(x.recipient_email)) is distinct from lower(btrim(public.application_student_contact(x.application_id)->>'email')) then return null; end if;
 select * into l from public.enrollment_offer_letters q where q.application_id = x.application_id and q.deposit_paid_at is not null
  and (x.event = 'offer_deposit_paid' or q.payment_copy_followup_at is not null) order by q.issued_at desc limit 1;
 if not found then return null; end if;
 -- Locked: the copy's store (offer_letter_payment_copy_store) waits for this decision, or this waits for the store.
 select * into l from public.enrollment_offer_letters where id = l.id for update;
 if l.payment_copy_content is not null then
  return jsonb_build_object('fileName', regexp_replace(coalesce(nullif(btrim(l.file_name), ''), 'Offer letter.pdf'), '\.pdf$', '', 'i') || ' - signed - payment confirmed.pdf',
   'sizeBytes', length(l.payment_copy_content), 'contentBase64', encode(l.payment_copy_content, 'base64'));
 end if;
 if x.event = 'offer_payment_copy_followup' then return jsonb_build_object('pending', true); end if;
 v_src := public.offer_letter_payment_copy_source(l.id);
 if coalesce((v_src->>'ready')::boolean, false) is not true then return null; end if;
 if x.attempt_count >= 3 then
  -- Sent without it: the copy's store emails it on its own (once).
  update public.enrollment_offer_letters set payment_copy_mail_missed_at = coalesce(payment_copy_mail_missed_at, now()) where id = l.id;
  return jsonb_build_object('missing', true);
 end if;
 if l.payment_copy_queued_at is null or l.payment_copy_queued_at < now() - interval '1 minute' then
  begin perform public.offer_letter_payment_copy_queue(l.id); exception when others then raise warning 'offer payment copy not queued: %', sqlerrm; end;
 end if;
 return jsonb_build_object('pending', true);
end $f$;
revoke all on function public.notification_delivery_offer_payment_copy(uuid, uuid) from public, anon, authenticated;
grant execute on function public.notification_delivery_offer_payment_copy(uuid, uuid) to service_role;

/* ------------------------------------------------------------------ 2. storing the copy; the follow-up when the email went without it */
create or replace function public.offer_letter_payment_copy_store(p_letter uuid, p_content text, p_sha256 text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare l public.enrollment_offer_letters; a public.enrollment_applications; v bytea; n integer; v_follow uuid; v_contact jsonb; v_subject text; v_body text; v_name text; v_ref text;
begin
 select * into l from public.enrollment_offer_letters where id = p_letter for update;
 if not found then raise exception 'Offer letter not found' using errcode = 'P0002'; end if;
 if l.payment_copy_content is not null then return jsonb_build_object('stored', false, 'already', true, 'sha256', l.payment_copy_sha256); end if;
 if l.deposit_paid_at is null or l.signed_content is null then raise exception 'The letter is not signed and paid' using errcode = '22023'; end if;
 v := decode(coalesce(p_content, ''), 'base64');
 if length(v) < 5 or length(v) > 20 * 1024 * 1024 or substring(v from 1 for 4) <> '\x25504446'::bytea then raise exception 'The copy is not a PDF' using errcode = '22023'; end if;
 if encode(sha256(v), 'hex') is distinct from lower(coalesce(p_sha256, '')) then raise exception 'The copy does not match its hash' using errcode = '22023'; end if;
 -- The signed letter as recorded at signing, and kept as its first bytes: the copy only appends.
 if l.signed_sha256 is not null and encode(sha256(l.signed_content), 'hex') <> l.signed_sha256 then
  raise exception 'The signed letter does not match its recorded hash' using errcode = '22023'; end if;
 n := length(l.signed_content);
 if length(v) < n or substring(v from 1 for n) <> l.signed_content then
  raise exception 'The payment-confirmed copy must keep the signed letter unchanged' using errcode = '22023'; end if;
 update public.enrollment_offer_letters set payment_copy_content = v, payment_copy_sha256 = lower(p_sha256), payment_copy_at = now() where id = l.id;
 select * into a from public.enrollment_applications where id = l.application_id;
 perform hr.sign_event(l.signing_request_id, 'payment_copy_created', null, null,
  jsonb_build_object('offer_letter', l.id, 'sha256', lower(p_sha256), 'bytes', length(v), 'signed_sha256', l.signed_sha256, 'paid_at', l.deposit_paid_at));
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
 values (null, 'System', 'system', 'offer_payment_copy_created', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
  jsonb_build_object('letter', l.id, 'request', l.signing_request_id, 'sha256', lower(p_sha256), 'bytes', length(v), 'signed_sha256', l.signed_sha256, 'paid_at', l.deposit_paid_at));
 -- The Payment received email went without the copy: one follow-up to the student (one conditional update under the row lock).
 update public.enrollment_offer_letters set payment_copy_followup_at = now()
  where id = l.id and payment_copy_mail_missed_at is not null and payment_copy_followup_at is null returning id into v_follow;
 if v_follow is not null then
  v_contact := public.application_student_contact(a.id);
  if coalesce(v_contact->>'email', '') <> '' then
   select coalesce(nullif(btrim(s.name), ''), 'Skyline Institute of Technology') into v_name from public.cms_settings s where s.tenant_id is not distinct from a.tenant_id order by s.id limit 1;
   v_ref := coalesce(nullif(a.reference, ''), left(a.id::text, 8));
   v_subject := 'Your payment-confirmed offer letter';
   v_body := 'Hello ' || coalesce(nullif(v_contact->>'name', ''), 'Student') || E',\n\nThank you for paying your initial deposit for application ' || v_ref || '.'
    || E' Your signed offer letter, now showing the payment, is attached as a PDF for your records.\n\n' || coalesce(v_name, 'Skyline Institute of Technology');
   insert into public.notification_deliveries(tenant_id, application_id, recipient_email, event, template_source, subject, body, html_body, signing)
   values (a.tenant_id, a.id, v_contact->>'email', 'offer_payment_copy_followup', 'default', v_subject, v_body, public.email_html_wrap(a.tenant_id, v_subject, v_body), false);
   insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
   values (null, 'System', 'system', 'offer_payment_copy_followup_queued', 'application', a.id::text, a.id, a.agency_id, a.tenant_id,
    jsonb_build_object('letter', l.id, 'to', v_contact->>'email', 'missed_at', l.payment_copy_mail_missed_at));
  end if;
 end if;
 return jsonb_build_object('stored', true, 'sha256', lower(p_sha256), 'bytes', length(v), 'followUp', v_follow is not null);
end $f$;
revoke all on function public.offer_letter_payment_copy_store(uuid, text, text) from public, anon, authenticated;
grant execute on function public.offer_letter_payment_copy_store(uuid, text, text) to service_role;

/* ------------------------------------------------------------------ 3. the daily check: paid letters still without their copy */
alter table public.cron_health_flags drop constraint if exists cron_health_flags_kind_check;
alter table public.cron_health_flags add constraint cron_health_flags_kind_check check (kind = any (array['job', 'function', 'offer_copy']));

-- Letters paid more than p_minutes ago whose copy should exist (signed, with the payment fields) and does not: one flag for the day
-- (removed when none is left) and document-signing asked again for each (at most once in 10 minutes).
create or replace function public.offer_payment_copy_late(p_minutes integer) returns table(letter uuid, paid_at timestamptz, queued_at timestamptz, label text)
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select l.id, l.deposit_paid_at, l.payment_copy_queued_at, coalesce(q.reference, '?') || ' (application ' || coalesce(nullif(a.reference, ''), left(a.id::text, 8)) || ')'
 from public.enrollment_offer_letters l
 join public.enrollment_applications a on a.id = l.application_id
 join hr.sign_requests q on q.id = l.signing_request_id
 where l.deposit_paid_at < now() - make_interval(mins => greatest(p_minutes, 1)) and l.payment_copy_content is null and l.signed_content is not null
  and exists (select 1 from hr.sign_fields f where f.request_id = q.id and f.type = 'checkbox' and hr.sign_auto_key(f.label) = 'payment_made');
$f$;
revoke all on function public.offer_payment_copy_late(integer) from public, anon, authenticated;
create or replace function public.offer_payment_copy_health(p_minutes integer default 30) returns integer
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare v_n integer; v_first timestamptz; v_last timestamptz; v_list text; r record;
begin
 select count(*), min(x.paid_at), max(x.paid_at), string_agg(x.label, ', ' order by x.paid_at) into v_n, v_first, v_last, v_list
 from public.offer_payment_copy_late(p_minutes) x;
 if v_n = 0 then
  delete from public.cron_health_flags where kind = 'offer_copy' and day = current_date;
  return 0;
 end if;
 for r in select x.letter from public.offer_payment_copy_late(p_minutes) x where x.queued_at is null or x.queued_at < now() - interval '10 minutes' loop
  begin perform public.offer_letter_payment_copy_queue(r.letter); exception when others then raise warning 'offer payment copy not queued: %', sqlerrm; end;
 end loop;
 insert into public.cron_health_flags(kind, job, day, calls, failures, last_status, last_detail, first_failure_at, last_failure_at, summary)
 values ('offer_copy', 'Offer letter payment-confirmed copy', current_date, v_n, v_n, null, null, v_first, v_last,
  v_n || ' offer letter' || case when v_n = 1 then '' else 's' end || ' paid more than ' || greatest(p_minutes, 1) || ' minutes ago without the payment-confirmed copy: '
   || left(v_list, 600) || '. document-signing (offer_payment_copy) was asked again; see public.cron_http_calls job offer-payment-copy.')
 on conflict (kind, job, day) do update set calls = excluded.calls, failures = excluded.failures, first_failure_at = excluded.first_failure_at,
  last_failure_at = excluded.last_failure_at, summary = excluded.summary, created_at = now();
 return v_n;
end $f$;
revoke all on function public.offer_payment_copy_health(integer) from public, anon, authenticated;
grant execute on function public.offer_payment_copy_health(integer) to service_role;

select pg_temp.patch('public.cron_http_health_check(integer,integer)',
 $a$ select count(*), count(*) filter (where f.kind = 'job'), count(*) filter (where f.kind = 'function'),$a$,
 $a$ begin perform public.offer_payment_copy_health(30); exception when others then raise warning 'offer payment copy check failed: %', sqlerrm; end;
 select count(*), count(*) filter (where f.kind = 'job'), count(*) filter (where f.kind = 'function'),$a$);
select pg_temp.patch('public.cron_http_health_check(integer,integer)',
 $a$E'\n' order by f.job) filter (where f.kind = 'function') end)$a$,
 $a$E'\n' order by f.job) filter (where f.kind = 'function') end,
    case when count(*) filter (where f.kind = 'offer_copy') > 0 then 'Offer letters paid without their payment-confirmed copy:' || E'\n'
     || string_agg('- ' || f.summary, E'\n') filter (where f.kind = 'offer_copy') end)$a$);
