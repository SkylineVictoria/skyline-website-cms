begin;
-- Registered documents are immutable objects; replacement/deletion uses the
-- existing coordinated handler. Preserve cleanup of unregistered draft uploads.
create or replace function public.portal_can_mutate_unbound_object(p_bucket text,p_name text)
returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and p_bucket='enrollment-documents'
   and p_name !~ '(^|/)(\.|\.\.)(/|$)' and position(chr(92) in p_name)=0
   and public.portal_can_edit_application(public.portal_path_app_id(p_name))
   and not exists(select 1 from public.enrollment_application_documents d
     where d.bucket_name=p_bucket and d.storage_path=p_name);
$$;
revoke all on function public.portal_can_mutate_unbound_object(text,text) from public,anon;
grant execute on function public.portal_can_mutate_unbound_object(text,text) to authenticated,service_role;
drop policy if exists portal_docs_obj_insert on storage.objects;
create policy portal_docs_obj_insert on storage.objects for insert to authenticated
with check(public.portal_can_mutate_unbound_object(bucket_id,name));
drop policy if exists portal_docs_obj_update on storage.objects;
create policy portal_docs_obj_update on storage.objects for update to authenticated
using(public.portal_can_mutate_unbound_object(bucket_id,name))
with check(public.portal_can_mutate_unbound_object(bucket_id,name));
drop policy if exists portal_docs_obj_delete on storage.objects;
create policy portal_docs_obj_delete on storage.objects for delete to authenticated
using(public.portal_can_mutate_unbound_object(bucket_id,name));
commit;
