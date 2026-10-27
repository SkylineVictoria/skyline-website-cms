-- P02-08. Additive nullable ownership: installation assigns no legacy rows.
-- Explicit tenant context is a selector, never authorization. Existing policies
-- are intersected with restrictive boundaries; scoped roles get narrow grants.
alter table public.cms_course_units add column tenant_id uuid references public.tenants(id);
create index cms_course_units_tenant_idx on public.cms_course_units(tenant_id);
alter table public.cms_course_attachments add column tenant_id uuid references public.tenants(id);
create index cms_course_attachments_tenant_idx on public.cms_course_attachments(tenant_id);
alter table public.enrollment_document_extraction_attempts add column tenant_id uuid references public.tenants(id);
create index enrollment_document_extraction_attempts_tenant_idx on public.enrollment_document_extraction_attempts(tenant_id);
alter table public.enrollment_applications add column tenant_id uuid references public.tenants(id);
create index enrollment_applications_tenant_idx on public.enrollment_applications(tenant_id);
alter table public.enrollment_application_courses add column tenant_id uuid references public.tenants(id);
create index enrollment_application_courses_tenant_idx on public.enrollment_application_courses(tenant_id);
alter table public.enrollment_application_documents add column tenant_id uuid references public.tenants(id);
create index enrollment_application_documents_tenant_idx on public.enrollment_application_documents(tenant_id);
alter table public.enrollment_application_status_history add column tenant_id uuid references public.tenants(id);
create index enrollment_application_status_history_tenant_idx on public.enrollment_application_status_history(tenant_id);
alter table public.enrollment_application_messages add column tenant_id uuid references public.tenants(id);
create index enrollment_application_messages_tenant_idx on public.enrollment_application_messages(tenant_id);
alter table public.enrollment_application_requests add column tenant_id uuid references public.tenants(id);
create index enrollment_application_requests_tenant_idx on public.enrollment_application_requests(tenant_id);
alter table public.enrollment_application_consents add column tenant_id uuid references public.tenants(id);
create index enrollment_application_consents_tenant_idx on public.enrollment_application_consents(tenant_id);
alter table public.enrollment_application_versions add column tenant_id uuid references public.tenants(id);
create index enrollment_application_versions_tenant_idx on public.enrollment_application_versions(tenant_id);
alter table public.portal_notifications add column tenant_id uuid references public.tenants(id);
create index portal_notifications_tenant_idx on public.portal_notifications(tenant_id);
alter table public.portal_audit_log add column tenant_id uuid references public.tenants(id);
create index portal_audit_log_tenant_idx on public.portal_audit_log(tenant_id);
alter table public.enrollment_document_deletion_recovery add column tenant_id uuid references public.tenants(id);
create index enrollment_document_deletion_recovery_tenant_idx on public.enrollment_document_deletion_recovery(tenant_id);
alter table public.enrollment_document_field_reviews add column tenant_id uuid references public.tenants(id);
create index enrollment_document_field_reviews_tenant_idx on public.enrollment_document_field_reviews(tenant_id);
alter table public.cms_social_links add column tenant_id uuid references public.tenants(id);
create index cms_social_links_tenant_idx on public.cms_social_links(tenant_id);
alter table public.cms_settings add column tenant_id uuid references public.tenants(id);
create index cms_settings_tenant_idx on public.cms_settings(tenant_id);
alter table public.cms_course_links add column tenant_id uuid references public.tenants(id);
create index cms_course_links_tenant_idx on public.cms_course_links(tenant_id);
alter table public.cms_forms add column tenant_id uuid references public.tenants(id);
create index cms_forms_tenant_idx on public.cms_forms(tenant_id);
alter table public.cms_form_fields add column tenant_id uuid references public.tenants(id);
create index cms_form_fields_tenant_idx on public.cms_form_fields(tenant_id);
alter table public.cms_courses add column tenant_id uuid references public.tenants(id);
create index cms_courses_tenant_idx on public.cms_courses(tenant_id);
alter table public.cms_course_sections add column tenant_id uuid references public.tenants(id);
create index cms_course_sections_tenant_idx on public.cms_course_sections(tenant_id);
alter table public.cms_navigation_items add column tenant_id uuid references public.tenants(id);
create index cms_navigation_items_tenant_idx on public.cms_navigation_items(tenant_id);
alter table public.cms_footer add column tenant_id uuid references public.tenants(id);
create index cms_footer_tenant_idx on public.cms_footer(tenant_id);
alter table public.cms_seo add column tenant_id uuid references public.tenants(id);
create index cms_seo_tenant_idx on public.cms_seo(tenant_id);
alter table public.cms_revisions add column tenant_id uuid references public.tenants(id);
create index cms_revisions_tenant_idx on public.cms_revisions(tenant_id);
alter table public.cms_activity_log add column tenant_id uuid references public.tenants(id);
create index cms_activity_log_tenant_idx on public.cms_activity_log(tenant_id);
alter table public.enrollment_document_extraction_jobs add column tenant_id uuid references public.tenants(id);
create index enrollment_document_extraction_jobs_tenant_idx on public.enrollment_document_extraction_jobs(tenant_id);
alter table public.public_assistant_usage_events add column tenant_id uuid references public.tenants(id);
create index public_assistant_usage_events_tenant_idx on public.public_assistant_usage_events(tenant_id);
alter table public.public_assistant_answer_cache add column tenant_id uuid references public.tenants(id);
create index public_assistant_answer_cache_tenant_idx on public.public_assistant_answer_cache(tenant_id);
alter table public.public_assistant_rate_limits add column tenant_id uuid references public.tenants(id);
create index public_assistant_rate_limits_tenant_idx on public.public_assistant_rate_limits(tenant_id);
alter table public.public_assistant_generation_slots add column tenant_id uuid references public.tenants(id);
create index public_assistant_generation_slots_tenant_idx on public.public_assistant_generation_slots(tenant_id);
alter table public.public_assistant_generation_budgets add column tenant_id uuid references public.tenants(id);
create index public_assistant_generation_budgets_tenant_idx on public.public_assistant_generation_budgets(tenant_id);
alter table public.cms_pages add column tenant_id uuid references public.tenants(id);
create index cms_pages_tenant_idx on public.cms_pages(tenant_id);
alter table public.cms_documents add column tenant_id uuid references public.tenants(id);
create index cms_documents_tenant_idx on public.cms_documents(tenant_id);
alter table public.public_assistant_faqs add column tenant_id uuid references public.tenants(id);
create index public_assistant_faqs_tenant_idx on public.public_assistant_faqs(tenant_id);
alter table public.public_assistant_sources add column tenant_id uuid references public.tenants(id);
create index public_assistant_sources_tenant_idx on public.public_assistant_sources(tenant_id);
alter table public.public_assistant_chunks add column tenant_id uuid references public.tenants(id);
create index public_assistant_chunks_tenant_idx on public.public_assistant_chunks(tenant_id);
alter table public.public_assistant_index_jobs add column tenant_id uuid references public.tenants(id);
create index public_assistant_index_jobs_tenant_idx on public.public_assistant_index_jobs(tenant_id);
alter table public.public_assistant_generation_requests add column tenant_id uuid references public.tenants(id);
create index public_assistant_generation_requests_tenant_idx on public.public_assistant_generation_requests(tenant_id);
alter table public.public_assistant_document_corrections add column tenant_id uuid references public.tenants(id);
create index public_assistant_document_corrections_tenant_idx on public.public_assistant_document_corrections(tenant_id);
alter table public.public_assistant_document_text add column tenant_id uuid references public.tenants(id);
create index public_assistant_document_text_tenant_idx on public.public_assistant_document_text(tenant_id);
alter table public.public_assistant_document_pages add column tenant_id uuid references public.tenants(id);
create index public_assistant_document_pages_tenant_idx on public.public_assistant_document_pages(tenant_id);

create function public.tenant_scope(p_tenant uuid) returns boolean language sql stable security definer set search_path=public as $$
 select case when p_tenant is null then public.tenant_request_domain() is null else p_tenant=public.tenant_current() and exists(select 1 from public.tenants where id=p_tenant and status='active') end;
$$;
create function public.tenant_scope_write(p_tenant uuid) returns boolean language sql stable security definer set search_path=public as $$
 select public.tenant_scope(p_tenant) and (p_tenant is null or public.tenant_has_role(p_tenant,array['tenant_admin','editor']));
$$;
create function public.tenant_bind_row() returns trigger language plpgsql security definer set search_path=public as $$
declare parent_tenant uuid; parent_key text; parent_table text; parent_exists boolean:=false; supplied uuid:=new.tenant_id;
begin
 if tg_op='UPDATE' and new.tenant_id is distinct from old.tenant_id and not (current_setting('skyline.ownership_assignment',true)='true' and public.tenant_is_platform_admin()) then raise exception 'Tenant ownership is immutable' using errcode='42501'; end if;
 if tg_nargs=2 then parent_table:=tg_argv[0];parent_key:=to_jsonb(new)->>tg_argv[1];
 elsif tg_table_name in ('public_assistant_sources','public_assistant_index_jobs') then
  parent_table:=case new.source_type when 'page' then 'cms_pages' when 'course' then 'cms_courses' when 'document' then 'cms_documents' else null end;parent_key:=new.source_key;
 end if;
 if parent_table is not null and parent_key is not null then
  execute format('select tenant_id,true from public.%I where id::text=$1',parent_table) into parent_tenant,parent_exists using parent_key;
  if not coalesce(parent_exists,false) then
   if tg_op='UPDATE' and tg_table_name='public_assistant_sources' and to_jsonb(new)->>'publication_status'='unpublished' then return new; end if;
   raise exception 'Parent ownership missing' using errcode='23503';
  end if;
  if supplied is not null and supplied is distinct from parent_tenant then raise exception 'Cross-tenant parent' using errcode='23503'; end if;
  new.tenant_id:=parent_tenant;
 elsif tg_op='INSERT' and new.tenant_id is null and public.tenant_request_domain() is not null then
  new.tenant_id:=public.tenant_current();if new.tenant_id is null then raise exception 'Unknown tenant domain' using errcode='42501'; end if;
 end if;
 if new.tenant_id is not null and not exists(select 1 from public.tenants where id=new.tenant_id and status='active') then raise exception 'Inactive tenant' using errcode='42501'; end if;
 if tg_table_name='enrollment_applications' and new.tenant_id is not null then
  if not exists(select 1 from public.agency_tenants a join public.agencies g on g.id=a.agency_id where a.tenant_id=new.tenant_id and a.agency_id=new.agency_id and a.active and g.status='Active') then raise exception 'Agency is not authorized for tenant' using errcode='23503'; end if;
 end if;
 return new;
end; $$;
revoke all on function public.tenant_bind_row() from public,anon,authenticated,service_role;
revoke all on function public.tenant_scope(uuid),public.tenant_scope_write(uuid) from public;
grant execute on function public.tenant_scope(uuid),public.tenant_scope_write(uuid) to anon,authenticated,service_role;
create trigger tenant_bind before insert or update on public.cms_course_units for each row execute function public.tenant_bind_row('cms_courses','course_id');
create policy tenant_boundary_read on public.cms_course_units as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_course_units as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_course_units as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_course_units as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_course_units for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_course_units for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_course_units for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_course_units for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_course_attachments for each row execute function public.tenant_bind_row('cms_courses','course_id');
create policy tenant_boundary_read on public.cms_course_attachments as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_course_attachments as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_course_attachments as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_course_attachments as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_course_attachments for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_course_attachments for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_course_attachments for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_course_attachments for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.enrollment_document_extraction_attempts for each row execute function public.tenant_bind_row('enrollment_document_extraction_jobs','job_id');
create policy tenant_boundary_read on public.enrollment_document_extraction_attempts as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_document_extraction_attempts as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.enrollment_document_extraction_attempts as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.enrollment_document_extraction_attempts as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.enrollment_document_extraction_attempts for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.enrollment_applications for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.enrollment_applications as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_applications as restrictive for insert to authenticated  with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_update on public.enrollment_applications as restrictive for update to authenticated using(public.tenant_scope(tenant_id)) with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_delete on public.enrollment_applications as restrictive for delete to authenticated using(public.tenant_scope(tenant_id)) ;
create policy tenant_member_read on public.enrollment_applications for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.enrollment_applications for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_update on public.enrollment_applications for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_delete on public.enrollment_applications for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) ;
create trigger tenant_bind before insert or update on public.enrollment_application_courses for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_application_courses as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_application_courses as restrictive for insert to authenticated  with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_update on public.enrollment_application_courses as restrictive for update to authenticated using(public.tenant_scope(tenant_id)) with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_delete on public.enrollment_application_courses as restrictive for delete to authenticated using(public.tenant_scope(tenant_id)) ;
create policy tenant_member_read on public.enrollment_application_courses for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.enrollment_application_courses for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_update on public.enrollment_application_courses for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_delete on public.enrollment_application_courses for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) ;
create trigger tenant_bind before insert or update on public.enrollment_application_documents for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_application_documents as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_application_documents as restrictive for insert to authenticated  with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_update on public.enrollment_application_documents as restrictive for update to authenticated using(public.tenant_scope(tenant_id)) with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_delete on public.enrollment_application_documents as restrictive for delete to authenticated using(public.tenant_scope(tenant_id)) ;
create policy tenant_member_read on public.enrollment_application_documents for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.enrollment_application_documents for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_update on public.enrollment_application_documents for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_delete on public.enrollment_application_documents for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) ;
create trigger tenant_bind before insert or update on public.enrollment_application_status_history for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_application_status_history as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_application_status_history as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.enrollment_application_status_history as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.enrollment_application_status_history as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.enrollment_application_status_history for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.enrollment_application_messages for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_application_messages as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_application_messages as restrictive for insert to authenticated  with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_update on public.enrollment_application_messages as restrictive for update to authenticated using(public.tenant_scope(tenant_id)) with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_delete on public.enrollment_application_messages as restrictive for delete to authenticated using(public.tenant_scope(tenant_id)) ;
create policy tenant_member_read on public.enrollment_application_messages for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.enrollment_application_messages for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_update on public.enrollment_application_messages for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_delete on public.enrollment_application_messages for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) ;
create trigger tenant_bind before insert or update on public.enrollment_application_requests for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_application_requests as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_application_requests as restrictive for insert to authenticated  with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_update on public.enrollment_application_requests as restrictive for update to authenticated using(public.tenant_scope(tenant_id)) with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_delete on public.enrollment_application_requests as restrictive for delete to authenticated using(public.tenant_scope(tenant_id)) ;
create policy tenant_member_read on public.enrollment_application_requests for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.enrollment_application_requests for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_update on public.enrollment_application_requests for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_delete on public.enrollment_application_requests for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) ;
create trigger tenant_bind before insert or update on public.enrollment_application_consents for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_application_consents as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_application_consents as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.enrollment_application_consents as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.enrollment_application_consents as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.enrollment_application_consents for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.enrollment_application_versions for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_application_versions as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_application_versions as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.enrollment_application_versions as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.enrollment_application_versions as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.enrollment_application_versions for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.portal_notifications for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.portal_notifications as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.portal_notifications as restrictive for insert to authenticated  with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_update on public.portal_notifications as restrictive for update to authenticated using(public.tenant_scope(tenant_id)) with check(public.tenant_scope(tenant_id));
create policy tenant_boundary_delete on public.portal_notifications as restrictive for delete to authenticated using(public.tenant_scope(tenant_id)) ;
create policy tenant_member_read on public.portal_notifications for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.portal_notifications for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_update on public.portal_notifications for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff']));
create policy tenant_member_delete on public.portal_notifications for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','staff'])) ;
create trigger tenant_bind before insert or update on public.portal_audit_log for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.portal_audit_log as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.portal_audit_log as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.portal_audit_log as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.portal_audit_log as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.portal_audit_log for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.enrollment_document_deletion_recovery for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_document_deletion_recovery as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_document_deletion_recovery as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.enrollment_document_deletion_recovery as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.enrollment_document_deletion_recovery as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.enrollment_document_deletion_recovery for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.enrollment_document_field_reviews for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_document_field_reviews as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_document_field_reviews as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.enrollment_document_field_reviews as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.enrollment_document_field_reviews as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.enrollment_document_field_reviews for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.cms_social_links for each row execute function public.tenant_bind_row('cms_settings','settings_id');
create policy tenant_boundary_read on public.cms_social_links as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_social_links as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_social_links as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_social_links as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_social_links for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_social_links for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_social_links for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_social_links for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_settings for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.cms_settings as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_settings as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_settings as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_settings as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_settings for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_settings for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_settings for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_settings for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_course_links for each row execute function public.tenant_bind_row('cms_courses','course_id');
create policy tenant_boundary_read on public.cms_course_links as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_course_links as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_course_links as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_course_links as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_course_links for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_course_links for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_course_links for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_course_links for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_forms for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.cms_forms as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_forms as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_forms as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_forms as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_forms for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_forms for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_forms for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_forms for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_form_fields for each row execute function public.tenant_bind_row('cms_forms','form_id');
create policy tenant_boundary_read on public.cms_form_fields as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_form_fields as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_form_fields as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_form_fields as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_form_fields for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_form_fields for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_form_fields for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_form_fields for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_courses for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.cms_courses as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_courses as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_courses as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_courses as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_courses for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_courses for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_courses for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_courses for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_course_sections for each row execute function public.tenant_bind_row('cms_courses','course_id');
create policy tenant_boundary_read on public.cms_course_sections as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_course_sections as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_course_sections as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_course_sections as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_course_sections for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_course_sections for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_course_sections for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_course_sections for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_navigation_items for each row execute function public.tenant_bind_row('cms_navigation_items','parent_id');
create policy tenant_boundary_read on public.cms_navigation_items as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_navigation_items as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_navigation_items as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_navigation_items as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_navigation_items for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_navigation_items for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_navigation_items for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_navigation_items for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_footer for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.cms_footer as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_footer as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_footer as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_footer as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_footer for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_footer for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_footer for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_footer for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_seo for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.cms_seo as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_seo as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_seo as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_seo as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_seo for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_seo for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_seo for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_seo for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_revisions for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.cms_revisions as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_revisions as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.cms_revisions as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.cms_revisions as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.cms_revisions for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.cms_activity_log for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.cms_activity_log as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_activity_log as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.cms_activity_log as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.cms_activity_log as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.cms_activity_log for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.enrollment_document_extraction_jobs for each row execute function public.tenant_bind_row('enrollment_applications','application_id');
create policy tenant_boundary_read on public.enrollment_document_extraction_jobs as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.enrollment_document_extraction_jobs as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.enrollment_document_extraction_jobs as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.enrollment_document_extraction_jobs as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create policy tenant_member_read on public.enrollment_document_extraction_jobs for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create trigger tenant_bind before insert or update on public.public_assistant_usage_events for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.public_assistant_usage_events as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_usage_events as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_usage_events as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_usage_events as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_answer_cache for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.public_assistant_answer_cache as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_answer_cache as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_answer_cache as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_answer_cache as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_rate_limits for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.public_assistant_rate_limits as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_rate_limits as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_rate_limits as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_rate_limits as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_generation_slots for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.public_assistant_generation_slots as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_generation_slots as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_generation_slots as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_generation_slots as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_generation_budgets for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.public_assistant_generation_budgets as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_generation_budgets as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_generation_budgets as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_generation_budgets as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.cms_pages for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.cms_pages as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_pages as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_pages as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_pages as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_pages for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_pages for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_pages for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_pages for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.cms_documents for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.cms_documents as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.cms_documents as restrictive for insert to authenticated  with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_update on public.cms_documents as restrictive for update to authenticated using(public.tenant_scope_write(tenant_id)) with check(public.tenant_scope_write(tenant_id));
create policy tenant_boundary_delete on public.cms_documents as restrictive for delete to authenticated using(public.tenant_scope_write(tenant_id)) ;
create policy tenant_member_read on public.cms_documents for select to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor','staff']));
create policy tenant_member_insert on public.cms_documents for insert to authenticated  with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_update on public.cms_documents for update to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) with check(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_member_delete on public.cms_documents for delete to authenticated using(tenant_id is not null and public.tenant_has_role(tenant_id,array['tenant_admin','editor'])) ;
create trigger tenant_bind before insert or update on public.public_assistant_faqs for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.public_assistant_faqs as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_faqs as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_faqs as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_faqs as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_sources for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.public_assistant_sources as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_sources as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_sources as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_sources as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_chunks for each row execute function public.tenant_bind_row('public_assistant_sources','source_id');
create policy tenant_boundary_read on public.public_assistant_chunks as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_chunks as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_chunks as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_chunks as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_index_jobs for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.public_assistant_index_jobs as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_index_jobs as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_index_jobs as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_index_jobs as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_generation_requests for each row execute function public.tenant_bind_row();
create policy tenant_boundary_read on public.public_assistant_generation_requests as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_generation_requests as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_generation_requests as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_generation_requests as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_document_corrections for each row execute function public.tenant_bind_row('public_assistant_document_text','document_text_id');
create policy tenant_boundary_read on public.public_assistant_document_corrections as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_document_corrections as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_document_corrections as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_document_corrections as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_document_text for each row execute function public.tenant_bind_row('cms_documents','document_id');
create policy tenant_boundary_read on public.public_assistant_document_text as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_document_text as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_document_text as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_document_text as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
create trigger tenant_bind before insert or update on public.public_assistant_document_pages for each row execute function public.tenant_bind_row('public_assistant_document_text','document_text_id');
create policy tenant_boundary_read on public.public_assistant_document_pages as restrictive for select to anon,authenticated using(public.tenant_scope(tenant_id));
create policy tenant_boundary_insert on public.public_assistant_document_pages as restrictive for insert to authenticated  with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_update on public.public_assistant_document_pages as restrictive for update to authenticated using(tenant_id is null and public.tenant_request_domain() is null) with check(tenant_id is null and public.tenant_request_domain() is null);
create policy tenant_boundary_delete on public.public_assistant_document_pages as restrictive for delete to authenticated using(tenant_id is null and public.tenant_request_domain() is null) ;
alter table public.cms_courses add constraint cms_courses_tenant_identity unique(id,tenant_id);
alter table public.cms_course_units add constraint cms_course_units_tenant_parent foreign key(course_id,tenant_id) references public.cms_courses(id,tenant_id) deferrable initially immediate;
alter table public.cms_course_attachments add constraint cms_course_attachments_tenant_parent foreign key(course_id,tenant_id) references public.cms_courses(id,tenant_id) deferrable initially immediate;
alter table public.cms_course_sections add constraint cms_course_sections_tenant_parent foreign key(course_id,tenant_id) references public.cms_courses(id,tenant_id) deferrable initially immediate;
alter table public.cms_course_links add constraint cms_course_links_tenant_parent foreign key(course_id,tenant_id) references public.cms_courses(id,tenant_id) deferrable initially immediate;
alter table public.cms_settings add constraint cms_settings_tenant_identity unique(id,tenant_id);
alter table public.cms_social_links add constraint cms_social_links_tenant_parent foreign key(settings_id,tenant_id) references public.cms_settings(id,tenant_id) deferrable initially immediate;
alter table public.cms_forms add constraint cms_forms_tenant_identity unique(id,tenant_id);
alter table public.cms_form_fields add constraint cms_form_fields_tenant_parent foreign key(form_id,tenant_id) references public.cms_forms(id,tenant_id) deferrable initially immediate;
alter table public.cms_navigation_items add constraint cms_navigation_items_tenant_identity unique(id,tenant_id);
alter table public.cms_navigation_items add constraint cms_navigation_items_tenant_parent foreign key(parent_id,tenant_id) references public.cms_navigation_items(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_document_extraction_jobs add constraint enrollment_document_extraction_jobs_tenant_identity unique(id,tenant_id);
alter table public.enrollment_document_extraction_attempts add constraint enrollment_document_extraction_attempts_tenant_parent foreign key(job_id,tenant_id) references public.enrollment_document_extraction_jobs(id,tenant_id) deferrable initially immediate;
alter table public.public_assistant_sources add constraint public_assistant_sources_tenant_identity unique(id,tenant_id);
alter table public.public_assistant_chunks add constraint public_assistant_chunks_tenant_parent foreign key(source_id,tenant_id) references public.public_assistant_sources(id,tenant_id) deferrable initially immediate;
alter table public.cms_documents add constraint cms_documents_tenant_identity unique(id,tenant_id);
alter table public.public_assistant_document_text add constraint public_assistant_document_text_tenant_parent foreign key(document_id,tenant_id) references public.cms_documents(id,tenant_id) deferrable initially immediate;
alter table public.public_assistant_document_text add constraint public_assistant_document_text_tenant_identity unique(id,tenant_id);
alter table public.public_assistant_document_pages add constraint public_assistant_document_pages_tenant_parent foreign key(document_text_id,tenant_id) references public.public_assistant_document_text(id,tenant_id) deferrable initially immediate;
alter table public.public_assistant_document_corrections add constraint public_assistant_document_corrections_tenant_parent foreign key(document_text_id,tenant_id) references public.public_assistant_document_text(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_applications add constraint enrollment_applications_tenant_identity unique(id,tenant_id);
alter table public.enrollment_application_courses add constraint enrollment_application_courses_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_application_documents add constraint enrollment_application_documents_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_application_status_history add constraint enrollment_application_status_history_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_application_messages add constraint enrollment_application_messages_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_application_requests add constraint enrollment_application_requests_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_application_consents add constraint enrollment_application_consents_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_application_versions add constraint enrollment_application_versions_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.portal_notifications add constraint portal_notifications_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.portal_audit_log add constraint portal_audit_log_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_document_deletion_recovery add constraint enrollment_document_deletion_recovery_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_document_field_reviews add constraint enrollment_document_field_reviews_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;
alter table public.enrollment_document_extraction_jobs add constraint enrollment_document_extraction_jobs_tenant_parent foreign key(application_id,tenant_id) references public.enrollment_applications(id,tenant_id) deferrable initially immediate;

-- Keep existing portal policy/function OIDs, but route assigned rows explicitly.
do $m$ declare body text; begin
 body:=pg_get_functiondef('public.portal_can_access_application(uuid)'::regprocedure);
 body:=replace(body,'public.portal_can_access_application','skyline_private.legacy_application_access');execute body;
end; $m$;
revoke all on function skyline_private.legacy_application_access(uuid) from public,anon,authenticated,service_role;
create or replace function public.portal_can_access_application(app_id uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.enrollment_applications a where a.id=app_id and
 case when a.tenant_id is null then public.tenant_request_domain() is null and skyline_private.legacy_application_access(app_id)
 else public.tenant_scope(a.tenant_id) and (public.tenant_has_role(a.tenant_id,array['tenant_admin','staff']) or
 (public.tenant_agency_access(a.tenant_id,a.agency_id) and (public.portal_is_agency_admin() or a.assigned_agent_id=public.portal_profile_id()))) end);
$$;
-- Internal audit rows remain server-authored; tenant role policy never grants
-- direct mutation of snapshots, extraction attempts, indexed artifacts or usage.

-- Remaining P02-08 commands; appended by build-tenant-migration.mjs.
alter table public.enrollment_application_documents add constraint tenant_document_application unique(id,application_id,tenant_id);
alter table public.enrollment_application_documents add constraint tenant_document_identity unique(id,tenant_id);
alter table public.enrollment_document_extraction_jobs add constraint tenant_extraction_document foreign key(document_id,application_id,tenant_id) references public.enrollment_application_documents(id,application_id,tenant_id);
alter table public.enrollment_document_field_reviews add constraint tenant_review_document foreign key(document_id,application_id,tenant_id) references public.enrollment_application_documents(id,application_id,tenant_id);
alter table public.enrollment_application_documents add constraint tenant_document_revision foreign key(revision_of,tenant_id) references public.enrollment_application_documents(id,tenant_id);
alter table public.enrollment_application_courses add constraint tenant_application_course foreign key(course_id,tenant_id) references public.cms_courses(id,tenant_id);

create function public.tenant_apply_ownership(p_decision uuid) returns void language plpgsql security definer set search_path=public as $$
declare d public.tenant_ownership_decisions; fingerprint text; old_tenant uuid; child record; target text; source_type text;
begin
 if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode='42501'; end if;
 select * into d from public.tenant_ownership_decisions where id=p_decision for update;
 if not found or d.status<>'approved' or d.tenant_id is null or not public.tenant_has_role(d.tenant_id) then raise exception 'Approved active ownership required' using errcode='22023'; end if;
 execute format('select md5((to_jsonb(r)-''tenant_id'')::text),tenant_id from public.%I r where id::text=$1 for update',d.table_name) into fingerprint,old_tenant using d.record_key;
 if fingerprint is distinct from d.observed_hash or old_tenant is not null then raise exception 'Ownership evidence changed' using errcode='40001'; end if;
 perform set_config('skyline.ownership_assignment','true',true);
 execute format('update public.%I set tenant_id=$1 where id::text=$2',d.table_name) using d.tenant_id,d.record_key;
 -- Assign only children whose recorded foreign key proves the same root.
 for child in select c.table_name,c.column_name from information_schema.columns c where c.table_schema='public' and
 ((d.table_name='cms_courses' and c.column_name='course_id' and c.table_name like 'cms_course_%') or
 (d.table_name='cms_forms' and c.table_name='cms_form_fields' and c.column_name='form_id') or
 (d.table_name='cms_settings' and c.table_name='cms_social_links' and c.column_name='settings_id') or
 (d.table_name='enrollment_applications' and c.column_name='application_id')) loop
  execute format('update public.%I set tenant_id=$1 where %I::text=$2 and tenant_id is null',child.table_name,child.column_name) using d.tenant_id,d.record_key;
 end loop;
 source_type:=case d.table_name when 'cms_courses' then 'course' when 'cms_pages' then 'page' when 'cms_documents' then 'document' end;
 if source_type is not null then
  update public.public_assistant_sources set tenant_id=d.tenant_id where public_assistant_sources.source_type=tenant_apply_ownership.source_type and source_key=d.record_key and tenant_id is null;
  update public.public_assistant_chunks c set tenant_id=d.tenant_id from public.public_assistant_sources s where c.source_id=s.id and s.tenant_id=d.tenant_id and s.source_key=d.record_key and c.tenant_id is null;
  update public.public_assistant_index_jobs set tenant_id=d.tenant_id where public_assistant_index_jobs.source_type=tenant_apply_ownership.source_type and source_key=d.record_key and tenant_id is null;
 end if;
 if d.table_name='cms_documents' then
  update public.public_assistant_document_text set tenant_id=d.tenant_id where document_id=d.record_key and tenant_id is null;
  update public.public_assistant_document_pages p set tenant_id=d.tenant_id from public.public_assistant_document_text t where p.document_text_id=t.id and t.document_id=d.record_key and p.tenant_id is null;
  update public.public_assistant_document_corrections c set tenant_id=d.tenant_id from public.public_assistant_document_text t where c.document_text_id=t.id and t.document_id=d.record_key and c.tenant_id is null;
 end if;
 if d.table_name='enrollment_applications' then
  update public.enrollment_document_extraction_attempts a set tenant_id=d.tenant_id from public.enrollment_document_extraction_jobs j where a.job_id=j.id and j.application_id::text=d.record_key and a.tenant_id is null;
 end if;
 perform set_config('skyline.ownership_assignment','false',true);
 update public.tenant_ownership_decisions set status='applied',applied_at=clock_timestamp() where id=d.id;
 insert into public.tenant_access_audit(tenant_id,actor,action,target) values(d.tenant_id,auth.uid(),'ownership_applied',d.id);
end; $$;
revoke all on function public.tenant_apply_ownership(uuid) from public,anon,service_role;
grant execute on function public.tenant_apply_ownership(uuid) to authenticated;

-- Storage validates the object parent and actor; no client tenant ID is trusted.
create function public.tenant_storage_access(p_bucket text,p_name text,p_write boolean default false) returns boolean language plpgsql stable security definer set search_path=public as $$
declare app public.enrollment_applications; tenant uuid; part text:=split_part(p_name,'/',1);
begin
 if auth.uid() is null or part !~ '^[a-f0-9-]{36}$' then return false; end if;
 if p_bucket='tenant-cms' then
  tenant:=part::uuid;return public.tenant_has_role(tenant,array['tenant_admin','editor']);
 elsif p_bucket='enrollment-documents' then
  select * into app from public.enrollment_applications where id=part::uuid;
  if not found or app.tenant_id is null then return false; end if;
  return (not p_write or app.status in ('draft','action_required')) and
   (public.tenant_has_role(app.tenant_id,array['tenant_admin','staff']) or
    (public.tenant_agency_access(app.tenant_id,app.agency_id) and (public.portal_is_agency_admin() or app.assigned_agent_id=public.portal_profile_id())));
 end if;
 return false;
exception when invalid_text_representation then return false;
end; $$;
revoke all on function public.tenant_storage_access(text,text,boolean) from public,anon;
grant execute on function public.tenant_storage_access(text,text,boolean) to authenticated,service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('tenant-cms','tenant-cms',false,20971520,array['application/pdf','image/png','image/jpeg']);
create policy tenant_storage_read on storage.objects for select to authenticated using(public.tenant_storage_access(bucket_id,name,false));
create policy tenant_storage_insert on storage.objects for insert to authenticated with check(public.tenant_storage_access(bucket_id,name,true));
create policy tenant_storage_update on storage.objects for update to authenticated using(public.tenant_storage_access(bucket_id,name,true)) with check(public.tenant_storage_access(bucket_id,name,true));
create policy tenant_storage_delete on storage.objects for delete to authenticated using(public.tenant_storage_access(bucket_id,name,true));

-- Bounded, authenticated conversation storage. Anonymous persistence is disabled;
-- Phase 6 must define opaque session ownership before enabling it.
create table public.tenant_conversations(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),owner_user_id uuid not null default auth.uid() references auth.users(id),created_at timestamptz not null default now(),unique(id,tenant_id));
create table public.tenant_conversation_messages(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),conversation_id uuid not null,role text not null check(role in ('user','assistant')),content text not null check(length(content) between 1 and 4000),created_at timestamptz not null default now(),foreign key(conversation_id,tenant_id) references public.tenant_conversations(id,tenant_id) on delete cascade);
alter table public.tenant_conversations enable row level security;
alter table public.tenant_conversation_messages enable row level security;
revoke all on public.tenant_conversations,public.tenant_conversation_messages from public,anon,authenticated,service_role;
grant select,insert,delete on public.tenant_conversations,public.tenant_conversation_messages to authenticated;
grant select,insert on public.tenant_conversations,public.tenant_conversation_messages to service_role;
create policy conversation_owner on public.tenant_conversations for all to authenticated using(owner_user_id=auth.uid() and public.tenant_scope(tenant_id) and public.tenant_can_access(tenant_id)) with check(owner_user_id=auth.uid() and public.tenant_scope(tenant_id) and public.tenant_can_access(tenant_id));
create policy message_owner_read on public.tenant_conversation_messages for select to authenticated using(public.tenant_scope(tenant_id) and exists(select 1 from public.tenant_conversations c where c.id=conversation_id and c.tenant_id=tenant_conversation_messages.tenant_id and c.owner_user_id=auth.uid()));
create policy message_owner_insert on public.tenant_conversation_messages for insert to authenticated with check(role='user' and public.tenant_scope(tenant_id) and exists(select 1 from public.tenant_conversations c where c.id=conversation_id and c.tenant_id=tenant_conversation_messages.tenant_id and c.owner_user_id=auth.uid()));
create policy message_owner_delete on public.tenant_conversation_messages for delete to authenticated using(exists(select 1 from public.tenant_conversations c where c.id=conversation_id and c.owner_user_id=auth.uid()));
create function public.tenant_conversation_bound() returns trigger language plpgsql security definer set search_path=public as $$
begin
 perform id from public.tenant_conversations where id=new.conversation_id and tenant_id=new.tenant_id for update;
 if not found then raise exception 'Conversation ownership missing' using errcode='23503'; end if;
 if (select count(*) from public.tenant_conversation_messages where conversation_id=new.conversation_id)>=40 then raise exception 'Conversation limit reached' using errcode='22023'; end if;
 return new;
end; $$;
revoke all on function public.tenant_conversation_bound() from public,anon,authenticated,service_role;
create trigger tenant_conversation_bound before insert on public.tenant_conversation_messages for each row execute function public.tenant_conversation_bound();

-- Scoped public retrieval never includes unassigned legacy or private app data.
create function public.tenant_assistant_version(p_tenant uuid) returns text language sql stable security definer set search_path=public as $$
 select md5(coalesce((select string_agg(source_type||':'||source_key||':'||source_version,',' order by id) from public.public_assistant_sources where tenant_id is not distinct from p_tenant and publication_status='published'),'')||'|'||coalesce((select string_agg(normalized_question||':'||source_version,',' order by id) from public.public_assistant_faqs where tenant_id is not distinct from p_tenant and status='published'),''));
$$;
create function public.tenant_assistant_search(p_tenant uuid,p_query extensions.vector(1536),p_query_text text,p_course_code text default null,p_limit integer default 6)
returns table(chunk_id uuid,title text,heading text,content text,canonical_url text,page_reference text,course_code text,lexical_rank real,semantic_distance real)
language sql stable security definer set search_path=public,extensions as $$
 select c.id,s.title,c.heading,c.content,s.canonical_url,c.page_reference,c.course_code,ts_rank_cd(c.content_tsv,websearch_to_tsquery('english',p_query_text)),(c.embedding <=> p_query)::real
 from public.public_assistant_chunks c join public.public_assistant_sources s on s.id=c.source_id and c.tenant_id is not distinct from s.tenant_id
 where s.tenant_id is not distinct from p_tenant and (p_tenant is null or exists(select 1 from public.tenants where id=p_tenant and status='active'))
 and s.publication_status='published' and c.embedding is not null and (p_course_code is null or c.course_code=p_course_code)
 order by .45*ts_rank_cd(c.content_tsv,websearch_to_tsquery('english',p_query_text))+.55*(1-(c.embedding <=> p_query)) desc limit greatest(1,least(p_limit,8));
$$;
create function public.tenant_assistant_rate_limit(p_tenant uuid,p_bucket text,p_limit integer,p_window_seconds integer) returns boolean language plpgsql security definer set search_path=public as $$
declare n integer; scoped text:=coalesce(p_tenant::text,'legacy')||':'||p_bucket;
begin
 if p_tenant is not null and not exists(select 1 from public.tenants where id=p_tenant and status='active') then return false; end if;
 insert into public.public_assistant_rate_limits(bucket,tenant_id,window_started_at,request_count) values(scoped,p_tenant,clock_timestamp(),1)
 on conflict(bucket) do update set window_started_at=case when public_assistant_rate_limits.window_started_at+make_interval(secs=>p_window_seconds)<=clock_timestamp() then clock_timestamp() else public_assistant_rate_limits.window_started_at end,request_count=case when public_assistant_rate_limits.window_started_at+make_interval(secs=>p_window_seconds)<=clock_timestamp() then 1 else public_assistant_rate_limits.request_count+1 end returning request_count into n;
 return n<=least(p_limit,100);
end; $$;
revoke all on function public.tenant_assistant_version(uuid),public.tenant_assistant_search(uuid,extensions.vector,text,text,integer),public.tenant_assistant_rate_limit(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.tenant_assistant_version(uuid),public.tenant_assistant_search(uuid,extensions.vector,text,text,integer),public.tenant_assistant_rate_limit(uuid,text,integer,integer) to service_role;
-- Generation stays disabled for scoped tenants until Phase 6 introduces
-- independently scoped request/slot/token budgets. Retrieval remains functional.
