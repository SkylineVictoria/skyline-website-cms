-- Offer letters signed from the email, without logging in (OFFER-SIGN). Additive on 20261113140000 (Documents & Signatures) and
-- 20261113260000 / 20261113320000 (offer letters). The existing Sign module carries it; no second signing system:
--   * an offer letter's email to the STUDENT carries a personal link (APP_URL/sign#t=<token>): 32 random bytes, only the sha256 kept,
--     made by the notification worker when the email is sent, tied to one signing request for that one letter and the student's email;
--     a new email for the letter (resend, retry) retires the earlier links; the request expires with the offer (Settings > Offer validity)
--   * the signer confirms a 6-digit code emailed to them (hash kept, 10 minutes, 5 wrong entries end it, one a minute, five an hour)
--     before signing; IP, browser, time and the code check are in the hash-chained history and so in the certificate
--   * fields from the staff browser (initials on every page, signature and date at "Student Signature", YES / NO for the pre-paid fee)
--   * signing completes the acceptance: the signed letter and certificate are stored on the letter (Documents), the application moves
--     to Offer accepted through the applicant's system path (history, audit, the offer_accepted email to staff and the agent)
--   * an agent keeps their own email with the portal link; a CC never gets the student's link
--   * "Request a new link" (expired / replaced link) tells admissions; rate limits per address and link
-- LOCAL until the owner releases it.
set local lock_timeout = '5s';

-- ------------------------------------------------------------------ schema
alter table hr.sign_requests
 add column if not exists offer_letter_id uuid references public.enrollment_offer_letters(id) on delete restrict,
 add column if not exists require_code boolean not null default false;
create index if not exists sign_requests_offer_idx on hr.sign_requests(offer_letter_id, created_at desc) where offer_letter_id is not null;

alter table hr.sign_fields drop constraint if exists sign_fields_type_check;
alter table hr.sign_fields add constraint sign_fields_type_check check (type in ('signature','initials','date','name','text','checkbox','choice'));
alter table hr.sign_notifications drop constraint if exists sign_notifications_kind_check;
alter table hr.sign_notifications add constraint sign_notifications_kind_check check (kind in ('invite','reminder','expired','declined','voided','completed','link_requested'));

create table if not exists hr.sign_codes (
 id bigint generated always as identity primary key,
 recipient_id uuid not null references hr.sign_recipients(id) on delete cascade,
 code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 attempts integer not null default 0 check (attempts between 0 and 5),
 verified_at timestamptz,
 session_hash text check (session_hash ~ '^[a-f0-9]{64}$'),
 session_expires_at timestamptz,
 ip text check (ip is null or length(ip) <= 64)
);
create index if not exists sign_codes_recipient_idx on hr.sign_codes(recipient_id, created_at desc);
-- Links that no longer work (replaced, expired, voided): kept only so "Request a new link" can tell admissions which offer it was.
create table if not exists hr.sign_token_history (
 token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
 recipient_id uuid not null references hr.sign_recipients(id) on delete cascade,
 retired_at timestamptz not null default now()
);
create table if not exists hr.sign_rate (key text primary key, window_start timestamptz not null, hits integer not null);
alter table hr.sign_codes enable row level security;
alter table hr.sign_token_history enable row level security;
alter table hr.sign_rate enable row level security;
revoke all on hr.sign_codes, hr.sign_token_history, hr.sign_rate from public, anon, authenticated;

create or replace function hr.sign_token_retire() returns trigger language plpgsql set search_path = pg_catalog, hr as $f$
begin
 insert into hr.sign_token_history(token_hash, recipient_id) values (old.token_hash, old.recipient_id) on conflict (token_hash) do nothing;
 return old;
end $f$;
drop trigger if exists sign_tokens_retire on hr.sign_tokens;
create trigger sign_tokens_retire before delete on hr.sign_tokens for each row execute function hr.sign_token_retire();

alter table public.enrollment_offer_letters
 add column if not exists sign_layout jsonb,
 add column if not exists signing_request_id uuid,
 add column if not exists signed_at timestamptz,
 add column if not exists signed_content bytea,
 add column if not exists signed_sha256 text,
 add column if not exists certificate_content bytea,
 add column if not exists certificate_sha256 text,
 add column if not exists prepaid_more text;
alter table public.enrollment_offer_letters drop constraint if exists enrollment_offer_letters_prepaid_more_check;
alter table public.enrollment_offer_letters add constraint enrollment_offer_letters_prepaid_more_check check (prepaid_more is null or prepaid_more in ('YES', 'NO'));
alter table public.enrollment_offer_letters drop constraint if exists enrollment_offer_letters_signed_size_check;
alter table public.enrollment_offer_letters add constraint enrollment_offer_letters_signed_size_check
 check ((signed_content is null or length(signed_content) <= 8388608) and (certificate_content is null or length(certificate_content) <= 8388608));
alter table public.enrollment_offer_letters drop constraint if exists enrollment_offer_letters_accepted_via_check;
alter table public.enrollment_offer_letters add constraint enrollment_offer_letters_accepted_via_check check (accepted_via in ('portal', 'staff', 'signing'));

-- The student's copy of an offer letter email gets the signing link when it is sent; nothing else ever does.
alter table public.notification_deliveries add column if not exists signing boolean not null default false;

-- ------------------------------------------------------------------ who signs: the student
/** The student of an application: name and email (the application's, else the student record's). */
create or replace function public.application_student_contact(p_application uuid) returns jsonb language sql stable security definer set search_path = public as $$
 select jsonb_build_object('name', coalesce(nullif(btrim(s.full_name), ''), nullif(btrim(a.student_name), ''), 'Student'),
   'email', coalesce(nullif(lower(btrim(a.student_email)), ''), lower(btrim(coalesce(s.email, '')))), 'studentId', a.student_id)
 from public.enrollment_applications a left join public.enrollment_students s on s.id = a.student_id where a.id = p_application;
$$;
revoke all on function public.application_student_contact(uuid) from public, anon, authenticated;

create or replace function public.offer_letter_portal_note(p_link text) returns text language sql immutable set search_path = pg_catalog as $$
 select case when coalesce(p_link, '') = '' then E'\n\nThe student has been emailed their own link to review and sign the offer.'
  else E'\n\nView the offer in the agency portal (sign-in required): ' || p_link || E'\nThe student has been emailed their own link to review and sign the offer.' end;
$$;

-- ------------------------------------------------------------------ field layout (staff browser)
/**
 * Where the student signs: found by the staff browser in the letter's own text (initials on every page, signature and date at
 * "Student Signature", YES / NO at "I elect to pay more"). Stored on the letter before the email goes; a request already made keeps its fields.
 */
create or replace function public.portal_offer_letter_sign_layout(p_letter uuid, p_layout jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.enrollment_offer_letters; f jsonb; v_out jsonb := '[]'::jsonb; v_type text;
begin
 select * into l from public.enrollment_offer_letters where id = p_letter for update;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(l.application_id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if l.accepted_at is not null then raise exception 'This offer was already accepted' using errcode = '22023'; end if;
 if jsonb_typeof(p_layout) <> 'array' or jsonb_array_length(p_layout) not between 1 and 210 then raise exception 'The signing layout is not valid' using errcode = '22023'; end if;
 for f in select * from jsonb_array_elements(p_layout) loop
  v_type := f->>'type';
  if v_type not in ('initials', 'signature', 'date', 'choice') or coalesce((f->>'page')::integer, 0) not between 1 and 200
   or (f->>'x')::numeric not between 0 and 1 or (f->>'y')::numeric not between 0 and 1 or (f->>'w')::numeric not between 0.005 and 1 or (f->>'h')::numeric not between 0.005 and 1
   or (f->>'x')::numeric + (f->>'w')::numeric > 1.0001 or (f->>'y')::numeric + (f->>'h')::numeric > 1.0001 then
   raise exception 'The signing layout is not valid' using errcode = '22023';
  end if;
  v_out := v_out || jsonb_build_object('type', v_type, 'page', (f->>'page')::integer, 'x', round((f->>'x')::numeric, 5), 'y', round((f->>'y')::numeric, 5),
   'w', round((f->>'w')::numeric, 5), 'h', round((f->>'h')::numeric, 5), 'label', left(coalesce(f->>'label', ''), 120));
 end loop;
 if not exists (select 1 from jsonb_array_elements(v_out) x where x->>'type' = 'signature') then raise exception 'The signing layout has no signature' using errcode = '22023'; end if;
 update public.enrollment_offer_letters set sign_layout = v_out where id = l.id;
 return jsonb_build_object('fields', jsonb_array_length(v_out));
end $$;
revoke all on function public.portal_offer_letter_sign_layout(uuid, jsonb) from public, anon;
grant execute on function public.portal_offer_letter_sign_layout(uuid, jsonb) to authenticated;

/** The layout when none was stored: initials at the foot of every page, signature, date and YES / NO near the end of the last page. */
create or replace function public.offer_letter_default_layout(p_pages integer) returns jsonb language sql immutable set search_path = pg_catalog as $$
 select coalesce((select jsonb_agg(jsonb_build_object('type', 'initials', 'page', p, 'x', 0.80, 'y', 0.905, 'w', 0.12, 'h', 0.03, 'label', 'Initials')) from generate_series(1, greatest(p_pages, 1)) p), '[]'::jsonb)
  || jsonb_build_array(
   jsonb_build_object('type', 'choice', 'page', greatest(p_pages, 1), 'x', 0.55, 'y', 0.70, 'w', 0.20, 'h', 0.03, 'label', 'I elect to pay more than the required pre-paid fee'),
   jsonb_build_object('type', 'signature', 'page', greatest(p_pages, 1), 'x', 0.35, 'y', 0.75, 'w', 0.35, 'h', 0.06, 'label', 'Student signature'),
   jsonb_build_object('type', 'date', 'page', greatest(p_pages, 1), 'x', 0.35, 'y', 0.82, 'w', 0.20, 'h', 0.03, 'label', 'Date'));
$$;

-- ------------------------------------------------------------------ the signing link, made when the student's email is sent
/**
 * The email worker (email-sender, 20261112160438), for a claimed student copy of offer_letter_issued (lease-checked): makes the signing
 * request for the letter the first time (answering needs_original until the worker has stored the letter PDF in signing-documents),
 * then a new personal link. Every earlier link of the letter stops working. With p_site (the app's address) it also returns the email
 * as sent: the stored text plus the "Review and sign your offer" line, and its branded HTML (email_html_wrap makes the line a button);
 * neither is stored, so the link exists only in the email. Returns null for any other delivery, closed when the offer is no longer open,
 * wait while the staff browser has not stored the layout yet (at most 3 minutes, then the default layout).
 */
create or replace function public.notification_delivery_offer_signing(p_id uuid, p_lease uuid, p_pages integer default null, p_original_stored boolean default false, p_site text default null)
returns jsonb language plpgsql security definer set search_path = public, hr as $$
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
 end if;
 if r.state = 'draft' then
  if not p_original_stored then return jsonb_build_object('needs_original', true, 'request_id', r.id, 'path', r.original_path, 'hash', r.original_hash); end if;
  update hr.sign_requests set state = 'sent', sent_at = now(),
   expires_at = greatest(l.issued_at + make_interval(days => v_days), now() + interval '1 day') where id = r.id returning * into r;
  update hr.sign_recipients set state = 'sent', sent_at = now(), last_notified_at = now() where request_id = r.id and state = 'pending';
  perform hr.sign_event(r.id, 'sent');
 elsif v_resend and r.expires_at < now() + interval '1 day' then
  -- Resent near or after the end of the offer's validity: staff are offering it again, so the link works for another validity period.
  update hr.sign_requests set expires_at = now() + make_interval(days => v_days) where id = r.id returning * into r;
 end if;
 select * into c from hr.sign_recipients where request_id = r.id order by signing_order, id limit 1;
 delete from hr.sign_tokens where recipient_id = c.id; -- one live link per offer: the newest email's
 v_token := encode(extensions.gen_random_bytes(32), 'hex');
 insert into hr.sign_tokens(token_hash, recipient_id) values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), c.id);
 update hr.sign_recipients set last_notified_at = now() where id = c.id;
 perform hr.sign_event(r.id, case when v_resend then 'resent' else 'link_emailed' end, c.id, null, jsonb_build_object('delivery', x.id, 'to', c.email));
 if coalesce(p_site, '') ~ '^https?://[^\s/"<>]+(/[^\s"<>]*)?$' then
  -- "Label (note): https://..." on its own line becomes the button in email_html_wrap.
  v_text := x.body || E'\n\nReview and sign your offer (no sign-in needed): ' || rtrim(p_site, '/') || '/sign#t=' || v_token
   || E'\n\nThis link is personal to you; please do not forward it. It works until '
   || to_char(r.expires_at at time zone 'Australia/Melbourne', 'FMDD FMMonth YYYY') || '. A copy of the letter is attached.';
 end if;
 return jsonb_build_object('token', v_token, 'expiresAt', r.expires_at, 'title', r.title, 'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)), 'studentName', c.name,
  'institution', coalesce((select t.name from public.tenants t where t.id = a.tenant_id), 'Skyline Institute of Technology'),
  'text', v_text, 'html', case when v_text is not null then public.email_html_wrap(x.tenant_id, x.subject, v_text) end);
end $$;
revoke all on function public.notification_delivery_offer_signing(uuid, uuid, integer, boolean, text) from public, anon, authenticated;
grant execute on function public.notification_delivery_offer_signing(uuid, uuid, integer, boolean, text) to service_role;

-- ------------------------------------------------------------------ acceptance by signing (from signing_service only)
create or replace function public.offer_letter_accept_signed(p_letter uuid, p_request uuid, p_signer text, p_signed bytea, p_signed_hash text, p_certificate bytea, p_certificate_hash text,
  p_choice text, p_ip text) returns void language plpgsql security definer set search_path = public as $$
declare l public.enrollment_offer_letters; a public.enrollment_applications; h uuid;
begin
 select * into l from public.enrollment_offer_letters where id = p_letter for update;
 select * into a from public.enrollment_applications where id = l.application_id for update;
 if l.accepted_at is not null then raise exception 'This offer was already accepted'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'applicant' and x.from_status = a.status and x.kind = 'accept_offer')
  or l.id <> (select q.id from public.enrollment_offer_letters q where q.application_id = a.id order by q.issued_at desc limit 1) then
  raise exception 'This offer can no longer be accepted online. Please contact admissions';
 end if;
 if not public.application_student_active(a.id) then raise exception 'This offer can no longer be accepted online. Please contact admissions'; end if;
 update public.enrollment_offer_letters set accepted_at = now(), accepted_by = null, accepted_by_name = left(coalesce(p_signer, ''), 150), accepted_via = 'signing',
  accept_note = 'Signed online', signed_at = now(), signed_content = p_signed, signed_sha256 = p_signed_hash, certificate_content = p_certificate, certificate_sha256 = p_certificate_hash,
  prepaid_more = p_choice, signing_request_id = p_request where id = l.id;
 perform set_config('portal.status_command', a.id::text, true);
 perform set_config('portal.status_note', 'Offer accepted: the student signed the offer letter online', true);
 update public.enrollment_applications set status = 'offer_accepted' where id = a.id;
 perform set_config('portal.status_command', '', true);
 select x.id into h from public.enrollment_application_status_history x where x.application_id = a.id and x.new_status = 'offer_accepted' order by x.created_at desc limit 1;
 update public.enrollment_application_status_history set action_key = 'accept_offer', actor_name = left(coalesce(p_signer, 'Student'), 150) || ' (signed online)', actor_role = 'student',
  payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('via', 'signing', 'letter', l.id, 'prepaid_more', p_choice) where id = h;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (null, left(coalesce(p_signer, 'Student'), 150), 'student', 'offer_accepted', 'application', a.id::text, a.id,
  jsonb_build_object('letter', l.id, 'from', a.status, 'to', 'offer_accepted', 'via', 'signing', 'request', p_request, 'ip', left(p_ip, 64), 'prepaid_more', p_choice));
 insert into public.admission_event_outbox(application_id, tenant_id, event, payload)
 values (a.id, a.tenant_id, 'offer_accepted', jsonb_build_object('from', a.status, 'to', 'offer_accepted', 'actor', null, 'via', 'signing'));
end $$;
revoke all on function public.offer_letter_accept_signed(uuid, uuid, text, bytea, text, bytea, text, text, text) from public, anon, authenticated;

-- An offer that is withdrawn, rejected or accepted another way closes its open signing link.
create or replace function public.offer_signing_close() returns trigger language plpgsql security definer set search_path = public, hr as $$
declare r hr.sign_requests;
begin
 if old.status = 'offer_issued' and new.status is distinct from old.status then
  for r in select q.* from hr.sign_requests q join public.enrollment_offer_letters l on l.id = q.offer_letter_id
    where l.application_id = new.id and q.state in ('draft', 'sent', 'viewed', 'partial') for update of q loop
   update hr.sign_requests set state = 'void', closed_reason = 'The offer is no longer open (' || public.portal_status_label(new.status) || ')' where id = r.id;
   perform hr.sign_stop(r.id, true);
   perform hr.sign_event(r.id, 'voided', null, null, jsonb_build_object('status', new.status));
  end loop;
 end if;
 return null;
end $$;
drop trigger if exists offer_signing_close on public.enrollment_applications;
create trigger offer_signing_close after update of status on public.enrollment_applications for each row execute function public.offer_signing_close();

-- ------------------------------------------------------------------ Documents: the signed letter and the certificate
create or replace function public.portal_offer_letter_list(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public, hr as $$
begin
 if not public.portal_can_access_application(p_application) then raise exception 'Application not found' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'fileName', l.file_name, 'sizeBytes', l.size_bytes, 'issuedAt', l.issued_at, 'acceptedAt', l.accepted_at,
   'recipientKind', l.recipient_kind, 'recipientEmail', l.recipient_email, 'templateName', l.template_name, 'templateVersion', l.template_version,
   'acceptedVia', l.accepted_via, 'signedAt', l.signed_at, 'hasSigned', l.signed_content is not null, 'hasCertificate', l.certificate_content is not null, 'prepaidMore', l.prepaid_more,
   'signing', (select jsonb_build_object('status', hr.sign_status(q), 'expiresAt', q.expires_at, 'viewedAt', q.viewed_at, 'reference', q.reference)
     from hr.sign_requests q where q.offer_letter_id = l.id order by q.created_at desc limit 1)) order by l.issued_at desc)
   from public.enrollment_offer_letters l where l.application_id = p_application), '[]'::jsonb);
end $$;
revoke all on function public.portal_offer_letter_list(uuid) from public;
grant execute on function public.portal_offer_letter_list(uuid) to authenticated;

/** The signed letter or its signing certificate, for anyone who can see the application. */
create or replace function public.portal_offer_letter_file(p_letter uuid, p_kind text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare l public.enrollment_offer_letters;
begin
 select * into l from public.enrollment_offer_letters where id = p_letter;
 if not found or not public.portal_can_access_application(l.application_id) then raise exception 'Offer letter not found' using errcode = '42501'; end if;
 if p_kind = 'signed' and l.signed_content is not null then
  return jsonb_build_object('fileName', regexp_replace(l.file_name, '\.pdf$', '', 'i') || ' - signed.pdf', 'contentBase64', encode(l.signed_content, 'base64'));
 elsif p_kind = 'certificate' and l.certificate_content is not null then
  return jsonb_build_object('fileName', regexp_replace(l.file_name, '\.pdf$', '', 'i') || ' - signing certificate.pdf', 'contentBase64', encode(l.certificate_content, 'base64'));
 elsif p_kind = 'letter' then
  return jsonb_build_object('fileName', l.file_name, 'contentBase64', encode(l.content, 'base64'));
 end if;
 raise exception 'That document is not available' using errcode = '22023';
end $$;
revoke all on function public.portal_offer_letter_file(uuid, text) from public, anon;
grant execute on function public.portal_offer_letter_file(uuid, text) to authenticated;

-- ------------------------------------------------------------------ the link holder's service (20261113140000 + codes, YES / NO, offers, rate, link_request)
create or replace function public.signing_service(p_action text, p_hash text default null, p_id uuid default null, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare r hr.sign_requests; c hr.sign_recipients; x hr.sign_recipients; n record; f record; v_out jsonb := '[]'::jsonb; v_token text; v_values jsonb; v_key text;
 v_complete boolean; v_kind text; v_now timestamptz := now(); v_count integer := 0; v_reminders integer := 0; v_date text;
 v_code text; v_session text; kc hr.sign_codes; v_signed bytea; v_certificate bytea; v_choice text; v_hits integer;
 k_consent constant text := 'I have read this document and agree to its contents. I consent to sign it electronically and adopt the signature I provide here as my electronic signature.';
begin
 p_data := coalesce(p_data, '{}'::jsonb);
 if p_action = 'rate' then
  -- A fixed window per key (the caller's address, a link), in its own transaction so a refused request still counts.
  if coalesce(p_data->>'key', '') !~ '^[a-z]+:[A-Za-z0-9.:_-]{1,80}$' then return to_jsonb(true); end if;
  insert into hr.sign_rate(key, window_start, hits) values (p_data->>'key', v_now, 1)
  on conflict (key) do update set
   hits = case when hr.sign_rate.window_start <= v_now - make_interval(secs => greatest(coalesce((p_data->>'seconds')::integer, 600), 1)) then 1 else hr.sign_rate.hits + 1 end,
   window_start = case when hr.sign_rate.window_start <= v_now - make_interval(secs => greatest(coalesce((p_data->>'seconds')::integer, 600), 1)) then v_now else hr.sign_rate.window_start end
  returning hits into v_hits;
  return to_jsonb(v_hits <= greatest(coalesce((p_data->>'limit')::integer, 60), 1));
 elsif p_action = 'link_request' then
  -- "Request a new link" on the page for an expired, replaced or unknown link: admissions are told when the link was one of ours (live or
  -- retired); the answer is the same either way, so nothing is learnt about the link.
  if p_hash ~ '^[a-f0-9]{64}$' then
   select k2.* into c from hr.sign_recipients k2 where k2.id = coalesce((select t.recipient_id from hr.sign_tokens t where t.token_hash = p_hash),
     (select t.recipient_id from hr.sign_token_history t where t.token_hash = p_hash));
   if c.id is not null then
    select * into r from hr.sign_requests where id = c.request_id;
    if r.offer_letter_id is not null and r.state <> 'signed' then
     perform hr.sign_queue(r.id, c.id, 'link_requested', 'link_requested:' || c.id || ':' || to_char(v_now at time zone 'UTC', 'YYYYMMDD'), 'admin');
     perform hr.sign_event(r.id, 'link_requested', c.id, null, jsonb_build_object('ip', left(p_data->>'ip', 64)));
     insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
     select null, c.name, 'student', 'offer_signing_link_requested', 'application', l.application_id::text, l.application_id, jsonb_build_object('letter', l.id, 'request', r.reference)
      from public.enrollment_offer_letters l where l.id = r.offer_letter_id
       and not exists (select 1 from public.portal_audit_log g where g.application_id = l.application_id and g.action = 'offer_signing_link_requested' and g.created_at > v_now - interval '1 hour');
    end if;
   end if;
  end if;
  return jsonb_build_object('ok', true);
 elsif p_action = 'path_referenced' then
  return to_jsonb(exists(select 1 from hr.sign_requests where p_data->>'path' in (original_path, signed_path, current_path, certificate_path))
   or exists(select 1 from hr.sign_templates where source_path = p_data->>'path')
   or exists(select 1 from hr.sign_template_versions where snapshot->>'source_path' = p_data->>'path'));
 elsif p_action = 'delivery_result' then
  return jsonb_build_object('stale', true); -- the first-stage function's one-link send; replaced by notification jobs
 elsif p_action = 'tick' then
  -- Expiry: close, drop the links, stop reminders, tell the people who were asked and the sender. Once per request.
  for r in select * from hr.sign_requests where state in ('sent','viewed','partial') and expires_at <= v_now order by expires_at for update skip locked loop
   update hr.sign_requests set state = 'expired', expired_at = v_now where id = r.id;
   perform hr.sign_stop(r.id, true);
   for c in select * from hr.sign_recipients where request_id = r.id and state in ('sent','viewed') loop
    perform hr.sign_queue(r.id, c.id, 'expired', 'expired:' || c.id);
   end loop;
   perform hr.sign_queue(r.id, null, 'expired', 'expired:' || r.id || ':admin', 'admin');
   perform hr.sign_event(r.id, 'expired');
   v_count := v_count + 1;
  end loop;
  -- Reminders: only to people whose turn it is, on an open request, at most 10 each.
  for c in select k.* from hr.sign_recipients k join hr.sign_requests q on q.id = k.request_id
    where q.state in ('sent','viewed','partial') and q.expires_at > v_now and q.reminder_days > 0 and k.state in ('sent','viewed') and k.reminder_count < 10
     and coalesce(k.last_notified_at, k.sent_at) <= v_now - make_interval(days => q.reminder_days) for update of k skip locked loop
   perform hr.sign_queue(c.request_id, c.id, 'reminder', 'reminder:' || c.id || ':' || (c.reminder_count + 1));
   update hr.sign_recipients set reminder_count = reminder_count + 1, last_notified_at = v_now where id = c.id;
   perform hr.sign_event(c.request_id, 'reminder_queued', c.id);
   v_reminders := v_reminders + 1;
  end loop;
  delete from hr.sign_rate where window_start < v_now - interval '1 day';
  delete from hr.sign_codes where created_at < v_now - interval '30 days';
  return jsonb_build_object('expired', v_count, 'reminders', v_reminders);
 elsif p_action = 'notify_claim' then
  -- Nothing invites or reminds once a request is closed or the person is no longer waiting.
  update hr.sign_notifications j set state = 'cancelled', lease_until = null
   where j.state = 'queued' and j.kind in ('invite','reminder') and (
    exists (select 1 from hr.sign_requests q where q.id = j.request_id and (q.state not in ('sent','viewed','partial') or q.expires_at <= v_now))
    or exists (select 1 from hr.sign_recipients k where k.id = j.recipient_id and k.state not in ('sent','viewed')));
  for n in select j.* from hr.sign_notifications j where (j.state = 'queued' or (j.state = 'sending' and j.lease_until < v_now)) and j.attempts < 5
    order by j.id limit least(greatest(coalesce((p_data->>'limit')::integer, 20), 1), 50) for update skip locked loop
   update hr.sign_notifications set state = 'sending', attempts = attempts + 1, lease_until = v_now + interval '2 minutes' where id = n.id;
   select * into r from hr.sign_requests where id = n.request_id;
   c := null;
   if n.recipient_id is not null then select * into c from hr.sign_recipients where id = n.recipient_id; end if;
   v_token := null;
   if n.kind in ('invite','reminder') then
    delete from hr.sign_tokens where notification_id = n.id; -- a retry of the same job makes its own link
    v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into hr.sign_tokens(token_hash, recipient_id, notification_id) values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), c.id, n.id);
   end if;
   v_out := v_out || jsonb_build_object('id', n.id, 'kind', n.kind, 'audience', n.audience, 'request_id', r.id, 'reference', r.reference, 'title', r.title, 'message', r.message,
    'expires_at', r.expires_at, 'to', c.email, 'name', c.name, 'role', c.role_label, 'token', v_token, 'signed_path', r.signed_path, 'signed_hash', r.signed_hash,
    'certificate_path', r.certificate_path, 'certificate_hash', r.certificate_hash, 'reason', r.closed_reason,
    'sender_email', (select u.email from auth.users u where u.id = r.created_by),
    'declined_by', (select k.name from hr.sign_recipients k where k.request_id = r.id and k.state = 'declined' order by k.declined_at desc limit 1),
    'signers', (select jsonb_agg(jsonb_build_object('name', k.name, 'role', k.role_label, 'state', k.state) order by k.signing_order, k.id) from hr.sign_recipients k where k.request_id = r.id));
  end loop;
  return v_out;
 elsif p_action = 'notify_result' then
  select * into n from hr.sign_notifications where id = (p_data->>'id')::bigint for update;
  if not found or n.state <> 'sending' then return jsonb_build_object('stale', true); end if;
  v_kind := case when p_data->>'state' = 'sent' then 'sent' when p_data->>'state' = 'queued' and n.attempts < 5 then 'queued' else 'failed' end;
  update hr.sign_notifications set state = v_kind, lease_until = null, message_id = p_data->>'message_id', error = left(p_data->>'error', 300),
   sent_at = case when v_kind = 'sent' then now() end where id = n.id;
  if v_kind <> 'sent' then delete from hr.sign_tokens where notification_id = n.id; end if; -- a link nobody received is not left valid
  if n.recipient_id is not null and n.kind in ('invite','reminder') then
   update hr.sign_recipients set delivery_error = case when v_kind = 'failed' then 'The email could not be sent. Use Resend to try again.' when v_kind = 'sent' then null else delivery_error end where id = n.recipient_id;
  end if;
  perform hr.sign_event(n.request_id, 'email_' || v_kind, n.recipient_id, null, jsonb_build_object('kind', n.kind, 'audience', n.audience));
  return jsonb_build_object('state', v_kind);
 end if;

 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'This signing link is invalid or expired'; end if;
 select k.* into c from hr.sign_tokens t join hr.sign_recipients k on k.id = t.recipient_id where t.token_hash = p_hash;
 if not found then raise exception 'This signing link is invalid or expired'; end if;
 select * into r from hr.sign_requests where id = c.request_id for update;
 select * into c from hr.sign_recipients where id = c.id for update;
 if r.state not in ('sent','viewed','partial','signed') or c.state not in ('sent','viewed','signed')
  or (r.state <> 'signed' and r.expires_at <= v_now) then raise exception 'This signing link is invalid or expired'; end if;

 if p_action = 'open' then
  if c.state = 'sent' then
   update hr.sign_recipients set state = 'viewed', viewed_at = v_now where id = c.id returning * into c;
   if r.state = 'sent' then update hr.sign_requests set state = 'viewed', viewed_at = v_now where id = r.id returning * into r; end if;
   perform hr.sign_event(r.id, 'viewed', c.id, null, jsonb_build_object('ip', left(p_data->>'ip', 64)));
  end if;
 elsif p_action = 'code_send' then
  -- Identity check (offer letters): a 6-digit code to the recipient's email, valid 10 minutes, at most one a minute and five an hour.
  -- Only its hash is kept; the function emails the code it gets back here and never returns it to the page.
  if not r.require_code then raise exception 'No code is needed for this document'; end if;
  if c.state = 'signed' or r.state = 'signed' then raise exception 'This document is already signed'; end if;
  if exists (select 1 from hr.sign_codes q where q.recipient_id = c.id and q.created_at > v_now - interval '60 seconds') then
   raise exception 'A code was just sent. Wait a minute before asking for another one' using errcode = 'SG429';
  end if;
  if (select count(*) from hr.sign_codes q where q.recipient_id = c.id and q.created_at > v_now - interval '1 hour') >= 5 then
   raise exception 'Too many codes were requested. Try again in an hour' using errcode = 'SG429';
  end if;
  v_code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  insert into hr.sign_codes(recipient_id, code_hash, expires_at, ip)
  values (c.id, encode(sha256(convert_to(c.id::text || ':' || v_code, 'UTF8')), 'hex'), v_now + interval '10 minutes', left(p_data->>'ip', 64));
  perform hr.sign_event(r.id, 'code_sent', c.id, null, jsonb_build_object('ip', left(p_data->>'ip', 64), 'to', c.email));
  return jsonb_build_object('code', v_code, 'to', c.email, 'name', c.name, 'title', r.title, 'reference', r.reference, 'expires_in_minutes', 10);
 elsif p_action = 'code_verify' then
  -- Five wrong entries end a code. A right one gives the page a session (30 minutes, hash kept) that signing then requires.
  -- Answers instead of raising, so a wrong attempt is counted (the transaction commits).
  if c.state = 'signed' or r.state = 'signed' then return jsonb_build_object('ok', false, 'reason', 'signed'); end if;
  select * into kc from hr.sign_codes q where q.recipient_id = c.id and q.verified_at is null order by q.created_at desc limit 1 for update;
  if not found or kc.expires_at <= v_now then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if kc.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
  if coalesce(p_data->>'code', '') !~ '^[0-9]{6}$' or encode(sha256(convert_to(c.id::text || ':' || (p_data->>'code'), 'UTF8')), 'hex') <> kc.code_hash then
   update hr.sign_codes set attempts = attempts + 1 where id = kc.id returning * into kc;
   perform hr.sign_event(r.id, 'code_wrong', c.id, null, jsonb_build_object('ip', left(p_data->>'ip', 64), 'attempt', kc.attempts));
   return jsonb_build_object('ok', false, 'reason', case when kc.attempts >= 5 then 'locked' else 'wrong' end, 'remaining', greatest(5 - kc.attempts, 0));
  end if;
  v_session := encode(extensions.gen_random_bytes(32), 'hex');
  update hr.sign_codes set verified_at = v_now, session_hash = encode(sha256(convert_to(v_session, 'UTF8')), 'hex'), session_expires_at = v_now + interval '30 minutes',
   ip = coalesce(left(p_data->>'ip', 64), ip) where id = kc.id;
  perform hr.sign_event(r.id, 'code_verified', c.id, null, jsonb_build_object('ip', left(p_data->>'ip', 64), 'method', 'email_code', 'to', c.email));
  return jsonb_build_object('ok', true, 'session', v_session, 'expires_in_minutes', 30);
 elsif p_action in ('sign_plan','sign') then
  if c.state = 'signed' then raise exception 'You have already signed this document'; end if;
  if r.state = 'signed' then raise exception 'This document is already complete'; end if;
  if r.require_code and not exists (select 1 from hr.sign_codes q where q.recipient_id = c.id and q.session_expires_at > v_now
    and q.session_hash = encode(sha256(convert_to(coalesce(p_data->>'code_session', ''), 'UTF8')), 'hex')) then
   raise exception 'Confirm the code we emailed you before signing' using errcode = 'SG401';
  end if;
  if coalesce(p_data->>'consent', '') <> k_consent or length(btrim(coalesce(p_data->>'signer_name', ''))) not between 2 and 150 or p_data->>'signer_name' ~ '[[:cntrl:]]'
   then raise exception 'Your full name and agreement are required'; end if;
  v_kind := coalesce(p_data->>'signature_kind', 'typed');
  if v_kind not in ('typed','drawn','uploaded') then raise exception 'Choose how you want to sign'; end if;
  if v_kind <> 'typed' and (coalesce(p_data->>'signature_image', '') !~ '^[A-Za-z0-9+/]+=*$' or length(p_data->>'signature_image') not between 100 and 400000)
   then raise exception 'Draw or upload your signature first'; end if;
  if p_data->>'document_hash' is distinct from r.original_hash then raise exception 'The signing document changed. Open it again'; end if;
  v_values := case when jsonb_typeof(p_data->'values') = 'object' then p_data->'values' else '{}'::jsonb end;
  -- Only this person's own fields: a value for anyone else's field (or the sender's) is refused, not ignored.
  for v_key in select jsonb_object_keys(v_values) loop
   if not exists (select 1 from hr.sign_fields q where q.id::text = v_key and q.request_id = r.id and q.recipient_id = c.id and q.type in ('text','checkbox','choice')) then
    raise exception 'You can only fill in your own fields' using errcode = '42501';
   end if;
  end loop;
  v_date := to_char(v_now at time zone 'Australia/Melbourne', 'DD/MM/YYYY');
  for f in select * from hr.sign_fields q where q.request_id = r.id and q.recipient_id = c.id loop
   if f.type = 'text' and (length(coalesce(v_values->>f.id::text, '')) > 500 or v_values->>f.id::text ~ '[[:cntrl:]]') then raise exception 'A text field is too long'; end if;
   if f.type = 'checkbox' and coalesce(v_values->>f.id::text, 'false') not in ('true','false') then raise exception 'Tick or clear each checkbox'; end if;
   if f.type = 'choice' and coalesce(v_values->>f.id::text, '') not in ('', 'YES', 'NO') then raise exception 'Answer YES or NO'; end if;
   if f.type = 'choice' then v_choice := nullif(v_values->>f.id::text, ''); end if;
   if f.required and ((f.type = 'text' and btrim(coalesce(v_values->>f.id::text, '')) = '') or (f.type = 'checkbox' and coalesce(v_values->>f.id::text, 'false') <> 'true')
     or (f.type = 'choice' and coalesce(v_values->>f.id::text, '') = '')) then
    raise exception 'Complete every required field before signing';
   end if;
  end loop;
  v_complete := not exists (select 1 from hr.sign_recipients k where k.request_id = r.id and k.id <> c.id and k.required and k.state in ('pending','sent','viewed'));
  if p_action = 'sign_plan' then
   -- Nothing is written: the function gets what the page will look like once this person has signed, and renders the PDF from the original.
   return jsonb_build_object('id', r.id, 'reference', r.reference, 'title', r.title, 'revision', r.revision, 'complete', v_complete, 'signed_at', v_now,
    'original_path', r.original_path, 'original_hash', r.original_hash, 'created_at', r.created_at, 'sent_at', r.sent_at, 'signing_mode', r.signing_mode,
    'recipient_id', c.id, 'chain_ok', hr.sign_chain_ok(r.id),
    'offer', r.offer_letter_id is not null,
    'fields', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'recipient_id', q.recipient_id, 'type', q.type, 'page', q.page, 'x', q.x, 'y', q.y, 'w', q.w, 'h', q.h, 'label', q.label,
      'value', case when q.recipient_id = c.id then case q.type when 'text' then btrim(coalesce(v_values->>q.id::text, '')) when 'checkbox' then coalesce(v_values->>q.id::text, 'false')
        when 'choice' then coalesce(v_values->>q.id::text, '') when 'date' then v_date when 'name' then btrim(p_data->>'signer_name') else '' end else q.value end,
      'done', q.recipient_id = c.id or q.filled_at is not null)) from hr.sign_fields q where q.request_id = r.id), '[]'::jsonb),
    'recipients', (select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'email', k.email, 'role', k.role_label, 'order', k.signing_order, 'required', k.required,
      'state', case when k.id = c.id then 'signed' else k.state end, 'signer_name', case when k.id = c.id then btrim(p_data->>'signer_name') else k.signer_name end,
      'signed_at', case when k.id = c.id then v_now else k.signed_at end, 'signature_kind', case when k.id = c.id then v_kind else k.signature_kind end,
      'signature_image', case when k.id = c.id then p_data->>'signature_image' else k.signature_image end, 'viewed_at', k.viewed_at, 'sent_at', k.sent_at,
      'ip', case when k.id = c.id then left(p_data->>'ip', 64) else k.ip end, 'user_agent', case when k.id = c.id then left(p_data->>'user_agent', 400) else k.user_agent end)
      order by k.signing_order, k.id) from hr.sign_recipients k where k.request_id = r.id),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'at', e.at, 'recipient_id', e.recipient_id, 'hash', e.hash) order by e.id) from hr.sign_events e where e.request_id = r.id), '[]'::jsonb));
  end if;
  -- Commit. The PDF was rendered for one revision; if someone else signed meanwhile the function renders again (SG409).
  if (p_data->>'revision')::integer is distinct from r.revision then raise exception 'Another signature was just added' using errcode = 'SG409'; end if;
  if coalesce(p_data->>'current_hash', '') !~ '^[a-f0-9]{64}$' or coalesce(p_data->>'current_path', '') not like r.id::text || '/signed-%.pdf'
   or (p_data->>'signed_at')::timestamptz not between v_now - interval '5 minutes' and v_now + interval '5 seconds' then raise exception 'The signing document changed. Open it again'; end if;
  if v_complete and (coalesce(p_data->>'certificate_hash', '') !~ '^[a-f0-9]{64}$' or coalesce(p_data->>'certificate_path', '') not like r.id::text || '/certificate-%.pdf')
   then raise exception 'The completion certificate is missing'; end if;
  if r.offer_letter_id is not null and v_complete then
   -- The signed letter and its certificate also go to the application's Documents: the bytes must be the ones whose hashes are recorded.
   begin v_signed := decode(coalesce(p_data->>'signed_base64', ''), 'base64'); v_certificate := decode(coalesce(p_data->>'certificate_base64', ''), 'base64');
   exception when others then raise exception 'The signed document could not be stored. Please select Sign again'; end;
   if length(v_signed) < 5 or length(v_certificate) < 5 or encode(sha256(v_signed), 'hex') <> p_data->>'current_hash' or encode(sha256(v_certificate), 'hex') <> p_data->>'certificate_hash' then
    raise exception 'The signed document could not be stored. Please select Sign again';
   end if;
  end if;
  update hr.sign_fields q set filled_at = v_now, value = case q.type when 'text' then btrim(coalesce(v_values->>q.id::text, '')) when 'checkbox' then coalesce(v_values->>q.id::text, 'false')
    when 'choice' then coalesce(v_values->>q.id::text, '') when 'date' then v_date when 'name' then btrim(p_data->>'signer_name') else 'signed' end where q.request_id = r.id and q.recipient_id = c.id;
  update hr.sign_recipients set state = 'signed', signed_at = (p_data->>'signed_at')::timestamptz, signer_name = btrim(p_data->>'signer_name'), consent = k_consent, signature_kind = v_kind,
   signature_image = case when v_kind <> 'typed' then p_data->>'signature_image' end, signature_hash = p_data->>'signature_hash',
   ip = left(p_data->>'ip', 64), user_agent = left(p_data->>'user_agent', 400), delivery_error = null where id = c.id returning * into c;
  update hr.sign_notifications set state = 'cancelled', lease_until = null where recipient_id = c.id and kind in ('invite','reminder') and state in ('queued','sending');
  perform hr.sign_event(r.id, 'signed', c.id, null, jsonb_build_object('signer_name', c.signer_name, 'kind', v_kind, 'ip', c.ip, 'document_hash', p_data->>'current_hash', 'signature_hash', c.signature_hash));
  if v_complete then
   update hr.sign_recipients set state = 'skipped' where request_id = r.id and state in ('pending','sent','viewed');
   update hr.sign_requests set state = 'signed', revision = revision + 1, current_path = p_data->>'current_path', current_hash = p_data->>'current_hash',
    signed_path = p_data->>'current_path', signed_hash = p_data->>'current_hash', signed_at = c.signed_at, completed_at = v_now, signer_name = c.signer_name, consent = k_consent,
    certificate_path = p_data->>'certificate_path', certificate_hash = p_data->>'certificate_hash' where id = r.id returning * into r;
   perform hr.sign_stop(r.id, false);
   for x in select * from hr.sign_recipients where request_id = r.id and state = 'signed' loop
    perform hr.sign_queue(r.id, x.id, 'completed', 'completed:' || x.id);
   end loop;
   perform hr.sign_queue(r.id, null, 'completed', 'completed:' || r.id || ':admin', 'admin');
   perform hr.sign_event(r.id, 'completed', null, null, jsonb_build_object('signed_hash', r.signed_hash, 'certificate_hash', r.certificate_hash));
   if r.offer_letter_id is not null then
    perform public.offer_letter_accept_signed(r.offer_letter_id, r.id, c.signer_name, v_signed, r.signed_hash, v_certificate, r.certificate_hash, v_choice, c.ip);
   end if;
  else
   update hr.sign_requests set state = 'partial', revision = revision + 1, current_path = p_data->>'current_path', current_hash = p_data->>'current_hash' where id = r.id returning * into r;
   perform hr.sign_activate(r.id); -- sequential: the next signer is invited now
  end if;
 elsif p_action = 'decline' then
  if c.state = 'signed' or r.state = 'signed' then raise exception 'This document is already signed'; end if;
  if r.offer_letter_id is not null then raise exception 'To decline this offer, please contact admissions'; end if;
  update hr.sign_recipients set state = 'declined', declined_at = v_now, decline_reason = nullif(left(btrim(coalesce(p_data->>'reason', '')), 500), '') where id = c.id returning * into c;
  update hr.sign_notifications set state = 'cancelled', lease_until = null where recipient_id = c.id and kind in ('invite','reminder') and state in ('queued','sending');
  delete from hr.sign_tokens where recipient_id = c.id;
  perform hr.sign_event(r.id, 'declined', c.id, null, jsonb_build_object('reason', c.decline_reason, 'required', c.required));
  if c.required then
   update hr.sign_requests set state = 'declined', token_hash = null, closed_reason = c.decline_reason where id = r.id returning * into r;
   perform hr.sign_stop(r.id, true);
   perform hr.sign_queue(r.id, null, 'declined', 'declined:' || r.id || ':admin', 'admin');
   for x in select * from hr.sign_recipients where request_id = r.id and state = 'signed' loop
    perform hr.sign_queue(r.id, x.id, 'declined', 'declined:' || x.id);
   end loop;
  end if;
 else raise exception 'Unknown signing action'; end if;
 return jsonb_build_object('id', r.id, 'reference', r.reference, 'title', r.title, 'state', r.state, 'message', r.message, 'expires_at', r.expires_at, 'signing_mode', r.signing_mode,
  'require_code', r.require_code,
  -- An offer letter: only the student's name and the application reference, nothing else of the application.
  'offer', case when r.offer_letter_id is null then null else (select jsonb_build_object('studentName', c.name, 'applicationReference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
     'prepaidMore', l.prepaid_more) from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id where l.id = r.offer_letter_id) end,
  'original_path', r.original_path, 'original_hash', r.original_hash, 'current_path', r.current_path, 'current_hash', r.current_hash,
  'signed_path', r.signed_path, 'signed_hash', r.signed_hash, 'certificate_path', r.certificate_path, 'certificate_hash', r.certificate_hash, 'signed_at', r.signed_at,
  'recipient', jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email, 'role', c.role_label, 'state', c.state, 'signed_at', c.signed_at),
  'fields', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'type', q.type, 'page', q.page, 'x', q.x, 'y', q.y, 'w', q.w, 'h', q.h, 'required', q.required, 'label', q.label, 'value', q.value)
    order by q.page, q.y, q.x) from hr.sign_fields q where q.request_id = r.id and q.recipient_id = c.id), '[]'::jsonb),
  'signers', (select jsonb_agg(jsonb_build_object('name', k.name, 'role', k.role_label, 'state', k.state, 'order', k.signing_order, 'required', k.required, 'me', k.id = c.id) order by k.signing_order, k.id)
    from hr.sign_recipients k where k.request_id = r.id));
end $f$;
revoke all on function public.signing_service(text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.signing_service(text, text, uuid, jsonb) to service_role;

-- ------------------------------------------------------------------ emails: the student's copy gets the signing link; an agent keeps the portal link
create or replace function public.notification_enqueue_deliveries()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  a public.enrollment_applications; v_id uuid; v_cfg jsonb; v_defaults jsonb := public.tenant_config_defaults('notifications');
  v_tpl jsonb; v_vars jsonb; v_enabled boolean; v_pref boolean; v_sender jsonb; r record; v_active boolean; v_set jsonb; v_source text;
  v_subject text; v_body text; v_addr text; v_state text; v_reason text; v_route jsonb; v_host text; v_link text; v_extra text; v_valid boolean;
  v_msg text; v_student jsonb;
begin
  if new.event in ('offer_letter_issued', 'action_required_reminder') then
    select * into a from public.enrollment_applications where id = new.application_id;
    select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
    v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
    v_sender := case when v_cfg->'sender' is not null and public.notification_sender_allowed(new.tenant_id, v_cfg->'sender'->>'email') then v_cfg->'sender' else null end;
    v_active := exists (select 1 from public.notification_activation act where act.revoked_at is null and act.tenant_id is not distinct from new.tenant_id);
    v_source := case when v_cfg is null then 'default' else 'published' end;
    v_route := public.application_offer_recipient(a.id);
    v_host := case when a.tenant_id is null then public.main_site_host() else (select min(t.hostname) from public.tenant_domains t where t.tenant_id = a.tenant_id and t.verified_at is not null) end;
    v_link := case when v_host is null then '' else 'https://' || v_host || '/agency/applications/' || a.id::text end;
    if new.event = 'offer_letter_issued' then
      -- The staff message is labelled (it was appended bare before, so a test word read as part of the email). A resend carries the
      -- resend note, not the first letter's message again.
      v_msg := btrim(coalesce(case when coalesce((new.payload->>'resend')::boolean, false) then new.payload->>'note'
        else (select l.message from public.enrollment_offer_letters l where l.id = (new.payload->>'letter')::uuid) end, ''));
      v_vars := jsonb_build_object(
        'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
        'student', coalesce(nullif(btrim(a.student_name), ''), 'the student'),
        'status', public.portal_status_label(a.status), 'previousStatus', '',
        'message', '',
        'institution', coalesce((select name from public.tenants where id = new.tenant_id), 'Skyline'));
      v_subject := public.notification_render(v_tpl->>'subject', v_vars);
      -- notification_render folds line breaks inside a value, so the labelled message (and an agent's portal note) follow the rendered text.
      v_body := public.notification_render(v_tpl->>'body', v_vars) || case when v_msg <> '' then E'\n\nMessage from admissions:\n' || v_msg else '' end;
      -- The student: their own signing link is made when the email is sent (only its hash is kept), so the stored body has none.
      v_student := public.application_student_contact(a.id);
      v_addr := lower(btrim(coalesce(v_student->>'email', '')));
      v_valid := v_addr ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(v_addr) <= 254;
      insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at, signing)
      values (new.id, new.tenant_id, new.application_id, null, left(v_addr, 254), new.event, v_source, v_id, v_sender, v_subject, v_body,
        case when not v_valid then 'suppressed' when v_active then 'pending' else 'suppressed' end,
        case when not v_valid then 'invalid_recipient' when v_active then null else 'legacy_scope_not_activated' end, clock_timestamp(), true)
      on conflict do nothing;
      -- An agent who started the application keeps their own email with the portal link (sign-in), never the student's signing link.
      if v_route->>'kind' = 'agent' and lower(btrim(coalesce(v_route->>'email', ''))) <> v_addr then
        v_addr := lower(btrim(coalesce(v_route->>'email', '')));
        v_valid := v_addr ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(v_addr) <= 254;
        insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
        values (new.id, new.tenant_id, new.application_id, nullif(v_route->>'user', '')::uuid, left(v_addr, 254), new.event, v_source, v_id, v_sender, v_subject, v_body || public.offer_letter_portal_note(v_link),
          case when not v_valid then 'suppressed' when v_active then 'pending' else 'suppressed' end,
          case when not v_valid then 'invalid_recipient' when v_active then null else 'legacy_scope_not_activated' end, clock_timestamp())
        on conflict do nothing;
      end if;
      return new;
    end if;
    v_extra := coalesce(E'\n\nWhat is needed: ' || nullif(btrim(coalesce(new.payload->>'reason', '')), ''), '') || coalesce(E'\n\n' || nullif(btrim(coalesce(new.payload->>'note', '')), ''), '')
        || case when v_link <> '' then E'\n\nOpen the application (sign-in required): ' || v_link else '' end;
    v_vars := jsonb_build_object(
      'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
      'student', coalesce(nullif(btrim(a.student_name), ''), 'the student'),
      'status', public.portal_status_label(a.status),
      'previousStatus', '',
      'message', v_extra,
      'institution', coalesce((select name from public.tenants where id = new.tenant_id), 'Skyline'));
    v_subject := public.notification_render(v_tpl->>'subject', v_vars);
    v_body := public.notification_render(v_tpl->>'body', v_vars);
    v_addr := lower(btrim(coalesce(v_route->>'email', '')));
    v_valid := v_addr ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(v_addr) <= 254;
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, nullif(v_route->>'user', '')::uuid, left(v_addr, 254), new.event, v_source, v_id, v_sender, v_subject, v_body,
      case when not v_valid then 'suppressed' when v_active then 'pending' else 'suppressed' end,
      case when not v_valid then 'invalid_recipient' when v_active then null else 'legacy_scope_not_activated' end, clock_timestamp())
    on conflict do nothing;
    return new;
  end if;
  if new.event not in ('application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued') then return new; end if;
  select * into a from public.enrollment_applications where id = new.application_id;
  select id, config into v_id, v_cfg from public.tenant_config_versions where tenant_id = new.tenant_id and kind = 'notifications' and state = 'published';
  v_enabled := coalesce((v_cfg->'defaults'->>new.event)::boolean, (v_defaults->'defaults'->>new.event)::boolean, true);
  if not v_enabled then return new; end if;
  v_tpl := coalesce(v_cfg->'templates'->new.event, v_defaults->'templates'->new.event);
  v_sender := case when v_cfg->'sender' is not null and public.notification_sender_allowed(new.tenant_id, v_cfg->'sender'->>'email') then v_cfg->'sender' else null end;
  v_active := exists (select 1 from public.notification_activation act where act.revoked_at is null and act.tenant_id is not distinct from new.tenant_id);
  v_set := public.notification_event_settings(new.tenant_id, new.event);
  v_source := case when v_cfg is null then 'default' else 'published' end;
  v_vars := jsonb_build_object(
    'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
    'status', public.portal_status_label(coalesce(new.payload->>'to', a.status)),
    'previousStatus', public.portal_status_label(coalesce(new.payload->>'from', case when new.event = 'application_submitted' then 'draft' else '' end)),
    'institution', coalesce((select name from public.tenants where id = new.tenant_id), 'Skyline'));
  v_subject := public.notification_render(v_tpl->>'subject', v_vars);
  v_body := public.notification_render(v_tpl->>'body', v_vars);
  -- Portal users: the assigned agent and / or the agency admins, per the event settings; per-user opt-outs apply.
  for r in
    select p.auth_user_id, lower(trim(coalesce(p.email, ''))) as email from public.portal_profiles p
    where p.status = 'Active' and p.auth_user_id is not null
      and ((coalesce((v_set->>'notifyAgent')::boolean, false) and p.id = a.assigned_agent_id)
        or (coalesce((v_set->>'notifyAgencyAdmins')::boolean, false) and exists (select 1 from public.agency_memberships m where m.user_id = p.id and m.agency_id = a.agency_id and m.status = 'Active' and m.role = 'agency_admin')))
  loop
    -- A selected user without a usable address is recorded as a visible suppressed delivery, never skipped silently.
    if r.email = '' or length(r.email) > 254 or r.email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then
      insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
      values (new.id, new.tenant_id, new.application_id, r.auth_user_id, left(r.email, 254), new.event, v_source, v_id, v_sender, v_subject, v_body, 'suppressed', 'invalid_recipient', clock_timestamp())
      on conflict do nothing;
      continue;
    end if;
    v_pref := coalesce((select email_enabled from public.notification_preferences where auth_user_id = r.auth_user_id and event = new.event), true);
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, r.auth_user_id, r.email, new.event, v_source, v_id, v_sender, v_subject, v_body,
      case when v_active and v_pref then 'pending' else 'suppressed' end,
      case when not v_active then 'legacy_scope_not_activated' when v_pref then null else 'recipient_opted_out' end, clock_timestamp())
    on conflict do nothing;
  end loop;
  -- Recipients without a portal account: the configured internal addresses and, when enabled, the student. One delivery per address per event.
  v_state := case when v_active then 'pending' else 'suppressed' end;
  v_reason := case when v_active then null else 'legacy_scope_not_activated' end;
  if coalesce((v_set->>'notifyStudent')::boolean, false)
     and not (a.student_email ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(a.student_email) <= 254) then
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, null, left(lower(btrim(coalesce(a.student_email, ''))), 254), new.event, v_source, v_id, v_sender, v_subject, v_body, 'suppressed', 'invalid_recipient', clock_timestamp())
    on conflict do nothing;
  end if;
  for v_addr in
    select distinct x from (
      select lower(btrim(e)) as x from jsonb_array_elements_text(coalesce(v_set->'recipients', '[]'::jsonb)) e
      union all
      select lower(btrim(a.student_email)) where coalesce((v_set->>'notifyStudent')::boolean, false) and a.student_email ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' and length(a.student_email) <= 254
    ) s where x is not null and x <> ''
  loop
    if exists (select 1 from public.notification_deliveries d where d.outbox_id = new.id and lower(d.recipient_email) = v_addr) then continue; end if;
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (new.id, new.tenant_id, new.application_id, null, v_addr, new.event, v_source, v_id, v_sender, v_subject, v_body, v_state, v_reason, clock_timestamp())
    on conflict do nothing;
  end loop;
  return new;
end;
$function$;

create or replace function public.portal_notification_cc(p_application uuid, p_event text, p_emails text[]) returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; o public.admission_event_outbox; d public.notification_deliveries; v_default jsonb; v_allowed text[]; v_sent text[] := '{}'; e text; h uuid;
 v_host text; v_body text;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if p_event not in ('offer_letter_issued', 'coe_voe_issued') then raise exception 'No copy for %', p_event using errcode = '22023'; end if;
 v_default := public.application_cc_default(a.id);
 v_allowed := array_remove(array[nullif(v_default->>'agentEmail', ''), nullif(v_default->>'agencyEmail', '')], null);
 select * into o from public.admission_event_outbox x where x.application_id = a.id and x.event = p_event and x.created_at > now() - interval '10 minutes' order by x.created_at desc limit 1;
 if not found then raise exception 'There is no email to copy' using errcode = '22023'; end if;
 select * into d from public.notification_deliveries x where x.outbox_id = o.id order by x.created_at limit 1;
 if not found then raise exception 'There is no email to copy' using errcode = '22023'; end if;
 -- The copy of the student's offer email never carries the student's signing link (it is only made for the student's own delivery):
 -- the agent or agency gets the portal link instead.
 v_body := d.body;
 if d.signing then
  v_host := case when a.tenant_id is null then public.main_site_host() else (select min(t.hostname) from public.tenant_domains t where t.tenant_id = a.tenant_id and t.verified_at is not null) end;
  v_body := d.body || public.offer_letter_portal_note(case when v_host is null then '' else 'https://' || v_host || '/agency/applications/' || a.id::text end);
 end if;
 foreach e in array coalesce(p_emails, '{}') loop
  e := lower(btrim(e));
  -- Nobody gets the same email twice (the agent of an agent-started application already has their own copy).
  if e = '' or exists (select 1 from public.notification_deliveries y where y.outbox_id = o.id and lower(y.recipient_email) = e) then continue; end if;
  if not (e = any(v_allowed)) then raise exception '% is not the agent or agency of this application', e using errcode = '42501'; end if;
  insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
  values (o.id, d.tenant_id, d.application_id, null, e, d.event, d.template_source, d.template_version_id, d.sender, d.subject, v_body, d.state, d.state_reason, clock_timestamp())
  on conflict do nothing;
  v_sent := v_sent || e;
 end loop;
 if cardinality(v_sent) > 0 then
  -- The status change just made gets the copy on its history line; a resend (no status change) gets a line of its own.
  select x.id into h from public.enrollment_application_status_history x where x.application_id = a.id and x.created_at > now() - interval '10 minutes'
   and x.new_status = a.status order by x.created_at desc limit 1;
  if h is not null and not coalesce((o.payload->>'resend')::boolean, false) then
   update public.enrollment_application_status_history set note = left(concat_ws(' · ', nullif(note, ''), 'CC: ' || array_to_string(v_sent, ', ')), 1000) where id = h;
  else
   insert into public.enrollment_application_status_history(application_id, previous_status, new_status, actor, actor_name, actor_role, note, tenant_id, action_key)
   values (a.id, a.status, a.status, auth.uid(), coalesce(auth.jwt()->>'email', 'Reviewer'), 'slit_admin', left('Offer letter resent · CC: ' || array_to_string(v_sent, ', '), 1000), a.tenant_id, 'resend_offer');
  end if;
  update public.enrollment_offer_letters set cc_emails = (select array_agg(distinct x) from unnest(coalesce(cc_emails, '{}') || v_sent) x)
   where id = (select z.id from public.enrollment_offer_letters z where z.application_id = a.id order by z.issued_at desc limit 1) and p_event = 'offer_letter_issued';
 end if;
 return jsonb_build_object('cc', to_jsonb(v_sent));
end $$;
revoke all on function public.portal_notification_cc(uuid, text, text[]) from public, anon;
grant execute on function public.portal_notification_cc(uuid, text, text[]) to authenticated;

