-- STUDENT-DOCUMENTS (owner 2026-11-27, stage 2 of STUDENT-OWNS-ANSWERS): "store all in the student, no duplicate data; we collect
-- documents at the time of application only". The student's personal documents (Passport, Visa, English / English Test / English
-- Certificate / PTE, Academic, Driving Licence: student_document_category) belong to the student: stored once, uploaded during an
-- application, used by every application of that student. Application documents (Consent, Offer, CoE, Credit Evidence, Health
-- Insurance, Other ...) stay with their application.
-- * enrollment_application_documents.student_id: set from the application's student for a student category (insert, category
--   change); application_id stays the application the file was uploaded in (its storage folder).
-- * "The documents of application X" = its own application documents + its student's documents: public.application_document_ids(X).
--   Used by the passport check, completion, progress, submit check, review, registration evidence and the submission email.
-- * One current document per student and category (Academic may have several): a new upload retires the student's earlier one
--   (is_current = false; the file is kept as history, a submitted application's snapshot may name it).
-- * Removing a student document: public.portal_student_document_removal(doc) retires it when the student has an application past
--   draft (its record needs the file), else says delete (portal-document-delete then deletes the file and row).
-- * Deleting a draft keeps the student documents the student's other applications use: they move to the student's latest other
--   application (trigger a_rehome_student_documents; the file stays in its folder); public.application_delete_document_ids(X) lists
--   only what the deletion removes (prepare / count / delete info).
-- * Read access: a student document can be read (row and file) by anyone who can open any application of the student
--   (portal_can_access_student_documents; policies student_documents_read, portal_docs_obj_student_read).
-- * Submit: the snapshot records the document versions used (documentVersions, trigger on enrollment_application_versions).
-- * DOCUMENT-CARRY copying stops (no copies): its dispatch trigger is dropped and the page's request answers "nothing to copy".
-- Down: drop the triggers / policies / functions added here, restore the patched functions from 20261127140517-era definitions,
-- drop column student_id.
begin;

create or replace function public.student_document_category(p_category text) returns boolean
language sql immutable parallel safe set search_path = '' as $fn$
  select p_category in ('Passport', 'Visa', 'English', 'English Test', 'English Certificate', 'PTE', 'Academic', 'Driving Licence');
$fn$;

alter table public.enrollment_application_documents add column if not exists student_id uuid references public.enrollment_students(id) on delete cascade;
create index if not exists enrollment_application_documents_student_idx on public.enrollment_application_documents(student_id, category) where student_id is not null;
comment on column public.enrollment_application_documents.student_id is
  'STUDENT-DOCUMENTS: the student this personal document belongs to (shared by all their applications); null for an application document.';

create or replace function public.document_set_student() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if public.student_document_category(new.category) then
    new.student_id := (select a.student_id from enrollment_applications a where a.id = new.application_id);
  else
    new.student_id := null;
  end if;
  return new;
end $fn$;
revoke all on function public.document_set_student() from public, anon, authenticated;
drop trigger if exists a_document_student on public.enrollment_application_documents;
create trigger a_document_student before insert or update of category, application_id on public.enrollment_application_documents
  for each row execute function public.document_set_student();

-- The documents an application uses: its own application documents and its student's documents.
create or replace function public.application_document_ids(p_application uuid) returns setof uuid
language sql stable security definer set search_path = '' as $fn$
  select d.id from public.enrollment_application_documents d where d.application_id = p_application and d.student_id is null
  union
  select d.id from public.enrollment_application_documents d join public.enrollment_applications a on a.id = p_application
   where a.student_id is not null and d.student_id = a.student_id;
$fn$;
revoke all on function public.application_document_ids(uuid) from public, anon, authenticated;
grant execute on function public.application_document_ids(uuid) to service_role;

-- What deleting this application removes: its application documents, and the student documents uploaded in it when the student has
-- no other application (otherwise they move to that application).
create or replace function public.application_delete_document_ids(p_application uuid) returns setof uuid
language sql stable security definer set search_path = '' as $fn$
  select d.id from public.enrollment_application_documents d join public.enrollment_applications a on a.id = d.application_id
   where d.application_id = p_application
     and (d.student_id is null or not exists (select 1 from public.enrollment_applications o where o.student_id = d.student_id and o.id <> p_application));
$fn$;
revoke all on function public.application_delete_document_ids(uuid) from public, anon, authenticated;

-- The documents of an application for its screens (after the caller's access check).
create or replace function public.portal_application_document_ids(p_application uuid) returns uuid[]
language plpgsql stable security definer set search_path = public as $fn$
begin
  if auth.uid() is null or not public.portal_can_access_application(p_application) then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select array_agg(x) from public.application_document_ids(p_application) x), '{}');
end $fn$;
revoke all on function public.portal_application_document_ids(uuid) from public, anon;
grant execute on function public.portal_application_document_ids(uuid) to authenticated;

create or replace function public.portal_can_access_student_documents(p_student uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select p_student is not null and (public.portal_is_slit_admin()
    or exists (select 1 from public.enrollment_applications a where a.student_id = p_student and public.portal_can_access_application(a.id)));
$fn$;
revoke all on function public.portal_can_access_student_documents(uuid) from public, anon;
grant execute on function public.portal_can_access_student_documents(uuid) to authenticated;

drop policy if exists student_documents_read on public.enrollment_application_documents;
create policy student_documents_read on public.enrollment_application_documents for select
  using (student_id is not null and public.portal_can_access_student_documents(student_id));

create or replace function public.portal_can_read_student_document_object(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = public as $fn$
  select auth.uid() is not null and exists (select 1 from public.enrollment_application_documents d
    where d.bucket_name = p_bucket and d.storage_path = p_name and d.student_id is not null and public.portal_can_access_student_documents(d.student_id));
$fn$;
revoke all on function public.portal_can_read_student_document_object(text, text) from public, anon;
grant execute on function public.portal_can_read_student_document_object(text, text) to authenticated;
drop policy if exists portal_docs_obj_student_read on storage.objects;
create policy portal_docs_obj_student_read on storage.objects for select
  using (bucket_id = 'enrollment-documents' and public.portal_can_read_student_document_object(bucket_id, name));

-- One current document per student and category (Academic may have several): a new one retires the earlier.
create or replace function public.document_retire_previous() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.student_id is not null and new.is_current and new.category <> 'Academic' then
    update enrollment_application_documents set is_current = false
     where student_id = new.student_id and category = new.category and id <> new.id and is_current;
  end if;
  return null;
end $fn$;
revoke all on function public.document_retire_previous() from public, anon, authenticated;
drop trigger if exists z_document_retire_previous on public.enrollment_application_documents;
create trigger z_document_retire_previous after insert on public.enrollment_application_documents
  for each row execute function public.document_retire_previous();

-- Removing a student document: retired (kept as history) once the student has an application past draft, else deleted.
create or replace function public.portal_student_document_removal(p_document uuid) returns text
language plpgsql security definer set search_path = public as $fn$
declare d enrollment_application_documents;
begin
  select * into d from enrollment_application_documents where id = p_document for update;
  if auth.uid() is null or not found then raise exception 'Not authorized' using errcode = '42501'; end if;
  if d.student_id is null then return 'application'; end if;
  if not exists (select 1 from enrollment_applications a where a.student_id = d.student_id and a.status in ('draft', 'action_required')
                   and public.portal_can_edit_application(a.id)) then
    raise exception 'This document can be changed only while one of the student''s applications is being filled in' using errcode = '42501';
  end if;
  if exists (select 1 from enrollment_applications a where a.student_id = d.student_id and a.status <> 'draft') then
    update enrollment_application_documents set is_current = false where id = d.id;
    return 'retired';
  end if;
  return 'delete';
end $fn$;
revoke all on function public.portal_student_document_removal(uuid) from public, anon;
grant execute on function public.portal_student_document_removal(uuid) to authenticated;

-- Deleting an application keeps the student documents its student's other applications use (moved to the latest other one).
create or replace function public.portal_guard_document_locator() returns trigger
language plpgsql set search_path to 'public' as $function$
begin
  if (new.id,new.application_id,new.bucket_name,new.storage_path,new.category,new.revision_of)
    is distinct from (old.id,old.application_id,old.bucket_name,old.storage_path,old.category,old.revision_of) then
    -- STUDENT-DOCUMENTS: a student document may move to another application of the same student (and nothing else may change).
    if current_setting('portal.document_rehome', true) = 'on' and old.student_id is not null
       and (new.id,new.bucket_name,new.storage_path,new.category,new.revision_of) is not distinct from (old.id,old.bucket_name,old.storage_path,old.category,old.revision_of)
       and exists (select 1 from enrollment_applications a where a.id = new.application_id and a.student_id = old.student_id) then
      return new;
    end if;
    raise exception 'document target is immutable; upload a replacement' using errcode='42501';
  end if;
  return new;
end;
$function$;

create or replace function public.application_rehome_student_documents() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_target uuid;
begin
  if old.student_id is null then return old; end if;
  select a.id into v_target from enrollment_applications a where a.student_id = old.student_id and a.id <> old.id
   order by a.created_at desc limit 1;
  if v_target is null then return old; end if;
  perform set_config('portal.document_rehome', 'on', true);
  update enrollment_application_documents set application_id = v_target where application_id = old.id and student_id = old.student_id;
  perform set_config('portal.document_rehome', '', true);
  return old;
end $fn$;
revoke all on function public.application_rehome_student_documents() from public, anon, authenticated;
drop trigger if exists a_rehome_student_documents on public.enrollment_applications;
create trigger a_rehome_student_documents before delete on public.enrollment_applications
  for each row execute function public.application_rehome_student_documents();

-- The submitted record names the document versions it used.
create or replace function public.application_version_documents() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  new.snapshot := coalesce(new.snapshot, '{}'::jsonb) || jsonb_build_object('documentVersions', coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'category', d.category, 'filename', d.filename, 'path', d.storage_path,
      'sha256', coalesce(d.metadata->>'contentSha256', d.metadata #>> '{extraction,source,contentSha256}'), 'student', d.student_id is not null)
      order by d.category, d.created_at)
      from enrollment_application_documents d where d.id in (select public.application_document_ids(new.application_id)) and d.is_current), '[]'::jsonb));
  return new;
end $fn$;
revoke all on function public.application_version_documents() from public, anon, authenticated;
drop trigger if exists a_version_documents on public.enrollment_application_versions;
create trigger a_version_documents before insert on public.enrollment_application_versions
  for each row execute function public.application_version_documents();

-- No more copies (DOCUMENT-CARRY): documents are the student's.
drop trigger if exists application_document_carry_dispatch on public.enrollment_applications;
create or replace function public.application_document_carry_pending(p_application uuid) returns boolean
language sql stable security definer set search_path = public as $fn$ select false; $fn$;

-- Existing student documents get their student.
update public.enrollment_application_documents d set student_id = a.student_id
  from public.enrollment_applications a where a.id = d.application_id and public.student_document_category(d.category) and d.student_id is distinct from a.student_id;

-- current_upload_passport: student documents count as the application's
CREATE OR REPLACE FUNCTION public.current_upload_passport(p_bucket text, p_owner uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare reference jsonb;
begin
  if p_bucket = 'enrollment-documents' then
    select jsonb_build_object('id', d.id, 'storage_path', d.storage_path, 'mime_type', d.mime_type, 'filename', d.filename)
    into reference from public.enrollment_application_documents d
    where d.id in (select public.application_document_ids(p_owner)) and d.is_current and d.category = 'Passport' and d.bucket_name = p_bucket
    order by d.created_at desc, d.id desc limit 1;
  elsif p_bucket = 'staff-documents' then
    select jsonb_build_object('id', d.id, 'storage_path', d.storage_path, 'mime_type', d.mime_type, 'filename', d.filename)
    into reference from hr.staff_documents d
    where d.profile_id = p_owner and d.is_current and d.category = 'Passport' and d.bucket_name = p_bucket
    order by d.created_at desc, d.id desc limit 1;
  end if;
  return reference;
end;
$function$;

-- hr.require_validated_document_category: student documents count as the application's
CREATE OR REPLACE FUNCTION hr.require_validated_document_category()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare passport_id uuid; owner_id uuid; current_passport_id uuid;
begin
  if tg_op = 'UPDATE' then
    if (old.category, old.bucket_name, old.storage_path) is not distinct from (new.category, new.bucket_name, new.storage_path) then
      return new;
    end if;
  end if;
  if not hr.requires_document_category_check(new.category) then return new; end if;

  select r.passport_document_id into passport_id
  from storage.objects o join hr.document_category_receipts r on r.object_id = o.id
    and r.category = new.category and r.object_version is not distinct from o.version
  where o.bucket_id = new.bucket_name and o.name = new.storage_path;
  if not found then
    raise exception 'Upload the file in the correct document field so its contents can be checked.' using errcode = '23514';
  end if;
  if tg_table_schema = 'hr' then
    owner_id := new.profile_id;
  else
    owner_id := new.application_id;
    -- Student replacement briefly permits two current Passport rows. Serialize
    -- the insertion and compare against the reference seen by the classifier.
    perform 1 from public.enrollment_applications a where a.id = owner_id for no key update;
    current_passport_id := (public.current_upload_passport(new.bucket_name, owner_id)->>'id')::uuid;
    if passport_id is distinct from current_passport_id then
      raise exception 'The passport changed while the document was checked. Upload this document again.' using errcode = '23514';
    end if;
  end if;
  if new.category = 'Passport' then return new; end if;
  -- Lock the exact reference row so a concurrent deletion or retirement cannot
  -- invalidate the receipt before the supporting document is saved.
  if tg_table_schema = 'hr' then
    perform 1 from hr.staff_documents p where p.id = passport_id and p.profile_id = owner_id
      and p.category = 'Passport' and p.is_current for share;
  else
    perform 1 from public.enrollment_application_documents p where p.id = passport_id and p.id in (select public.application_document_ids(owner_id))
      and p.category = 'Passport' and p.is_current for share;
  end if;
  if not found then
    raise exception 'Upload your passport first, then upload this document again.' using errcode = '23514';
  end if;
  current_passport_id := (public.current_upload_passport(new.bucket_name, owner_id)->>'id')::uuid;
  if passport_id is distinct from current_passport_id then
    raise exception 'The passport changed while the document was checked. Upload this document again.' using errcode = '23514';
  end if;
  return new;
end;
$function$;

-- application_completion: student documents count as the application's
CREATE OR REPLACE FUNCTION public.application_completion(p_application uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare vals jsonb := coalesce(public.application_values(p_application), '{}'::jsonb); s jsonb; f jsonb; total integer := 0; done integer := 0;
 v jsonb; cat text;
begin
 for s in select value from jsonb_array_elements(public.portal_required_schema()) loop
  if not public.portal_condition_met(s->'showIf', vals) then continue; end if;
  for f in select value from jsonb_array_elements(s->'fields') loop
   if not public.portal_condition_met(f->'showIf', vals) or public.admissions_field_optional(f->>'name') then continue; end if;
   total := total + 1;
   v := vals -> (f->>'name');
   if f->>'type' = 'file' then
    cat := case f->>'name' when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa' when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
    if cat is not null and exists (select 1 from public.enrollment_application_documents d where d.id in (select public.application_document_ids(p_application)) and d.category = cat and d.is_current) then done := done + 1; end if;
   elsif f->>'type' = 'checkbox' then
    if f->>'name' = 'courses_of_interest' then
     if exists (select 1 from public.enrollment_application_courses c where c.application_id = p_application) then done := done + 1; end if;
    elsif jsonb_typeof(v) = 'array' and jsonb_array_length(v) > 0 then done := done + 1; end if;
   elsif nullif(btrim(coalesce(v #>> '{}', '')), '') is not null then done := done + 1;
   end if;
  end loop;
 end loop;
 if total = 0 then return 0; end if;
 return least(100, round(100.0 * done / total)::integer);
end $function$;

-- portal_validate_submission: student documents count as the application's
CREATE OR REPLACE FUNCTION public.portal_validate_submission(p_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; s jsonb; f jsonb; vals jsonb; field_value jsonb; v_category text; label text; v_problem text;
begin
 select * into a from public.enrollment_applications where id=p_application_id;
 vals:=public.application_values(a.id);
 for s in select value from jsonb_array_elements(public.portal_required_schema()) loop
  if not public.portal_condition_met(s->'showIf',vals) then continue; end if;
  for f in select value from jsonb_array_elements(s->'fields') loop
   if not public.portal_condition_met(f->'showIf',vals) or public.admissions_field_optional(f->>'name')
      or (f->>'name' = 'mobile' and not public.rule_bool('admissions.application_mobile_required', true)) then continue; end if;
   label:=f->>'name';field_value:=vals->label;
   if f->>'type'='file' then
    v_category:=case label when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa' when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
    if v_category is null or not exists(select 1 from public.enrollment_application_documents d join storage.objects o on o.bucket_id=d.bucket_name and o.name=d.storage_path
     where d.id in (select public.application_document_ids(a.id)) and d.category=v_category and d.is_current) then
     raise exception 'Required document missing: %',label using errcode='22023'; end if;
   elsif f->>'type'='checkbox' then
    if jsonb_typeof(field_value) is distinct from 'array' or jsonb_array_length(field_value)=0 then raise exception 'Required selection missing: %',label using errcode='22023'; end if;
    if label='courses_of_interest' then
     if not exists(select 1 from public.enrollment_application_courses where application_id=a.id) then raise exception 'Select an institution course' using errcode='22023'; end if;
    elsif f ? 'options' then
     if exists(select 1 from jsonb_array_elements_text(field_value) v where not (f->'options' ? v)) then raise exception 'Invalid selection: %',label using errcode='22023'; end if;
    end if;
   elsif nullif(btrim(field_value#>>'{}'),'') is null then raise exception 'Required field missing: %',label using errcode='22023';
   elsif f->>'type' in ('select','radio') and f ? 'options' and label<>'agent_agency' and not(f->'options' ? (field_value#>>'{}'))
         and not (f ? 'avetmissSet' and public.avetmiss_code(f->>'avetmissSet', field_value#>>'{}') is not null) then
    raise exception 'Invalid option: %',label using errcode='22023';
   elsif f->>'type'='date' then
    begin perform (field_value#>>'{}')::date; exception when others then raise exception 'Invalid date: %',label using errcode='22023'; end;
   elsif f->>'type'='email' and (field_value#>>'{}') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid email: %',label using errcode='22023';
   end if;
  end loop;
 end loop;
 if nullif(btrim(vals->>'mobile'), '') is not null
    and regexp_replace(vals->>'mobile', '[[:space:]().-]', '', 'g') !~ '^(04[0-9]{8}|\+61[1-9][0-9]{8}|\+(?!61)[1-9][0-9]{6,14})$' then
   raise exception 'Enter a valid phone number: mobile' using errcode='22023';
 end if;
 if vals->>'email' is distinct from vals->>'confirm_email' then raise exception 'Email confirmation does not match' using errcode='22023'; end if;
 if a.tenant_id is not null and exists(select 1 from public.enrollment_application_courses c left join public.cms_courses cc on cc.id=c.course_id and cc.tenant_id=a.tenant_id and (cc.status='Published' or not public.rule_bool('admissions.applications_require_published_course', true))
  where c.application_id=a.id and cc.id is null) then raise exception 'Course is no longer published' using errcode='22023'; end if;
 v_problem := public.avetmiss_application_problem(vals);
 if v_problem is not null then raise exception '%', v_problem using errcode='22023'; end if;
 v_problem := public.application_intake_problem(a.id);
 if v_problem is not null then raise exception '%', v_problem using errcode='22023'; end if;
end; $function$;

-- skyline_private.wizard_application_progress: student documents count as the application's
CREATE OR REPLACE FUNCTION skyline_private.wizard_application_progress(p_application uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  values_map jsonb := public.application_values(p_application);
  section jsonb;
  field jsonb;
  field_name text;
  field_value jsonb;
  category text;
  done int := 0;
  applicable int := 0;
  ready boolean := false;
begin
  for section in select value from jsonb_array_elements(public.portal_required_schema()) loop
    if not public.portal_condition_met(section->'showIf', values_map) then continue; end if;
    for field in select value from jsonb_array_elements(section->'fields') loop
      field_name := field->>'name';
      if not public.portal_condition_met(field->'showIf', values_map) or public.admissions_field_optional(field_name)
         or (field_name = 'mobile' and not public.rule_bool('admissions.application_mobile_required', true)) then continue; end if;
      applicable := applicable + 1;
      field_value := values_map->field_name;
      if field->>'type' = 'file' then
        category := case field_name when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa'
          when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
        if exists(select 1 from public.enrollment_application_documents d join storage.objects o
          on o.bucket_id = d.bucket_name and o.name = d.storage_path where d.id in (select public.application_document_ids(p_application))
          and d.category = category and d.is_current) then done := done + 1; end if;
      elsif field_name = 'courses_of_interest' then
        if exists(select 1 from public.enrollment_application_courses c where c.application_id = p_application) then done := done + 1; end if;
      elsif jsonb_typeof(field_value) = 'array' then
        if jsonb_array_length(field_value) > 0 then done := done + 1; end if;
      elsif nullif(btrim(field_value #>> '{}'), '') is not null then
        done := done + 1;
      end if;
    end loop;
  end loop;
  begin
    perform public.portal_validate_submission(p_application);
    ready := true;
  exception when sqlstate '22023' then
    ready := false;
  end;
  return jsonb_build_object('completion', case when applicable = 0 then 0 else least(99, round(100.0 * done / applicable)) end, 'ready', ready);
end;
$function$;

-- notification_delivery_submission: student documents count as the application's
CREATE OR REPLACE FUNCTION public.notification_delivery_submission(p_id uuid, p_lease uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.notification_deliveries; o public.admission_event_outbox; a public.enrollment_applications; v_mode text; v_version integer; v_snapshot jsonb; v_created timestamptz; v_host text; v_site jsonb; v_kind text;
begin
  select * into d from public.notification_deliveries x where x.id = p_id and x.lease_token = p_lease and x.state = 'sending' and x.event = 'application_submitted';
  if not found then return null; end if;
  select * into o from public.admission_event_outbox where id = d.outbox_id;
  select * into a from public.enrollment_applications where id = d.application_id;
  -- Who this copy is for: portal users have recipient_user; otherwise the address is the student's (case-insensitive, trimmed) or an internal one.
  v_kind := case when d.recipient_user is not null then 'portal'
    when nullif(lower(btrim(coalesce(a.student_email, ''))), '') is not null and lower(btrim(d.recipient_email)) = lower(btrim(a.student_email)) then 'student'
    else 'internal' end;
  v_mode := coalesce((select s.submission_pdf from public.notification_attachment_settings s where s.tenant_id is not distinct from d.tenant_id), 'attach');
  v_version := coalesce(case when (o.payload->>'version') ~ '^[0-9]{1,9}$' then (o.payload->>'version')::integer end,
    (select max(v.version) from public.enrollment_application_versions v where v.application_id = d.application_id));
  select v.snapshot, v.created_at into v_snapshot, v_created from public.enrollment_application_versions v where v.application_id = d.application_id and v.version = v_version;
  v_host := case when d.tenant_id is null then public.main_site_host()
    else (select min(t.hostname) from public.tenant_domains t where t.tenant_id = d.tenant_id and t.verified_at is not null) end;
  select to_jsonb(c) into v_site from public.cms_settings c where c.tenant_id is not distinct from d.tenant_id order by c.id limit 1;
  return jsonb_build_object(
    'mode', v_mode,
    -- By recipient: portal users open the agency portal, internal addresses (CMS staff) open the CMS, the student gets no link.
    'link', case when v_host is null or v_kind = 'student' then '' else 'https://' || v_host || case when v_kind = 'portal' then '/agency/applications/' else '/admin/applications/' end || d.application_id::text end,
    'recipientKind', v_kind,
    'host', v_host,
    'applicationId', d.application_id,
    'tenantId', d.tenant_id,
    'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
    'version', coalesce(v_version, 0),
    'institution', coalesce(nullif(v_site->>'name', ''), (select t.name from public.tenants t where t.id = d.tenant_id), 'Skyline Institute of Technology'),
    'submittedAt', v_created,
    'branding', jsonb_build_object('logo', coalesce(v_site->>'logo', ''), 'primaryColor', case when coalesce((v_site->>'theme_configured')::boolean, false) then v_site->>'primary_color' end, 'timezone', (select public.institution_tz())),
    'documents', case when v_mode = 'attach' then coalesce((select jsonb_agg(jsonb_build_object('category', x.category, 'filename', x.filename, 'bucket', case when v_kind = 'student' then '' else x.bucket_name end, 'path', case when v_kind = 'student' then '' else x.storage_path end) order by x.created_at)
      from public.enrollment_application_documents x where x.id in (select public.application_document_ids(d.application_id)) and x.is_current
        and (x.category <> 'Credit Evidence' or coalesce(v_snapshot->'values'->>'rpl', '') = 'Yes')), '[]'::jsonb) else '[]'::jsonb end,
    'snapshot', case when v_mode = 'attach' then v_snapshot else null end);
end;
$function$;

-- portal_save_document_review: student documents count as the application's
CREATE OR REPLACE FUNCTION public.portal_save_document_review(p_application_id uuid, p_values jsonb, p_provenance jsonb DEFAULT '{}'::jsonb, p_confirmed jsonb DEFAULT '[]'::jsonb, p_resolutions jsonb DEFAULT '[]'::jsonb, p_wizard jsonb DEFAULT '{}'::jsonb, p_student_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_data jsonb; v_values jsonb; v_wizard jsonb; v_provenance jsonb; v_field text; v_value text;
  v_resolution jsonb; v_document_id uuid; v_candidate text; v_state text;
begin
  if auth.uid() is null or not public.portal_can_access_application(p_application_id) then raise exception 'not authorised' using errcode = '42501'; end if;
  select data into v_data from public.enrollment_applications where id = p_application_id for update;
  if not found then raise exception 'application not found' using errcode = 'P0002'; end if;
  if not public.portal_can_edit_application(p_application_id) then raise exception 'not authorised' using errcode='42501'; end if;
  v_data := public.application_data(p_application_id);
  -- Validate every document parent before accepting any field changes.
  for v_resolution in select value from jsonb_array_elements(coalesce(p_resolutions,'[]'::jsonb)) loop
    v_document_id := nullif(v_resolution->>'documentId','')::uuid;
    if v_document_id is not null and not exists(select 1 from public.enrollment_application_documents
       where id=v_document_id and id in (select public.application_document_ids(p_application_id)) and is_current) then
      raise exception 'document does not belong to application' using errcode='42501';
    end if;
  end loop;
  v_values := coalesce(v_data->'values', '{}'::jsonb); v_wizard := coalesce(v_data->'wizard', '{}'::jsonb) || coalesce(p_wizard, '{}'::jsonb); v_provenance := coalesce(v_wizard->'provenance', '{}'::jsonb) || coalesce(p_provenance, '{}'::jsonb);
  for v_field, v_value in select key, value #>> '{}' from jsonb_each(coalesce(p_values, '{}'::jsonb)) loop v_values := jsonb_set(v_values, array[v_field], to_jsonb(coalesce(v_value, '')), true); end loop;
  v_wizard := jsonb_set(v_wizard, '{provenance}', v_provenance, true); v_wizard := jsonb_set(v_wizard, '{confirmed}', coalesce(p_confirmed, '[]'::jsonb), true); v_wizard := jsonb_set(v_wizard, '{updatedAt}', to_jsonb(now()), true);
  update public.enrollment_applications set data = jsonb_set(jsonb_set(v_data, '{values}', v_values, true), '{wizard}', v_wizard, true), student_name = coalesce(p_student_name, student_name), updated_at = now() where id = p_application_id;
  for v_resolution in select value from jsonb_array_elements(coalesce(p_resolutions, '[]'::jsonb)) loop
    v_field := nullif(v_resolution->>'field', ''); if v_field is null then continue; end if;
    v_document_id := nullif(v_resolution->>'documentId', '')::uuid; v_candidate := nullif(v_resolution->>'candidateValue', ''); v_state := case when v_resolution->>'state' in ('confirmed','corrected','rejected') then v_resolution->>'state' else 'corrected' end;
    insert into public.enrollment_document_field_reviews(application_id, document_id, field_identifier, candidate_value, existing_value, final_value, state, source, reviewed_by, reviewed_at)
    values (p_application_id, v_document_id, v_field, v_candidate, null, v_values->>v_field, v_state, jsonb_build_object('kind', coalesce(v_provenance->>v_field, 'Manual entry')), public.portal_profile_id(), now());
  end loop;
  return jsonb_build_object('ok', true, 'values', v_values, 'wizard', v_wizard);
end;
$function$;

-- portal_registration_add_evidence: student documents count as the application's
CREATE OR REPLACE FUNCTION public.portal_registration_add_evidence(p_registration uuid, p_kind text, p_description text, p_document uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.enrollment_registrations; a public.enrollment_applications; v_id uuid;
begin
  select * into r from public.enrollment_registrations where id = p_registration;
  if not found then raise exception 'Registration not found' using errcode = 'P0002'; end if;
  a := public.portal_registration_authority(r.application_id);
  select * into r from public.enrollment_registrations where id = p_registration for update;
  if r.state = 'cancelled' then raise exception 'A cancelled registration accepts no evidence' using errcode = '22023'; end if;
  if p_kind is null or p_kind not in ('external_confirmation', 'coe_document', 'correspondence', 'other') then raise exception 'Unknown evidence kind' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_description, '')), '') is null or length(trim(p_description)) > 500 then raise exception 'A description of 1-500 characters is required' using errcode = '22023'; end if;
  if p_document is not null and not exists (select 1 from public.enrollment_application_documents d where d.id = p_document and d.id in (select public.application_document_ids(a.id)) and d.is_current) then
    raise exception 'The document does not belong to this application' using errcode = '22023';
  end if;
  insert into public.enrollment_registration_evidence(registration_id, tenant_id, kind, description, document_id, recorded_by) values (r.id, r.tenant_id, p_kind, trim(p_description), p_document, auth.uid()) returning id into v_id;
  return v_id;
end;
$function$;

-- portal_draft_document_counts: student documents count as the application's
CREATE OR REPLACE FUNCTION public.portal_draft_document_counts(p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_object_agg(a.id::text, (select count(*) from public.enrollment_application_documents d where d.id in (select public.application_delete_document_ids(a.id))))
    from public.enrollment_applications a where a.id = any (p_ids[1:50]) and public.portal_can_access_application(a.id)), '{}'::jsonb);
end; $function$;

-- portal_draft_delete_info: student documents count as the application's
CREATE OR REPLACE FUNCTION public.portal_draft_delete_info(p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then raise exception 'Not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_object_agg(a.id::text, jsonb_build_object(
      'reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)),
      'documents', (select count(*) from public.enrollment_application_documents d where d.id in (select public.application_delete_document_ids(a.id))),
      'studentDocuments', (select count(*) from public.enrollment_application_documents d where d.application_id = a.id and d.guest_link_id is not null)))
    from public.enrollment_applications a where a.id = any (p_ids[1:50]) and public.portal_can_access_application(a.id)), '{}'::jsonb);
end; $function$;

-- portal_delete_draft_prepare: student documents count as the application's
CREATE OR REPLACE FUNCTION public.portal_delete_draft_prepare(p_application uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; v_docs jsonb;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if auth.uid() is null or not found or not public.portal_can_access_application(p_application) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if public.rule_text('admissions.application_delete_only_unsubmitted', 'Delete an unsubmitted draft only') = 'No deletion: keep every application' then
    raise exception 'Applications cannot be deleted: every application is kept as a record.' using errcode = '55000'; end if;
  if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then
    raise exception 'Only drafts can be deleted. Submitted applications are kept as records.' using errcode = '55000'; end if;
  if not public.portal_can_edit_application(p_application) then raise exception 'Not authorized' using errcode = '42501'; end if;
  update public.guest_document_links set revoked_at = now() where application_id = a.id and revoked_at is null;
  update public.enrollment_document_extraction_jobs set state = 'cancelled', lease_token = null, lease_expires_at = null, updated_at = now()
    where application_id = a.id and state in ('queued', 'processing');
  select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_name, 'path', storage_path, 'filename', filename)), '[]'::jsonb) into v_docs from public.enrollment_application_documents where id in (select public.application_delete_document_ids(a.id));
  return jsonb_build_object('reference', coalesce(nullif(a.reference, ''), left(a.id::text, 8)), 'documents', v_docs, 'count', jsonb_array_length(v_docs));
end; $function$;

-- portal_delete_draft_application: student documents count as the application's
CREATE OR REPLACE FUNCTION public.portal_delete_draft_application(p_application uuid, p_expected_documents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; v_count integer; v_ref text; v_name text; v_role text;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  if auth.uid() is null or not found or not public.portal_can_access_application(p_application) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if public.rule_text('admissions.application_delete_only_unsubmitted', 'Delete an unsubmitted draft only') = 'No deletion: keep every application' then
    raise exception 'Applications cannot be deleted: every application is kept as a record.' using errcode = '55000'; end if;
  if a.status <> 'draft' or exists (select 1 from public.admission_submission_receipts where application_id = a.id) then
    raise exception 'Only drafts can be deleted. Submitted applications are kept as records.' using errcode = '55000'; end if;
  if not public.portal_can_edit_application(p_application) then raise exception 'Not authorized' using errcode = '42501'; end if;
  select count(*) into v_count from public.enrollment_application_documents where id in (select public.application_delete_document_ids(a.id));
  if v_count is distinct from p_expected_documents then raise exception 'Documents changed while deleting; try again' using errcode = 'PT409'; end if;
  v_ref := coalesce(nullif(a.reference, ''), left(a.id::text, 8));
  -- Link emails (sent, pending or suppressed) and their provider records, then the outbox rows that point at the application.
  delete from public.guest_link_sends where application_id = a.id;
  delete from public.notification_provider_events where delivery_id in (select id from public.notification_deliveries where application_id = a.id);
  delete from public.notification_delivery_attempts where delivery_id in (select id from public.notification_deliveries where application_id = a.id);
  delete from public.notification_deliveries where application_id = a.id;
  delete from public.admission_event_outbox where application_id = a.id;
  -- Earlier audit entries about this application stay as history; only their link to the (now deleted) row is cut.
  update public.portal_audit_log set application_id = null where application_id = a.id;
  select coalesce(nullif(btrim(full_name), ''), 'User') into v_name from public.portal_profiles where auth_user_id = auth.uid();
  v_role := case when public.portal_is_slit_admin() then 'slit_admin' when public.portal_is_agency_admin() then 'agency_admin' else 'agent' end;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, application_id, detail, tenant_id)
  values (auth.uid(), coalesce(v_name, 'User'), v_role, 'draft_deleted', 'application', v_ref, a.agency_id, null, jsonb_build_object('reference', v_ref, 'documents', v_count), a.tenant_id);
  -- Documents, field reviews (suggestions), extraction jobs, guest links and consents, notifications, messages, requests, versions and history cascade.
  delete from public.enrollment_applications where id = a.id;
  return jsonb_build_object('reference', v_ref, 'documents', v_count);
end; $function$;

commit;
