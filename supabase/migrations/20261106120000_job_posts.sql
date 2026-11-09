-- Job posts and job applications, in the hr schema (staff self-registration, 20261105180000/190000).
-- The CMS posts jobs (title, description, full time / part time, salary, location); the public site lists open jobs at /careers;
-- a visitor creates an account first (the existing staff sign-up: email + mobile, emailed code, password), then applies with a
-- resume and a cover letter. Applying creates their row in the staff table (hr.staff_profiles) with the NEW status `job_applied`.
-- An Admin hires (the profile becomes a draft again, so the person completes the staff registration and the normal
-- submitted > preboarding > active review follows) or declines (rejected, unless another job application is still open).
-- Changes to existing objects: 'job_applied' is added to the status checks and the transition table (draft/rejected > job_applied,
-- job_applied > draft/rejected); the document categories gain Resume and Cover Letter; the bucket and the mime check accept Word
-- files; the storage write policies and hr_staff_document_register let a job applicant (draft, job_applied or rejected) upload a
-- resume or cover letter; hr_staff_me / hr_admin_staff_detail / hr_admin_staff_list report job applications.
-- Rollback (manual): drop function public.hr_admin_job_decide, public.hr_job_apply, public.hr_admin_job_save, public.hr_admin_job_list,
-- public.jobs_open, hr.job_applications_json; drop table hr.job_applications, hr.jobs. The status 'job_applied', the categories and
-- the policies can stay (nothing breaks); remove them only once no profile or document uses them.
set local lock_timeout='5s';
set local statement_timeout='60s';

-- ------------------------------------------------------------------ the new status and document kinds
do $do$
declare r record;
begin
 for r in
  select c.conname, c.conrelid::regclass::text as tbl
  from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.contype = 'c' and array_length(c.conkey, 1) = 1 and (
   (c.conrelid = 'hr.staff_profiles'::regclass and a.attname = 'status') or
   (c.conrelid = 'hr.staff_status_events'::regclass and a.attname in ('from_status', 'to_status')) or
   (c.conrelid = 'hr.staff_documents'::regclass and a.attname in ('category', 'mime_type')))
 loop
  execute format('alter table %s drop constraint %I', r.tbl, r.conname);
 end loop;
end $do$;
alter table hr.staff_profiles add constraint staff_profiles_status_check
 check (status in ('draft','job_applied','submitted','preboarding','active','rejected','inactive'));
alter table hr.staff_status_events
 add constraint staff_status_events_from_status_check check (from_status is null or from_status in ('draft','job_applied','submitted','preboarding','active','rejected','inactive')),
 add constraint staff_status_events_to_status_check check (to_status in ('draft','job_applied','submitted','preboarding','active','rejected','inactive'));
alter table hr.staff_documents
 add constraint staff_documents_category_check check (category in ('Passport','Visa','Driving Licence','PTE','English Certificate','Resume','Cover Letter')),
 add constraint staff_documents_mime_type_check check (mime_type in ('application/pdf','image/png','image/jpeg','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'));

-- draft/rejected > job_applied when a job application is made; job_applied > draft when hired (complete the staff registration),
-- job_applied > rejected when declined. Everything else is as before.
create or replace function hr.staff_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable parallel safe as $fn$
 select (p_from, p_to) in (
  ('draft','submitted'), ('submitted','preboarding'), ('submitted','rejected'),
  ('preboarding','active'), ('preboarding','rejected'),
  ('active','inactive'), ('inactive','active'), ('rejected','draft'),
  ('draft','job_applied'), ('rejected','job_applied'), ('job_applied','draft'), ('job_applied','rejected'));
$fn$;

update storage.buckets set allowed_mime_types = array['application/pdf','image/png','image/jpeg','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
 where id = 'staff-documents';

-- A job applicant (draft, job_applied or rejected) uploads to their own folder; the read policy is unchanged.
drop policy if exists staff_documents_owner_insert on storage.objects;
drop policy if exists staff_documents_owner_delete on storage.objects;
create policy staff_documents_owner_insert on storage.objects for insert to authenticated
 with check (bucket_id = 'staff-documents' and (storage.foldername(name))[1] = auth.uid()::text
  and exists (select 1 from hr.staff_profiles p where p.auth_user_id = auth.uid() and p.status in ('draft','job_applied','rejected')));
create policy staff_documents_owner_delete on storage.objects for delete to authenticated
 using (bucket_id = 'staff-documents' and (storage.foldername(name))[1] = auth.uid()::text
  and exists (select 1 from hr.staff_profiles p where p.auth_user_id = auth.uid() and p.status in ('draft','job_applied','rejected')));

-- ------------------------------------------------------------------ tables
create table hr.jobs (
 id uuid primary key default gen_random_uuid(),
 title text not null check (char_length(btrim(title)) between 2 and 150),
 description text not null check (char_length(description) between 1 and 10000),
 employment_type text not null check (employment_type in ('full_time','part_time')),
 salary text not null default '' check (char_length(salary) <= 120),
 location text not null check (char_length(btrim(location)) between 1 and 150),
 status text not null default 'open' check (status in ('open','closed')),
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index jobs_status_idx on hr.jobs(status, created_at desc);
create trigger jobs_touch before update on hr.jobs for each row execute function hr.touch_updated_at();

create table hr.job_applications (
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null references hr.jobs(id) on delete restrict,
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 resume_document_id uuid not null references hr.staff_documents(id) on delete restrict,
 cover_letter text not null default '' check (char_length(cover_letter) <= 5000),
 cover_letter_document_id uuid references hr.staff_documents(id) on delete restrict,
 status text not null default 'applied' check (status in ('applied','hired','declined')),
 decided_by uuid,
 decided_at timestamptz,
 decision_note text not null default '' check (char_length(decision_note) <= 2000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (job_id, profile_id),
 check (btrim(cover_letter) <> '' or cover_letter_document_id is not null)
);
create index job_applications_profile_idx on hr.job_applications(profile_id, created_at desc);
create trigger job_applications_touch before update on hr.job_applications for each row execute function hr.touch_updated_at();

alter table hr.jobs enable row level security;
alter table hr.job_applications enable row level security;
revoke all on hr.jobs, hr.job_applications from public, anon, authenticated, service_role;
grant select on hr.jobs, hr.job_applications to authenticated;
grant select, insert, update, delete on hr.jobs, hr.job_applications to service_role;
create policy jobs_read on hr.jobs for select to authenticated using (status = 'open' or public.cms_is_admin());
create policy job_applications_read on hr.job_applications for select to authenticated
 using (public.cms_is_admin() or exists (select 1 from hr.staff_profiles p where p.id = profile_id and p.auth_user_id = auth.uid()));

-- ------------------------------------------------------------------ public: open jobs
create or replace function hr.job_json(j hr.jobs) returns jsonb
language sql immutable parallel safe as $fn$
 select jsonb_build_object('id', j.id, 'title', j.title, 'description', j.description, 'employmentType', j.employment_type, 'salary', j.salary,
  'location', j.location, 'status', j.status, 'postedAt', j.created_at, 'updatedAt', j.updated_at);
$fn$;

-- All open jobs, newest first; with p_id that one job whatever its status (so a closed job's page can say so). Anyone may call it.
create or replace function public.jobs_open(p_id uuid default null) returns jsonb
language sql stable security definer set search_path = public, hr, pg_temp as $fn$
 select coalesce(jsonb_agg(hr.job_json(j) order by j.created_at desc), '[]'::jsonb)
 from hr.jobs j where (p_id is null and j.status = 'open') or (p_id is not null and j.id = p_id);
$fn$;
revoke all on function public.jobs_open(uuid) from public;
grant execute on function public.jobs_open(uuid) to anon, authenticated;

-- ------------------------------------------------------------------ admin: post and manage jobs
create or replace function public.hr_admin_job_list() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(hr.job_json(j) || jsonb_build_object(
   'applied', (select count(*) from hr.job_applications a where a.job_id = j.id and a.status = 'applied'),
   'hired', (select count(*) from hr.job_applications a where a.job_id = j.id and a.status = 'hired'),
   'declined', (select count(*) from hr.job_applications a where a.job_id = j.id and a.status = 'declined'))
  order by (j.status = 'open') desc, j.created_at desc) from hr.jobs j), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_admin_job_list() from public, anon;
grant execute on function public.hr_admin_job_list() to authenticated;

-- Creates (p_id null) or updates a job. Keys: title, description, employmentType (full_time | part_time), salary, location, status (open | closed).
create or replace function public.hr_admin_job_save(p_id uuid, p_job jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); j hr.jobs; v_title text; v_desc text; v_type text; v_salary text; v_location text; v_status text;
begin
 if p_id is not null then
  select * into j from hr.jobs where id = p_id for update;
  if not found then raise exception 'Job not found.' using errcode = 'P0002'; end if;
 end if;
 v_title := btrim(coalesce(p_job->>'title', j.title, ''));
 v_desc := btrim(coalesce(p_job->>'description', j.description, ''));
 v_type := coalesce(p_job->>'employmentType', j.employment_type, '');
 v_salary := btrim(coalesce(p_job->>'salary', j.salary, ''));
 v_location := btrim(coalesce(p_job->>'location', j.location, ''));
 v_status := coalesce(p_job->>'status', j.status, 'open');
 if char_length(v_title) < 2 or char_length(v_title) > 150 then raise exception 'Enter a job title (2 to 150 characters).' using errcode = '22023'; end if;
 if v_desc = '' or char_length(v_desc) > 10000 then raise exception 'Enter a job description (up to 10,000 characters).' using errcode = '22023'; end if;
 if v_type not in ('full_time','part_time') then raise exception 'Choose Full time or Part time.' using errcode = '22023'; end if;
 if char_length(v_salary) > 120 then raise exception 'The salary must be 120 characters or fewer.' using errcode = '22023'; end if;
 if v_location = '' or char_length(v_location) > 150 then raise exception 'Enter the job location.' using errcode = '22023'; end if;
 if v_status not in ('open','closed') then raise exception 'A job is open or closed.' using errcode = '22023'; end if;
 if p_id is null then
  insert into hr.jobs(title, description, employment_type, salary, location, status, created_by)
   values (v_title, v_desc, v_type, v_salary, v_location, v_status, v_admin) returning * into j;
 else
  update hr.jobs set title = v_title, description = v_desc, employment_type = v_type, salary = v_salary, location = v_location, status = v_status
   where id = p_id returning * into j;
 end if;
 return hr.job_json(j);
end $fn$;
revoke all on function public.hr_admin_job_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_job_save(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ job applications in the staff payloads
create or replace function hr.job_applications_json(p_profile uuid) returns jsonb
language sql stable security definer set search_path = public, hr, pg_temp as $fn$
 select coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'jobId', j.id, 'jobTitle', j.title, 'employmentType', j.employment_type, 'location', j.location,
   'jobStatus', j.status, 'status', a.status, 'coverLetter', a.cover_letter, 'appliedAt', a.created_at, 'decidedAt', a.decided_at, 'decisionNote', a.decision_note,
   'resume', (select jsonb_build_object('id', d.id, 'filename', d.filename, 'storagePath', d.storage_path, 'mimeType', d.mime_type) from hr.staff_documents d where d.id = a.resume_document_id),
   'coverLetterDocument', (select jsonb_build_object('id', d.id, 'filename', d.filename, 'storagePath', d.storage_path, 'mimeType', d.mime_type) from hr.staff_documents d where d.id = a.cover_letter_document_id))
  order by a.created_at desc)
  from hr.job_applications a join hr.jobs j on j.id = a.job_id where a.profile_id = p_profile), '[]'::jsonb);
$fn$;
revoke all on function hr.job_applications_json(uuid) from public, anon, authenticated;

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
  'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'category', d.category, 'filename', d.filename, 'mimeType', d.mime_type,
     'fileSize', d.file_size, 'storagePath', d.storage_path, 'extractionStatus', d.extraction_status, 'extracted', d.extracted,
     'extractionError', d.extraction_error, 'createdAt', d.created_at) order by d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'role', (select r.role from hr.staff_roles r where r.profile_id = p.id and r.revoked_at is null),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id)
     from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb),
  'jobApplications', hr.job_applications_json(p.id));
end $fn$;

create or replace function public.hr_admin_staff_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; a hr.staff_applications;
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 return jsonb_build_object('profile', to_jsonb(p) - 'auth_user_id', 'application', to_jsonb(a),
  'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'category', d.category, 'filename', d.filename, 'mimeType', d.mime_type, 'fileSize', d.file_size,
     'storagePath', d.storage_path, 'extractionStatus', d.extraction_status, 'extracted', d.extracted) order by d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'roles', coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'grantedAt', r.granted_at, 'revokedAt', r.revoked_at) order by r.granted_at) from hr.staff_roles r where r.profile_id = p.id), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id) from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb),
  'hasCmsAccess', exists (select 1 from public.cms_users c where c.auth_user_id = p.auth_user_id and c.status = 'Active'),
  'jobApplications', hr.job_applications_json(p.id));
end $fn$;

-- The list accepts the new status and names the job a person applied for most recently.
create or replace function public.hr_admin_staff_list(p_status text default null, p_search text default null, p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_search text := nullif(btrim(coalesce(p_search, '')), ''); v_total integer; v_rows jsonb;
begin
 perform hr.require_admin();
 if p_status is not null and p_status <> '' and p_status not in ('draft','job_applied','submitted','preboarding','active','rejected','inactive') then raise exception 'Unknown status.' using errcode = '22023'; end if;
 select count(*) into v_total from hr.staff_profiles p
  where (coalesce(p_status, '') = '' or p.status = p_status)
   and (v_search is null or concat_ws(' ', p.first_name, p.middle_name, p.last_name, p.email, p.phone_e164) ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%');
 select coalesce(jsonb_agg(r order by (r->>'updatedAt') desc), '[]'::jsonb) into v_rows from (
  select jsonb_build_object('id', p.id, 'name', btrim(concat_ws(' ', p.first_name, p.last_name)), 'email', p.email, 'phone', p.phone_e164, 'status', p.status,
   'requestedRole', a.requested_role, 'role', (select ro.role from hr.staff_roles ro where ro.profile_id = p.id and ro.revoked_at is null),
   'jobTitle', (select j.title from hr.job_applications ja join hr.jobs j on j.id = ja.job_id where ja.profile_id = p.id order by (ja.status = 'applied') desc, ja.created_at desc limit 1),
   'submittedAt', a.submitted_at, 'updatedAt', p.updated_at) as r
  from hr.staff_profiles p join hr.staff_applications a on a.profile_id = p.id
  where (coalesce(p_status, '') = '' or p.status = p_status)
   and (v_search is null or concat_ws(' ', p.first_name, p.middle_name, p.last_name, p.email, p.phone_e164) ilike '%' || replace(replace(v_search, '%', ''), '_', '') || '%')
  order by p.updated_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) q;
 return jsonb_build_object('total', v_total, 'rows', v_rows);
end $fn$;

-- A resume or cover letter may be registered by a draft, job_applied or rejected profile; the other categories still need a draft.
-- Resumes and cover letters are never sent for reading (extraction_status unavailable).
create or replace function public.hr_staff_document_register(p_category text, p_path text, p_filename text, p_mime text, p_size integer) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; a hr.staff_applications; d hr.staff_documents; v_old text[]; v_job_doc boolean;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid;
 if not found then raise exception 'Start your staff application first.' using errcode = 'P0002'; end if;
 if p_category not in ('Passport','Visa','Driving Licence','PTE','English Certificate','Resume','Cover Letter') then raise exception 'Unknown document type.' using errcode = '22023'; end if;
 v_job_doc := p_category in ('Resume','Cover Letter');
 if (v_job_doc and p.status not in ('draft','job_applied','rejected')) or (not v_job_doc and p.status <> 'draft') then
  raise exception 'This application can no longer be edited.' using errcode = '23514'; end if;
 if p_mime not in ('application/pdf','image/png','image/jpeg','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  or (not v_job_doc and p_mime not in ('application/pdf','image/png','image/jpeg')) then raise exception 'Upload a PDF, JPG or PNG.' using errcode = '22023'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 if p_path is null or split_part(p_path, '/', 1) <> v_uid::text or split_part(p_path, '/', 2) <> a.id::text or split_part(p_path, '/', 3) = ''
  or p_path ~ '(^|/)\.\.?(/|$)' or p_path ~ '[\\%[:cntrl:]]' or char_length(p_path) > 400 or array_length(string_to_array(p_path, '/'), 1) <> 3 then
  raise exception 'The document location is not valid.' using errcode = '22023'; end if;
 if not exists (select 1 from storage.objects o where o.bucket_id = 'staff-documents' and o.name = p_path) then raise exception 'The uploaded file was not found.' using errcode = 'P0002'; end if;
 select array_agg(storage_path) into v_old from hr.staff_documents where application_id = a.id and category = p_category and is_current;
 update hr.staff_documents set is_current = false where application_id = a.id and category = p_category and is_current;
 insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size, extraction_status)
  values (a.id, p.id, p_category, p_path, left(btrim(p_filename), 255), p_mime, p_size, case when v_job_doc then 'unavailable' else 'pending' end) returning * into d;
 return jsonb_build_object('id', d.id, 'replacedPaths', coalesce(to_jsonb(v_old), '[]'::jsonb));
end $fn$;

-- ------------------------------------------------------------------ applying
-- The signed-in person (with a staff profile from hr_staff_start) applies for an open job with their current Resume document, a cover
-- letter (text, an uploaded Cover Letter document, or both). A draft or rejected profile becomes job_applied; a job_applied one stays.
create or replace function public.hr_job_apply(p_job uuid, p_cover_letter text default null, p_resume_document uuid default null, p_cover_letter_document uuid default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; j hr.jobs; v_letter text := left(btrim(coalesce(p_cover_letter, '')), 5000);
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid for update;
 if not found then raise exception 'Create your account first.' using errcode = 'P0002'; end if;
 if p.status not in ('draft','job_applied','rejected') then raise exception 'Your staff application is already with an administrator. Contact them about this role.' using errcode = '23514'; end if;
 select * into j from hr.jobs where id = p_job;
 if not found or j.status <> 'open' then raise exception 'This job is no longer open.' using errcode = '23514'; end if;
 if p_resume_document is null or not exists (select 1 from hr.staff_documents d where d.id = p_resume_document and d.profile_id = p.id and d.category = 'Resume' and d.is_current) then
  raise exception 'Upload your resume.' using errcode = '22023'; end if;
 if p_cover_letter_document is not null and not exists (select 1 from hr.staff_documents d where d.id = p_cover_letter_document and d.profile_id = p.id and d.category = 'Cover Letter' and d.is_current) then
  raise exception 'The cover letter file was not found.' using errcode = '22023'; end if;
 if v_letter = '' and p_cover_letter_document is null then raise exception 'Write a cover letter or upload one.' using errcode = '22023'; end if;
 if exists (select 1 from hr.job_applications a where a.job_id = j.id and a.profile_id = p.id) then raise exception 'You have already applied for this job.' using errcode = '23505'; end if;
 insert into hr.job_applications(job_id, profile_id, resume_document_id, cover_letter, cover_letter_document_id)
  values (j.id, p.id, p_resume_document, v_letter, p_cover_letter_document);
 if p.status in ('draft','rejected') then
  perform set_config('hr.actor', v_uid::text, true); perform set_config('hr.actor_kind', 'applicant', true);
  perform set_config('hr.note', 'Applied for ' || j.title, true);
  update hr.staff_profiles set status = 'job_applied' where id = p.id;
 end if;
 return public.hr_staff_me();
end $fn$;
revoke all on function public.hr_job_apply(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.hr_job_apply(uuid, text, uuid, uuid) to authenticated;

-- hired: the application is marked hired and a job_applied profile becomes a draft so the person completes the staff registration.
-- declined: the application is marked declined; a job_applied profile with no other open application becomes rejected.
create or replace function public.hr_admin_job_decide(p_application uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); a hr.job_applications; j hr.jobs; p hr.staff_profiles; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
 if p_decision not in ('hired','declined') then raise exception 'Choose Hire or Decline.' using errcode = '22023'; end if;
 select * into a from hr.job_applications where id = p_application for update;
 if not found then raise exception 'Job application not found.' using errcode = 'P0002'; end if;
 if a.status <> 'applied' then raise exception 'This job application has already been decided.' using errcode = '23514'; end if;
 select * into j from hr.jobs where id = a.job_id;
 select * into p from hr.staff_profiles where id = a.profile_id for update;
 if p.auth_user_id = v_admin then raise exception 'You cannot decide your own job application.' using errcode = '42501'; end if;
 update hr.job_applications set status = p_decision, decided_by = v_admin, decided_at = now(), decision_note = left(coalesce(v_note, ''), 2000) where id = a.id;
 if p_decision = 'hired' then
  if p.status = 'job_applied' then
   perform hr.staff_move(p.id, 'draft', coalesce(v_note, 'Hired for ' || j.title || '. Please complete your staff registration.'), v_admin, false);
  end if;
 elsif p.status = 'job_applied' and not exists (select 1 from hr.job_applications o where o.profile_id = p.id and o.status = 'applied') then
  perform hr.staff_move(p.id, 'rejected', coalesce(v_note, 'Not selected for ' || j.title), v_admin, true);
 end if;
 return public.hr_admin_staff_detail(p.id);
end $fn$;
revoke all on function public.hr_admin_job_decide(uuid, text, text) from public, anon;
grant execute on function public.hr_admin_job_decide(uuid, text, text) to authenticated;
