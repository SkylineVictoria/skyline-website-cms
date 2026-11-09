set local lock_timeout = '5s';

-- Keep the existing Master Data group and its system identity.
update public.admin_menu_items set label = 'Master Data' where id = 'agencies';
update public.admin_menu_items set is_enabled = false where route = '/admin/staff'
 or (parent_id = 'agencies' and id in ('agency_directory','agent_users'));
insert into public.admin_menu_items
 (id, parent_id, label, route, icon_key, sort_order, permission_key, permission_scope, is_system)
values
 ('agency_candidates', 'agencies', 'Candidates', '/admin/candidates', 'users', 60, 'cms.admin', 'current', true),
 ('agency_employees', 'agencies', 'Employees', '/admin/employees', 'users', 70, 'cms.admin', 'current', true);

alter table hr.jobs
 drop constraint jobs_status_check,
 add constraint jobs_status_check check (status in ('draft', 'open', 'closed')),
 add column department text not null default '' check (char_length(department) <= 120),
 add column vacancies integer not null default 1 check (vacancies between 1 and 10000),
 add column published_at timestamptz;
update hr.jobs set published_at = created_at where status in ('open', 'closed');

-- A manually entered person has no sign-in until they verify their email.
alter table hr.staff_profiles alter column auth_user_id drop not null;
alter table hr.job_applications
 alter column resume_document_id drop not null,
 drop constraint job_applications_check,
 drop constraint job_applications_status_check,
 drop constraint job_applications_job_id_profile_id_key,
 add constraint job_applications_status_check check (status in ('applied', 'hired', 'declined', 'withdrawn')),
 add column source text not null default 'careers' check (source in ('careers', 'manual')),
 add column stage text not null default 'screening' check (stage in ('screening', 'shortlisted', 'interview', 'selected')),
 add column interview_at timestamptz,
 add column interview_notes text not null default '' check (char_length(interview_notes) <= 5000),
 add column recruiter_notes text not null default '' check (char_length(recruiter_notes) <= 5000),
 add constraint job_application_required_files check (source = 'manual' or
  (resume_document_id is not null and (btrim(cover_letter) <> '' or cover_letter_document_id is not null))),
 add constraint job_application_id_profile_key unique (id, profile_id);
update hr.job_applications set stage = 'selected' where status = 'hired';
create unique index job_application_one_in_progress on hr.job_applications(job_id, profile_id) where status = 'applied';
create index job_applications_job_history on hr.job_applications(job_id, created_at desc);

-- Hosted and repository constraints included different categories. Preserve both sets.
alter table hr.staff_documents drop constraint staff_documents_category_check,
 add constraint staff_documents_category_check check (category in
  ('Passport', 'Visa', 'Academic', 'Health Insurance', 'Driving Licence', 'PTE', 'English Certificate', 'Resume', 'Cover Letter'));

-- Employment is a one-to-one extension of the HR identity, independent of login provisioning.
create table hr.employment (
 profile_id uuid primary key references hr.staff_profiles(id) on delete restrict,
 application_id uuid,
 department text not null default '' check (char_length(department) <= 120),
 job_title text not null default '' check (char_length(job_title) <= 150),
 employment_type text check (employment_type in ('full_time', 'part_time')),
 joining_date date check (joining_date between date '1900-01-01' and date '2100-12-31'),
 manager_id uuid references hr.employment(profile_id) on delete restrict check (manager_id <> profile_id),
 work_location text not null default '' check (char_length(work_location) <= 150),
 created_at timestamptz not null default now(),
 foreign key (application_id, profile_id) references hr.job_applications(id, profile_id) on delete restrict
);
create index employment_manager_idx on hr.employment(manager_id);
alter table hr.employment enable row level security;
revoke all on hr.employment from public, anon, authenticated;

insert into hr.employment(profile_id, application_id, department, job_title, employment_type, work_location, created_at)
select p.id, a.id, coalesce(j.department, ''), coalesce(j.title, ''), j.employment_type, coalesce(j.location, ''),
 coalesce(a.decided_at, p.status_changed_at)
from hr.staff_profiles p
left join lateral (select h.* from hr.job_applications h where h.profile_id = p.id and h.status = 'hired'
 order by h.decided_at desc nulls last, h.created_at desc, h.id desc limit 1) a on true
left join hr.jobs j on j.id = a.job_id
where p.status in ('active', 'inactive') or a.id is not null;

create table hr.recruitment_events (
 id bigint generated always as identity primary key,
 profile_id uuid not null references hr.staff_profiles(id) on delete restrict,
 application_id uuid,
 actor_id uuid,
 action text not null,
 details jsonb not null default '{}',
 created_at timestamptz not null default now(),
 foreign key (application_id, profile_id) references hr.job_applications(id, profile_id) on delete restrict
);
create index recruitment_events_person_idx on hr.recruitment_events(profile_id, id desc);
create index recruitment_events_application_idx on hr.recruitment_events(application_id, id desc) where application_id is not null;
alter table hr.recruitment_events enable row level security;
revoke all on hr.recruitment_events from public, anon, authenticated;
create trigger recruitment_events_no_change before update or delete on hr.recruitment_events
 for each row execute function hr.staff_events_append_only();
create trigger recruitment_events_no_truncate before truncate on hr.recruitment_events
 for each statement execute function hr.staff_events_append_only();

create function hr.log_recruitment_change() returns trigger
language plpgsql set search_path = '' as $fn$
declare previous jsonb; current_values jsonb; changes jsonb; candidate uuid; person uuid;
begin
 previous := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
 current_values := to_jsonb(new) - 'updated_at';
 select jsonb_agg(k order by k) into changes from jsonb_object_keys(current_values) k
 where current_values->k is distinct from previous->k;
 if changes is null then return new; end if;
 person := new.profile_id;
 if tg_table_name = 'job_applications' then
  candidate := new.id;
  current_values := jsonb_build_object('status', new.status, 'stage', new.stage, 'decision', new.decision_note);
 else
  candidate := new.application_id;
  current_values := to_jsonb(new) - 'profile_id' - 'created_at';
 end if;
 insert into hr.recruitment_events(profile_id, application_id, actor_id, action, details)
 values (person, candidate, auth.uid(),
  case when tg_table_name = 'job_applications' then 'Application ' else 'Employment ' end ||
  case when tg_op = 'INSERT' then 'created' else 'updated' end,
  current_values || jsonb_build_object('fields', changes));
 return new;
end $fn$;
revoke all on function hr.log_recruitment_change() from public, anon, authenticated;
create trigger recruitment_application_log after insert or update on hr.job_applications for each row execute function hr.log_recruitment_change();
create trigger employment_record_log after insert or update on hr.employment for each row execute function hr.log_recruitment_change();

-- Existing staff activation also establishes an employment record for direct registrations.
create function hr.record_staff_employment() returns trigger
language plpgsql set search_path = '' as $fn$
begin
 insert into hr.employment(profile_id) values (new.id) on conflict (profile_id) do nothing;
 return new;
end $fn$;
revoke all on function hr.record_staff_employment() from public, anon, authenticated;
create trigger employment_on_activation after update of status on hr.staff_profiles
 for each row when (new.status = 'active' and old.status is distinct from new.status)
 execute function hr.record_staff_employment();

create or replace function hr.job_json(j hr.jobs) returns jsonb
language sql immutable parallel safe as $fn$
 select jsonb_build_object('id', j.id, 'title', j.title, 'description', j.description, 'employmentType', j.employment_type, 'salary', j.salary,
  'location', j.location, 'status', j.status, 'postedAt', j.created_at, 'updatedAt', j.updated_at, 'publishedAt', j.published_at, 'department', j.department, 'vacancies', j.vacancies);
$fn$;

create or replace function public.jobs_open(p_id uuid default null) returns jsonb
language sql stable security definer set search_path = public, hr, pg_temp as $fn$
 select coalesce(jsonb_agg(hr.job_json(j) order by j.created_at desc), '[]'::jsonb)
 from hr.jobs j where (p_id is null and j.status = 'open') or (p_id is not null and j.id = p_id and (j.status = 'open' or (j.status = 'closed' and j.published_at is not null)));
$fn$;

create or replace function public.hr_admin_job_list() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(hr.job_json(j) || jsonb_build_object(
   'candidateCount', (select count(distinct profile_id) from hr.job_applications a where a.job_id = j.id),
   'applied', (select count(*) from hr.job_applications a where a.job_id = j.id and a.status = 'applied'),
   'hired', (select count(*) from hr.job_applications a where a.job_id = j.id and a.status = 'hired'),
   'declined', (select count(*) from hr.job_applications a where a.job_id = j.id and a.status = 'declined'))
  order by (j.status = 'open') desc, j.created_at desc) from hr.jobs j), '[]'::jsonb);
end $fn$;

create or replace function public.hr_admin_job_save(p_id uuid, p_job jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); j hr.jobs; v_title text; v_desc text; v_type text; v_salary text; v_location text; v_status text; v_department text; v_vacancies integer;
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
 v_department := btrim(coalesce(p_job->>'department', j.department, ''));
 v_vacancies := coalesce((p_job->>'vacancies')::integer, j.vacancies, 1);
 if char_length(v_department) > 120 or v_vacancies not between 1 and 10000 then
  raise exception 'Check the department and vacancy count.' using errcode = '22023'; end if;
 if v_status not in ('draft','open','closed') then raise exception 'Choose Draft, Open or Closed.' using errcode = '22023'; end if;
 if p_id is null then
  insert into hr.jobs(title, description, employment_type, salary, location, status, department, vacancies, published_at, created_by)
   values (v_title, v_desc, v_type, v_salary, v_location, v_status, v_department, v_vacancies, case when v_status = 'open' then now() end, v_admin) returning * into j;
 else
  update hr.jobs set title = v_title, description = v_desc, employment_type = v_type, salary = v_salary, location = v_location, status = v_status,
   department = v_department, vacancies = v_vacancies,
   published_at = coalesce(j.published_at, case when v_status = 'open' then now() end)
   where id = p_id returning * into j;
 end if;
 return hr.job_json(j);
end $fn$;

create or replace function hr.staff_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable parallel safe as $fn$
 select (p_from, p_to) in (
  ('draft','submitted'), ('submitted','preboarding'), ('submitted','rejected'),
  ('preboarding','active'), ('preboarding','rejected'),
  ('active','inactive'), ('inactive','active'), ('inactive','draft'), ('rejected','draft'),
  ('draft','job_applied'), ('rejected','job_applied'), ('job_applied','draft'), ('job_applied','rejected'));
$fn$;

create or replace function public.hr_staff_start(p_phone text default null, p_requested_role text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_uid uuid := auth.uid(); v_email text; v_confirmed timestamptz; v_meta jsonb; v_phone text; c jsonb; p hr.staff_profiles; v_attached boolean; v_role text := nullif(btrim(coalesce(p_requested_role, '')), '');
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select hr.email_key(u.email), u.email_confirmed_at, u.raw_user_meta_data into v_email, v_confirmed, v_meta from auth.users u where u.id = v_uid;
 if v_email is null or v_confirmed is null then raise exception 'Verify your email address first.' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_email, 12309));
 if exists (select 1 from hr.staff_profiles where auth_user_id = v_uid) then return public.hr_staff_me(); end if;
 if v_role is not null and v_role not in ('admin','trainer') then raise exception 'Choose Admin or Trainer.' using errcode = '22023'; end if;
 v_phone := hr.phone_e164(coalesce(nullif(btrim(coalesce(p_phone, '')), ''), v_meta->>'staff_phone'));
 if v_phone is null then raise exception 'Enter a valid mobile number with its country code.' using errcode = '22023'; end if;
 select * into p from hr.staff_profiles where email = v_email and auth_user_id is null for update;
 c := hr.contact_conflicts(v_email, v_phone, v_uid);
 if p.id is not null then
  if p.phone_e164 <> v_phone or (c->'email') - 'staff'::text <> '[]'::jsonb or (c->'phone') - 'staff'::text <> '[]'::jsonb then
   raise exception 'These details cannot be linked. Please contact the administrator.' using errcode = '23505';
  end if;
  update hr.staff_profiles set auth_user_id = v_uid where id = p.id;
  return public.hr_staff_me();
 end if;
 if jsonb_array_length(c->'email') > 0 then raise exception 'This email can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 if jsonb_array_length(c->'phone') > 0 then raise exception 'This number can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 v_attached := exists (select 1 from public.portal_profiles where auth_user_id = v_uid);
 perform set_config('hr.actor', v_uid::text, true); perform set_config('hr.actor_kind', 'applicant', true);
 perform set_config('hr.note', case when v_attached then 'Started from an existing account' else 'Registered' end, true);
 insert into hr.staff_profiles(auth_user_id, email, phone_e164) values (v_uid, v_email, v_phone) returning * into p;
 insert into hr.staff_applications(profile_id, requested_role) values (p.id, v_role);
 return public.hr_staff_me() || jsonb_build_object('attachedToExistingAccount', v_attached);
exception when unique_violation then
 if sqlerrm like '%staff_profiles_phone_key%' then raise exception 'This number can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 if sqlerrm like '%staff_profiles_email_key%' then raise exception 'This email can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 raise;
end $fn$;

create or replace function public.hr_staff_precheck(p_email text, p_phone text) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare c jsonb;
begin
 if hr.email_key(p_email) is null or hr.email_key(p_email) !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then
  return jsonb_build_object('ok', false, 'reason', 'invalid_email'); end if;
 if hr.phone_e164(p_phone) is null then return jsonb_build_object('ok', false, 'reason', 'invalid_phone'); end if;
 c := hr.contact_conflicts(p_email, p_phone, null);
 if exists (select 1 from hr.staff_profiles where auth_user_id is null
  and email = hr.email_key(p_email) and phone_e164 = hr.phone_e164(p_phone)) then
  c := c || jsonb_build_object('email', (c->'email') - 'staff'::text, 'phone', (c->'phone') - 'staff'::text);
 end if;
 return jsonb_build_object('ok', jsonb_array_length(c->'email') = 0 and jsonb_array_length(c->'phone') = 0,
  'emailConflict', jsonb_array_length(c->'email') > 0, 'phoneConflict', jsonb_array_length(c->'phone') > 0, 'phoneE164', c->'phoneE164');
end $fn$;

create or replace function public.hr_staff_document_register(p_category text, p_path text, p_filename text, p_mime text, p_size integer) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; a hr.staff_applications; d hr.staff_documents; v_old text[]; v_job_doc boolean;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid for update;
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
 select array_agg(storage_path) into v_old from hr.staff_documents where application_id = a.id and category = p_category and is_current
  and not exists (select 1 from hr.job_applications j where resume_document_id = hr.staff_documents.id or cover_letter_document_id = hr.staff_documents.id);
 update hr.staff_documents set is_current = false where application_id = a.id and category = p_category and is_current;
 insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size, extraction_status)
  values (a.id, p.id, p_category, p_path, left(btrim(p_filename), 255), p_mime, p_size, case when v_job_doc then 'unavailable' else 'pending' end) returning * into d;
 return jsonb_build_object('id', d.id, 'replacedPaths', coalesce(to_jsonb(v_old), '[]'::jsonb));
end $fn$;

create or replace function public.hr_job_apply(p_job uuid, p_cover_letter text default null, p_resume_document uuid default null, p_cover_letter_document uuid default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles; j hr.jobs; v_letter text := left(btrim(coalesce(p_cover_letter, '')), 5000);
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid for update;
 if not found then raise exception 'Create your account first.' using errcode = 'P0002'; end if;
 if p.status not in ('draft','job_applied','rejected') then raise exception 'Your staff application is already with an administrator. Contact them about this role.' using errcode = '23514'; end if;
 select * into j from hr.jobs where id = p_job for share;
 if not found or j.status <> 'open' then raise exception 'This job is no longer open.' using errcode = '23514'; end if;
 if p_resume_document is null or not exists (select 1 from hr.staff_documents d where d.id = p_resume_document and d.profile_id = p.id and d.category = 'Resume' and d.is_current) then
  raise exception 'Upload your resume.' using errcode = '22023'; end if;
 if p_cover_letter_document is not null and not exists (select 1 from hr.staff_documents d where d.id = p_cover_letter_document and d.profile_id = p.id and d.category = 'Cover Letter' and d.is_current) then
  raise exception 'The cover letter file was not found.' using errcode = '22023'; end if;
 if v_letter = '' and p_cover_letter_document is null then raise exception 'Write a cover letter or upload one.' using errcode = '22023'; end if;
 if exists (select 1 from hr.job_applications a where a.job_id = j.id and a.profile_id = p.id and a.status in ('applied','hired')) then raise exception 'You have already applied for this job.' using errcode = '23505'; end if;
 insert into hr.job_applications(job_id, profile_id, resume_document_id, cover_letter, cover_letter_document_id)
  values (j.id, p.id, p_resume_document, v_letter, p_cover_letter_document);
 if p.status in ('draft','rejected') and not exists (select 1 from hr.employment where profile_id = p.id) then
  perform set_config('hr.actor', v_uid::text, true); perform set_config('hr.actor_kind', 'applicant', true);
  perform set_config('hr.note', 'Applied for ' || j.title, true);
  update hr.staff_profiles set status = 'job_applied' where id = p.id;
 end if;
 return public.hr_staff_me();
end $fn$;

-- The owner and administrators can still read private files through the existing
-- signed URL policy. Once used in an application the object cannot be deleted.
create function hr.recruitment_file_is_unused(p_path text) returns boolean
language sql stable security definer set search_path = '' as $fn$
 select not exists (
  select 1 from hr.staff_documents d join hr.job_applications a
   on a.resume_document_id = d.id or a.cover_letter_document_id = d.id
  where d.storage_path = p_path);
$fn$;
revoke all on function hr.recruitment_file_is_unused(text) from public, anon;
grant execute on function hr.recruitment_file_is_unused(text) to authenticated;
create policy recruitment_keep_application_files on storage.objects as restrictive for delete to authenticated
 using (bucket_id <> 'staff-documents' or hr.recruitment_file_is_unused(name));
create policy recruitment_admin_upload on storage.objects for insert to authenticated with check (
 bucket_id = 'staff-documents' and public.cms_is_admin()
 and (storage.foldername(name))[1] = 'recruitment' and (storage.foldername(name))[2] = auth.uid()::text);
create policy recruitment_admin_remove_orphan on storage.objects for delete to authenticated using (
 bucket_id = 'staff-documents' and public.cms_is_admin()
 and (storage.foldername(name))[1] = 'recruitment' and (storage.foldername(name))[2] = auth.uid()::text
 and hr.recruitment_file_is_unused(name));

create function hr.admin_save_person(p_id uuid, p_person jsonb) returns hr.staff_profiles
language plpgsql set search_path = '' as $fn$
declare p hr.staff_profiles; v_email text := hr.email_key(p_person->>'email');
 v_phone text := hr.phone_e164(p_person->>'phone'); v_first text := btrim(coalesce(p_person->>'firstName', ''));
 v_last text := btrim(coalesce(p_person->>'lastName', ''));
begin
 if v_email is null or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' or char_length(v_email) > 254 then
  raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
 if v_phone is null then raise exception 'Enter a valid mobile number with its country code.' using errcode = '22023'; end if;
 if char_length(v_first) not between 1 and 100 or char_length(v_last) not between 1 and 100 then
  raise exception 'Enter first and last names (up to 100 characters each).' using errcode = '22023'; end if;
 if p_id is null then
  perform pg_advisory_xact_lock(hashtextextended(v_email, 12309));
  select * into p from hr.staff_profiles where email = v_email for update;
  if p.id is not null then
   if p.phone_e164 <> v_phone then
    raise exception 'The email matches an HR profile with a different phone number.' using errcode = '23505'; end if;
   return p;
  end if;
  perform set_config('hr.actor_kind', 'admin', true);
  perform set_config('hr.note', 'Added by an administrator', true);
  insert into hr.staff_profiles(email, phone_e164, first_name, last_name)
   values (v_email, v_phone, v_first, v_last) returning * into p;
  insert into hr.staff_applications(profile_id) values (p.id);
 else
  select * into strict p from hr.staff_profiles where id = p_id for update;
  if p.auth_user_id is not null and v_email <> p.email then
   raise exception 'Change the linked sign-in email through account management.' using errcode = '23514'; end if;
  if (p.email,p.phone_e164,p.first_name,p.last_name) is distinct from (v_email,v_phone,v_first,v_last) then
   update hr.staff_profiles set email = v_email, phone_e164 = v_phone, first_name = v_first, last_name = v_last
    where id = p_id returning * into p;
   insert into hr.recruitment_events(profile_id, actor_id, action)
    values (p.id, auth.uid(), 'Contact details updated');
  end if;
 end if;
 return p;
end $fn$;
revoke all on function hr.admin_save_person(uuid,jsonb) from public, anon, authenticated;

create function hr.candidate_json(a hr.job_applications, p hr.staff_profiles, j hr.jobs) returns jsonb
language sql stable set search_path = '' as $fn$
 select jsonb_build_object('id', a.id, 'profileId', p.id, 'jobId', j.id, 'jobTitle', j.title,
  'firstName', p.first_name, 'lastName', p.last_name, 'email', p.email, 'phone', p.phone_e164,
  'linkedAccount', p.auth_user_id is not null, 'appliedAt', a.created_at, 'source', a.source,
  'status', a.status, 'stage', a.stage, 'interviewAt', a.interview_at, 'interviewNotes', a.interview_notes,
  'recruiterNotes', a.recruiter_notes, 'coverLetter', a.cover_letter, 'decisionNote', a.decision_note,
  'decidedAt', a.decided_at, 'employeeId', (select e.profile_id from hr.employment e where e.profile_id = p.id),
  'resume', (select jsonb_build_object('filename', d.filename, 'storagePath', d.storage_path) from hr.staff_documents d where d.id = a.resume_document_id),
  'coverLetterDocument', (select jsonb_build_object('filename', d.filename, 'storagePath', d.storage_path) from hr.staff_documents d where d.id = a.cover_letter_document_id));
$fn$;
revoke all on function hr.candidate_json(hr.job_applications,hr.staff_profiles,hr.jobs) from public, anon, authenticated;

create function public.hr_admin_candidates(p_job uuid, p_state text, p_search text, p_limit integer, p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
begin
 perform hr.require_admin();
 return (
  with matching as materialized (
   select a.id, a.created_at from hr.job_applications a join hr.staff_profiles p on p.id = a.profile_id
   join hr.jobs j on j.id = a.job_id
   where (p_job is null or a.job_id = p_job)
   and (p_state is null or (case when a.status = 'applied' then a.stage else a.status end) = p_state)
   and strpos(lower(concat_ws(' ', p.first_name, p.last_name, p.email, p.phone_e164, j.title, a.id, p.id)),
    lower(coalesce(btrim(p_search), ''))) > 0
  ), page as (
   select * from matching order by created_at desc, id desc
   limit greatest(1,least(100,coalesce(p_limit,25))) offset greatest(0,coalesce(p_offset,0))
  )
  select jsonb_build_object('total', (select count(*) from matching), 'rows', coalesce((
   select jsonb_agg(jsonb_build_object('id', a.id, 'profileId', p.id, 'jobTitle', j.title,
    'firstName', p.first_name, 'lastName', p.last_name, 'email', p.email, 'phone', p.phone_e164,
    'appliedAt', a.created_at, 'source', a.source, 'status', a.status, 'stage', a.stage) order by a.created_at desc, a.id desc)
   from page x join hr.job_applications a on a.id = x.id join hr.staff_profiles p on p.id = a.profile_id
   join hr.jobs j on j.id = a.job_id), '[]'::jsonb)));
end $fn$;

create function public.hr_admin_candidate(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare result jsonb;
begin
 perform hr.require_admin();
 select hr.candidate_json(a,p,j) || jsonb_build_object('history', coalesce((
  select jsonb_agg(jsonb_build_object('id',x.id,'action',x.action,'at',x.created_at,'details',x.details)
   order by x.id desc) from hr.recruitment_events x where x.application_id = a.id or (x.profile_id = p.id and x.action = 'Contact details updated')), '[]'::jsonb))
 into result from hr.job_applications a join hr.staff_profiles p on p.id = a.profile_id join hr.jobs j on j.id = a.job_id
 where a.id = p_id;
 if not found then raise exception 'Candidate application not found.' using errcode = 'P0002'; end if;
 return result;
end $fn$;

create function public.hr_admin_candidate_save(p_id uuid, p_job uuid, p_person jsonb, p_cover_letter text, p_recruiter_notes text) returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare a hr.job_applications; p hr.staff_profiles; j hr.jobs; v_person uuid;
begin
 perform hr.require_admin();
 if p_id is not null then
  select profile_id into strict v_person from hr.job_applications where id = p_id;
 end if;
 p := hr.admin_save_person(v_person, p_person);
 if p_id is not null then
  select * into strict a from hr.job_applications where id = p_id for update;
  if a.job_id <> p_job and (a.source <> 'manual' or a.status <> 'applied' or a.stage <> 'screening') then
   raise exception 'Only a manual application in screening can change jobs.' using errcode = '23514'; end if;
 end if;
 select * into j from hr.jobs where id = p_job for share;
 if not found then raise exception 'Choose an existing job.' using errcode = '22023'; end if;
 if p_id is null or a.job_id <> p_job then
  if exists (select 1 from hr.job_applications where profile_id = p.id and job_id = j.id and
   (status = 'applied' or (status = 'hired' and p.status <> 'inactive'))) then
   raise exception 'This person already has an application for this job.' using errcode = '23505'; end if;
 end if;
 if p_id is null then
  insert into hr.job_applications(job_id,profile_id,source,cover_letter,recruiter_notes)
   values(j.id,p.id,'manual',coalesce(p_cover_letter,''),coalesce(p_recruiter_notes,'')) returning id into p_id;
  if p.status in ('draft','rejected') and not exists (select 1 from hr.employment where profile_id = p.id) then
   perform hr.staff_move(p.id,'job_applied','Application added by an administrator',auth.uid(),false);
  end if;
 else
  update hr.job_applications set job_id = j.id, recruiter_notes = coalesce(p_recruiter_notes,''),
   cover_letter = case when a.source = 'manual' then coalesce(p_cover_letter,'') else a.cover_letter end where id = a.id;
 end if;
 return p_id;
end $fn$;

create function public.hr_admin_candidate_document(p_id uuid, p_category text, p_path text, p_filename text, p_mime text, p_size integer) returns void
language plpgsql security definer set search_path = '' as $fn$
declare v_admin uuid := hr.require_admin(); a hr.job_applications; v_person uuid; v_staff uuid; v_doc uuid;
begin
 select profile_id into strict v_person from hr.job_applications where id = p_id;
 perform 1 from hr.staff_profiles where id = v_person for update;
 select * into strict a from hr.job_applications where id = p_id for update;
 if a.status <> 'applied' then raise exception 'This application has already been decided.' using errcode = '23514'; end if;
 if a.source <> 'manual' and ((p_category = 'Resume' and a.resume_document_id is not null) or
  (p_category = 'Cover Letter' and a.cover_letter_document_id is not null)) then
  raise exception 'Files submitted through Careers are kept with the application.' using errcode = '23514'; end if;
 if p_category is null or p_category not in ('Resume','Cover Letter') or p_mime is null or
  p_mime not in ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  or p_size is null or p_size not between 1 and 10485760 or coalesce(char_length(btrim(p_filename)),0) not between 1 and 255 then
  raise exception 'Upload a PDF or Word document up to 10 MB.' using errcode = '22023'; end if;
 if p_path is null or p_path !~ ('^recruitment/' || v_admin || '/' || p_id || '/[a-f0-9-]{36}\.(pdf|doc|docx)$')
  or not exists (select 1 from storage.objects where bucket_id = 'staff-documents' and name = p_path) then
  raise exception 'The uploaded document could not be verified.' using errcode = '22023'; end if;
 select id into strict v_staff from hr.staff_applications where profile_id = a.profile_id;
 insert into hr.staff_documents(application_id,profile_id,category,storage_path,filename,mime_type,file_size,is_current,extraction_status)
  values (v_staff,a.profile_id,p_category,p_path,btrim(p_filename),p_mime,p_size,false,'unavailable') returning id into v_doc;
 update hr.job_applications set resume_document_id = case when p_category = 'Resume' then v_doc else resume_document_id end,
  cover_letter_document_id = case when p_category = 'Cover Letter' then v_doc else cover_letter_document_id end where id = a.id;
end $fn$;

create function public.hr_admin_candidate_progress(p_id uuid, p_action text, p_interview_at timestamptz, p_interview_notes text, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare v_admin uuid := hr.require_admin(); a hr.job_applications; p hr.staff_profiles; j hr.jobs; v_person uuid;
 v_reason text := btrim(coalesce(p_reason,'')); v_status text;
begin
 select profile_id into strict v_person from hr.job_applications where id = p_id;
 select * into strict p from hr.staff_profiles where id = v_person for update;
 select * into strict a from hr.job_applications where id = p_id for update;
 if p.auth_user_id = v_admin then raise exception 'You cannot decide your own job application.' using errcode = '42501'; end if;
 if a.status <> 'applied' then raise exception 'This job application has already been decided.' using errcode = '23514'; end if;
 if p_action in ('screening','shortlisted','interview','selected') then
  if p_action = 'interview' and p_interview_at is null then
   raise exception 'Enter the interview date and time.' using errcode = '22023'; end if;
  if p_action = 'selected' and a.stage not in ('interview','selected') then
   raise exception 'Record the interview before marking a candidate selected.' using errcode = '23514'; end if;
  update hr.job_applications set stage = p_action,
   interview_at = case when p_action = 'interview' then p_interview_at else interview_at end,
   interview_notes = case when p_action in ('interview','selected') and p_interview_notes is not null
    then p_interview_notes else interview_notes end where id = p_id;
  return p.id;
 end if;
 if p_action is null or p_action not in ('hired','declined','withdrawn') then
  raise exception 'Choose a valid recruitment action.' using errcode = '22023'; end if;
 if p_action in ('declined','withdrawn') and v_reason = '' then
  raise exception 'Record a reason for this decision.' using errcode = '22023'; end if;
 if p_action = 'hired' and a.stage <> 'selected' then
  raise exception 'Mark the candidate selected before hiring.' using errcode = '23514'; end if;
 if p_action = 'hired' and exists (select 1 from hr.employment where profile_id = p.id) and p.status not in ('inactive','active') then
  raise exception 'This person already has an employment record in onboarding.' using errcode = '23514'; end if;
 update hr.job_applications set status = p_action, decided_by = v_admin, decided_at = now(), decision_note = v_reason where id = p_id;
 if p_action = 'hired' then
  select * into strict j from hr.jobs where id = a.job_id;
  insert into hr.employment(profile_id,application_id,department,job_title,employment_type,work_location)
   values (p.id,a.id,j.department,j.title,j.employment_type,j.location)
   on conflict (profile_id) do update set application_id = excluded.application_id,
    department = excluded.department, job_title = excluded.job_title, employment_type = excluded.employment_type,
    work_location = excluded.work_location,
    joining_date = case when p.status = 'inactive' then null else hr.employment.joining_date end;
  if p.status in ('job_applied','rejected','inactive') then
   update hr.staff_roles set revoked_at = now(), revoked_by = v_admin where profile_id = p.id and revoked_at is null;
   if p.status = 'inactive' then
    update hr.staff_applications set submitted_at = null, reviewed_at = null, reviewed_by = null, review_note = ''
     where profile_id = p.id;
   end if;
   perform hr.staff_move(p.id,'draft','Hired for ' || j.title || '. Complete onboarding.',v_admin,false);
  end if;
 elsif p.status = 'job_applied' and not exists (
  select 1 from hr.job_applications where profile_id = p.id and status = 'applied') then
  v_status := case when p_action = 'declined' then 'rejected' else 'draft' end;
  perform hr.staff_move(p.id,v_status,'Recruitment application ' || p_action,v_admin,p_action = 'declined');
 end if;
 return p.id;
end $fn$;

-- Keep the previous RPC contract for existing clients while enforcing the same hiring rules.
create or replace function public.hr_admin_job_decide(p_application uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare v_person uuid;
begin
 if p_decision is null or p_decision not in ('hired','declined') then
  raise exception 'Choose Hire or Decline.' using errcode = '22023'; end if;
 v_person := public.hr_admin_candidate_progress(p_application,p_decision,null,null,p_note);
 return public.hr_admin_staff_detail(v_person);
end $fn$;

create function hr.employee_json(e hr.employment, p hr.staff_profiles) returns jsonb
language sql stable set search_path = '' as $fn$
 select jsonb_build_object('id', p.id, 'firstName', p.first_name, 'lastName', p.last_name, 'email', p.email,
  'phone', p.phone_e164, 'linkedAccount', p.auth_user_id is not null, 'status', p.status,
  'candidateId', e.application_id, 'department', e.department, 'jobTitle', e.job_title, 'employmentType', e.employment_type,
  'joiningDate', e.joining_date, 'managerId', e.manager_id, 'workLocation', e.work_location,
  'managerName', (select coalesce(nullif(btrim(concat_ws(' ',m.first_name,m.last_name)),''),m.email)
   from hr.staff_profiles m where m.id = e.manager_id));
$fn$;
revoke all on function hr.employee_json(hr.employment,hr.staff_profiles) from public, anon, authenticated;

create function public.hr_admin_employees(p_state text, p_department text, p_search text, p_limit integer, p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
begin
 perform hr.require_admin();
 return (
  with matching as materialized (
   select p.id, lower(p.last_name) as surname, lower(p.first_name) as given_name
   from hr.employment e join hr.staff_profiles p on p.id = e.profile_id
   where (p_state is null or (case when p.status in ('active','inactive','rejected') then p.status else 'onboarding' end) = p_state)
   and (p_department is null or e.department = p_department)
   and strpos(lower(concat_ws(' ', p.first_name, p.last_name, p.email, p.phone_e164, e.job_title, e.department, p.id)),
    lower(coalesce(btrim(p_search), ''))) > 0
  ), page as (
   select * from matching order by surname,given_name,id
   limit greatest(1,least(100,coalesce(p_limit,25))) offset greatest(0,coalesce(p_offset,0))
  )
  select jsonb_build_object('total', (select count(*) from matching),
   'departments', coalesce((select jsonb_agg(department order by department) from
     (select distinct department from hr.employment where department <> '') departments), '[]'::jsonb),
   'rows', coalesce((select jsonb_agg(hr.employee_json(e,p) order by x.surname,x.given_name,x.id)
    from page x join hr.employment e on e.profile_id = x.id join hr.staff_profiles p on p.id = x.id), '[]'::jsonb)));
end $fn$;

create function public.hr_admin_employee(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare result jsonb;
begin
 perform hr.require_admin();
 select hr.employee_json(e,p) || jsonb_build_object('history', coalesce((
  select jsonb_agg(jsonb_build_object('id',x.id,'action',x.action,'at',x.at,'details',x.details)
   order by x.at desc,x.id desc) from (
    select 'recruitment-' || r.id id, r.action, r.created_at at, r.details from hr.recruitment_events r
     where r.profile_id = p.id and r.action not like 'Application %'
    union all
    select 'staff-' || s.id, 'Onboarding status', s.created_at,
     jsonb_build_object('status',s.to_status,'decision',s.note) from hr.staff_status_events s where s.profile_id = p.id
   ) x), '[]'::jsonb))
 into result from hr.employment e join hr.staff_profiles p on p.id = e.profile_id where p.id = p_id;
 if not found then raise exception 'Employee record not found.' using errcode = 'P0002'; end if;
 return result;
end $fn$;

create function public.hr_admin_employee_save(p_id uuid, p_person jsonb, p_employment jsonb) returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare p hr.staff_profiles; v_manager uuid := nullif(p_employment->>'managerId','')::uuid;
 v_joining date := nullif(p_employment->>'joiningDate','')::date;
 v_title text := btrim(coalesce(p_employment->>'jobTitle',''));
 v_type text := nullif(p_employment->>'employmentType','');
 v_department text := btrim(coalesce(p_employment->>'department',''));
 v_location text := btrim(coalesce(p_employment->>'workLocation',''));
begin
 perform hr.require_admin();
 if char_length(v_title) not between 1 and 150 or v_type is null or v_type not in ('full_time','part_time') then
  raise exception 'Enter the job title and employment type.' using errcode = '22023'; end if;
 if p_id is not null and not exists (select 1 from hr.employment where profile_id = p_id) then
  raise exception 'Employee record not found.' using errcode = 'P0002'; end if;
 perform pg_advisory_xact_lock(736325054);
 p := hr.admin_save_person(p_id,p_person);
 if p_id is null and exists (select 1 from hr.employment where profile_id = p.id) then
  raise exception 'This person already has an employee record. Edit the existing record.' using errcode = '23505'; end if;
 if p_id is null and exists (select 1 from hr.job_applications where profile_id = p.id and status = 'applied') then
  raise exception 'Hire this person from their active candidate application.' using errcode = '23514'; end if;
 if v_manager is not null and exists (
  with recursive chain as (
   select profile_id,manager_id from hr.employment where profile_id = v_manager
   union select e.profile_id,e.manager_id from hr.employment e join chain c on e.profile_id = c.manager_id
  ) select 1 from chain where profile_id = p.id) then
  raise exception 'The manager assignment would create a reporting cycle.' using errcode = '23514'; end if;
 insert into hr.employment(profile_id,department,job_title,employment_type,joining_date,manager_id,work_location)
 values (p.id,v_department,v_title,v_type,v_joining,v_manager,v_location)
 on conflict (profile_id) do update set department = excluded.department, job_title = excluded.job_title,
  employment_type = excluded.employment_type, joining_date = excluded.joining_date, manager_id = excluded.manager_id,
  work_location = excluded.work_location;
 if p_id is null and p.status in ('job_applied','rejected') then
  perform hr.staff_move(p.id,'draft','Added as an employee. Complete onboarding.',auth.uid(),false);
 end if;
 return p.id;
end $fn$;

-- The existing staff-register Edge Function verifies the caller before requesting this email target.
create function public.hr_employee_invite_target(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare p hr.staff_profiles;
begin
 select s.* into p from hr.employment e join hr.staff_profiles s on s.id = e.profile_id where e.profile_id = p_id;
 if not found then raise exception 'Employee record not found.' using errcode = 'P0002'; end if;
 if p.status not in ('draft','submitted','preboarding') then
  raise exception 'Only an employee in onboarding can be invited.' using errcode = '23514'; end if;
 return jsonb_build_object('email', p.email, 'phone', p.phone_e164, 'name', btrim(concat_ws(' ',p.first_name,p.last_name)),
  'hasAccount', exists (select 1 from auth.users u where lower(u.email) = p.email));
end $fn$;
revoke all on function public.hr_employee_invite_target(uuid) from public, anon, authenticated;
grant execute on function public.hr_employee_invite_target(uuid) to service_role;

create function public.hr_employee_invite_logged(p_id uuid, p_actor uuid) returns void
language sql security definer set search_path = '' as $fn$
 insert into hr.recruitment_events(profile_id,actor_id,action)
 select profile_id,p_actor,'Onboarding invitation requested' from hr.employment where profile_id = p_id;
$fn$;
revoke all on function public.hr_employee_invite_logged(uuid,uuid) from public, anon, authenticated;
grant execute on function public.hr_employee_invite_logged(uuid,uuid) to service_role;

revoke all on function
 public.hr_admin_candidates(uuid,text,text,integer,integer), public.hr_admin_candidate(uuid),
 public.hr_admin_candidate_save(uuid,uuid,jsonb,text,text),
 public.hr_admin_candidate_document(uuid,text,text,text,text,integer),
 public.hr_admin_candidate_progress(uuid,text,timestamptz,text,text),
 public.hr_admin_employees(text,text,text,integer,integer), public.hr_admin_employee(uuid),
 public.hr_admin_employee_save(uuid,jsonb,jsonb)
from public, anon;
grant execute on function
 public.hr_admin_candidates(uuid,text,text,integer,integer), public.hr_admin_candidate(uuid),
 public.hr_admin_candidate_save(uuid,uuid,jsonb,text,text),
 public.hr_admin_candidate_document(uuid,text,text,text,text,integer),
 public.hr_admin_candidate_progress(uuid,text,timestamptz,text,text),
 public.hr_admin_employees(text,text,text,integer,integer), public.hr_admin_employee(uuid),
 public.hr_admin_employee_save(uuid,jsonb,jsonb)
to authenticated;

-- Keep the additional onboarding fields present on Skyline Web while restoring job history.
do $onboarding$
begin
 if to_regprocedure('hr.staff_doc_summary(uuid)') is not null then
  execute $ddl$
CREATE OR REPLACE FUNCTION public.hr_staff_me()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
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
  'jobApplications', hr.job_applications_json(p.id),
  'role', (select r.role from hr.staff_roles r where r.profile_id = p.id and r.revoked_at is null),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id)
     from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb));
end $function$

$ddl$;
  execute $ddl$
CREATE OR REPLACE FUNCTION public.hr_admin_staff_detail(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'hr', 'pg_temp'
AS $function$
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
  'jobApplications', hr.job_applications_json(p.id),
  'roles', coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'grantedAt', r.granted_at, 'revokedAt', r.revoked_at) order by r.granted_at) from hr.staff_roles r where r.profile_id = p.id), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id) from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb),
  'hasCmsAccess', exists (select 1 from public.cms_users c where c.auth_user_id = p.auth_user_id and c.status = 'Active'));
end $function$

$ddl$;
 end if;
end $onboarding$;

-- On Skyline Web, every newly activated or reactivated account must pass the
-- same document gate, including callers using the legacy activation RPC.
create function hr.guard_employment_activation() returns trigger
language plpgsql set search_path = '' as $fn$
declare v_category text;
begin
 if new.auth_user_id is null then
  raise exception 'The employee must link and verify their sign-in first.' using errcode = '23514'; end if;
 if to_regprocedure('hr.staff_doc_summary(uuid)') is not null then
  for v_category in select unnest(hr.staff_required_categories(new.is_australian_citizen)) loop
   if not exists (select 1 from hr.staff_documents d where d.profile_id = new.id and d.category = v_category and d.is_current)
    or exists (select 1 from hr.staff_documents d where d.profile_id = new.id and d.category = v_category and d.is_current and
      (d.status <> 'approved' or (hr.staff_doc_needs_expiry(v_category) and (d.expiry_date is null or d.expiry_date < current_date)))) then
    raise exception 'Approve every required, current document first (%).', lower(v_category) using errcode = '23514'; end if;
  end loop;
 end if;
 return new;
end $fn$;
revoke all on function hr.guard_employment_activation() from public, anon, authenticated;
create trigger employment_activation_guard before update of status on hr.staff_profiles
 for each row when (new.status = 'active' and old.status is distinct from new.status)
 execute function hr.guard_employment_activation();
