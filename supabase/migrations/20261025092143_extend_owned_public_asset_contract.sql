-- Extend, never replace, the retained legacy CMS file identity contract.
alter table public.cms_documents drop constraint cms_documents_bucket_name_check;
alter table public.cms_documents add constraint cms_documents_bucket_name_check check(
 bucket_name is null or bucket_name='cms-media' or
 (bucket_name='tenant-public-media' and tenant_id is not null and storage_path like tenant_id::text||'/%'));
alter table public.cms_course_attachments drop constraint cms_course_attachments_bucket_name_check;
alter table public.cms_course_attachments add constraint cms_course_attachments_bucket_name_check check(
 bucket_name is null or bucket_name='cms-media' or
 (bucket_name='tenant-public-media' and tenant_id is not null and storage_path like tenant_id::text||'/%'));
