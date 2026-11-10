-- Document category validation: receipts, the guard triggers and the Storage policies for the uploader's reserved filenames.
--
-- Released to hosted on 2026-11-10 by another session as two history entries, 20261110150244_stage_document_category_validation
-- (objects, triggers disabled) and 20261110150831_activate_document_category_validation (triggers enabled, canary), both fetched
-- read-only into this folder. This version therefore creates nothing: it only proves the guard is in place, so a local replay
-- (lab, fresh stack) and the hosted history (marked applied on 2026-11-10, never pushed) agree.
begin;
do $$
begin
  if to_regclass('hr.document_category_receipts') is null
     or to_regprocedure('public.record_validated_document_category(text, text, text)') is null
     or not exists (select 1 from pg_trigger where tgname = 'require_validated_enrollment_document_category' and tgenabled <> 'D')
     or not exists (select 1 from pg_trigger where tgname = 'require_validated_staff_document_category' and tgenabled <> 'D')
     or not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'validated_document_server_insert') then
    raise exception 'Document category validation is not in place: apply 20261110150244 and 20261110150831 first.';
  end if;
end $$;
commit;
