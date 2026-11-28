-- AXCELERATE-DOCUMENTS (owner 2026-11-28: "you didn't grab the documents of the student, can you grab them also"). Each student's aXcelerate
-- portfolio files (passport, visa, English test, certificates ...) are read with the student's Refresh (GET /contact/portfolio and
-- /contact/portfolio/file, both on the read-only list) and kept as they are in Skyline:
--   * public.student_external_documents: one row per file (aXcelerate's portfolio type and name, file name, type, size), staff read only.
--   * private bucket axcelerate-documents: the files, at <student id>/<portfolio id>-<file id>-<file name>; CMS staff may read them.
-- They are kept apart from the application documents on purpose: those categories (Passport, Visa, English ...) only take a file whose
-- contents were checked (live Azure), and an imported student may have no application. The import never writes to aXcelerate.
-- axcelerate_document_status(key) says whether a file is new, already imported or deleted in Skyline (not brought back);
-- axcelerate_import_document saves the row and its link (entity 'document').
begin;

insert into storage.buckets (id, name, public, file_size_limit)
values ('axcelerate-documents', 'axcelerate-documents', false, 26214400)
on conflict (id) do nothing;

create table if not exists public.student_external_documents (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.enrollment_students(id) on delete cascade,
  -- rule-policy: technical axcelerate-documents 2026-11-28 owner (AXCELERATE-DOCUMENTS): imported document types, size limit and access; fixed, no configurable value.
  source text not null default 'axcelerate' check (source in ('axcelerate')),
  document_type text,
  title text,
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null,
  file_size bigint not null check (file_size > 0),
  -- rule-policy: technical axcelerate-documents 2026-11-28 owner (AXCELERATE-DOCUMENTS): imported document types, size limit and access; fixed, no configurable value.
  bucket_name text not null default 'axcelerate-documents' check (bucket_name = 'axcelerate-documents'),
  storage_path text not null unique,
  source_key text not null unique,
  added_in_source date,
  imported_at timestamptz not null default now()
);
create index if not exists student_external_documents_student on public.student_external_documents(student_id);
alter table public.student_external_documents enable row level security;
drop policy if exists student_external_documents_staff_read on public.student_external_documents;
create policy student_external_documents_staff_read on public.student_external_documents for select to authenticated using (public.cms_is_staff());
revoke all on public.student_external_documents from anon;
grant select on public.student_external_documents to authenticated;

drop policy if exists axcelerate_documents_staff_read on storage.objects;
create policy axcelerate_documents_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'axcelerate-documents' and public.cms_is_staff());

alter table public.axcelerate_links drop constraint if exists axcelerate_links_entity_check;
alter table public.axcelerate_links add constraint axcelerate_links_entity_check check (entity = any (array['location', 'course', 'unit', 'trainer',
  'class', 'class_unit', 'break', 'student', 'agent', 'agency', 'qualification', 'master', 'unit_result', 'batch', 'invoice', 'course_fee',
  'attendance', 'room', 'class_day', 'document']));

create or replace function public.axcelerate_document_status(p_connection uuid, p_key text)
returns text language plpgsql stable security definer set search_path = public as $$
declare l public.axcelerate_links;
begin
  if public.axcelerate_is_skipped(p_connection, 'document', p_key) then return 'skipped'; end if;
  l := public.axcelerate_link_find(p_connection, 'document', p_key);
  if l.id is not null and exists (select 1 from public.student_external_documents d where d.id::text = l.target_id) then return 'have'; end if;
  return 'new';
end $$;

create or replace function public.axcelerate_import_document(p_connection uuid, p_run uuid, p_actor uuid, p_student uuid, p_key text, p_rec jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_path text := p_rec->>'path';
begin
  perform public.axcelerate_importing(p_actor);
  -- rule-policy: technical axcelerate-documents 2026-11-28 owner (AXCELERATE-DOCUMENTS): imported document types, size limit and access; fixed, no configurable value.
  if not exists (select 1 from public.enrollment_students where id = p_student) then raise exception 'Student not found' using errcode = 'P0002'; end if;
  if v_path is null or split_part(v_path, '/', 1) <> p_student::text then raise exception 'The document path does not belong to the student' using errcode = '22023'; end if;
  insert into public.student_external_documents(student_id, document_type, title, file_name, mime_type, file_size, storage_path, source_key, added_in_source)
  values (p_student, left(nullif(btrim(p_rec->>'type'), ''), 120), left(nullif(btrim(p_rec->>'title'), ''), 200), left(p_rec->>'fileName', 255),
          left(p_rec->>'mime', 120), (p_rec->>'size')::bigint, v_path, p_key, public.axcelerate_date(p_rec->>'added'))
  on conflict (source_key) do update set document_type = excluded.document_type, title = excluded.title, file_name = excluded.file_name,
    mime_type = excluded.mime_type, file_size = excluded.file_size, storage_path = excluded.storage_path, imported_at = now()
  returning id into v_id;
  perform public.axcelerate_link_save(p_connection, p_run, 'document', p_key, 'public.student_external_documents', v_id::text, p_rec - 'path');
  return jsonb_build_object('action', 'created', 'id', v_id);
end $$;

revoke all on function public.axcelerate_document_status(uuid, text) from public, anon, authenticated;
revoke all on function public.axcelerate_import_document(uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.axcelerate_document_status(uuid, text) to service_role;
grant execute on function public.axcelerate_import_document(uuid, uuid, uuid, uuid, text, jsonb) to service_role;

commit;
