-- Administrator changes to an agency's own record (details, activation) are written to portal_audit_log by this function.
-- Creating an agency with a first administrator, and every agent invite / role / status change, are already audited by the portal-admin-users
-- functions; the agency record itself is edited with direct table writes, and the audit log accepts no client writes (phase4_immutable_insert).
-- Administrators only. Rollback / compensation (additive): drop function public.portal_log_agency_change(uuid, text, jsonb).
-- Apply with the normal reviewed release process; it must not be assumed applied. Until it is, edits still save (see the client).
begin;

create function public.portal_log_agency_change(p_agency uuid, p_action text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.portal_is_slit_admin() or not exists (select 1 from public.agencies where id = p_agency) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_action not in ('agency_created', 'agency_updated', 'agency_deactivated', 'agency_reactivated') then raise exception 'Unknown agency action' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) <> 'object' or length(coalesce(p_detail, '{}'::jsonb)::text) > 2000 then raise exception 'Invalid detail' using errcode = '22023'; end if;
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'administrator', p_action, 'agency', p_agency::text, p_agency, coalesce(p_detail, '{}'::jsonb));
end;
$$;
revoke all on function public.portal_log_agency_change(uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.portal_log_agency_change(uuid, text, jsonb) to authenticated;

commit;
