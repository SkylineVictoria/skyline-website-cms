-- Staff enrolment rework (extends the hr schema of 20261105180000/190000; additive, no table or row is dropped).
--   * Sign-up is email + password with Supabase email confirmation (staff-register `sign_up`); the profile still starts as a
--     draft (shown as "Pending") and no role grants anything until an Admin activates the account.
--   * Documents: Passport (expiry required), Visa and English (only when not an Australian citizen; Visa expiry required, English
--     expiry optional), Academic results (one or more files), Health Insurance (expiry required): REQUIRED, counted as x/5
--     (x/3 for citizens). Driving Licence (expiry required when uploaded) is OPTIONAL: not counted, never blocks Submit or
--     Activate. Files live at staff-documents/{auth uid}/{doc slug}/{file}.
--   * Each document carries its own review: status pending/approved/rejected, review_note, reviewed_by, reviewed_at.
--     A rejected document can be re-uploaded after submission; the new file starts as pending and the old one is kept.
--   * Admin: per-document approve/reject (hr_admin_staff_document_review) and one-step Activate with a role
--     (hr_admin_staff_activate_account; every required document must be approved and unexpired). Reject account is the
--     existing hr_admin_staff_reject.
--   * hr_admin_staff_list gains an optional p_statuses text[] filter (the Employees tabs).
--   * Admin sidebar: a top-level "Staff" group after "Agencies & Agents"; the 'agency_staff' row moves under it as "Employees".
-- The legacy categories PTE and English Certificate are removed from the allowed list (no staff rows exist; the migration
-- refuses to run if any row still uses them). 'Driving Licence' keeps its name as the optional licence category.
-- Rollback (manual): re-create hr_staff_document_register (with its grants) from 20261105190000; drop the functions created
-- here (including the 5-argument hr_admin_staff_list), the storage policy
-- staff_documents_owner_reupload, the policy staff_documents_admin_review, the trigger staff_document_review_reset and the added
-- columns; recreate staff_documents_one_current and the old category check; re-run the bodies of hr_staff_me, hr_staff_submit,
-- hr_admin_staff_list (4 arguments, with its grants) and hr_admin_staff_detail from 20261105190000; with protect_admin_menu
-- disabled, set 'agency_staff' back to parent 'agencies', label 'Staff', route '/admin/staff', sort 40, and delete the 'staff' row.
set local lock_timeout='5s';
set local statement_timeout='60s';

-- ------------------------------------------------------------------ columns
alter table hr.staff_profiles add column if not exists is_australian_citizen boolean;

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
  raise exception 'Staff documents with the legacy categories PTE / English Certificate exist; move them to English first. Nothing was changed.';
 end if;
end $legacy$;
alter table hr.staff_documents drop constraint if exists staff_documents_category_check;
alter table hr.staff_documents add constraint staff_documents_category_check
 check (category in ('Passport','Visa','English','Academic','Driving Licence','Health Insurance'));

-- Academic results may hold several current files; every other category keeps one current file.
drop index if exists hr.staff_documents_one_current;
create unique index staff_documents_one_current on hr.staff_documents(application_id, category) where is_current and category <> 'Academic';
create index if not exists staff_documents_expiry_idx on hr.staff_documents(expiry_date) where is_current and expiry_date is not null;

-- ------------------------------------------------------------------ RLS: admins update review fields only (defence in depth;
-- the hr schema is not exposed, so the browser uses hr_admin_staff_document_review below).
grant update (status, review_note, reviewed_by, reviewed_at) on hr.staff_documents to authenticated;
drop policy if exists staff_documents_admin_review on hr.staff_documents;
-- Never on their own documents (same rule as hr_admin_staff_document_review). No INSERT or DELETE grant exists on any hr table.
create policy staff_documents_admin_review on hr.staff_documents for update to authenticated
 using (public.cms_is_admin() and not exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid()))
 with check (public.cms_is_admin() and not exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid()));

-- ------------------------------------------------------------------ helpers
create or replace function hr.staff_doc_slug(p_category text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select lower(replace(btrim(coalesce(p_category, '')), ' ', '-')); $fn$;

-- Expiry date: REQUIRED for these (on upload); accepted but optional for English; not taken for Academic.
create or replace function hr.staff_doc_needs_expiry(p_category text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select p_category in ('Passport','Visa','Driving Licence','Health Insurance'); $fn$;

create or replace function hr.staff_doc_takes_expiry(p_category text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select p_category in ('Passport','Visa','English','Driving Licence','Health Insurance'); $fn$;

-- The words used in messages ("your passport", "your English test result").
create or replace function hr.staff_doc_label(p_category text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select case p_category when 'English' then 'English test result' when 'Academic' then 'academic results' else lower(p_category) end;
$fn$;

-- The REQUIRED categories for a person (Driving Licence is optional and never listed). Visa and English only when they are not
-- (or have not said they are) an Australian citizen.
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

-- Checklist counts per person: required document types, how many have a current file, how many are fully approved (for
-- Academic: at least one file and every current file approved), any rejected, and any current file expiring within 30 days
-- (or already expired).
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
  'rejected', (select coalesce(sum(rejected), 0) from per),
  'expiringSoon', exists (select 1 from hr.staff_documents d where d.profile_id = p_profile and d.is_current and d.expiry_date is not null
     and d.expiry_date <= current_date + 30),
  'nextExpiry', (select min(d.expiry_date) from hr.staff_documents d where d.profile_id = p_profile and d.is_current and d.expiry_date is not null));
$fn$;
revoke all on function hr.staff_doc_summary(uuid) from public, anon, authenticated;
grant execute on function hr.staff_doc_summary(uuid) to service_role;

-- A new expiry date or a different file puts a document back into review, however the change is made. (A re-upload is a new
-- row, which starts as pending by default.)
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

-- ------------------------------------------------------------------ storage: re-upload of a rejected document after submission
-- Draft uploads keep the existing staff_documents_owner_insert policy. Once submitted, the owner may add a file only in the
-- folder of a category whose current document was rejected.
drop policy if exists staff_documents_owner_reupload on storage.objects;
create policy staff_documents_owner_reupload on storage.objects for insert to authenticated
 with check (bucket_id = 'staff-documents' and (storage.foldername(name))[1] = auth.uid()::text
  and exists (select 1 from hr.staff_profiles p join hr.staff_documents d on d.profile_id = p.id
   where p.auth_user_id = auth.uid() and p.status in ('submitted','preboarding') and d.is_current and d.status = 'rejected'
    and hr.staff_doc_slug(d.category) = (storage.foldername(name))[2]));

-- ------------------------------------------------------------------ applicant
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
  'application', to_jsonb(a),
  'documents', coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'requiredCategories', to_jsonb(hr.staff_required_categories(p.is_australian_citizen)),
  'summary', hr.staff_doc_summary(p.id),
  'role', (select r.role from hr.staff_roles r where r.profile_id = p.id and r.revoked_at is null),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id)
     from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb));
end $fn$;

create or replace function public.hr_staff_set_citizenship(p_citizen boolean) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid for update;
 if not found then raise exception 'Start your staff application first.' using errcode = 'P0002'; end if;
 if p.status <> 'draft' then raise exception 'This application can no longer be edited.' using errcode = '23514'; end if;
 update hr.staff_profiles set is_australian_citizen = p_citizen where id = p.id;
 return public.hr_staff_me();
end $fn$;
revoke all on function public.hr_staff_set_citizenship(boolean) from public, anon;
grant execute on function public.hr_staff_set_citizenship(boolean) to authenticated;

create or replace function hr.check_staff_expiry(p_category text, p_expiry date) returns date
language plpgsql immutable set search_path = hr, pg_catalog, pg_temp as $fn$
begin
 if not hr.staff_doc_takes_expiry(p_category) then return null; end if;
 if p_expiry is null and hr.staff_doc_needs_expiry(p_category) then raise exception 'Enter the expiry date of your %.', hr.staff_doc_label(p_category) using errcode = '22023'; end if;
 if p_expiry > date '2100-12-31' then raise exception 'Check the expiry date.' using errcode = '22023'; end if;
 return p_expiry;
end $fn$;

-- Records a file the browser already uploaded to staff-documents/{uid}/{doc slug}/{file}.
--   Draft: Passport / Visa / English / Driving Licence / Health Insurance replace the current file of that type (its path is
--   returned so the browser can delete it); Academic adds a file, or replaces p_replaces.
--   Submitted / preboarding: only a REJECTED current document may be replaced (p_replaces for Academic); the old file is kept.
create or replace function public.hr_staff_document_add(p_category text, p_path text, p_filename text, p_mime text, p_size integer,
 p_expiry date default null, p_replaces uuid default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; a hr.staff_applications; d hr.staff_documents; r hr.staff_documents; v_old text[]; v_expiry date; v_draft boolean;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid for update;
 if not found then raise exception 'Start your staff application first.' using errcode = 'P0002'; end if;
 if p.status not in ('draft','submitted','preboarding') then raise exception 'This application can no longer be edited.' using errcode = '23514'; end if;
 v_draft := p.status = 'draft';
 select * into a from hr.staff_applications where profile_id = p.id;
 if p_category is null or p_category not in ('Passport','Visa','English','Academic','Driving Licence','Health Insurance') then raise exception 'Unknown document type.' using errcode = '22023'; end if;
 if p_path is null or split_part(p_path, '/', 1) <> v_uid::text or split_part(p_path, '/', 2) <> hr.staff_doc_slug(p_category) or split_part(p_path, '/', 3) = ''
  or p_path ~ '(^|/)\.\.?(/|$)' or p_path ~ '[\\%[:cntrl:]]' or char_length(p_path) > 400 or array_length(string_to_array(p_path, '/'), 1) <> 3 then
  raise exception 'The document location is not valid.' using errcode = '22023'; end if;
 v_expiry := hr.check_staff_expiry(p_category, p_expiry);
 if v_expiry is not null and v_expiry < current_date then raise exception 'This % has expired. Upload a current one.', hr.staff_doc_label(p_category) using errcode = '22023'; end if;

 if p_category = 'Academic' then
  if p_replaces is not null then
   select * into r from hr.staff_documents where id = p_replaces and profile_id = p.id and category = 'Academic' and is_current for update;
   if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
   if not v_draft and r.status <> 'rejected' then raise exception 'Only a rejected document can be replaced.' using errcode = '23514'; end if;
  elsif not v_draft then raise exception 'Only a rejected document can be replaced.' using errcode = '23514';
  end if;
 else
  select * into r from hr.staff_documents where application_id = a.id and category = p_category and is_current for update;
  if not v_draft and (r.id is null or r.status <> 'rejected') then raise exception 'Only a rejected document can be replaced.' using errcode = '23514'; end if;
 end if;

 if not exists (select 1 from storage.objects o where o.bucket_id = 'staff-documents' and o.name = p_path) then raise exception 'The uploaded file was not found.' using errcode = 'P0002'; end if;
 if r.id is not null then
  update hr.staff_documents set is_current = false where id = r.id;
  if v_draft then v_old := array[r.storage_path]; end if;
 end if;
 insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size, expiry_date)
  values (a.id, p.id, p_category, p_path, left(btrim(p_filename), 255), p_mime, p_size, v_expiry) returning * into d;
 return jsonb_build_object('id', d.id, 'replacedPaths', coalesce(to_jsonb(v_old), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_staff_document_add(text, text, text, text, integer, date, uuid) from public, anon;
grant execute on function public.hr_staff_document_add(text, text, text, text, integer, date, uuid) to authenticated;

-- The 20261105190000 upload function is replaced by hr_staff_document_add: it took no expiry date, used the old
-- {uid}/{application}/file path and listed the removed PTE / English Certificate categories. Nothing in the app, the Edge
-- Functions or the scripts calls it, so it is dropped rather than left callable.
drop function if exists public.hr_staff_document_register(text, text, text, text, integer);

-- Corrects the expiry date of an own current document: any document of a draft, or a REJECTED document after submission.
-- The change puts the document back into review (trigger staff_document_review_reset).
create or replace function public.hr_staff_document_set_expiry(p_id uuid, p_expiry date) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; d hr.staff_documents; v_expiry date;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid;
 if not found or p.status not in ('draft','submitted','preboarding') then raise exception 'This application can no longer be edited.' using errcode = '23514'; end if;
 select * into d from hr.staff_documents where id = p_id and profile_id = p.id and is_current for update;
 if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 if p.status <> 'draft' and d.status <> 'rejected' then raise exception 'Only a rejected document can be changed.' using errcode = '23514'; end if;
 v_expiry := hr.check_staff_expiry(d.category, p_expiry);
 if v_expiry is not null and v_expiry < current_date then raise exception 'This % has expired. Upload a current one.', hr.staff_doc_label(d.category) using errcode = '22023'; end if;
 update hr.staff_documents set expiry_date = v_expiry where id = d.id;
 return public.hr_staff_me();
end $fn$;
revoke all on function public.hr_staff_document_set_expiry(uuid, date) from public, anon;
grant execute on function public.hr_staff_document_set_expiry(uuid, date) to authenticated;

create or replace function public.hr_staff_submit() returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; a hr.staff_applications; c text;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid for update;
 if not found then raise exception 'Start your staff application first.' using errcode = 'P0002'; end if;
 if p.status <> 'draft' then raise exception 'This application has already been submitted.' using errcode = '23514'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 if btrim(p.first_name) = '' or btrim(p.last_name) = '' then raise exception 'Enter your first and last name.' using errcode = '23514'; end if;
 if p.date_of_birth is null then raise exception 'Enter your date of birth.' using errcode = '23514'; end if;
 if btrim(p.address_street) = '' or btrim(p.address_country) = '' then raise exception 'Enter your address.' using errcode = '23514'; end if;
 if btrim(p.emergency_name) = '' or btrim(p.emergency_relationship) = '' or p.emergency_phone_e164 is null then
  raise exception 'Enter an emergency contact: name, relationship and phone.' using errcode = '23514'; end if;
 if a.requested_role is null then raise exception 'Choose the role you are requesting.' using errcode = '23514'; end if;
 if p.is_australian_citizen is null then raise exception 'Tell us whether you are an Australian citizen.' using errcode = '23514'; end if;
 foreach c in array hr.staff_required_categories(p.is_australian_citizen) loop
  if not exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current) then
   raise exception '%', case c when 'Passport' then 'A passport is required before you can submit.' else 'Upload your ' || hr.staff_doc_label(c) || '.' end
    using errcode = '23514'; end if;
  if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current
     and ((d.expiry_date is null and hr.staff_doc_needs_expiry(c)) or d.expiry_date < current_date)) then
   raise exception 'Enter a current expiry date for your %.', hr.staff_doc_label(c) using errcode = '23514'; end if;
 end loop;
 perform set_config('hr.actor', v_uid::text, true); perform set_config('hr.actor_kind', 'applicant', true); perform set_config('hr.note', 'Submitted', true);
 update hr.staff_profiles set status = 'submitted' where id = p.id;
 update hr.staff_applications set submitted_at = now() where id = a.id;
 return public.hr_staff_me();
end $fn$;

-- ------------------------------------------------------------------ admin
-- p_statuses (optional) filters by several statuses at once, e.g. the Employees tabs: Applications = submitted + preboarding,
-- Inactive/Rejected = inactive + rejected. p_status keeps working; using both is refused. Adding a parameter changes the
-- signature, so the 4-argument version from 20261105190000 is dropped first: keeping both would make every named call
-- through the Data API ambiguous. Existing 4-argument calls resolve to this function (p_statuses defaults to null).
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
 if exists (select 1 from unnest(coalesce(v_statuses, '{}'::text[])) s where s is null or s not in ('draft','submitted','preboarding','active','rejected','inactive')) then
  raise exception 'Unknown status.' using errcode = '22023'; end if;
 select count(*) into v_total from hr.staff_profiles p
  where (v_statuses is null or p.status = any(v_statuses))
   and (v_search is null or concat_ws(' ', p.first_name, p.middle_name, p.last_name, p.email, p.phone_e164) ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%');
 select coalesce(jsonb_agg(r order by (r->>'updatedAt') desc), '[]'::jsonb) into v_rows from (
  select jsonb_build_object('id', p.id, 'name', btrim(concat_ws(' ', p.first_name, p.last_name)), 'email', p.email, 'phone', p.phone_e164, 'status', p.status,
   'requestedRole', a.requested_role, 'role', (select ro.role from hr.staff_roles ro where ro.profile_id = p.id and ro.revoked_at is null),
   'submittedAt', a.submitted_at, 'updatedAt', p.updated_at, 'docs', hr.staff_doc_summary(p.id)) as r
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
  'documents', coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.category, d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'requiredCategories', to_jsonb(hr.staff_required_categories(p.is_australian_citizen)),
  'summary', hr.staff_doc_summary(p.id),
  'roles', coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'grantedAt', r.granted_at, 'revokedAt', r.revoked_at) order by r.granted_at) from hr.staff_roles r where r.profile_id = p.id), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id) from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb),
  'hasCmsAccess', exists (select 1 from public.cms_users c where c.auth_user_id = p.auth_user_id and c.status = 'Active'));
end $fn$;

create or replace function public.hr_admin_staff_document_review(p_doc uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); d hr.staff_documents; p hr.staff_profiles; v_note text := btrim(coalesce(p_note, ''));
begin
 if p_decision not in ('approved','rejected') then raise exception 'Choose approve or reject.' using errcode = '22023'; end if;
 if p_decision = 'rejected' and v_note = '' then raise exception 'Add a note telling them what to fix.' using errcode = '22023'; end if;
 if char_length(v_note) > 2000 then raise exception 'The note is too long.' using errcode = '22023'; end if;
 select * into d from hr.staff_documents where id = p_doc and is_current for update;
 if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 select * into p from hr.staff_profiles where id = d.profile_id;
 if p.auth_user_id = v_admin then raise exception 'You cannot review your own documents.' using errcode = '42501'; end if;
 if p.status = 'draft' then raise exception 'This application has not been submitted yet.' using errcode = '23514'; end if;
 update hr.staff_documents set status = p_decision, review_note = v_note, reviewed_by = v_admin, reviewed_at = now() where id = d.id;
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_staff_document_review(uuid, text, text) from public, anon;
grant execute on function public.hr_admin_staff_document_review(uuid, text, text) to authenticated;

-- One step from submitted (or preboarding) to active: records the role (Admin needs p_confirm_admin), then activates through
-- the existing hr_admin_staff_approve / hr_admin_staff_activate, so the status log, the role table and cms_users (Admin only)
-- behave exactly as before. Every required document must be approved and unexpired.
create or replace function public.hr_admin_staff_activate_account(p_id uuid, p_role text, p_note text default null, p_confirm_admin boolean default false) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; c text; v_current text;
begin
 if p_role is null or p_role not in ('admin','trainer') then raise exception 'Choose Admin or Trainer.' using errcode = '22023'; end if;
 if p_role = 'admin' and p_confirm_admin is not true then raise exception 'Confirm that this person should become an Admin.' using errcode = '23514'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('submitted','preboarding') then raise exception 'Only a submitted application can be activated.' using errcode = '23514'; end if;
 if p.auth_user_id = v_admin then raise exception 'You cannot activate your own account.' using errcode = '42501'; end if;
 foreach c in array hr.staff_required_categories(p.is_australian_citizen) loop
  if not exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current)
   or exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current and d.status <> 'approved') then
   raise exception 'Approve every required document first (%).', hr.staff_doc_label(c) using errcode = '23514'; end if;
  if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current and d.expiry_date < current_date) then
   raise exception 'The % has expired.', hr.staff_doc_label(c) using errcode = '23514'; end if;
 end loop;
 if p.status = 'submitted' then
  perform public.hr_admin_staff_approve(p.id, p_role, p_note, p_confirm_admin);
 else
  select role into v_current from hr.staff_roles where profile_id = p.id and revoked_at is null;
  if v_current is distinct from p_role then
   update hr.staff_roles set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and revoked_at is null;
   insert into hr.staff_roles(profile_id, role, granted_by) values (p.id, p_role, v_admin);
  end if;
 end if;
 return public.hr_admin_staff_activate(p.id, p_note);
end $fn$;
revoke all on function public.hr_admin_staff_activate_account(uuid, text, text, boolean) from public, anon;
grant execute on function public.hr_admin_staff_activate_account(uuid, text, text, boolean) to authenticated;

-- ------------------------------------------------------------------ admin sidebar: Staff becomes its own top-level group
-- A top-level "Staff" group right after "Agencies & Agents", with the existing 'agency_staff' row moved under it as
-- "Employees" (/admin/staff/employees). The row is UPDATED, not re-created, and keeps its id: 20261105200000 and the
-- release-staff check scripts refer to 'agency_staff'. The group copies that row's permission (admin-only today).
-- Safe to re-run: the group's position is chosen only when it is first inserted, and every other value is simply set again.
-- Fails loudly (nothing changed) when 'agencies' or 'agency_staff' is missing, or when an unrelated 'staff' row exists.
-- More Staff items are added later as rows with parent_id = 'staff'.
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
