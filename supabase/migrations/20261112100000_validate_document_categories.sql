begin;

-- A receipt is issued only after the Edge Function validates and stores a file.
-- Binding it to the Storage object and its version prevents reuse for different bytes.
create table hr.document_category_receipts (
  object_id uuid not null,
  category text not null,
  object_version text,
  primary key (object_id, category)
);
alter table hr.document_category_receipts enable row level security;
revoke all on hr.document_category_receipts from public, anon, authenticated, service_role;

create function hr.requires_document_category_check(p_category text) returns boolean
language sql immutable set search_path = '' as $$
  select p_category in ('Passport', 'Academic', 'Driving Licence', 'Visa', 'English', 'English Test', 'English Certificate', 'PTE', 'Health Insurance');
$$;
revoke all on function hr.requires_document_category_check(text) from public, anon, authenticated, service_role;

create function public.record_validated_document_category(p_bucket text, p_path text, p_category text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_bucket is null or p_bucket not in ('enrollment-documents', 'staff-documents')
     or hr.requires_document_category_check(p_category) is distinct from true then
    return false;
  end if;
  insert into hr.document_category_receipts (object_id, category, object_version)
  select o.id, p_category, o.version from storage.objects o where o.bucket_id = p_bucket and o.name = p_path
  on conflict (object_id, category) do update set object_version = excluded.object_version;
  return found;
end;
$$;
revoke all on function public.record_validated_document_category(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.record_validated_document_category(text, text, text) to service_role;

create function hr.require_validated_document_category() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if (old.category, old.bucket_name, old.storage_path) is not distinct from (new.category, new.bucket_name, new.storage_path) then
      return new;
    end if;
  end if;
  if hr.requires_document_category_check(new.category) and not exists (
    select 1
    from storage.objects o
    join hr.document_category_receipts r on r.object_id = o.id
      and r.category = new.category and r.object_version is not distinct from o.version
    where o.bucket_id = new.bucket_name and o.name = new.storage_path
  ) then
    raise exception 'Upload the file in the correct document field so its contents can be checked.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function hr.require_validated_document_category() from public, anon, authenticated, service_role;

create trigger require_validated_enrollment_document_category
before insert or update of category, bucket_name, storage_path on public.enrollment_application_documents
for each row execute function hr.require_validated_document_category();

create trigger require_validated_staff_document_category
before insert or update of category, bucket_name, storage_path on hr.staff_documents
for each row execute function hr.require_validated_document_category();

-- Only the trusted uploader can write to its reserved filenames. Existing
-- Storage policies still govern access to downloads and removal.
create policy validated_document_server_insert on storage.objects as restrictive for insert to anon, authenticated
with check (bucket_id not in ('enrollment-documents', 'staff-documents') or name !~ '(^|/)validated-[^/]+$');

create policy validated_document_server_update on storage.objects as restrictive for update to anon, authenticated
using (bucket_id not in ('enrollment-documents', 'staff-documents') or name !~ '(^|/)validated-[^/]+$')
with check (bucket_id not in ('enrollment-documents', 'staff-documents') or name !~ '(^|/)validated-[^/]+$');

commit;
