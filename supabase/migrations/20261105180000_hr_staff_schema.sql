-- Staff self-registration, part 1 of 3: the `hr` schema (future HRMS), tables, indexes, RLS, status guard and the private
-- document bucket. Nothing here touches an existing table: students, agents, agencies, portal and CMS users are unchanged.
-- Part 2 (20261105190000) adds the RPCs; part 3 (20261105200000) adds the admin sidebar item.
--
-- * The `hr` schema is NOT exposed through the Data API (PostgREST serves `public` only). The browser reaches it through the
--   SECURITY DEFINER hr_* functions in part 2; RLS and column grants below still hold if the schema is ever exposed.
-- * Status changes happen only through those functions (column grants leave `status` to service/definer code); the trigger
--   below validates every transition and logs it in hr.staff_status_events, so a change made any other way is logged too.
-- * Applicants can read their own rows and edit them only while the profile is a draft; Admins (public.cms_is_admin()) read all.
-- Rollback (manual, nothing else depends on it): drop the storage policies staff_documents_*, delete the bucket staff-documents
-- (after emptying it), drop schema hr cascade, drop the public hr_* functions from parts 2 and 3.
set local lock_timeout='5s';
set local statement_timeout='60s';

create schema if not exists hr;
revoke all on schema hr from public, anon;
grant usage on schema hr to authenticated, service_role;

-- ------------------------------------------------------------------ phone and email normalisation
-- E.164 or null. Accepts "+61 412 345 678", "+61 (0)412 345 678", "0061412345678", "0412 345 678" (Australian national
-- number) and any other "+<country><number>" of 8 to 15 digits. Anything ambiguous (no + and not Australian) is null.
-- The TypeScript twin is src/lib/staffPhone.ts; both are tested against the same vectors.
create or replace function hr.phone_e164(p_phone text) returns text
language sql immutable parallel safe as $fn$
 select case
  when raw is null or raw = '' then null
  when raw ~ '^\+[1-9]\d{7,14}$' then raw
  when raw ~ '^00[1-9]\d{7,14}$' then '+' || substr(raw, 3)
  when raw ~ '^04\d{8}$' or raw ~ '^0[2378]\d{8}$' then '+61' || substr(raw, 2)
  else null end
 from (select regexp_replace(regexp_replace(coalesce(p_phone, ''), '\(0\)', '', 'g'), '[\s().\-]', '', 'g') as raw) x;
$fn$;

create or replace function hr.email_key(p_email text) returns text
language sql immutable parallel safe as $fn$ select nullif(lower(btrim(coalesce(p_email, ''))), ''); $fn$;

-- ------------------------------------------------------------------ tables
create table hr.staff_profiles (
 id uuid primary key default gen_random_uuid(),
 auth_user_id uuid not null unique references auth.users(id) on delete restrict,
 first_name text not null default '' check (char_length(first_name) <= 100),
 middle_name text not null default '' check (char_length(middle_name) <= 100),
 last_name text not null default '' check (char_length(last_name) <= 100),
 date_of_birth date check (date_of_birth is null or (date_of_birth <= current_date - interval '14 years' and date_of_birth >= date '1900-01-01')),
 email text not null check (email = lower(btrim(email)) and char_length(email) <= 254),
 phone_e164 text not null check (phone_e164 ~ '^\+[1-9]\d{7,14}$'),
 address_street text not null default '' check (char_length(address_street) <= 200),
 address_line2 text not null default '' check (char_length(address_line2) <= 200),
 address_suburb text not null default '' check (char_length(address_suburb) <= 100),
 address_state text not null default '' check (char_length(address_state) <= 100),
 address_postcode text not null default '' check (char_length(address_postcode) <= 20),
 address_country text not null default '' check (char_length(address_country) <= 100),
 emergency_name text not null default '' check (char_length(emergency_name) <= 200),
 emergency_relationship text not null default '' check (char_length(emergency_relationship) <= 100),
 emergency_phone_e164 text check (emergency_phone_e164 is null or emergency_phone_e164 ~ '^\+[1-9]\d{7,14}$'),
 status text not null default 'draft' check (status in ('draft','submitted','preboarding','active','rejected','inactive')),
 status_changed_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index staff_profiles_email_key on hr.staff_profiles(email);
create unique index staff_profiles_phone_key on hr.staff_profiles(phone_e164);
create index staff_profiles_status_idx on hr.staff_profiles(status, updated_at desc);

create table hr.staff_applications (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null unique references hr.staff_profiles(id) on delete restrict,
 -- A request only: nothing is granted until an Admin approves (hr.staff_roles).
 requested_role text check (requested_role in ('admin','trainer')),
 submitted_at timestamptz,
 reviewed_by uuid,
 reviewed_at timestamptz,
 review_note text not null default '' check (char_length(review_note) <= 2000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table hr.staff_documents (
 id uuid primary key default gen_random_uuid(),
 application_id uuid not null references hr.staff_applications(id) on delete restrict,
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 category text not null check (category in ('Passport','Visa','Driving Licence','PTE','English Certificate')),
 bucket_name text not null default 'staff-documents' check (bucket_name = 'staff-documents'),
 storage_path text not null unique check (char_length(storage_path) <= 400),
 filename text not null check (char_length(filename) between 1 and 255),
 mime_type text not null check (mime_type in ('application/pdf','image/png','image/jpeg')),
 file_size integer not null check (file_size between 1 and 10485760),
 is_current boolean not null default true,
 extraction_status text not null default 'pending' check (extraction_status in ('pending','processing','done','no_fields','failed','unavailable')),
 extracted jsonb not null default '{}'::jsonb,
 extracted_at timestamptz,
 extraction_error text check (extraction_error is null or char_length(extraction_error) <= 500),
 created_at timestamptz not null default now()
);
create unique index staff_documents_one_current on hr.staff_documents(application_id, category) where is_current;
create index staff_documents_profile_idx on hr.staff_documents(profile_id);

create table hr.staff_roles (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 role text not null check (role in ('admin','trainer')),
 granted_by uuid not null,
 granted_at timestamptz not null default now(),
 revoked_at timestamptz,
 revoked_by uuid
);
-- One live role per person; an Admin's decision replaces it, it is never self-assigned.
create unique index staff_roles_one_active on hr.staff_roles(profile_id) where revoked_at is null;

create table hr.staff_status_events (
 id bigint generated always as identity primary key,
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 from_status text check (from_status is null or from_status in ('draft','submitted','preboarding','active','rejected','inactive')),
 to_status text not null check (to_status in ('draft','submitted','preboarding','active','rejected','inactive')),
 actor_id uuid,
 actor_kind text not null default 'applicant' check (actor_kind in ('applicant','admin','system')),
 note text not null default '' check (char_length(note) <= 2000),
 created_at timestamptz not null default now()
);
create index staff_status_events_profile_idx on hr.staff_status_events(profile_id, id);

-- ------------------------------------------------------------------ status guard and log
-- Allowed moves. rejected -> draft is the Admin-only reopen; inactive -> active is an Admin reactivation.
create or replace function hr.staff_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable parallel safe as $fn$
 select (p_from, p_to) in (
  ('draft','submitted'), ('submitted','preboarding'), ('submitted','rejected'),
  ('preboarding','active'), ('preboarding','rejected'),
  ('active','inactive'), ('inactive','active'), ('rejected','draft'));
$fn$;

create function hr.staff_status_guard() returns trigger
language plpgsql set search_path = hr, public as $$
begin
 if tg_op = 'INSERT' then
  if new.status <> 'draft' then raise exception 'A staff profile starts as a draft.' using errcode = '23514'; end if;
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
create trigger staff_status_guard before insert or update on hr.staff_profiles for each row execute function hr.staff_status_guard();

-- Every change is logged: actor and note come from the transaction settings the hr_* functions set (hr.actor, hr.actor_kind,
-- hr.note); a change made any other way is still logged, with the signed-in user or as 'system'.
create function hr.staff_status_log() returns trigger
language plpgsql security definer set search_path = hr, public as $$
declare v_actor uuid := coalesce(nullif(current_setting('hr.actor', true), '')::uuid, auth.uid());
 v_kind text := coalesce(nullif(current_setting('hr.actor_kind', true), ''), case when auth.uid() is null then 'system' else 'applicant' end);
begin
 if tg_op = 'INSERT' or new.status is distinct from old.status then
  insert into hr.staff_status_events(profile_id, from_status, to_status, actor_id, actor_kind, note)
   values (new.id, case when tg_op = 'INSERT' then null else old.status end, new.status, v_actor, v_kind, left(coalesce(current_setting('hr.note', true), ''), 2000));
 end if;
 return new;
end $$;
create trigger staff_status_log after insert or update on hr.staff_profiles for each row execute function hr.staff_status_log();

create function hr.staff_events_append_only() returns trigger language plpgsql as $$
begin raise exception 'The staff status log is append-only.' using errcode = '23514'; end $$;
create trigger staff_events_no_change before update or delete on hr.staff_status_events for each row execute function hr.staff_events_append_only();
create trigger staff_events_no_truncate before truncate on hr.staff_status_events for each statement execute function hr.staff_events_append_only();

create function hr.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger staff_applications_touch before update on hr.staff_applications for each row execute function hr.touch_updated_at();

-- ------------------------------------------------------------------ privileges and RLS
alter table hr.staff_profiles enable row level security;
alter table hr.staff_applications enable row level security;
alter table hr.staff_documents enable row level security;
alter table hr.staff_roles enable row level security;
alter table hr.staff_status_events enable row level security;

revoke all on all tables in schema hr from public, anon, authenticated, service_role;
revoke all on all sequences in schema hr from public, anon, authenticated, service_role;
grant select on hr.staff_profiles, hr.staff_applications, hr.staff_documents, hr.staff_roles, hr.staff_status_events to authenticated;
-- An applicant edits personal details only: never status, role, review fields, email or phone (those go through functions).
grant update (first_name, middle_name, last_name, date_of_birth, address_street, address_line2, address_suburb, address_state,
 address_postcode, address_country, emergency_name, emergency_relationship, emergency_phone_e164) on hr.staff_profiles to authenticated;
grant update (requested_role) on hr.staff_applications to authenticated;
grant select, insert, update, delete on hr.staff_profiles, hr.staff_applications, hr.staff_documents, hr.staff_roles, hr.staff_status_events to service_role;
grant usage, select on all sequences in schema hr to service_role;

create policy staff_profiles_read on hr.staff_profiles for select to authenticated
 using (auth_user_id = auth.uid() or public.cms_is_admin());
create policy staff_profiles_edit_own_draft on hr.staff_profiles for update to authenticated
 using (auth_user_id = auth.uid() and status = 'draft') with check (auth_user_id = auth.uid() and status = 'draft');

create policy staff_applications_read on hr.staff_applications for select to authenticated
 using (public.cms_is_admin() or exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid()));
create policy staff_applications_edit_own_draft on hr.staff_applications for update to authenticated
 using (exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid() and p.status = 'draft'))
 with check (exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid() and p.status = 'draft'));

create policy staff_documents_read on hr.staff_documents for select to authenticated
 using (public.cms_is_admin() or exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid()));
create policy staff_roles_read on hr.staff_roles for select to authenticated
 using (public.cms_is_admin() or exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid()));
create policy staff_status_events_read on hr.staff_status_events for select to authenticated
 using (public.cms_is_admin() or exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid()));

-- ------------------------------------------------------------------ private document bucket
-- Path: {auth uid}/{application id}/{file}. Only the owner (while still a draft) writes; the owner and Admins read.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
 values ('staff-documents', 'staff-documents', false, 10485760, array['application/pdf','image/png','image/jpeg'])
 on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;

create policy staff_documents_owner_insert on storage.objects for insert to authenticated
 with check (bucket_id = 'staff-documents' and (storage.foldername(name))[1] = auth.uid()::text
  and exists (select 1 from hr.staff_profiles p where p.auth_user_id = auth.uid() and p.status = 'draft'));
create policy staff_documents_owner_delete on storage.objects for delete to authenticated
 using (bucket_id = 'staff-documents' and (storage.foldername(name))[1] = auth.uid()::text
  and exists (select 1 from hr.staff_profiles p where p.auth_user_id = auth.uid() and p.status = 'draft'));
create policy staff_documents_read on storage.objects for select to authenticated
 using (bucket_id = 'staff-documents' and ((storage.foldername(name))[1] = auth.uid()::text or public.cms_is_admin()));
