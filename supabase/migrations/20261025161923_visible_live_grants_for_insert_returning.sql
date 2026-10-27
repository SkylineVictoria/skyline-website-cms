-- A STABLE parent lookup cannot see a just-inserted row during INSERT RETURNING.
-- Evaluate live actor authorization against the policy row itself instead.
alter policy portal_live_scope_read on public.enrollment_applications using(tenant_id is null or
 public.tenant_scope(tenant_id) and (public.tenant_has_role(tenant_id,array['tenant_admin','staff']) or
  public.tenant_agency_access(tenant_id,agency_id) and (public.portal_is_agency_admin() or assigned_agent_id=public.portal_profile_id())));
