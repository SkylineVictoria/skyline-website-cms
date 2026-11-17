-- UNIT-CONTENT: learning content for each unit of a course (LMS > Courses > Units > a unit > Learning content).
-- An item is a text section, a web link, a video link or a file (PDF, Word, PowerPoint, Excel, image) in the private
-- unit-content bucket, ordered per unit, with "Show to students" for the student view that comes later. RTO Managers add, edit,
-- reorder and remove items; Admins and RTO Managers read them. Files are stored as unit-content/<unit id>/<random>-<name>.
-- Assessments for the unit use the existing asm_* tables (the same drawer lists and creates them). Additive.
-- Rollback (manual): drop the four storage policies, delete the bucket's objects and the bucket; drop table public.unit_contents;
-- drop function public.unit_content_can_read(), public.unit_content_can_edit().
begin;

create table public.unit_contents(
  id uuid primary key default gen_random_uuid(),
  unit_id text not null references public.cms_course_units(id) on delete cascade,
  kind text not null check (kind in ('text', 'link', 'video', 'file')),
  title text not null check (length(btrim(title)) between 1 and 200),
  body text not null default '' check (length(body) <= 20000),
  url text check (url is null or (url ~ '^https://' and length(url) <= 2000)),
  storage_path text check (storage_path is null or storage_path ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'),
  file_name text check (file_name is null or length(file_name) <= 200),
  mime_type text,
  size_bytes integer check (size_bytes is null or size_bytes between 1 and 26214400),
  sort integer not null default 0,
  visible_to_students boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  check (kind <> 'file' or storage_path is not null),
  check (kind not in ('link', 'video') or url is not null)
);
create index unit_contents_unit on public.unit_contents(unit_id, sort, created_at);

create function public.unit_content_can_read() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false);
$$;
create function public.unit_content_can_edit() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.cms_is_rto_manager(), false);
$$;

create function public.unit_contents_touch() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now(); new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then new.created_by := old.created_by; new.created_at := old.created_at; new.unit_id := old.unit_id; end if;
  return new;
end;
$$;
create trigger unit_contents_touch before insert or update on public.unit_contents for each row execute function public.unit_contents_touch();

alter table public.unit_contents enable row level security;
revoke all on public.unit_contents from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.unit_contents to authenticated;
grant select on public.unit_contents to service_role;
create policy unit_contents_read on public.unit_contents for select to authenticated using (public.unit_content_can_read());
create policy unit_contents_insert on public.unit_contents for insert to authenticated with check (public.unit_content_can_edit());
create policy unit_contents_update on public.unit_contents for update to authenticated using (public.unit_content_can_edit()) with check (public.unit_content_can_edit());
create policy unit_contents_delete on public.unit_contents for delete to authenticated using (public.unit_content_can_edit());

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('unit-content', 'unit-content', false, 26214400,
 array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

drop policy if exists unit_content_files_read on storage.objects;
create policy unit_content_files_read on storage.objects for select to authenticated
 using (bucket_id = 'unit-content' and public.unit_content_can_read());
drop policy if exists unit_content_files_insert on storage.objects;
create policy unit_content_files_insert on storage.objects for insert to authenticated
 with check (bucket_id = 'unit-content' and public.unit_content_can_edit()
   and exists (select 1 from public.cms_course_units u where u.id = split_part(name, '/', 1)));
drop policy if exists unit_content_files_delete on storage.objects;
create policy unit_content_files_delete on storage.objects for delete to authenticated
 using (bucket_id = 'unit-content' and public.unit_content_can_edit());

revoke all on function public.unit_content_can_read(), public.unit_content_can_edit(), public.unit_contents_touch() from public, anon;
grant execute on function public.unit_content_can_read(), public.unit_content_can_edit() to authenticated;

commit;
