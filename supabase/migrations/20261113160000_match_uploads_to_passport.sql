begin;

-- Store the reference document ID on the existing receipt, not the holder's name.
alter table hr.document_category_receipts add column passport_document_id uuid;

create function public.current_upload_passport(p_bucket text, p_owner uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare reference jsonb;
begin
  if p_bucket = 'enrollment-documents' then
    select jsonb_build_object('id', d.id, 'storage_path', d.storage_path, 'mime_type', d.mime_type, 'filename', d.filename)
    into reference from public.enrollment_application_documents d
    where d.application_id = p_owner and d.is_current and d.category = 'Passport' and d.bucket_name = p_bucket
    order by d.created_at desc, d.id desc limit 1;
  elsif p_bucket = 'staff-documents' then
    select jsonb_build_object('id', d.id, 'storage_path', d.storage_path, 'mime_type', d.mime_type, 'filename', d.filename)
    into reference from hr.staff_documents d
    where d.profile_id = p_owner and d.is_current and d.category = 'Passport' and d.bucket_name = p_bucket
    order by d.created_at desc, d.id desc limit 1;
  end if;
  return reference;
end;
$$;
revoke all on function public.current_upload_passport(text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.current_upload_passport(text, uuid) to service_role;

create function public.record_passport_matched_document(p_bucket text, p_path text, p_category text, p_passport_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_bucket is null or p_bucket not in ('enrollment-documents', 'staff-documents')
     or hr.requires_document_category_check(p_category) is distinct from true
     or (p_category <> 'Passport' and p_passport_id is null) then
    return false;
  end if;
  insert into hr.document_category_receipts (object_id, category, object_version, passport_document_id)
  select o.id, p_category, o.version, p_passport_id
  from storage.objects o where o.bucket_id = p_bucket and o.name = p_path
  on conflict (object_id, category) do update
  set object_version = excluded.object_version, passport_document_id = excluded.passport_document_id;
  return found;
end;
$$;
revoke all on function public.record_passport_matched_document(text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_passport_matched_document(text, text, text, uuid) to service_role;

create or replace function hr.require_validated_document_category() returns trigger
language plpgsql security definer set search_path = '' as $$
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
    perform 1 from public.enrollment_application_documents p where p.id = passport_id and p.application_id = owner_id
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
$$;

commit;
