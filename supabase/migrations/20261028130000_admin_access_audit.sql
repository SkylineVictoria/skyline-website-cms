-- Administrator access to application documents and exports is written to portal_audit_log by this function.
-- The table is immutable for direct client writes (phase4_immutable_insert), so the portal cannot insert audit rows itself;
-- like portal_assign_agent, this definer function is the only writer. Administrators only, and only for applications they can access.
--
-- Rollback / compensation (additive): drop function public.portal_log_admin_access(uuid, text, jsonb);
-- Apply with the normal reviewed release process; it must not be assumed applied. Until it is, the portal still downloads (see the client).
begin;

create function public.portal_log_admin_access(p_application_id uuid, p_action text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications;
begin
  select * into a from public.enrollment_applications where id = p_application_id;
  if auth.uid() is null or not found or not public.portal_can_access_application(a.id) or not public.portal_is_slit_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_action not in ('document_viewed', 'document_downloaded', 'pdf_exported') then raise exception 'Unknown access action' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) <> 'object' or length(coalesce(p_detail, '{}'::jsonb)::text) > 2000 then raise exception 'Invalid detail' using errcode = '22023'; end if;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'administrator', p_action, 'application', a.id::text, a.id, a.agency_id, a.tenant_id, coalesce(p_detail, '{}'::jsonb));
end;
$$;
revoke all on function public.portal_log_admin_access(uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.portal_log_admin_access(uuid, text, jsonb) to authenticated;

commit;
