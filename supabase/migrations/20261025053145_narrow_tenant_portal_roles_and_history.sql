-- CMS editing does not confer access to student records or portal history.
do $$ declare p record; begin
 for p in select tablename from pg_policies where schemaname='public' and policyname='tenant_member_read'
 and (tablename like 'enrollment_%' or tablename in ('portal_notifications','portal_audit_log')) loop
  execute format('alter policy tenant_member_read on public.%I using(tenant_id is not null and public.tenant_has_role(tenant_id,array[''tenant_admin'',''staff'']))',p.tablename);
 end loop;
end; $$;
create policy tenant_message_author on public.enrollment_application_messages as restrictive for insert to authenticated
with check(tenant_id is null or author=auth.uid());
drop policy tenant_member_update on public.enrollment_application_messages;
drop policy tenant_member_delete on public.enrollment_application_messages;
create policy tenant_message_append_only_update on public.enrollment_application_messages as restrictive for update to authenticated
using(tenant_id is null) with check(tenant_id is null);
create policy tenant_message_append_only_delete on public.enrollment_application_messages as restrictive for delete to authenticated
using(tenant_id is null);
