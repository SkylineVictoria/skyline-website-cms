-- DOCUMENT-CARRY (owner 2026-11-26): a student's second application must not ask again for documents they already gave.
-- When an application of a student who has an earlier application is created (by the student or an agent), the student's personal
-- documents are copied into it: passport, visa, English evidence, qualifications (Academic) and Australian driving licence. Each copy
-- is a NEW storage object in the new application's folder and a NEW enrollment_application_documents row of the new application only
-- (applications never share a file or a row; deleting one never touches another).
-- * Latest valid version per category (Academic: every current file of the latest application that has any, duplicates by content
--   hash skipped); Rejected documents and expired ones (an expiry date read from the document or confirmed on it, before today; the
--   passport also by the application's passport_expiry answer) are not copied and stay required.
-- * Never copied: anything else (signed agreements, offer letters, receipts, Health Insurance / OSHC, Consent, course-specific files).
-- * A category the new application already has is not copied; a document already copied is never copied twice (idempotent).
-- * The copy carries metadata.carriedFrom { documentId, applicationId, reference, copiedAt } (the page shows "From your previous
--   application") and keeps the source's review state and extraction.
-- Mechanics: application_document_carry_plan(app) lists what to copy; the Edge Function validated-document-upload (action carry,
-- service role or a caller who may edit the application) copies each file, then application_document_carry_record(app, source, path)
-- records the receipt (hr.document_category_receipts, passport = the new application's current passport) and the row in one call.
-- Checked categories other than the passport are recorded only once the new application has a current passport (copied first).
-- Trigger application_document_carry_dispatch (after insert / update of student_id on enrollment_applications, drafts only) calls the
-- function through pg_net when the plan is not empty; the application page also asks once when it opens (fallback).
-- Down: drop trigger application_document_carry_dispatch and the four functions.
begin;

-- Categories that are the student's own (not tied to a course, an intake or this application).
create or replace function public.application_document_carry_category(p_category text) returns boolean
language sql immutable set search_path = '' as $fn$
  select p_category in ('Passport', 'Visa', 'English', 'English Test', 'English Certificate', 'PTE', 'Academic', 'Driving Licence');
$fn$;

-- The earliest expiry date a document states (read from it or confirmed), null when it states none.
create or replace function public.application_document_expiry(p_metadata jsonb) returns date
language plpgsql immutable set search_path = '' as $fn$
declare v date; k text; t text;
begin
  for k, t in
    select e.key, e.value #>> '{}' from jsonb_each(coalesce(p_metadata #> '{extraction,confirmed}', '{}'::jsonb)) e
    union all
    select e.key, e.value #>> '{}' from jsonb_each(coalesce(p_metadata #> '{extraction,extracted}', '{}'::jsonb)) e
  loop
    if k ~ '(expiry|expiration|expires|valid_until|_expiry_date)' and t ~ '^\d{4}-\d{2}-\d{2}' then
      begin
        if v is null or left(t, 10)::date < v then v := left(t, 10)::date; end if;
      exception when others then null; end;
    end if;
  end loop;
  return v;
end $fn$;

create or replace function public.application_document_carry_plan(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare a public.enrollment_applications; v jsonb;
begin
  select * into a from public.enrollment_applications where id = p_application;
  if not found or a.student_id is null or a.status <> 'draft' then return '[]'::jsonb; end if;
  with src as (
    select d.*, o.reference, o.created_at app_created,
           public.application_document_expiry(d.metadata) expiry,
           case when d.category = 'Passport' then nullif(o.data #>> '{values,passport_expiry}', '') end app_passport_expiry
      from public.enrollment_application_documents d
      join public.enrollment_applications o on o.id = d.application_id
     where o.student_id = a.student_id and o.id <> a.id
       and d.is_current and d.review_state <> 'Rejected'
       and public.application_document_carry_category(d.category)
       and d.bucket_name = 'enrollment-documents'
       and exists (select 1 from storage.objects so where so.bucket_id = d.bucket_name and so.name = d.storage_path)
  ), valid as (
    select * from src
     where (expiry is null or expiry >= current_date)
       and (app_passport_expiry is null or app_passport_expiry !~ '^\d{4}-\d{2}-\d{2}' or left(app_passport_expiry, 10)::date >= current_date)
  ), single as (  -- latest version of each one-file category
    select distinct on (category) * from valid where category <> 'Academic' order by category, created_at desc, id desc
  ), academic_app as (
    select application_id from valid where category = 'Academic' order by app_created desc, created_at desc limit 1
  ), academic as (
    select distinct on (coalesce(metadata #>> '{extraction,source,contentSha256}', metadata->>'contentSha256', id::text)) *
      from valid where category = 'Academic' and application_id = (select application_id from academic_app)
     order by coalesce(metadata #>> '{extraction,source,contentSha256}', metadata->>'contentSha256', id::text), created_at desc
  ), chosen as (
    select * from single union all select * from academic
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'documentId', c.id, 'category', c.category, 'bucket', c.bucket_name, 'path', c.storage_path, 'filename', c.filename,
           'mimeType', c.mime_type, 'fromApplicationId', c.application_id, 'fromReference', c.reference)
           order by (c.category <> 'Passport'), c.category, c.created_at), '[]'::jsonb)
    into v
    from chosen c
   where not exists (select 1 from public.enrollment_application_documents t where t.application_id = a.id
                      and t.metadata #>> '{carriedFrom,documentId}' = c.id::text)
     and not exists (select 1 from public.enrollment_application_documents t where t.application_id = a.id
                      and t.is_current and t.category = c.category and t.metadata -> 'carriedFrom' is null);
  return v;
end $fn$;
revoke all on function public.application_document_carry_plan(uuid) from public, anon, authenticated;
grant execute on function public.application_document_carry_plan(uuid) to service_role;

-- Record one copied file: the receipt for its new object and the new application's row. Returns the new row id, or null when the
-- copy cannot be recorded yet (a checked category before the new application has a passport) or was recorded before.
create or replace function public.application_document_carry_record(p_application uuid, p_source uuid, p_path text) returns uuid
language plpgsql security definer set search_path = public as $fn$
declare a public.enrollment_applications; s public.enrollment_application_documents; v_passport uuid; v_id uuid; v_ref text;
begin
  select * into a from public.enrollment_applications where id = p_application for no key update;
  if not found or a.student_id is null or a.status <> 'draft' then raise exception 'Application not open for documents' using errcode = '42501'; end if;
  select d.* into s from public.enrollment_application_documents d join public.enrollment_applications o on o.id = d.application_id
   where d.id = p_source and o.student_id = a.student_id and o.id <> a.id and d.is_current
     and public.application_document_carry_category(d.category);
  if not found then raise exception 'This document cannot be copied to the application' using errcode = '42501'; end if;
  if p_path is null or p_path not like p_application::text || '/validated-%'
     or not exists (select 1 from storage.objects o where o.bucket_id = s.bucket_name and o.name = p_path) then
    raise exception 'The copied file is missing' using errcode = '22023';
  end if;
  select d.id into v_id from public.enrollment_application_documents d
   where d.application_id = a.id and d.metadata #>> '{carriedFrom,documentId}' = s.id::text;
  if found then return null; end if;
  if hr.requires_document_category_check(s.category) then
    if s.category <> 'Passport' then
      v_passport := (public.current_upload_passport(s.bucket_name, a.id)->>'id')::uuid;
      if v_passport is null then return null; end if;
    end if;
    if not public.record_passport_matched_document(s.bucket_name, p_path, s.category, v_passport) then
      raise exception 'The copied file could not be verified' using errcode = '22023';
    end if;
  end if;
  select reference into v_ref from public.enrollment_applications where id = s.application_id;
  insert into public.enrollment_application_documents(application_id, category, bucket_name, storage_path, filename, mime_type, file_size,
         uploaded_by, review_state, is_current, metadata)
  values (a.id, s.category, s.bucket_name, p_path, s.filename, s.mime_type, s.file_size, s.uploaded_by, s.review_state, true,
          coalesce(s.metadata, '{}'::jsonb) || jsonb_build_object('carriedFrom', jsonb_build_object(
            'documentId', s.id, 'applicationId', s.application_id, 'reference', v_ref, 'copiedAt', now())))
  returning id into v_id;
  return v_id;
end $fn$;
revoke all on function public.application_document_carry_record(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.application_document_carry_record(uuid, uuid, text) to service_role;

-- A signed-in caller who may edit the application asks for the copy (the page's fallback): true when there is something to copy.
create or replace function public.application_document_carry_pending(p_application uuid) returns boolean
language plpgsql stable security definer set search_path = public as $fn$
begin
  if auth.uid() is null or not public.portal_can_edit_application(p_application) then return false; end if;
  return jsonb_array_length(public.application_document_carry_plan(p_application)) > 0;
end $fn$;
revoke all on function public.application_document_carry_pending(uuid) from public, anon;
grant execute on function public.application_document_carry_pending(uuid) to authenticated;

-- New application (or one given its student): ask the Edge Function to copy, after commit (pg_net).
create or replace function public.application_document_carry_dispatch() returns trigger
language plpgsql security definer set search_path = public, vault as $fn$
declare v_key text;
begin
  if new.student_id is null or new.status <> 'draft' then return null; end if;
  if tg_op = 'UPDATE' and new.student_id is not distinct from old.student_id then return null; end if;
  if jsonb_array_length(public.application_document_carry_plan(new.id)) = 0 then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'notification_service_role_key' limit 1;
  if nullif(v_key, '') is null then return null; end if;
  begin
    perform public.cron_http_post('application-document-carry',
      url := 'https://xcpydisstlvtvcsqnjob.supabase.co/functions/v1/validated-document-upload',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object('action', 'carry', 'applicationId', new.id),
      timeout_milliseconds := 30000);
  exception when others then null;  -- never block creating the application; the page asks again when it opens
  end;
  return null;
end $fn$;
revoke all on function public.application_document_carry_dispatch() from public, anon, authenticated;

drop trigger if exists application_document_carry_dispatch on public.enrollment_applications;
create trigger application_document_carry_dispatch
  after insert or update of student_id on public.enrollment_applications
  for each row execute function public.application_document_carry_dispatch();

commit;
