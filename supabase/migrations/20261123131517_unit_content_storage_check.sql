-- UNIT-CONTENT-STORAGE (owner, 2026-11-23): Add from documents was refused on every file with "new row violates row-level
-- security policy" although unit_learning_file_limit (which checks unit_content_can_edit) passed. The unit-content storage
-- insert policy also looked the unit up in cms_course_units with the uploader's own row-level security, which can hide the
-- unit (tenant boundary / course read rules) and refuse the upload. The unit is now checked by a security-definer helper,
-- so only unit_content_can_edit() (Admins and RTO Managers, 20261123121517) decides. Delete and read are unchanged.
-- Rollback: drop policy unit_content_files_insert on storage.objects; create policy unit_content_files_insert on storage.objects
--   for insert to authenticated with check (bucket_id = 'unit-content' and public.unit_content_can_edit()
--   and exists (select 1 from public.cms_course_units u where u.id = split_part(name, '/', 1)));
--   drop function public.unit_content_unit_exists(text);
begin;

create or replace function public.unit_content_unit_exists(p_unit_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cms_course_units u where u.id = p_unit_id);
$$;
revoke all on function public.unit_content_unit_exists(text) from public, anon;
grant execute on function public.unit_content_unit_exists(text) to authenticated;

drop policy if exists unit_content_files_insert on storage.objects;
create policy unit_content_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'unit-content' and public.unit_content_can_edit()
    and public.unit_content_unit_exists(split_part(name, '/', 1)));

commit;
