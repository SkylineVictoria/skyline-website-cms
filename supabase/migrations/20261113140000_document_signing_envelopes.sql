-- Documents & Signatures, second stage (SIGN-02). LOCAL until the owner releases it. Additive on 20261110154917 and 20261113100000
-- (a request's staff member `profile_id`, the edited copy `edited` / `template_text`: kept, and a staff member becomes the request's employee):
--   * templates: PDF or text, audience, category, signer roles, field placements, versions, archive, soft delete
--   * a request is an envelope: several recipients (sequential or parallel, required or optional), placed fields per recipient
--   * every email carries its own link token (only the sha256 is stored); reminders, expiry, decline and completion mail are jobs
--     in hr.sign_notifications with a unique dedupe key, claimed with a lease (no duplicate sends)
--   * hr.sign_events is append-only and hash-chained (tamper detection); documents keep their sha256
--   * related record (student / employee / agent) for the module panels; variables are read from that record
-- Authorization is unchanged: CMS Admin through public.signing_admin, the service role through public.signing_service, and a
-- signed-in person only for requests addressed to their own confirmed email (public.signing_mine). No table is readable from a browser.
set local lock_timeout = '5s';

-- ------------------------------------------------------------------ templates
alter table hr.sign_templates
 add column kind text not null default 'text' check (kind in ('text','pdf')),
 add column audience text not null default 'any' check (audience in ('any','student','employee','agent')),
 add column category text not null default 'other' check (category in ('enrolment_agreement','consent_form','fee_agreement','employment_contract','offer_letter','hr_declaration','agency_agreement','commission_agreement','other')),
 add column status text not null default 'active' check (status in ('active','archived')),
 add column version integer not null default 1,
 add column source_path text,
 add column source_hash text check (source_hash ~ '^[a-f0-9]{64}$'),
 add column source_pages integer check (source_pages between 1 and 200),
 add column roles jsonb not null default '[{"key":"signer1","label":"Signer","order":1,"required":true}]'::jsonb,
 add column fields jsonb not null default '[]'::jsonb,
 add column signing_mode text not null default 'sequential' check (signing_mode in ('sequential','parallel')),
 add column expiry_days integer not null default 14 check (expiry_days between 1 and 365),
 add column reminder_days integer not null default 3 check (reminder_days between 0 and 60),
 add column deleted_at timestamptz,
 add column created_at timestamptz not null default now();
alter table hr.sign_templates alter column body drop not null;
alter table hr.sign_templates add constraint sign_templates_kind_source check (
 (kind = 'text' and body is not null) or
 (kind = 'pdf' and source_hash is not null and source_path is not null and source_path like 'templates/' || id::text || '/%'));

create table hr.sign_template_versions (
 template_id uuid not null references hr.sign_templates(id) on delete cascade,
 version integer not null,
 snapshot jsonb not null,
 created_by uuid,
 created_at timestamptz not null default now(),
 primary key (template_id, version)
);
insert into hr.sign_template_versions(template_id, version, snapshot, created_by, created_at)
 select t.id, 1, to_jsonb(t), t.created_by, t.updated_at from hr.sign_templates t;

-- ------------------------------------------------------------------ requests become envelopes
do $c$
declare c record;
begin
 for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'hr.sign_requests'::regclass and contype = 'c' loop
  if c.def like '%email_failed%' or c.def like '%signer_name IS NOT NULL%' then
   execute format('alter table hr.sign_requests drop constraint %I', c.conname);
  end if;
 end loop;
end $c$;
create sequence hr.sign_reference_seq;
alter table hr.sign_requests
 add column reference text unique,
 add column signing_mode text not null default 'sequential' check (signing_mode in ('sequential','parallel')),
 add column subject_type text check (subject_type in ('student','employee','agent')),
 add column subject_id uuid,
 add column tenant_id uuid,
 add column category text not null default 'other',
 add column template_version integer,
 add column expiry_days integer not null default 14 check (expiry_days between 1 and 365),
 add column reminder_days integer not null default 3 check (reminder_days between 0 and 60),
 add column message text check (message is null or length(message) <= 2000),
 add column revision integer not null default 0,
 add column current_path text,
 add column current_hash text check (current_hash ~ '^[a-f0-9]{64}$'),
 add column certificate_path text,
 add column certificate_hash text check (certificate_hash ~ '^[a-f0-9]{64}$'),
 add column sent_at timestamptz,
 add column completed_at timestamptz,
 add column expired_at timestamptz,
 add column closed_reason text check (closed_reason is null or length(closed_reason) <= 500),
 add constraint sign_requests_state_check check (state in ('draft','sending','sent','viewed','email_failed','partial','signed','declined','expired','void')),
 add constraint sign_requests_signed_check check ((state = 'signed') = (signed_path is not null and signed_hash is not null and signed_at is not null)),
 add constraint sign_requests_subject_check check ((subject_type is null) = (subject_id is null)),
 add constraint sign_requests_current_check check (current_path is null or current_path like id::text || '/signed-%.pdf'),
 add constraint sign_requests_certificate_check check (certificate_path is null or certificate_path like id::text || '/certificate-%.pdf');
update hr.sign_requests set reference = 'SLIT-' || to_char(created_at, 'YYYY') || '-' || lpad(nextval('hr.sign_reference_seq')::text, 6, '0') where reference is null;
alter table hr.sign_requests alter column reference set not null;
create index sign_requests_subject_idx on hr.sign_requests(subject_type, subject_id) where subject_id is not null;
create index sign_requests_open_idx on hr.sign_requests(expires_at) where state in ('sent','viewed','partial');

create table hr.sign_recipients (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references hr.sign_requests(id) on delete cascade,
 role_key text not null default 'signer1' check (role_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 role_label text not null default 'Signer' check (length(btrim(role_label)) between 1 and 80),
 name text not null check (length(btrim(name)) between 2 and 150),
 email text not null check (email = lower(email) and email ~ '^[^[:space:]<>@,]+@[^[:space:]<>@,]+\.[^[:space:]<>@,]+$'),
 signing_order integer not null default 1 check (signing_order between 1 and 50),
 required boolean not null default true,
 state text not null default 'pending' check (state in ('pending','sent','viewed','signed','declined','skipped')),
 sent_at timestamptz, viewed_at timestamptz, signed_at timestamptz, declined_at timestamptz,
 decline_reason text check (decline_reason is null or length(decline_reason) <= 500),
 signer_name text, consent text,
 signature_kind text check (signature_kind in ('typed','drawn','uploaded')),
 signature_image text check (signature_image is null or length(signature_image) <= 400000),
 signature_hash text check (signature_hash ~ '^[a-f0-9]{64}$'),
 ip text check (ip is null or length(ip) <= 64),
 user_agent text check (user_agent is null or length(user_agent) <= 400),
 delivery_error text,
 last_notified_at timestamptz,
 reminder_count integer not null default 0,
 unique (request_id, role_key),
 check ((state = 'signed') = (signed_at is not null and signer_name is not null and consent is not null and signature_kind is not null))
);
create index sign_recipients_request_idx on hr.sign_recipients(request_id, signing_order);
create index sign_recipients_email_idx on hr.sign_recipients(email);

create table hr.sign_fields (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references hr.sign_requests(id) on delete cascade,
 -- Every field belongs to one recipient. What the sender prints from a template (role "sender") is drawn into the document when the
 -- request is made, so it is part of the original everyone sees, not a field.
 recipient_id uuid not null references hr.sign_recipients(id) on delete cascade,
 type text not null check (type in ('signature','initials','date','name','text','checkbox')),
 page integer not null check (page between 1 and 200),
 x numeric not null check (x >= 0 and x <= 1), y numeric not null check (y >= 0 and y <= 1),
 w numeric not null check (w > 0 and w <= 1), h numeric not null check (h > 0 and h <= 1),
 required boolean not null default true,
 label text not null default '' check (length(label) <= 120),
 value text check (value is null or length(value) <= 500),
 filled_at timestamptz,
 check (x + w <= 1.0001 and y + h <= 1.0001)
);
create index sign_fields_request_idx on hr.sign_fields(request_id, page);

-- One row per emailed link; only the sha256 of the token is kept. Every email (invitation, reminder) has its own token, so an
-- earlier email keeps working. All of a request's tokens go when it is declined, voided or expired.
create table hr.sign_tokens (
 token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
 recipient_id uuid not null references hr.sign_recipients(id) on delete cascade,
 notification_id bigint,
 created_at timestamptz not null default now()
);
create index sign_tokens_recipient_idx on hr.sign_tokens(recipient_id);

create table hr.sign_notifications (
 id bigint generated always as identity primary key,
 request_id uuid not null references hr.sign_requests(id) on delete cascade,
 recipient_id uuid references hr.sign_recipients(id) on delete cascade,
 kind text not null check (kind in ('invite','reminder','expired','declined','voided','completed')),
 audience text not null default 'recipient' check (audience in ('recipient','admin')),
 dedupe_key text not null unique,
 state text not null default 'queued' check (state in ('queued','sending','sent','failed','cancelled')),
 attempts integer not null default 0,
 lease_until timestamptz,
 message_id text, error text,
 created_at timestamptz not null default now(),
 sent_at timestamptz
);
create index sign_notifications_due_idx on hr.sign_notifications(id) where state in ('queued','sending');
create index sign_notifications_request_idx on hr.sign_notifications(request_id, id);

-- ------------------------------------------------------------------ history: append-only and hash-chained
alter table hr.sign_events
 add column recipient_id uuid,
 add column detail jsonb not null default '{}'::jsonb,
 add column prev_hash text,
 add column hash text;
create function hr.sign_event_digest(p_prev text, p_request uuid, p_event text, p_recipient uuid, p_actor uuid, p_at timestamptz, p_detail jsonb) returns text
language sql immutable set search_path = pg_catalog as $f$
 select encode(sha256(convert_to(concat_ws('|', coalesce(p_prev, ''), p_request::text, p_event, coalesce(p_recipient::text, ''), coalesce(p_actor::text, ''),
  to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), coalesce(p_detail, '{}'::jsonb)::text), 'UTF8')), 'hex');
$f$;
do $b$
declare e record; v_prev text; v_request uuid; v_hash text;
begin
 for e in select * from hr.sign_events order by request_id, id loop
  if v_request is distinct from e.request_id then v_prev := null; v_request := e.request_id; end if;
  v_hash := hr.sign_event_digest(v_prev, e.request_id, e.event, e.recipient_id, e.actor_id, e.at, e.detail);
  update hr.sign_events set prev_hash = v_prev, hash = v_hash where id = e.id;
  v_prev := v_hash;
 end loop;
end $b$;
alter table hr.sign_events alter column hash set not null;
create function hr.sign_event_chain() returns trigger
language plpgsql set search_path = pg_catalog, hr as $f$
declare v_prev text;
begin
 if tg_op <> 'INSERT' then raise exception 'Signing history cannot be changed' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('hr.sign_events:' || new.request_id::text, 0));
 select e.hash into v_prev from hr.sign_events e where e.request_id = new.request_id order by e.id desc limit 1;
 new.at := clock_timestamp();
 new.detail := coalesce(new.detail, '{}'::jsonb);
 new.prev_hash := v_prev;
 new.hash := hr.sign_event_digest(v_prev, new.request_id, new.event, new.recipient_id, new.actor_id, new.at, new.detail);
 return new;
end $f$;
create trigger sign_events_chain before insert or update or delete on hr.sign_events for each row execute function hr.sign_event_chain();
create trigger sign_events_no_truncate before truncate on hr.sign_events for each statement execute function hr.sign_event_chain();

/** True when every event of the request still carries the hash of its content and of the event before it. */
create function hr.sign_chain_ok(p_request uuid) returns boolean
language plpgsql stable set search_path = pg_catalog, hr as $f$
declare e record; v_prev text;
begin
 for e in select * from hr.sign_events where request_id = p_request order by id loop
  if e.prev_hash is distinct from v_prev or e.hash is distinct from hr.sign_event_digest(v_prev, e.request_id, e.event, e.recipient_id, e.actor_id, e.at, e.detail) then return false; end if;
  v_prev := e.hash;
 end loop;
 return true;
end $f$;

alter table hr.sign_template_versions enable row level security;
alter table hr.sign_recipients enable row level security;
alter table hr.sign_fields enable row level security;
alter table hr.sign_tokens enable row level security;
alter table hr.sign_notifications enable row level security;
revoke all on hr.sign_template_versions, hr.sign_recipients, hr.sign_fields, hr.sign_tokens, hr.sign_notifications from public, anon, authenticated;
revoke all on sequence hr.sign_reference_seq from public, anon, authenticated;

-- ------------------------------------------------------------------ existing single-recipient requests > one recipient each
insert into hr.sign_recipients(request_id, name, email, state, sent_at, viewed_at, signed_at, signer_name, consent, signature_kind, delivery_error)
 select r.id, r.recipient_name, lower(r.recipient_email),
  case r.state when 'draft' then 'pending' when 'void' then 'pending' when 'signed' then 'signed' when 'declined' then 'declined' when 'viewed' then 'viewed' else 'sent' end,
  r.delivery_started_at, r.viewed_at, r.signed_at, r.signer_name, r.consent, case when r.state = 'signed' then 'typed' end, r.delivery_error
 from hr.sign_requests r;
insert into hr.sign_tokens(token_hash, recipient_id)
 select r.token_hash, c.id from hr.sign_requests r join hr.sign_recipients c on c.request_id = r.id where r.token_hash is not null;
update hr.sign_requests set state = 'sent' where state in ('sending','email_failed');
update hr.sign_requests set current_path = signed_path, current_hash = signed_hash, completed_at = signed_at where state = 'signed';
update hr.sign_requests set subject_type = 'employee', subject_id = profile_id where profile_id is not null and subject_id is null;

-- The bucket also holds template source PDFs; still private, still PDF only, no browser policies.
update storage.buckets set file_size_limit = 8388608, allowed_mime_types = array['application/pdf'] where id = 'signing-documents';

-- ------------------------------------------------------------------ helpers
create function hr.sign_event(p_request uuid, p_event text, p_recipient uuid default null, p_actor uuid default null, p_detail jsonb default '{}') returns void
language sql set search_path = pg_catalog, hr as $f$
 insert into hr.sign_events(request_id, event, recipient_id, actor_id, detail) values (p_request, p_event, p_recipient, p_actor, coalesce(p_detail, '{}'::jsonb));
$f$;
create function hr.sign_queue(p_request uuid, p_recipient uuid, p_kind text, p_key text, p_audience text default 'recipient') returns void
language sql set search_path = pg_catalog, hr as $f$
 insert into hr.sign_notifications(request_id, recipient_id, kind, audience, dedupe_key) values (p_request, p_recipient, p_kind, p_audience, p_key)
  on conflict (dedupe_key) do nothing;
$f$;
/** Stops everything that would still invite or remind (called when a request closes), and optionally its links. */
create function hr.sign_stop(p_request uuid, p_drop_links boolean) returns void
language plpgsql set search_path = pg_catalog, hr as $f$
begin
 update hr.sign_notifications set state = 'cancelled', lease_until = null where request_id = p_request and kind in ('invite','reminder') and state in ('queued','sending');
 delete from hr.sign_tokens t using hr.sign_notifications n where n.id = t.notification_id and n.request_id = p_request and n.state = 'cancelled';
 if p_drop_links then
  delete from hr.sign_tokens t using hr.sign_recipients c where c.id = t.recipient_id and c.request_id = p_request;
 end if;
end $f$;
/** Invites whoever may sign now: everyone (parallel), or everyone up to the lowest order that still has a required signer waiting. */
create function hr.sign_activate(p_request uuid) returns integer
language plpgsql set search_path = pg_catalog, hr as $f$
declare r hr.sign_requests; c hr.sign_recipients; v_order integer; n integer := 0;
begin
 select * into r from hr.sign_requests where id = p_request;
 if r.signing_mode = 'parallel' then v_order := 50;
 else select min(signing_order) into v_order from hr.sign_recipients where request_id = p_request and required and state in ('pending','sent','viewed'); end if;
 if v_order is null then return 0; end if;
 for c in select * from hr.sign_recipients where request_id = p_request and state = 'pending' and signing_order <= v_order order by signing_order, id loop
  update hr.sign_recipients set state = 'sent', sent_at = now(), last_notified_at = now() where id = c.id;
  perform hr.sign_queue(p_request, c.id, 'invite', 'invite:' || c.id || ':1');
  perform hr.sign_event(p_request, 'recipient_invited', c.id, null, jsonb_build_object('email', c.email, 'order', c.signing_order));
  n := n + 1;
 end loop;
 return n;
end $f$;
/** Roles of a template: 1 to 10, unique lowercase keys. */
create function hr.sign_roles(p_roles jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $f$
declare v jsonb; out jsonb := '[]'::jsonb; keys text[] := '{}'; k text; i integer := 0;
begin
 if p_roles is null or jsonb_typeof(p_roles) <> 'array' or jsonb_array_length(p_roles) = 0 then
  return '[{"key":"signer1","label":"Signer","order":1,"required":true}]'::jsonb;
 end if;
 if jsonb_array_length(p_roles) > 10 then raise exception 'Use no more than 10 signers'; end if;
 for v in select * from jsonb_array_elements(p_roles) loop
  i := i + 1; k := coalesce(nullif(v->>'key', ''), 'signer' || i);
  if k !~ '^[a-z][a-z0-9_]{0,39}$' or k = any(keys) then raise exception 'Signer roles need unique names'; end if;
  if length(btrim(coalesce(v->>'label', ''))) not between 1 and 80 then raise exception 'Give every signer role a name'; end if;
  keys := keys || k;
  out := out || jsonb_build_object('key', k, 'label', btrim(v->>'label'), 'order', least(greatest(coalesce((v->>'order')::integer, i), 1), 50), 'required', coalesce((v->>'required')::boolean, true));
 end loop;
 if not exists (select 1 from jsonb_array_elements(out) x where (x->>'required')::boolean) then raise exception 'At least one signer must be required'; end if;
 return out;
end $f$;
/** Field placements of a template, checked: known type, a role of the template (or "sender"), a box inside the page. */
create function hr.sign_template_fields(p_fields jsonb, p_roles jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $f$
declare v jsonb; out jsonb := '[]'::jsonb;
begin
 if p_fields is null or jsonb_typeof(p_fields) <> 'array' then return '[]'::jsonb; end if;
 if jsonb_array_length(p_fields) > 200 then raise exception 'Use no more than 200 fields'; end if;
 for v in select * from jsonb_array_elements(p_fields) loop
  if coalesce(v->>'type', '') not in ('signature','initials','date','name','text','checkbox') then raise exception 'Unknown field type'; end if;
  if coalesce(v->>'role', '') <> 'sender' and not exists (select 1 from jsonb_array_elements(p_roles) x where x->>'key' = v->>'role') then raise exception 'Every field must belong to a signer'; end if;
  if v->>'role' = 'sender' and v->>'type' <> 'text' then raise exception 'Only a text field can be filled by the sender'; end if;
  if (v->>'page')::integer not between 1 and 200 or (v->>'x')::numeric < 0 or (v->>'y')::numeric < 0 or (v->>'w')::numeric <= 0 or (v->>'h')::numeric <= 0
   or (v->>'x')::numeric + (v->>'w')::numeric > 1.0001 or (v->>'y')::numeric + (v->>'h')::numeric > 1.0001 then raise exception 'A field is outside its page'; end if;
  out := out || jsonb_build_object('type', v->>'type', 'role', v->>'role', 'page', (v->>'page')::integer, 'x', (v->>'x')::numeric, 'y', (v->>'y')::numeric,
   'w', (v->>'w')::numeric, 'h', (v->>'h')::numeric, 'required', coalesce((v->>'required')::boolean, true), 'label', left(coalesce(v->>'label', ''), 120), 'value', left(coalesce(v->>'value', ''), 500));
 end loop;
 return out;
end $f$;

/** What a list shows for a request: the stored state, with "expired" as soon as the date has passed. */
create function hr.sign_status(r hr.sign_requests) returns text
language sql stable set search_path = pg_catalog as $f$
 select case when r.state in ('sent','viewed','partial') and r.expires_at is not null and r.expires_at <= now() then 'expired'
  when r.state in ('sending','email_failed') then 'sent' else r.state end;
$f$;
create function hr.sign_request_json(r hr.sign_requests) returns jsonb
language sql stable set search_path = pg_catalog, hr as $f$
 select (to_jsonb(r) - 'token_hash' - 'field_values' - 'rendered_text' - 'template_text') || jsonb_build_object('status', hr.sign_status(r),
  'recipients', coalesce((select jsonb_agg(to_jsonb(c) - 'signature_image' order by c.signing_order, c.id) from hr.sign_recipients c where c.request_id = r.id), '[]'::jsonb));
$f$;

-- ------------------------------------------------------------------ variables from the related record
-- Read through to_jsonb so a column added or dropped later never breaks the function; a value that does not exist is ''.
create function hr.sign_subject(p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare j jsonb; d jsonb; e jsonb; b jsonb; a jsonb; v_name text; v_first text; v_last text; v_address text; v_course jsonb; out jsonb;
 v_today text := to_char(now() at time zone 'Australia/Melbourne', 'FMDD FMMonth YYYY');
begin
 if p_type = 'student' and to_regclass('public.enrollment_students') is not null then
  execute 'select to_jsonb(s) from public.enrollment_students s where s.id = $1' into j using p_id;
  if j is null then raise exception 'Student not found'; end if;
  d := case when jsonb_typeof(j->'details') = 'object' then j->'details' else '{}'::jsonb end;
  v_name := btrim(coalesce(j->>'full_name', ''));
  v_first := coalesce(nullif(btrim(coalesce(d->>'first_name', '')), ''), split_part(v_name, ' ', 1));
  v_last := coalesce(nullif(btrim(coalesce(d->>'last_name', '')), ''), nullif(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), ''), '');
  v_address := array_to_string(array_remove(array[nullif(btrim(coalesce(d->>'au_street', d->>'ov_street', '')), ''), nullif(btrim(coalesce(d->>'au_suburb', d->>'ov_city', '')), ''),
   nullif(btrim(coalesce(d->>'au_state', d->>'ov_state', '')), ''), nullif(btrim(coalesce(d->>'au_postcode', d->>'ov_postcode', '')), ''), nullif(btrim(coalesce(d->>'ov_country', '')), '')], null), ', ');
  if to_regclass('public.enrollment_applications') is not null and to_regclass('public.enrollment_application_courses') is not null then
   execute 'select jsonb_build_object(''name'', c.course_title, ''code'', c.course_code, ''id'', c.course_id) from public.enrollment_application_courses c
     join public.enrollment_applications ap on ap.id = c.application_id where ap.student_id = $1 order by ap.created_at desc, c.created_at limit 1' into v_course using p_id;
  end if;
  if v_course is not null and to_regclass('public.cms_courses') is not null then
   execute 'select $1 || jsonb_build_object(''fees'', k.fees, ''duration'', k.duration, ''cricos'', k.cricos) from public.cms_courses k where k.id = $2 or (k.code <> '''' and k.code = $3) limit 1'
    into a using v_course, v_course->>'id', v_course->>'code';
   v_course := coalesce(a, v_course);
  end if;
  out := jsonb_build_object('name', coalesce(nullif(v_name, ''), btrim(v_first || ' ' || v_last)), 'email', lower(coalesce(j->>'email', '')), 'tenant_id', j->>'tenant_id', 'values', jsonb_build_object(
   'student.first_name', v_first, 'student.last_name', v_last, 'student.full_name', coalesce(nullif(v_name, ''), btrim(v_first || ' ' || v_last)), 'student.email', coalesce(j->>'email', ''),
   'student.phone', coalesce(j->>'phone', d->>'mobile', ''), 'student.address', v_address, 'student.date_of_birth', coalesce(j->>'date_of_birth', d->>'dob', ''),
   'student.passport_number', coalesce(nullif(j->>'passport_number', ''), d->>'passport_number', ''), 'student.nationality', coalesce(nullif(j->>'nationality', ''), d->>'nationality', ''),
   'course.name', coalesce(v_course->>'name', ''), 'course.code', coalesce(v_course->>'code', ''), 'course.fees', coalesce(v_course->>'fees', ''),
   'course.duration', coalesce(v_course->>'duration', ''), 'course.cricos', coalesce(v_course->>'cricos', '')));
 elsif p_type = 'employee' then
  select to_jsonb(p) into j from hr.staff_profiles p where p.id = p_id;
  if j is null then raise exception 'Employee not found'; end if;
  if to_regclass('hr.employment') is not null then execute 'select to_jsonb(x) from hr.employment x where x.profile_id = $1' into e using p_id; end if;
  e := coalesce(e, '{}'::jsonb);
  v_name := btrim(regexp_replace(concat_ws(' ', j->>'first_name', j->>'middle_name', j->>'last_name'), '\s+', ' ', 'g'));
  v_address := array_to_string(array_remove(array[nullif(btrim(coalesce(j->>'address_street', '')), ''), nullif(btrim(coalesce(j->>'address_line2', '')), ''), nullif(btrim(coalesce(j->>'address_suburb', '')), ''),
   nullif(btrim(coalesce(j->>'address_state', '')), ''), nullif(btrim(coalesce(j->>'address_postcode', '')), ''), nullif(btrim(coalesce(j->>'address_country', '')), '')], null), ', ');
  out := jsonb_build_object('name', v_name, 'email', lower(coalesce(j->>'email', '')), 'values', jsonb_build_object(
   'employee.name', v_name, 'employee.first_name', coalesce(j->>'first_name', ''), 'employee.last_name', coalesce(j->>'last_name', ''), 'employee.email', coalesce(j->>'email', ''),
   'employee.phone', coalesce(j->>'phone_e164', ''), 'employee.address', v_address, 'employee.position', coalesce(e->>'job_title', ''), 'employee.department', coalesce(e->>'department', ''),
   'employee.employment_type', replace(coalesce(e->>'employment_type', ''), '_', ' '), 'employee.start_date', coalesce(e->>'joining_date', ''), 'employee.work_location', coalesce(e->>'work_location', '')));
 elsif p_type = 'agent' and to_regclass('public.agents') is not null then
  execute 'select to_jsonb(g) from public.agents g where g.id = $1' into j using p_id;
  if j is null then raise exception 'Agent not found'; end if;
  if to_regclass('public.agencies') is not null then execute 'select to_jsonb(x) from public.agencies x where x.id = $1' into b using (j->>'business_id')::uuid; end if;
  b := coalesce(b, '{}'::jsonb);
  out := jsonb_build_object('name', coalesce(j->>'full_name', ''), 'email', lower(coalesce(j->>'email', '')), 'values', jsonb_build_object(
   'agent.name', coalesce(j->>'full_name', ''), 'agent.email', coalesce(j->>'email', ''), 'agent.phone', coalesce(j->>'phone', ''), 'agent.marn', coalesce(j->>'marn', ''),
   'agency.name', coalesce(b->>'name', b->>'legal_name', ''), 'agency.abn', coalesce(b->>'registration_number', ''), 'agency.email', coalesce(b->>'email', ''), 'agency.phone', coalesce(b->>'phone', '')));
 else raise exception 'Choose a student, an employee or an agent';
 end if;
 return jsonb_set(out, '{values}', (out->'values') || jsonb_build_object('current_date', v_today));
end $f$;
revoke all on function hr.sign_subject(text, uuid) from public, anon, authenticated;

create function hr.sign_subject_search(p_type text, p_query text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare q text := '%' || replace(replace(lower(btrim(coalesce(p_query, ''))), '%', ''), '_', '\_') || '%'; out jsonb;
begin
 if p_type = 'student' and to_regclass('public.enrollment_students') is not null then
  execute 'select jsonb_agg(x) from (select s.id, s.full_name as name, coalesce(s.email, '''') as email from public.enrollment_students s
    where lower(s.full_name) like $1 or lower(coalesce(s.email, '''')) like $1 order by s.full_name limit 20) x' into out using q;
 elsif p_type = 'employee' then
  select jsonb_agg(x) into out from (select p.id, btrim(p.first_name || ' ' || p.last_name) as name, p.email from hr.staff_profiles p
   where lower(p.first_name || ' ' || p.last_name) like q or lower(coalesce(p.email, '')) like q order by p.first_name, p.last_name limit 20) x;
 elsif p_type = 'agent' and to_regclass('public.agents') is not null then
  execute 'select jsonb_agg(x) from (select g.id, g.full_name as name, g.email from public.agents g
    where lower(g.full_name) like $1 or lower(g.email) like $1 order by g.full_name limit 20) x' into out using q;
 end if;
 return coalesce(out, '[]'::jsonb);
end $f$;
revoke all on function hr.sign_subject_search(text, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ admin
create or replace function public.signing_admin(p_action text, p_id uuid default null, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare v_admin uuid := hr.require_admin(); r hr.sign_requests; t hr.sign_templates; c hr.sign_recipients; v jsonb; v_roles jsonb; v_subject jsonb;
 v_id uuid; v_first jsonb; v_n integer; v_snapshot jsonb;
begin
 p_data := coalesce(p_data, '{}'::jsonb);
 if p_action = 'list' then
  return jsonb_build_object(
   'templates', coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from hr.sign_templates x where x.deleted_at is null), '[]'::jsonb),
   'requests', coalesce((select jsonb_agg(hr.sign_request_json(x) order by x.created_at desc) from hr.sign_requests x where x.id in (select q.id from hr.sign_requests q order by q.created_at desc limit 500)), '[]'::jsonb));
 elsif p_action = 'subject_search' then
  return hr.sign_subject_search(p_data->>'type', p_data->>'query');
 elsif p_action = 'subject_values' then
  return hr.sign_subject(p_data->>'type', p_id);
 elsif p_action = 'subject_list' then
  return coalesce((select jsonb_agg(hr.sign_request_json(x) order by x.created_at desc) from hr.sign_requests x where x.subject_type = p_data->>'type' and x.subject_id = p_id), '[]'::jsonb);
 elsif p_action = 'template_save' then
  v_roles := hr.sign_roles(p_data->'roles');
  select * into t from hr.sign_templates where id = p_id and deleted_at is null for update;
  if not found then
   insert into hr.sign_templates(id, name, title, body, kind, audience, category, roles, fields, signing_mode, expiry_days, reminder_days, source_path, source_hash, source_pages, created_by)
    values (coalesce(p_id, gen_random_uuid()), p_data->>'name', p_data->>'title', p_data->>'body', coalesce(p_data->>'kind', 'text'), coalesce(p_data->>'audience', 'any'),
     coalesce(p_data->>'category', 'other'), v_roles, hr.sign_template_fields(p_data->'fields', v_roles), coalesce(p_data->>'signing_mode', 'sequential'),
     coalesce((p_data->>'expiry_days')::integer, 14), coalesce((p_data->>'reminder_days')::integer, 3), p_data->>'source_path', p_data->>'source_hash', (p_data->>'source_pages')::integer, v_admin)
    returning * into t;
  else
   update hr.sign_templates set name = p_data->>'name', title = p_data->>'title', body = case when kind = 'text' then p_data->>'body' else body end,
    audience = coalesce(p_data->>'audience', audience), category = coalesce(p_data->>'category', category), roles = v_roles,
    fields = hr.sign_template_fields(coalesce(p_data->'fields', fields), v_roles), signing_mode = coalesce(p_data->>'signing_mode', signing_mode),
    expiry_days = coalesce((p_data->>'expiry_days')::integer, expiry_days), reminder_days = coalesce((p_data->>'reminder_days')::integer, reminder_days),
    source_path = coalesce(p_data->>'source_path', source_path), source_hash = coalesce(p_data->>'source_hash', source_hash),
    source_pages = coalesce((p_data->>'source_pages')::integer, source_pages), version = version + 1, updated_at = now() where id = p_id returning * into t;
  end if;
  insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
  return to_jsonb(t);
 elsif p_action in ('template_duplicate','template_archive','template_delete','template_versions','template_restore') then
  select * into t from hr.sign_templates where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Template not found'; end if;
  if p_action = 'template_versions' then
   return coalesce((select jsonb_agg(jsonb_build_object('version', x.version, 'created_at', x.created_at, 'name', x.snapshot->>'name', 'title', x.snapshot->>'title') order by x.version desc)
    from hr.sign_template_versions x where x.template_id = p_id), '[]'::jsonb);
  elsif p_action = 'template_archive' then
   update hr.sign_templates set status = case when status = 'active' then 'archived' else 'active' end, updated_at = now() where id = p_id returning * into t;
  elsif p_action = 'template_delete' then
   -- Requests keep their own fixed copy, so a deleted template only leaves the lists; its history stays for the requests made from it.
   update hr.sign_templates set deleted_at = now(), status = 'archived' where id = p_id returning * into t;
  elsif p_action = 'template_restore' then
   select snapshot into v_snapshot from hr.sign_template_versions where template_id = p_id and version = (p_data->>'version')::integer;
   if v_snapshot is null then raise exception 'Version not found'; end if;
   update hr.sign_templates set name = v_snapshot->>'name', title = v_snapshot->>'title', body = v_snapshot->>'body', audience = coalesce(v_snapshot->>'audience', audience),
    category = coalesce(v_snapshot->>'category', category), roles = coalesce(v_snapshot->'roles', roles), fields = coalesce(v_snapshot->'fields', fields),
    signing_mode = coalesce(v_snapshot->>'signing_mode', signing_mode), expiry_days = coalesce((v_snapshot->>'expiry_days')::integer, expiry_days),
    reminder_days = coalesce((v_snapshot->>'reminder_days')::integer, reminder_days), source_path = coalesce(v_snapshot->>'source_path', source_path),
    source_hash = coalesce(v_snapshot->>'source_hash', source_hash), source_pages = coalesce((v_snapshot->>'source_pages')::integer, source_pages),
    version = version + 1, updated_at = now() where id = p_id returning * into t;
   insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
  else
   -- A copy of a PDF template shares nothing: the function copies the file first and passes the new id and path.
   v_id := coalesce((p_data->>'new_id')::uuid, gen_random_uuid());
   insert into hr.sign_templates(id, name, title, body, kind, audience, category, roles, fields, signing_mode, expiry_days, reminder_days, source_path, source_hash, source_pages, created_by)
    values (v_id, left(t.name || ' (copy)', 120), t.title, t.body, t.kind, t.audience, t.category, t.roles, t.fields, t.signing_mode, t.expiry_days, t.reminder_days,
     case when t.kind = 'pdf' then p_data->>'source_path' end, t.source_hash, t.source_pages, v_admin) returning * into t;
   insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, 1, to_jsonb(t), v_admin);
  end if;
  return to_jsonb(t);
 elsif p_action = 'create' then
  -- The first-stage form (one recipient_name / recipient_email, 20261110154917 and 20261113100000) is one recipient.
  if p_data->'recipients' is null and p_data ? 'recipient_email' then
   p_data := p_data || jsonb_build_object('recipients', jsonb_build_array(jsonb_build_object('name', p_data->>'recipient_name', 'email', p_data->>'recipient_email')));
  end if;
  -- A staff member (20261113100000) is the request's employee.
  if nullif(p_data->>'profile_id', '') is not null then
   if not exists (select 1 from hr.staff_profiles where id = (p_data->>'profile_id')::uuid) then raise exception 'Staff member not found'; end if;
   if p_data->>'subject_type' is null then p_data := p_data || jsonb_build_object('subject_type', 'employee', 'subject_id', p_data->>'profile_id'); end if;
  end if;
  if jsonb_typeof(p_data->'recipients') <> 'array' or jsonb_array_length(p_data->'recipients') not between 1 and 10 then raise exception 'Add between 1 and 10 recipients'; end if;
  if not exists (select 1 from jsonb_array_elements(p_data->'recipients') x where coalesce((x->>'required')::boolean, true)) then raise exception 'At least one recipient must be required'; end if;
  v_first := p_data->'recipients'->0;
  if p_data->>'subject_type' is not null then v_subject := hr.sign_subject(p_data->>'subject_type', (p_data->>'subject_id')::uuid); end if;
  insert into hr.sign_requests(id, reference, title, recipient_name, recipient_email, template_id, template_version, rendered_text, field_values, original_path, original_hash, created_by,
    signing_mode, subject_type, subject_id, tenant_id, category, expiry_days, reminder_days, message, profile_id, edited, template_text)
   values (p_id, 'SLIT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('hr.sign_reference_seq')::text, 6, '0'), p_data->>'title', btrim(v_first->>'name'), lower(btrim(v_first->>'email')),
    (p_data->>'template_id')::uuid, (select version from hr.sign_templates where id = (p_data->>'template_id')::uuid), p_data->>'rendered_text', coalesce(p_data->'field_values', '{}'::jsonb),
    p_id::text || '/original.pdf', p_data->>'original_hash', v_admin, coalesce(p_data->>'signing_mode', 'sequential'), p_data->>'subject_type', (p_data->>'subject_id')::uuid,
    (v_subject->>'tenant_id')::uuid, coalesce(p_data->>'category', 'other'), coalesce((p_data->>'expiry_days')::integer, 14), coalesce((p_data->>'reminder_days')::integer, 3),
    nullif(btrim(coalesce(p_data->>'message', '')), ''),
    case when p_data->>'subject_type' = 'employee' then (p_data->>'subject_id')::uuid end, coalesce((p_data->>'edited')::boolean, false),
    case when coalesce((p_data->>'edited')::boolean, false) then p_data->>'template_text' end) returning * into r;
  v_n := 0;
  for v in select * from jsonb_array_elements(p_data->'recipients') loop
   v_n := v_n + 1;
   insert into hr.sign_recipients(request_id, role_key, role_label, name, email, signing_order, required)
    values (p_id, coalesce(nullif(v->>'role', ''), 'signer' || v_n), coalesce(nullif(btrim(coalesce(v->>'label', '')), ''), 'Signer ' || v_n), btrim(v->>'name'), lower(btrim(v->>'email')),
     coalesce((v->>'order')::integer, v_n), coalesce((v->>'required')::boolean, true));
  end loop;
  for v in select * from jsonb_array_elements(coalesce(p_data->'fields', '[]'::jsonb)) loop
   insert into hr.sign_fields(request_id, recipient_id, type, page, x, y, w, h, required, label)
    select k.request_id, k.id, v->>'type', (v->>'page')::integer, (v->>'x')::numeric, (v->>'y')::numeric,
     (v->>'w')::numeric, (v->>'h')::numeric, coalesce((v->>'required')::boolean, true), left(coalesce(v->>'label', ''), 120)
    from hr.sign_recipients k where k.request_id = p_id and k.role_key = v->>'role';
  end loop;
  perform hr.sign_event(p_id, 'created', null, v_admin, jsonb_build_object('original_hash', r.original_hash, 'recipients', v_n));
  return hr.sign_request_json(r);
 end if;

 select * into r from hr.sign_requests where id = p_id for update;
 if not found then raise exception 'Signing request not found'; end if;
 if p_action = 'detail' then
  return hr.sign_request_json(r) || jsonb_build_object(
   'fields', coalesce((select jsonb_agg(to_jsonb(f) order by f.page, f.y, f.x) from hr.sign_fields f where f.request_id = p_id), '[]'::jsonb),
   'events', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object('recipient_name', (select name from hr.sign_recipients where id = e.recipient_id)) order by e.id) from hr.sign_events e where e.request_id = p_id), '[]'::jsonb),
   'notifications', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'audience', n.audience, 'state', n.state, 'recipient_id', n.recipient_id, 'created_at', n.created_at, 'sent_at', n.sent_at, 'error', n.error) order by n.id)
     from hr.sign_notifications n where n.request_id = p_id), '[]'::jsonb),
   'chain_ok', hr.sign_chain_ok(p_id));
 elsif p_action = 'fields_save' then
  if r.state <> 'draft' then raise exception 'Fields can only be changed while the request is a draft'; end if;
  if jsonb_typeof(p_data->'fields') <> 'array' or jsonb_array_length(p_data->'fields') > 200 then raise exception 'Use no more than 200 fields'; end if;
  delete from hr.sign_fields where request_id = p_id;
  for v in select * from jsonb_array_elements(p_data->'fields') loop
   if v->>'recipient_id' is null or not exists (select 1 from hr.sign_recipients where id = (v->>'recipient_id')::uuid and request_id = p_id) then
    raise exception 'Every field must belong to a recipient of this request';
   end if;
   insert into hr.sign_fields(request_id, recipient_id, type, page, x, y, w, h, required, label)
    values (p_id, (v->>'recipient_id')::uuid, v->>'type', (v->>'page')::integer, (v->>'x')::numeric, (v->>'y')::numeric, (v->>'w')::numeric, (v->>'h')::numeric,
     coalesce((v->>'required')::boolean, true), left(coalesce(v->>'label', ''), 120));
  end loop;
  perform hr.sign_event(p_id, 'fields_changed', null, v_admin, jsonb_build_object('fields', jsonb_array_length(p_data->'fields')));
 elsif p_action = 'send' then
  if r.state <> 'draft' then raise exception 'This request has already been sent'; end if;
  update hr.sign_requests set state = 'sent', sent_at = now(), expires_at = now() + make_interval(days => expiry_days) where id = p_id returning * into r;
  perform hr.sign_event(p_id, 'sent', null, v_admin, jsonb_build_object('mode', r.signing_mode, 'expires_at', r.expires_at));
  perform hr.sign_activate(p_id);
 elsif p_action = 'resend' then
  if hr.sign_status(r) not in ('sent','viewed','partial') then raise exception 'This request is not waiting for a signature'; end if;
  select * into c from hr.sign_recipients where id = (p_data->>'recipient_id')::uuid and request_id = p_id for update;
  if not found or c.state not in ('sent','viewed') then raise exception 'This recipient is not waiting to sign'; end if;
  -- One email per press: the key carries the number of emails already made for this recipient.
  perform hr.sign_queue(p_id, c.id, 'invite', 'invite:' || c.id || ':' || (1 + (select count(*) from hr.sign_notifications where recipient_id = c.id and kind = 'invite')));
  update hr.sign_recipients set last_notified_at = now(), delivery_error = null where id = c.id;
  perform hr.sign_event(p_id, 'resent', c.id, v_admin);
 elsif p_action = 'void' then
  if r.state in ('signed','declined','void','expired') then raise exception 'This request is closed'; end if;
  update hr.sign_requests set state = 'void', token_hash = null, closed_reason = nullif(left(btrim(coalesce(p_data->>'reason', '')), 500), '') where id = p_id returning * into r;
  perform hr.sign_stop(p_id, true);
  for c in select * from hr.sign_recipients where request_id = p_id and state in ('sent','viewed','signed') loop
   perform hr.sign_queue(p_id, c.id, 'voided', 'voided:' || c.id);
  end loop;
  perform hr.sign_event(p_id, 'voided', null, v_admin, jsonb_build_object('reason', r.closed_reason));
 elsif p_action = 'delete_draft' then
  if r.state <> 'draft' then raise exception 'Only a draft can be deleted'; end if;
  update hr.sign_requests set state = 'void', closed_reason = 'Draft discarded' where id = p_id returning * into r;
  perform hr.sign_event(p_id, 'draft_discarded', null, v_admin);
 else raise exception 'Unknown signing action'; end if;
 return hr.sign_request_json(r);
end $f$;
revoke all on function public.signing_admin(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.signing_admin(text, uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ service (the Edge Function only)
create or replace function public.signing_service(p_action text, p_hash text default null, p_id uuid default null, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare r hr.sign_requests; c hr.sign_recipients; x hr.sign_recipients; n record; f record; v_out jsonb := '[]'::jsonb; v_token text; v_values jsonb; v_key text;
 v_complete boolean; v_kind text; v_now timestamptz := now(); v_count integer := 0; v_reminders integer := 0; v_date text;
 k_consent constant text := 'I have read this document and agree to its contents. I consent to sign it electronically and adopt the signature I provide here as my electronic signature.';
begin
 p_data := coalesce(p_data, '{}'::jsonb);
 if p_action = 'path_referenced' then
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
 elsif p_action in ('sign_plan','sign') then
  if c.state = 'signed' then raise exception 'You have already signed this document'; end if;
  if r.state = 'signed' then raise exception 'This document is already complete'; end if;
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
   if not exists (select 1 from hr.sign_fields q where q.id::text = v_key and q.request_id = r.id and q.recipient_id = c.id and q.type in ('text','checkbox')) then
    raise exception 'You can only fill in your own fields' using errcode = '42501';
   end if;
  end loop;
  v_date := to_char(v_now at time zone 'Australia/Melbourne', 'DD/MM/YYYY');
  for f in select * from hr.sign_fields q where q.request_id = r.id and q.recipient_id = c.id loop
   if f.type = 'text' and (length(coalesce(v_values->>f.id::text, '')) > 500 or v_values->>f.id::text ~ '[[:cntrl:]]') then raise exception 'A text field is too long'; end if;
   if f.type = 'checkbox' and coalesce(v_values->>f.id::text, 'false') not in ('true','false') then raise exception 'Tick or clear each checkbox'; end if;
   if f.required and ((f.type = 'text' and btrim(coalesce(v_values->>f.id::text, '')) = '') or (f.type = 'checkbox' and coalesce(v_values->>f.id::text, 'false') <> 'true')) then
    raise exception 'Complete every required field before signing';
   end if;
  end loop;
  v_complete := not exists (select 1 from hr.sign_recipients k where k.request_id = r.id and k.id <> c.id and k.required and k.state in ('pending','sent','viewed'));
  if p_action = 'sign_plan' then
   -- Nothing is written: the function gets what the page will look like once this person has signed, and renders the PDF from the original.
   return jsonb_build_object('id', r.id, 'reference', r.reference, 'title', r.title, 'revision', r.revision, 'complete', v_complete, 'signed_at', v_now,
    'original_path', r.original_path, 'original_hash', r.original_hash, 'created_at', r.created_at, 'sent_at', r.sent_at, 'signing_mode', r.signing_mode,
    'recipient_id', c.id, 'chain_ok', hr.sign_chain_ok(r.id),
    'fields', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'recipient_id', q.recipient_id, 'type', q.type, 'page', q.page, 'x', q.x, 'y', q.y, 'w', q.w, 'h', q.h,
      'value', case when q.recipient_id = c.id then case q.type when 'text' then btrim(coalesce(v_values->>q.id::text, '')) when 'checkbox' then coalesce(v_values->>q.id::text, 'false')
        when 'date' then v_date when 'name' then btrim(p_data->>'signer_name') else '' end else q.value end,
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
  update hr.sign_fields q set filled_at = v_now, value = case q.type when 'text' then btrim(coalesce(v_values->>q.id::text, '')) when 'checkbox' then coalesce(v_values->>q.id::text, 'false')
    when 'date' then v_date when 'name' then btrim(p_data->>'signer_name') else 'signed' end where q.request_id = r.id and q.recipient_id = c.id;
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
  else
   update hr.sign_requests set state = 'partial', revision = revision + 1, current_path = p_data->>'current_path', current_hash = p_data->>'current_hash' where id = r.id returning * into r;
   perform hr.sign_activate(r.id); -- sequential: the next signer is invited now
  end if;
 elsif p_action = 'decline' then
  if c.state = 'signed' or r.state = 'signed' then raise exception 'This document is already signed'; end if;
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

-- ------------------------------------------------------------------ a signed-in person's own requests (students, staff, agents)
-- Only requests addressed to the caller's own CONFIRMED email. "token" makes a fresh personal link, so the same signing page is used.
create function public.signing_mine(p_action text default 'list', p_id uuid default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare v_email text; c hr.sign_recipients; r hr.sign_requests; v_token text;
begin
 select lower(u.email) into v_email from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null;
 if v_email is null then raise exception 'Sign in to see your documents' using errcode = '42501'; end if;
 if p_action = 'list' then
  return coalesce((select jsonb_agg(jsonb_build_object('recipient_id', k.id, 'reference', q.reference, 'title', q.title, 'status', hr.sign_status(q), 'my_state', k.state,
    'role', k.role_label, 'sent_at', k.sent_at, 'signed_at', k.signed_at, 'expires_at', q.expires_at, 'completed_at', q.completed_at) order by q.created_at desc)
   from hr.sign_recipients k join hr.sign_requests q on q.id = k.request_id
   where k.email = v_email and k.state in ('sent','viewed','signed') and q.state in ('sent','viewed','partial','signed')), '[]'::jsonb);
 elsif p_action = 'token' then
  select * into c from hr.sign_recipients where id = p_id and email = v_email;
  if found then select * into r from hr.sign_requests where id = c.request_id; end if;
  if c.id is null or c.state not in ('sent','viewed','signed') or r.state not in ('sent','viewed','partial','signed') or (r.state <> 'signed' and r.expires_at <= now())
   then raise exception 'This document is not available' using errcode = '42501'; end if;
  delete from hr.sign_tokens where recipient_id = c.id and notification_id is null and created_at < now() - interval '1 day';
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into hr.sign_tokens(token_hash, recipient_id) values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), c.id);
  perform hr.sign_event(r.id, 'opened_signed_in', c.id, auth.uid());
  return jsonb_build_object('token', v_token);
 end if;
 raise exception 'Unknown action';
end $f$;
revoke all on function public.signing_mine(text, uuid) from public, anon, authenticated;
grant execute on function public.signing_mine(text, uuid) to authenticated;

-- ------------------------------------------------------------------ reminders and expiry on a schedule
-- Every 15 minutes pg_cron calls public.signing_dispatch(), which POSTs {"action":"tick"} to document-signing with the service-role key
-- from Vault (never in this file, the job command or a log), only when something is due. The job is created INACTIVE; the owner turns it
-- on at release, after storing the two Vault secrets:
--   select vault.create_secret('<service_role key>', 'signing_service_role_key', 'Document signing reminders');
--   select vault.create_secret('https://<project>.supabase.co/functions/v1/document-signing', 'signing_function_url', 'Document signing reminders');
--   select cron.alter_job((select jobid from cron.job where jobname = 'signing-notifications'), active := true);
-- Without both secrets the dispatcher does nothing. Invitations and completion mail do not wait for it: the function sends them at once.
create extension if not exists pg_net;
create extension if not exists pg_cron;
create function public.signing_dispatch() returns bigint
language plpgsql security definer set search_path = public, vault, net, pg_temp as $f$
declare v_key text; v_url text;
begin
 if not pg_try_advisory_xact_lock(9342, 20261113) then return null; end if;
 select decrypted_secret into v_key from vault.decrypted_secrets where name = 'signing_service_role_key' limit 1;
 select decrypted_secret into v_url from vault.decrypted_secrets where name = 'signing_function_url' limit 1;
 if nullif(v_key, '') is null or nullif(v_url, '') is null or v_url !~ '^https?://[^/]+/functions/v1/document-signing$' then return null; end if;
 if not exists (select 1 from hr.sign_notifications where state = 'queued' or (state = 'sending' and lease_until < now()))
  and not exists (select 1 from hr.sign_requests q where q.state in ('sent','viewed','partial') and (q.expires_at <= now() or (q.reminder_days > 0 and exists (
   select 1 from hr.sign_recipients k where k.request_id = q.id and k.state in ('sent','viewed') and k.reminder_count < 10
    and coalesce(k.last_notified_at, k.sent_at) <= now() - make_interval(days => q.reminder_days))))) then return null; end if;
 return net.http_post(url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
  body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 55000);
end $f$;
revoke all on function public.signing_dispatch() from public, anon, authenticated, service_role;
grant execute on function public.signing_dispatch() to postgres;
do $job$
declare v_job bigint;
begin
 select jobid into v_job from cron.job where jobname = 'signing-notifications' order by jobid limit 1;
 if v_job is null then
  v_job := cron.schedule('signing-notifications', '*/15 * * * *', 'select public.signing_dispatch();');
  perform cron.alter_job(v_job, active := false);
 end if;
end $job$;
