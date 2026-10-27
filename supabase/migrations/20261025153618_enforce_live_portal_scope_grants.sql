-- Legacy permissive policies predate RTO grants; the live grant must also hold.
create policy portal_live_scope_read on public.enrollment_applications as restrictive for select to authenticated
using (tenant_id is null or public.portal_can_access_application(id));
create policy portal_live_scope_update on public.enrollment_applications as restrictive for update to authenticated
using (tenant_id is null or public.portal_can_access_application(id))
with check (tenant_id is null or public.portal_can_access_application(id));
create policy portal_live_scope_delete on public.enrollment_applications as restrictive for delete to authenticated
using (tenant_id is null or public.portal_can_access_application(id));
create policy portal_live_scope_insert on public.enrollment_applications as restrictive for insert to authenticated
with check (tenant_id is null or public.tenant_scope(tenant_id) and
 (public.tenant_has_role(tenant_id,array['tenant_admin','staff']) or
  public.tenant_agency_access(tenant_id,agency_id) and agency_id=public.portal_agency_id() and
  (public.portal_is_agency_admin() or assigned_agent_id=public.portal_profile_id())));
