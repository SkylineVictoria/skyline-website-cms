-- Staff enrolment v2 (HR-02a; extends the hr schema of 20261105180000/190000/200000, which are applied hosted and not edited).
-- LOCAL only until the owner releases it. Flow, with no login until the very end:
--   applied             public form (staff-register `apply`): name, email, phone, resume. Admin: reject or send a document invite.
--   invited             a one-time link (hr.staff_invites stores only the sha256 of the token): personal details + documents.
--   documents_submitted the applicant submitted; each document is reviewed. A rejected document lets the admin send a
--                       re-upload link (back to invited, purpose 'reupload': only rejected documents can be replaced).
--   offer_sent          the admin uploaded an offer PDF and sent it (a link of purpose 'offer').
--   offer_signed        the applicant signed it on the page (typed name, consent, time, IP, user agent, signed PDF + sha256).
--   active              joining date + role: an existing confirmed auth account gets the role at once; otherwise Auth
--                       invites the person and hr_staff_claim_account() activates them after they set a password.
--   rejected / inactive as before; rejected > applied is a re-application or an admin reopen; inactive > applied is a former
--                       staff member applying again.
-- Applicants never call SQL directly: the token-checked Edge Functions call the service-role-only hr_svc_* functions with the
-- token HASH. Admin functions keep hr.require_admin(). Documents keep the per-document review (pending/approved/rejected),
-- categories and expiry rules. Files: staff-documents/{profile id}/{doc slug|resume|offer}/{file}.
-- Legacy rows are mapped once: draft > applied, submitted/preboarding > documents_submitted (logged as system).
-- Rollback (manual, nothing hosted depends on it yet): drop the functions and tables created here, restore the bodies of the
-- redefined 20261105180000/190000 functions, the dropped policies and grants, the old status checks, and the menu row.

-- ------------------------------------------------------------------ documents: review columns and categories
alter table hr.staff_profiles add column if not exists is_australian_citizen boolean;
alter table hr.staff_profiles alter column auth_user_id drop not null;
-- Retention (HR-02h): a purged application keeps status and dates only, so email and mobile can be cleared (unique indexes allow many nulls).
alter table hr.staff_profiles alter column email drop not null;
alter table hr.staff_profiles alter column phone_e164 drop not null;

alter table hr.staff_documents
 add column if not exists expiry_date date check (expiry_date is null or expiry_date between date '1990-01-01' and date '2100-12-31'),
 add column if not exists status text not null default 'pending' check (status in ('pending','approved','rejected')),
 add column if not exists review_note text not null default '' check (char_length(review_note) <= 2000),
 add column if not exists reviewed_by uuid,
 add column if not exists reviewed_at timestamptz;
alter table hr.staff_documents drop constraint if exists staff_documents_rejection_has_note;
alter table hr.staff_documents add constraint staff_documents_rejection_has_note check (status <> 'rejected' or btrim(review_note) <> '');

do $legacy$
begin
 if exists (select 1 from hr.staff_documents where category in ('PTE','English Certificate')) then
  update hr.staff_documents set category = 'English' where category in ('PTE','English Certificate') and not is_current;
  if exists (select 1 from hr.staff_documents where category in ('PTE','English Certificate')) then
   raise exception 'Current staff documents with the legacy categories PTE / English Certificate exist; move them to English first. Nothing was changed.';
  end if;
 end if;
end $legacy$;
alter table hr.staff_documents drop constraint if exists staff_documents_category_check;
alter table hr.staff_documents add constraint staff_documents_category_check
 check (category in ('Passport','Visa','English','Academic','Driving Licence','Health Insurance'));

-- Academic results may hold several current files; every other category keeps one current file.
drop index if exists hr.staff_documents_one_current;
create unique index staff_documents_one_current on hr.staff_documents(application_id, category) where is_current and category <> 'Academic';
create index if not exists staff_documents_expiry_idx on hr.staff_documents(expiry_date) where is_current and expiry_date is not null;

-- ------------------------------------------------------------------ applications: resume, joining date, activation, retention
alter table hr.staff_applications
 add column if not exists resume_path text unique check (resume_path is null or char_length(resume_path) <= 400),
 add column if not exists resume_filename text check (resume_filename is null or char_length(resume_filename) between 1 and 255),
 add column if not exists resume_mime text check (resume_mime is null or resume_mime in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
 add column if not exists resume_size integer check (resume_size is null or resume_size between 1 and 5242880),
 add column if not exists resume_uploaded_at timestamptz,
 add column if not exists joining_date date check (joining_date is null or joining_date between date '2000-01-01' and date '2100-12-31'),
 add column if not exists account_invited_at timestamptz,
 add column if not exists files_purged_at timestamptz;

-- ------------------------------------------------------------------ status machine
alter table hr.staff_profiles drop constraint if exists staff_profiles_status_check;
alter table hr.staff_status_events drop constraint if exists staff_status_events_from_status_check;
alter table hr.staff_status_events drop constraint if exists staff_status_events_to_status_check;
-- The log keeps the legacy values of rows written before this migration (it is append-only).
alter table hr.staff_status_events add constraint staff_status_events_from_status_check check (from_status is null or from_status in
 ('applied','invited','documents_submitted','offer_sent','offer_signed','active','rejected','inactive','draft','submitted','preboarding'));
alter table hr.staff_status_events add constraint staff_status_events_to_status_check check (to_status in
 ('applied','invited','documents_submitted','offer_sent','offer_signed','active','rejected','inactive','draft','submitted','preboarding'));

do $map$
begin
 perform set_config('hr.actor_kind', 'system', true);
 perform set_config('hr.note', 'Moved to the new staff enrolment flow', true);
 alter table hr.staff_profiles disable trigger staff_status_guard;
 update hr.staff_profiles set status = 'applied', status_changed_at = now() where status = 'draft';
 update hr.staff_profiles set status = 'documents_submitted', status_changed_at = now() where status in ('submitted','preboarding');
 alter table hr.staff_profiles enable trigger staff_status_guard;
 perform set_config('hr.actor_kind', '', true);
 perform set_config('hr.note', '', true);
end $map$;
alter table hr.staff_profiles alter column status set default 'applied';
alter table hr.staff_profiles add constraint staff_profiles_status_check
 check (status in ('applied','invited','documents_submitted','offer_sent','offer_signed','active','rejected','inactive'));

create or replace function hr.staff_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select (p_from, p_to) in (
  ('applied','invited'), ('applied','rejected'),
  ('invited','documents_submitted'), ('invited','rejected'),
  ('documents_submitted','invited'), ('documents_submitted','offer_sent'), ('documents_submitted','rejected'),
  ('offer_sent','offer_signed'), ('offer_sent','documents_submitted'), ('offer_sent','rejected'),
  ('offer_signed','active'), ('offer_signed','rejected'),
  ('active','inactive'), ('inactive','active'), ('rejected','applied'), ('inactive','applied'));
$fn$;

create or replace function hr.staff_status_guard() returns trigger
language plpgsql set search_path = hr, public as $$
begin
 if tg_op = 'INSERT' then
  if new.status <> 'applied' then raise exception 'A staff profile starts as an application.' using errcode = '23514'; end if;
  return new;
 end if;
 new.updated_at := now();
 if new.status is distinct from old.status then
  if not hr.staff_transition_allowed(old.status, new.status) then
   raise exception 'A staff application cannot move from % to %.', old.status, new.status using errcode = '23514';
  end if;
  new.status_changed_at := now();
 end if;
 return new;
end $$;

-- ------------------------------------------------------------------ invites, offers, emails
create table if not exists hr.staff_invites (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 purpose text not null check (purpose in ('documents','reupload','offer')),
 -- sha256 (hex) of the random token; the token itself is only ever in the email / the admin's screen.
 token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
 created_by uuid not null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 revoked_at timestamptz,
 revoked_by uuid,
 superseded_at timestamptz,
 used_at timestamptz,
 last_seen_at timestamptz,
 check (expires_at > created_at)
);
-- One live link per person for documents (documents or reupload) and one for the offer.
create unique index if not exists staff_invites_one_live on hr.staff_invites(profile_id, (purpose = 'offer'))
 where revoked_at is null and superseded_at is null and used_at is null;

create table if not exists hr.staff_offers (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 storage_path text not null unique check (char_length(storage_path) <= 400),
 filename text not null check (char_length(filename) between 1 and 255),
 file_size integer not null check (file_size between 1 and 10485760),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
 uploaded_by uuid not null,
 uploaded_at timestamptz not null default now(),
 sent_at timestamptz,
 sent_by uuid,
 withdrawn_at timestamptz,
 withdrawn_by uuid,
 signed_at timestamptz,
 signer_name text check (signer_name is null or char_length(signer_name) between 1 and 200),
 consent_text text check (consent_text is null or char_length(consent_text) <= 1000),
 signer_ip text check (signer_ip is null or char_length(signer_ip) <= 64),
 signer_user_agent text check (signer_user_agent is null or char_length(signer_user_agent) <= 500),
 signed_path text unique check (signed_path is null or char_length(signed_path) <= 400),
 signed_sha256 text check (signed_sha256 is null or signed_sha256 ~ '^[0-9a-f]{64}$'),
 check (signed_at is null or (sent_at is not null and signer_name is not null and consent_text is not null and signed_path is not null and signed_sha256 is not null)),
 check (not (signed_at is not null and withdrawn_at is not null))
);
create unique index if not exists staff_offers_one_open on hr.staff_offers(profile_id) where withdrawn_at is null and signed_at is null;

create table if not exists hr.staff_emails (
 id bigint generated always as identity primary key,
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 kind text not null check (kind in ('application_received','admin_new_application','document_invite','reupload_invite',
  'admin_documents_submitted','offer','signed_offer','admin_offer_signed','rejected','already_applied','access_ready')),
 audience text not null check (audience in ('applicant','admin')),
 -- The applicant's address at the time; admin mail goes to EF_HR_ADMIN_NOTIFY_TO, resolved when sending.
 to_email text check (to_email is null or char_length(to_email) <= 254),
 -- Never a token: link emails are sent inline by the Edge Function and only logged here.
 payload jsonb not null default '{}'::jsonb,
 state text not null default 'queued' check (state in ('queued','sending','sent','failed','skipped')),
 attempts integer not null default 0 check (attempts between 0 and 5),
 lease_until timestamptz,
 provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 200),
 last_error text check (last_error is null or char_length(last_error) <= 500),
 created_at timestamptz not null default now(),
 sent_at timestamptz,
 check (audience = 'admin' or to_email is not null),
 check (not (payload ? 'token'))
);
create index if not exists staff_emails_queue_idx on hr.staff_emails(state, created_at) where state in ('queued','sending');
create index if not exists staff_emails_profile_idx on hr.staff_emails(profile_id, id);

alter table hr.staff_invites enable row level security;
alter table hr.staff_offers enable row level security;
alter table hr.staff_emails enable row level security;
revoke all on hr.staff_invites, hr.staff_offers, hr.staff_emails from public, anon, authenticated;
grant select, insert, update on hr.staff_invites, hr.staff_offers, hr.staff_emails to service_role;

-- ------------------------------------------------------------------ privileges: no applicant writes through the Data API
drop policy if exists staff_profiles_edit_own_draft on hr.staff_profiles;
drop policy if exists staff_applications_edit_own_draft on hr.staff_applications;
revoke update on hr.staff_profiles from authenticated;
revoke update on hr.staff_applications from authenticated;

-- Admins update review fields only (defence in depth; the browser uses hr_admin_staff_document_review).
grant update (status, review_note, reviewed_by, reviewed_at) on hr.staff_documents to authenticated;
drop policy if exists staff_documents_admin_review on hr.staff_documents;
create policy staff_documents_admin_review on hr.staff_documents for update to authenticated
 using (public.cms_is_admin() and not exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid()))
 with check (public.cms_is_admin() and not exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid()));

-- ------------------------------------------------------------------ storage
-- Applicants never write storage directly (signed upload URLs from the Edge Functions). Admins read everything; an ACTIVE
-- person reads their own folder (My HR). The owner write policies of 20261105180000 are dropped.
update storage.buckets set allowed_mime_types = array['application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
 where id = 'staff-documents';
drop policy if exists staff_documents_owner_insert on storage.objects;
drop policy if exists staff_documents_owner_delete on storage.objects;
drop policy if exists staff_documents_owner_reupload on storage.objects;
drop policy if exists staff_documents_read on storage.objects;
create policy staff_documents_read on storage.objects for select to authenticated
 using (bucket_id = 'staff-documents' and (public.cms_is_admin() or exists (select 1 from hr.staff_profiles p
  where p.auth_user_id = auth.uid() and p.status = 'active' and p.id::text = (storage.foldername(name))[1])));

-- ------------------------------------------------------------------ obsolete functions (sign-up, applicant RPCs on auth.uid())
drop function if exists public.hr_staff_start(text, text);
drop function if exists public.hr_staff_save(jsonb);
drop function if exists public.hr_staff_document_register(text, text, text, text, integer);
drop function if exists public.hr_staff_document_remove(uuid);
drop function if exists public.hr_staff_document_for_extraction(uuid);
drop function if exists public.hr_staff_submit();
drop function if exists public.hr_admin_staff_approve(uuid, text, text, boolean);

-- ------------------------------------------------------------------ document helpers
create or replace function hr.staff_doc_slug(p_category text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select lower(replace(btrim(coalesce(p_category, '')), ' ', '-')); $fn$;

-- Expiry date: REQUIRED for these (on upload); accepted but optional for English; not taken for Academic.
create or replace function hr.staff_doc_needs_expiry(p_category text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select p_category in ('Passport','Visa','Driving Licence','Health Insurance'); $fn$;

create or replace function hr.staff_doc_takes_expiry(p_category text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select p_category in ('Passport','Visa','English','Driving Licence','Health Insurance'); $fn$;

create or replace function hr.staff_doc_label(p_category text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select case p_category when 'English' then 'English test result' when 'Academic' then 'academic results' else lower(p_category) end;
$fn$;

-- REQUIRED categories (Driving Licence is optional). Visa and English only when not (or not yet said to be) an Australian citizen.
create or replace function hr.staff_required_categories(p_citizen boolean) returns text[]
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select case when p_citizen is true then array['Passport','Academic','Health Insurance'] else array['Passport','Visa','English','Academic','Health Insurance'] end;
$fn$;

create or replace function hr.staff_doc_json(d hr.staff_documents) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('id', d.id, 'category', d.category, 'filename', d.filename, 'mimeType', d.mime_type, 'fileSize', d.file_size,
  'storagePath', d.storage_path, 'extractionStatus', d.extraction_status, 'extracted', d.extracted, 'extractionError', d.extraction_error,
  'createdAt', d.created_at, 'expiryDate', d.expiry_date, 'status', d.status, 'reviewNote', d.review_note, 'reviewedAt', d.reviewed_at);
$fn$;

create or replace function hr.staff_doc_summary(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, public, pg_temp as $fn$
 with p as (select id, is_australian_citizen from hr.staff_profiles where id = p_profile),
 req as (select unnest(hr.staff_required_categories(p.is_australian_citizen)) as category from p),
 per as (
  select r.category, count(d.id) as files, count(d.id) filter (where d.status = 'approved') as approved,
   count(d.id) filter (where d.status = 'rejected') as rejected
  from req r left join hr.staff_documents d on d.profile_id = p_profile and d.category = r.category and d.is_current
  group by r.category)
 select jsonb_build_object(
  'required', (select count(*) from per),
  'uploaded', (select count(*) from per where files > 0),
  'approved', (select count(*) from per where files > 0 and approved = files),
  'rejected', (select count(*) from hr.staff_documents d where d.profile_id = p_profile and d.is_current and d.status = 'rejected'),
  'expiringSoon', exists (select 1 from hr.staff_documents d where d.profile_id = p_profile and d.is_current and d.expiry_date is not null
     and d.expiry_date <= current_date + 30),
  'nextExpiry', (select min(d.expiry_date) from hr.staff_documents d where d.profile_id = p_profile and d.is_current and d.expiry_date is not null));
$fn$;
revoke all on function hr.staff_doc_summary(uuid) from public, anon, authenticated;
grant execute on function hr.staff_doc_summary(uuid) to service_role;

-- A new expiry date or a different file puts a document back into review. (A re-upload is a new row, pending by default.)
create or replace function hr.staff_document_review_reset() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
 if new.expiry_date is distinct from old.expiry_date or new.storage_path is distinct from old.storage_path then
  new.status := 'pending'; new.review_note := ''; new.reviewed_by := null; new.reviewed_at := null;
 end if;
 return new;
end $fn$;
drop trigger if exists staff_document_review_reset on hr.staff_documents;
create trigger staff_document_review_reset before update on hr.staff_documents for each row execute function hr.staff_document_review_reset();

create or replace function hr.check_staff_expiry(p_category text, p_expiry date) returns date
language plpgsql immutable set search_path = hr, pg_catalog, pg_temp as $fn$
begin
 if not hr.staff_doc_takes_expiry(p_category) then return null; end if;
 if p_expiry is null and hr.staff_doc_needs_expiry(p_category) then raise exception 'Enter the expiry date of your %.', hr.staff_doc_label(p_category) using errcode = '22023'; end if;
 if p_expiry > date '2100-12-31' then raise exception 'Check the expiry date.' using errcode = '22023'; end if;
 return p_expiry;
end $fn$;

-- A storage path inside the person's folder: {profile id}/{folder}/{file}, no traversal, no control characters.
create or replace function hr.staff_path_ok(p_path text, p_profile uuid, p_folder text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $fn$
 select p_path is not null and char_length(p_path) <= 400 and array_length(string_to_array(p_path, '/'), 1) = 3
  and split_part(p_path, '/', 1) = p_profile::text and split_part(p_path, '/', 2) = p_folder and split_part(p_path, '/', 3) <> ''
  and p_path !~ '(^|/)\.\.?(/|$)' and p_path !~ '[\\%[:cntrl:]]';
$fn$;

create or replace function hr.staff_object_exists(p_path text) returns boolean
language sql stable security definer set search_path = storage, pg_temp as $fn$
 select exists (select 1 from storage.objects o where o.bucket_id = 'staff-documents' and o.name = p_path);
$fn$;
revoke all on function hr.staff_object_exists(text) from public, anon, authenticated;

create or replace function hr.staff_name(p hr.staff_profiles) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $fn$ select btrim(concat_ws(' ', nullif(btrim(p.first_name), ''), nullif(btrim(p.last_name), ''))); $fn$;

-- Every required document present, approved and unexpired (offer and activation gate). Returns the first problem or null.
create or replace function hr.staff_documents_problem(p_profile uuid) returns text
language plpgsql stable set search_path = hr, pg_temp as $fn$
declare p hr.staff_profiles; c text;
begin
 select * into p from hr.staff_profiles where id = p_profile;
 foreach c in array hr.staff_required_categories(p.is_australian_citizen) loop
  if not exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current)
   or exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current and d.status <> 'approved') then
   return format('Approve every required document first (%s).', hr.staff_doc_label(c)); end if;
  if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current and d.expiry_date < current_date) then
   return format('The %s has expired.', hr.staff_doc_label(c)); end if;
 end loop;
 return null;
end $fn$;

-- ------------------------------------------------------------------ email outbox (internal)
create or replace function hr.queue_email(p_profile uuid, p_kind text, p_audience text, p_payload jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare p hr.staff_profiles; v_id bigint;
begin
 select * into p from hr.staff_profiles where id = p_profile;
 insert into hr.staff_emails(profile_id, kind, audience, to_email, payload)
  values (p.id, p_kind, p_audience, case when p_audience = 'applicant' then p.email end,
   jsonb_build_object('name', hr.staff_name(p), 'email', p.email) || coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
 return v_id;
end $fn$;
revoke all on function hr.queue_email(uuid, text, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------ invites (internal)
-- The single message for every unusable link (unknown, wrong purpose, expired, revoked, replaced): it never says which.
create or replace function hr.invite_resolve(p_hash text, p_purposes text[]) returns hr.staff_invites
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare i hr.staff_invites;
begin
 if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'This link is not valid any more. Ask us for a new one.' using errcode = '28000'; end if;
 select * into i from hr.staff_invites where token_hash = p_hash for update;
 if not found or i.purpose <> all(p_purposes) or i.revoked_at is not null or i.superseded_at is not null or i.expires_at <= now() then
  raise exception 'This link is not valid any more. Ask us for a new one.' using errcode = '28000'; end if;
 update hr.staff_invites set last_seen_at = now() where id = i.id;
 return i;
end $fn$;
revoke all on function hr.invite_resolve(text, text[]) from public, anon, authenticated;

-- Same, for a change: the link must be unused and the person still in the state the link was sent for.
create or replace function hr.invite_for_write(p_hash text, p_purposes text[]) returns hr.staff_invites
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare i hr.staff_invites; v_status text;
begin
 i := hr.invite_resolve(p_hash, p_purposes);
 select status into v_status from hr.staff_profiles where id = i.profile_id for update;
 if i.used_at is not null or v_status <> (case when i.purpose = 'offer' then 'offer_sent' else 'invited' end) then
  raise exception 'This has already been sent and can no longer be changed.' using errcode = '23514'; end if;
 return i;
end $fn$;
revoke all on function hr.invite_for_write(text, text[]) from public, anon, authenticated;

create or replace function hr.invite_create(p_profile uuid, p_purpose text, p_hash text, p_admin uuid) returns hr.staff_invites
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare i hr.staff_invites;
begin
 if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid link hash.' using errcode = '22023'; end if;
 update hr.staff_invites set superseded_at = now()
  where profile_id = p_profile and (purpose = 'offer') = (p_purpose = 'offer') and revoked_at is null and superseded_at is null and used_at is null;
 insert into hr.staff_invites(profile_id, purpose, token_hash, created_by, expires_at)
  values (p_profile, p_purpose, p_hash, p_admin, now() + case when p_purpose = 'offer' then interval '30 days' else interval '14 days' end)
  returning * into i;
 return i;
end $fn$;
revoke all on function hr.invite_create(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function hr.invite_json(i hr.staff_invites) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('id', i.id, 'purpose', i.purpose, 'createdAt', i.created_at, 'expiresAt', i.expires_at, 'usedAt', i.used_at,
  'revokedAt', i.revoked_at, 'supersededAt', i.superseded_at, 'lastSeenAt', i.last_seen_at,
  'state', case when i.used_at is not null then 'used' when i.revoked_at is not null then 'revoked' when i.superseded_at is not null then 'replaced'
   when i.expires_at <= now() then 'expired' else 'live' end);
$fn$;

create or replace function hr.offer_json(o hr.staff_offers) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('id', o.id, 'filename', o.filename, 'fileSize', o.file_size, 'storagePath', o.storage_path, 'sha256', o.sha256,
  'uploadedAt', o.uploaded_at, 'sentAt', o.sent_at, 'withdrawnAt', o.withdrawn_at, 'signedAt', o.signed_at, 'signerName', o.signer_name,
  'signedPath', o.signed_path, 'signedSha256', o.signed_sha256);
$fn$;

-- What the applicant's page shows (no auth ids, no review internals beyond the note).
create or replace function hr.staff_applicant_view(i hr.staff_invites) returns jsonb
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare p hr.staff_profiles;
begin
 select * into p from hr.staff_profiles where id = i.profile_id;
 return jsonb_build_object(
  'profile', to_jsonb(p) - 'auth_user_id' - 'id' - 'status_changed_at' - 'created_at' - 'updated_at',
  'status', p.status,
  'mode', i.purpose,
  'readOnly', i.used_at is not null or p.status <> 'invited',
  'expiresAt', i.expires_at,
  'documents', coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.category, d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'requiredCategories', to_jsonb(hr.staff_required_categories(p.is_australian_citizen)),
  'summary', hr.staff_doc_summary(p.id));
end $fn$;
revoke all on function hr.staff_applicant_view(hr.staff_invites) from public, anon, authenticated;

-- ------------------------------------------------------------------ public apply (service role, called by staff-register)
-- Step 1: the person. A new email gets a new profile (status applied). Only an OPEN application (applied with a resume,
-- invited, documents_submitted, offer_sent, offer_signed) or an active staff member counts as a duplicate. A CLOSED one
-- (rejected or inactive) with the same email is reused for the new application (rejected/inactive > applied; any live role
-- is revoked), as is an application still waiting for its resume. A duplicate answers {ok:false, reason:'exists'}. The mobile
-- number is unique across all profiles, so a number held by ANOTHER person's profile (open or closed) also answers 'exists'. Existing students, agents and portal users MAY apply (they keep their login; activation grants the role to it).
create or replace function public.hr_svc_apply(p_first_name text, p_last_name text, p_email text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_email text := hr.email_key(p_email); v_phone text := hr.phone_e164(p_phone); p hr.staff_profiles; a hr.staff_applications;
 v_first text := btrim(coalesce(p_first_name, '')); v_last text := btrim(coalesce(p_last_name, ''));
begin
 if v_email is null or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' or char_length(v_email) > 254 then return jsonb_build_object('ok', false, 'reason', 'invalid_email'); end if;
 if v_phone is null then return jsonb_build_object('ok', false, 'reason', 'invalid_phone'); end if;
 if v_first = '' or v_last = '' or char_length(v_first) > 100 or char_length(v_last) > 100 or (v_first || v_last) ~ '[[:cntrl:]<>]' then
  return jsonb_build_object('ok', false, 'reason', 'invalid_name'); end if;
 -- An ACTIVE admin console user cannot apply; a deactivated former Admin (cms_users Inactive) can.
 if exists (select 1 from public.cms_users c where hr.email_key(c.email) = v_email and c.status = 'Active') then return jsonb_build_object('ok', false, 'reason', 'exists'); end if;
 select * into p from hr.staff_profiles where email = v_email for update;
 if found then
  select * into a from hr.staff_applications where profile_id = p.id;
  if not (p.status in ('rejected','inactive') or (p.status = 'applied' and a.resume_path is null)) then
   -- The address already has an open application: tell THAT address (never a different one), at most once an hour. The
   -- caller's answer stays the same thank-you; staff-register's per-email rate limit applies before this is reached.
   if not exists (select 1 from hr.staff_emails e where e.profile_id = p.id and e.kind = 'already_applied' and e.created_at > now() - interval '1 hour') then
    perform hr.queue_email(p.id, 'already_applied', 'applicant');
   end if;
   return jsonb_build_object('ok', false, 'reason', 'exists');
  end if;
 end if;
 if exists (select 1 from hr.staff_profiles s where s.phone_e164 = v_phone and s.id is distinct from p.id) then return jsonb_build_object('ok', false, 'reason', 'exists'); end if;
 perform set_config('hr.actor_kind', 'applicant', true); perform set_config('hr.note', 'Applied', true);
 if p.id is null then
  insert into hr.staff_profiles(first_name, last_name, email, phone_e164) values (v_first, v_last, v_email, v_phone) returning * into p;
  insert into hr.staff_applications(profile_id) values (p.id);
 else
  update hr.staff_profiles set first_name = v_first, last_name = v_last, phone_e164 = v_phone, status = 'applied' where id = p.id returning * into p;
  update hr.staff_applications set resume_path = null, resume_filename = null, resume_mime = null, resume_size = null, resume_uploaded_at = null,
   submitted_at = null, reviewed_by = null, reviewed_at = null, review_note = '', joining_date = null, account_invited_at = null where profile_id = p.id;
  update hr.staff_documents set is_current = false where profile_id = p.id and is_current;
  update hr.staff_roles set revoked_at = now() where profile_id = p.id and revoked_at is null;
 end if;
 return jsonb_build_object('ok', true, 'profileId', p.id);
end $fn$;
revoke all on function public.hr_svc_apply(text, text, text, text) from public, anon, authenticated;
grant execute on function public.hr_svc_apply(text, text, text, text) to service_role;

-- Step 2: the resume the function uploaded to {profile}/resume/{file}. Queues "application received" and "new application".
create or replace function public.hr_svc_apply_resume(p_profile uuid, p_path text, p_filename text, p_mime text, p_size integer) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; a hr.staff_applications;
begin
 select * into p from hr.staff_profiles where id = p_profile for update;
 if not found then raise exception 'Application not found.' using errcode = 'P0002'; end if;
 select * into a from hr.staff_applications where profile_id = p.id for update;
 if p.status <> 'applied' or a.resume_path is not null then raise exception 'The resume is already recorded.' using errcode = '23514'; end if;
 if not hr.staff_path_ok(p_path, p.id, 'resume') then raise exception 'The resume location is not valid.' using errcode = '22023'; end if;
 if p_mime not in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document') then raise exception 'Upload a PDF or Word (.docx) file.' using errcode = '22023'; end if;
 if p_size is null or p_size < 1 or p_size > 5242880 then raise exception 'The resume must be 5 MB or smaller.' using errcode = '22023'; end if;
 if not hr.staff_object_exists(p_path) then raise exception 'The uploaded file was not found.' using errcode = 'P0002'; end if;
 update hr.staff_applications set resume_path = p_path, resume_filename = left(btrim(coalesce(p_filename, 'resume')), 255), resume_mime = p_mime,
  resume_size = p_size, resume_uploaded_at = now() where id = a.id;
 perform hr.queue_email(p.id, 'application_received', 'applicant');
 perform hr.queue_email(p.id, 'admin_new_application', 'admin');
 return jsonb_build_object('ok', true, 'profileId', p.id);
end $fn$;
revoke all on function public.hr_svc_apply_resume(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.hr_svc_apply_resume(uuid, text, text, text, integer) to service_role;

-- ------------------------------------------------------------------ onboarding by link (service role, called by staff-onboarding)
create or replace function public.hr_svc_onboarding_open(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
begin
 return hr.staff_applicant_view(hr.invite_resolve(p_token_hash, array['documents','reupload']));
end $fn$;

-- Personal details: only with a 'documents' link (a re-upload link changes documents only). Email and phone are fixed.
create or replace function public.hr_svc_onboarding_save(p_token_hash text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; v_ephone text; v_dob date; k text;
 text_keys constant text[] := array['first_name','middle_name','last_name','address_street','address_line2','address_suburb','address_state','address_postcode','address_country','emergency_name','emergency_relationship'];
begin
 i := hr.invite_for_write(p_token_hash, array['documents']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Nothing to save.' using errcode = '22023'; end if;
 foreach k in array text_keys loop
  if p_patch ? k and (jsonb_typeof(p_patch->k) not in ('string','null') or char_length(coalesce(p_patch->>k, '')) > 200 or coalesce(p_patch->>k, '') ~ '[[:cntrl:]]') then
   raise exception 'Check the % field.', replace(k, '_', ' ') using errcode = '22023'; end if;
 end loop;
 if p_patch ? 'date_of_birth' then
  begin v_dob := nullif(btrim(coalesce(p_patch->>'date_of_birth', '')), '')::date; exception when others then raise exception 'Enter a valid date of birth.' using errcode = '22023'; end;
  if v_dob is not null and (v_dob > current_date - interval '14 years' or v_dob < date '1900-01-01') then raise exception 'Enter a valid date of birth.' using errcode = '22023'; end if;
 else v_dob := p.date_of_birth; end if;
 if p_patch ? 'emergency_phone' then
  v_ephone := hr.phone_e164(p_patch->>'emergency_phone');
  if nullif(btrim(coalesce(p_patch->>'emergency_phone', '')), '') is not null and v_ephone is null then raise exception 'Enter the emergency contact''s number with its country code.' using errcode = '22023'; end if;
 else v_ephone := p.emergency_phone_e164; end if;
 if p_patch ? 'is_australian_citizen' then
  if jsonb_typeof(p_patch->'is_australian_citizen') not in ('boolean','null') then raise exception 'Tell us whether you are an Australian citizen.' using errcode = '22023'; end if;
 end if;
 update hr.staff_profiles set
  first_name = case when p_patch ? 'first_name' then btrim(coalesce(p_patch->>'first_name', '')) else first_name end,
  middle_name = case when p_patch ? 'middle_name' then btrim(coalesce(p_patch->>'middle_name', '')) else middle_name end,
  last_name = case when p_patch ? 'last_name' then btrim(coalesce(p_patch->>'last_name', '')) else last_name end,
  date_of_birth = v_dob, emergency_phone_e164 = v_ephone,
  is_australian_citizen = case when p_patch ? 'is_australian_citizen' then (p_patch->>'is_australian_citizen')::boolean else is_australian_citizen end,
  address_street = case when p_patch ? 'address_street' then btrim(coalesce(p_patch->>'address_street', '')) else address_street end,
  address_line2 = case when p_patch ? 'address_line2' then btrim(coalesce(p_patch->>'address_line2', '')) else address_line2 end,
  address_suburb = case when p_patch ? 'address_suburb' then btrim(coalesce(p_patch->>'address_suburb', '')) else address_suburb end,
  address_state = case when p_patch ? 'address_state' then btrim(coalesce(p_patch->>'address_state', '')) else address_state end,
  address_postcode = case when p_patch ? 'address_postcode' then btrim(coalesce(p_patch->>'address_postcode', '')) else address_postcode end,
  address_country = case when p_patch ? 'address_country' then btrim(coalesce(p_patch->>'address_country', '')) else address_country end,
  emergency_name = case when p_patch ? 'emergency_name' then btrim(coalesce(p_patch->>'emergency_name', '')) else emergency_name end,
  emergency_relationship = case when p_patch ? 'emergency_relationship' then btrim(coalesce(p_patch->>'emergency_relationship', '')) else emergency_relationship end
  where id = p.id;
 return hr.staff_applicant_view(i);
end $fn$;

-- Records a file the function already uploaded to {profile}/{doc slug}/{file}.
--   'documents' link: Passport / Visa / English / Driving Licence / Health Insurance replace the current file of that type (its path
--   is returned for deletion); Academic adds a file, or replaces p_replaces.
--   'reupload' link: only a REJECTED current document may be replaced (p_replaces for Academic); the old file is kept.
create or replace function public.hr_svc_document_add(p_token_hash text, p_category text, p_path text, p_filename text, p_mime text, p_size integer,
 p_expiry date default null, p_replaces uuid default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; a hr.staff_applications; d hr.staff_documents; r hr.staff_documents; v_old text[]; v_expiry date; v_fresh boolean;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 v_fresh := i.purpose = 'documents';
 select * into p from hr.staff_profiles where id = i.profile_id;
 select * into a from hr.staff_applications where profile_id = p.id;
 if p_category is null or p_category not in ('Passport','Visa','English','Academic','Driving Licence','Health Insurance') then raise exception 'Unknown document type.' using errcode = '22023'; end if;
 if not hr.staff_path_ok(p_path, p.id, hr.staff_doc_slug(p_category)) then raise exception 'The document location is not valid.' using errcode = '22023'; end if;
 if p_mime is null or p_mime not in ('application/pdf','image/png','image/jpeg') then raise exception 'Upload a PDF, PNG or JPEG file.' using errcode = '22023'; end if;
 if p_size is null or p_size < 1 or p_size > 10485760 then raise exception 'The file must be 10 MB or smaller.' using errcode = '22023'; end if;
 v_expiry := hr.check_staff_expiry(p_category, p_expiry);
 if v_expiry is not null and v_expiry < current_date then raise exception 'This % has expired. Upload a current one.', hr.staff_doc_label(p_category) using errcode = '22023'; end if;
 if p_category = 'Academic' then
  if p_replaces is not null then
   select * into r from hr.staff_documents where id = p_replaces and profile_id = p.id and category = 'Academic' and is_current for update;
   if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
   if not v_fresh and r.status <> 'rejected' then raise exception 'Only a rejected document can be replaced.' using errcode = '23514'; end if;
  elsif not v_fresh then raise exception 'Only a rejected document can be replaced.' using errcode = '23514';
  end if;
 else
  select * into r from hr.staff_documents where application_id = a.id and category = p_category and is_current for update;
  if not v_fresh and (r.id is null or r.status <> 'rejected') then raise exception 'Only a rejected document can be replaced.' using errcode = '23514'; end if;
 end if;
 if not hr.staff_object_exists(p_path) then raise exception 'The uploaded file was not found.' using errcode = 'P0002'; end if;
 if r.id is not null then
  update hr.staff_documents set is_current = false where id = r.id;
  if v_fresh then v_old := array[r.storage_path]; end if;
 end if;
 insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size, expiry_date)
  values (a.id, p.id, p_category, p_path, left(btrim(coalesce(p_filename, 'document')), 255), p_mime, p_size, v_expiry) returning * into d;
 return jsonb_build_object('id', d.id, 'replacedPaths', coalesce(to_jsonb(v_old), '[]'::jsonb), 'view', hr.staff_applicant_view(i));
end $fn$;

-- Removes a current document (a 'documents' link only); returns the path for the function to delete.
create or replace function public.hr_svc_document_remove(p_token_hash text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; d hr.staff_documents;
begin
 i := hr.invite_for_write(p_token_hash, array['documents']);
 select * into d from hr.staff_documents where id = p_id and profile_id = i.profile_id and is_current for update;
 if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 update hr.staff_documents set is_current = false where id = d.id;
 return jsonb_build_object('removedPath', d.storage_path, 'view', hr.staff_applicant_view(i));
end $fn$;

create or replace function public.hr_svc_document_set_expiry(p_token_hash text, p_id uuid, p_expiry date) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; d hr.staff_documents; v_expiry date;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 select * into d from hr.staff_documents where id = p_id and profile_id = i.profile_id and is_current for update;
 if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 if i.purpose = 'reupload' and d.status <> 'rejected' then raise exception 'Only a rejected document can be changed.' using errcode = '23514'; end if;
 v_expiry := hr.check_staff_expiry(d.category, p_expiry);
 if v_expiry is not null and v_expiry < current_date then raise exception 'This % has expired. Upload a current one.', hr.staff_doc_label(d.category) using errcode = '22023'; end if;
 update hr.staff_documents set expiry_date = v_expiry where id = d.id;
 return hr.staff_applicant_view(i);
end $fn$;

-- Before the function stores a file: may this link upload this document type now, and into which folder? The same rules as
-- hr_svc_document_add (a re-upload link only replaces a REJECTED document), checked BEFORE any file is written.
create or replace function public.hr_svc_upload_target(p_token_hash text, p_category text, p_replaces uuid default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; r hr.staff_documents;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 if p_category is null or p_category not in ('Passport','Visa','English','Academic','Driving Licence','Health Insurance') then raise exception 'Unknown document type.' using errcode = '22023'; end if;
 if i.purpose = 'reupload' then
  if p_category = 'Academic' and p_replaces is null then raise exception 'Only a rejected document can be replaced.' using errcode = '23514'; end if;
  select * into r from hr.staff_documents d where d.profile_id = i.profile_id and d.category = p_category and d.is_current
   and (p_replaces is null or d.id = p_replaces) order by d.created_at desc limit 1;
  if r.id is null or r.status <> 'rejected' then raise exception 'Only a rejected document can be replaced.' using errcode = '23514'; end if;
 end if;
 return jsonb_build_object('profileId', i.profile_id, 'folder', hr.staff_doc_slug(p_category));
end $fn$;

-- The stored path of one of the link holder's current documents, to open it (also after submit: read-only links still view).
create or replace function public.hr_svc_document_path(p_token_hash text, p_id uuid) returns text
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; v_path text;
begin
 i := hr.invite_resolve(p_token_hash, array['documents','reupload']);
 select d.storage_path into v_path from hr.staff_documents d where d.id = p_id and d.profile_id = i.profile_id and d.is_current;
 if v_path is null then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 return v_path;
end $fn$;

-- The file to read for one of the link holder's current documents (staff-onboarding runs the shared reader).
create or replace function public.hr_svc_document_for_extraction(p_token_hash text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; d hr.staff_documents;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 select * into d from hr.staff_documents where id = p_id and profile_id = i.profile_id and is_current;
 if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 return jsonb_build_object('id', d.id, 'category', d.category, 'storagePath', d.storage_path, 'filename', d.filename, 'mimeType', d.mime_type);
end $fn$;

-- Submit: details (documents link), citizenship, every required document with a current expiry; with a re-upload link, no
-- current document may still be rejected. The link becomes read-only; the admins are told.
create or replace function public.hr_svc_onboarding_submit(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; c text;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 if btrim(p.first_name) = '' or btrim(p.last_name) = '' then raise exception 'Enter your first and last name.' using errcode = '23514'; end if;
 if p.date_of_birth is null then raise exception 'Enter your date of birth.' using errcode = '23514'; end if;
 if btrim(p.address_street) = '' or btrim(p.address_country) = '' then raise exception 'Enter your address.' using errcode = '23514'; end if;
 if btrim(p.emergency_name) = '' or btrim(p.emergency_relationship) = '' or p.emergency_phone_e164 is null then
  raise exception 'Enter an emergency contact: name, relationship and phone.' using errcode = '23514'; end if;
 if p.is_australian_citizen is null then raise exception 'Tell us whether you are an Australian citizen.' using errcode = '23514'; end if;
 foreach c in array hr.staff_required_categories(p.is_australian_citizen) loop
  if not exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current) then
   raise exception '%', case c when 'Passport' then 'A passport is required before you can submit.' else 'Upload your ' || hr.staff_doc_label(c) || '.' end
    using errcode = '23514'; end if;
  if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current
     and ((d.expiry_date is null and hr.staff_doc_needs_expiry(c)) or d.expiry_date < current_date)) then
   raise exception 'Enter a current expiry date for your %.', hr.staff_doc_label(c) using errcode = '23514'; end if;
 end loop;
 if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.is_current and d.status = 'rejected') then
  raise exception 'Replace every document we asked you to upload again.' using errcode = '23514'; end if;
 perform set_config('hr.actor_kind', 'applicant', true);
 perform set_config('hr.note', case when i.purpose = 'reupload' then 'Documents uploaded again' else 'Documents submitted' end, true);
 update hr.staff_profiles set status = 'documents_submitted' where id = p.id;
 update hr.staff_applications set submitted_at = now() where profile_id = p.id;
 update hr.staff_invites set used_at = now() where id = i.id returning * into i;
 perform hr.queue_email(p.id, 'admin_documents_submitted', 'admin', jsonb_build_object('reupload', i.purpose = 'reupload'));
 return hr.staff_applicant_view(i);
end $fn$;

-- ------------------------------------------------------------------ offer by link (service role)
create or replace function public.hr_svc_offer_open(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; o hr.staff_offers;
begin
 i := hr.invite_resolve(p_token_hash, array['offer']);
 select * into p from hr.staff_profiles where id = i.profile_id;
 select * into o from hr.staff_offers where profile_id = p.id and sent_at is not null and withdrawn_at is null order by sent_at desc limit 1;
 if not found then raise exception 'This link is not valid any more. Ask us for a new one.' using errcode = '28000'; end if;
 return jsonb_build_object('name', hr.staff_name(p), 'status', p.status, 'readOnly', i.used_at is not null or p.status <> 'offer_sent',
  'expiresAt', i.expires_at, 'offer', hr.offer_json(o) - 'sha256' - 'signedSha256');
end $fn$;

-- The function stamped the signature page onto the PDF and uploaded it to {profile}/offer/{file}; this records the signature.
create or replace function public.hr_svc_offer_sign(p_token_hash text, p_offer uuid, p_signer_name text, p_consent_text text, p_ip text, p_user_agent text,
 p_signed_path text, p_signed_sha256 text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; o hr.staff_offers; v_name text := btrim(coalesce(p_signer_name, ''));
begin
 i := hr.invite_for_write(p_token_hash, array['offer']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 select * into o from hr.staff_offers where id = p_offer and profile_id = p.id and sent_at is not null and withdrawn_at is null and signed_at is null for update;
 if not found then raise exception 'This offer can no longer be signed.' using errcode = '23514'; end if;
 if v_name = '' or char_length(v_name) > 200 or v_name ~ '[[:cntrl:]<>]' then raise exception 'Type your full name to sign.' using errcode = '22023'; end if;
 if btrim(coalesce(p_consent_text, '')) = '' then raise exception 'Tick the box to agree.' using errcode = '22023'; end if;
 if not hr.staff_path_ok(p_signed_path, p.id, 'offer') or p_signed_path = o.storage_path then raise exception 'The signed file location is not valid.' using errcode = '22023'; end if;
 if p_signed_sha256 is null or p_signed_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'The signed file hash is not valid.' using errcode = '22023'; end if;
 if not hr.staff_object_exists(p_signed_path) then raise exception 'The signed file was not found.' using errcode = 'P0002'; end if;
 update hr.staff_offers set signed_at = now(), signer_name = v_name, consent_text = left(btrim(p_consent_text), 1000), signer_ip = left(p_ip, 64),
  signer_user_agent = left(p_user_agent, 500), signed_path = p_signed_path, signed_sha256 = p_signed_sha256 where id = o.id returning * into o;
 perform set_config('hr.actor_kind', 'applicant', true); perform set_config('hr.note', 'Offer signed', true);
 update hr.staff_profiles set status = 'offer_signed' where id = p.id;
 update hr.staff_invites set used_at = now() where id = i.id returning * into i;
 perform hr.queue_email(p.id, 'signed_offer', 'applicant', jsonb_build_object('offerId', o.id));
 perform hr.queue_email(p.id, 'admin_offer_signed', 'admin', jsonb_build_object('offerId', o.id));
 return public.hr_svc_offer_open(p_token_hash);
end $fn$;

-- What staff-onboarding needs to sign (HR-02e): the unsigned sent offer of this link, with its storage path and the sha256
-- recorded at upload (the function checks the downloaded file against it before stamping). Only while the link can still sign.
-- Never sent to the browser.
create or replace function public.hr_svc_offer_file(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; o hr.staff_offers;
begin
 i := hr.invite_for_write(p_token_hash, array['offer']);
 select * into p from hr.staff_profiles where id = i.profile_id;
 select * into o from hr.staff_offers where profile_id = p.id and sent_at is not null and withdrawn_at is null and signed_at is null;
 if not found then raise exception 'This offer can no longer be signed.' using errcode = '23514'; end if;
 return jsonb_build_object('profileId', p.id, 'offerId', o.id, 'path', o.storage_path, 'sha256', o.sha256, 'filename', o.filename, 'name', hr.staff_name(p));
end $fn$;

-- The file the offer page may show through a short signed URL: the offer itself, or (after signing) the signed copy.
create or replace function public.hr_svc_offer_path(p_token_hash text, p_which text default 'offer') returns text
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; o hr.staff_offers;
begin
 i := hr.invite_resolve(p_token_hash, array['offer']);
 select * into o from hr.staff_offers where profile_id = i.profile_id and sent_at is not null and withdrawn_at is null order by sent_at desc limit 1;
 if not found then raise exception 'This link is not valid any more. Ask us for a new one.' using errcode = '28000'; end if;
 if p_which = 'signed' then
  if o.signed_path is null then raise exception 'The offer has not been signed yet.' using errcode = 'P0002'; end if;
  return o.signed_path;
 end if;
 if p_which <> 'offer' then raise exception 'Unknown file.' using errcode = '22023'; end if;
 return o.storage_path;
end $fn$;

-- The signed copy for the outbox (signed_offer / admin_offer_signed attach it). Service role only.
create or replace function public.hr_svc_offer_signed_file(p_offer uuid) returns jsonb
language sql stable security definer set search_path = public, hr, pg_temp as $fn$
 select jsonb_build_object('path', o.signed_path, 'filename', o.filename, 'signerName', o.signer_name, 'signedAt', o.signed_at, 'sha256', o.signed_sha256)
 from hr.staff_offers o where o.id = p_offer and o.signed_at is not null;
$fn$;

do $grants$
declare f text;
begin
 foreach f in array array['public.hr_svc_offer_file(text)', 'public.hr_svc_offer_path(text, text)', 'public.hr_svc_offer_signed_file(uuid)'] loop
  execute format('revoke all on function %s from public, anon, authenticated', f);
  execute format('grant execute on function %s to service_role', f);
 end loop;
end $grants$;

-- ------------------------------------------------------------------ email outbox (service role)
-- Claims queued mail (and mail whose lease ran out), at most 3 attempts. Admin mail has to_email null.
-- p_kinds limits the claim to the kinds the sender has templates for (null = every kind).
drop function if exists public.hr_svc_email_claim(integer, integer);
create or replace function public.hr_svc_email_claim(p_limit integer default 10, p_lease_seconds integer default 120, p_kinds text[] default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v jsonb;
begin
 with c as (
  select e.id from hr.staff_emails e
  where (e.state = 'queued' or (e.state = 'sending' and e.lease_until < now())) and e.attempts < 3 and (p_kinds is null or e.kind = any(p_kinds))
  order by e.id limit least(greatest(coalesce(p_limit, 10), 1), 50) for update skip locked),
 u as (
  update hr.staff_emails e set state = 'sending', attempts = e.attempts + 1, lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900))
  from c where e.id = c.id returning e.*)
 select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'profileId', u.profile_id, 'kind', u.kind, 'audience', u.audience, 'to', u.to_email,
  'payload', u.payload, 'attempts', u.attempts) order by u.id), '[]'::jsonb) into v from u;
 -- Mail that used its attempts while 'sending' is marked failed (never resent automatically).
 update hr.staff_emails set state = 'failed', last_error = coalesce(last_error, 'No result after 3 attempts'), lease_until = null
  where state = 'sending' and lease_until < now() and attempts >= 3;
 return v;
end $fn$;

create or replace function public.hr_svc_email_result(p_id bigint, p_state text, p_message_id text default null, p_error text default null) returns void
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
begin
 if p_state not in ('sent','failed','queued','skipped') then raise exception 'Unknown email state.' using errcode = '22023'; end if;
 update hr.staff_emails set state = case when p_state = 'queued' and attempts >= 3 then 'failed' else p_state end,
  provider_message_id = coalesce(left(p_message_id, 200), provider_message_id), last_error = left(p_error, 500), lease_until = null,
  sent_at = case when p_state = 'sent' then now() else sent_at end
  where id = p_id and state = 'sending';
end $fn$;

-- Link emails (invite, re-upload, offer) are sent inline by the function and logged here with the outcome; never the token.
create or replace function public.hr_svc_email_log(p_profile uuid, p_kind text, p_state text, p_message_id text default null, p_error text default null,
 p_payload jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_id bigint;
begin
 if p_kind not in ('document_invite','reupload_invite','offer') then raise exception 'Only link emails are logged this way.' using errcode = '22023'; end if;
 if p_state not in ('sent','failed','skipped') then raise exception 'Unknown email state.' using errcode = '22023'; end if;
 v_id := hr.queue_email(p_profile, p_kind, 'applicant', p_payload);
 update hr.staff_emails set state = p_state, attempts = 1, provider_message_id = left(p_message_id, 200), last_error = left(p_error, 500),
  sent_at = case when p_state = 'sent' then now() end where id = v_id;
 return v_id;
end $fn$;

-- ------------------------------------------------------------------ retention (service role, scheduled)
-- Applications rejected more than p_months ago whose files are not yet deleted: every stored path (resume, documents, offers).
create or replace function public.hr_svc_retention_due(p_months integer, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 if p_months is null or p_months < 1 or p_months > 120 then raise exception 'Retention must be 1 to 120 months.' using errcode = '22023'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('profileId', q.id, 'paths', q.paths) order by q.status_changed_at) from (
  select p.id, p.status_changed_at, to_jsonb(array_remove(array[a.resume_path], null)
    || coalesce((select array_agg(d.storage_path) from hr.staff_documents d where d.profile_id = p.id), '{}')
    || coalesce((select array_agg(o.storage_path) from hr.staff_offers o where o.profile_id = p.id), '{}')
    || coalesce((select array_agg(o.signed_path) from hr.staff_offers o where o.profile_id = p.id and o.signed_path is not null), '{}')) as paths
  from hr.staff_profiles p join hr.staff_applications a on a.profile_id = p.id
  where p.status = 'rejected' and a.files_purged_at is null and p.status_changed_at < now() - make_interval(months => p_months)
  order by p.status_changed_at limit least(greatest(coalesce(p_limit, 50), 1), 200)) q), '[]'::jsonb);
end $fn$;

-- Called by staff-admin after the files are deleted: records the purge AND removes the personal data, keeping status and dates only
-- (ids, statuses, timestamps, expiry dates, review states, the status log). Names, email, mobile, date of birth, address, emergency
-- contact, file names, values read from documents, notes, signer details and email addresses/payloads are cleared.
create or replace function hr.staff_anonymise(p_profile uuid) returns void
language plpgsql security definer set search_path = hr, public, auth, pg_temp as $fn$
declare v_login uuid;
begin
 -- The login goes too, but ONLY when it is the staff activation invite's own login that was never used: invited by staff-admin
 -- (account_type staff), never signed in, and no other role (no CMS user, no portal profile = student/agent, no other staff record).
 -- Anything else keeps its login; the record is just unlinked. Same transaction as the rest; a delete that something else
 -- still references is skipped, never forced.
 select p.auth_user_id into v_login from hr.staff_profiles p where p.id = p_profile;
 if v_login is not null then
  update hr.staff_profiles set auth_user_id = null where id = p_profile;
  if exists (select 1 from auth.users u where u.id = v_login and u.invited_at is not null and u.last_sign_in_at is null
       and coalesce(u.raw_user_meta_data->>'account_type', '') = 'staff')
     and not exists (select 1 from public.cms_users c where c.auth_user_id = v_login)
     and not exists (select 1 from public.portal_profiles pp where pp.auth_user_id = v_login)
     and not exists (select 1 from hr.staff_profiles o where o.auth_user_id = v_login) then
   begin
    delete from auth.users where id = v_login;
   exception when foreign_key_violation then null;
   end;
  end if;
 end if;
 update hr.staff_profiles set first_name = '', middle_name = '', last_name = '', date_of_birth = null, email = null, phone_e164 = null,
  address_street = '', address_line2 = '', address_suburb = '', address_state = '', address_postcode = '', address_country = '',
  emergency_name = '', emergency_relationship = '', emergency_phone_e164 = null, is_australian_citizen = null
  where id = p_profile;
 update hr.staff_applications set resume_path = null, resume_filename = null, review_note = '' where profile_id = p_profile;
 update hr.staff_documents set filename = 'removed', extracted = '{}'::jsonb, extraction_error = null,
  review_note = case when status = 'rejected' then 'removed' else '' end where profile_id = p_profile;
 update hr.staff_offers set filename = 'removed.pdf', signer_name = case when signer_name is null then null else 'removed' end,
  signer_ip = null, signer_user_agent = null where profile_id = p_profile;
 update hr.staff_emails set to_email = case when audience = 'applicant' then 'removed' else null end, payload = '{}'::jsonb, last_error = null where profile_id = p_profile;
end $fn$;
revoke all on function hr.staff_anonymise(uuid) from public, anon, authenticated;

create or replace function public.hr_svc_retention_mark(p_profile uuid, p_months integer) returns boolean
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
begin
 if p_months is null or p_months < 1 or p_months > 120 then raise exception 'Retention must be 1 to 120 months.' using errcode = '22023'; end if;
 update hr.staff_applications a set files_purged_at = now() from hr.staff_profiles p
  where a.profile_id = p.id and p.id = p_profile and p.status = 'rejected' and a.files_purged_at is null
   and p.status_changed_at < now() - make_interval(months => p_months);
 if not found then return false; end if;
 perform hr.staff_anonymise(p_profile);
 return true;
end $fn$;

do $grants$
declare f text;
begin
 foreach f in array array[
  'public.hr_svc_onboarding_open(text)', 'public.hr_svc_onboarding_save(text, jsonb)',
  'public.hr_svc_document_add(text, text, text, text, text, integer, date, uuid)', 'public.hr_svc_document_remove(text, uuid)',
  'public.hr_svc_document_set_expiry(text, uuid, date)', 'public.hr_svc_document_for_extraction(text, uuid)', 'public.hr_svc_onboarding_submit(text)',
  'public.hr_svc_upload_target(text, text, uuid)', 'public.hr_svc_document_path(text, uuid)',
  'public.hr_svc_offer_open(text)', 'public.hr_svc_offer_sign(text, uuid, text, text, text, text, text, text)',
  'public.hr_svc_email_claim(integer, integer, text[])', 'public.hr_svc_email_result(bigint, text, text, text)', 'public.hr_svc_email_log(uuid, text, text, text, text, jsonb)',
  'public.hr_svc_retention_due(integer, integer)', 'public.hr_svc_retention_mark(uuid, integer)'] loop
  execute format('revoke all on function %s from public, anon, authenticated', f);
  execute format('grant execute on function %s to service_role', f);
 end loop;
end $grants$;

-- Reading results fill empty profile fields only while the person is filling in (invited).
create or replace function public.hr_staff_document_apply_extraction(p_doc uuid, p_status text, p_extracted jsonb, p_error text default null) returns void
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare d hr.staff_documents; p hr.staff_profiles; x jsonb := coalesce(p_extracted, '{}'::jsonb); v_dob date;
begin
 if p_status not in ('processing','done','no_fields','failed','unavailable') then raise exception 'Unknown extraction status.' using errcode = '22023'; end if;
 select * into d from hr.staff_documents where id = p_doc and is_current for update;
 if not found then return; end if;
 update hr.staff_documents set extraction_status = p_status, extracted = case when p_status in ('done','no_fields') then x else extracted end,
  extracted_at = case when p_status in ('done','no_fields') then now() else extracted_at end, extraction_error = left(p_error, 500) where id = d.id;
 if p_status <> 'done' then return; end if;
 select * into p from hr.staff_profiles where id = d.profile_id;
 if p.status <> 'invited' then return; end if;
 if d.category = 'Passport' then
  begin v_dob := nullif(x->>'dob', '')::date; exception when others then v_dob := null; end;
  if v_dob is not null and (v_dob > current_date - interval '14 years' or v_dob < date '1900-01-01') then v_dob := null; end if;
  update hr.staff_profiles set
   first_name = case when first_name = '' then left(btrim(coalesce(x->>'first_name', '')), 100) else first_name end,
   middle_name = case when middle_name = '' then left(btrim(coalesce(x->>'middle_name', '')), 100) else middle_name end,
   last_name = case when last_name = '' then left(btrim(coalesce(x->>'last_name', '')), 100) else last_name end,
   date_of_birth = coalesce(date_of_birth, v_dob) where id = p.id;
 elsif d.category = 'Driving Licence' then
  update hr.staff_profiles set
   address_street = case when address_street = '' then left(btrim(coalesce(x->>'au_street', '')), 200) else address_street end,
   address_line2 = case when address_line2 = '' then left(btrim(coalesce(x->>'au_line2', '')), 200) else address_line2 end,
   address_suburb = case when address_suburb = '' then left(btrim(coalesce(x->>'au_suburb', '')), 100) else address_suburb end,
   address_state = case when address_state = '' then left(btrim(coalesce(x->>'au_state', '')), 100) else address_state end,
   address_postcode = case when address_postcode = '' then left(btrim(coalesce(x->>'au_zip', '')), 20) else address_postcode end,
   address_country = case when address_country = '' and coalesce(x->>'au_street', '') <> '' then 'Australia' else address_country end where id = p.id;
 end if;
end $fn$;

-- ------------------------------------------------------------------ admin
drop function if exists public.hr_admin_staff_list(text, text, integer, integer);
create or replace function public.hr_admin_staff_list(p_status text default null, p_search text default null, p_limit integer default 50, p_offset integer default 0,
 p_statuses text[] default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_search text := nullif(btrim(coalesce(p_search, '')), ''); v_total integer; v_rows jsonb;
 v_statuses text[] := case when nullif(btrim(coalesce(p_status, '')), '') is not null then array[btrim(p_status)] when cardinality(p_statuses) > 0 then p_statuses end;
begin
 perform hr.require_admin();
 if nullif(btrim(coalesce(p_status, '')), '') is not null and cardinality(p_statuses) > 0 then raise exception 'Use p_status or p_statuses, not both.' using errcode = '22023'; end if;
 if cardinality(p_statuses) > 10 then raise exception 'Too many statuses.' using errcode = '22023'; end if;
 if exists (select 1 from unnest(coalesce(v_statuses, '{}'::text[])) s where s is null or s not in ('applied','invited','documents_submitted','offer_sent','offer_signed','active','rejected','inactive')) then
  raise exception 'Unknown status.' using errcode = '22023'; end if;
 select count(*) into v_total from hr.staff_profiles p
  where (v_statuses is null or p.status = any(v_statuses))
   and (v_search is null or concat_ws(' ', p.first_name, p.middle_name, p.last_name, p.email, p.phone_e164) ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%');
 select coalesce(jsonb_agg(r order by (r->>'updatedAt') desc), '[]'::jsonb) into v_rows from (
  select jsonb_build_object('id', p.id, 'name', hr.staff_name(p), 'email', p.email, 'phone', p.phone_e164, 'status', p.status,
   'role', (select ro.role from hr.staff_roles ro where ro.profile_id = p.id and ro.revoked_at is null),
   'hasResume', a.resume_path is not null, 'appliedAt', p.created_at, 'submittedAt', a.submitted_at, 'joiningDate', a.joining_date,
   'updatedAt', p.updated_at, 'docs', hr.staff_doc_summary(p.id),
   'inviteExpiresAt', (select i.expires_at from hr.staff_invites i where i.profile_id = p.id and i.revoked_at is null and i.superseded_at is null and i.used_at is null
     order by i.created_at desc limit 1),
   'emailFailed', hr.staff_email_failed(p.id)) as r
  from hr.staff_profiles p join hr.staff_applications a on a.profile_id = p.id
  where (v_statuses is null or p.status = any(v_statuses))
   and (v_search is null or concat_ws(' ', p.first_name, p.middle_name, p.last_name, p.email, p.phone_e164) ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%')
  order by p.updated_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) q;
 return jsonb_build_object('total', v_total, 'rows', v_rows);
end $fn$;
revoke all on function public.hr_admin_staff_list(text, text, integer, integer, text[]) from public, anon;
grant execute on function public.hr_admin_staff_list(text, text, integer, integer, text[]) to authenticated;

create or replace function public.hr_admin_staff_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; a hr.staff_applications;
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 return jsonb_build_object('profile', to_jsonb(p) - 'auth_user_id', 'application', to_jsonb(a),
  'hasAccount', p.auth_user_id is not null,
  'documents', coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.category, d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'requiredCategories', to_jsonb(hr.staff_required_categories(p.is_australian_citizen)),
  'summary', hr.staff_doc_summary(p.id),
  'invites', coalesce((select jsonb_agg(hr.invite_json(i) order by i.created_at desc) from hr.staff_invites i where i.profile_id = p.id), '[]'::jsonb),
  'offers', coalesce((select jsonb_agg(hr.offer_json(o) order by o.uploaded_at desc) from hr.staff_offers o where o.profile_id = p.id), '[]'::jsonb),
  'emails', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'audience', e.audience, 'state', e.state, 'createdAt', e.created_at,
     'sentAt', e.sent_at, 'error', e.last_error, 'attempts', e.attempts,
     'retryable', e.state = 'failed' and e.kind not in ('document_invite','reupload_invite','offer')) order by e.id desc) from hr.staff_emails e where e.profile_id = p.id), '[]'::jsonb),
  'emailFailed', hr.staff_email_failed(p.id),
  'roles', coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'grantedAt', r.granted_at, 'revokedAt', r.revoked_at) order by r.granted_at) from hr.staff_roles r where r.profile_id = p.id), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id) from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb),
  'hasCmsAccess', exists (select 1 from public.cms_users c where c.auth_user_id = p.auth_user_id and c.status = 'Active'));
end $fn$;

-- Documents are reviewed once they were submitted at least once.
create or replace function public.hr_admin_staff_document_review(p_doc uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); d hr.staff_documents; p hr.staff_profiles; a hr.staff_applications; v_note text := btrim(coalesce(p_note, ''));
begin
 if p_decision not in ('approved','rejected') then raise exception 'Choose approve or reject.' using errcode = '22023'; end if;
 if p_decision = 'rejected' and v_note = '' then raise exception 'Add a note telling them what to fix.' using errcode = '22023'; end if;
 if char_length(v_note) > 2000 then raise exception 'The note is too long.' using errcode = '22023'; end if;
 select * into d from hr.staff_documents where id = p_doc and is_current for update;
 if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 select * into p from hr.staff_profiles where id = d.profile_id;
 select * into a from hr.staff_applications where profile_id = p.id;
 if p.auth_user_id = v_admin then raise exception 'You cannot review your own documents.' using errcode = '42501'; end if;
 if a.submitted_at is null or p.status in ('applied','rejected') then raise exception 'These documents have not been submitted yet.' using errcode = '23514'; end if;
 update hr.staff_documents set status = p_decision, review_note = v_note, reviewed_by = v_admin, reviewed_at = now() where id = d.id;
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_staff_document_review(uuid, text, text) from public, anon;
grant execute on function public.hr_admin_staff_document_review(uuid, text, text) to authenticated;

-- Reject from any status before active. Live links are revoked, an unsigned offer is withdrawn, any role is revoked, and the
-- rejection email is queued unless p_notify is false (the UI checkbox, ticked by default).
drop function if exists public.hr_admin_staff_reject(uuid, text);
create or replace function public.hr_admin_staff_reject(p_id uuid, p_note text, p_notify boolean default true) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles;
begin
 if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Add a note explaining the decision.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('applied','invited','documents_submitted','offer_sent','offer_signed') then raise exception 'Only an application in progress can be rejected.' using errcode = '23514'; end if;
 if p.auth_user_id = v_admin then raise exception 'You cannot reject your own application.' using errcode = '42501'; end if;
 update hr.staff_invites set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and revoked_at is null and superseded_at is null and used_at is null;
 update hr.staff_offers set withdrawn_at = now(), withdrawn_by = v_admin where profile_id = p.id and withdrawn_at is null and signed_at is null;
 update hr.staff_roles set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and revoked_at is null;
 perform hr.staff_move(p.id, 'rejected', btrim(p_note), v_admin, true);
 if coalesce(p_notify, true) then perform hr.queue_email(p.id, 'rejected', 'applicant'); end if;
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_staff_reject(uuid, text, boolean) from public, anon;
grant execute on function public.hr_admin_staff_reject(uuid, text, boolean) to authenticated;

-- rejected > applied (an admin reopens it; the person can then be invited again).
create or replace function public.hr_staff_reopen(p_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles;
begin
 if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Add a note explaining why this is reopened.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'rejected' then raise exception 'Only a rejected application can be reopened.' using errcode = '23514'; end if;
 if exists (select 1 from hr.staff_applications a where a.profile_id = p.id and a.files_purged_at is not null) then
  raise exception 'This application''s personal data was removed under the retention rule; the person can apply again.' using errcode = '23514'; end if;
 perform hr.staff_move(p.id, 'applied', btrim(p_note), v_admin, false);
 update hr.staff_applications set submitted_at = null where profile_id = p.id;
 return public.hr_admin_staff_detail(p.id);
end $fn$;

-- Document link (applied, or a resend while invited for documents) or re-upload link (documents_submitted with a rejected
-- document, or a resend while invited for re-upload). The Edge Function made the token and passes only its sha256; it mails the
-- link. A new link replaces the old one.
create or replace function public.hr_admin_staff_invite(p_id uuid, p_purpose text, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; a hr.staff_applications; i hr.staff_invites; v_live text;
begin
 if p_purpose not in ('documents','reupload') then raise exception 'Choose a document or re-upload link.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 select purpose into v_live from hr.staff_invites where profile_id = p.id and purpose <> 'offer' order by created_at desc limit 1;
 if p_purpose = 'documents' then
  if not (p.status = 'applied' or (p.status = 'invited' and v_live = 'documents')) then raise exception 'A document link can be sent to a new application only.' using errcode = '23514'; end if;
 else
  if not ((p.status = 'documents_submitted' or (p.status = 'invited' and v_live = 'reupload'))
     and exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.is_current and d.status = 'rejected')) then
   raise exception 'Reject at least one document before asking for a new upload.' using errcode = '23514'; end if;
 end if;
 i := hr.invite_create(p.id, p_purpose, p_token_hash, v_admin);
 if p.status <> 'invited' then
  perform hr.staff_move(p.id, 'invited', case p_purpose when 'documents' then 'Document link sent' else 'Re-upload link sent' end, v_admin, false);
 end if;
 return jsonb_build_object('invite', hr.invite_json(i), 'email', p.email, 'name', hr.staff_name(p),
  'rejected', coalesce((select jsonb_agg(jsonb_build_object('category', d.category, 'note', d.review_note)) from hr.staff_documents d
    where d.profile_id = p.id and d.is_current and d.status = 'rejected'), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_admin_staff_invite(uuid, text, text) from public, anon;
grant execute on function public.hr_admin_staff_invite(uuid, text, text) to authenticated;

-- True when an email to or about this person failed and no later email of the same kind went out.
create or replace function hr.staff_email_failed(p_profile uuid) returns boolean
language sql stable security definer set search_path = hr, pg_temp as $fn$
 select exists (select 1 from hr.staff_emails e where e.profile_id = p_profile and e.state = 'failed'
  and not exists (select 1 from hr.staff_emails l where l.profile_id = e.profile_id and l.kind = e.kind and l.state = 'sent' and l.id > e.id));
$fn$;
revoke all on function hr.staff_email_failed(uuid) from public, anon, authenticated;

-- How many requests a rate-limit bucket holds in its current window, WITHOUT counting this one (staff-onboarding checks its
-- invalid-link bucket before doing anything). Reads public.public_assistant_rate_limits, the store of
-- public_assistant_take_rate_limit.
create or replace function public.hr_svc_rate_count(p_bucket text, p_window_seconds integer) returns integer
language sql stable security definer set search_path = public, pg_temp as $fn$
 select coalesce((select r.request_count from public.public_assistant_rate_limits r where r.bucket = p_bucket
  and r.window_started_at + make_interval(secs => p_window_seconds) > now()), 0);
$fn$;
revoke all on function public.hr_svc_rate_count(text, integer) from public, anon, authenticated;
grant execute on function public.hr_svc_rate_count(text, integer) to service_role;

-- A link email that could not be sent: staff-admin cancels THAT link at once, so a link nobody received never stays valid and a
-- retry ("send again") makes exactly one new live link. Only a live link of this person can be cancelled.
create or replace function public.hr_admin_staff_invite_cancel(p_id uuid, p_invite uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin();
begin
 update hr.staff_invites set revoked_at = now(), revoked_by = v_admin
  where id = p_invite and profile_id = p_id and revoked_at is null and superseded_at is null and used_at is null;
 if not found then raise exception 'There is no live link to cancel.' using errcode = 'P0002'; end if;
 return public.hr_admin_staff_detail(p_id);
end $fn$;
revoke all on function public.hr_admin_staff_invite_cancel(uuid, uuid) from public, anon;
grant execute on function public.hr_admin_staff_invite_cancel(uuid, uuid) to authenticated;

-- Puts a FAILED queued email (not a link email: those are sent again with a new link) back in the queue for another try.
create or replace function public.hr_admin_staff_email_retry(p_email bigint) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); e hr.staff_emails;
begin
 select * into e from hr.staff_emails where id = p_email for update;
 if not found then raise exception 'Email not found.' using errcode = 'P0002'; end if;
 if e.kind in ('document_invite','reupload_invite','offer') then raise exception 'Send the link again instead: a new link replaces the old one.' using errcode = '23514'; end if;
 if e.state <> 'failed' then raise exception 'Only a failed email can be sent again.' using errcode = '23514'; end if;
 update hr.staff_emails set state = 'queued', attempts = 0, lease_until = null, last_error = null where id = e.id;
 return public.hr_admin_staff_detail(e.profile_id);
end $fn$;
revoke all on function public.hr_admin_staff_email_retry(bigint) from public, anon;
grant execute on function public.hr_admin_staff_email_retry(bigint) to authenticated;

-- Revokes the live link of that kind ('documents' covers document and re-upload links). The status does not change; the admin
-- can send a new link.
create or replace function public.hr_admin_staff_invite_revoke(p_id uuid, p_purpose text default 'documents') returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin();
begin
 if p_purpose not in ('documents','offer') then raise exception 'Choose the document or the offer link.' using errcode = '22023'; end if;
 update hr.staff_invites set revoked_at = now(), revoked_by = v_admin
  where profile_id = p_id and (purpose = 'offer') = (p_purpose = 'offer') and revoked_at is null and superseded_at is null and used_at is null;
 if not found then raise exception 'There is no live link to revoke.' using errcode = 'P0002'; end if;
 return public.hr_admin_staff_detail(p_id);
end $fn$;
revoke all on function public.hr_admin_staff_invite_revoke(uuid, text) from public, anon;
grant execute on function public.hr_admin_staff_invite_revoke(uuid, text) to authenticated;

-- The offer PDF the function uploaded to {profile}/offer/{file}; replaces an unsent one (returned for deletion).
create or replace function public.hr_admin_staff_offer_add(p_id uuid, p_path text, p_filename text, p_size integer, p_sha256 text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; o hr.staff_offers; v_old text;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'documents_submitted' then raise exception 'Upload an offer once the documents are submitted (withdraw a sent offer first).' using errcode = '23514'; end if;
 if not hr.staff_path_ok(p_path, p.id, 'offer') then raise exception 'The offer location is not valid.' using errcode = '22023'; end if;
 if p_size is null or p_size < 1 or p_size > 10485760 then raise exception 'The offer must be 10 MB or smaller.' using errcode = '22023'; end if;
 if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'The offer hash is not valid.' using errcode = '22023'; end if;
 if not hr.staff_object_exists(p_path) then raise exception 'The uploaded file was not found.' using errcode = 'P0002'; end if;
 update hr.staff_offers set withdrawn_at = now(), withdrawn_by = v_admin where profile_id = p.id and withdrawn_at is null and signed_at is null and sent_at is null
  returning storage_path into v_old;
 insert into hr.staff_offers(profile_id, storage_path, filename, file_size, sha256, uploaded_by)
  values (p.id, p_path, left(btrim(coalesce(p_filename, 'offer.pdf')), 255), p_size, p_sha256, v_admin) returning * into o;
 return jsonb_build_object('offer', hr.offer_json(o), 'replacedPath', v_old);
end $fn$;
revoke all on function public.hr_admin_staff_offer_add(uuid, text, text, integer, text) from public, anon;
grant execute on function public.hr_admin_staff_offer_add(uuid, text, text, integer, text) to authenticated;

-- Sends the uploaded offer (documents_submitted > offer_sent; every required document approved and unexpired) or resends it
-- (offer_sent: a new link replaces the old one).
create or replace function public.hr_admin_staff_offer_send(p_id uuid, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; o hr.staff_offers; i hr.staff_invites; v_problem text;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('documents_submitted','offer_sent') then raise exception 'An offer can be sent after the documents are submitted.' using errcode = '23514'; end if;
 if p.auth_user_id = v_admin then raise exception 'You cannot send yourself an offer.' using errcode = '42501'; end if;
 select * into o from hr.staff_offers where profile_id = p.id and withdrawn_at is null and signed_at is null for update;
 if not found then raise exception 'Upload the offer letter first.' using errcode = '23514'; end if;
 if p.status = 'documents_submitted' then
  v_problem := hr.staff_documents_problem(p.id);
  if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
  update hr.staff_offers set sent_at = now(), sent_by = v_admin where id = o.id returning * into o;
 end if;
 i := hr.invite_create(p.id, 'offer', p_token_hash, v_admin);
 if p.status = 'documents_submitted' then perform hr.staff_move(p.id, 'offer_sent', 'Offer sent', v_admin, false); end if;
 return jsonb_build_object('invite', hr.invite_json(i), 'offer', hr.offer_json(o), 'email', p.email, 'name', hr.staff_name(p));
end $fn$;
revoke all on function public.hr_admin_staff_offer_send(uuid, text) from public, anon;
grant execute on function public.hr_admin_staff_offer_send(uuid, text) to authenticated;

create or replace function public.hr_admin_staff_offer_withdraw(p_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles;
begin
 if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'Add a note explaining why the offer is withdrawn.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'offer_sent' then raise exception 'Only a sent, unsigned offer can be withdrawn.' using errcode = '23514'; end if;
 update hr.staff_offers set withdrawn_at = now(), withdrawn_by = v_admin where profile_id = p.id and withdrawn_at is null and signed_at is null;
 update hr.staff_invites set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and purpose = 'offer' and revoked_at is null and superseded_at is null and used_at is null;
 perform hr.staff_move(p.id, 'documents_submitted', btrim(p_note), v_admin, false);
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_staff_offer_withdraw(uuid, text) from public, anon;
grant execute on function public.hr_admin_staff_offer_withdraw(uuid, text) to authenticated;

-- offer_signed > active, writing cms_users for the Admin role only (a trainer gets My HR, never CMS access).
create or replace function hr.staff_grant_access(p_profile uuid, p_actor uuid, p_actor_kind text, p_note text) returns void
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; v_role text; c public.cms_users;
begin
 select * into p from hr.staff_profiles where id = p_profile for update;
 select role into v_role from hr.staff_roles where profile_id = p.id and revoked_at is null;
 if v_role is null or p.auth_user_id is null then raise exception 'Activate the person with a role first.' using errcode = '23514'; end if;
 if v_role = 'admin' then
  select * into c from public.cms_users where auth_user_id = p.auth_user_id;
  if found then
   update public.cms_users set role = 'Admin', status = 'Active', must_change_password = false where id = c.id;
  else
   if exists (select 1 from public.cms_users where lower(email) = p.email) then raise exception 'A CMS user with this email already exists.' using errcode = '23505'; end if;
   insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password)
    values (gen_random_uuid()::text, hr.staff_name(p), p.email, 'Admin', 'Active', p.auth_user_id, false);
  end if;
 end if;
 perform set_config('hr.actor', coalesce(p_actor::text, ''), true); perform set_config('hr.actor_kind', p_actor_kind, true); perform set_config('hr.note', p_note, true);
 update hr.staff_profiles set status = 'active' where id = p.id;
end $fn$;
revoke all on function hr.staff_grant_access(uuid, uuid, text, text) from public, anon, authenticated;

-- Activation, in two calls from staff-admin. The login is never taken on trust: this function looks it up by the applicant's
-- email (case-insensitive) itself, and p_auth_user_id only has to agree with what it found.
--   p_auth_user_id null: checks only (status offer_signed, role, joining date); returns the email and whether a CONFIRMED login
--   already exists for it (then staff-admin skips the Auth invite). Nothing changes.
--   p_auth_user_id set: must equal the single login found for the email, and not belong to another staff profile. The role and
--   joining date are recorded. A confirmed login (an existing student/agent) is activated at once. An unconfirmed login is
--   accepted only when it was created by an Auth invite and never signed in (just invited): the person then becomes active
--   through hr_staff_claim_account() after setting a password. Any other unconfirmed login is refused.
create or replace function public.hr_admin_staff_activate_account(p_id uuid, p_role text, p_joining_date date, p_auth_user_id uuid default null,
 p_confirm_admin boolean default false) returns jsonb
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; u auth.users; v_current text; v_logins integer;
begin
 if p_role is null or p_role not in ('admin','trainer') then raise exception 'Choose Admin or Trainer.' using errcode = '22023'; end if;
 if p_role = 'admin' and p_confirm_admin is not true then raise exception 'Confirm that this person should become an Admin.' using errcode = '23514'; end if;
 if p_joining_date is null or p_joining_date < current_date - 365 or p_joining_date > current_date + 730 then raise exception 'Enter the joining date.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'offer_signed' then raise exception 'Only a person who signed the offer can be activated.' using errcode = '23514'; end if;
 if p.auth_user_id is not null and p.auth_user_id = v_admin then raise exception 'You cannot activate your own account.' using errcode = '42501'; end if;
 select count(*) into v_logins from auth.users where lower(btrim(coalesce(email, ''))) = p.email;
 if v_logins > 1 then raise exception 'More than one login uses this email; resolve that first.' using errcode = '23505'; end if;
 select * into u from auth.users where lower(btrim(coalesce(email, ''))) = p.email;
 if p_auth_user_id is null then
  return jsonb_build_object('ok', true, 'email', p.email, 'name', hr.staff_name(p), 'existingLogin', u.id is not null and u.email_confirmed_at is not null);
 end if;
 if u.id is null or u.id <> p_auth_user_id then raise exception 'That login does not belong to this person.' using errcode = '42501'; end if;
 if u.email_confirmed_at is null and (u.invited_at is null or u.last_sign_in_at is not null) then
  raise exception 'That login has not confirmed its email.' using errcode = '42501'; end if;
 if p_auth_user_id = v_admin then raise exception 'You cannot activate your own account.' using errcode = '42501'; end if;
 if exists (select 1 from hr.staff_profiles s where s.auth_user_id = p_auth_user_id and s.id <> p.id) then raise exception 'That login already belongs to another staff member.' using errcode = '23505'; end if;
 update hr.staff_profiles set auth_user_id = p_auth_user_id where id = p.id;
 update hr.staff_applications set joining_date = p_joining_date, account_invited_at = now(), reviewed_by = v_admin, reviewed_at = now() where profile_id = p.id;
 select role into v_current from hr.staff_roles where profile_id = p.id and revoked_at is null;
 if v_current is distinct from p_role then
  update hr.staff_roles set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and revoked_at is null;
  insert into hr.staff_roles(profile_id, role, granted_by) values (p.id, p_role, v_admin);
 end if;
 if u.email_confirmed_at is not null then
  perform hr.staff_grant_access(p.id, v_admin, 'admin', 'Activated as ' || p_role || ' on the existing login');
  -- No Auth invite on this path: HR tells the person their staff access is ready on the login they already have.
  perform hr.queue_email(p.id, 'access_ready', 'applicant', jsonb_build_object('role', p_role));
  return jsonb_build_object('ok', true, 'activated', true, 'detail', public.hr_admin_staff_detail(p.id));
 end if;
 return jsonb_build_object('ok', true, 'activated', false, 'detail', public.hr_admin_staff_detail(p.id));
end $fn$;
revoke all on function public.hr_admin_staff_activate_account(uuid, text, date, uuid, boolean) from public, anon;
grant execute on function public.hr_admin_staff_activate_account(uuid, text, date, uuid, boolean) to authenticated;

-- inactive > active (reactivation). Activation from offer_signed is hr_admin_staff_activate_account.
create or replace function public.hr_admin_staff_activate(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; v_role text;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'inactive' then raise exception 'Only an inactive person can be reactivated.' using errcode = '23514'; end if;
 if p.auth_user_id = v_admin then raise exception 'You cannot reactivate yourself.' using errcode = '42501'; end if;
 select role into v_role from hr.staff_roles where profile_id = p.id and revoked_at is null;
 perform hr.staff_grant_access(p.id, v_admin, 'admin', coalesce(nullif(btrim(p_note), ''), 'Reactivated as ' || coalesce(v_role, 'staff')));
 return public.hr_admin_staff_detail(p.id);
end $fn$;

-- ------------------------------------------------------------------ the activated person
-- Called by /staff/welcome after the person set a password from the Auth invite: offer_signed > active. Idempotent.
create or replace function public.hr_staff_claim_account() returns jsonb
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; a hr.staff_applications;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid for update;
 if not found then raise exception 'There is no staff account for this login.' using errcode = 'P0002'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 if p.status = 'offer_signed' and a.account_invited_at is not null then
  if not exists (select 1 from auth.users u where u.id = v_uid and u.email_confirmed_at is not null) then
   raise exception 'Confirm your email first.' using errcode = '42501'; end if;
  perform hr.staff_grant_access(p.id, v_uid, 'applicant', 'Account activated');
 end if;
 return public.hr_staff_me();
end $fn$;
revoke all on function public.hr_staff_claim_account() from public, anon;
grant execute on function public.hr_staff_claim_account() to authenticated;

-- My HR: the signed-in person's profile, current documents with expiry, role, joining date and signed offer.
create or replace function public.hr_staff_me() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; a hr.staff_applications;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid;
 if not found then return null; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 return jsonb_build_object(
  'profile', to_jsonb(p) - 'auth_user_id',
  'status', p.status,
  'role', (select r.role from hr.staff_roles r where r.profile_id = p.id and r.revoked_at is null),
  'joiningDate', a.joining_date,
  'documents', case when p.status = 'active' then coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.category, d.created_at)
     from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb) else '[]'::jsonb end,
  'signedOffer', case when p.status = 'active' then (select jsonb_build_object('id', o.id, 'signedAt', o.signed_at, 'signedPath', o.signed_path, 'filename', o.filename)
     from hr.staff_offers o where o.profile_id = p.id and o.signed_at is not null order by o.signed_at desc limit 1) end);
end $fn$;

-- ------------------------------------------------------------------ retention job (HR-02h)
-- Daily at 03:15 UTC pg_cron calls public.hr_retention_dispatch(), which POSTs {"action":"purge"} to staff-admin with the service-role
-- key from Vault (never in this file, the job command or a log). staff-admin deletes the storage files of applications rejected more
-- than EF_HR_RETENTION_MONTHS months ago (default 6) and marks them files_purged_at. The job is created INACTIVE; the owner turns it on
-- at release, after storing the Vault secrets:
--   select vault.create_secret('<service_role key>', 'hr_retention_service_role_key', 'HR retention job');
--   select vault.create_secret('https://xcpydisstlvtvcsqnjob.supabase.co/functions/v1/staff-admin', 'hr_retention_function_url', 'HR retention job');
--   select cron.alter_job((select jobid from cron.job where jobname = 'hr-retention-purge'), active := true);
-- Without both secrets the dispatcher does nothing. Pause: active := false. Remove: select cron.unschedule('hr-retention-purge');
create extension if not exists pg_net;
create extension if not exists pg_cron;
create or replace function public.hr_retention_dispatch() returns bigint
language plpgsql security definer set search_path = public, vault, net, pg_temp as $fn$
declare v_key text; v_url text;
begin
 if not pg_try_advisory_xact_lock(9342, 20261109) then return null; end if;
 select decrypted_secret into v_key from vault.decrypted_secrets where name = 'hr_retention_service_role_key' limit 1;
 select decrypted_secret into v_url from vault.decrypted_secrets where name = 'hr_retention_function_url' limit 1;
 if nullif(v_key, '') is null or nullif(v_url, '') is null or v_url !~ '^https?://[^/]+/functions/v1/staff-admin$' then return null; end if;
 -- Nothing due: no call.
 if not exists (select 1 from hr.staff_profiles p join hr.staff_applications a on a.profile_id = p.id
   where p.status = 'rejected' and a.files_purged_at is null and p.status_changed_at < now() - interval '1 month') then return null; end if;
 return net.http_post(url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
  body := '{"action":"purge"}'::jsonb, timeout_milliseconds := 55000);
end $fn$;
revoke all on function public.hr_retention_dispatch() from public, anon, authenticated, service_role;
grant execute on function public.hr_retention_dispatch() to postgres;
do $job$
declare v_job bigint;
begin
 select jobid into v_job from cron.job where jobname = 'hr-retention-purge' order by jobid limit 1;
 if v_job is null then
  v_job := cron.schedule('hr-retention-purge', '15 3 * * *', 'select public.hr_retention_dispatch();');
  perform cron.alter_job(v_job, active := false);
 end if;
end $job$;

-- ------------------------------------------------------------------ admin sidebar: Staff becomes its own top-level group
-- A top-level "Staff" group right after "Agencies & Agents", with the existing 'agency_staff' row moved under it as
-- "Employees" (/admin/staff/employees). The row is UPDATED, not re-created, and keeps its id: 20261105200000 and the
-- release-staff check scripts refer to 'agency_staff'. The group copies that row's permission (admin-only today).
-- Safe to re-run. Fails loudly (nothing changed) when 'agencies' or 'agency_staff' is missing, or an unrelated 'staff' row exists.
do $menu$
declare v_item public.admin_menu_items; v_after integer; v_next integer;
begin
 select * into v_item from public.admin_menu_items where id = 'agency_staff';
 if not found then raise exception 'The admin menu item "agency_staff" does not exist. Nothing was changed.'; end if;
 select sort_order into v_after from public.admin_menu_items where id = 'agencies' and parent_id is null;
 if v_after is null then raise exception 'The top-level admin menu group "agencies" does not exist. Nothing was changed.'; end if;
 if exists (select 1 from public.admin_menu_items where id = 'staff' and (parent_id is not null or route is not null)) then
  raise exception 'An admin menu row "staff" already exists and is not the Staff group. Nothing was changed.'; end if;
 select min(sort_order) into v_next from public.admin_menu_items where parent_id is null and id <> 'staff' and sort_order > v_after;
 if not exists (select 1 from public.admin_menu_items where id = 'staff') and v_next is not null and v_next - v_after < 2 then
  raise exception 'No free menu position between "agencies" (%) and the next group (%). Nothing was changed.', v_after, v_next; end if;

 alter table public.admin_menu_items disable trigger protect_admin_menu;
 insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, is_enabled, permission_key, permission_scope, is_system)
  values ('staff', null, 'Staff', null, 'users', case when v_next is null then v_after + 10 else v_after + (v_next - v_after) / 2 end, true,
   v_item.permission_key, v_item.permission_scope, true)
 on conflict (id) do update set parent_id = null, route = null, is_enabled = true,
  permission_key = excluded.permission_key, permission_scope = excluded.permission_scope;
 update public.admin_menu_items set parent_id = 'staff', label = 'Employees', route = '/admin/staff/employees', sort_order = 10, is_enabled = true
  where id = 'agency_staff';
 alter table public.admin_menu_items enable trigger protect_admin_menu;
end $menu$;
