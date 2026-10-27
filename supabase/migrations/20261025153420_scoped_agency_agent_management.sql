-- An agency administrator can manage institution grants, never global Auth identities.
create function public.portal_scope_agents() returns jsonb language plpgsql stable security definer set search_path=public as $$
declare t uuid:=public.tenant_current(); result jsonb;
begin
 if t is null or not (public.tenant_has_role(t,array['tenant_admin']) or
  public.portal_is_agency_admin() and public.tenant_agency_access(t,public.portal_agency_id())) then
  raise exception 'Institution agent administration required' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('profileId',p.id,'name',p.full_name,'email',p.email,
  'agencyId',a.id,'agencyName',a.name,'active',coalesce(g.active,false)) order by a.name,p.full_name),'[]') into result
 from public.agency_memberships m join public.portal_profiles p on p.id=m.user_id
 join public.agencies a on a.id=m.agency_id join public.agency_tenants at on at.agency_id=a.id and at.tenant_id=t
 left join public.agency_tenant_agents g on g.tenant_id=t and g.agency_id=a.id and g.profile_id=p.id
 where m.role='agent' and m.status='Active' and p.status='Active' and a.status='Active' and at.active
 and (public.tenant_has_role(t,array['tenant_admin']) or a.id=public.portal_agency_id());
 return result;
end; $$;
revoke all on function public.portal_scope_agents() from public,anon,authenticated,service_role;
grant execute on function public.portal_scope_agents() to authenticated;

-- Enforce assignment at the database boundary, including direct REST writes.
create function public.portal_verify_agent_institution() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.tenant_id is not null and new.assigned_agent_id is not null and
  (tg_op='INSERT' or new.assigned_agent_id is distinct from old.assigned_agent_id) and not exists(
   select 1 from public.agency_tenant_agents g join public.agency_memberships m on m.user_id=g.profile_id and m.agency_id=g.agency_id
   join public.portal_profiles p on p.id=g.profile_id where g.tenant_id=new.tenant_id and g.agency_id=new.agency_id
   and g.profile_id=new.assigned_agent_id and g.active and m.status='Active' and p.status='Active' and m.role='agent') then
   raise exception 'Agent is not authorized for this institution' using errcode='42501'; end if;
 return new;
end; $$;
revoke all on function public.portal_verify_agent_institution() from public;
create trigger z_portal_agent_institution before insert or update on public.enrollment_applications
for each row execute function public.portal_verify_agent_institution();
