-- Staff > Employees, simple (owner's decision 2026-11-10): an Admin adds an employee with first name, last name, email and mobile;
-- they are Active at once. Two statuses only: Active and Inactive. The Admin uploads the person's documents by hand.
-- No invite, document link, offer or activation steps. Self-contained: needs only what hosted already has (20261105180000..200000,
-- 20261106120000/130000, 20261109153953), so it runs on hosted before (and instead of) 20261110090000.
--   hr_admin_emp_list(p_status, p_search)        active / inactive employees (null: both), with their document count
--   hr_admin_emp_get(p_id)                       one employee and their current documents
--   hr_admin_emp_save(p_id, p_person)            add (p_id null) or edit {firstName, lastName, email, phone}; validated here too.
--                                                A candidate (any other status) with the same email becomes the employee.
--   hr_admin_emp_set_status(p_id, p_status)      active | inactive
--   hr_admin_emp_doc_add(p_id, p_category, p_path, p_filename, p_mime, p_size)   records a file the Admin uploaded to
--                                                staff-documents/employees/<id>/...; replaces the current one of that category
--   hr_admin_emp_doc_remove(p_doc)               removes a hand-uploaded document; returns its path (the browser deletes the file)
-- Status rules: hr.staff_status_guard / hr.staff_transition_allowed now also allow an Admin-created Active profile and any status to
-- Active or Inactive. Storage: Admins may upload to and delete from staff-documents/employees/ (reading was already allowed).
-- Rollback (manual): drop the hr_admin_emp_* functions and hr.emp_* helpers, the two storage policies employee_docs_admin_*;
-- re-create the employment_activation_guard trigger of 20261109153953;
-- re-run the hr.staff_status_guard / hr.staff_transition_allowed bodies of 20261106120000 and 20261105180000.
set local lock_timeout='5s';
set local statement_timeout='60s';

-- ------------------------------------------------------------------ status rules
create or replace function hr.staff_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable parallel safe as $fn$
 select p_to in ('active','inactive') or (p_from, p_to) in (
  ('draft','submitted'), ('submitted','preboarding'), ('submitted','rejected'),
  ('preboarding','rejected'), ('rejected','draft'),
  ('draft','job_applied'), ('rejected','job_applied'), ('job_applied','draft'), ('job_applied','rejected'));
$fn$;

create or replace function hr.staff_status_guard() returns trigger
language plpgsql set search_path = hr, public as $$
begin
 if tg_op = 'INSERT' then
  -- An Admin adding an employee creates them Active (hr_admin_emp_save sets hr.actor_kind = 'admin').
  if new.status <> 'draft' and not (new.status = 'active' and current_setting('hr.actor_kind', true) = 'admin') then
   raise exception 'A staff profile starts as a draft.' using errcode = '23514'; end if;
  return new;
 end if;
 new.updated_at := now();
 if new.status is distinct from old.status then
  if not hr.staff_transition_allowed(old.status, new.status) then
   raise exception 'A staff record cannot move from % to %.', old.status, new.status using errcode = '23514';
  end if;
  new.status_changed_at := now();
 end if;
 return new;
end $$;

-- Activation no longer needs a sign-in or approved documents (20261109153953's gate; 20261110090000 drops it too).
drop trigger if exists employment_activation_guard on hr.staff_profiles;

-- ------------------------------------------------------------------ helpers
create or replace function hr.emp_name_problem(p_value text, p_label text) returns text
language sql immutable as $fn$
 select case
  when btrim(coalesce(p_value, '')) = '' then 'Enter the ' || p_label || '.'
  when char_length(btrim(p_value)) > 100 then 'The ' || p_label || ' must be 100 characters or fewer.'
  when btrim(p_value) !~ '^[[:alpha:]]([[:alpha:] .''-]*[[:alpha:].])?$' then 'The ' || p_label || ' can only contain letters, spaces, hyphens, apostrophes and full stops.'
 end;
$fn$;
revoke all on function hr.emp_name_problem(text, text) from public, anon, authenticated;

create or replace function hr.emp_json(p hr.staff_profiles) returns jsonb
language sql stable security definer set search_path = '' as $fn$
 select jsonb_build_object('id', p.id, 'firstName', p.first_name, 'lastName', p.last_name, 'email', p.email, 'phone', p.phone_e164,
  'status', p.status, 'createdAt', p.created_at, 'statusChangedAt', p.status_changed_at, 'hasLogin', p.auth_user_id is not null,
  'documents', (select count(*) from hr.staff_documents d where d.profile_id = p.id and d.is_current));
$fn$;
revoke all on function hr.emp_json(hr.staff_profiles) from public, anon, authenticated;

-- ------------------------------------------------------------------ list, get
create or replace function public.hr_admin_emp_list(p_status text default null, p_search text default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 if p_status is not null and p_status not in ('active','inactive') then raise exception 'Choose Active or Inactive.' using errcode = '22023'; end if;
 return coalesce((select jsonb_agg(hr.emp_json(p) order by lower(p.first_name), lower(p.last_name), p.email)
  from hr.staff_profiles p
  where p.status in ('active','inactive') and (p_status is null or p.status = p_status)
   and strpos(lower(concat_ws(' ', p.first_name, p.last_name, p.email, p.phone_e164)), lower(btrim(coalesce(p_search, '')))) > 0), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_admin_emp_list(text, text) from public, anon;
grant execute on function public.hr_admin_emp_list(text, text) to authenticated;

create or replace function public.hr_admin_emp_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles;
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id;
 if not found then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
 return hr.emp_json(p) || jsonb_build_object('documentList', coalesce((select jsonb_agg(jsonb_build_object(
   'id', d.id, 'category', d.category, 'filename', d.filename, 'mimeType', d.mime_type, 'size', d.file_size,
   'storagePath', d.storage_path, 'uploadedAt', d.created_at, 'removable', d.storage_path like 'employees/%')
  order by d.category, d.created_at desc) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_admin_emp_get(uuid) from public, anon;
grant execute on function public.hr_admin_emp_get(uuid) to authenticated;

-- ------------------------------------------------------------------ add / edit
create or replace function public.hr_admin_emp_save(p_id uuid, p_person jsonb) returns uuid
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin();
 v_first text := btrim(coalesce(p_person->>'firstName', '')); v_last text := btrim(coalesce(p_person->>'lastName', ''));
 v_email text := lower(btrim(coalesce(p_person->>'email', ''))); v_phone text := btrim(coalesce(p_person->>'phone', ''));
 v_problem text; p hr.staff_profiles; v_other hr.staff_profiles;
begin
 v_problem := coalesce(hr.emp_name_problem(v_first, 'first name'), hr.emp_name_problem(v_last, 'last name'));
 if v_problem is null and (v_email = '' or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$') then v_problem := 'Enter a valid email address.'; end if;
 if v_problem is null and v_phone !~ '^\+[1-9]\d{7,14}$' then v_problem := 'Enter a valid mobile number (for example 0412 345 678 or +61 412 345 678).'; end if;
 if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
 perform set_config('hr.actor', v_admin::text, true);
 perform set_config('hr.actor_kind', 'admin', true);
 perform pg_advisory_xact_lock(hashtext('hr.emp_save'));

 if p_id is null then
  select * into p from hr.staff_profiles where email = v_email for update;
  if found and p.status in ('active','inactive') then
   raise exception '% is already an employee (%).', v_email, p.status using errcode = '23505'; end if;
 else
  select * into p from hr.staff_profiles where id = p_id for update;
  if not found then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
  select * into v_other from hr.staff_profiles where email = v_email and id <> p.id;
  if found then raise exception 'Another staff record already uses %.', v_email using errcode = '23505'; end if;
  if p.auth_user_id is not null and p.email <> v_email then
   raise exception 'This person already signs in with %, so their email cannot be changed here.', p.email using errcode = '22023'; end if;
 end if;
 select * into v_other from hr.staff_profiles where phone_e164 = v_phone and id is distinct from p.id;
 if found then raise exception 'Another staff record already uses the mobile number %.', v_phone using errcode = '23505'; end if;

 if p.id is null then
  insert into hr.staff_profiles(first_name, last_name, email, phone_e164, status) values (v_first, v_last, v_email, v_phone, 'active') returning * into p;
 else
  -- Editing, or a candidate with this email becoming the employee.
  update hr.staff_profiles set first_name = v_first, last_name = v_last, email = v_email, phone_e164 = v_phone,
   status = case when p_id is null then 'active' else status end where id = p.id returning * into p;
 end if;
 insert into hr.staff_applications(profile_id) values (p.id) on conflict (profile_id) do nothing;
 insert into hr.employment(profile_id) values (p.id) on conflict (profile_id) do nothing;
 return p.id;
end $fn$;
revoke all on function public.hr_admin_emp_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_emp_save(uuid, jsonb) to authenticated;

create or replace function public.hr_admin_emp_set_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles;
begin
 if p_status not in ('active','inactive') then raise exception 'Choose Active or Inactive.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found or p.status not in ('active','inactive') then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
 perform set_config('hr.actor', v_admin::text, true);
 perform set_config('hr.actor_kind', 'admin', true);
 update hr.staff_profiles set status = p_status where id = p_id and status <> p_status;
end $fn$;
revoke all on function public.hr_admin_emp_set_status(uuid, text) from public, anon;
grant execute on function public.hr_admin_emp_set_status(uuid, text) to authenticated;

-- ------------------------------------------------------------------ documents
create or replace function public.hr_admin_emp_doc_add(p_id uuid, p_category text, p_path text, p_filename text, p_mime text, p_size integer) returns uuid
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; a hr.staff_applications; v_id uuid;
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id;
 if not found or p.status not in ('active','inactive') then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
 if p_category not in ('Passport','Visa','Academic','Health Insurance','Driving Licence','PTE','English Certificate','Resume') then
  raise exception 'Choose a document type from the list.' using errcode = '22023'; end if;
 if p_mime not in ('application/pdf','image/png','image/jpeg','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document') then
  raise exception 'Upload a PDF, JPG, PNG or Word file.' using errcode = '22023'; end if;
 if p_size is null or p_size < 1 or p_size > 10485760 then raise exception 'The file must be 10 MB or smaller.' using errcode = '22023'; end if;
 if p_path is null or p_path not like 'employees/' || p.id::text || '/%' or p_path like '%..%' then
  raise exception 'The file is not in this employee''s folder.' using errcode = '22023'; end if;
 if not exists (select 1 from storage.objects o where o.bucket_id = 'staff-documents' and o.name = p_path) then
  raise exception 'The uploaded file was not found.' using errcode = 'P0002'; end if;
 insert into hr.staff_applications(profile_id) values (p.id) on conflict (profile_id) do nothing;
 select * into a from hr.staff_applications where profile_id = p.id;
 update hr.staff_documents set is_current = false where application_id = a.id and category = p_category and is_current;
 insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size, extraction_status)
  values (a.id, p.id, p_category, p_path, left(btrim(coalesce(nullif(p_filename, ''), 'document')), 255), p_mime, p_size, 'unavailable')
  returning id into v_id;
 return v_id;
end $fn$;
revoke all on function public.hr_admin_emp_doc_add(uuid, text, text, text, text, integer) from public, anon;
grant execute on function public.hr_admin_emp_doc_add(uuid, text, text, text, text, integer) to authenticated;

create or replace function public.hr_admin_emp_doc_remove(p_doc uuid) returns text
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare d hr.staff_documents;
begin
 perform hr.require_admin();
 select * into d from hr.staff_documents where id = p_doc for update;
 if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 if d.storage_path not like 'employees/%' then raise exception 'Only documents uploaded here can be removed here.' using errcode = '42501'; end if;
 delete from hr.staff_documents where id = d.id;
 return d.storage_path;
end $fn$;
revoke all on function public.hr_admin_emp_doc_remove(uuid) from public, anon;
grant execute on function public.hr_admin_emp_doc_remove(uuid) to authenticated;

-- ------------------------------------------------------------------ storage: Admins upload to and delete from employees/<id>/
drop policy if exists employee_docs_admin_upload on storage.objects;
create policy employee_docs_admin_upload on storage.objects for insert to authenticated with check (
 bucket_id = 'staff-documents' and public.cms_is_admin() and (storage.foldername(name))[1] = 'employees'
 and exists (select 1 from hr.staff_profiles p where p.id::text = (storage.foldername(name))[2] and p.status in ('active','inactive')));
drop policy if exists employee_docs_admin_delete on storage.objects;
create policy employee_docs_admin_delete on storage.objects for delete to authenticated using (
 bucket_id = 'staff-documents' and public.cms_is_admin() and (storage.foldername(name))[1] = 'employees'
 and not exists (select 1 from hr.staff_documents d where d.storage_path = name));
