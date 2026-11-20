-- OFFER-ADMIN-TABLE (2026-11-21, owner): the offer letter's ADMIN USE ONLY table.
--
--   * Its boxes printed "?" (U+2610 in the template; neither embedded font has it). document-pdf.ts now draws tick boxes as lines and
--     reports where it drew them; the staff browser places automatic fields on them (offerSigningLayout.ts adminTableFields):
--     "Offer accepted" (checkbox) on ACCEPTED, "Payment made" (checkbox) on Yes, "Payment date" (text) in the cell after "Date:".
--     hr.sign_auto_value (20261116075140) fills them when the student signs: the signed letter (PDF #1) shows ACCEPTED ticked and the
--     payment boxes empty. DEFERRED / DECLINED / No get no field (nothing in the system decides those outcomes).
--   * When the deposit is recorded (deposit_paid_at set, any path), document-signing is called through pg_net (job 'offer-payment-copy')
--     to make the payment-confirmed copy (PDF #2): the signed file with Yes ticked and the paid date (DD/MM/YYYY, Melbourne) appended as
--     an incremental update. The signed letter, its hash and its signing history are never changed: the copy is stored apart
--     (enrollment_offer_letters.payment_copy_*), must begin with the signed file byte for byte, is made once per letter, and is logged
--     (hr.sign_event payment_copy_created, portal_audit_log offer_payment_copy_created).
--   * email-sender attaches it to the student's "Payment received" email (notification_delivery_offer_payment_copy); while it is being
--     made the email waits (retried each minute) and, on its last attempt, goes without it rather than not at all.
-- Additive: four columns, five new functions, one trigger; portal_offer_letter_sign_layout replaced (same checks plus the automatic
-- fields), portal_offer_letter_file / portal_offer_letter_list patched in place (single-line anchors).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

/* ------------------------------------------------------------------ 1. the payment-confirmed copy, stored apart from the signed letter */
alter table public.enrollment_offer_letters
 add column if not exists payment_copy_content bytea,
 add column if not exists payment_copy_sha256 text,
 add column if not exists payment_copy_at timestamptz,
 add column if not exists payment_copy_queued_at timestamptz;
do $$ begin
 if not exists (select 1 from pg_constraint where conname = 'enrollment_offer_letters_payment_copy_sha256_check') then
  alter table public.enrollment_offer_letters add constraint enrollment_offer_letters_payment_copy_sha256_check
   check (payment_copy_sha256 is null or payment_copy_sha256 ~ '^[0-9a-f]{64}$');
 end if;
end $$;
comment on column public.enrollment_offer_letters.payment_copy_content is
 'Payment-confirmed copy of the signed letter: signed_content byte for byte plus an incremental update ticking "Payment made: Yes" and printing the paid date. Made once (document-signing offer_payment_copy); signed_content is never changed.';
comment on column public.enrollment_offer_letters.payment_copy_queued_at is 'When document-signing was last asked to make the payment-confirmed copy (job offer-payment-copy).';

/* ------------------------------------------------------------------ 2. the layout takes the automatic ADMIN USE ONLY fields */
-- Same checks as before for the student's own fields; a checkbox or text field only as one of the three automatic fields the letter
-- uses. A layout without automatic fields (Resend offer letter reads the PDF only) keeps the ones already stored.
create or replace function public.portal_offer_letter_sign_layout(p_letter uuid, p_layout jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l public.enrollment_offer_letters; f jsonb; v_out jsonb := '[]'::jsonb; v_type text; v_auto text;
begin
 select * into l from public.enrollment_offer_letters where id = p_letter for update;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(l.application_id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if l.accepted_at is not null then raise exception 'This offer was already accepted' using errcode = '22023'; end if;
 if jsonb_typeof(p_layout) <> 'array' or jsonb_array_length(p_layout) not between 1 and 210 then raise exception 'The signing layout is not valid' using errcode = '22023'; end if;
 for f in select * from jsonb_array_elements(p_layout) loop
  v_type := f->>'type';
  v_auto := hr.sign_auto_key(f->>'label');
  if not (v_type in ('initials', 'signature', 'date', 'choice')
      or (v_type = 'checkbox' and v_auto in ('offer_accepted', 'payment_made')) or (v_type = 'text' and v_auto = 'payment_date'))
   or coalesce((f->>'page')::integer, 0) not between 1 and 200
   or (f->>'x')::numeric not between 0 and 1 or (f->>'y')::numeric not between 0 and 1 or (f->>'w')::numeric not between 0.005 and 1 or (f->>'h')::numeric not between 0.005 and 1
   or (f->>'x')::numeric + (f->>'w')::numeric > 1.0001 or (f->>'y')::numeric + (f->>'h')::numeric > 1.0001 then
   raise exception 'The signing layout is not valid' using errcode = '22023';
  end if;
  v_out := v_out || jsonb_build_object('type', v_type, 'page', (f->>'page')::integer, 'x', round((f->>'x')::numeric, 5), 'y', round((f->>'y')::numeric, 5),
   'w', round((f->>'w')::numeric, 5), 'h', round((f->>'h')::numeric, 5), 'label', left(coalesce(f->>'label', ''), 120));
 end loop;
 if not exists (select 1 from jsonb_array_elements(v_out) x where x->>'type' = 'signature') then raise exception 'The signing layout has no signature' using errcode = '22023'; end if;
 if not exists (select 1 from jsonb_array_elements(v_out) x where x->>'type' in ('checkbox', 'text')) and jsonb_typeof(l.sign_layout) = 'array' then
  v_out := v_out || coalesce((select jsonb_agg(x) from jsonb_array_elements(l.sign_layout) x where x->>'type' in ('checkbox', 'text')), '[]'::jsonb);
 end if;
 update public.enrollment_offer_letters set sign_layout = v_out where id = l.id;
 return jsonb_build_object('fields', jsonb_array_length(v_out));
end $function$;
revoke all on function public.portal_offer_letter_sign_layout(uuid, jsonb) from public, anon;
grant execute on function public.portal_offer_letter_sign_layout(uuid, jsonb) to authenticated;

/* ------------------------------------------------------------------ 3. what document-signing stamps (service role) */
-- ready: the signed file and the two automatic payment fields with their values. reason (not ready): done (made already), not_found,
-- not_ready (no signed letter or no deposit recorded), no_fields (a letter signed before 2026-11-21: nothing to tick; no copy).
-- A field the signed letter already shows (the deposit was paid before signing) is left out; with none left the copy is the signed file.
create or replace function public.offer_letter_payment_copy_source(p_letter uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare l public.enrollment_offer_letters; r hr.sign_requests; v_date text; v_fields jsonb; v_has boolean;
begin
 select * into l from public.enrollment_offer_letters where id = p_letter;
 if not found then return jsonb_build_object('ready', false, 'reason', 'not_found'); end if;
 if l.payment_copy_content is not null then return jsonb_build_object('ready', false, 'reason', 'done'); end if;
 if l.deposit_paid_at is null or l.signed_content is null or l.signing_request_id is null then return jsonb_build_object('ready', false, 'reason', 'not_ready'); end if;
 select * into r from hr.sign_requests where id = l.signing_request_id;
 if not found then return jsonb_build_object('ready', false, 'reason', 'not_ready'); end if;
 select exists (select 1 from hr.sign_fields f where f.request_id = r.id and f.type = 'checkbox' and hr.sign_auto_key(f.label) = 'payment_made') into v_has;
 if not v_has then return jsonb_build_object('ready', false, 'reason', 'no_fields'); end if;
 v_date := to_char(l.deposit_paid_at at time zone 'Australia/Melbourne', 'DD/MM/YYYY');
 select coalesce(jsonb_agg(jsonb_build_object('type', f.type, 'page', f.page, 'x', f.x, 'y', f.y, 'w', f.w, 'h', f.h, 'label', f.label,
    'value', case when f.type = 'checkbox' then 'true' else v_date end) order by f.page, f.y), '[]'::jsonb)
   into v_fields
   from hr.sign_fields f
  where f.request_id = r.id
    and ((f.type = 'checkbox' and hr.sign_auto_key(f.label) = 'payment_made' and coalesce(f.value, '') <> 'true')
      or (f.type = 'text' and hr.sign_auto_key(f.label) = 'payment_date' and coalesce(btrim(f.value), '') = ''));
 return jsonb_build_object('ready', true, 'letterId', l.id, 'requestId', r.id, 'reference', r.reference, 'title', r.title, 'paidOn', v_date,
  'signedSha256', l.signed_sha256, 'signedBase64', encode(l.signed_content, 'base64'), 'fields', v_fields);
end $f$;
revoke all on function public.offer_letter_payment_copy_source(uuid) from public, anon, authenticated;
grant execute on function public.offer_letter_payment_copy_source(uuid) to service_role;

/* ------------------------------------------------------------------ 4. storing it: once, and only as the signed file plus the marks */
create or replace function public.offer_letter_payment_copy_store(p_letter uuid, p_content text, p_sha256 text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare l public.enrollment_offer_letters; a public.enrollment_applications; v bytea; n integer;
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
 return jsonb_build_object('stored', true, 'sha256', lower(p_sha256), 'bytes', length(v));
end $f$;
revoke all on function public.offer_letter_payment_copy_store(uuid, text, text) from public, anon, authenticated;
grant execute on function public.offer_letter_payment_copy_store(uuid, text, text) to service_role;

/* ------------------------------------------------------------------ 5. asking document-signing (pg_net, like onboarding-followup) */
create or replace function public.offer_letter_payment_copy_queue(p_letter uuid) returns bigint
language plpgsql security definer set search_path = pg_catalog, public, vault as $f$
declare v_key text; v_url text; v_id bigint;
begin
 if not exists (select 1 from public.enrollment_offer_letters where id = p_letter and payment_copy_content is null) then return null; end if;
 select decrypted_secret into v_key from vault.decrypted_secrets where name = 'signing_service_role_key' limit 1;
 select decrypted_secret into v_url from vault.decrypted_secrets where name = 'signing_function_url' limit 1;
 if nullif(v_key, '') is null or nullif(v_url, '') is null or v_url !~ '^https?://[^/]+/functions/v1/document-signing$' then raise exception 'The payment copy call is not configured'; end if;
 v_id := public.cron_http_post('offer-payment-copy', url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
  body := jsonb_build_object('action', 'offer_payment_copy', 'letterId', p_letter), timeout_milliseconds := 55000);
 update public.enrollment_offer_letters set payment_copy_queued_at = now() where id = p_letter;
 return v_id;
end $f$;
revoke all on function public.offer_letter_payment_copy_queue(uuid) from public, anon, authenticated;
grant execute on function public.offer_letter_payment_copy_queue(uuid) to service_role;

-- The deposit recorded (Stripe webhook or any other path): ask for the copy once. Never fails the payment: a problem is only a warning
-- (the email worker asks again while the "Payment received" email waits).
create or replace function public.offer_letter_payment_copy_on_paid() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $f$
begin
 if new.deposit_paid_at is not null and old.deposit_paid_at is null and new.signed_content is not null and new.payment_copy_content is null then
  begin
   perform public.offer_letter_payment_copy_queue(new.id);
  exception when others then
   raise warning 'offer payment copy not queued for letter %: %', new.id, sqlerrm;
  end;
 end if;
 return null;
end $f$;
revoke all on function public.offer_letter_payment_copy_on_paid() from public, anon, authenticated;
drop trigger if exists enrollment_offer_letters_payment_copy on public.enrollment_offer_letters;
create trigger enrollment_offer_letters_payment_copy after update of deposit_paid_at on public.enrollment_offer_letters
 for each row execute function public.offer_letter_payment_copy_on_paid();

/* ------------------------------------------------------------------ 6. the attachment of the student's "Payment received" email */
-- email-sender, for a claimed offer_deposit_paid delivery (lease-checked): the copy for the student's email (null for the agent's copy
-- and for a letter with no copy to make); pending while it is being made (asked again at most once a minute); missing on the last
-- attempt (the email then goes without it).
create or replace function public.notification_delivery_offer_payment_copy(p_id uuid, p_lease uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare x public.notification_deliveries; l public.enrollment_offer_letters; v_src jsonb;
begin
 select * into x from public.notification_deliveries y where y.id = p_id and y.lease_token = p_lease and y.state = 'sending' and y.event = 'offer_deposit_paid';
 if not found then return null; end if;
 if lower(btrim(x.recipient_email)) is distinct from lower(btrim(public.application_student_contact(x.application_id)->>'email')) then return null; end if;
 select * into l from public.enrollment_offer_letters q where q.application_id = x.application_id and q.deposit_paid_at is not null order by q.issued_at desc limit 1;
 if not found then return null; end if;
 if l.payment_copy_content is not null then
  return jsonb_build_object('fileName', regexp_replace(coalesce(nullif(btrim(l.file_name), ''), 'Offer letter.pdf'), '\.pdf$', '', 'i') || ' - signed - payment confirmed.pdf',
   'sizeBytes', length(l.payment_copy_content), 'contentBase64', encode(l.payment_copy_content, 'base64'));
 end if;
 v_src := public.offer_letter_payment_copy_source(l.id);
 if coalesce((v_src->>'ready')::boolean, false) is not true then return null; end if;
 if x.attempt_count >= 3 then return jsonb_build_object('missing', true); end if;
 if l.payment_copy_queued_at is null or l.payment_copy_queued_at < now() - interval '1 minute' then
  begin perform public.offer_letter_payment_copy_queue(l.id); exception when others then raise warning 'offer payment copy not queued: %', sqlerrm; end;
 end if;
 return jsonb_build_object('pending', true);
end $f$;
revoke all on function public.notification_delivery_offer_payment_copy(uuid, uuid) from public, anon, authenticated;
grant execute on function public.notification_delivery_offer_payment_copy(uuid, uuid) to service_role;

/* ------------------------------------------------------------------ 7. staff and agents: the copy beside the signed letter */
select pg_temp.patch('public.portal_offer_letter_file(uuid,text)',
 $a$ elsif p_kind = 'certificate' then$a$,
 $a$ elsif p_kind = 'payment_confirmed' and l.payment_copy_content is not null then
  return jsonb_build_object('fileName', regexp_replace(l.file_name, '\.pdf$', '', 'i') || ' - signed - payment confirmed.pdf', 'contentBase64', encode(l.payment_copy_content, 'base64'));
 elsif p_kind = 'certificate' then$a$);
select pg_temp.patch('public.portal_offer_letter_list(uuid)',
 $a$'hasSigned', l.signed_content is not null,$a$,
 $a$'hasSigned', l.signed_content is not null, 'hasPaymentCopy', l.payment_copy_content is not null,$a$);
