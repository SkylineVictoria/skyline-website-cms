-- Fetched read-only from the hosted history (supabase_migrations.schema_migrations, project xcpydisstlvtvcsqnjob) on 2026-11-10;
-- applied hosted 2026-11-10 15:08:31Z by another session. Enables the guard staged by 20261110150244 and proves it with a canary.
set local lock_timeout = '5s';
do $identity$ begin
 -- The hosted original raised 'Unexpected database identity' unless pg_control_system() reported 7692130048193495360; dropped here so
 -- a fresh local replay (lab, restore drill) runs. This file is never pushed: its version is already in the hosted history.
 if to_regclass('hr.document_category_receipts') is null then raise exception 'Document category receipts are not staged'; end if;
end $identity$;
alter table public.enrollment_application_documents enable trigger require_validated_enrollment_document_category;
alter table hr.staff_documents enable trigger require_validated_staff_document_category;
do $canary$
declare
  probe uuid := gen_random_uuid();
  expected constant text := 'Upload the file in the correct document field so its contents can be checked.';
begin
  begin
    insert into public.enrollment_application_documents(application_id, category, bucket_name, storage_path, filename, mime_type, file_size)
    values (probe, 'Passport', 'enrollment-documents', probe::text || '/synthetic.pdf', 'synthetic.pdf', 'application/pdf', 10);
    raise exception 'Student passport guard did not reject an unvalidated document';
  exception when check_violation then
    if sqlerrm <> expected then raise; end if;
  end;
  begin
    insert into hr.staff_documents(application_id, profile_id, category, bucket_name, storage_path, filename, mime_type, file_size)
    values (probe, probe, 'Passport', 'staff-documents', probe::text || '/passport/synthetic.pdf', 'synthetic.pdf', 'application/pdf', 10);
    raise exception 'Staff passport guard did not reject an unvalidated document';
  exception when check_violation then
    if sqlerrm <> expected then raise; end if;
  end;
end $canary$;
